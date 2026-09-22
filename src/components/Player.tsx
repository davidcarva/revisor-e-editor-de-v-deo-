// O visor: o elemento de vídeo e as faixas de áudio.
//
// Só a mídia mora aqui. Os controles vivem em Controles.tsx, por cima — assim o
// mesmo visor serve ao modo cinema (vídeo ocupando a janela) e ao modo estúdio
// (vídeo num painel, com timeline embaixo), sem duplicar nada.
import { useEffect, useRef } from 'react';
import { urlAudioFaixa, urlProxy, type Fonte } from '../lib/api';
import type { Player } from '../lib/player';

export function Visor({ fonte, player }: { fonte: Fonte; player: Player }) {
  const video = useRef<HTMLVideoElement>(null);
  const faixasAudio = fonte.tracks.filter((t) => t.kind === 'audio' && t.audio_path);

  useEffect(() => { player.ligarVideo(video.current); }, [player, fonte.id]);
  useEffect(() => { player.definirFaixas(fonte.tracks); }, [player, fonte.tracks]);

  return (
    <div className="visor">
      <div className="visor-video">
        <video
          ref={video}
          src={urlProxy(fonte.id)}
          preload="auto"
          playsInline
          onClick={() => player.alternar()}
          onDoubleClick={(e) => e.preventDefault()}
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
            <span className="visor-aviso-ponto" />
            {fonte.stage === 'proxy' ? 'preparando revisão' : 'separando as faixas de áudio'}
            {' · '}{(fonte.progress * 100).toFixed(0)}%
            <small>dá pra assistir já — o arquivo original está sendo usado enquanto isso</small>
          </div>
        )}
      </div>
    </div>
  );
}
