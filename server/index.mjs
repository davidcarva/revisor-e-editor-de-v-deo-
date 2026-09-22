// Servidor local. Escuta so em 127.0.0.1 — nada disso vai pra rede.
//
// Ele existe separado do Electron de proposito: rodando no Node do sistema, o
// SQLite embutido e o ffmpeg funcionam sem recompilacao nativa, e a mesma UI abre
// tanto no app quanto no navegador (o que torna depurar muito mais facil).
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as db from './db.mjs';
import * as ingest from './ingest.mjs';
import { readWindow } from './peaks.mjs';
import { proximoInicio } from './segmentos.mjs';
import * as transcricao from './transcricao.mjs';
import * as biblioteca from './biblioteca.mjs';
import { buildFcp7Xml, buildMarkerCsv } from './premiere-xml.mjs';

const PORT = Number(process.env.REVISOR_PORT || 5273);
// Token de sessao: protege /media/direto, que serve qualquer arquivo do disco.
// Vem do ambiente quando o Electron sobe o servidor, senao e sorteado aqui.
const TOKEN = process.env.REVISOR_TOKEN || crypto.randomUUID();
const HOME = process.env.REVISOR_HOME || path.join(os.homedir(), 'Revisor');
const EXTS_MIDIA = new Set([
  '.mp4', '.mov', '.mkv', '.mxf', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts',
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.ogg', '.opus',
]);

fs.mkdirSync(HOME, { recursive: true });
db.open(path.join(HOME, 'projeto.revdb'));
ingest.setCacheRoot(path.join(HOME, 'cache'));
biblioteca.setRaizPosters(path.join(HOME, 'cache'));

const interrompidas = db.limparTranscricoesInterrompidas();
if (interrompidas) {
  console.log(`revisor: ${interrompidas} faixa(s) presa(s) em transcricao foram liberadas`);
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '4mb' }));

// Nada de /api pode ser guardado em cache.
//
// Sem este cabecalho o Chromium aplica cache heuristico nas respostas JSON e passa
// a servir copias velhas: o acervo mostrava as faixas como nao-transcritas ("nao")
// enquanto /api/sources/:id, no MESMO servidor e no mesmo instante, respondia
// "pronta". Toda a API aqui e estado vivo — marcadores, progresso, status — e
// nenhuma resposta dela pode sobreviver a propria requisicao.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

/** Envolve handler async pra um throw virar 500 com mensagem, e nao processo morto. */
const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err);
  if (!res.headersSent) res.status(500).json({ erro: String(err.message || err) });
});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function exigirFonte(req) {
  const src = db.getSource(Number(req.params.id));
  if (!src) { const e = new Error('fonte nao encontrada'); e.status = 404; throw e; }
  return src;
}

// ------------------------------------------------------------------ estado

// `app: 'revisor'` nao e enfeite: e como o Electron confere que a porta e NOSSA
// antes de reaproveitar um servidor ja de pe. Sem essa assinatura ele acabaria
// se ligando a qualquer outro servidor local que respondesse 200 nessa porta.
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'revisor', porta: PORT, token: TOKEN,
  home: HOME, banco: db.dbPath(), cache: ingest.cacheRoot(),
}));

app.get('/api/sources', rota((req, res) => {
  const lista = db.listSources().map((s) => ({ ...s, tracks: db.listTracks(s.id) }));
  res.json(lista);
}));

app.get('/api/sources/:id', rota((req, res) => {
  const src = exigirFonte(req);
  res.json({
    ...src,
    tracks: db.listTracks(src.id),
    processando: ingest.isRunning(src.id),
    thumbs: lerThumbs(src),
  });
}));

function lerThumbs(src) {
  if (!src.thumbs_path || !fs.existsSync(src.thumbs_path)) return null;
  try { return JSON.parse(fs.readFileSync(src.thumbs_path, 'utf8')); } catch { return null; }
}

app.post('/api/sources', rota(async (req, res) => {
  const alvo = String(req.body?.path || '').trim();
  if (!alvo) return res.status(400).json({ erro: 'informe o caminho do arquivo' });
  const { sourceId } = await ingest.register(alvo);
  ingest.start(sourceId);
  res.json({ ...db.getSource(sourceId), tracks: db.listTracks(sourceId) });
}));

