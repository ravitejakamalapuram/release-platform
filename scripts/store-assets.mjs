#!/usr/bin/env node
// Validate a Chrome Web Store listing manifest (a chrome target's `store` field in release.yaml)
// against schema/store-listing.schema.json, then check every screenshot and promo image it
// declares: it must exist on disk, be a PNG or JPEG, and have the exact pixel dimensions the
// dashboard accepts. Dimensions are read from the file's own header bytes - no image library.
//
//   node scripts/store-assets.mjs --repo . --store chrome-store/store.config.json
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from './lib/schema.mjs';
import { log, main } from './lib/gha.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../schema/store-listing.schema.json', import.meta.url));

export const SCREENSHOT_SIZES = [
  [1280, 800],
  [640, 400],
];
export const SMALL_TILE_SIZE = [440, 280];
export const MARQUEE_SIZE = [1400, 560];

export function loadListingSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/**
 * Width/height/format straight from a PNG or JPEG file's header bytes.
 * Returns null when the buffer is neither (the caller decides what that means).
 */
export function readImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    // PNG: IHDR is always the first chunk, at a fixed offset, with width then height (big-endian).
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    // JPEG: walk the marker segments until a start-of-frame (SOFn) segment gives the dimensions.
    let offset = 2;
    while (offset + 9 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) {
        offset += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2; // markers with no payload
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
    throw new Error('JPEG has no start-of-frame segment (corrupt file?)');
  }
  return null;
}

const sizeLabel = ([w, h]) => `${w}x${h}`;

/** Check one declared image: exists, is PNG/JPEG, and matches one of the allowed pixel sizes. */
function checkImage(errors, { manifestDir, relPath, label, allowedSizes }) {
  const abs = join(manifestDir, relPath);
  if (!existsSync(abs)) {
    errors.push(`${label} "${relPath}" does not exist`);
    return;
  }
  const dims = readImageDimensions(readFileSync(abs));
  if (!dims) {
    errors.push(`${label} "${relPath}" is not a PNG or JPEG file`);
    return;
  }
  const ok = allowedSizes.some(([w, h]) => dims.width === w && dims.height === h);
  if (!ok) {
    errors.push(`${label} "${relPath}" is ${dims.width}x${dims.height}, expected ${allowedSizes.map(sizeLabel).join(' or ')}`);
  }
}

/**
 * Validate a parsed listing manifest against the schema plus asset checks (existence, format,
 * dimensions). `manifestDir` is the directory image paths are resolved against (the manifest's
 * own directory, not the repo root). Throws with every problem found, naming the file and value.
 */
export function checkListing(listing, manifestDir, schema = loadListingSchema()) {
  if (listing === null || typeof listing !== 'object' || Array.isArray(listing)) {
    throw new Error('listing manifest must be a JSON object');
  }
  const schemaErrors = validate(schema, listing, schema).map((e) => `${e.path}: ${e.message}`);
  const assetErrors = [];
  if (Array.isArray(listing.screenshots)) {
    listing.screenshots.forEach((relPath, i) => {
      if (typeof relPath === 'string') checkImage(assetErrors, { manifestDir, relPath, label: `screenshots[${i}]`, allowedSizes: SCREENSHOT_SIZES });
    });
  }
  if (typeof listing.promotionalImages?.smallTile === 'string') {
    checkImage(assetErrors, { manifestDir, relPath: listing.promotionalImages.smallTile, label: 'promotionalImages.smallTile', allowedSizes: [SMALL_TILE_SIZE] });
  }
  if (typeof listing.promotionalImages?.marquee === 'string') {
    checkImage(assetErrors, { manifestDir, relPath: listing.promotionalImages.marquee, label: 'promotionalImages.marquee', allowedSizes: [MARQUEE_SIZE] });
  }
  const errors = [...schemaErrors, ...assetErrors];
  if (errors.length) throw new Error(errors.map((e) => `  ${e}`).join('\n'));
}

/** Load, parse and validate the listing manifest a chrome target's `store` field points at. */
export function checkStoreAssets({ repo, storePath }) {
  const abs = join(repo, storePath);
  if (!existsSync(abs)) throw new Error(`store listing manifest "${storePath}" does not exist`);
  let listing;
  try {
    listing = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`store listing manifest "${storePath}" is not valid JSON: ${err.message}`);
  }
  try {
    checkListing(listing, dirname(abs));
  } catch (err) {
    throw new Error(`store listing manifest "${storePath}" is invalid:\n${err.message}`);
  }
  return listing;
}

async function cli() {
  const { values } = parseArgs({ options: { repo: { type: 'string', default: '.' }, store: { type: 'string' } } });
  if (!values.store) throw new Error('--store is required');
  const listing = checkStoreAssets({ repo: values.repo, storePath: values.store });
  log(`${values.store} OK: ${listing.screenshots.length} screenshot(s), category "${listing.category}"`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
