import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ouvirProgresso, type Faixa, type Fonte, type Marcador, type Qualidade,
  type Veredito } from './lib/api';
import { Player } from './lib/player';
import { estaDigitando } from './lib/teclado';
import { caminhoDoArrasto, sessao } from './lib/sessao';
import { navegacao, posicaoNaFila, vizinhoNaFila } from './lib/navegacao';
import { Inicio } from './components/Inicio';
import { Visor } from './components/Player';
import { Timeline } from './components/Timeline';
import { PainelLog } from './components/PainelLog';
import { PainelTranscricao } from './components/PainelTranscricao';
import { Controles } from './components/Controles';
import { MenuQualidade } from './components/MenuQualidade';
import { IndicadorTranscricao, estadoDaTranscricao } from './components/IndicadorTranscricao';
import { baseDoArquivo } from './lib/tempo';

type Selecao = { de: number; ate: number } | null;

/**
 * O nome do arquivo, editavel ali mesmo.
 *
 * Batizar a gravacao e a hora em que voce DESCOBRE o que ela e — assistindo.
 * Ter que guardar isso na cabeca, voltar pra biblioteca e procurar o arquivo de
 * novo e o jeito de nunca renomear nada.
 *
 * Renomear com o video rodando nao interrompe nada: o Windows permite renomear
 * um arquivo com leitura aberta, e o stream que o servidor ja tem continua lendo
 * ate o fim.
 */
