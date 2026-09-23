import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, render } from '../scripts/status.mjs';
import { fakeFetch, googleError } from './helpers.mjs';

const registry = {
  apps: [
    { name: 'EchoKit', repo: 'o/echokit', targets: [{ type: 'chrome', item_id: 'a'.repeat(32) }] },
    { name: 'TelePort', repo: 'o/TelePort', targets: [{ type: 'android', package: 'com.x.y' }, { type: 'chrome', item_id: 'b'.repeat(32) }] },
  ],
};

test('collect queries each store and keeps going on errors', async () => {
  const f = fakeFetch([
    { body: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0', deployPercentage: 100 }] } } },
    { body: { id: 'e' } },
    { body: { tracks: [
      { track: 'production', releases: [{ name: '1.0.0', versionCodes: ['1000000'], status: 'inProgress', userFraction: 0.1 }] },
      { track: 'internal', releases: [{ name: '1.1.0', versionCodes: ['1001000'], status: 'completed' }] },
    ] } },
    { body: {} },
    googleError(403, 'nope'),
  ]);
  const rows = await collect({ registry, publisher: 'p', cwsToken: 'c', playToken: 'p', fetchImpl: f });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].live, 'PUBLISHED (1.0.0 @ 100%)');
  assert.equal(rows[1].live, '1.0.0 inProgress 10%');
  assert.equal(rows[1].pending, 'internal: 1.1.0 completed');
  assert.equal(rows[2].ok, false);
  assert.match(rows[2].notes, /Not authorized/);
  assert.equal(f.calls[3].method, 'DELETE');

  const md = render(rows, { now: new Date('2026-01-02T03:04:05.678Z'), repo: 'o/rp' });
  assert.match(md, /_Updated 2026-01-02T03:04:05Z by \[dashboard.yml\]\(https:\/\/github.com\/o\/rp\/actions\/workflows\/dashboard.yml\)\._/);
  assert.match(md, /\| \[EchoKit\]\(https:\/\/github.com\/o\/echokit\) \| Chrome Web Store \| `a{32}` \| PUBLISHED \(1.0.0 @ 100%\) \| - \|  \|/);
  assert.match(md, /:warning: Not authorized/);
});

test('missing tokens are reported per row', async () => {
  const rows = await collect({ registry, fetchImpl: fakeFetch([]) });
  assert.ok(rows.every((r) => !r.ok));
  assert.match(rows[1].notes, /no Google Play token/);
});
