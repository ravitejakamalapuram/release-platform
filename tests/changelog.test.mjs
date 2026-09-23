import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSection, playNotes, truncate } from '../scripts/changelog.mjs';

test('firstSection takes the newest release section', () => {
  const md = '# Changelog\n\n## [1.2.0] - 2026-01-01\n### Added\n* **New** thing ([#3](http://x))\n\n## 1.1.0\n- old\n';
  assert.equal(firstSection(md), 'Added\n- New thing (#3)');
});

test('firstSection without sections uses the whole text minus the title', () => {
  assert.equal(firstSection('# Title\nJust text'), 'Just text');
  assert.equal(firstSection(''), '');
});

test('truncate keeps Play notes within 500 chars', () => {
  const long = Array.from({ length: 60 }, (_, i) => `- change number ${i}`).join('\n');
  const out = playNotes(`## 1.0.0\n${long}`);
  assert.ok(out.length <= 500, `length ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.equal(truncate('short'), 'short');
});
