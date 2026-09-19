import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ouvirProgresso, type Faixa, type Fonte, type Marcador } from './lib/api';
import { Player } from './lib/player';
import { estaDigitando } from './lib/teclado';
import { caminhoDoArrasto, sessao } from './lib/sessao';
import { Inicio } from './components/Inicio';
import { Visor } from './components/Player';
import { Timeline } from './components/Timeline';
import { PainelLog } from './components/PainelLog';
import { PainelTranscricao } from './components/PainelTranscricao';
import { IndicadorTranscricao, estadoDaTranscricao } from './components/IndicadorTranscricao';
import { baseDoArquivo } from './lib/tempo';

type Selecao = { de: number; ate: number } | null;

export default function App() {
  const [atualId, setAtualId] = useState<number | null>(null);
  const [fonte, setFonte] = useState<Fonte | null>(null);
  const [marcadores, setMarcadores] = useState<Marcador[]>([]);
  const [selecao, setSelecao] = useState<Selecao>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [verTranscricao, setVerTranscricao] = useState(false);
  const [abrindo, setAbrindo] = useState<string | null>(null);
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
      if (ev.status === 'pronto' || ev.status === 'erro') recarregarFonte(ev.sourceId);
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
    try {
      const f = await api.assistir(caminho);
      setAtualId(f.id);
      if (f.extraindoAudio) avisar('separando as faixas de áudio em segundo plano…');
    } catch (e) {
      avisar(`não consegui abrir: ${(e as Error).message}`);
    } finally {
      setAbrindo(null);
    }
  }, [avisar]);

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
        case 'm': case 'M':
          criarMarcador({ t_in: player.tempo, text: 'marcador', color: 'amarelo' });
          break;
        case 'Escape': setSelecao(null); break;
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

  return (
    <div className="app trabalhando">
      <Cabecalho>
        <button className="voltar" onClick={() => { player.pausar(); setAtualId(null); }}>← acervo</button>
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
        <Visor fonte={fonte} player={player} />
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
