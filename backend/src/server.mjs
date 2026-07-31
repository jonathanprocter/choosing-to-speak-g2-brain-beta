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
const VERSION = '0.1.5';
const JONATHAN_VOICE_ENABLED = env.JONATHAN_VOICE_ENABLED !== 'false';
const MEMORY_DB_PATH = env.MEMORY_DB_PATH || env.SQLITE_DB_PATH || new URL('../data/choosing-to-speak-memory.sqlite', import.meta.url).pathname;
const MEMORY_MAX_SESSIONS = env.MEMORY_MAX_SESSIONS || 500;
const ROSTER_TIME_ZONE = env.CALENDAR_TIME_ZONE || env.ROSTER_TIME_ZONE || 'America/New_York';
const WS_HEARTBEAT_INTERVAL_MS = Number(env.WS_HEARTBEAT_INTERVAL_MS || 30000);
const WS_TRANSCRIBE_MIN_BYTES = Number(env.WS_TRANSCRIBE_MIN_BYTES || 24000);
const WS_TRANSCRIBE_INTERVAL_MS = Number(env.WS_TRANSCRIBE_INTERVAL_MS || 2500);
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
    if (url.pathname.startsWith('/v1/client_context/')) {
      handleClientContextPurge(res, decodeURIComponent(url.pathname.split('/').pop() || ''));
      return;
    }
    if (url.pathname.startsWith('/v1/day_roster/')) {
      handleDayRosterPurge(res, decodeURIComponent(url.pathname.split('/').pop() || ''), url.searchParams);
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
    case '/v1/question_cues':
      await handleQuestionCues(res, body);
      return;
    case '/v1/memory/enable':
      handleMemoryEnable(res);
      return;
    case '/v1/memory/sessions':
      handleMemorySessionUpload(res, body);
      return;
    case '/v1/client_context':
      handleClientContextUpload(res, body);
      return;
    case '/v1/day_roster':
      handleDayRosterUpload(res, body);
      return;
    case '/v1/client_candidate':
      handleClientCandidate(res, body);
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
      questionCues: `${PUBLIC_BASE_URL}/v1/question_cues`,
      memorySessions: `${PUBLIC_BASE_URL}/v1/memory/sessions`,
      clientContext: `${PUBLIC_BASE_URL}/v1/client_context`,
      dayRoster: `${PUBLIC_BASE_URL}/v1/day_roster`,
      clientCandidate: `${PUBLIC_BASE_URL}/v1/client_candidate`
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
      memorySync: 'sqlite_persistent',
      clientContext: 'sqlite_notion_session_prep_question_cues',
      dayRoster: 'calendar_sync_candidate_resolver',
      dynamics: 'clinical_hud_inspired_metrics'
    },
    calendar: {
      timeZone: ROSTER_TIME_ZONE,
      dateMode: 'local_day_not_utc'
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
    sayThis: result.sayThis,
    questionCue: result.questionCue || buildQuestionCue(context),
    dynamics: context.dynamics,
    clientContextUsed: summarizeClientContextUse(context)
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

function handleClientContextUpload(res, body) {
  const context = normalizeClientContext(body);
  if (!context) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: 'INVALID_CLIENT_CONTEXT',
        message: 'Client context needs a client name/id plus at least a summary or one item.'
      }
    });
    return;
  }
  const stored = memoryStore.upsertClientContext(context);
  sendJson(res, 200, {
    ok: true,
    status: 'uploaded',
    clientId: context.clientId,
    displayName: context.displayName,
    storedItems: stored.storedItems,
    updatedAt: context.updatedAt
  });
}

function handleClientContextPurge(res, clientId) {
  const id = cleanText(clientId);
  const purged = id ? memoryStore.deleteClientContext(id) : 0;
  sendJson(res, 200, { ok: true, purged });
}

function handleDayRosterUpload(res, body) {
  const roster = normalizeDayRoster(body);
  if (!roster) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: 'INVALID_DAY_ROSTER',
        message: 'Day roster needs a date plus at least one appointment with a client name and start time.'
      }
    });
    return;
  }
  const stored = memoryStore.upsertDayRoster(roster);
  let storedClientContexts = 0;
  for (const entry of roster.entries) {
    if (entry.clientContext) {
      const clientStored = memoryStore.upsertClientContext(entry.clientContext);
      if (clientStored.storedItems > 0 || entry.clientContext.summary) storedClientContexts += 1;
    }
  }
  sendJson(res, 200, {
    ok: true,
    status: 'uploaded',
    rosterDate: roster.rosterDate,
    lensId: roster.lensId,
    source: roster.source,
    storedItems: stored.storedItems,
    storedClientContexts,
    updatedAt: roster.updatedAt
  });
}

function handleDayRosterPurge(res, rosterDate, searchParams) {
  const date = cleanText(rosterDate);
  const lensId = cleanText(searchParams?.get('lensId') || searchParams?.get('lens') || 'default') || 'default';
  const purged = date ? memoryStore.deleteDayRoster({ rosterDate: date, lensId }) : 0;
  sendJson(res, 200, { ok: true, purged });
}

