/**
 * O usuário está digitando num campo agora?
 *
 * Todo atalho de tecla solta (Espaço, T, M, setas) precisa disto: sem a checagem,
 * escrever "marcador" no registro dispara play/pause e pula quadros.
 *
 * O `alvo` de um evento de teclado nem sempre é um Element — pode ser `document`
 * ou `window`, que não têm `matches()`. Chamar `.matches` neles lança TypeError
 * dentro do listener e mata o atalho inteiro em silêncio.
 */
const CAMPOS = 'input, textarea, select, [contenteditable="true"]';

export function estaDigitando(alvo: EventTarget | null): boolean {
  return alvo instanceof Element && alvo.matches(CAMPOS);
}
