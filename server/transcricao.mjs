// Transcrição por faixa, na GPU.
//
// Cada microfone é uma faixa separada, então transcrever faixa a faixa entrega
// QUEM falou de graça — sem diarização e sem erro de atribuição. É a vantagem
// que uma gravação multipista dá e que ninguém aproveita.
//
// O trabalho pesado é um processo Python (scripts/transcrever.py) com
// faster-whisper. As faixas rodam UMA DE CADA VEZ: são todas a mesma GPU, e
// paralelizar só troca throughput por disputa de VRAM.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as db from './db.mjs';

export const events = new EventEmitter();

const RAIZ = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'transcrever.py');
const MODELO_PADRAO = process.env.REVISOR_MODELO || 'large-v3';
const LOTE_PADRAO = Number(process.env.REVISOR_LOTE || 8);

/** Python do venv do projeto; sem ele nem adianta tentar. */
export function pythonDoProjeto() {
  const exe = path.join(RAIZ, '.venv-whisper', 'Scripts', 'python.exe');
  return fs.existsSync(exe) ? exe : null;
}

export function disponivel() {
  return Boolean(pythonDoProjeto()) && fs.existsSync(SCRIPT);
}

const filas = new Map();     // sourceId -> { cancelar(), faixas: number[] }
export const rodando = (sourceId) => filas.has(sourceId);

function avisar(trackId, patch) {
  db.setTranscStatus(trackId, patch);
  const t = db.getTrack(trackId);
  events.emit('transcricao', {
    trackId,
    sourceId: t?.source_id,
    status: t?.transc_status,
    progresso: t?.transc_progresso,
    erro: t?.transc_erro,
    idioma: t?.idioma,
  });
}

/**
 * Enfileira as faixas de áudio de uma fonte. Faixas já prontas são puladas, a
 * menos que `refazer` peça o contrário.
 */
export function iniciar(sourceId, { modelo = MODELO_PADRAO, idioma = 'pt', refazer = false } = {}) {
  if (filas.has(sourceId)) return filas.get(sourceId);
  if (!disponivel()) throw new Error('transcrição indisponível: rode `npm run transcricao:instalar`');

  const src = db.getSource(sourceId);
  if (!src) throw new Error('fonte não encontrada');

  const faixas = db.listTracks(sourceId).filter((t) => t.kind === 'audio' && t.audio_path
    && (refazer || t.transc_status !== 'pronta'));
  if (!faixas.length) throw new Error('nenhuma faixa de áudio pendente');

  const ctl = { cancelado: false, filho: null };
  ctl.cancelar = () => {
    ctl.cancelado = true;
    try { ctl.filho?.kill(); } catch { /* já morreu */ }
  };
  filas.set(sourceId, ctl);

  for (const f of faixas) avisar(f.id, { status: 'na fila', progresso: 0, erro: null });

  (async () => {
    for (const faixa of faixas) {
      if (ctl.cancelado) break;
      try {
        await transcreverFaixa(faixa, src, { modelo, idioma, ctl });
      } catch (erro) {
        if (ctl.cancelado) avisar(faixa.id, { status: 'cancelada', progresso: 0 });
        else avisar(faixa.id, { status: 'erro', erro: String(erro.message || erro) });
      }
    }
    for (const f of faixas) {
      if (ctl.cancelado && db.getTrack(f.id)?.transc_status === 'na fila') {
        avisar(f.id, { status: 'cancelada', progresso: 0 });
      }
    }
  })().finally(() => filas.delete(sourceId));

  return ctl;
}

export function cancelar(sourceId) {
  filas.get(sourceId)?.cancelar();
}

function transcreverFaixa(faixa, src, { modelo, idioma, ctl }) {
  return new Promise((resolve, reject) => {
    const python = pythonDoProjeto();
    const destino = path.join(path.dirname(faixa.audio_path), `t${faixa.id}.transcricao.json`);

    avisar(faixa.id, { status: 'transcrevendo', progresso: 0, erro: null });

    const filho = spawn(python, [
      SCRIPT,
      '--audio', faixa.audio_path,
      '--saida', destino,
      '--modelo', modelo,
      '--idioma', idioma,
      '--lote', String(LOTE_PADRAO),
      '--duracao', String(src.duration_s || 0),
    ], {
      cwd: RAIZ,
      windowsHide: true,
      // PYTHONIOENCODING: sem isto o Windows escreve stdout em cp1252 e a
      // primeira palavra acentuada quebra o JSON de progresso.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ctl.filho = filho;

    let resto = '';
    let erroSaida = '';

    filho.stdout.on('data', (bloco) => {
      resto += bloco;
      const linhas = resto.split('\n');
      resto = linhas.pop() ?? '';
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        let ev;
        try { ev = JSON.parse(linha); } catch { continue; }
        if (ev.tipo === 'progresso') {
          avisar(faixa.id, { status: 'transcrevendo', progresso: ev.pct });
        } else if (ev.tipo === 'etapa' && ev.etapa === 'carregando modelo') {
          avisar(faixa.id, { status: 'carregando modelo', progresso: 0 });
        }
      }
    });
    filho.stderr.on('data', (d) => { erroSaida = (erroSaida + d).slice(-4000); });
    filho.on('error', reject);

    filho.on('close', async (codigo) => {
      ctl.filho = null;
      if (ctl.cancelado) return reject(new Error('cancelada'));
      if (codigo !== 0) {
        return reject(new Error(`transcrição falhou (código ${codigo})\n${erroSaida.slice(-800)}`));
      }
      try {
        const dados = JSON.parse(await fsp.readFile(destino, 'utf8'));
        db.gravarTranscricao(faixa.id, src.id, dados.segmentos);
        avisar(faixa.id, {
          status: 'pronta', progresso: 1, erro: null, idioma: dados.idioma,
        });
        resolve(dados.segmentos.length);
      } catch (e) { reject(e); }
    });
  });
}
