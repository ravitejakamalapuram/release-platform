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
