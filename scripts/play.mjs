#!/usr/bin/env node
// Google Play Android Publisher API v3 client (edits flow).
// Docs: https://developers.google.com/android-publisher/api-ref/rest/v3/edits
//
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs upload   --package com.x --aab app.aab --track internal --version 1.2.3 --version-code 1002003 [--notes-file n.txt] [--status completed]
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs promote  --package com.x --from internal --to production [--fraction 0.2]
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs rollout  --package com.x --track production --fraction 0.5
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs halt     --package com.x --track production
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs complete --package com.x --track production
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs tracks   --package com.x
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs preflight --package com.x --version-code 1002003   (read-only)
//   GOOGLE_ACCESS_TOKEN=... node scripts/play.mjs listing  --package com.x --bundle listings/android-0 [--dry-run]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ApiError, request } from './lib/http.mjs';
import { log, main, requireEnv, setOutput, warning } from './lib/gha.mjs';

export const API = 'https://androidpublisher.googleapis.com';
const app = (pkg) => `${API}/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`;

export const urls = {
  insert: (pkg) => `${app(pkg)}/edits`,
  edit: (pkg, id) => `${app(pkg)}/edits/${encodeURIComponent(id)}`,
  bundles: (pkg, id) => `${API}/upload/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/edits/${encodeURIComponent(id)}/bundles?uploadType=media`,
  tracks: (pkg, id) => `${app(pkg)}/edits/${encodeURIComponent(id)}/tracks`,
  track: (pkg, id, track) => `${app(pkg)}/edits/${encodeURIComponent(id)}/tracks/${encodeURIComponent(track)}`,
  listing: (pkg, id, lang) => `${app(pkg)}/edits/${encodeURIComponent(id)}/listings/${encodeURIComponent(lang)}`,
  images: (pkg, id, lang, type) => `${app(pkg)}/edits/${encodeURIComponent(id)}/listings/${encodeURIComponent(lang)}/${encodeURIComponent(type)}`,
  imageUpload: (pkg, id, lang, type) =>
    `${API}/upload/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/edits/${encodeURIComponent(id)}/listings/${encodeURIComponent(lang)}/${encodeURIComponent(type)}?uploadType=media`,
  commit: (pkg, id, notForReview) => `${app(pkg)}/edits/${encodeURIComponent(id)}:commit${notForReview ? '?changesNotSentForReview=true' : ''}`,
};

export class StoreError extends Error {}

/** True when Play refuses a commit because the app requires manual "Send for review". */
export function needsManualReview(err) {
  return /changesNotSentForReview|cannot be sent for review automatically/i.test(err?.message ?? '');
}

export function explainPlayError(err, pkg) {
  const msg = err?.message ?? String(err);
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return new StoreError(
      `Not authorized for ${pkg} (HTTP ${err.status}). Invite release-bot@rk-release-platform.iam.gserviceaccount.com in Play Console ` +
        `(Users and permissions) with release permissions for this app. Details: ${msg}`,
    );
  }
  if (/version code .* has already been used|APK specifies a version code that has already been used/i.test(msg)) {
    return new StoreError(`Play already has this versionCode for ${pkg}. Bump the version (a new v* tag) and re-run. Details: ${msg}`);
  }
  if (/Only releases with status draft may be created on draft app/i.test(msg)) {
    return new StoreError(`${pkg} is still a draft app in Play Console; set \`release_status: draft\` on the android target until the first release is published manually. Details: ${msg}`);
  }
  if (/signed with the wrong key|upload key/i.test(msg)) {
    return new StoreError(`The bundle is signed with a key Play does not expect for ${pkg}. Check the keystore secrets. Details: ${msg}`);
  }
  return err;
}

/**
 * Wraps one edit: insert -> fn(editId) -> commit (or delete on failure / when readOnly).
 * Commit falls back to changesNotSentForReview=true when Play demands it. `commitIf(result)`
 * returning false discards the edit instead (nothing changed, so nothing is sent for review).
 */
export async function withEdit({ pkg, token, fetchImpl, readOnly = false, commitIf }, fn) {
  const { id } = await request({ method: 'POST', url: urls.insert(pkg), token, json: {}, fetchImpl }).catch((err) => {
    throw explainPlayError(err, pkg);
  });
  let result;
  try {
    result = await fn(id);
  } catch (err) {
    await discard({ pkg, token, fetchImpl, id });
    throw explainPlayError(err, pkg);
  }
  if (readOnly || (commitIf && !commitIf(result))) {
    await discard({ pkg, token, fetchImpl, id });
    return { result, commit: null };
  }
  const commit = await commitEdit({ pkg, token, fetchImpl, id });
  return { result, commit };
}

