// Play track read-back (APP-295). Every writer (upload, promote, rollout, halt, complete) is
// followed by verifyTrack, and every case has a MUTATION test: a fake Play that acknowledges the
// PUT and the commit but keeps the old release, or reports a different status or fraction. The
// verifier must report a mismatch each time. A verifier that cannot fail is not a verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeRollout, diffTrack, promote, uploadBundle, verifyTrack } from '../scripts/play.mjs';

/**
 * A stateful fake of the Play edits API for tracks: an edit copies the committed tracks, a PUT
 * replaces one track's releases inside the edit, a commit publishes the edit.
 * - dropWrites: 200 on every PUT and commit, but nothing is kept (the silent failure).
 * - play.onRead = (tracks) => ...: from then on, rewrites what tracks.list / tracks.get return
 *   (Play reports something else than it was told to keep).
 */
function fakePlay(initial, { dropWrites = false } = {}) {
  let onRead;
  let live = structuredClone(initial);
  const edits = new Map();
  let n = 0;
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body ?? {}) });
  const read = (tracks) => {
    const copy = structuredClone(tracks);
    onRead?.(copy);
    return copy;
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const path = new URL(url).pathname.replace(/^.*\/applications\/[^/]+/, '');
    let m;
    if (method === 'POST' && path === '/edits') {
      const id = `e${++n}`;
      edits.set(id, structuredClone(live));
      return res(200, { id });
    }
    if ((m = path.match(/^\/edits\/([^/:]+):commit$/))) {
      if (!dropWrites) live = edits.get(m[1]);
      edits.delete(m[1]);
      return res(200, { id: m[1] });
    }
    if ((m = path.match(/^\/edits\/([^/]+)$/)) && method === 'DELETE') {
      edits.delete(m[1]);
      return res(204);
    }
    if ((m = path.match(/^\/edits\/([^/]+)\/bundles$/))) return res(200, { versionCode: 1002003 });
    if ((m = path.match(/^\/edits\/([^/]+)\/tracks$/))) return res(200, { tracks: read(edits.get(m[1])) });
    if ((m = path.match(/^\/edits\/([^/]+)\/tracks\/([^/]+)$/))) {
      const tracks = edits.get(m[1]);
      const name = decodeURIComponent(m[2]);
      if (method === 'GET') return res(200, read(tracks).find((t) => t.track === name) ?? { track: name, releases: [] });
      const body = JSON.parse(init.body);
      if (!dropWrites) {
        const i = tracks.findIndex((t) => t.track === name);
        if (i >= 0) tracks[i] = body;
        else tracks.push(body);
      }
      return res(200, body);
    }
    return res(404, { error: { message: `unexpected ${method} ${path}` } });
  };
  return { fetchImpl, calls, get live() { return live; }, set onRead(fn) { onRead = fn; } };
}

const OLD = { name: '1.2.2', versionCodes: ['1002002'], status: 'completed' };
const NEW = { name: '1.2.3', versionCodes: ['1002003'], status: 'completed' };
const STAGED = { name: '1.2.3', versionCodes: ['1002003'], status: 'inProgress', userFraction: 0.2 };

const base = () => [
  { track: 'internal', releases: [NEW] },
  { track: 'production', releases: [OLD] },
];
const staged = () => [
  { track: 'internal', releases: [NEW] },
  { track: 'production', releases: [OLD, STAGED] },
];

