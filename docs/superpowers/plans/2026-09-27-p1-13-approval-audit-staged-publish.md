# P1-13 (safe half): approval_id audit trail + Chrome staged publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a purely-recorded `approval_id` audit field to the release GitHub Release, and a `publish_type` (default/staged) input for Chrome Web Store publishing, without changing any existing caller's behavior or the platform's security model.

**Architecture:** Two small, independent, additive changes: (1) `version.mjs` gains an optional audit-trail block appended to the generated release notes only when `approval_id` is non-empty, carrying the run id/url alongside it; (2) `cws.mjs`'s `publish()`/`release()` gain an optional `publishType` parameter (default `'default'` → `DEFAULT_PUBLISH`, unchanged from today) mapped to the CWS v2 `publishType` field. `release.yml` threads two new `workflow_call` inputs (`approval_id`, `publish_type`) to these scripts via env vars, following the exact pattern already used for `bump`/`BASELINE`. No job's `permissions:`, no secret, and no `id-token` grant changes.

**Tech Stack:** Node 20+ ESM, zero dependencies, `node:test`, GitHub Actions reusable workflows (`workflow_call`), `actionlint`.

**Spec:** AppForge AI master plan §13.5 (Chrome staged publish / `setRollout`), §25 (audit: GitHub Release body includes `approval_id` + run id), P1-13 backlog item, safe additive half only. `appforge approval request/verify` and `appforge release beta|production` CLI commands are explicitly OUT of scope (they belong to appforge-kit and depend on a not-yet-stable Paperclip API).

## Global Constraints

- **SECURITY INVARIANT (verbatim, non-negotiable):** "No job that executes app-controlled code has `id-token: write`." App-controlled code = anything from the caller repo: `test`, `build`, `npm ci`, Gradle, Flutter, postinstall scripts, Gradle plugins, and so on.
- Every existing caller of every reusable workflow, with no new input specified, must behave byte-for-byte identically to today: same CWS API request bodies, same release-notes content, same job permissions.
- Do not touch WIF/OIDC config (`WIF_PROVIDER`, `SERVICE_ACCOUNT`, attribute conditions). Do not add any new secret. Do not add `id-token: write` to any job that doesn't already have it. Do not change any existing job's `permissions:` block.
- `approval_id` is a pure audit string. Do NOT add any logic that verifies it against anything — real verification happens in a separate, not-yet-built `appforge approval verify` CLI command that runs before this workflow is ever dispatched, on a machine that can reach Paperclip. This repo has no way to reach Paperclip and must not pretend to.
- Percentage-rollout (`setPublishedDeployPercentage` / `setRollout()`) is explicitly out of scope — only applies to items with >10k 7-day actives, a separate later concern.
- Values from `release.yaml` (and, by the same logic, from workflow inputs) reach scripts through environment variables, never through `${{ }}` interpolated directly into a shell command string.
- Test runner: `npm test` (`node --test tests/*.test.mjs`). Workflow lint: `actionlint` (see `ci.yml`'s `actionlint` job for the pinned version/checksum).
- Follow this repo's own conventions (plain Node ESM scripts + `node:test`, `tests/*.test.mjs`, `tests/helpers.mjs`'s `fakeFetch`), not appforge-kit's.

## Review Focus

1. **`approval_id` with markdown-adjacent characters** (backticks, `---`, embedded newline) — must not corrupt the generated `notes.md` structure or the eventual GitHub Release rendering when embedded into the audit block.
2. **Invalid `publish_type` value** (e.g. `"foo"`) — must fail loudly with a clear, actionable error instead of silently sending a bad or empty `publishType` to the Chrome Web Store API.
3. **Default/omitted new inputs** (`approval_id: ''`, `publish_type: 'default'`) — must produce byte-identical `notes.md` content and byte-identical CWS `:publish` request body (`{"publishType":"DEFAULT_PUBLISH"}`) to pre-change behavior. This is the core backward-compatibility guarantee and gets an explicit regression test, not just "no test broke."
4. **`approval_id` set together with `dry_run: true`** — the audit block must still be written to the `notes.md` artifact (which is uploaded regardless of `dry_run`), since a dry run never reaches the `gh release create` step and that's the only way to make this inspectable without a real release.
5. **`publish_type: staged` together with a target's `publish: false`** (upload-a-draft-only path) — `publish()` is never called on that path today; the new parameter must not force a call to `publish()` or otherwise change the draft-upload behavior.

