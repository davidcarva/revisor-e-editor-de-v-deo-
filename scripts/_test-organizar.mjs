// Teste das operações que MEXEM EM DISCO: mover, renomear, desfazer.
//
// Roda inteiramente numa pasta descartável, com banco próprio. Nunca toca em
// arquivo de verdade — o que está sendo testado aqui é justamente o código que
// pode perder os arquivos de alguém.
//
//   node scripts/_test-organizar.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as db from '../server/db.mjs';
import * as biblioteca from '../server/biblioteca.mjs';

const RAIZ = path.join(os.tmpdir(), `revisor-organizar-${Date.now()}`);
const CACHE = path.join(RAIZ, '_cache');

let falhas = 0;
const ok = (cond, msg) => { if (!cond) falhas++; console.log(`${cond ? '  ok  ' : ' FALHA'} ${msg}`); };
const existe = (p) => fs.existsSync(p);

await fsp.mkdir(path.join(RAIZ, 'origem'), { recursive: true });
await fsp.mkdir(CACHE, { recursive: true });

// Arquivos falsos com extensão de vídeo: as operações de disco não decodificam
// nada, então o conteúdo é irrelevante e o teste fica instantâneo.
const nomes = ['gravacao a', 'gravacao b', 'gravacao c', 'repetido'];
for (const n of nomes) {
  await fsp.writeFile(path.join(RAIZ, 'origem', `${n}.mp4`), `conteudo de ${n}`);
}
// Um arquivo que já ocupa o nome de destino, pra testar que nada é sobrescrito.
await fsp.mkdir(path.join(RAIZ, 'destino'), { recursive: true });
await fsp.writeFile(path.join(RAIZ, 'destino', 'repetido.mp4'), 'NAO PODE SUMIR');

db.open(path.join(RAIZ, 'teste.revdb'));
biblioteca.setRaizPosters(CACHE);
db.adicionarPasta(RAIZ);
const achados = await biblioteca.varrer(RAIZ);
ok(achados === 5, `varredura achou os 5 arquivos (${achados})`);

const daOrigem = () => db.listarMidia({ pasta: path.join(RAIZ, 'origem'), recursivo: false, limite: 50 });
const porNome = (n) => daOrigem().find((m) => m.nome === n);

// ------------------------------------------------------------------- mover
console.log('\nmover:');
{
  const alvos = ['gravacao a', 'gravacao b'].map((n) => porNome(n).id);
  const plano = biblioteca.planejarMover(alvos, path.join(RAIZ, 'destino'));
  ok(plano.length === 2, 'o plano cobre os 2 arquivos');
  ok(plano.every((p) => !existe(p.destino)), 'planejar não criou nada em disco');

  const r = await biblioteca.aplicarLote('mover', plano);
  ok(r.feitos.length === 2 && r.erros.length === 0, `2 movidos, 0 erros (${r.erros.map((e) => e.erro)})`);
  ok(existe(path.join(RAIZ, 'destino', 'gravacao a.mp4')), 'o arquivo está no destino');
  ok(!existe(path.join(RAIZ, 'origem', 'gravacao a.mp4')), 'e saiu da origem');
  const naBase = db.getMidiaPorCaminho(path.join(RAIZ, 'destino', 'gravacao a.mp4'));
  ok(!!naBase, 'a biblioteca aponta pro novo caminho');
}

// ------------------------------------------------ mover sem sobrescrever
console.log('\nnão sobrescrever:');
{
  const alvo = porNome('repetido').id;
  const plano = biblioteca.planejarMover([alvo], path.join(RAIZ, 'destino'));
  ok(plano[0].destino.endsWith('repetido (2).mp4'),
    `o destino vira "repetido (2).mp4" (${path.basename(plano[0].destino)})`);
  await biblioteca.aplicarLote('mover', plano);
  const antigo = await fsp.readFile(path.join(RAIZ, 'destino', 'repetido.mp4'), 'utf8');
  ok(antigo === 'NAO PODE SUMIR', 'o arquivo que já estava lá continua intacto');
  ok(existe(path.join(RAIZ, 'destino', 'repetido (2).mp4')), 'e o novo entrou ao lado');
}

