#!/usr/bin/env node
// Store listings as code: validate and bundle each target's listing (text + images).
//
//   node scripts/listing.mjs check  --config release.json --repo .                 (PR checks)
//   node scripts/listing.mjs bundle --config release.json --repo . --out listings  (listing.yml)
//   node scripts/listing.mjs chrome-issue --bundle listings/chrome-0 --github-repo owner/app --run-url <url> [--dry-run]
//   node scripts/listing.mjs verify-issue --bundle listings/android-0 --github-repo owner/app --run-url <url> [--public-check]  (after play.mjs verify-listing)
//   node scripts/listing.mjs chrome-verify --bundle listings/chrome-0 --github-repo owner/app --run-url <url>  (public page vs the closed checklist)
//
// Chrome: the target's `listing` points at chrome-store/store.config.json. The Chrome Web Store
// API cannot change listings, so the bundle is prepared for a person to upload.
// Android: the target's `listing` points at a fastlane-style metadata directory
// (<locale>/title.txt, short_description.txt, full_description.txt, images/...). play.mjs syncs it.
//
// Reads files only; never runs app code. Outputs (bundle): chrome_listing_ids, android_listing_ids.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { log, main, setOutput, summary, warning } from './lib/gha.mjs';
import { checkConfig, normalizeTarget, parseTargetFilter } from './validate.mjs';
import {
  COMMITTED_LABEL,
  VERIFIED_LABEL,
  checkChromePublic,
  checkPlayPublic,
  chromeVerdict,
  committedMarker,
  planChromeVerify,
  planCommitted,
  publicVerdict,
  REVIEW_SLA_DAYS,
} from './public-listing.mjs';

export const CHROME_RULES = Object.freeze({
  shortDescription: 132,
  description: 16000,
  screenshots: { min: 1, max: 5, sizes: [[1280, 800], [640, 400]] },
  promo: { smallTile: [440, 280], marquee: [1400, 560] },
});

export const PLAY_RULES = Object.freeze({
  title: 30,
  short: 80,
  full: 4000,
  icon: [512, 512],
  featureGraphic: [1024, 500],
  tvBanner: [1280, 720],
  // [min count, max count]; screenshot sides must be 320..3840 px with long side <= 2x short side.
  screenshots: { phoneScreenshots: [2, 8], sevenInchScreenshots: [0, 8], tenInchScreenshots: [0, 8], tvScreenshots: [0, 8], wearScreenshots: [0, 8] },
});

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

/** Width/height of a PNG or JPEG from its bytes, or null if it is neither. */
export function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    // Colour types 4 (grey + alpha) and 6 (RGBA), or a tRNS chunk, mean transparency.
    const alpha = buf.length > 25 && (buf[25] === 4 || buf[25] === 6 || buf.includes('tRNS'));
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), alpha: false };
      }
      i += 2 + len;
    }
  }
  return null;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const readText = (p) => (isFile(p) ? readFileSync(p, 'utf8').replace(/\s+$/, '') : null);
const fmt = ([w, h]) => `${w}x${h}`;

/** Check one image file; returns { error } or { image }. */
function readImage(path, label) {
  if (!isFile(path)) return { error: `${label}: file not found (${path})` };
  if (!IMAGE_EXT.has(extname(path).toLowerCase())) return { error: `${label}: must be PNG or JPEG (${basename(path)})` };
  const buf = readFileSync(path);
  const size = imageSize(buf);
  if (!size) return { error: `${label}: not a readable PNG/JPEG (${basename(path)})` };
  return { image: { path, ...size, bytes: buf.length, sha256: sha256(buf) } };
}

// ---------------------------------------------------------------- Chrome Web Store

/** Load chrome-store/store.config.json; image paths are relative to the config file. */
export function loadChromeListing(configPath) {
  if (!isFile(configPath)) throw new Error(`listing file not found: ${configPath}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err.message}`);
  }
  const base = dirname(configPath);
  const promo = raw.promotionalImages ?? {};
  return {
    name: raw.name ?? '',
    publisherId: raw.publisherId ?? '',
    shortDescription: raw.shortDescription ?? '',
    description: raw.description ?? '',
    category: raw.category ?? '',
    language: raw.language ?? '',
    privacyPolicyUrl: raw.privacyPolicyUrl ?? '',
    supportUrl: raw.supportUrl ?? '',
    websiteUrl: raw.websiteUrl ?? '',
    promoVideo: raw.promoVideo ?? '',
    screenshots: (raw.screenshots ?? []).map((p) => resolve(base, p)),
    promo: Object.fromEntries(Object.entries(promo).map(([k, p]) => [k, resolve(base, p)])),
  };
}

