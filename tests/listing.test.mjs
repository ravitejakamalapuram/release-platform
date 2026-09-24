import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleTargets, syncVideoIssue, VIDEO_TITLE, checkChromeListing, checkPlayListing, checkTargets, chromeChecklist, imageSize, loadChromeListing,
  loadPlayListing, planChromeIssue, syncChromeIssue,
} from '../scripts/listing.mjs';
import { syncListing, urls } from '../scripts/play.mjs';
import { fakeFetch } from './helpers.mjs';

/** Minimal PNG: signature + IHDR (enough for imageSize). `seed` makes distinct bytes. */
function png(width, height, seed = 0) {
  const b = Buffer.alloc(33 + seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Minimal JPEG: SOI, an APP0 segment, then SOF0 with the frame size. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function write(root, rel, data) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  return p;
}

/** A chrome repo shaped like json-workbench: config in chrome-store/, screenshots elsewhere. */
function chromeRepo({ shots = [[1280, 800], [1280, 800]], short = 'Inspect big JSON locally.', promo = { smallTile: 'assets/promo/small-tile.png' } } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'listing-chrome-'));
  const screenshots = shots.map(([w, h], i) => {
    write(repo, `store/assets/screenshots/0${i + 1}-view.png`, png(w, h, i));
    return `../store/assets/screenshots/0${i + 1}-view.png`;
  });
  write(repo, 'chrome-store/assets/promo/small-tile.png', png(440, 280));
  write(repo, 'chrome-store/store.config.json', JSON.stringify({
    name: 'JSON Workbench', shortDescription: short, description: 'Long description.', category: 'Developer Tools', language: 'en',
    privacyPolicyUrl: 'https://example.com/privacy', publisherId: 'pub-1', screenshots, promotionalImages: promo,
  }));
  return repo;
}

const chromeConfig = { app: 'jw', targets: [{ type: 'chrome', item_id: 'a'.repeat(32), path: 'dist', listing: 'chrome-store/store.config.json' }] };

function playRepo({ title = 'TelePort', phones = [[1080, 1920], [1080, 1920]] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'listing-play-'));
  const base = 'fastlane/metadata/android/en-US';
  write(repo, `${base}/title.txt`, `${title}\n`);
  write(repo, `${base}/short_description.txt`, 'Cast the web to your TV.\n');
  write(repo, `${base}/full_description.txt`, 'A long description.\n');
  write(repo, `${base}/images/icon.png`, png(512, 512));
  write(repo, `${base}/images/featureGraphic.png`, png(1024, 500));
  phones.forEach(([w, h], i) => write(repo, `${base}/images/phoneScreenshots/${i + 1}.png`, png(w, h, i)));
  mkdirSync(join(repo, 'fastlane/metadata/android/changelogs'), { recursive: true });
  return repo;
}

const playConfig = { app: 'tp', targets: [{ type: 'android', package: 'com.example.tp', listing: 'fastlane/metadata/android' }] };

test('imageSize reads PNG and JPEG dimensions and rejects other bytes', () => {
  assert.deepEqual(imageSize(png(1280, 800)), { type: 'png', width: 1280, height: 800, alpha: false });
  assert.deepEqual(imageSize(jpeg(640, 400)), { type: 'jpeg', width: 640, height: 400, alpha: false });
  const rgba = png(1280, 800);
  rgba[25] = 6;
  assert.equal(imageSize(rgba).alpha, true);
  assert.equal(imageSize(Buffer.from('GIF89a......')), null);
});

test('a valid chrome listing passes, with paths resolved relative to store.config.json', () => {
  const repo = chromeRepo();
  const listing = loadChromeListing(join(repo, 'chrome-store/store.config.json'));
  const { errors, images } = checkChromeListing(listing);
  assert.deepEqual(errors, []);
  assert.equal(images.screenshots.length, 2);
  assert.equal(images.promo.smallTile.width, 440);
});

