import { useEffect, useRef, useState } from 'react';
import { urlAudioFaixa, urlProxy, type Fonte } from '../lib/api';
import { baseDoArquivo, duracaoCurta, tcDaOrigem } from '../lib/tempo';
import type { Player } from '../lib/player';

const VELOCIDADES = [0.25, 0.5, 1, 1.5, 2, 4];

export function Visor({ fonte, player }: { fonte: Fonte; player: Player }) {
  const video = useRef<HTMLVideoElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [, forcar] = useState(0);
  const base = baseDoArquivo(fonte.fps, fonte.start_timecode);
  const faixasAudio = fonte.tracks.filter((t) => t.kind === 'audio' && t.audio_path);

  useEffect(() => { player.ligarVideo(video.current); }, [player, fonte.id]);
  useEffect(() => { player.definirFaixas(fonte.tracks); }, [player, fonte.tracks]);
  useEffect(() => player.assinarEstado(() => forcar((v) => v + 1)), [player]);

  // O timecode muda 30x por segundo. Escrever direto no DOM evita re-render do
  // React a cada quadro — isso sozinho e a diferenca entre 60fps e 20fps na UI.
  useEffect(() => player.assinarTempo((t) => {
    if (tcRef.current) tcRef.current.textContent = tcDaOrigem(t, base, fonte.start_timecode);
  }), [player, base, fonte.start_timecode]);

  return (
    <div className="visor">
      <div className="visor-video">
        <video
          ref={video}
          src={urlProxy(fonte.id)}
          preload="auto"
          playsInline
          onClick={() => player.alternar()}
        />
        {faixasAudio.map((f) => (
          <audio
            key={f.id}
            ref={(el) => player.ligarAudio(f.id, el)}
            src={urlAudioFaixa(f.id)}
            preload="auto"
          />
        ))}
        {fonte.status === 'processando' && (
          <div className="visor-aviso">
            {fonte.stage === 'proxy' ? 'gerando proxy' : 'analisando áudio'} · {(fonte.progress * 100).toFixed(0)}%
            <small>dá pra trabalhar já — o arquivo original está sendo usado enquanto isso</small>
          </div>
        )}
      </div>

      <div className="transporte">
        <button onClick={() => player.pular(-base.fps, base.fps)} title="1 segundo atrás (Shift+←)">⏮</button>
        <button onClick={() => player.pular(-1, base.fps)} title="1 quadro atrás (←)">◀|</button>
        <button className="principal" onClick={() => player.alternar()} title="Espaço">
          {player.tocando ? '❚❚' : '▶'}
        </button>
        <button onClick={() => player.pular(1, base.fps)} title="1 quadro à frente (→)">|▶</button>
        <button onClick={() => player.pular(base.fps, base.fps)} title="1 segundo à frente (Shift+→)">⏭</button>

        <span className="tc" ref={tcRef}>{tcDaOrigem(0, base, fonte.start_timecode)}</span>
        <span className="tc-total">de {duracaoCurta(fonte.duration_s)}</span>

        <select
          value={player.velocidade}
          onChange={(e) => player.definirVelocidade(Number(e.target.value))}
          title="Velocidade"
        >
          {VELOCIDADES.map((v) => <option key={v} value={v}>{v}×</option>)}
        </select>
      </div>
    </div>
  );
}
