import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import './style.css';
import { HUD_ZONE_LAYOUT, HUD_ZONE_ORDER, formatHudZones, normalizeDynamics, normalizeText } from './hudFormat.js';

const VERSION = '0.1.53';
const BACKEND_BASE_URL = 'https://speak.procterai.cc';
const WS_URL = 'wss://speak.procterai.cc/v1/transcribe/stream';
const TOKEN_KEY = 'velvetspeakBetaAppKey.v1';
const DEVICE_ID_KEY = 'ctsDeviceId.v1';
const PACKAGE_ID = 'cc.procterai.choosingtospeak';
const LENS_ID = 'clinical';
const HUD_ZONES = HUD_ZONE_LAYOUT;
const CUE_TTL_MS = 6500;
const COACH_MIN_CHARS = 38;
const COACH_INTERVAL_MS = 9000;
const QUESTION_CUE_INTERVAL_MS = 14000;
const CLIENT_REFRESH_INTERVAL_MS = 60000;
const TIME_ZONE = 'America/New_York';
const MAX_RECENT_TURNS = 16;
// ~15s of 16kHz 16-bit mono PCM held while the stream reconnects, so a
// mid-session drop delays speech instead of losing it.
const AUDIO_BUFFER_MAX_BYTES = 480000;
const MAX_RECONNECT_ATTEMPTS = 5;
const PARTIAL_RENDER_MS = 300;

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
  cues: { near: null, mid: null },
  cueSignatures: { near: '', mid: '' },
  cueTicker: null,
  reviewIndex: null,
  eventCount: 0,
  audioFrames: 0,
  audioBytes: 0,
  lastCoachAt: 0,
  coachInFlight: false,
  lastQuestionCueAt: 0,
  questionCueInFlight: false,
  lastClientRefreshAt: 0,
  clientRefreshTimer: null,
  dynamics: {},
  lastHudZones: {},
  renderInFlight: false,
  renderQueued: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  audioBuffer: [],
  audioBufferBytes: 0,
  lastPartialRenderAt: 0,
  partialRenderTimer: null,
  authRecovering: false,
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
  const zones = normalizeHudZoneContent(formatHudZones(state));
  const result = await state.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: HUD_ZONE_ORDER.length,
    textObject: HUD_ZONE_ORDER.map((zone) => buildHudContainer(zone, zones[zone])),
  }));
  state.startupCreated = result === 0 || result === true;
  state.lastHudZones = zones;
  log('createStartUpPageContainer result', { result });
  if (!state.startupCreated) throw new Error(`G2 page create failed: ${result}`);
}

function buildHudContainer(zone, content) {
  const spec = HUD_ZONES[zone];
  return new TextContainerProperty({
    ...spec,
    content: content || ' ',
  });
}

function normalizeHudZoneContent(zones) {
  return Object.fromEntries(HUD_ZONE_ORDER.map((zone) => [zone, zones[zone] || ' ']));
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

  // Safety: if the OS is tearing the plugin down, never leave the mic and
  // stream running in a therapy session. Stop before swallowing the event.
  if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    if (state.live) {
      stopLive('system-exit').catch((error) => log('exit stop failed', { error: String(error?.message || error) }));
    }
    return;
  }
  if (isSystemLifecycleEvent(type)) return;

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (!state.live) return;
    stopLive('double-tap').catch((error) => log('stop failed', { error: String(error?.message || error) }));
    return;
  }

  // While live, scroll pages back through remembered turns instead of
  // aliasing tap: up = older, down = newer, past the newest = back to live.
  if (state.live && (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    stepReview(type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1);
    return;
  }

  if (isStartOrDismissEvent(type)) {
    if (state.live) {
      if (state.reviewIndex !== null) {
        state.reviewIndex = null;
        renderGlasses();
        return;
      }
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

function stepReview(direction) {
  const turns = state.recentTurns;
  if (!turns.length) return;
  if (state.reviewIndex === null) {
    if (direction > 0) return; // already at the live tail
    state.reviewIndex = turns.length - 1;
  } else {
    const next = state.reviewIndex + direction;
    state.reviewIndex = next < 0 ? 0 : next >= turns.length ? null : next;
  }
  renderGlasses();
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
    try {
      await waitForSocketReady();
    } catch (error) {
      try { state.socket?.close(); } catch {}
      state.socket = null;
      throw error;
    }
    await state.bridge.audioControl(true, AudioInputSource?.Glasses);
    state.live = true;
    state.transcript = '';
    state.recentTurns = [];
    state.reviewIndex = null;
    state.audioBuffer = [];
    state.audioBufferBytes = 0;
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
  const endedAt = Date.now();
  const shouldSummarize = state.live && state.token && state.recentTurns.length > 0;
  state.live = false;
  state.socketReady = false;
  state.reviewIndex = null;
  state.audioBuffer = [];
  state.audioBufferBytes = 0;
  state.reconnectAttempts = 0;
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.partialRenderTimer) {
    window.clearTimeout(state.partialRenderTimer);
    state.partialRenderTimer = null;
  }
  if (shouldSummarize) postSessionSummary(endedAt);
  setCue('STOPPED', 'Tap once before the next conversation.');
  setStatus('Ready');
  log('audio stopped', { reason });
}

// Fire-and-forget: hand the remembered turns to the backend at session end so
// a draft note skeleton is waiting on the phone. Never blocks or cues.
async function postSessionSummary(endedAt) {
  try {
    const payload = {
      ...buildBrainPayload('session-summary'),
      sessionStartedAt: state.sessionStartedAt ? new Date(state.sessionStartedAt).toISOString() : null,
      sessionEndedAt: new Date(endedAt).toISOString(),
      sessionDurationMs: state.sessionStartedAt ? endedAt - state.sessionStartedAt : null,
    };
    const response = await fetch(`${BACKEND_BASE_URL}/v1/session_summary`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(response.status);
      return;
    }
    if (!response.ok) throw new Error(`session_summary HTTP ${response.status}`);
    log('session summary posted', { turns: state.recentTurns.length });
  } catch (error) {
    log('session summary warning', { error: String(error?.message || error) });
  }
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
    state.reconnectAttempts = 0;
    log('websocket open');
    socket.send(JSON.stringify({ type: 'Authenticate', token: state.token }));
  });
  socket.addEventListener('message', (event) => handleSocketMessage(event.data));
  socket.addEventListener('close', () => {
    state.socketReady = false;
    log('websocket closed');
    if (state.live) {
      setStatus('Reconnecting');
      scheduleReconnect();
    }
  });
  socket.addEventListener('error', () => {
    state.socketReady = false;
    log('websocket error');
  });
}

