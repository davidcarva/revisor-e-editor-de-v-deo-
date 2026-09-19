// Teste da navegação por pastas da biblioteca, contra o servidor rodando.
//
//   node scripts/_test-biblioteca.mjs [porta]
//
// Vive num arquivo, e não num `node -e`, porque caminho do Windows tem barra
// invertida e passar isso por bash -> node -e vira uma corrida de escapes que
// já engoliu o caminho duas vezes.
const PORTA = process.argv[2] || '5395';
const API = `http://127.0.0.1:${PORTA}`;

const pega = async (caminho) => {
  const r = await fetch(API + caminho);
  if (!r.ok) throw new Error(`${r.status} ${caminho}`);
  return r.json();
};
const naPasta = (p, { recursivo = 0, limite = 5, ordem = 'modificado' } = {}) =>
  pega(`/api/biblioteca?pasta=${encodeURIComponent(p)}&recursivo=${recursivo}`
    + `&limite=${limite}&ordem=${ordem}`);

let falhas = 0;
const ok = (cond, msg) => { if (!cond) falhas++; console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`); };

const inicial = await pega('/api/biblioteca?limite=1');
if (!inicial.pastas.length) {
  console.log('nenhuma pasta na biblioteca — adicione uma antes de rodar este teste');
  process.exit(0);
}

const raiz = inicial.pastas[0].caminho;
console.log(`pasta raiz: ${raiz}\n`);

const nivel1 = await naPasta(raiz);
console.log(`direto em ${raiz}: ${nivel1.diretos} arquivo(s)`);
console.log(`subpastas: ${nivel1.subpastas.map((s) => `${s.nome} (${s.arquivos})`).join(', ') || '(nenhuma)'}`);
ok(nivel1.subpastas.length > 0 || nivel1.diretos > 0, 'a pasta raiz tem conteúdo');
ok(nivel1.itens.length === Math.min(5, nivel1.diretos),
  `sem recursivo, mostra só os ${nivel1.diretos} arquivos diretos (veio ${nivel1.itens.length})`);

const recursivo = await naPasta(raiz, { recursivo: 1, limite: 400 });
const soma = nivel1.diretos + nivel1.subpastas.reduce((a, s) => a + s.arquivos, 0);
ok(recursivo.itens.length === soma,
  `com recursivo, ${recursivo.itens.length} itens = ${nivel1.diretos} diretos + ${soma - nivel1.diretos} nas subpastas`);

if (nivel1.subpastas.length) {
  const sub = nivel1.subpastas[0];
  const dentro = await naPasta(sub.caminho, { limite: 4 });
  console.log(`\ndentro de ${sub.nome}: ${dentro.diretos} direto(s)`
    + `, subpastas: ${dentro.subpastas.map((s) => s.nome).join(', ') || '(nenhuma)'}`);
  console.log(`  ${dentro.itens.map((i) => i.nome.slice(0, 22)).join(' | ')}`);
  ok(dentro.itens.every((i) => i.pasta === sub.caminho),
    'todo item listado pertence mesmo à subpasta aberta');
  ok(dentro.diretos + dentro.subpastas.reduce((a, s) => a + s.arquivos, 0) === sub.arquivos,
    `a contagem da subpasta (${sub.arquivos}) bate com o que há dentro dela`);
}

console.log('\nordenações:');
for (const ordem of ['modificado', 'antigos', 'nome', 'duracao', 'tamanho']) {
  const r = await naPasta(raiz, { recursivo: 1, limite: 3, ordem });
  const campo = { duracao: 'duracao', tamanho: 'tamanho', nome: 'nome' }[ordem] ?? 'modificado';
  console.log(`  ${ordem.padEnd(11)} ${r.itens.map((i) => `${i.nome.slice(0, 18)}=${i[campo] ?? '?'}`).join(' | ')}`);
  ok(r.itens.length > 0, `ordem "${ordem}" devolve itens`);
}

// Busca tem que atravessar subpasta, senão procurar um nome e não achar porque
// ele está um nível abaixo seria uma armadilha.
const umNome = recursivo.itens.find((i) => i.pasta !== raiz)?.nome;
if (umNome) {
  const achou = await pega(`/api/biblioteca?pasta=${encodeURIComponent(raiz)}`
    + `&recursivo=0&q=${encodeURIComponent(umNome.slice(0, 12))}`);
  ok(achou.itens.length > 0, 'busca encontra arquivo de subpasta mesmo com "só esta pasta" ligado');
}

console.log(`\n${falhas === 0 ? 'tudo certo' : `${falhas} falha(s)`}`);
// `exitCode` em vez de `process.exit()`: sair com os handles do fetch ainda
// abertos dispara um assert do libuv no Windows e suja a saída do teste.
process.exitCode = falhas === 0 ? 0 : 1;
