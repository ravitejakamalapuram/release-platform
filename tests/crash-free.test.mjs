import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, googleError } from './helpers.mjs';
import { checkCrashFree, crashFreeUsers, firstFullDay, releaseUnderCheck } from '../scripts/crash-free.mjs';

const PKG = 'com.example.app';
const freshness = { body: { freshnessInfo: { freshnesses: [
  { aggregationPeriod: 'HOURLY', latestEndTime: { year: 2026, month: 11, day: 21, hours: 5 } },
  { aggregationPeriod: 'DAILY', latestEndTime: { year: 2026, month: 11, day: 21, timeZone: { id: 'America/Los_Angeles' } } },
] } } };
const row = (code, rate, users, day = 20) => ({
  startTime: { year: 2026, month: 11, day },
  dimensions: [{ dimension: 'versionCode', int64Value: String(code) }],
  metrics: [
    { metric: 'crashRate', decimalValue: { value: String(rate) } },
    { metric: 'distinctUsers', decimalValue: { value: String(users) } },
  ],
});
const rows = (r, nextPageToken) => ({ body: { rows: r, ...(nextPageToken ? { nextPageToken } : {}) } });

test('weights daily crash rates by users, keeps only the asked version codes, follows pages', async () => {
  const f = fakeFetch([
    freshness,
    { ...rows([row(101, 0.01, 100, 19), row(999, 0.5, 1000)], 'p2'), match: (url, init) => {
      assert.match(url, /\/v1beta1\/apps\/com\.example\.app\/crashRateMetricSet:query$/);
      const body = JSON.parse(init.body);
      assert.deepEqual(body.dimensions, ['versionCode']);
      assert.deepEqual(body.metrics, ['crashRate', 'distinctUsers']);
      assert.equal(body.timelineSpec.aggregationPeriod, 'DAILY');
      assert.deepEqual(body.timelineSpec.endTime, { year: 2026, month: 11, day: 21, timeZone: { id: 'America/Los_Angeles' } });
      assert.deepEqual(body.timelineSpec.startTime, { year: 2026, month: 11, day: 14, timeZone: { id: 'America/Los_Angeles' } });
    } },
    { ...rows([row(101, 0, 300, 20)]), match: (_u, init) => assert.equal(JSON.parse(init.body).pageToken, 'p2') },
  ]);
  const r = await crashFreeUsers({ pkg: PKG, token: 't', versionCodes: ['101'], fetchImpl: f });
  // crashed users 0.01*100 + 0*300 = 1 of 400 user-days
  assert.equal(r.byCode.length, 1);
  assert.equal(r.byCode[0].userDays, 400);
  assert.equal(r.byCode[0].days, 2);
  assert.ok(Math.abs(r.byCode[0].percent - 99.75) < 1e-9);
  assert.equal(f.remaining(), 0);
});

const check = (rate, users, opts = {}) => checkCrashFree({
  pkg: PKG, token: 't', versionCodes: ['101'], min: 99.5, minUsers: 100,
  fetchImpl: fakeFetch([freshness, rows(rate === null ? [] : [row(101, rate, users)])]), ...opts,
});

test('99.49% crash-free refuses', async () => {
  await assert.rejects(check(0.0051, 1000), /99\.49% .*needs at least 99\.5%/);
});

test('99.50% crash-free allows', async () => {
  const r = await check(0.005, 1000);
  assert.ok(Math.abs(r.percent - 99.5) < 1e-9);
});

test('no rows for the version code refuses and names it', async () => {
  await assert.rejects(check(null), /No crash data .*101/);
});

test('fewer users than the minimum refuses', async () => {
  await assert.rejects(check(0, 90), /90 user-days .*at least 100/);
});

test('a disabled Reporting API explains the fix', async () => {
  const f = fakeFetch([googleError(403, 'Google Play Developer Reporting API has not been used in project 1 before or it is disabled.')]);
  await assert.rejects(crashFreeUsers({ pkg: PKG, token: 't', versionCodes: ['101'], fetchImpl: f }), /playdeveloperreporting\.googleapis\.com/);
});

test('every version code must pass on its own; a healthy one cannot hide a missing or bad one', async () => {
  const two = (rows) => checkCrashFree({
    pkg: PKG, token: 't', versionCodes: ['101', '102'], min: 99.5, minUsers: 100,
    fetchImpl: fakeFetch([freshness, rows]),
  });
  await assert.rejects(two(rows([row(101, 0, 1000)])), /No crash data .*102/);
  await assert.rejects(two(rows([row(101, 0, 1000), row(102, 0.02, 1000)])), /102 is 98\.00%/);
  await assert.rejects(two(rows([row(101, 0, 1000), row(102, 0, 50)])), /50 user-days .*102/);
  const ok = await two(rows([row(101, 0.001, 1000), row(102, 0.004, 1000)]));
  assert.ok(Math.abs(ok.percent - 99.6) < 1e-9, 'reports the worst code');
});

