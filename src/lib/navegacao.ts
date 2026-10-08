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
};

let atual: Navegacao = { ...INICIAL };

export const navegacao = (): Navegacao => atual;

export function lembrar(patch: Partial<Navegacao>) {
  atual = { ...atual, ...patch };
}

/** Volta a biblioteca ao começo — usado quando a pasta deixa de existir. */
export function esquecer() {
  atual = { ...INICIAL };
}
