#!/usr/bin/env node
// Extract "What's new" text for Google Play from a Markdown changelog.
//
//   node scripts/changelog.mjs --changelog CHANGELOG.md --generated notes.md --out whatsnew.txt
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { log, main } from './lib/gha.mjs';

export const PLAY_NOTES_LIMIT = 500;

/** First release section of a changelog (under the first "## " heading), as plain-ish text. */
export function firstSection(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+\S/.test(l));
  let body;
  if (start === -1) {
    body = lines.filter((l) => !/^#\s/.test(l));
  } else {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s+\S/.test(l));
    body = end === -1 ? rest : rest.slice(0, end);
  }
  return body
    .map((l) => l.replace(/^#{3,}\s+/, '').replace(/^\s*[*+]\s+/, '- ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text, limit = PLAY_NOTES_LIMIT) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const nl = cut.lastIndexOf('\n');
  return `${(nl > limit * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}…`;
}

export function playNotes(markdown) {
  const text = firstSection(markdown);
  return text ? truncate(text) : '';
}

/**
 * Choose the Play "What's new" text: the changelog's newest section, or — when there is no
 * changelog or that section is empty — the generated commit notes.
 */
export function pickNotes({ changelog, changelogPath, generated }) {
  const fromChangelog = changelog === null || changelog === undefined ? '' : playNotes(changelog);
  if (fromChangelog) return { text: fromChangelog, source: changelogPath };
  const reason = changelog === null || changelog === undefined ? 'no changelog' : `first section of ${changelogPath} is empty`;
  return { text: playNotes(generated ?? ''), source: `generated notes (${reason})` };
}

async function cli() {
  const { values } = parseArgs({ options: { changelog: { type: 'string', default: '' }, generated: { type: 'string' }, out: { type: 'string' } } });
  if (!values.out) throw new Error('--out is required');
  const path = values.changelog;
  const changelog = path && existsSync(path) ? readFileSync(path, 'utf8') : null;
  const generated = values.generated && existsSync(values.generated) ? readFileSync(values.generated, 'utf8') : '';
  const { text, source } = pickNotes({ changelog, changelogPath: path, generated });
  writeFileSync(values.out, text);
  log(`What's new (from ${source}):\n${text || '(empty)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(cli);
