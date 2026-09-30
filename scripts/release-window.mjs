// Release WINDOW: batches a burst of merges into one release instead of one release per merge.
//
//   push to main            -> releases only if an unreleased commit is marked urgent (`hotfix:`)
//   schedule / dispatch     -> releases once, if there is at least one unreleased user-facing commit
//                              AND the last release is at least `minIntervalHours` old
//   force (dispatch)        -> releases now          hold (RELEASE_HOLD=true) -> never releases
//
// `decideWindow` is pure (unit-tested). The CLI gathers the git facts (last v* tag and its date, the
// commit subjects since it) and writes `go` / `reason` to $GITHUB_OUTPUT for the workflow.
//
// Note: urgency is an explicit `hotfix:` prefix. `fix!:` is NOT urgent: in conventional commits `!` means
// "breaking change", which bumps the major version but says nothing about speed.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { decide, DEFAULT_TYPES } from './release-gate.mjs';

const HOTFIX = /^hotfix(\([^)]*\))?!?:\s*\S/i;

export function decideWindow({
  subjects = [], lastReleaseAt = null, now = new Date(), trigger = 'schedule',
  minIntervalHours = 3, hold = false, force = false, types = DEFAULT_TYPES,
} = {}) {
  if (hold) return { go: false, reason: 'RELEASE_HOLD is set - automatic releasing is paused.' };
  if (force) return { go: true, reason: 'Forced release.' };

  const lines = subjects.map((s) => String(s).split('\n')[0].trim()).filter(Boolean);
  const urgent = lines.find((l) => HOTFIX.test(l));
  const releasable = lines.filter((l) => decide({ subject: l, types }).go);
  if (urgent) return { go: true, reason: `Urgent change, releasing now: ${urgent}` };
  if (releasable.length === 0) {
    return { go: false, reason: `Nothing to release: ${lines.length} unreleased commit(s), none user-facing.` };
  }
  if (trigger === 'push') {
    return { go: false, reason: `${releasable.length} releasable commit(s) are waiting for the next release window.` };
  }
  if (lastReleaseAt) {
    const hours = (new Date(now) - new Date(lastReleaseAt)) / 36e5;
    if (hours < minIntervalHours) {
      return { go: false, reason: `Last release was ${hours.toFixed(1)}h ago; waiting for ${minIntervalHours}h between releases (${releasable.length} queued).` };
    }
  }
  return { go: true, reason: `Release window open: ${releasable.length} user-facing commit(s) since the last release.` };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function gatherGit() {
  let tag = '';
  try { tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']); } catch { /* no tag yet */ }
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = git(['log', range, '--no-merges', '--format=%s%x1f']);
  const subjects = log.split('\x1f').map((s) => s.trim()).filter(Boolean);
  const lastReleaseAt = tag ? git(['log', '-1', '--format=%cI', tag]) : null;
  return { tag, subjects, lastReleaseAt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';
  const { tag, subjects, lastReleaseAt } = gatherGit();
  const { go, reason } = decideWindow({
    subjects, lastReleaseAt,
    trigger: process.env.TRIGGER || 'schedule',
    minIntervalHours: Number(process.env.MIN_INTERVAL_HOURS || 3),
    hold: truthy(process.env.HOLD), force: truthy(process.env.FORCE),
    types: (process.env.TYPES || DEFAULT_TYPES.join(',')).split(','),
  });
  console.log(`last release: ${tag || '(none)'} at ${lastReleaseAt || '-'}; unreleased commits: ${subjects.length}`);
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `go=${go}\nreason=${reason.replace(/\n/g, ' ')}\n`);
}
