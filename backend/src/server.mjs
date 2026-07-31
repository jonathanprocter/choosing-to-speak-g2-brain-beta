import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { JONATHAN_LIVE_RESPONSE_VOICE } from './jonathanVoice.mjs';
import { createMemoryStore } from './memoryStore.mjs';

const env = process.env;
const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT || 8788);
const BETA_TOKEN = env.VELVETSPEAK_BETA_TOKEN || 'velvet-beta-local';
const PUBLIC_BASE_URL = (env.VELVETSPEAK_PUBLIC_BASE_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const OPENAI_MODEL = env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_TRANSCRIBE_MODEL = env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const PROVIDER = 'choosing-to-speak-brain-backend';
const VERSION = '0.1.4';
const JONATHAN_VOICE_ENABLED = env.JONATHAN_VOICE_ENABLED !== 'false';
const MEMORY_DB_PATH = env.MEMORY_DB_PATH || env.SQLITE_DB_PATH || new URL('../data/choosing-to-speak-memory.sqlite', import.meta.url).pathname;
const MEMORY_MAX_SESSIONS = env.MEMORY_MAX_SESSIONS || 500;
const WS_HEARTBEAT_INTERVAL_MS = Number(env.WS_HEARTBEAT_INTERVAL_MS || 30000);
const WS_TRANSCRIBE_MIN_BYTES = Number(env.WS_TRANSCRIBE_MIN_BYTES || 96000);
const WS_TRANSCRIBE_INTERVAL_MS = Number(env.WS_TRANSCRIBE_INTERVAL_MS || 4500);
const WS_TRANSCRIBE_MAX_BYTES = Number(env.WS_TRANSCRIBE_MAX_BYTES || 384000);
const SHUTDOWN_TIMEOUT_MS = Number(env.SHUTDOWN_TIMEOUT_MS || 25000);
const sockets = new Set();
const memoryStore = createMemoryStore({ dbPath: MEMORY_DB_PATH, maxSessions: MEMORY_MAX_SESSIONS });
let memoryStoreClosed = false;

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
  console.log(`Memory DB: ${memoryStore.dbPath}`);
});

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