/**
 * Modo assistir: registra o arquivo e devolve na hora, sem gerar proxy.
 *
 * A reproducao usa o arquivo ORIGINAL — o Chromium toca H.264, HEVC, VP9, MKV e
 * WebM direto. So a passada de audio roda em segundo plano, porque e ela que
 * destrava o mixer de faixas.
 */
app.post('/api/assistir', rota(async (req, res) => {
  const alvo = String(req.body?.path || '').trim();
  if (!alvo) return res.status(400).json({ erro: 'informe o caminho do arquivo' });

  const { sourceId, info } = await ingest.register(alvo);
  db.marcarVisto(path.resolve(alvo));
  const varias = info.audioStreams.length > 1;
  // Uma faixa so nao precisa de mixer: o proprio <video> ja toca ela.
  if (varias) ingest.start(sourceId, { comVideo: false });
  else db.setSourceStatus(sourceId, { status: 'pronto', progress: 1, stage: null });

  res.json({
    ...db.getSource(sourceId),
    tracks: db.listTracks(sourceId),
    extraindoAudio: varias,
  });
}));

/** Promove para revisao: gera o que faltou (proxy, miniaturas). */
app.post('/api/sources/:id/revisar', rota((req, res) => {
  const src = exigirFonte(req);
  ingest.start(src.id, { comVideo: true });
  res.json({ ok: true });
}));

app.post('/api/sources/:id/reingest', rota((req, res) => {
  const src = exigirFonte(req);
  ingest.cancel(src.id);
  ingest.start(src.id, { force: !!req.body?.force });
  res.json({ ok: true });
}));

app.post('/api/sources/:id/cancel', rota((req, res) => {
  ingest.cancel(exigirFonte(req).id);
  res.json({ ok: true });
}));

app.delete('/api/sources/:id', rota(async (req, res) => {
  const src = exigirFonte(req);
  ingest.cancel(src.id);
  db.deleteSource(src.id);
  if (req.query.cache === '1') {
    await fsp.rm(path.join(ingest.cacheRoot(), String(src.id)), { recursive: true, force: true });
  }
  res.json({ ok: true });
}));

// SSE de progresso: a UI acompanha o ingest sem ficar batendo de 1 em 1 segundo.
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  const envia = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // O progresso da transcricao vai pelo MESMO canal, marcado com `tipo` pra a
  // interface saber qual dos dois chegou.
  const enviaTransc = (ev) => envia({ ...ev, tipo: 'transcricao' });
  ingest.events.on('progress', envia);
  transcricao.events.on('transcricao', enviaTransc);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    ingest.events.off('progress', envia);
    transcricao.events.off('transcricao', enviaTransc);
  });
});

// ------------------------------------------------------------------ midia

/** sendFile ja resolve Range/206, que e o que faz o seek do <video> funcionar. */
function servirArquivo(res, file, tipo) {
  if (!file || !fs.existsSync(file)) return res.status(404).json({ erro: 'arquivo ausente' });
  if (tipo) res.type(tipo);
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(path.resolve(file));
}

/**
 * Stream direto de um arquivo do disco, sem passar pelo registro.
 *
 * E o que faz o vídeo comecar a tocar no instante em que a janela abre: o
 * ffprobe e o registro no banco levam mais de um segundo num arquivo grande, e
 * esperar por eles seria um segundo de tela preta a cada duplo clique.
 *
 * Exige o token gerado no arranque. Sem ele, qualquer processo local poderia
 * pedir qualquer arquivo do disco a este servidor.
 */
app.get('/media/direto', rota((req, res) => {
  if (req.query.token !== TOKEN) return res.status(403).json({ erro: 'token invalido' });
  const alvo = String(req.query.p || '');
  if (!alvo) return res.status(400).json({ erro: 'informe p=' });
  const abs = path.resolve(alvo);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ erro: 'arquivo nao encontrado' });
  }
  if (!EXTS_MIDIA.has(path.extname(abs).toLowerCase())) {
    return res.status(415).json({ erro: 'extensao nao suportada' });
  }
  servirArquivo(res, abs);
}));

