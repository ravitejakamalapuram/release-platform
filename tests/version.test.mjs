import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpVersion, detectBump, latestTag, planVersion, releaseNotes, versionCode } from '../scripts/version.mjs';

const c = (subject, body = '') => ({ subject, body });

test('latestTag picks the highest strict semver tag', () => {
  assert.equal(latestTag(['v1.2.3', 'v1.10.0', 'v1.9.9', 'v2', 'v3.0.0-beta', 'release-9', '']), 'v1.10.0');
  assert.equal(latestTag(['foo']), null);
  assert.equal(latestTag([]), null);
});

test('detectBump follows conventional commits', () => {
  assert.equal(detectBump([c('fix: a'), c('chore: b')]), 'patch');
  assert.equal(detectBump([c('fix: a'), c('feat(ui): b')]), 'minor');
  assert.equal(detectBump([c('feat!: drop api')]), 'major');
  assert.equal(detectBump([c('refactor(core)!: x')]), 'major');
  assert.equal(detectBump([c('fix: a', 'details\n\nBREAKING CHANGE: removed x')]), 'major');
  assert.equal(detectBump([c('Update README')]), 'patch');
  assert.equal(detectBump([c('feature: not conventional feat')]), 'patch');
});

test('bumpVersion resets lower components', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => bumpVersion('1.2.3', 'huge'), /Unknown bump/);
});

test('planVersion from tag with auto bump', () => {
  const plan = planVersion({ tag: 'v1.4.2', bump: 'auto', commits: [c('feat: x')] });
  assert.deepEqual(
    { version: plan.version, tag: plan.tag, bump: plan.bump, versionCode: plan.versionCode },
    { version: '1.5.0', tag: 'v1.5.0', bump: 'minor', versionCode: 1_005_000 },
  );
});

test('planVersion uses baseline when untagged', () => {
  assert.equal(planVersion({ tag: null, baseline: '3.70.18', bump: 'patch' }).version, '3.70.19');
  assert.equal(planVersion({ tag: null, baseline: undefined, bump: 'auto', commits: [c('feat: first')] }).version, '0.1.0');
});

test('planVersion refuses an empty auto release but allows explicit bump', () => {
  assert.throws(() => planVersion({ tag: 'v1.0.0', bump: 'auto', commits: [] }), /No commits since v1.0.0/);
  assert.equal(planVersion({ tag: 'v1.0.0', bump: 'patch', commits: [] }).version, '1.0.1');
  assert.throws(() => planVersion({ tag: 'v1.0.0', bump: 'nope' }), /Unknown bump/);
});

test('versionCode encoding and guards', () => {
  assert.equal(versionCode('1.6.9'), 1_006_009);
  assert.equal(versionCode('3.70.18'), 3_070_018);
  assert.ok(versionCode('1.10.0') > versionCode('1.9.999'));
  assert.throws(() => versionCode('1.1000.0'), /MINOR and PATCH <= 999/);
  assert.throws(() => versionCode('1.0.1000'), /MINOR and PATCH <= 999/);
  assert.throws(() => versionCode('2101.0.0'), /outside Play/);
  assert.throws(() => versionCode('0.0.0'), /outside Play/);
  assert.throws(() => versionCode('1.2'), /MAJOR.MINOR.PATCH/);
});

test('releaseNotes groups commits and skips merges', () => {
  const md = releaseNotes([
    { subject: 'feat: add x', sha: 'abcdef1234' },
    { subject: 'fix: y', sha: '1234567890' },
    { subject: 'Merge pull request #1', sha: 'ffffffffff' },
    { subject: 'docs: z', sha: '0000000000' },
  ]);
  assert.match(md, /### Features\n- feat: add x \(abcdef1\)/);
  assert.match(md, /### Fixes\n- fix: y/);
  assert.match(md, /### Other\n- docs: z/);
  assert.doesNotMatch(md, /Merge pull request/);
  assert.equal(releaseNotes([]), '_No notable changes._');
});
