// Seleção por caixa arrastada — o laço do Explorador.
//
// Três coisas que parecem detalhe e são a diferença entre "funciona" e
// "funciona bem":
//
//   1. a caixa só nasce depois de alguns pixels de arrasto, senão todo clique
//      num espaço vazio vira um laço de 1px que limpa a seleção sem querer;
//   2. as posições dos cartões são medidas UMA vez, no começo do arrasto, em
//      coordenadas do documento. Medir a cada movimento custa um reflow por
//      quadro com 300 cartões na tela, e rolar durante o arrasto quebraria a
//      conta se as coordenadas fossem da janela;
//   3. segurar Ctrl/Shift soma à seleção que já existia em vez de substituí-la.
import { useCallback, useEffect, useRef, useState } from 'react';

export type Caixa = { x: number; y: number; w: number; h: number };

const LIMIAR = 5;          // px de arrasto antes da caixa existir
const BORDA = 60;          // px da borda onde a rolagem automática começa
const VELOCIDADE = 14;     // px por quadro no limite da borda

type Opcoes = {
  /** Seletor dos itens selecionáveis, cada um com `data-id`. */
  seletor: string;
  aoSelecionar: (ids: number[], somar: boolean) => void;
  /** Chamado no clique seco no vazio — sem arrasto. */
  aoLimpar?: () => void;
  ativo?: boolean;
};

