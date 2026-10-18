# report-problem

Opt-in crash reporting for Chrome extensions. No server, no SDK, no account, no new permission.
Errors stay on the device; the user taps "Report a problem" and a prefilled GitHub issue (label `crash`)
opens for them to read and send. The daily crash-fix routine reads those issues.

## Add it to an app (3 steps)

1. Copy `report-problem.js` from this folder into the extension (keep the file name; the CI check looks for it).
2. Load it first on every page that runs your code:
   `<script src="report-problem.js" data-repo="owner/repo"></script>`
3. Add a "Report a problem" link in settings that calls `ReportProblem.open()`.

Optional: `ReportProblem.configure({ strings: { message, report, dismiss } })` to translate the prompt.
Add one sentence to your privacy policy: errors are stored on the device and only shared if the user
chooses to report them (the extension itself makes no network request).

## CI

`app-ci.yml` runs `scripts/check-report-problem.mjs` and writes `ok`, `outdated`, `modified`,
`not loaded` or `missing` to the job summary. It only warns by default; pass `require_report_problem: true`
to the workflow to make anything other than `ok` fail the check.

## Updating

Bump the `v1` in the first line when behaviour changes, copy the new file into each app, and CI flags
apps still on the old copy as `outdated`.
