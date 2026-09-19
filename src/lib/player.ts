// Motor de reproducao.
//
// O proxy de video nao tem audio: cada faixa toca no seu proprio <audio>, o que e
// o que permite mute/solo/ganho por microfone. O preco disso e que N elementos de
// midia derivam entre si. O video e o relogio mestre e as faixas sao corrigidas:
// deriva pequena vira um ajuste suave de playbackRate (inaudivel), deriva grande
// vira um seek seco. Sem isso, meia hora de reproducao sai com eco.
import type { Faixa } from './api';

const DERIVA_SECA = 0.12;    // s — acima disso, reposiciona
const DERIVA_SUAVE = 0.025;  // s — entre os dois, acelera/desacelera 2%
const INTERVALO_CHECAGEM = 400;
// Em velocidade alta o vídeo é quem não acompanha: a 4× num arquivo 60fps são 240
// quadros por segundo pra decodificar, e o decodificador fica pra trás enquanto o
// áudio segue no ritmo. Se a correção continuar valendo, ela puxa o áudio de volta
// a cada checagem e o trecho toca de novo — o áudio "repetindo". Duas defesas:
// a tolerância cresce junto com a velocidade, e um reposicionamento seco só pode
// acontecer uma vez por segundo.
const INTERVALO_MIN_CORRECAO = 1000;
const VELOCIDADE_SEM_AJUSTE_FINO = 2;

export type OuvinteTempo = (t: number) => void;

export class Player {
  private video: HTMLVideoElement | null = null;
  private audios = new Map<number, HTMLAudioElement>();
  private ctx: AudioContext | null = null;
  private ganhos = new Map<number, GainNode>();
  private ouvintes = new Set<OuvinteTempo>();
  private ouvintesEstado = new Set<() => void>();
  private raf = 0;
  private timer = 0;
  private faixas: Faixa[] = [];

  tempo = 0;
  duracao = 0;
  tocando = false;
  velocidade = 1;
  /** true enquanto arrastamos a agulha: audio fica mudo pra nao virar serra eletrica. */
  arrastando = false;

  // --------------------------------------------------------------- registro

  ligarVideo(el: HTMLVideoElement | null) {
    if (this.video === el) return;
    this.video = el;
    if (!el) { this.pararLoop(); return; }
    el.addEventListener('play', this.aoTocar);
    el.addEventListener('pause', this.aoPausar);
    el.addEventListener('durationchange', this.aoDuracao);
    el.addEventListener('seeked', this.aoSeek);
    this.iniciarLoop();
  }

  ligarAudio(faixaId: number, el: HTMLAudioElement | null) {
    if (!el) { this.audios.delete(faixaId); this.ganhos.delete(faixaId); return; }
    if (this.audios.get(faixaId) === el) return;
    this.audios.set(faixaId, el);
    el.preload = 'auto';
    this.conectarGanho(faixaId, el);
    this.aplicarMixagem();
  }

  /**
   * Web Audio em vez de `el.volume` porque volume nao passa de 1.0 — e mic de
   * convidado quase sempre precisa de +6 dB pra emparelhar com o resto.
   */
  private conectarGanho(faixaId: number, el: HTMLAudioElement) {
    try {
      this.ctx ??= new AudioContext();
      const fonte = this.ctx.createMediaElementSource(el);
      const g = this.ctx.createGain();
      fonte.connect(g).connect(this.ctx.destination);
      this.ganhos.set(faixaId, g);
    } catch {
      // Navegador recusou (ja conectado, ou sem permissao): cai no volume simples.
      this.ganhos.delete(faixaId);
    }
  }

  definirFaixas(faixas: Faixa[]) {
    this.faixas = faixas;
    this.aplicarMixagem();
  }

  aplicarMixagem() {
    // No modo assistir o <video> toca o arquivo ORIGINAL, que traz o próprio
    // áudio junto. Assim que as faixas separadas entram no ar, a faixa 1 estaria
    // tocando duas vezes — pelo vídeo e pelo mixer. Quem manda é o mixer; o
    // áudio embutido no vídeo só vale enquanto ele ainda não existe.
    if (this.video) this.video.muted = this.audios.size > 0;

    const temSolo = this.faixas.some((f) => f.solo);
    for (const f of this.faixas) {
      const el = this.audios.get(f.id);
      if (!el) continue;
      const ativo = !f.muted && (!temSolo || !!f.solo) && !this.arrastando;
      const ganho = ativo ? 10 ** ((f.gain_db || 0) / 20) : 0;
      const g = this.ganhos.get(f.id);
      if (g) g.gain.value = ganho;
      else el.volume = Math.min(1, ganho);
      el.muted = !ativo;
    }
  }

  // --------------------------------------------------------------- controle

