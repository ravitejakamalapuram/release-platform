#!/usr/bin/env node
// Hourly CodeRabbit review queue. CodeRabbit reviews about one PR per hour on these repos and only on a
// manual "review" command, so this is the ONLY thing that posts that command. Each run:
//   1. lists open non-draft PRs in REVIEW_QUEUE_REPOS that CodeRabbit has not reviewed at their head commit,
//   2. orders them: label `review:urgent` first, no label next, `review:low` last, then oldest opened first,
//   3. posts the review command on the first one, unless a review is running, a rate limit is active, or the last
//      command (ours or a person's) was under 55 minutes ago,
//   4. labels `ready-to-merge` on PRs whose latest CodeRabbit review has 0 actionable comments and whose CI is green
//      (and removes it when that stops being true), so a person or thread only has to glance and merge,
//   5. keeps one sticky comment per queued PR (position + expected time) and writes the whole line to the run summary.
//
//   REVIEW_QUEUE_TOKEN=... REVIEW_QUEUE_REPOS=owner/a,owner/b [DRY_RUN=1] node scripts/review-queue.mjs
//
// Needs a token of the repo owner (CodeRabbit ignores commands from bots): fine-grained, on the queued repos,
// Pull requests read/write, Commit statuses read, Checks read. No LLM, no app code runs.
import { pathToFileURL } from 'node:url';
import { log, main, notice, summary } from './lib/gha.mjs';

export const LABELS = { urgent: 'review:urgent', low: 'review:low', ready: 'ready-to-merge' };
const BOT = 'coderabbitai[bot]';
const TRIGGER = 'review-queue:trigger';
const STATUS = 'review-queue:status';
const MIN = 60_000;
const COOLDOWN = 55 * MIN; // slots are one hour apart; 5 minutes of slack for late cron runs
const REVIEW_TAKES = 15 * MIN; // CodeRabbit answered 10-13 minutes after a command in the PRs we looked at
const MAX_ATTEMPTS = 3; // commands per head commit with no review before a PR is parked

export const priority = (labels) => (labels.includes(LABELS.urgent) ? 0 : labels.includes(LABELS.low) ? 2 : 1);
const PRIORITY_NAME = ['urgent', 'normal', 'low'];

