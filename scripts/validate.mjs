#!/usr/bin/env node
// Validate release.yaml (already converted to JSON by `yq -o=json`) and emit a normalized plan.
//
//   yq -o=json . release.yaml > release.json
//   node scripts/validate.mjs --config release.json --repo . --targets chrome
//
// Outputs: app, test, e2e, e2e_in_release, chrome (JSON array), android (JSON array), baseline,
// node/java/flutter (toolchain for the test gate).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
      listing: target.listing ?? '',
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
    listing: target.listing ?? '',
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

/**
 * Toolchains the test gate needs, from ALL targets (not just the filtered ones): the repo's tests
 * may compile Android code even when only the chrome target is being released.
 */
export function testToolchain(config) {
  const all = config.targets.map(normalizeTarget);
  const android = all.filter((t) => t.type === 'android');
  const chrome = all.filter((t) => t.type === 'chrome');
  return {
    node: chrome[0]?.node ?? '22',
    java: android[0]?.java ?? '',
    flutter: android.find((t) => t.flutter)?.flutter ?? '',
  };
}

export function matrixIds(plan) {
  return {
    chrome_ids: plan.chrome.map((t) => t.item_id),
    chrome_targets: Object.fromEntries(plan.chrome.map((t) => [t.item_id, t])),
    android_ids: plan.android.map((t) => t.package),
    android_targets: Object.fromEntries(plan.android.map((t) => [t.package, t])),
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

/** Read a version out of one file, by file type. Returns null if none is found. */
export function versionFromFile(path, text) {
  const name = path.split('/').pop();
  if (name.endsWith('.json')) {
    try {
      return toSemver(JSON.parse(text).version ?? '');
    } catch {
      return null;
    }
  }
  if (/\.gradle(\.kts)?$/.test(name)) return versionFromGradle(text);
  if (name === 'pubspec.yaml' || name === 'pubspec.yml') return versionFromPubspec(text);
  const m = /^\s*version\s*[:=]\s*['"]?(\d+(?:\.\d+){1,3})/m.exec(text);
  return m ? toSemver(m[1]) : null;
}

const BUILD_DIRS = /\/(dist|build|out|release)$/;

/**
 * Candidate files that may hold a chrome target's *source* version, most specific first.
 * `path` is usually a build output (e.g. apps/extension/dist) that does not exist before the
 * build, so we also look next to it and in common source layouts. Only JSON is read; files like
 * manifest.config.ts are not parseable here and are skipped.
 */
export function chromeVersionCandidates(target, repo) {
  const path = target.path.replace(/\/+$/, '');
  const parent = BUILD_DIRS.test(path) ? path.replace(BUILD_DIRS, '') : null;
  const out = [`${path}/manifest.json`];
  if (parent) out.push(`${parent}/manifest.json`, `${parent}/public/manifest.json`, `${parent}/src/manifest.json`, `${parent}/static/manifest.json`);
  out.push('manifest.json', 'public/manifest.json', 'src/manifest.json');
  const appsDir = join(repo, 'apps');
  if (existsSync(appsDir)) {
    for (const d of readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      out.push(`apps/${d}/manifest.json`, `apps/${d}/public/manifest.json`, `apps/${d}/src/manifest.json`);
    }
  }
  if (parent) out.push(`${parent}/package.json`);
  out.push('package.json');
  return [...new Set(out)];
}

const ANDROID_CANDIDATES = ['app/build.gradle.kts', 'app/build.gradle', 'android/app/build.gradle.kts', 'android/app/build.gradle', 'pubspec.yaml'];

/**
 * Version recorded in the repo; used only when there is no v* tag yet.
 * An explicit `version_file` wins (and must yield a version); otherwise the first target decides.
 */
export function detectBaseline(target, repo, versionFile) {
  const read = (p) => (existsSync(join(repo, p)) && statSync(join(repo, p)).isFile() ? readFileSync(join(repo, p), 'utf8') : null);
  if (versionFile) {
    const text = read(versionFile);
    if (text === null) throw new Error(`version_file "${versionFile}" does not exist`);
    const version = versionFromFile(versionFile, text);
    if (!version) throw new Error(`version_file "${versionFile}" does not contain a recognizable version`);
    return { version, source: `${versionFile} (version_file)` };
  }
  const candidates = target.type === 'chrome' ? chromeVersionCandidates(target, repo) : ANDROID_CANDIDATES;
  for (const p of candidates) {
    const text = read(p);
    const version = text && versionFromFile(p, text);
    if (version) return { version, source: p };
  }
  return null;
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
  const baseline = detectBaseline(normalizeTarget(config.targets[0], 0), values.repo, config.version_file);

  log(`release.yaml OK: app=${config.app}, chrome=${plan.chrome.length}, android=${plan.android.length}`);
  log(baseline ? `Baseline version ${baseline.version} (from ${baseline.source}); used only if there is no v* tag` : 'No baseline version found in the repo; an untagged repo starts from 0.0.0');
  setOutput('app', config.app);
  setOutput('test', config.test ?? '');
  setOutput('e2e', config.e2e ?? '');
  setOutput('e2e_in_release', String(config.e2e_in_release ?? false));
  setOutput('chrome', JSON.stringify(plan.chrome));
  setOutput('android', JSON.stringify(plan.android));
  // Matrices run over plain ids (so GitHub's job names read "Build chrome (<id>)"); jobs look the
  // full target up by id.
  const ids = matrixIds(plan);
  setOutput('chrome_ids', JSON.stringify(ids.chrome_ids));
  setOutput('chrome_targets', JSON.stringify(ids.chrome_targets));
  setOutput('android_ids', JSON.stringify(ids.android_ids));
  setOutput('android_targets', JSON.stringify(ids.android_targets));
  setOutput('baseline', baseline?.version ?? '');
  const tools = testToolchain(config);
  setOutput('node', tools.node);
  setOutput('java', tools.java);
  setOutput('flutter', tools.flutter);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
