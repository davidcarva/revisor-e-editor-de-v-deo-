// Ingest: transforma um arquivo bruto em algo que a timeline consegue mostrar
// instantaneamente, por mais longo que ele seja.
//
//   1. probe        — duracao, fps, timecode de origem, streams de audio
//   2. proxy        — H.264 540p com keyframe a cada ~0.5s (NVENC) + folhas de
//                     miniatura, tudo numa unica decodificacao
//   3. por faixa    — .pks (picos da onda) + .m4a (audio isolado pro player)
//
// O arquivo original nunca e tocado depois disso: o player le so o proxy. E o que
// permite abrir um video de 10 horas e arrastar a agulha sem engasgo.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FFMPEG, spawnFF, probe, hasNvenc, premiereTimebase } from './ffmpeg.mjs';
import { buildPeaks } from './peaks.mjs';
import * as db from './db.mjs';

export const events = new EventEmitter();

// Níveis de qualidade, como divisores da altura original. O arquivo original
// é sempre o nível 1 e não precisa ser gerado.
export const NIVEIS = { metade: 2, quarto: 4 };
export const arquivoDoNivel = (dir, divisor) => path.join(dir, `proxy-${divisor}.mp4`);
const THUMB_WIDTH = 160;
const THUMB_COLS = 10;
const THUMB_ROWS = 10;
const MAX_THUMBS = 2400;          // teto: define o intervalo entre miniaturas
const CORES_DE_FAIXA = ['#4f9cf0', '#f0a24f', '#7bd88f', '#e06c9f', '#b58cf0', '#f0e04f'];

let CACHE_ROOT = null;
export function setCacheRoot(dir) {
  CACHE_ROOT = dir;
  fs.mkdirSync(dir, { recursive: true });
}
export const cacheRoot = () => CACHE_ROOT;

const jobs = new Map();           // sourceId -> { cancel() }
export const isRunning = (id) => jobs.has(id);

function report(sourceId, patch) {
  db.setSourceStatus(sourceId, patch);
  events.emit('progress', { sourceId, ...patch });
}

/** Registra o arquivo no banco (rapido) e devolve o id; o trabalho pesado vem depois. */
export async function register(file) {
  const abs = path.resolve(file);
  await fsp.access(abs, fs.constants.R_OK);
  const info = await probe(abs);
  if (!info.hasVideo && info.audioStreams.length === 0) {
    throw new Error('arquivo sem video nem audio');
  }

  const sourceId = db.upsertSource({
    path: abs,
    name: path.basename(abs),
    duration_s: info.duration,
    fps: info.fps,
    width: info.width,
    height: info.height,
    start_timecode: info.startTimecode,
    size_bytes: info.sizeBytes,
    probe_json: JSON.stringify({
      videoCodec: info.videoCodec, format: info.format,
      audioStreams: info.audioStreams, hasVideo: info.hasVideo,
    }),
  });

  if (info.hasVideo) {
    db.upsertTrack({
      source_id: sourceId, kind: 'video', stream_index: info.videoStreams[0].index,
      ord: 0, label: 'Video', channels: 0, sample_rate: 0, color: '#8892a6',
    });
  }
  info.audioStreams.forEach((s, i) => {
    db.upsertTrack({
      source_id: sourceId, kind: 'audio', stream_index: s.index, ord: i,
      label: s.label || `Faixa ${i + 1}`,
      channels: s.channels, sample_rate: s.sampleRate,
      color: CORES_DE_FAIXA[i % CORES_DE_FAIXA.length],
    });
  });

  report(sourceId, { status: 'registrado', progress: 0, stage: null, error: null });
  return { sourceId, info };
}

/**
 * Roda o ingest em background. Idempotente: pula o que ja existe.
 * `comVideo: false` faz so a passada de audio (modo assistir).
 */
export function start(sourceId, { force = false, comVideo = true } = {}) {
  if (jobs.has(sourceId)) return jobs.get(sourceId);

  const ctl = { children: new Set(), cancelled: false };
  ctl.cancel = () => {
    ctl.cancelled = true;
    for (const c of ctl.children) { try { c.kill('SIGKILL'); } catch { /* ja morreu */ } };
  };
  jobs.set(sourceId, ctl);

  run(sourceId, ctl, force, comVideo)
    .then(() => {
      if (!ctl.cancelled) report(sourceId, { status: 'pronto', progress: 1, stage: null });
    })
    .catch((err) => {
      if (ctl.cancelled) report(sourceId, { status: 'cancelado', stage: null });
      else report(sourceId, { status: 'erro', stage: null, error: String(err.message || err) });
    })
    .finally(() => jobs.delete(sourceId));

  return ctl;
}

export function cancel(sourceId) {
  jobs.get(sourceId)?.cancel();
}

/**
 * Adota um `proxy.mp4` do esquema antigo como nível "metade".
 *
 * Antes existia um proxy só, fixo em 540p. Num arquivo 1080p isso é exatamente
 * metade, então renomear é honesto; em qualquer outra resolução não é, e aí o
 * arquivo antigo é ignorado em vez de mentir sobre a qualidade que entrega.
 */
