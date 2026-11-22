import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffInProgress } from '../scripts/play.mjs';

const tracks = (releases) => [{ track: 'production', releases }];
const want = { track: 'production', versionCodes: ['121'] };

test('holds when the in-progress release has exactly the expected version codes', () => {
  assert.deepEqual(diffInProgress(want, tracks([{ versionCodes: ['121'], status: 'inProgress', userFraction: 0.05 }])), []);
  assert.deepEqual(diffInProgress({ track: 'production', versionCodes: [122, 121] }, tracks([{ versionCodes: ['121', '122'], status: 'inProgress', userFraction: 0.2 }])), []);
});

test('differs when Play serves another version code in progress', () => {
  const out = diffInProgress({ track: 'production', versionCodes: ['120'] }, tracks([{ versionCodes: ['121'], status: 'inProgress', userFraction: 0.05 }]));
  assert.match(out[0], /in-progress release is \[121\], expected \[120\]/);
});

test('differs when the release is completed, halted or missing', () => {
  for (const status of ['completed', 'halted', 'draft']) {
    assert.match(diffInProgress(want, tracks([{ versionCodes: ['121'], status }]))[0], /no in-progress release/);
  }
  assert.match(diffInProgress(want, tracks([]))[0], /no in-progress release/);
  assert.match(diffInProgress(want, [])[0], /track not found/);
});

test('includeHalted accepts the highest in-progress or halted release, whatever the order', () => {
  const opts = { ...want, includeHalted: true };
  assert.deepEqual(diffInProgress(opts, tracks([{ versionCodes: ['121'], status: 'halted' }])), []);
  const both = tracks([{ versionCodes: ['120'], status: 'halted' }, { versionCodes: ['121'], status: 'inProgress' }]);
  assert.deepEqual(diffInProgress(opts, both), []);
  assert.match(diffInProgress({ track: 'production', versionCodes: ['120'], includeHalted: true }, both)[0], /is \[121\], expected \[120\]/);
  assert.match(diffInProgress(opts, tracks([{ versionCodes: ['121'], status: 'completed' }]))[0], /no in-progress release/);
});
