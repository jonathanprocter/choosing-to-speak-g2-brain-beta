import { getTextWidth, pxTruncate } from '@evenrealities/pretext';

export const G2_DISPLAY = {
  width: 576,
  height: 288,
  lineHeightPx: 27,
  safetyGutterPx: 10,
};

export const HUD_ZONE_ORDER = ['far', 'mid', 'near'];

// Semantic depth planes mapped onto the documented 2D G2 display. These
// dimensions are chosen so each zone's text budget fits the actual LVGL line
// height instead of relying on approximate character counts.
export const HUD_ZONE_LAYOUT = {
  far: {
    containerID: 1,
    containerName: 'zone-far',
    xPosition: 32,
    yPosition: 0,
    width: 512,
    height: 44,
    paddingLength: 4,
    borderWidth: 0,
    borderColor: 6,
    isEventCapture: 0,
  },
  mid: {
    containerID: 2,
    containerName: 'zone-mid',
    xPosition: 24,
    yPosition: 56,
    width: 528,
    height: 126,
    paddingLength: 8,
    borderWidth: 1,
    borderColor: 10,
    isEventCapture: 1,
  },
  near: {
    containerID: 3,
    containerName: 'zone-near',
    xPosition: 48,
    yPosition: 196,
    width: 480,
    height: 92,
    paddingLength: 4,
    borderWidth: 1,
    borderColor: 15,
    isEventCapture: 0,
  },
};

const MAX_G2_CHARS = 620;
const ZONE_CHAR_LIMITS = { far: 80, mid: 260, near: 150 };
export const ZONE_LIMITS = Object.fromEntries(
  HUD_ZONE_ORDER.map((zone) => {
    const spec = HUD_ZONE_LAYOUT[zone];
    const inset = 2 * ((spec.paddingLength || 0) + (spec.borderWidth || 0));
    return [zone, {
      chars: ZONE_CHAR_LIMITS[zone],
      lines: Math.max(1, Math.floor((spec.height - inset) / G2_DISPLAY.lineHeightPx)),
      widthPx: Math.max(80, spec.width - inset - G2_DISPLAY.safetyGutterPx),
    }];
  })
);
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
  return [zones.far, zones.mid, zones.near]
    .filter((zone) => normalizeText(zone))
    .join('\n\n')
    .slice(0, MAX_G2_CHARS);
}

// Two-slot cue model: one active cue per plane. Legacy single-cue state
// (state.cue / state.cueExpiresAt) is still honored so older callers and
// tests keep working; legacy cues route by their declared plane.
function getActiveCues(state, now) {
  const active = { near: null, mid: null };
  if (state.cues && typeof state.cues === 'object') {
    for (const plane of ['near', 'mid']) {
      const slot = state.cues[plane];
      if (slot && now < Number(slot.expiresAt || 0)) {
        active[plane] = { cue: slot, expiresAt: Number(slot.expiresAt) };
      }
    }
    return active;
  }
  if (state.cue && now < state.cueExpiresAt) {
    const plane = state.cue.plane === 'mid' ? 'mid' : 'near';
    active[plane] = { cue: state.cue, expiresAt: state.cueExpiresAt };
  }
  return active;
}

export function formatHudZones(state, now = Date.now()) {
  const cues = getActiveCues(state, now);
  // When not live, a mid-plane cue would collide with the prep/offline block,
  // so promote it to NEAR (matching the old all-cues-render-near behavior).
  const nearSlot = cues.near || (!state.live ? cues.mid : null);
  const midSlot = state.live ? cues.mid : null;

  const zones = {
    far: formatFarPlane(state, now),
    mid: '',
    near: nearSlot ? formatNearPlane(nearSlot.cue, nearSlot.expiresAt, now) : '',
  };

  if (!state.token) {
    zones.mid = capZone('mid', [
      'OFFLINE',
      ...takeWrappedLines('Backend unreachable. Key enrolls when reachable.', 'mid', 2),
      ...takeWrappedLines('Tap G2 or R1 retries.', 'mid', 1),
    ]);
    return zones;
  }

  if (!state.live) {
    const prep = firstContextHint(state);
    zones.mid = capZone('mid', [
      'PREP',
      'Transcript default on',
      'Auto assist highest',
      ...(prep
        ? takeWrappedLines(prep, 'mid', 3)
        : takeWrappedLines('Tap G2 or R1 once to start.', 'mid', 2)),
    ]);
    return zones;
  }

  if (isReviewing(state)) {
    zones.mid = formatReviewPlane(state);
    return zones;
  }

  zones.mid = midSlot
    ? formatMidCuePlane(state, midSlot.cue, midSlot.expiresAt, now)
    : formatMiddlePlane(state, nearSlot ? 2 : 3);
  return zones;
}

