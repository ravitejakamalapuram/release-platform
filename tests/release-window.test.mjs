import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideWindow, gatherGit } from '../scripts/release-window.mjs';

const NOW = '2026-10-01T12:00:00Z';
const hoursAgo = (h) => new Date(new Date(NOW) - h * 36e5).toISOString();

test('a burst of merges becomes ONE release once the window opens', () => {
  const r = decideWindow({ subjects: ['fix: a', 'feat: b', 'fix: c', 'chore: d'], lastReleaseAt: hoursAgo(5), now: NOW });
  assert.equal(r.go, true);
  assert.match(r.reason, /3 user-facing/);
});

test('pushes never release non-urgent work; they wait for the window', () => {
  const r = decideWindow({ subjects: ['fix: a'], lastReleaseAt: hoursAgo(50), now: NOW, trigger: 'push' });
  assert.equal(r.go, false);
  assert.match(r.reason, /waiting for the next release window/);
});

test('the minimum gap between releases is respected on schedule', () => {
  const young = decideWindow({ subjects: ['fix: a'], lastReleaseAt: hoursAgo(1), now: NOW });
  assert.equal(young.go, false);
  assert.match(young.reason, /waiting for 3h/);
  assert.equal(decideWindow({ subjects: ['fix: a'], lastReleaseAt: hoursAgo(3), now: NOW }).go, true);
  assert.equal(decideWindow({ subjects: ['fix: a'], lastReleaseAt: hoursAgo(1), now: NOW, minIntervalHours: 0.5 }).go, true);
});

test('nothing releasable means no release, however old the last one is', () => {
  assert.equal(decideWindow({ subjects: ['chore: a', 'docs: b'], lastReleaseAt: hoursAgo(500), now: NOW }).go, false);
  assert.equal(decideWindow({ subjects: [], lastReleaseAt: hoursAgo(500), now: NOW }).go, false);
});

test('hotfix: releases immediately, even on push and inside the gap', () => {
  const r = decideWindow({ subjects: ['chore: x', 'hotfix(auth): crash on login'], lastReleaseAt: hoursAgo(0.1), now: NOW, trigger: 'push' });
  assert.equal(r.go, true);
  assert.match(r.reason, /Urgent/);
});

test('fix! is a breaking-change marker, not urgency', () => {
  const r = decideWindow({ subjects: ['fix!: rename api'], lastReleaseAt: hoursAgo(0.1), now: NOW, trigger: 'push' });
  assert.equal(r.go, false);
});

test('hold always wins; force releases now', () => {
  assert.equal(decideWindow({ subjects: ['hotfix: x'], hold: true, force: true }).go, false);
  assert.equal(decideWindow({ subjects: [], lastReleaseAt: hoursAgo(0.1), now: NOW, force: true }).go, true);
});

test('no previous release: first release goes out as soon as there is something to ship', () => {
  assert.equal(decideWindow({ subjects: ['feat: first'], lastReleaseAt: null, now: NOW }).go, true);
});

test('gatherGit reads the last v* tag, its date and only the commits after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' } });
  const cwd = process.cwd();
  try {
    run('init', '-q', '-b', 'main');
    const commit = (m) => { writeFileSync(join(dir, 'f'), m); run('add', '.'); run('commit', '-q', '-m', m); };
    commit('fix: old'); run('tag', 'v1.0.0'); commit('feat: new one'); commit('chore: tidy'); commit('fix: new two');
    process.chdir(dir);
    const g = gatherGit();
    assert.equal(g.tag, 'v1.0.0');
    assert.deepEqual(g.subjects.sort(), ['chore: tidy', 'feat: new one', 'fix: new two']);
    assert.match(g.lastReleaseAt, /^2026-09-01T/);
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});
