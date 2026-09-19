// Estado do projeto em SQLite (node:sqlite, embutido no Node 24 — sem build nativo).
// SQLite e nao JSON porque um projeto real tem dezenas de milhares de marcadores e
// linhas de transcricao: reescrever um JSON inteiro a cada autosave trava a UI e
// corrompe o arquivo se a energia cair no meio da escrita.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  duration_s     REAL NOT NULL DEFAULT 0,
  fps            REAL,
  width          INTEGER,
  height         INTEGER,
  start_timecode TEXT NOT NULL DEFAULT '00:00:00:00',
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  proxy_path     TEXT,
  thumbs_path    TEXT,
  status         TEXT NOT NULL DEFAULT 'novo',
  progress       REAL NOT NULL DEFAULT 0,
  stage          TEXT,
  error          TEXT,
  probe_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  stream_index INTEGER NOT NULL,
  ord          INTEGER NOT NULL,
  label        TEXT NOT NULL,
  channels     INTEGER NOT NULL DEFAULT 1,
  sample_rate  INTEGER NOT NULL DEFAULT 48000,
  peaks_path   TEXT,
  audio_path   TEXT,
  nav          INTEGER NOT NULL DEFAULT 1,
  transc_status    TEXT NOT NULL DEFAULT 'nao',
  transc_progresso REAL NOT NULL DEFAULT 0,
  transc_erro      TEXT,
  idioma           TEXT,
  gain_db      REAL NOT NULL DEFAULT 0,
  muted        INTEGER NOT NULL DEFAULT 0,
  solo         INTEGER NOT NULL DEFAULT 0,
  color        TEXT,
  UNIQUE (source_id, kind, stream_index)
);

