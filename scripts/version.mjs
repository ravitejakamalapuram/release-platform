#!/usr/bin/env node
// Next-version computation from git tags + conventional commits.
//
//   node scripts/version.mjs --bump auto --baseline 1.4.0
//
// Writes outputs: version, tag, version_code, previous_tag, bump.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { log, main, setOutput } from './lib/gha.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const BUMPS = ['auto', 'patch', 'minor', 'major'];

export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim());
  if (!m) throw new Error(`Not a MAJOR.MINOR.PATCH version: "${text}"`);
  return m.slice(1, 4).map(Number);
}

export function formatVersion([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

/** Highest vX.Y.Z tag, ignoring anything that is not strict semver (v1.2, v2-beta, ...). */
export function latestTag(tags) {
  const parsed = tags
    .map((t) => t.trim())
    .filter((t) => TAG.test(t))
    .map((t) => ({ tag: t, v: t.slice(1).split('.').map(Number) }));
  parsed.sort((a, b) => compareParts(b.v, a.v));
  return parsed[0]?.tag ?? null;
}

export function compareParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s/;

/** Decide the bump implied by a list of commits ({subject, body}). */
export function detectBump(commits) {
  let bump = 'patch';
  for (const { subject = '', body = '' } of commits) {
    const m = CONVENTIONAL.exec(subject);
    if ((m && m[2]) || /^BREAKING[ -]CHANGE:/m.test(body)) return 'major';
    if (m && m[1].toLowerCase() === 'feat') bump = 'minor';
  }
  return bump;
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = typeof version === 'string' ? parseVersion(version) : version;
  switch (bump) {
    case 'major':
      return formatVersion([major + 1, 0, 0]);
    case 'minor':
      return formatVersion([major, minor + 1, 0]);
    case 'patch':
      return formatVersion([major, minor, patch + 1]);
    default:
      throw new Error(`Unknown bump "${bump}" (expected ${BUMPS.join('|')})`);
  }
}

/**
 * Play versionCode = MAJOR*1_000_000 + MINOR*1_000 + PATCH.
 * Monotonic as long as MINOR/PATCH stay <= 999; Play caps versionCode at 2_100_000_000.
 */
export function versionCode(version) {
  const [major, minor, patch] = parseVersion(version);
  if (minor > 999 || patch > 999) {
    throw new Error(`versionCode scheme needs MINOR and PATCH <= 999 (got ${version}); bump the next component instead`);
  }
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code < 1 || code > 2_100_000_000) throw new Error(`versionCode ${code} for ${version} is outside Play's 1..2100000000 range`);
  return code;
}

/**
 * Pure planner: given the latest tag (or baseline when untagged), requested bump and commits,
 * return the next version.
 */
export function planVersion({ tag, baseline, bump = 'auto', commits = [] }) {
  if (!BUMPS.includes(bump)) throw new Error(`Unknown bump "${bump}" (expected ${BUMPS.join('|')})`);
  const current = tag ? tag.slice(1) : (baseline ?? '0.0.0');
  parseVersion(current);
  if (bump === 'auto' && tag && commits.length === 0) {
    throw new Error(`No commits since ${tag}; nothing to release. Pass an explicit bump to force a release.`);
  }
  const effective = bump === 'auto' ? detectBump(commits) : bump;
  const version = bumpVersion(current, effective);
  return { previous: current, previousTag: tag, bump: effective, version, tag: `v${version}`, versionCode: versionCode(version) };
}

/** Release notes markdown grouped by conventional type. */
export function releaseNotes(commits) {
  const groups = { Features: [], Fixes: [], Other: [] };
  for (const { subject, sha } of commits) {
    if (/^Merge /.test(subject)) continue;
    const m = CONVENTIONAL.exec(subject);
    const type = m?.[1]?.toLowerCase();
    const bucket = type === 'feat' ? 'Features' : type === 'fix' ? 'Fixes' : 'Other';
    groups[bucket].push(`- ${subject}${sha ? ` (${sha.slice(0, 7)})` : ''}`);
  }
  const parts = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([title, items]) => `### ${title}\n${items.join('\n')}`);
  return parts.length ? parts.join('\n\n') : '_No notable changes._';
}

// ---------- git plumbing (not unit tested; thin) ----------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function readCommits(range, cwd) {
  const out = git(['log', '--format=%H%x1f%s%x1f%b%x1e', ...(range ? [range] : [])], cwd);
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split('\x1f');
      return { sha, subject, body: body ?? '' };
    });
}

async function cli() {
  const { values } = parseArgs({
    options: {
      bump: { type: 'string', default: 'auto' },
      baseline: { type: 'string' },
      cwd: { type: 'string', default: '.' },
      'notes-file': { type: 'string' },
    },
  });
  const tag = latestTag(git(['tag', '--list', 'v*'], values.cwd).split('\n'));
  const commits = readCommits(tag ? `${tag}..HEAD` : null, values.cwd);
  const plan = planVersion({ tag, baseline: values.baseline, bump: values.bump, commits });

  log(`Previous: ${plan.previousTag ?? `(no tag; baseline ${plan.previous})`}`);
  log(`Bump:     ${plan.bump}`);
  log(`Next:     ${plan.version} (versionCode ${plan.versionCode})`);
  setOutput('version', plan.version);
  setOutput('tag', plan.tag);
  setOutput('version_code', String(plan.versionCode));
  setOutput('previous_tag', plan.previousTag ?? '');
  setOutput('bump', plan.bump);
  if (values['notes-file']) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(values['notes-file'], `${releaseNotes(commits)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