function TituloEditavel({ fonte, aoRenomear, aoAvisar }: {
  fonte: Fonte;
  aoRenomear: (f: Fonte) => void;
  aoAvisar: (msg: string) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState('');
  const [salvando, setSalvando] = useState(false);

  const semExtensao = fonte.name.replace(/\.[^.]+$/, '');

  const abrir = () => { setTexto(semExtensao); setEditando(true); };

  const salvar = async () => {
    const novo = texto.trim();
    if (!novo || novo === semExtensao) { setEditando(false); return; }
    setSalvando(true);
    try {
      const f = await api.renomearFonte(fonte.id, novo);
      aoRenomear(f);
      aoAvisar(f.renomeado.nome === novo
        ? `renomeado para ${f.renomeado.nome}`
        : `já existia um com esse nome — ficou ${f.renomeado.nome}`);
      setEditando(false);
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setSalvando(false); }
  };

  if (!editando) {
    return (
      <button
        className="cinema-titulo editavel"
        title={`${fonte.path}

Clique para renomear`}
        onClick={abrir}
      >
        {fonte.name}
        <span className="titulo-lapis">✎</span>
      </button>
    );
  }

  return (
    <input
      className="cinema-titulo campo"
      value={texto}
      autoFocus
      disabled={salvando}
      onChange={(e) => setTexto(e.target.value)}
      onBlur={salvar}
      onKeyDown={(e) => {
        // O teclado do player inteiro escuta a janela: espaco pausaria, T
        // trocaria de modo. Enquanto se digita um nome, nada disso pode valer.
        e.stopPropagation();
        if (e.key === 'Enter') salvar();
        if (e.key === 'Escape') setEditando(false);
      }}
    />
  );
}

const VEREDITOS: { valor: Veredito; rotulo: string; tecla: string }[] = [
  { valor: 'usar', rotulo: 'Usar', tecla: '1' },
  { valor: 'talvez', rotulo: 'Talvez', tecla: '2' },
  { valor: 'descartar', rotulo: 'Descartar', tecla: '3' },
];

/**
 * Triagem no cinema: onde você está na fila, e o que achou do que viu.
 *
 * Os botões existem pra ensinar os atalhos, não pra serem o caminho normal —
 * cada um mostra a tecla. Quem tria quarenta gravações faz isso com a mão no
 * teclado; quem tria duas clica.
 */
function BarraTriagem({ fonte, veredito, aoJulgar, aoPassar }: {
  fonte: Fonte;
  veredito: Veredito | null;
  aoJulgar: (v: Veredito) => void;
  aoPassar: (passo: 1 | -1) => void;
}) {
  const i = posicaoNaFila(fonte.path);
  const total = navegacao().fila.length;

  return (
    <div className="triagem">
      {i >= 0 && total > 1 && (
        <div className="triagem-fila">
          <button
            className="triagem-seta"
            onClick={() => aoPassar(-1)}
            disabled={i === 0}
            title="Anterior da pasta (↑)"
          >‹</button>
          <span className="triagem-conta">{i + 1} <small>de {total}</small></span>
          <button
            className="triagem-seta"
            onClick={() => aoPassar(1)}
            disabled={i === total - 1}
            title="Próximo da pasta (↓)"
          >›</button>
        </div>
      )}
      <div className="triagem-vereditos">
        {VEREDITOS.map((v) => (
          <button
            key={v.valor}
            className={`triagem-btn ${v.valor} ${veredito === v.valor ? 'on' : ''}`}
            onClick={() => aoJulgar(v.valor)}
            title={`${v.rotulo} (${v.tecla}) — a mesma tecla de novo desfaz`}
          >
            <kbd>{v.tecla}</kbd>{v.rotulo}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [atualId, setAtualId] = useState<number | null>(null);
  const [fonte, setFonte] = useState<Fonte | null>(null);
  const [marcadores, setMarcadores] = useState<Marcador[]>([]);
  const [selecao, setSelecao] = useState<Selecao>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [verTranscricao, setVerTranscricao] = useState(false);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  // Abre sempre em cinema, como o Media Player: o vídeo primeiro, o resto
  // depois. Os painéis de revisão ficam a um clique.
  const [modo, setModo] = useState<'cinema' | 'estudio'>('cinema');
  const [telaCheia, setTelaCheia] = useState(false);
  const palco = useRef<HTMLDivElement>(null);
  // Qualidade da reprodução. Original por padrão: o proxy existe pra arrastar a
  // agulha sem engasgo, não pra ser a única coisa que dá pra assistir.
  const [qualidade, setQualidade] = useState<Qualidade>('original');
  // Contador só para forçar o <video> a buscar de novo a MESMA URL.
  const [recarga, setRecarga] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // O veredito do arquivo aberto. Vem do servidor ao abrir e e otimista ao
  // julgar: numa triagem, a tecla precisa responder na hora.
  const [veredito, setVeredito] = useState<Veredito | null>(null);
  const player = useMemo(() => new Player(), []);

  // Em desenvolvimento, deixa o motor de reprodução acessível pelo console — sem
  // isso não dá pra investigar quem mandou pausar ou buscar.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { player?: Player }).player = player;
  }, [player]);
  const timerAviso = useRef(0);

  const avisar = useCallback((msg: string) => {
    setAviso(msg);
    clearTimeout(timerAviso.current);
    timerAviso.current = window.setTimeout(() => setAviso(null), 6000);
  }, []);

  const recarregarFonte = useCallback(async (id: number) => {
    try { setFonte(await api.fonte(id)); } catch (e) { avisar(String((e as Error).message)); }
  }, [avisar]);

  useEffect(() => () => player.destruir(), [player]);

  useEffect(() => {
    if (atualId == null) { setFonte(null); return; }
    recarregarFonte(atualId);
    api.marcadores(atualId).then(setMarcadores).catch(() => undefined);
    setSelecao(null);
  }, [atualId, recarregarFonte]);

  // Progresso do ingest chega por SSE. Quando termina, recarrega a fonte pra
  // pegar proxy/miniaturas/picos que acabaram de nascer.
  useEffect(() => ouvirProgresso((ev) => {
    // A fila de preparo tem o próprio painel; aqui só passaria batido.
    if (ev.tipo === 'fila') return;
    if (ev.tipo === 'transcricao') {
      setFonte((f) => (f && f.id === ev.sourceId
        ? {
          ...f,
          tracks: f.tracks.map((t) => (t.id === ev.trackId
            ? {
              ...t,
              transc_status: (ev.status as Faixa['transc_status']) ?? t.transc_status,
              transc_progresso: ev.progresso ?? t.transc_progresso,
              transc_erro: ev.erro ?? null,
              idioma: ev.idioma ?? t.idioma,
            }
            : t)),
        }
        : f));
      return;
    }
    if (ev.sourceId === atualId) {
      setFonte((f) => (f && f.id === ev.sourceId
        ? { ...f, status: (ev.status as Fonte['status']) ?? f.status, progress: ev.progress ?? f.progress, stage: ev.stage ?? f.stage }
        : f));
      if (ev.status === 'pronto' || ev.status === 'erro') {
        recarregarFonte(ev.sourceId);
        // Terminou de gerar a qualidade escolhida. A URL não muda (o servidor
        // serve o original enquanto o nível não existe), então trocar o estado
        // não recarregaria nada: quem recarrega é o `load()` lá no visor.
        if (String(ev.stage || '').startsWith('qualidade')) {
          setRecarga((n) => n + 1);
        }
      }
    }
  }), [atualId, recarregarFonte]);

  // ------------------------------------------------------------- acoes

  /**
   * Promove de assistir para revisar: gera proxy e miniaturas da régua.
   * É uma escolha explícita porque custa caro — ~15 GB de proxy por 10 h.
   */
  const revisar = async () => {
    if (!fonte) return;
    try {
      await api.revisar(fonte.id);
      avisar('gerando proxy e miniaturas — dá pra continuar assistindo enquanto isso');
    } catch (e) { avisar(String((e as Error).message)); }
  };

  /**
   * Modo assistir: toca já, sem gerar proxy.
   *
   * É o caminho do duplo clique e do arrastar-e-soltar. Só a extração de áudio
   * roda em segundo plano, e só quando o arquivo tem mais de uma faixa — que é
   * quando o mixer tem o que mixar.
   */
  const assistir = useCallback(async (caminho: string) => {
    setAbrindo(caminho);
    setVeredito(null);
    try {
      const f = await api.assistir(caminho);
      setAtualId(f.id);
      setModo('cinema');
      setQualidade('original');
      // O veredito mora na biblioteca, não na fonte: busca à parte.
      api.infoMidiaPorCaminho(caminho)
        .then((m) => setVeredito(m.veredito ?? null))
        .catch(() => undefined);
      if (f.extraindoAudio) avisar('separando as faixas de áudio em segundo plano…');
    } catch (e) {
      avisar(`não consegui abrir: ${(e as Error).message}`);
    } finally {
      setAbrindo(null);
    }
  }, [avisar]);

  /**
   * Próximo / anterior na fila que você estava vendo.
   *
   * Sem isto, julgar dez gravações são dez idas e voltas pela biblioteca; o
   * trabalho vira o vai-e-volta, não o assistir.
   */
  const passar = useCallback((passo: 1 | -1) => {
    if (!fonte) return;
    const alvo = vizinhoNaFila(fonte.path, passo);
    if (!alvo) {
      avisar(posicaoNaFila(fonte.path) < 0
        ? 'este vídeo não veio de uma lista — volte à biblioteca para escolher'
        : passo > 0 ? 'é o último da pasta' : 'é o primeiro da pasta');
      return;
    }
    player.pausar();
    assistir(alvo);
  }, [fonte, player, assistir, avisar]);

  /** O veredito da triagem. A mesma tecla de novo desfaz. */
  const julgar = useCallback(async (valor: Veredito) => {
    if (!fonte) return;
    const novo = veredito === valor ? null : valor;
    setVeredito(novo);
    try { await api.julgarFonte(fonte.id, novo); }
    catch (e) { setVeredito(veredito); avisar(String((e as Error).message)); }
  }, [fonte, veredito, avisar]);

  // "Abrir com" do Windows, e o segundo duplo clique com a janela já aberta.
  useEffect(() => {
    let vivo = true;
    sessao().then((s) => { if (vivo && s.arquivoInicial) assistir(s.arquivoInicial); });
    const parar = window.revisor?.aoAbrirArquivo((caminho) => assistir(caminho));
    return () => { vivo = false; parar?.(); };
  }, [assistir]);

  // Arrastar e soltar em qualquer lugar da janela.
  useEffect(() => {
    const permitir = (e: DragEvent) => { e.preventDefault(); };
    const soltar = (e: DragEvent) => {
      e.preventDefault();
      const arquivo = e.dataTransfer?.files?.[0];
      if (!arquivo) return;
      const caminho = caminhoDoArrasto(arquivo);
      if (caminho) assistir(caminho);
      else avisar('arrastar e soltar só funciona no aplicativo, não no navegador');
    };
    window.addEventListener('dragover', permitir);
    window.addEventListener('drop', soltar);
    return () => {
      window.removeEventListener('dragover', permitir);
      window.removeEventListener('drop', soltar);
    };
  }, [assistir, avisar]);

  const criarMarcador = async (m: Partial<Marcador>) => {
    if (!fonte) return;
    try {
      const novo = await api.criarMarcador(fonte.id, m);
      setMarcadores((l) => [...l, novo].sort((a, b) => a.t_in - b.t_in));
      setSelecao(null);
    } catch (e) { avisar(String((e as Error).message)); }
  };

  const atualizarMarcador = async (id: number, patch: Partial<Marcador>) => {
    setMarcadores((l) => l.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    try { await api.atualizarMarcador(id, patch); }
    catch (e) { avisar(String((e as Error).message)); if (fonte) api.marcadores(fonte.id).then(setMarcadores); }
  };

  const apagarMarcador = async (id: number) => {
    setMarcadores((l) => l.filter((m) => m.id !== id));
    try { await api.apagarMarcador(id); } catch (e) { avisar(String((e as Error).message)); }
  };

  const mudarFaixa = async (id: number, patch: Partial<Faixa>) => {
    setFonte((f) => (f ? { ...f, tracks: f.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : f));
    try { await api.atualizarFaixa(id, patch); } catch (e) { avisar(String((e as Error).message)); }
  };

  const exportar = async (formato: string) => {
    if (!fonte) return;
    try {
      const r = await api.exportar(fonte.id, formato);
      avisar(`salvo em ${r.arquivo}`);
    } catch (e) { avisar(`export falhou: ${(e as Error).message}`); }
  };

  /**
   * Ctrl+← / Ctrl+→: pula direto pro próximo trecho em que alguém fala, pulando
   * o silêncio. Só entram as faixas com o botão "A" ligado — como cada microfone
   * é uma faixa, dá pra percorrer só as falas de uma pessoa.
   */
  const pularTrecho = async (dir: 1 | -1) => {
    if (!fonte) return;
    try {
      const r = await api.segmento(fonte.id, player.tempo, dir);
      if (r.t == null) avisar(dir > 0 ? 'último trecho com som' : 'primeiro trecho com som');
      else player.buscar(r.t);
    } catch (e) { avisar(String((e as Error).message)); }
  };

  /**
   * O Chromium não decodifica tudo o que um editor gera: ProRes, DNxHD, MXF e
   * AVI antigo passam pelo ffmpeg mas não pelo `<video>`. Tocar o arquivo como
   * foi gravado é o padrão certo — mas quando o padrão não toca, cair calado
   * numa tela preta é o pior resultado possível. Aqui a falha vira uma
   * conversão: usa o nível que já existir, senão gera um.
   */
  const aoFalharVideo = useCallback(async (codigo: number) => {
    // Só interessa "não sei decodificar isto" (SRC_NOT_SUPPORTED / DECODE).
    if (!fonte || qualidade !== 'original') return;
    if (codigo !== 4 && codigo !== 3) return;
    try {
      const { niveis } = await api.qualidades(fonte.id);
      const pronto = niveis.find((n) => n.divisor > 1 && n.pronto);
      if (pronto) {
        setQualidade(pronto.nome);
        avisar('este formato o player não decodifica direto — tocando a versão convertida');
        return;
      }
      await api.gerarQualidade(fonte.id, 'metade');
      setQualidade('metade');
      avisar('formato que o player não abre direto (ProRes, MXF, AVI antigo) — '
        + 'convertendo; começa a tocar sozinho quando ficar pronto');
    } catch (e) { avisar(`não consegui abrir este arquivo: ${(e as Error).message}`); }
  }, [fonte, qualidade, avisar]);

  const alternarTelaCheia = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await palco.current?.requestFullscreen();
    } catch (e) { avisar(String((e as Error).message)); }
  }, [avisar]);

  useEffect(() => {
    const mudou = () => setTelaCheia(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', mudou);
    return () => document.removeEventListener('fullscreenchange', mudou);
  }, []);

  // ------------------------------------------------------------- atalhos
  useEffect(() => {
    if (!fonte) return;
    const fps = baseDoArquivo(fonte.fps, fonte.start_timecode).fps;
    const aoTeclar = (e: KeyboardEvent) => {
      if (estaDigitando(e.target)) return;
      switch (e.key) {
        case ' ': e.preventDefault(); player.alternar(); break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey) pularTrecho(-1);
          else player.pular(e.shiftKey ? -fps : -1, fps);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey) pularTrecho(1);
          else player.pular(e.shiftKey ? fps : 1, fps);
          break;
        case 'i': case 'I':
          setSelecao((s) => ({ de: player.tempo, ate: Math.max(player.tempo, s?.ate ?? player.tempo) }));
          break;
        case 'o': case 'O':
          setSelecao((s) => ({ de: Math.min(player.tempo, s?.de ?? player.tempo), ate: player.tempo }));
          break;
        case 'f': case 'F': e.preventDefault(); alternarTelaCheia(); break;
        case 'j': case 'J': e.preventDefault(); player.pular(-10 * fps, fps); break;
        case 'l': case 'L': e.preventDefault(); player.pular(10 * fps, fps); break;
        case 'k': case 'K': e.preventDefault(); player.alternar(); break;
        case 'm': case 'M':
          e.preventDefault();
          // No cinema, M é mudo — como em todo reprodutor. No estúdio, é marcador.
          if (modo === 'cinema') player.definirVolume(player.volumeMestre > 0 ? 0 : 1);
          else criarMarcador({ t_in: player.tempo, text: 'marcador', color: 'amarelo' });
          break;
        case 't': case 'T':
          if (modo === 'cinema') { e.preventDefault(); setModo('estudio'); }
          break;
        // Triagem: percorrer a fila e dar o veredito sem tocar no mouse.
        case 'ArrowDown': e.preventDefault(); passar(1); break;
        case 'ArrowUp': e.preventDefault(); passar(-1); break;
        case '1': e.preventDefault(); julgar('usar'); break;
        case '2': e.preventDefault(); julgar('talvez'); break;
        case '3': e.preventDefault(); julgar('descartar'); break;
        case 'Escape':
          if (document.fullscreenElement) break;   // o próprio Esc já sai da tela cheia
          if (modo === 'estudio') setModo('cinema');
          setSelecao(null);
          break;
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  });

  const estadoTranscricao = useMemo(
    () => (fonte ? estadoDaTranscricao(fonte.tracks) : null), [fonte?.tracks]);

  // ------------------------------------------------------------- render

  if (abrindo && !fonte) {
    return (
      <div className="app">
        <Cabecalho />
        <div className="abrindo">
          <div className="abrindo-nome">{abrindo.split(/[\\/]/).pop()}</div>
          <div className="abrindo-barra"><i /></div>
        </div>
      </div>
    );
  }

  if (!fonte) {
    return (
      <div className="app">
        <Cabecalho />
        <Inicio aoAbrir={assistir} aoAvisar={avisar} />
        {aviso && <div className="aviso-flutuante">{aviso}</div>}
      </div>
    );
  }

  const controles = (
    <Controles
      fonte={fonte}
      player={player}
      telaCheia={telaCheia}
      aoAlternarTelaCheia={alternarTelaCheia}
      aoMudarFaixa={mudarFaixa}
    />
  );

  // Cinema: o vídeo ocupa a janela inteira e nada mais aparece até você pedir.
  // É como o Media Player abre, e é o que faz o Revisor servir como reprodutor
  // do dia a dia em vez de parecer uma bancada de edição toda vez.
  if (modo === 'cinema') {
    return (
      <div className="app cinema" ref={palco}>
        <div className="cinema-palco">
          <Visor
            fonte={fonte}
            player={player}
            qualidade={qualidade}
            recarga={recarga}
            aoFalhar={aoFalharVideo}
            aoPedirMenu={(x, y) => setMenu({ x, y })}
          />
          {controles}
          <div className="cinema-topo">
            <button
              className="cinema-btn"
              onClick={() => { player.pausar(); setAtualId(null); }}
              title="Voltar para a biblioteca"
            >←</button>
            <button
              className="cinema-btn destaque"
              onClick={() => setModo('estudio')}
              title="Mostrar transcrição, faixas e timeline (T)"
            >
              <span className="cinema-btn-icone">▤</span>
              Painéis
            </button>
            <TituloEditavel
              fonte={fonte}
              aoAvisar={avisar}
              aoRenomear={(f) => setFonte(f)}
            />
            {estadoTranscricao?.emCurso && (
              <span className="cinema-selo" title="transcrevendo em segundo plano">
                <i />transcrevendo {Math.round(estadoTranscricao.pct * 100)}%
              </span>
            )}
            <BarraTriagem
              fonte={fonte}
              veredito={veredito}
              aoJulgar={julgar}
              aoPassar={passar}
            />
          </div>
        </div>
        {menu && (
          <MenuQualidade
            fonteId={fonte.id}
            x={menu.x}
            y={menu.y}
            atual={qualidade}
            aoEscolher={setQualidade}
            aoFechar={() => setMenu(null)}
            aoAvisar={avisar}
          />
        )}
        {aviso && <div className="aviso-flutuante">{aviso}</div>}
      </div>
    );
  }

  return (
    <div className="app trabalhando" ref={palco}>
      <Cabecalho>
        <button className="voltar" onClick={() => setModo('cinema')} title="Voltar ao modo cinema (Esc)">
          ← cinema
        </button>
        <button className="voltar" onClick={() => { player.pausar(); setAtualId(null); }}>biblioteca</button>
        <span className="titulo-arquivo" title={fonte.path}>{fonte.name}</span>
        <div className="acoes-topo">
          <button onClick={() => exportar('fcp7')} title="Gera o XML da sequência com todas as marcações; importe no Premiere">
            Enviar pro Premiere
          </button>
          <button onClick={() => exportar('csv')}>CSV</button>
          <span className="separador" />
          <button
            onClick={revisar}
            disabled={!!fonte.proxy_path}
            title={fonte.proxy_path
              ? 'proxy e miniaturas já existem'
              : 'Gera proxy e miniaturas — deixa a timeline fluida, custa disco'}
          >{fonte.proxy_path ? 'Revisão pronta' : 'Preparar revisão'}</button>
          <span className="separador" />
          {estadoTranscricao && (
            <IndicadorTranscricao
              estado={estadoTranscricao}
              aberto={verTranscricao}
              onClick={() => setVerTranscricao((v) => !v)}
              title={estadoTranscricao.completa
                ? `${estadoTranscricao.total} faixas transcritas — clique para abrir`
                : 'Mostrar a transcrição, uma coluna por faixa'}
            />
          )}
        </div>
      </Cabecalho>

      <div className={`area-principal${verTranscricao ? ' com-transcricao' : ''}`}>
        <div className="visor-palco">
          <Visor
            fonte={fonte}
            player={player}
            qualidade={qualidade}
            recarga={recarga}
            aoFalhar={aoFalharVideo}
            aoPedirMenu={(x, y) => setMenu({ x, y })}
          />
          {controles}
        </div>
        <PainelLog
          fonte={fonte}
          player={player}
          marcadores={marcadores}
          selecao={selecao}
          aoCriar={criarMarcador}
          aoAtualizar={atualizarMarcador}
          aoApagar={apagarMarcador}
          aoAvisar={avisar}
        />
        {verTranscricao && (
          <PainelTranscricao
            fonte={fonte}
            player={player}
            aoAvisar={avisar}
            aoFechar={() => setVerTranscricao(false)}
          />
        )}
      </div>

      <Timeline
        fonte={fonte}
        player={player}
        marcadores={marcadores}
        selecao={selecao}
        aoSelecionar={setSelecao}
        aoClicarMarcador={(m) => player.buscar(m.t_in)}
        aoMudarFaixa={mudarFaixa}
      />

      {menu && (
        <MenuQualidade
          fonteId={fonte.id}
          x={menu.x}
          y={menu.y}
          atual={qualidade}
          aoEscolher={setQualidade}
          aoFechar={() => setMenu(null)}
          aoAvisar={avisar}
        />
      )}
      {aviso && <div className="aviso-flutuante">{aviso}</div>}
    </div>
  );
}

function Cabecalho({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topo">
      <span className="marca">Revisor</span>
      {children}
    </header>
  );
}
