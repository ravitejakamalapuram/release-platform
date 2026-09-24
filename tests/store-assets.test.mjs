import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkListing, checkStoreAssets, readImageDimensions, SCREENSHOT_SIZES, SMALL_TILE_SIZE, MARQUEE_SIZE } from '../scripts/store-assets.mjs';
import { bundleListing, planAssets, renderListingMarkdown } from '../scripts/bundle-store-listing.mjs';

// A real 37x21 JPEG (sips-encoded, with EXIF) used to check the marker-walking parser copes with
// a realistic file, not just a minimal one.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAJaADAAQAAAABAAAAFQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAFQAlAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAWHhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3N0BAQEBASEhISEhISEhISP/bAEMBCwwMEhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS//dAAQAA//aAAwDAQACEQMRAD8AuUUUV7B5QUUUUAFFFFAH/9C5RRRXsHlBRRRQAUUUUAf/2Q==';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A tiny valid solid-color PNG at exactly `width`x`height`. */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) raw[y * (rowLen + 1)] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('readImageDimensions reads PNG headers', () => {
  assert.deepEqual(readImageDimensions(makePng(1280, 800)), { format: 'png', width: 1280, height: 800 });
  assert.deepEqual(readImageDimensions(makePng(37, 21)), { format: 'png', width: 37, height: 21 });
});

test('readImageDimensions reads JPEG headers (real file, with EXIF)', () => {
  assert.deepEqual(readImageDimensions(Buffer.from(TINY_JPEG_BASE64, 'base64')), { format: 'jpeg', width: 37, height: 21 });
});

test('readImageDimensions returns null for neither PNG nor JPEG', () => {
  assert.equal(readImageDimensions(Buffer.from('not an image, just text')), null);
  assert.equal(readImageDimensions(Buffer.alloc(0)), null);
});

const goodListing = () => ({
  shortDescription: 'A short pitch for the store.',
  description: 'A longer description of what the extension does.',
  category: 'Developer Tools',
  screenshots: ['screenshots/01.png', 'screenshots/02.png'],
  promotionalImages: { smallTile: 'promo/small-tile.png', marquee: 'promo/marquee.png' },
  privacyPolicyUrl: 'https://example.com/privacy',
  supportUrl: 'https://example.com/support',
  websiteUrl: 'https://example.com',
});

/** A temp dir with a manifest.json-style listing and every image it declares, all correctly sized. */
function goodFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'store-listing-'));
  const listing = goodListing();
  write(join(dir, 'screenshots/01.png'), makePng(...SCREENSHOT_SIZES[0]));
  write(join(dir, 'screenshots/02.png'), makePng(...SCREENSHOT_SIZES[1]));
  write(join(dir, 'promo/small-tile.png'), makePng(...SMALL_TILE_SIZE));
  write(join(dir, 'promo/marquee.png'), makePng(...MARQUEE_SIZE));
  write(join(dir, 'listing.json'), JSON.stringify(listing));
  return dir;
}

test('checkListing accepts a fully-populated valid listing', () => {
  const dir = goodFixture();
  assert.doesNotThrow(() => checkListing(goodListing(), dir));
});

test('checkStoreAssets accepts the repo fixture used by CI (tests/fixtures/chrome-app/store)', () => {
  const repo = fileURLToPath(new URL('fixtures/chrome-app', import.meta.url));
  const listing = checkStoreAssets({ repo, storePath: 'store/listing.json' });
  assert.equal(listing.screenshots.length, 2);
});

test('checkStoreAssets fails, naming the file, when the manifest itself does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-listing-'));
  assert.throws(() => checkStoreAssets({ repo: dir, storePath: 'store/missing.json' }), /store listing manifest "store\/missing\.json" does not exist/);
});

test('rejects a declared screenshot/promo path that does not exist on disk, naming the file', () => {
  const dir = goodFixture();
  write(join(dir, 'listing.json'), JSON.stringify({ ...goodListing(), screenshots: ['screenshots/01.png', 'screenshots/nope.png'] }));
  assert.throws(() => checkListing(JSON.parse(readFileSync(join(dir, 'listing.json'), 'utf8')), dir), /screenshots\[1\] "screenshots\/nope\.png" does not exist/);
});

test('rejects screenshots with the wrong pixel dimensions, naming the actual size', () => {
  const dir = goodFixture();
  write(join(dir, 'screenshots/01.png'), makePng(800, 600));
  assert.throws(() => checkListing(goodListing(), dir), /screenshots\[0\] "screenshots\/01\.png" is 800x600, expected 1280x800 or 640x400/);
});

test('rejects a small tile / marquee with the wrong pixel dimensions', () => {
  const dir = goodFixture();
  write(join(dir, 'promo/small-tile.png'), makePng(400, 300));
  assert.throws(() => checkListing(goodListing(), dir), /promotionalImages\.smallTile "promo\/small-tile\.png" is 400x300, expected 440x280/);

  const dir2 = goodFixture();
  write(join(dir2, 'promo/marquee.png'), makePng(1400, 561));
  assert.throws(() => checkListing(goodListing(), dir2), /promotionalImages\.marquee "promo\/marquee\.png" is 1400x561, expected 1400x560/);
});

