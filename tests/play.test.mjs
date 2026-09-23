import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, changeRollout, latestRelease, listTracks, parseFraction, promote, uploadBundle, urls } from '../scripts/play.mjs';
import { fakeFetch, googleError } from './helpers.mjs';

const PKG = 'com.carfry369.teleport';
const base = { pkg: PKG, token: 'tok' };
const REVIEW_ERR = googleError(400, 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.');
const body = (call) => JSON.parse(call.body);

test('urls follow the v3 edits layout', () => {
  assert.equal(urls.insert(PKG), `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/edits`);
  assert.equal(urls.bundles(PKG, 'e1'), `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}/edits/e1/bundles?uploadType=media`);
  assert.equal(urls.track(PKG, 'e1', 'internal'), `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/edits/e1/tracks/internal`);
  assert.equal(urls.commit(PKG, 'e1', true), `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/edits/e1:commit?changesNotSentForReview=true`);
});

test('uploadBundle: insert -> version check -> upload -> track update -> commit', async () => {
  const f = fakeFetch([
    { body: { id: 'e1' } },
    { body: { tracks: [{ track: 'production', releases: [{ versionCodes: ['147'] }] }] } },
    { body: { versionCode: 1002003, sha256: 'x' } },
    { body: {} },
    { body: { id: 'e1' } },
  ]);
  const { result, commit } = await uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('aab'), track: 'internal', versionName: '1.2.3', versionCode: '1002003', notes: 'Fixes' });
  assert.deepEqual(result, { versionCode: 1002003, track: 'internal', status: 'completed' });
  assert.equal(commit.sentForReview, true);
  const [insert, tracks, up, track, cm] = f.calls;
  assert.equal(tracks.url, urls.tracks(PKG, 'e1'));
  assert.equal(insert.method, 'POST');
  assert.equal(up.headers['Content-Type'], 'application/octet-stream');
  assert.equal(track.method, 'PUT');
  assert.deepEqual(body(track), {
    track: 'internal',
    releases: [{ name: '1.2.3', versionCodes: ['1002003'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Fixes' }] }],
  });
  assert.equal(cm.url, urls.commit(PKG, 'e1', false));
});

test('commit falls back to changesNotSentForReview=true', async () => {
  const f = fakeFetch([{ body: { id: 'e1' } }, { body: { versionCode: 5 } }, { body: {} }, REVIEW_ERR, { body: { id: 'e1' } }]);
  const { commit } = await uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('a'), track: 'internal', versionName: '0.0.5' });
  assert.equal(commit.sentForReview, false);
  assert.equal(f.calls[4].url, urls.commit(PKG, 'e1', true));
});

test('other commit errors fail and discard the edit', async () => {
  const f = fakeFetch([{ body: { id: 'e1' } }, { body: { versionCode: 5 } }, { body: {} }, googleError(400, 'Something else'), { body: {} }]);
  await assert.rejects(uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('a'), track: 'internal', versionName: '0.0.5' }), /Something else/);
  assert.equal(f.calls[4].method, 'DELETE');
});

test('versionCode not above the store aborts before uploading', async () => {
  const tracks = { tracks: [{ track: 'alpha', releases: [{ versionCodes: ['1006017'] }] }, { track: 'production', releases: [{ versionCodes: ['147'] }] }] };
  const f = fakeFetch([{ body: { id: 'e1' } }, { body: tracks }, { body: {} }]);
  await assert.rejects(
    uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('a'), track: 'internal', versionName: '1.6.10', versionCode: '1006010' }),
    /versionCode 1006010 is not higher than 1006017 already on the "alpha" track/,
  );
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].method, 'DELETE');
});

test('versionCode mismatch aborts and deletes the edit', async () => {
  const f = fakeFetch([{ body: { id: 'e1' } }, { body: {} }, { body: { versionCode: 6 } }, { body: {} }]);
  await assert.rejects(
    uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('a'), track: 'internal', versionName: '1.0.0', versionCode: '1000000' }),
    /versionCode 6, expected 1000000.*Gradle snippet/,
  );
  assert.equal(f.calls[3].method, 'DELETE');
});

test('Play errors are explained', async () => {
  const cases = [
    [googleError(403, 'The caller does not have permission'), /Invite release-bot@rk-release-platform/],
    [googleError(403, 'APK specifies a version code that has already been used.'), /Not authorized/],
    [googleError(400, 'APK specifies a version code that has already been used.'), /already has this versionCode/],
    [googleError(400, 'Only releases with status draft may be created on draft app.'), /release_status: draft/],
  ];
  for (const [err, re] of cases) {
    const f = fakeFetch([{ body: { id: 'e1' } }, err, { body: {} }]);
    await assert.rejects(uploadBundle({ ...base, fetchImpl: f, aab: Buffer.from('a'), track: 'internal', versionName: '1' }), re);
  }
});

