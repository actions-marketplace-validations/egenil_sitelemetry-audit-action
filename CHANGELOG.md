# Changelog

## 0.2.0 - 2026-09-21

GitLab CI/CD support with the GitHub Action unchanged.

- Platform detection: `GITHUB_ACTIONS=true` keeps the Action's behaviour (masking, annotations, step summary, `GITHUB_OUTPUT`, pull request comment); `GITLAB_CI=true` and plain CLI use write files instead and print plain `NOTICE:`, `WARNING:` and `ERROR:` lines. The API key is never written to the log on any platform.
- GitLab and CLI outputs: a dotenv file (`SITELEMETRY_OUTPUT_FILE`, default `sitelemetry.env`) with `SCORE`, `FINDINGS_TOTAL`, `FINDINGS_CRITICAL`, `FINDINGS_HIGH`, `SARIF_FILE`, `STATUS` and `REPORT_URL`, and the markdown report as `SITELEMETRY_SUMMARY_FILE` (default `sitelemetry-summary.md`). Relative paths resolve against `CI_PROJECT_DIR` on GitLab.
- GitLab security report `gl-sast-report.json` (SAST schema 15.1.4): one vulnerability per finding with a stable UUID v5 id from the finding key and the target, severities mapped to `Critical`, `High`, `Medium`, `Low` and `Info`, the finding's URL as `location.file`, the fix as `solution` and the finding key as `sitelemetry_finding` identifier. Written on GitLab, or anywhere with `INPUT_GITLAB_REPORT` (`true`, `false` or a path).
- One merge request note per audit kind through the GitLab REST API (same markers as the pull request comment, updated on reruns) using `SITELEMETRY_GITLAB_TOKEN`. `CI_JOB_TOKEN` is never used; without a token the note is skipped with a log line.
- `templates/audit.yml`: GitLab CI/CD component (`spec:inputs` mirroring the Action inputs plus `stage` and `image`) whose `sitelemetry-audit` job uploads `artifacts:reports:sast` and `artifacts:reports:dotenv`.
- The pricing link in reports names the platform (`utm_source=github-action`, `gitlab-ci` or `cli`).
- Documentation: README section "GitLab CI/CD" and `docs/gitlab.md` (walkthrough, outputs in later jobs, note token, catalog publishing).
- Tests: unit tests for the report writer, platform detection, dotenv format, the platform sinks and the note upsert; GitLab and CLI integration runs against the mock server, which now also serves the GitLab merge request notes API.

## 0.1.0

Initial release.

- Composite action that runs a Sitelemetry audit (`security`, `seo`, `ai_visibility`, `integrations`, `accessibility`, `performance` or `full`) over the hosted MCP endpoint with a Sitelemetry MCP API key.
- Polls long-running audits with the server's `pollArguments` and `retryAfterMs`, bounded by `timeout-minutes`.
- Writes a SARIF 2.1.0 file (one rule per finding identity, severity levels, locations, fix as help text) for `github/codeql-action/upload-sarif`.
- Writes a job summary and posts or updates one pull request comment (marker `<!-- sitelemetry-audit -->`).
- Outputs `score`, `findings-total`, `findings-critical`, `findings-high`, `sarif-file`, `status` and `report-url`.
- `fail-on` severity gate; plan, quota and verification gates are reported as statuses without failing the job.
- Neutral plan and usage section based on the public `/api/plans` catalogue.
- The audit tool is always requested, even when the plan-scoped `tools/list` omits it: the server's pre-execution gate names the reason (for example the Free security-only alternative) without starting an audit. A JSON-RPC rejection of an unlisted tool is reported as `plan_required`.
- `verification_required` distinguishes ownership verification of the target, its renewal, host-scope verification and the account's audit authorization terms in the summary heading and next step.
- No npm dependencies and no build step (Node.js 20 or newer; developed on Node.js 24).