test('chrome rules: wrong screenshot size, long short description, too many screenshots, retired tile', () => {
  const repo = chromeRepo({ shots: [[2560, 1600], ...Array(5).fill([1280, 800])], short: 'x'.repeat(133), promo: { smallTile: 'assets/promo/small-tile.png', largeTile: 'assets/promo/small-tile.png' } });
  const { errors, warnings } = checkChromeListing(loadChromeListing(join(repo, 'chrome-store/store.config.json')));
  assert.ok(errors.some((e) => /shortDescription is 133 characters/.test(e)));
  assert.ok(errors.some((e) => /6 listed \(the store takes 1 to 5\)/.test(e)));
  assert.ok(errors.some((e) => /screenshots\[0\] is 2560x1600/.test(e)));
  assert.ok(warnings.some((w) => /largeTile is not used/.test(w)));
});

test('chrome rules: screenshots with transparency are refused', () => {
  const repo = chromeRepo();
  const p = join(repo, 'store/assets/screenshots/01-view.png');
  const b = readFileSync(p);
  b[25] = 6;
  writeFileSync(p, b);
  const { errors } = checkChromeListing(loadChromeListing(join(repo, 'chrome-store/store.config.json')));
  assert.ok(errors.some((e) => /screenshots\[0\] has transparency/.test(e)));
});

test('chrome promoVideo must be a YouTube URL and is carried into the checklist', () => {
  const repo = chromeRepo();
  const cfgPath = join(repo, 'chrome-store/store.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, promoVideo: 'https://vimeo.com/1' }));
  assert.ok(checkChromeListing(loadChromeListing(cfgPath)).errors.some((e) => /promoVideo must be a YouTube URL/.test(e)));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, promoVideo: 'https://youtu.be/Jrr2vy4up2c' }));
  const [b] = bundleTargets(checkTargets(chromeConfig, repo), mkdtempSync(join(tmpdir(), 'bundle-')));
  assert.equal(b.manifest.text.promoVideo, 'https://youtu.be/Jrr2vy4up2c');
  assert.match(chromeChecklist(b.manifest), /Global promo video:\*\* `https:\/\/youtu\.be\/Jrr2vy4up2c`/);
});

test('checkTargets refuses listings that reach outside the repo', () => {
  const repo = chromeRepo();
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  write(outside, 'x.png', png(1280, 800));
  const cfg = JSON.parse(readFileSync(join(repo, 'chrome-store/store.config.json'), 'utf8'));
  cfg.screenshots = [join(outside, 'x.png')];
  writeFileSync(join(repo, 'chrome-store/store.config.json'), JSON.stringify(cfg));
  const [r] = checkTargets(chromeConfig, repo);
  assert.ok(r.errors.some((e) => /outside the repo/.test(e)));
});

test('checkTargets skips targets without a listing and honours the type filter', () => {
  const repo = chromeRepo();
  assert.equal(checkTargets({ app: 'x', targets: [{ type: 'chrome', item_id: 'a'.repeat(32), path: 'dist' }] }, repo).length, 0);
  assert.equal(checkTargets(chromeConfig, repo, 'android').length, 0);
});

test('chrome bundle: ordered, renamed files and a fingerprint that tracks content', () => {
  const repo = chromeRepo();
  const out = mkdtempSync(join(tmpdir(), 'bundle-'));
  const [b] = bundleTargets(checkTargets(chromeConfig, repo), out);
  assert.deepEqual(readdirSync(join(out, 'chrome-0/screenshots')), ['01-view.png', '02-view.png']);
  assert.ok(readFileSync(join(out, 'chrome-0/LISTING.md'), 'utf8').includes(`listing-fingerprint: ${b.manifest.fingerprint}`));
  const [again] = bundleTargets(checkTargets(chromeConfig, repo), mkdtempSync(join(tmpdir(), 'bundle-')));
  assert.equal(again.manifest.fingerprint, b.manifest.fingerprint, 'same content, same fingerprint');
  write(repo, 'store/assets/screenshots/01-view.png', png(1280, 800, 7));
  const [changed] = bundleTargets(checkTargets(chromeConfig, repo), mkdtempSync(join(tmpdir(), 'bundle-')));
  assert.notEqual(changed.manifest.fingerprint, b.manifest.fingerprint);
});

