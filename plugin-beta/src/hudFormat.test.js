import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  G2_DISPLAY,
  HUD_ZONE_LAYOUT,
  HUD_ZONE_ORDER,
  ZONE_LIMITS,
  formatHud,
  formatHudZones,
  normalizeDynamics,
  normalizeText,
} from './hudFormat.js';
import { getTextWidth } from '@evenrealities/pretext';

const baseState = {
  version: '0.1.53',
  live: false,
  token: 'vs_live_testtoken000000000000000000000000',
  client: null,
  contextHints: [],
  dynamics: {},
  cue: null,
  cueExpiresAt: 0,
  transcript: '',
  audioFrames: 0,
};

test('depth zones fit the physical G2 line-height budget', () => {
  for (const zone of HUD_ZONE_ORDER) {
    const spec = HUD_ZONE_LAYOUT[zone];
    const limit = ZONE_LIMITS[zone];
    const inset = 2 * ((spec.paddingLength || 0) + (spec.borderWidth || 0));
    assert.ok(spec.xPosition >= 0, `${zone} x starts off-display`);
    assert.ok(spec.yPosition >= 0, `${zone} y starts off-display`);
    assert.ok(spec.xPosition + spec.width <= G2_DISPLAY.width, `${zone} too wide for display`);
    assert.ok(spec.yPosition + spec.height <= G2_DISPLAY.height, `${zone} too tall for display`);
    assert.ok(limit.lines * G2_DISPLAY.lineHeightPx <= spec.height - inset, `${zone} line budget clips`);
    assert.ok(limit.widthPx <= spec.width - inset, `${zone} width budget clips`);
  }
  assert.equal(ZONE_LIMITS.far.lines, 1);
  assert.equal(ZONE_LIMITS.mid.lines, 4);
  assert.equal(ZONE_LIMITS.near.lines, 3);
});

test('live transcript is the default active plane when no cue is visible', () => {
  const text = formatHud({
    ...baseState,
    live: true,
    transcript: 'The client is describing a difficult conversation with their partner and naming a need for more space.',
  }, Date.parse('2026-07-31T16:00:00-04:00'));

  assert.match(text, /TRANSCRIPT/);
  assert.match(text, /difficult\s+conversation/);
  assert.match(text, /LIVE/);
  assertLensSafe(text);

  const zones = formatHudZones({
    ...baseState,
    live: true,
    transcript: 'The client is describing a difficult conversation with their partner and naming a need for more space.',
  }, Date.parse('2026-07-31T16:00:00-04:00'));
  assert.equal(zones.near, '');
  assert.match(zones.mid, /TRANSCRIPT/);
  assert.match(zones.far, /LIVE/);
  assertZonesSafe(zones);
});

