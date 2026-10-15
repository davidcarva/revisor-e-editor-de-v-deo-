// Portaria das miniaturas: no máximo três sendo buscadas ao mesmo tempo.
//
// O navegador abre no máximo 6 conexões simultâneas por servidor. A conexão de
// eventos (SSE) fica com uma delas pra sempre, e as miniaturas pegam o resto —
// então, numa pasta cujas miniaturas ainda não existem, as 5 vagas restantes
// ficam ocupadas por ffmpeg gerando quadro. Medido aqui, com seis ao mesmo
// tempo: 2 segundos cada, 3,2 s no pior caso.
//
// O efeito é que o PEDIDO DA PRÓXIMA PASTA entra na fila atrás das imagens.
// Clicar numa pasta durante esse período não mostrava nada por vários segundos,
// e a tela inteira ficava apagada esperando — parecia travada.
//
// Segurar as miniaturas em três deixa sempre vaga livre pra API. As imagens
// demoram um pouco mais a completar; a navegação deixa de esperar por elas, que
// é o que a pessoa está olhando.
import { useCallback, useEffect, useRef, useState } from 'react';
import { urlPoster } from './api';

const MAX_SIMULTANEAS = 3;

let emVoo = 0;
const esperando: (() => void)[] = [];

function liberar() {
  emVoo--;
  const proxima = esperando.shift();
  if (proxima) { emVoo++; proxima(); }
}

/** Resolve quando houver vaga; devolve a função que a devolve. */
function pegarVaga(): Promise<() => void> {
  return new Promise((entrar) => {
    // Uma vaga só é devolvida uma vez, aconteça o que acontecer com a imagem.
    const devolver = () => { if (!devolvida) { devolvida = true; liberar(); } };
    let devolvida = false;
    if (emVoo < MAX_SIMULTANEAS) { emVoo++; entrar(devolver); }
    else esperando.push(() => entrar(devolver));
  });
}

/**
 * O `src` da miniatura, entregue só quando houver vaga.
 *
 * `pronto` é o que o cartão usa pra dizer "já estou perto da tela": sem isso a
 * grade inteira entraria na fila de uma vez, inclusive o que ninguém vai ver.
 */
export function useCapa(id: number, pronto: boolean) {
  const [src, setSrc] = useState<string | null>(null);
  const devolver = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!pronto) return;
    let vivo = true;
    pegarVaga().then((solta) => {
      // Rolou pra longe antes da vez chegar: devolve sem baixar nada.
      if (!vivo) { solta(); return; }
      devolver.current = solta;
      setSrc(urlPoster(id));
    });
    return () => {
      vivo = false;
      devolver.current?.();
      devolver.current = null;
    };
  }, [id, pronto]);

  // Carregou, falhou ou foi desmontada: a vaga volta pra fila do mesmo jeito.
  const terminou = useCallback(() => {
    devolver.current?.();
    devolver.current = null;
  }, []);

  return { src, terminou };
}
