import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConfig, chromeVersionCandidates, matrixIds, testToolchain, detectBaseline, versionFromFile, normalizeTarget, parseTargetFilter, planTargets, toSemver, versionFromGradle, versionFromPubspec,
} from '../scripts/validate.mjs';

const chrome = { type: 'chrome', item_id: 'jndhbmaokpclbpjoogffaimahadpidcf', path: 'extension' };
const android = { type: 'android', package: 'com.carfry369.teleport' };

test('accepts a minimal and a full config', () => {
  checkConfig({ app: 'echokit', targets: [chrome] });
  checkConfig({
    app: 'teleport',
    test: 'npm test',
    targets: [
      { ...chrome, build: 'npm ci && npm run build', node: '22', include: ['manifest.json', 'dist/**'], publish: false },
      {
        ...android, gradle_task: 'bundleRelease', aab: 'app/build/outputs/bundle/release/app-release.aab', java: '17',
        track: 'internal', release_status: 'draft', ci_task: 'assembleDebug', ci_build: 'flutter build apk --debug', release_notes: 'CHANGELOG.md', flutter: '3.24.0',
        signing: { keystore_base64: 'RELEASE_KEYSTORE_BASE64', key_alias: 'RELEASE_KEY_ALIAS' },
      },
    ],
  });
});

const invalid = (config, re) => assert.throws(() => checkConfig(config), re);

test('rejects bad configs with a pointed message', () => {
  invalid(null, /empty/);
  invalid({ targets: [chrome] }, /missing required property "app"/);
  invalid({ app: 'x', targets: [] }, /at least 1/);
  invalid({ app: 'x', targets: [{ ...chrome, item_id: 'short' }] }, /\$\.targets\[0\]\.item_id: must match .*32-letter/);
  invalid({ app: 'x', targets: [{ type: 'chrome', path: 'ext' }] }, /missing required property "item_id"/);
  invalid({ app: 'x', targets: [{ ...android, package: 'noDots' }] }, /package: must match/);
  invalid({ app: 'x', targets: [{ ...android, trak: 'beta' }] }, /unknown property "trak"/);
  invalid({ app: 'x', targets: [{ type: 'ios', bundle: 'x' }] }, /targets\[0\]\.type: must be one of "chrome", "android"/);
  invalid({ app: 'x', targets: [{ ...chrome, path: '../outside' }] }, /path: must match/);
  invalid({ app: 'x', targets: [{ ...android, signing: { keystore_base64: 'has-dash' } }] }, /secret name/);
  invalid({ app: 'x', targets: [{ ...android, ci_task: 'rm -rf /' }] }, /ci_task: must match/);
  invalid({ app: 'x', targets: [{ ...android, release_status: 'halted' }] }, /one of "completed", "draft"/);
  invalid({ app: 'x', targets: [chrome, chrome] }, /duplicate target chrome:/);
  invalid({ app: 'x', extra: 1, targets: [chrome] }, /unknown property "extra"/);
});

test('normalizeTarget fills defaults', () => {
  assert.deepEqual(normalizeTarget({ ...chrome, path: 'extension/' }, 0), {
    key: 'chrome-0', type: 'chrome', item_id: chrome.item_id, path: 'extension', build: '', node: '22', include: [], publish: true,
  });
  const a = normalizeTarget({ ...android, signing: { key_alias: 'RELEASE_KEY_ALIAS' } }, 1);
  assert.equal(a.key, 'android-1');
  assert.equal(a.gradle_task, 'bundleRelease');
  assert.equal(a.aab, 'app/build/outputs/bundle/release/app-release.aab');
  assert.equal(a.track, 'internal');
  assert.equal(a.release_status, 'completed');
  assert.equal(a.ci_task, 'assembleDebug');
  assert.equal(a.ci_build, '');
  assert.equal(normalizeTarget({ ...android, ci_task: 'app:assembleRelease', ci_build: 'flutter build apk --debug' }, 0).ci_build, 'flutter build apk --debug');
  assert.deepEqual(a.signing, {
    keystore_base64: 'ANDROID_KEYSTORE_BASE64', keystore_password: 'ANDROID_KEYSTORE_PASSWORD',
    key_alias: 'RELEASE_KEY_ALIAS', key_password: 'ANDROID_KEY_PASSWORD',
  });
});

