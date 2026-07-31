// Triplane (2.5D) glasses text law for Choosing to Speak, adapted from
// jonathanprocter/clinical-hud hud/src/g2/format.js (same 576x288 single
// text container, <=900 chars, NEAR > MID > FAR priority).
//
// Inputs map to this repo's own backend payloads instead of the clinical-hud
// middleware frames:
//   NEAR  <- /v1/coach nudge (dynamics alerts: interruptions, talk share)
//   MID   <- /v1/coach sayThis[0] or /v1/question_cues questions[0]
//   FAR   <- /v1/coach dynamics {clientRatio, therapistRatio, conversationalState}

const MAX_G2_CHARS = 900;

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
  return String(value ?? fallback)
    .replace(/\s+/g, ' ')
    .trim();
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
// FAR stays compressed to one status line; hard cap at 900 chars.
export function formatGlassesText(state) {
  const alert = normalizeText(state.latestAlert);
  const cue = normalizeText(state.latestCue);
  const mode = alert ? 'DYNAMICS ALERT' : `${normalizeText(state.modality, 'CUE')} CUE`;
  const body = alert || cue || 'Listening...';
  const ratio = state.clientRatio || state.therapistRatio
    ? `${Math.round(state.clientRatio)}% client / ${Math.round(state.therapistRatio)}% you`
    : 'talk ratio pending';
  const status = normalizeText(state.conversationalState, 'listening').replace(/_/g, ' ');
  const connection = normalizeText(state.connection, 'connecting').toUpperCase();

  return [
    `CHOOSING TO SPEAK  ${connection}`,
    `${status}`,
    ratio,
    '',
    mode,
    body
  ].join('\n').slice(0, MAX_G2_CHARS);
}
