import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConfig, detectBaseline, normalizeTarget, parseTargetFilter, planTargets, toSemver, versionFromGradle, versionFromPubspec,
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
        track: 'internal', release_status: 'draft', release_notes: 'CHANGELOG.md', flutter: '3.24.0',
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
