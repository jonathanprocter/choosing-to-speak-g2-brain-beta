const MAX_G2_CHARS = 900;
const TIME_ZONE = 'America/New_York';

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeDynamics(value, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const next = { ...fallback };
  if (Number.isFinite(Number(source.clientRatio))) next.clientRatio = Number(source.clientRatio);
  if (Number.isFinite(Number(source.therapistRatio))) next.therapistRatio = Number(source.therapistRatio);
  if (Number.isFinite(Number(source.interruptionsByTherapist))) next.interruptionsByTherapist = Number(source.interruptionsByTherapist);
  if (source.conversationalState) next.conversationalState = normalizeText(source.conversationalState);
  return next;
}

export function formatHud(state, now = Date.now()) {
  const cue = state.cue && now < state.cueExpiresAt ? state.cue : null;
  const lines = [];

  lines.push(`${state.live ? 'LIVE' : 'READY'}  CTS ${state.version}  ${formatTime(now)}`);
  lines.push(formatClientLine(state.client));
  const dynamics = formatDynamics(state.dynamics);
  if (dynamics) lines.push(dynamics);
  lines.push('');

  if (cue) {
    lines.push(formatCueHeader(cue, state.cueExpiresAt, now));
    lines.push(normalizeText(cue.title || 'Counselor cue').toUpperCase());
    wrapText(cue.detail || cue.sayThis || '', 42).slice(0, 3).forEach((line) => lines.push(`> ${line}`));
    if (state.transcript) {
      lines.push('');
      lines.push('TRANSCRIPT');
      lastWrappedLines(state.transcript, 46, 2).forEach((line) => lines.push(line));
    } else {
      lines.push('');
      lines.push(state.live ? 'Transcript on - listening.' : 'Tap G2/R1 when ready.');
    }
    return cap(lines);
  }

  if (!state.token) {
    lines.push('OFFLINE MODE');
    lines.push('Key auto-enrolls when backend is reachable.');
    lines.push('Tap G2/R1 retries and starts mic test.');
    return cap(lines);
  }

  if (!state.live) {
    lines.push('TRANSCRIPT DEFAULT: ON');
    lines.push('AUTO ASSIST: HIGHEST');
    const prep = firstContextHint(state);
    if (prep) {
      lines.push('');
      lines.push('PREP');
      wrapText(prep, 46).slice(0, 3).forEach((line) => lines.push(line));
    } else {
      lines.push('');
      lines.push('Tap G2/R1 once to start.');
    }
    return cap(lines);
  }

  lines.push('TRANSCRIPT');
  if (state.transcript) {
    lastWrappedLines(state.transcript, 46, 6).forEach((line) => lines.push(line));
  } else {
    lines.push('Listening for speech...');
    lines.push(state.audioFrames > 0
      ? `Mic frames received: ${state.audioFrames}`
      : 'Waiting for G2 mic frames.');
  }
  lines.push('');
  lines.push('Counselor cues appear automatically.');
  return cap(lines);
}

function cap(lines) {
  return lines
    .filter((line) => line !== undefined && line !== null)
    .join('\n')
    .slice(0, MAX_G2_CHARS);
}

function formatCueHeader(cue, expiresAt, now) {
  const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const plane = cue.plane === 'near' ? 'COUNSELOR CUE' : cue.source === 'client_context' ? 'PREP CUE' : 'COUNSELOR CUE';
  return `*** ${plane} - CLOSE ${seconds}S ***`;
}

function formatClientLine(client) {
  if (!client?.displayName) return 'Today: no calendar client selected';
  const starts = client.startsAt ? ` ${formatTime(client.startsAt)}` : '';
  return `Today: ${normalizeText(client.displayName).slice(0, 36)}${starts}`;
}

function formatDynamics(dynamics) {
  const state = normalizeText(dynamics?.conversationalState || '').replace(/_/g, ' ');
  const clientRatio = Number(dynamics?.clientRatio || 0);
  const therapistRatio = Number(dynamics?.therapistRatio || 0);
  if (clientRatio || therapistRatio) {
    return `${state || 'listening'} | ${Math.round(clientRatio)} client / ${Math.round(therapistRatio)} you`;
  }
  return state ? `${state} | talk ratio pending` : '';
}

function firstContextHint(state) {
  return normalizeText((state.contextHints || [])[0] || state.prepCue || '');
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function lastWrappedLines(text, width, count) {
  return wrapText(text, width).slice(-count);
}

export function wrapText(text, width) {
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