// Each flow: the starting store, the writer, and the intended end state the workflow passes to
// verify-track. The intended state is built from inputs here, not from the writer's response.
const FLOWS = {
  upload: {
    start: () => [{ track: 'internal', releases: [OLD] }],
    write: (o) => uploadBundle({ ...o, aab: Buffer.from('aab'), track: 'internal', versionName: '1.2.3', versionCode: '1002003' }),
    intended: { track: 'internal', versionCodes: ['1002003'], status: 'completed' },
  },
  'promote (staged 20%)': {
    start: base,
    write: (o) => promote({ ...o, from: 'internal', to: 'production', fraction: 0.2 }),
    intended: { track: 'production', versionCodes: ['1002003'], status: 'inProgress', userFraction: 0.2 },
  },
  'promote (100%)': {
    start: base,
    write: (o) => promote({ ...o, from: 'internal', to: 'production' }),
    intended: { track: 'production', versionCodes: ['1002003'], status: 'completed' },
  },
  'rollout 20% -> 50%': {
    start: staged,
    write: (o) => changeRollout({ ...o, track: 'production', action: 'rollout', fraction: 0.5 }),
    intended: { track: 'production', versionCodes: ['1002003'], status: 'inProgress', userFraction: 0.5 },
  },
  halt: {
    start: staged,
    write: (o) => changeRollout({ ...o, track: 'production', action: 'halt' }),
    intended: { track: 'production', versionCodes: ['1002003'], status: 'halted', userFraction: 0.2 },
  },
  complete: {
    start: staged,
    write: (o) => changeRollout({ ...o, track: 'production', action: 'complete' }),
    intended: { track: 'production', versionCodes: ['1002003'], status: 'completed' },
  },
};

async function run(flow, { onRead, ...fakeOpts } = {}) {
  const play = fakePlay(flow.start(), fakeOpts);
  await flow.write({ pkg: 'com.x', token: 't', fetchImpl: play.fetchImpl });
  play.onRead = onRead;
  const before = play.calls.length;
  const r = await verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: play.fetchImpl, wait: noWait, ...flow.intended });
  return { ...r, verifyCalls: play.calls.slice(before) };
}

const noWait = async () => {};

for (const [name, flow] of Object.entries(FLOWS)) {
  test(`verifyTrack after ${name}: Play holds the intended release -> VERIFIED, read-back never commits`, async () => {
    const r = await run(flow);
    assert.deepEqual({ ok: r.ok, mismatches: r.mismatches }, { ok: true, mismatches: [] });
    assert.equal(r.reads, 1, 'a match needs no second read');
    assert.equal(r.verifyCalls.filter((c) => c.includes(':commit')).length, 0, 'the read-back must not commit');
    assert.ok(r.verifyCalls.some((c) => c.startsWith('DELETE ') && /\/edits\/e\d+$/.test(c)), 'the read-only edit is deleted');
    assert.ok(!r.verifyCalls.some((c) => c.startsWith('PUT ')), 'the read-back must not write');
  });

  // ---- Mutation tests: each must produce a mismatch.
  test(`MUTATION ${name}: Play acks the PUT and commit but keeps the old release -> MISMATCH`, async () => {
    const r = await run(flow, { dropWrites: true });
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.length > 0);
    assert.equal(r.reads, 3, 'a persistent mismatch is read 3 times, then fails');
    assert.equal(r.verifyCalls.filter((c) => c.startsWith('POST ') && c.endsWith('/edits')).length, 3);
    assert.equal(r.verifyCalls.filter((c) => c.startsWith('DELETE ')).length, 3, 'every read-only edit is deleted');
    assert.equal(r.verifyCalls.filter((c) => c.includes(':commit') || c.startsWith('PUT ')).length, 0, 'retries never write');
  });

  test(`${name}: Play is stale on the first read only -> VERIFIED on the second read`, async () => {
    let reads = 0;
    const r = await run(flow, { onRead: (ts) => { if (reads++ === 0) ts.forEach((t) => t.releases?.forEach((rel) => rel.versionCodes.includes('1002003') && (rel.versionCodes = ['1002002']))); } });
    assert.deepEqual({ ok: r.ok, reads: r.reads }, { ok: true, reads: 2 });
  });

  test(`MUTATION ${name}: Play reports a different status -> MISMATCH`, async () => {
    const other = flow.intended.status === 'completed' ? 'halted' : 'completed';
    const r = await run(flow, { onRead: (ts) => ts.forEach((t) => t.releases?.forEach((rel) => rel.versionCodes.includes('1002003') && (rel.status = other))) });
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some((m) => m.includes(`status is ${other}`)), r.mismatches.join('\n'));
  });

  test(`MUTATION ${name}: Play reports a different user fraction -> MISMATCH`, async () => {
    const r = await run(flow, { onRead: (ts) => ts.forEach((t) => t.releases?.forEach((rel) => rel.versionCodes.includes('1002003') && (rel.userFraction = 0.05))) });
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some((m) => m.includes('user fraction is 0.05')), r.mismatches.join('\n'));
  });
}

