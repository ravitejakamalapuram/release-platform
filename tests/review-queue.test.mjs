import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, order, priority, rateLimitWait, run, slots, statusBody } from '../scripts/review-queue.mjs';

const T = (s) => Date.parse(s);
const NOW = T('2026-10-19T18:20:00Z');

// Routed GitHub double: prs = { 'o/r': [{ number, created_at, labels, draft, reviews, comments, status }] }
function gh(prs) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ method: init.method, path, body: init.body && JSON.parse(init.body) });
    const send = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    const pr = (repo, n) => prs[repo].find((p) => p.number === Number(n));
    let m;
    if ((m = /^\/repos\/(.+)\/pulls\?state=open/.exec(path))) return send(prs[m[1]].map((p) => ({ number: p.number, title: `PR ${p.number}`, draft: !!p.draft, created_at: p.created_at, labels: (p.labels ?? []).map((name) => ({ name })), head: { sha: `s${p.number}x` } })));
    if ((m = /^\/repos\/(.+)\/pulls\/(\d+)\/reviews/.exec(path))) return send(pr(m[1], m[2]).reviews ?? []);
    if ((m = /^\/repos\/(.+)\/issues\/(\d+)\/comments/.exec(path)) && init.method === 'GET') return send(pr(m[1], m[2]).comments ?? []);
    if ((m = /^\/repos\/(.+)\/commits\/s(\d+)x\/status/.exec(path))) return send({ statuses: pr(m[1], m[2]).status ? [{ context: 'CodeRabbit', ...pr(m[1], m[2]).status }] : [] });
    if ((m = /^\/repos\/(.+)\/commits\/s(\d+)x\/check-runs/.exec(path))) return send({ check_runs: pr(m[1], m[2]).checks ?? [] });
    if (['POST', 'PATCH', 'DELETE'].includes(init.method)) return send({});
    throw new Error(`unrouted ${path}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const pr = (number, created_at, extra = {}) => ({ number, created_at, ...extra });
const posts = (f) => f.calls.filter((c) => c.method === 'POST' && c.body.body.startsWith('@coderabbitai review'));
const go = (prs, extra = {}) => { const f = gh(prs); return run({ token: 't', repos: Object.keys(prs), fetchImpl: f, now: NOW, ...extra }).then((r) => ({ f, r })); };

test('urgent first, then no label, then low; oldest first within a priority', () => {
  const mk = (id, labels, created) => ({ repo: 'o/r', number: id, created, rank: priority(labels) });
  const got = order([mk(1, ['review:low'], '2026-10-01'), mk(2, [], '2026-10-05'), mk(3, [], '2026-10-02'), mk(4, ['review:urgent'], '2026-10-09')]);
  assert.deepEqual(got.map((p) => p.number), [4, 3, 2, 1]);
});

test('slots: first now when allowed, later ones one hour apart on the cron minute', () => {
  const s = slots(3, { now: NOW, blockedUntil: 0, canTrigger: true, tickMinute: 17 });
  assert.equal(s[0], NOW);
  assert.equal(new Date(s[1]).toISOString(), '2026-10-19T19:17:00.000Z');
  assert.equal(new Date(s[2]).toISOString(), '2026-10-19T20:17:00.000Z');
  assert.equal(new Date(nextTick(T('2026-10-19T19:17:00Z'), 17)).toISOString(), '2026-10-19T19:17:00.000Z');
});

test('parses the wait out of a rate-limit notice', () => {
  assert.equal(rateLimitWait('Rate limit exceeded. Please wait 12 minutes and 30 seconds before requesting another review.'), 750_000);
  assert.equal(rateLimitWait('Rate limit exceeded. Please wait 1 hour and 5 minutes'), 3_900_000);
  assert.equal(rateLimitWait('> [!WARNING]\n> ## Review limit reached\n> Wait for the free limit to reset to keep reviewing.\n> **Next included review available in 25 minutes.**'), 1_500_000);
  assert.equal(rateLimitWait('Looks good, no rate limit hit? wait'), 0);
  assert.equal(rateLimitWait('Walkthrough: nothing to wait on'), 0);
});

test('requests a review on exactly one PR: the urgent one, with a sha marker', async () => {
  const { f, r } = await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z'), pr(2, '2026-10-02T00:00:00Z', { labels: ['review:urgent'] }), pr(3, '2026-10-03T00:00:00Z', { draft: true })] });
  assert.equal(posts(f).length, 1);
  assert.match(posts(f)[0].path, /issues\/2\/comments/);
  assert.match(posts(f)[0].body.body, /<!-- review-queue:trigger sha=s2x -->/);
  assert.deepEqual(r.queue.map((p) => p.number), [2, 1]);
  const sticky = f.calls.filter((c) => c.method === 'POST' && c.body.body.includes('review-queue:status'));
  assert.equal(sticky.length, 2);
  assert.doesNotMatch(sticky[0].body.body, /@coderabbitai/);
  assert.match(sticky[1].body.body, /position 2 of 2 · priority normal/);
});

test('reviewed at the head commit leaves the queue; an older review does not', async () => {
  const bot = { user: { login: 'coderabbitai[bot]' } };
  const { r } = await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { reviews: [{ ...bot, commit_id: 's1x' }] }), pr(2, '2026-10-02T00:00:00Z', { reviews: [{ ...bot, commit_id: 'old' }] })] });
  assert.deepEqual(r.queue.map((p) => p.number), [2]);
});

test('no command while a review runs, within 55 minutes of the last command, or inside a rate limit', async () => {
  const q = [pr(1, '2026-10-01T00:00:00Z')];
  assert.equal((await go({ 'o/r': [{ ...q[0], status: { state: 'pending' } }] })).f.calls.filter((c) => c.method === 'POST' && c.body.body.startsWith('@')).length, 0);
  const recent = { user: { login: 'someone' }, body: '@coderabbitai review', created_at: '2026-10-19T17:40:00Z' };
  assert.equal((await go({ 'o/r': [{ ...q[0], comments: [recent] }] })).r.canTrigger, false);
  const limited = { user: { login: 'coderabbitai[bot]' }, body: 'Rate limit exceeded. Please wait 40 minutes and 0 seconds.', created_at: '2026-10-19T18:00:00Z' };
  assert.equal((await go({ 'o/r': [{ ...q[0], comments: [limited] }] })).r.canTrigger, false);
});

test('a PR that got three commands at this commit and no review is parked, not retried forever', async () => {
  const t = (h) => ({ user: { login: 'me' }, body: `@coderabbitai review\n<!-- review-queue:trigger sha=s1x -->`, created_at: `2026-10-19T0${h}:00:00Z` });
  const { r, f } = await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { comments: [t(1), t(2), t(3)] }), pr(2, '2026-10-02T00:00:00Z')] });
  assert.deepEqual(r.parked.map((p) => p.number), [1]);
  assert.match(posts(f)[0].path, /issues\/2\//);
});

test('dry run writes nothing; sticky comment is edited in place and only when it changed', async () => {
  const dry = await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z')] }, { dry: true });
  assert.equal(dry.f.calls.filter((c) => c.method !== 'GET').length, 0);
  const body = statusBody({ rank: 1 }, { position: 1, total: 1, when: NOW, tz: 'Asia/Kolkata', state: 'requested' });
  const same = await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { comments: [{ id: 9, user: { login: 'me' }, body, created_at: '2026-10-19T10:00:00Z' }] })] });
  assert.equal(same.f.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('ready-to-merge label: added when the latest review has 0 actionable comments and CI is green, removed when not', async () => {
  const rev = (n) => [{ user: { login: 'coderabbitai[bot]' }, commit_id: 's1x', body: `**Actionable comments posted: ${n}**` }];
  const green = [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }];
  const labelCalls = (f) => f.calls.filter((c) => /\/labels/.test(c.path)).map((c) => `${c.method} ${c.body?.labels ?? decodeURIComponent(c.path.split('/').pop())}`);
  assert.deepEqual(labelCalls((await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { reviews: rev(0), checks: green })] })).f), ['POST ready-to-merge']);
  assert.deepEqual(labelCalls((await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { reviews: rev(2), checks: green })] })).f), []);
  assert.deepEqual(labelCalls((await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { reviews: rev(0), checks: [{ status: 'in_progress' }] })] })).f), []);
  assert.deepEqual(labelCalls((await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { labels: ['ready-to-merge'], reviews: rev(1), checks: green })] })).f), ['DELETE ready-to-merge']);
  assert.deepEqual(labelCalls((await go({ 'o/r': [pr(1, '2026-10-01T00:00:00Z', { reviews: rev(0), checks: green })] }, { dry: true })).f), []);
});
