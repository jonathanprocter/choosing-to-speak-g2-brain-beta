// Triplane (2.5D) glasses text law for Choosing to Speak, adapted from
// jonathanprocter/clinical-hud hud/src/g2/format.js (same 576x288 single
// text container, lens-safe plain text, NEAR > MID > FAR priority).
//
// Inputs map to this repo's own backend payloads instead of the clinical-hud
// middleware frames:
//   NEAR  <- /v1/coach nudge (dynamics alerts: interruptions, talk share)
//   MID   <- /v1/coach sayThis[0] or /v1/question_cues questions[0]
//   FAR   <- /v1/coach dynamics {clientRatio, therapistRatio, conversationalState}

const MAX_G2_CHARS = 620;
const MAX_G2_LINES = 12;
const WIDTH = {
  near: 31,
  mid: 34,
  far: 36
};

export function initialState() {
  return {
    connection: 'connecting',
    clientRatio: 0,
    therapistRatio: 0,
    conversationalState: 'listening',
    modality: 'CUE',
    latestCue: '',
    latestAlert: '',
    lastEventType: 'READY'
  };
}

export function normalizeText(value, fallback = '') {
  return stripMarkdown(value ?? fallback).replace(/\s+/g, ' ').trim();
}

export function stripMarkdown(value) {
  return String(value ?? '')
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

// Fold a coach.result.v1 payload into triplane state. The nudge itself has no
// source field; dynamics attribution lives on questionCue.source. A
// dynamics-sourced cue promotes the nudge teaser to a NEAR alert; sayThis
// lines are MID cues; the dynamics block feeds FAR.
export function applyCoachResult(state, coach) {
  if (!coach || typeof coach !== 'object') return state;
  const next = { ...state };
  const dynamics = coach.dynamics || {};
  if (Number.isFinite(Number(dynamics.clientRatio))) next.clientRatio = Number(dynamics.clientRatio);
  if (Number.isFinite(Number(dynamics.therapistRatio))) next.therapistRatio = Number(dynamics.therapistRatio);
  if (dynamics.conversationalState) next.conversationalState = normalizeText(dynamics.conversationalState);
  const sayThis = Array.isArray(coach.sayThis) ? coach.sayThis.filter(Boolean) : [];
  if (sayThis.length) {
    next.latestCue = normalizeText(sayThis[0]);
    next.lastEventType = 'MID';
  }
  if (coach.nudge && coach.nudge.teaser) {
    const cueSource = normalizeText(coach.questionCue && coach.questionCue.source);
    if (cueSource === 'dynamics') {
      next.latestAlert = normalizeText(coach.nudge.teaser);
      next.lastEventType = 'NEAR';
    } else if (!sayThis.length) {
      next.latestCue = normalizeText(coach.nudge.teaser);
      next.lastEventType = 'MID';
    }
  }
  if (coach.questionCue && coach.questionCue.questions) {
    const modality = coach.questionCue.questions[0] && coach.questionCue.questions[0].modality;
    if (modality) next.modality = normalizeText(modality).toUpperCase();
  }
  return next;
}

// Fold a /v1/question_cues result into MID when nothing louder is showing.
export function applyQuestionCues(state, cues) {
  const question = cues && Array.isArray(cues.questions) ? cues.questions[0] : null;
  if (!question || !question.text) return state;
  return {
    ...state,
    latestCue: normalizeText(question.text),
    modality: normalizeText(question.source, state.modality).toUpperCase(),
    lastEventType: 'MID'
  };
}

export function clearAlert(state) {
  return { ...state, latestAlert: '' };
}

// Single-container 576x288 rendering. NEAR alert text takes over the cue slot;
// FAR stays compressed; hard line and character caps protect the lenses.
export function formatGlassesText(state) {
  const alert = normalizeText(state.latestAlert);
  const cue = normalizeText(state.latestCue);
  const modality = normalizeText(state.modality, 'CUE').replace(/_/g, ' ').toUpperCase();
  const mode = modality.endsWith('CUE') ? modality : `${modality} CUE`;
  const body = alert || cue || 'Listening...';
  const ratio = state.clientRatio || state.therapistRatio
    ? `${Math.round(state.clientRatio)}% client / ${Math.round(state.therapistRatio)}% you`
    : 'talk ratio pending';
  const status = normalizeText(state.conversationalState, 'listening').replace(/_/g, ' ');
  const connection = normalizeText(state.connection, 'connecting').toUpperCase();

  if (alert) {
    return cap([
      'NEAR DYNAMICS ALERT',
      ...wrapText(alert, WIDTH.near).slice(0, 3),
      '',
      'FAR STATUS',
      fitLine(connection, WIDTH.far),
      fitLine(`${status} ${ratio}`, WIDTH.far)
    ]);
  }

  return cap([
    `MID ${mode}`,
    ...wrapText(body, WIDTH.mid).slice(0, 4),
    '',
    'FAR STATUS',
    fitLine(connection, WIDTH.far),
    fitLine(`${status} ${ratio}`, WIDTH.far)
  ]);
}

function wrapText(text, width) {
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

function cap(lines) {
  const fitted = [];
  for (const line of lines.filter((value) => value !== undefined && value !== null)) {
    const text = line === '' ? '' : fitLine(line, WIDTH.far);
    if (!text && (!fitted.length || fitted[fitted.length - 1] === '')) continue;
    fitted.push(text);
  }
  while (fitted[fitted.length - 1] === '') fitted.pop();
  return fitted.slice(0, MAX_G2_LINES).join('\n').slice(0, MAX_G2_CHARS);
}

function fitLine(value, width) {
  const text = normalizeText(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3)).trimEnd()}...`;
}
