#!/usr/bin/env node
// Chrome Web Store API v2 client (upload -> publish -> fetchStatus).
// Docs: https://developer.chrome.com/docs/webstore/api
//
//   GOOGLE_ACCESS_TOKEN=... node scripts/cws.mjs release --publisher <id> --item <id> --zip x.zip --version 1.2.3
//   GOOGLE_ACCESS_TOKEN=... node scripts/cws.mjs status  --publisher <id> --item <id>
//   GOOGLE_ACCESS_TOKEN=... node scripts/cws.mjs preflight --publisher <id> --item <id> --version 1.2.3   (read-only)
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ApiError, request } from './lib/http.mjs';
import { log, main, requireEnv, setOutput, summary, warning } from './lib/gha.mjs';
import { compareParts } from './version.mjs';

export const API = 'https://chromewebstore.googleapis.com';
const itemName = (publisher, item) => `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;

export const urls = {
  upload: (p, i) => `${API}/upload/v2/${itemName(p, i)}:upload`,
  publish: (p, i) => `${API}/v2/${itemName(p, i)}:publish`,
  status: (p, i) => `${API}/v2/${itemName(p, i)}:fetchStatus`,
};

const IN_PROGRESS = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const PUBLISH_OK = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

export class StoreError extends Error {}

/** Turn raw CWS failures into actionable messages. */
export function explainCwsError(err, item) {
  const msg = err?.message ?? String(err);
  if (/not updatable|ITEM_NOT_UPDATABLE|pending review|in review|under review/i.test(msg)) {
    return new StoreError(
      `Chrome Web Store refused the upload for ${item} because a previous version is still in review. ` +
        `Wait for the review to finish (or cancel the pending submission in the Developer Dashboard) and re-run this job. Details: ${msg}`,
    );
  }
  if (/version/i.test(msg) && /(greater|higher|larger|already|must be)/i.test(msg)) {
    return new StoreError(`Chrome Web Store rejected the manifest version for ${item}: it must be higher than any version uploaded before. Details: ${msg}`);
  }
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return new StoreError(
      `Not authorized for item ${item} (HTTP ${err.status}). Check that the release-bot service account is added to the ` +
        `Chrome Web Store publisher and that the item belongs to that publisher. Details: ${msg}`,
    );
  }
  return err;
}

export async function fetchStatus({ publisher, item, token, fetchImpl }) {
  return request({ method: 'GET', url: urls.status(publisher, item), token, fetchImpl });
}

/** Refuse early when the store cannot accept this version (in review, or version not higher). */
export function preflight(status, version, item) {
  const submitted = status?.submittedItemRevisionStatus;
  if (submitted?.state === 'PENDING_REVIEW') {
    throw new StoreError(
      `Chrome Web Store item ${item} already has a submission in review (${channelVersions(submitted) || 'unknown version'}). ` +
        'A new version cannot be uploaded until that review completes or is cancelled in the Developer Dashboard.',
    );
  }
  const known = [status?.publishedItemRevisionStatus, submitted].flatMap((r) => (r?.distributionChannels ?? []).map((c) => c.crxVersion)).filter(Boolean);
  const wanted = version.split('.').map(Number);
  const tooLow = known.find((v) => compareParts(wanted, v.split('.').map(Number)) <= 0);
  if (tooLow) {
    throw new StoreError(
      `Version ${version} is not higher than ${tooLow} already on the Chrome Web Store for ${item}. ` +
        'Create a v* tag at or above the store version (or pass bump: minor/major) and re-run.',
    );
  }
}

function channelVersions(rev) {
  return (rev?.distributionChannels ?? []).map((c) => `${c.crxVersion} @ ${c.deployPercentage ?? 100}%`).join(', ');
}

export async function upload({ publisher, item, token, zip, fetchImpl, sleep = defaultSleep, pollMs = 5000, maxPolls = 60 }) {
  let res;
  try {
    res = await request({ method: 'POST', url: urls.upload(publisher, item), token, body: zip, contentType: 'application/zip', fetchImpl });
  } catch (err) {
    throw explainCwsError(err, item);
  }
  let state = res.uploadState;
  for (let i = 0; IN_PROGRESS.has(state) && i < maxPolls; i++) {
    await sleep(pollMs);
    const status = await fetchStatus({ publisher, item, token, fetchImpl });
    state = status.lastAsyncUploadState;
    if (state === 'SUCCEEDED') res = { ...res, uploadState: state, crxVersion: res.crxVersion ?? latestSubmittedVersion(status) };
  }
  if (state !== 'SUCCEEDED') {
    const detail = IN_PROGRESS.has(state) ? 'still processing after polling timed out' : `upload state ${state ?? 'missing'}`;
    throw explainCwsError(new StoreError(`Chrome Web Store upload for ${item} did not succeed: ${detail}. Response: ${JSON.stringify(res)}`), item);
  }
  return res;
}

function latestSubmittedVersion(status) {
  return status?.submittedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
}

export async function publish({ publisher, item, token, fetchImpl }) {
  let res;
  try {
    res = await request({ method: 'POST', url: urls.publish(publisher, item), token, json: { publishType: 'DEFAULT_PUBLISH' }, fetchImpl });
  } catch (err) {
    throw explainCwsError(err, item);
  }
  if (!PUBLISH_OK.has(res.state)) {
    throw new StoreError(`Chrome Web Store did not accept the submission for ${item}: state ${res.state ?? 'missing'}. Response: ${JSON.stringify(res)}`);
  }
  return res;
}

/** Full release: preflight -> upload -> publish (optional) -> status. */
export async function release({ publisher, item, token, zip, version, submit = true, fetchImpl, sleep, pollMs }) {
  const before = await fetchStatus({ publisher, item, token, fetchImpl }).catch((err) => {
    throw explainCwsError(err, item);
  });
  preflight(before, version, item);
  const uploaded = await upload({ publisher, item, token, zip, fetchImpl, sleep, pollMs });
  if (uploaded.crxVersion && uploaded.crxVersion !== version) {
    throw new StoreError(`Uploaded package reports version ${uploaded.crxVersion}, expected ${version}`);
  }
  const published = submit ? await publish({ publisher, item, token, fetchImpl }) : null;
  const after = await fetchStatus({ publisher, item, token, fetchImpl });
  return { uploaded, published, status: after };
}

export function describeStatus(status) {
  const rev = (r) => (r ? `${r.state ?? '?'}${channelVersions(r) ? ` (${channelVersions(r)})` : ''}` : '-');
  return {
    published: rev(status?.publishedItemRevisionStatus),
    submitted: rev(status?.submittedItemRevisionStatus),
    lastUpload: status?.lastAsyncUploadState ?? '-',
    flags: [status?.takenDown && 'TAKEN DOWN', status?.warned && 'WARNED'].filter(Boolean).join(', '),
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      publisher: { type: 'string' },
      item: { type: 'string' },
      zip: { type: 'string' },
      version: { type: 'string' },
      'no-publish': { type: 'boolean', default: false },
    },
  });
  const publisher = values.publisher ?? process.env.CWS_PUBLISHER_ID;
  const { item } = values;
  if (!publisher || !item) throw new Error('--publisher (or CWS_PUBLISHER_ID) and --item are required');
  const token = requireEnv('GOOGLE_ACCESS_TOKEN');

  if (command === 'status') {
    const d = describeStatus(await fetchStatus({ publisher, item, token }));
    log(`published: ${d.published}\nsubmitted: ${d.submitted}\nlast upload: ${d.lastUpload}${d.flags ? `\nflags: ${d.flags}` : ''}`);
    setOutput('status', JSON.stringify(d));
    return;
  }
  if (command === 'preflight') {
    if (!values.version) throw new Error('--version is required for preflight');
    const status = await fetchStatus({ publisher, item, token }).catch((err) => {
      throw explainCwsError(err, item);
    });
    const d = describeStatus(status);
    log(`published: ${d.published}\nsubmitted: ${d.submitted}`);
    preflight(status, values.version, item);
    const result = `PREFLIGHT_OK: ${values.version} is uploadable (published: ${d.published})`;
    log(result);
    setOutput('result', result);
    return;
  }
  if (command !== 'release') throw new Error(`Unknown command "${command}" (expected release|preflight|status)`);
  if (!values.zip || !values.version) throw new Error('--zip and --version are required for release');

  const submit = !values['no-publish'];
  const result = await release({ publisher, item, token, zip: readFileSync(values.zip), version: values.version, submit });
  const d = describeStatus(result.status);
  log(`Uploaded ${item} v${result.uploaded.crxVersion ?? values.version}: ${result.uploaded.uploadState}`);
  if (result.published) log(`Submitted for review: ${result.published.state}`);
  else warning(`Uploaded ${item} as a draft only (publish: false). Submit it from the Developer Dashboard.`);
  const warnings = result.published?.warningInfo;
  if (warnings && Object.keys(warnings).length) warning(`Chrome Web Store warnings: ${JSON.stringify(warnings)}`);
  log(`Store status -> published: ${d.published}; submitted: ${d.submitted}`);
  const outcome = result.published ? result.published.state : 'DRAFT_UPLOADED';
  setOutput('result', outcome);
  summary(`- Chrome Web Store \`${item}\`: **${outcome}** — published: ${d.published}; submitted: ${d.submitted}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
