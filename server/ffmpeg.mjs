// Wrappers finos em cima do ffmpeg/ffprobe empacotados. Nada aqui depende de
// binario instalado na maquina: os dois .exe vem de node_modules.
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = ffmpegPath;
export const FFPROBE = ffprobeStatic.path;

/** Roda um processo ate o fim, devolvendo stdout. Rejeita com o stderr real. */
export function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => {
      const s = String(d);
      err += s;
      if (err.length > 64_000) err = err.slice(-32_000);
      onStderr?.(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} saiu com codigo ${code}\n${err.slice(-4000)}`));
    });
  });
}

/** Igual a run(), mas devolve o processo pra quem quiser ler stdout em stream. */
export function spawnFF(args, { stdio } = {}) {
  return spawn(FFMPEG, args, { windowsHide: true, stdio: stdio ?? ['ignore', 'pipe', 'pipe'] });
}

/** "30000/1001" -> 29.97002997. Aceita tambem "25" e "0/0". */
export function parseRate(str) {
  if (!str) return null;
  const [n, d] = String(str).split('/').map(Number);
  if (!n || !d) return Number(str) || null;
  return n / d;
}

/**
 * Timebase que o Premiere entende. NTSC (23.976/29.97/59.94) precisa do par
 * (timebase inteiro arredondado pra cima, ntsc=TRUE) — mandar 29.97 direto
 * faz o Premiere importar a sequencia com a duracao errada.
 */
export function premiereTimebase(fps) {
  if (!fps) return { timebase: 30, ntsc: true, fps: 30000 / 1001 };
  const ntscPairs = [
    [24000 / 1001, 24], [30000 / 1001, 30], [60000 / 1001, 60], [120000 / 1001, 120],
  ];
  for (const [rate, tb] of ntscPairs) {
    if (Math.abs(fps - rate) < 0.01) return { timebase: tb, ntsc: true, fps: rate };
  }
  const tb = Math.round(fps);
  return { timebase: tb, ntsc: false, fps: tb };
}

// MP4/MOV gravam quase sempre "SoundHandler" / "VideoHandler" no handler_name, e
// alguns gravadores poem o nome do codec no title. Nada disso e um nome de faixa
// util, entao vira null e o ingest cai em "Faixa 1", "Faixa 2"...
const ROTULO_GENERICO = /^(sound|video|audio|core media|gpac|isom|bento4|mainconcept|\s*)(handler|media)?\s*$/i;
const rotuloUtil = (v) => {
  const s = String(v ?? '').trim();
  return s && !ROTULO_GENERICO.test(s) ? s : null;
};

/** Le metadados completos do arquivo. */
export async function probe(file) {
  const out = await run(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', '-show_entries', 'stream_tags:format_tags',
    file,
  ]);
  const data = JSON.parse(out);
  const streams = data.streams || [];
  const video = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const v0 = video[0];

  const fps = v0 ? (parseRate(v0.avg_frame_rate) || parseRate(v0.r_frame_rate)) : null;
  const duration = Number(data.format?.duration)
    || Number(v0?.duration)
    || Number(audio[0]?.duration)
    || 0;

  // Timecode de origem: camera grava em stream tag, alguns containers em format tag.
  const startTimecode = v0?.tags?.timecode
    || data.format?.tags?.timecode
    || streams.find((s) => s.codec_type === 'data' && s.tags?.timecode)?.tags?.timecode
    || '00:00:00:00';

  return {
    duration,
    fps,
    width: v0 ? Number(v0.width) : null,
    height: v0 ? Number(v0.height) : null,
    videoCodec: v0?.codec_name ?? null,
    startTimecode,
    hasVideo: video.length > 0,
    videoStreams: video.map((s) => ({ index: s.index, codec: s.codec_name })),
    audioStreams: audio.map((s, i) => ({
      index: s.index,
      order: i,
      codec: s.codec_name,
      channels: Number(s.channels) || 1,
      sampleRate: Number(s.sample_rate) || 48000,
      layout: s.channel_layout || null,
      label: rotuloUtil(s.tags?.title) || rotuloUtil(s.tags?.handler_name) || null,
      language: s.tags?.language || null,
    })),
    format: data.format?.format_name ?? null,
    sizeBytes: Number(data.format?.size) || 0,
    raw: data,
  };
}

/** Testa uma vez se o NVENC realmente encoda nesta maquina (driver pode recusar). */
let nvencOk = null;
export async function hasNvenc() {
  if (nvencOk !== null) return nvencOk;
  try {
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
      '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ]);
    nvencOk = true;
  } catch {
    nvencOk = false;
  }
  return nvencOk;
}
