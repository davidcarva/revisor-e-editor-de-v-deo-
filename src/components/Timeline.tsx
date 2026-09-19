// Timeline em canvas.
//
// Dois canvas empilhados de proposito: `conteudo` (regua, miniaturas, onda,
// marcadores) so e redesenhado quando os dados ou o zoom mudam; `overlay` (agulha,
// selecao, cursor) e redesenhado a cada quadro. Se fosse um canvas so, a agulha
// obrigaria a redesenhar a onda 60 vezes por segundo e a timeline engasgaria.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, urlFolha, type Faixa, type Fonte, type Marcador } from '../lib/api';
import { baseDoArquivo, corDoMarcador, duracaoCurta, framesParaTimecode, timecodeParaFrames } from '../lib/tempo';
import type { Player } from '../lib/player';
import { estaDigitando } from '../lib/teclado';

const H_REGUA = 22;
const H_MARCADORES = 22;
const H_VIDEO = 46;
const H_FAIXA = 58;
const LARGURA_CABECALHO = 152;
const SPAN_MIN = 0.25;

type Janela = { de: number; ate: number };
type Selecao = { de: number; ate: number } | null;

type Props = {
  fonte: Fonte;
  player: Player;
  marcadores: Marcador[];
  selecao: Selecao;
  aoSelecionar: (s: Selecao) => void;
  aoClicarMarcador: (m: Marcador) => void;
  aoMudarFaixa: (id: number, patch: Partial<Faixa>) => void;
};

