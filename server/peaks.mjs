// Waveform pre-calculada.
//
// Desenhar a onda lendo o arquivo original em tempo real e o que trava qualquer
// timeline em video longo. Aqui o audio e decodificado UMA vez para PCM mono 8 kHz,
// reduzido a picos (min/max por bloco) e gravado em disco com varios niveis de zoom
// (mipmaps, cada um 4x menor). Depois, desenhar 10h de onda custa uma leitura de
// alguns KB.
//
// Formato do .pks (little-endian):
//   0  char[4]  "PKS1"
//   4  uint32   versao
//   8  float64  duracao em segundos
//  16  uint32   quantidade de niveis
//  20  por nivel: float64 segundosPorPico, uint32 quantidade, uint32 offsetEmBytes
//   ...dados: por pico, 2 bytes int8 (min, max) normalizados para -127..127
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, spawnFF } from './ffmpeg.mjs';

const PCM_RATE = 8000;          // Hz do PCM intermediario
const SAMPLES_PER_PEAK = 100;   // -> 80 picos por segundo no nivel 0
const LEVELS = 6;               // 80, 20, 5, 1.25, 0.3125, 0.078 picos/s
const HEADER_FIXED = 20;
const LEVEL_ENTRY = 16;

export const BASE_SECONDS_PER_PEAK = SAMPLES_PER_PEAK / PCM_RATE;

/**
 * Extrai os picos de um stream de audio e grava o .pks.
 * @param {string} file       arquivo de origem
 * @param {number} streamIndex indice absoluto do stream no arquivo
 * @param {string} outFile    destino .pks
 * @param {object} opts       { duration, onProgress, audioOut }
 *
 * `audioOut` aproveita a MESMA decodificacao para gravar o .m4a que o player usa.
 * Sem isso o audio de cada faixa seria decodificado duas vezes.
 */