async function discard({ pkg, token, fetchImpl, id }) {
  await request({ method: 'DELETE', url: urls.edit(pkg, id), token, fetchImpl }).catch(() => {});
}

export async function commitEdit({ pkg, token, fetchImpl, id }) {
  try {
    const res = await request({ method: 'POST', url: urls.commit(pkg, id, false), token, fetchImpl });
    return { ...res, sentForReview: true };
  } catch (err) {
    if (!needsManualReview(err)) {
      await discard({ pkg, token, fetchImpl, id });
      throw explainPlayError(err, pkg);
    }
    const res = await request({ method: 'POST', url: urls.commit(pkg, id, true), token, fetchImpl }).catch((e) => {
      throw explainPlayError(e, pkg);
    });
    return { ...res, sentForReview: false };
  }
}

export function buildRelease({ name, versionCodes, status = 'completed', userFraction, releaseNotes }) {
  const release = { name, versionCodes: versionCodes.map(String), status };
  if (status === 'inProgress' || status === 'halted') {
    if (!(userFraction > 0 && userFraction < 1)) throw new Error(`A ${status} rollout needs a user fraction between 0 and 1 (exclusive)`);
    release.userFraction = userFraction;
  }
  if (releaseNotes?.length) release.releaseNotes = releaseNotes;
  return release;
}

export function parseFraction(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!(n > 0 && n <= 1)) throw new Error(`user fraction must be in (0, 1], got "${value}"`);
  return n;
}

const codeOf = (r) => Math.max(0, ...(r.versionCodes ?? []).map(Number));

/** The release on a track that carries the newest version codes (optionally filtered by status). */
export function latestRelease(track, statuses) {
  const releases = (track?.releases ?? []).filter((r) => !statuses || statuses.includes(r.status));
  return releases.sort((a, b) => codeOf(b) - codeOf(a))[0] ?? null;
}

/** Highest versionCode on any track (and which track holds it). */
export function maxVersionCode(tracks) {
  let best = { code: 0, track: null };
  for (const t of tracks) for (const r of t.releases ?? []) for (const c of r.versionCodes ?? []) {
    if (Number(c) > best.code) best = { code: Number(c), track: t.track };
  }
  return best;
}

/** Throw unless versionCode is higher than every code already on any track. */
export function checkVersionCode(tracks, versionCode, pkg) {
  const highest = maxVersionCode(tracks);
  if (Number(versionCode) <= highest.code) {
    throw new StoreError(
      `versionCode ${versionCode} is not higher than ${highest.code} already on the "${highest.track}" track of ${pkg}. ` +
        'Create a v* tag at or above that version (versionCode = MAJOR*1000000 + MINOR*1000 + PATCH) or pass a bigger bump, then re-run.',
    );
  }
  return highest;
}

/** Read-only check used by dry runs: the same versionCode rule uploadBundle enforces. */
export async function preflight({ pkg, token, fetchImpl, versionCode }) {
  const tracks = await listTracks({ pkg, token, fetchImpl });
  return { highest: checkVersionCode(tracks, versionCode, pkg), tracks };
}

export async function uploadBundle({ pkg, token, fetchImpl, aab, track, versionName, versionCode, status = 'completed', notes }) {
  return withEdit({ pkg, token, fetchImpl }, async (id) => {
    if (versionCode !== undefined) {
      const { tracks = [] } = await request({ method: 'GET', url: urls.tracks(pkg, id), token, fetchImpl });
      checkVersionCode(tracks, versionCode, pkg);
    }
    const bundle = await request({ method: 'POST', url: urls.bundles(pkg, id), token, body: aab, contentType: 'application/octet-stream', fetchImpl });
    if (versionCode !== undefined && Number(bundle.versionCode) !== Number(versionCode)) {
      throw new StoreError(
        `The bundle has versionCode ${bundle.versionCode}, expected ${versionCode}. Make the app read -PversionCode/-PversionName (see README "Gradle snippet").`,
      );
    }
    const releaseNotes = notes ? [{ language: 'en-US', text: notes }] : undefined;
    const release = buildRelease({ name: versionName, versionCodes: [bundle.versionCode], status, releaseNotes });
    await request({ method: 'PUT', url: urls.track(pkg, id, track), token, json: { track, releases: [release] }, fetchImpl });
    return { versionCode: bundle.versionCode, track, status };
  });
}

