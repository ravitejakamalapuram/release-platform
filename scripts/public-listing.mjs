// Post-review check of the PUBLIC store pages (APP-296). The Play API read-back (play.mjs
// verify-listing) proves what Play accepted; only the public page proves what users see after
// review. Chrome has no listing read API at all, so the public page is its only source of truth.
//
// What is compared (image bytes cannot be: both stores re-encode them to googleusercontent URLs):
//   Play:   title, sha256 of the normalised full description, screenshot count, per bundle locale
//   Chrome: sha256 of the normalised detailed description, screenshot count
// A page that cannot be parsed is VERIFIER_BROKEN - never a pass.
//
// Pure functions (parse, diff, plan) take strings and dates; the network and `gh` are injected.
import { createHash } from 'node:crypto';

export const REVIEW_SLA_DAYS = 7;
export const COMMITTED_LABEL = 'listing-committed';
export const VERIFIED_LABEL = 'listing-verified';
const DAY_MS = 24 * 60 * 60 * 1000;

export class VerifierBroken extends Error {}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * One form for repo text and page HTML: line breaks and paragraphs become spaces, tags are dropped
 * (Play renders <b>/<i>/<u> from the listing text), entities decoded, whitespace collapsed.
 */
export function normaliseText(s) {
  return decode(String(s ?? '').replace(/<br\s*\/?>|<\/p>\s*<p[^>]*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export const textHash = (s) => createHash('sha256').update(normaliseText(s), 'utf8').digest('hex');
const short = (h) => h.slice(0, 12);

/**
 * Inner HTML of the first <div> whose opening tag matches `open`, balancing nested divs (a
 * non-greedy match to the first </div> would cut the text at a nested div). undefined if absent.
 */
export function divInner(html, open) {
  const start = html.search(open);
  if (start < 0) return undefined;
  const from = html.indexOf('>', start) + 1;
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = from;
  let depth = 1;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return undefined;
}

function need(value, what, page) {
  if (value === undefined || value === null || value === '') throw new VerifierBroken(`VERIFIER_BROKEN: ${page}: ${what} not found in the page markup`);
  return value;
}

/** Parse play.google.com/store/apps/details. Throws VerifierBroken when any part is missing. */
export function parsePlayPage(html, pkg) {
  const page = `Play page for ${pkg}`;
  const canonical = need(html.match(/<link rel="canonical" href="([^"]*)"/)?.[1], 'canonical link', page);
  if (!decode(canonical).includes(`id=${pkg}`)) throw new VerifierBroken(`VERIFIER_BROKEN: ${page}: the page is for ${decode(canonical)}`);
  const title = need(html.match(/<h1[^>]*>\s*<span[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/)?.[1], 'title (h1 itemprop=name)', page);
  const description = need(divInner(html, /<div[^>]*data-g-id="description"/), 'description (data-g-id=description)', page);
  // The carousel repeats each screenshot once per form factor (the live InvTrack page has 15 slots
  // for 5 images), so count distinct images: the src without its =wNNN-hNNN size suffix.
  const shots = new Set([...html.matchAll(/<img[^>]*alt="Screenshot image"[^>]*>/g)].map((m) => m[0].match(/\ssrc="([^"=]+)/)?.[1]).filter(Boolean));
  // Play refuses to publish a listing with fewer than 2 screenshots: 0 means the markup changed.
  need(shots.size || '', 'screenshots (img alt="Screenshot image" src)', page);
  return { title: normaliseText(title), descriptionHash: textHash(description), descriptionLength: normaliseText(description).length, screenshots: shots.size };
}

/** Parse chromewebstore.google.com/detail. The overview's first <p> is the summary, the rest the description. */
export function parseChromePage(html, itemId) {
  const page = `Chrome Web Store page for ${itemId}`;
  const canonical = need(html.match(/<link rel="canonical" href="([^"]*)"/)?.[1], 'canonical link', page);
  if (!canonical.endsWith(`/${itemId}`)) throw new VerifierBroken(`VERIFIER_BROKEN: ${page}: the page is for ${canonical}`);
  const overview = need(divInner(html, /<div jsname="ij8cu"/), 'overview (div jsname=ij8cu)', page);
  const paras = [...overview.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  if (paras.length < 2) throw new VerifierBroken(`VERIFIER_BROKEN: ${page}: overview has ${paras.length} paragraph(s), expected summary + description`);
  const description = paras.slice(1).join('\n');
  const shots = new Set([...html.matchAll(/Item media (\d+) \(screenshot\)/g)].map((m) => m[1]));
  need(shots.size || '', 'screenshots (Item media N (screenshot))', page);
  return { descriptionHash: textHash(description), descriptionLength: normaliseText(description).length, screenshots: shots.size };
}

const descLine = (prefix, want, got) => `${prefix}description differs (repo ${normaliseText(want).length} chars sha256 ${short(textHash(want))}, page ${got.descriptionLength} chars sha256 ${short(got.descriptionHash)})`;

/** Play: one line per difference between a bundle locale and its parsed public page. */
export function diffPlayPage(loc, page) {
  const out = [];
  const p = `${loc.language}: public `;
  if (normaliseText(loc.title) !== page.title) out.push(`${p}title differs (repo "${normaliseText(loc.title)}", page "${page.title}")`);
  if (textHash(loc.fullDescription) !== page.descriptionHash) out.push(descLine(p, loc.fullDescription, page));
  // The public carousel shows every screenshot type of the listing in one strip.
  const want = Object.entries(loc.images ?? {}).filter(([t]) => t.endsWith('Screenshots')).reduce((n, [, list]) => n + list.length, 0);
  if (want !== page.screenshots) out.push(`${p}screenshot count differs (repo ${want}, page ${page.screenshots})`);
  return out;
}

/** Chrome: one line per difference between the manifest and the parsed public page. */
export function diffChromePage(manifest, page) {
  const out = [];
  if (textHash(manifest.text.description) !== page.descriptionHash) out.push(descLine('public ', manifest.text.description, page));
  if (manifest.screenshots.length !== page.screenshots) out.push(`public screenshot count differs (repo ${manifest.screenshots.length}, page ${page.screenshots})`);
  return out;
}

export const playPageUrl = (pkg, lang) => `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=${encodeURIComponent(lang)}`;
export const chromePageUrl = (itemId, lang) => `https://chromewebstore.google.com/detail/${encodeURIComponent(itemId)}${lang ? `?hl=${encodeURIComponent(lang)}` : ''}`;

/**
 * GET a public page. null = not public (a real difference): HTTP 404, or the Chrome Web Store's
 * empty shell (it answers 200 and redirects an unpublished item to /detail/empty-title/<id>).
 * Any other failure = VERIFIER_BROKEN.
 */
export async function fetchPage(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'accept-language': 'en-US,en;q=0.8' } });
  } catch (err) {
    throw new VerifierBroken(`VERIFIER_BROKEN: GET ${url} failed: ${err.message}`);
  }
  if (/^https?:\/\/consent\.(google|youtube)\.[a-z.]+\//.test(res.url ?? '')) throw new VerifierBroken(`VERIFIER_BROKEN: GET ${url} was redirected to a Google consent page (${res.url.split('?')[0]}): the runner's region gets a cookie wall instead of the store page, so nothing was checked`);
  if (res.status === 404 || /\/detail\/empty-title\//.test(res.url ?? '')) return null;
  if (!res.ok) throw new VerifierBroken(`VERIFIER_BROKEN: GET ${url} returned HTTP ${res.status}`);
  const html = await res.text();
  if (/<form[^>]+action="https:\/\/consent\.(google|youtube)\./.test(html)) throw new VerifierBroken(`VERIFIER_BROKEN: GET ${url} returned a Google consent page instead of the store page (the runner's region gets a cookie wall), so nothing was checked`);
  return html;
}

/**
 * Compare every locale of a Play bundle with its public page.
 * Returns { outcome: 'verified'|'differs'|'broken', mismatches }.
 */
export async function checkPlayPublic({ bundle, fetchImpl = fetch }) {
  const mismatches = [];
  try {
    for (const loc of bundle.locales ?? []) {
      const html = await fetchPage(playPageUrl(bundle.package, loc.language), fetchImpl);
      if (html === null) mismatches.push(`${loc.language}: public page not found (HTTP 404) - the app is not public`);
      else mismatches.push(...diffPlayPage(loc, parsePlayPage(html, bundle.package)));
    }
  } catch (err) {
    if (err instanceof VerifierBroken) return { outcome: 'broken', mismatches: [err.message] };
    throw err;
  }
  return { outcome: mismatches.length ? 'differs' : 'verified', mismatches };
}

export async function checkChromePublic({ manifest, fetchImpl = fetch }) {
  try {
    const html = await fetchPage(chromePageUrl(manifest.item_id, manifest.text.language), fetchImpl);
    if (html === null) return { outcome: 'differs', mismatches: ['public page not found (404 or the store empty page) - the item is not public'] };
    const mismatches = diffChromePage(manifest, parseChromePage(html, manifest.item_id));
    return { outcome: mismatches.length ? 'differs' : 'verified', mismatches };
  } catch (err) {
    if (err instanceof VerifierBroken) return { outcome: 'broken', mismatches: [err.message] };
    throw err;
  }
}

export const overdue = (since, now, days = REVIEW_SLA_DAYS) => now.getTime() - new Date(since).getTime() > days * DAY_MS;

// ---- Play: the `listing-committed` record. One issue per package+fingerprint, opened by the bot
// on the first run whose API read-back verified that fingerprint (= Play committed it), closed by
// the bot (label listing-verified) once the public page matches. Its marker dates the review clock.
export const committedMarker = (pkg, fp) => `<!-- listing-committed: ${pkg} ${fp} `;
export const parseCommitted = (body) => {
  const m = (body ?? '').match(/<!-- listing-committed: (\S+) (\S+) (\S+) -->/);
  return m ? { pkg: m[1], fingerprint: m[2], date: m[3] } : null;
};

/**
 * Decide what to do with the record for (pkg, fp) given the repo's listing-committed issues
 * (state all). Returns { action: 'create'|'check'|'done', issue?, since, superseded: [numbers] }.
 */
export function planCommitted({ pkg, fingerprint, issues, now }) {
  const mine = issues.map((i) => ({ ...i, rec: parseCommitted(i.body) })).filter((i) => i.rec?.pkg === pkg);
  const same = mine.find((i) => i.rec.fingerprint === fingerprint);
  const superseded = mine.filter((i) => i !== same && i.state === 'OPEN').map((i) => i.number);
  if (!same) return { action: 'create', since: now.toISOString(), superseded };
  const verified = (same.labels ?? []).some((l) => (l.name ?? l) === VERIFIED_LABEL);
  if (same.state !== 'OPEN' && verified) return { action: 'done', issue: same.number, since: same.rec.date, superseded };
  return { action: 'check', issue: same.number, since: same.rec.date, superseded };
}

/**
 * Turn the public check into the outcome for the package's listing-verify issue. Before the review
 * SLA a difference is only "pending" (review may still be running); after it, it is a mismatch.
 * VERIFIER_BROKEN is loud at any age.
 */
export function publicVerdict({ check, since, now }) {
  if (check.outcome === 'broken') return { outcome: 'broken', state: 'broken', mismatches: check.mismatches };
  if (check.outcome === 'verified') return { outcome: 'verified', state: 'verified', mismatches: [] };
  if (!overdue(since, now)) return { outcome: 'verified', state: 'pending', mismatches: check.mismatches };
  return { outcome: 'mismatch', state: 'overdue', mismatches: check.mismatches };
}

// ---- Chrome: a person closing the store-listing checklist means "submitted", not "done".
/**
 * `issue` is the checklist issue carrying this manifest's fingerprint ({ number, state, closedAt,
 * labels }) or undefined. Returns what the run must do before any page is fetched:
 * 'no-checklist' | 'awaiting-submission' | 'recheck' (confirmed before: re-checked daily so later
 * drift is caught) | 'check'.
 */
export function planChromeVerify(issue) {
  if (!issue) return 'no-checklist';
  const labels = (issue.labels ?? []).map((l) => l.name ?? l);
  if (labels.includes(VERIFIED_LABEL)) return 'recheck';
  if (issue.state === 'OPEN' && !labels.includes('listing-verify')) return 'awaiting-submission';
  return 'check';
}

/**
 * Given the check result: 'verify' (label listing-verified; close if the bot had reopened it),
 * 'still-verified' (a recheck that still matches: nothing to write), 'drift' (it matched before and
 * no longer does: reopen at once, no review grace), 'pending', 'reopen' (overdue: reopen with the
 * diff + listing-verify label), 'still-open' (already reopened, still differs), or 'broken'.
 * `failed` = the run must exit non-zero.
 */
export function chromeVerdict({ issue, check, now }) {
  const confirmed = (issue.labels ?? []).some((l) => (l.name ?? l) === VERIFIED_LABEL);
  if (check.outcome === 'broken') return { action: 'broken', failed: true };
  if (check.outcome === 'verified') return { action: confirmed ? 'still-verified' : 'verify', failed: false };
  if (confirmed) return { action: 'drift', failed: true };
  if (issue.state === 'OPEN') return { action: 'still-open', failed: true };
  if (!overdue(issue.closedAt, now)) return { action: 'pending', failed: false };
  return { action: 'reopen', failed: true };
}