// Previously the UI showed "Reconnecting" but nothing ever reconnected, so a
// dropped stream mid-session silently killed the transcript until a manual
// stop/start. Exponential backoff: 0.5s -> 8s cap, only while live.
function scheduleReconnect() {
  if (!state.live || state.reconnectTimer) return;
  if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log('reconnect abandoned', { attempts: state.reconnectAttempts });
    stopLive('stream-lost').catch(() => {});
    setCue('STREAM LOST', 'Tap once to restart the transcript.');
    setStatus('Stream lost');
    return;
  }
  const delay = Math.min(8000, 500 * 2 ** state.reconnectAttempts);
  state.reconnectAttempts += 1;
  log('reconnect scheduled', { attempt: state.reconnectAttempts, delayMs: delay });
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.live) return;
    if (state.socket && state.socket.readyState < WebSocket.CLOSING) return;
    connectSocket();
  }, delay);
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
    if (frame.type === 'stream.ready') {
      state.socketReady = true;
      flushAudioBuffer();
    }
    renderGlasses();
    return;
  }
  if (frame.type === 'stream.error') {
    const message = String(frame.message || frame.code || '');
    if (/auth|token|unauthorized|401|403/i.test(message)) {
      handleAuthFailure(message);
    }
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
    // Partials can arrive many times per second; each render is a BLE write.
    // Coalesce partials to one render per PARTIAL_RENDER_MS; finals render now.
    if (frame.type === 'transcript.final') {
      renderGlasses();
      maybeCoach();
      maybeQuestionCue('transcript');
    } else {
      throttledRender();
    }
  }
}

function throttledRender() {
  const now = Date.now();
  const elapsed = now - state.lastPartialRenderAt;
  if (elapsed >= PARTIAL_RENDER_MS) {
    state.lastPartialRenderAt = now;
    renderGlasses();
    return;
  }
  if (state.partialRenderTimer) return;
  state.partialRenderTimer = window.setTimeout(() => {
    state.partialRenderTimer = null;
    state.lastPartialRenderAt = Date.now();
    renderGlasses();
  }, PARTIAL_RENDER_MS - elapsed);
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
  if (!state.socketReady || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    bufferAudioFrame(bytes);
    return;
  }
  flushAudioBuffer();
  state.socket.send(bytes);
  if (state.audioFrames === 1 || state.audioFrames % 50 === 0) {
    log('audio frame sent', { frames: state.audioFrames, kb: Math.round(state.audioBytes / 1024) });
    renderGlasses();
  }
}

