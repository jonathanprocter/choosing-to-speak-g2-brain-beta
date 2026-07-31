import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import './style.css';
import { formatHud, normalizeDynamics, normalizeText } from './hudFormat.js';

const VERSION = '0.1.47';
const BACKEND_BASE_URL = 'https://speak.procterai.cc';
const WS_URL = 'wss://speak.procterai.cc/v1/transcribe/stream';
const TOKEN_KEY = 'velvetspeakBetaAppKey.v1';
const DEVICE_ID_KEY = 'ctsDeviceId.v1';
const PACKAGE_ID = 'cc.procterai.choosingtospeak';
const LENS_ID = 'clinical';
const MAIN_CONTAINER_ID = 1;
const MAIN_CONTAINER_NAME = 'main';
const CUE_TTL_MS = 6500;
const COACH_MIN_CHARS = 38;
const COACH_INTERVAL_MS = 9000;
const QUESTION_CUE_INTERVAL_MS = 14000;
const CLIENT_REFRESH_INTERVAL_MS = 60000;
const TIME_ZONE = 'America/New_York';
const MAX_RECENT_TURNS = 16;

const phoneLog = document.querySelector('#phone-log');
const statePill = document.querySelector('#state-pill');
const clientLine = document.querySelector('#client-line');
const prepLine = document.querySelector('#prep-line');
const todayList = document.querySelector('#today-list');
document.querySelector('#version').textContent = `v${VERSION}`;

const state = {
  version: VERSION,
  bridge: null,
  bridgeReady: false,
  startupCreated: false,
  starting: false,
  live: false,
  socket: null,
  socketReady: false,
  token: '',
  keyState: 'checking',
  client: null,
  candidates: [],
  contextHints: [],
  dismissedClientIds: [],
  status: 'Booting',
  transcript: '',
  recentTurns: [],
  sessionStartedAt: 0,
  lastTranscriptAt: 0,
  cue: null,
  cueExpiresAt: 0,
  eventCount: 0,
  audioFrames: 0,
  audioBytes: 0,
  lastCoachAt: 0,
  coachInFlight: false,
  lastQuestionCueAt: 0,
  questionCueInFlight: false,
  lastCueSignature: '',
  lastClientRefreshAt: 0,
  clientRefreshTimer: null,
  dynamics: {},
};

const logLines = [];

function log(message, details = null) {
  const line = details ? `${message} ${JSON.stringify(redact(details))}` : message;
  logLines.unshift(`${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ${line}`);
  logLines.splice(12);
  if (phoneLog) phoneLog.textContent = logLines.join('\n');
  console.info(`CTS_G2 ${line}`);
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/token|key|authorization/i.test(key)) return [key, item ? '[redacted]' : item];
    return [key, item];
  }));
}

function setStatus(status) {
  state.status = status;
  if (statePill) statePill.textContent = status;
  renderGlasses().catch((error) => log('render failed', { error: String(error?.message || error) }));
}

async function boot() {
  log('waiting for Even Hub bridge');
  state.bridge = await waitForEvenAppBridge();
  state.bridgeReady = true;
  log('bridge ready');

  state.bridge.onEvenHubEvent(handleEvenHubEvent);
  await createStartupPage();
  setStatus('Checking');

  await hydrateToken();
  await refreshClientContext({ reason: 'boot' });
  startClientRefreshTimer();
  setStatus(state.token ? 'Ready' : 'Offline');
  log('ready for explicit G2/R1 tap');
}

async function hydrateToken() {
  const localToken = readBrowserStorage(TOKEN_KEY);
  let bridgeToken = '';
  try {
    bridgeToken = await state.bridge.getLocalStorage(TOKEN_KEY);
  } catch (error) {
    log('bridge key read unavailable', { error: String(error?.message || error) });
  }
  state.token = validToken(bridgeToken) ? bridgeToken : validToken(localToken) ? localToken : '';
  if (!state.token) {
    state.token = await bootstrapToken();
  }
  state.keyState = state.token ? 'ready' : 'missing';
  log(state.token ? 'saved beta key loaded' : 'no saved beta key found');
}

// Silent enrollment: mint a device-bound key from the backend so the phone
// never shows a token screen. Idempotent per device id on the backend side.
async function bootstrapToken() {
  const deviceId = await ensureDeviceId();
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/beta_bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, packageId: PACKAGE_ID }),
    });
    if (!response.ok) throw new Error(`beta_bootstrap HTTP ${response.status}`);
    const result = await response.json();
    if (!validToken(result.token)) throw new Error('beta_bootstrap returned no usable key');
    await persistToken(result.token);
    log(result.created ? 'beta key enrolled' : 'beta key restored from backend');
    return result.token;
  } catch (error) {
    log('beta bootstrap unavailable', { error: String(error?.message || error) });
    return '';
  }
}

