// Store-listing verification (APP-290). Every verifier here has a MUTATION test: break the
// intended end state on the fake store and the verifier must report a mismatch. A verifier that
// cannot fail is not a verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diffListing, syncListing, verifyListing } from '../scripts/play.mjs';
import { planVerifyIssue, syncVerifyIssue } from '../scripts/listing.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const FILES = { 'en-US/phoneScreenshots/01.png': 'shot-1', 'en-US/phoneScreenshots/02.png': 'shot-2', 'en-US/featureGraphic/01.png': 'feature' };
const img = (file) => ({ file, sha256: sha(FILES[file]), contentType: 'image/png' });

const bundle = () => ({
  type: 'android',
  package: 'com.x',
  fingerprint: 'fp1',
  locales: [
    {
      language: 'en-US',
      title: 'Inv Track',
      shortDescription: 'Track investments',
      fullDescription: 'Long text',
      images: {
        phoneScreenshots: [img('en-US/phoneScreenshots/01.png'), img('en-US/phoneScreenshots/02.png')],
        featureGraphic: [img('en-US/featureGraphic/01.png')],
      },
    },
  ],
});

/**
 * A stateful fake of the Play edits API: edits copy the committed state, commit publishes it.
 * `dropWrites` makes it answer 200 to every PUT/upload while keeping nothing - the silent
 * failure the read-back exists to catch.
 */
function fakePlay(initial = {}, { dropWrites = false } = {}) {
  let live = structuredClone(initial);
  const edits = new Map();
  let n = 0;
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body ?? {}) });
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
    const [, id, lang, type] = path.match(/^\/edits\/([^/]+)\/listings\/([^/]+)(?:\/([^/]+))?$/) ?? [];
    const ed = edits.get(id);
    if (!ed) return res(404, { error: { message: 'no such edit' } });
    ed[lang] ??= { listing: null, images: {} };
    const loc = ed[lang];
    if (!type) {
      if (method === 'GET') return loc.listing ? res(200, loc.listing) : res(404, { error: { message: 'not found' } });
      if (!dropWrites) loc.listing = JSON.parse(init.body);
      return res(200, JSON.parse(init.body));
    }
    if (method === 'GET') return res(200, { images: loc.images[type] ?? [] });
    if (method === 'DELETE') {
      if (!dropWrites) loc.images[type] = [];
      return res(200, {});
    }
    if (!dropWrites) (loc.images[type] ??= []).push({ id: String(loc.images[type].length), sha256: sha(init.body) });
    return res(200, {});
  };
  return { fetchImpl, calls, get live() { return live; } };
}

const matching = () => ({
  'en-US': {
    listing: { language: 'en-US', title: 'Inv Track', shortDescription: 'Track investments', fullDescription: 'Long text' },
    images: {
      phoneScreenshots: [{ sha256: sha('shot-1') }, { sha256: sha('shot-2') }],
      featureGraphic: [{ sha256: sha('feature') }],
    },
  },
});

const verify = (state) => verifyListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: fakePlay(state).fetchImpl });

test('verifyListing: a store that matches the repo is VERIFIED, and the read-back never commits', async () => {
  const play = fakePlay(matching());
  const r = await verifyListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: play.fetchImpl });
  assert.deepEqual(r, { ok: true, mismatches: [] });
  assert.equal(play.calls.filter((c) => c.includes(':commit')).length, 0);
  assert.ok(play.calls.some((c) => c.startsWith('DELETE') && /edits\/e1$/.test(c)), 'the read-only edit is deleted');
});

// ---- Mutation tests: each breaks one aspect of the intended state; each must be caught.
const MUTATIONS = {
  'screenshots reordered (hand edit in the console)': (s) => s['en-US'].images.phoneScreenshots.reverse(),
  'one screenshot replaced': (s) => (s['en-US'].images.phoneScreenshots[1] = { sha256: sha('red-loss') }),
  'one screenshot dropped': (s) => s['en-US'].images.phoneScreenshots.pop(),
  'feature graphic missing': (s) => (s['en-US'].images.featureGraphic = []),
  'full description edited': (s) => (s['en-US'].listing.fullDescription += ' (edited by hand)'),
  'title edited': (s) => (s['en-US'].listing.title = 'InvTrack'),
  'locale missing on Play': (s) => delete s['en-US'],
};
for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`verifyListing MUTATION: ${name} -> MISMATCH`, async () => {
    const state = matching();
    mutate(state);
    const r = await verify(state);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.length >= 1, 'at least one difference is reported');
  });
}