export function buildPeaks(file, streamIndex, outFile, { duration = 0, onProgress, audioOut } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    if (audioOut) fs.mkdirSync(path.dirname(audioOut), { recursive: true });

    const proc = spawnFF([
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      // saida 1: PCM mono 8 kHz para os picos
      '-map', `0:${streamIndex}`,
      '-ac', '1',
      '-ar', String(PCM_RATE),
      '-f', 's16le',
      'pipe:1',
      // saida 2 (opcional): AAC para o player ouvir esta faixa isolada
      ...(audioOut ? [
        '-map', `0:${streamIndex}`,
        '-vn',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-movflags', '+faststart',
        '-y', audioOut,
      ] : []),
    ]);

    // Nivel 0 cresce em blocos; Int8Array duplicado e mais barato que array de objetos.
    let cap = Math.max(1024, Math.ceil((duration || 60) * (PCM_RATE / SAMPLES_PER_PEAK)) + 64);
    let mins = new Int8Array(cap);
    let maxs = new Int8Array(cap);
    let count = 0;

    let blkMin = 127;
    let blkMax = -128;
    let blkLen = 0;
    let carry = null;          // byte impar sobrando entre chunks
    let samplesSeen = 0;
    const expected = duration ? duration * PCM_RATE : 0;
    let lastReport = 0;
    let stderr = '';

    const push = (mn, mx) => {
      if (count === cap) {
        cap = Math.ceil(cap * 1.6);
        const m1 = new Int8Array(cap); m1.set(mins); mins = m1;
        const m2 = new Int8Array(cap); m2.set(maxs); maxs = m2;
      }
      mins[count] = mn;
      maxs[count] = mx;
      count++;
    };

    proc.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
      const n = buf.length >> 1;
      if (buf.length & 1) carry = buf.subarray(buf.length - 1);

      for (let i = 0; i < n; i++) {
        // int16 -> -127..127. /258 mantem o pico maximo dentro de int8 com folga.
        const v = (buf.readInt16LE(i << 1) / 258) | 0;
        if (v < blkMin) blkMin = v;
        if (v > blkMax) blkMax = v;
        if (++blkLen === SAMPLES_PER_PEAK) {
          push(blkMin, blkMax);
          blkMin = 127; blkMax = -128; blkLen = 0;
        }
      }
      samplesSeen += n;

      if (expected && onProgress) {
        const pct = Math.min(0.99, samplesSeen / expected);
        if (pct - lastReport > 0.02) { lastReport = pct; onProgress(pct); }
      }
    });

    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', reject);

    proc.on('close', async (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (picos) codigo ${code}\n${stderr}`));
      if (blkLen > 0) push(blkMin, blkMax);
      if (count === 0) return reject(new Error('stream de audio sem amostras'));

      try {
        await writePeaksFile(outFile, mins.subarray(0, count), maxs.subarray(0, count),
          duration || count * BASE_SECONDS_PER_PEAK);
        onProgress?.(1);
        resolve({ file: outFile, peaks: count });
      } catch (e) { reject(e); }
    });
  });
}

async function writePeaksFile(outFile, mins, maxs, duration) {
  // Constroi os mipmaps: cada nivel e a juncao de 4 picos do nivel anterior.
  const levels = [{ mins, maxs, spp: BASE_SECONDS_PER_PEAK }];
  for (let l = 1; l < LEVELS; l++) {
    const prev = levels[l - 1];
    const n = Math.ceil(prev.mins.length / 4);
    if (n < 2) break;
    const mn = new Int8Array(n);
    const mx = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * 4;
      const e = Math.min(s + 4, prev.mins.length);
      let a = 127; let b = -128;
      for (let j = s; j < e; j++) {
        if (prev.mins[j] < a) a = prev.mins[j];
        if (prev.maxs[j] > b) b = prev.maxs[j];
      }
      mn[i] = a; mx[i] = b;
    }
    levels.push({ mins: mn, maxs: mx, spp: prev.spp * 4 });
  }

  const headerSize = HEADER_FIXED + levels.length * LEVEL_ENTRY;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.write('PKS1', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeDoubleLE(duration, 8);
  header.writeUInt32LE(levels.length, 16);

  const bodies = [];
  levels.forEach((lv, i) => {
    const at = HEADER_FIXED + i * LEVEL_ENTRY;
    header.writeDoubleLE(lv.spp, at);
    header.writeUInt32LE(lv.mins.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    const body = Buffer.alloc(lv.mins.length * 2);
    for (let k = 0; k < lv.mins.length; k++) {
      body.writeInt8(lv.mins[k], k * 2);
      body.writeInt8(lv.maxs[k], k * 2 + 1);
    }
    bodies.push(body);
    offset += body.length;
  });

  const tmp = `${outFile}.tmp`;
  await fsp.writeFile(tmp, Buffer.concat([header, ...bodies]));
  await fsp.rename(tmp, outFile);   // troca atomica: nunca deixa .pks pela metade
}

/** Le so o cabecalho (mantido em cache — o arquivo nao muda depois de escrito). */
const headerCache = new Map();

export async function readHeader(file) {
  const st = await fsp.stat(file);
  const key = `${file}:${st.mtimeMs}`;
  const hit = headerCache.get(key);
  if (hit) return hit;

  const fh = await fsp.open(file, 'r');
  try {
    const fixed = Buffer.alloc(HEADER_FIXED);
    await fh.read(fixed, 0, HEADER_FIXED, 0);
    if (fixed.toString('ascii', 0, 4) !== 'PKS1') throw new Error('arquivo de picos invalido');
    const levelCount = fixed.readUInt32LE(16);
    const lv = Buffer.alloc(levelCount * LEVEL_ENTRY);
    await fh.read(lv, 0, lv.length, HEADER_FIXED);
    const levels = [];
    for (let i = 0; i < levelCount; i++) {
      const at = i * LEVEL_ENTRY;
      levels.push({
        secondsPerPeak: lv.readDoubleLE(at),
        count: lv.readUInt32LE(at + 8),
        offset: lv.readUInt32LE(at + 12),
      });
    }
    const h = { duration: fixed.readDoubleLE(8), levels };
    headerCache.set(key, h);
    if (headerCache.size > 200) headerCache.clear();
    return h;
  } finally {
    await fh.close();
  }
}

/**
 * Le um nivel inteiro, escolhendo o mais grosseiro que ainda tenha pelo menos
 * `porSegundo` picos por segundo. Usado pela deteccao de trechos com som, que
 * precisa varrer o arquivo todo — e nao uma janela.
 */
export async function lerNivel(file, porSegundo = 20) {
  const h = await readHeader(file);
  let escolhido = h.levels[0];
  for (const lv of h.levels) {
    if (1 / lv.secondsPerPeak >= porSegundo) escolhido = lv;
    else break;
  }
  const bytes = Buffer.alloc(escolhido.count * 2);
  const fh = await fsp.open(file, 'r');
  try {
    await fh.read(bytes, 0, bytes.length, escolhido.offset);
  } finally {
    await fh.close();
  }
  // Amplitude por pico: o maior desvio do zero, normalizado em 0..1.
  const amp = new Float32Array(escolhido.count);
  for (let i = 0; i < escolhido.count; i++) {
    const mn = Math.abs(bytes.readInt8(i * 2));
    const mx = Math.abs(bytes.readInt8(i * 2 + 1));
    amp[i] = Math.max(mn, mx) / 127;
  }
  return { amp, secondsPerPeak: escolhido.secondsPerPeak, duration: h.duration };
}

/**
 * Devolve exatamente `width` colunas (min,max) para a janela [from, to].
 * O trabalho de escolher o mipmap e agrupar acontece aqui, no servidor, para o
 * canvas do cliente so precisar desenhar. Sao ~2*width bytes por requisicao.
 */
export async function readWindow(file, from, to, width) {
  const h = await readHeader(file);
  const span = Math.max(1e-6, to - from);

  // Maior nivel que ainda entrega pelo menos 1 pico por coluna.
  let level = h.levels[0];
  for (const lv of h.levels) {
    if (span / lv.secondsPerPeak >= width) level = lv;
    else break;
  }

  const first = Math.max(0, Math.floor(from / level.secondsPerPeak));
  const last = Math.min(level.count, Math.ceil(to / level.secondsPerPeak));
  const out = new Int8Array(width * 2);
  if (last <= first) return { data: out, secondsPerPeak: level.secondsPerPeak, empty: true };

  const bytes = Buffer.alloc((last - first) * 2);
  const fh = await fsp.open(file, 'r');
  try {
    await fh.read(bytes, 0, bytes.length, level.offset + first * 2);
  } finally {
    await fh.close();
  }

  const perCol = (last - first) / width;
  for (let c = 0; c < width; c++) {
    const s = Math.floor(c * perCol);
    const e = Math.max(s + 1, Math.floor((c + 1) * perCol));
    let mn = 127; let mx = -128;
    for (let i = s; i < e && i < last - first; i++) {
      const a = bytes.readInt8(i * 2);
      const b = bytes.readInt8(i * 2 + 1);
      if (a < mn) mn = a;
      if (b > mx) mx = b;
    }
    if (mn > mx) { mn = 0; mx = 0; }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
  }
  return { data: out, secondsPerPeak: level.secondsPerPeak, empty: false };
}