test('promote copies the newest internal release to production as a staged rollout', async () => {
  const internal = {
    track: 'internal',
    releases: [
      { name: '1.2.0', versionCodes: ['1002000'], status: 'completed' },
      { name: '1.3.0', versionCodes: ['1003000'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'n' }] },
      { name: '1.4.0', versionCodes: ['1004000'], status: 'draft' },
    ],
  };
  const f = fakeFetch([{ body: { id: 'e2' } }, { body: internal }, { body: {} }, { body: {} }]);
  const { result } = await promote({ ...base, fetchImpl: f, from: 'internal', to: 'production', fraction: 0.2 });
  assert.deepEqual(result, { name: '1.3.0', versionCodes: ['1003000'], track: 'production', status: 'inProgress', userFraction: 0.2 });
  assert.deepEqual(body(f.calls[2]).releases, [
    { name: '1.3.0', versionCodes: ['1003000'], status: 'inProgress', userFraction: 0.2, releaseNotes: [{ language: 'en-US', text: 'n' }] },
  ]);
});

test('promote with no fraction (or 1) is a full rollout; empty source fails', async () => {
  const f = fakeFetch([{ body: { id: 'e' } }, { body: { releases: [{ name: 'a', versionCodes: ['1'], status: 'completed' }] } }, { body: {} }, { body: {} }]);
  const { result } = await promote({ ...base, fetchImpl: f, from: 'internal', to: 'production', fraction: 1 });
  assert.equal(result.status, 'completed');
  assert.equal(result.userFraction, undefined);

  const empty = fakeFetch([{ body: { id: 'e' } }, { body: { track: 'internal' } }, { body: {} }]);
  await assert.rejects(promote({ ...base, fetchImpl: empty, from: 'internal', to: 'production' }), /no completed or in-progress release/);
  await assert.rejects(promote({ ...base, fetchImpl: fakeFetch([]), from: 'x', to: 'x' }), /must differ/);
});

const production = {
  track: 'production',
  releases: [
    { name: '1.2.0', versionCodes: ['1002000'], status: 'completed' },
    { name: '1.3.0', versionCodes: ['1003000'], status: 'inProgress', userFraction: 0.2 },
  ],
};

test('halt / rollout / complete change only the in-progress release', async () => {
  const run = async (action, fraction) => {
    const f = fakeFetch([{ body: { id: 'e' } }, { body: production }, { body: {} }, { body: {} }]);
    await changeRollout({ ...base, fetchImpl: f, track: 'production', action, fraction });
    return body(f.calls[2]).releases;
  };
  const halted = await run('halt');
  assert.deepEqual(halted[0], production.releases[0]);
  assert.deepEqual(halted[1], { name: '1.3.0', versionCodes: ['1003000'], status: 'halted', userFraction: 0.2 });
  assert.equal((await run('rollout', 0.5))[1].userFraction, 0.5);
  assert.deepEqual((await run('complete'))[1], { name: '1.3.0', versionCodes: ['1003000'], status: 'completed' });
  assert.equal((await run('rollout', 1))[1].status, 'completed');
  await assert.rejects(run('rollout', 0.1), /must be higher than the current 0.2/);
});

test('changeRollout fails clearly when nothing is rolling out', async () => {
  const f = fakeFetch([{ body: { id: 'e' } }, { body: { releases: [{ name: 'x', versionCodes: ['1'], status: 'completed' }] } }, { body: {} }]);
  await assert.rejects(changeRollout({ ...base, fetchImpl: f, track: 'production', action: 'halt' }), /no inProgress release to halt/);
});

test('listTracks is read-only: it deletes the edit instead of committing', async () => {
  const f = fakeFetch([{ body: { id: 'e3' } }, { body: { tracks: [{ track: 'internal', releases: [] }] } }, { body: {} }]);
  assert.deepEqual(await listTracks({ ...base, fetchImpl: f }), [{ track: 'internal', releases: [] }]);
  assert.equal(f.calls[2].method, 'DELETE');
  assert.ok(!f.calls.some((c) => c.url.includes(':commit')));
});

test('helpers', () => {
  assert.equal(parseFraction(''), undefined);
  assert.equal(parseFraction('0.25'), 0.25);
  assert.throws(() => parseFraction('0'), /\(0, 1\]/);
  assert.throws(() => parseFraction('1.5'), /\(0, 1\]/);
  assert.throws(() => buildRelease({ name: 'a', versionCodes: [1], status: 'inProgress' }), /between 0 and 1/);
  assert.equal(latestRelease(production, ['completed']).name, '1.2.0');
  assert.equal(latestRelease({}, null), null);
});