test('diffListing names what differs: order vs content, and both lengths for text', () => {
  const s = matching();
  s['en-US'].images.phoneScreenshots.reverse();
  s['en-US'].listing.fullDescription = 'Long text!';
  const d = diffListing(bundle(), s);
  assert.ok(d.some((l) => l === 'en-US: phoneScreenshots order differs at position 1, 2'), d.join('\n'));
  assert.ok(d.some((l) => /fullDescription differs \(repo 9 chars .* Play 10 chars/.test(l)), d.join('\n'));
});

test('diffListing ignores image types and the video field the bundle does not manage', () => {
  const s = matching();
  s['en-US'].images.tenInchScreenshots = [{ sha256: 'other' }];
  s['en-US'].listing.video = 'https://youtu.be/x';
  assert.deepEqual(diffListing(bundle(), s), []);
});

test('read-back catches a sync that Play acknowledged but did not keep (silent write loss)', async () => {
  const play = fakePlay({}, { dropWrites: true });
  const sync = await syncListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: play.fetchImpl, readFile: (f) => Buffer.from(FILES[f]) });
  assert.ok(sync.changes.length > 0 && sync.commit, 'the sync itself believes it succeeded');
  const r = await verifyListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: play.fetchImpl });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ['en-US: listing missing on Play', 'en-US: phoneScreenshots count differs (repo 2, Play 0)', 'en-US: featureGraphic count differs (repo 1, Play 0)']);
});

test('sync then read-back against an honest store: VERIFIED end to end', async () => {
  const play = fakePlay({});
  await syncListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: play.fetchImpl, readFile: (f) => Buffer.from(FILES[f]) });
  assert.deepEqual(await verifyListing({ pkg: 'com.x', token: 't', bundle: bundle(), fetchImpl: play.fetchImpl }), { ok: true, mismatches: [] });
});

// ---- The listing-verify issue: one open issue per package, never silent.
const issue = (number, pkg, state = 'OPEN') => ({ number, state, body: `<!-- listing-verify: ${pkg} -->\nbody` });

test('planVerifyIssue: mismatch opens one issue, then comments on it instead of duplicating', () => {
  assert.equal(planVerifyIssue({ pkg: 'com.x', outcome: 'mismatch', issues: [] }).action, 'create');
  assert.deepEqual(planVerifyIssue({ pkg: 'com.x', outcome: 'mismatch', issues: [issue(4, 'com.y'), issue(7, 'com.x')] }), { action: 'comment', issue: 7, marker: '<!-- listing-verify: com.x -->' });
});

test('planVerifyIssue: a verifier that produced no result is loud, not a pass', () => {
  assert.equal(planVerifyIssue({ pkg: 'com.x', outcome: 'broken', issues: [] }).action, 'create');
});

test('planVerifyIssue: verified closes the open issue, and does nothing when none is open', () => {
  assert.deepEqual(planVerifyIssue({ pkg: 'com.x', outcome: 'verified', issues: [issue(7, 'com.x')] }), { action: 'close', issue: 7 });
  assert.deepEqual(planVerifyIssue({ pkg: 'com.x', outcome: 'verified', issues: [] }), { action: 'none' });
  assert.throws(() => planVerifyIssue({ pkg: 'com.x', outcome: 'ok', issues: [] }), /Unknown verify outcome/);
});

test('syncVerifyIssue: creates a labelled issue carrying the marker and every difference', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args[1] === 'list' ? '[]' : args[1] === 'create' ? 'https://github.com/o/a/issues/9\n' : '';
  };
  const r = syncVerifyIssue({ pkg: 'com.x', outcome: 'mismatch', mismatches: ['en-US: title differs'], repo: 'o/a', runUrl: 'RUN', gh });
  assert.equal(r.result, 'LISTING_VERIFY_ISSUE_OPENED: https://github.com/o/a/issues/9');
  const create = calls.find((c) => c[0] === 'issue' && c[1] === 'create');
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /^<!-- listing-verify: com\.x -->/);
  assert.match(body, /- en-US: title differs/);
  assert.equal(create[create.indexOf('--label') + 1], 'listing-verify');
});
