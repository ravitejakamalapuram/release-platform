// Post-review public-page verification (APP-296). The fixtures in tests/fixtures/public-pages are
// trimmed copies of the real Play / Chrome Web Store markup (captured 2026-10-01) with test text.
// MUTATION tests: an edited description, one screenshot fewer and unparseable markup must each
// fail - a verifier that cannot fail is not a verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkChromePublic,
  checkPlayPublic,
  chromeVerdict,
  normaliseText,
  parseChromePage,
  parsePlayPage,
  planChromeVerify,
  planCommitted,
  publicVerdict,
} from '../scripts/public-listing.mjs';
import { chromeVerify, playPublicReport } from '../scripts/listing.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/public-pages/${name}.html`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-20T03:17:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

const bundle = () => ({
  type: 'android',
  package: 'com.x',
  fingerprint: 'fp1',
  locales: [
    {
      language: 'en-US',
      title: 'Inv Track',
      shortDescription: 'Track investments',
      fullDescription: 'Track money in & out.\n\n• Record investments\n• See your "real" returns',
      images: { phoneScreenshots: [{ sha256: 'a' }, { sha256: 'b' }], featureGraphic: [{ sha256: 'f' }] },
    },
  ],
});
const manifest = () => ({
  type: 'chrome',
  item_id: 'abcdefghijklmnopabcdefghijklmnop',
  fingerprint: 'cfp1',
  text: { description: 'Session Mover moves a session.\n\nHOW IT WORKS\n1. Press "Transfer".\n2. Enter the code & done.', language: 'en' },
  screenshots: [{ file: 's1' }, { file: 's2' }, { file: 's3' }],
});

/** A fake public web: serves one fixture (or a status) and records the URLs it was asked for. */
function web(page, { status = 200, url } = {}) {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    return { ok: status < 300, status, url: url ?? u, text: async () => (page ? fixture(page) : '') };
  };
  return { fetchImpl, calls };
}

// ---- Parsing the real markup shape
test('parsePlayPage reads title, description and the screenshot carousel', () => {
  const p = parsePlayPage(fixture('play-details'), 'com.x');
  assert.equal(p.title, 'Inv Track');
  assert.equal(p.screenshots, 2);
  assert.equal(p.descriptionLength, normaliseText(bundle().locales[0].fullDescription).length);
});

test('parseChromePage skips the summary paragraph and counts carousel clones once', () => {
  const p = parseChromePage(fixture('cws-detail'), manifest().item_id);
  assert.equal(p.screenshots, 3);
  assert.equal(p.descriptionLength, normaliseText(manifest().text.description).length);
});

test('normaliseText: <br>, tags, entities and whitespace runs give the same text as the repo', () => {
  assert.equal(normaliseText('A &amp; <b>B</b><br><br>• C&#39;s &quot;x&quot;'), normaliseText('A & B\n\n• C\'s "x"'));
});

test('a clean page matches the repo: Play and Chrome are VERIFIED', async () => {
  const play = web('play-details');
  assert.deepEqual(await checkPlayPublic({ bundle: bundle(), fetchImpl: play.fetchImpl }), { outcome: 'verified', mismatches: [] });
  assert.deepEqual(play.calls, ['https://play.google.com/store/apps/details?id=com.x&hl=en-US']);
  const cws = web('cws-detail');
  assert.deepEqual(await checkChromePublic({ manifest: manifest(), fetchImpl: cws.fetchImpl }), { outcome: 'verified', mismatches: [] });
  assert.deepEqual(cws.calls, ['https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop?hl=en']);
});

