const MAX_G2_CHARS = 620;
const MAX_G2_LINES = 13;
const PLANE_WIDTH = {
  near: 31,
  mid: 34,
  far: 36,
};
const TIME_ZONE = 'America/New_York';

export function normalizeText(value) {
  return stripMarkdown(value).replace(/\s+/g, ' ').trim();
}

export function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[a-zA-Z0-9_-]*\s*/g, ' ')
    .replace(/```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[>#*`|]/g, ' ');
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

  if (cue) {
    return cap([
      ...formatNearPlane(cue, state.cueExpiresAt, now),
      '',
      ...formatMiddlePlane(state),
      '',
      ...formatFarPlane(state, now),
    ]);
  }

  if (!state.token) {
    return cap([
      'MID OFFLINE',
      ...wrapText('Backend unreachable. Key enrolls when reachable.', PLANE_WIDTH.mid).slice(0, 2),
      ...wrapText('Tap G2 or R1 retries.', PLANE_WIDTH.mid).slice(0, 1),
      '',
      ...formatFarPlane(state, now),
    ]);
  }

  if (!state.live) {
    const prep = firstContextHint(state);
    return cap([
      'MID PREP',
      'Transcript default on',
      'Auto assist highest',
      ...(prep
        ? wrapText(prep, PLANE_WIDTH.mid).slice(0, 3)
        : wrapText('Tap G2 or R1 once to start.', PLANE_WIDTH.mid).slice(0, 2)),
      '',
      ...formatFarPlane(state, now),
    ]);
  }

  return cap([
    ...formatMiddlePlane(state, 5),
    '',
    ...formatFarPlane(state, now),
  ]);
}

function cap(lines) {
  const fitted = [];
  for (const line of lines.filter((value) => value !== undefined && value !== null)) {
    const text = line === '' ? '' : fitLine(line, PLANE_WIDTH.far);
    if (!text && (!fitted.length || fitted[fitted.length - 1] === '')) continue;
    fitted.push(text);
  }
  while (fitted[fitted.length - 1] === '') fitted.pop();
  const clipped = fitted.slice(0, MAX_G2_LINES);
  return clipped.join('\n').slice(0, MAX_G2_CHARS);
}

function formatNearPlane(cue, expiresAt, now) {
  const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const label = cue.source === 'client_context' ? 'NEAR PREP' : 'NEAR COUNSELOR';
  const title = normalizeText(cue.title || 'Counselor cue').toUpperCase();
  const detail = normalizeText(cue.detail || cue.sayThis || '');
  return [
    fitLine(`${label} CLOSE ${seconds}S`, PLANE_WIDTH.near),
    ...wrapText(title, PLANE_WIDTH.near).slice(0, 1),
    ...wrapText(detail, PLANE_WIDTH.near).slice(0, 2),
  ];
}

function formatMiddlePlane(state, transcriptLines = 2) {
  if (state.transcript) {
    return [
      'MID TRANSCRIPT',
      ...lastWrappedLines(state.transcript, PLANE_WIDTH.mid, transcriptLines),
    ];
  }
  return [
    'MID TRANSCRIPT',
    ...(state.live
      ? wrapText(state.audioFrames > 0
        ? `Mic frames ${state.audioFrames}. Waiting for speech.`
        : 'Listening for G2 mic.', PLANE_WIDTH.mid).slice(0, 2)
      : wrapText('Transcript appears here by default.', PLANE_WIDTH.mid).slice(0, 2)),
  ];
}

function formatFarPlane(state, now) {
  const lines = [
    fitLine(`FAR ${state.live ? 'LIVE' : 'READY'} ${formatTime(now)}`, PLANE_WIDTH.far),
    fitLine(formatClientLine(state.client), PLANE_WIDTH.far),
  ];
  const dynamics = formatDynamics(state.dynamics);
  if (dynamics) lines.push(fitLine(dynamics, PLANE_WIDTH.far));
  return lines.filter(Boolean).slice(0, 3);
}

function formatClientLine(client) {
  if (!client?.displayName) return 'No calendar client selected';
  const starts = client.startsAt ? ` ${formatTime(client.startsAt)}` : '';
  return `Client ${normalizeText(client.displayName)}${starts}`;
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
    const safeWord = word.length > width ? fitLine(word, width) : word;
    const next = line ? `${line} ${safeWord}` : safeWord;
    if (next.length > width && line) {
      lines.push(line);
      line = safeWord;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitLine(value, width) {
  const text = normalizeText(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}
