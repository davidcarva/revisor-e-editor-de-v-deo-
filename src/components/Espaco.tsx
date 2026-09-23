// Para onde foi o espaço do disco, e como recuperá-lo.
//
// Nada do que o app guarda aqui é insubstituível: tudo pode ser refeito a
// partir do arquivo original. O que muda é o preço de refazer — segundos para
// uma onda, minutos de GPU para uma conversão de vídeo, e por isso a
// transcrição nunca entra na limpeza: ela é minúscula em bytes e cara em tempo.
import { useCallback, useEffect, useState } from 'react';
import { api, type ResumoCache, type TipoCache } from '../lib/api';
import { tamanho } from './Preparo';

const ROTULO: Record<string, string> = {
  proxies: 'Versões convertidas',
  audio: 'Faixas de áudio',
  picos: 'Ondas da timeline',
  miniaturas: 'Miniaturas da régua',
  posters: 'Capas da biblioteca',
  transcricao: 'Transcrições',
  outros: 'Outros',
};

const EXPLICA: Record<string, string> = {
  proxies: 'metade e um quarto da resolução. Só a timeline precisa delas — '
    + 'o vídeo toca no arquivo original.',
  audio: 'cada microfone num arquivo. É o que faz o mixer de várias faixas funcionar.',
  picos: 'o desenho da onda. Refazer é rápido.',
  miniaturas: 'as imagenzinhas da régua da timeline.',
  posters: 'as capas dos cartões da página inicial.',
  transcricao: 'o texto do que foi falado. Minúsculo, e leva minutos de GPU pra refazer.',
};

/** Ordem de quem vale a pena apagar primeiro. */
const APAGAVEIS: TipoCache[] = ['proxies', 'miniaturas', 'audio', 'picos'];

