// O painel de log: onde o trabalho de revisao acontece de fato.
//
// Voce assiste, digita o que aconteceu, da Enter. O marcador nasce no timecode em
// que a agulha estava quando voce COMECOU a digitar — nao quando apertou Enter.
// Sem isso, cada anotacao nasce alguns segundos atrasada e o corte sai torto.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Fonte, Marcador } from '../lib/api';
import { CORES, baseDoArquivo, corDoMarcador, duracaoCurta, tcDaOrigem } from '../lib/tempo';
import type { Player } from '../lib/player';
import { estaDigitando } from '../lib/teclado';
import { copiarRoteiro } from '../lib/roteiro';

type Props = {
  fonte: Fonte;
  player: Player;
  marcadores: Marcador[];
  selecao: { de: number; ate: number } | null;
  aoCriar: (m: Partial<Marcador>) => void;
  aoAtualizar: (id: number, patch: Partial<Marcador>) => void;
  aoApagar: (id: number) => void;
  aoAvisar: (msg: string) => void;
};

export function PainelLog({ fonte, player, marcadores, selecao, aoCriar, aoAtualizar, aoApagar, aoAvisar }: Props) {
  const [texto, setTexto] = useState('');
  const [cor, setCor] = useState('amarelo');
  const [busca, setBusca] = useState('');
  const [editando, setEditando] = useState<number | null>(null);
  const [tempoFixado, setTempoFixado] = useState<number | null>(null);
  const entrada = useRef<HTMLTextAreaElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const [tempoAtual, setTempoAtual] = useState(0);

  const base = useMemo(() => baseDoArquivo(fonte.fps, fonte.start_timecode), [fonte.fps, fonte.start_timecode]);

  // Atualiza 4x por segundo: o suficiente pra destacar o marcador corrente sem
  // re-renderizar a lista inteira a cada quadro.
  useEffect(() => {
    let ultimo = 0;
    return player.assinarTempo((t) => {
      if (Math.abs(t - ultimo) < 0.25) return;
      ultimo = t;
      setTempoAtual(t);
    });
  }, [player]);

  // T: comeca uma marcacao sem parar o video. O timecode e fixado no instante em
  // que voce aperta a tecla — nao quando termina de escrever —, que e o ponto em
  // que a coisa realmente aconteceu.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (estaDigitando(e.target)) return;
      if (e.key !== 't' && e.key !== 'T') return;
      e.preventDefault();
      setTempoFixado(player.tempo);
      entrada.current?.focus();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [player]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return marcadores;
    return marcadores.filter((m) =>
      m.text.toLowerCase().includes(q) || m.comment.toLowerCase().includes(q));
  }, [marcadores, busca]);

  const indiceAtual = useMemo(() => {
    let i = -1;
    for (let k = 0; k < filtrados.length; k++) if (filtrados[k].t_in <= tempoAtual) i = k;
    return i;
  }, [filtrados, tempoAtual]);

  const enviar = () => {
    const t = texto.trim();
    if (!t) return;
    const inicio = selecao ? Math.min(selecao.de, selecao.ate) : (tempoFixado ?? player.tempo);
    const fim = selecao ? Math.max(selecao.de, selecao.ate) : null;
    aoCriar({ t_in: inicio, t_out: fim, text: t, color: cor, kind: selecao ? 'corte' : 'log' });
    setTexto('');
    setTempoFixado(null);
  };

  return (
    <aside className="painel">
      <header className="painel-topo">
        <strong>Registro</strong>
        <input
          className="busca"
          placeholder="buscar…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <span className="contagem">{filtrados.length}/{marcadores.length}</span>
        <button
          className="copiar"
          disabled={!filtrados.length}
          onClick={async () => {
            const modo = await copiarRoteiro({ fonte, base, marcadores: filtrados });
            aoAvisar(modo === 'rico'
              ? `${filtrados.length} marcações copiadas — cole no Google Docs`
              : `${filtrados.length} marcações copiadas como texto puro`);
          }}
          title="Copia as marcações formatadas; cole direto no Google Docs"
        >Copiar</button>
      </header>

      <div className="painel-lista" ref={lista}>
        {filtrados.length === 0 && (
          <p className="vazio">
            Nada registrado ainda. Assista e escreva embaixo — cada linha vira um
            marcador no timecode em que você começou a digitar.
          </p>
        )}
        {filtrados.map((m, i) => (
          <div
            key={m.id}
            className={`item ${i === indiceAtual ? 'atual' : ''}`}
            style={{ borderLeftColor: corDoMarcador(m.color) }}
            onDoubleClick={() => setEditando(m.id)}
          >
            <button
              className="item-tc"
              onClick={() => player.buscar(m.t_in)}
              title="Ir para este ponto"
            >
              {tcDaOrigem(m.t_in, base, fonte.start_timecode)}
              {m.t_out != null && (
                <em> +{duracaoCurta(m.t_out - m.t_in, true)}</em>
              )}
            </button>

            {editando === m.id ? (
              <textarea
                className="item-edicao"
                defaultValue={m.text}
                autoFocus
                onBlur={(e) => { aoAtualizar(m.id, { text: e.target.value }); setEditando(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === 'Escape') setEditando(null);
                }}
              />
            ) : (
              <p className="item-texto">{m.text}</p>
            )}

            <div className="item-acoes">
              {Object.keys(CORES).map((c) => (
                <button
                  key={c}
                  className={`ponto ${m.color === c ? 'on' : ''}`}
                  style={{ background: CORES[c] }}
                  onClick={() => aoAtualizar(m.id, { color: c })}
                  title={c}
                />
              ))}
              <button className="apagar" onClick={() => aoApagar(m.id)} title="Apagar">✕</button>
            </div>
          </div>
        ))}
      </div>

      <div className="painel-entrada">
        {selecao && (
          <div className="aviso-selecao">
            trecho selecionado: {duracaoCurta(Math.abs(selecao.ate - selecao.de), true)}
            {' — o registro vira um marcador com entrada e saída'}
          </div>
        )}
        <textarea
          ref={entrada}
          value={texto}
          placeholder="O que aconteceu? — Enter registra, Shift+Enter quebra linha, Esc volta ao vídeo"
          onFocus={() => setTempoFixado((t) => t ?? player.tempo)}
          onChange={(e) => {
            if (!texto && e.target.value) setTempoFixado(player.tempo);
            setTexto(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();   // Espaco aqui e espaco, nao play/pause
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
            // Esc devolve o teclado ao player sem perder o que ja foi digitado.
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <div className="entrada-rodape">
          <div className="cores">
            {Object.keys(CORES).map((c) => (
              <button
                key={c}
                className={`ponto ${cor === c ? 'on' : ''}`}
                style={{ background: CORES[c] }}
                onClick={() => setCor(c)}
                title={c}
              />
            ))}
          </div>
          <span className="tc-fixado">
            {tempoFixado != null
              ? `em ${tcDaOrigem(tempoFixado, base, fonte.start_timecode)}`
              : 'no ponto atual'}
          </span>
          <button className="registrar" onClick={enviar} disabled={!texto.trim()}>Registrar</button>
        </div>
      </div>
    </aside>
  );
}