-- Biblioteca: o indice de midia do computador.
--
-- Separada da tabela sources de proposito: sources e o que voce esta revisando,
-- com proxy e picos em disco; a biblioteca e so um catalogo do que existe nas
-- pastas, barato de manter. Um arquivo pode estar na biblioteca sem nunca ter
-- virado uma fonte — que e o caso da esmagadora maioria.
CREATE TABLE IF NOT EXISTS pastas (
  caminho   TEXT PRIMARY KEY,
  adicionada TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS biblioteca (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  caminho    TEXT NOT NULL UNIQUE,
  nome       TEXT NOT NULL,
  pasta      TEXT NOT NULL,
  ext        TEXT NOT NULL,
  tipo       TEXT NOT NULL,              -- 'video' | 'audio'
  tamanho    INTEGER NOT NULL DEFAULT 0,
  modificado REAL NOT NULL DEFAULT 0,    -- mtimeMs: muda -> miniatura refeita
  duracao    REAL,
  largura    INTEGER,
  altura     INTEGER,
  faixas_audio INTEGER,
  poster     TEXT,
  sondado    INTEGER NOT NULL DEFAULT 0, -- ja passou pelo ffprobe?
  ausente    INTEGER NOT NULL DEFAULT 0, -- sumiu do disco na ultima varredura
  visto_em   TEXT,                       -- ultima vez aberto no app
  favorito   INTEGER NOT NULL DEFAULT 0,
  revisado   INTEGER NOT NULL DEFAULT 0,
  criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bib_pasta ON biblioteca(pasta, nome);
CREATE INDEX IF NOT EXISTS idx_bib_visto ON biblioteca(visto_em DESC);
CREATE INDEX IF NOT EXISTS idx_bib_mod ON biblioteca(modificado DESC);

-- Historico de operacoes que mexeram em disco, pra poder desfazer o ultimo lote.
-- Mover e renomear sao as unicas coisas que este app faz nos SEUS arquivos;
-- fazer isso sem volta seria irresponsavel.
CREATE TABLE IF NOT EXISTS operacoes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo     TEXT NOT NULL,
  quando   TEXT NOT NULL DEFAULT (datetime('now')),
  desfeita INTEGER NOT NULL DEFAULT 0,
  passos   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcricao (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  t_in      REAL NOT NULL,
  t_out     REAL NOT NULL,
  texto     TEXT NOT NULL,
  palavras  TEXT
);
CREATE INDEX IF NOT EXISTS idx_transc_faixa ON transcricao(track_id, t_in);
CREATE INDEX IF NOT EXISTS idx_transc_fonte ON transcricao(source_id, t_in);

-- Busca textual. O modo remove_diacritics 2 faz "acao" encontrar "ação", que em
-- portugues e a diferenca entre a busca servir e nao servir.
CREATE VIRTUAL TABLE IF NOT EXISTS transcricao_fts USING fts5(
  texto, content='transcricao', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);
CREATE TRIGGER IF NOT EXISTS transcricao_inseriu AFTER INSERT ON transcricao BEGIN
  INSERT INTO transcricao_fts(rowid, texto) VALUES (new.id, new.texto);
END;
CREATE TRIGGER IF NOT EXISTS transcricao_apagou AFTER DELETE ON transcricao BEGIN
  INSERT INTO transcricao_fts(transcricao_fts, rowid, texto)
    VALUES ('delete', old.id, old.texto);
END;

CREATE TABLE IF NOT EXISTS markers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  track_id   INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  t_in       REAL NOT NULL,
  t_out      REAL,
  text       TEXT NOT NULL DEFAULT '',
  comment    TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'amarelo',
  kind       TEXT NOT NULL DEFAULT 'log',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_markers_pos ON markers(source_id, t_in);

`;

let db = null;
let dbFile = null;

/**
 * Colunas acrescentadas depois que ja existiam projetos salvos.
 * `CREATE TABLE IF NOT EXISTS` nao mexe numa tabela que ja existe, entao sem isto
 * um banco antigo continuaria sem a coluna e toda consulta quebraria.
 */
const MIGRACOES = [
  ['tracks', 'nav', 'INTEGER NOT NULL DEFAULT 1'],
  ['tracks', 'transc_status', "TEXT NOT NULL DEFAULT 'nao'"],
  ['tracks', 'transc_progresso', 'REAL NOT NULL DEFAULT 0'],
  ['tracks', 'transc_erro', 'TEXT'],
  ['tracks', 'idioma', 'TEXT'],
  ['biblioteca', 'favorito', 'INTEGER NOT NULL DEFAULT 0'],
  ['biblioteca', 'revisado', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrar(d) {
  for (const [tabela, coluna, tipo] of MIGRACOES) {
    const existe = d.prepare(`PRAGMA table_info(${tabela})`).all()
      .some((c) => c.name === coluna);
    if (!existe) d.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

export function open(file) {
  if (db) db.close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrar(db);
  dbFile = file;
  return db;
}

/** Fecha o banco. O WAL segura arquivos abertos; sem isto, apagar o diretorio
 *  do projeto falha com EBUSY no Windows. */
export function fechar() {
  if (db) { db.close(); db = null; }
}

export function handle() {
  if (!db) throw new Error('banco nao aberto');
  return db;
}

export const dbPath = () => dbFile;

/** node:sqlite devolve rowid como BigInt em alguns casos; normaliza pra Number. */
const rid = (r) => Number(r.lastInsertRowid);

// ---------------------------------------------------------------- sources

export function upsertSource(row) {
  const d = handle();
  const existing = d.prepare('SELECT id FROM sources WHERE path = ?').get(row.path);
  if (existing) {
    d.prepare(`UPDATE sources SET name=?, duration_s=?, fps=?, width=?, height=?,
               start_timecode=?, size_bytes=?, probe_json=? WHERE id=?`)
      .run(row.name, row.duration_s, row.fps, row.width, row.height,
           row.start_timecode, row.size_bytes, row.probe_json, existing.id);
    return Number(existing.id);
  }
  const r = d.prepare(`INSERT INTO sources
      (path, name, duration_s, fps, width, height, start_timecode, size_bytes, probe_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.path, row.name, row.duration_s, row.fps, row.width, row.height,
         row.start_timecode, row.size_bytes, row.probe_json);
  return rid(r);
}

export const getSource = (id) => handle().prepare('SELECT * FROM sources WHERE id=?').get(id);
export const listSources = () => handle().prepare('SELECT * FROM sources ORDER BY id DESC').all();

export function setSourceStatus(id, { status, progress, stage, error }) {
  const cur = getSource(id);
  if (!cur) return;
  handle().prepare('UPDATE sources SET status=?, progress=?, stage=?, error=? WHERE id=?')
    .run(status ?? cur.status, progress ?? cur.progress, stage ?? cur.stage,
         error ?? cur.error, id);
}

export function setSourceAssets(id, { proxy_path, thumbs_path }) {
  const cur = getSource(id);
  handle().prepare('UPDATE sources SET proxy_path=?, thumbs_path=? WHERE id=?')
    .run(proxy_path ?? cur.proxy_path, thumbs_path ?? cur.thumbs_path, id);
}

export function deleteSource(id) {
  handle().prepare('DELETE FROM sources WHERE id=?').run(id);
}

// ---------------------------------------------------------------- tracks

export function upsertTrack(t) {
  const d = handle();
  const ex = d.prepare('SELECT id FROM tracks WHERE source_id=? AND kind=? AND stream_index=?')
    .get(t.source_id, t.kind, t.stream_index);
  if (ex) {
    // `label` de proposito fora do UPDATE: se voce renomeou a faixa para
    // "Mic do convidado", reprocessar o arquivo nao pode devolver ela pra
    // "Faixa 2". O nome e seu; o resto vem do arquivo.
    d.prepare('UPDATE tracks SET ord=?, channels=?, sample_rate=?, color=? WHERE id=?')
      .run(t.ord, t.channels, t.sample_rate, t.color ?? null, ex.id);
    return Number(ex.id);
  }
  const r = d.prepare(`INSERT INTO tracks
      (source_id, kind, stream_index, ord, label, channels, sample_rate, color)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(t.source_id, t.kind, t.stream_index, t.ord, t.label,
         t.channels, t.sample_rate, t.color ?? null);
  return rid(r);
}

export const listTracks = (sourceId) =>
  handle().prepare('SELECT * FROM tracks WHERE source_id=? ORDER BY kind DESC, ord').all(sourceId);

export const setTrackAssets = (id, { peaks_path, audio_path }) => {
  const cur = handle().prepare('SELECT * FROM tracks WHERE id=?').get(id);
  handle().prepare('UPDATE tracks SET peaks_path=?, audio_path=? WHERE id=?')
    .run(peaks_path ?? cur.peaks_path, audio_path ?? cur.audio_path, id);
};

export function updateTrack(id, patch) {
  const d = handle();
  const cur = d.prepare('SELECT * FROM tracks WHERE id=?').get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  d.prepare('UPDATE tracks SET label=?, gain_db=?, muted=?, solo=?, color=?, nav=? WHERE id=?')
    .run(next.label, next.gain_db, next.muted ? 1 : 0, next.solo ? 1 : 0, next.color,
         next.nav ? 1 : 0, id);
  return d.prepare('SELECT * FROM tracks WHERE id=?').get(id);
}

// ---------------------------------------------------------------- markers

export function addMarker(m) {
  const r = handle().prepare(`INSERT INTO markers
      (source_id, track_id, t_in, t_out, text, comment, color, kind)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(m.source_id, m.track_id ?? null, m.t_in, m.t_out ?? null,
         m.text ?? '', m.comment ?? '', m.color ?? 'amarelo', m.kind ?? 'log');
  return getMarker(rid(r));
}

export const getMarker = (id) => handle().prepare('SELECT * FROM markers WHERE id=?').get(id);

export const listMarkers = (sourceId) =>
  handle().prepare('SELECT * FROM markers WHERE source_id=? ORDER BY t_in, id').all(sourceId);

export function updateMarker(id, patch) {
  const cur = getMarker(id);
  if (!cur) return null;
  const n = { ...cur, ...patch };
  handle().prepare(`UPDATE markers SET t_in=?, t_out=?, text=?, comment=?, color=?, kind=?,
                    track_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(n.t_in, n.t_out, n.text, n.comment, n.color, n.kind, n.track_id, id);
  return getMarker(id);
}

export const deleteMarker = (id) =>
  handle().prepare('DELETE FROM markers WHERE id=?').run(id);


// ------------------------------------------------------------ biblioteca

export const listarPastas = () =>
  handle().prepare('SELECT * FROM pastas ORDER BY caminho').all();

export const adicionarPasta = (caminho) =>
  handle().prepare('INSERT OR IGNORE INTO pastas (caminho) VALUES (?)').run(caminho);

export function removerPasta(caminho) {
  const d = handle();
  d.prepare('DELETE FROM pastas WHERE caminho=?').run(caminho);
  // Tira da biblioteca o que vivia sob essa pasta, mas nao toca em disco.
  d.prepare('DELETE FROM biblioteca WHERE caminho LIKE ?').run(`${caminho}%`);
}

/**
 * Insere ou atualiza um arquivo do catalogo.
 * Se o arquivo mudou (mtime), invalida a sondagem e a miniatura — senao a grade
 * mostraria o quadro de uma versao que nao existe mais.
 */
export function upsertMidia(m) {
  const d = handle();
  const atual = d.prepare('SELECT id, modificado FROM biblioteca WHERE caminho=?').get(m.caminho);
  if (atual) {
    const mudou = Math.abs(Number(atual.modificado) - m.modificado) > 1;
    d.prepare(`UPDATE biblioteca SET nome=?, pasta=?, ext=?, tipo=?, tamanho=?,
               modificado=?, ausente=0${mudou ? ', sondado=0, poster=NULL' : ''} WHERE id=?`)
      .run(m.nome, m.pasta, m.ext, m.tipo, m.tamanho, m.modificado, atual.id);
    return Number(atual.id);
  }
  const r = d.prepare(`INSERT INTO biblioteca
      (caminho, nome, pasta, ext, tipo, tamanho, modificado)
      VALUES (?,?,?,?,?,?,?)`)
    .run(m.caminho, m.nome, m.pasta, m.ext, m.tipo, m.tamanho, m.modificado);
  return Number(r.lastInsertRowid);
}

export const getMidia = (id) =>
  handle().prepare('SELECT * FROM biblioteca WHERE id=?').get(id);

export const getMidiaPorCaminho = (caminho) =>
  handle().prepare('SELECT * FROM biblioteca WHERE caminho=?').get(caminho);

export function setSondagem(id, s) {
  handle().prepare(`UPDATE biblioteca SET duracao=?, largura=?, altura=?,
                    faixas_audio=?, sondado=1 WHERE id=?`)
    .run(s.duracao ?? null, s.largura ?? null, s.altura ?? null,
         s.faixas_audio ?? null, id);
}

export const setPoster = (id, caminho) =>
  handle().prepare('UPDATE biblioteca SET poster=? WHERE id=?').run(caminho, id);

export function setSinalizador(id, campo, valor) {
  if (campo !== 'favorito' && campo !== 'revisado') throw new Error('campo invalido');
  handle().prepare(`UPDATE biblioteca SET ${campo}=? WHERE id=?`).run(valor ? 1 : 0, id);
  return getMidia(id);
}

/**
 * Registra que um arquivo mudou de lugar ou de nome.
 *
 * Atualiza a biblioteca E a tabela sources: se o arquivo ja foi aberto pra
 * revisao, o caminho guardado la apontaria pro vazio depois da mudanca, e o
 * proxy, os marcadores e a transcricao ficariam orfaos de um arquivo que existe.
 */
export function reapontarArquivo(deCaminho, paraCaminho) {
  const d = handle();
  const pasta = path.dirname(paraCaminho);
  const nome = path.parse(paraCaminho).name;
  d.prepare('UPDATE biblioteca SET caminho=?, pasta=?, nome=? WHERE caminho=?')
    .run(paraCaminho, pasta, nome, deCaminho);
  d.prepare('UPDATE sources SET path=?, name=? WHERE path=?')
    .run(paraCaminho, path.basename(paraCaminho), deCaminho);
}

export function registrarOperacao(tipo, passos) {
  const r = handle().prepare('INSERT INTO operacoes (tipo, passos) VALUES (?,?)')
    .run(tipo, JSON.stringify(passos));
  return rid(r);
}

export const ultimaOperacao = () =>
  handle().prepare('SELECT * FROM operacoes WHERE desfeita=0 ORDER BY id DESC LIMIT 1').get();

export const marcarDesfeita = (id) =>
  handle().prepare('UPDATE operacoes SET desfeita=1 WHERE id=?').run(id);

export const marcarVisto = (caminho) =>
  handle().prepare("UPDATE biblioteca SET visto_em=datetime('now') WHERE caminho=?").run(caminho);

export const marcarAusentes = (pasta) =>
  handle().prepare('UPDATE biblioteca SET ausente=1 WHERE pasta LIKE ?').run(`${pasta}%`);

/**
 * Grade da inicial.
 *
 * `recursivo: false` mostra so os arquivos DIRETAMENTE na pasta — e o que faz
 * navegar por pastas significar alguma coisa. Com `true`, tudo que estiver
 * abaixo dela entra junto.
 */
export function listarMidia({
  q = '', pasta = '', ordem = 'modificado', limite = 120, offset = 0, recursivo = true,
  filtro = '',
} = {}) {
  const cond = ['ausente = 0'];
  const args = [];
  if (filtro === 'favoritos') cond.push('favorito = 1');
  if (filtro === 'naoRevisados') cond.push('revisado = 0');
  if (filtro === 'revisados') cond.push('revisado = 1');
  if (q) { cond.push('nome LIKE ?'); args.push(`%${q}%`); }
  if (pasta) {
    if (recursivo) { cond.push('pasta LIKE ?'); args.push(`${pasta}%`); }
    else { cond.push('pasta = ?'); args.push(pasta); }
  }
  if (ordem === 'vistos') cond.push('visto_em IS NOT NULL');

  const ordenar = {
    vistos: 'visto_em DESC',
    modificado: 'modificado DESC',
    antigos: 'modificado ASC',
    nome: 'nome COLLATE NOCASE',
    duracao: 'duracao DESC NULLS LAST',
    tamanho: 'tamanho DESC',
  }[ordem] ?? 'modificado DESC';

  args.push(limite, offset);
  return handle().prepare(`SELECT * FROM biblioteca WHERE ${cond.join(' AND ')}
    ORDER BY ${ordenar} LIMIT ? OFFSET ?`).all(...args);
}

/**
 * Subpastas imediatas de um caminho, com quantos arquivos cada uma guarda
 * (contando o que esta aninhado mais fundo).
 *
 * Sai do proprio catalogo, sem tocar o disco: a tabela ja sabe a pasta de cada
 * arquivo, entao e so agrupar pelo primeiro trecho do caminho relativo.
 */
export function subpastasDe(base, sep = '\\') {
  const linhas = handle().prepare(
    `SELECT pasta, COUNT(*) AS n FROM biblioteca
     WHERE ausente = 0 AND pasta LIKE ? GROUP BY pasta`).all(`${base}%`);

  const filhas = new Map();
  let diretos = 0;
  for (const l of linhas) {
    if (l.pasta === base) { diretos = Number(l.n); continue; }
    const rel = l.pasta.slice(base.length).replace(/^[\\/]+/, '');
    if (!rel) { diretos = Number(l.n); continue; }
    const primeiro = rel.split(/[\\/]/)[0];
    const caminho = base.replace(/[\\/]+$/, '') + sep + primeiro;
    filhas.set(caminho, (filhas.get(caminho) ?? 0) + Number(l.n));
  }

  return {
    diretos,
    subpastas: [...filhas.entries()]
      .map(([caminho, arquivos]) => ({ caminho, nome: caminho.split(/[\\/]/).pop(), arquivos }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
  };
}

export function contarMidia() {
  const d = handle();
  return {
    total: d.prepare('SELECT COUNT(*) AS n FROM biblioteca WHERE ausente=0').get().n,
    vistos: d.prepare('SELECT COUNT(*) AS n FROM biblioteca WHERE visto_em IS NOT NULL AND ausente=0').get().n,
    semPoster: d.prepare("SELECT COUNT(*) AS n FROM biblioteca WHERE poster IS NULL AND tipo='video' AND ausente=0").get().n,
  };
}

// ------------------------------------------------------------ transcricao

export const getTrack = (id) =>
  handle().prepare('SELECT * FROM tracks WHERE id=?').get(id);

/**
 * Desfaz estados de transcricao que ficaram no ar.
 *
 * A fila vive na memoria do servidor: se ele cai (ou e reiniciado) no meio de uma
 * faixa, o processo Python morre junto mas a linha no banco continua dizendo
 * "transcrevendo" — e a faixa fica travada nesse estado para sempre, sem nada
 * rodando. Na subida, qualquer estado em curso volta para "nao".
 */
export function limparTranscricoesInterrompidas() {
  const r = handle().prepare(`UPDATE tracks SET transc_status='nao', transc_progresso=0
    WHERE transc_status IN ('na fila','carregando modelo','transcrevendo')`).run();
  return Number(r.changes);
}

export function setTranscStatus(id, { status, progresso, erro, idioma }) {
  const cur = getTrack(id);
  if (!cur) return;
  handle().prepare(`UPDATE tracks SET transc_status=?, transc_progresso=?,
                    transc_erro=?, idioma=? WHERE id=?`)
    .run(status ?? cur.transc_status, progresso ?? cur.transc_progresso,
         erro === undefined ? cur.transc_erro : erro,
         idioma ?? cur.idioma, id);
}

/** Substitui a transcricao inteira da faixa, numa transacao so. */
export function gravarTranscricao(trackId, sourceId, segmentos) {
  const d = handle();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM transcricao WHERE track_id=?').run(trackId);
    const ins = d.prepare(`INSERT INTO transcricao
      (track_id, source_id, ord, t_in, t_out, texto, palavras)
      VALUES (?,?,?,?,?,?,?)`);
    segmentos.forEach((s, i) => {
      ins.run(trackId, sourceId, i, s.de, s.ate, s.texto,
        s.palavras?.length ? JSON.stringify(s.palavras) : null);
    });
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return segmentos.length;
}

export const contarTranscricao = (sourceId) =>
  handle().prepare('SELECT COUNT(*) AS n FROM transcricao WHERE source_id=?').get(sourceId).n;

export const trechosNaJanela = (sourceId, de, ate, limite = 4000) =>
  handle().prepare(`SELECT id, track_id, t_in, t_out, texto FROM transcricao
                    WHERE source_id=? AND t_out >= ? AND t_in <= ?
                    ORDER BY t_in LIMIT ?`).all(sourceId, de, ate, limite);

export const palavrasDoTrecho = (id) =>
  handle().prepare('SELECT palavras FROM transcricao WHERE id=?').get(id);

/** Busca textual; devolve os trechos em ordem de tempo, nao de relevancia. */
export function buscarTranscricao(sourceId, consulta, limite = 500) {
  return handle().prepare(`
    SELECT t.id, t.track_id, t.t_in, t.t_out, t.texto
    FROM transcricao_fts f
    JOIN transcricao t ON t.id = f.rowid
    WHERE f.transcricao_fts MATCH ? AND t.source_id = ?
    ORDER BY t.t_in LIMIT ?`).all(consulta, sourceId, limite);
}
