#!/usr/bin/env node
// Validate release.yaml (already converted to JSON by `yq -o=json`) and emit a normalized plan.
//
//   yq -o=json . release.yaml > release.json
//   node scripts/validate.mjs --config release.json --repo . --targets chrome
//
// Outputs: app, test, chrome (JSON array), android (JSON array), baseline.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate, formatErrors } from './lib/schema.mjs';
import { log, main, setOutput } from './lib/gha.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../schema/release.schema.json', import.meta.url));
export const TARGET_TYPES = ['chrome', 'android'];

export const DEFAULT_SIGNING = Object.freeze({
  keystore_base64: 'ANDROID_KEYSTORE_BASE64',
  keystore_password: 'ANDROID_KEYSTORE_PASSWORD',
  key_alias: 'ANDROID_KEY_ALIAS',
  key_password: 'ANDROID_KEY_PASSWORD',
});

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Throw a readable error if config does not match the schema or has semantic problems. */
export function checkConfig(config, schema = loadSchema()) {
  if (config === null || config === undefined) throw new Error('release.yaml is empty');
  const errors = validate(schema, config);
  const seen = new Set();
  for (const [i, t] of (Array.isArray(config.targets) ? config.targets : []).entries()) {
    const key = t?.type === 'chrome' ? `chrome:${t.item_id}` : t?.type === 'android' ? `android:${t.package}` : null;
    if (key && seen.has(key)) errors.push({ path: `$.targets[${i}]`, message: `duplicate target ${key}` });
    if (key) seen.add(key);
  }
  if (errors.length) throw new Error(`release.yaml is invalid:\n${formatErrors(errors)}`);
}

/** Fill in defaults so workflows never need `|| 'default'` expressions. */
export function normalizeTarget(target, index) {
  if (target.type === 'chrome') {
    return {
      key: `chrome-${index}`,
      type: 'chrome',
      item_id: target.item_id,
      path: target.path.replace(/\/+$/, ''),
      build: target.build ?? '',
      node: target.node ?? '22',
      include: target.include ?? [],
      publish: target.publish ?? true,
    };
  }
  return {
    key: `android-${index}`,
    type: 'android',
    package: target.package,
    gradle_task: target.gradle_task ?? 'bundleRelease',
    build: target.build ?? '',
    ci_task: target.ci_task ?? 'assembleDebug',
    ci_build: target.ci_build ?? '',
    flutter: target.flutter ?? '',
    aab: target.aab ?? 'app/build/outputs/bundle/release/app-release.aab',
    java: target.java ?? '17',
    track: target.track ?? 'internal',
    release_status: target.release_status ?? 'completed',
    release_notes: target.release_notes ?? '',
    signing: { ...DEFAULT_SIGNING, ...(target.signing ?? {}) },
  };
}

export function parseTargetFilter(filter) {
  const types = String(filter ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = types.filter((t) => !TARGET_TYPES.includes(t));
  if (unknown.length) throw new Error(`Unknown target type(s) in filter: ${unknown.join(', ')} (expected ${TARGET_TYPES.join(', ')})`);
  return types;
}

export function planTargets(config, filter) {
  const types = parseTargetFilter(filter);
  const all = config.targets.map(normalizeTarget);
  const selected = types.length ? all.filter((t) => types.includes(t.type)) : all;
  if (!selected.length) throw new Error(`No targets in release.yaml match the filter "${filter}"`);
  return {
    chrome: selected.filter((t) => t.type === 'chrome'),
    android: selected.filter((t) => t.type === 'android'),
  };
}

/** Normalize "1.2" / "1.2.3.4" style versions to MAJOR.MINOR.PATCH. */
export function toSemver(raw) {
  const parts = String(raw).trim().split('.');
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const [major = '0', minor = '0', patch = '0'] = parts;
  return [major, minor, patch].map(Number).join('.');
}

export function versionFromGradle(text) {
  const m = /versionName\s*(?:=\s*)?[^\n]*?"(\d+(?:\.\d+){1,3})"/.exec(text);
  return m ? toSemver(m[1]) : null;
}

export function versionFromPubspec(text) {
  const m = /^version:\s*['"]?(\d+(?:\.\d+){1,2})/m.exec(text);
  return m ? toSemver(m[1]) : null;
}

/** Version recorded in the repo for the first target; used only when there is no v* tag yet. */
export function detectBaseline(target, repo) {
  const read = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : null);
  if (target.type === 'chrome') {
    for (const p of [`${target.path}/manifest.json`, 'manifest.json', 'src/manifest.json', 'public/manifest.json', 'package.json']) {
      const text = read(p);
      if (!text) continue;
      try {
        const v = toSemver(JSON.parse(text).version ?? '');
        if (v) return { version: v, source: p };
      } catch {
        // ignore unparsable files
      }
    }
    return null;
  }
  for (const p of ['app/build.gradle.kts', 'app/build.gradle', 'android/app/build.gradle.kts', 'android/app/build.gradle']) {
    const text = read(p);
    const v = text && versionFromGradle(text);
    if (v) return { version: v, source: p };
  }
  const pubspec = read('pubspec.yaml');
  const v = pubspec && versionFromPubspec(pubspec);
  return v ? { version: v, source: 'pubspec.yaml' } : null;
}

async function cli() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'release.json' },
      repo: { type: 'string', default: '.' },
      targets: { type: 'string', default: '' },
    },
  });
  let config;
  try {
    config = JSON.parse(readFileSync(values.config, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${values.config}: ${err.message}`);
  }
  checkConfig(config);
  const plan = planTargets(config, values.targets);
  const baseline = detectBaseline(normalizeTarget(config.targets[0], 0), values.repo);

  log(`release.yaml OK: app=${config.app}, chrome=${plan.chrome.length}, android=${plan.android.length}`);
  if (baseline) log(`Baseline version ${baseline.version} (from ${baseline.source})`);
  setOutput('app', config.app);
  setOutput('test', config.test ?? '');
  setOutput('chrome', JSON.stringify(plan.chrome));
  setOutput('android', JSON.stringify(plan.android));
  setOutput('baseline', baseline?.version ?? '');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