export async function promote({ pkg, token, fetchImpl, from, to, fraction }) {
  if (from === to) throw new Error('from and to tracks must differ');
  return withEdit({ pkg, token, fetchImpl }, async (id) => {
    const source = await request({ method: 'GET', url: urls.track(pkg, id, from), token, fetchImpl });
    const rel = latestRelease(source, ['completed', 'inProgress']);
    if (!rel) throw new StoreError(`Track "${from}" of ${pkg} has no completed or in-progress release to promote`);
    const staged = fraction !== undefined && fraction < 1;
    const release = buildRelease({
      name: rel.name,
      versionCodes: rel.versionCodes,
      status: staged ? 'inProgress' : 'completed',
      userFraction: staged ? fraction : undefined,
      releaseNotes: rel.releaseNotes,
    });
    await request({ method: 'PUT', url: urls.track(pkg, id, to), token, json: { track: to, releases: [release] }, fetchImpl });
    return { name: rel.name, versionCodes: release.versionCodes, track: to, status: release.status, userFraction: release.userFraction };
  });
}

/** Change the in-progress (or halted) rollout on a track: rollout (new fraction), halt, or complete. */
export async function changeRollout({ pkg, token, fetchImpl, track, action, fraction }) {
  return withEdit({ pkg, token, fetchImpl }, async (id) => {
    const current = await request({ method: 'GET', url: urls.track(pkg, id, track), token, fetchImpl });
    const wanted = action === 'halt' ? ['inProgress'] : ['inProgress', 'halted'];
    const rel = latestRelease(current, wanted);
    if (!rel) throw new StoreError(`Track "${track}" of ${pkg} has no ${wanted.join(' or ')} release to ${action}`);

    let updated;
    if (action === 'halt') updated = { ...rel, status: 'halted' };
    else if (action === 'complete' || fraction === 1) {
      const { userFraction: _drop, ...rest } = rel;
      updated = { ...rest, status: 'completed' };
    } else if (action === 'rollout') {
      if (fraction === undefined) throw new Error('rollout needs a user fraction');
      if (rel.status === 'inProgress' && fraction <= (rel.userFraction ?? 0)) {
        throw new Error(`New fraction ${fraction} must be higher than the current ${rel.userFraction}`);
      }
      updated = { ...rel, status: 'inProgress', userFraction: fraction };
    } else throw new Error(`Unknown rollout action "${action}"`);

    const others = (current.releases ?? []).filter((r) => r !== rel);
    await request({ method: 'PUT', url: urls.track(pkg, id, track), token, json: { track, releases: [...others, updated] }, fetchImpl });
    return { name: updated.name, versionCodes: updated.versionCodes, track, status: updated.status, userFraction: updated.userFraction };
  });
}

const LISTING_TEXT = ['title', 'shortDescription', 'fullDescription', 'video'];

/**
 * Make the Play store listing match a bundle from scripts/listing.mjs (listing.json + files).
 * Per locale: update the text if it differs; for each image type the bundle has, replace the
 * images only when the ordered sha256 list differs from what Play has. Image types the bundle
 * does not mention are left alone. Commits only when something changed; dryRun only reports.
 */
export async function syncListing({ pkg, token, fetchImpl, bundle, readFile, dryRun = false }) {
  const changes = [];
  const { commit } = await withEdit({ pkg, token, fetchImpl, readOnly: dryRun, commitIf: () => changes.length > 0 }, async (id) => {
    for (const loc of bundle.locales) {
      const current = await request({ url: urls.listing(pkg, id, loc.language), token, fetchImpl }).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      });
      const want = { language: loc.language, title: loc.title, shortDescription: loc.shortDescription, fullDescription: loc.fullDescription };
      if (loc.video) want.video = loc.video;
      const textChanged = !current || LISTING_TEXT.some((k) => k in want && (current[k] ?? '') !== want[k]);
      if (textChanged) {
        changes.push(`${loc.language}: ${current ? 'text updated' : 'listing created'}`);
        if (!dryRun) await request({ method: 'PUT', url: urls.listing(pkg, id, loc.language), token, json: want, fetchImpl });
      }
      for (const [type, images] of Object.entries(loc.images ?? {})) {
        const { images: live = [] } = await request({ url: urls.images(pkg, id, loc.language, type), token, fetchImpl });
        const same = live.length === images.length && live.every((img, i) => img.sha256 === images[i].sha256);
        if (same) continue;
        changes.push(`${loc.language}: ${type} (${live.length} -> ${images.length})`);
        if (dryRun) continue;
        await request({ method: 'DELETE', url: urls.images(pkg, id, loc.language, type), token, fetchImpl });
        for (const img of images) {
          await request({ method: 'POST', url: urls.imageUpload(pkg, id, loc.language, type), token, body: readFile(img.file), contentType: img.contentType, fetchImpl });
        }
      }
    }
    return { changes };
  });
  return { changes, commit };
}

/** Read-only: list all tracks (edit is always deleted, never committed). */
export async function listTracks({ pkg, token, fetchImpl }) {
  const { result } = await withEdit({ pkg, token, fetchImpl, readOnly: true }, (id) => request({ method: 'GET', url: urls.tracks(pkg, id), token, fetchImpl }));
  return result.tracks ?? [];
}

