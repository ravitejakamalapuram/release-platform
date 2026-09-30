// Decides whether a push to main should trigger an automatic release.
//
// Pure function + a tiny CLI for the auto-release workflow. Keeping the rule here (tested) instead of
// as inline shell means every app gets the same behaviour and it can change in one place.
//
// A commit is releasable when its subject is a conventional-commit of one of the user-facing types
// (default feat, fix, perf, revert), optionally scoped and/or marked breaking: `fix(scope)!: ...`.
// chore, docs, ci, test, style, build, refactor and merge commits never release on their own.
import { appendFileSync } from 'node:fs';

export const DEFAULT_TYPES = ['feat', 'fix', 'perf', 'revert'];

export function decide({ subject = '', hold = false, force = false, types = DEFAULT_TYPES } = {}) {
  if (hold) return { go: false, reason: 'RELEASE_HOLD is set - automatic releasing is paused.' };
  if (force) return { go: true, reason: 'Forced release.' };
  const line = String(subject).split('\n')[0].trim();
  const clean = types.map((t) => String(t).trim().toLowerCase()).filter((t) => /^[a-z]+$/.test(t));
  if (clean.length === 0) return { go: false, reason: 'No valid release types configured.' };
  const re = new RegExp(`^(${clean.join('|')})(\\([^)]*\\))?!?:\\s*\\S`);
  if (re.test(line)) return { go: true, reason: `Releasable change: ${line}` };
  return { go: false, reason: `Not a user-facing change, no release: ${line || '(empty subject)'}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';
  const types = (process.env.TYPES || DEFAULT_TYPES.join(',')).split(',');
  const { go, reason } = decide({
    subject: process.env.SUBJECT,
    hold: truthy(process.env.HOLD),
    force: truthy(process.env.FORCE),
    types,
  });
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\nreason=${reason.replace(/\n/g, ' ')}\n`);
}
