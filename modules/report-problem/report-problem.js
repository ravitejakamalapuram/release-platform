/* @release-platform/report-problem v1
 * Opt-in crash reporting for Chrome extensions, with no server and no SDK.
 * Errors are kept on the device only. Nothing leaves it until the user taps "Report a problem",
 * which opens a prefilled GitHub issue they can read and edit before sending.
 * Setup: see README.md next to this file in release-platform/modules/report-problem. */
(function () {
  'use strict';
  var KEY = 'rp_errors', MAX = 5, shown = false, memory = [];
  var cfg = {
    repo: '', label: 'crash', version: '',
    strings: { message: 'Something went wrong.', report: 'Report a problem', dismiss: 'Dismiss' }
  };
  var tag = document.currentScript;
  if (tag) { cfg.repo = tag.getAttribute('data-repo') || ''; cfg.label = tag.getAttribute('data-label') || cfg.label; }

  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || memory; } catch (e) { return memory; } }
  function write(list) {
    memory = list.slice(-MAX); // fallback copy for this page if storage is blocked or full
    try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (e) { /* keep the in-memory copy */ }
  }
  function clean(s) { return String(s || '').replace(/(chrome|moz)-extension:\/\/[^/]+\//g, ''); }
  function version() {
    if (cfg.version) return cfg.version;
    try { return chrome.runtime.getManifest().version; } catch (e) { return 'unknown'; }
  }

  function record(msg, src, stack) {
    msg = clean(msg);
    if (/ResizeObserver loop/.test(msg)) return;
    var list = read(), where = clean(src), last = list[list.length - 1];
    if (!(last && last.msg === msg && last.where === where)) {
      list.push({ at: new Date().toISOString(), msg: msg, where: where, stack: clean(stack).split('\n').slice(0, 4).join('\n') });
      write(list);
    }
    prompt();
  }

  window.addEventListener('error', function (e) {
    record(e.message, (e.filename || '') + ':' + (e.lineno || 0), e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    record(r && r.message ? r.message : String(r), '', r && r.stack);
  });

  function issueUrl() {
    var errs = read(), body = [
      '**Version:** ' + version(), '**Browser:** ' + navigator.userAgent, '',
      '**Errors** (kept on your device until you opened this draft; opening it sends them to GitHub, and nothing is posted until you submit):', '```',
      errs.map(function (x) { return x.at + '  ' + x.msg + '  ' + x.where + (x.stack ? '\n' + x.stack : ''); }).join('\n\n') || 'none recorded',
      '```', '', '**What were you doing?** (optional)', ''
    ].join('\n');
    var title = errs.length ? errs[errs.length - 1].msg.slice(0, 80) : 'Problem report';
    return 'https://github.com/' + cfg.repo + '/issues/new?labels=' + encodeURIComponent(cfg.label) +
      '&title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body.slice(0, 5000));
  }

  function open() {
    if (!cfg.repo) { console.error('ReportProblem: set data-repo="owner/repo" on the script tag'); return; }
    window.open(issueUrl(), '_blank', 'noopener');
  }

  function prompt() {
    if (shown || !document.body) return;
    shown = true;
    var bar = document.createElement('div'), s = cfg.strings;
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;max-width:90vw;' +
      'display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;font:14px system-ui,sans-serif;' +
      'background:#222;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    function btn(text, fn) {
      var b = document.createElement('button');
      b.textContent = text; b.style.cssText = 'font:inherit;cursor:pointer;border:1px solid #fff;background:none;color:inherit;border-radius:6px;padding:4px 10px';
      b.onclick = fn; return b;
    }
    bar.appendChild(document.createTextNode(s.message));
    bar.appendChild(btn(s.report, function () { open(); bar.remove(); }));
    bar.appendChild(btn(s.dismiss, function () { bar.remove(); }));
    document.body.appendChild(bar);
  }

  window.ReportProblem = {
    open: open,
    count: function () { return read().length; },
    configure: function (o) {
      if (o.strings) for (var k in o.strings) cfg.strings[k] = o.strings[k];
      ['repo', 'label', 'version'].forEach(function (k) { if (o[k]) cfg[k] = o[k]; });
    }
  };
})();