// ---- MUTATION tests (acceptance): each saved page must fail.
const PLAY_MUTATIONS = {
  'edited description': ['play-edited-description', 'differs', /en-US: public description differs \(repo 68 chars sha256 \w{12}, page 70 chars/],
  'one screenshot fewer': ['play-one-screenshot-fewer', 'differs', /en-US: public screenshot count differs \(repo 2, page 1\)/],
  'unparseable markup': ['play-unparseable', 'broken', /^VERIFIER_BROKEN: Play page for com\.x: description \(data-g-id=description\) not found/],
};
for (const [name, [page, outcome, line]] of Object.entries(PLAY_MUTATIONS)) {
  test(`Play MUTATION: ${name} -> ${outcome}, and a failed run once the review SLA has passed`, async () => {
    const check = await checkPlayPublic({ bundle: bundle(), fetchImpl: web(page).fetchImpl });
    assert.equal(check.outcome, outcome);
    assert.ok(check.mismatches.some((m) => line.test(m)), check.mismatches.join('\n'));
    const v = publicVerdict({ check, since: daysAgo(8), now: NOW });
    assert.notEqual(v.outcome, 'verified', 'the listing-verify outcome fails the run');
  });
}

const CHROME_MUTATIONS = {
  'edited description': ['cws-edited-description', 'differs', /^public description differs/],
  'one screenshot fewer': ['cws-one-screenshot-fewer', 'differs', /^public screenshot count differs \(repo 3, page 2\)/],
  'unparseable markup': ['cws-unparseable', 'broken', /^VERIFIER_BROKEN: Chrome Web Store page for \w+: overview \(div jsname=ij8cu\) not found/],
};
for (const [name, [page, outcome, line]] of Object.entries(CHROME_MUTATIONS)) {
  test(`Chrome MUTATION: ${name} -> ${outcome}, and the run fails once overdue`, async () => {
    const check = await checkChromePublic({ manifest: manifest(), fetchImpl: web(page).fetchImpl });
    assert.equal(check.outcome, outcome);
    assert.ok(check.mismatches.some((m) => line.test(m)), check.mismatches.join('\n'));
    assert.equal(chromeVerdict({ issue: { state: 'CLOSED', closedAt: daysAgo(8) }, check, now: NOW }).failed, true);
  });
}

test('a page for another app, an HTTP error or a network failure is VERIFIER_BROKEN, never a pass', async () => {
  const other = fixture('play-details').replace('id=com.x&amp;', 'id=com.other&amp;');
  assert.throws(() => parsePlayPage(other, 'com.x'), /VERIFIER_BROKEN: .*the page is for .*com\.other/);
  assert.equal((await checkPlayPublic({ bundle: bundle(), fetchImpl: web('play-details', { status: 503 }).fetchImpl })).outcome, 'broken');
  const down = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.deepEqual(await checkChromePublic({ manifest: manifest(), fetchImpl: down }), { outcome: 'broken', mismatches: ['VERIFIER_BROKEN: GET https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop?hl=en failed: ENOTFOUND'] });
});

test('a page that is not public is a difference: Play 404, and the Chrome Web Store empty-title redirect', async () => {
  const play = await checkPlayPublic({ bundle: bundle(), fetchImpl: web(null, { status: 404 }).fetchImpl });
  assert.deepEqual(play, { outcome: 'differs', mismatches: ['en-US: public page not found (HTTP 404) - the app is not public'] });
  const cws = await checkChromePublic({ manifest: manifest(), fetchImpl: web('cws-unparseable', { url: 'https://chromewebstore.google.com/detail/empty-title/abc' }).fetchImpl });
  assert.equal(cws.outcome, 'differs');
});

// ---- The review clock
test('publicVerdict: a difference inside 7 days is pending, after 7 days a mismatch; broken is loud at any age', () => {
  const differs = { outcome: 'differs', mismatches: ['x'] };
  assert.deepEqual(publicVerdict({ check: differs, since: daysAgo(6.9), now: NOW }), { outcome: 'verified', state: 'pending', mismatches: ['x'] });
  assert.deepEqual(publicVerdict({ check: differs, since: daysAgo(7.1), now: NOW }), { outcome: 'mismatch', state: 'overdue', mismatches: ['x'] });
  assert.equal(publicVerdict({ check: { outcome: 'broken', mismatches: ['b'] }, since: daysAgo(0), now: NOW }).outcome, 'broken');
});

const rec = (number, fp, date, state = 'OPEN', labels = []) => ({ number, state, labels, body: `<!-- listing-committed: com.x ${fp} ${date} -->\ntext` });

test('planCommitted: first sight of a fingerprint starts the clock; older open records are superseded', () => {
  assert.deepEqual(planCommitted({ pkg: 'com.x', fingerprint: 'fp2', issues: [rec(3, 'fp1', daysAgo(30))], now: NOW }), { action: 'create', since: NOW.toISOString(), superseded: [3] });
  assert.deepEqual(planCommitted({ pkg: 'com.x', fingerprint: 'fp1', issues: [rec(3, 'fp1', daysAgo(2))], now: NOW }), { action: 'check', issue: 3, since: daysAgo(2), superseded: [] });
  assert.equal(planCommitted({ pkg: 'com.x', fingerprint: 'fp1', issues: [rec(3, 'fp1', daysAgo(2), 'CLOSED', [{ name: 'listing-verified' }])], now: NOW }).action, 'done');
  // A record closed by a person without the label is not proof: keep checking.
  assert.equal(planCommitted({ pkg: 'com.x', fingerprint: 'fp1', issues: [rec(3, 'fp1', daysAgo(2), 'CLOSED')], now: NOW }).action, 'check');
  assert.equal(planCommitted({ pkg: 'com.y', fingerprint: 'fp1', issues: [rec(3, 'fp1', daysAgo(2))], now: NOW }).action, 'create');
});

/** gh double: answers `issue list` with the given issues, `issue create` with a URL; records calls. */
function fakeGh(issues = []) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(issues);
    if (args[1] === 'create') return 'https://github.com/o/a/issues/12\n';
    return '';
  };
  const did = (verb) => calls.filter((c) => c[0] === 'issue' && c[1] === verb);
  return { gh, calls, did };
}