test('foreground counselor cue overrides the top of the HUD and still keeps transcript context', () => {
  const now = Date.parse('2026-07-31T16:00:00-04:00');
  const text = formatHud({
    ...baseState,
    live: true,
    cue: {
      title: '**Repair** before steering',
      detail: '> Reflect first, then ask `one` open question tied to the session goal.',
      plane: 'near',
      source: 'dynamics',
    },
    cueExpiresAt: now + 6000,
    transcript: 'I want to fix this quickly but I can tell I am moving faster than the client.',
  }, now);

  assert.match(text, /COUNSELOR 6S/);
  assert.match(text, /REPAIR BEFORE STEERING/);
  assert.match(text, /Reflect first/);
  assert.match(text, /TRANSCRIPT/);
  assert.doesNotMatch(text, /\*\*|>|`/);
  assertLensSafe(text);

  const zones = formatHudZones({
    ...baseState,
    live: true,
    cue: {
      title: '**Repair** before steering',
      detail: '> Reflect first, then ask `one` open question tied to the session goal.',
      plane: 'near',
      source: 'dynamics',
    },
    cueExpiresAt: now + 6000,
    transcript: 'I want to fix this quickly but I can tell I am moving faster than the client.',
  }, now);
  assert.match(zones.near, /COUNSELOR 6S/);
  assert.match(zones.mid, /TRANSCRIPT/);
  assert.match(zones.far, /LIVE/);
  assertZonesSafe(zones);
});

test('prep context appears before recording starts', () => {
  const text = formatHud({
    ...baseState,
    client: { displayName: 'Demo Client', startsAt: '2026-07-31T18:00:00Z' },
    contextHints: ['client question: What would make this week feel one degree more workable?'],
  }, Date.parse('2026-07-31T16:00:00-04:00'));

  assert.match(text, /PREP/);
  assert.match(text, /Demo Client/);
  assert.match(text, /Transcript default on/);
  assert.match(text, /client question/);
  assertLensSafe(text);
  assertZonesSafe(formatHudZones({
    ...baseState,
    client: { displayName: 'Demo Client', startsAt: '2026-07-31T18:00:00Z' },
    contextHints: ['client question: What would make this week feel one degree more workable?'],
  }, Date.parse('2026-07-31T16:00:00-04:00')));
});

test('dynamics normalize safely merges partial updates', () => {
  assert.deepEqual(
    normalizeDynamics({ clientRatio: '71', conversationalState: 'client_speaking' }, { therapistRatio: 29 }),
    { therapistRatio: 29, clientRatio: 71, conversationalState: 'client_speaking' }
  );
});

test('normalizeText strips markdown before text reaches the lens', () => {
  assert.equal(
    normalizeText('### Header\n- **one** `line` > [link](https://example.com)'),
    'Header one line link'
  );
});


test('mid-plane cue renders inside MID alongside the transcript tail, NEAR stays free', () => {
  const now = Date.parse('2026-07-31T16:00:00-04:00');
  const zones = formatHudZones({
    ...baseState,
    live: true,
    cues: {
      near: null,
      mid: { title: 'Open question', detail: 'Ask what changed since last week.', source: 'coach', plane: 'mid', expiresAt: now + 6000 },
    },
    transcript: 'The client mentioned the schedule change at work again.',
  }, now);
  assert.equal(zones.near, '');
  assert.match(zones.mid, /CUE 6S/);
  assert.match(zones.mid, /OPEN QUESTION/);
  assert.match(zones.mid, /what changed/);
  assertZonesSafe(zones);
});

test('two-slot cues render both planes at once without eviction', () => {
  const now = Date.parse('2026-07-31T16:00:00-04:00');
  const zones = formatHudZones({
    ...baseState,
    live: true,
    cues: {
      near: { title: 'Slow down', detail: 'Reflect before steering.', source: 'dynamics', plane: 'near', expiresAt: now + 6000 },
      mid: { title: 'Open question', detail: 'Ask about the schedule change.', source: 'coach', plane: 'mid', expiresAt: now + 6000 },
    },
    transcript: 'Transcript context continues here.',
  }, now);
  assert.match(zones.near, /COUNSELOR/);
  assert.match(zones.near, /SLOW DOWN/);
  assert.match(zones.mid, /CUE/);
  assert.match(zones.mid, /OPEN QUESTION/);
  assertZonesSafe(zones);
});

test('scroll review shows one remembered turn with position and speaker', () => {
  const zones = formatHudZones({
    ...baseState,
    live: true,
    reviewIndex: 0,
    recentTurns: [
      { text: 'I keep replaying the conversation with my sister.', speakerKind: 'NOT_ME' },
      { text: 'What part keeps pulling you back?', speakerKind: 'ME' },
    ],
    transcript: 'live tail should not render during review',
  }, Date.parse('2026-07-31T16:00:00-04:00'));
  assert.match(zones.mid, /REVIEW 1\/2/);
  assert.match(zones.mid, /C: I keep replaying/);
  assert.doesNotMatch(zones.mid, /live tail/);
  assertZonesSafe(zones);
});

test('cue countdown renders in 2-second steps so off-step ticks are BLE no-ops', () => {
  const now = Date.parse('2026-07-31T16:00:00-04:00');
  const cue = { title: 'Cue', detail: 'Detail', source: 'dynamics', plane: 'near' };
  const at = (msLeft) => formatHudZones({
    ...baseState, live: true,
    cues: { near: { ...cue, expiresAt: now + msLeft }, mid: null },
    transcript: 'context',
  }, now).near;
  assert.match(at(6000), /COUNSELOR 6S/);
  assert.match(at(5000), /COUNSELOR 6S/);
  assert.match(at(4000), /COUNSELOR 4S/);
  assert.match(at(3000), /COUNSELOR 4S/);
  assert.match(at(1500), /COUNSELOR 2S/);
});

function assertLensSafe(text) {
  assert.ok(text.length <= 620);
  assert.ok(text.split('\n').length <= 13);
  assert.doesNotMatch(text, /[*`>#|]/);
  for (const line of text.split('\n')) {
    assert.ok(getTextWidth(line) <= 510, `line too wide (${getTextWidth(line)}px): ${line}`);
  }
}

function assertZonesSafe(zones) {
  for (const [zone, text] of Object.entries(zones)) {
    const limit = ZONE_LIMITS[zone];
    assert.ok(text.length <= limit.chars, `${zone} too long`);
    assert.ok(text.split('\n').length <= limit.lines, `${zone} too tall`);
    assert.doesNotMatch(text, /[*`>#|]/);
    for (const line of text.split('\n')) {
      assert.ok(getTextWidth(line) <= limit.widthPx, `${zone} line too wide (${getTextWidth(line)}px): ${line}`);
    }
  }
}