test('chrome checklist links the right dashboard and carries the text to paste', () => {
  const md = chromeChecklist({ item_id: 'abc', publisher_id: 'pub', fingerprint: 'f1', text: { shortDescription: 'S', description: 'D' }, screenshots: [{ file: 'screenshots/01-a.png' }], promo: {} }, 'https://run');
  assert.ok(md.includes('https://chrome.google.com/webstore/devconsole/pub/abc/edit'));
  assert.ok(md.includes('Submit for review'));
  assert.ok(md.includes('https://run'));
});

test('planChromeIssue: same fingerprint is skipped; a new one supersedes older open issues', () => {
  const m = { item_id: 'item1', fingerprint: 'fp2' };
  assert.deepEqual(planChromeIssue(m, [{ number: 3, state: 'CLOSED', body: 'x listing-fingerprint: fp2' }]), { action: 'skip', issue: 3, reason: 'already handled' });
  assert.deepEqual(planChromeIssue(m, [{ number: 4, state: 'OPEN', body: 'item1 listing-fingerprint: fp1' }]), { action: 'create', superseded: [4] });
});

test('syncChromeIssue opens the issue, labels it and closes the superseded one', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 4, state: 'OPEN', body: 'item1 listing-fingerprint: old' }]);
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/5\n';
    return '';
  };
  const manifest = { item_id: 'item1', publisher_id: '', fingerprint: 'new', text: { shortDescription: 's', description: 'd' }, screenshots: [], promo: {} };
  const r = syncChromeIssue({ manifest, repo: 'o/r', gh });
  assert.equal(r.result, 'LISTING_ISSUE_OPENED: https://github.com/o/r/issues/5');
  assert.ok(calls.some((a) => a[0] === 'label' && a[1] === 'create'));
  assert.ok(calls.some((a) => a[0] === 'issue' && a[1] === 'close' && a[2] === '4'));
  const dry = [];
  syncChromeIssue({ manifest, repo: 'o/r', dryRun: true, gh: (a) => (dry.push(a), a[1] === 'list' ? '[]' : '') });
  assert.deepEqual(dry.map((a) => a[1]), ['list'], 'dry run only reads');
});

test('play listing: fastlane layout loads and validates', () => {
  const repo = playRepo();
  const listing = loadPlayListing(join(repo, 'fastlane/metadata/android'));
  assert.deepEqual(listing.locales.map((l) => l.language), ['en-US'], 'changelogs/ has no title.txt and is skipped');
  assert.deepEqual(checkPlayListing(listing).errors, []);
});

test('play rules: title length, screenshot count and aspect ratio', () => {
  const repo = playRepo({ title: 'T'.repeat(31), phones: [[1080, 3000]] });
  const { errors } = checkPlayListing(loadPlayListing(join(repo, 'fastlane/metadata/android')));
  assert.ok(errors.some((e) => /title.txt is 31 characters \(max 30\)/.test(e)));
  assert.ok(errors.some((e) => /phoneScreenshots: 1 images/.test(e)));
  assert.ok(errors.some((e) => /at most twice the short side/.test(e)));
});

const PKG = 'com.example.tp';

function playBundle() {
  const repo = playRepo();
  const out = mkdtempSync(join(tmpdir(), 'bundle-'));
  const [b] = bundleTargets(checkTargets(playConfig, repo), out);
  return { bundle: b.manifest, readFile: (f) => readFileSync(join(out, 'android-0', f)) };
}

test('syncListing: nothing changed -> edit discarded, never committed', async () => {
  const { bundle, readFile } = playBundle();
  const loc = bundle.locales[0];
  const f = fakeFetch([
    { body: { id: 'e1' } },
    { body: { language: 'en-US', title: loc.title, shortDescription: loc.shortDescription, fullDescription: loc.fullDescription } },
    ...Object.values(loc.images).map((imgs) => ({ body: { images: imgs.map((i) => ({ sha256: i.sha256 })) } })),
    { body: {} },
  ]);
  const { changes, commit } = await syncListing({ pkg: PKG, token: 't', fetchImpl: f, bundle, readFile });
  assert.deepEqual(changes, []);
  assert.equal(commit, null);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).url, urls.edit(PKG, 'e1'));
});