export function PainelEspaco({ aoFechar, aoAvisar }: {
  aoFechar: () => void;
  aoAvisar: (m: string) => void;
}) {
  const [r, setR] = useState<ResumoCache | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [marcados, setMarcados] = useState<Set<number>>(new Set());
  const [confirmar, setConfirmar] = useState<{ texto: string; agir: () => Promise<void> } | null>(null);

  const carregar = useCallback(async () => {
    try { setR(await api.cache()); } catch (e) { aoAvisar(String((e as Error).message)); }
  }, [aoAvisar]);

  useEffect(() => { carregar(); }, [carregar]);

  const executar = async (agir: () => Promise<{ apagados: number; bytes: number }>) => {
    setOcupado(true);
    try {
      const res = await agir();
      aoAvisar(res.apagados
        ? `${tamanho(res.bytes)} liberados (${res.apagados} arquivos)`
        : 'nada foi apagado — o que sobrou está em uso ou já não existia');
      setMarcados(new Set());
      await carregar();
    } catch (e) { aoAvisar(String((e as Error).message)); }
    finally { setOcupado(false); setConfirmar(null); }
  };

  const pedirConfirmacao = (texto: string, agir: () => Promise<{ apagados: number; bytes: number }>) =>
    setConfirmar({ texto, agir: () => executar(agir) });

  const alternar = (id: number) => setMarcados((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const bytesMarcados = r
    ? r.fontes.filter((f) => marcados.has(f.id)).reduce((a, f) => a + f.total, 0)
    : 0;
  const proxies = r?.porTipo.proxies ?? 0;

  return (
    <div className="modal-fundo" onClick={aoFechar}>
      <div className="modal largo" onClick={(e) => e.stopPropagation()}>
        <h3>Espaço em disco</h3>

        {!r && <p className="modal-nota">medindo…</p>}

        {r && (
          <>
            <div className="espaco-total">
              <strong>{tamanho(r.total)}</strong>
              <span>em {r.raiz}</span>
            </div>

            <div className="espaco-tipos">
              {Object.entries(r.porTipo)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([t, b]) => (
                  <div className="espaco-tipo" key={t}>
                    <div className="espaco-linha">
                      <span className="espaco-rotulo">{ROTULO[t] ?? t}</span>
                      <span className="espaco-valor">{tamanho(b ?? 0)}</span>
                      {r.porHora[t as TipoCache] != null && (
                        <span className="espaco-taxa">
                          {tamanho(r.porHora[t as TipoCache]!)}/h de gravação
                        </span>
                      )}
                    </div>
                    <div className="espaco-barra">
                      <i style={{ width: `${r.total ? ((b ?? 0) / r.total) * 100 : 0}%` }} />
                    </div>
                    {EXPLICA[t] && <p className="espaco-explica">{EXPLICA[t]}</p>}
                  </div>
                ))}
            </div>

            <div className="espaco-acoes">
              {proxies > 0 && (
                <button
                  className="primario"
                  disabled={ocupado}
                  onClick={() => pedirConfirmacao(
                    `Apagar TODAS as versões convertidas (${tamanho(proxies)})?\n\n`
                    + 'Os vídeos continuam tocando: eles usam o arquivo original. '
                    + 'O que volta a custar tempo é arrastar a agulha na timeline '
                    + 'e escolher "metade" ou "um quarto" — aí é reconverter.',
                    () => api.limparCache(null, ['proxies']),
                  )}
                >Liberar {tamanho(proxies)} de versões convertidas</button>
              )}
              {r.orfaos > 0 && (
                <button
                  disabled={ocupado}
                  onClick={() => pedirConfirmacao(
                    `Apagar ${tamanho(r.orfaos)} de sobras sem dono?\n\n`
                    + 'São pastas de cache de arquivos que o app não conhece mais. '
                    + 'Nada as reclama.',
                    () => api.limparOrfaos(),
                  )}
                >Limpar sobras sem dono ({tamanho(r.orfaos)})</button>
              )}
            </div>

            <h4 className="espaco-sub">Por arquivo</h4>
            <p className="modal-nota">
              Marque os que não vai revisar tão cedo. Apagar não mexe no vídeo
              original — só no que o app gerou a partir dele.
            </p>
            <ul className="espaco-fontes">
              {r.fontes.map((f) => (
                <li key={f.id} className={marcados.has(f.id) ? 'on' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={marcados.has(f.id)}
                      onChange={() => alternar(f.id)}
                    />
                    <span className="espaco-nome" title={f.caminho}>{f.nome}</span>
                  </label>
                  <span className="espaco-dur">
                    {f.duracao ? `${Math.round(f.duracao / 60)} min` : ''}
                  </span>
                  <span className="espaco-detalhe">
                    {APAGAVEIS.filter((t) => f.porTipo[t])
                      .map((t) => `${ROTULO[t]!.toLowerCase()} ${tamanho(f.porTipo[t]!)}`)
                      .join(' · ')}
                  </span>
                  <span className="espaco-valor">{tamanho(f.total)}</span>
                </li>
              ))}
            </ul>

            {marcados.size > 0 && (
              <div className="espaco-selecao">
                <strong>{marcados.size} marcado{marcados.size > 1 ? 's' : ''} · {tamanho(bytesMarcados)}</strong>
                <button
                  disabled={ocupado}
                  onClick={() => pedirConfirmacao(
                    `Apagar só as versões convertidas de ${marcados.size} arquivo(s)?`,
                    () => api.limparCache([...marcados], ['proxies']),
                  )}
                >Só as conversões</button>
                <button
                  className="perigo"
                  disabled={ocupado}
                  onClick={() => pedirConfirmacao(
                    `Apagar TUDO o que o app gerou para ${marcados.size} arquivo(s) `
                    + `(${tamanho(bytesMarcados)})?\n\n`
                    + 'Inclui as faixas de áudio separadas — o mixer vai precisar '
                    + 'separá-las de novo na próxima vez que você abrir. '
                    + 'As transcrições ficam.',
                    () => api.limparCache([...marcados], ['proxies', 'audio', 'picos', 'miniaturas']),
                  )}
                >Tudo menos a transcrição</button>
              </div>
            )}
          </>
        )}

        <div className="modal-acoes">
          <button onClick={aoFechar}>Fechar</button>
        </div>
      </div>

      {confirmar && (
        <div className="modal-fundo em-cima" onClick={() => setConfirmar(null)}>
          <div className="modal estreito" onClick={(e) => e.stopPropagation()}>
            <p className="confirma-texto">{confirmar.texto}</p>
            <div className="modal-acoes">
              <button onClick={() => setConfirmar(null)}>Cancelar</button>
              <button className="perigo" disabled={ocupado} onClick={confirmar.agir}>
                {ocupado ? 'apagando…' : 'Apagar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
