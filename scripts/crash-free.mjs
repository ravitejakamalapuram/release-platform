// Crash-free users for a Play release, read from the Google Play Developer Reporting API (InvTrack #848),
// so widening a staged rollout no longer depends on a number someone typed in.
//
// The figure is Android vitals' crash rate (share of distinct users with at least one crash), per day
// and version code, over the last `days` days of data Play has published. Days are weighted by their
// distinct users: crash-free % = 100 * (1 - sum(rate * users) / sum(users)). Missing or thin data is
// never treated as 100%: it refuses.
//
//   PLAY_TOKEN=... REPORTING_TOKEN=... node scripts/crash-free.mjs --package com.x --track production \
//     --min 99.5 [--min-users 100] [--days 7]
// PLAY_TOKEN (androidpublisher scope) reads which release is in progress on the track; REPORTING_TOKEN
// (playdeveloperreporting scope) reads its crash rate. Exit 1 when the release is below --min or the
// data is missing or thin.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ApiError, request } from './lib/http.mjs';
import { log, main, requireEnv, setOutput, summary } from './lib/gha.mjs';
import { listTracks } from './play.mjs';

const API = 'https://playdeveloperreporting.googleapis.com/v1beta1';
const ZONE = { id: 'America/Los_Angeles' }; // the only time zone DAILY data supports

/** Version codes of the in-progress or halted release on `track`, sorted. */
export function releaseUnderCheck(tracks, track) {
  const rel = (tracks.find((t) => t.track === track)?.releases ?? []).find((r) => r.status === 'inProgress' || r.status === 'halted');
  if (!rel?.versionCodes?.length) throw new Error(`No in-progress or halted release on ${track} to check crash-free users for.`);
  return rel.versionCodes.map(String).sort();
}

function explain(err) {
  if (err instanceof ApiError && err.status === 403) {
    return new Error(
      `${err.message} - enable the Google Play Developer Reporting API (playdeveloperreporting.googleapis.com) in project ` +
        'rk-release-platform, and give release-bot "View app information" for the app in Play Console.',
    );
  }
  return err;
}

const shiftDays = ({ year, month, day }, delta) => {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), timeZone: ZONE };
};

const metric = (row, name) => Number(row.metrics?.find((m) => m.metric === name)?.decimalValue?.value ?? NaN);
const versionCodeOf = (row) => {
  const d = row.dimensions?.find((x) => x.dimension === 'versionCode');
  return String(d?.int64Value ?? d?.stringValue ?? '');
};

/** User-weighted crash-free users (%) for `versionCodes` over the last `days` days of published data. */
export async function crashFreeUsers({ pkg, token, versionCodes, days = 7, fetchImpl = globalThis.fetch }) {
  try {
    const set = await request({ url: `${API}/apps/${pkg}/crashRateMetricSet`, token, fetchImpl });
    const latest = set.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime;
    if (!latest) throw new Error(`Play has published no daily crash data for ${pkg} yet.`);
    const end = { year: latest.year, month: latest.month, day: latest.day, timeZone: ZONE };
    const wanted = new Set(versionCodes.map(String));
    let users = 0;
    let crashed = 0;
    const seenDays = new Set();
    let pageToken;
    do {
      const page = await request({
        method: 'POST',
        url: `${API}/apps/${pkg}/crashRateMetricSet:query`,
        token,
        fetchImpl,
        json: {
          timelineSpec: { aggregationPeriod: 'DAILY', startTime: shiftDays(end, -days), endTime: end },
          dimensions: ['versionCode'],
          metrics: ['crashRate', 'distinctUsers'],
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const row of page.rows ?? []) {
        if (!wanted.has(versionCodeOf(row))) continue;
        const rate = metric(row, 'crashRate');
        const n = metric(row, 'distinctUsers');
        if (!Number.isFinite(rate) || !Number.isFinite(n) || n <= 0) continue;
        users += n;
        crashed += rate * n;
        const s = row.startTime ?? {};
        seenDays.add(`${s.year}-${s.month}-${s.day}`);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { percent: users > 0 ? 100 * (1 - crashed / users) : null, userDays: users, days: seenDays.size, end };
  } catch (err) {
    throw explain(err);
  }
}

/** Resolves with the figures when `versionCodes` are at least `min`% crash-free on enough users; rejects otherwise. */
export async function checkCrashFree({ pkg, token, versionCodes, min, minUsers = 100, days = 7, fetchImpl }) {
  const r = await crashFreeUsers({ pkg, token, versionCodes, days, fetchImpl });
  const codes = versionCodes.join(', ');
  if (r.percent === null) {
    throw new Error(`No crash data from Play for version code ${codes} in the last ${days} days. Play publishes a day's data about a day later; try again tomorrow.`);
  }
  const shown = `${(Math.floor(r.percent * 100 + 1e-9) / 100).toFixed(2)}%`;
  if (r.userDays < minUsers) {
    throw new Error(`Only ${r.userDays} user-days of data for version code ${codes} (crash-free ${shown}); the check needs at least ${minUsers}.`);
  }
  if (r.percent + 1e-9 < min) {
    throw new Error(`Version code ${codes} is ${shown} crash-free over ${r.userDays} user-days; widening needs at least ${min}%.`);
  }
  return { ...r, shown };
}

async function cli() {
  const { values } = parseArgs({
    options: {
      package: { type: 'string' },
      track: { type: 'string', default: 'production' },
      min: { type: 'string' },
      'min-users': { type: 'string', default: '100' },
      days: { type: 'string', default: '7' },
    },
  });
  const pkg = values.package;
  const min = Number(values.min);
  if (!pkg || !(min > 0 && min <= 100)) throw new Error('--package and --min (a percentage in (0, 100]) are required');
  const versionCodes = releaseUnderCheck(await listTracks({ pkg, token: requireEnv('PLAY_TOKEN') }), values.track);
  const r = await checkCrashFree({
    pkg, token: requireEnv('REPORTING_TOKEN'), versionCodes, min,
    minUsers: Number(values['min-users']), days: Number(values.days),
  });
  const out = `CRASH_FREE_OK: ${pkg} [${versionCodes.join(', ')}] ${r.shown} crash-free users over ${r.userDays} user-days (${r.days} days of Play data to ${r.end.year}-${r.end.month}-${r.end.day}), minimum ${min}%`;
  log(out);
  setOutput('crash_free_users', r.percent.toFixed(4));
  summary(`### Crash-free users\n${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
