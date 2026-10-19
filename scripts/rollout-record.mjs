// Records when a production staged rollout started, so a later promotion can count its 48 h soak
// from the real Play rollout and not from a proxy such as the end of a workflow run (InvTrack #849).
//
// A record is a GitHub Deployment in the `play-production` environment whose payload holds the
// package, version codes, status and user fraction. It is written only after `play.mjs verify-track`
// read the same release back from Play, so a record exists only for a rollout Play confirmed.
// Consumers read it with `GET /repos/{repo}/deployments?environment=play-production`.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=o/r GITHUB_SHA=... node scripts/rollout-record.mjs --package com.x \
//     --track production --version-codes 1002003 --status inProgress --fraction 0.05
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { request } from './lib/http.mjs';
import { log, main, requireEnv } from './lib/gha.mjs';

export const ENVIRONMENT = 'play-production';

/** Only a staged production rollout has a soak to count. Returns the reason not to record, or null. */
export function skipReason({ track, status }) {
  if (String(track).trim().toLowerCase() !== 'production') return `track "${track}" is not production`;
  if (status !== 'inProgress') return `status "${status}" is not a staged rollout`;
  return null;
}

export function buildPayload({ pkg, track, versionCodes, status, userFraction, startedAt }) {
  const codes = [...versionCodes].map(String).sort();
  if (!pkg || !track || codes.length === 0 || !status) throw new Error('A rollout record needs package, track, versionCodes and status');
  if (Number.isNaN(Date.parse(startedAt))) throw new Error(`startedAt must be an ISO 8601 time, got ${startedAt}`);
  return { package: pkg, track, versionCodes: codes, status, userFraction, startedAt: new Date(startedAt).toISOString() };
}

export async function recordRollout({ repo, token, sha, payload, fetchImpl }) {
  const base = `https://api.github.com/repos/${repo}`;
  const deployment = await request({
    method: 'POST',
    url: `${base}/deployments`,
    token,
    fetchImpl,
    json: {
      ref: sha,
      environment: ENVIRONMENT,
      description: `Play ${payload.track} rollout of ${payload.versionCodes.join(', ')} started`,
      payload,
      auto_merge: false,
      required_contexts: [],
      transient_environment: false,
      production_environment: true,
    },
  });
  if (!deployment?.id) throw new Error('GitHub did not create the deployment record');
  await request({ method: 'POST', url: `${base}/deployments/${deployment.id}/statuses`, token, fetchImpl, json: { state: 'success', environment: ENVIRONMENT } });
  return deployment.id;
}

async function cli() {
  const { values } = parseArgs({
    options: { package: { type: 'string' }, track: { type: 'string' }, 'version-codes': { type: 'string' }, status: { type: 'string' }, fraction: { type: 'string' } },
  });
  const skip = skipReason({ track: values.track ?? '', status: values.status });
  if (skip) return log(`No rollout record written: ${skip}.`);
  const fraction = values.fraction === undefined || values.fraction === '' ? undefined : Number(values.fraction);
  const payload = buildPayload({
    pkg: values.package,
    track: values.track,
    versionCodes: (values['version-codes'] ?? '').split(',').map((c) => c.trim()).filter(Boolean),
    status: values.status,
    userFraction: fraction,
    startedAt: new Date().toISOString(),
  });
  const id = await recordRollout({ repo: requireEnv('GITHUB_REPOSITORY'), token: requireEnv('GITHUB_TOKEN'), sha: requireEnv('GITHUB_SHA'), payload });
  log(`ROLLOUT_RECORDED: ${payload.package} ${payload.track} [${payload.versionCodes.join(', ')}] started ${payload.startedAt} (deployment ${id})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