export function adotarProxyAntigo(sourceId) {
  const src = db.getSource(sourceId);
  if (!src?.height) return false;
  const dir = path.join(CACHE_ROOT, String(sourceId));
  const antigo = path.join(dir, 'proxy.mp4');
  const novo = arquivoDoNivel(dir, NIVEIS.metade);
  if (!fs.existsSync(antigo) || fs.existsSync(novo)) return false;
  if (Math.abs(540 - src.height / 2) > 10) return false;
  fs.renameSync(antigo, novo);
  db.setSourceAssets(sourceId, { proxy_path: novo });
  return true;
}

/** Caminho de um nível, se ele já existe em disco. */
export function nivelPronto(sourceId, divisor) {
  const arq = arquivoDoNivel(path.join(CACHE_ROOT, String(sourceId)), divisor);
  return fs.existsSync(arq) ? arq : null;
}

const gerando = new Map();   // `${id}:${divisor}` -> Promise
export const gerandoNivel = (sourceId, divisor) => gerando.has(`${sourceId}:${divisor}`);

/**
 * Gera um nível de qualidade sob demanda, sem miniaturas — elas já existem e
 * não dependem da resolução do vídeo.
 */
export function gerarNivel(sourceId, divisor) {
  const chave = `${sourceId}:${divisor}`;
  if (gerando.has(chave)) return gerando.get(chave);

  const src = db.getSource(sourceId);
  if (!src) throw new Error('fonte não encontrada');
  const dir = path.join(CACHE_ROOT, String(sourceId));

  const ctl = { children: new Set(), cancelled: false };
  const tarefa = (async () => {
    await fsp.mkdir(dir, { recursive: true });
    report(sourceId, { status: 'processando', stage: `qualidade ${divisor}`, progress: 0 });
    await buildProxy(src, dir, ctl, divisor, (p) => {
      report(sourceId, { status: 'processando', stage: `qualidade ${divisor}`, progress: p });
    });
    // O `stage` sobrevive ao fim de proposito: e por ele que o cliente sabe que
    // o que ficou pronto foi um nivel de qualidade, e recarrega o <video>.
    report(sourceId, { status: 'pronto', progress: 1, stage: `qualidade ${divisor}` });
    return arquivoDoNivel(dir, divisor);
  })().finally(() => gerando.delete(chave));

  gerando.set(chave, tarefa);
  return tarefa;
}

async function run(sourceId, ctl, force, comVideo) {
  const src = db.getSource(sourceId);
  if (!src) throw new Error('fonte nao encontrada');
  const dir = path.join(CACHE_ROOT, String(sourceId));
  await fsp.mkdir(dir, { recursive: true });

  const meta = JSON.parse(src.probe_json || '{}');
  const tracks = db.listTracks(sourceId);
  const audioTracks = tracks.filter((t) => t.kind === 'audio');

  // As duas metades do ingest custam coisas muito diferentes, e servem a coisas
  // diferentes. O proxy e caro (horas de GPU, ~15 GB por 10 h) e so melhora o
  // arraste da agulha. A passada de audio e barata e e o que destrava o mixer de
  // faixas — sem ela o Chromium toca so a PRIMEIRA faixa do arquivo, e um vídeo
  // multipista vira mono-pista. Por isso, no modo assistir, so a segunda roda.
  const hasVideo = !!meta.hasVideo && comVideo;
  const wVideo = hasVideo ? 0.65 : 0;
  const wAudio = 1 - wVideo;

  if (hasVideo) {
    const proxy = arquivoDoNivel(dir, NIVEIS.metade);
    const thumbsMeta = path.join(dir, 'thumbs.json');
    const done = !force && fs.existsSync(proxy) && fs.existsSync(thumbsMeta);
    if (!done) {
      report(sourceId, { status: 'processando', stage: 'proxy', progress: 0 });
      await buildProxyAndThumbs(src, dir, ctl, (p) => {
        report(sourceId, { status: 'processando', stage: 'proxy', progress: p * wVideo });
      });
    }
    db.setSourceAssets(sourceId, { proxy_path: proxy, thumbs_path: thumbsMeta });
    report(sourceId, { status: 'processando', stage: 'proxy', progress: wVideo });
  }

  // Faixas de audio em paralelo limitado: 2 por vez segura a CPU de 6 nucleos.
  const progresso = new Array(audioTracks.length).fill(0);
  const bump = () => {
    const media = progresso.reduce((a, b) => a + b, 0) / (audioTracks.length || 1);
    report(sourceId, {
      status: 'processando', stage: 'audio',
      progress: wVideo + media * wAudio,
    });
  };

  await poolMap(audioTracks, 2, async (t, i) => {
    if (ctl.cancelled) return;
    const pks = path.join(dir, `t${t.id}.pks`);
    const m4a = path.join(dir, `t${t.id}.m4a`);
    if (!force && fs.existsSync(pks) && fs.existsSync(m4a)) {
      progresso[i] = 1; bump();
      db.setTrackAssets(t.id, { peaks_path: pks, audio_path: m4a });
      return;
    }
    await buildPeaks(src.path, t.stream_index, pks, {
      duration: src.duration_s,
      audioOut: m4a,
      onProgress: (p) => { progresso[i] = p; bump(); },
    });
    db.setTrackAssets(t.id, { peaks_path: pks, audio_path: m4a });
    progresso[i] = 1; bump();
  });

  if (ctl.cancelled) throw new Error('cancelado');
}