app.get('/media/:id/proxy', rota((req, res) => {
  const src = exigirFonte(req);
  // Enquanto o proxy nao fica pronto, cai no arquivo original: da pra comecar a
  // trabalhar num arquivo de 10h antes do ingest terminar.
  const f = src.proxy_path && fs.existsSync(src.proxy_path) ? src.proxy_path : src.path;
  servirArquivo(res, f, 'video/mp4');
}));

app.get('/media/:id/original', rota((req, res) => servirArquivo(res, exigirFonte(req).path)));

app.get('/media/:id/thumbs.json', rota((req, res) => {
  const t = lerThumbs(exigirFonte(req));
  if (!t) return res.status(404).json({ erro: 'miniaturas ainda nao geradas' });
  res.json(t);
}));

app.get('/media/:id/thumbs/:sheet', rota((req, res) => {
  const src = exigirFonte(req);
  const nome = path.basename(String(req.params.sheet));
  if (!/^sheet_\d+\.jpg$/.test(nome)) return res.status(400).json({ erro: 'nome invalido' });
  servirArquivo(res, path.join(ingest.cacheRoot(), String(src.id), 'thumbs', nome), 'image/jpeg');
}));

app.get('/media/track/:tid/audio', rota((req, res) => {
  const t = db.handle().prepare('SELECT * FROM tracks WHERE id=?').get(Number(req.params.tid));
  if (!t) return res.status(404).json({ erro: 'faixa nao encontrada' });
  servirArquivo(res, t.audio_path, 'audio/mp4');
}));

// ------------------------------------------------------------------ faixas

app.patch('/api/tracks/:id', rota((req, res) => {
  const t = db.updateTrack(Number(req.params.id), req.body || {});
  if (!t) return res.status(404).json({ erro: 'faixa nao encontrada' });
  res.json(t);
}));

/**
 * Picos ja reduzidos a exatamente `width` colunas. O cliente nao faz conta nem
 * baixa a onda inteira — recebe ~2*width bytes e so desenha.
 */
app.get('/api/tracks/:id/peaks', rota(async (req, res) => {
  const t = db.handle().prepare('SELECT * FROM tracks WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ erro: 'faixa nao encontrada' });
  if (!t.peaks_path || !fs.existsSync(t.peaks_path)) {
    return res.status(409).json({ erro: 'picos ainda nao gerados' });
  }
  const from = num(req.query.from) ?? 0;
  const to = num(req.query.to) ?? from + 1;
  const width = Math.max(1, Math.min(8000, Math.round(num(req.query.width) ?? 1000)));
  if (!(to > from)) return res.status(400).json({ erro: 'janela invalida' });

  const { data, secondsPerPeak } = await readWindow(t.peaks_path, from, to, width);
  res.setHeader('Content-Type', 'application/octet-stream');
  // Sem cache aqui tambem: reprocessar o arquivo regrava o .pks, e uma onda
  // guardada do arquivo antigo seria desenhada por cima do novo.
  res.setHeader('X-Seconds-Per-Peak', String(secondsPerPeak));
  res.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}));

/**
 * Próximo/anterior trecho com som, para o pulo por Ctrl+←/Ctrl+→.
 * Só entram as faixas marcadas com `nav` — é assim que você escolhe pular pelas
 * falas de uma pessoa específica e ignorar o resto.
 */
app.get('/api/sources/:id/segmento', rota(async (req, res) => {
  const src = exigirFonte(req);
  const dir = Number(req.query.dir) < 0 ? -1 : 1;
  const de = num(req.query.de) ?? 0;

  const faixas = db.listTracks(src.id).filter((t) => t.kind === 'audio' && t.nav && t.peaks_path);
  const caminhos = faixas.filter((t) => fs.existsSync(t.peaks_path)).map((t) => t.peaks_path);
  if (!caminhos.length) {
    return res.status(409).json({ erro: 'nenhuma faixa marcada para navegação (botão A)' });
  }
  res.json({ t: await proximoInicio(caminhos, de, dir), faixas: faixas.length });
}));

// ------------------------------------------------------------ biblioteca

app.get('/api/biblioteca', rota((req, res) => {
  const pasta = String(req.query.pasta || '');
  // Buscar é sempre recursivo: procurar um nome e não achar porque o arquivo
  // está uma pasta abaixo seria uma armadilha.
  const q = String(req.query.q || '');
  const recursivo = q ? true : req.query.recursivo !== '0';

  res.json({
    itens: db.listarMidia({
      q,
      pasta,
      recursivo,
      ordem: String(req.query.ordem || 'modificado'),
      filtro: String(req.query.filtro || ''),
      limite: Math.min(400, Number(req.query.limite) || 120),
      offset: Number(req.query.offset) || 0,
    }),
    // Só faz sentido listar subpastas quando se está dentro de uma pasta.
    ...(pasta ? db.subpastasDe(pasta, path.sep) : { subpastas: [], diretos: 0 }),
    contagem: db.contarMidia(),
    formatos: db.formatosExistentes(),
    pastas: db.listarPastas(),
  });
}));

app.post('/api/biblioteca/pastas', rota(async (req, res) => {
  const alvo = String(req.body?.caminho || '').trim();
  if (!alvo) return res.status(400).json({ erro: 'informe a pasta' });
  const abs = path.resolve(alvo);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return res.status(400).json({ erro: 'não é uma pasta' });
  }
  db.adicionarPasta(abs);
  const achados = await biblioteca.varrer(abs);
  res.json({ ok: true, pasta: abs, achados });
}));

