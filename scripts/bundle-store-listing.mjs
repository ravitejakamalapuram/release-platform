#!/usr/bin/env node
// Bundle a validated Chrome Web Store listing (a chrome target's `store` field) into one zip a
// human can download and paste into the Developer Dashboard by hand: screenshots renamed to
// their upload order, the promo images, and a LISTING.md with each field's exact text under a
// heading matching the dashboard's own field label. The Store API has no endpoint for any of
// this (see README), so this is as automated as the listing step gets.
//
//   node scripts/bundle-store-listing.mjs --repo . --store chrome-store/store.config.json --app myapp --version 1.2.3 --out dist/store-listing-myapp-1.2.3.zip
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkStoreAssets } from './store-assets.mjs';
import { log, main, setOutput } from './lib/gha.mjs';

const pad = (n) => String(n).padStart(2, '0');

/** { src, dest } pairs: screenshots numbered in upload order, plus the promo images. */
export function planAssets(listing) {
  const assets = listing.screenshots.map((src, i) => ({ src, dest: `screenshots/${pad(i + 1)}${extname(src)}` }));
  if (listing.promotionalImages?.smallTile) assets.push({ src: listing.promotionalImages.smallTile, dest: `promo/small-tile${extname(listing.promotionalImages.smallTile)}` });
  if (listing.promotionalImages?.marquee) assets.push({ src: listing.promotionalImages.marquee, dest: `promo/marquee${extname(listing.promotionalImages.marquee)}` });
  return assets;
}

/** LISTING.md: each field under a heading matching the Developer Dashboard's own field label. */
export function renderListingMarkdown(listing) {
  const lines = ['# Chrome Web Store listing', ''];
  const field = (label, text) => lines.push(`## ${label}`, '', text, '');
  field('Short description', listing.shortDescription);
  field('Description', listing.description);
  field('Category', listing.category);
  field('Screenshots', listing.screenshots.map((src, i) => `${pad(i + 1)}. \`screenshots/${pad(i + 1)}${extname(src)}\` (from \`${src}\`)`).join('\n'));
  if (listing.promotionalImages?.smallTile) field('Small promo tile (440x280)', `\`promo/small-tile${extname(listing.promotionalImages.smallTile)}\``);
  if (listing.promotionalImages?.marquee) field('Marquee promo tile (1400x560)', `\`promo/marquee${extname(listing.promotionalImages.marquee)}\``);
  if (listing.privacyPolicyUrl) field('Privacy policy', listing.privacyPolicyUrl);
  if (listing.supportUrl) field('Support URL', listing.supportUrl);
  if (listing.websiteUrl) field('Website', listing.websiteUrl);
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Validate the listing, then stage renamed assets + LISTING.md into `out` as a zip. */
export function bundleListing({ repo, storePath, out }) {
  const listing = checkStoreAssets({ repo, storePath });
  const manifestDir = dirname(join(repo, storePath));
  const assets = planAssets(listing);

  const stage = mkdtempSync(join(tmpdir(), 'store-listing-'));
  try {
    for (const { src, dest } of assets) {
      mkdirSync(dirname(join(stage, dest)), { recursive: true });
      cpSync(join(manifestDir, src), join(stage, dest));
    }
    writeFileSync(join(stage, 'LISTING.md'), renderListingMarkdown(listing));
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    execFileSync('zip', ['-q', '-X', '-D', '-r', target, '.'], { cwd: stage, stdio: 'inherit' });
    return { out: target, assets, listing };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function cli() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: '.' },
      store: { type: 'string' },
      out: { type: 'string' },
    },
  });
  for (const k of ['store', 'out']) if (!values[k]) throw new Error(`--${k} is required`);
  const result = bundleListing({ repo: values.repo, storePath: values.store, out: values.out });
  log(`Bundled ${result.assets.length} asset(s) + LISTING.md -> ${values.out}`);
  setOutput('zip', result.out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