/**
 * Proxy + miniaturas numa unica passada. Duas saidas do mesmo -i significa que o
 * ffmpeg decodifica o arquivo uma vez so — em video longo isso e metade do tempo.
 */
/** Só o vídeo, num nível de qualidade. Usado quando as miniaturas já existem. */
async function buildProxy(src, dir, ctl, divisor, onProgress) {
  const nvenc = await hasNvenc();
  const fps = src.fps || 30;
  const gop = Math.max(2, Math.round(fps / 2));
  const altura = Math.max(2, Math.round((src.height || 1080) / divisor / 2) * 2);
  const tmp = path.join(dir, `proxy-${divisor}.part.mp4`);
  const codec = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];

  await runWithProgress([
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    ...(nvenc ? ['-hwaccel', 'cuda'] : []),
    '-i', src.path,
    '-map', '0:v:0', '-an',
    '-vf', `scale=-2:${altura}`,
    ...codec,
    '-g', String(gop), '-bf', '0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', tmp,
  ], ctl, src.duration_s, onProgress);

  await fsp.rename(tmp, arquivoDoNivel(dir, divisor));
  return arquivoDoNivel(dir, divisor);
}

async function buildProxyAndThumbs(src, dir, ctl, onProgress, divisor = 2) {
  const nvenc = await hasNvenc();
  const fps = src.fps || 30;
  const gop = Math.max(2, Math.round(fps / 2));   // keyframe a cada ~0.5s
  // Altura par: codec de vídeo não aceita dimensão ímpar.
  const altura = Math.max(2, Math.round((src.height || 1080) / divisor / 2) * 2);

  const thumbDir = path.join(dir, 'thumbs');
  await fsp.rm(thumbDir, { recursive: true, force: true });
  await fsp.mkdir(thumbDir, { recursive: true });

  const interval = Math.max(1, Math.ceil((src.duration_s || 60) / MAX_THUMBS));
  const thumbH = src.width && src.height
    ? Math.max(2, Math.round((THUMB_WIDTH * src.height) / src.width / 2) * 2)
    : 90;

  const proxyTmp = path.join(dir, `proxy-${divisor}.part.mp4`);
  const codecArgs = nvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-progress', 'pipe:1',
    ...(nvenc ? ['-hwaccel', 'cuda'] : []),
    '-i', src.path,
    // saida 1: proxy de video, sem audio (o audio vem por faixa, isolado)
    '-map', '0:v:0', '-an',
    '-vf', `scale=-2:${altura}`,
    ...codecArgs,
    '-g', String(gop), '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', proxyTmp,
    // saida 2: folhas de miniatura para a regua de video
    '-map', '0:v:0', '-an',
    '-vf', `fps=1/${interval},scale=${THUMB_WIDTH}:${thumbH},tile=${THUMB_COLS}x${THUMB_ROWS}`,
    '-fps_mode', 'vfr', '-q:v', '4',
    '-y', path.join(thumbDir, 'sheet_%04d.jpg'),
  ];

  await runWithProgress(args, ctl, src.duration_s, onProgress);
  if (ctl.cancelled) throw new Error('cancelado');

  await fsp.rename(proxyTmp, arquivoDoNivel(dir, divisor));

  const sheets = (await fsp.readdir(thumbDir)).filter((f) => f.endsWith('.jpg')).sort();
  await fsp.writeFile(path.join(dir, 'thumbs.json'), JSON.stringify({
    interval, cols: THUMB_COLS, rows: THUMB_ROWS,
    thumbW: THUMB_WIDTH, thumbH,
    perSheet: THUMB_COLS * THUMB_ROWS,
    sheets,
    count: Math.ceil((src.duration_s || 0) / interval),
  }, null, 2));
}

/** Executa o ffmpeg lendo `-progress pipe:1` para virar fracao 0..1. */
function runWithProgress(args, ctl, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawnFF(args);
    ctl.children.add(p);
    let stderr = '';
    let buf = '';

    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_ms' && duration) {
          const secs = Number(v) / 1e6;
          if (Number.isFinite(secs)) onProgress?.(Math.min(0.99, secs / duration));
        }
      }
    });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => {
      ctl.children.delete(p);
      if (ctl.cancelled) return reject(new Error('cancelado'));
      if (code !== 0) return reject(new Error(`ffmpeg codigo ${code}\n${stderr}`));
      onProgress?.(1);
      resolve();
    });
  });
}

/** map com concorrencia limitada, sem dependencia externa. */
async function poolMap(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export { premiereTimebase };
