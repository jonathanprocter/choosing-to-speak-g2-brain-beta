import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 8798;
const token = 'smoke-token';
const tempRoot = await mkdtemp(join(tmpdir(), 'choosing-to-speak-smoke-'));
const memoryDbPath = join(tempRoot, 'memory.sqlite');
let child = startServer({ port, token, memoryDbPath });

try {
  await waitForServer(port);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const health = await fetch(`${base}/v1/health`).then((res) => res.json());
  assert.equal(health.ok, true);
  assert.equal(health.voiceLock.enabled, false);
  assert.equal(health.ai.answerGeneration, 'deterministic_fallback');
  assert.equal(health.ai.transcription, 'listening_fallback');
  assert.equal(health.ai.voiceProfile, 'jonathan_live_response');
  assert.equal(health.ai.coachCueMode, 'contextual_auto_ephemeral');
  assert.equal(health.ai.debrief, 'deterministic_session_intel');
  assert.equal(health.ai.memorySync, 'sqlite_persistent');
  assert.equal(health.ai.clientContext, 'sqlite_contextual_question_cues');
  assert.equal(health.ai.dayRoster, 'calendar_sync_candidate_resolver');
  assert.equal(health.calendar.timeZone, 'America/New_York');
  assert.equal(health.calendar.dateMode, 'local_day_not_utc');
  assert.equal(health.memory.driver, 'sqlite');
  assert.equal(health.memory.persistent, true);

  const answer = await fetch(`${base}/v1/live_brain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'generate_answer',
      input: {
        sessionId: 'smoke',
        lensId: 'interview',
        question: 'How should I answer the architecture tradeoff question?',
        requestedOutputType: 'answer',
        settings: { answerDelivery: 'coaching', answerLength: 'medium', maxLongPages: 3 },
        toolResults: [],
        retrievedMemorySnippets: []
      }
    })
  }).then((res) => res.json());
  assert.equal(answer.schemaVersion, 'answer.result.v1');
  assert.equal(answer.status, 'success');
  assert.equal(answer.cards.length, 1);
  assert.equal(answer.confidence, 0.9);

  const lines = await fetch(`${base}/v1/live_brain`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'generate_line_options',
      input: { sessionId: 'smoke', question: 'What should I ask next?', lineStyle: 'mix' }
    })
  }).then((res) => res.json());
  assert.equal(lines.schemaVersion, 'line-options.result.v1');
  assert.equal(lines.options.length, 4);

  const search = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'OpenAI interview', requestId: 'search-smoke' })
  }).then((res) => res.json());
  assert.equal(search.status, 'success');

  const coach = await fetch(`${base}/v1/coach`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'coach_digest',
      sessionId: 'smoke',
      lensId: 'interview',
      digest: {
        recentTurns: [
          { speaker: 'other', text: 'Tell me about a time you handled a hard architecture tradeoff.', atMs: 1000 },
          { speaker: 'me', text: 'I need to choose an example that shows judgment, scope, and impact.', atMs: 2000 }
        ]
      },
      scene: {
        title: 'Staff product interview',
        goal: 'Show calm product judgment, not just technical depth.',
        boundaries: 'Avoid sounding scattered or over-explaining.'
      },
      finalTurnCount: 2,
      memoryContext: {
        items: [{ text: 'Prep goal: emphasize staff-level product judgment and calm communication.' }]
      }
    })
  }).then((res) => res.json());
  assert.equal(coach.type, 'coach.result.v1');
  assert.ok(coach.nudge);
  assert.equal(typeof coach.nudge.teaser, 'string');
  assert.ok(Array.isArray(coach.sayThis));

  const debrief = await fetch(`${base}/v1/debrief`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: 'debrief-smoke',
      sessionId: 'smoke-session',
      lensId: 'interview',
      goal: 'Show calm product judgment.',
      turns: [
        { speakerKind: 'NOT_ME', text: 'Tell me about a time you handled a hard architecture tradeoff?', atMs: 1000 },
        { speakerKind: 'ME', text: 'I will follow up with the migration diagram and explain the scope tradeoff.', atMs: 2000 }
      ],
      capturedItems: [{ kind: 'action', text: 'Send migration diagram', owner: 'me' }]
    })
  }).then((res) => res.json());
  assert.equal(debrief.type, 'debrief.result.v1');
  assert.equal(debrief.requestId, 'debrief-smoke');
  assert.equal(debrief.debrief.goalOutcome.status, 'partial');
  assert.equal(typeof debrief.debrief.summary, 'string');
  assert.ok(debrief.debrief.commitments.length >= 1);
  assert.ok(debrief.debrief.moments.length >= 1);

  const coachReview = await fetch(`${base}/v1/coach_review`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: 'review-smoke',
      sessionId: 'smoke-session',
      lensId: 'interview',
      goal: 'Show calm product judgment.',
      turns: [{ speakerKind: 'ME', text: 'I probably need to explain the thing better.', atMs: 3000 }]
    })
  }).then((res) => res.json());
  assert.equal(coachReview.type, 'coach_review.result.v1');
  assert.equal(coachReview.requestId, 'review-smoke');
  assert.equal(coachReview.provider, 'choosing-to-speak-brain-backend');
  assert.ok(Array.isArray(coachReview.review.coaching));

  const memoryEnable = await fetch(`${base}/v1/memory/enable`, {
    method: 'POST',
    headers,
    body: '{}'
  }).then((res) => res.json());
  assert.equal(memoryEnable.ok, true);
  assert.equal(memoryEnable.syncEnabled, true);

  const memoryUpload = await fetch(`${base}/v1/memory/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: 'memory-smoke',
      lensId: 'interview',
      sessionStartedAt: new Date().toISOString(),
      items: [{ kind: 'lesson', body: 'Ask for named examples before giving a long answer.' }]
    })
  }).then((res) => res.json());
  assert.equal(memoryUpload.ok, true);
  assert.equal(memoryUpload.status, 'uploaded');

  const rosterUpload = await fetch(`${base}/v1/day_roster`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rosterDate: '2026-07-31',
      lensId: 'clinical',
      source: 'simplepractice-calendar-sync',
      entries: [
        {
          eventId: 'sp-smoke-1',
          clientId: 'client-smoke',
          clientName: 'Smoke Client',
          start: '11:15 PM',
          durationMinutes: 50,
          summary: 'Client folds quickly when family pushes back.',
          bestQuestions: ['What boundary would protect your Sunday without over-explaining?'],
          risks: ['Do not rush into scripts before validating fatigue.'],
          source: 'notion-clinical-hud'
        }
      ]
    })
  }).then((res) => res.json());
  assert.equal(rosterUpload.ok, true);
  assert.equal(rosterUpload.rosterDate, '2026-07-31');
  assert.equal(rosterUpload.storedItems, 1);
  assert.equal(rosterUpload.storedClientContexts, 1);

  const candidate = await fetch(`${base}/v1/client_candidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z'
    })
  }).then((res) => res.json());
  assert.equal(candidate.type, 'client_candidate.result.v1');
  assert.equal(candidate.rosterDate, '2026-07-31');
  assert.equal(candidate.selected.displayName, 'Smoke Client');
  assert.equal(candidate.selected.reason, 'calendar_window_match');
  assert.match(candidate.contextHints.join(' '), /protect your Sunday/i);

  const dismissedCandidate = await fetch(`${base}/v1/client_candidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z',
      dismissedClientIds: ['client-smoke']
    })
  }).then((res) => res.json());
  assert.equal(dismissedCandidate.selected, null);

  const manualCandidate = await fetch(`${base}/v1/client_candidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z',
      manualClientContext: {
        clientId: 'client-manual-smoke',
        displayName: 'Manual Smoke',
        lensId: 'clinical',
        summary: 'Manual override client context.',
        bestQuestions: ['What would make this next step feel doable?']
      }
    })
  }).then((res) => res.json());
  assert.equal(manualCandidate.selected.reason, 'manual_override');

  const questionCue = await fetch(`${base}/v1/question_cues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z',
      transcript: 'My family keeps pushing me and I keep folding even when I am tired.'
    })
  }).then((res) => res.json());
  assert.equal(questionCue.type, 'question_cues.result.v1');
  assert.equal(questionCue.clientContextUsed.displayName, 'Smoke Client');
  assert.match(questionCue.questions[0].text, /protect your Sunday/i);

  const clientCoach = await fetch(`${base}/v1/coach`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'coach_digest',
      sessionId: 'client-context-smoke',
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z',
      transcript: 'My family keeps pushing me and I keep folding even when I am tired.',
      recentTurns: [
        { speaker: 'client', text: 'My family keeps pushing me and I keep folding.', atMs: 1000, endedAtMs: 8000 },
        { speaker: 'therapist', text: 'Let us slow that down.', atMs: 8200, endedAtMs: 9500 }
      ]
    })
  }).then((res) => res.json());
  assert.equal(clientCoach.type, 'coach.result.v1');
  assert.equal(clientCoach.clientContextUsed.displayName, 'Smoke Client');
  assert.equal(clientCoach.clientContextUsed.rosterMatched, true);
  assert.match(clientCoach.sayThis.join(' '), /protect your Sunday/i);

  const memoryHealth = await fetch(`${base}/v1/health`).then((res) => res.json());
  assert.ok(memoryHealth.memory.sessions >= 2);
  assert.ok(memoryHealth.memory.items >= 2);
  assert.ok(memoryHealth.memory.clients >= 2);
  assert.ok(memoryHealth.memory.clientItems >= 2);
  assert.ok(memoryHealth.memory.rosterEntries >= 1);
  assert.ok((await stat(memoryDbPath)).size > 0);

  await stopServer(child);
  child = startServer({ port, token, memoryDbPath });
  await waitForServer(port);

  const persistedCoach = await fetch(`${base}/v1/coach`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'coach_digest',
      sessionId: 'persisted-memory-smoke',
      lensId: 'interview',
      transcript: 'Examples?'
    })
  }).then((res) => res.json());
  assert.ok(persistedCoach.nudge);
  assert.match(persistedCoach.nudge.explanation, /named examples/i);

  const persistedQuestionCue = await fetch(`${base}/v1/question_cues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lensId: 'clinical',
      at: '2026-08-01T03:30:00.000Z',
      transcript: 'My family keeps pushing me and I keep folding even when I am tired.'
    })
  }).then((res) => res.json());
  assert.equal(persistedQuestionCue.clientContextUsed.displayName, 'Smoke Client');
  assert.match(persistedQuestionCue.questions[0].text, /protect your Sunday/i);

  const clientContextPurge = await fetch(`${base}/v1/client_context/client-smoke`, {
    method: 'DELETE',
    headers
  }).then((res) => res.json());
  assert.equal(clientContextPurge.ok, true);

  const dayRosterPurge = await fetch(`${base}/v1/day_roster/2026-07-31?lensId=clinical`, {
    method: 'DELETE',
    headers
  }).then((res) => res.json());
  assert.equal(dayRosterPurge.ok, true);

  const memoryPurge = await fetch(`${base}/v1/memory/sessions/memory-smoke`, {
    method: 'DELETE',
    headers
  }).then((res) => res.json());
  assert.equal(memoryPurge.ok, true);

  const memoryPurgeAll = await fetch(`${base}/v1/memory`, {
    method: 'DELETE',
    headers
  }).then((res) => res.json());
  assert.equal(memoryPurgeAll.ok, true);
  assert.ok(memoryPurgeAll.purged >= 1);

  await smokeWebSocketStream({ port, token });

  console.log('Smoke tests passed');
} finally {
  await stopServer(child);
  await rm(tempRoot, { recursive: true, force: true });
}

function startServer({ port, token, memoryDbPath }) {
  return spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      VELVETSPEAK_BETA_TOKEN: token,
      VELVETSPEAK_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      OPENAI_API_KEY: '',
      MEMORY_DB_PATH: memoryDbPath,
      MEMORY_MAX_SESSIONS: '20',
      CALENDAR_TIME_ZONE: 'America/New_York'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function waitForServer(port) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {}
      if (Date.now() - started > 15000) {
        reject(new Error('Server did not start.'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function smokeWebSocketStream({ port, token }) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(5000);

  const key = crypto.randomBytes(16).toString('base64');
  let buffer = Buffer.alloc(0);

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('WebSocket connection timed out.')));
  });

  socket.write([
    'GET /v1/transcribe/stream?sessionId=smoke&source=g2Mic HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: velvetspeak-stt.v1',
    '',
    ''
  ].join('\r\n'));

  await readUntil(socket, (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    return buffer.includes(Buffer.from('\r\n\r\n'));
  });

  const headerEnd = buffer.indexOf('\r\n\r\n');
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  assert.match(headerText, /^HTTP\/1\.1 101 /);
  assert.match(headerText, /Sec-WebSocket-Protocol: velvetspeak-stt\.v1/i);

  buffer = buffer.subarray(headerEnd + 4);
  socket.write(encodeClientFrame(Buffer.from(JSON.stringify({ type: 'Authenticate', token }), 'utf8'), 1));

  const ready = await readServerJson(socket, buffer);
  assert.equal(ready.type, 'stream.ready');
  socket.end(encodeClientFrame(Buffer.from([0x03, 0xe8]), 8));
}

function readUntil(socket, predicate) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (predicate(chunk)) cleanup(resolve);
    };
    const onError = (error) => cleanup(reject, error);
    const onTimeout = () => cleanup(reject, new Error('Timed out while reading from socket.'));
    const cleanup = (done, value) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      done(value);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

async function readServerJson(socket, initialBuffer) {
  let buffer = initialBuffer;
  for (;;) {
    const decoded = decodeServerFrame(buffer);
    if (decoded) return JSON.parse(decoded.payload.toString('utf8'));
    const chunk = await new Promise((resolve, reject) => {
      socket.once('data', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('Timed out while waiting for WebSocket message.')));
    });
    buffer = Buffer.concat([buffer, chunk]);
  }
}

function decodeServerFrame(buffer) {
  if (buffer.byteLength < 2) return null;
  let offset = 0;
  const first = buffer[offset++];
  const second = buffer[offset++];
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.byteLength < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.byteLength < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  if (buffer.byteLength < offset + length) return null;
  return { opcode: first & 0x0f, payload: buffer.subarray(offset, offset + length) };
}

function encodeClientFrame(payload, opcode = 1) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.byteLength < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.byteLength]);
  } else if (payload.byteLength < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}