test('playPublicReport: new fingerprint + matching page -> record opened, then closed as listing-verified', async () => {
  const g = fakeGh([]);
  const r = await playPublicReport({ manifest: bundle(), repo: 'o/a', now: NOW, fetchImpl: web('play-details').fetchImpl, gh: g.gh });
  assert.equal(r.outcome, 'verified');
  const body = g.did('create')[0][g.did('create')[0].indexOf('--body') + 1];
  assert.match(body, /^<!-- listing-committed: com\.x fp1 2026-10-20T03:17:00\.000Z -->/);
  assert.deepEqual(g.did('edit')[0].slice(3), ['--repo', 'o/a', '--add-label', 'listing-verified']);
  assert.equal(g.did('close')[0][2], '12');
});

test('playPublicReport: a page that differs is pending for 7 days (no fail), then fails the run', async () => {
  const pending = await playPublicReport({ manifest: bundle(), repo: 'o/a', now: NOW, fetchImpl: web('play-edited-description').fetchImpl, gh: fakeGh([rec(5, 'fp1', daysAgo(3))]).gh });
  assert.equal(pending.outcome, 'verified');
  assert.equal(pending.pending, true);
  assert.match(pending.line, /^PUBLIC_PENDING/);
  const g = fakeGh([rec(5, 'fp1', daysAgo(8))]);
  const late = await playPublicReport({ manifest: bundle(), repo: 'o/a', now: NOW, fetchImpl: web('play-edited-description').fetchImpl, gh: g.gh });
  assert.equal(late.outcome, 'mismatch');
  assert.match(late.line, /^PUBLIC_MISMATCH/);
  assert.equal(g.did('close').length, 0, 'the record stays open until the page matches');
});

test('playPublicReport: unparseable page is VERIFIER_BROKEN even on day one', async () => {
  const r = await playPublicReport({ manifest: bundle(), repo: 'o/a', now: NOW, fetchImpl: web('play-unparseable').fetchImpl, gh: fakeGh([]).gh });
  assert.equal(r.outcome, 'broken');
  assert.match(r.mismatches[0], /^VERIFIER_BROKEN/);
});

test('playPublicReport: an already-confirmed fingerprint fetches nothing', async () => {
  const w = web('play-unparseable');
  const r = await playPublicReport({ manifest: bundle(), repo: 'o/a', now: NOW, fetchImpl: w.fetchImpl, gh: fakeGh([rec(5, 'fp1', daysAgo(20), 'CLOSED', [{ name: 'listing-verified' }])]).gh });
  assert.equal(r.outcome, 'verified');
  assert.equal(w.calls.length, 0);
});

// ---- Chrome: the checklist closes only when confirmed
const checklist = (state, extra = {}) => ({ number: 7, state, body: '<!-- listing-fingerprint: cfp1 -->\nsteps', labels: [], closedAt: null, ...extra });

