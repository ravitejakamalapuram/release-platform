#!/usr/bin/env node
// Package a built Chrome extension directory into a store-ready zip.
//
//   node scripts/package-chrome.mjs --dir extension --version 1.4.0 --out dist/app.zip [--include '["a","b/**"]']
//
// - Stamps manifest.json "version" (the working tree is never modified; files are staged).
// - Default: everything under --dir minus common junk (see DEFAULT_EXCLUDES).
// - --include switches to an allowlist (files, directories or globs). manifest.json is always included.
// - Fails if the manifest references a file that did not make it into the package.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { log, main, setOutput } from './lib/gha.mjs';

export const DEFAULT_EXCLUDES = [
  '**/.git*', '**/.git/**', '**/node_modules/**', '**/.DS_Store', '**/.env*',
  '**/*.md', '**/*.map', '**/*.zip', '**/*.crx', '**/*.pem', '**/*.log',
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**', 'e2e/**', 'coverage/**',
  'scripts/**', 'store/**', 'chrome-store/**', 'store-assets/**', 'screenshots/**', 'promo/**',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig*.json',
  '.eslintrc*', 'eslint.config.*', '.prettierrc*', 'vitest.config.*', 'jest.config.*', 'playwright.config.*',
];

/** Convert a glob (supports **, *, ?) or a plain path/dir into a RegExp over POSIX relative paths. */
export function globToRegExp(glob) {
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches anything.
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A plain entry also matches everything beneath it (so "icons" includes "icons/16.png").
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function makeFilter({ include = [], exclude = DEFAULT_EXCLUDES } = {}) {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return (rel) => {
    if (rel === 'manifest.json') return true;
    if (inc.length) return inc.some((r) => r.test(rel));
    return !exc.some((r) => r.test(rel));
  };
}

export function listFiles(root, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...listFiles(root, p));
    } else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** Files a manifest points at that must exist in the package (globs are skipped). */
export function manifestReferences(manifest) {
  const refs = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v && !/[*?]/.test(v) && !/^https?:/.test(v)) refs.add(v.replace(/^\.?\//, ''));
  };
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  add(manifest.background?.page);
  add(manifest.action?.default_popup);
  add(manifest.browser_action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);
  for (const cs of manifest.content_scripts ?? []) [...(cs.js ?? []), ...(cs.css ?? [])].forEach(add);
  for (const icons of [manifest.icons, manifest.action?.default_icon, manifest.browser_action?.default_icon]) {
    if (typeof icons === 'string') add(icons);
    else if (icons) Object.values(icons).forEach(add);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    (typeof war === 'string' ? [war] : war.resources ?? []).forEach(add);
  }
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return [...refs].sort();
}

export function stampManifest(manifest, version) {
  if (!/^\d+(\.\d+){0,3}$/.test(version) || version.split('.').some((p) => Number(p) > 65535)) {
    throw new Error(`"${version}" is not a valid Chrome extension version`);
  }
  return { ...manifest, version };
}

/** Pure selection step: returns the file list to ship, or throws if the manifest would break. */
export function selectFiles({ files, manifest, include }) {
  if (!files.includes('manifest.json')) throw new Error('manifest.json not found in the extension directory (is `path` the build output?)');
  const selected = files.filter(makeFilter({ include }));
  const missing = manifestReferences(manifest).filter((ref) => !selected.includes(ref));
  if (missing.length) {
    const hint = include?.length ? 'add them to `include`' : 'they are excluded by the default denylist; set `include` explicitly';
    throw new Error(`Package would be missing files referenced by manifest.json: ${missing.join(', ')} (${hint})`);
  }
  return selected;
}

export function packageExtension({ dir, version, out, include = [] }) {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Extension directory "${dir}" does not exist`);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const files = selectFiles({ files: listFiles(root), manifest, include });

  const stage = mkdtempSync(join(tmpdir(), 'cws-'));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(stage, f)), { recursive: true });
      cpSync(join(root, f), join(stage, f));
    }
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(stampManifest(manifest, version), null, 2)}\n`);
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    // -X: no extra attributes, -D: no directory entries -> reproducible-ish archives.
    execFileSync('zip', ['-q', '-X', '-D', '-r', target, '.'], { cwd: stage, stdio: 'inherit' });
    return { files, out: target, name: manifest.name };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function cli() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      version: { type: 'string' },
      out: { type: 'string' },
      include: { type: 'string', default: '[]' },
    },
  });
  for (const k of ['dir', 'version', 'out']) if (!values[k]) throw new Error(`--${k} is required`);
  const include = JSON.parse(values.include);
  const result = packageExtension({ dir: values.dir, version: values.version, out: values.out, include });
  const size = statSync(result.out).size;
  log(`Packaged ${result.files.length} files -> ${values.out} (${(size / 1024).toFixed(1)} KiB)`);
  for (const f of result.files) log(`  ${f}`);
  setOutput('zip', result.out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