async function ensureDeviceId() {
  let deviceId = readBrowserStorage(DEVICE_ID_KEY);
  if (!deviceId) {
    try {
      deviceId = (await state.bridge.getLocalStorage(DEVICE_ID_KEY)) || '';
    } catch {}
  }
  if (!deviceId) {
    const random = crypto?.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    deviceId = `g2-${random}`;
  }
  writeBrowserStorage(DEVICE_ID_KEY, deviceId);
  try {
    await state.bridge.setLocalStorage(DEVICE_ID_KEY, deviceId);
  } catch {}
  return deviceId;
}

async function persistToken(token) {
  writeBrowserStorage(TOKEN_KEY, token);
  try {
    await state.bridge.setLocalStorage(TOKEN_KEY, token);
  } catch (error) {
    log('bridge key save unavailable', { error: String(error?.message || error) });
  }
}

function readBrowserStorage(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeBrowserStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

function validToken(value) {
  return typeof value === 'string' && /^vs_live_[A-Za-z0-9]{32,}$/.test(value);
}

async function createStartupPage() {
  const result = await state.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 15,
        paddingLength: 8,
        containerID: MAIN_CONTAINER_ID,
        containerName: MAIN_CONTAINER_NAME,
        content: formatHud(state),
        isEventCapture: 1,
      }),
    ],
  }));
  state.startupCreated = result === 0;
  log('createStartUpPageContainer result', { result });
  if (!state.startupCreated) throw new Error(`G2 page create failed: ${result}`);
}

function handleEvenHubEvent(event) {
  state.eventCount += 1;

  if (event.audioEvent) {
    handleAudioEvent(event.audioEvent);
    return;
  }

  const type = normalizeEventType(event);
  const source = event.textEvent ? 'text' : event.sysEvent ? 'sys' : 'unknown';
  log('input event', { source, type: type ?? 'click' });

  if (isSystemLifecycleEvent(type)) return;

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    stopLive('double-tap').catch((error) => log('stop failed', { error: String(error?.message || error) }));
    return;
  }

  if (isStartOrDismissEvent(type)) {
    if (state.live) {
      dismissCue();
      return;
    }
    startLive('tap').catch((error) => {
      log('start failed', { error: String(error?.message || error) });
      setCue('START FAILED', 'Check G2 connection and backend reachability.');
      setStatus('Start failed');
    });
  }
}

async function startLive(reason) {
  if (state.live || state.starting) return;
  state.starting = true;
  try {
    if (!state.token) {
      setStatus('Checking');
      await hydrateToken();
      if (!state.token) {
        setStatus('Starting');
        await state.bridge.audioControl(true, AudioInputSource?.Glasses);
        state.live = true;
        state.socketReady = false;
        state.transcript = '';
        state.recentTurns = [];
        state.sessionStartedAt = Date.now();
        state.audioFrames = 0;
        state.audioBytes = 0;
        setCue('MIC TEST MODE', 'Backend unreachable; G2 mic capture is running locally.');
        setStatus('Mic test');
        log('audio started without backend key', { reason });
        return;
      }
    }

    setStatus('Connecting');
    connectSocket();
    await waitForSocketReady();
    await state.bridge.audioControl(true, AudioInputSource?.Glasses);
    state.live = true;
    state.transcript = '';
    state.recentTurns = [];
    state.sessionStartedAt = Date.now();
    state.audioFrames = 0;
    state.audioBytes = 0;
    setCue('LISTENING', 'Transcript default is on. Counselor cues appear when useful.');
    setStatus('Live');
    refreshClientContext({ reason: 'start', silent: true });
    maybeQuestionCue('start');
    log('audio started', { reason });
  } finally {
    state.starting = false;
  }
}

async function stopLive(reason) {
  if (state.bridgeReady) {
    try {
      await state.bridge.audioControl(false, AudioInputSource?.Glasses);
    } catch (error) {
      log('audio stop warning', { error: String(error?.message || error) });
    }
  }
  if (state.socket) {
    try {
      state.socket.send(JSON.stringify({ type: 'CloseStream' }));
      state.socket.close();
    } catch {}
  }
  state.live = false;
  state.socketReady = false;
  setCue('STOPPED', 'Tap once before the next conversation.');
  setStatus('Ready');
  log('audio stopped', { reason });
}