export function useLaco({ seletor, aoSelecionar, aoLimpar, ativo = true }: Opcoes) {
  const area = useRef<HTMLDivElement>(null);
  const [caixa, setCaixa] = useState<Caixa | null>(null);

  // As funcoes vao pra ref porque o efeito que escuta o mouse NAO pode depender
  // delas. Se dependesse, selecionar um cartao re-renderizaria a lista, o efeito
  // seria desmontado e remontado no meio do arrasto, e o `pointermove` morreria
  // junto: o laco pegava o primeiro cartao e parava de funcionar.
  const chamadas = useRef({ aoSelecionar, aoLimpar });
  chamadas.current = { aoSelecionar, aoLimpar };

  // Tudo o que só o arrasto usa fica em ref: mudar isso não pode re-renderizar
  // a lista inteira a cada movimento do mouse.
  const arrasto = useRef<{
    x0: number; y0: number;
    somar: boolean;
    /** O começo em coordenadas da janela, pra desenhar. */
    xTela: number; yTela: number;
    passouDoLimiar: boolean;
    alvos: { id: number; x: number; y: number; w: number; h: number }[];
    ultimo: { x: number; y: number };
    quadro: number;
  } | null>(null);

  const medir = useCallback(() => {
    const raiz = area.current;
    if (!raiz) return [];
    // Coordenadas do CONTEÚDO da área que rola — não da janela. Quem rola aqui
    // é a própria `.inicio`: o app ocupa a tela e cada painel rola por dentro,
    // então `window.scrollY` é sempre zero e não serviria de referência.
    const base = raiz.getBoundingClientRect();
    return [...raiz.querySelectorAll<HTMLElement>(seletor)].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: Number(el.dataset.id),
        x: r.left - base.left + raiz.scrollLeft,
        y: r.top - base.top + raiz.scrollTop,
        w: r.width,
        h: r.height,
      };
    }).filter((a) => Number.isFinite(a.id) && a.id > 0);
  }, [seletor]);

  const aplicar = useCallback((c: Caixa, somar: boolean) => {
    const a = arrasto.current;
    if (!a) return;
    const dentro = a.alvos
      .filter((t) => t.x < c.x + c.w && t.x + t.w > c.x && t.y < c.y + c.h && t.y + t.h > c.y)
      .map((t) => t.id);
    chamadas.current.aoSelecionar(dentro, somar);
  }, []);

  useEffect(() => {
    const raiz = area.current;
    if (!raiz || !ativo) return;

    const descer = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const alvo = e.target as HTMLElement;
      // Clicar num cartão, botão ou campo é o trabalho deles, não do laço.
      if (alvo.closest('button, a, input, label, select, textarea, .barra-selecao')) return;

      const base = raiz.getBoundingClientRect();
      arrasto.current = {
        x0: e.clientX - base.left + raiz.scrollLeft,
        y0: e.clientY - base.top + raiz.scrollTop,
        xTela: e.clientX,
        yTela: e.clientY,
        somar: e.ctrlKey || e.metaKey || e.shiftKey,
        passouDoLimiar: false,
        alvos: [],
        ultimo: { x: e.clientX, y: e.clientY },
        quadro: 0,
      };
      window.addEventListener('pointermove', mover);
      window.addEventListener('pointerup', subir, { once: true });
    };

    /** Converte um ponto da janela para coordenada do conteúdo que rola. */
    const noConteudo = (clientX: number, clientY: number) => {
      const base = raiz.getBoundingClientRect();
      return {
        x: clientX - base.left + raiz.scrollLeft,
        y: clientY - base.top + raiz.scrollTop,
      };
    };

    /**
     * A caixa que APARECE vive em coordenadas da janela; a que SELECIONA, em
     * coordenadas do conteúdo.
     *
     * Parece redundante e não é. O conteúdo pode se mexer durante o arrasto —
     * selecionar cartões dispara animação de layout, e a rolagem automática da
     * borda move a lista de propósito. Desenhar no conteúdo fazia a caixa
     * descolar do cursor quando isso acontecia. Quem precisa acompanhar o
     * conteúdo é a seleção, e essa continua no conteúdo.
     */
    const caixaDe = (x: number, y: number): Caixa => {
      const a = arrasto.current!;
      return {
        x: Math.min(a.x0, x),
        y: Math.min(a.y0, y),
        w: Math.abs(x - a.x0),
        h: Math.abs(y - a.y0),
      };
    };

    const mover = (e: PointerEvent) => {
      const a = arrasto.current;
      if (!a) return;
      a.ultimo = { x: e.clientX, y: e.clientY };

      const agora = noConteudo(e.clientX, e.clientY);
      if (!a.passouDoLimiar) {
        if (Math.abs(agora.x - a.x0) < LIMIAR && Math.abs(agora.y - a.y0) < LIMIAR) return;
        a.passouDoLimiar = true;
        a.alvos = medir();
        // Arrastar sobre texto seleciona o texto junto; isso atrapalha o laço.
        document.body.classList.add('lacando');
        rolarSePerto();
      }
      e.preventDefault();
      aplicar(caixaDe(agora.x, agora.y), a.somar);
      setCaixa(naTela(e.clientX, e.clientY));
    };

    /** A caixa visível, em coordenadas da janela. */
    const naTela = (x: number, y: number): Caixa => {
      const a = arrasto.current!;
      return {
        x: Math.min(a.xTela, x),
        y: Math.min(a.yTela, y),
        w: Math.abs(x - a.xTela),
        h: Math.abs(y - a.yTela),
      };
    };

    // Chegar na borda rola a lista, como no Explorador.
    const rolarSePerto = () => {
      const a = arrasto.current;
      if (!a?.passouDoLimiar) return;
      const base = raiz.getBoundingClientRect();
      const y = a.ultimo.y - base.top;
      const alto = base.height;
      let d = 0;
      if (y < BORDA) d = -VELOCIDADE * (1 - y / BORDA);
      else if (y > alto - BORDA) d = VELOCIDADE * (1 - (alto - y) / BORDA);
      if (d) {
        raiz.scrollTop += d;
        // Rolar move o conteúdo sob o cursor parado: o alcance da seleção muda,
        // o desenho não.
        const p = noConteudo(a.ultimo.x, a.ultimo.y);
        aplicar(caixaDe(p.x, p.y), a.somar);
      }
      a.quadro = requestAnimationFrame(rolarSePerto);
    };

    const subir = () => {
      const a = arrasto.current;
      window.removeEventListener('pointermove', mover);
      document.body.classList.remove('lacando');
      if (a) cancelAnimationFrame(a.quadro);
      // Clique seco no vazio: limpa, como o Explorador.
      if (a && !a.passouDoLimiar && !a.somar) chamadas.current.aoLimpar?.();
      arrasto.current = null;
      setCaixa(null);
    };

    raiz.addEventListener('pointerdown', descer);
    return () => {
      raiz.removeEventListener('pointerdown', descer);
      window.removeEventListener('pointermove', mover);
      document.body.classList.remove('lacando');
    };
    // Só `ativo` e o seletor: ver o comentário em `chamadas`.
  }, [ativo, medir, aplicar]);

  return { area, caixa };
}