test('a bad minimum user count is refused before it can pass thin data', async () => {
  for (const bad of [NaN, 0, -5]) await assert.rejects(check(0, 10, { minUsers: bad }), /min-users must be/);
});

test('the release under check is the highest in-progress or halted one, whatever the order', () => {
  const tracks = [{ track: 'production', releases: [
    { status: 'halted', versionCodes: ['101'] },
    { status: 'completed', versionCodes: ['100'] },
    { status: 'inProgress', versionCodes: ['103', '102'] },
  ] }];
  assert.deepEqual(releaseUnderCheck(tracks, 'production'), ['102', '103']);
  assert.throws(() => releaseUnderCheck(tracks, 'beta'), /No in-progress or halted release on beta/);
});

test('firstFullDay is the first Los Angeles day that starts at or after the given moment', () => {
  const d = (y, m, day) => ({ year: y, month: m, day, timeZone: { id: 'America/Los_Angeles' } });
  assert.deepEqual(firstFullDay('2026-11-20T20:00:00Z'), d(2026, 11, 21)); // 12:00 in LA: the rest of that day is partial
  assert.deepEqual(firstFullDay('2026-11-20T08:00:00Z'), d(2026, 11, 20)); // exactly LA midnight
  assert.deepEqual(firstFullDay('2026-11-20T03:00:00Z'), d(2026, 11, 20)); // 19:00 on Nov 19 in LA
  assert.throws(() => firstFullDay('not a date'), /since must be/);
});

test('since moves the query start up to the first full day after it, but never earlier than the window', async () => {
  const startOf = (since) => {
    let start;
    const f = fakeFetch([freshness, { ...rows([row(101, 0, 500)]), match: (_u, init) => { start = JSON.parse(init.body).timelineSpec.startTime; } }]);
    return crashFreeUsers({ pkg: PKG, token: 't', versionCodes: ['101'], since, fetchImpl: f }).then(() => start);
  };
  assert.equal((await startOf('2026-11-19T20:00:00Z')).day, 20); // later than end(21) - 7 = 14
  assert.equal((await startOf('2026-11-01T00:00:00Z')).day, 14); // older than the window: window wins
});

test('a soak that started after the last published day has no data yet and refuses without querying', async () => {
  const f = fakeFetch([freshness]);
  await assert.rejects(
    checkCrashFree({ pkg: PKG, token: 't', versionCodes: ['101'], min: 99.5, minUsers: 100, since: '2026-11-22T20:00:00Z', fetchImpl: f }),
    /No crash data .*101.*since 2026-11-22T20:00:00Z/s,
  );
  assert.equal(f.remaining(), 0);
});

test('a soak whose first full day is the exclusive end has no data yet and does not query', async () => {
  const f = fakeFetch([freshness]);
  await assert.rejects(
    checkCrashFree({ pkg: PKG, token: 't', versionCodes: ['101'], min: 99.5, minUsers: 100, since: '2026-11-21T08:00:00Z', fetchImpl: f }),
    /No crash data .*101.*since 2026-11-21T08:00:00Z/s,
  );
  assert.equal(f.remaining(), 0);
});

test('since needs Z or an explicit offset, so the window never depends on the host time zone', () => {
  for (const bad of ['2026-11-20T08:00:00', '2026-11-20', 'Nov 20 2026 08:00']) {
    assert.throws(() => firstFullDay(bad), /since must be/, bad);
  }
  assert.deepEqual(firstFullDay('2026-11-20T00:00:00-08:00'), firstFullDay('2026-11-20T08:00:00Z'));
  assert.deepEqual(firstFullDay('2026-11-20T08:00:00.000+00:00'), firstFullDay('2026-11-20T08:00:00Z'));
});

test('the reported highest daily crashRate is the highest across every version code, not the worst one', async () => {
  const f = fakeFetch([freshness, rows([row(101, 0.004, 500, 19), row(101, 0.004, 500, 20), row(102, 0, 5000, 19), row(102, 0.1, 100, 20)])]);
  const r = await checkCrashFree({ pkg: PKG, token: 't', versionCodes: ['101', '102'], min: 99.5, minUsers: 100, fetchImpl: f });
  assert.equal(r.code, '101'); // lowest crash-free (99.60% against 99.80%)
  assert.equal(r.maxRate, 0.1); // but code 102 had the highest single-day rate
});