test('target filter', () => {
  assert.deepEqual(parseTargetFilter(' Chrome , android '), ['chrome', 'android']);
  assert.deepEqual(parseTargetFilter(''), []);
  assert.throws(() => parseTargetFilter('chrome,ios'), /Unknown target type\(s\) in filter: ios/);
  const cfg = { app: 'x', targets: [chrome, android] };
  assert.equal(planTargets(cfg, '').chrome.length, 1);
  assert.equal(planTargets(cfg, 'android').chrome.length, 0);
  assert.throws(() => planTargets({ app: 'x', targets: [chrome] }, 'android'), /No targets .* match/);
});

test('version extraction helpers', () => {
  assert.equal(toSemver('1.2'), '1.2.0');
  assert.equal(toSemver('1.2.3.4'), '1.2.3');
  assert.equal(toSemver('abc'), null);
  assert.equal(versionFromGradle('versionName = (project.findProperty("versionName") as? String) ?: "1.0.0"'), '1.0.0');
  assert.equal(versionFromGradle('    versionName "2.3.4"'), '2.3.4');
  assert.equal(versionFromGradle('versionCode 3'), null);
  assert.equal(versionFromPubspec('name: x\nversion: 3.70.18+274\n'), '3.70.18');
});

test('detectBaseline reads manifest / gradle / pubspec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  mkdirSync(join(dir, 'extension'));
  writeFileSync(join(dir, 'extension/manifest.json'), JSON.stringify({ version: '1.4' }));
  assert.deepEqual(detectBaseline(normalizeTarget(chrome, 0), dir), { version: '1.4.0', source: 'extension/manifest.json' });

  const dist = normalizeTarget({ ...chrome, path: 'dist' }, 0);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  assert.deepEqual(detectBaseline(dist, dir), { version: '2.0.1', source: 'package.json' });

  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app/build.gradle.kts'), 'versionName = "1.6.9"');
  assert.equal(detectBaseline(normalizeTarget(android, 0), dir).version, '1.6.9');

  const flutter = mkdtempSync(join(tmpdir(), 'rp-'));
  writeFileSync(join(flutter, 'pubspec.yaml'), 'version: 3.70.18+274');
  assert.deepEqual(detectBaseline(normalizeTarget(android, 0), flutter), { version: '3.70.18', source: 'pubspec.yaml' });
  assert.equal(detectBaseline(normalizeTarget(android, 0), mkdtempSync(join(tmpdir(), 'rp-'))), null);
});

const tree = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};
const manifestV = (v) => JSON.stringify({ manifest_version: 3, version: v });

test('baseline: build-output path falls back to the source manifest next to it, not root package.json', () => {
  // json-workbench layout: path is apps/extension/dist, which only exists after the build.
  const dir = tree({
    'package.json': JSON.stringify({ version: '0.1.0' }),
    'apps/extension/package.json': JSON.stringify({ version: '0.1.0' }),
    'apps/extension/manifest.json': manifestV('1.4.2'),
  });
  const t = normalizeTarget({ ...chrome, path: 'apps/extension/dist' }, 0);
  assert.deepEqual(detectBaseline(t, dir), { version: '1.4.2', source: 'apps/extension/manifest.json' });
});

test('baseline: public/ and src/ next to the build dir, then apps/*', () => {
  const t = normalizeTarget({ ...chrome, path: 'ext/build' }, 0);
  assert.equal(detectBaseline(t, tree({ 'ext/public/manifest.json': manifestV('2.0'), 'package.json': '{"version":"9.9.9"}' })).source, 'ext/public/manifest.json');
  assert.equal(detectBaseline(t, tree({ 'ext/src/manifest.json': manifestV('2.1') })).version, '2.1.0');
  const other = normalizeTarget({ ...chrome, path: 'out' }, 0);
  assert.deepEqual(detectBaseline(other, tree({ 'apps/web/src/manifest.json': manifestV('3.0.1') })), { version: '3.0.1', source: 'apps/web/src/manifest.json' });
});

