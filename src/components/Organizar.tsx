// Barra de ações da seleção, e os diálogos de mover e renomear.
//
// Todas as operações daqui mexem nos arquivos de verdade, então nenhuma acontece
// sem passar por um plano: você vê o antes/depois, confirma, e só então o disco
// é tocado. O último lote sempre pode voltar.
import { useEffect, useState } from 'react';
import { api, type PassoPlano, type Subpasta } from '../lib/api';

type Props = {
  ids: number[];
  pastaAtual: string;
  subpastas: Subpasta[];
  aoTerminar: (msg: string) => void;
  aoLimpar: () => void;
  aoAvisar: (msg: string) => void;
};

export function BarraSelecao({ ids, pastaAtual, subpastas, aoTerminar, aoLimpar, aoAvisar }: Props) {
  const [dialogo, setDialogo] = useState<'mover' | 'renomear' | null>(null);
  const [podeDesfazer, setPodeDesfazer] = useState<{ tipo: string; quantos: number } | null>(null);

  const conferirDesfazer = async () => {
    try {
      const r = await api.podeDesfazer();
      setPodeDesfazer(r.pode ? { tipo: r.tipo!, quantos: r.quantos } : null);
    } catch { setPodeDesfazer(null); }
  };
  useEffect(() => { conferirDesfazer(); }, [ids.length]);

  const marcar = async (campo: 'favorito' | 'revisado', valor: boolean) => {
    try {
      await Promise.all(ids.map((id) => api.marcar(id, campo, valor)));
      aoTerminar(`${ids.length} ${campo === 'favorito'
        ? (valor ? 'favoritados' : 'desfavoritados')
        : (valor ? 'marcados como revisados' : 'desmarcados')}`);
    } catch (e) { aoAvisar(String((e as Error).message)); }
  };

  const desfazer = async () => {
    try {
      const r = await api.desfazer();
      if (r.nada) return aoAvisar('não há nada para desfazer');
      aoTerminar(`${r.voltaram.length} arquivo(s) voltaram ao lugar`
        + (r.erros.length ? ` — ${r.erros.length} falharam` : ''));
    } catch (e) { aoAvisar(String((e as Error).message)); }
  };

  return (
    <>
      <div className="barra-selecao">
        <strong>{ids.length} selecionado{ids.length > 1 ? 's' : ''}</strong>
        <button onClick={() => setDialogo('mover')}>Mover para…</button>
        <button onClick={() => setDialogo('renomear')}>Renomear…</button>
        <button onClick={() => marcar('favorito', true)} title="Marcar como favorito">★ Favoritar</button>
        <button onClick={() => marcar('revisado', true)} title="Marcar como já revisado">✓ Revisado</button>
        <button onClick={() => marcar('revisado', false)}>Desmarcar</button>
        <span className="barra-sep" />
        {podeDesfazer && (
          <button
            className="desfazer"
            onClick={desfazer}
            title={`Volta atrás no último ${podeDesfazer.tipo} (${podeDesfazer.quantos} arquivos)`}
          >↩ Desfazer {podeDesfazer.tipo}</button>
        )}
        <button onClick={aoLimpar}>Limpar seleção</button>
      </div>

      {dialogo === 'mover' && (
        <DialogoMover
          ids={ids}
          pastaAtual={pastaAtual}
          subpastas={subpastas}
          aoFechar={() => setDialogo(null)}
          aoTerminar={aoTerminar}
          aoAvisar={aoAvisar}
        />
      )}
      {dialogo === 'renomear' && (
        <DialogoRenomear
          ids={ids}
          aoFechar={() => setDialogo(null)}
          aoTerminar={aoTerminar}
          aoAvisar={aoAvisar}
        />
      )}
    </>
  );
}

