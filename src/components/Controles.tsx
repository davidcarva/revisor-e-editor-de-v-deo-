// Controles de reprodutor: o que o VLC e o Media Player têm e o Revisor não tinha.
//
// Ficam por cima do vídeo e somem sozinhos depois de alguns segundos parados —
// é o que deixa o modo cinema ser cinema. Qualquer movimento do mouse, foco de
// teclado ou pausa traz de volta.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Faixa, Fonte } from '../lib/api';
import { baseDoArquivo, duracaoCurta, tcDaOrigem } from '../lib/tempo';
import type { Player } from '../lib/player';

const SUMIR_APOS = 2600;
const VELOCIDADES = [0.25, 0.5, 1, 1.5, 2, 4];

type Props = {
  fonte: Fonte;
  player: Player;
  telaCheia: boolean;
  aoAlternarTelaCheia: () => void;
  aoMudarFaixa: (id: number, patch: Partial<Faixa>) => void;
};

export function Controles({ fonte, player, telaCheia, aoAlternarTelaCheia, aoMudarFaixa }: Props) {
  const [visivel, setVisivel] = useState(true);
  const [tocando, setTocando] = useState(false);
  const [volume, setVolume] = useState(() => player.volumeMestre);
  const [velocidade, setVelocidade] = useState(1);
  const [abrirMixer, setAbrirMixer] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const barra = useRef<HTMLDivElement>(null);
  const preenchimento = useRef<HTMLSpanElement>(null);
  const agulha = useRef<HTMLSpanElement>(null);
  const relogio = useRef<HTMLSpanElement>(null);
  const timerSumir = useRef(0);

  const base = baseDoArquivo(fonte.fps, fonte.start_timecode);
  const faixas = fonte.tracks.filter((t) => t.kind === 'audio');
  const duracao = fonte.duration_s || 1;

  const acordar = useCallback(() => {
    setVisivel(true);
    clearTimeout(timerSumir.current);
    // Com o vídeo parado ou algum painel aberto, os controles ficam: sumir
    // enquanto alguém está decidindo o que fazer é hostil.
    if (!player.tocando || abrirMixer) return;
    timerSumir.current = window.setTimeout(() => setVisivel(false), SUMIR_APOS);
  }, [player, abrirMixer]);

  useEffect(() => {
    const mover = () => acordar();
    window.addEventListener('mousemove', mover);
    window.addEventListener('keydown', mover);
    acordar();
    return () => {
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('keydown', mover);
      clearTimeout(timerSumir.current);
    };
  }, [acordar]);

  useEffect(() => player.assinarEstado(() => {
    setTocando(player.tocando);
    setVelocidade(player.velocidade);
    acordar();
  }), [player, acordar]);

  // A barra e o relógio são escritos direto no DOM, 60x por segundo. Passar isso
  // por estado do React re-renderizaria a árvore inteira a cada quadro.
  useEffect(() => player.assinarTempo((t) => {
    const pct = Math.min(100, (t / duracao) * 100);
    if (preenchimento.current) preenchimento.current.style.width = `${pct}%`;
    if (agulha.current) agulha.current.style.left = `${pct}%`;
    if (relogio.current) relogio.current.textContent = tcDaOrigem(t, base, fonte.start_timecode);
  }), [player, duracao, base, fonte.start_timecode]);

  const tempoDoEvento = (e: React.MouseEvent) => {
    const r = barra.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duracao;
  };

  const arrastar = (e: React.MouseEvent) => {
    e.preventDefault();
    player.definirArraste(true);
    player.buscar(tempoDoEvento(e));
    const mover = (ev: MouseEvent) => player.buscar(tempoDoEvento(ev as unknown as React.MouseEvent));
    const soltar = () => {
      player.definirArraste(false);
      window.removeEventListener('mousemove', mover);
      window.removeEventListener('mouseup', soltar);
    };
    window.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
  };

  const temSolo = faixas.some((f) => f.solo);

  return (
    <div className={`controles ${visivel ? '' : 'sumido'}`} onMouseMove={acordar}>
      <div className="controles-barra">
        <div
          className="trilho"
          ref={barra}
          onMouseDown={arrastar}
          onMouseMove={(e) => setHover(tempoDoEvento(e))}
          onMouseLeave={() => setHover(null)}
        >
          <span className="trilho-fundo" />
          <span className="trilho-cheio" ref={preenchimento} />
          <span className="trilho-agulha" ref={agulha} />
          {hover != null && (
            <span className="trilho-dica" style={{ left: `${(hover / duracao) * 100}%` }}>
              {duracaoCurta(hover)}
            </span>
          )}
        </div>
      </div>

      <div className="controles-linha">
        <button className="ctrl principal" onClick={() => player.alternar()} title="Espaço">
          {tocando ? '❚❚' : '▶'}
        </button>
        <button className="ctrl" onClick={() => player.pular(-10 * base.fps, base.fps)} title="10 s atrás (J)">
          ↺10
        </button>
        <button className="ctrl" onClick={() => player.pular(10 * base.fps, base.fps)} title="10 s à frente (L)">
          10↻
        </button>

        <div className="ctrl-volume">
          <button
            className="ctrl"
            onClick={() => { const v = volume > 0 ? 0 : 1; setVolume(v); player.definirVolume(v); }}
            title="Mudo (M)"
          >{volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}</button>
          <input
            type="range" min={0} max={1} step={0.01} value={volume}
            onChange={(e) => { const v = Number(e.target.value); setVolume(v); player.definirVolume(v); }}
            title={`Volume ${Math.round(volume * 100)}%`}
          />
        </div>

        <span className="ctrl-tempo">
          <span ref={relogio}>{tcDaOrigem(0, base, fonte.start_timecode)}</span>
          <em>{duracaoCurta(duracao)}</em>
        </span>

        <span className="ctrl-espaco" />

        {faixas.length > 1 && (
          <div className="mixer-caixa">
            <button
              className={`ctrl ${abrirMixer ? 'on' : ''}`}
              onClick={() => setAbrirMixer((v) => !v)}
              title="Faixas de áudio"
            >{faixas.length} faixas</button>

            {abrirMixer && (
              <div className="mixer">
                <strong>Faixas de áudio</strong>
                {faixas.map((f) => (
                  <div className="mixer-linha" key={f.id}>
                    <span className="mixer-cor" style={{ background: f.color ?? '#4f9cf0' }} />
                    <span className="mixer-nome" title={f.label}>{f.label}</span>
                    <button
                      className={f.muted ? 'on mudo' : ''}
                      onClick={() => aoMudarFaixa(f.id, { muted: f.muted ? 0 : 1 })}
                      title="Mudo"
                    >M</button>
                    <button
                      className={f.solo ? 'on solo' : ''}
                      onClick={() => aoMudarFaixa(f.id, { solo: f.solo ? 0 : 1 })}
                      title="Solo"
                    >S</button>
                    <input
                      type="range" min={-12} max={12} step={1} value={f.gain_db}
                      onChange={(e) => aoMudarFaixa(f.id, { gain_db: Number(e.target.value) })}
                      title={`${f.gain_db > 0 ? '+' : ''}${f.gain_db} dB`}
                    />
                    <span className={`mixer-db ${temSolo && !f.solo ? 'apagado' : ''}`}>
                      {f.gain_db > 0 ? '+' : ''}{f.gain_db}
                    </span>
                  </div>
                ))}
                <p className="mixer-dica">
                  É isto que nenhum reprodutor comum mostra: cada microfone numa
                  faixa, controlável sem abrir editor.
                </p>
              </div>
            )}
          </div>
        )}

        <select
          className="ctrl"
          value={velocidade}
          onChange={(e) => player.definirVelocidade(Number(e.target.value))}
          title="Velocidade"
        >
          {VELOCIDADES.map((v) => <option key={v} value={v}>{v}×</option>)}
        </select>

        <button className="ctrl" onClick={aoAlternarTelaCheia} title="Tela cheia (F)">
          {telaCheia ? '⤡' : '⤢'}
        </button>
      </div>
    </div>
  );
}
