// As formas de ver a biblioteca, nos moldes do Explorer do Windows.
//
// Cada uma serve a uma pergunta diferente: a grade é "qual é este vídeo?",
// detalhes é "qual é o maior / o mais longo?", ícones é "quantos são?", e lado
// a lado é o meio-termo com nome, tipo e tamanho legíveis de relance.
import { useEffect, useRef, useState } from 'react';
import { api, urlPoster, type Midia } from '../lib/api';
import { duracaoCurta } from '../lib/tempo';

export type Visual = 'grade' | 'detalhes' | 'icones' | 'ladoALado';

export const VISOES: { id: Visual; rotulo: string; icone: string }[] = [
  { id: 'grade', rotulo: 'Miniaturas', icone: '▦' },
  { id: 'ladoALado', rotulo: 'Lado a lado', icone: '▤' },
  { id: 'icones', rotulo: 'Ícones', icone: '⬚' },
  { id: 'detalhes', rotulo: 'Detalhes', icone: '☰' },
];

export const tamanhoCurto = (n: number) =>
  (n >= 1e9 ? `${(n / 1e9).toFixed(2).replace('.', ',')} GB`
    : `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace('.', ',')} MB`);

const dataCurta = (ms: number) => new Date(ms).toLocaleString('pt-BR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export type PropsVisao = {
  itens: Midia[];
  aoAbrir: (c: string) => void;
  selecao: Set<number>;
  aoSelecionar: (id: number, e: React.MouseEvent) => void;
  aoMarcar: (id: number, campo: 'favorito' | 'revisado', valor: boolean) => void;
  ordem?: string;
  dir?: string;
  aoOrdenar?: (coluna: string) => void;
};

/**
 * Pede os metadados do item quando ele chega perto da tela.
 * O mesmo gatilho da miniatura, porque o custo é o mesmo: um ffprobe por
 * arquivo, que numa pasta de centenas não pode acontecer todo de uma vez.
 */
function useInfo(midia: Midia) {
  const [info, setInfo] = useState(midia);
  const [visivel, setVisivel] = useState(false);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => { setInfo(midia); }, [midia]);

  useEffect(() => {
    const el = ref.current;
    if (!el || visivel) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVisivel(true); obs.disconnect(); }
    }, { rootMargin: '250px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [visivel]);

  useEffect(() => {
    if (!visivel || info.sondado) return;
    let vivo = true;
    api.infoMidia(midia.id).then((m) => { if (vivo) setInfo(m); }).catch(() => undefined);
    return () => { vivo = false; };
  }, [visivel, info.sondado, midia.id]);

  return { info, visivel, ref };
}

/** O clique decide entre abrir e selecionar, igual em todas as visões. */
function aoClicar(
  e: React.MouseEvent, midia: Midia, selecao: Set<number>,
  aoSelecionar: PropsVisao['aoSelecionar'], aoAbrir: PropsVisao['aoAbrir'],
) {
  if (selecao.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey) aoSelecionar(midia.id, e);
  else aoAbrir(midia.caminho);
}

// ------------------------------------------------------------- detalhes

const COLUNAS: { id: string; rotulo: string; classe?: string }[] = [
  { id: 'nome', rotulo: 'Nome' },
  { id: 'duracao', rotulo: 'Duração', classe: 'num' },
  { id: 'tamanho', rotulo: 'Tamanho', classe: 'num' },
  { id: 'faixas', rotulo: 'Faixas', classe: 'num' },
  { id: 'ext', rotulo: 'Tipo' },
  { id: 'modificado', rotulo: 'Modificado' },
  { id: 'pasta', rotulo: 'Pasta' },
];

