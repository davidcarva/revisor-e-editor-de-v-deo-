// Contabilidade do cache: quanto cada coisa ocupa, e como apagar o que não
// vale o espaço.
//
// Tudo o que o app gera fica em `<HOME>/cache/<sourceId>/`, e nada disso é
// insubstituível: some, e é só refazer. Mas "é só refazer" não ajuda quem está
// com o disco cheio e não faz ideia de onde foi parar o espaço — daí este
// módulo, que separa por tipo e diz o preço de cada um por hora de gravação.
//
// A hierarquia de valor, do mais caro pro mais barato de perder:
//
//   proxies       — caros em disco (GB por hora), rápidos de refazer com GPU
//   áudio isolado — médios, e é o que faz o mixer de várias faixas funcionar
//   picos/thumbs  — irrisórios, e refazê-los custa outra passada no arquivo
//   transcrição   — minúscula, mas leva MINUTOS de GPU: nunca entra em limpeza
import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from './db.mjs';
import * as ingest from './ingest.mjs';

/** Um arquivo do cache, classificado pelo que ele é. */
function tipoDoArquivo(nome) {
  if (/^proxy(-\d+)?\.mp4$/.test(nome)) return 'proxies';
  if (nome.endsWith('.part.mp4')) return 'proxies';        // sobra de conversão interrompida
  if (nome.endsWith('.transcricao.json')) return 'transcricao';
  if (nome.endsWith('.m4a')) return 'audio';
  if (nome.endsWith('.pks')) return 'picos';
  if (nome.endsWith('.jpg') || nome === 'thumbs.json') return 'miniaturas';
  return 'outros';
}

export const TIPOS_LIMPAVEIS = ['proxies', 'audio', 'picos', 'miniaturas'];

export const ROTULO = {
  proxies: 'versões convertidas (metade / um quarto)',
  audio: 'faixas de áudio isoladas',
  picos: 'ondas da timeline',
  miniaturas: 'miniaturas da régua',
  transcricao: 'transcrições',
  outros: 'outros',
};

async function medirPasta(dir) {
  const porTipo = {};
  const arquivos = [];
  let entradas;
  try { entradas = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return { porTipo, total: 0, arquivos }; }

  for (const e of entradas) {
    const cheio = path.join(dir, e.name);
    if (e.isDirectory()) {
      // `thumbs/` é a única subpasta; tudo dentro dela é miniatura.
      const dentro = await medirPasta(cheio);
      for (const [t, b] of Object.entries(dentro.porTipo)) {
        porTipo[e.name === 'thumbs' ? 'miniaturas' : t] =
          (porTipo[e.name === 'thumbs' ? 'miniaturas' : t] || 0) + b;
      }
      arquivos.push(...dentro.arquivos);
      continue;
    }
    let bytes = 0;
    try { bytes = (await fs.stat(cheio)).size; } catch { continue; }
    const tipo = tipoDoArquivo(e.name);
    porTipo[tipo] = (porTipo[tipo] || 0) + bytes;
    arquivos.push({ caminho: cheio, tipo, bytes });
  }
  const total = Object.values(porTipo).reduce((a, b) => a + b, 0);
  return { porTipo, total, arquivos };
}

/**
 * Onde o espaço foi parar, por fonte e por tipo.
 *
 * As taxas "por hora" saem do que JÁ existe em disco, não de uma constante
 * chutada: assim a estimativa acompanha a sua câmera, o seu codec e a sua
 * quantidade de microfones, em vez de mentir com um número médio da internet.
 */
