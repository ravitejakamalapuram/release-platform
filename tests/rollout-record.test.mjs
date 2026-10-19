import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, recordRollout, skipReason, ENVIRONMENT } from '../scripts/rollout-record.mjs';
import { fakeFetch } from './helpers.mjs';

const payload = buildPayload({ pkg: 'com.x', track: 'production', versionCodes: [121], status: 'inProgress', userFraction: 0.05, startedAt: '2026-10-01T10:00:00Z' });

test('only a staged production rollout is recorded', () => {
  assert.equal(skipReason({ track: 'production', status: 'inProgress' }), null);
  assert.equal(skipReason({ track: 'Production', status: 'inProgress' }), null);
  assert.match(skipReason({ track: 'internal', status: 'inProgress' }), /not production/);
  assert.match(skipReason({ track: 'production', status: 'completed' }), /not a staged rollout/);
  assert.match(skipReason({ track: 'production', status: 'halted' }), /not a staged rollout/);
});

test('the payload keeps string version codes and an ISO start time', () => {
  assert.deepEqual(payload, { package: 'com.x', track: 'production', versionCodes: ['121'], status: 'inProgress', userFraction: 0.05, startedAt: '2026-10-01T10:00:00.000Z' });
});

test('the payload rejects missing fields and a bad time', () => {
  assert.throws(() => buildPayload({ pkg: 'com.x', track: 'production', versionCodes: [], status: 'inProgress', startedAt: '2026-10-01T10:00:00Z' }), /needs package/);
  assert.throws(() => buildPayload({ pkg: 'com.x', track: 'production', versionCodes: [1], status: 'inProgress', startedAt: 'soon' }), /ISO 8601/);
});

test('writes a deployment in play-production, then marks it successful', async () => {
  const fetchImpl = fakeFetch([
    { body: { id: 77 }, match: (url, init) => {
      assert.equal(url, 'https://api.github.com/repos/o/r/deployments');
      const sent = JSON.parse(init.body);
      assert.equal(sent.environment, ENVIRONMENT);
      assert.equal(sent.ref, 'abc');
      assert.deepEqual(sent.payload, payload);
      assert.deepEqual(sent.required_contexts, []);
    } },
    { body: {}, match: (url, init) => {
      assert.equal(url, 'https://api.github.com/repos/o/r/deployments/77/statuses');
      assert.equal(JSON.parse(init.body).state, 'success');
    } },
  ]);
  assert.equal(await recordRollout({ repo: 'o/r', token: 't', sha: 'abc', payload, fetchImpl }), 77);
  assert.equal(fetchImpl.remaining(), 0);
});

test('fails when GitHub rejects the deployment, so no half record is reported as written', async () => {
  const fetchImpl = fakeFetch([{ status: 403, body: { message: 'Resource not accessible by integration' } }]);
  await assert.rejects(recordRollout({ repo: 'o/r', token: 't', sha: 'abc', payload, fetchImpl }), /403/);
});