app.delete('/api/biblioteca/pastas', rota((req, res) => {
  const alvo = String(req.query.caminho || '');
  if (!alvo) return res.status(400).json({ erro: 'informe a pasta' });
  db.removerPasta(path.resolve(alvo));
  res.json({ ok: true });
}));

/** Revarre tudo: pega arquivo novo, some com o que foi apagado. */
app.post('/api/biblioteca/varrer', rota(async (req, res) => {
  let total = 0;
  for (const p of db.listarPastas()) {
    try { total += await biblioteca.varrer(p.caminho); } catch { /* pasta sumiu */ }
  }
  res.json({ ok: true, total });
}));

// ------------------------------------------- organizar (mexe em disco)
//
// Tudo aqui é em duas etapas: primeiro um PLANO, que não toca em nada e mostra
// o antes/depois, e só depois a aplicação. E todo lote aplicado fica no
// histórico, pra poder voltar atrás.

app.post('/api/biblioteca/plano/mover', rota((req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  const destino = String(req.body?.destino || '');
  if (!ids.length || !destino) return res.status(400).json({ erro: 'informe ids e destino' });
  res.json({ passos: biblioteca.planejarMover(ids, destino) });
}));

app.post('/api/biblioteca/plano/renomear', rota((req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  const padrao = String(req.body?.padrao || '');
  if (!ids.length || !padrao) return res.status(400).json({ erro: 'informe ids e padrão' });
  res.json({ passos: biblioteca.planejarRenomear(ids, padrao, { inicio: Number(req.body?.inicio) || 1 }) });
}));

app.post('/api/biblioteca/aplicar', rota(async (req, res) => {
  const tipo = String(req.body?.tipo || '');
  const passos = req.body?.passos || [];
  if (!['mover', 'renomear'].includes(tipo)) return res.status(400).json({ erro: 'tipo inválido' });
  if (!Array.isArray(passos) || !passos.length) return res.status(400).json({ erro: 'nada a aplicar' });
  res.json(await biblioteca.aplicarLote(tipo, passos));
}));

app.post('/api/biblioteca/desfazer', rota(async (req, res) => {
  res.json(await biblioteca.desfazerUltimo());
}));

app.get('/api/biblioteca/desfazer', rota((req, res) => {
  const op = db.ultimaOperacao();
  res.json({ pode: !!op, tipo: op?.tipo ?? null, quantos: op ? JSON.parse(op.passos).length : 0 });
}));

app.post('/api/biblioteca/nova-pasta', rota(async (req, res) => {
  const pai = String(req.body?.pai || '');
  const nome = String(req.body?.nome || '');
  if (!pai || !nome.trim()) return res.status(400).json({ erro: 'informe pai e nome' });
  res.json({ ok: true, pasta: await biblioteca.criarPasta(pai, nome) });
}));

app.patch('/api/biblioteca/:id/marca', rota((req, res) => {
  const campo = String(req.body?.campo || '');
  const m = db.setSinalizador(Number(req.params.id), campo, !!req.body?.valor);
  if (!m) return res.status(404).json({ erro: 'não encontrado' });
  res.json(m);
}));