function handleClientCandidate(res, body) {
  const source = isRecord(body?.input) ? body.input : body;
  const lensId = cleanText(source?.lensId || source?.activeLensId || 'clinical') || 'clinical';
  const at = normalizeDate(source?.at || source?.now || source?.timestamp) || new Date().toISOString();
  const rosterDate = normalizeRosterDate(source?.date || source?.rosterDate, at);
  const dismissed = new Set(
    (Array.isArray(source?.dismissedClientIds) ? source.dismissedClientIds : [])
      .map((item) => cleanText(item).toLowerCase())
      .filter(Boolean)
  );
  const manualSource = source?.manualClientContext ||
    source?.manualClient ||
    source?.clientContext ||
    (source?.manualClientName || source?.manualName
      ? { displayName: source.manualClientName || source.manualName, lensId, source: 'manual' }
      : null);
  const manualContext = normalizeClientContext(manualSource);
  const manualDisplayName = cleanText(manualContext?.displayName || manualSource?.displayName || manualSource?.clientName || manualSource?.name || '');
  const manualClientId = cleanText(manualContext?.clientId || manualSource?.clientId || manualSource?.client_id || '') ||
    (manualDisplayName ? stableClientId(manualDisplayName, 'manual') : '');
  if (manualContext || manualDisplayName || manualClientId) {
    if (manualContext) memoryStore.upsertClientContext(manualContext);
    sendJson(res, 200, {
      type: 'client_candidate.result.v1',
      requestId: source?.requestId || requestId('client-candidate'),
      provider: PROVIDER,
      selected: {
        clientId: manualContext?.clientId || manualClientId,
        displayName: manualContext?.displayName || manualDisplayName || manualClientId,
        source: manualContext?.source || 'manual',
        confidence: 1,
        reason: 'manual_override'
      },
      candidates: [],
      contextHints: manualContext ? memoryStore.clientHints({
        lensId,
        clientId: manualContext.clientId,
        displayName: manualContext.displayName,
        limit: 8
      }) : []
    });
    return;
  }
  const candidates = memoryStore
    .rosterCandidates({ lensId, date: rosterDate, at, limit: 8 })
    .filter((candidate) => !dismissed.has(cleanText(candidate.clientId).toLowerCase()));
  const selected = candidates[0] || null;
  const contextHints = selected
    ? memoryStore.clientHints({ lensId, clientId: selected.clientId, displayName: selected.displayName, limit: 8 })
    : [];
  sendJson(res, 200, {
    type: 'client_candidate.result.v1',
    requestId: source?.requestId || requestId('client-candidate'),
    provider: PROVIDER,
    rosterDate,
    selected: selected
      ? {
          clientId: selected.clientId,
          displayName: selected.displayName,
          startsAt: selected.startsAt,
          endsAt: selected.endsAt,
          source: selected.source,
          confidence: selected.active ? 0.86 : 0.64,
          reason: selected.active ? 'calendar_window_match' : 'nearest_calendar_event'
        }
      : null,
    candidates,
    contextHints
  });
}

async function handleQuestionCues(res, body) {
  const started = Date.now();
  const context = extractCoachContext(body);
  const requestIdValue = body?.requestId || requestId('question-cues');
  const questionCue = buildQuestionCue(context);
  sendJson(res, 200, {
    type: 'question_cues.result.v1',
    requestId: requestIdValue,
    provider: PROVIDER,
    modelRoute: `${PUBLIC_BASE_URL}/v1/question_cues`,
    latencyMs: Math.max(0, Date.now() - started),
    nudge: questionCue.nudge,
    sayThis: questionCue.questions.map((question) => question.text).slice(0, 2),
    questions: questionCue.questions,
    dynamics: context.dynamics,
    clientContextUsed: summarizeClientContextUse(context)
  });
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
    'You are the Choosing to Speak counselor-colleague lane for smart glasses.',
    'Write like a warm, clinically trained mental-health counselor colleague supporting Jonathan during a live session.',
    'Generate one short, timely cue based on the SCENE CONTEXT and the recent transcript.',
    'Scene context is primary: client, goal, affect, risk, boundaries, ruptures, and pre-session notes should shape the cue.',
    'Client context is durable prep from the roster, Notion, or the clinical HUD. Use it to choose the best empathic reflection, question, repair, or next move.',
    'Conversation dynamics show whether Jonathan should listen longer, repair, clarify, slow down, ask a sharper question, or name a feeling.',
    'The cue must feel like it belongs to this exact counseling moment, not generic advice.',
    'Prefer one concrete thing Jonathan can ask, say, notice, or avoid. Keep it clinically grounded and client-centered.',
    'The visible cue appears as a temporary foreground glasses card, so make it punchy enough to scan without touching the ring or glasses.',
    'If the transcript contains a direct question, give a concise answer frame tied to the client goal.',
    'If the transcript is not a question, cue the next therapeutic move that advances the session goal.',
    'Do not diagnose, over-pathologize, moralize, or move faster than the client.',
    'Do not mention being an AI. Do not give a long analysis.',
    JONATHAN_VOICE_ENABLED ? JONATHAN_LIVE_RESPONSE_VOICE : '',
    'Return JSON only: {"teaser":"...","explanation":"...","sayThis":["..."]}',
    'Constraints: teaser <= 48 characters. explanation <= 135 characters. sayThis has 0-1 speakable lines <= 95 characters.',
    `Lens: ${context.lensId || 'default'}`,
    context.sessionLanguage && context.sessionLanguage !== 'en' ? `Language: ${context.sessionLanguage}` : '',
    context.memory.length ? `SCENE CONTEXT:\n${context.memory.map((item) => `- ${item}`).join('\n')}` : '',
    context.clientContext?.hints ? `Client context used: ${context.clientContext.hints} hint(s)` : '',
    context.dynamics ? `Dynamics: ${JSON.stringify(context.dynamics)}` : '',
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
    input.clientContext?.displayName ? `Selected client: ${input.clientContext.displayName}` : '',
    input.dynamics ? `Conversation dynamics: ${JSON.stringify(input.dynamics)}` : '',
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
    input.clientContext?.displayName ? `Selected client: ${input.clientContext.displayName}` : '',
    input.dynamics ? `Conversation dynamics: ${JSON.stringify(input.dynamics)}` : '',
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
  const explanation = truncate(cleanText(raw.explanation), 135);
  const sayThis = Array.isArray(raw.sayThis)
    ? raw.sayThis.map((line) => truncate(cleanText(line), 95)).filter(Boolean).slice(0, 1)
    : [];
  if (!teaser || !explanation) return null;
  return { nudge: { teaser, explanation }, sayThis };
}

