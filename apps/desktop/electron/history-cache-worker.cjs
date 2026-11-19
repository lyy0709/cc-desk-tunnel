const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { mkdirSync, statSync, chmodSync } = require('node:fs');
const { join } = require('node:path');

const { historyPageStart } = require('./history-page.mjs');
const pageColumns = `json_extract(data, '$.runId'), CASE WHEN json_extract(data, '$.payload.type') = 'message.user' THEN CASE WHEN json_extract(data, '$.payload.continued') THEN 2 ELSE 1 END ELSE 0 END, octet_length(data)`;
let database, file;

function open(url) {
  const address = new URL(url);
  if (
    !['ws:', 'wss:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('缓存需要有效的服务地址。');
  const name = createHash('sha256').update(address.href).digest('hex') + '.sqlite';
  const target = join(workerData.directory, name);
  if (file === target) return;
  database?.close();
  database = undefined;
  file = undefined;
  mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(target);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version > 1)
      throw new Error('此缓存由较新客户端创建，请升级客户端后读取。');
    db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS about(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, ranges TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,sequence));
      CREATE INDEX IF NOT EXISTS event_pages ON events(session_id, sequence, ${pageColumns});
      PRAGMA user_version=1;`);
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    database = db;
    file = target;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction(run) {
  database.exec('BEGIN');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function readPage(sessionId, before, offline) {
  const row = database.prepare('SELECT ranges, metadata FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  const ranges = JSON.parse(row.ranges);
  const adjacent =
    before === undefined
      ? ranges.at(-1)
      : ranges.find(([after, through]) => after < before - 1 && through >= before - 1);
  const earlier =
    before === undefined ? undefined : ranges.findLast((range) => range[1] < before - 1);
  if (!adjacent && !offline && before !== undefined) return { after: earlier?.[1] ?? 0 };
  const range = adjacent ?? earlier;
  if (!range) return null;

  const end = Math.min(before ?? Infinity, range[1] + 1);
  const keys = database.prepare(`SELECT session_id, sequence, ${pageColumns}
    FROM events INDEXED BY event_pages WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence`);
  keys.setReturnArrays(true);
  const rows = keys.all(sessionId, range[0], end);
  const first = historyPageStart(rows);
  if (first === undefined) return null;
  const events = database
    .prepare(
      'SELECT data FROM events WHERE session_id = ? AND sequence >= ? AND sequence < ? ORDER BY sequence',
    )
    .all(sessionId, first, end)
    .map((row) => JSON.parse(row.data));
  return {
    events,
    hasEarlier: first > rows[0][1] || range[0] > 0,
    gap: !adjacent,
    lastSequence: JSON.parse(row.metadata).lastSequence,
  };
}

function metadata(session, saved) {
  const lastSequence =
    session.lastSequence === undefined
      ? undefined
      : Math.max(session.lastSequence, saved ? (JSON.parse(saved).lastSequence ?? 0) : 0);
  return JSON.stringify({ ...session, activeRun: null, lastSequence });
}

function run(message) {
  if (message.type === 'close') {
    database?.close();
    database = undefined;
    file = undefined;
    return;
  }
  open(message.url);
  const known = database.prepare("SELECT value FROM about WHERE key = 'history'").get()?.value;
  if (message.type === 'use') {
    if (known === message.history) return;
    return transaction(() => {
      database.exec('DELETE FROM sessions');
      database.prepare("INSERT OR REPLACE INTO about VALUES ('history', ?)").run(message.history);
    });
  }
  // A connection reading offline has no new identity to compare against.
  if (!known?.endsWith(`/${message.protocol}`) || (message.history && message.history !== known))
    return null;
  switch (message.type) {
    case 'list':
      return database
        .prepare(
          "SELECT metadata FROM sessions ORDER BY json_extract(metadata, '$.updatedAt') DESC",
        )
        .all()
        .map((row) => JSON.parse(row.metadata));
    case 'read':
      return readPage(message.sessionId, message.before, message.offline);
    case 'write':
      return transaction(() => {
        const { session, events, range } = message;
        const saved = database
          .prepare('SELECT ranges, metadata FROM sessions WHERE id = ?')
          .get(session.id);
        const ranges = [...(saved ? JSON.parse(saved.ranges) : []), range].sort(
          (a, b) => a[0] - b[0],
        );
        const combined = [];
        for (const [after, through] of ranges) {
          if (through <= after) continue;
          const last = combined.at(-1);
          if (last && after <= last[1]) last[1] = Math.max(last[1], through);
          else combined.push([after, through]);
        }
        database
          .prepare(
            'INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,ranges=excluded.ranges',
          )
          .run(session.id, metadata(session, saved?.metadata), JSON.stringify(combined));
        const put = database.prepare('INSERT OR REPLACE INTO events VALUES (?, ?, ?)');
        for (const event of events) put.run(session.id, event.sequence, JSON.stringify(event));
      });
    case 'metadata': {
      const saved = database
        .prepare('SELECT metadata FROM sessions WHERE id = ?')
        .get(message.session.id);
      if (!saved) return;
      database
        .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
        .run(metadata(message.session, saved.metadata), message.session.id);
      return;
    }
    case 'retain':
      return transaction(() => {
        const sessions = new Map(message.sessions.map((session) => [session.id, session]));
        const update = database.prepare('UPDATE sessions SET metadata = ? WHERE id = ?');
        const remove = database.prepare('DELETE FROM sessions WHERE id = ?');
        for (const { id } of database.prepare('SELECT id FROM sessions').all()) {
          const session = sessions.get(id);
          if (session) update.run(metadata(session), id);
          else remove.run(id);
        }
      });
    case 'drop':
      database.prepare('DELETE FROM sessions WHERE id = ?').run(message.sessionId);
      return;
    case 'clear':
      database.exec('DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
      return;
    case 'stats':
      return {
        bytes: ['', '-wal', '-shm'].reduce(
          (total, suffix) =>
            total + (statSync(file + suffix, { throwIfNoEntry: false })?.size ?? 0),
          0,
        ),
        sessions: Number(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n),
        events: Number(database.prepare('SELECT COUNT(*) AS n FROM events').get().n),
      };
    default:
      throw new Error('未知缓存操作。');
  }
}

parentPort.on('message', ({ id, message }) => {
  try {
    parentPort.postMessage({ id, result: run(message) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