test('baseline: unparseable or version-less candidates are skipped', () => {
  const t = normalizeTarget({ ...chrome, path: 'apps/extension/dist' }, 0);
  const dir = tree({
    'apps/extension/manifest.config.ts': 'export default { version: "5.0.0" }',
    'apps/extension/manifest.json': '{ not json',
    'apps/extension/public/manifest.json': '{"name":"no version"}',
    'apps/extension/package.json': JSON.stringify({ version: '0.7.0' }),
  });
  assert.deepEqual(detectBaseline(t, dir), { version: '0.7.0', source: 'apps/extension/package.json' });
});

test('baseline: explicit version_file wins and must be valid', () => {
  const dir = tree({ 'VERSION.txt': 'version = 4.5.6\n', 'extension/manifest.json': manifestV('1.0.0'), 'meta.json': '{"version":"7.0"}' });
  const t = normalizeTarget(chrome, 0);
  assert.deepEqual(detectBaseline(t, dir, 'VERSION.txt'), { version: '4.5.6', source: 'VERSION.txt (version_file)' });
  assert.equal(detectBaseline(t, dir, 'meta.json').version, '7.0.0');
  assert.throws(() => detectBaseline(t, dir, 'missing.json'), /version_file "missing.json" does not exist/);
  assert.throws(() => detectBaseline(t, tree({ 'x.json': '{}' }), 'x.json'), /does not contain a recognizable version/);
});

test('versionFromFile and candidate ordering', () => {
  assert.equal(versionFromFile('a/build.gradle.kts', 'versionName = "1.2.3"'), '1.2.3');
  assert.equal(versionFromFile('pubspec.yaml', 'version: 1.0.0+5'), '1.0.0');
  assert.equal(versionFromFile('VERSION', '2.3'), null);
  const c = chromeVersionCandidates(normalizeTarget({ ...chrome, path: 'apps/extension/dist' }, 0), tree({}));
  assert.deepEqual(c.slice(0, 2), ['apps/extension/dist/manifest.json', 'apps/extension/manifest.json']);
  assert.ok(c.indexOf('apps/extension/package.json') < c.indexOf('package.json'));
  assert.equal(c.at(-1), 'package.json');
});

test('schema accepts e2e, e2e_in_release and version_file', () => {
  checkConfig({ app: 'x', e2e: 'npx playwright test', e2e_in_release: true, version_file: 'apps/extension/manifest.json', targets: [chrome] });
  invalid({ app: 'x', e2e_in_release: 'yes', targets: [chrome] }, /e2e_in_release: must be boolean/);
  invalid({ app: 'x', version_file: '../x', targets: [chrome] }, /version_file: must match/);
});

test('testToolchain derives node/java/flutter for the test gate from all targets', () => {
  assert.deepEqual(testToolchain({ targets: [chrome] }), { node: '22', java: '', flutter: '' });
  assert.deepEqual(testToolchain({ targets: [{ ...chrome, node: '20' }, { ...android, java: '21' }] }), { node: '20', java: '21', flutter: '' });
  assert.deepEqual(testToolchain({ targets: [android, { ...android, package: 'com.b.c', flutter: '3.24.5' }] }), { node: '22', java: '17', flutter: '3.24.5' });
});

test('matrixIds keys targets by store id', () => {
  const plan = planTargets({ app: 'x', targets: [chrome, android] }, '');
  const m = matrixIds(plan);
  assert.deepEqual(m.chrome_ids, [chrome.item_id]);
  assert.deepEqual(m.android_ids, [android.package]);
  assert.equal(m.chrome_targets[chrome.item_id].key, 'chrome-0');
  assert.equal(m.android_targets[android.package].signing.key_alias, 'ANDROID_KEY_ALIAS');
});