export function Detalhes({
  itens, aoAbrir, selecao, aoSelecionar, aoMarcar, ordem, dir, aoOrdenar,
}: PropsVisao) {
  return (
    <div className="tabela-caixa">
      <table className="tabela">
        <thead>
          <tr>
            <th className="col-marca" />
            {COLUNAS.map((c) => (
              <th
                key={c.id}
                className={`${c.classe ?? ''} ${ordem === c.id ? 'ordenando' : ''}`}
              >
                <button onClick={() => aoOrdenar?.(c.id)}>
                  {c.rotulo}
                  <span className="seta">{ordem === c.id ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {itens.map((m) => (
            <Linha
              key={m.id}
              midia={m}
              selecionado={selecao.has(m.id)}
              onClick={(e) => aoClicar(e, m, selecao, aoSelecionar, aoAbrir)}
              aoMarcar={aoMarcar}
              aoSelecionar={aoSelecionar}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Linha({ midia, selecionado, onClick, aoMarcar, aoSelecionar }: {
  midia: Midia; selecionado: boolean;
  onClick: (e: React.MouseEvent) => void;
  aoMarcar: PropsVisao['aoMarcar'];
  aoSelecionar: PropsVisao['aoSelecionar'];
}) {
  const { info, ref } = useInfo(midia);
  return (
    <tr
      ref={ref as React.Ref<HTMLTableRowElement>}
      className={`${selecionado ? 'sel' : ''} ${midia.revisado ? 'revisto' : ''}`}
      onClick={onClick}
      title={midia.caminho}
    >
      <td className="col-marca">
        <span
          className={`marca-caixa ${selecionado ? 'on' : ''}`}
          role="checkbox"
          aria-checked={selecionado}
          aria-label={`Selecionar ${midia.nome}`}
          onClick={(e) => { e.stopPropagation(); aoSelecionar(midia.id, e); }}
        >{selecionado ? '✓' : ''}</span>
      </td>
      <td className="col-nome">
        <span className={`ponto-tipo ${midia.tipo}`} />
        <span className="nome-texto">{midia.nome}</span>
        <button
          className={`linha-estrela ${midia.favorito ? 'on' : ''}`}
          title={midia.favorito ? 'Tirar dos favoritos' : 'Favoritar'}
          onClick={(e) => { e.stopPropagation(); aoMarcar(midia.id, 'favorito', !midia.favorito); }}
        >{midia.favorito ? '★' : '☆'}</button>
        {midia.revisado > 0 && <span className="linha-revisto" title="já revisado">✓</span>}
      </td>
      <td className="num">{info.duracao ? duracaoCurta(info.duracao) : '—'}</td>
      <td className="num">{tamanhoCurto(midia.tamanho)}</td>
      <td className="num">{info.faixas_audio ?? '—'}</td>
      <td className="fraco">{midia.ext.replace('.', '').toUpperCase()}</td>
      <td className="fraco">{dataCurta(midia.modificado)}</td>
      <td className="fraco col-pasta" title={midia.pasta}>
        {midia.pasta.split(/[\\/]/).filter(Boolean).pop()}
      </td>
    </tr>
  );
}

// --------------------------------------------------------------- ícones

export function Icones({ itens, aoAbrir, selecao, aoSelecionar }: PropsVisao) {
  return (
    <div className="grade-icones">
      {itens.map((m) => (
        <Icone
          key={m.id}
          midia={m}
          selecionado={selecao.has(m.id)}
          onClick={(e) => aoClicar(e, m, selecao, aoSelecionar, aoAbrir)}
        />
      ))}
    </div>
  );
}

function Icone({ midia, selecionado, onClick }: {
  midia: Midia; selecionado: boolean; onClick: (e: React.MouseEvent) => void;
}) {
  const { visivel, ref } = useInfo(midia);
  const [falhou, setFalhou] = useState(false);
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      className={`icone ${selecionado ? 'sel' : ''}`}
      onClick={onClick}
      title={midia.caminho}
    >
      <span className={`icone-arte ${midia.tipo}`}>
        {midia.tipo === 'video' && visivel && !falhou
          ? <img src={urlPoster(midia.id)} alt="" loading="lazy" onError={() => setFalhou(true)} />
          : <span className="icone-glifo">{midia.tipo === 'audio' ? '♪' : '▶'}</span>}
      </span>
      <span className="icone-nome">{midia.nome}</span>
    </button>
  );
}

// ----------------------------------------------------------- lado a lado

export function LadoALado({ itens, aoAbrir, selecao, aoSelecionar }: PropsVisao) {
  return (
    <div className="grade-lado">
      {itens.map((m) => (
        <Ladrilho
          key={m.id}
          midia={m}
          selecionado={selecao.has(m.id)}
          onClick={(e) => aoClicar(e, m, selecao, aoSelecionar, aoAbrir)}
        />
      ))}
    </div>
  );
}

function Ladrilho({ midia, selecionado, onClick }: {
  midia: Midia; selecionado: boolean; onClick: (e: React.MouseEvent) => void;
}) {
  const { info, visivel, ref } = useInfo(midia);
  const [falhou, setFalhou] = useState(false);
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      className={`ladrilho ${selecionado ? 'sel' : ''}`}
      onClick={onClick}
      title={midia.caminho}
    >
      <span className={`ladrilho-arte ${midia.tipo}`}>
        {midia.tipo === 'video' && visivel && !falhou
          ? <img src={urlPoster(midia.id)} alt="" loading="lazy" onError={() => setFalhou(true)} />
          : <span className="icone-glifo">{midia.tipo === 'audio' ? '♪' : '▶'}</span>}
      </span>
      <span className="ladrilho-texto">
        <span className="ladrilho-nome">{midia.nome}</span>
        <span className="ladrilho-meta">
          Arquivo {midia.ext.replace('.', '').toUpperCase()}
          {info.faixas_audio && info.faixas_audio > 1 ? ` · ${info.faixas_audio} faixas` : ''}
        </span>
        <span className="ladrilho-meta">
          {tamanhoCurto(midia.tamanho)}
          {info.duracao ? ` · ${duracaoCurta(info.duracao)}` : ''}
        </span>
      </span>
    </button>
  );
}
