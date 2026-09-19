// Página inicial: a biblioteca de mídia do computador, navegável por pasta.
//
// A miniatura de cada vídeo é gerada no servidor na primeira vez que o cartão
// aparece na tela — nunca antes. Numa pasta com centenas de gravações, gerar
// tudo de uma vez seriam minutos de ffmpeg pra mostrar quatro fileiras.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, urlPoster, type Midia, type Pasta, type Subpasta } from '../lib/api';
import { duracaoCurta } from '../lib/tempo';
import { noElectron } from '../lib/sessao';
import { BarraSelecao } from './Organizar';

const tamanhoCurto = (n: number) =>
  (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

const ORDENS: [string, string][] = [
  ['modificado', 'Mais recentes'],
  ['antigos', 'Mais antigos'],
  ['nome', 'Nome'],
  ['duracao', 'Duração'],
  ['tamanho', 'Tamanho'],
];

const ultimoTrecho = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

type Props = {
  aoAbrir: (caminho: string) => void;
  aoAvisar: (msg: string) => void;
};

export function Inicio({ aoAbrir, aoAvisar }: Props) {
  const [itens, setItens] = useState<Midia[]>([]);
  const [recentes, setRecentes] = useState<Midia[]>([]);
  const [subpastas, setSubpastas] = useState<Subpasta[]>([]);
  const [diretos, setDiretos] = useState(0);
  const [raizes, setRaizes] = useState<Pasta[]>([]);
  const [contagem, setContagem] = useState({ total: 0, vistos: 0, semPoster: 0 });
  const [busca, setBusca] = useState('');
  const [pasta, setPasta] = useState('');
  const [recursivo, setRecursivo] = useState(false);
  const [ordem, setOrdem] = useState('modificado');
  const [ocupado, setOcupado] = useState(false);
  const [filtro, setFiltro] = useState('');
  const [selecao, setSelecao] = useState<Set<number>>(new Set());
  const ultimoClique = useRef<number | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await api.biblioteca({
        q: busca, pasta, ordem, filtro, limite: 300,
        // Sem pasta escolhida a grade é o acervo inteiro; aí recursivo é o único
        // sentido possível.
        recursivo: pasta ? recursivo : true,
      });
      setItens(r.itens);
      setSubpastas(r.subpastas ?? []);
      setDiretos(r.diretos ?? 0);
      setRaizes(r.pastas);
      setContagem(r.contagem);

      // A fileira de recentes só aparece na raiz e sem busca: em qualquer outro
      // lugar ela repetiria cartões que já estão logo abaixo.
      if (!busca && !pasta) {
        setRecentes((await api.biblioteca({ ordem: 'vistos', limite: 12 })).itens);
      } else {
        setRecentes([]);
      }
    } catch (e) { aoAvisar(String((e as Error).message)); }
  }, [busca, pasta, ordem, filtro, recursivo, aoAvisar]);

  useEffect(() => {
    const id = window.setTimeout(carregar, busca ? 250 : 0);
    return () => clearTimeout(id);
  }, [carregar, busca]);

  const adicionarPasta = async () => {
    const escolhido = await window.revisor?.escolherPasta?.();
    const caminho = escolhido ?? window.prompt('Caminho da pasta:') ?? '';
    if (!caminho.trim()) return;
    setOcupado(true);
    try {
      const r = await api.adicionarPasta(caminho.trim());
      aoAvisar(`${r.achados} arquivos encontrados em ${r.pasta}`);
      await carregar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  const revarrer = async () => {
    setOcupado(true);
    try {
      const r = await api.revarrer();
      aoAvisar(`${r.total} arquivos no catálogo`);
      await carregar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  // Trilha de navegação: a raiz registrada, e depois cada nível abaixo dela.
  const trilha = useMemo(() => {
    if (!pasta) return [];
    const raiz = raizes.find((r) => pasta.startsWith(r.caminho));
    if (!raiz) return [{ nome: ultimoTrecho(pasta), caminho: pasta }];
    const passos = [{ nome: ultimoTrecho(raiz.caminho), caminho: raiz.caminho }];
    const resto = pasta.slice(raiz.caminho.length).replace(/^[\\/]+/, '');
    let acumulado = raiz.caminho.replace(/[\\/]+$/, '');
    for (const parte of resto.split(/[\\/]/).filter(Boolean)) {
      acumulado += `\\${parte}`;
      passos.push({ nome: parte, caminho: acumulado });
    }
    return passos;
  }, [pasta, raizes]);

  // Shift+clique seleciona o intervalo entre o último clique e este, na ordem
  // em que os cartões estão na tela.
  const selecionar = (id: number, e: React.MouseEvent) => {
    setSelecao((atual) => {
      const nova = new Set(atual);
      if (e.shiftKey && ultimoClique.current != null) {
        const ordemVisivel = itens.map((m) => m.id);
        const a = ordemVisivel.indexOf(ultimoClique.current);
        const b = ordemVisivel.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) nova.add(ordemVisivel[i]);
          return nova;
        }
      }
      if (nova.has(id)) nova.delete(id); else nova.add(id);
      return nova;
    });
    ultimoClique.current = id;
  };

  const marcarUm = async (id: number, campo: 'favorito' | 'revisado', valor: boolean) => {
    try { await api.marcar(id, campo, valor); await carregar(); }
    catch (err) { aoAvisar(String((err as Error).message)); }
  };

  // Esc limpa a seleção: é a saída óbvia quando se entra nela sem querer.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelecao(new Set()); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const semNada = raizes.length === 0;

  return (
    <div className="inicio">
      <header className="inicio-topo">
        <h1>Início</h1>
        <input
          className="inicio-busca"
          placeholder="buscar na biblioteca…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div className="inicio-acoes">
          <button onClick={revarrer} disabled={ocupado || semNada} title="Reler as pastas">
            Atualizar
          </button>
          <button onClick={adicionarPasta} disabled={ocupado}>Adicionar pasta…</button>
          {noElectron() && (
            <button
              className="primario"
              onClick={async () => {
                const p = await window.revisor?.escolherArquivo();
                if (p) aoAbrir(p);
              }}
            >Abrir arquivo(s)</button>
          )}
        </div>
      </header>

      {!semNada && (
        <div className="inicio-barra">
          <nav className="trilha">
            <button className={pasta ? '' : 'on'} onClick={() => setPasta('')}>
              Tudo <small>({contagem.total})</small>
            </button>
            {!pasta && raizes.map((r) => (
              <span key={r.caminho} className="trilha-raiz">
                <button onClick={() => setPasta(r.caminho)} title={r.caminho}>
                  {ultimoTrecho(r.caminho)}
                </button>
                <button
                  className="trilha-x"
                  title="Tirar da biblioteca (não apaga nada do disco)"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.removerPasta(r.caminho);
                    carregar();
                  }}
                >✕</button>
              </span>
            ))}
            {trilha.map((p, i) => (
              <span key={p.caminho} className="trilha-passo">
                <span className="trilha-sep">›</span>
                <button
                  className={i === trilha.length - 1 ? 'on' : ''}
                  onClick={() => setPasta(p.caminho)}
                  title={p.caminho}
                >{p.nome}</button>
              </span>
            ))}
          </nav>

          <div className="inicio-controles">
            {pasta && subpastas.length > 0 && (
              <label className="alternador" title="Mostrar também o que está nas subpastas">
                <input
                  type="checkbox"
                  checked={recursivo}
                  onChange={(e) => setRecursivo(e.target.checked)}
                />
                incluir subpastas
              </label>
            )}
            <select value={filtro} onChange={(e) => setFiltro(e.target.value)} title="Filtrar">
              <option value="">Todos</option>
              <option value="favoritos">★ Favoritos</option>
              <option value="naoRevisados">Ainda não revisados</option>
              <option value="revisados">Já revisados</option>
            </select>
            <select value={ordem} onChange={(e) => setOrdem(e.target.value)} title="Ordenar por">
              {ORDENS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </select>
          </div>
        </div>
      )}

      {semNada && (
        <div className="inicio-vazio">
          <p>Nenhuma pasta na biblioteca ainda.</p>
          <p className="detalhe">
            Aponte as pastas onde você guarda gravação e material bruto. O Revisor
            só lê o que existe lá — não move, não renomeia e não apaga nada.
          </p>
          <button className="primario" onClick={adicionarPasta} disabled={ocupado}>
            Adicionar pasta…
          </button>
        </div>
      )}

      {selecao.size > 0 && (
        <BarraSelecao
          ids={[...selecao]}
          pastaAtual={pasta}
          subpastas={subpastas}
          aoAvisar={aoAvisar}
          aoLimpar={() => setSelecao(new Set())}
          aoTerminar={async (msg) => { aoAvisar(msg); setSelecao(new Set()); await carregar(); }}
        />
      )}

      {recentes.length > 0 && (
        <section>
          <h2>Mídia recente</h2>
          <Grade itens={recentes} aoAbrir={aoAbrir} selecao={selecao} aoSelecionar={selecionar} aoMarcar={marcarUm} />
        </section>
      )}

      {subpastas.length > 0 && !busca && (
        <section>
          <h2>Pastas <small>{subpastas.length}</small></h2>
          <div className="grade-pastas">
            {subpastas.map((s) => (
              <button key={s.caminho} className="cartao-pasta" onClick={() => setPasta(s.caminho)}>
                <span className="cartao-pasta-icone">📁</span>
                <span className="cartao-pasta-nome" title={s.caminho}>{s.nome}</span>
                <span className="cartao-pasta-n">{s.arquivos}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {itens.length > 0 && (
        <section>
          <h2>
            {busca ? `Resultados para "${busca}"`
              : pasta ? (recursivo ? `${ultimoTrecho(pasta)} e subpastas` : ultimoTrecho(pasta))
                : 'Tudo'}
            <small>
              {itens.length}
              {!busca && !pasta && ` de ${contagem.total}`}
              {pasta && !recursivo && diretos > itens.length && ` de ${diretos}`}
            </small>
          </h2>
          <Grade itens={itens} aoAbrir={aoAbrir} selecao={selecao} aoSelecionar={selecionar} aoMarcar={marcarUm} />
        </section>
      )}

      {!semNada && itens.length === 0 && subpastas.length === 0 && (
        <p className="vazio">{busca ? 'nada encontrado' : 'pasta vazia'}</p>
      )}

      {!semNada && itens.length === 0 && subpastas.length > 0 && !busca && (
        <p className="vazio">
          nenhum arquivo direto nesta pasta — o conteúdo está nas subpastas acima
        </p>
      )}
    </div>
  );
}

type PropsGrade = {
  itens: Midia[];
  aoAbrir: (c: string) => void;
  selecao: Set<number>;
  aoSelecionar: (id: number, e: React.MouseEvent) => void;
  aoMarcar: (id: number, campo: 'favorito' | 'revisado', valor: boolean) => void;
};

function Grade({ itens, aoAbrir, selecao, aoSelecionar, aoMarcar }: PropsGrade) {
  return (
    <div className="grade">
      {itens.map((m) => (
        <Cartao
          key={m.id}
          midia={m}
          aoAbrir={aoAbrir}
          selecionado={selecao.has(m.id)}
          modoSelecao={selecao.size > 0}
          aoSelecionar={aoSelecionar}
          aoMarcar={aoMarcar}
        />
      ))}
    </div>
  );
}

type PropsCartao = {
  midia: Midia;
  aoAbrir: (c: string) => void;
  selecionado: boolean;
  modoSelecao: boolean;
  aoSelecionar: (id: number, e: React.MouseEvent) => void;
  aoMarcar: (id: number, campo: 'favorito' | 'revisado', valor: boolean) => void;
};

function Cartao({ midia, aoAbrir, selecionado, modoSelecao, aoSelecionar, aoMarcar }: PropsCartao) {
  const [visivel, setVisivel] = useState(false);
  const [falhou, setFalhou] = useState(false);
  const [info, setInfo] = useState<Midia>(midia);
  const ref = useRef<HTMLButtonElement>(null);

  // Só pede miniatura e metadados quando o cartão chega perto da tela.
  useEffect(() => {
    const el = ref.current;
    if (!el || visivel) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVisivel(true); obs.disconnect(); }
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [visivel]);

  useEffect(() => { setInfo(midia); setFalhou(false); }, [midia]);

  useEffect(() => {
    if (!visivel || info.sondado) return;
    let vivo = true;
    api.infoMidia(midia.id).then((m) => { if (vivo) setInfo(m); }).catch(() => undefined);
    return () => { vivo = false; };
  }, [visivel, info.sondado, midia.id]);

  const dur = info.duracao ? duracaoCurta(info.duracao) : null;

  return (
    <div
      className={`cartao ${selecionado ? 'sel' : ''} ${midia.revisado ? 'revisto' : ''}`}
      title={`${midia.caminho}\n${tamanhoCurto(midia.tamanho)}`}
    >
      <button
        ref={ref}
        className="cartao-alvo"
        // Com algo selecionado, o clique simples passa a selecionar: ficar
        // segurando Ctrl pra cada arquivo de um lote de trinta é tortura.
        onClick={(e) => {
          if (modoSelecao || e.ctrlKey || e.metaKey || e.shiftKey) aoSelecionar(midia.id, e);
          else aoAbrir(midia.caminho);
        }}
        onDoubleClick={() => aoAbrir(midia.caminho)}
      >
        <div className={`cartao-arte ${midia.tipo}`}>
          {midia.tipo === 'video' && visivel && !falhou ? (
            <img src={urlPoster(midia.id)} alt="" loading="lazy" onError={() => setFalhou(true)} />
          ) : (
            <span className="cartao-icone">{midia.tipo === 'audio' ? '♪' : '🎬'}</span>
          )}
          {dur && <span className="cartao-dur">{dur}</span>}
          {(info.faixas_audio ?? 0) > 1 && (
            <span className="cartao-faixas" title={`${info.faixas_audio} faixas de áudio`}>
              {info.faixas_audio} faixas
            </span>
          )}
          {midia.revisado > 0 && <span className="cartao-revisto" title="já revisado">✓</span>}
        </div>
        <div className="cartao-nome">{midia.nome}</div>
      </button>

      <span
        className={`cartao-caixa ${selecionado ? 'on' : ''}`}
        role="checkbox"
        aria-checked={selecionado}
        aria-label={`Selecionar ${midia.nome}`}
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); aoSelecionar(midia.id, e); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            aoSelecionar(midia.id, e as unknown as React.MouseEvent);
          }
        }}
      >{selecionado ? '✓' : ''}</span>

      <button
        className={`cartao-estrela ${midia.favorito ? 'on' : ''}`}
        title={midia.favorito ? 'Tirar dos favoritos' : 'Favoritar'}
        onClick={(e) => { e.stopPropagation(); aoMarcar(midia.id, 'favorito', !midia.favorito); }}
      >{midia.favorito ? '★' : '☆'}</button>
    </div>
  );
}