// Ring buffer: keep the newest ~15s of PCM while the stream is down so a
// reconnect resumes the transcript without a hole in the client's speech.
function bufferAudioFrame(bytes) {
  state.audioBuffer.push(bytes);
  state.audioBufferBytes += bytes.byteLength;
  while (state.audioBufferBytes > AUDIO_BUFFER_MAX_BYTES && state.audioBuffer.length > 1) {
    const dropped = state.audioBuffer.shift();
    state.audioBufferBytes -= dropped.byteLength;
  }
}

function flushAudioBuffer() {
  if (!state.audioBuffer.length) return;
  if (!state.socketReady || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  const frames = state.audioBuffer;
  state.audioBuffer = [];
  state.audioBufferBytes = 0;
  for (const frame of frames) {
    try {
      state.socket.send(frame);
    } catch (error) {
      log('buffer flush warning', { error: String(error?.message || error) });
      return;
    }
  }
  log('buffered audio flushed', { frames: frames.length });
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
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(response.status);
      throw new Error(`coach auth ${response.status}`);
    }
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
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(response.status);
      throw new Error(`question_cues auth ${response.status}`);
    }
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
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(response.status);
      throw new Error(`client_candidate auth ${response.status}`);
    }
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
  const plane = options.plane === 'near' ? 'near' : 'mid';
  const normalizedTitle = normalizeText(title || 'Counselor cue').toUpperCase().slice(0, 54);
  const normalizedDetail = normalizeText(detail).slice(0, 180);
  const signature = `${normalizedTitle}|${normalizedDetail}`;
  const existing = state.cues[plane];
  if (signature === state.cueSignatures[plane] && existing && Date.now() < existing.expiresAt) return;
  state.cueSignatures[plane] = signature;
  // One slot per plane: a NEAR dynamics cue no longer evicts a MID question
  // cue (or vice versa) — they render in their own zones simultaneously.
  state.cues[plane] = {
    title: normalizedTitle,
    detail: normalizedDetail,
    source: normalizeText(options.source || ''),
    modality: normalizeText(options.modality || ''),
    plane,
    expiresAt: Date.now() + CUE_TTL_MS,
  };
  renderGlasses();
  ensureCueTicker();
}

// One shared 1s ticker while any cue is visible. The countdown text renders
// in 2s steps (see hudFormat), so half of these ticks produce identical zone
// content and are skipped by the BLE diff in renderGlasses.
function ensureCueTicker() {
  if (state.cueTicker) return;
  state.cueTicker = window.setInterval(() => {
    const now = Date.now();
    let anyActive = false;
    for (const plane of ['near', 'mid']) {
      const slot = state.cues[plane];
      if (!slot) continue;
      if (now >= slot.expiresAt) {
        state.cues[plane] = null;
      } else {
        anyActive = true;
      }
    }
    if (!anyActive) {
      window.clearInterval(state.cueTicker);
      state.cueTicker = null;
    }
    renderGlasses();
  }, 1000);
}

function dismissCue() {
  if (state.cueTicker) {
    window.clearInterval(state.cueTicker);
    state.cueTicker = null;
  }
  state.cues = { near: null, mid: null };
  renderGlasses();
}

// Recover from key rotation/revocation: without this, every request fails
// with 401/403 forever. bootstrapToken is idempotent per device id.
async function handleAuthFailure(context) {
  if (state.authRecovering) return;
  state.authRecovering = true;
  log('auth failure, re-enrolling key', { context: String(context) });
  try {
    state.token = '';
    writeBrowserStorage(TOKEN_KEY, '');
    try {
      await state.bridge.setLocalStorage(TOKEN_KEY, '');
    } catch {}
    state.token = await bootstrapToken();
    state.keyState = state.token ? 'ready' : 'missing';
    if (!state.token) setStatus('Offline');
  } finally {
    state.authRecovering = false;
  }
}

async function renderGlasses() {
  if (!state.bridgeReady || !state.startupCreated) return;
  if (state.renderInFlight) {
    state.renderQueued = true;
    return;
  }
  state.renderInFlight = true;
  try {
    do {
      state.renderQueued = false;
      const now = Date.now();
      const zones = normalizeHudZoneContent(formatHudZones(state, now));
      for (const zone of HUD_ZONE_ORDER) {
        const content = zones[zone];
        if (content === state.lastHudZones[zone]) continue;
        const spec = HUD_ZONES[zone];
        try {
          await state.bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: spec.containerID,
            containerName: spec.containerName,
            content,
            contentLength: 2000,
          }));
          // Mark per zone on success only, so a failed zone retries next render
          state.lastHudZones = { ...state.lastHudZones, [zone]: content };
        } catch (error) {
          log('zone render failed', { zone, error: String(error?.message || error) });
        }
      }
    } while (state.renderQueued);
  } finally {
    state.renderInFlight = false;
  }
}

boot().catch((error) => {
  log('boot failed', { error: String(error?.message || error) });
  setStatus('Bridge failed');
});
