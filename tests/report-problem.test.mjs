import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../scripts/check-report-problem.mjs';

const platform = new URL('..', import.meta.url).pathname;
const canonical = readFileSync(join(platform, 'modules/report-problem/report-problem.js'), 'utf8');

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const page = '<script src="report-problem.js"></script>';

test('statuses', () => {
  assert.equal(check(app({ 'a.txt': '' }), platform).status, 'n/a');
  assert.equal(check(app({ 'manifest.json': '{}' }), platform).status, 'missing');
  assert.equal(check(app({ 'manifest.json': '{}', 'report-problem.js': '/* @release-platform/report-problem v0 */', 'x.html': page }), platform).status, 'outdated');
  assert.equal(check(app({ 'manifest.json': '{}', 'report-problem.js': canonical + '//x', 'x.html': page }), platform).status, 'modified');
  assert.equal(check(app({ 'manifest.json': '{}', 'report-problem.js': canonical }), platform).status, 'not loaded');
  assert.equal(check(app({ 'manifest.json': '{}', 'report-problem.js': canonical, 'x.html': page }), platform).status, 'ok');
});