function connectSocket() {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) return;
  const sessionId = `g2-${Date.now()}`;
  const url = `${WS_URL}?sessionId=${encodeURIComponent(sessionId)}&source=g2Mic`;
  const socket = new WebSocket(url, 'velvetspeak-stt.v1');
  socket.binaryType = 'arraybuffer';
  state.socket = socket;
  state.socketReady = false;

  socket.addEventListener('open', () => {
    log('websocket open');
    socket.send(JSON.stringify({ type: 'Authenticate', token: state.token }));
  });
  socket.addEventListener('message', (event) => handleSocketMessage(event.data));
  socket.addEventListener('close', () => {
    state.socketReady = false;
    if (state.live) setStatus('Reconnecting');
    log('websocket closed');
  });
  socket.addEventListener('error', () => {
    state.socketReady = false;
    log('websocket error');
  });
}

function waitForSocketReady() {
  if (state.socketReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (state.socketReady) {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 8000) {
        window.clearInterval(timer);
        reject(new Error('transcript stream did not become ready'));
      }
    }, 100);
  });
}

function handleSocketMessage(data) {
  if (typeof data !== 'string') return;
  let frame = null;
  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }
  log('stream message', { type: frame.type });
  if (frame.type === 'stream.ready' || frame.type === 'stream.hello') {
    if (frame.type === 'stream.ready') state.socketReady = true;
    renderGlasses();
    return;
  }
  if (frame.type === 'stream.error') {
    setCue('STREAM ERROR', frame.message || frame.code || 'Transcript stream rejected.');
    setStatus('Stream error');
    return;
  }
  if (frame.type === 'transcript.partial' || frame.type === 'transcript.final') {
    const text = normalizeText(frame.turn?.text || frame.text || '');
    if (!text) return;
    state.transcript = text === 'Listening...' && state.transcript ? state.transcript : text;
    state.lastTranscriptAt = Date.now();
    if (frame.type === 'transcript.final') rememberTurn(frame.turn || frame, text);
    renderGlasses();
    if (frame.type === 'transcript.final') {
      maybeCoach();
      maybeQuestionCue('transcript');
    }
  }
}

function handleAudioEvent(audioEvent) {
  if (!state.live) return;
  const pcm = audioEvent.audioPcm || audioEvent.pcm || audioEvent.data;
  const bytes = toBytes(pcm);
  if (!bytes || bytes.byteLength === 0) return;
  state.audioFrames += 1;
  state.audioBytes += bytes.byteLength;
  if (!state.token) {
    if (state.audioFrames === 1 || state.audioFrames % 25 === 0) {
      log('local mic frame received', { frames: state.audioFrames, kb: Math.round(state.audioBytes / 1024) });
      renderGlasses();
    }
    return;
  }
  if (!state.socketReady || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(bytes);
  if (state.audioFrames === 1 || state.audioFrames % 50 === 0) {
    log('audio frame sent', { frames: state.audioFrames, kb: Math.round(state.audioBytes / 1024) });
    renderGlasses();
  }
}

function toBytes(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value).buffer;
  return null;
}

function normalizeEventType(event) {
  const raw = event.textEvent?.eventType
    ?? event.sysEvent?.eventType
    ?? event.listEvent?.eventType
    ?? event.jsonData?.eventType
    ?? event.jsonData?.Event_Type
    ?? event.jsonData?.event_type;
  if (typeof OsEventTypeList.fromJson === 'function') {
    return OsEventTypeList.fromJson(raw);
  }
  return raw;
}

function isSystemLifecycleEvent(type) {
  return type === OsEventTypeList.FOREGROUND_ENTER_EVENT
    || type === OsEventTypeList.FOREGROUND_EXIT_EVENT
    || type === OsEventTypeList.ABNORMAL_EXIT_EVENT
    || type === OsEventTypeList.SYSTEM_EXIT_EVENT
    || type === OsEventTypeList.IMU_DATA_REPORT;
}

function isStartOrDismissEvent(type) {
  return type === undefined
    || type === OsEventTypeList.CLICK_EVENT
    || type === OsEventTypeList.SCROLL_TOP_EVENT
    || type === OsEventTypeList.SCROLL_BOTTOM_EVENT;
}

