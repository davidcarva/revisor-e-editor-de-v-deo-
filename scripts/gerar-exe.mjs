// Cria o Revisor.exe: o executável do app, com o ícone do app.
//
//   npm run exe
//
// O Windows tira o ícone que mostra no Explorador — no "Abrir com", no crachá
// da miniatura, na barra de tarefas — do EXECUTÁVEL associado. Enquanto isso
// fosse o electron.exe do node_modules, todo arquivo de vídeo aparecia com o
// átomo do Electron no canto.
//
// O Electron não liga pro nome do próprio executável: uma cópia renomeada ao
// lado do original acha o `resources/` do mesmo jeito. Então em vez de empacotar
// o app inteiro (e ter que reempacotar a cada mudança no código), aqui é só uma
// cópia com o ícone trocado — o código continua sendo lido direto da pasta do
// projeto.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const executar = promisify(execFile);
const RAIZ = path.join(import.meta.dirname, '..');
const DIST_ELECTRON = path.join(RAIZ, 'node_modules', 'electron', 'dist');
const ORIGEM = path.join(DIST_ELECTRON, 'electron.exe');
export const EXE = path.join(DIST_ELECTRON, 'Revisor.exe');
const ICONE = path.join(RAIZ, 'build', 'revisor.ico');
const RCEDIT = path.join(RAIZ, 'node_modules', 'rcedit', 'bin',
  process.arch === 'arm64' ? 'rcedit.exe' : 'rcedit-x64.exe');

const { version } = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
// O Windows quer quatro números; o package.json tem três.
const versaoWin = `${version}.0`;

export async function gerarExe({ silencioso = false } = {}) {
  const log = silencioso ? () => {} : console.log;
  if (process.platform !== 'win32') throw new Error('este script é do Windows');
  for (const [rotulo, alvo] of [['electron.exe', ORIGEM], ['rcedit', RCEDIT]]) {
    if (!fs.existsSync(alvo)) throw new Error(`não encontrei ${rotulo} em ${alvo} — rode \`npm install\``);
  }
  if (!fs.existsSync(ICONE)) {
    log('sem ícone; gerando…');
    await import('./gerar-icone.mjs');
  }

  // Copiar por cima de um Revisor.exe em execução falha com EBUSY. Fechar o app
  // é problema de quem roda o script, mas o erro precisa dizer isso.
  try {
    fs.copyFileSync(ORIGEM, EXE);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      throw new Error('Revisor.exe está aberto — feche o app e rode de novo');
    }
    throw e;
  }

  await executar(RCEDIT, [
    EXE,
    '--set-icon', ICONE,
    '--set-version-string', 'FileDescription', 'Revisor',
    '--set-version-string', 'ProductName', 'Revisor',
    '--set-version-string', 'InternalName', 'Revisor',
    '--set-version-string', 'OriginalFilename', 'Revisor.exe',
    '--set-version-string', 'CompanyName', 'Revisor',
    '--set-version-string', 'LegalCopyright', '',
    '--set-file-version', versaoWin,
    '--set-product-version', versaoWin,
  ]);

  log(`Revisor.exe pronto em ${EXE}`);
  return EXE;
}

if (import.meta.filename === process.argv[1]) {
  gerarExe().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