/** Metadados sob demanda — o cartão pede quando entra na tela. */
app.get('/api/biblioteca/:id/info', rota(async (req, res) => {
  const m = await biblioteca.sondar(Number(req.params.id));
  if (!m) return res.status(404).json({ erro: 'não encontrado' });
  res.json(m);
}));

/** Miniatura; gera na primeira vez que alguém pede. */
app.get('/api/biblioteca/:id/poster', rota(async (req, res) => {
  let arquivo = null;
  try {
    arquivo = await biblioteca.poster(Number(req.params.id));
  } catch {
    // Arquivo vazio, truncado ou com codec que o ffmpeg não abre: não ter
    // miniatura é um fato sobre o arquivo, não uma falha do servidor. O cartão
    // cai no ícone e a vida segue — e o log não vira uma pilha de stack traces.
    arquivo = null;
  }
  if (!arquivo) return res.status(404).json({ erro: 'sem miniatura' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  servirArquivo(res, arquivo, 'image/jpeg');
}));

// ------------------------------------------------------------ transcricao

app.get('/api/transcricao/status', rota((req, res) => res.json({
  disponivel: transcricao.disponivel(),
  python: transcricao.pythonDoProjeto(),
})));

app.post('/api/sources/:id/transcrever', rota((req, res) => {
  const src = exigirFonte(req);
  transcricao.iniciar(src.id, {
    modelo: req.body?.modelo,
    idioma: req.body?.idioma,
    refazer: !!req.body?.refazer,
  });
  res.json({ ok: true, tracks: db.listTracks(src.id) });
}));

app.post('/api/sources/:id/transcrever/cancelar', rota((req, res) => {
  transcricao.cancelar(exigirFonte(req).id);
  res.json({ ok: true });
}));

/** Trechos visíveis na janela atual da timeline, de todas as faixas. */
app.get('/api/sources/:id/transcricao', rota((req, res) => {
  const src = exigirFonte(req);
  const de = num(req.query.de) ?? 0;
  const ate = num(req.query.ate) ?? src.duration_s;
  res.json({
    total: db.contarTranscricao(src.id),
    trechos: db.trechosNaJanela(src.id, de, ate),
  });
}));

app.get('/api/sources/:id/transcricao/busca', rota((req, res) => {
  const src = exigirFonte(req);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ trechos: [] });
  // Aspas ao redor: o FTS5 trata a consulta como frase literal, então digitar
  // um "-" ou "*" no campo de busca não vira sintaxe nem erro.
  try {
    res.json({ trechos: db.buscarTranscricao(src.id, `"${q.replace(/"/g, '""')}"`) });
  } catch (e) {
    res.status(400).json({ erro: String(e.message || e) });
  }
}));

app.get('/api/transcricao/:id/palavras', rota((req, res) => {
  const linha = db.palavrasDoTrecho(Number(req.params.id));
  if (!linha) return res.status(404).json({ erro: 'trecho não encontrado' });
  res.json({ palavras: linha.palavras ? JSON.parse(linha.palavras) : [] });
}));

// -------------------------------------------------------------- marcadores

app.get('/api/sources/:id/markers', rota((req, res) =>
  res.json(db.listMarkers(exigirFonte(req).id))));

app.post('/api/sources/:id/markers', rota((req, res) => {
  const src = exigirFonte(req);
  const t_in = num(req.body?.t_in);
  if (t_in == null) return res.status(400).json({ erro: 't_in obrigatorio' });
  res.json(db.addMarker({ ...req.body, source_id: src.id, t_in }));
}));

app.patch('/api/markers/:id', rota((req, res) => {
  const m = db.updateMarker(Number(req.params.id), req.body || {});
  if (!m) return res.status(404).json({ erro: 'marcador nao encontrado' });
  res.json(m);
}));

app.delete('/api/markers/:id', rota((req, res) => {
  db.deleteMarker(Number(req.params.id));
  res.json({ ok: true });
}));

// -------------------------------------------------------------- exportacao

const FORMATOS = {
  fcp7: { ext: 'xml', tipo: 'application/xml' },
  csv: { ext: 'csv', tipo: 'text/csv; charset=utf-8' },
};

