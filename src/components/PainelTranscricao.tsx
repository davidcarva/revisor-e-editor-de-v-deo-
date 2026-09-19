// Painel de transcrição, uma coluna por faixa.
//
// Cada microfone é uma faixa, então uma coluna por faixa é uma coluna por pessoa
// — a atribuição de fala sai correta sem diarização nenhuma.
//
// Só as falas da janela visível são buscadas. Uma gravação longa tem dezenas de
// milhares de linhas; renderizar tudo, ou baixar tudo, mata a interface.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Faixa, type Fala, type Fonte } from '../lib/api';
import { baseDoArquivo, duracaoCurta, tcDaOrigem } from '../lib/tempo';
import type { Player } from '../lib/player';

const JANELA = 180;   // s visíveis de cada lado da agulha

type Props = {
  fonte: Fonte;
  player: Player;
  aoAvisar: (msg: string) => void;
  aoFechar: () => void;
};

export function PainelTranscricao({ fonte, player, aoAvisar, aoFechar }: Props) {
  const [falas, setFalas] = useState<Fala[]>([]);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState<Fala[]>([]);
  const [indiceAchado, setIndiceAchado] = useState(0);
  const [tempo, setTempo] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  const corpo = useRef<HTMLDivElement>(null);
  const seguirAgulha = useRef(true);

  const base = useMemo(() => baseDoArquivo(fonte.fps, fonte.start_timecode),
    [fonte.fps, fonte.start_timecode]);
  const faixas = useMemo(
    () => fonte.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.ord - b.ord),
    [fonte.tracks]);
  const colunaDa = useMemo(() => {
    const m = new Map<number, number>();
    faixas.forEach((f, i) => m.set(f.id, i));
    return m;
  }, [faixas]);

  const emAndamento = faixas.some((f) =>
    ['na fila', 'carregando modelo', 'transcrevendo'].includes(f.transc_status));
  const alguemPronto = faixas.some((f) => f.transc_status === 'pronta');

  // Acompanha a agulha só de longe: refazer a busca a cada quadro seria absurdo.
  useEffect(() => {
    let ultimo = -999;
    return player.assinarTempo((t) => {
      if (Math.abs(t - ultimo) < 1) return;
      ultimo = t;
      setTempo(t);
    });
  }, [player]);

  const janela = useMemo(() => {
    const centro = Math.floor(tempo / JANELA) * JANELA;   // degraus: evita refetch constante
    return { de: Math.max(0, centro - JANELA), ate: centro + JANELA * 2 };
  }, [tempo]);

  const carregar = useCallback(async () => {
    if (!alguemPronto) { setFalas([]); return; }
    try {
      const r = await api.transcricao(fonte.id, janela.de, janela.ate);
      setFalas(r.trechos);
      setTotal(r.total);
    } catch { /* transcrição ainda não existe */ }
  }, [fonte.id, janela.de, janela.ate, alguemPronto]);

  useEffect(() => { carregar(); }, [carregar]);

  // Busca com atraso: digitar não deve disparar uma consulta por tecla.
  useEffect(() => {
    const q = busca.trim();
    if (!q) { setAchados([]); return; }
    const id = window.setTimeout(async () => {
      try {
        const r = await api.buscarNaTranscricao(fonte.id, q);
        setAchados(r.trechos);
        setIndiceAchado(0);
      } catch { setAchados([]); }
    }, 250);
    return () => clearTimeout(id);
  }, [busca, fonte.id]);

  const irParaAchado = (i: number) => {
    if (!achados.length) return;
    const n = ((i % achados.length) + achados.length) % achados.length;
    setIndiceAchado(n);
    seguirAgulha.current = true;
    player.buscar(achados[n].t_in);
  };

  // Rola pra fala corrente enquanto o vídeo anda, mas para de forçar assim que
  // você rola com a mão — senão fica impossível ler pra frente.
  useEffect(() => {
    if (!seguirAgulha.current || !corpo.current) return;
    const alvo = corpo.current.querySelector('.fala.atual');
    alvo?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [tempo, falas]);

  const transcrever = async (refazer: boolean) => {
    setOcupado(true);
    try {
      await api.transcrever(fonte.id, { refazer });
      aoAvisar('transcrevendo na GPU — as faixas saem uma de cada vez');
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  const marcados = useMemo(() => new Set(achados.map((f) => f.id)), [achados]);

  return (
    <aside className="transcricao">
      <header className="transc-topo">
        <strong>Transcrição</strong>
        <input
          className="busca"
          placeholder="buscar na fala…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') irParaAchado(indiceAchado + (e.shiftKey ? -1 : 1));
            if (e.key === 'Escape') { setBusca(''); e.currentTarget.blur(); }
          }}
        />
        {busca.trim() && (
          <span className="achados">
            <button onClick={() => irParaAchado(indiceAchado - 1)} disabled={!achados.length}>‹</button>
            {achados.length ? `${indiceAchado + 1}/${achados.length}` : '0'}
            <button onClick={() => irParaAchado(indiceAchado + 1)} disabled={!achados.length}>›</button>
          </span>
        )}
        <button className="fechar" onClick={aoFechar} title="Fechar a transcrição">✕</button>
      </header>

      {faixas.some((f) => f.transc_status === 'erro') && (
        <div className="transc-erro">
          {faixas.find((f) => f.transc_status === 'erro')?.transc_erro}
        </div>
      )}

      {!alguemPronto && !emAndamento && (
        <div className="transc-vazio">
          <p>Nenhuma faixa transcrita ainda.</p>
          <p className="detalhe">
            Roda na GPU, uma faixa de cada vez, a ~26× o tempo real — uma gravação
            de 1 h sai em pouco mais de 2 minutos por faixa.
          </p>
          <button className="primario" disabled={ocupado} onClick={() => transcrever(false)}>
            Transcrever {faixas.length} faixas
          </button>
        </div>
      )}

      {emAndamento && (
        <div className="transc-andamento">
          {faixas.map((f) => (
            <div key={f.id} className="transc-linha">
              <span className="cor" style={{ background: f.color ?? '#4f9cf0' }} />
              <span className="nome">{f.label}</span>
              <span className="estado">
                {f.transc_status === 'transcrevendo'
                  ? `${(f.transc_progresso * 100).toFixed(0)}%`
                  : f.transc_status}
              </span>
              <div className="barra"><i style={{ width: `${f.transc_progresso * 100}%` }} /></div>
            </div>
          ))}
          <button onClick={() => api.cancelarTranscricao(fonte.id)}>Cancelar</button>
        </div>
      )}

      {alguemPronto && (
        <>
          <div className="transc-cabecalho" style={{ gridTemplateColumns: `repeat(${faixas.length}, 1fr)` }}>
            {faixas.map((f) => (
              <span key={f.id} className="col-nome" title={f.label}>
                <i style={{ background: f.color ?? '#4f9cf0' }} />
                {f.label}
              </span>
            ))}
          </div>

          <div
            className="transc-corpo"
            ref={corpo}
            onWheel={() => { seguirAgulha.current = false; }}
          >
            {falas.length === 0 && <p className="vazio">nenhuma fala nesta parte do vídeo</p>}
            {falas.map((f) => {
              const col = colunaDa.get(f.track_id) ?? 0;
              const atual = tempo >= f.t_in && tempo < f.t_out;
              return (
                <div
                  key={f.id}
                  className="fala-linha"
                  style={{ gridTemplateColumns: `repeat(${faixas.length}, 1fr)` }}
                >
                  <button
                    className={`fala ${atual ? 'atual' : ''} ${marcados.has(f.id) ? 'achada' : ''}`}
                    style={{ gridColumn: col + 1, borderLeftColor: corDaFaixa(faixas, col) }}
                    onClick={() => { seguirAgulha.current = true; player.buscar(f.t_in); }}
                    title={`${tcDaOrigem(f.t_in, base, fonte.start_timecode)} · ${duracaoCurta(f.t_out - f.t_in, true)}`}
                  >
                    <span className="fala-tc">{tcDaOrigem(f.t_in, base, fonte.start_timecode).slice(0, 8)}</span>
                    <span className="fala-texto">{f.texto}</span>
                  </button>
                </div>
              );
            })}
          </div>

          <footer className="transc-rodape">
            <span>{total.toLocaleString('pt-BR')} falas</span>
            <button
              onClick={() => { seguirAgulha.current = true; setTempo(player.tempo + 0.001); }}
              title="Voltar a acompanhar a agulha"
            >Seguir o vídeo</button>
            <button disabled={ocupado || emAndamento} onClick={() => transcrever(true)}>
              Refazer
            </button>
          </footer>
        </>
      )}
    </aside>
  );
}

const corDaFaixa = (faixas: Faixa[], col: number) => faixas[col]?.color ?? '#4f9cf0';

