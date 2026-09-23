import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus, preflight, publish, release, upload, urls } from '../scripts/cws.mjs';
import { fakeFetch, googleError } from './helpers.mjs';

const P = '9637cb78-fa33-49dd-a4cb-91066ff182e3';
const I = 'jndhbmaokpclbpjoogffaimahadpidcf';
const base = { publisher: P, item: I, token: 'tok', sleep: async () => {}, pollMs: 0 };
const published = (v, state = 'PUBLISHED') => ({ state, distributionChannels: [{ deployPercentage: 100, crxVersion: v }] });

test('urls follow the v2 resource layout', () => {
  assert.equal(urls.upload(P, I), `https://chromewebstore.googleapis.com/upload/v2/publishers/${P}/items/${I}:upload`);
  assert.equal(urls.publish(P, I), `https://chromewebstore.googleapis.com/v2/publishers/${P}/items/${I}:publish`);
  assert.equal(urls.status(P, I), `https://chromewebstore.googleapis.com/v2/publishers/${P}/items/${I}:fetchStatus`);
});

test('release: preflight, upload, publish, status — happy path', async () => {
  const f = fakeFetch([
    { body: { itemId: I, publishedItemRevisionStatus: published('1.2.3') } },
    { body: { itemId: I, crxVersion: '1.3.0', uploadState: 'SUCCEEDED' } },
    { body: { itemId: I, state: 'PENDING_REVIEW' } },
    { body: { itemId: I, publishedItemRevisionStatus: published('1.2.3'), submittedItemRevisionStatus: published('1.3.0', 'PENDING_REVIEW') } },
  ]);
  const res = await release({ ...base, zip: Buffer.from('zip'), version: '1.3.0', fetchImpl: f });
  assert.equal(res.published.state, 'PENDING_REVIEW');
  const [status, up, pub] = f.calls;
  assert.equal(status.method, 'GET');
  assert.equal(up.method, 'POST');
  assert.equal(up.url, urls.upload(P, I));
  assert.equal(up.headers.Authorization, 'Bearer tok');
  assert.equal(up.headers['Content-Type'], 'application/zip');
  assert.equal(pub.url, urls.publish(P, I));
  assert.deepEqual(JSON.parse(pub.body), { publishType: 'DEFAULT_PUBLISH' });
  assert.deepEqual(describeStatus(res.status), {
    published: 'PUBLISHED (1.2.3 @ 100%)', submitted: 'PENDING_REVIEW (1.3.0 @ 100%)', lastUpload: '-', flags: '',
  });
});

test('release with submit=false uploads a draft only', async () => {
  const f = fakeFetch([{ body: {} }, { body: { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' } }, { body: {} }]);
  const res = await release({ ...base, zip: Buffer.from('z'), version: '0.1.0', submit: false, fetchImpl: f });
  assert.equal(res.published, null);
  assert.equal(f.calls.length, 3);
});

test('preflight blocks an item already in review', () => {
  assert.throws(() => preflight({ submittedItemRevisionStatus: published('1.3.0', 'PENDING_REVIEW') }, '1.4.0', I), /already has a submission in review/);
});

test('preflight blocks a version that is not higher than the store', () => {
  assert.throws(() => preflight({ publishedItemRevisionStatus: published('1.5.0') }, '1.4.9', I), /not higher than 1.5.0/);
  assert.throws(() => preflight({ publishedItemRevisionStatus: published('1.5.0') }, '1.5.0', I), /not higher/);
  assert.throws(() => preflight({ submittedItemRevisionStatus: published('1.6.0', 'REJECTED') }, '1.6.0', I), /not higher/);
  preflight({ publishedItemRevisionStatus: published('1.5.0.1') }, '1.5.1', I);
  preflight({}, '0.0.1', I);
});

test('upload polls fetchStatus while in progress', async () => {
  const f = fakeFetch([
    { body: { uploadState: 'IN_PROGRESS' } },
    { body: { lastAsyncUploadState: 'IN_PROGRESS' } },
    { body: { lastAsyncUploadState: 'SUCCEEDED', submittedItemRevisionStatus: published('2.0.0', 'DRAFT') } },
  ]);
  const res = await upload({ ...base, zip: Buffer.from('z'), fetchImpl: f });
  assert.equal(res.uploadState, 'SUCCEEDED');
  assert.equal(f.calls.length, 3);
});

test('upload fails loudly on any non-success state', async () => {
  for (const state of ['FAILED', 'NOT_FOUND', undefined]) {
    const f = fakeFetch([{ body: { uploadState: state } }]);
    await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: f }), /did not succeed: upload state/);
  }
  const stuck = fakeFetch([{ body: { uploadState: 'IN_PROGRESS' } }, { body: { lastAsyncUploadState: 'IN_PROGRESS' } }]);
  await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: stuck, maxPolls: 1 }), /polling timed out/);
});

test('upload errors are translated into actionable messages', async () => {
  const inReview = fakeFetch([googleError(400, 'The item is not updatable while it is pending review.')]);
  await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: inReview }), /still in review/);
  const version = fakeFetch([googleError(400, 'Invalid version: must be greater than the published version 1.2.3')]);
  await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: version }), /must be higher than any version/);
  const denied = fakeFetch([googleError(403, 'The caller does not have permission')]);
  await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: denied }), /Not authorized .*release-bot/);
  const other = fakeFetch([{ status: 500, body: '<html>oops</html>' }]);
  await assert.rejects(upload({ ...base, zip: Buffer.from('z'), fetchImpl: other }), /failed \(500\): <html>oops/);
});

test('publish rejects unexpected states', async () => {
  const f = fakeFetch([{ body: { state: 'REJECTED' } }]);
  await assert.rejects(publish({ ...base, fetchImpl: f }), /did not accept the submission.*REJECTED/);
});
