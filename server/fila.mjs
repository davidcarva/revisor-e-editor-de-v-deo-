// Fila de preparo: deixa vários arquivos prontos de uma vez, sem você esperar
// cada um na hora de abrir.
//
// Um de cada vez, de propósito. O ffmpeg já usa todos os núcleos e a NVENC tem
// um número fixo de sessões: rodar quatro conversões juntas não termina antes,
// só deixa a máquina inutilizável enquanto isso. Em série, dá pra continuar
// assistindo um vídeo enquanto a fila trabalha atrás.
//
// O preparo tem dois tamanhos, e a diferença é gigante em disco:
//
//   áudio   — separa as faixas (.m4a) e desenha as ondas (.pks). É o que faz o
//             mixer de várias faixas existir, e custa ~100 MB por hora.
//   revisão — o acima MAIS a versão convertida do vídeo e as miniaturas da
//             régua. Custa ~1,5 GB por hora.
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as ingest from './ingest.mjs';
import * as db from './db.mjs';

export const events = new EventEmitter();

/** @type {{caminho:string, nome:string, comVideo:boolean, estado:string, sourceId:number|null, erro:string|null}[]} */
const itens = [];
let rodando = false;
let cancelado = false;

const publico = (i) => ({
  caminho: i.caminho, nome: i.nome, comVideo: i.comVideo,
  estado: i.estado, sourceId: i.sourceId, erro: i.erro,
});

export function estado() {
  const feitos = itens.filter((i) => i.estado === 'pronto' || i.estado === 'erro').length;
  return {
    rodando,
    total: itens.length,
    feitos,
    atual: itens.find((i) => i.estado === 'preparando')?.nome ?? null,
    itens: itens.map(publico),
  };
}

function avisar() { events.emit('fila', estado()); }

/**
 * Põe caminhos na fila. Repetir um caminho que já está lá não duplica — e se
 * ele já passou, entra de novo, porque pedir duas vezes costuma significar
 * "agora com vídeo também".
 */
export function enfileirar(caminhos, { comVideo = false } = {}) {
  let novos = 0;
  for (const bruto of caminhos) {
    const caminho = path.resolve(String(bruto));
    const pendente = itens.find((i) => i.caminho === caminho
      && (i.estado === 'esperando' || i.estado === 'preparando'));
    if (pendente) {
      // Já na fila: só promove de áudio pra revisão, nunca rebaixa.
      if (comVideo && !pendente.comVideo) pendente.comVideo = true;
      continue;
    }
    itens.push({
      caminho, nome: path.basename(caminho), comVideo,
      estado: 'esperando', sourceId: null, erro: null,
    });
    novos++;
  }
  cancelado = false;
  avisar();
  if (!rodando) processar();
  return { novos, ...estado() };
}

export function cancelar() {
  cancelado = true;
  for (const i of itens) if (i.estado === 'esperando') i.estado = 'cancelado';
  const atual = itens.find((i) => i.estado === 'preparando');
  if (atual?.sourceId != null) ingest.cancel(atual.sourceId);
  avisar();
  return estado();
}

/** Tira da lista o que já acabou — a fila vira histórico se ninguém limpar. */
export function limpar() {
  for (let i = itens.length - 1; i >= 0; i--) {
    if (itens[i].estado !== 'esperando' && itens[i].estado !== 'preparando') itens.splice(i, 1);
  }
  avisar();
  return estado();
}

async function processar() {
  if (rodando) return;
  rodando = true;
  avisar();

  try {
    for (;;) {
      const item = itens.find((i) => i.estado === 'esperando');
      if (!item || cancelado) break;
      item.estado = 'preparando';
      item.erro = null;
      avisar();
      try {
        // `register` é o ffprobe: rápido, mas é ele que descobre quantas faixas
        // de áudio existem — sem isso não há o que separar.
        const { sourceId } = await ingest.register(item.caminho);
        item.sourceId = sourceId;
        avisar();
        const ctl = ingest.start(sourceId, { comVideo: item.comVideo });
        // `ctl.pronto` não rejeita — o resultado é que diz se deu certo.
        const r = await ctl.pronto;
        if (r && r.ok === false) { item.estado = 'erro'; item.erro = r.erro; }
        else item.estado = cancelado ? 'cancelado' : 'pronto';
      } catch (e) {
        item.estado = 'erro';
        item.erro = String(e?.message || e);
      }
      avisar();
    }
  } finally {
    rodando = false;
    avisar();
  }
}

/**
 * O que a fila vai custar em disco, com as taxas medidas do cache de verdade.
 * Serve pra mostrar o preço ANTES de começar, não depois de encher o HD.
 */
export function estimativa(caminhos, { comVideo = false, porHora = {}, porByte = {} } = {}) {
  let segundos = 0;
  let bytesOriginais = 0;   // dos que NÃO têm duração conhecida
  let comDuracao = 0;
  let semNada = 0;

  for (const bruto of caminhos) {
    const m = db.getMidiaPorCaminho(path.resolve(String(bruto)));
    // A duração é a régua melhor, mas só existe pra quem já passou pelo
    // ffprobe. O tamanho do arquivo a biblioteca sabe de todo mundo, então é
    // ele que evita mostrar "0 MB" pra uma fila de trinta gravações.
    if (m?.duracao) { segundos += m.duracao; comDuracao++; }
    else if (m?.tamanho) bytesOriginais += m.tamanho;
    else semNada++;
  }

  const h = segundos / 3600;
  const tipos = comVideo
    ? ['audio', 'picos', 'proxies', 'miniaturas']
    : ['audio', 'picos'];
  const PADRAO_HORA = { audio: 95e6, picos: 2.5e6, proxies: 1.55e9, miniaturas: 2.5e6 };
  const PADRAO_BYTE = { audio: 0.006, picos: 0.0002, proxies: 0.09, miniaturas: 0.0002 };

  let bytes = 0;
  for (const t of tipos) {
    bytes += h * (porHora[t] ?? PADRAO_HORA[t]);
    bytes += bytesOriginais * (porByte[t] ?? PADRAO_BYTE[t]);
  }

  return {
    horas: h,
    total: caminhos.length,
    comDuracao,
    porTamanho: caminhos.length - comDuracao - semNada,
    desconhecidos: semNada,
    bytes: Math.round(bytes),
  };
}