test('syncListing: new listing text and changed screenshots are written, then committed', async () => {
  const { bundle, readFile } = playBundle();
  const loc = bundle.locales[0];
  const types = Object.keys(loc.images);
  const responses = [{ body: { id: 'e1' } }, { status: 404, body: { error: { message: 'not found' } } }, { body: {} }];
  for (const t of types) {
    if (t === 'phoneScreenshots') {
      responses.push({ body: { images: [{ sha256: 'old' }] } }, { body: {} }, ...loc.images[t].map(() => ({ body: { image: {} } })));
    } else {
      responses.push({ body: { images: loc.images[t].map((i) => ({ sha256: i.sha256 })) } });
    }
  }
  responses.push({ body: { id: 'e1' } });
  const f = fakeFetch(responses);
  const { changes, commit } = await syncListing({ pkg: PKG, token: 't', fetchImpl: f, bundle, readFile });
  assert.deepEqual(changes, ['en-US: listing created', 'en-US: phoneScreenshots (1 -> 2)']);
  assert.equal(commit.sentForReview, true);
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, urls.listing(PKG, 'e1', 'en-US'));
  assert.equal(JSON.parse(put.body).title, 'TelePort');
  const uploads = f.calls.filter((c) => c.method === 'POST' && c.url.includes('/phoneScreenshots?uploadType=media'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers['Content-Type'], 'image/png');
  assert.equal(f.remaining(), 0);
});

test('syncListing dry run reports changes but writes nothing', async () => {
  const { bundle, readFile } = playBundle();
  const types = Object.keys(bundle.locales[0].images);
  const f = fakeFetch([{ body: { id: 'e1' } }, { status: 404, body: {} }, ...types.map(() => ({ body: { images: [] } })), { body: {} }]);
  const { changes, commit } = await syncListing({ pkg: PKG, token: 't', fetchImpl: f, bundle, readFile, dryRun: true });
  assert.equal(changes.length, 1 + types.length);
  assert.equal(commit, null);
  assert.ok(f.calls.every((c) => c.method !== 'PUT' && c.method !== 'POST' || c.url === urls.insert(PKG)));
});

test('demo-video checkpoint: opens one agent-ready issue when promoVideo is missing', () => {
  const calls = [];
  const gh = (a) => (calls.push(a), a[1] === 'list' ? '[]' : a[0] === 'issue' && a[1] === 'create' ? 'https://github.com/o/r/issues/9\n' : '');
  const r = syncVideoIssue({ manifest: { item_id: 'item1', text: {} }, repo: 'o/r', gh });
  assert.equal(r.result, 'DEMO_VIDEO_MISSING: opened https://github.com/o/r/issues/9');
  const create = calls.find((a) => a[0] === 'issue' && a[1] === 'create');
  assert.equal(create[create.indexOf('--title') + 1], VIDEO_TITLE);
  assert.deepEqual(create.filter((x, i) => create[i - 1] === '--label'), ['demo-video', 'agent-ready']);
  const again = syncVideoIssue({ manifest: { item_id: 'item1', text: {} }, repo: 'o/r', gh: (a) => (a[1] === 'list' ? JSON.stringify([{ number: 9, body: 'demo-video-checkpoint: item1' }]) : '') });
  assert.equal(again.action, 'skip', 'never a second issue');
});

test('demo-video checkpoint: closes the open issue once promoVideo is set; dry run writes nothing', () => {
  const calls = [];
  const gh = (a) => (calls.push(a), a[1] === 'list' ? JSON.stringify([{ number: 9, body: 'demo-video-checkpoint: item1' }]) : '');
  const m = { item_id: 'item1', text: { promoVideo: 'https://youtu.be/x' } };
  assert.equal(syncVideoIssue({ manifest: m, repo: 'o/r', gh, dryRun: true }).action, 'close');
  assert.ok(!calls.some((a) => a[1] === 'close'));
  syncVideoIssue({ manifest: m, repo: 'o/r', gh });
  assert.ok(calls.some((a) => a[1] === 'close' && a[2] === '9'));
});
