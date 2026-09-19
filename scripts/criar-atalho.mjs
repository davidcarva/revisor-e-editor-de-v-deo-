// Cria os atalhos do Revisor na Área de Trabalho e no Menu Iniciar.
//
//   npm run atalho
//
// O atalho aponta direto pro electron.exe — não pra um .bat — então abre como
// aplicativo, sem janela de terminal atrás. O Electron sobe o servidor sozinho.
// Rode de novo se você mover a pasta do projeto: os caminhos são gravados no .lnk.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const executar = promisify(execFile);
const RAIZ = path.join(import.meta.dirname, '..');
const ELECTRON = path.join(RAIZ, 'node_modules', 'electron', 'dist', 'electron.exe');
const ENTRADA = path.join(RAIZ, 'electron', 'main.mjs');
const ICONE = path.join(RAIZ, 'build', 'revisor.ico');

if (process.platform !== 'win32') {
  console.error('este script é do Windows');
  process.exit(1);
}
for (const [rotulo, alvo] of [['electron.exe', ELECTRON], ['electron/main.mjs', ENTRADA]]) {
  if (!fs.existsSync(alvo)) {
    console.error(`não encontrei ${rotulo} em ${alvo}\nrode \`npm install\` primeiro`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(RAIZ, 'dist', 'index.html'))) {
  console.error('não existe dist/ — rode `npm run build` antes, senão o atalho abre em branco');
  process.exit(1);
}
if (!fs.existsSync(ICONE)) {
  console.log('sem ícone; gerando…');
  await import('./gerar-icone.mjs');
}

// Aspas simples do PowerShell escapam duplicando; caminhos com apóstrofo existem.
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$destinos = @(
  [System.Environment]::GetFolderPath('Desktop'),
  (Join-Path ([System.Environment]::GetFolderPath('StartMenu')) 'Programs'),
  ${ps(RAIZ)}
)
foreach ($d in $destinos) {
  if (-not (Test-Path $d)) { continue }
  $lnk = $shell.CreateShortcut((Join-Path $d 'Revisor.lnk'))
  $lnk.TargetPath       = ${ps(ELECTRON)}
  $lnk.Arguments        = '"' + ${ps(ENTRADA)} + '"'
  $lnk.WorkingDirectory = ${ps(RAIZ)}
  $lnk.IconLocation     = ${ps(ICONE)} + ',0'
  $lnk.Description      = 'Revisor — revisão de vídeo longo e ponte com o Premiere'
  $lnk.WindowStyle      = 1
  $lnk.Save()
  Write-Output (Join-Path $d 'Revisor.lnk')
}
`;

const { stdout } = await executar('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', script]);

console.log('atalhos criados:');
for (const linha of stdout.trim().split(/\r?\n/)) console.log(`  ${linha}`);
console.log('\nse mover a pasta do projeto, rode `npm run atalho` de novo.');