test('MUTATION: the release landed on the wrong track -> MISMATCH', async () => {
  const play = fakePlay([{ track: 'internal', releases: [NEW] }, { track: 'production', releases: [OLD] }]);
  const r = await verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: play.fetchImpl, wait: noWait, track: 'production', versionCodes: ['1002003'], status: 'completed' });
  assert.equal(r.ok, false);
  assert.match(r.mismatches[0], /production: no release with versionCodes \[1002003\] \(Play has production: 1\.2\.2 completed\)/);
});

test('diffTrack: a missing track, extra or missing version codes are mismatches', () => {
  assert.match(diffTrack({ track: 'beta', versionCodes: ['1'], status: 'completed' }, [])[0], /track not found/);
  const tracks = [{ track: 'production', releases: [{ versionCodes: ['1', '2'], status: 'completed' }] }];
  assert.equal(diffTrack({ track: 'production', versionCodes: ['1'], status: 'completed' }, tracks).length, 1);
  assert.equal(diffTrack({ track: 'production', versionCodes: ['2', '1'], status: 'completed' }, tracks).length, 0, 'order of version codes does not matter');
  assert.equal(diffTrack({ track: 'production', versionCodes: ['1', '2', '3'], status: 'completed' }, tracks).length, 1);
});

test('diffTrack: a staged release with no fraction on Play, or a completed one with a fraction, is a mismatch', () => {
  const staged = [{ track: 'production', releases: [{ versionCodes: ['1'], status: 'inProgress' }] }];
  assert.match(diffTrack({ track: 'production', versionCodes: ['1'], status: 'inProgress', userFraction: 0.2 }, staged)[0], /user fraction is unset/);
  const done = [{ track: 'production', releases: [{ versionCodes: ['1'], status: 'completed', userFraction: 0.2 }] }];
  assert.match(diffTrack({ track: 'production', versionCodes: ['1'], status: 'completed' }, done)[0], /expected none/);
});

test('verifyTrack refuses an intended state it cannot check (staged with no fraction)', async () => {
  await assert.rejects(verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: fakePlay([]).fetchImpl, track: 'production', versionCodes: ['1'], status: 'inProgress' }), /needs a user fraction/);
  await assert.rejects(verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: fakePlay([]).fetchImpl, track: 'production', versionCodes: [], status: 'completed' }), /needs track, versionCodes and status/);
});

test('verifyTrack waits about 10 s between reads, and only after a mismatch', async () => {
  const waits = [];
  const play = fakePlay([{ track: 'production', releases: [OLD] }]);
  const r = await verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: play.fetchImpl, wait: async (ms) => waits.push(ms), track: 'production', versionCodes: ['1002003'], status: 'completed' });
  assert.equal(r.ok, false);
  assert.deepEqual(waits, [10_000, 10_000]);
  const ok = fakePlay([{ track: 'production', releases: [NEW] }]);
  const waits2 = [];
  await verifyTrack({ pkg: 'com.x', token: 't', fetchImpl: ok.fetchImpl, wait: async (ms) => waits2.push(ms), track: 'production', versionCodes: ['1002003'], status: 'completed' });
  assert.deepEqual(waits2, [], 'no wait when the first read matches');
});
