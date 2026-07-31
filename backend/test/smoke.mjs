import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

const port = 8798;
const token = 'smoke-token';
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    VELVETSPEAK_BETA_TOKEN: token,
    VELVETSPEAK_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

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
      digest: 'Interviewer: Tell me about a time you handled a hard architecture tradeoff. Candidate: I need to choose an example that shows judgment, scope, and impact.',
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

  await smokeWebSocketStream({ port, token });

  console.log('Smoke tests passed');
} finally {
  child.kill('SIGTERM');
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
      if (Date.now() - started > 5000) {
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
