import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSection, pickNotes, playNotes, truncate } from '../scripts/changelog.mjs';

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

test('pickNotes falls back to generated notes when the newest section is empty', () => {
  const generated = '### Fixes\n- fix: crash on start (abc1234)';
  for (const changelog of ['# Changelog\n\n## [Unreleased]\n\n   \n\n## [1.0.0]\n- old', '## 1.2.0\n', '']) {
    const res = pickNotes({ changelog, changelogPath: 'CHANGELOG.md', generated });
    assert.equal(res.text, 'Fixes\n- fix: crash on start (abc1234)');
    assert.match(res.source, /generated notes \(first section of CHANGELOG.md is empty\)/);
  }
  assert.match(pickNotes({ changelog: null, changelogPath: '', generated }).source, /no changelog/);
  assert.deepEqual(pickNotes({ changelog: '## 1.0\n- real', changelogPath: 'CHANGELOG.md', generated }), { text: '- real', source: 'CHANGELOG.md' });
});
