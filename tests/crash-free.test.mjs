import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, googleError } from './helpers.mjs';
import { checkCrashFree, crashFreeUsers, releaseUnderCheck } from '../scripts/crash-free.mjs';

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
  assert.equal(r.userDays, 400);
  assert.equal(r.days, 2);
  assert.ok(Math.abs(r.percent - 99.75) < 1e-9);
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

test('the release under check is the in-progress or halted one', () => {
  const tracks = [{ track: 'production', releases: [
    { status: 'completed', versionCodes: ['100'] },
    { status: 'halted', versionCodes: ['102', '101'] },
  ] }];
  assert.deepEqual(releaseUnderCheck(tracks, 'production'), ['101', '102']);
  assert.throws(() => releaseUnderCheck(tracks, 'beta'), /No in-progress or halted release on beta/);
});
