import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResults, renderSummary } from '../scripts/summary.mjs';

const targets = [
  { key: 'chrome-0', type: 'chrome', item_id: 'a'.repeat(32) },
  { key: 'android-1', type: 'android', package: 'com.x.y', track: 'internal' },
];

test('summary lists every planned target, including ones that never ran', () => {
  const md = renderSummary({ targets, results: { 'chrome-0': { key: 'chrome-0', ok: true, result: 'PENDING_REVIEW' } }, version: '1.2.3', tag: 'v1.2.3' });
  assert.match(md, /\| chrome \| `a{32}` \| 1.2.3 \| Chrome Web Store \| PENDING_REVIEW \|/);
  assert.match(md, /\| android \| `com.x.y` \| 1.2.3 \| Google Play \(internal\) \| not published/);
  assert.match(md, /No tag was created/);
});

test('summary footer for success and dry run', () => {
  const results = { 'chrome-0': { ok: true, result: 'x' }, 'android-1': { ok: true, result: 'y' } };
  assert.match(renderSummary({ targets, results, version: '1.0.0', tag: 'v1.0.0' }), /Tagged \*\*v1.0.0\*\*/);
  assert.match(renderSummary({ targets, results, version: '1.0.0', tag: 'v1.0.0', dryRun: true }), /Dry run/);
});

test('readResults loads nested json files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'res-'));
  mkdirSync(join(dir, 'result-chrome-0'));
  writeFileSync(join(dir, 'result-chrome-0', 'chrome-0.json'), JSON.stringify({ key: 'chrome-0', ok: true, result: 'OK' }));
  assert.deepEqual(readResults(dir), { 'chrome-0': { key: 'chrome-0', ok: true, result: 'OK' } });
  assert.deepEqual(readResults(join(dir, 'missing')), {});
});