/** Validate a loaded Chrome listing against CHROME_RULES. Returns { errors, warnings, images }. */
export function checkChromeListing(listing) {
  const errors = [];
  const warnings = [];
  const images = { screenshots: [], promo: {} };
  if (!listing.shortDescription.trim()) errors.push('shortDescription is required');
  else if (listing.shortDescription.length > CHROME_RULES.shortDescription) {
    errors.push(`shortDescription is ${listing.shortDescription.length} characters (max ${CHROME_RULES.shortDescription})`);
  }
  if (!listing.description.trim()) errors.push('description is required');
  else if (listing.description.length > CHROME_RULES.description) errors.push(`description is ${listing.description.length} characters (max ${CHROME_RULES.description})`);
  for (const key of ['privacyPolicyUrl', 'supportUrl', 'websiteUrl']) {
    if (listing[key] && !/^https:\/\//.test(listing[key])) errors.push(`${key} must be an https:// URL`);
  }
  if (listing.promoVideo && !/^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{6,}/.test(listing.promoVideo)) {
    errors.push('promoVideo must be a YouTube URL (https://www.youtube.com/watch?v=... or https://youtu.be/...)');
  }

  const { min, max, sizes } = CHROME_RULES.screenshots;
  if (listing.screenshots.length < min || listing.screenshots.length > max) {
    errors.push(`screenshots: ${listing.screenshots.length} listed (the store takes ${min} to ${max})`);
  }
  listing.screenshots.forEach((p, i) => {
    const { error, image } = readImage(p, `screenshots[${i}]`);
    if (error) return errors.push(error);
    if (!sizes.some(([w, h]) => image.width === w && image.height === h)) {
      errors.push(`screenshots[${i}] is ${image.width}x${image.height}; the store accepts ${sizes.map(fmt).join(' or ')} (${basename(p)})`);
    }
    if (image.alpha) errors.push(`screenshots[${i}] has transparency; the store takes JPEG or 24-bit PNG without alpha (${basename(p)})`);
    images.screenshots.push(image);
  });

  for (const [key, p] of Object.entries(listing.promo)) {
    const want = CHROME_RULES.promo[key];
    if (!want) {
      warnings.push(`promotionalImages.${key} is not used by the Chrome Web Store any more; it is ignored`);
      continue;
    }
    const { error, image } = readImage(p, `promotionalImages.${key}`);
    if (error) {
      errors.push(error);
      continue;
    }
    if (image.width !== want[0] || image.height !== want[1]) errors.push(`promotionalImages.${key} is ${image.width}x${image.height}; expected ${fmt(want)}`);
    if (image.alpha) errors.push(`promotionalImages.${key} has transparency; the store takes JPEG or 24-bit PNG without alpha`);
    images.promo[key] = image;
  }
  if (!listing.promo.smallTile) warnings.push('promotionalImages.smallTile (440x280) is missing; the store shows a generic tile without it');
  return { errors, warnings, images };
}

// ---------------------------------------------------------------- Google Play (fastlane layout)

const PLAY_SINGLE_IMAGES = { icon: 'icon', featureGraphic: 'featureGraphic', promoGraphic: 'promoGraphic', tvBanner: 'tvBanner' };

function findSingleImage(dir, name) {
  for (const ext of ['.png', '.jpg', '.jpeg']) if (isFile(join(dir, `${name}${ext}`))) return join(dir, `${name}${ext}`);
  return null;
}

/** Load <dir>/<locale>/... in fastlane "supply" layout. Folders without title.txt are skipped. */
export function loadPlayListing(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`listing directory not found: ${dir}`);
  const locales = [];
  for (const locale of readdirSync(dir).sort()) {
    const ldir = join(dir, locale);
    if (!statSync(ldir).isDirectory() || !isFile(join(ldir, 'title.txt'))) continue;
    const images = {};
    const idir = join(ldir, 'images');
    for (const [type, name] of Object.entries(PLAY_SINGLE_IMAGES)) {
      const p = existsSync(idir) ? findSingleImage(idir, name) : null;
      if (p) images[type] = [p];
    }
    for (const type of Object.keys(PLAY_RULES.screenshots)) {
      const sdir = join(idir, type);
      if (!existsSync(sdir)) continue;
      const files = readdirSync(sdir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();
      if (files.length) images[type] = files.map((f) => join(sdir, f));
    }
    locales.push({
      language: locale,
      title: readText(join(ldir, 'title.txt')) ?? '',
      shortDescription: readText(join(ldir, 'short_description.txt')) ?? '',
      fullDescription: readText(join(ldir, 'full_description.txt')) ?? '',
      video: readText(join(ldir, 'video.txt')) ?? '',
      images,
    });
  }
  return { locales };
}

/** Validate a loaded Play listing against PLAY_RULES. Returns { errors, warnings, images }. */
export function checkPlayListing(listing) {
  const errors = [];
  const warnings = [];
  const images = {};
  if (!listing.locales.length) errors.push('no locale folders with a title.txt (expected e.g. en-US/title.txt)');
  for (const loc of listing.locales) {
    const at = (m) => `${loc.language}: ${m}`;
    const text = [['title', loc.title, PLAY_RULES.title], ['short_description', loc.shortDescription, PLAY_RULES.short], ['full_description', loc.fullDescription, PLAY_RULES.full]];
    for (const [name, value, max] of text) {
      if (!value.trim()) errors.push(at(`${name}.txt is required`));
      else if ([...value].length > max) errors.push(at(`${name}.txt is ${[...value].length} characters (max ${max})`));
    }
    if (loc.video && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(loc.video)) errors.push(at('video.txt must be a YouTube URL'));
    images[loc.language] = {};
    for (const [type, paths] of Object.entries(loc.images)) {
      const list = [];
      for (const [i, p] of paths.entries()) {
        const { error, image } = readImage(p, at(`${type}[${i}]`));
        if (error) {
          errors.push(error);
          continue;
        }
        const exact = PLAY_RULES[type];
        if (Array.isArray(exact) && (image.width !== exact[0] || image.height !== exact[1])) {
          errors.push(at(`${type} is ${image.width}x${image.height}; expected ${fmt(exact)}`));
        }
        if (type === 'icon' && image.type !== 'png') errors.push(at('icon must be a PNG'));
        if (type !== 'icon' && image.alpha) errors.push(at(`${type}[${i}] has transparency; Play takes JPEG or 24-bit PNG without alpha`));
        if (PLAY_RULES.screenshots[type]) {
          const lo = Math.min(image.width, image.height);
          const hi = Math.max(image.width, image.height);
          if (lo < 320 || hi > 3840) errors.push(at(`${type}[${i}] is ${image.width}x${image.height}; each side must be 320-3840 px`));
          else if (hi > 2 * lo) errors.push(at(`${type}[${i}] is ${image.width}x${image.height}; the long side may be at most twice the short side`));
        }
        list.push(image);
      }
      images[loc.language][type] = list;
    }
    for (const [type, [minCount, maxCount]] of Object.entries(PLAY_RULES.screenshots)) {
      const n = loc.images[type]?.length ?? 0;
      if (n > maxCount || (n > 0 && n < minCount) || (type === 'phoneScreenshots' && n < minCount)) {
        errors.push(at(`${type}: ${n} images (the store takes ${minCount} to ${maxCount})`));
      }
    }
    if (!loc.images.icon) warnings.push(at('images/icon.png missing; the current store icon is kept'));
    if (!loc.images.featureGraphic) warnings.push(at('images/featureGraphic missing; the current feature graphic is kept'));
  }
  return { errors, warnings, images };
}

// ---------------------------------------------------------------- targets, bundles

function listingFiles(listing) {
  if (listing.locales) return listing.locales.flatMap((l) => Object.values(l.images).flat());
  return [...listing.screenshots, ...Object.values(listing.promo)];
}

/** Targets that declare a `listing`, with the listing loaded and checked. */
export function checkTargets(config, repo, filter = '') {
  checkConfig(config);
  const types = parseTargetFilter(filter);
  const results = [];
  for (const [i, raw] of config.targets.entries()) {
    const target = normalizeTarget(raw, i);
    if (!target.listing || (types.length && !types.includes(target.type))) continue;
    const path = resolve(repo, target.listing);
    let listing;
    let checked;
    try {
      listing = target.type === 'chrome' ? loadChromeListing(path) : loadPlayListing(path);
      checked = target.type === 'chrome' ? checkChromeListing(listing) : checkPlayListing(listing);
      // Listings are bundled into artifacts: never let them reach files outside the repo.
      const root = resolve(repo);
      const outside = listingFiles(listing).filter((f) => relative(root, f).startsWith('..'));
      if (outside.length) checked.errors.push(`listing references files outside the repo: ${outside.map((f) => basename(f)).join(', ')}`);
    } catch (err) {
      checked = { errors: [err.message], warnings: [], images: {} };
    }
    results.push({ target, listing, ...checked });
  }
  return results;
}

/** Stable fingerprint of everything that would be uploaded (text + image bytes, in order). */
export function fingerprint(value) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'path').map((k) => [k, strip(v[k])]));
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(strip(value))).digest('hex').slice(0, 16);
}

