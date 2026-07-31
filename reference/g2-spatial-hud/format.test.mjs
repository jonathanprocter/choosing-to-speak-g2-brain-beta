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
  assert.match(text, /DYNAMICS ALERT/);
  assert.match(text, /let the pause breathe/);
  assert.match(text, /72% client \/ 28% you/);
  assert.doesNotMatch(text, /protect your Sunday/);
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
  assert.match(text, /CUE/);
  assert.match(text, /Name the value beneath the struggle/);
});

test('question cues fill MID and formatting stays under the 900 char cap', () => {
  const state = applyQuestionCues(initialState(), {
    questions: [{ text: 'x'.repeat(2000), source: 'client_context' }]
  });
  assert.equal(state.lastEventType, 'MID');
  assert.ok(formatGlassesText(state).length <= 900);
});

test('non-dynamics nudge without sayThis lands in the cue slot, not the alert slot', () => {
  const state = applyCoachResult(initialState(), {
    nudge: { teaser: 'Ask for a named example.', explanation: 'x' },
    questionCue: { source: 'memory', questions: [] }
  });
  assert.equal(state.latestAlert, '');
  assert.match(formatGlassesText(state), /Ask for a named example/);
});
