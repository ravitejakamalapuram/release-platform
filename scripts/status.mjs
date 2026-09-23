#!/usr/bin/env node
// Read-only store dashboard for every app in apps.yaml (converted to JSON by yq).
//
//   CWS_TOKEN=... PLAY_TOKEN=... node scripts/status.mjs --registry apps.json --out STATUS.md
//
// Failures for one item never fail the whole run: they are shown in the table instead.
import { writeFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { describeStatus, explainCwsError, fetchStatus } from './cws.mjs';
import { describeTracks, listTracks } from './play.mjs';
import { log, main, summary, warning } from './lib/gha.mjs';

const cell = (s) => String(s ?? '-').replace(/\|/g, '\\|').replace(/\n/g, '<br>');

export async function collect({ registry, publisher, cwsToken, playToken, fetchImpl }) {
  const rows = [];
  for (const appEntry of registry.apps ?? []) {
    for (const t of appEntry.targets ?? []) {
      const row = { app: appEntry.name, repo: appEntry.repo, type: t.type, id: t.item_id ?? t.package };
      try {
        if (t.type === 'chrome') {
          if (!cwsToken) throw new Error('no Chrome Web Store token');
          const d = describeStatus(
            await fetchStatus({ publisher, item: t.item_id, token: cwsToken, fetchImpl }).catch((err) => {
              throw explainCwsError(err, t.item_id);
            }),
          );
          row.live = d.published;
          row.pending = d.submitted;
          row.notes = d.flags;
        } else if (t.type === 'android') {
          if (!playToken) throw new Error('no Google Play token');
          const lines = describeTracks(await listTracks({ pkg: t.package, token: playToken, fetchImpl }));
          const prod = lines.find((l) => l.startsWith('production:'));
          row.live = prod ? prod.slice('production:'.length).trim() : '-';
          row.pending = lines.filter((l) => l !== prod).join('\n') || '-';
        } else {
          throw new Error(`unknown target type ${t.type}`);
        }
        row.ok = true;
      } catch (err) {
        row.ok = false;
        row.notes = err.message.split('\n')[0].slice(0, 200);
      }
      rows.push(row);
    }
  }
  return rows;
}

export function render(rows, { now = new Date(), repo = 'ravitejakamalapuram/release-platform' } = {}) {
  const header = [
    `# Store status`,
    '',
    `_Updated ${now.toISOString().replace(/\.\d+Z$/, 'Z')} by [dashboard.yml](https://github.com/${repo}/actions/workflows/dashboard.yml)._`,
    '',
    '| App | Store | ID | Live | Pending / other tracks | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const body = rows.map((r) => {
    const store = r.type === 'chrome' ? 'Chrome Web Store' : r.type === 'android' ? 'Google Play' : r.type;
    const app = r.repo ? `[${cell(r.app)}](https://github.com/${r.repo})` : cell(r.app);
    const notes = r.ok ? cell(r.notes || '') : `:warning: ${cell(r.notes)}`;
    return `| ${app} | ${store} | \`${cell(r.id)}\` | ${cell(r.live)} | ${cell(r.pending)} | ${notes} |`;
  });
  return `${[...header, ...body].join('\n')}\n`;
}

async function cli() {
  const { values } = parseArgs({ options: { registry: { type: 'string', default: 'apps.json' }, out: { type: 'string' } } });
  const registry = JSON.parse(readFileSync(values.registry, 'utf8'));
  const rows = await collect({
    registry,
    publisher: process.env.CWS_PUBLISHER_ID,
    cwsToken: process.env.CWS_TOKEN,
    playToken: process.env.PLAY_TOKEN,
  });
  const md = render(rows, { repo: process.env.GITHUB_REPOSITORY });
  summary(md);
  if (values.out) writeFileSync(values.out, md);
  const failed = rows.filter((r) => !r.ok);
  for (const r of failed) warning(`${r.app} (${r.type} ${r.id}): ${r.notes}`);
  log(`${rows.length - failed.length}/${rows.length} targets queried successfully`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
