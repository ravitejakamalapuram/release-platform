#!/usr/bin/env node
// Daily app performance snapshot (replaces the Supermetrics-backed hub).
//   GA_TOKEN=... PLAY_TOKEN=... node scripts/performance.mjs --config performance.json --out performance.json.out
// GA4: Analytics Data API. Play: the monthly stats CSVs Play Console writes to a Cloud Storage bucket.
// Nothing is estimated: a source that returns nothing gives null.
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from './lib/http.mjs';
import { main, requireEnv, warning } from './lib/gha.mjs';

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

/** Play stats CSV (UTF-16LE) -> [{date, installs, uninstalls}] using the user-level columns. */
export function parsePlayCsv(buf) {
  const text = (Buffer.isBuffer(buf) ? buf.toString('utf16le') : String(buf)).replace(/^﻿/, '');
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = head.split(',');
  const i = (n) => cols.indexOf(n);
  const [d, a, b] = [i('Date'), i('Daily User Installs'), i('Daily User Uninstalls')];
  if (d < 0 || a < 0 || b < 0) throw new Error('Play stats CSV has unexpected columns');
  return lines.map((l) => l.split(',')).map((r) => ({ date: r[d], installs: +r[a] || 0, uninstalls: +r[b] || 0 }));
}

export function sumWindow(rows, from, to) {
  const r = rows.filter((x) => x.date >= from && x.date <= to);
  return r.length ? { installs: r.reduce((s, x) => s + x.installs, 0), uninstalls: r.reduce((s, x) => s + x.uninstalls, 0) } : null;
}

async function playRows(bucket, pkg, token, months) {
  const rows = [];
  for (const ym of months) {
    const obj = encodeURIComponent(`stats/installs/installs_${pkg}_${ym}_overview.csv`);
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${obj}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Play stats ${pkg} ${ym}: HTTP ${res.status}`);
    rows.push(...parsePlayCsv(Buffer.from(await res.arrayBuffer())));
  }
  return rows;
}

async function gaProperties(token) {
  const out = {};
  let pageToken = '';
  do {
    const r = await request({ url: `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`, token });
    for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out[p.displayName] = p.property.split('/')[1];
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

async function gaReport(id, token, body) {
  const r = await request({ method: 'POST', url: `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, token, json: body });
  const v = r.rows?.[0]?.metricValues;
  return v ? v.map((m) => +m.value) : null;
}

async function ga(id, token, t) {
  const win = (s, e, metrics) => gaReport(id, token, { dateRanges: [{ startDate: s, endDate: e }], metrics: metrics.map((name) => ({ name })) });
  const [cur, prev, d1, d2] = await Promise.all([
    win(day(addDays(t, -30)), day(addDays(t, -1)), ['activeUsers', 'newUsers']),
    win(day(addDays(t, -60)), day(addDays(t, -31)), ['activeUsers', 'newUsers']),
    win(day(addDays(t, -1)), day(addDays(t, -1)), ['active7DayUsers', 'active28DayUsers']),
    win(day(addDays(t, -31)), day(addDays(t, -31)), ['active7DayUsers', 'active28DayUsers']),
  ]);
  return { active: cur?.[0] ?? null, new: cur?.[1] ?? null, prevActive: prev?.[0] ?? null, prevNew: prev?.[1] ?? null,
    active7: d1?.[0] ?? null, active28: d1?.[1] ?? null, prevActive7: d2?.[0] ?? null, prevActive28: d2?.[1] ?? null };
}

export async function collect(cfg, { gaToken, playToken, today = new Date() }) {
  const props = await gaProperties(gaToken);
  const months = [...new Set([-60, -30, -1].map((n) => day(addDays(today, n)).slice(0, 7).replace('-', '')))];
  const apps = [];
  for (const a of cfg.apps) {
    const entry = { name: a.name, platform: a.platform, id: a.play ?? a.ga, play: null, ga: null };
    try {
      if (a.play) {
        const rows = await playRows(cfg.playBucket, a.play, playToken, months);
        const cur = sumWindow(rows, day(addDays(today, -30)), day(addDays(today, -1)));
        const prev = sumWindow(rows, day(addDays(today, -60)), day(addDays(today, -31)));
        entry.play = cur && { ...cur, prevInstalls: prev?.installs ?? null, prevUninstalls: prev?.uninstalls ?? null };
      }
    } catch (e) { warning(`${a.name}: ${e.message}`); }
    try {
      entry.ga = props[a.ga] ? await ga(props[a.ga], gaToken, today) : null;
      if (!props[a.ga]) warning(`${a.name}: GA4 property "${a.ga}" not visible to the service account`);
    } catch (e) { warning(`${a.name}: GA4 failed (${e.status ?? e.message})`); }
    apps.push(entry);
  }
  return { generated: today.toISOString(), apps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(async () => {
    const args = process.argv.slice(2);
    const arg = (n) => args[args.indexOf(n) + 1];
    const cfg = JSON.parse(readFileSync(arg('--config'), 'utf8'));
    const data = await collect(cfg, { gaToken: requireEnv('GA_TOKEN'), playToken: requireEnv('PLAY_TOKEN') });
    writeFileSync(arg('--out'), JSON.stringify(data, null, 1));
  });
}
