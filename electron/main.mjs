// Casca do Electron: janela, diálogo nativo de arquivo, e o ciclo de vida do
// servidor. Nada de lógica de domínio aqui — o trabalho pesado vive no servidor
// Node, que roda como processo separado (assim ffmpeg e SQLite não dependem da
// versão do Electron).
//
// Ele SOBE o servidor sozinho: é o que permite um atalho na área de trabalho
// abrir o app com um clique, sem terminal aberto atrás.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, '..');
const PORTA_PREFERIDA = Number(process.env.REVISOR_PORT || 5273);
// Faixa de reserva quando a preferida está ocupada. Portas locais são território
// disputado — é comum ter outros servidores de projeto rodando na máquina, e o
// app não pode depender de um número fixo estar livre.
const PORTAS_RESERVA = Array.from({ length: 20 }, (_, i) => 5390 + i);

let janela = null;
let servidor = null;
// Compartilhado com o servidor: protege /media/direto, que e o que permite
// comecar a tocar antes do arquivo estar registrado.
const TOKEN = crypto.randomUUID();
let arquivoPendente = null;
let base = `http://127.0.0.1:${PORTA_PREFERIDA}`;
const ui = process.env.REVISOR_UI || null;

app.setName('Revisor');

// Sem isto o vídeo não reproduz.
//
// O Chromium tem uma detecção de oclusão nativa no Windows que dá falso positivo:
// a janela está em primeiro plano e não minimizada (o Windows confirma), mas a
// página passa a reportar `visibilityState: "hidden"`. E como o proxy é de vídeo
// puro, sem faixa de áudio, o Chrome o classifica como silencioso e suspende a
// reprodução de mídia "invisível" — o vídeo congela em frações de segundo
// enquanto as faixas de áudio, essas audíveis, seguem tocando.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// No Windows o Electron roda no subsistema gráfico: nada que ele escreva em
// stdout/stderr chega ao terminal. Sem um log em arquivo, um atalho que não abre
// é uma tela preta sem explicação nenhuma.
const ARQUIVO_LOG = path.join(app.getPath('userData'), 'inicio.log');
function registrar(...partes) {
  const linha = `${new Date().toISOString()} ${partes.join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(ARQUIVO_LOG), { recursive: true });
    fs.appendFileSync(ARQUIVO_LOG, linha);
  } catch { /* sem log é melhor que travar o arranque */ }
}

process.on('uncaughtException', (e) => registrar('EXCEÇÃO', e?.stack || e));
process.on('unhandledRejection', (e) => registrar('REJEIÇÃO', e?.stack || e));

const EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.mxf', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts',
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.ogg', '.opus',
]);

/**
 * Extrai um caminho de mídia da linha de comando.
 *
 * É o que faz o "Abrir com" funcionar: o Windows passa o arquivo como argumento.
 * Os argumentos do próprio Electron (flags, o caminho do main.mjs) vêm junto,
 * então filtra por extensão e por existir em disco.
 */
function arquivoDosArgumentos(argv) {
  const ehMidia = (p) => {
    if (!EXTS.has(path.extname(p).toLowerCase())) return false;
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };

  const soltos = argv.slice(1).filter((a) => !a.startsWith('-'));
  for (const a of soltos) if (ehMidia(a)) return path.resolve(a);

  // Caminho com espaço que chegou SEM aspas vem picado em vários argumentos
  // ("D:\Meus" + "vídeos\a.mp4"). O Explorer cita certo, mas um atalho editado à
  // mão ou um script não necessariamente — e pasta de vídeo quase sempre tem
  // espaço no nome. Tenta remontar as sequências antes de desistir.
  for (let i = 0; i < soltos.length; i++) {
    for (let j = soltos.length; j > i + 1; j--) {
      const junto = soltos.slice(i, j).join(' ');
      if (ehMidia(junto)) return path.resolve(junto);
    }
  }
  return null;
}

function abrirNaJanela(arquivo) {
  if (!arquivo) return;
  arquivoPendente = arquivo;
  if (janela && !janela.webContents.isLoading()) {
    janela.webContents.send('abrir-arquivo', arquivo);
    if (janela.isMinimized()) janela.restore();
    janela.focus();
  }
}

/**
 * Confere se quem responde nessa porta é o NOSSO servidor.
 *
 * Checar só "respondeu 200" não basta: qualquer outro projeto rodando um Express
 * local na mesma porta passaria no teste, e o app abriria mostrando a página de
 * outra aplicação. Por isso o /api/health assina com `app: 'revisor'`.
 */
function ehNossoServidor(porta) {
  return new Promise((resolve) => {
    // `node:http` e não `fetch`: no processo principal do Electron o fetch global
    // é o do Chromium, que passa pela pilha de rede dele (proxy, sessão) e não
    // chega em 127.0.0.1 de forma confiável. Isso custou uma tela de erro com o
    // servidor funcionando perfeitamente do lado de fora.
    const req = http.get({
      host: '127.0.0.1', port: porta, path: '/api/health', timeout: 1200,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(corpo);
          // Confere tambem a porta: se outro processo responder por esta porta,
          // o numero que ele reporta nao bate com o que pedimos.
          resolve(j?.app === 'revisor' && Number(j?.porta) === Number(porta));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * A porta está livre — pra QUALQUER endereço?
 *
 * O teste vincula o curinga, não `127.0.0.1`, e a diferença não é detalhe: no
 * Windows, vincular `127.0.0.1:P` funciona mesmo com outro processo já em `::P`.
 * Testando só o loopback, uma porta ocupada parecia livre, dois servidores
 * passavam a atender o mesmo número, e qual dos dois responde a cada conexão
 * fica a critério do sistema. Aqui uma porta só conta como livre se ninguém a
 * estiver usando de forma nenhuma.
 */
function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(porta);   // sem host = curinga
  });
}

async function escolherPorta() {
  for (const p of [PORTA_PREFERIDA, ...PORTAS_RESERVA]) {
    if (await portaLivre(p)) return p;
  }
  throw new Error('não encontrei nenhuma porta livre entre '
    + `${PORTA_PREFERIDA} e ${PORTAS_RESERVA.at(-1)}`);
}

/**
 * Acha um Node capaz de rodar o servidor.
 *
 * NÃO dá pra usar o Node embutido no Electron: o Electron 33 traz Node 20, e o
 * servidor depende do `node:sqlite`, que só existe a partir do 22.5. Rodar no
 * Node do sistema também é o que mantém a promessa original — ffmpeg e SQLite
 * sem recompilação a cada atualização do Electron.
 */
const MIN_NODE = [22, 5];

function versaoOk(saida) {
  const m = /v(\d+)\.(\d+)\./.exec(String(saida).trim());
  if (!m) return false;
  const [maior, menor] = [Number(m[1]), Number(m[2])];
  return maior > MIN_NODE[0] || (maior === MIN_NODE[0] && menor >= MIN_NODE[1]);
}

function versaoDe(exe, env) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['-v'], { windowsHide: true, env: { ...process.env, ...env } });
    let saida = '';
    p.stdout.on('data', (d) => { saida += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(saida.trim() || null));
  });
}

async function acharNode() {
  const candidatos = [
    process.env.REVISOR_NODE,
    'node',
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ].filter(Boolean);

  for (const exe of candidatos) {
    const v = await versaoDe(exe);
    if (v && versaoOk(v)) return { exe, versao: v, env: {} };
  }
  // Último recurso: o Node de dentro do Electron, se um dia ele for novo o bastante.
  const vEmbutido = await versaoDe(process.execPath, { ELECTRON_RUN_AS_NODE: '1' });
  if (vEmbutido && versaoOk(vEmbutido)) {
    return { exe: process.execPath, versao: vEmbutido, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  throw new Error(
    `o Revisor precisa do Node ${MIN_NODE.join('.')} ou mais novo (por causa do SQLite embutido).\n\n`
    + `Encontrado: ${vEmbutido || 'nada'}.\n`
    + 'Instale em https://nodejs.org, ou aponte o caminho na variável REVISOR_NODE.');
}

async function garantirServidor() {
  // Um Revisor já de pé (por exemplo `npm run server` numa aba do terminal) é
  // reaproveitado; qualquer outra coisa na porta é ignorada e desviamos.
  if (await ehNossoServidor(PORTA_PREFERIDA)) {
    base = `http://127.0.0.1:${PORTA_PREFERIDA}`;
    return 'externo';
  }

  const porta = await escolherPorta();
  base = `http://127.0.0.1:${porta}`;
  if (porta !== PORTA_PREFERIDA) {
    registrar(`porta ${PORTA_PREFERIDA} ocupada por outro programa; usando ${porta}`);
  }

  const node = await acharNode();

  const arquivoLog = path.join(app.getPath('userData'), 'servidor.log');
  fs.mkdirSync(path.dirname(arquivoLog), { recursive: true });
  const log = fs.createWriteStream(arquivoLog, { flags: 'a' });
  log.write(`\n=== ${new Date().toISOString()} — porta ${porta}, ${node.exe} ${node.versao} ===\n`);

  servidor = spawn(node.exe, [path.join(RAIZ, 'server', 'index.mjs')], {
    cwd: RAIZ,
    windowsHide: true,
    env: { ...process.env, ...node.env, REVISOR_PORT: String(porta), REVISOR_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.pipe(log);
  servidor.stderr.pipe(log);
  servidor.on('exit', (code) => {
    servidor = null;
    if (code && code !== 0 && janela) {
      dialog.showErrorBox('O servidor do Revisor parou',
        `Código ${code}. O log está em:\n${arquivoLog}`);
    }
  });

  // Espera responder — até ~15 s, que cobre disco lento e primeiro arranque.
  for (let i = 0; i < 60; i++) {
    if (await ehNossoServidor(porta)) return 'proprio';
    if (!servidor) throw new Error(`o servidor parou ao iniciar. Log em:\n${arquivoLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`o servidor não respondeu a tempo. Log em:\n${arquivoLog}`);
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1600,
    height: 950,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(RAIZ, 'build', 'revisor.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // A timeline desenha por requestAnimationFrame e o player corrige deriva de
      // áudio por timer; com o estrangulamento de segundo plano ligado, os dois
      // caem para ~1 Hz assim que a janela perde o foco e a agulha "pula".
      backgroundThrottling: false,
    },
  });
  janela.once('ready-to-show', () => janela.show());
  // Em desenvolvimento (`npm run dev`) a UI vem do Vite via REVISOR_UI; em uso
  // normal vem do dist/ servido pelo próprio servidor, na porta que ele pegou.
  janela.loadURL(ui || base);
  janela.webContents.on('did-fail-load', (_e, codigo, descricao, url) => {
    registrar('falha ao carregar', url, codigo, descricao);
  });
  janela.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  janela.on('closed', () => { janela = null; });
}

ipcMain.handle('sessao', () => ({ token: TOKEN, base, arquivoInicial: arquivoPendente }));

ipcMain.handle('escolher-pasta', async () => {
  const r = await dialog.showOpenDialog(janela, {
    title: 'Escolher pasta de mídia',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('escolher-arquivo', async () => {
  const r = await dialog.showOpenDialog(janela, {
    title: 'Escolher gravação',
    properties: ['openFile'],
    filters: [
      { name: 'Vídeo', extensions: ['mp4', 'mov', 'mkv', 'mxf', 'avi', 'm4v', 'webm', 'mts', 'm2ts', 'ts'] },
      { name: 'Áudio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'aiff', 'aif', 'ogg', 'opus'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Só uma janela: clicar no atalho de novo traz a que já está aberta.
registrar('arranque; execPath =', process.execPath);

if (!app.requestSingleInstanceLock()) {
  registrar('outra instância já está aberta — encerrando esta');
  app.quit();
} else {
  // Clicar num segundo video nao abre um segundo Revisor: o arquivo vai pra
  // janela que ja esta aberta, como qualquer reprodutor faz.
  app.on('second-instance', (_ev, argv) => {
    const arquivo = arquivoDosArgumentos(argv);
    if (janela) {
      if (janela.isMinimized()) janela.restore();
      janela.focus();
    }
    abrirNaJanela(arquivo);
  });

  app.whenReady().then(async () => {
    try {
      registrar('electron pronto');
      registrar('argv:', JSON.stringify(process.argv));
      arquivoPendente = arquivoDosArgumentos(process.argv);
      registrar('arquivo da linha de comando:', arquivoPendente ?? '(nenhum)');
      const modo = await garantirServidor();
      registrar('servidor', modo, 'em', base);
      criarJanela();
      registrar('janela criada, carregando', ui || base);
    } catch (err) {
      registrar('FALHA NO ARRANQUE:', err?.stack || err);
      dialog.showErrorBox('Não consegui iniciar o Revisor',
        `${String(err.message || err)}

Detalhes em:
${ARQUIVO_LOG}`);
      app.quit();
    }
  });
}

// Derruba o servidor junto — mas só se fomos nós que o subimos.
app.on('before-quit', () => { servidor?.kill(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
