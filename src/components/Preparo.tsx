// Preparar vários arquivos de uma vez, e ver o quanto isso custa em disco.
//
// A escolha entre "só áudio" e "revisão completa" não é detalhe: são ~95 MB por
// hora contra ~1,5 GB por hora, medidos do cache de verdade. Por isso o diálogo
// mostra os dois números antes de você decidir, em vez de esconder a diferença
// atrás de um botão "preparar".
import { useEffect, useRef, useState } from 'react';
import { api, ouvirProgresso, type EstadoFila, type Estimativa } from '../lib/api';

export const tamanho = (b: number) => (b >= 1e9
  ? `${(b / 1e9).toFixed(1)} GB`
  : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} kB`);

// ------------------------------------------------------------- diálogo

type PropsDialogo = {
  caminhos: string[];
  aoFechar: () => void;
  aoAvisar: (msg: string) => void;
};

export function DialogoPreparar({ caminhos, aoFechar, aoAvisar }: PropsDialogo) {
  const [est, setEst] = useState<{ audio: Estimativa; revisao: Estimativa } | null>(null);
  const [comVideo, setComVideo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    let vivo = true;
    api.estimativaFila(caminhos)
      .then((r) => { if (vivo) setEst(r); })
      .catch(() => { if (vivo) setEst(null); });
    return () => { vivo = false; };
  }, [caminhos]);

  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await api.enfileirar(caminhos, comVideo);
      aoAvisar(r.novos === 0
        ? 'todos esses já estavam na fila'
        : `${r.novos} na fila — dá pra continuar usando o app enquanto prepara`);
      aoFechar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setEnviando(false); }
  };

  const escolhido = comVideo ? est?.revisao : est?.audio;
  // Quem ainda não passou pelo ffprobe entra na conta pelo tamanho do arquivo,
  // que é menos preciso. Dizer isso é mais honesto do que arredondar e calar.
  const incerto = escolhido && escolhido.comDuracao < escolhido.total;

  return (
    <div className="modal-fundo" onClick={aoFechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Preparar {caminhos.length} arquivo{caminhos.length > 1 ? 's' : ''}</h3>
        <p className="modal-nota">
          Fica tudo pronto antes de você abrir: nada de esperar a separação das
          faixas na hora. Um arquivo de cada vez, em segundo plano.
        </p>

        <div className="opcoes-preparo">
          <label className={`opcao ${!comVideo ? 'on' : ''}`}>
            <input
              type="radio"
              checked={!comVideo}
              onChange={() => setComVideo(false)}
            />
            <span className="opcao-titulo">Só as faixas de áudio</span>
            <span className="opcao-desc">
              Separa cada microfone e desenha as ondas. É o que o mixer precisa.
            </span>
            <span className="opcao-custo">
              {est ? tamanho(est.audio.bytes) : '…'}
            </span>
          </label>

          <label className={`opcao ${comVideo ? 'on' : ''}`}>
            <input
              type="radio"
              checked={comVideo}
              onChange={() => setComVideo(true)}
            />
            <span className="opcao-titulo">Revisão completa</span>
            <span className="opcao-desc">
              O acima mais a versão convertida do vídeo e as miniaturas da régua.
            </span>
            <span className="opcao-custo caro">
              {est ? tamanho(est.revisao.bytes) : '…'}
            </span>
          </label>
        </div>

        {escolhido && escolhido.horas > 0 && (
          <p className="modal-nota">
            {escolhido.horas.toFixed(1)} h de gravação
            {incerto && ` · ${escolhido.total - escolhido.comDuracao} arquivo(s) `
              + 'sem duração conhecida, estimados pelo tamanho'}
          </p>
        )}

        <div className="modal-acoes">
          <button onClick={aoFechar}>Cancelar</button>
          <button className="primario" onClick={enviar} disabled={enviando}>
            {enviando ? 'enfileirando…' : 'Preparar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- faixa de status

const ROTULO_ESTADO: Record<string, string> = {
  esperando: 'na fila',
  preparando: 'preparando',
  pronto: 'pronto',
  erro: 'falhou',
  cancelado: 'cancelado',
};

/**
 * Barra fina que só aparece quando há fila. Vive no rodapé da biblioteca: dá
 * pra navegar, abrir vídeo e organizar pasta enquanto ela trabalha.
 */
export function FaixaFila({ aoAvisar }: { aoAvisar: (m: string) => void }) {
  const [fila, setFila] = useState<EstadoFila | null>(null);
  const [aberta, setAberta] = useState(false);
  const montado = useRef(true);

  useEffect(() => {
    montado.current = true;
    api.fila().then((f) => { if (montado.current) setFila(f); }).catch(() => undefined);
    // O progresso chega pelo mesmo canal de SSE do ingest, marcado com `tipo`.
    const parar = ouvirProgresso((ev) => {
      if (ev.tipo === 'fila' && montado.current) setFila(ev as unknown as EstadoFila);
    });
    return () => { montado.current = false; parar?.(); };
  }, []);

  if (!fila || fila.total === 0) return null;

  const pendentes = fila.itens.filter((i) => i.estado === 'esperando' || i.estado === 'preparando');
  const falhas = fila.itens.filter((i) => i.estado === 'erro');
  const pct = fila.total ? (fila.feitos / fila.total) * 100 : 0;

  return (
    <div className={`faixa-fila ${aberta ? 'aberta' : ''}`}>
      <div className="faixa-fila-topo" onClick={() => setAberta((a) => !a)}>
        <span className={`fila-ponto ${fila.rodando ? 'ativo' : ''}`} />
        <strong>
          {fila.rodando ? 'Preparando' : pendentes.length ? 'Pausado' : 'Fila terminada'}
        </strong>
        <span className="fila-conta">{fila.feitos} de {fila.total}</span>
        {fila.atual && <span className="fila-atual">{fila.atual}</span>}
        {falhas.length > 0 && <span className="fila-falhas">{falhas.length} falhou</span>}
        <span className="fila-espaco" />
        {pendentes.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); api.cancelarFila().then(setFila); }}>
            Cancelar
          </button>
        )}
        {pendentes.length === 0 && (
          <button onClick={(e) => { e.stopPropagation(); api.limparFeitos().then(setFila); }}>
            Fechar
          </button>
        )}
        <span className="fila-seta">{aberta ? '▾' : '▴'}</span>
      </div>
      <div className="fila-barra"><i style={{ width: `${pct}%` }} /></div>

      {aberta && (
        <ul className="fila-lista">
          {fila.itens.map((i) => (
            <li key={i.caminho} className={i.estado}>
              <span className="fila-estado">{ROTULO_ESTADO[i.estado] ?? i.estado}</span>
              <span className="fila-nome" title={i.caminho}>{i.nome}</span>
              {i.comVideo && <span className="fila-tag">revisão</span>}
              {i.erro && (
                <button
                  className="fila-erro"
                  title={i.erro}
                  onClick={() => aoAvisar(i.erro!)}
                >por quê?</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
