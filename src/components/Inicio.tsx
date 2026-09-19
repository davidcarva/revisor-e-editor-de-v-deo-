// Página inicial: a biblioteca de mídia do computador, em grade.
//
// A miniatura de cada vídeo é gerada no servidor na primeira vez que o cartão
// aparece na tela — nunca antes. Numa pasta com centenas de gravações, gerar
// tudo de uma vez seriam minutos de ffmpeg pra mostrar quatro fileiras.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, urlPoster, type Midia, type Pasta } from '../lib/api';
import { duracaoCurta } from '../lib/tempo';
import { noElectron } from '../lib/sessao';

const tamanhoCurto = (n: number) =>
  (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

type Props = {
  aoAbrir: (caminho: string) => void;
  aoAvisar: (msg: string) => void;
};

export function Inicio({ aoAbrir, aoAvisar }: Props) {
  const [itens, setItens] = useState<Midia[]>([]);
  const [recentes, setRecentes] = useState<Midia[]>([]);
  const [pastas, setPastas] = useState<Pasta[]>([]);
  const [contagem, setContagem] = useState({ total: 0, vistos: 0, semPoster: 0 });
  const [busca, setBusca] = useState('');
  const [pastaAtiva, setPastaAtiva] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await api.biblioteca({ q: busca, pasta: pastaAtiva, ordem: 'modificado', limite: 200 });
      setItens(r.itens);
      setPastas(r.pastas);
      setContagem(r.contagem);
      // A fileira de recentes só faz sentido sem filtro: com busca ativa ela
      // repetiria os mesmos cartões que já estão logo abaixo.
      if (!busca && !pastaAtiva) {
        const v = await api.biblioteca({ ordem: 'vistos', limite: 12 });
        setRecentes(v.itens);
      } else {
        setRecentes([]);
      }
    } catch (e) { aoAvisar(String((e as Error).message)); }
  }, [busca, pastaAtiva, aoAvisar]);

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

  const abrirArquivo = async () => {
    const p = await window.revisor?.escolherArquivo();
    if (p) aoAbrir(p);
  };

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
          <button onClick={revarrer} disabled={ocupado || !pastas.length} title="Reler as pastas">
            Atualizar
          </button>
          <button onClick={adicionarPasta} disabled={ocupado}>Adicionar pasta…</button>
          {noElectron() && (
            <button className="primario" onClick={abrirArquivo}>Abrir arquivo(s)</button>
          )}
        </div>
      </header>

      {pastas.length > 0 && (
        <div className="inicio-pastas">
          <button
            className={`chip ${pastaAtiva === '' ? 'on' : ''}`}
            onClick={() => setPastaAtiva('')}
          >Tudo ({contagem.total})</button>
          {pastas.map((p) => (
            <span key={p.caminho} className="chip-pasta">
              <button
                className={`chip ${pastaAtiva === p.caminho ? 'on' : ''}`}
                onClick={() => setPastaAtiva(pastaAtiva === p.caminho ? '' : p.caminho)}
                title={p.caminho}
              >{p.caminho.split(/[\\/]/).filter(Boolean).pop()}</button>
              <button
                className="chip-x"
                title="Tirar esta pasta da biblioteca (não apaga nada do disco)"
                onClick={async () => { await api.removerPasta(p.caminho); carregar(); }}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      {pastas.length === 0 && (
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

      {recentes.length > 0 && (
        <section>
          <h2>Mídia recente</h2>
          <Grade itens={recentes} aoAbrir={aoAbrir} />
        </section>
      )}

      {itens.length > 0 && (
        <section>
          <h2>
            {busca ? `Resultados para "${busca}"`
              : pastaAtiva ? pastaAtiva.split(/[\\/]/).filter(Boolean).pop()
                : 'Tudo'}
            <small>{itens.length} de {contagem.total}</small>
          </h2>
          <Grade itens={itens} aoAbrir={aoAbrir} />
        </section>
      )}

      {pastas.length > 0 && itens.length === 0 && (
        <p className="vazio">nada encontrado</p>
      )}
    </div>
  );
}

function Grade({ itens, aoAbrir }: { itens: Midia[]; aoAbrir: (c: string) => void }) {
  return (
    <div className="grade">
      {itens.map((m) => <Cartao key={m.id} midia={m} aoAbrir={aoAbrir} />)}
    </div>
  );
}

function Cartao({ midia, aoAbrir }: { midia: Midia; aoAbrir: (c: string) => void }) {
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

  useEffect(() => {
    if (!visivel || info.sondado) return;
    let vivo = true;
    api.infoMidia(midia.id).then((m) => { if (vivo) setInfo(m); }).catch(() => undefined);
    return () => { vivo = false; };
  }, [visivel, info.sondado, midia.id]);

  const dur = useMemo(
    () => (info.duracao ? duracaoCurta(info.duracao) : null), [info.duracao]);

  return (
    <button
      ref={ref}
      className="cartao"
      onClick={() => aoAbrir(midia.caminho)}
      title={`${midia.caminho}\n${tamanhoCurto(midia.tamanho)}`}
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
      </div>
      <div className="cartao-nome">{midia.nome}</div>
    </button>
  );
}