/** Queue order: priority, then earliest opened, then a stable tiebreak. */
export function order(prs) {
  return [...prs].sort((a, b) => a.rank - b.rank || Date.parse(a.created) - Date.parse(b.created) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

/** First cron tick (minute `at` of an hour, UTC) at or after `t`. */
export function nextTick(t, at) {
  const d = new Date(Math.ceil(t / MIN) * MIN);
  while (d.getUTCMinutes() !== at) d.setTime(d.getTime() + MIN);
  return d.getTime();
}

/** Time each queue position gets its command: the first now if allowed, else the next tick; then one slot apart. */
export function slots(count, { now, blockedUntil, canTrigger, tickMinute }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(i === 0 ? (canTrigger ? now : nextTick(Math.max(now, blockedUntil), tickMinute)) : nextTick(out[i - 1] + COOLDOWN, tickMinute));
  }
  return out;
}

const clock = (t, tz) => `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t)} ${tz === 'Asia/Kolkata' ? 'IST' : tz}`;

/** Wait CodeRabbit asks for ("Next included review available in 25 minutes", "Please wait 12 minutes and 30 seconds"), in ms, or 0. */
export function rateLimitWait(body) {
  if (!/rate limit|review limit reached/i.test(body)) return 0;
  const at = body.search(/(?:wait|available in)\s+\**\d/i);
  if (at < 0) return 0;
  const tail = body.slice(at, at + 80).replace(/\*/g, '');
  const n = (unit) => Number(new RegExp(`(\\d+)\\s*${unit}`, 'i').exec(tail)?.[1] ?? 0);
  return ((n('hours?') * 60 + n('minutes?')) * 60 + n('seconds?')) * 1000;
}

export function statusBody(pr, { position, total, when, tz, state }) {
  const lines = [`<!-- ${STATUS} -->`];
  if (state === 'done') lines.push('**CodeRabbit queue:** reviewed at the latest commit. Nothing more to wait for.');
  else if (state === 'parked') lines.push(`**CodeRabbit queue:** parked. ${MAX_ATTEMPTS} review requests for this commit got no review. Push a new commit, or ask for a review by hand once, to put it back in the line.`);
  else {
    lines.push(`**CodeRabbit queue:** position ${position} of ${total} · priority ${PRIORITY_NAME[pr.rank]}`);
    lines.push(`Review ${state === 'requested' ? 'requested' : 'will be requested about'} ${clock(when, tz)}; CodeRabbit usually answers about ${REVIEW_TAKES / MIN} minutes later.`);
    lines.push('Label `review:urgent` to go first or `review:low` to go last. Updated every hour; nothing to do otherwise.');
  }
  return lines.join('\n\n');
}

function client(fetchImpl, token) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'release-platform-review-queue' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const list = async (path) => {
    const rows = [];
    for (let page = 1; ; page++) {
      const batch = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  };
  return { call, list };
}

async function inspect(api, repo, pr) {
  const [reviews, comments, status] = await Promise.all([
    api.list(`/repos/${repo}/pulls/${pr.number}/reviews`),
    api.list(`/repos/${repo}/issues/${pr.number}/comments`),
    api.call('GET', `/repos/${repo}/commits/${pr.head.sha}/status`),
  ]);
  const sha = pr.head.sha;
  const cr = (status.statuses ?? []).find((s) => s.context === 'CodeRabbit');
  const triggers = [];
  let sticky = null;
  let limitUntil = 0;
  for (const c of comments) {
    const at = Date.parse(c.created_at);
    const seen = Date.parse(c.updated_at ?? c.created_at); // CodeRabbit edits its limit notice in place
    const mark = new RegExp(`<!-- ${TRIGGER} sha=(\\w+) -->`).exec(c.body);
    if (mark) triggers.push({ at, sha: mark[1] });
    else if (/^\s*@coderabbitai\s+(full\s+)?review\b/i.test(c.body) && c.user?.login !== BOT) triggers.push({ at, sha: null });
    if (c.body.includes(`<!-- ${STATUS} -->`)) sticky = c;
    if (c.user?.login === BOT) limitUntil = Math.max(limitUntil, rateLimitWait(c.body) ? seen + rateLimitWait(c.body) : 0);
  }
  const reviewed = reviews.some((r) => r.user?.login === BOT && r.commit_id === sha) || (cr?.state === 'success' && /review completed/i.test(cr.description ?? ''));
  let clean = false;
  if (reviewed) {
    const last = reviews.filter((r) => r.user?.login === BOT && r.commit_id === sha).pop();
    const n = /Actionable comments posted:\s*(\d+)/i.exec(last?.body ?? '');
    const checks = await api.call('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const ok = (checks.check_runs ?? []).every((c) => c.status === 'completed' && ['success', 'skipped', 'neutral'].includes(c.conclusion));
    const others = (status.statuses ?? []).filter((x) => x.context !== 'CodeRabbit').every((x) => x.state === 'success');
    clean = n !== null && Number(n[1]) === 0 && ok && others;
  }
  return {
    repo,
    number: pr.number,
    labels: pr.labels.map((l) => l.name),
    clean,
    title: pr.title,
    created: pr.created_at,
    sha,
    rank: priority(pr.labels.map((l) => l.name)),
    reviewed,
    running: cr?.state === 'pending',
    attempts: triggers.filter((t) => t.sha && sha.startsWith(t.sha)).length,
    lastTrigger: Math.max(0, ...triggers.map((t) => t.at)),
    limitUntil,
    sticky,
  };
}

export async function run({ token, repos, dry = false, tz = 'Asia/Kolkata', tickMinute = 17, fetchImpl = fetch, now = Date.now() }) {
  const api = client(fetchImpl, token);
  const open = [];
  for (const repo of repos) for (const pr of await api.list(`/repos/${repo}/pulls?state=open`)) if (!pr.draft) open.push([repo, pr]);
  const prs = [];
  for (const [repo, pr] of open) prs.push(await inspect(api, repo, pr));

  const parked = prs.filter((p) => !p.reviewed && p.attempts >= MAX_ATTEMPTS);
  const queue = order(prs.filter((p) => !p.reviewed && p.attempts < MAX_ATTEMPTS));
  const running = prs.some((p) => p.running);
  const blockedUntil = Math.max(0, ...prs.map((p) => Math.max(p.limitUntil, p.lastTrigger ? p.lastTrigger + COOLDOWN : 0)), running ? now + REVIEW_TAKES : 0);
  const canTrigger = blockedUntil <= now;
  const times = slots(queue.length, { now, blockedUntil, canTrigger, tickMinute });

  const writes = [];
  const upsert = (p, body) => {
    if (p.sticky?.body === body) return;
    writes.push(dry ? null : p.sticky ? api.call('PATCH', `/repos/${p.repo}/issues/comments/${p.sticky.id}`, { body }) : api.call('POST', `/repos/${p.repo}/issues/${p.number}/comments`, { body }));
  };

  let decision;
  if (!queue.length) decision = 'Queue is empty: every open PR has a CodeRabbit review at its latest commit (or is a draft).';
  else if (!canTrigger) decision = `Waiting, no command sent: ${running ? 'a CodeRabbit review is running' : `earliest next command ${clock(blockedUntil, tz)} (rate limit or the 55-minute spacing)`}.`;
  else {
    const first = queue[0];
    decision = `${dry ? 'Would request' : 'Requested'} a review on ${first.repo}#${first.number} (${first.title}).`;
    if (!dry) await api.call('POST', `/repos/${first.repo}/issues/${first.number}/comments`, { body: `@coderabbitai review\n\n<!-- ${TRIGGER} sha=${first.sha.slice(0, 12)} -->\n_Requested by the hourly review queue._` });
  }

  queue.forEach((p, i) => upsert(p, statusBody(p, { position: i + 1, total: queue.length, when: times[i], tz, state: i === 0 && canTrigger ? 'requested' : 'queued' })));
  parked.forEach((p) => upsert(p, statusBody(p, { state: 'parked' })));
  prs.filter((p) => p.reviewed && p.sticky && !p.sticky.body.includes('reviewed at the latest commit')).forEach((p) => upsert(p, statusBody(p, { state: 'done' })));
  for (const p of prs) {
    const has = p.labels.includes(LABELS.ready);
    if (p.clean && !has) writes.push(dry ? null : api.call('POST', `/repos/${p.repo}/issues/${p.number}/labels`, { labels: [LABELS.ready] }));
    if (!p.clean && has) writes.push(dry ? null : api.call('DELETE', `/repos/${p.repo}/issues/${p.number}/labels/${encodeURIComponent(LABELS.ready)}`));
  }
  await Promise.all(writes);

  const rows = queue.map((p, i) => `| ${i + 1} | ${p.repo}#${p.number} | ${PRIORITY_NAME[p.rank]} | ${p.created.slice(0, 10)} | ${clock(times[i], tz)} |`);
  summary(['## CodeRabbit review queue', '', dry ? '_Dry run: nothing was posted._' : '', decision, '', ...(rows.length ? ['| # | PR | Priority | Opened | Review requested |', '|---|---|---|---|---|', ...rows] : []), ...parked.map((p) => `\nParked: ${p.repo}#${p.number} (${MAX_ATTEMPTS} requests, no review)`)].join('\n'));
  summary(prs.filter((p) => p.clean).map((p) => `Ready to merge: ${p.repo}#${p.number}`).join('\n'));
  return { queue, parked, decision, canTrigger, prs };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(async () => {
    const token = process.env.REVIEW_QUEUE_TOKEN;
    if (!token) {
      notice('REVIEW_QUEUE_TOKEN is not set, so the review queue is idle. Add it as a repository secret.');
      summary('## CodeRabbit review queue\n\nIdle: the `REVIEW_QUEUE_TOKEN` secret is not set.');
      return;
    }
    const repos = (process.env.REVIEW_QUEUE_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!repos.length) throw new Error('REVIEW_QUEUE_REPOS is empty');
    const { decision } = await run({ token, repos, dry: Boolean(process.env.DRY_RUN) });
    log(decision);
  });
}