---

## Task 1: `cws.mjs` — Chrome staged publish (`publish_type`)

**Files:**
- Modify: `scripts/cws.mjs`
- Test: `tests/cws.test.mjs`

**Interfaces:**
- Produces: `export const PUBLISH_TYPES = { default: 'DEFAULT_PUBLISH', staged: 'STAGED_PUBLISH' }`; `publish({ publisher, item, token, fetchImpl, publishType = 'default' })`; `release({ publisher, item, token, zip, version, submit = true, fetchImpl, sleep, pollMs, publishType = 'default' })` — `publishType` is forwarded to `publish()` only when `submit` is true.
- CLI: new `--publish-type <default|staged>` flag on the `release` subcommand, default `default`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/cws.test.mjs` (after the existing `urls follow the v2 resource layout` test, using the existing `P`, `I`, `base`, `published`, `fakeFetch` helpers already in that file):

```js
test('publish defaults to DEFAULT_PUBLISH (unchanged from today)', async () => {
  const f = fakeFetch([{ body: { state: 'PENDING_REVIEW' } }]);
  await publish({ ...base, fetchImpl: f });
  assert.deepEqual(JSON.parse(f.calls[0].body), { publishType: 'DEFAULT_PUBLISH' });
});

test('publish sends STAGED_PUBLISH when publishType is "staged"', async () => {
  const f = fakeFetch([{ body: { state: 'STAGED' } }]);
  await publish({ ...base, publishType: 'staged', fetchImpl: f });
  assert.deepEqual(JSON.parse(f.calls[0].body), { publishType: 'STAGED_PUBLISH' });
});

test('publish rejects an unknown publishType', async () => {
  await assert.rejects(publish({ ...base, publishType: 'bogus', fetchImpl: fakeFetch([]) }), /Unknown publish_type "bogus"/);
});

test('release forwards publishType to publish()', async () => {
  const f = fakeFetch([
    { body: { itemId: I, publishedItemRevisionStatus: published('1.2.3') } },
    { body: { itemId: I, crxVersion: '1.3.0', uploadState: 'SUCCEEDED' } },
    { body: { itemId: I, state: 'STAGED' } },
    { body: { itemId: I, publishedItemRevisionStatus: published('1.2.3'), submittedItemRevisionStatus: published('1.3.0', 'STAGED') } },
  ]);
  const res = await release({ ...base, zip: Buffer.from('zip'), version: '1.3.0', publishType: 'staged', fetchImpl: f });
  assert.equal(res.published.state, 'STAGED');
  assert.deepEqual(JSON.parse(f.calls[2].body), { publishType: 'STAGED_PUBLISH' });
});

