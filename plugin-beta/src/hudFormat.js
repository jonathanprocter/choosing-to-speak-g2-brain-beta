const MAX_G2_CHARS = 620;
const ZONE_LIMITS = {
  far: { chars: 120, lines: 3, width: 36 },
  mid: { chars: 260, lines: 6, width: 34 },
  near: { chars: 150, lines: 4, width: 31 },
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
  const zones = formatHudZones(state, now);
  return [zones.near, zones.mid, zones.far]
    .filter((zone) => normalizeText(zone))
    .join('\n\n')
    .slice(0, MAX_G2_CHARS);
}

export function formatHudZones(state, now = Date.now()) {
  const cue = state.cue && now < state.cueExpiresAt ? state.cue : null;
  const zones = {
    far: formatFarPlane(state, now),
    mid: '',
    near: cue ? formatNearPlane(cue, state.cueExpiresAt, now) : '',
  };

  if (!state.token) {
    zones.mid = capZone('mid', [
      'MID OFFLINE',
      ...takeWrappedLines('Backend unreachable. Key enrolls when reachable.', 'mid', 2),
      ...takeWrappedLines('Tap G2 or R1 retries.', 'mid', 1),
    ]);
    return zones;
  }

  if (!state.live) {
    const prep = firstContextHint(state);
    zones.mid = capZone('mid', [
      'MID PREP',
      'Transcript default on',
      'Auto assist highest',
      ...(prep
        ? takeWrappedLines(prep, 'mid', 3)
        : takeWrappedLines('Tap G2 or R1 once to start.', 'mid', 2)),
    ]);
    return zones;
  }

  zones.mid = formatMiddlePlane(state, cue ? 2 : 5);
  return zones;
}

function formatNearPlane(cue, expiresAt, now) {
  const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const label = cue.source === 'client_context' ? 'NEAR PREP' : 'NEAR COUNSELOR';
  const title = normalizeText(cue.title || 'Counselor cue').toUpperCase();
  const detail = normalizeText(cue.detail || cue.sayThis || '');
  return capZone('near', [
    fitLine(`${label} CLOSE ${seconds}S`, 'near'),
    ...takeWrappedLines(title, 'near', 1),
    ...takeWrappedLines(detail, 'near', 2),
  ]);
}

function formatMiddlePlane(state, transcriptLines = 2) {
  if (state.transcript) {
    return capZone('mid', [
      'MID TRANSCRIPT',
      ...lastWrappedLines(state.transcript, 'mid', transcriptLines),
    ]);
  }
  return capZone('mid', [
    'MID TRANSCRIPT',
    ...(state.live
      ? takeWrappedLines(state.audioFrames > 0
        ? `Mic frames ${state.audioFrames}. Waiting for speech.`
        : 'Listening for G2 mic.', 'mid', 2)
      : takeWrappedLines('Transcript appears here by default.', 'mid', 2)),
  ]);
}

function formatFarPlane(state, now) {
  const lines = [
    fitLine(`FAR ${state.live ? 'LIVE' : 'READY'} ${formatTime(now)}`, 'far'),
    fitLine(formatClientLine(state.client), 'far'),
  ];
  const dynamics = formatDynamics(state.dynamics);
  if (dynamics) lines.push(fitLine(dynamics, 'far'));
  return capZone('far', lines);
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

function lastWrappedLines(text, zone, count) {
  return wrapText(text, zoneWidth(zone)).slice(-count);
}

function takeWrappedLines(text, zone, count) {
  const lines = wrapText(text, zoneWidth(zone));
  if (lines.length <= count) return lines;
  const kept = lines.slice(0, count);
  kept[count - 1] = fitLine(`${kept[count - 1]}...`, zone);
  return kept;
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

function capZone(zone, lines) {
  const limit = ZONE_LIMITS[zone] || ZONE_LIMITS.mid;
  const fitted = [];
  for (const line of lines.filter((value) => value !== undefined && value !== null)) {
    const text = line === '' ? '' : fitLine(line, zone);
    if (!text && (!fitted.length || fitted[fitted.length - 1] === '')) continue;
    fitted.push(text);
  }
  while (fitted[fitted.length - 1] === '') fitted.pop();
  return fitted.slice(0, limit.lines).join('\n').slice(0, limit.chars);
}

function fitLine(value, zoneOrWidth) {
  const width = typeof zoneOrWidth === 'number' ? zoneOrWidth : zoneWidth(zoneOrWidth);
  const text = normalizeText(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}

function zoneWidth(zone) {
  return (ZONE_LIMITS[zone] || ZONE_LIMITS.mid).width;
}
