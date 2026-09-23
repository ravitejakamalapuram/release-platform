#!/usr/bin/env node
// Render the release job summary: one row per planned target.
//
//   node scripts/summary.mjs --chrome '[...]' --android '[...]' --results results/ --version 1.2.3 [--dry-run]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { main, summary } from './lib/gha.mjs';

export function readResults(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir, { recursive: true })) {
    if (!String(f).endsWith('.json')) continue;
    const r = JSON.parse(readFileSync(join(dir, String(f)), 'utf8'));
    out[r.key] = r;
  }
  return out;
}

export function renderSummary({ targets, results, version, tag, dryRun }) {
  const rows = targets.map((t) => {
    const r = results[t.key];
    const store = t.type === 'chrome' ? 'Chrome Web Store' : `Google Play (${t.track})`;
    const id = t.item_id ?? t.package;
    const result = r ? r.result : 'not published (an earlier job failed)';
    return `| ${t.type} | \`${id}\` | ${version} | ${store} | ${String(result).replace(/\|/g, '\\|')} |`;
  });
  const ok = targets.length > 0 && targets.every((t) => results[t.key]?.ok);
  const footer = dryRun
    ? `_Dry run: nothing was uploaded and no tag was created._`
    : ok
      ? `Tagged **${tag}** and created a GitHub Release.`
      : `**No tag was created** because not every target succeeded. Fix the failure and use "Re-run failed jobs" to retry with the same version.`;
  return [
    `## Release ${tag}${dryRun ? ' (dry run)' : ''}`,
    '',
    '| Target | ID | Version | Store | Result |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    footer,
  ].join('\n');
}

async function cli() {
  const { values } = parseArgs({
    options: {
      chrome: { type: 'string', default: '[]' },
      android: { type: 'string', default: '[]' },
      results: { type: 'string' },
      version: { type: 'string' },
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const targets = [...JSON.parse(values.chrome), ...JSON.parse(values.android)];
  summary(renderSummary({ targets, results: readResults(values.results), version: values.version, tag: values.tag, dryRun: values['dry-run'] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