function chromeBundle(result, out) {
  const { listing, images, target } = result;
  mkdirSync(join(out, 'screenshots'), { recursive: true });
  const files = images.screenshots.map((img, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${basename(img.path).replace(/^\d+[-_ ]*/, '')}`;
    copyFileSync(img.path, join(out, 'screenshots', name));
    return { file: `screenshots/${name}`, width: img.width, height: img.height, sha256: img.sha256 };
  });
  const promo = {};
  for (const [key, img] of Object.entries(images.promo)) {
    const name = `${key}${extname(img.path).toLowerCase()}`;
    copyFileSync(img.path, join(out, name));
    promo[key] = { file: name, width: img.width, height: img.height, sha256: img.sha256 };
  }
  const text = { shortDescription: listing.shortDescription, description: listing.description, category: listing.category, language: listing.language, privacyPolicyUrl: listing.privacyPolicyUrl, supportUrl: listing.supportUrl, websiteUrl: listing.websiteUrl, promoVideo: listing.promoVideo };
  const fp = fingerprint({ text, screenshots: files, promo });
  const manifest = { type: 'chrome', item_id: target.item_id, publisher_id: listing.publisherId, fingerprint: fp, text, screenshots: files, promo };
  writeFileSync(join(out, 'listing.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'LISTING.md'), chromeChecklist(manifest));
  return manifest;
}

/** Markdown the person uploading the Chrome listing follows (also the GitHub issue body). */
export function chromeChecklist(m, runUrl = '') {
  const dash = m.publisher_id
    ? `https://chrome.google.com/webstore/devconsole/${m.publisher_id}/${m.item_id}/edit`
    : 'https://chrome.google.com/webstore/devconsole';
  const lines = [
    `<!-- listing-fingerprint: ${m.fingerprint} -->`,
    `The Chrome Web Store API cannot change listings, so this update needs a person in the Developer Dashboard.`,
    '',
    `**Item:** \`${m.item_id}\` · **Dashboard:** ${dash}`,
    runUrl ? `**Files:** download the \`listing-chrome-*\` artifact from ${runUrl}` : '',
    '',
    '### Steps',
    '1. Open the dashboard link above → **Store listing**.',
    `2. **Screenshots:** remove the old ones, then upload in this order: ${m.screenshots.map((s) => `\`${basename(s.file)}\``).join(', ')}.`,
    ...Object.entries(m.promo).map(([k, v]) => `   - **${k}** (${v.width}×${v.height}): \`${v.file}\``),
    '3. **Short description** and **Detailed description:** replace with the text below if they differ.',
    ...(m.text.promoVideo ? [`   - **Global promo video:** \`${m.text.promoVideo}\``] : []),
    '4. **Save draft**, then **Submit for review** (listing edits stay private until the review passes).',
    '5. Close this issue once submitted. A later change to the listing opens a new issue.',
    '',
    '### Short description',
    '```text',
    m.text.shortDescription,
    '```',
    '### Detailed description',
    '```text',
    m.text.description,
    '```',
  ];
  return `${lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')}\n`;
}