test('planChromeVerify: an open checklist is awaiting submission; a person closing it triggers the check', () => {
  assert.equal(planChromeVerify(undefined), 'no-checklist');
  assert.equal(planChromeVerify(checklist('OPEN')), 'awaiting-submission');
  assert.equal(planChromeVerify(checklist('CLOSED', { closedAt: daysAgo(1) })), 'check');
  assert.equal(planChromeVerify(checklist('OPEN', { labels: [{ name: 'listing-verify' }] })), 'check');
  assert.equal(planChromeVerify(checklist('CLOSED', { labels: [{ name: 'listing-verified' }] })), 'done');
});

test('chromeVerify: closed + public page matches -> listing-verified label, issue stays closed', async () => {
  const g = fakeGh([checklist('CLOSED', { closedAt: daysAgo(2) })]);
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-detail').fetchImpl, gh: g.gh });
  assert.deepEqual([r.result, r.failed], ['CHROME_LISTING_VERIFIED: #7', false]);
  assert.deepEqual(g.did('edit')[0].slice(3), ['--repo', 'o/a', '--add-label', 'listing-verified']);
  assert.equal(g.did('comment').length, 1);
  assert.equal(g.did('reopen').length, 0);
});

test('chromeVerify: closed 2 days ago and the page differs -> pending, nothing written, run passes', async () => {
  const g = fakeGh([checklist('CLOSED', { closedAt: daysAgo(2) })]);
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-one-screenshot-fewer').fetchImpl, gh: g.gh });
  assert.equal(r.failed, false);
  assert.match(r.result, /^CHROME_LISTING_PENDING/);
  assert.equal(g.calls.length, 1, 'only the issue list');
});

test('chromeVerify MUTATION: closed 8 days ago and the page differs -> reopened with the diff + listing-verify, run fails', async () => {
  const g = fakeGh([checklist('CLOSED', { closedAt: daysAgo(8) })]);
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-edited-description').fetchImpl, gh: g.gh });
  assert.deepEqual([r.result, r.failed], ['CHROME_LISTING_MISMATCH: reopened #7', true]);
  const reopen = g.did('reopen')[0];
  assert.match(reopen[reopen.indexOf('--comment') + 1], /- public description differs/);
  assert.deepEqual(g.did('edit')[0].slice(3), ['--repo', 'o/a', '--add-label', 'listing-verify']);
});

test('chromeVerify: reopened issue whose page now matches is closed as listing-verified and loses listing-verify', async () => {
  const g = fakeGh([checklist('OPEN', { labels: [{ name: 'store-listing' }, { name: 'listing-verify' }], closedAt: daysAgo(9) })]);
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-detail').fetchImpl, gh: g.gh });
  assert.equal(r.failed, false);
  assert.deepEqual(g.did('edit')[0].slice(3), ['--repo', 'o/a', '--add-label', 'listing-verified', '--remove-label', 'listing-verify']);
  assert.equal(g.did('close')[0][2], '7');
});

test('chromeVerify: reopened and still different keeps failing without another comment', async () => {
  const g = fakeGh([checklist('OPEN', { labels: [{ name: 'listing-verify' }], closedAt: daysAgo(9) })]);
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-edited-description').fetchImpl, gh: g.gh });
  assert.equal(r.failed, true);
  assert.equal(g.calls.length, 1);
});

test('chromeVerify MUTATION: unparseable page fails the run even one day after close', async () => {
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: web('cws-unparseable').fetchImpl, gh: fakeGh([checklist('CLOSED', { closedAt: daysAgo(1) })]).gh });
  assert.equal(r.failed, true);
  assert.match(r.mismatches[0], /^VERIFIER_BROKEN/);
});

test('chromeVerify: an open checklist (not yet submitted) fetches nothing and passes', async () => {
  const w = web('cws-unparseable');
  const r = await chromeVerify({ manifest: manifest(), repo: 'o/a', now: NOW, fetchImpl: w.fetchImpl, gh: fakeGh([checklist('OPEN')]).gh });
  assert.equal(r.failed, false);
  assert.equal(w.calls.length, 0);
});