async function maybeCoach() {
  const now = Date.now();
  if (
    state.coachInFlight ||
    state.transcript.length < COACH_MIN_CHARS ||
    now - state.lastCoachAt < COACH_INTERVAL_MS
  ) return;
  state.coachInFlight = true;
  state.lastCoachAt = now;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/coach`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildBrainPayload('coach')),
    });
    if (!response.ok) throw new Error(`coach HTTP ${response.status}`);
    const result = await response.json();
    applyBrainCue(result, 'coach');
  } catch (error) {
    log('coach warning', { error: String(error?.message || error) });
  } finally {
    state.coachInFlight = false;
  }
}

async function maybeQuestionCue(reason) {
  const now = Date.now();
  if (
    !state.token ||
    state.questionCueInFlight ||
    now - state.lastQuestionCueAt < QUESTION_CUE_INTERVAL_MS
  ) return;
  const hasPrepContext = Boolean(state.client?.displayName || state.contextHints.length);
  const hasConversation = state.transcript.length >= COACH_MIN_CHARS || state.recentTurns.length > 0;
  if (!hasPrepContext && !hasConversation) return;

  state.questionCueInFlight = true;
  state.lastQuestionCueAt = now;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/question_cues`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildBrainPayload(`question-${reason}`)),
    });
    if (!response.ok) throw new Error(`question_cues HTTP ${response.status}`);
    const result = await response.json();
    applyBrainCue(result, `question-${reason}`);
  } catch (error) {
    log('question cue warning', { error: String(error?.message || error) });
  } finally {
    state.questionCueInFlight = false;
  }
}

async function refreshClientContext({ reason = 'manual', silent = false } = {}) {
  if (!state.token) {
    updateClientUi(null, [], []);
    return;
  }
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/client_candidate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        lensId: LENS_ID,
        at: new Date().toISOString(),
        timeZone: TIME_ZONE,
        dismissedClientIds: state.dismissedClientIds,
      }),
    });
    if (!response.ok) throw new Error(`client_candidate HTTP ${response.status}`);
    const result = await response.json();
    state.client = result.selected || null;
    state.candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 8) : [];
    state.contextHints = Array.isArray(result.contextHints)
      ? result.contextHints.map((hint) => normalizeText(hint.summary || hint.text || hint.note || hint)).filter(Boolean).slice(0, 5)
      : [];
    state.lastClientRefreshAt = Date.now();
    updateClientUi(state.client, state.contextHints, state.candidates);
    if (!silent) log('client candidate loaded', { selected: state.client?.displayName || 'none', hints: state.contextHints.length, reason });
    maybeQuestionCue('prep');
    renderGlasses();
  } catch (error) {
    updateClientUi(state.client, state.contextHints, state.candidates);
    log('client candidate unavailable', { error: String(error?.message || error) });
  }
}

function startClientRefreshTimer() {
  if (state.clientRefreshTimer) window.clearInterval(state.clientRefreshTimer);
  state.clientRefreshTimer = window.setInterval(() => {
    refreshClientContext({ reason: 'timer', silent: true });
  }, CLIENT_REFRESH_INTERVAL_MS);
}

function updateClientUi(client, hints, candidates = []) {
  if (clientLine) {
    clientLine.textContent = client?.displayName
      ? `Likely session: ${client.displayName}${client.startsAt ? ` at ${formatEtTime(client.startsAt)}` : ''}`
      : 'No SimplePractice2 calendar client selected';
  }
  if (prepLine) {
    prepLine.textContent = hints.length
      ? hints[0]
      : 'When SimplePractice2 and Notion prep are synced, they will feed this HUD.';
  }
  if (todayList) {
    if (!candidates.length) {
      todayList.textContent = 'No day roster loaded from SimplePractice2 yet.';
    } else {
      todayList.textContent = candidates
        .slice(0, 5)
        .map((candidate) => `${formatEtTime(candidate.startsAt)} ${candidate.displayName || 'Unnamed client'}`)
        .join('\n');
    }
  }
}

function buildBrainPayload(requestKind) {
  return {
    requestId: `${requestKind}-${Date.now()}`,
    lensId: LENS_ID,
    at: new Date().toISOString(),
    timeZone: TIME_ZONE,
    transcript: state.transcript,
    recentTranscript: state.transcript,
    recentTurns: state.recentTurns,
    currentScene: buildSceneSummary(),
    selectedClient: state.client,
    clientCandidate: state.client,
    memoryContext: { items: state.contextHints },
    settings: {
      autoAssist: 'highest',
      transcriptDefault: true,
      counselorColleague: true,
      delivery: 'ephemeral_glasses_cue',
    },
  };
}

