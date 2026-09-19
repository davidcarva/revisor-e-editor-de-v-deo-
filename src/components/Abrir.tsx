// Escolha de arquivo. No Electron usa o dialogo nativo; no navegador cai neste
// explorador simples servido pelo backend — o que deixa depurar tudo no Chrome.
import { useEffect, useState } from 'react';
import { api, type Fonte, type ItemArquivo } from '../lib/api';
import { duracaoCurta } from '../lib/tempo';

declare global {
  interface Window {
    revisor?: { escolherArquivo(): Promise<string | null> };
  }
}

const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`);

export function Abrir({
  fontes, aoAbrir, aoRemover, aoSelecionar,
}: {
  fontes: Fonte[];
  aoAbrir: (caminho: string) => void;
  aoRemover: (id: number) => void;
  aoSelecionar: (id: number) => void;
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [pai, setPai] = useState<string | null>(null);
  const [itens, setItens] = useState<ItemArquivo[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [caminhoManual, setCaminhoManual] = useState('');

  const navegar = async (destino?: string) => {
    try {
      setErro(null);
      const r = await api.listarPasta(destino);
      setDir(r.dir); setPai(r.pai); setItens(r.itens);
    } catch (e) { setErro(String((e as Error).message)); }
  };

  useEffect(() => {
    api.drives().then((d) => setDrives(d.drives)).catch(() => undefined);
    navegar();
  }, []);

  const nativo = async () => {
    const p = await window.revisor?.escolherArquivo();
    if (p) aoAbrir(p);
  };

  return (
    <div className="abrir">
      <div className="abrir-coluna">
        <h2>Abrir gravação</h2>

        <div className="abrir-linha">
          {window.revisor && (
            <button className="primario" onClick={nativo}>Escolher arquivo…</button>
          )}
          <input
            placeholder="ou cole o caminho: D:\gravacoes\live.mp4"
            value={caminhoManual}
            onChange={(e) => setCaminhoManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && caminhoManual.trim()) aoAbrir(caminhoManual.trim()); }}
          />
          <button onClick={() => caminhoManual.trim() && aoAbrir(caminhoManual.trim())}>Abrir</button>
        </div>

        <div className="navegador">
          <div className="nav-topo">
            {drives.map((d) => (
              <button key={d} className="chip" onClick={() => navegar(d)}>{d}</button>
            ))}
            <span className="nav-caminho" title={dir ?? ''}>{dir}</span>
          </div>
          <div className="nav-lista">
            {pai && <button className="nav-item pasta" onClick={() => navegar(pai)}>↑ acima</button>}
            {erro && <p className="erro">{erro}</p>}
            {itens.map((i) => (
              <button
                key={i.caminho}
                className={`nav-item ${i.dir ? 'pasta' : 'arquivo'}`}
                onClick={() => (i.dir ? navegar(i.caminho) : aoAbrir(i.caminho))}
                title={i.caminho}
              >
                <span>{i.dir ? '📁' : '🎬'} {i.nome}</span>
                {!i.dir && <em>{mb(i.size)}</em>}
              </button>
            ))}
            {!erro && itens.length === 0 && <p className="vazio">nenhuma mídia nesta pasta</p>}
          </div>
        </div>
      </div>

      <div className="abrir-coluna">
        <h2>Neste projeto</h2>
        {fontes.length === 0 && <p className="vazio">nada aberto ainda</p>}
        <div className="fontes">
          {fontes.map((f) => (
            <div
              key={f.id}
              className="fonte-card"
              role="button"
              tabIndex={0}
              aria-label={`Abrir ${f.name}`}
              onClick={() => aoSelecionar(f.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoSelecionar(f.id); }
              }}
            >
              <div className="fonte-nome">{f.name}</div>
              <div className="fonte-meta">
                {duracaoCurta(f.duration_s)} · {f.width}×{f.height} · {f.fps?.toFixed(2)}fps · {mb(f.size_bytes)}
              </div>
              <div className={`fonte-status ${f.status}`}>
                {f.status === 'processando'
                  ? `${f.stage === 'proxy' ? 'proxy' : 'áudio'} ${(f.progress * 100).toFixed(0)}%`
                  : f.status}
                {f.error && <small title={f.error}> — {f.error.slice(0, 60)}</small>}
              </div>
              {f.status === 'processando' && (
                <div className="barra"><i style={{ width: `${f.progress * 100}%` }} /></div>
              )}
              <button
                className="fonte-remover"
                onClick={(e) => { e.stopPropagation(); aoRemover(f.id); }}
                title="Tirar do projeto"
              >✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
