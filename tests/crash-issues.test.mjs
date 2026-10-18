import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, issueTitle, run } from '../scripts/crash-issues.mjs';
import { fakeFetch } from './helpers.mjs';

const group = (id, state = 'OPEN') => ({
  issue: { id, state, errorType: 'FATAL', title: 'Boom', subtitle: 'Foo.bar' },
  metrics: [{ eventsCount: '3', impactedUsersCount: '2' }],
});

test('body has the dedupe marker and stack, and no user identifiers', () => {
  const body = buildBody(group('abc123'), {
    user: { id: 'secret-user' }, installationUuid: 'secret-inst', sessionId: 'secret-session', customKeys: { k: 'secret-key' },
    exceptions: [{ type: 'StateError', frames: [{ symbol: 'a.b', file: 'x.dart', line: '9', blamed: true }] }],
  });
  assert.match(body, /<!-- crashlytics-issue:abc123 -->/);
  assert.match(body, />> a\.b {2}\(x\.dart:9\)/);
  assert.match(body, /Events in window: 3, users impacted: 2/);
  assert.doesNotMatch(body, /secret/);
  assert.equal(issueTitle(group('abc123').issue), '[crash abc123] Boom in Foo.bar');
});

const opts = (fetchImpl, extra = {}) => ({
  token: 't', project: 'p', appId: '1:2:android:3', ghToken: 'g', repo: 'o/r', fetchImpl, now: new Date('2026-10-18T00:00:00Z'), ...extra,
});

test('files only crashes not already filed, skips closed, caps at max', async () => {
  const f = fakeFetch([
    { body: { groups: [group('old1'), group('new1'), group('closed1', 'CLOSED'), group('new2')] } },
    { body: [{ body: '<!-- crashlytics-issue:old1 -->' }] },
    { body: { events: [{ exceptions: [] }] } },
    { status: 201, body: { number: 7 }, match: (_u, init) => assert.deepEqual(JSON.parse(init.body).labels, ['crash']) },
  ]);
  const filed = await run(opts(f, { max: 1 }));
  assert.deepEqual(filed.map((x) => x.number), [7]);
  assert.equal(f.remaining(), 0);
  assert.match(f.calls[0].url, /filter\.issue\.errorTypes=FATAL.*filter\.issue\.errorTypes=ANR/);
  assert.equal(f.calls[0].headers.authorization, 'Bearer t');
});

test('dry run files nothing and a missing sample event still files', async () => {
  const f = fakeFetch([
    { body: { groups: [group('new1')] } },
    { body: [] },
    { status: 404, body: { error: { message: 'nope' } } },
  ]);
  const filed = await run(opts(f, { dry: true }));
  assert.equal(filed.length, 1);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
});