// --------------------------------------------------------------- renomear
console.log('\nrenomear em lote:');
{
  const noDestino = db.listarMidia({ pasta: path.join(RAIZ, 'destino'), recursivo: false, limite: 50 })
    .filter((m) => m.nome.startsWith('gravacao'))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  const plano = biblioteca.planejarRenomear(noDestino.map((m) => m.id), 'Partida {n} - {nome}');
  console.log(`  ${plano.map((p) => `${p.nome} -> ${p.novoNome}`).join(' | ')}`);
  ok(plano[0].novoNome === 'Partida 01 - gravacao a', 'o padrão numera e mantém o nome antigo');

  const r = await biblioteca.aplicarLote('renomear', plano);
  ok(r.feitos.length === plano.length, `${r.feitos.length} renomeados`);
  ok(existe(path.join(RAIZ, 'destino', 'Partida 01 - gravacao a.mp4')), 'o arquivo tem o nome novo');
}

// ----------------------------------------------- caracteres proibidos
console.log('\nnome seguro:');
ok(biblioteca.nomeSeguro('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j',
  'caracteres proibidos no Windows viram _');
ok(biblioteca.nomeSeguro('  nome.  ') === 'nome', 'espaço e ponto no fim são removidos');
ok(biblioteca.nomeSeguro('...oculto') === 'oculto', 'ponto inicial é removido');
ok(biblioteca.nomeSeguro('   ') === 'sem nome', 'nome vazio vira um nome utilizável');

// --------------------------------------------------------------- desfazer
console.log('\ndesfazer:');
{
  const antes = fs.readdirSync(path.join(RAIZ, 'destino')).sort();
  const r = await biblioteca.desfazerUltimo();
  ok(r.erros.length === 0, `desfez sem erro (${r.voltaram.length} arquivos)`);
  ok(existe(path.join(RAIZ, 'destino', 'gravacao a.mp4')),
    'o nome antigo voltou depois de desfazer o renomear');
  ok(!existe(path.join(RAIZ, 'destino', 'Partida 01 - gravacao a.mp4')),
    'e o nome novo não existe mais');
  const naBase = db.getMidiaPorCaminho(path.join(RAIZ, 'destino', 'gravacao a.mp4'));
  ok(!!naBase, 'a biblioteca acompanhou a volta');
  console.log(`  antes: ${antes.length} arquivos | depois: ${fs.readdirSync(path.join(RAIZ, 'destino')).length}`);
}

// ------------------------------------------------- sources segue o arquivo
console.log('\no caminho da revisão acompanha:');
{
  const m = db.listarMidia({ pasta: path.join(RAIZ, 'destino'), recursivo: false, limite: 50 })[0];
  db.upsertSource({
    path: m.caminho, name: path.basename(m.caminho), duration_s: 10, fps: 30,
    width: 1920, height: 1080, start_timecode: '00:00:00:00', size_bytes: 1, probe_json: '{}',
  });
  const plano = biblioteca.planejarMover([m.id], path.join(RAIZ, 'origem'));
  await biblioteca.aplicarLote('mover', plano);
  const fonte = db.listSources().find((s) => s.path === plano[0].destino);
  ok(!!fonte, 'sources.path passou a apontar pro novo lugar, não pro vazio');
}

// ------------------------------------------------------------ nova pasta
console.log('\ncriar pasta:');
{
  const nova = await biblioteca.criarPasta(RAIZ, 'Melhores momentos');
  ok(existe(nova), `pasta criada: ${path.basename(nova)}`);
  let recusou = false;
  try { await biblioteca.criarPasta(RAIZ, 'Melhores momentos'); } catch { recusou = true; }
  ok(recusou, 'criar de novo com o mesmo nome é recusado');
}

// ------------------------------------------------- arquivo que sumiu
console.log('\narquivo que saiu do lugar por fora:');
{
  const m = db.listarMidia({ pasta: path.join(RAIZ, 'origem'), recursivo: false, limite: 50 })[0];
  await fsp.unlink(m.caminho);
  const plano = biblioteca.planejarMover([m.id], path.join(RAIZ, 'destino'));
  const r = await biblioteca.aplicarLote('mover', plano);
  ok(r.erros.length === 1 && r.feitos.length === 0,
    'o lote reporta o erro em vez de estourar');
  console.log(`  erro reportado: ${r.erros[0].erro}`);
}

db.fechar();   // o WAL segura arquivos; sem fechar, o rm falha com EBUSY
await fsp.rm(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'tudo certo' : `${falhas} falha(s)`}`);
process.exitCode = falhas === 0 ? 0 : 1;
