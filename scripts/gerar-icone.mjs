// Gera build/revisor.ico (e um .png de conferência) sem nenhuma dependência:
// desenha num buffer RGBA, codifica PNG com o zlib do Node e embrulha no
// contêiner ICO. Windows Vista+ aceita PNG dentro de .ico.
//
//   node scripts/gerar-icone.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TAMANHOS = [256, 128, 64, 48, 32, 16];
const SUPER = 4;   // desenha 4x maior e reduz: é o que dá o antisserrilhado

// ------------------------------------------------------------------ desenho

const cor = (hex, a = 255) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
  a,
];

function tela(n) {
  return { n, px: new Uint8ClampedArray(n * n * 4) };
}

/** Mistura um pixel respeitando alfa (source-over). */
function ponto(t, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= t.n || y >= t.n || a === 0) return;
  const i = (y * t.n + x) * 4;
  if (a === 255) {
    t.px[i] = r; t.px[i + 1] = g; t.px[i + 2] = b; t.px[i + 3] = 255;
    return;
  }
  const af = a / 255;
  const ad = t.px[i + 3] / 255;
  const ao = af + ad * (1 - af);
  t.px[i] = (r * af + t.px[i] * ad * (1 - af)) / ao;
  t.px[i + 1] = (g * af + t.px[i + 1] * ad * (1 - af)) / ao;
  t.px[i + 2] = (b * af + t.px[i + 2] * ad * (1 - af)) / ao;
  t.px[i + 3] = ao * 255;
}

/** Retângulo de cantos arredondados, em coordenadas 0..1. */
function retangulo(t, x0, y0, x1, y1, raio, c) {
  const s = t.n;
  const [ax, ay, bx, by, r] = [x0 * s, y0 * s, x1 * s, y1 * s, raio * s];
  for (let y = Math.floor(ay); y < Math.ceil(by); y++) {
    for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      // Distância até o retângulo interno encolhido pelo raio.
      const dx = Math.max(ax + r - x, 0, x - (bx - r));
      const dy = Math.max(ay + r - y, 0, y - (by - r));
      if (dx * dx + dy * dy <= r * r || (dx === 0 && dy === 0)) ponto(t, x, y, c);
    }
  }
}

/**
 * O ícone: uma forma de onda azul cortada por uma agulha vermelha. É literalmente
 * o que o app faz, e a agulha vermelha lê bem mesmo em 16 px.
 */
function desenhar(n) {
  const t = tela(n);
  const fundo = cor('#151a23');
  const borda = cor('#2b3444');
  const onda = cor('#4f9cf0');
  const ondaFraca = cor('#38618f');
  const agulha = cor('#ff4d4f');

  retangulo(t, 0, 0, 1, 1, 0.19, borda);
  retangulo(t, 0.022, 0.022, 0.978, 0.978, 0.175, fundo);

  // Barras da onda: alturas assimétricas, senão parece um gráfico de barras.
  const alturas = [0.30, 0.58, 0.88, 0.66, 0.95, 0.44, 0.24];
  const larguraBarra = 0.072;
  const vao = (0.72 - larguraBarra) / (alturas.length - 1);
  alturas.forEach((h, i) => {
    const x = 0.14 + i * vao;
    const meio = 0.5;
    const meiaAltura = (h * 0.62) / 2;
    // Destaca a barra 2, e não a 4: a 4 fica atrás da agulha e o azul vazando
    // pelas bordas faz a linha vermelha parecer contornada.
    retangulo(t, x, meio - meiaAltura, x + larguraBarra, meio + meiaAltura,
      larguraBarra / 2, i === 2 ? onda : ondaFraca);
  });

  // A agulha cruza tudo, com a cabeça triangular do topo.
  retangulo(t, 0.585, 0.10, 0.625, 0.90, 0.02, agulha);
  const s = t.n;
  const meiaLargura = 0.055 * s;
  const centro = 0.605 * s;
  const topo = 0.10 * s;
  for (let y = 0; y < 0.075 * s; y++) {
    const w = meiaLargura * (1 - y / (0.075 * s));
    for (let x = Math.floor(centro - w); x <= Math.ceil(centro + w); x++) {
      ponto(t, x, Math.floor(topo + y), agulha);
    }
  }
  return t;
}

/** Reduz por média de blocos SUPER×SUPER — o antisserrilhado. */
function reduzir(grande, n) {
  const t = tela(n);
  const k = grande.n / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) {
          const i = ((y * k + sy) * grande.n + (x * k + sx)) * 4;
          const af = grande.px[i + 3] / 255;
          r += grande.px[i] * af; g += grande.px[i + 1] * af; b += grande.px[i + 2] * af;
          a += grande.px[i + 3];
        }
      }
      const total = k * k;
      const alfaMedio = a / total;
      const peso = alfaMedio > 0 ? (a / 255) : 1;
      const j = (y * n + x) * 4;
      t.px[j] = r / peso; t.px[j + 1] = g / peso; t.px[j + 2] = b / peso;
      t.px[j + 3] = alfaMedio;
    }
  }
  return t;
}

// -------------------------------------------------------------- codificação

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

function png(t) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(t.n, 0);
  ihdr.writeUInt32BE(t.n, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // RGBA
  // Cada linha leva um byte de filtro (0 = nenhum) na frente.
  const bruto = Buffer.alloc(t.n * (t.n * 4 + 1));
  for (let y = 0; y < t.n; y++) {
    const destino = y * (t.n * 4 + 1);
    bruto[destino] = 0;
    Buffer.from(t.px.buffer, y * t.n * 4, t.n * 4).copy(bruto, destino + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(bruto, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(imagens) {
  const cabecalho = Buffer.alloc(6);
  cabecalho.writeUInt16LE(0, 0);
  cabecalho.writeUInt16LE(1, 2);            // 1 = ícone
  cabecalho.writeUInt16LE(imagens.length, 4);

  const entradas = Buffer.alloc(16 * imagens.length);
  let offset = 6 + entradas.length;
  imagens.forEach(({ n, dados }, i) => {
    const at = i * 16;
    entradas[at] = n >= 256 ? 0 : n;        // 0 significa 256
    entradas[at + 1] = n >= 256 ? 0 : n;
    entradas[at + 4] = 1;                   // planos
    entradas.writeUInt16LE(32, at + 6);     // bits por pixel
    entradas.writeUInt32LE(dados.length, at + 8);
    entradas.writeUInt32LE(offset, at + 12);
    offset += dados.length;
  });

  return Buffer.concat([cabecalho, entradas, ...imagens.map((i) => i.dados)]);
}

// ------------------------------------------------------------------- saída

const destino = path.join(import.meta.dirname, '..', 'build');
fs.mkdirSync(destino, { recursive: true });

const imagens = TAMANHOS.map((n) => ({ n, dados: png(reduzir(desenhar(n * SUPER), n)) }));
fs.writeFileSync(path.join(destino, 'revisor.ico'), ico(imagens));
fs.writeFileSync(path.join(destino, 'revisor.png'), imagens[0].dados);

console.log(`ícone gerado: ${TAMANHOS.join(', ')} px`);
console.log(`  ${path.join(destino, 'revisor.ico')}`);
