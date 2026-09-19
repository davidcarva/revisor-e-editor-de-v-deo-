// Timecode no cliente. Mesma matematica do servidor (server/premiere-xml.mjs) —
// se os dois divergirem, o que voce ve na tela nao bate com o que cai no Premiere.

export type Base = { timebase: number; ntsc: boolean; fps: number; drop: boolean };

/**
 * Base de tempo do arquivo.
 *
 * `drop` sai do SEPARADOR do timecode de origem (";" = drop-frame), nunca da taxa.
 * 29.97 non-drop-frame e comum, e presumir drop-frame nesse caso desloca tudo em
 * 2 frames por minuto — 36 segundos ao longo de 10 horas. Tem que casar
 * exatamente com baseDeSequencia() em server/premiere-xml.mjs: se a tela e o
 * export divergirem, voce marca num ponto e o Premiere recebe outro.
 */
export function baseDoArquivo(fps: number | null, tcInicial: string | null | undefined): Base {
  const b = semDrop(fps);
  const podeDrop = b.ntsc && (b.timebase === 30 || b.timebase === 60);
  return { ...b, drop: podeDrop && String(tcInicial ?? '').includes(';') };
}

function semDrop(fps: number | null): Base {
  if (!fps) return { timebase: 30, ntsc: false, fps: 30, drop: false };
  const ntsc: [number, number][] = [
    [24000 / 1001, 24], [30000 / 1001, 30], [60000 / 1001, 60], [120000 / 1001, 120],
  ];
  for (const [taxa, tb] of ntsc) {
    if (Math.abs(fps - taxa) < 0.01) return { timebase: tb, ntsc: true, fps: taxa, drop: false };
  }
  const tb = Math.round(fps);
  return { timebase: tb, ntsc: false, fps: tb, drop: false };
}

const ehDrop = (b: Base) => b.drop;
const p2 = (n: number) => String(n).padStart(2, '0');

export function framesParaTimecode(frames: number, b: Base): string {
  const df = ehDrop(b);
  let f = Math.max(0, Math.round(frames));
  if (df) {
    const drop = b.timebase === 60 ? 4 : 2;
    const por10 = b.timebase * 60 * 10 - drop * 9;
    const porMin = b.timebase * 60 - drop;
    const d = Math.floor(f / por10);
    let m = f % por10;
    if (m < drop) m += drop;
    f += drop * 9 * d + drop * Math.floor((m - drop) / porMin);
  }
  const ff = f % b.timebase;
  const ss = Math.floor(f / b.timebase) % 60;
  const mm = Math.floor(f / (b.timebase * 60)) % 60;
  const hh = Math.floor(f / (b.timebase * 60 * 60)) % 24;
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}${df ? ';' : ':'}${p2(ff)}`;
}

export function timecodeParaFrames(tc: string, b: Base): number {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(tc || '');
  if (!m) return 0;
  const [h, mi, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  let total = ((h * 60 + mi) * 60 + s) * b.timebase + f;
  if (ehDrop(b)) {
    const drop = b.timebase === 60 ? 4 : 2;
    const totalMin = h * 60 + mi;
    total -= drop * (totalMin - Math.floor(totalMin / 10));
  }
  return total;
}

/** Timecode de exibicao, ja somado ao timecode de origem do arquivo. */
export function tcDaOrigem(segundos: number, b: Base, tcInicial: string): string {
  return framesParaTimecode(
    timecodeParaFrames(tcInicial, b) + Math.round(segundos * b.fps), b);
}

/** "1:23:45" / "12:34.5" — leitura rapida, pra rotulo de regua e duracao. */
export function duracaoCurta(segundos: number, comDecimo = false): string {
  const s = Math.max(0, segundos);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const sTxt = comDecimo ? seg.toFixed(1).padStart(4, '0') : p2(Math.floor(seg));
  return h > 0 ? `${h}:${p2(m)}:${sTxt}` : `${m}:${sTxt}`;
}

/** Aceita "10:00:05:12", "1:23:45", "83.5" ou "90s" e devolve segundos na origem. */
export function interpretarTempo(txt: string, b: Base, tcInicial: string): number | null {
  const t = txt.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?s?$/.test(t)) return parseFloat(t);
  if (/^(\d+):(\d+):(\d+)[:;](\d+)$/.test(t)) {
    return (timecodeParaFrames(t, b) - timecodeParaFrames(tcInicial, b)) / b.fps;
  }
  const partes = t.split(':').map(Number);
  if (partes.some(Number.isNaN)) return null;
  if (partes.length === 2) return partes[0] * 60 + partes[1];
  if (partes.length === 3) return partes[0] * 3600 + partes[1] * 60 + partes[2];
  return null;
}

export const CORES: Record<string, string> = {
  amarelo: '#e8c33c',
  vermelho: '#e2564d',
  verde: '#5fbf7a',
  azul: '#4f9cf0',
  roxo: '#a97cf0',
  laranja: '#e8913c',
  ciano: '#3cc7d0',
};
export const corDoMarcador = (nome: string) => CORES[nome] ?? CORES.amarelo;