export function describeTracks(tracks) {
  return tracks
    .filter((t) => (t.releases ?? []).length)
    .map((t) => {
      const rels = t.releases.map((r) => `${r.name ?? r.versionCodes?.join('/')} ${r.status}${r.userFraction ? ` ${Math.round(r.userFraction * 100)}%` : ''}`);
      return `${t.track}: ${rels.join(', ')}`;
    });
}

function reportCommit(commit) {
  if (commit && !commit.sentForReview) {
    warning('Play could not send these changes for review automatically. Open Play Console > Publishing overview and click "Send changes for review".');
  }
  return commit?.sentForReview === false ? 'COMMITTED_NOT_SENT_FOR_REVIEW' : 'COMMITTED';
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      package: { type: 'string' },
      aab: { type: 'string' },
      track: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      fraction: { type: 'string' },
      version: { type: 'string' },
      'version-code': { type: 'string' },
      'notes-file': { type: 'string' },
      bundle: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      status: { type: 'string', default: 'completed' },
    },
  });
  const pkg = values.package;
  if (!pkg) throw new Error('--package is required');
  const token = requireEnv('GOOGLE_ACCESS_TOKEN');
  const fraction = parseFraction(values.fraction);

  let out;
  switch (command) {
    case 'upload': {
      if (!values.aab || !values.track || !values.version) throw new Error('--aab, --track and --version are required');
      const notes = values['notes-file'] ? readFileSync(values['notes-file'], 'utf8').trim() : '';
      const { result, commit } = await uploadBundle({
        pkg, token, aab: readFileSync(values.aab), track: values.track, versionName: values.version,
        versionCode: values['version-code'], status: values.status, notes,
      });
      out = `${reportCommit(commit)}: ${pkg} ${values.version} (versionCode ${result.versionCode}) -> ${result.track} [${result.status}]`;
      break;
    }
    case 'promote': {
      const { result, commit } = await promote({ pkg, token, from: values.from ?? 'internal', to: values.to ?? 'production', fraction });
      out = `${reportCommit(commit)}: ${pkg} ${result.name} -> ${result.track} [${result.status}${result.userFraction ? ` ${result.userFraction * 100}%` : ''}]`;
      break;
    }
    case 'rollout':
    case 'halt':
    case 'complete': {
      const { result, commit } = await changeRollout({ pkg, token, track: values.track ?? 'production', action: command, fraction });
      out = `${reportCommit(commit)}: ${pkg} ${result.name} on ${result.track} [${result.status}${result.userFraction ? ` ${result.userFraction * 100}%` : ''}]`;
      break;
    }
    case 'preflight': {
      if (!values['version-code']) throw new Error('--version-code is required');
      // Opens an edit (proves release-bot can access the app), lists tracks, deletes the edit.
      const { highest, tracks } = await preflight({ pkg, token, versionCode: values['version-code'] });
      log(`Access OK: opened and discarded an edit for ${pkg}`);
      for (const line of describeTracks(tracks)) log(`  ${line}`);
      out = `PREFLIGHT_OK: versionCode ${values['version-code']} > ${highest.code}${highest.track ? ` (highest, on ${highest.track})` : ' (no releases yet)'}`;
      break;
    }
    case 'listing': {
      if (!values.bundle) throw new Error('--bundle (a directory made by scripts/listing.mjs bundle) is required');
      const bundle = JSON.parse(readFileSync(join(values.bundle, 'listing.json'), 'utf8'));
      if (bundle.package !== pkg) throw new Error(`Bundle is for ${bundle.package}, not ${pkg}`);
      const dryRun = values['dry-run'];
      const { changes, commit } = await syncListing({ pkg, token, bundle, dryRun, readFile: (f) => readFileSync(join(values.bundle, f)) });
      for (const c of changes) log(`  ${c}`);
      if (!changes.length) out = `LISTING_UNCHANGED: ${pkg} already matches the repo (fingerprint ${bundle.fingerprint})`;
      else if (dryRun) out = `LISTING_WOULD_CHANGE (dry run): ${pkg} ${changes.length} change(s)`;
      else out = `LISTING_${reportCommit(commit)}: ${pkg} ${changes.length} change(s)`;
      break;
    }
    case 'tracks': {
      const lines = describeTracks(await listTracks({ pkg, token }));
      out = lines.length ? lines.join('\n') : '(no releases on any track)';
      break;
    }
    default:
      throw new Error(`Unknown command "${command}" (expected upload|preflight|promote|rollout|halt|complete|tracks|listing)`);
  }
  log(out);
  setOutput('result', out.split('\n')[0]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
