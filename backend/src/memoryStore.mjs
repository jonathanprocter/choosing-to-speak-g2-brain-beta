import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export function createMemoryStore({ dbPath = ':memory:', maxSessions = 500 } = {}) {
  const resolvedPath = dbPath || ':memory:';
  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (resolvedPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sessions (
      session_id TEXT PRIMARY KEY,
      lens_id TEXT NOT NULL,
      session_started_at TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES memory_sessions(session_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      item_order INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_sessions_lens_started
      ON memory_sessions(lens_id, session_started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_items_session_order
      ON memory_items(session_id, item_order);
  `);

  const insertSession = db.prepare(`
    INSERT INTO memory_sessions (session_id, lens_id, session_started_at, uploaded_at)
    VALUES (@sessionId, @lensId, @sessionStartedAt, @uploadedAt)
    ON CONFLICT(session_id) DO UPDATE SET
      lens_id = excluded.lens_id,
      session_started_at = excluded.session_started_at,
      uploaded_at = excluded.uploaded_at
  `);
  const deleteItems = db.prepare('DELETE FROM memory_items WHERE session_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO memory_items (session_id, kind, body, item_order)
    VALUES (@sessionId, @kind, @body, @itemOrder)
  `);
  const countSessions = db.prepare('SELECT COUNT(*) AS count FROM memory_sessions');
  const countItems = db.prepare('SELECT COUNT(*) AS count FROM memory_items');
  const deleteOldestSessions = db.prepare(`
    DELETE FROM memory_sessions
    WHERE session_id IN (
      SELECT session_id
      FROM memory_sessions
      ORDER BY datetime(session_started_at) ASC, datetime(uploaded_at) ASC, session_id ASC
      LIMIT ?
    )
  `);
  const deleteSessionById = db.prepare('DELETE FROM memory_sessions WHERE session_id = ?');
  const deleteAllSessions = db.prepare('DELETE FROM memory_sessions');
  const hintsForLens = db.prepare(`
    SELECT i.kind, i.body
    FROM memory_sessions s
    JOIN memory_items i ON i.session_id = s.session_id
    WHERE lower(s.lens_id) = lower(?) OR s.lens_id = 'default'
    ORDER BY datetime(s.session_started_at) DESC, datetime(s.uploaded_at) DESC, i.item_order ASC
    LIMIT ?
  `);
  const hintsForAll = db.prepare(`
    SELECT i.kind, i.body
    FROM memory_sessions s
    JOIN memory_items i ON i.session_id = s.session_id
    ORDER BY datetime(s.session_started_at) DESC, datetime(s.uploaded_at) DESC, i.item_order ASC
    LIMIT ?
  `);

  const trim = () => {
    const max = normalizeMaxSessions(maxSessions);
    const count = countSessions.get().count;
    if (count <= max) return 0;
    return deleteOldestSessions.run(count - max).changes;
  };

  const upsertSession = db.transaction((session) => {
    insertSession.run({
      sessionId: session.sessionId,
      lensId: session.lensId || 'default',
      sessionStartedAt: session.sessionStartedAt,
      uploadedAt: session.uploadedAt
    });
    deleteItems.run(session.sessionId);
    session.items.forEach((item, index) => {
      insertItem.run({
        sessionId: session.sessionId,
        kind: item.kind,
        body: item.body,
        itemOrder: index
      });
    });
    trim();
  });

  return {
    driver: 'sqlite',
    persistent: resolvedPath !== ':memory:',
    dbPath: resolvedPath,
    maxSessions: normalizeMaxSessions(maxSessions),
    upsertSession(session) {
      if (!session?.sessionId || !Array.isArray(session.items) || !session.items.length) {
        return { storedItems: 0 };
      }
      upsertSession(session);
      return { storedItems: session.items.length };
    },
    deleteSession(sessionId) {
      return deleteSessionById.run(sessionId).changes;
    },
    purgeAll() {
      const purged = countSessions.get().count;
      deleteAllSessions.run();
      return purged;
    },
    hints({ lensId = '', limit = 6 } = {}) {
      const boundedLimit = Math.max(1, Math.min(24, Math.trunc(Number(limit) || 6)));
      const wanted = String(lensId || '').trim();
      const rows = wanted ? hintsForLens.all(wanted, boundedLimit) : hintsForAll.all(boundedLimit);
      return rows.map((row) => `${row.kind}: ${row.body}`);
    },
    stats() {
      return {
        driver: 'sqlite',
        persistent: resolvedPath !== ':memory:',
        sessions: countSessions.get().count,
        items: countItems.get().count,
        maxSessions: normalizeMaxSessions(maxSessions)
      };
    },
    close() {
      if (db.open) db.close();
    }
  };
}

function normalizeMaxSessions(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 500;
  return Math.max(1, Math.min(5000, Math.trunc(number)));
}
