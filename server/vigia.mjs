// Vigia das pastas: a biblioteca acompanha o disco sem você mandar atualizar.
//
// `fs.watch` recursivo no Windows usa o ReadDirectoryChangesW do próprio
// sistema — é o mesmo mecanismo do Explorador, custa quase nada e não envolve
// ficar relendo pasta. O que ele NÃO faz é ser pontual: copiar um arquivo de
// 2 GB dispara dezenas de eventos enquanto ele é escrito, renomear dispara dois.
//
// Daí as duas defesas aqui:
//
//   1. uma espera que reinicia a cada evento, pra uma rajada virar um trabalho
//      só em vez de trinta varreduras concorrentes;
//   2. a exigência de que o tamanho do arquivo pare de mudar antes de aceitá-lo,
//      porque catalogar um arquivo pela metade grava a duração errada e a
//      miniatura falha.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as db from './db.mjs';
import { tipoDe } from './biblioteca.mjs';

export const events = new EventEmitter();

const ESPERA_MS = 700;          // rajada vira um trabalho só
const ESTAVEL_MS = 1500;        // quanto tempo o tamanho precisa ficar parado
const MAX_TENTATIVAS = 40;      // ~60 s esperando uma cópia terminar

const vigias = new Map();       // raiz -> FSWatcher
const pendentes = new Set();    // caminhos a conferir
let timer = null;
let ligado = false;

const IGNORAR_PASTA = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information',
  'appdata', 'windows', 'program files', 'program files (x86)', '.venv-whisper',
]);

const dentroDeIgnorada = (relativo) => relativo
  .split(/[\\/]/)
  .some((p) => IGNORAR_PASTA.has(p.toLowerCase()) || p.startsWith('.'));

/** (Re)liga o vigia nas pastas registradas. Idempotente. */
export function ligar() {
  ligado = true;
  const raizes = db.listarPastas().map((p) => p.caminho);

  for (const [raiz, w] of vigias) {
    if (!raizes.includes(raiz)) { w.close(); vigias.delete(raiz); }
  }

  for (const raiz of raizes) {
    if (vigias.has(raiz)) continue;
    try {
      const w = fs.watch(raiz, { recursive: true, persistent: false }, (_tipo, nome) => {
        if (!nome) return;
        if (dentroDeIgnorada(nome)) return;
        const ext = path.extname(nome).toLowerCase();
        // Pasta renomeada/apagada não tem extensão: entra assim mesmo, porque
        // pode ter levado vídeos junto.
        if (ext && !tipoDe(ext)) return;
        pendentes.add(path.join(raiz, nome));
        agendar();
      });
      w.on('error', () => { w.close(); vigias.delete(raiz); });
      vigias.set(raiz, w);
    } catch { /* pasta sumiu ou é de rede sem suporte a watch */ }
  }
  return vigias.size;
}

export function desligar() {
  ligado = false;
  for (const w of vigias.values()) w.close();
  vigias.clear();
  clearTimeout(timer);
  timer = null;
}

export const vigiando = () => [...vigias.keys()];

function agendar() {
  clearTimeout(timer);
  timer = setTimeout(() => { processar().catch(() => {}); }, ESPERA_MS);
}

/** O tamanho precisa parar de mudar: copiar um arquivo grande leva tempo. */
async function estavel(caminho) {
  let anterior = -1;
  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    let st;
    try { st = await fsp.stat(caminho); } catch { return null; }
    if (!st.isFile()) return null;
    if (st.size > 0 && st.size === anterior) return st;
    anterior = st.size;
    await new Promise((r) => setTimeout(r, ESTAVEL_MS));
  }
  return null;
}

async function processar() {
  if (!ligado || !pendentes.size) return;
  const lote = [...pendentes];
  pendentes.clear();

  const novos = [];
  const sumiram = [];

  for (const caminho of lote) {
    const existe = fs.existsSync(caminho);

    if (!existe) {
      // Pode ser o arquivo em si, ou uma pasta inteira que foi embora.
      const jaTinha = db.getMidiaPorCaminho(caminho);
      if (jaTinha) { db.removerMidiaPorCaminho(caminho); sumiram.push(caminho); continue; }
      const dentro = db.listarMidia({ pasta: caminho, recursivo: true, limite: 400 });
      for (const m of dentro) {
        if (!fs.existsSync(m.caminho)) { db.removerMidiaPorCaminho(m.caminho); sumiram.push(m.caminho); }
      }
      continue;
    }

    let st;
    try { st = fs.statSync(caminho); } catch { continue; }

    if (st.isDirectory()) {
      // Pasta nova (ou renomeada): varre só ela, não o disco inteiro.
      const { varrer } = await import('./biblioteca.mjs');
      try { await varrer(caminho); novos.push(caminho); } catch { /* sumiu no meio */ }
      continue;
    }

    const ext = path.extname(caminho).toLowerCase();
    const tipo = tipoDe(ext);
    if (!tipo) continue;

    const anterior = db.getMidiaPorCaminho(caminho);
    // Já catalogado e do mesmo tamanho: foi só um toque no mtime.
    if (anterior && anterior.tamanho === st.size && !anterior.ausente) continue;

    const firme = await estavel(caminho);
    if (!firme) continue;

    db.upsertMidia({
      caminho,
      nome: path.parse(caminho).name,
      pasta: path.dirname(caminho),
      ext,
      tipo,
      tamanho: firme.size,
      modificado: firme.mtimeMs,
    });
    novos.push(caminho);
  }

  if (novos.length || sumiram.length) {
    events.emit('biblioteca', {
      tipo: 'biblioteca',
      novos: novos.length,
      sumiram: sumiram.length,
      caminhos: [...novos, ...sumiram].slice(0, 20),
    });
  }

  // Chegou coisa enquanto trabalhávamos.
  if (pendentes.size) agendar();
}