test('release with submit=false never resolves publishType (draft upload is unaffected)', async () => {
  const f = fakeFetch([{ body: {} }, { body: { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' } }, { body: {} }]);
  const res = await release({ ...base, zip: Buffer.from('z'), version: '0.1.0', submit: false, publishType: 'bogus', fetchImpl: f });
  assert.equal(res.published, null);
  assert.equal(f.calls.length, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/git-personal/release-platform && node --test tests/cws.test.mjs`
Expected: FAIL — `publish` doesn't accept/use `publishType` yet, so the new assertions fail (existing tests still pass).

- [ ] **Step 3: Implement `publishType` support in `scripts/cws.mjs`**

Add near the top (after `export class StoreError`):

```js
export const PUBLISH_TYPES = { default: 'DEFAULT_PUBLISH', staged: 'STAGED_PUBLISH' };

function resolvePublishType(publishType = 'default') {
  const mapped = PUBLISH_TYPES[publishType];
  if (!mapped) throw new StoreError(`Unknown publish_type "${publishType}" (expected ${Object.keys(PUBLISH_TYPES).join('|')})`);
  return mapped;
}
```

Change `publish()`:

```js
export async function publish({ publisher, item, token, fetchImpl, publishType = 'default' }) {
  let res;
  try {
    res = await request({ method: 'POST', url: urls.publish(publisher, item), token, json: { publishType: resolvePublishType(publishType) }, fetchImpl });
  } catch (err) {
    throw explainCwsError(err, item);
  }
  if (!PUBLISH_OK.has(res.state)) {
    throw new StoreError(`Chrome Web Store did not accept the submission for ${item}: state ${res.state ?? 'missing'}. Response: ${JSON.stringify(res)}`);
  }
  return res;
}
```

Change `release()`'s signature and the line that calls `publish()`:

```js
export async function release({ publisher, item, token, zip, version, submit = true, fetchImpl, sleep, pollMs, publishType = 'default' }) {
  const before = await fetchStatus({ publisher, item, token, fetchImpl }).catch((err) => {
    throw explainCwsError(err, item);
  });
  preflight(before, version, item);
  const uploaded = await upload({ publisher, item, token, zip, fetchImpl, sleep, pollMs });
  if (uploaded.crxVersion && uploaded.crxVersion !== version) {
    throw new StoreError(`Uploaded package reports version ${uploaded.crxVersion}, expected ${version}`);
  }
  const published = submit ? await publish({ publisher, item, token, fetchImpl, publishType }) : null;
  const after = await fetchStatus({ publisher, item, token, fetchImpl });
  return { uploaded, published, status: after };
}
```

Add the CLI flag in `cli()` (inside the `parseArgs` options object, next to `'no-publish'`):

```js
      'publish-type': { type: 'string', default: 'default' },
```

And pass it through in the `release` branch:

```js
  const submit = !values['no-publish'];
  const result = await release({ publisher, item, token, zip: readFileSync(values.zip), version: values.version, submit, publishType: values['publish-type'] });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/git-personal/release-platform && node --test tests/cws.test.mjs`
Expected: PASS, all tests including the 5 new ones and every pre-existing one (`release: preflight, upload, publish, status — happy path` must still assert `{ publishType: 'DEFAULT_PUBLISH' }` unchanged).

- [ ] **Step 5: Commit**

```bash
cd ~/git-personal/release-platform
git add scripts/cws.mjs tests/cws.test.mjs
git commit -m "$(cat <<'EOF'
feat(cws): support Chrome staged publish via publishType

Add an optional publishType parameter to publish()/release() ('default'
-> DEFAULT_PUBLISH, 'staged' -> STAGED_PUBLISH), defaulting to 'default'
so every existing caller's CWS :publish request body is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `version.mjs` — approval_id + run id/url audit trail

**Files:**
- Modify: `scripts/version.mjs`
- Test: `tests/version.test.mjs`

**Interfaces:**
- Produces: `export function auditTrailBlock({ approvalId, runId, runUrl } = {})` → returns `''` when `approvalId` is falsy/empty; otherwise returns a markdown block containing the approval id, run id and run url.
- CLI: new `--approval-id`, `--run-id`, `--run-url` flags (all optional strings, default `''`); when `--notes-file` is given and `--approval-id` is non-empty, the audit block is appended after the generated release notes.

- [ ] **Step 1: Write the failing tests**

Add to `tests/version.test.mjs` (uses only `assert`, no new imports beyond adding `auditTrailBlock` to the existing import line):

```js
test('auditTrailBlock is empty when there is no approval id', () => {
  assert.equal(auditTrailBlock(), '');
  assert.equal(auditTrailBlock({}), '');
  // Run id/url alone, with no approval id, still produce nothing: the block only exists
  // to carry approval_id, and run info rides along with it (see plan Global Constraints).
  assert.equal(auditTrailBlock({ runId: '123', runUrl: 'https://github.com/x/y/actions/runs/123' }), '');
});

test('auditTrailBlock renders approval id with run id/url', () => {
  const block = auditTrailBlock({ approvalId: 'appr-abc123', runId: '456', runUrl: 'https://github.com/x/y/actions/runs/456' });
  assert.match(block, /appr-abc123/);
  assert.match(block, /456/);
  assert.match(block, /https:\/\/github\.com\/x\/y\/actions\/runs\/456/);
});

test('auditTrailBlock does not break on markdown-adjacent characters in approval id', () => {
  const block = auditTrailBlock({ approvalId: 'weird `--- backtick` id\nwith a newline', runId: '1', runUrl: 'https://x' });
  // The raw value is recorded verbatim on its own line; it must not introduce a stray
  // "---" heading break or unescaped backtick block that corrupts the rest of notes.md.
  assert.equal(block.split('\n').filter((l) => l.trim() === '---').length, 1);
  assert.match(block, /weird `--- backtick` id/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/git-personal/release-platform && node --test tests/version.test.mjs`
Expected: FAIL — `auditTrailBlock` is not exported yet.

- [ ] **Step 3: Implement `auditTrailBlock` and thread it into the CLI in `scripts/version.mjs`**

Add after `releaseNotes()`:

```js
/**
 * Optional audit-trail block appended to the generated release notes: purely a recorded
 * string plus this run's own id/url, never verified here (verification, if any, happens
 * before this workflow is ever dispatched). Empty when there is no approval id, so a caller
 * that never sets approval_id gets byte-identical notes to before this existed.
 */
export function auditTrailBlock({ approvalId, runId, runUrl } = {}) {
  if (!approvalId) return '';
  const lines = [`- Approval: ${approvalId}`];
  if (runId) lines.push(`- Run: ${runId}${runUrl ? ` (${runUrl})` : ''}`);
  else if (runUrl) lines.push(`- Run: ${runUrl}`);
  return ['---', '### Audit', ...lines].join('\n');
}
```

Update the CLI's `parseArgs` options (add alongside `'notes-file'`):

```js
      'approval-id': { type: 'string', default: '' },
      'run-id': { type: 'string', default: '' },
      'run-url': { type: 'string', default: '' },
```

Update the notes-writing block at the end of `cli()`:

```js
  if (values['notes-file']) {
    const { writeFileSync } = await import('node:fs');
    const audit = auditTrailBlock({ approvalId: values['approval-id'], runId: values['run-id'], runUrl: values['run-url'] });
    const body = audit ? `${releaseNotes(commits)}\n\n${audit}\n` : `${releaseNotes(commits)}\n`;
    writeFileSync(values['notes-file'], body);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/git-personal/release-platform && node --test tests/version.test.mjs`
Expected: PASS, all tests including the 3 new ones and every pre-existing one unchanged.

- [ ] **Step 5: Commit**

```bash
cd ~/git-personal/release-platform
git add scripts/version.mjs tests/version.test.mjs
git commit -m "$(cat <<'EOF'
feat(version): record approval_id + run id/url as an audit-only block

auditTrailBlock() is empty unless approval_id is set, so every existing
caller's generated notes.md is byte-identical. No verification logic:
this is purely a recorded string for later audit (verification, if any,
happens before this workflow is ever dispatched).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `release.yml` — thread `approval_id` and `publish_type` through

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `auditTrailBlock`/CLI flags from Task 2 (`--approval-id`, `--run-id`, `--run-url` on `version.mjs`); `--publish-type` from Task 1 (`cws.mjs release`).
- Produces: two new `workflow_call` inputs, `approval_id` (string, default `''`) and `publish_type` (string, default `'default'`), usable by every app repo's release caller without any change to that caller.

- [ ] **Step 1: Add the two new `workflow_call` inputs**

In the `on.workflow_call.inputs` block, add after `platform_ref`:

```yaml
      approval_id:
        description: 'Optional audit-only identifier for an external approval record. Recorded verbatim in the GitHub Release notes (run id/url alongside it) if set; NEVER verified here.'
        type: string
        default: ''
      publish_type:
        description: 'Chrome Web Store publish type: default (submit for review normally) or staged (STAGED_PUBLISH, gradual rollout).'
        type: string
        default: 'default'
```

- [ ] **Step 2: Thread `approval_id` + run id/url into the "Compute version" step (`plan` job)**

Change the existing step:

```yaml
      - name: Compute version
        id: version
        working-directory: app/${{ inputs.directory }}
        env:
          BUMP: ${{ inputs.bump }}
          BASELINE: ${{ steps.config.outputs.baseline }}
        run: |
          args=(--bump "$BUMP" --notes-file "$RUNNER_TEMP/notes.md")
          if [ -n "$BASELINE" ]; then args+=(--baseline "$BASELINE"); fi
          node "$GITHUB_WORKSPACE/platform/scripts/version.mjs" "${args[@]}"
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
```

to:

```yaml
      - name: Compute version
        id: version
        working-directory: app/${{ inputs.directory }}
        env:
          BUMP: ${{ inputs.bump }}
          BASELINE: ${{ steps.config.outputs.baseline }}
          APPROVAL_ID: ${{ inputs.approval_id }}
          RUN_ID: ${{ github.run_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          args=(--bump "$BUMP" --notes-file "$RUNNER_TEMP/notes.md")
          if [ -n "$BASELINE" ]; then args+=(--baseline "$BASELINE"); fi
          if [ -n "$APPROVAL_ID" ]; then args+=(--approval-id "$APPROVAL_ID" --run-id "$RUN_ID" --run-url "$RUN_URL"); fi
          node "$GITHUB_WORKSPACE/platform/scripts/version.mjs" "${args[@]}"
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
```

This step already runs with `permissions: contents: read` and no `id-token` (see `plan` job) — unchanged. `APPROVAL_ID`/`RUN_ID`/`RUN_URL` reach the script only via env vars, matching the existing `BASELINE` pattern (never interpolated directly into the shell string).

- [ ] **Step 3: Thread `publish_type` into the "Upload and submit for review" step (`publish-chrome` job)**

Change:

```yaml
      - name: Upload and submit for review
        id: publish
        if: ${{ !inputs.dry_run }}
        env:
          GOOGLE_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
          ITEM: ${{ steps.target.outputs.item_id }}
          VERSION: ${{ needs.plan.outputs.version }}
          SUBMIT: ${{ steps.target.outputs.publish }}
        run: |
          args=(release --item "$ITEM" --zip "$(ls dist/*.zip)" --version "$VERSION")
          if [ "$SUBMIT" != "true" ]; then args+=(--no-publish); fi
          node platform/scripts/cws.mjs "${args[@]}"
```

to:

```yaml
      - name: Upload and submit for review
        id: publish
        if: ${{ !inputs.dry_run }}
        env:
          GOOGLE_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
          ITEM: ${{ steps.target.outputs.item_id }}
          VERSION: ${{ needs.plan.outputs.version }}
          SUBMIT: ${{ steps.target.outputs.publish }}
          PUBLISH_TYPE: ${{ inputs.publish_type }}
        run: |
          args=(release --item "$ITEM" --zip "$(ls dist/*.zip)" --version "$VERSION" --publish-type "$PUBLISH_TYPE")
          if [ "$SUBMIT" != "true" ]; then args+=(--no-publish); fi
          node platform/scripts/cws.mjs "${args[@]}"
```

This step already runs in the `publish-chrome` job, which is the one job intentionally holding `id-token: write` to mint store credentials via `google-github-actions/auth` — that job's `permissions:` block is untouched by this change (still `contents: read, id-token: write`, exactly as before). `publish_type` defaults to `'default'`, so `--publish-type default` maps to `DEFAULT_PUBLISH`, identical to today's hardcoded body.

- [ ] **Step 4: `actionlint` the changed workflow**

Run: `cd ~/git-personal/release-platform && ./actionlint .github/workflows/release.yml` (download actionlint first if not present locally, matching `ci.yml`'s `actionlint` job: version `1.7.12`, checksum `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`, or just `brew install actionlint` / use whatever the environment already has).
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/git-personal/release-platform
git add .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
feat(release): thread approval_id + publish_type workflow_call inputs

Two new optional inputs, both defaulted to preserve today's behavior
exactly: approval_id (audit-only, never verified here) reaches
version.mjs via env vars and is recorded in the release notes only when
non-empty; publish_type ('default'|'staged') reaches cws.mjs and
defaults to 'default' (DEFAULT_PUBLISH), identical to the previous
hardcoded value. No job's permissions, secrets, or id-token grants
changed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ci.yml` fixture coverage — exercise both new inputs

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `release.yml`'s new `approval_id`/`publish_type` inputs (Task 3); the `release-notes` artifact already uploaded, unconditionally, by the `plan` job of `release.yml`.

- [ ] **Step 1: Extend the existing `e2e-dry-run` job's `with:` block**

Change:

```yaml
  e2e-dry-run:
    needs: [test]
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      id-token: write
    uses: ./.github/workflows/release.yml
    with:
      dry_run: true
      bump: patch
      directory: tests/fixtures/chrome-app
      store_preflight: false   # the fixture's item id is fake; real apps keep the read-only preflight
```

to:

```yaml
  e2e-dry-run:
    needs: [test]
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      id-token: write
    uses: ./.github/workflows/release.yml
    with:
      dry_run: true
      bump: patch
      directory: tests/fixtures/chrome-app
      store_preflight: false   # the fixture's item id is fake; real apps keep the read-only preflight
      approval_id: ci-fixture-audit-test-id
      publish_type: staged     # dry run never calls cws.mjs publish(); this only proves the
                                # input is accepted end to end (unit-tested behavior lives in
                                # tests/cws.test.mjs — see Task 1).
```

- [ ] **Step 2: Add a job that asserts the audit trail landed in the release-notes artifact**

Add a new job after `e2e-dry-run` (before `listing-dry-run`, no need to block it):

```yaml
  # Asserts the approval_id + run id set above actually reached the generated release notes,
  # which is the only inspectable evidence in a dry run (no GitHub Release is created).
  verify-audit-trail:
    name: Verify audit trail recorded
    needs: [e2e-dry-run]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: release-notes
          path: notes
      - name: Assert approval_id and run id are recorded
        run: |
          cat notes/notes.md
          grep -q "ci-fixture-audit-test-id" notes/notes.md
          grep -q "${{ github.run_id }}" notes/notes.md
```

- [ ] **Step 3: `actionlint` the changed workflow**

Run: `cd ~/git-personal/release-platform && ./actionlint .github/workflows/ci.yml`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/git-personal/release-platform
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
test(ci): exercise approval_id + publish_type in the fixture dry run

e2e-dry-run now passes both new release.yml inputs; a new
verify-audit-trail job asserts the approval id and run id actually
landed in the generated release-notes artifact, since a dry run never
creates a real GitHub Release to inspect.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: README — document the two new inputs; confirm no `release.yaml`/schema change

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation only).

**Decision to document:** `approval_id` and `publish_type` are `workflow_call` inputs supplied at dispatch time (like `bump`, `dry_run`, `targets`, `directory`, `platform_ref` already are), not fields stored in a per-app `release.yaml`. They are properties of *one release run* (an approval record, a rollout choice), not of the app's release configuration — exactly the same reasoning that already keeps `directory` and `platform_ref` out of `schema/release.schema.json`. No schema change is needed or made.

- [ ] **Step 1: Add both inputs to the "Releasing" input table**

In the `## Releasing` section, change:

```markdown
| Input | Meaning |
| --- | --- |
| `bump` | `auto` (default), `patch`, `minor`, `major` |
| `dry_run` | Validate, test, build, package, authenticate and run the **read-only store preflight** — but no upload, tag or release |
| `targets` | Only these target types, e.g. `chrome` (empty = all) |
```

to:

```markdown
| Input | Meaning |
| --- | --- |
| `bump` | `auto` (default), `patch`, `minor`, `major` |
| `dry_run` | Validate, test, build, package, authenticate and run the **read-only store preflight** — but no upload, tag or release |
| `targets` | Only these target types, e.g. `chrome` (empty = all) |
| `approval_id` | Optional audit-only string, recorded verbatim (with this run's id/url) in the GitHub Release notes when set. Never verified here — see [Audit trail](#audit-trail). |
| `publish_type` | Chrome Web Store publish type: `default` (submit for review, default) or `staged` (`STAGED_PUBLISH`, for a gradual rollout) |
```

- [ ] **Step 2: Add a short "Audit trail" subsection**

Immediately after the "**Per target.**" paragraph and before `## Promoting (Google Play)`, add:

```markdown
**Audit trail.** `approval_id` is a pure string the caller supplies at dispatch time; this
workflow never checks it against anything. When set, it is recorded — together with this run's
own `github.run_id` and `run_url` — in the generated release notes (`notes.md`), which become the
GitHub Release body. That file is written before the dry-run/real-release fork, so it is also
inspectable as the `release-notes` build artifact on a `dry_run: true` run. Verifying that an
`approval_id` corresponds to a real, completed approval is a separate concern (an
`appforge approval verify` step that runs *before* this workflow is dispatched, on a machine that
can reach the approval system) — this repo has no way to reach that system and does not try to.
```

- [ ] **Step 3: Note `approval_id`/`publish_type` alongside `directory`/`platform_ref` in the reference section**

In `## release.yaml reference`, change:

```markdown
Reusable workflow inputs besides the above: `directory` (where `release.yaml` lives; tags stay
repo-wide) and `platform_ref` (advanced; which release-platform commit's scripts to use — by
default the exact commit of the workflow you called, read from the OIDC token's `job_workflow_sha`).
```

to:

```markdown
Reusable workflow inputs besides the above: `directory` (where `release.yaml` lives; tags stay
repo-wide), `platform_ref` (advanced; which release-platform commit's scripts to use — by default
the exact commit of the workflow you called, read from the OIDC token's `job_workflow_sha`),
`approval_id` (audit-only; see [Audit trail](#audit-trail)) and `publish_type` (Chrome
`default`/`staged`). None of these four are `release.yaml` fields: they are properties of one
release *run*, supplied at `workflow_dispatch` time, not of the app's release configuration.
```

- [ ] **Step 4: Diff-check the security-invariant table is untouched**

Run: `cd ~/git-personal/release-platform && git diff README.md | grep -A2 -B2 "id-token\|Runs app code"`
Expected: no output (the table between `### Security model` and `### Pipeline guarantees` is not touched by this diff at all).

- [ ] **Step 5: Commit**

```bash
cd ~/git-personal/release-platform
git add README.md
git commit -m "$(cat <<'EOF'
docs: document approval_id and publish_type inputs

Adds both to the Releasing input table and release.yaml reference, and
a short Audit trail subsection explaining approval_id is recorded, not
verified, here. Documents the decision that both are workflow_call
inputs (like directory/platform_ref already are), not release.yaml
fields, so no schema change was needed. Security invariant table is
untouched by this diff.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full local verification, PR, CI, fresh-reviewer pass

**Files:** none new — verification only.

- [ ] **Step 1: Run the full existing test suite**

Run: `cd ~/git-personal/release-platform && npm test`
Expected: all tests pass (79 pre-existing + 8 new = 87), 0 failures.

- [ ] **Step 2: Run `actionlint` over every workflow and template**

Run: `cd ~/git-personal/release-platform && ./actionlint .github/workflows/*.yml templates/*.yml` (matching the `actionlint` job in `ci.yml`).
Expected: no errors.

- [ ] **Step 3: Validate every example and fixture `release.yaml`**

Run:
```bash
cd ~/git-personal/release-platform
for f in examples/*.yaml tests/fixtures/*/release.yaml; do
  yq -o=json '.' "$f" > /tmp/r.json
  node scripts/validate.mjs --config /tmp/r.json --repo "$(dirname "$f")"
done
```
Expected: no errors (confirms Task 5's "no schema change" decision didn't break existing validation).

- [ ] **Step 4: Diff the security-invariant table against `origin/main`**

Run: `cd ~/git-personal/release-platform && git diff origin/main -- README.md | sed -n '/### Security model/,/### Pipeline guarantees/p'`
Expected: empty output — proves the table is byte-for-byte identical to `main`.

- [ ] **Step 5: Push the branch and open a draft PR**

```bash
cd ~/git-personal/release-platform
direnv exec . git push -u origin HEAD
direnv exec . gh pr create --draft --title "feat: approval_id audit trail + Chrome staged publish (P1-13 safe half)" --body "$(cat <<'EOF'
## Summary
- Adds an optional `approval_id` input to `release.yml`, recorded (with this run's id/url) in
  the generated release notes only when set — pure audit string, never verified here.
- Adds an optional `publish_type` input (`default`|`staged`) threaded to `cws.mjs`'s new
  `publishType` parameter, mapping to the Chrome Web Store v2 API's `DEFAULT_PUBLISH` /
  `STAGED_PUBLISH`. Defaults preserve today's behavior byte-for-byte.
- No job's `permissions:`, no new secret, no new `id-token` grant. Security invariant table in
  README.md is untouched (diffed against main).
- `appforge approval request/verify` and `appforge release beta|production` (the other half of
  P1-13) are deliberately NOT part of this PR — they live in appforge-kit and depend on a
  not-yet-stable Paperclip API contract.

## Test plan
- [ ] `npm test` — 87/87 passing (79 pre-existing + 8 new: 5 in cws.test.mjs, 3 in version.test.mjs)
- [ ] `actionlint` clean on all workflows/templates
- [ ] CI: actionlint, unit tests, app-ci dry run, e2e-dry-run (now with approval_id + publish_type
      set), verify-audit-trail (asserts the audit block landed in the release-notes artifact),
      listing-dry-run all green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI, fix anything red**

Run: `direnv exec . gh pr checks <PR-number>` every ~15s until every check is green (zsh reserves the bare word `status`, so name the variable something else, e.g. `checks_output`). Fix and push follow-up commits if anything fails; re-run this step until clean.

- [ ] **Step 7: Fresh-reviewer pass — "does this preserve the security invariant table" first**

Use `superpowers:receiving-code-review` / a fresh review pass over the whole branch diff (`git diff origin/main...HEAD`). The review's first and mandatory question: does `README.md`'s security-invariant table (the `| Workflow · job | Runs app code? | id-token | Secrets |` table) differ at all from `origin/main`? (It must not — Step 4 already proved this mechanically; the reviewer re-confirms by reading the diff, not by re-trusting the script.) Second: does any job's `permissions:` block in `.github/workflows/release.yml` differ from `origin/main`? (It must not, other than the two new `env:` lines inside existing steps.) Third: for every existing `release.yaml`/caller with no new input specified, is the generated CWS request body and `notes.md` content provably unchanged (point to the regression tests from Tasks 1–2)? Only after all three are answered "no change" / "yes, unchanged, here's the test" does the review pass.

- [ ] **Step 8: Mark ready and merge, or stop for human review**

If the fresh-reviewer pass in Step 7 raises no finding that touches the security invariant, dispatch permissions, or existing-caller compatibility: `direnv exec . gh pr ready <PR-number>` then `direnv exec . gh pr merge <PR-number> --squash --delete-branch`.

If it raises ANY finding that even might touch those three things: still run `direnv exec . gh pr ready <PR-number>` (so the PR is visible), but do NOT merge — report back to the user for an explicit human look instead, per this task's standing instruction for this repo.
