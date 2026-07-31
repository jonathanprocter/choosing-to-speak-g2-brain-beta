import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import './style.css';

const VERSION = '0.1.42';
const BACKEND_BASE_URL = 'https://speak.procterai.cc';
const WS_URL = 'wss://speak.procterai.cc/v1/transcribe/stream';
const TOKEN_KEY = 'velvetspeakBetaAppKey.v1';
const LENS_ID = 'clinical';
const MAIN_CONTAINER_ID = 1;
const MAIN_CONTAINER_NAME = 'main';
const CUE_TTL_MS = 6500;
const COACH_MIN_CHARS = 38;
const COACH_INTERVAL_MS = 9000;

const phoneLog = document.querySelector('#phone-log');
const statePill = document.querySelector('#state-pill');
const clientLine = document.querySelector('#client-line');
const prepLine = document.querySelector('#prep-line');
document.querySelector('#version').textContent = `v${VERSION}`;

const state = {
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
  contextHints: [],
  status: 'Booting',
  transcript: '',
  lastTranscriptAt: 0,
  cue: null,
  cueExpiresAt: 0,
  eventCount: 0,
  audioFrames: 0,
  audioBytes: 0,
  lastCoachAt: 0,
  coachInFlight: false,
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
  await loadClientCandidate();
  setStatus(state.token ? 'Ready' : 'Key needed');
  log('ready for explicit G2/R1 tap');
}

async function hydrateToken() {
  const localToken = readBrowserToken();
  let bridgeToken = '';
  try {
    bridgeToken = await state.bridge.getLocalStorage(TOKEN_KEY);
  } catch (error) {
    log('bridge key read unavailable', { error: String(error?.message || error) });
  }
  state.token = validToken(bridgeToken) ? bridgeToken : validToken(localToken) ? localToken : '';
  state.keyState = state.token ? 'ready' : 'missing';
  log(state.token ? 'saved beta key loaded' : 'no saved beta key found');
}

function readBrowserToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
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
        content: formatHud(),
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
      setCue('START FAILED', 'Check G2 connection and saved beta key.');
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
        state.audioFrames = 0;
        state.audioBytes = 0;
        setCue('MIC TEST MODE', 'No beta key is saved, but G2 mic capture is running.');
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
    state.audioFrames = 0;
    state.audioBytes = 0;
    setCue('LISTENING', 'Transcript default is on. Counselor cues appear when useful.');
    setStatus('Live');
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
    renderGlasses();
    if (frame.type === 'transcript.final') maybeCoach();
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
      body: JSON.stringify({
        lensId: LENS_ID,
        transcript: state.transcript,
        recentTranscript: state.transcript,
        currentScene: state.client ? `Current client: ${state.client.displayName}` : '',
        memoryContext: { items: state.contextHints },
        settings: { autoAssist: 'highest', transcriptDefault: true },
      }),
    });
    if (!response.ok) throw new Error(`coach HTTP ${response.status}`);
    const result = await response.json();
    const nudge = result.nudge || result.questionCue?.nudge;
    const sayThis = Array.isArray(result.sayThis) ? result.sayThis[0] : '';
    if (nudge?.teaser || nudge?.explanation || sayThis) {
      setCue(nudge?.teaser || 'COUNSELOR CUE', sayThis || nudge.explanation);
    }
  } catch (error) {
    log('coach warning', { error: String(error?.message || error) });
  } finally {
    state.coachInFlight = false;
  }
}

async function loadClientCandidate() {
  if (!state.token) {
    updateClientUi(null, []);
    return;
  }
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/client_candidate`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        lensId: LENS_ID,
        at: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error(`client_candidate HTTP ${response.status}`);
    const result = await response.json();
    state.client = result.selected || null;
    state.contextHints = Array.isArray(result.contextHints)
      ? result.contextHints.map((hint) => normalizeText(hint.summary || hint.text || hint.note || hint)).filter(Boolean).slice(0, 5)
      : [];
    updateClientUi(state.client, state.contextHints);
    log('client candidate loaded', { selected: state.client?.displayName || 'none', hints: state.contextHints.length });
  } catch (error) {
    updateClientUi(null, []);
    log('client candidate unavailable', { error: String(error?.message || error) });
  }
}

function updateClientUi(client, hints) {
  if (clientLine) clientLine.textContent = client?.displayName ? `Likely session: ${client.displayName}` : 'No calendar client selected';
  if (prepLine) {
    prepLine.textContent = hints.length
      ? hints[0]
      : 'When SimplePractice2 and Notion prep are synced, they will feed this HUD.';
  }
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
  };
}

function setCue(title, detail) {
  state.cue = {
    title: normalizeText(title).toUpperCase().slice(0, 54),
    detail: normalizeText(detail).slice(0, 150),
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
  const content = formatHud();
  await state.bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: MAIN_CONTAINER_ID,
    containerName: MAIN_CONTAINER_NAME,
    content,
  }));
}

function formatHud() {
  const lines = [];
  lines.push(`CHOOSING TO SPEAK  v${VERSION}`);
  lines.push(state.live ? 'LIVE  transcript on  assist high' : 'READY  tap G2/R1 to start');
  if (state.client?.displayName) lines.push(`Client: ${state.client.displayName}`);
  else lines.push('Client: no calendar match');
  lines.push('');

  if (state.cue && Date.now() < state.cueExpiresAt) {
    lines.push(`[ ${state.cue.title || 'COUNSELOR CUE'} ]`);
    if (state.cue.detail) wrapText(state.cue.detail, 44).slice(0, 3).forEach((line) => lines.push(`| ${line}`));
    lines.push('| fades automatically');
    lines.push('');
  }

  if (!state.token) {
    lines.push('KEY NEEDED');
    lines.push('Save the beta key once on the phone.');
  } else if (!state.live) {
    lines.push('Transcript will appear here by default.');
    lines.push('Double tap while live stops the mic.');
  } else if (state.transcript) {
    lines.push('TRANSCRIPT');
    wrapText(state.transcript, 48).slice(-5).forEach((line) => lines.push(line));
  } else {
    lines.push('Listening for speech...');
    lines.push(`Audio frames: ${state.audioFrames}`);
  }

  return lines.join('\n').slice(0, 980);
}

function wrapText(text, width) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

boot().catch((error) => {
  log('boot failed', { error: String(error?.message || error) });
  setStatus('Bridge failed');
});
