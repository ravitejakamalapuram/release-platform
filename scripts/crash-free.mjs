// Crash-free users for a Play release, read from the Google Play Developer Reporting API (InvTrack #848),
// so widening a staged rollout no longer depends on a number someone typed in.
//
// The figure is Android vitals' crash rate (share of distinct users with at least one crash), per day
// and version code, over the last `days` days of data Play has published. Days are weighted by their
// distinct users: crash-free % = 100 * (1 - sum(rate * users) / sum(users)). Missing or thin data is
// never treated as 100%: it refuses.
//
//   PLAY_TOKEN=... REPORTING_TOKEN=... node scripts/crash-free.mjs --package com.x --track production \
//     --min 99.5 [--min-users 100] [--days 7] [--since 2026-11-20T08:00:00Z]
// --since: when the soak began; only full days from then on count (InvTrack #848: the soak window).
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

/** Version codes of the in-progress or halted release on `track` with the highest version code (the one `play.mjs` writes), sorted. */
export function releaseUnderCheck(tracks, track) {
  const top = (r) => Math.max(0, ...(r.versionCodes ?? []).map(Number));
  const rel = (tracks.find((t) => t.track === track)?.releases ?? [])
    .filter((r) => r.status === 'inProgress' || r.status === 'halted')
    .sort((x, y) => top(y) - top(x))[0];
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

/** The first Los Angeles day (Play's only daily time zone) that starts at or after `sinceIso`; days before it include time before `since`. */
export function firstFullDay(sinceIso) {
  // Z or an explicit offset is required: a bare date-time would be read in the host's time zone.
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(sinceIso) ? new Date(sinceIso) : new Date(NaN);
  if (Number.isNaN(at.getTime())) throw new Error(`since must be a date-time with Z or an offset, such as 2026-11-20T08:00:00Z (got ${sinceIso})`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: ZONE.id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  );
  const midnight = p.hour === 0 && p.minute === 0 && p.second === 0 && at.getUTCMilliseconds() === 0;
  return shiftDays({ year: p.year, month: p.month, day: p.day }, midnight ? 0 : 1);
}

const dayNumber = ({ year, month, day }) => Date.UTC(year, month - 1, day);

const metric = (row, name) => Number(row.metrics?.find((m) => m.metric === name)?.decimalValue?.value ?? NaN);
const versionCodeOf = (row) => {
  const d = row.dimensions?.find((x) => x.dimension === 'versionCode');
  return String(d?.int64Value ?? d?.stringValue ?? '');
};

/** User-weighted crash-free users (%) for `versionCodes` over the last `days` days of published data. */
export async function crashFreeUsers({ pkg, token, versionCodes, days = 7, since, fetchImpl = globalThis.fetch }) {
  try {
    const set = await request({ url: `${API}/apps/${pkg}/crashRateMetricSet`, token, fetchImpl });
    const latest = set.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime;
    if (!latest) throw new Error(`Play has published no daily crash data for ${pkg} yet.`);
    const end = { year: latest.year, month: latest.month, day: latest.day, timeZone: ZONE };
    // Data from before the soak began (for example testers on an earlier track) must not count.
    const windowStart = shiftDays(end, -days);
    const first = since ? firstFullDay(since) : null;
    const start = first && dayNumber(first) > dayNumber(windowStart) ? first : windowStart;
    const per = new Map(versionCodes.map((c) => [String(c), { users: 0, crashed: 0, maxRate: 0, days: new Set() }]));
    let pageToken;
    // No full day since the soak began has been published yet: nothing to read.
    if (dayNumber(start) < dayNumber(end)) do {
      const page = await request({
        method: 'POST',
        url: `${API}/apps/${pkg}/crashRateMetricSet:query`,
        token,
        fetchImpl,
        json: {
          timelineSpec: { aggregationPeriod: 'DAILY', startTime: start, endTime: end },
          dimensions: ['versionCode'],
          metrics: ['crashRate', 'distinctUsers'],
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const row of page.rows ?? []) {
        const acc = per.get(versionCodeOf(row));
        if (!acc) continue;
        const rate = metric(row, 'crashRate');
        const n = metric(row, 'distinctUsers');
        if (!Number.isFinite(rate) || !Number.isFinite(n) || n <= 0) continue;
        acc.users += n;
        acc.crashed += rate * n;
        acc.maxRate = Math.max(acc.maxRate, rate);
        const st = row.startTime ?? {};
        acc.days.add(`${st.year}-${st.month}-${st.day}`);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    const byCode = [...per].map(([code, a]) => ({ code, userDays: a.users, days: a.days.size, maxRate: a.maxRate, percent: a.users > 0 ? 100 * (1 - a.crashed / a.users) : null }));
    return { byCode, end };
  } catch (err) {
    throw explain(err);
  }
}

/** Resolves with the figures when every version code is at least `min`% crash-free on enough users; rejects otherwise. */
export async function checkCrashFree({ pkg, token, versionCodes, min, minUsers = 100, days = 7, since, allowThin = false, fetchImpl }) {
  if (!(Number.isFinite(minUsers) && minUsers >= 1)) throw new Error(`min-users must be a number of at least 1 (got ${minUsers})`);
  const { byCode, end } = await crashFreeUsers({ pkg, token, versionCodes, days, since, fetchImpl });
  const shown = (p) => `${(Math.floor(p * 100 + 1e-9) / 100).toFixed(2)}%`;
  // With allowThin, a version code Play has no or too few user-days for passes (flagged), but only if its crashes, when there are any, are within the minimum.
  const thin = [];
  for (const r of byCode) {
    if (allowThin && (r.percent === null || r.userDays < minUsers)) {
      if (r.percent !== null && r.percent + 1e-9 < min) {
        throw new Error(`Version code ${r.code} is ${shown(r.percent)} crash-free over ${r.userDays} user-days; widening needs at least ${min}%.`);
      }
      thin.push(r.code);
      continue;
    }
    if (r.percent === null) {
      throw new Error(`No crash data from Play for version code ${r.code} in the last ${days} days${since ? ` since ${since}` : ''}. Play publishes a day's data about a day later; try again tomorrow.`);
    }
    if (r.userDays < minUsers) {
      throw new Error(`Only ${r.userDays} user-days of data for version code ${r.code} (crash-free ${shown(r.percent)}); the check needs at least ${minUsers}.`);
    }
    if (r.percent + 1e-9 < min) {
      throw new Error(`Version code ${r.code} is ${shown(r.percent)} crash-free over ${r.userDays} user-days; widening needs at least ${min}%.`);
    }
  }
  if (thin.length === byCode.length) {
    return { code: thin.join(','), userDays: Math.max(...byCode.map((r) => r.userDays)), days: 0, percent: null, maxRate: 0, shown: 'n/a', byCode, end, thin };
  }
  const known = byCode.filter((r) => r.percent !== null);
  const worst = known.reduce((a, b) => (b.percent < a.percent ? b : a));
  // maxRate is the highest daily rate over every checked version code, not only the worst one's.
  return { ...worst, maxRate: Math.max(...byCode.map((r) => r.maxRate)), shown: shown(worst.percent), byCode, end, thin };
}

async function cli() {
  const { values } = parseArgs({
    options: {
      package: { type: 'string' },
      track: { type: 'string', default: 'production' },
      min: { type: 'string' },
      'min-users': { type: 'string', default: '100' },
      days: { type: 'string', default: '7' },
      since: { type: 'string' },
      'allow-thin-data': { type: 'boolean', default: false },
    },
  });
  const pkg = values.package;
  const min = Number(values.min);
  if (!pkg || !(min > 0 && min <= 100)) throw new Error('--package and --min (a percentage in (0, 100]) are required');
  const versionCodes = releaseUnderCheck(await listTracks({ pkg, token: requireEnv('PLAY_TOKEN') }), values.track);
  const r = await checkCrashFree({
    pkg, token: requireEnv('REPORTING_TOKEN'), versionCodes, min,
    minUsers: Number(values['min-users']), days: Number(values.days), since: values.since || undefined,
    allowThin: values['allow-thin-data'],
  });
  setOutput('version_codes', versionCodes.join(','));
  if (r.thin.length) {
    const outThin = `CRASH_FREE_THIN_DATA: ${pkg} [${r.thin.join(', ')}] Play has too little crash data (fewer than ${values['min-users']} user-days) to publish a rate; none shows crashes below ${min}%. Passed only because allow-thin-data is on.`;
    log(outThin);
    summary(`### Crash-free users\n${outThin}`);
    if (r.percent === null) return;
  }
  const out = `CRASH_FREE_OK: ${pkg} [${versionCodes.join(', ')}] ${r.shown} crash-free users over ${r.userDays} user-days (${r.days} days of Play data to ${r.end.year}-${r.end.month}-${r.end.day}), minimum ${min}%. Highest daily crashRate read: ${r.maxRate} (read as a fraction: 0.005 = 0.5% of users; if Play's figure is a percentage the gate refuses, never allows)`;
  log(out);
  setOutput('crash_free_users', r.percent.toFixed(4));
  summary(`### Crash-free users\n${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