function gerarExport(src, formato) {
  const tracks = db.listTracks(src.id);
  const markers = db.listMarkers(src.id);
  if (formato === 'csv') return buildMarkerCsv(src, markers);
  return buildFcp7Xml(src, tracks, { markers });
}

const nomeArquivo = (src, formato) =>
  `${path.parse(src.name).name.replace(/[\\/:*?"<>|]/g, '_')}-${formato}.${FORMATOS[formato].ext}`;

/** Download direto pelo navegador. */
app.get('/api/sources/:id/export/:formato', rota((req, res) => {
  const src = exigirFonte(req);
  const formato = String(req.params.formato);
  if (!FORMATOS[formato]) return res.status(400).json({ erro: 'formato desconhecido' });
  res.setHeader('Content-Disposition',
    `attachment; filename="${nomeArquivo(src, formato)}"`);
  res.type(FORMATOS[formato].tipo).send(gerarExport(src, formato));
}));

/** Grava numa pasta do disco — o fluxo real: salvar e importar no Premiere. */
app.post('/api/sources/:id/export/:formato', rota(async (req, res) => {
  const src = exigirFonte(req);
  const formato = String(req.params.formato);
  if (!FORMATOS[formato]) return res.status(400).json({ erro: 'formato desconhecido' });

  const dir = req.body?.dir ? path.resolve(String(req.body.dir))
    : path.join(HOME, 'exports');
  await fsp.mkdir(dir, { recursive: true });
  const destino = path.join(dir, req.body?.filename || nomeArquivo(src, formato));
  await fsp.writeFile(destino, gerarExport(src, formato), 'utf8');
  res.json({ ok: true, arquivo: destino });
}));

// ------------------------------------------------- navegador de arquivos

/** Deixa escolher o arquivo pela UI mesmo sem Electron (util pra depurar no browser). */
app.get('/api/fs/list', rota(async (req, res) => {
  const dir = req.query.dir ? path.resolve(String(req.query.dir)) : os.homedir();
  const entradas = await fsp.readdir(dir, { withFileTypes: true });
  const itens = [];
  for (const e of entradas) {
    if (e.name.startsWith('.')) continue;
    const ehDir = e.isDirectory();
    if (!ehDir && !EXTS_MIDIA.has(path.extname(e.name).toLowerCase())) continue;
    let size = 0;
    if (!ehDir) { try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch { /* sem permissao */ } }
    itens.push({ nome: e.name, dir: ehDir, caminho: path.join(dir, e.name), size });
  }
  itens.sort((a, b) => (a.dir === b.dir ? a.nome.localeCompare(b.nome, 'pt-BR') : a.dir ? -1 : 1));
  res.json({ dir, pai: path.dirname(dir) === dir ? null : path.dirname(dir), itens });
}));

app.get('/api/fs/drives', rota(async (req, res) => {
  const letras = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try { await fsp.access(`${l}:\\`); letras.push(`${l}:\\`); } catch { /* sem esse drive */ }
  }
  res.json({ drives: letras, home: os.homedir() });
}));

// ------------------------------------------------- interface compilada

// Quando existe `dist/`, o proprio servidor entrega a interface. Isso deixa o
// atalho subir so DOIS processos (Electron + servidor) em vez de tres, e faz a
// UI e a API viverem na mesma origem — sem proxy, sem CORS.
const DIST = path.join(import.meta.dirname, '..', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/|\/media\/).*/, (req, res) => {
    res.sendFile(path.join(DIST, 'index.html'));
  });
  console.log('revisor: servindo a interface compilada de dist/');
} else {
  console.log('revisor: sem dist/ — rode `npm run build` (ou use `npm run dev`)');
}

const servidor = app.listen(PORT, '127.0.0.1', () => {
  console.log(`revisor: servidor em http://127.0.0.1:${PORT}`);
  console.log(`         projeto  ${db.dbPath()}`);
  console.log(`         cache    ${ingest.cacheRoot()}`);
});

servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nA porta ${PORT} ja esta em uso — provavelmente ha outro Revisor aberto.`);
    console.error('Feche o outro, ou rode com outra porta:  REVISOR_PORT=5373 npm run server\n');
    process.exit(1);
  }
  throw err;
});
