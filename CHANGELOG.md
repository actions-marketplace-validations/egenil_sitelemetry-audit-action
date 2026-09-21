# Changelog

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
