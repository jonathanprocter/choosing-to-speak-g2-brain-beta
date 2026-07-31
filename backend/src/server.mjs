import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const env = process.env;
const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT || 8788);
const BETA_TOKEN = env.VELVETSPEAK_BETA_TOKEN || 'velvet-beta-local';
const PUBLIC_BASE_URL = (env.VELVETSPEAK_PUBLIC_BASE_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_TRANSCRIBE_MODEL = env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const PROVIDER = 'choosing-to-speak-brain-backend';
const VERSION = '0.1.0';
const WS_HEARTBEAT_INTERVAL_MS = Number(env.WS_HEARTBEAT_INTERVAL_MS || 30000);
const WS_TRANSCRIBE_MIN_BYTES = Number(env.WS_TRANSCRIBE_MIN_BYTES || 96000);
const WS_TRANSCRIBE_INTERVAL_MS = Number(env.WS_TRANSCRIBE_INTERVAL_MS || 4500);
const WS_TRANSCRIBE_MAX_BYTES = Number(env.WS_TRANSCRIBE_MAX_BYTES || 384000);
const SHUTDOWN_TIMEOUT_MS = Number(env.SHUTDOWN_TIMEOUT_MS || 25000);
const sockets = new Set();

const server = http.createServer(async (req, res) => {
  try {
    await handleHttp(req, res);
  } catch (error) {
    sendJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 500, {
      ok: false,
      error: {
        code: Number.isInteger(error?.statusCode) ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== '/v1/transcribe/stream') {
    socket.destroy();
    return;
  }
  handleWebSocket(req, socket, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Choosing to Speak brain backend listening on http://${HOST}:${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`VoiceLock: disabled`);
  console.log(`OpenAI: ${env.OPENAI_API_KEY ? `enabled (${OPENAI_MODEL})` : 'disabled; deterministic fallback'}`);
  console.log(`OpenAI transcription: ${env.OPENAI_API_KEY ? `enabled (${OPENAI_TRANSCRIBE_MODEL})` : 'disabled; listening fallback'}`);
});

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

function shutdown(signal) {
  console.log(`${signal} received; closing Choosing to Speak brain backend.`);
  server.close(() => process.exit(0));
  for (const socket of sockets) {
    if (!socket.destroyed) {
      socket.end(encodeWsFrame(Buffer.from([0x03, 0xe9]), 8));
    }
  }
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
}

async function handleHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    writeCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' }
    });
    return;
  }

  const body = await readJson(req);

  switch (url.pathname) {
    case '/v1/live_brain':
      await handleLiveBrain(res, body);
      return;
    case '/v1/search':
      handleSearch(res, body);
      return;
    case '/v1/transcribe':
      handleTranscribe(res, body);
      return;
    case '/v1/coach':
      handleCoach(res, body);
      return;
    case '/v1/debrief':
      handleDebrief(res, body);
      return;
    case '/v1/coach_review':
      handleCoachReview(res, body);
      return;
    case '/v1/phone_mic_proof':
      sendJson(res, 200, { proofId: requestId('phone-proof') });
      return;
    default:
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  }
}

function healthPayload() {
  return {
    ok: true,
    service: 'choosing-to-speak-brain-backend',
    version: VERSION,
    provider: PROVIDER,
    routes: {
      liveBrain: `${PUBLIC_BASE_URL}/v1/live_brain`,
      search: `${PUBLIC_BASE_URL}/v1/search`,
      transcribe: `${PUBLIC_BASE_URL}/v1/transcribe`,
      transcribeStream: `${PUBLIC_BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/v1/transcribe/stream`
    },
    voiceLock: {
      enabled: false,
      message: 'VoiceLock is intentionally not part of this beta backend.'
    },
    ai: {
      answerGeneration: env.OPENAI_API_KEY ? 'openai' : 'deterministic_fallback',
      transcription: env.OPENAI_API_KEY ? 'openai_audio_transcriptions' : 'listening_fallback'
    }
  };
}