function shutdown(signal) {
  console.log(`${signal} received; closing Choosing to Speak brain backend.`);
  server.close(() => {
    closeMemoryStore();
    process.exit(0);
  });
  for (const socket of sockets) {
    if (!socket.destroyed) {
      socket.end(encodeWsFrame(Buffer.from([0x03, 0xe9]), 8));
    }
  }
  setTimeout(() => {
    closeMemoryStore();
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

function closeMemoryStore() {
  if (memoryStoreClosed) return;
  memoryStoreClosed = true;
  memoryStore.close();
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

  if (req.method !== 'POST' && req.method !== 'DELETE') {
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

  if (req.method === 'DELETE') {
    if (url.pathname === '/v1/memory') {
      handleMemoryPurge(res);
      return;
    }
    if (url.pathname.startsWith('/v1/memory/sessions/')) {
      handleMemorySessionPurge(res, decodeURIComponent(url.pathname.split('/').pop() || ''));
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
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
      await handleCoach(res, body);
      return;
    case '/v1/debrief':
      await handleDebrief(res, body);
      return;
    case '/v1/coach_review':
      await handleCoachReview(res, body);
      return;
    case '/v1/memory/enable':
      handleMemoryEnable(res);
      return;
    case '/v1/memory/sessions':
      handleMemorySessionUpload(res, body);
      return;
    case '/v1/phone_mic_proof':
      sendJson(res, 200, { proofId: requestId('phone-proof') });
      return;
    default:
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  }
}

function healthPayload() {
  const memoryStats = memoryStore.stats();
  return {
    ok: true,
    service: 'choosing-to-speak-brain-backend',
    version: VERSION,
    provider: PROVIDER,
    routes: {
      liveBrain: `${PUBLIC_BASE_URL}/v1/live_brain`,
      search: `${PUBLIC_BASE_URL}/v1/search`,
      transcribe: `${PUBLIC_BASE_URL}/v1/transcribe`,
      transcribeStream: `${PUBLIC_BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/v1/transcribe/stream`,
      debrief: `${PUBLIC_BASE_URL}/v1/debrief`,
      coachReview: `${PUBLIC_BASE_URL}/v1/coach_review`,
      memorySessions: `${PUBLIC_BASE_URL}/v1/memory/sessions`
    },
    voiceLock: {
      enabled: false,
      message: 'VoiceLock is intentionally not part of this beta backend.'
    },
    ai: {
      answerGeneration: env.OPENAI_API_KEY ? 'openai' : 'deterministic_fallback',
      transcription: env.OPENAI_API_KEY ? 'openai_audio_transcriptions' : 'listening_fallback',
      voiceProfile: JONATHAN_VOICE_ENABLED ? 'jonathan_live_response' : 'neutral',
      coachCueMode: 'contextual_auto_ephemeral',
      debrief: env.OPENAI_API_KEY ? 'openai_session_intel' : 'deterministic_session_intel',
      memorySync: 'sqlite_persistent'
    },
    memory: memoryStats
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

async function handleCoach(res, body) {
  const started = Date.now();
  const context = extractCoachContext(body);
  const requestIdValue = body?.requestId || requestId('coach');
  if (context.transcript.length < 40 && !context.memory.length) {
    sendJson(res, 200, { type: 'coach.result.v1', requestId: requestIdValue, nudge: null });
    return;
  }

  let result = null;
  if (env.OPENAI_API_KEY) {
    result = await askOpenAICoach(context).catch((error) => {
      console.warn(`OpenAI coach fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (!result) result = deterministicCoach(context);

  sendJson(res, 200, {
    type: 'coach.result.v1',
    requestId: requestIdValue,
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/coach`,
    latencyMs: Math.max(0, Date.now() - started),
    nudge: result.nudge,
    sayThis: result.sayThis
  });
}

async function handleDebrief(res, body) {
  const started = Date.now();
  const requestIdValue = body?.requestId || requestId('debrief');
  const input = extractDebriefInput(body);
  let debrief = null;
  if (env.OPENAI_API_KEY) {
    debrief = await askOpenAIDebrief(input).catch((error) => {
      console.warn(`OpenAI debrief fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (!debrief) debrief = deterministicDebrief(input);
  rememberDebrief(input, debrief);
  sendJson(res, 200, {
    type: 'debrief.result.v1',
    requestId: requestIdValue,
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/debrief`,
    latencyMs: Math.max(0, Date.now() - started),
    debrief
  });
}

async function handleCoachReview(res, body) {
  const started = Date.now();
  const requestIdValue = body?.requestId || requestId('coach-review');
  const input = extractDebriefInput(body);
  let review = null;
  if (env.OPENAI_API_KEY) {
    review = await askOpenAICoachReview(input).catch((error) => {
      console.warn(`OpenAI coach review fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (!review) review = deterministicCoachReview(input);
  sendJson(res, 200, {
    type: 'coach_review.result.v1',
    requestId: requestIdValue,
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/coach_review`,
    latencyMs: Math.max(0, Date.now() - started),
    review
  });
}

function handleMemoryEnable(res) {
  sendJson(res, 200, { ok: true, syncEnabled: true, provider: PROVIDER });
}

function handleMemorySessionUpload(res, body) {
  const session = normalizeMemorySession(body);
  if (!session) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_SESSION_MEMORY', message: 'Session memory payload was empty or invalid.' } });
    return;
  }
  const stored = memoryStore.upsertSession(session);
  sendJson(res, 200, {
    ok: true,
    status: 'uploaded',
    sessionId: session.sessionId,
    storedItems: stored.storedItems
  });
}

function handleMemoryPurge(res) {
  const purged = memoryStore.purgeAll();
  sendJson(res, 200, { ok: true, purged });
}

function handleMemorySessionPurge(res, sessionId) {
  const id = cleanText(sessionId);
  const purged = id ? memoryStore.deleteSession(id) : 0;
  sendJson(res, 200, { ok: true, purged });
}

async function askOpenAI({ question, intent, settings, context }) {
  const prompt = [
    'You are the Choosing to Speak live conversation brain.',
    'Return only concise coaching text for smart-glasses display.',
    'No markdown fences. No safety boilerplate. No private chain of thought.',
    JONATHAN_VOICE_ENABLED ? JONATHAN_LIVE_RESPONSE_VOICE : '',
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

async function askOpenAICoach(context) {
  const prompt = [
    'You are the Choosing to Speak automatic coaching lane for smart glasses.',
    'Generate one short, timely coaching cue based on the SCENE CONTEXT and the recent transcript.',
    'Scene context is primary: role, person, goal, vibe, boundaries, risks, and pre-session notes should shape the cue.',
    'The cue must feel like it belongs to this exact conversation, not generic advice.',
    'Prefer a concrete next thing the wearer can ask, say, notice, or avoid.',
    'If the transcript contains an interview-style question, give a concise answer frame tied to the scene goal.',
    'If the transcript is not a question, cue the next conversational move that advances the scene goal.',
    'Do not mention being an AI. Do not give a long analysis.',
    JONATHAN_VOICE_ENABLED ? JONATHAN_LIVE_RESPONSE_VOICE : '',
    'Return JSON only: {"teaser":"...","explanation":"...","sayThis":["..."]}',
    'Constraints: teaser <= 64 characters. explanation <= 180 characters. sayThis has 1-2 speakable lines, each <= 110 characters.',
    `Lens: ${context.lensId || 'default'}`,
    context.sessionLanguage && context.sessionLanguage !== 'en' ? `Language: ${context.sessionLanguage}` : '',
    context.memory.length ? `SCENE CONTEXT:\n${context.memory.map((item) => `- ${item}`).join('\n')}` : '',
    `Recent transcript:\n${context.transcript}`
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
      max_output_tokens: 220
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI coach HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const parsed = parseCoachJson(extractOpenAIText(data));
  if (!parsed) throw new Error('OpenAI returned no coach JSON.');
  return parsed;
}

async function askOpenAIDebrief(input) {
  const prompt = [
    'You are the Choosing to Speak post-session intelligence engine for smart glasses.',
    'Summarize the live conversation into durable, future-useful session memory.',
    'Prefer specifics: commitments, unanswered questions, useful patterns, and the next conversation move.',
    'Do not invent commitments, names, dates, numbers, or outcomes.',
    JONATHAN_VOICE_ENABLED ? JONATHAN_LIVE_RESPONSE_VOICE : '',
    'Return JSON only with this shape:',
    '{"goalOutcome":{"status":"met|partial|missed|no_goal","evidence":"..."},"summary":"...","lesson":"...","commitments":[{"text":"...","ownerKind":"me|other|unknown","due":"optional"}],"moments":[{"kind":"up|down","note":"...","atMs":0}],"talkShareNote":"..."}',
    'Limits: summary <= 600 chars. lesson <= 220 chars. commitments <= 8. moments <= 2.',
    input.goal ? `Goal: ${input.goal}` : 'Goal: none',
    input.context.length ? `Prior/session context:\n${input.context.map((item) => `- ${item}`).join('\n')}` : '',
    input.capturedItems.length ? `Captured items:\n${input.capturedItems.map((item) => `- ${item.kind}: ${item.text}`).join('\n')}` : '',
    `Transcript:\n${input.transcript || '(no transcript)'}`
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
      max_output_tokens: 700
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI debrief HTTP ${response.status}: ${await response.text()}`);
  }

  const parsed = parseDebriefJson(extractOpenAIText(await response.json()));
  if (!parsed) throw new Error('OpenAI returned no debrief JSON.');
  return parsed;
}

async function askOpenAICoachReview(input) {
  const prompt = [
    'You are reviewing how Choosing to Speak coached a smart-glasses conversation.',
    'Give a practical review the wearer can use next time. Keep it concise and behavior-specific.',
    'Do not invent events. If evidence is thin, say so and make the next action small.',
    JONATHAN_VOICE_ENABLED ? JONATHAN_LIVE_RESPONSE_VOICE : '',
    'Return JSON only with this shape:',
    '{"goalOutcome":{"status":"met|partial|missed|no_goal","evidence":"..."},"moments":[{"kind":"up|down","note":"...","atMs":0}],"commitments":[{"text":"...","ownerKind":"me|other|unknown","due":"optional"}],"coaching":[{"dimension":"...","observation":"...","suggestion":"..."}],"lesson":"...","talkShareNote":"..."}',
    'Limits: moments <= 4. commitments <= 12. coaching <= 4. lesson <= 220 chars.',
    input.goal ? `Goal: ${input.goal}` : 'Goal: none',
    input.context.length ? `Prior/session context:\n${input.context.map((item) => `- ${item}`).join('\n')}` : '',
    input.capturedItems.length ? `Captured items:\n${input.capturedItems.map((item) => `- ${item.kind}: ${item.text}`).join('\n')}` : '',
    `Transcript:\n${input.transcript || '(no transcript)'}`
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
      max_output_tokens: 800
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI coach review HTTP ${response.status}: ${await response.text()}`);
  }

  const parsed = parseCoachReviewJson(extractOpenAIText(await response.json()));
  if (!parsed) throw new Error('OpenAI returned no coach review JSON.');
  return parsed;
}

function parseDebriefJson(text) {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const summary = truncate(cleanText(raw.summary), 600);
  const lesson = truncate(cleanText(raw.lesson), 240) || 'Keep the next conversation focused on one concrete next move.';
  return {
    goalOutcome: sanitizeGoalOutcome(raw.goalOutcome),
    summary,
    lesson,
    commitments: sanitizeCommitments(raw.commitments, 8),
    moments: sanitizeMoments(raw.moments, 2),
    ...(cleanText(raw.talkShareNote) ? { talkShareNote: truncate(cleanText(raw.talkShareNote), 200) } : {})
  };
}

function parseCoachReviewJson(text) {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  return {
    goalOutcome: sanitizeGoalOutcome(raw.goalOutcome),
    moments: sanitizeMoments(raw.moments, 4),
    commitments: sanitizeCommitments(raw.commitments, 12),
    coaching: sanitizeCoaching(raw.coaching),
    lesson: truncate(cleanText(raw.lesson), 240) || 'Use fewer, sharper cues tied to what the other person just said.',
    talkShareNote: truncate(cleanText(raw.talkShareNote), 200)
  };
}

function parseJsonObject(text) {
  const trimmed = cleanText(String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, ''));
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function sanitizeGoalOutcome(value) {
  const raw = isRecord(value) ? value : {};
  const allowed = new Set(['met', 'partial', 'missed', 'no_goal']);
  const status = allowed.has(raw.status) ? raw.status : 'no_goal';
  return { status, evidence: truncate(cleanText(raw.evidence), 240) };
}

function sanitizeCommitments(value, max = 8) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['me', 'other', 'unknown']);
  const seen = new Set();
  const commitments = [];
  for (const item of value) {
    const text = truncate(cleanText(item?.text || item?.primary), 200);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commitments.push({
      text,
      ownerKind: allowed.has(item?.ownerKind) ? item.ownerKind : ownerKindFromText(item?.owner || item?.ownerLabel || ''),
      ...(cleanText(item?.due) ? { due: truncate(cleanText(item.due), 80) } : {})
    });
    if (commitments.length >= max) break;
  }
  return commitments;
}

function sanitizeMoments(value, max = 2) {
  if (!Array.isArray(value)) return [];
  const moments = [];
  for (const item of value) {
    const note = truncate(cleanText(item?.note || item?.text), 200);
    if (!note) continue;
    moments.push({
      kind: item?.kind === 'down' ? 'down' : 'up',
      note,
      ...(Number.isFinite(item?.atMs) ? { atMs: item.atMs } : {}),
      ...(cleanText(item?.turnRef) ? { turnRef: truncate(cleanText(item.turnRef), 120) } : {})
    });
    if (moments.length >= max) break;
  }
  return moments;
}

function sanitizeCoaching(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      dimension: truncate(cleanText(item?.dimension || 'clarity'), 80),
      observation: truncate(cleanText(item?.observation), 240),
      suggestion: truncate(cleanText(item?.suggestion), 240)
    }))
    .filter((item) => item.dimension && item.observation && item.suggestion)
    .slice(0, 4);
}

function parseCoachJson(text) {
  const trimmed = cleanText(String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, ''));
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const teaser = truncate(cleanText(raw.teaser), 70);
  const explanation = truncate(cleanText(raw.explanation), 180);
  const sayThis = Array.isArray(raw.sayThis)
    ? raw.sayThis.map((line) => truncate(cleanText(line), 110)).filter(Boolean).slice(0, 2)
    : [];
  if (!teaser || !explanation) return null;
  return { nudge: { teaser, explanation }, sayThis };
}

function deterministicCoach(context) {
  const topic = summarizeQuestion(context.transcript || context.memory.join(' '));
  const memoryHint = context.memory[0] ? ` Tie it to prep: ${truncate(context.memory[0], 90)}` : '';
  if (/\?/.test(context.transcript)) {
    return {
      nudge: {
        teaser: 'Use the scene goal as the frame.',
        explanation: `Answer directly, then connect one concrete example to the scene goal.${memoryHint}`
      },
      sayThis: [`The short answer is this: ${topic}.`, 'One example that shows that is...']
    };
  }
  return {
    nudge: {
      teaser: 'Move the scene forward.',
      explanation: `Use the context you set before the session, then ask one short question that narrows ${topic}.${memoryHint}`
    },
    sayThis: [`What matters most about ${topic} right now?`, 'Can you give me one concrete example?']
  };
}

function deterministicDebrief(input) {
  const topic = summarizeQuestion(input.transcript || input.goal || input.context.join(' '));
  const commitments = [
    ...sanitizeCommitments(input.localCommitments, 8),
    ...inferCommitments(input.transcript)
  ].slice(0, 8);
  const talkShareNote = talkShare(input.turns);
  return {
    goalOutcome: input.goal
      ? { status: input.transcript.length > 80 ? 'partial' : 'missed', evidence: truncate(`Session touched the goal: ${input.goal}`, 220) }
      : { status: 'no_goal', evidence: 'No explicit goal was provided for this session.' },
    summary: truncate(`Covered ${topic}. The useful follow-up is to turn the strongest thread into one concrete next step and capture any open decision.`, 600),
    lesson: truncate(`Next time, anchor the scene up front and ask for one concrete example or decision around ${topic}.`, 240),
    commitments,
    moments: deterministicMoments(input),
    ...(talkShareNote ? { talkShareNote } : {})
  };
}

function deterministicCoachReview(input) {
  const debrief = deterministicDebrief(input);
  const topic = summarizeQuestion(input.transcript || input.goal || input.context.join(' '));
  return {
    goalOutcome: debrief.goalOutcome,
    moments: deterministicMoments(input, 4),
    commitments: debrief.commitments.slice(0, 12),
    coaching: [
      {
        dimension: 'context',
        observation: input.context.length
          ? 'Pre-session context was available and should shape the live cue.'
          : 'The session had little explicit pre-session context.',
        suggestion: 'Before starting, set the scene goal, person, and one risk you want cues to watch for.'
      },
      {
        dimension: 'specificity',
        observation: `The strongest live thread was ${topic}.`,
        suggestion: 'Ask for one named example, date, owner, or next action when the conversation gets broad.'
      }
    ],
    lesson: debrief.lesson,
    talkShareNote: debrief.talkShareNote || ''
  };
}

function deterministicMoments(input, max = 2) {
  const moments = [];
  const otherQuestion = input.turns.find((turn) => turn.speakerKind !== 'ME' && /\?/.test(turn.text));
  if (otherQuestion) {
    moments.push({
      kind: 'up',
      note: truncate(`Good opportunity to answer or probe: ${otherQuestion.text}`, 200),
      ...(Number.isFinite(otherQuestion.atMs) ? { atMs: otherQuestion.atMs } : {})
    });
  }
  const vagueTurn = input.turns.find((turn) => /\b(maybe|probably|sort of|kind of|thing|stuff|unclear|not sure)\b/i.test(turn.text));
  if (vagueTurn) {
    moments.push({
      kind: 'down',
      note: truncate(`Clarify vague wording before moving on: ${vagueTurn.text}`, 200),
      ...(Number.isFinite(vagueTurn.atMs) ? { atMs: vagueTurn.atMs } : {})
    });
  }
  if (!moments.length) {
    moments.push({ kind: 'up', note: truncate(`Main thread: ${summarizeQuestion(input.transcript || input.goal || 'the session')}`, 200) });
  }
  return moments.slice(0, max);
}

function inferCommitments(transcript) {
  const commitments = [];
  const sentences = cleanText(transcript).split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    if (!/\b(I will|I'll|we will|we'll|I can|we can|follow up|send|schedule|circle back|next step|action item)\b/i.test(sentence)) {
      continue;
    }
    commitments.push({ text: truncate(sentence, 180), ownerKind: /\b(I will|I'll|I can)\b/i.test(sentence) ? 'me' : 'unknown' });
    if (commitments.length >= 4) break;
  }
  return sanitizeCommitments(commitments, 4);
}

function talkShare(turns) {
  let me = 0;
  let other = 0;
  for (const turn of turns) {
    const words = cleanText(turn.text).split(/\s+/).filter(Boolean).length;
    if (turn.speakerKind === 'ME') me += words;
    else other += words;
  }
  const total = me + other;
  if (!total) return '';
  const mePercent = Math.round((me / total) * 100);
  return `Approximate talk share: you ${mePercent}%, other ${100 - mePercent}%.`;
}

function extractCoachContext(body) {
  const digest = isRecord(body?.digest) ? body.digest : null;
  const turnSource = Array.isArray(body?.recentTurns)
    ? body.recentTurns
    : Array.isArray(digest?.recentTurns)
      ? digest.recentTurns
      : [];
  const recentTurns = turnSource
        .map((turn) => {
          const speaker = cleanText(turn?.speaker || turn?.speakerKind || '');
          const text = cleanText(turn?.text || '');
          return text ? `${speaker ? `${speaker}: ` : ''}${text}` : '';
        })
        .filter(Boolean);
  const digestText = typeof body?.digest === 'string' ? body.digest : digest?.windowSummary;
  const transcript = cleanText([
    body?.transcript,
    body?.recentTranscript,
    digestText,
    recentTurns.join(' ')
  ].filter(Boolean).join(' '));
  const memory = [];
  for (const value of [
    body?.activeBriefLabel,
    body?.activeContextSummary,
    body?.context,
    body?.scene,
    body?.sessionBlock,
    body?.currentScene,
    ...(Array.isArray(body?.memoryContext?.items) ? body.memoryContext.items : []),
    ...(Array.isArray(body?.retrievedMemorySnippets) ? body.retrievedMemorySnippets : []),
    ...(Array.isArray(digest?.context) ? digest.context : [])
  ]) {
    for (const text of extractContextStrings(value)) {
      if (text) memory.push(truncate(text, 240));
    }
  }
  const lensId = cleanText(body?.lensId || body?.activeLensId || '');
  for (const text of storedMemoryHints({ lensId, limit: 6 })) {
    memory.push(truncate(text, 240));
  }
  return {
    transcript: truncate(transcript, 3000),
    memory: uniqueStrings(memory).slice(0, 10),
    lensId,
    sessionLanguage: cleanText(body?.sessionLanguage || '')
  };
}

function extractDebriefInput(body) {
  const source = isRecord(body?.input) ? body.input : body;
  const rawTurns = Array.isArray(source?.turns)
    ? source.turns
    : Array.isArray(source?.transcriptTurns)
      ? source.transcriptTurns
      : Array.isArray(source?.session?.transcriptTurns)
        ? source.session.transcriptTurns
        : [];
  const turns = rawTurns
    .map((turn) => {
      const text = cleanText(turn?.text || turn?.transcript || turn?.primary || '');
      if (!text) return null;
      const speakerKind = normalizeSpeakerKind(turn?.speakerKind || turn?.speaker || turn?.speakerLabel);
      const atMs = Number.isFinite(turn?.atMs)
        ? turn.atMs
        : Number.isFinite(turn?.startedAtMs)
          ? turn.startedAtMs
          : Number.isFinite(Date.parse(turn?.startedAt || ''))
            ? Date.parse(turn.startedAt)
            : undefined;
      return {
        speakerKind,
        speakerLabel: cleanText(turn?.speakerLabel || turn?.speaker || ''),
        text,
        ...(Number.isFinite(atMs) ? { atMs } : {})
      };
    })
    .filter(Boolean);
  const capturedItems = normalizeCapturedItems(source?.capturedItems);
  const localCommitments = sanitizeCommitments(source?.localCommitments, 12);
  const context = [];
  for (const value of [
    source?.activeBriefLabel,
    source?.activeContextSummary,
    source?.context,
    source?.scene,
    source?.sessionBlock,
    source?.currentScene,
    ...(Array.isArray(source?.memoryContext?.items) ? source.memoryContext.items : []),
    ...(Array.isArray(source?.retrievedMemorySnippets) ? source.retrievedMemorySnippets : [])
  ]) {
    context.push(...extractContextStrings(value).map((item) => truncate(item, 240)));
  }
  const lensId = cleanText(source?.lensId || source?.activeLensId || '');
  context.push(...storedMemoryHints({ lensId, limit: 6 }));
  const transcript = cleanText([
    source?.transcript,
    source?.recentTranscript,
    turns.map((turn) => `${turn.speakerLabel || turn.speakerKind}: ${turn.text}`).join('\n')
  ].filter(Boolean).join('\n'));
  return {
    sessionId: cleanText(source?.sessionId || source?.id || 'session'),
    lensId,
    goal: cleanText(source?.goal || source?.sessionGoal || source?.objective || ''),
    sessionLanguage: cleanText(source?.sessionLanguage || ''),
    durationMs: Number.isFinite(source?.durationMs) ? Math.max(0, Math.round(source.durationMs)) : 0,
    turns,
    transcript: truncate(transcript, 6000),
    capturedItems,
    localCommitments,
    context: uniqueStrings(context).slice(0, 10)
  };
}

function normalizeMemorySession(body) {
  const sessionId = cleanText(body?.sessionId || body?.id);
  const lensId = cleanText(body?.lensId || body?.activeLensId || 'default');
  if (!sessionId || !lensId) return null;
  const startedAt = normalizeDate(body?.sessionStartedAt || body?.startedAt || body?.createdAt) || new Date().toISOString();
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const items = rawItems
    .map((item) => ({
      kind: truncate(cleanText(item?.kind || 'note'), 40),
      body: truncate(cleanText(item?.body || item?.text || item?.summary || ''), 600)
    }))
    .filter((item) => item.kind && item.body)
    .slice(0, 24);
  if (!items.length) return null;
  return {
    sessionId,
    lensId,
    sessionStartedAt: startedAt,
    uploadedAt: new Date().toISOString(),
    items
  };
}

function rememberDebrief(input, debrief) {
  if (!input.sessionId || !debrief) return;
  const items = [
    debrief.summary ? { kind: 'recap', body: debrief.summary } : null,
    debrief.lesson ? { kind: 'lesson', body: debrief.lesson } : null,
    ...(debrief.commitments || []).map((item) => ({ kind: 'commitment', body: `${item.ownerKind === 'me' ? 'You' : item.ownerKind === 'other' ? 'Them' : 'Someone'}: ${item.text}` })),
    ...(debrief.moments || []).map((item) => ({ kind: 'moment', body: `${item.kind === 'down' ? 'Watch' : 'Useful'}: ${item.note}` }))
  ].filter(Boolean);
  const normalized = normalizeMemorySession({
    sessionId: input.sessionId,
    lensId: input.lensId || 'default',
    sessionStartedAt: new Date().toISOString(),
    items
  });
  if (normalized) {
    memoryStore.upsertSession(normalized);
  }
}

function storedMemoryHints({ lensId = '', limit = 6 } = {}) {
  return memoryStore.hints({ lensId: cleanText(lensId), limit });
}

function extractContextStrings(value, depth = 0) {
  if (depth > 2 || value == null) return [];
  if (typeof value === 'string') {
    const text = cleanText(value);
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractContextStrings(item, depth + 1)).slice(0, 12);
  }
  if (!isRecord(value)) return [];
  const preferred = [
    value.title,
    value.label,
    value.goal,
    value.vibe,
    value.person,
    value.role,
    value.scene,
    value.summary,
    value.text,
    value.context,
    value.boundaries,
    value.notes,
    value.risk,
    value.callbackNotes,
    value.forbiddenTopics
  ];
  return preferred.flatMap((item) => extractContextStrings(item, depth + 1)).slice(0, 12);
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
  const lens = cleanText(input.lensId || input.activeLensId || '');
  for (const text of storedMemoryHints({ lensId: lens, limit: 4 })) {
    memory.push(truncate(text, 240));
  }
  return {
    lens,
    brief: cleanText(input.activeBriefLabel || ''),
    memory: uniqueStrings(memory).slice(0, 8)
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

function normalizeSpeakerKind(value) {
  const text = cleanText(value).toUpperCase();
  if (text === 'ME' || text === 'SELF' || text === 'OWNER' || text === 'YOU') return 'ME';
  if (text === 'NOT_ME' || text === 'OTHER' || text === 'THEM') return 'NOT_ME';
  return 'UNKNOWN';
}

function normalizeCapturedItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      kind: truncate(cleanText(item?.kind || 'note'), 40),
      text: truncate(cleanText(item?.text || item?.primary || ''), 240),
      owner: cleanText(item?.owner || item?.ownerLabel || ''),
      due: cleanText(item?.due || '')
    }))
    .filter((item) => item.kind && item.text)
    .slice(0, 20);
}

function ownerKindFromText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return 'unknown';
  return ['you', 'me', 'i', 'myself', 'self', 'jonathan'].includes(text) ? 'me' : 'other';
}

function normalizeDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
