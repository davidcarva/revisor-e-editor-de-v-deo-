// Biblioteca: catálogo da mídia que existe nas pastas do computador.
//
// A regra que organiza tudo aqui é: a varredura tem que ser INSTANTÂNEA. Ler
// metadado de arquivo (ffprobe) custa ~100 ms cada; numa pasta com 500 vídeos
// isso é um minuto de espera antes de ver a primeira miniatura. Então a
// varredura faz só `readdir` + `stat`, e duração, dimensões e miniatura são
// preenchidas depois, sob demanda, conforme os cartões aparecem na tela.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FFMPEG, run, probe } from './ffmpeg.mjs';
import * as db from './db.mjs';

const EXTS_VIDEO = new Set([
  '.mp4', '.mov', '.mkv', '.mxf', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts', '.wmv',
]);
const EXTS_AUDIO = new Set([
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.ogg', '.opus', '.wma',
]);

const PROFUNDIDADE_MAX = 6;
const LARGURA_POSTER = 400;
// Pastas que nunca contêm mídia do usuário e que só fariam a varredura demorar.
const IGNORAR = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information',
  'appdata', 'windows', 'program files', 'program files (x86)', '.venv-whisper',
]);

let RAIZ_POSTERS = null;
export function setRaizPosters(dir) {
  RAIZ_POSTERS = path.join(dir, 'biblioteca');
  fs.mkdirSync(RAIZ_POSTERS, { recursive: true });
}

export const tipoDe = (ext) => (EXTS_VIDEO.has(ext) ? 'video' : EXTS_AUDIO.has(ext) ? 'audio' : null);

/**
 * Varre uma pasta e grava o que achou. Só `readdir` + `stat`: nada de ffprobe.
 * Devolve quantos arquivos entraram.
 */
export async function varrer(raiz, { onProgresso } = {}) {
  const base = path.resolve(raiz);
  if (!fs.existsSync(base)) throw new Error(`pasta não encontrada: ${base}`);

  // Tudo que estava sob essa pasta vira "ausente"; o que a varredura reencontrar
  // volta a existir. É assim que arquivo apagado some da grade sem apagar nada.
  db.marcarAusentes(base);

  let achados = 0;
  const fila = [{ dir: base, nivel: 0 }];

  while (fila.length) {
    const { dir, nivel } = fila.shift();
    let entradas;
    try { entradas = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }

    for (const e of entradas) {
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (nivel >= PROFUNDIDADE_MAX) continue;
        if (e.name.startsWith('.') || IGNORAR.has(e.name.toLowerCase())) continue;
        fila.push({ dir: completo, nivel: nivel + 1 });
        continue;
      }
      if (!e.isFile()) continue;

      const ext = path.extname(e.name).toLowerCase();
      const tipo = tipoDe(ext);
      if (!tipo) continue;

      let st;
      try { st = await fsp.stat(completo); } catch { continue; }
      db.upsertMidia({
        caminho: completo,
        nome: path.parse(e.name).name,
        pasta: dir,
        ext,
        tipo,
        tamanho: st.size,
        modificado: st.mtimeMs,
      });
      achados++;
      if (achados % 50 === 0) onProgresso?.(achados);
    }
  }
  onProgresso?.(achados);
  return achados;
}

/** Lê duração/dimensões/faixas de um item — só quando alguém precisa. */
export async function sondar(id) {
  const m = db.getMidia(id);
  if (!m || m.sondado) return m;
  try {
    const info = await probe(m.caminho);
    db.setSondagem(id, {
      duracao: info.duration,
      largura: info.width,
      altura: info.height,
      faixas_audio: info.audioStreams.length,
    });
  } catch {
    // Arquivo ilegível não pode travar a grade; marca como sondado pra não
    // tentar de novo a cada rolagem.
    db.setSondagem(id, {});
  }
  return db.getMidia(id);
}

const posterDe = (m) => {
  // O nome carrega o mtime: arquivo reexportado gera miniatura nova sozinho.
  const chave = crypto.createHash('sha1')
    .update(`${m.caminho}:${Math.round(m.modificado)}`).digest('hex').slice(0, 16);
  return path.join(RAIZ_POSTERS, `${chave}.jpg`);
};

// Uma miniatura por vez por arquivo: rolar rápido dispara o mesmo id várias
// vezes, e sem isto seriam vários ffmpeg pro mesmo quadro.
const emCurso = new Map();

/**
 * Miniatura de um vídeo. Procura um quadro com conteúdo, não o primeiro —
 * gravação costuma abrir em preto, e uma grade de retângulos pretos não ajuda
 * ninguém a achar o arquivo certo.
 */
export async function poster(id) {
  const m = db.getMidia(id);
  if (!m || m.tipo !== 'video') return null;
  if (m.poster && fs.existsSync(m.poster)) return m.poster;
  if (emCurso.has(id)) return emCurso.get(id);

  const tarefa = (async () => {
    const info = m.sondado ? m : await sondar(id);
    const destino = posterDe(m);
    const dur = Number(info?.duracao) || 0;
    // 10% do arquivo pula vinheta e tela preta de abertura; em arquivo curto,
    // ou sem duração conhecida, cai pro começo.
    const inicio = dur > 4 ? Math.min(dur * 0.1, 60) : 0;

    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      // -ss ANTES de -i: busca por índice, não decodifica desde o início. É a
      // diferença entre 200 ms e um minuto num arquivo de vários GB.
      '-ss', String(inicio),
      '-i', m.caminho,
      '-frames:v', '1',
      '-vf', `scale=${LARGURA_POSTER}:-2`,
      '-q:v', '4',
      '-y', destino,
    ]);
    db.setPoster(id, destino);
    return destino;
  })().finally(() => emCurso.delete(id));

  emCurso.set(id, tarefa);
  return tarefa;
}