test('rejects a screenshot count outside 1..5', () => {
  const dir = goodFixture();
  assert.throws(() => checkListing({ ...goodListing(), screenshots: [] }, dir), /screenshots: must have at least 1 item/);
  const six = ['01.png', '02.png', '03.png', '04.png', '05.png', '06.png'];
  for (const f of six) write(join(dir, 'screenshots', f), makePng(...SCREENSHOT_SIZES[0]));
  assert.throws(() => checkListing({ ...goodListing(), screenshots: six.map((f) => `screenshots/${f}`) }, dir), /screenshots: must have at most 5 item\(s\) \(got 6\)/);
});

test('rejects an over-long shortDescription/description, naming the actual length', () => {
  const dir = goodFixture();
  assert.throws(() => checkListing({ ...goodListing(), shortDescription: 'x'.repeat(133) }, dir), /shortDescription: must be at most 132 characters \(got 133\)/);
  assert.throws(() => checkListing({ ...goodListing(), description: 'x'.repeat(16001) }, dir), /description: must be at most 16000 characters \(got 16001\)/);
});

test('rejects a declared file that is not a PNG or JPEG', () => {
  const dir = goodFixture();
  write(join(dir, 'screenshots/01.png'), Buffer.from('not actually a png'));
  assert.throws(() => checkListing(goodListing(), dir), /screenshots\[0\] "screenshots\/01\.png" is not a PNG or JPEG file/);
});

test('rejects unknown fields and missing required fields', () => {
  const dir = goodFixture();
  assert.throws(() => checkListing({ ...goodListing(), extra: true }, dir), /unknown property "extra"/);
  const { category, ...noCategory } = goodListing();
  assert.throws(() => checkListing(noCategory, dir), /missing required property "category"/);
});

test('accepts JPEG screenshots (real file) alongside PNG', () => {
  const dir = goodFixture();
  write(join(dir, 'screenshots/02.png'), Buffer.from(TINY_JPEG_BASE64, 'base64'));
  const listing = { ...goodListing(), screenshots: ['screenshots/01.png', 'screenshots/02.png'] };
  // Real size (37x21) does not match either allowed screenshot size, so this exercises the JPEG
  // decode path through to a size mismatch rather than a "not PNG/JPEG" error.
  assert.throws(() => checkListing(listing, dir), /screenshots\[1\] "screenshots\/02\.png" is 37x21, expected 1280x800 or 640x400/);
});

test('bundle: planAssets numbers screenshots in upload order and keeps original extensions', () => {
  const assets = planAssets({ ...goodListing(), screenshots: ['a/shot.png', 'b/shot.jpg'] });
  assert.deepEqual(assets, [
    { src: 'a/shot.png', dest: 'screenshots/01.png' },
    { src: 'b/shot.jpg', dest: 'screenshots/02.jpg' },
    { src: 'promo/small-tile.png', dest: 'promo/small-tile.png' },
    { src: 'promo/marquee.png', dest: 'promo/marquee.png' },
  ]);
});

test('bundle: renderListingMarkdown uses a heading per dashboard field with the exact text', () => {
  const md = renderListingMarkdown(goodListing());
  assert.match(md, /^# Chrome Web Store listing/);
  assert.match(md, /## Short description\n\nA short pitch for the store\./);
  assert.match(md, /## Description\n\nA longer description of what the extension does\./);
  assert.match(md, /## Category\n\nDeveloper Tools/);
  assert.match(md, /## Screenshots\n\n01\. `screenshots\/01\.png` \(from `screenshots\/01\.png`\)\n02\. `screenshots\/02\.png` \(from `screenshots\/02\.png`\)/);
  assert.match(md, /## Small promo tile \(440x280\)\n\n`promo\/small-tile\.png`/);
  assert.match(md, /## Marquee promo tile \(1400x560\)\n\n`promo\/marquee\.png`/);
  assert.match(md, /## Privacy policy\n\nhttps:\/\/example\.com\/privacy/);
  assert.match(md, /## Support URL\n\nhttps:\/\/example\.com\/support/);
  assert.match(md, /## Website\n\nhttps:\/\/example\.com\b/);
});

test('bundle: renderListingMarkdown omits optional fields that are absent', () => {
  const { promotionalImages, privacyPolicyUrl, supportUrl, websiteUrl, ...minimal } = goodListing();
  const md = renderListingMarkdown(minimal);
  assert.doesNotMatch(md, /Small promo tile/);
  assert.doesNotMatch(md, /Marquee promo tile/);
  assert.doesNotMatch(md, /Privacy policy/);
});

test('bundleListing writes a zip with renamed assets and LISTING.md, and validates first', { skip: !hasZip() && 'zip not installed' }, () => {
  const dir = goodFixture();
  const out = join(dir, 'store-listing-fixture-1.2.3.zip');
  const result = bundleListing({ repo: dir, storePath: 'listing.json', out });
  assert.equal(result.out, out);
  const listing = execFileSync('unzip', ['-l', out], { encoding: 'utf8' });
  assert.match(listing, /screenshots\/01\.png/);
  assert.match(listing, /screenshots\/02\.png/);
  assert.match(listing, /promo\/small-tile\.png/);
  assert.match(listing, /promo\/marquee\.png/);
  assert.match(listing, /LISTING\.md/);
  const md = execFileSync('unzip', ['-p', out, 'LISTING.md'], { encoding: 'utf8' });
  assert.match(md, /## Short description/);

  write(join(dir, 'screenshots/01.png'), makePng(1, 1));
  assert.throws(() => bundleListing({ repo: dir, storePath: 'listing.json', out }), /screenshots\[0\].*is 1x1, expected/);
});

function hasZip() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
