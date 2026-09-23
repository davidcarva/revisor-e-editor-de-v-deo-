// Registra o Revisor no Windows como aplicativo de mídia.
//
//   node scripts/registrar-windows.mjs            (só mostra o que faria)
//   node scripts/registrar-windows.mjs --aplicar
//   node scripts/registrar-windows.mjs --desfazer
//
// O que isto NÃO faz: virar o padrão sozinho. Desde o Windows 10 a escolha do
// app padrão (a chave `UserChoice`) é assinada com um hash que só o Explorador
// sabe gerar — qualquer programa que escreva ali direto é ignorado ou revertido.
// O que dá pra fazer é o que este script faz: registrar o app direito, com nome
// e ícone, pra ele aparecer em "Abrir com" e em Configurações › Aplicativos
// padrão. A escolha em si é sua, em dois cliques.
//
// Tudo fica em HKCU: é só do seu usuário, não pede administrador, e `--desfazer`
// apaga exatamente as mesmas chaves.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const executar = promisify(execFile);
const RAIZ = path.join(import.meta.dirname, '..');
const EXE = path.join(RAIZ, 'node_modules', 'electron', 'dist', 'Revisor.exe');
const ENTRADA = path.join(RAIZ, 'electron', 'main.mjs');
const ICONE = path.join(RAIZ, 'build', 'revisor.ico');

const PROGID = 'Revisor.Midia';
const APP = 'Revisor.exe';
const EXTS = [
  '.mp4', '.mov', '.mkv', '.m4v', '.webm', '.mts', '.m2ts', '.ts', '.avi', '.mxf',
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.ogg', '.opus',
];

// Sem o caminho do main.mjs: o `resources/app` que o `npm run exe` cria faz o
// executável achar o app sozinho. É o mesmo formato que o Windows monta quando
// você escolhe o .exe em "Abrir com", então os dois caminhos batem.
const COMANDO = `"${EXE}" "%1"`;
const ICONE_REG = `${ICONE},0`;

const HKCU = 'HKCU\\Software';
const APP_K = `${HKCU}\\Classes\\Applications\\${APP}`;
const PROG_K = `${HKCU}\\Classes\\${PROGID}`;
const CAP_K = `${HKCU}\\Revisor\\Capabilities`;
const fileExtK = (e) =>
  `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${e}\\OpenWithProgids`;

/** Cada entrada é [chave, nome|null, tipo, valor|null]. `null` no nome = valor padrão. */
function chaves() {
  const k = [];

  // O aplicativo em si: é daqui que o Explorador tira o nome e o ícone que
  // aparecem em "Abrir com" e no crachá da miniatura.
  k.push([APP_K, 'FriendlyAppName', 'REG_SZ', 'Revisor']);
  k.push([`${APP_K}\\DefaultIcon`, null, 'REG_SZ', ICONE_REG]);
  k.push([`${APP_K}\\shell\\open\\command`, null, 'REG_SZ', COMANDO]);
  for (const e of EXTS) k.push([`${APP_K}\\SupportedTypes`, e, 'REG_SZ', '']);

  // O tipo de arquivo "Mídia (Revisor)".
  k.push([PROG_K, null, 'REG_SZ', 'Mídia (Revisor)']);
  k.push([PROG_K, 'FriendlyTypeName', 'REG_SZ', 'Mídia (Revisor)']);
  k.push([`${PROG_K}\\DefaultIcon`, null, 'REG_SZ', ICONE_REG]);
  k.push([`${PROG_K}\\shell\\open\\command`, null, 'REG_SZ', COMANDO]);

  // Aparecer em Configurações › Aplicativos padrão.
  k.push([CAP_K, 'ApplicationName', 'REG_SZ', 'Revisor']);
  k.push([CAP_K, 'ApplicationDescription', 'REG_SZ',
    'Reprodutor de vídeo com várias faixas de áudio, marcações e transcrição']);
  k.push([CAP_K, 'ApplicationIcon', 'REG_SZ', ICONE_REG]);
  for (const e of EXTS) k.push([`${CAP_K}\\FileAssociations`, e, 'REG_SZ', PROGID]);
  k.push([`${HKCU}\\RegisteredApplications`, 'Revisor', 'REG_SZ',
    'Software\\Revisor\\Capabilities']);

  // Faz o Revisor aparecer na lista de "Abrir com" de cada extensão.
  for (const e of EXTS) k.push([fileExtK(e), PROGID, 'REG_NONE', null]);

  return k;
}

const RAIZES_A_APAGAR = [APP_K, PROG_K, `${HKCU}\\Revisor`];

function comandoDe([chave, nome, tipo, valor]) {
  const args = ['add', chave, '/f', '/t', tipo];
  if (nome) args.push('/v', nome); else args.push('/ve');
  if (valor !== null) args.push('/d', valor);
  return args;
}

const aspas = (a) => (/[ "%&]/.test(a) || a === '' ? `"${a}"` : a);

const modo = process.argv.includes('--aplicar') ? 'aplicar'
  : process.argv.includes('--desfazer') ? 'desfazer' : 'mostrar';

if (process.platform !== 'win32') {
  console.error('este script é do Windows');
  process.exit(1);
}

if (modo === 'desfazer') {
  for (const r of RAIZES_A_APAGAR) {
    try { await executar('reg', ['delete', r, '/f']); console.log(`apagado        ${r}`); }
    catch { console.log(`já não existia ${r}`); }
  }
  for (const e of EXTS) {
    try {
      await executar('reg', ['delete', fileExtK(e), '/v', PROGID, '/f']);
      console.log(`apagado        ${e} › ${PROGID}`);
    } catch { /* não estava lá */ }
  }
  try {
    await executar('reg', ['delete', `${HKCU}\\RegisteredApplications`, '/v', 'Revisor', '/f']);
    console.log(`apagado        RegisteredApplications › Revisor`);
  } catch { /* não estava lá */ }
  console.log('\npronto — o Windows volta ao que era. Se alguma extensão ainda abrir');
  console.log('no Revisor, troque em Configurações › Aplicativos padrão.');
  process.exit(0);
}

for (const [rotulo, alvo] of [['Revisor.exe', EXE], ['electron/main.mjs', ENTRADA], ['o ícone', ICONE]]) {
  if (!fs.existsSync(alvo)) {
    console.error(`não encontrei ${rotulo} em ${alvo}`);
    console.error(rotulo === 'Revisor.exe' ? 'rode `npm run exe` antes' : 'rode `npm install` / `npm run icone`');
    process.exit(1);
  }
}

const lista = chaves();

if (modo === 'mostrar') {
  console.log('PRÉVIA — nada foi escrito.\n');
  console.log(`${lista.length} valores, todos em HKCU (só o seu usuário, sem administrador):\n`);
  for (const c of lista) console.log(`  reg ${comandoDe(c).map(aspas).join(' ')}`);
  console.log('\naplicar:   node scripts/registrar-windows.mjs --aplicar');
  console.log('desfazer:  node scripts/registrar-windows.mjs --desfazer');
  process.exit(0);
}

let n = 0;
for (const c of lista) { await executar('reg', comandoDe(c)); n++; }
console.log(`${n} valores gravados.\n`);
console.log('Falta o único passo que nenhum programa pode dar por você:');
console.log('  Configurações › Aplicativos › Aplicativos padrão › Revisor');
console.log('  (ou: botão direito no arquivo › Abrir com › Escolher outro aplicativo)');
console.log('\ndesfazer tudo:  node scripts/registrar-windows.mjs --desfazer');