async function handleLiveBrain(res, body) {
  const type = typeof body?.type === 'string' ? body.type : 'generate_answer';
  const input = isRecord(body?.input) ? body.input : body;

  if (type === 'generate_line_options') {
    sendJson(res, 200, buildLineOptions(input));
    return;
  }

  const answer = await buildAnswer(input);
  sendJson(res, 200, answer);
}

async function buildAnswer(input) {
  const started = Date.now();
  const question = cleanText(input.question || input.detectedQuestion || input.transcript || 'What should I say next?');
  const intent = normalizeIntent(input.requestedOutputType);
  const settings = normalizeSettings(input.settings);
  const context = extractContext(input);

  let pages = null;
  if (env.OPENAI_API_KEY) {
    pages = await askOpenAI({ question, intent, settings, context }).catch((error) => {
      console.warn(`OpenAI fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (!pages) pages = deterministicPages({ question, intent, settings, context });

  const cardType = intent === 'longAnswer' ? 'answer' : intent === 'lineOptions' ? 'lineOptions' : intent;
  const createdAt = new Date().toISOString();
  const id = requestId('answer');
  const card = {
    cardId: `card-${id}`,
    cardType,
    pages: pages.slice(0, Math.max(1, settings.maxLongPages)),
    createdAt
  };

  return {
    schemaVersion: 'answer.result.v1',
    requestId: id,
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/live_brain`,
    status: 'success',
    intent,
    cards: [card],
    staged: {
      opener: card.pages[0] || 'Answer unavailable',
      additionalPages: card.pages.slice(1),
      isComplete: true
    },
    toolRequests: [],
    toolResults: [],
    memoryUsed: {
      summary: context.memory.length ? `Used ${context.memory.length} memory/context hint(s).` : 'No memory snippets used.',
      sourceRefs: context.memory.map((_, index) => `memory-${index + 1}`)
    },
    confidence: env.OPENAI_API_KEY ? 0.92 : 0.9,
    detectedQuestion: question,
    groundingMode: 'polished',
    deliveryMode: settings.answerDelivery,
    answerLength: settings.answerLength,
    latencyMs: Math.max(0, Date.now() - started)
  };
}

function buildLineOptions(input) {
  const question = cleanText(input.question || input.transcript || 'What should I say?');
  const style = normalizeLineStyle(input.lineStyle);
  const base = summarizeQuestion(question);
  return {
    schemaVersion: 'line-options.result.v1',
    requestId: requestId('lines'),
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/live_brain`,
    options: [
      { id: `${style}-1`, text: `I would anchor this in ${base}, then name the tradeoff.`, style },
      { id: `${style}-2`, text: `The important part is ${base}; here is how I would handle it.`, style },
      { id: `${style}-3`, text: `I want to be specific: the decision hinges on ${base}.`, style },
      { id: `${style}-4`, text: `A practical next step is to clarify ${base} before we commit.`, style }
    ],
    preferenceTraits: ['Direct', 'Calm', 'Specific', 'Useful']
  };
}

function handleSearch(res, body) {
  const query = cleanText(body?.query || 'Choosing to Speak search');
  const started = Date.now();
  sendJson(res, 200, {
    query,
    requestId: body?.requestId || requestId('search'),
    summary: 'Search is routed through the Choosing to Speak backend boundary. Live web lookup is not enabled in this local build.',
    sources: [],
    provider: 'velvetspeak-backend-search',
    latencyMs: Math.max(0, Date.now() - started),
    status: 'success'
  });
}

function handleTranscribe(res, body) {
  const sessionId = cleanText(body?.sessionId || 'bounded-session');
  const source = normalizeMicSource(body?.source);
  const text = cleanText(body?.text || body?.transcript || '');
  const turns = text ? [transcriptTurn({ sessionId, source, text, final: true })] : [];
  sendJson(res, 200, { turns });
}

function handleCoach(res, body) {
  const transcript = cleanText(body?.transcript || body?.recentTranscript || '');
  const nudge = transcript.length > 80
    ? {
        teaser: 'Ask one clear follow-up.',
        explanation: 'The conversation has enough context for a useful next question. Keep it short and specific.'
      }
    : null;
  sendJson(res, 200, { type: 'coach.result.v1', requestId: requestId('coach'), nudge });
}

function handleDebrief(res, body) {
  sendJson(res, 200, {
    type: 'debrief.result.v1',
    requestId: body?.requestId || requestId('debrief'),
    debrief: {
      goalOutcome: { status: 'no_goal', evidence: 'No explicit goal outcome was provided to the backend.' },
      lesson: 'Keep the next session focused on one concrete outcome.',
      commitments: [],
      moments: []
    }
  });
}

function handleCoachReview(res, body) {
  sendJson(res, 200, {
    type: 'coach_review.result.v1',
    requestId: body?.requestId || requestId('coach-review'),
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/coach_review`,
    review: {
      goalOutcome: { status: 'no_goal', evidence: 'No completed session goal was included.' },
      moments: [],
      commitments: [],
      coaching: [
        {
          dimension: 'clarity',
          observation: 'The session did not include enough transcript for a detailed review.',
          suggestion: 'Capture a longer live segment before requesting a review.'
        }
      ],
      lesson: 'Shorter, direct prompts produce more useful live coaching.',
      talkShareNote: ''
    }
  });
}

async function askOpenAI({ question, intent, settings, context }) {
  const prompt = [
    'You are the Choosing to Speak live conversation brain.',
    'Return only concise coaching text for smart-glasses display.',
    'No markdown fences. No safety boilerplate. No private chain of thought.',
    `Intent: ${intent}`,
    `Answer length: ${settings.answerLength}`,
    `Question/transcript: ${question}`,
    context.brief ? `Context: ${context.brief}` : '',
    context.memory.length ? `Memory hints: ${context.memory.join(' | ')}` : ''
  ].filter(Boolean).join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      max_output_tokens: settings.answerLength === 'long' ? 500 : 260
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = extractOpenAIText(data);
  if (!text) throw new Error('OpenAI returned no text.');
  return splitPages(text, settings);
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function deterministicPages({ question, intent, settings, context }) {
  const topic = summarizeQuestion(question);
  if (intent === 'summary') {
    return splitPages(`Recap: ${topic}. Name the decision, owner, next step, and one risk before moving on.`, settings);
  }
  if (intent === 'followUp') {
    return [`Ask: "What constraint matters most for ${topic}?"`];
  }
  if (intent === 'script') {
    return [`Say: "I would start with ${topic}, then make the tradeoff explicit."`];
  }
  if (intent === 'priorityAlert') {
    return [`Answer directly. Keep the next sentence about ${topic}.`];
  }

  const lens = context.lens ? `${context.lens} lens` : 'this conversation';
  const text = [
    `Start calm: answer the question behind "${topic}".`,
    `Use one concrete example, then name the tradeoff.`,
    `Close with a forward move: ask what success or next steps should look like.`
  ];

  if (settings.answerLength === 'short') return [text[0]];
  if (settings.answerLength === 'medium') return [text.slice(0, 2).join(' ')];
  return splitPages(`${text.join(' ')} In ${lens}, favor specifics over a long explanation.`, settings);
}

function splitPages(text, settings) {
  const normalized = cleanText(text);
  if (settings.answerLength !== 'long') return [truncate(normalized, settings.answerLength === 'short' ? 180 : 360)];
  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  const pages = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length > 280 && current) {
      pages.push(current.trim());
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }
  if (current) pages.push(current);
  return pages.slice(0, Math.max(1, settings.maxLongPages));
}

function extractContext(input) {
  const memory = [];
  for (const value of [
    input.activeBriefLabel,
    input.activeContextSummary,
    ...(Array.isArray(input.retrievedMemorySnippets) ? input.retrievedMemorySnippets : []),
    ...(Array.isArray(input.recentSessionContext) ? input.recentSessionContext : [])
  ]) {
    const text = typeof value === 'string' ? cleanText(value) : cleanText(value?.text || value?.summary || '');
    if (text) memory.push(truncate(text, 240));
  }
  return {
    lens: cleanText(input.lensId || input.activeLensId || ''),
    brief: cleanText(input.activeBriefLabel || ''),
    memory: memory.slice(0, 6)
  };
}

function transcriptTurn({ sessionId, source, text, final }) {
  const now = new Date().toISOString();
  return {
    id: requestId('turn'),
    sessionId,
    source,
    micSource: source,
    provider: 'velvetspeak-backend-stt',
    text,
    isFinal: final,
    stabilityScore: final ? 1 : 0.5,
    stable: final,
    startedAtMs: Date.now(),
    endedAtMs: Date.now(),
    receivedAt: now,
    speakerKind: 'UNKNOWN',
    speakerConfidence: 0
  };
}

function normalizeSettings(settings) {
  const value = isRecord(settings) ? settings : {};
  return {
    answerDelivery: ['script', 'coaching', 'hybrid'].includes(value.answerDelivery) ? value.answerDelivery : 'coaching',
    answerLength: ['short', 'medium', 'long'].includes(value.answerLength) ? value.answerLength : 'medium',
    maxLongPages: Number.isFinite(value.maxLongPages) ? Math.max(1, Math.min(10, Math.trunc(value.maxLongPages))) : 3
  };
}

function normalizeIntent(value) {
  const allowed = new Set(['answer', 'longAnswer', 'search', 'math', 'script', 'summary', 'followUp', 'priorityAlert', 'lineOptions', 'passive']);
  return allowed.has(value) ? value : 'answer';
}

function normalizeLineStyle(value) {
  const allowed = new Set(['mix', 'funnier', 'warmer', 'moreSerious', 'moreConfident', 'shorter', 'moreDirect', 'softer', 'newOptions']);
  return allowed.has(value) ? value : 'mix';
}

function normalizeMicSource(value) {
  return value === 'phoneMic' || value === 'g2Mic' ? value : 'g2Mic';
}

function summarizeQuestion(text) {
  const cleaned = cleanText(text).replace(/[?!.]+$/, '');
  if (!cleaned) return 'the core issue';
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, 12).join(' ');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isAuthorized(req) {
  if (!BETA_TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${BETA_TOKEN}`;
}

async function readJson(req) {
  const raw = await readBody(req, 4 * 1024 * 1024);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON body.');
    error.statusCode = 400;
    throw error;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function requestId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sendJson(res, status, payload) {
  writeCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function writeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function handleWebSocket(req, socket, url) {
  if (!req.headers['sec-websocket-key']) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  const protocol = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((value) => value.trim())
    .find((value) => value === 'velvetspeak-stt.v1');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : [])
  ];
  socket.write(`${responseHeaders.join('\r\n')}\r\n\r\n`);

  const sessionId = cleanText(url.searchParams.get('sessionId') || 'stream-session');
  const source = normalizeMicSource(url.searchParams.get('source'));
  let authed = !BETA_TOKEN;
  let audioBytes = 0;
  let lastEmit = 0;
  let lastTranscribeAt = 0;
  let transcribeInFlight = false;
  let lastTranscriptText = '';
  let frameBuffer = Buffer.alloc(0);
  let pcmBuffer = Buffer.alloc(0);
  let heartbeat = null;
  let cleanedUp = false;

  sockets.add(socket);
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeat) clearInterval(heartbeat);
    sockets.delete(socket);
  };
  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', cleanup);

  if (Number.isFinite(WS_HEARTBEAT_INTERVAL_MS) && WS_HEARTBEAT_INTERVAL_MS > 0) {
    heartbeat = setInterval(() => {
      if (socket.destroyed) {
        cleanup();
        return;
      }
      socket.write(encodeWsFrame(Buffer.alloc(0), 9));
    }, WS_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  }

  if (authed) sendWs(socket, { type: 'stream.ready' });

  socket.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    const decoded = decodeClientFrames(frameBuffer);
    frameBuffer = decoded.remaining;
    const frames = decoded.frames;
    for (const frame of frames) {
      if (frame.opcode === 8) {
        socket.end(encodeWsFrame(Buffer.from([0x03, 0xe8]), 8));
        return;
      }
      if (frame.opcode === 9) {
        socket.write(encodeWsFrame(frame.payload, 10));
        continue;
      }
      if (frame.opcode === 10) {
        continue;
      }
      if (frame.opcode === 1) {
        const message = frame.payload.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(message); } catch {}
        if (parsed?.type === 'Authenticate') {
          authed = !BETA_TOKEN || parsed.token === BETA_TOKEN;
          if (authed) sendWs(socket, { type: 'stream.ready' });
          else sendWs(socket, { type: 'stream.error', code: 'unauthorized', message: 'Missing or invalid bearer token.' });
        } else if (parsed?.type === 'CloseStream') {
          socket.end(encodeWsFrame(Buffer.from([0x03, 0xe8]), 8));
        }
      }
      if (frame.opcode === 2 && authed) {
        audioBytes += frame.payload.byteLength;
        const now = Date.now();
        pcmBuffer = appendBoundedPcm(pcmBuffer, frame.payload);
        if (env.OPENAI_API_KEY) {
          if (
            pcmBuffer.byteLength >= WS_TRANSCRIBE_MIN_BYTES &&
            !transcribeInFlight &&
            now - lastTranscribeAt >= WS_TRANSCRIBE_INTERVAL_MS
          ) {
            const pcm = pcmBuffer;
            pcmBuffer = Buffer.alloc(0);
            lastTranscribeAt = now;
            transcribeInFlight = true;
            transcribePcm16Mono(pcm)
              .then((text) => {
                const cleaned = cleanText(text);
                if (!cleaned || cleaned === lastTranscriptText || socket.destroyed) return;
                lastTranscriptText = cleaned;
                sendWs(socket, {
                  type: 'transcript.final',
                  turn: transcriptTurn({
                    sessionId,
                    source,
                    text: cleaned,
                    final: true
                  })
                });
              })
              .catch((error) => {
                console.warn(`OpenAI STT fallback: ${error instanceof Error ? error.message : String(error)}`);
                if (!socket.destroyed && now - lastEmit > 5000) {
                  lastEmit = now;
                  sendListeningFallback(socket, { sessionId, source });
                }
              })
              .finally(() => {
                transcribeInFlight = false;
              });
          }
        } else if (audioBytes >= 32000 && now - lastEmit > 5000) {
          lastEmit = now;
          sendListeningFallback(socket, { sessionId, source });
        }
      }
    }
  });
}

function appendBoundedPcm(current, next) {
  const combined = Buffer.concat([current, next]);
  if (
    Number.isFinite(WS_TRANSCRIBE_MAX_BYTES) &&
    WS_TRANSCRIBE_MAX_BYTES > 0 &&
    combined.byteLength > WS_TRANSCRIBE_MAX_BYTES
  ) {
    return combined.subarray(combined.byteLength - WS_TRANSCRIBE_MAX_BYTES);
  }
  return combined;
}

function sendListeningFallback(socket, { sessionId, source }) {
  sendWs(socket, {
    type: 'transcript.partial',
    turn: transcriptTurn({
      sessionId,
      source,
      text: 'Listening...',
      final: false
    })
  });
}

async function transcribePcm16Mono(pcm) {
  const audio = pcm16MonoToWav(pcm, 16000);
  const form = new FormData();
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'g2-mic.wav');
  form.append('response_format', 'json');
  form.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: form
  });
  if (!response.ok) {
    throw new Error(`OpenAI transcription HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return typeof data?.text === 'string' ? data.text : '';
}

function pcm16MonoToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

function sendWs(socket, payload) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(Buffer.from(JSON.stringify(payload), 'utf8'), 1));
}

function encodeWsFrame(payload, opcode = 1) {
  const length = payload.byteLength;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeClientFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.byteLength) {
    const frameStart = offset;
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.byteLength) {
        offset = frameStart;
        break;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.byteLength) {
        offset = frameStart;
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (offset + 4 > buffer.byteLength) {
        offset = frameStart;
        break;
      }
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.byteLength) {
      offset = frameStart;
      break;
    }
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
  }
  return { frames, remaining: buffer.subarray(offset) };
}