function Moldura({ titulo, aoFechar, children, rodape }: {
  titulo: string; aoFechar: () => void;
  children: React.ReactNode; rodape: React.ReactNode;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') aoFechar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [aoFechar]);

  return (
    <div className="fundo-dialogo" onClick={aoFechar}>
      <div className="dialogo" onClick={(e) => e.stopPropagation()}>
        <header><strong>{titulo}</strong><button onClick={aoFechar}>✕</button></header>
        <div className="dialogo-corpo">{children}</div>
        <footer>{rodape}</footer>
      </div>
    </div>
  );
}

function DialogoMover({ ids, pastaAtual, subpastas, aoFechar, aoTerminar, aoAvisar }: {
  ids: number[]; pastaAtual: string; subpastas: Subpasta[];
  aoFechar: () => void; aoTerminar: (m: string) => void; aoAvisar: (m: string) => void;
}) {
  const [destino, setDestino] = useState('');
  const [nomeNovo, setNomeNovo] = useState('');
  const [plano, setPlano] = useState<PassoPlano[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [opcoes, setOpcoes] = useState<Subpasta[]>(subpastas);

  useEffect(() => {
    if (!destino) { setPlano([]); return; }
    api.planoMover(ids, destino).then((r) => setPlano(r.passos)).catch(() => setPlano([]));
  }, [destino, ids]);

  const criarEUsar = async () => {
    if (!nomeNovo.trim() || !pastaAtual) return;
    setOcupado(true);
    try {
      const r = await api.novaPasta(pastaAtual, nomeNovo.trim());
      setOpcoes((o) => [...o, { caminho: r.pasta, nome: nomeNovo.trim(), arquivos: 0 }]);
      setDestino(r.pasta);
      setNomeNovo('');
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  const aplicar = async () => {
    setOcupado(true);
    try {
      const r = await api.aplicarLote('mover', plano);
      aoTerminar(`${r.feitos.length} arquivo(s) movidos`
        + (r.erros.length ? ` — ${r.erros.length} falharam: ${r.erros[0].erro}` : ''));
      aoFechar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  const renomeados = plano.filter((p) => p.destino.split(/[\\/]/).pop() !== `${p.nome}` + p.destino.slice(p.destino.lastIndexOf('.')));

  return (
    <Moldura
      titulo={`Mover ${ids.length} arquivo(s)`}
      aoFechar={aoFechar}
      rodape={
        <>
          <span className="dica">
            {plano.length ? `${plano.length} arquivo(s) vão para ${destino}` : 'escolha o destino'}
          </span>
          <button onClick={aoFechar}>Cancelar</button>
          <button className="primario" disabled={!plano.length || ocupado} onClick={aplicar}>
            Mover
          </button>
        </>
      }
    >
      <label className="campo">
        <span>Pasta de destino</span>
        <select value={destino} onChange={(e) => setDestino(e.target.value)}>
          <option value="">— escolher —</option>
          {pastaAtual && <option value={pastaAtual}>{pastaAtual} (aqui)</option>}
          {opcoes.map((s) => <option key={s.caminho} value={s.caminho}>{s.nome}</option>)}
        </select>
      </label>

      {pastaAtual && (
        <label className="campo">
          <span>ou criar uma pasta nova aqui</span>
          <span className="linha">
            <input
              value={nomeNovo}
              placeholder="ex: Melhores momentos"
              onChange={(e) => setNomeNovo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') criarEUsar(); }}
            />
            <button onClick={criarEUsar} disabled={!nomeNovo.trim() || ocupado}>Criar</button>
          </span>
        </label>
      )}

      {renomeados.length > 0 && (
        <p className="aviso-dialogo">
          {renomeados.length} arquivo(s) já têm um nome igual no destino — entram com
          sufixo em vez de sobrescrever.
        </p>
      )}

      {plano.length > 0 && (
        <ul className="previa">
          {plano.slice(0, 12).map((p) => (
            <li key={p.id}><code>{p.nome}</code> → <code>{p.destino.split(/[\\/]/).pop()}</code></li>
          ))}
          {plano.length > 12 && <li className="mais">e mais {plano.length - 12}…</li>}
        </ul>
      )}
    </Moldura>
  );
}

function DialogoRenomear({ ids, aoFechar, aoTerminar, aoAvisar }: {
  ids: number[]; aoFechar: () => void; aoTerminar: (m: string) => void; aoAvisar: (m: string) => void;
}) {
  const [padrao, setPadrao] = useState('{nome}');
  const [inicio, setInicio] = useState(1);
  const [plano, setPlano] = useState<PassoPlano[]>([]);
  const [ocupado, setOcupado] = useState(false);

  // A prévia sai do MESMO código que vai renomear de verdade: o que você lê aqui
  // é literalmente o que vai acontecer, não uma simulação parecida.
  useEffect(() => {
    if (!padrao.trim()) { setPlano([]); return; }
    const id = window.setTimeout(() => {
      api.planoRenomear(ids, padrao, inicio).then((r) => setPlano(r.passos)).catch(() => setPlano([]));
    }, 200);
    return () => clearTimeout(id);
  }, [padrao, inicio, ids]);

  const aplicar = async () => {
    setOcupado(true);
    try {
      const r = await api.aplicarLote('renomear', plano);
      aoTerminar(`${r.feitos.length} arquivo(s) renomeados`
        + (r.erros.length ? ` — ${r.erros.length} falharam` : ''));
      aoFechar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); }
  };

  return (
    <Moldura
      titulo={`Renomear ${ids.length} arquivo(s)`}
      aoFechar={aoFechar}
      rodape={
        <>
          <span className="dica">a extensão é preservada; nada é sobrescrito</span>
          <button onClick={aoFechar}>Cancelar</button>
          <button className="primario" disabled={!plano.length || ocupado} onClick={aplicar}>
            Renomear
          </button>
        </>
      }
    >
      <label className="campo">
        <span>Padrão</span>
        <input value={padrao} onChange={(e) => setPadrao(e.target.value)} autoFocus />
      </label>
      <label className="campo">
        <span>Começar a numerar em</span>
        <input
          type="number" min={0} value={inicio}
          onChange={(e) => setInicio(Number(e.target.value) || 0)}
          style={{ width: 80 }}
        />
      </label>

      <div className="fichas">
        {[
          ['{n}', 'número da sequência'],
          ['{nome}', 'nome atual'],
          ['{data}', 'data do arquivo'],
          ['{hora}', 'hora do arquivo'],
          ['{dur}', 'duração em minutos'],
        ].map(([ficha, oque]) => (
          <button key={ficha} onClick={() => setPadrao((p) => p + ficha)} title={oque}>
            {ficha}
          </button>
        ))}
      </div>

      {plano.length > 0 && (
        <ul className="previa">
          {plano.slice(0, 12).map((p) => (
            <li key={p.id}><code>{p.nome}</code> → <code>{p.novoNome}</code></li>
          ))}
          {plano.length > 12 && <li className="mais">e mais {plano.length - 12}…</li>}
        </ul>
      )}
    </Moldura>
  );
}