export async function resumo() {
  const raiz = ingest.cacheRoot();
  let dirs = [];
  try { dirs = await fs.readdir(raiz, { withFileTypes: true }); } catch { /* cache vazio */ }

  const fontes = [];
  const porTipo = {};
  let total = 0;
  let orfaos = 0;
  // Horas de gravação que cada tipo já cobriu, pra derivar o custo por hora.
  const horas = {};
  // E o mesmo em bytes do arquivo original: a biblioteca só sabe a duração de
  // quem já passou pelo ffprobe, mas o TAMANHO ela sabe de todo mundo. É a
  // régua que sobra quando a outra não existe.
  const originais = {};

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(raiz, d.name);
    const medida = await medirPasta(dir);
    total += medida.total;

    // `biblioteca/` guarda as capas da página inicial, não é de uma fonte. Tem
    // que sair da conta ANTES de somar por tipo: os arquivos lá são .jpg, e
    // somados como "miniaturas" inflariam o custo por hora da régua.
    if (d.name === 'biblioteca') {
      porTipo.posters = (porTipo.posters || 0) + medida.total;
      continue;
    }

    for (const [t, b] of Object.entries(medida.porTipo)) porTipo[t] = (porTipo[t] || 0) + b;

    const id = Number(d.name);
    const src = Number.isInteger(id) ? db.getSource(id) : null;
    if (!src) { orfaos += medida.total; continue; }

    const h = (src.duration_s || 0) / 3600;
    for (const t of Object.keys(medida.porTipo)) {
      if (h > 0) horas[t] = (horas[t] || 0) + h;
      if (src.size_bytes > 0) originais[t] = (originais[t] || 0) + src.size_bytes;
    }
    fontes.push({
      id,
      nome: src.name,
      caminho: src.path,
      duracao: src.duration_s,
      bytesOriginal: src.size_bytes,
      total: medida.total,
      porTipo: medida.porTipo,
      existe: !!src.path,
    });
  }

  fontes.sort((a, b) => b.total - a.total);

  const porHora = {};
  const porByte = {};
  for (const t of Object.keys(porTipo)) {
    if (horas[t] > 0.01) porHora[t] = Math.round(porTipo[t] / horas[t]);
    if (originais[t] > 0) porByte[t] = porTipo[t] / originais[t];
  }

  return { raiz, total, porTipo, porHora, porByte, orfaos, fontes };
}

/**
 * Apaga tipos de arquivo de fontes específicas (ou de todas, sem `ids`).
 *
 * O banco é atualizado junto: um `proxy_path` apontando pra um arquivo que não
 * existe mais faria o app oferecer uma qualidade fantasma.
 */
export async function limpar({ ids = null, tipos = ['proxies'] } = {}) {
  const pedidos = tipos.filter((t) => TIPOS_LIMPAVEIS.includes(t));
  if (!pedidos.length) throw new Error('nada a limpar (a transcrição nunca é apagada aqui)');

  const raiz = ingest.cacheRoot();
  let dirs = [];
  try { dirs = await fs.readdir(raiz, { withFileTypes: true }); } catch { return { apagados: 0, bytes: 0 }; }

  let apagados = 0;
  let bytes = 0;

  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'biblioteca') continue;
    const id = Number(d.name);
    if (!Number.isInteger(id)) continue;
    if (ids && !ids.includes(id)) continue;
    // Apagar debaixo de uma conversão em andamento deixa meio arquivo pra trás.
    if (ingest.isRunning(id)) continue;

    const dir = path.join(raiz, d.name);
    const { arquivos } = await medirPasta(dir);
    for (const a of arquivos) {
      if (!pedidos.includes(a.tipo)) continue;
      try { await fs.rm(a.caminho, { force: true }); apagados++; bytes += a.bytes; }
      catch { /* em uso; fica pra próxima */ }
    }
    if (pedidos.includes('miniaturas')) {
      await fs.rm(path.join(dir, 'thumbs'), { recursive: true, force: true }).catch(() => {});
    }

    db.limparAssets(id, { proxy: pedidos.includes('proxies'), thumbs: pedidos.includes('miniaturas') });
    for (const t of db.listTracks(id)) {
      db.limparAssetsDaFaixa(t.id, {
        picos: pedidos.includes('picos'),
        audio: pedidos.includes('audio'),
      });
    }
  }
  return { apagados, bytes };
}

/** Pastas de cache cujo registro no banco sumiu — espaço que nada reclama. */
export async function limparOrfaos() {
  const raiz = ingest.cacheRoot();
  let dirs = [];
  try { dirs = await fs.readdir(raiz, { withFileTypes: true }); } catch { return { apagados: 0, bytes: 0 }; }

  let apagados = 0;
  let bytes = 0;
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'biblioteca') continue;
    const id = Number(d.name);
    if (Number.isInteger(id) && db.getSource(id)) continue;
    const dir = path.join(raiz, d.name);
    const { total } = await medirPasta(dir);
    try { await fs.rm(dir, { recursive: true, force: true }); apagados++; bytes += total; }
    catch { /* em uso */ }
  }
  return { apagados, bytes };
}
