// Reports whether an app repo carries the report-problem module and loads it.
// Usage: node check-report-problem.mjs --repo <app dir> --platform <release-platform dir> [--require]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

const version = (text) => Number(/@release-platform\/report-problem v(\d+)/.exec(text)?.[1] ?? 0);

/** Returns { status, detail }; status is n/a, ok, missing, outdated, modified or not loaded. */
export function check(repo, platform) {
  const files = walk(repo);
  if (!files.some((f) => basename(f) === 'manifest.json')) return { status: 'n/a', detail: 'no manifest.json (not a Chrome extension)' };
  const canonical = readFileSync(join(platform, 'modules/report-problem/report-problem.js'), 'utf8');
  const copy = files.find((f) => basename(f) === 'report-problem.js');
  if (!copy) return { status: 'missing', detail: 'see modules/report-problem/README.md in release-platform' };
  const text = readFileSync(copy, 'utf8');
  if (version(text) < version(canonical)) return { status: 'outdated', detail: `v${version(text)}, current is v${version(canonical)}` };
  if (text !== canonical) return { status: 'modified', detail: 'differs from the platform copy; re-copy it instead of editing' };
  const loaded = files.some((f) => f.endsWith('.html') && /<script[^>]+src="[^"]*report-problem\.js"/.test(readFileSync(f, 'utf8')));
  return loaded ? { status: 'ok', detail: `v${version(text)}` } : { status: 'not loaded', detail: 'no HTML page includes report-problem.js' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
  const { status, detail } = check(arg('--repo'), arg('--platform'));
  const line = `Report a problem: ${status} (${detail})`;
  console.log(line);
  const bad = !['ok', 'n/a'].includes(status);
  if (bad) console.log(`::warning::${line}`);
  if (process.env.GITHUB_STEP_SUMMARY && existsSync(process.env.GITHUB_STEP_SUMMARY)) {
    (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  }
  if (bad && process.argv.includes('--require')) process.exit(1);
}