function buildSceneSummary() {
  const lines = [];
  if (state.client?.displayName) {
    lines.push(`Current client: ${state.client.displayName}${state.client.startsAt ? ` at ${formatEtTime(state.client.startsAt)} ET` : ''}.`);
  }
  if (state.contextHints.length) {
    lines.push(`Pre-session prep: ${state.contextHints.join(' | ')}`);
  }
  if (!lines.length) {
    lines.push('No selected client context yet; infer only from the live transcript.');
  }
  return lines.join(' ');
}

function applyBrainCue(result, sourceLabel) {
  if (!result || typeof result !== 'object') return;
  state.dynamics = normalizeDynamics(result.dynamics || result.questionCue?.dynamics, state.dynamics);
  const question = Array.isArray(result.questions)
    ? result.questions[0]
    : Array.isArray(result.questionCue?.questions)
      ? result.questionCue.questions[0]
      : null;
  const nudge = result.nudge || result.questionCue?.nudge || null;
  const sayThis = Array.isArray(result.sayThis) ? normalizeText(result.sayThis[0]) : '';
  const questionText = normalizeText(question?.text || '');
  const detail = sayThis || questionText || normalizeText(nudge?.explanation || '');
  const rawTitle = normalizeText(nudge?.teaser || question?.modality || '');
  const title = rawTitle || 'Counselor cue';
  const cueSource = normalizeText(question?.source || result.questionCue?.source || sourceLabel);

  if (!detail && !rawTitle) {
    renderGlasses();
    return;
  }
  if (cueSource === 'generic' && !state.transcript && !state.contextHints.length) return;

  setCue(title, detail, {
    source: cueSource,
    modality: normalizeText(question?.modality || ''),
    plane: cueSource === 'dynamics' ? 'near' : 'mid',
  });
}

function rememberTurn(rawTurn, text) {
  const now = Date.now();
  const startedAtMs = Number.isFinite(Number(rawTurn?.atMs))
    ? Number(rawTurn.atMs)
    : Number.isFinite(Number(rawTurn?.startedAtMs))
      ? Number(rawTurn.startedAtMs)
      : Math.max(state.sessionStartedAt || now, now - Math.max(900, text.split(/\s+/).length * 360));
  const endedAtMs = Number.isFinite(Number(rawTurn?.endedAtMs))
    ? Number(rawTurn.endedAtMs)
    : Number.isFinite(Number(rawTurn?.endAtMs))
      ? Number(rawTurn.endAtMs)
      : now;
  state.recentTurns.push({
    text,
    speakerKind: normalizeSpeakerKind(rawTurn?.speakerKind || rawTurn?.speaker || rawTurn?.speakerLabel),
    speakerLabel: normalizeText(rawTurn?.speakerLabel || rawTurn?.speaker || ''),
    atMs: startedAtMs,
    endedAtMs,
  });
  state.recentTurns = state.recentTurns.slice(-MAX_RECENT_TURNS);
}

function normalizeSpeakerKind(value) {
  const text = normalizeText(value).toLowerCase();
  if (['not_me', 'not me', 'client', 'other', 'speaker_1', 'speaker 1'].includes(text)) return 'NOT_ME';
  if (['me', 'self', 'you', 'jonathan', 'therapist', 'clinician', 'speaker_0', 'speaker 0'].includes(text)) return 'ME';
  return '';
}

function formatEtTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
  };
}

function setCue(title, detail, options = {}) {
  const normalizedTitle = normalizeText(title || 'Counselor cue').toUpperCase().slice(0, 54);
  const normalizedDetail = normalizeText(detail).slice(0, 180);
  const signature = `${normalizedTitle}|${normalizedDetail}`;
  if (signature === state.lastCueSignature && state.cue && Date.now() < state.cueExpiresAt) return;
  state.lastCueSignature = signature;
  state.cue = {
    title: normalizedTitle,
    detail: normalizedDetail,
    source: normalizeText(options.source || ''),
    modality: normalizeText(options.modality || ''),
    plane: options.plane === 'near' ? 'near' : 'mid',
  };
  state.cueExpiresAt = Date.now() + CUE_TTL_MS;
  renderGlasses();
  window.setTimeout(() => {
    if (state.cue && Date.now() >= state.cueExpiresAt) dismissCue();
  }, CUE_TTL_MS + 100);
}

function dismissCue() {
  state.cue = null;
  state.cueExpiresAt = 0;
  renderGlasses();
}

async function renderGlasses() {
  if (!state.bridgeReady || !state.startupCreated) return;
  const content = formatHud(state);
  await state.bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: MAIN_CONTAINER_ID,
    containerName: MAIN_CONTAINER_NAME,
    content,
  }));
}

boot().catch((error) => {
  log('boot failed', { error: String(error?.message || error) });
  setStatus('Bridge failed');
});