function isReviewing(state) {
  return Number.isInteger(state.reviewIndex)
    && Array.isArray(state.recentTurns)
    && state.reviewIndex >= 0
    && state.reviewIndex < state.recentTurns.length;
}

// Scroll-back transcript review: MID shows one remembered turn at a time.
function formatReviewPlane(state) {
  const turns = state.recentTurns;
  const index = state.reviewIndex;
  const turn = turns[index];
  const speaker = turn.speakerKind === 'NOT_ME' ? 'C: ' : turn.speakerKind === 'ME' ? 'Y: ' : '';
  return capZone('mid', [
    `REVIEW ${index + 1}/${turns.length}`,
    ...takeWrappedLines(`${speaker}${turn.text}`, 'mid', 3),
  ]);
}

// Countdown renders in 2-second steps (6, 4, 2) so the 1s ticker's off-step
// renders are content-identical and skipped by the BLE diff — halves the
// per-cue radio writes without losing the countdown affordance.
function cueSeconds(expiresAt, now) {
  const raw = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  return Math.max(1, Math.ceil(raw / 2) * 2);
}

function formatNearPlane(cue, expiresAt, now) {
  const seconds = cueSeconds(expiresAt, now);
  const label = cue.source === 'client_context' ? 'PREP' : 'COUNSELOR';
  const title = normalizeText(cue.title || 'Counselor cue').toUpperCase();
  const detail = normalizeText(cue.detail || cue.sayThis || '');
  return capZone('near', [
    fitLine(`${label} ${seconds}S`, 'near'),
    ...takeWrappedLines(title, 'near', 1),
    ...takeWrappedLines(detail, 'near', 1),
  ]);
}

// Mid-plane cues render inside the MID zone above the live transcript tail,
// instead of evicting a NEAR cue (or being silently dropped).
function formatMidCuePlane(state, cue, expiresAt, now) {
  const seconds = cueSeconds(expiresAt, now);
  const title = normalizeText(cue.title || 'Counselor cue').toUpperCase();
  const detail = normalizeText(cue.detail || cue.sayThis || '');
  const tail = state.transcript ? lastWrappedLines(state.transcript, 'mid', 1) : [];
  return capZone('mid', [
    fitLine(`CUE ${seconds}S`, 'mid'),
    ...takeWrappedLines(title, 'mid', 1),
    ...takeWrappedLines(detail, 'mid', tail.length ? 1 : 2),
    ...tail,
  ]);
}

function formatMiddlePlane(state, transcriptLines = 2) {
  if (state.transcript) {
    return capZone('mid', [
      'TRANSCRIPT',
      ...lastWrappedLines(state.transcript, 'mid', transcriptLines),
    ]);
  }
  return capZone('mid', [
    'TRANSCRIPT',
    ...(state.live
      ? takeWrappedLines(state.audioFrames > 0
        ? `Mic frames ${state.audioFrames}. Waiting for speech.`
        : 'Listening for G2 mic.', 'mid', 2)
      : takeWrappedLines('Transcript appears here by default.', 'mid', 2)),
  ]);
}

function formatFarPlane(state, now) {
  const clientLine = formatClientLine(state.client, { includeStart: !state.live });
  return capZone('far', [
    [
      `${state.live ? 'LIVE' : 'READY'} ${formatTime(now)}`,
      clientLine,
      clientLine === 'no client' ? formatTalkRatio(state.dynamics) : '',
    ].filter(Boolean).join(' '),
  ]);
}

function formatClientLine(client, { includeStart = true } = {}) {
  if (!client?.displayName) return 'no client';
  const starts = includeStart && client.startsAt ? ` ${formatTime(client.startsAt)}` : '';
  return `${normalizeText(client.displayName)}${starts}`;
}

function formatTalkRatio(dynamics) {
  const clientRatio = Number(dynamics?.clientRatio || 0);
  const therapistRatio = Number(dynamics?.therapistRatio || 0);
  if (!clientRatio && !therapistRatio) return '';
  return `${Math.round(clientRatio)}C/${Math.round(therapistRatio)}Y`;
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

// Pixel-accurate wrapping using the LVGL font metrics Even Hub renders with.
// The previous char-count approximation (34ch etc.) truncated wide-glyph
// lines mid-word and wasted width on narrow-glyph lines.
export function wrapText(text, widthPx) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const safeWord = getTextWidth(word) > widthPx ? pxTruncate(word, widthPx) : word;
    const next = line ? `${line} ${safeWord}` : safeWord;
    if (getTextWidth(next) > widthPx && line) {
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
  const widthPx = typeof zoneOrWidth === 'number' ? zoneOrWidth : zoneWidth(zoneOrWidth);
  const text = normalizeText(value);
  if (getTextWidth(text) <= widthPx) return text;
  return pxTruncate(text, widthPx);
}

function zoneWidth(zone) {
  return (ZONE_LIMITS[zone] || ZONE_LIMITS.mid).widthPx;
}
