// Onde você estava na biblioteca, para o botão de voltar devolver isso.
//
// O componente da biblioteca é desmontado quando um vídeo abre — é o que mantém
// 300 cartões, seus observadores e seus pedidos de miniatura fora da memória
// durante a reprodução. O preço é que o estado dele morre junto, e voltar
// recomeçava do zero: a pasta em que você estava, a busca que você tinha
// digitado e a posição da rolagem iam embora a cada vídeo aberto.
//
// Então o estado de navegação mora aqui fora, num objeto de módulo. Não é
// `useState` levantado para o App de propósito: nada disto precisa provocar
// renderização em ninguém, e passar sete campos por props atravessando três
// componentes seria pior.

export type Navegacao = {
  pasta: string;
  busca: string;
  ordem: string;
  dir: 'asc' | 'desc';
  filtro: string;
  recursivo: boolean;
  agrupar: string;
  rolagem: number;
  /**
   * Os caminhos que estavam na tela quando você abriu um vídeo, na ordem em que
   * apareciam.
   *
   * É isso que dá sentido a "próximo": não o próximo do acervo, o próximo
   * DAQUILO QUE VOCÊ ESTAVA OLHANDO — a pasta que escolheu, na ordem que
   * escolheu, com o filtro que escolheu. Triagem é percorrer uma fila; a fila é
   * esta.
   */
  fila: string[];
};

const INICIAL: Navegacao = {
  pasta: '',
  busca: '',
  ordem: 'modificado',
  dir: 'desc',
  filtro: '',
  recursivo: false,
  agrupar: 'nenhum',
  rolagem: 0,
  fila: [],
};

let atual: Navegacao = { ...INICIAL };

export const navegacao = (): Navegacao => atual;

export function lembrar(patch: Partial<Navegacao>) {
  atual = { ...atual, ...patch };
  // Gancho de inspeção: é um app local, e poder perguntar "o que ele acha que
  // está na fila?" pelo console poupa uma recompilação a cada dúvida.
  (window as unknown as { __nav?: Navegacao }).__nav = atual;
}

/** Volta a biblioteca ao começo — usado quando a pasta deixa de existir. */
export function esquecer() {
  atual = { ...INICIAL };
}

/** Onde um caminho está na fila. -1 quando ele não veio dela. */
export const posicaoNaFila = (caminho: string) =>
  atual.fila.findIndex((c) => c === caminho);

/**
 * O vizinho de `caminho` na fila, ou null nas pontas.
 *
 * Não dá a volta de propósito: numa triagem, chegar ao fim da pasta é uma
 * informação — voltar pro começo sem avisar faria você revisar tudo de novo
 * sem perceber.
 */
export function vizinhoNaFila(caminho: string, passo: 1 | -1): string | null {
  const i = posicaoNaFila(caminho);
  if (i < 0) return null;
  const alvo = i + passo;
  return alvo >= 0 && alvo < atual.fila.length ? atual.fila[alvo] : null;
}