function playBundle(result, out) {
  const { listing, images, target } = result;
  const locales = listing.locales.map((loc) => {
    const imgs = {};
    for (const [type, list] of Object.entries(images[loc.language] ?? {})) {
      imgs[type] = list.map((img, i) => {
        const rel = join(loc.language, type, `${String(i + 1).padStart(2, '0')}${extname(img.path).toLowerCase()}`);
        mkdirSync(join(out, dirname(rel)), { recursive: true });
        copyFileSync(img.path, join(out, rel));
        return { file: rel, width: img.width, height: img.height, sha256: img.sha256, contentType: img.type === 'png' ? 'image/png' : 'image/jpeg' };
      });
    }
    return { language: loc.language, title: loc.title, shortDescription: loc.shortDescription, fullDescription: loc.fullDescription, video: loc.video, images: imgs };
  });
  const manifest = { type: 'android', package: target.package, fingerprint: fingerprint({ locales }), locales };
  writeFileSync(join(out, 'listing.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Write one bundle directory per target: <out>/<target key>/{listing.json, files...}. */
export function bundleTargets(results, out) {
  return results.map((r) => {
    const dir = join(out, r.target.key);
    mkdirSync(dir, { recursive: true });
    return { key: r.target.key, type: r.target.type, id: r.target.type === 'chrome' ? r.target.item_id : r.target.package, manifest: r.target.type === 'chrome' ? chromeBundle(r, dir) : playBundle(r, dir) };
  });
}

export const ISSUE_LABEL = 'store-listing';

/**
 * Decide what to do about the GitHub issue for a Chrome listing bundle, given the repo's
 * store-listing issues ([{ number, state, body, title }]). An issue whose body carries the same
 * fingerprint (open or closed) means this exact listing was already handed to a person.
 */
export function planChromeIssue(manifest, issues) {
  const marker = `listing-fingerprint: ${manifest.fingerprint}`;
  const same = issues.find((i) => (i.body ?? '').includes(marker));
  if (same) return { action: 'skip', issue: same.number, reason: same.state === 'OPEN' ? 'already open' : 'already handled' };
  const superseded = issues.filter((i) => i.state === 'OPEN' && (i.body ?? '').includes(manifest.item_id)).map((i) => i.number);
  return { action: 'create', superseded };
}

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Open (or skip) the Chrome listing checklist issue. `gh` is injectable for tests. */
export function syncChromeIssue({ manifest, repo, runUrl = '', dryRun = false, gh = defaultGh }) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--label', ISSUE_LABEL, '--limit', '100', '--json', 'number,state,title,body']));
  const plan = planChromeIssue(manifest, issues);
  if (plan.action === 'skip') return { ...plan, result: `LISTING_ISSUE_SKIPPED: #${plan.issue} ${plan.reason} for fingerprint ${manifest.fingerprint}` };
  const title = `Chrome Web Store listing update (${manifest.fingerprint})`;
  if (dryRun) return { ...plan, result: `LISTING_ISSUE_WOULD_OPEN (dry run): "${title}"${plan.superseded.length ? `, superseding #${plan.superseded.join(', #')}` : ''}` };
  gh(['label', 'create', ISSUE_LABEL, '--repo', repo, '--color', '0e8a16', '--description', 'Store listing changes that need a person in the store dashboard', '--force']);
  const url = gh(['issue', 'create', '--repo', repo, '--title', title, '--label', ISSUE_LABEL, '--body', chromeChecklist(manifest, runUrl)]).trim();
  for (const n of plan.superseded) {
    gh(['issue', 'close', String(n), '--repo', repo, '--comment', `Superseded by ${url}: the listing changed again before this one was applied.`]);
  }
  return { ...plan, url, result: `LISTING_ISSUE_OPENED: ${url}` };
}

export const VERIFY_LABEL = 'listing-verify';

/**
 * Decide what to do about the one open listing-verify issue per package (APP-290), given the
 * verifier's outcome: 'mismatch' (Play differs from the repo), 'broken' (the verifier did not
 * produce a result - never treated as a pass) or 'verified'. issues: [{ number, state, body }].
 */
export function planVerifyIssue({ pkg, outcome, issues }) {
  const marker = `<!-- listing-verify: ${pkg} -->`;
  const open = issues.find((i) => i.state === 'OPEN' && (i.body ?? '').includes(marker));
  if (outcome === 'verified') return open ? { action: 'close', issue: open.number } : { action: 'none' };
  if (outcome !== 'mismatch' && outcome !== 'broken') throw new Error(`Unknown verify outcome "${outcome}"`);
  return open ? { action: 'comment', issue: open.number, marker } : { action: 'create', marker };
}

export function verifyIssueBody({ pkg, outcome, mismatches = [], fingerprint = '', runUrl = '' }) {
  const head =
    outcome === 'broken'
      ? 'The listing verifier did not produce a result or could not read the store (VERIFIER_BROKEN), so nobody knows whether Play matches the repo. A broken check is not a pass.'
      : `Google Play's listing for \`${pkg}\` does not match the repo's listing directory${fingerprint ? ` (bundle fingerprint \`${fingerprint}\`)` : ''}.`;
  return [
    head,
    runUrl ? `**Run:** ${runUrl}` : '',
    '',
    ...(mismatches.length ? ['### Differences', ...mismatches.map((m) => `- ${m}`), ''] : []),
    'If the repo is right, re-run the `listing` workflow. If someone changed the Play Console on purpose, copy the change into the repo\'s listing directory first.',
    'This issue closes itself on the next run that reads Play back and finds it matching.',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

/** Open, update or close the listing-verify issue for one package. `gh` is injectable for tests. */
export function syncVerifyIssue({ pkg, outcome, mismatches = [], fingerprint = '', repo, runUrl = '', gh = defaultGh }) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', VERIFY_LABEL, '--limit', '100', '--json', 'number,state,body']));
  const plan = planVerifyIssue({ pkg, outcome, issues });
  const body = verifyIssueBody({ pkg, outcome, mismatches, fingerprint, runUrl });
  if (plan.action === 'none') return { ...plan, result: `LISTING_VERIFIED: ${pkg}` };
  if (plan.action === 'close') {
    gh(['issue', 'close', String(plan.issue), '--repo', repo, '--comment', `Play matches the repo again (read back by ${runUrl || 'the listing workflow'}).`]);
    return { ...plan, result: `LISTING_VERIFY_ISSUE_CLOSED: #${plan.issue}` };
  }
  if (plan.action === 'comment') {
    gh(['issue', 'comment', String(plan.issue), '--repo', repo, '--body', body]);
    return { ...plan, result: `LISTING_VERIFY_ISSUE_UPDATED: #${plan.issue}` };
  }
  gh(['label', 'create', VERIFY_LABEL, '--repo', repo, '--color', 'b60205', '--description', 'The store does not match the repo listing (read back by the listing workflow)', '--force']);
  const url = gh(['issue', 'create', '--repo', repo, '--title', `Play listing does not match the repo: ${pkg}`, '--label', VERIFY_LABEL, '--body', `${plan.marker}\n${body}`]).trim();
  return { ...plan, url, result: `LISTING_VERIFY_ISSUE_OPENED: ${url}` };
}

const issueNumber = (url) => Number(url.trim().match(/\/issues\/(\d+)$/)?.[1]);

/**
 * Post-review public-page check for one Play package (APP-296). Runs only after the API read-back
 * verified the bundle. Keeps the `listing-committed` record for (package, fingerprint) - its date
 * starts the review clock - and closes it with `listing-verified` once the public page matches.
 * Returns the outcome for the listing-verify issue: { outcome, mismatches, line }.
 */
export async function playPublicReport({ manifest, repo, now = new Date(), fetchImpl = fetch, gh = defaultGh }) {
  const pkg = manifest.package;
  const fp = manifest.fingerprint;
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--label', COMMITTED_LABEL, '--limit', '100', '--json', 'number,state,body,labels']));
  const plan = planCommitted({ pkg, fingerprint: fp, issues, now });
  for (const n of plan.superseded) gh(['issue', 'close', String(n), '--repo', repo, '--comment', `Superseded: the Play listing for \`${pkg}\` changed again (fingerprint \`${fp}\`) before this one was confirmed public.`]);
  if (plan.action === 'done') return { outcome: 'verified', mismatches: [], line: `PUBLIC_VERIFIED: ${pkg} fingerprint ${fp} was confirmed public in #${plan.issue}` };
  let issue = plan.issue;
  if (plan.action === 'create') {
    gh(['label', 'create', COMMITTED_LABEL, '--repo', repo, '--color', 'c5def5', '--description', 'Play accepted this listing; waiting for the public page to show it', '--force']);
    const body = [
      `${committedMarker(pkg, fp)}${plan.since} -->`,
      `Play's API holds the repo listing for \`${pkg}\` (fingerprint \`${fp}\`) as of ${plan.since.slice(0, 10)}. Listing changes go through review before users see them.`,
      '',
      `The daily \`listing\` run compares the public page (title, description, screenshot count) with the repo and closes this issue with the \`${VERIFIED_LABEL}\` label once they match. If they still differ ${REVIEW_SLA_DAYS} days after the date above, the run fails and the \`listing-verify\` issue lists the differences.`,
    ].join('\n');
    issue = issueNumber(gh(['issue', 'create', '--repo', repo, '--title', `Play listing waiting for public confirmation: ${pkg} (${fp})`, '--label', COMMITTED_LABEL, '--body', body]));
  }
  const check = await checkPlayPublic({ bundle: manifest, fetchImpl });
  const v = publicVerdict({ check, since: plan.since, now });
  if (v.state === 'verified') {
    gh(['label', 'create', VERIFIED_LABEL, '--repo', repo, '--color', '0e8a16', '--description', 'The public store page matches the repo listing', '--force']);
    gh(['issue', 'edit', String(issue), '--repo', repo, '--add-label', VERIFIED_LABEL]);
    gh(['issue', 'close', String(issue), '--repo', repo, '--comment', `The public Play page matches the repo listing (title, description, screenshot count). Confirmed ${now.toISOString().slice(0, 10)}.`]);
    return { outcome: 'verified', mismatches: [], line: `PUBLIC_VERIFIED: ${pkg} fingerprint ${fp} (closed #${issue})` };
  }
  const tag = { pending: `PUBLIC_PENDING (in review since ${plan.since.slice(0, 10)}, fails after ${REVIEW_SLA_DAYS} days)`, overdue: `PUBLIC_MISMATCH (committed ${plan.since.slice(0, 10)}, more than ${REVIEW_SLA_DAYS} days ago)`, broken: 'VERIFIER_BROKEN' }[v.state];
  return { outcome: v.outcome, mismatches: v.mismatches, line: `${tag}: ${pkg} #${issue}`, pending: v.state === 'pending' };
}

/**
 * Chrome: the checklist issue for this fingerprint closes only when the public page confirms it.
 * A person closing it means "submitted". Returns { result, failed, mismatches }.
 */
export async function chromeVerify({ manifest, repo, runUrl = '', now = new Date(), fetchImpl = fetch, gh = defaultGh }) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--label', ISSUE_LABEL, '--limit', '100', '--json', 'number,state,body,closedAt,labels']));
  const issue = issues.find((i) => (i.body ?? '').includes(`listing-fingerprint: ${manifest.fingerprint}`));
  const plan = planChromeVerify(issue);
  const id = `${manifest.item_id} (${manifest.fingerprint})`;
  if (plan === 'no-checklist') return { result: `CHROME_LISTING_NO_CHECKLIST: no store-listing issue for ${id}; run the listing workflow to open one`, failed: false, mismatches: [] };
  if (plan === 'awaiting-submission') return { result: `CHROME_LISTING_AWAITING_SUBMISSION: #${issue.number} is still open`, failed: false, mismatches: [] };
  if (plan === 'done') return { result: `CHROME_LISTING_VERIFIED: #${issue.number} already confirmed`, failed: false, mismatches: [] };
  const check = await checkChromePublic({ manifest, fetchImpl });
  const v = chromeVerdict({ issue, check, now });
  const n = String(issue.number);
  const diff = check.mismatches.map((m) => `- ${m}`).join('\n');
  if (v.action === 'verify') {
    gh(['label', 'create', VERIFIED_LABEL, '--repo', repo, '--color', '0e8a16', '--description', 'The public store page matches the repo listing', '--force']);
    gh(['issue', 'edit', n, '--repo', repo, '--add-label', VERIFIED_LABEL, ...((issue.labels ?? []).some((l) => (l.name ?? l) === VERIFY_LABEL) ? ['--remove-label', VERIFY_LABEL] : [])]);
    const msg = `The public Chrome Web Store page matches this listing (description, screenshot count). Confirmed ${now.toISOString().slice(0, 10)}${runUrl ? ` by ${runUrl}` : ''}.`;
    gh(issue.state === 'OPEN' ? ['issue', 'close', n, '--repo', repo, '--comment', msg] : ['issue', 'comment', n, '--repo', repo, '--body', msg]);
    return { result: `CHROME_LISTING_VERIFIED: #${n}`, failed: false, mismatches: [] };
  }
  if (v.action === 'reopen') {
    gh(['label', 'create', VERIFY_LABEL, '--repo', repo, '--color', 'b60205', '--description', 'The store does not match the repo listing (read back by the listing workflow)', '--force']);
    gh(['issue', 'reopen', n, '--repo', repo, '--comment', [`This was closed on ${issue.closedAt.slice(0, 10)}, but ${REVIEW_SLA_DAYS} days later the public Chrome Web Store page still differs from this listing${runUrl ? ` (${runUrl})` : ''}:`, '', diff, '', 'Check the Developer Dashboard: was the listing submitted for review, and did the review pass? Close this issue again once it is submitted; the daily run confirms it.'].join('\n')]);
    gh(['issue', 'edit', n, '--repo', repo, '--add-label', VERIFY_LABEL]);
    return { result: `CHROME_LISTING_MISMATCH: reopened #${n}`, failed: true, mismatches: check.mismatches };
  }
  const result = {
    pending: `CHROME_LISTING_PENDING: #${n} closed ${issue.closedAt?.slice(0, 10)}; the public page differs (review may still be running, fails after ${REVIEW_SLA_DAYS} days)`,
    'still-open': `CHROME_LISTING_MISMATCH: #${n} is reopened and the public page still differs`,
    broken: `VERIFIER_BROKEN: #${n} could not be checked`,
  }[v.action];
  return { result, failed: v.failed, mismatches: check.mismatches };
}

export const VIDEO_LABEL = 'demo-video';
export const VIDEO_TITLE = 'Demo video needed for the Chrome Web Store listing';

export function videoIssueBody(manifest) {
  return [
    `<!-- demo-video-checkpoint: ${manifest.item_id} -->`,
    'This item has no promo video. `chrome-store/store.config.json` has no `promoVideo`. A short demo',
    'raises store conversion, and first-time publishes should not go out without one.',
    '',
    '### Steps',
    '1. **Agents** (this issue is labelled `agent-ready`, so the intake hands it to Paperclip): the Demo',
    '   Producer records a 20-30 s demo of the real product with a voice-over and attaches the MP4.',
    '2. **Board:** upload the MP4 to YouTube as **Unlisted** (the store only accepts YouTube links).',
    '3. Set `"promoVideo": "https://youtu.be/<id>"` in `chrome-store/store.config.json` in a PR whose body says',
    '   `Fixes #<this issue>`. The next listing run carries it into the listing, and closes this issue if it is',
    '   still open.',
  ].join('\n');
}

/**
 * Demo-video checkpoint: without a promoVideo, open one `demo-video` issue (labelled agent-ready so the
 * agent company makes the video); with one, close any open checkpoint issue.
 */
export function syncVideoIssue({ manifest, repo, dryRun = false, gh = defaultGh }) {
  const open = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', VIDEO_LABEL, '--limit', '20', '--json', 'number,body']))
    .filter((i) => (i.body ?? '').includes(`demo-video-checkpoint: ${manifest.item_id}`));
  if (manifest.text?.promoVideo) {
    if (!open.length) return { action: 'none', result: 'DEMO_VIDEO_OK: promoVideo is set' };
    if (dryRun) return { action: 'close', result: `DEMO_VIDEO_OK (dry run): would close #${open.map((i) => i.number).join(', #')}` };
    for (const i of open) gh(['issue', 'close', String(i.number), '--repo', repo, '--comment', `promoVideo is set (${manifest.text.promoVideo}); closing.`]);
    return { action: 'close', result: `DEMO_VIDEO_OK: closed #${open.map((i) => i.number).join(', #')}` };
  }
  if (open.length) return { action: 'skip', result: `DEMO_VIDEO_MISSING: already tracked in #${open[0].number}` };
  if (dryRun) return { action: 'create', result: `DEMO_VIDEO_MISSING (dry run): would open "${VIDEO_TITLE}"` };
  gh(['label', 'create', VIDEO_LABEL, '--repo', repo, '--color', 'fbca04', '--description', 'The store listing needs a demo video', '--force']);
  gh(['label', 'create', 'agent-ready', '--repo', repo, '--color', '0e8a16', '--description', 'Board-approved for the agent team to pick up', '--force']);
  const url = gh(['issue', 'create', '--repo', repo, '--title', VIDEO_TITLE, '--label', VIDEO_LABEL, '--label', 'agent-ready', '--body', videoIssueBody(manifest)]).trim();
  return { action: 'create', url, result: `DEMO_VIDEO_MISSING: opened ${url}` };
}

function report(results, repo) {
  let failed = false;
  const rows = [];
  for (const r of results) {
    const id = r.target.type === 'chrome' ? r.target.item_id : r.target.package;
    for (const w of r.warnings) warning(`${r.target.type} ${id}: ${w}`);
    for (const e of r.errors) log(`::error::${r.target.type} ${id} listing (${relative(repo, resolve(repo, r.target.listing))}): ${e}`);
    if (r.errors.length) failed = true;
    rows.push(`| ${r.target.type} | \`${id}\` | \`${r.target.listing}\` | ${r.errors.length ? `❌ ${r.errors.length} problem(s)` : '✅ valid'} |`);
  }
  if (results.length) summary(['### Store listings', '', '| Target | Id | Listing | Result |', '|---|---|---|---|', ...rows].join('\n'));
  return failed;
}

async function cli() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      config: { type: 'string', default: 'release.json' },
      repo: { type: 'string', default: '.' },
      targets: { type: 'string', default: '' },
      out: { type: 'string', default: 'listings' },
      bundle: { type: 'string' },
      'github-repo': { type: 'string' },
      'run-url': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
      'public-check': { type: 'boolean', default: false },
    },
  });
  if (command === 'verify-issue') {
    if (!values.bundle || !values['github-repo']) throw new Error('--bundle and --github-repo are required');
    const manifest = JSON.parse(readFileSync(join(values.bundle, 'listing.json'), 'utf8'));
    const verifyPath = join(values.bundle, 'verify.json');
    const v = existsSync(verifyPath) ? JSON.parse(readFileSync(verifyPath, 'utf8')) : { outcome: 'broken', mismatches: [] };
    // The public page is checked only once Play's API holds the bundle: otherwise its state is unknown.
    if (values['public-check'] && v.outcome === 'verified') {
      const pub = await playPublicReport({ manifest, repo: values['github-repo'] });
      log(pub.line);
      for (const m of pub.mismatches) log(`  ${m}`);
      if (pub.pending) warning(pub.line);
      Object.assign(v, { outcome: pub.outcome, mismatches: pub.mismatches });
    }
    const { result } = syncVerifyIssue({ pkg: manifest.package, outcome: v.outcome, mismatches: v.mismatches, fingerprint: manifest.fingerprint, repo: values['github-repo'], runUrl: values['run-url'] });
    log(result);
    setOutput('result', result);
    if (v.outcome !== 'verified') throw new Error(`Listing verification ${v.outcome === 'broken' ? 'did not run or could not read the store' : 'found differences'}: ${result}`);
    return;
  }
  if (command === 'chrome-verify') {
    if (!values.bundle || !values['github-repo']) throw new Error('--bundle and --github-repo are required');
    const manifest = JSON.parse(readFileSync(join(values.bundle, 'listing.json'), 'utf8'));
    const { result, failed, mismatches } = await chromeVerify({ manifest, repo: values['github-repo'], runUrl: values['run-url'] });
    log(result);
    for (const m of mismatches) log(`  ${m}`);
    setOutput('result', result);
    summary(`### Chrome listing (public page)\n\n${result}${mismatches.length ? `\n\n${mismatches.map((m) => `- ${m}`).join('\n')}` : ''}`);
    if (failed) throw new Error(result);
    return;
  }
  if (command === 'chrome-issue') {
    if (!values.bundle || !values['github-repo']) throw new Error('--bundle and --github-repo are required');
    const manifest = JSON.parse(readFileSync(join(values.bundle, 'listing.json'), 'utf8'));
    const { result } = syncChromeIssue({ manifest, repo: values['github-repo'], runUrl: values['run-url'], dryRun: values['dry-run'] });
    log(result);
    setOutput('result', result);
    const video = syncVideoIssue({ manifest, repo: values['github-repo'], dryRun: values['dry-run'] });
    log(video.result);
    if (video.action === 'create' || video.action === 'skip') warning(video.result);
    summary(`### Chrome listing\n\n${result}\n\n${video.result}\n\n${chromeChecklist(manifest, values['run-url'])}`);
    return;
  }
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const results = checkTargets(config, values.repo, values.targets);
  if (!results.length) {
    log('No target declares a `listing`; nothing to check.');
    setOutput('chrome_listing_ids', '[]');
    setOutput('android_listing_ids', '[]');
    return;
  }
  if (report(results, values.repo)) throw new Error('Store listing validation failed (see the errors above).');
  log(`Store listings OK: ${results.map((r) => `${r.target.type}:${r.target.listing}`).join(', ')}`);
  if (command === 'check') return;
  if (command !== 'bundle') throw new Error(`Unknown command "${command}" (expected check|bundle|chrome-issue|verify-issue|chrome-verify)`);
  const bundles = bundleTargets(results, values.out);
  for (const b of bundles) log(`Bundled ${b.type} ${b.id} → ${join(values.out, b.key)} (fingerprint ${b.manifest.fingerprint})`);
  setOutput('chrome_listing_ids', JSON.stringify(bundles.filter((b) => b.type === 'chrome').map((b) => b.key)));
  setOutput('android_listing_ids', JSON.stringify(bundles.filter((b) => b.type === 'android').map((b) => b.key)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
