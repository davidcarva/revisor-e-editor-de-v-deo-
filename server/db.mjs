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
