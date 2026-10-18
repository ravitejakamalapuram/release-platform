#!/usr/bin/env node
// Files one GitHub issue per new Crashlytics crash (label `crash`) in the calling app repo.
//
//   GOOGLE_ACCESS_TOKEN=... GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
//   FIREBASE_PROJECT=my-project FIREBASE_APP_ID=1:123:android:abc node scripts/crash-issues.mjs
//
// Dedupe is by the Crashlytics issue id kept in a hidden marker in each issue body, open or closed.
// No user, installation, session or event ids and no custom keys are copied into the issue.
import { pathToFileURL } from 'node:url';
import { log, main, notice, summary, warning } from './lib/gha.mjs';

const MARK = 'crashlytics-issue';
const LABEL = 'crash';

const sum = (metrics, key) => (metrics ?? []).reduce((n, m) => n + Number(m[key] ?? 0), 0);

export function frameLine(f) {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : (f.library ?? '');
  return `${f.blamed ? '>> ' : '   '}${f.symbol ?? f.address ?? '?'}${where ? `  (${where})` : ''}`;
}

export function issueTitle(issue) {
  const sub = issue.subtitle ? ` in ${issue.subtitle}` : '';
  return `[crash ${issue.id.slice(0, 8)}] ${issue.title ?? 'Crash'}${sub}`.slice(0, 200);
}

export function buildBody(group, event) {
  const i = group.issue;
  const lines = [`<!-- ${MARK}:${i.id} -->`];
  lines.push(`**Crashlytics issue** \`${i.id}\` · ${i.errorType ?? 'FATAL'} · state ${i.state ?? 'unknown'}${i.uri ? ` · [Console](${i.uri})` : ''}`, '');
  lines.push(`- Events in window: ${sum(group.metrics, 'eventsCount')}, users impacted: ${sum(group.metrics, 'impactedUsersCount')}`);
  lines.push(`- First seen ${i.firstSeenTime ?? '?'} (version ${i.firstSeenVersion ?? '?'}), last seen ${i.lastSeenTime ?? '?'} (version ${i.lastSeenVersion ?? '?'})`);
  if (i.signals?.length) lines.push(`- Signals: ${i.signals.join(', ')}`);
  if (event) {
    const dev = event.device?.model ?? event.device?.displayName ?? event.device?.manufacturer;
    lines.push(`- Latest sample: app ${event.version?.displayVersion ?? event.version?.displayName ?? '?'}, OS ${event.operatingSystem?.displayName ?? '?'}, device ${dev ?? '?'}, ${event.eventTime ?? ''}`, '');
    for (const ex of event.exceptions ?? []) {
      lines.push(`**${ex.type ?? 'Exception'}**: ${ex.exceptionMessage ?? ex.title ?? ''}`);
      lines.push('```', ...(ex.frames ?? []).slice(0, 60).map(frameLine), '```');
    }
    for (const t of (event.threads ?? []).filter((x) => x.crashed || x.blamed).slice(0, 2)) {
      lines.push(`**Thread ${t.name ?? t.title ?? ''}** ${t.signal ?? ''}`);
      lines.push('```', ...(t.frames ?? []).slice(0, 60).map(frameLine), '```');
    }
    if (event.blameFrame) lines.push(`Blamed frame: \`${frameLine(event.blameFrame).trim()}\``);
    const logs = (event.logs ?? []).slice(-30).map((l) => l.message ?? JSON.stringify(l));
    if (logs.length) lines.push('<details><summary>Last log lines</summary>', '', '```', ...logs, '```', '</details>');
  } else {
    lines.push('', '_No sample event could be fetched; open the Console link._');
  }
  lines.push('', 'Triage against current `main` first, fix test-first, and close this issue from the PR.');
  return lines.join('\n');
}

async function getJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url.split('?')[0]} failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function run({ token, project, appId, ghToken, repo, dry = false, windowDays = 7, max = 5, fetchImpl = fetch, now = new Date() }) {
  const api = `https://firebasecrashlytics.googleapis.com/v1alpha/projects/${project}/apps/${appId}`;
  const gHead = { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' };
  const cHead = { authorization: `Bearer ${token}` };
  const q = (pairs) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const report = await getJson(fetchImpl, `${api}/reports/topIssues?${q([
    ['filter.interval.startTime', new Date(now - windowDays * 864e5).toISOString()],
    ['filter.interval.endTime', now.toISOString()],
    ['filter.issue.errorTypes', 'FATAL'], ['filter.issue.errorTypes', 'ANR'], ['pageSize', '25'],
  ])}`, cHead);
  const groups = (report.groups ?? []).filter((g) => g.issue?.id && g.issue.state !== 'CLOSED');

  const known = new Set();
  for (let page = 1; page < 20; page++) {
    const rows = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/issues?${q([['labels', LABEL], ['state', 'all'], ['per_page', '100'], ['page', String(page)]])}`, gHead);
    for (const r of rows) for (const m of (r.body ?? '').matchAll(new RegExp(`<!-- ${MARK}:(\\S+) -->`, 'g'))) known.add(m[1]);
    if (rows.length < 100) break;
  }

  const fresh = groups.filter((g) => !known.has(g.issue.id)).slice(0, max);
  log(`${groups.length} open crash issues in ${windowDays} d, ${fresh.length} new to file${dry ? ' (dry run)' : ''}`);
  const filed = [];
  for (const g of fresh) {
    let event = null;
    try {
      event = (await getJson(fetchImpl, `${api}/events?${q([['filter.issue.id', g.issue.id], ['pageSize', '1']])}`, cHead)).events?.[0] ?? null;
    } catch (e) { warning(`sample event unavailable for ${g.issue.id}: ${e.message}`); }
    const title = issueTitle(g.issue);
    const body = buildBody(g, event);
    if (dry) { log(`--- would file: ${title}\n${body}\n`); filed.push({ title }); continue; }
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: gHead, body: JSON.stringify({ title, body, labels: [LABEL] }) });
    if (!res.ok) throw new Error(`creating issue failed (${res.status})`);
    const made = JSON.parse(await res.text());
    notice(`filed #${made.number} for ${g.issue.id}`);
    filed.push({ title, number: made.number });
  }
  summary(`### Crash issues\n${filed.length ? filed.map((f) => `- ${f.number ? `#${f.number} ` : ''}${f.title}`).join('\n') : 'No new crashes.'}`);
  return filed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(async () => {
    const need = (n) => process.env[n] || (() => { throw new Error(`${n} is required`); })();
    await run({
      token: need('GOOGLE_ACCESS_TOKEN'), project: need('FIREBASE_PROJECT'), appId: need('FIREBASE_APP_ID'),
      ghToken: need('GITHUB_TOKEN'), repo: need('GITHUB_REPOSITORY'), dry: process.env.DRY_RUN === '1',
      windowDays: Number(process.env.WINDOW_DAYS || 7), max: Number(process.env.MAX_NEW || 5),
    });
  });
}