  async tocar() {
    if (!this.video) return;
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    this.sincronizarSeco();
    const tudo: Promise<unknown>[] = [this.video.play()];
    for (const el of this.audios.values()) tudo.push(el.play().catch(() => undefined));
    await Promise.allSettled(tudo);
  }

  pausar() {
    this.video?.pause();
    for (const el of this.audios.values()) el.pause();
  }

  alternar() { (this.tocando ? this.pausar() : this.tocar()); }

  buscar(t: number) {
    const alvo = Math.max(0, Math.min(this.duracao || Infinity, t));
    this.tempo = alvo;
    if (this.video) this.video.currentTime = alvo;
    for (const el of this.audios.values()) {
      // readyState 0 significa que o arquivo ainda nao carregou: setar
      // currentTime agora e descartado, entao deixamos o loop corrigir depois.
      if (el.readyState > 0) el.currentTime = alvo;
    }
    this.emitirTempo();
  }

  /** Avanca N frames (setas) — o passo que um editor espera. */
  pular(frames: number, fps: number) {
    this.buscar(this.tempo + frames / (fps || 30));
  }

  definirVelocidade(v: number) {
    this.velocidade = v;
    if (this.video) this.video.playbackRate = v;
    for (const el of this.audios.values()) el.playbackRate = v;
    this.emitirEstado();
  }

  definirArraste(a: boolean) {
    if (this.arrastando === a) return;
    this.arrastando = a;
    this.aplicarMixagem();
  }

  // ------------------------------------------------------------ assinaturas

  assinarTempo(cb: OuvinteTempo): () => void {
    this.ouvintes.add(cb);
    cb(this.tempo);
    return () => { this.ouvintes.delete(cb); };
  }

  assinarEstado(cb: () => void): () => void {
    this.ouvintesEstado.add(cb);
    return () => { this.ouvintesEstado.delete(cb); };
  }

  private emitirTempo() { for (const cb of this.ouvintes) cb(this.tempo); }
  private emitirEstado() { for (const cb of this.ouvintesEstado) cb(); }

  // ----------------------------------------------------------------- loops

  private aoTocar = () => { this.tocando = true; this.emitirEstado(); };
  private aoPausar = () => { this.tocando = false; this.emitirEstado(); };
  private aoSeek = () => { this.sincronizarSeco(); };
  private aoDuracao = () => {
    if (this.video && Number.isFinite(this.video.duration)) {
      this.duracao = this.video.duration;
      this.emitirEstado();
    }
  };

  private iniciarLoop() {
    this.pararLoop();
    const passo = () => {
      if (this.video && !this.video.seeking) {
        const t = this.video.currentTime;
        if (t !== this.tempo) { this.tempo = t; this.emitirTempo(); }
      }
      this.raf = requestAnimationFrame(passo);
    };
    this.raf = requestAnimationFrame(passo);
    this.timer = window.setInterval(() => this.corrigirDeriva(), INTERVALO_CHECAGEM);
  }

  private pararLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private sincronizarSeco() {
    const t = this.video?.currentTime ?? this.tempo;
    for (const el of this.audios.values()) {
      if (el.readyState > 0) el.currentTime = t;
      el.playbackRate = this.velocidade;
    }
  }

  private ultimaCorrecao = 0;

  private corrigirDeriva() {
    if (!this.video || !this.tocando) return;
    const v = Math.max(1, this.velocidade);
    const seca = DERIVA_SECA * v;
    const suave = DERIVA_SUAVE * v;
    const agora = performance.now();
    const podeReposicionar = agora - this.ultimaCorrecao > INTERVALO_MIN_CORRECAO;
    const mestre = this.video.currentTime;

    for (const el of this.audios.values()) {
      if (el.readyState === 0) continue;
      const d = el.currentTime - mestre;
      const abs = Math.abs(d);

      if (abs > seca && podeReposicionar) {
        el.currentTime = mestre;
        el.playbackRate = this.velocidade;
        this.ultimaCorrecao = agora;
      } else if (abs > suave && this.velocidade <= VELOCIDADE_SEM_AJUSTE_FINO) {
        // Puxa 2% na direção certa; some sozinho quando alinha. Acima de 2× esse
        // ajuste fino não ajuda — o erro cresce mais rápido do que ele corrige, e
        // a variação de ritmo fica audível.
        el.playbackRate = this.velocidade * (d > 0 ? 0.98 : 1.02);
      } else if (el.playbackRate !== this.velocidade) {
        el.playbackRate = this.velocidade;
      }
    }
  }

  destruir() {
    this.pararLoop();
    this.ouvintes.clear();
    this.ouvintesEstado.clear();
    this.audios.clear();
    this.ganhos.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
