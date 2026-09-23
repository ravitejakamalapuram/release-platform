import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globToRegExp, makeFilter, manifestReferences, packageExtension, selectFiles, stampManifest } from '../scripts/package-chrome.mjs';

test('globToRegExp handles plain paths, dirs, * and **', () => {
  assert.ok(globToRegExp('icons').test('icons/16.png'));
  assert.ok(globToRegExp('icons/').test('icons/a/b.png'));
  assert.ok(!globToRegExp('icons').test('icons2/a.png'));
  assert.ok(globToRegExp('*.js').test('popup.js'));
  assert.ok(!globToRegExp('*.js').test('lib/popup.js'));
  assert.ok(globToRegExp('**/*.js').test('lib/deep/popup.js'));
  assert.ok(globToRegExp('**/*.js').test('popup.js'));
  assert.ok(globToRegExp('dist/**').test('dist/a/b.css'));
  assert.ok(globToRegExp('./manifest.json').test('manifest.json'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('default denylist drops junk but keeps extension code', () => {
  const keep = makeFilter();
  for (const f of ['manifest.json', 'background.js', 'popup/popup.html', 'icons/icon128.png', 'lib/vendor.min.js', '_locales/en/messages.json']) {
    assert.ok(keep(f), `should keep ${f}`);
  }
  for (const f of ['README.md', 'docs/x.md', '.gitignore', '.github/workflows/ci.yml', 'popup.js.map', '.env.local', 'tests/a.test.js',
    'src/util.test.js', 'store/screenshot1.png', 'chrome-store/promo.png', 'package.json', 'package-lock.json', 'old.zip', 'key.pem', 'scripts/build.sh']) {
    assert.ok(!keep(f), `should drop ${f}`);
  }
});

test('allowlist mode keeps only listed entries (plus manifest)', () => {
  const keep = makeFilter({ include: ['dist/**', 'icons'] });
  assert.ok(keep('manifest.json'));
  assert.ok(keep('dist/bg.js'));
  assert.ok(keep('icons/16.png'));
  assert.ok(!keep('src/bg.ts'));
});

const manifest = {
  manifest_version: 3,
  version: '0.0.1',
  background: { service_worker: 'background.js' },
  action: { default_popup: 'popup.html', default_icon: { 16: 'icons/16.png' } },
  icons: { 128: 'icons/128.png' },
  content_scripts: [{ matches: ['<all_urls>'], js: ['content/main.js'], css: ['content/main.css'] }],
  web_accessible_resources: [{ resources: ['inject/*.js', 'inject/page.html'], matches: ['<all_urls>'] }],
  options_ui: { page: 'options.html' },
  default_locale: 'en',
};

test('manifestReferences lists concrete files only', () => {
  assert.deepEqual(manifestReferences(manifest), [
    '_locales/en/messages.json', 'background.js', 'content/main.css', 'content/main.js', 'icons/128.png', 'icons/16.png',
    'inject/page.html', 'options.html', 'popup.html',
  ]);
});

test('selectFiles fails when the manifest would break', () => {
  const files = ['manifest.json', 'background.js', 'popup.html', 'options.html', 'icons/16.png', 'icons/128.png',
    'content/main.js', 'content/main.css', 'inject/page.html', '_locales/en/messages.json', 'README.md'];
  assert.deepEqual(selectFiles({ files, manifest }).includes('README.md'), false);
  assert.throws(() => selectFiles({ files, manifest, include: ['background.js'] }), /missing files referenced by manifest.json: .*popup.html.*add them to `include`/);
  assert.throws(() => selectFiles({ files: ['background.js'], manifest }), /manifest.json not found/);
  const scriptsManifest = { ...manifest, background: { service_worker: 'scripts/bg.js' } };
  assert.throws(() => selectFiles({ files: [...files, 'scripts/bg.js'], manifest: scriptsManifest }), /scripts\/bg.js .*default denylist/);
});

test('stampManifest validates chrome versions', () => {
  assert.equal(stampManifest({ version: '1' }, '1.2.3').version, '1.2.3');
  assert.throws(() => stampManifest({}, '1.2.3-beta'), /not a valid Chrome extension version/);
  assert.throws(() => stampManifest({}, '1.70000.0'), /not a valid/);
});

test('packageExtension writes a stamped zip without touching the source', { skip: !hasZip() && 'zip not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'));
  const write = (p, c) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  write('manifest.json', JSON.stringify({ manifest_version: 3, name: 'T', version: '0.0.1', background: { service_worker: 'bg.js' } }));
  write('bg.js', '//');
  write('README.md', '#');
  const out = join(dir, '..', `${Date.now()}-out.zip`);
  const res = packageExtension({ dir, version: '2.3.4', out });
  assert.deepEqual(res.files, ['bg.js', 'manifest.json']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version, '0.0.1');
  const listing = execFileSync('unzip', ['-l', out], { encoding: 'utf8' });
  assert.match(listing, /bg\.js/);
  assert.doesNotMatch(listing, /README/);
  const stamped = JSON.parse(execFileSync('unzip', ['-p', out, 'manifest.json'], { encoding: 'utf8' }));
  assert.equal(stamped.version, '2.3.4');

  const unstamped = `${out}.ci.zip`;
  packageExtension({ dir, out: unstamped });
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', unstamped, 'manifest.json'], { encoding: 'utf8' })).version, '0.0.1');
});

function hasZip() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
