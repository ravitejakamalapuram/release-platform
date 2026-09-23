// Extract "What's new" text for Google Play from a Markdown changelog.
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
