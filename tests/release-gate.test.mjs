import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_TYPES } from '../scripts/release-gate.mjs';

test('user-facing conventional commits release', () => {
  for (const s of ['feat: add x', 'fix: y', 'perf: z', 'revert: w', 'feat(review): prompt', 'fix!: breaking', 'fix(db)!: migrate']) {
    assert.equal(decide({ subject: s }).go, true, s);
  }
});

test('non user-facing commits do not release', () => {
  for (const s of ['chore: bump', 'docs: readme', 'ci: workflow', 'test: add', 'style: fmt', 'refactor: tidy', 'build: deps',
    'Merge pull request #1 from a/b', 'Update README.md', '', 'fix:', 'feature: nope', 'fixup: x']) {
    assert.equal(decide({ subject: s }).go, false, JSON.stringify(s));
  }
});

test('only the first line of a multi-line message counts', () => {
  assert.equal(decide({ subject: 'chore: x\n\nfix: hidden in body' }).go, false);
  assert.equal(decide({ subject: 'fix: real\n\nchore: body' }).go, true);
});

test('hold beats everything, including force', () => {
  assert.equal(decide({ subject: 'fix: y', hold: true }).go, false);
  assert.equal(decide({ subject: 'fix: y', hold: true, force: true }).go, false);
});

test('force releases a non user-facing head commit', () => {
  assert.equal(decide({ subject: 'chore: x', force: true }).go, true);
});

test('custom types, and junk type names cannot inject regex', () => {
  assert.equal(decide({ subject: 'chore: x', types: ['chore'] }).go, true);
  assert.equal(decide({ subject: 'fix: y', types: ['chore'] }).go, false);
  assert.equal(decide({ subject: 'anything: y', types: ['.*', '(a'] }).go, false);
  assert.equal(decide({ subject: 'fix: y', types: [] }).go, false);
});

test('defaults are the user-facing set', () => {
  assert.deepEqual(DEFAULT_TYPES, ['feat', 'fix', 'perf', 'revert']);
});
