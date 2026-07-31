import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHud, formatHudZones, normalizeDynamics, normalizeText } from './hudFormat.js';

const baseState = {
  version: '0.1.49',
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

test('live transcript is the default active plane when no cue is visible', () => {
  const text = formatHud({
    ...baseState,
    live: true,
    transcript: 'The client is describing a difficult conversation with their partner and naming a need for more space.',
  }, Date.parse('2026-07-31T16:00:00-04:00'));

  assert.match(text, /MID TRANSCRIPT/);
  assert.match(text, /difficult\s+conversation/);
  assert.match(text, /FAR LIVE/);
  assertLensSafe(text);

  const zones = formatHudZones({
    ...baseState,
    live: true,
    transcript: 'The client is describing a difficult conversation with their partner and naming a need for more space.',
  }, Date.parse('2026-07-31T16:00:00-04:00'));
  assert.equal(zones.near, '');
  assert.match(zones.mid, /MID TRANSCRIPT/);
  assert.match(zones.far, /FAR LIVE/);
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

  assert.match(text, /NEAR COUNSELOR CLOSE 6S/);
  assert.match(text, /REPAIR BEFORE STEERING/);
  assert.match(text, /Reflect first/);
  assert.match(text, /MID TRANSCRIPT/);
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
  assert.match(zones.near, /NEAR COUNSELOR CLOSE 6S/);
  assert.match(zones.mid, /MID TRANSCRIPT/);
  assert.match(zones.far, /FAR LIVE/);
  assertZonesSafe(zones);
});

test('prep context appears before recording starts', () => {
  const text = formatHud({
    ...baseState,
    client: { displayName: 'Demo Client', startsAt: '2026-07-31T18:00:00Z' },
    contextHints: ['client question: What would make this week feel one degree more workable?'],
  }, Date.parse('2026-07-31T16:00:00-04:00'));

  assert.match(text, /MID PREP/);
  assert.match(text, /Client Demo Client/);
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

function assertLensSafe(text) {
  assert.ok(text.length <= 620);
  assert.ok(text.split('\n').length <= 13);
  assert.doesNotMatch(text, /[*`>#|]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 36, `line too wide: ${line}`);
  }
}

function assertZonesSafe(zones) {
  const limits = {
    near: { chars: 150, lines: 4, width: 31 },
    mid: { chars: 260, lines: 6, width: 34 },
    far: { chars: 120, lines: 3, width: 36 },
  };
  for (const [zone, text] of Object.entries(zones)) {
    const limit = limits[zone];
    assert.ok(text.length <= limit.chars, `${zone} too long`);
    assert.ok(text.split('\n').length <= limit.lines, `${zone} too tall`);
    assert.doesNotMatch(text, /[*`>#|]/);
    for (const line of text.split('\n')) {
      assert.ok(line.length <= limit.width, `${zone} line too wide: ${line}`);
    }
  }
}
