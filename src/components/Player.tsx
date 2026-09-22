// O visor: o elemento de vídeo e as faixas de áudio.
//
// Só a mídia mora aqui. Os controles vivem em Controles.tsx, por cima — assim o
// mesmo visor serve ao modo cinema (vídeo ocupando a janela) e ao modo estúdio
// (vídeo num painel, com timeline embaixo), sem duplicar nada.
import { useEffect, useRef } from 'react';
import { urlAudioFaixa, urlVideo, type Fonte, type Qualidade } from '../lib/api';
import type { Player } from '../lib/player';

type Props = {
  fonte: Fonte;
  player: Player;
  qualidade: Qualidade;
  /** Muda quando o arquivo por tras da MESMA URL mudou (nivel recem-gerado). */
  recarga?: number;
  aoPedirMenu?: (x: number, y: number) => void;
};

export function Visor({ fonte, player, qualidade, recarga = 0, aoPedirMenu }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const faixasAudio = fonte.tracks.filter((t) => t.kind === 'audio' && t.audio_path);
  const fonteDeVideo = urlVideo(fonte.id, qualidade);

  useEffect(() => { player.ligarVideo(video.current); }, [player, fonte.id]);
  useEffect(() => { player.definirFaixas(fonte.tracks); }, [player, fonte.tracks]);

  // Trocar de qualidade troca o `src`, e trocar o `src` zera o tempo e para o
  // vídeo. Guardar onde estava e retomar é o que faz a troca parecer um ajuste
  // de qualidade em vez de um recomeço.
  //
  // Quando um nível acaba de ser gerado, a URL é a mesma de antes (o servidor
  // vinha servindo o original no lugar dele), então nem React nem o elemento
  // percebem: só `load()` faz buscar o arquivo novo.
  // `player` e o mesmo objeto entre arquivos, e `<video>` tambem (mesma posicao
  // na arvore), entao `tempo` sobrevive a troca de arquivo. Retomar so faz
  // sentido dentro do MESMO arquivo — senao o video novo abriria no minuto em
  // que o anterior parou.
  const arquivoAnterior = useRef<number | null>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const mesmoArquivo = arquivoAnterior.current === fonte.id;
    arquivoAnterior.current = fonte.id;
    if (!mesmoArquivo) { player.tempo = 0; return; }
    const tempo = player.tempo;
    const tocava = player.tocando;
    const retomar = () => {
      el.removeEventListener('loadedmetadata', retomar);
      if (tempo > 0.1) player.buscar(tempo);
      if (tocava) player.tocar();
    };
    el.addEventListener('loadedmetadata', retomar);
    el.load();
    return () => el.removeEventListener('loadedmetadata', retomar);
  }, [fonteDeVideo, recarga, player, fonte.id]);

  return (
    <div className="visor">
      <div className="visor-video">
        <video
          ref={video}
          src={fonteDeVideo}
          preload="auto"
          playsInline
          onClick={() => player.alternar()}
          onDoubleClick={(e) => e.preventDefault()}
          onContextMenu={(e) => {
            if (!aoPedirMenu) return;
            e.preventDefault();
            aoPedirMenu(e.clientX, e.clientY);
          }}
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
            {fonte.stage?.startsWith('qualidade') ? 'gerando qualidade menor'
              : fonte.stage === 'proxy' ? 'preparando revisão'
                : 'separando as faixas de áudio'}
            {' · '}{(fonte.progress * 100).toFixed(0)}%
            <small>dá pra assistir já — o vídeo continua tocando</small>
          </div>
        )}
      </div>
    </div>
  );
}
