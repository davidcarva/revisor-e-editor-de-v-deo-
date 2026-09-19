// Detecção de trechos com som, por faixa.
//
// Serve ao pulo por Ctrl+←/Ctrl+→: "leva a agulha pro próximo lugar onde alguém
// fala nesta faixa". Como cada microfone é uma faixa separada, pular pelos
// trechos de UMA faixa é o mesmo que pular pelas falas de UMA pessoa — que é o
// que torna o atalho útil numa gravação de várias horas com convidados.
//
// Sai tudo do .pks que o ingest já gravou: nada de decodificar áudio de novo.
import fs from 'node:fs';
import { lerNivel } from './peaks.mjs';

const POR_SEGUNDO = 20;        // resolução da varredura
const MIN_TRECHO = 0.30;       // s — abaixo disso é estalo, não fala
const MIN_SILENCIO = 0.40;     // s — pausa curta não separa dois trechos
const MARGEM = 0.12;           // s — recua um pouco pra não cortar a sílaba inicial

// A detecção é determinística e o .pks não muda depois de escrito, então o
// resultado vale enquanto o arquivo tiver a mesma data de modificação.
const cache = new Map();

/**
 * Limiar adaptativo: um piso fixo não serve porque cada microfone tem um nível
 * de ruído próprio. Toma um quantil alto como referência do que é "fala nesta
 * faixa" e corta bem abaixo dele.
 */
function limiar(amp) {
  const amostra = [];
  const passo = Math.max(1, Math.floor(amp.length / 20000));
  for (let i = 0; i < amp.length; i += passo) amostra.push(amp[i]);
  amostra.sort((a, b) => a - b);
  if (!amostra.length) return 0.05;
  const alto = amostra[Math.floor(amostra.length * 0.95)] || 0;
  const piso = amostra[Math.floor(amostra.length * 0.5)] || 0;
  // Entre o silêncio típico e os picos; nunca abaixo de um mínimo absoluto.
  return Math.max(0.02, piso + (alto - piso) * 0.18);
}

export async function segmentosDaFaixa(peaksPath) {
  const st = fs.statSync(peaksPath);
  const chave = `${peaksPath}:${st.mtimeMs}`;
  const guardado = cache.get(chave);
  if (guardado) return guardado;

  const { amp, secondsPerPeak, duration } = await lerNivel(peaksPath, POR_SEGUNDO);
  const entra = limiar(amp);
  const sai = entra * 0.6;      // histerese: evita picotar durante a fala

  const trechos = [];
  let dentro = false;
  let inicio = 0;

  for (let i = 0; i < amp.length; i++) {
    const t = i * secondsPerPeak;
    if (!dentro && amp[i] >= entra) { dentro = true; inicio = t; }
    else if (dentro && amp[i] < sai) { dentro = false; trechos.push([inicio, t]); }
  }
  if (dentro) trechos.push([inicio, duration]);

  // Junta trechos separados por pausas curtas, depois descarta os curtos demais.
  const juntos = [];
  for (const [de, ate] of trechos) {
    const ultimo = juntos[juntos.length - 1];
    if (ultimo && de - ultimo[1] < MIN_SILENCIO) ultimo[1] = ate;
    else juntos.push([de, ate]);
  }
  const finais = juntos
    .filter(([de, ate]) => ate - de >= MIN_TRECHO)
    .map(([de, ate]) => ({ de: Math.max(0, de - MARGEM), ate }));

  cache.set(chave, finais);
  if (cache.size > 40) cache.clear();
  return finais;
}

/**
 * Próximo (ou anterior) começo de trecho, considerando várias faixas juntas.
 * `dir` = 1 avança, -1 volta. Devolve null quando não há mais nada.
 */
export async function proximoInicio(caminhosPks, de, dir) {
  const listas = await Promise.all(caminhosPks.map((p) => segmentosDaFaixa(p)));
  const inicios = listas.flat().map((s) => s.de).sort((a, b) => a - b);
  if (!inicios.length) return null;

  // Tolerância pra não ficar preso no trecho em que a agulha já está.
  const tol = 0.05;
  if (dir > 0) return inicios.find((t) => t > de + tol) ?? null;
  for (let i = inicios.length - 1; i >= 0; i--) if (inicios[i] < de - tol) return inicios[i];
  return null;
}