function deterministicCoach(context) {
  const questionCue = buildQuestionCue(context);
  if (questionCue.source === 'client_context' || questionCue.source === 'dynamics') {
    return {
      nudge: questionCue.nudge,
      sayThis: questionCue.questions.map((question) => question.text).slice(0, 1),
      questionCue
    };
  }
  const topic = summarizeQuestion(context.transcript || context.memory.join(' '));
  const memoryHint = context.memory[0] ? ` Prep: ${truncate(context.memory[0], 48)}` : '';
  if (/\?/.test(context.transcript)) {
    return {
      nudge: {
        teaser: 'Answer, then return to the goal.',
        explanation: `Answer briefly, then ask one empathic question tied to the session goal.${memoryHint}`
      },
      sayThis: [`What feels most important about that right now?`],
      questionCue
    };
  }
  return {
    nudge: {
      teaser: 'Offer one grounded next move.',
      explanation: `Reflect what changed, then ask one short question that narrows ${topic}.${memoryHint}`
    },
    sayThis: questionCue.questions.map((question) => question.text).slice(0, 1),
    questionCue
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
  const turns = normalizeCoachTurns(turnSource);
  const recentTurns = turns.map((turn) => `${turn.speakerLabel || turn.speakerKind}: ${turn.text}`);
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
  const clientContext = resolveClientContextForRequest(body, { lensId });
  if (clientContext?.calendarHint) memory.push(clientContext.calendarHint);
  for (const text of clientContext?.inlineHints || []) {
    memory.push(truncate(text, 240));
  }
  for (const text of clientContext?.storedHints || []) {
    memory.push(truncate(text, 240));
  }
  for (const text of storedMemoryHints({ lensId, limit: 6 })) {
    memory.push(truncate(text, 240));
  }
  return {
    transcript: truncate(transcript, 3000),
    memory: uniqueStrings(memory).slice(0, 10),
    turns,
    dynamics: buildConversationDynamics(turns, body),
    clientContext,
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
  const clientContext = resolveClientContextForRequest(source, { lensId });
  if (clientContext?.calendarHint) context.push(clientContext.calendarHint);
  context.push(...(clientContext?.inlineHints || []));
  context.push(...(clientContext?.storedHints || []));
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
    clientContext,
    dynamics: buildConversationDynamics(turns, source),
    context: uniqueStrings(context).slice(0, 10)
  };
}

function normalizeCoachTurns(turnSource) {
  if (!Array.isArray(turnSource)) return [];
  return turnSource.map(normalizeCoachTurn).filter(Boolean);
}

function normalizeCoachTurn(turn) {
  const text = cleanText(turn?.text || turn?.transcript || turn?.primary || '');
  if (!text) return null;
  const speakerLabel = cleanText(turn?.speakerLabel || turn?.speaker || turn?.speakerKind || '');
  const speakerKind = speakerKindFromCoachSpeaker(turn?.speakerKind || turn?.speaker || turn?.speakerLabel);
  const atMs = Number.isFinite(turn?.atMs)
    ? turn.atMs
    : Number.isFinite(turn?.startedAtMs)
      ? turn.startedAtMs
      : Number.isFinite(Date.parse(turn?.startedAt || ''))
        ? Date.parse(turn.startedAt)
        : undefined;
  const endedAtMs = Number.isFinite(turn?.endedAtMs)
    ? turn.endedAtMs
    : Number.isFinite(Date.parse(turn?.endedAt || ''))
      ? Date.parse(turn.endedAt)
      : undefined;
  return {
    speakerKind,
    speakerLabel,
    text,
    ...(Number.isFinite(atMs) ? { atMs } : {}),
    ...(Number.isFinite(endedAtMs) ? { endedAtMs } : {})
  };
}

function speakerKindFromCoachSpeaker(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return 'UNKNOWN';
  if (['me', 'self', 'owner', 'you', 'therapist', 'clinician', 'coach', 'jonathan'].includes(text)) return 'ME';
  if (['not_me', 'other', 'them', 'client', 'patient', 'speaker'].includes(text)) return 'NOT_ME';
  return normalizeSpeakerKind(text);
}

function resolveClientContextForRequest(body, { lensId = '' } = {}) {
  const source = isRecord(body?.input) ? body.input : body;
  if (!isRecord(source)) return null;
  const explicitContext = normalizeClientContext(source.clientContext || source.clientPrep || source.client);
  const identity = extractClientIdentity(source, explicitContext);
  const rosterCandidate = identity.clientId || identity.displayName
    ? null
    : pickRosterCandidate(source, { lensId });
  const clientId = cleanText(identity.clientId || rosterCandidate?.clientId || explicitContext?.clientId || '');
  const displayName = cleanText(identity.displayName || rosterCandidate?.displayName || explicitContext?.displayName || '');
  const inlineHints = explicitContext ? clientContextHints(explicitContext) : [];
  const storedHints = clientId || displayName
    ? memoryStore.clientHints({ lensId, clientId, displayName, limit: 8 })
    : [];
  const calendarHint = rosterCandidate
    ? `calendar candidate: ${rosterCandidate.displayName} at ${formatRosterTime(rosterCandidate.startsAt)} ${ROSTER_TIME_ZONE}`
    : '';
  if (!clientId && !displayName && !inlineHints.length && !storedHints.length && !calendarHint) return null;
  return {
    clientId,
    displayName,
    source: explicitContext?.source || rosterCandidate?.source || 'request',
    rosterCandidate: rosterCandidate || null,
    calendarHint,
    inlineHints,
    storedHints,
    hints: inlineHints.length + storedHints.length + (calendarHint ? 1 : 0)
  };
}

function extractClientIdentity(source, explicitContext = null) {
  const selected = isRecord(source?.selectedClient)
    ? source.selectedClient
    : isRecord(source?.clientCandidate)
      ? source.clientCandidate
      : {};
  return {
    clientId: cleanText(
      source?.clientId ||
      source?.client_id ||
      selected?.clientId ||
      selected?.client_id ||
      explicitContext?.clientId ||
      ''
    ),
    displayName: cleanText(
      source?.clientName ||
      source?.displayName ||
      source?.clientDisplayName ||
      selected?.displayName ||
      selected?.name ||
      explicitContext?.displayName ||
      ''
    )
  };
}

function pickRosterCandidate(source, { lensId = '' } = {}) {
  const at = normalizeDate(source?.at || source?.now || source?.timestamp) || new Date().toISOString();
  const rosterDate = normalizeRosterDate(source?.date || source?.rosterDate, at);
  const dismissed = new Set(
    [
      ...(Array.isArray(source?.dismissedClientIds) ? source.dismissedClientIds : []),
      ...(Array.isArray(source?.dismissedCandidates) ? source.dismissedCandidates.map((item) => item?.clientId || item?.displayName || item) : [])
    ]
      .map((item) => cleanText(item).toLowerCase())
      .filter(Boolean)
  );
  const candidates = memoryStore.rosterCandidates({ lensId, date: rosterDate, at, limit: 8 });
  return candidates.find((candidate) => {
    const id = cleanText(candidate.clientId).toLowerCase();
    const name = cleanText(candidate.displayName).toLowerCase();
    return !dismissed.has(id) && !dismissed.has(name);
  }) || null;
}

function normalizeClientContext(body) {
  const source = isRecord(body?.input) ? body.input : body;
  if (!isRecord(source)) return null;
  const client = isRecord(source.client) ? source.client : {};
  const previousSessionNotes = normalizePreviousSessionNotes(source);
  let displayName = cleanText(
    source.displayName ||
    source.clientName ||
    source.name ||
    source.fullName ||
    client.displayName ||
    client.clientName ||
    client.name ||
    client.fullName ||
    source.title ||
    ''
  );
  const summary = truncate(uniqueStrings([
    ...extractContextStrings(source.summary),
    ...extractContextStrings(source.prep),
    ...extractContextStrings(source.sessionPrep),
    ...extractContextStrings(source.clinicalSummary),
    ...extractContextStrings(source.notionSummary),
    ...extractContextStrings(source.presentingContext),
    ...extractContextStrings(source.contextSummary),
    ...previousSessionNotes.map(previousSessionSummary)
  ]).join(' '), 1200);
  const items = normalizeClientContextItems(source, previousSessionNotes);
  let clientId = cleanText(source.clientId || source.client_id || source.id || client.clientId || client.id || '');
  if (!clientId && displayName) clientId = stableClientId(displayName, summary);
  if (!displayName && clientId) displayName = clientId;
  if (!clientId || !displayName || (!summary && !items.length)) return null;
  return {
    clientId,
    lensId: cleanText(source.lensId || source.activeLensId || 'clinical') || 'clinical',
    displayName: truncate(displayName, 120),
    source: truncate(cleanText(source.source || source.origin || 'api'), 80),
    summary,
    updatedAt: normalizeDate(source.updatedAt || source.updated_at) || new Date().toISOString(),
    items
  };
}

function normalizeClientContextItems(source, previousSessionNotes = normalizePreviousSessionNotes(source)) {
  const items = [];
  const pushItem = (kind, value) => {
    for (const text of extractContextStrings(value)) {
      const body = truncate(cleanText(text), 600);
      const normalizedKind = normalizeItemKind(kind);
      if (body && normalizedKind) items.push({ kind: normalizedKind, body });
    }
  };
  const rawItems = [
    ...(Array.isArray(source.items) ? source.items : []),
    ...(Array.isArray(source.contextItems) ? source.contextItems : []),
    ...(Array.isArray(source.prepItems) ? source.prepItems : [])
  ];
  for (const item of rawItems) {
    if (isRecord(item)) pushItem(item.kind || item.type || item.label || 'note', item.body || item.text || item.summary || item.value);
    else pushItem('note', item);
  }
  pushItem('best_question', source.bestQuestion);
  pushItem('best_question', source.bestQuestions);
  pushItem('best_question', source.questionsToAsk);
  pushItem('best_question', source.questionCues);
  pushItem('best_question', source.suggestedQuestions);
  pushItem('goal', source.goals || source.goal || source.sessionGoal);
  pushItem('risk', source.risks || source.risk || source.watchFor || source.watch);
  pushItem('avoid', source.avoid || source.doNotSay || source.forbiddenTopics || source.boundaries);
  pushItem('value', source.values || source.valuesWork);
  pushItem('pattern', source.patterns || source.recurringPatterns);
  pushItem('homework', source.homework || source.nextSteps);
  pushItem('notion', source.notionUrl || source.notionPage || source.sourceUrl);
  for (const note of previousSessionNotes) {
    pushItem('previous_session', previousSessionSummary(note));
    pushItem('pattern', note.themes);
    pushItem('pattern', note.patterns);
    pushItem('goal', note.goals);
    pushItem('risk', note.risks);
    pushItem('avoid', note.avoid);
    pushItem('homework', note.homework);
    pushItem('best_question', note.bestQuestions);
    pushItem('notion', note.sourceUrl);
  }
  return uniqueClientItems(items).slice(0, 32);
}

function normalizePreviousSessionNotes(source) {
  const rawNotes = [
    ...(Array.isArray(source?.previousSessionNotes) ? source.previousSessionNotes : []),
    ...(Array.isArray(source?.previousNotes) ? source.previousNotes : []),
    ...(Array.isArray(source?.recentSessionNotes) ? source.recentSessionNotes : []),
    ...(Array.isArray(source?.recentNotes) ? source.recentNotes : []),
    ...(Array.isArray(source?.notionSessionNotes) ? source.notionSessionNotes : []),
    ...(Array.isArray(source?.notionNotes) ? source.notionNotes : [])
  ];
  const seen = new Set();
  const notes = [];
  rawNotes.forEach((value, index) => {
    const note = normalizePreviousSessionNote(value, index);
    if (!note) return;
    const key = cleanText(`${note.sessionDate}|${note.title}|${note.summary}`).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    notes.push(note);
  });
  return notes
    .sort((left, right) => {
      const leftTime = Date.parse(left.sessionDate || '');
      const rightTime = Date.parse(right.sessionDate || '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      return left.index - right.index;
    })
    .slice(0, 5);
}

function normalizePreviousSessionNote(value, index) {
  if (typeof value === 'string') {
    const summary = truncate(cleanText(value), 700);
    return summary ? { index, sessionDate: '', title: '', summary } : null;
  }
  if (!isRecord(value)) return null;
  const sessionDate = normalizeDate(
    value.sessionDate ||
    value.session_date ||
    value.date ||
    value.createdAt ||
    value.created_at ||
    value.lastEditedAt ||
    value.last_edited_time
  );
  const title = truncate(cleanText(value.title || value.name || value.label || value.sessionTitle || value.noteTitle || value.pageTitle || ''), 120);
  const summary = truncate(uniqueStrings([
    ...extractContextStrings(value.summary),
    ...extractContextStrings(value.sessionSummary),
    ...extractContextStrings(value.clinicalSummary),
    ...extractContextStrings(value.notionSummary),
    ...extractContextStrings(value.progressNote),
    ...extractContextStrings(value.sessionNote),
    ...extractContextStrings(value.note),
    ...extractContextStrings(value.notes),
    ...extractContextStrings(value.text),
    ...extractContextStrings(value.content),
    ...extractContextStrings(value.assessment),
    ...extractContextStrings(value.interventions),
    ...extractContextStrings(value.response),
    ...extractContextStrings(value.plan)
  ]).join(' '), 700);
  const bestQuestions = uniqueStrings([
    ...extractContextStrings(value.bestQuestion),
    ...extractContextStrings(value.bestQuestions),
    ...extractContextStrings(value.questionsToAsk),
    ...extractContextStrings(value.suggestedQuestions),
    ...extractContextStrings(value.questionCues)
  ]).slice(0, 4);
  const themes = uniqueStrings([
    ...extractContextStrings(value.themes),
    ...extractContextStrings(value.theme),
    ...extractContextStrings(value.focus),
    ...extractContextStrings(value.focusAreas)
  ]).slice(0, 4);
  const patterns = uniqueStrings([
    ...extractContextStrings(value.patterns),
    ...extractContextStrings(value.recurringPatterns),
    ...extractContextStrings(value.presentation),
    ...extractContextStrings(value.presentingContext)
  ]).slice(0, 4);
  const goals = uniqueStrings([
    ...extractContextStrings(value.goals),
    ...extractContextStrings(value.goal),
    ...extractContextStrings(value.sessionGoal),
    ...extractContextStrings(value.nextGoal)
  ]).slice(0, 4);
  const risks = uniqueStrings([
    ...extractContextStrings(value.risks),
    ...extractContextStrings(value.risk),
    ...extractContextStrings(value.watchFor),
    ...extractContextStrings(value.flags)
  ]).slice(0, 4);
  const avoid = uniqueStrings([
    ...extractContextStrings(value.avoid),
    ...extractContextStrings(value.boundaries),
    ...extractContextStrings(value.doNotSay),
    ...extractContextStrings(value.forbiddenTopics)
  ]).slice(0, 4);
  const homework = uniqueStrings([
    ...extractContextStrings(value.homework),
    ...extractContextStrings(value.nextSteps),
    ...extractContextStrings(value.actionItems),
    ...extractContextStrings(value.plan)
  ]).slice(0, 4);
  const sourceUrl = truncate(cleanText(value.notionUrl || value.notionPage || value.sourceUrl || value.url || ''), 240);
  if (!summary && !title && !bestQuestions.length && !themes.length && !patterns.length && !goals.length && !risks.length && !avoid.length && !homework.length) {
    return null;
  }
  return {
    index,
    sessionDate,
    title,
    summary,
    bestQuestions,
    themes,
    patterns,
    goals,
    risks,
    avoid,
    homework,
    sourceUrl
  };
}

function previousSessionSummary(note) {
  const label = cleanText([
    note.sessionDate ? `Prior session ${note.sessionDate.slice(0, 10)}` : `Prior session ${note.index + 1}`,
    note.title
  ].filter(Boolean).join(' - '));
  const body = cleanText(note.summary || [
    note.themes?.length ? `Themes: ${note.themes.join('; ')}` : '',
    note.patterns?.length ? `Patterns: ${note.patterns.join('; ')}` : '',
    note.goals?.length ? `Goals: ${note.goals.join('; ')}` : '',
    note.risks?.length ? `Risks: ${note.risks.join('; ')}` : ''
  ].filter(Boolean).join(' '));
  return truncate([label, body].filter(Boolean).join(': '), 700);
}

function normalizeItemKind(value) {
  const text = cleanText(value || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return truncate(text || 'note', 40);
}

function uniqueClientItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.kind}:${item.body}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clientContextHints(context) {
  if (!context) return [];
  return uniqueStrings([
    context.displayName ? `client name: ${context.displayName}` : '',
    context.summary ? `client summary: ${context.summary}` : '',
    ...(context.items || []).map((item) => `client ${item.kind}: ${item.body}`)
  ]).slice(0, 10);
}

function normalizeDayRoster(body) {
  const source = isRecord(body?.input) ? body.input : body;
  if (!isRecord(source)) return null;
  const lensId = cleanText(source.lensId || source.activeLensId || 'clinical') || 'clinical';
  const at = normalizeDate(source.at || source.now || source.timestamp) || new Date().toISOString();
  const rosterDate = normalizeRosterDate(source.date || source.rosterDate, at);
  const rawEntries = [
    ...(Array.isArray(source.entries) ? source.entries : []),
    ...(Array.isArray(source.appointments) ? source.appointments : []),
    ...(Array.isArray(source.events) ? source.events : []),
    ...(Array.isArray(source.items) ? source.items : [])
  ];
  const defaultDurationMinutes = Number.isFinite(source.defaultDurationMinutes)
    ? Math.max(1, Math.min(240, Math.trunc(source.defaultDurationMinutes)))
    : 50;
  const entries = rawEntries
    .map((entry, index) => normalizeRosterEntry(entry, { rosterDate, lensId, index, defaultDurationMinutes, sourceName: source.source }))
    .filter(Boolean)
    .slice(0, 64);
  if (!rosterDate || !entries.length) return null;
  return {
    rosterDate,
    lensId,
    source: truncate(cleanText(source.source || 'simplepractice-calendar-sync'), 80),
    replace: source.replace !== false,
    updatedAt: normalizeDate(source.updatedAt || source.updated_at) || new Date().toISOString(),
    entries
  };
}

function normalizeRosterEntry(entry, { rosterDate, lensId, index, defaultDurationMinutes, sourceName }) {
  if (!isRecord(entry)) return null;
  const startValue = entry.startsAt || entry.startAt || entry.startTime || entry.start || entry.when;
  const endValue = entry.endsAt || entry.endAt || entry.endTime || entry.end;
  const startsAt = normalizeAppointmentTime(startValue, rosterDate);
  if (!startsAt) return null;
  const durationMinutes = Number.isFinite(entry.durationMinutes)
    ? Math.max(1, Math.min(240, Math.trunc(entry.durationMinutes)))
    : defaultDurationMinutes;
  const endsAt = normalizeAppointmentTime(endValue, rosterDate) || new Date(Date.parse(startsAt) + durationMinutes * 60000).toISOString();
  const displayName = inferClientNameFromEvent(entry);
  if (!displayName) return null;
  const clientId = cleanText(entry.clientId || entry.client_id || entry.client?.id || '') || stableClientId(displayName, rosterDate);
  const eventId = cleanText(entry.eventId || entry.event_id || entry.id || '') || stableClientId(`${displayName}:${startsAt}:${index}`, sourceName || 'calendar');
  const prep = normalizeClientContext({
    ...entry,
    clientId,
    displayName,
    lensId,
    source: cleanText(entry.contextSource || entry.prepSource || sourceName || 'notion-clinical-hud')
  });
  return {
    clientId,
    displayName: truncate(displayName, 120),
    startsAt,
    endsAt,
    eventId,
    status: truncate(cleanText(entry.status || 'scheduled'), 40),
    notes: truncate(cleanText(entry.notes || entry.description || entry.location || ''), 600),
    clientContext: prep
  };
}

function inferClientNameFromEvent(entry) {
  const explicit = cleanText(
    entry.displayName ||
    entry.clientName ||
    entry.name ||
    entry.client?.displayName ||
    entry.client?.name ||
    ''
  );
  if (explicit) return explicit;
  const title = cleanText(entry.title || entry.summary || entry.subject || '');
  if (!title) return '';
  return title
    .replace(/\b(?:SimplePractice|Appointment|Telehealth|Video|Session|Client)\b/gi, ' ')
    .replace(/\s+[-|]\s*(?:SimplePractice|Telehealth|Video).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAppointmentTime(value, rosterDate) {
  const raw = isRecord(value)
    ? value.dateTime || value.datetime || value.iso || value.date || value.value
    : value;
  if (Number.isFinite(raw)) return new Date(raw).toISOString();
  const text = cleanText(raw);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return zonedLocalToIso(text, '00:00:00');
  const dateTime = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)(?!.*(?:Z|[+-]\d{2}:?\d{2})$)/i);
  if (dateTime) return zonedLocalToIso(dateTime[1], normalizeTimePart(dateTime[2]));
  const timeOnly = parseSimpleLocalTime(text);
  if (timeOnly && rosterDate) return zonedLocalToIso(rosterDate, timeOnly);
  const normalized = normalizeDate(text);
  return normalized || '';
}

function parseSimpleLocalTime(value) {
  const match = cleanText(value).match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const suffix = cleanText(match[3]).toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return '';
  if (suffix.startsWith('p') && hour < 12) hour += 12;
  if (suffix.startsWith('a') && hour === 12) hour = 0;
  if (hour > 23) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function normalizeTimePart(value) {
  const [hour = '0', minute = '0', second = '0'] = cleanText(value).split(':');
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

function normalizeRosterDate(value, fallbackAt = '') {
  const text = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = normalizeDate(text) || normalizeDate(fallbackAt) || new Date().toISOString();
  return dateInRosterTimeZone(parsed);
}

function dateInRosterTimeZone(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const parts = zonedParts(safeDate, ROSTER_TIME_ZONE);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function zonedLocalToIso(datePart, timePart) {
  const dateMatch = cleanText(datePart).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = cleanText(timePart).match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return '';
  const target = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
    second: Number(timeMatch[3])
  };
  let utcMs = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(utcMs), ROSTER_TIME_ZONE);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
    utcMs += targetAsUtc - actualAsUtc;
  }
  return new Date(utcMs).toISOString();
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function formatRosterTime(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ROSTER_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function buildConversationDynamics(turns, body = {}) {
  const metrics = {
    clientTalkTime: 0,
    therapistTalkTime: 0,
    clientWords: 0,
    therapistWords: 0,
    interruptionsByTherapist: 0,
    longestClientMonologue: 0,
    currentPauseDuration: 0,
    clientRatio: 0,
    therapistRatio: 0,
    conversationalState: 'unknown'
  };
  let lastClient = null;
  let latest = null;
  for (const turn of turns || []) {
    const words = cleanText(turn.text).split(/\s+/).filter(Boolean).length;
    const duration = estimatedTurnDurationMs(turn, words);
    if (turn.speakerKind === 'NOT_ME') {
      metrics.clientTalkTime += duration;
      metrics.clientWords += words;
      metrics.longestClientMonologue = Math.max(metrics.longestClientMonologue, duration);
      lastClient = turn;
    } else if (turn.speakerKind === 'ME') {
      metrics.therapistTalkTime += duration;
      metrics.therapistWords += words;
      if (lastClient && Number.isFinite(turn.atMs) && Number.isFinite(lastClient.endedAtMs) && turn.atMs - lastClient.endedAtMs < 500) {
        metrics.interruptionsByTherapist += 1;
      }
    }
    latest = turn;
  }
  const total = metrics.clientTalkTime + metrics.therapistTalkTime;
  if (total > 0) {
    metrics.clientRatio = Math.round((metrics.clientTalkTime / total) * 100);
    metrics.therapistRatio = 100 - metrics.clientRatio;
  }
  const nowMs = Number.isFinite(body?.nowMs)
    ? body.nowMs
    : Number.isFinite(Date.parse(body?.now || body?.timestamp || ''))
      ? Date.parse(body.now || body.timestamp)
      : Date.now();
  if (latest && Number.isFinite(latest.endedAtMs)) metrics.currentPauseDuration = Math.max(0, nowMs - latest.endedAtMs);
  if (metrics.currentPauseDuration > 2500 || body?.vad_state?.is_speaking === false) {
    metrics.conversationalState = 'pause';
  } else if (latest?.speakerKind === 'NOT_ME') {
    metrics.conversationalState = 'client_speaking';
  } else if (latest?.speakerKind === 'ME') {
    metrics.conversationalState = 'therapist_speaking';
  }
  return metrics;
}

function estimatedTurnDurationMs(turn, words) {
  if (Number.isFinite(turn?.atMs) && Number.isFinite(turn?.endedAtMs) && turn.endedAtMs >= turn.atMs) {
    return Math.max(300, turn.endedAtMs - turn.atMs);
  }
  return Math.max(300, words * 360);
}

function buildQuestionCue(context) {
  const ttlMs = 12000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const directQuestion = findClientQuestionHint(context.memory);
  if (directQuestion) {
    return cuePayload({
      source: 'client_context',
      teaser: context.clientContext?.displayName ? `Ask ${context.clientContext.displayName}` : 'Use client prep',
      explanation: 'Use the stored client prep before adding a new direction.',
      question: directQuestion,
      reason: 'best_question from client prep',
      modality: 'prep',
      ttlMs,
      expiresAt
    });
  }
  const dynamics = context.dynamics || {};
  if (dynamics.interruptionsByTherapist >= 2 || dynamics.therapistRatio > 48) {
    return cuePayload({
      source: 'dynamics',
      teaser: 'Repair before steering.',
      explanation: 'You have been carrying more of the talk. Reflect first, then ask one open question.',
      question: 'Before I steer this, what feels most important in what you just said?',
      reason: 'high therapist talk share or interruption pattern',
      modality: 'repair',
      ttlMs,
      expiresAt
    });
  }
  if (dynamics.conversationalState === 'pause') {
    return cuePayload({
      source: 'dynamics',
      teaser: 'Use the pause.',
      explanation: 'Let the silence work, then ask a focused question if the pause holds.',
      question: 'What are you noticing right now as we sit with that?',
      reason: 'pause detected',
      modality: 'presence',
      ttlMs,
      expiresAt
    });
  }
  const topic = summarizeQuestion(context.transcript || context.memory.join(' '));
  const sceneQuestion = findSceneQuestion(context.memory, topic);
  return cuePayload({
    source: sceneQuestion.source,
    teaser: sceneQuestion.source === 'generic' ? 'Ask one sharper question.' : 'Tie it to the scene.',
    explanation: sceneQuestion.explanation,
    question: sceneQuestion.question,
    reason: sceneQuestion.reason,
    modality: sceneQuestion.modality,
    ttlMs,
    expiresAt
  });
}

function cuePayload({ source, teaser, explanation, question, reason, modality, ttlMs, expiresAt }) {
  const text = truncate(cleanText(question), 110);
  return {
    source,
    ttlMs,
    expiresAt,
    deliveryAction: 'cue',
    nudge: {
      teaser: truncate(cleanText(teaser), 64),
      explanation: truncate(cleanText(explanation), 180)
    },
    questions: [
      {
        text,
        reason: truncate(cleanText(reason), 160),
        source,
        modality: truncate(cleanText(modality || 'question'), 40),
        priority: source === 'client_context' ? 1 : source === 'dynamics' ? 2 : 3
      }
    ]
  };
}

function findClientQuestionHint(memory) {
  for (const item of memory || []) {
    const text = cleanText(item);
    const labeled = text.match(/^client\s+(?:best_question|suggested_question|questions_to_ask|question_cues?|question_focus|question):\s*(.+)$/i);
    const candidate = cleanText(labeled?.[1] || '');
    if (candidate) return ensureQuestion(candidate);
  }
  return '';
}

function findSceneQuestion(memory, topic) {
  const contextText = (memory || []).join(' ');
  const risk = firstLabeledHint(memory, /^(?:client\s+)?(?:risk|avoid|boundary|boundaries):\s*(.+)$/i);
  if (risk) {
    return {
      source: 'scene_context',
      explanation: 'The prep names a risk or boundary. Ask around it before offering advice.',
      question: ensureQuestion(`What would help us stay clear of ${summarizeQuestion(risk)} right now`),
      reason: 'risk or boundary in prep',
      modality: 'boundary'
    };
  }
  if (/\bgoal|outcome|priority|decision\b/i.test(contextText)) {
    return {
      source: 'scene_context',
      explanation: 'Use the pre-session goal to narrow the next move.',
      question: ensureQuestion(`What would make ${topic} feel useful by the end of this conversation`),
      reason: 'scene goal available',
      modality: 'goal'
    };
  }
  return {
    source: 'generic',
    explanation: `Ask one concrete follow-up that narrows ${topic}.`,
    question: ensureQuestion(`What matters most about ${topic} right now`),
    reason: 'generic follow-up',
    modality: 'clarify'
  };
}

function firstLabeledHint(memory, pattern) {
  for (const item of memory || []) {
    const match = cleanText(item).match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }
  return '';
}

function ensureQuestion(value) {
  const text = cleanText(value).replace(/[.!\s]+$/, '');
  return text.endsWith('?') ? text : `${text}?`;
}

function summarizeClientContextUse(context) {
  const client = context?.clientContext;
  if (!client) return { used: false, hints: 0 };
  return {
    used: client.hints > 0 || Boolean(client.clientId || client.displayName),
    clientId: client.clientId || '',
    displayName: client.displayName || '',
    source: client.source || '',
    hints: client.hints || 0,
    rosterMatched: Boolean(client.rosterCandidate)
  };
}

function stableClientId(...parts) {
  const raw = cleanText(parts.filter(Boolean).join(':')) || 'client';
  return `client-${crypto.createHash('sha256').update(raw.toLowerCase()).digest('hex').slice(0, 16)}`;
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
  const clientQuestion = findClientQuestionHint(context.memory);
  if (intent === 'summary') {
    return splitPages(`Recap: ${topic}. Name the decision, owner, next step, and one risk before moving on.`, settings);
  }
  if (intent === 'followUp') {
    if (clientQuestion) return [`Ask: "${clientQuestion}"`];
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
    input.clientContext,
    input.client,
    input.clientCandidate,
    ...(Array.isArray(input.retrievedMemorySnippets) ? input.retrievedMemorySnippets : []),
    ...(Array.isArray(input.recentSessionContext) ? input.recentSessionContext : [])
  ]) {
    for (const text of extractContextStrings(value)) {
      if (text) memory.push(truncate(text, 240));
    }
  }
  const lens = cleanText(input.lensId || input.activeLensId || '');
  const clientContext = resolveClientContextForRequest(input, { lensId: lens });
  if (clientContext?.calendarHint) memory.push(clientContext.calendarHint);
  memory.push(...(clientContext?.inlineHints || []));
  memory.push(...(clientContext?.storedHints || []));
  for (const text of storedMemoryHints({ lensId: lens, limit: 4 })) {
    memory.push(truncate(text, 240));
  }
  return {
    lens,
    brief: cleanText(input.activeBriefLabel || ''),
    clientContext,
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
        } else if (audioBytes >= 12000 && now - lastEmit > 2500) {
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
