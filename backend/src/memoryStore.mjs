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

    CREATE TABLE IF NOT EXISTS client_contexts (
      client_id TEXT PRIMARY KEY,
      lens_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_context_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL REFERENCES client_contexts(client_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      item_order INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_client_contexts_lens_updated
      ON client_contexts(lens_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_client_context_items_client_order
      ON client_context_items(client_id, item_order);

    CREATE TABLE IF NOT EXISTS day_roster_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roster_date TEXT NOT NULL,
      lens_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(roster_date, lens_id, source, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_day_roster_date_lens_start
      ON day_roster_entries(roster_date, lens_id, starts_at);

    CREATE TABLE IF NOT EXISTS beta_keys (
      token TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_beta_keys_device
      ON beta_keys(device_id, revoked, created_at DESC);
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
  const countClientContexts = db.prepare('SELECT COUNT(*) AS count FROM client_contexts');
  const countClientContextItems = db.prepare('SELECT COUNT(*) AS count FROM client_context_items');
  const countRosterEntries = db.prepare('SELECT COUNT(*) AS count FROM day_roster_entries');
  const countBetaKeys = db.prepare('SELECT COUNT(*) AS count FROM beta_keys WHERE revoked = 0');
  const betaKeyForDevice = db.prepare(`
    SELECT token FROM beta_keys
    WHERE device_id = ? AND revoked = 0
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `);
  const betaKeyByToken = db.prepare('SELECT token FROM beta_keys WHERE token = ? AND revoked = 0');
  const insertBetaKey = db.prepare(`
    INSERT INTO beta_keys (token, device_id, package_id, created_at, last_seen_at)
    VALUES (@token, @deviceId, @packageId, @createdAt, @lastSeenAt)
  `);
  const touchBetaKey = db.prepare('UPDATE beta_keys SET last_seen_at = ? WHERE token = ?');
  const revokeBetaKeyByToken = db.prepare('UPDATE beta_keys SET revoked = 1 WHERE token = ?');
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
  const insertClientContext = db.prepare(`
    INSERT INTO client_contexts (client_id, lens_id, display_name, source, summary, updated_at)
    VALUES (@clientId, @lensId, @displayName, @source, @summary, @updatedAt)
    ON CONFLICT(client_id) DO UPDATE SET
      lens_id = excluded.lens_id,
      display_name = excluded.display_name,
      source = excluded.source,
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `);
  const deleteClientContextItems = db.prepare('DELETE FROM client_context_items WHERE client_id = ?');
  const insertClientContextItem = db.prepare(`
    INSERT INTO client_context_items (client_id, kind, body, item_order)
    VALUES (@clientId, @kind, @body, @itemOrder)
  `);
  const deleteClientContextById = db.prepare('DELETE FROM client_contexts WHERE client_id = ?');
  const clientContextById = db.prepare(`
    SELECT c.client_id, c.display_name, c.summary, i.kind, i.body, i.item_order
    FROM client_contexts c
    LEFT JOIN client_context_items i ON i.client_id = c.client_id
    WHERE lower(c.client_id) = lower(?)
    ORDER BY i.item_order ASC
  `);
  const clientContextByDisplayName = db.prepare(`
    SELECT c.client_id, c.display_name, c.summary, i.kind, i.body, i.item_order
    FROM client_contexts c
    LEFT JOIN client_context_items i ON i.client_id = c.client_id
    WHERE lower(c.display_name) = lower(?)
    ORDER BY datetime(c.updated_at) DESC, i.item_order ASC
    LIMIT ?
  `);
  const clientContextByLens = db.prepare(`
    SELECT c.client_id, c.display_name, c.summary, i.kind, i.body, i.item_order
    FROM client_contexts c
    LEFT JOIN client_context_items i ON i.client_id = c.client_id
    WHERE lower(c.lens_id) = lower(?)
    ORDER BY datetime(c.updated_at) DESC, c.client_id ASC, i.item_order ASC
    LIMIT ?
  `);
  const deleteRosterForSource = db.prepare(`
    DELETE FROM day_roster_entries
    WHERE roster_date = @rosterDate AND lower(lens_id) = lower(@lensId) AND source = @source
  `);
  const deleteRosterForDate = db.prepare(`
    DELETE FROM day_roster_entries
    WHERE roster_date = @rosterDate AND lower(lens_id) = lower(@lensId)
  `);
  const insertRosterEntry = db.prepare(`
    INSERT INTO day_roster_entries (
      roster_date, lens_id, client_id, display_name, starts_at, ends_at, source, event_id, status, notes, updated_at
    )
    VALUES (
      @rosterDate, @lensId, @clientId, @displayName, @startsAt, @endsAt, @source, @eventId, @status, @notes, @updatedAt
    )
    ON CONFLICT(roster_date, lens_id, source, event_id) DO UPDATE SET
      client_id = excluded.client_id,
      display_name = excluded.display_name,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      status = excluded.status,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `);
  const rosterForDateLens = db.prepare(`
    SELECT client_id, display_name, starts_at, ends_at, source, event_id, status, notes
    FROM day_roster_entries
    WHERE roster_date = ? AND (lower(lens_id) = lower(?) OR lens_id = 'default')
    ORDER BY datetime(starts_at) ASC, display_name ASC
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
  const upsertClientContext = db.transaction((context) => {
    insertClientContext.run({
      clientId: context.clientId,
      lensId: context.lensId || 'default',
      displayName: context.displayName,
      source: context.source || 'api',
      summary: context.summary || '',
      updatedAt: context.updatedAt
    });
    deleteClientContextItems.run(context.clientId);
    context.items.forEach((item, index) => {
      insertClientContextItem.run({
        clientId: context.clientId,
        kind: item.kind,
        body: item.body,
        itemOrder: index
      });
    });
  });
  const upsertDayRoster = db.transaction((roster) => {
    if (roster.replace !== false) {
      deleteRosterForSource.run({
        rosterDate: roster.rosterDate,
        lensId: roster.lensId || 'default',
        source: roster.source || 'calendar-sync'
      });
    }
    roster.entries.forEach((entry, index) => {
      insertRosterEntry.run({
        rosterDate: roster.rosterDate,
        lensId: roster.lensId || 'default',
        clientId: entry.clientId,
        displayName: entry.displayName,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        source: roster.source || 'calendar-sync',
        eventId: entry.eventId || `${entry.clientId}-${entry.startsAt}-${index}`,
        status: entry.status || 'scheduled',
        notes: entry.notes || '',
        updatedAt: roster.updatedAt
      });
    });
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
    upsertClientContext(context) {
      if (!context?.clientId || !context?.displayName || !Array.isArray(context.items)) {
        return { storedItems: 0 };
      }
      upsertClientContext(context);
      return { storedItems: context.items.length };
    },
    deleteClientContext(clientId) {
      return deleteClientContextById.run(clientId).changes;
    },
    upsertDayRoster(roster) {
      if (!roster?.rosterDate || !Array.isArray(roster.entries)) {
        return { storedItems: 0 };
      }
      upsertDayRoster(roster);
      return { storedItems: roster.entries.length };
    },
    deleteDayRoster({ rosterDate = '', lensId = 'default' } = {}) {
      if (!rosterDate) return 0;
      return deleteRosterForDate.run({ rosterDate, lensId: lensId || 'default' }).changes;
    },
    rosterCandidates({ lensId = '', date = '', at = '', limit = 8 } = {}) {
      const rosterDate = String(date || '').trim();
      if (!rosterDate) return [];
      const boundedLimit = Math.max(1, Math.min(48, Math.trunc(Number(limit) || 8)));
      const rows = rosterForDateLens.all(rosterDate, String(lensId || 'default').trim() || 'default', boundedLimit * 4);
      return rankRosterRows(rows, { at, limit: boundedLimit });
    },
    clientHints({ lensId = '', clientId = '', displayName = '', limit = 8, includeLensFallback = false } = {}) {
      const boundedLimit = Math.max(1, Math.min(24, Math.trunc(Number(limit) || 8)));
      const rows = [];
      const seenClients = new Set();
      for (const id of uniqueTruthy([clientId])) {
        for (const row of clientContextById.all(id)) {
          rows.push(row);
          if (row.client_id) seenClients.add(row.client_id.toLowerCase());
        }
      }
      const name = String(displayName || '').trim();
      if (name) {
        for (const row of clientContextByDisplayName.all(name, boundedLimit)) {
          if (row.client_id && seenClients.has(row.client_id.toLowerCase())) continue;
          rows.push(row);
        }
      }
      const wantedLens = includeLensFallback ? String(lensId || '').trim() : '';
      if (wantedLens) {
        for (const row of clientContextByLens.all(wantedLens, boundedLimit)) {
          if (row.client_id && seenClients.has(row.client_id.toLowerCase())) continue;
          rows.push(row);
          if (row.client_id) seenClients.add(row.client_id.toLowerCase());
        }
      }
      return formatClientContextRows(rows, boundedLimit);
    },
    enrollBetaKey({ token = '', deviceId = '', packageId = '', at = new Date().toISOString() } = {}) {
      const device = String(deviceId || '').trim();
      if (!device) return null;
      const existing = betaKeyForDevice.get(device);
      if (existing) {
        touchBetaKey.run(at, existing.token);
        return { token: existing.token, created: false };
      }
      const minted = String(token || '').trim();
      if (!minted) return null;
      insertBetaKey.run({
        token: minted,
        deviceId: device,
        packageId: String(packageId || '').trim(),
        createdAt: at,
        lastSeenAt: at
      });
      return { token: minted, created: true };
    },
    isBetaKeyValid(token) {
      const value = String(token || '').trim();
      if (!value) return false;
      const row = betaKeyByToken.get(value);
      if (!row) return false;
      touchBetaKey.run(new Date().toISOString(), value);
      return true;
    },
    revokeBetaKey(token) {
      return revokeBetaKeyByToken.run(String(token || '').trim()).changes;
    },
    stats() {
      return {
        driver: 'sqlite',
        persistent: resolvedPath !== ':memory:',
        sessions: countSessions.get().count,
        items: countItems.get().count,
        clients: countClientContexts.get().count,
        clientItems: countClientContextItems.get().count,
        rosterEntries: countRosterEntries.get().count,
        betaKeys: countBetaKeys.get().count,
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

function uniqueTruthy(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatClientContextRows(rows, limit) {
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    for (const text of [
      row.summary ? `client summary: ${row.summary}` : '',
      row.kind && row.body ? `client ${row.kind}: ${row.body}` : ''
    ]) {
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function rankRosterRows(rows, { at = '', limit = 8 } = {}) {
  const anchor = Date.parse(at || '');
  return rows
    .map((row) => {
      const starts = Date.parse(row.starts_at || '');
      const ends = Date.parse(row.ends_at || '');
      const distanceMs = Number.isFinite(anchor) && Number.isFinite(starts)
        ? Math.abs(anchor - starts)
        : 0;
      const active = Number.isFinite(anchor) && Number.isFinite(starts) && Number.isFinite(ends)
        ? anchor >= starts - 15 * 60 * 1000 && anchor <= ends + 15 * 60 * 1000
        : false;
      return {
        clientId: row.client_id,
        displayName: row.display_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        source: row.source,
        eventId: row.event_id,
        status: row.status,
        notes: row.notes,
        active,
        distanceMs
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.distanceMs - b.distanceMs || a.startsAt.localeCompare(b.startsAt))
    .slice(0, limit);
}
