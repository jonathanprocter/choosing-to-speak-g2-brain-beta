import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCoachResult,
  applyQuestionCues,
  clearAlert,
  formatGlassesText,
  initialState
} from './format.mjs';

test('coach dynamics nudge becomes a NEAR alert and overrides the cue slot', () => {
  const state = applyCoachResult(initialState(), {
    nudge: { teaser: 'You are interrupting; let the pause breathe.', explanation: 'x' },
    sayThis: ['What boundary would protect your Sunday?'],
    questionCue: { source: 'dynamics', questions: [{ text: 'q', modality: 'repair' }] },
    dynamics: { clientRatio: 72, therapistRatio: 28, conversationalState: 'pause' }
  });
  assert.equal(state.lastEventType, 'NEAR');
  assert.equal(state.clientRatio, 72);
  const text = formatGlassesText(state);
  assert.match(text, /NEAR DYNAMICS ALERT/);
  assert.match(text, /let the\s+pause breathe/);
  assert.match(text, /72% client \/ 28% you/);
  assert.doesNotMatch(text, /protect your Sunday/);
  assertLensSafe(text);
});

test('clearing the alert falls back to the MID cue', () => {
  let state = applyCoachResult(initialState(), {
    nudge: { teaser: 'Alert', explanation: 'x' },
    sayThis: ['Name the value beneath the struggle.'],
    questionCue: { source: 'dynamics', questions: [] },
    dynamics: {}
  });
  state = clearAlert(state);
  const text = formatGlassesText(state);
  assert.match(text, /MID CUE/);
  assert.match(text, /Name the value beneath the\s+struggle/);
  assertLensSafe(text);
});

test('question cues fill MID and formatting stays lens safe', () => {
  const state = applyQuestionCues(initialState(), {
    questions: [{ text: 'x'.repeat(2000), source: 'client_context' }]
  });
  assert.equal(state.lastEventType, 'MID');
  assertLensSafe(formatGlassesText(state));
});

test('non-dynamics nudge without sayThis lands in the cue slot, not the alert slot', () => {
  const state = applyCoachResult(initialState(), {
    nudge: { teaser: 'Ask for a named example.', explanation: 'x' },
    questionCue: { source: 'memory', questions: [] }
  });
  assert.equal(state.latestAlert, '');
  assert.match(formatGlassesText(state), /Ask for a named example/);
});

test('markdown markers are stripped from generated HUD text', () => {
  const state = applyQuestionCues(initialState(), {
    questions: [{ text: '### Ask **one** `clear` question', source: 'client_context' }]
  });
  const text = formatGlassesText(state);
  assert.match(text, /Ask one clear question/);
  assertLensSafe(text);
});

function assertLensSafe(text) {
  assert.ok(text.length <= 620);
  assert.ok(text.split('\n').length <= 12);
  assert.doesNotMatch(text, /[*`>#|]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 36, `line too wide: ${line}`);
  }
}