export function Timeline({
  fonte, player, marcadores, selecao, aoSelecionar, aoClicarMarcador, aoMudarFaixa,
}: Props) {
  const hospedeiro = useRef<HTMLDivElement>(null);
  const cvConteudo = useRef<HTMLCanvasElement>(null);
  const cvOverlay = useRef<HTMLCanvasElement>(null);
  const [largura, setLargura] = useState(1000);
  const [janela, setJanela] = useState<Janela>({ de: 0, ate: Math.max(1, fonte.duration_s) });

  const faixasAudio = useMemo(
    () => fonte.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.ord - b.ord),
    [fonte.tracks]);
  const temVideo = fonte.tracks.some((t) => t.kind === 'video');
  const base = useMemo(() => baseDoArquivo(fonte.fps, fonte.start_timecode), [fonte.fps, fonte.start_timecode]);
  const tcInicial = useMemo(() => timecodeParaFrames(fonte.start_timecode, base), [fonte.start_timecode, base]);

  const altura = H_REGUA + H_MARCADORES + (temVideo ? H_VIDEO : 0) + faixasAudio.length * H_FAIXA;
  const yVideo = H_REGUA + H_MARCADORES;
  const yFaixas = yVideo + (temVideo ? H_VIDEO : 0);

  // Janela sempre dentro do arquivo, e nunca menor que SPAN_MIN.
  const limitar = useCallback((j: Janela): Janela => {
    const dur = Math.max(SPAN_MIN, fonte.duration_s || 1);
    const span = Math.min(dur, Math.max(SPAN_MIN, j.ate - j.de));
    const de = Math.max(0, Math.min(dur - span, j.de));
    return { de, ate: de + span };
  }, [fonte.duration_s]);

  useEffect(() => { setJanela(limitar({ de: 0, ate: fonte.duration_s || 1 })); }, [fonte.id]);

  const paraX = useCallback(
    (t: number) => ((t - janela.de) / (janela.ate - janela.de)) * largura,
    [janela, largura]);
  const paraT = useCallback(
    (x: number) => janela.de + (x / largura) * (janela.ate - janela.de),
    [janela, largura]);

  // ------------------------------------------------------------ dimensoes
  useEffect(() => {
    const el = hospedeiro.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setLargura(Math.max(200, Math.floor(e.contentRect.width - LARGURA_CABECALHO)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------ picos
  // Guarda o ultimo resultado por faixa junto da janela em que foi buscado, pra
  // poder ESTICAR o desenho antigo enquanto o novo nao chega. Sem isso a onda
  // pisca em branco a cada movimento de zoom.
  const picos = useRef(new Map<number, { dados: Int8Array; de: number; ate: number; largura: number }>());
  const [versaoPicos, setVersaoPicos] = useState(0);

  useEffect(() => {
    if (fonte.status !== 'pronto' && fonte.status !== 'processando') return;
    const ac = new AbortController();
    const id = window.setTimeout(async () => {
      await Promise.all(faixasAudio.map(async (f) => {
        try {
          const dados = await api.picos(f.id, janela.de, janela.ate, largura, ac.signal);
          picos.current.set(f.id, { dados, de: janela.de, ate: janela.ate, largura });
        } catch { /* abortado ou ainda sem .pks — mantem o desenho anterior */ }
      }));
      if (!ac.signal.aborted) setVersaoPicos((v) => v + 1);
    }, 45);
    return () => { ac.abort(); clearTimeout(id); };
  }, [janela.de, janela.ate, largura, faixasAudio, fonte.status, fonte.progress]);

  // ------------------------------------------------------------ miniaturas
  const folhas = useRef(new Map<string, HTMLImageElement>());
  const [versaoFolhas, setVersaoFolhas] = useState(0);
  const thumbs = fonte.thumbs ?? null;

  const pegarFolha = useCallback((nome: string) => {
    const cache = folhas.current;
    const achou = cache.get(nome);
    if (achou) return achou.complete && achou.naturalWidth > 0 ? achou : null;
    const img = new Image();
    img.src = urlFolha(fonte.id, nome);
    img.onload = () => setVersaoFolhas((v) => v + 1);
    img.onerror = () => cache.delete(nome);
    cache.set(nome, img);
    return null;
  }, [fonte.id]);

  useEffect(() => { folhas.current.clear(); }, [fonte.id]);

  // ------------------------------------------------------------ desenho
  const desenharConteudo = useCallback(() => {
    const cv = cvConteudo.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(largura * dpr) || cv.height !== Math.round(altura * dpr)) {
      cv.width = Math.round(largura * dpr);
      cv.height = Math.round(altura * dpr);
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, largura, altura);

    const span = janela.ate - janela.de;

    // --- fundo das pistas
    g.fillStyle = '#12151b';
    g.fillRect(0, 0, largura, altura);

    // --- regua
    g.fillStyle = '#181c24';
    g.fillRect(0, 0, largura, H_REGUA);
    const passo = escolherPasso(span, largura);
    g.font = '10px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    const primeiro = Math.ceil(janela.de / passo) * passo;
    for (let t = primeiro; t <= janela.ate; t += passo) {
      const x = Math.round(paraX(t)) + 0.5;
      g.strokeStyle = '#2b313d';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, altura);
      g.stroke();
      g.fillStyle = '#7d8798';
      g.fillText(framesParaTimecode(tcInicial + t * base.fps, base).slice(0, 8), x + 4, H_REGUA / 2);
    }


    // --- miniaturas
    if (temVideo && thumbs && thumbs.sheets.length) {
      g.save();
      g.beginPath();
      g.rect(0, yVideo, largura, H_VIDEO);
      g.clip();
      g.fillStyle = '#0d1015';
      g.fillRect(0, yVideo, largura, H_VIDEO);
      const escala = (H_VIDEO - 4) / thumbs.thumbH;
      const larguraDesenho = thumbs.thumbW * escala;
      const passoT = Math.max(thumbs.interval, (span / largura) * larguraDesenho);
      const inicio = Math.floor(janela.de / passoT) * passoT;
      for (let t = inicio; t < janela.ate + passoT; t += passoT) {
        const idx = Math.min(thumbs.count - 1, Math.max(0, Math.floor(t / thumbs.interval)));
        const nFolha = Math.floor(idx / thumbs.perSheet);
        const nome = thumbs.sheets[nFolha];
        if (!nome) continue;
        const img = pegarFolha(nome);
        if (!img) continue;
        const cel = idx % thumbs.perSheet;
        const sx = (cel % thumbs.cols) * thumbs.thumbW;
        const sy = Math.floor(cel / thumbs.cols) * thumbs.thumbH;
        g.drawImage(img, sx, sy, thumbs.thumbW, thumbs.thumbH,
          paraX(t), yVideo + 2, larguraDesenho, H_VIDEO - 4);
      }
      g.restore();
    } else if (temVideo) {
      g.fillStyle = '#0d1015';
      g.fillRect(0, yVideo, largura, H_VIDEO);
      g.fillStyle = '#3d4452';
      g.font = '11px system-ui';
      g.fillText('gerando miniaturas…', 8, yVideo + H_VIDEO / 2);
    }

    // --- ondas
    faixasAudio.forEach((f, i) => {
      const y = yFaixas + i * H_FAIXA;
      const meio = y + H_FAIXA / 2;
      const amp = (H_FAIXA - 10) / 2;
      g.fillStyle = i % 2 ? '#151922' : '#12161e';
      g.fillRect(0, y, largura, H_FAIXA);
      g.strokeStyle = '#1e2430';
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(largura, y + 0.5); g.stroke();

      const p = picos.current.get(f.id);
      if (!p) {
        g.fillStyle = '#39404f';
        g.font = '11px system-ui';
        g.fillText(fonte.status === 'pronto' ? 'sem onda' : 'analisando áudio…', 8, meio);
        return;
      }
      // Estica o ultimo resultado quando a janela mudou e o novo ainda nao chegou.
      const escalaX = ((p.ate - p.de) / (janela.ate - janela.de)) * (largura / p.largura);
      const deslocX = ((p.de - janela.de) / (janela.ate - janela.de)) * largura;
      const mudo = f.muted || (faixasAudio.some((x) => x.solo) && !f.solo);
      g.fillStyle = mudo ? '#39404f' : (f.color ?? '#4f9cf0');
      const n = p.dados.length / 2;
      for (let c = 0; c < n; c++) {
        const x = Math.round(deslocX + c * escalaX);
        if (x < -2 || x > largura + 2) continue;
        const mn = p.dados[c * 2] / 127;
        const mx = p.dados[c * 2 + 1] / 127;
        const y0 = meio - mx * amp;
        const y1 = meio - mn * amp;
        g.fillRect(x, y0, Math.max(1, Math.ceil(escalaX)), Math.max(1, y1 - y0));
      }
    });

    // --- pista de marcadores
    g.fillStyle = '#151922';
    g.fillRect(0, H_REGUA, largura, H_MARCADORES);
    g.font = '11px system-ui';
    let ultimoRotulo = -Infinity;
    for (const m of marcadores) {
      const fim = m.t_out ?? m.t_in;
      if (fim < janela.de || m.t_in > janela.ate) continue;
      const x = paraX(m.t_in);
      const cor = corDoMarcador(m.color);
      if (m.t_out != null && m.t_out > m.t_in) {
        g.fillStyle = `${cor}33`;
        g.fillRect(x, H_REGUA, Math.max(2, paraX(m.t_out) - x), H_MARCADORES);
      }
      g.fillStyle = cor;
      g.fillRect(x - 1, H_REGUA, 2, H_MARCADORES);
      g.beginPath();
      g.moveTo(x - 4, H_REGUA + 1);
      g.lineTo(x + 4, H_REGUA + 1);
      g.lineTo(x, H_REGUA + 7);
      g.closePath();
      g.fill();
      const rotulo = (m.text || '').split('\n')[0];
      if (rotulo && x > ultimoRotulo + 8) {
        const larg = g.measureText(rotulo).width;
        g.fillStyle = '#c9d2e0';
        g.fillText(rotulo.slice(0, 60), x + 6, H_REGUA + H_MARCADORES / 2 + 1);
        ultimoRotulo = x + Math.min(larg, 200);
      }
    }
  }, [largura, altura, janela, faixasAudio, marcadores, thumbs, temVideo,
      yVideo, yFaixas, paraX, base, tcInicial, pegarFolha, fonte.status, versaoPicos, versaoFolhas]);

  useEffect(() => { desenharConteudo(); }, [desenharConteudo]);

  // ------------------------------------------------------------ overlay
  const hoverRef = useRef<number | null>(null);
  useEffect(() => {
    const cv = cvOverlay.current;
    if (!cv) return;
    let raf = 0;
    const desenhar = () => {
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(largura * dpr) || cv.height !== Math.round(altura * dpr)) {
        cv.width = Math.round(largura * dpr);
        cv.height = Math.round(altura * dpr);
      }
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, largura, altura);

      if (selecao) {
        const x0 = paraX(Math.min(selecao.de, selecao.ate));
        const x1 = paraX(Math.max(selecao.de, selecao.ate));
        g.fillStyle = 'rgba(79,156,240,0.16)';
        g.fillRect(x0, 0, x1 - x0, altura);
        g.strokeStyle = '#4f9cf0';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x0 + 0.5, 0); g.lineTo(x0 + 0.5, altura);
        g.moveTo(x1 - 0.5, 0); g.lineTo(x1 - 0.5, altura);
        g.stroke();
      }

      if (hoverRef.current != null) {
        const x = Math.round(paraX(hoverRef.current)) + 0.5;
        g.strokeStyle = 'rgba(160,172,190,0.35)';
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, altura); g.stroke();
      }

      const x = paraX(player.tempo);
      if (x >= -2 && x <= largura + 2) {
        const xr = Math.round(x) + 0.5;
        g.strokeStyle = '#ff4d4f';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(xr, 0); g.lineTo(xr, altura); g.stroke();
        g.fillStyle = '#ff4d4f';
        g.beginPath();
        g.moveTo(xr - 5, 0); g.lineTo(xr + 5, 0); g.lineTo(xr, 7);
        g.closePath(); g.fill();
      }
      raf = requestAnimationFrame(desenhar);
    };
    raf = requestAnimationFrame(desenhar);
    return () => cancelAnimationFrame(raf);
  }, [largura, altura, paraX, selecao, player]);

  // Segue a agulha: quando ela sai da janela tocando, rola meia tela a frente.
  useEffect(() => player.assinarTempo((t) => {
    if (!player.tocando) return;
    const span = janela.ate - janela.de;
    if (t > janela.ate - span * 0.1 || t < janela.de) {
      setJanela(limitar({ de: t - span * 0.4, ate: t + span * 0.6 }));
    }
  }), [player, janela.de, janela.ate, limitar]);

  // ------------------------------------------------------------ interacao
  const arrastando = useRef<'agulha' | 'selecao' | 'pan' | null>(null);
  const inicioArraste = useRef({ x: 0, t: 0, de: 0 });

  const tempoDoEvento = (e: React.MouseEvent | MouseEvent) => {
    const cv = cvOverlay.current;
    if (!cv) return 0;
    const r = cv.getBoundingClientRect();
    return paraT(Math.max(0, Math.min(largura, e.clientX - r.left)));
  };

  const aoDescer = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = tempoDoEvento(e);
    const cv = cvOverlay.current!;
    const y = e.clientY - cv.getBoundingClientRect().top;

    if (e.button === 1 || e.altKey) {
      arrastando.current = 'pan';
      inicioArraste.current = { x: e.clientX, t, de: janela.de };
    } else if (e.shiftKey) {
      arrastando.current = 'selecao';
      inicioArraste.current = { x: e.clientX, t, de: janela.de };
      aoSelecionar({ de: t, ate: t });
    } else {
      // Clique na pista de marcadores abre o marcador em vez de mover a agulha.
      if (y >= H_REGUA && y < H_REGUA + H_MARCADORES) {
        const tol = ((janela.ate - janela.de) / largura) * 6;
        const alvo = marcadores.find((m) => Math.abs(m.t_in - t) < tol);
        if (alvo) { aoClicarMarcador(alvo); return; }
      }
      arrastando.current = 'agulha';
      player.definirArraste(true);
      player.buscar(t);
    }

    const mover = (ev: MouseEvent) => {
      const tt = tempoDoEvento(ev);
      if (arrastando.current === 'agulha') player.buscar(tt);
      else if (arrastando.current === 'selecao') aoSelecionar({ de: inicioArraste.current.t, ate: tt });
      else if (arrastando.current === 'pan') {
        const span = janela.ate - janela.de;
        const dx = ev.clientX - inicioArraste.current.x;
        const novoDe = inicioArraste.current.de - (dx / largura) * span;
        setJanela(limitar({ de: novoDe, ate: novoDe + span }));
      }
    };
    const soltar = () => {
      arrastando.current = null;
      player.definirArraste(false);
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
  };

  const aoRolar = (e: React.WheelEvent) => {
    const span = janela.ate - janela.de;
    if (e.ctrlKey || e.metaKey) {
      const cv = cvOverlay.current!;
      const ancora = paraT(e.clientX - cv.getBoundingClientRect().left);
      const fator = Math.exp(e.deltaY * 0.0018);
      const novoSpan = Math.max(SPAN_MIN, Math.min(fonte.duration_s || 1, span * fator));
      const razao = (ancora - janela.de) / span;
      setJanela(limitar({ de: ancora - razao * novoSpan, ate: ancora + (1 - razao) * novoSpan }));
    } else {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      const passo = (d / largura) * span * 1.2;
      setJanela(limitar({ de: janela.de + passo, ate: janela.ate + passo }));
    }
  };

  const zoom = (fator: number) => {
    const span = janela.ate - janela.de;
    const centro = player.tempo >= janela.de && player.tempo <= janela.ate
      ? player.tempo : (janela.de + janela.ate) / 2;
    const novoSpan = Math.max(SPAN_MIN, Math.min(fonte.duration_s || 1, span * fator));
    const razao = (centro - janela.de) / span;
    setJanela(limitar({ de: centro - razao * novoSpan, ate: centro + (1 - razao) * novoSpan }));
  };

  // Atalhos de zoom vivem aqui porque dependem da janela atual.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (estaDigitando(e.target)) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1 / 1.6); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(1.6); }
      else if (e.key === '\\') { e.preventDefault(); setJanela(limitar({ de: 0, ate: fonte.duration_s })); }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  });

  const span = janela.ate - janela.de;

  return (
    <div className="timeline" ref={hospedeiro}>
      <div className="tl-cabecalhos" style={{ width: LARGURA_CABECALHO }}>
        <div className="tl-cab-regua">
          <button title="Aproximar (+)" onClick={() => zoom(1 / 1.6)}>+</button>
          <button title="Afastar (−)" onClick={() => zoom(1.6)}>−</button>
          <button title="Vídeo inteiro (\)" onClick={() => setJanela(limitar({ de: 0, ate: fonte.duration_s }))}>⤢</button>
        </div>
        <div className="tl-cab-marcadores">{marcadores.length} marcações</div>
        {temVideo && <div className="tl-cab-video">Vídeo</div>}
        {faixasAudio.map((f) => {
          const temSolo = faixasAudio.some((x) => x.solo);
          return (
            <div className="tl-cab-faixa" key={f.id} style={{ height: H_FAIXA }}>
              <div className="tl-cab-nome">
                <span className="tl-cor" style={{ background: f.color ?? '#4f9cf0' }} />
                <input
                  value={f.label}
                  onChange={(e) => aoMudarFaixa(f.id, { label: e.target.value })}
                  spellCheck={false}
                />
              </div>
              <div className="tl-cab-botoes">
                <button
                  className={f.muted ? 'on mudo' : ''}
                  onClick={() => aoMudarFaixa(f.id, { muted: f.muted ? 0 : 1 })}
                  title="Mudo"
                >M</button>
                <button
                  className={f.solo ? 'on solo' : ''}
                  onClick={() => aoMudarFaixa(f.id, { solo: f.solo ? 0 : 1 })}
                  title="Solo"
                >S</button>
                <button
                  className={f.nav ? 'on nav' : ''}
                  onClick={() => aoMudarFaixa(f.id, { nav: f.nav ? 0 : 1 })}
                  title={'Incluir esta faixa quando Ctrl+← / Ctrl+→ pularem para o '
                    + 'próximo trecho com som'}
                >A</button>
                <input
                  type="range" min={-12} max={12} step={1} value={f.gain_db}
                  onChange={(e) => aoMudarFaixa(f.id, { gain_db: Number(e.target.value) })}
                  title={`Ganho ${f.gain_db > 0 ? '+' : ''}${f.gain_db} dB`}
                />
                <span className={`tl-db ${temSolo && !f.solo ? 'apagado' : ''}`}>
                  {f.gain_db > 0 ? '+' : ''}{f.gain_db}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="tl-area" style={{ height: altura }}>
        <canvas ref={cvConteudo} style={{ width: largura, height: altura }} />
        <canvas
          ref={cvOverlay}
          style={{ width: largura, height: altura }}
          onMouseDown={aoDescer}
          onWheel={aoRolar}
          onMouseMove={(e) => { hoverRef.current = tempoDoEvento(e); }}
          onMouseLeave={() => { hoverRef.current = null; }}
          onDoubleClick={() => aoSelecionar(null)}
        />
        <div className="tl-escala">
          janela {duracaoCurta(span, span < 60)} · {(span / largura * 1000).toFixed(0)} ms/px
          {'  ·  ctrl+roda = zoom · alt+arrasta = mover · shift+arrasta = selecionar'}
        </div>
      </div>
    </div>
  );
}

/** Passo da regua: o maior "numero redondo" que ainda deixa ~90 px entre marcas. */
function escolherPasso(span: number, largura: number) {
  const alvo = (span / largura) * 90;
  const passos = [
    0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600,
  ];
  return passos.find((p) => p >= alvo) ?? 21600;
}
