# Sitelemetry Audit Action

Run a [Sitelemetry](https://sitelemetry.com) website audit from GitHub Actions and get the result as a SARIF file (for the code-scanning tab), a job summary and one pull request comment. The action is a thin client: it talks to the hosted Sitelemetry MCP endpoint with your API key, polls long audits until they finish, and turns the findings into CI artifacts. No npm dependencies, no build step (Node.js 20 or newer; developed and tested on Node.js 24).

Audit kinds: `security` (default), `seo`, `ai_visibility`, `integrations`, `accessibility`, `performance` and `full` (all pillars with one blended score).

## Install

```yaml
name: Sitelemetry audit

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Security audit
        id: sitelemetry
        uses: sitelemetry/sitelemetry-audit-action@v0
        with:
          target: https://www.example.com
          api-key: ${{ secrets.SITELEMETRY_API_KEY }}
          audit: security
          fail-on: high

      - name: Upload SARIF to code scanning
        if: always() && steps.sitelemetry.outputs.sarif-file != ''
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.sitelemetry.outputs.sarif-file }}
          category: sitelemetry-security
```

`actions/checkout` is not required: the audit runs against the live target, not the repository. The `upload-sarif` step is optional; it needs `security-events: write`. The pull request comment needs `pull-requests: write`.

## Get an API key

1. Sign in at <https://sitelemetry.com/app> (a Free account is enough to start).
2. Open **API key** and copy the Sitelemetry MCP API key.
3. Store it as a repository or organization secret, for example `SITELEMETRY_API_KEY`, and pass it through the `api-key` input.

The action registers the key with `::add-mask::` so it never appears in logs. Never write the key into the workflow file.

## Ownership and authorization

Audit only websites you own or are explicitly authorized to test. Every audit is performed by Sitelemetry against the live target and is recorded on the connected account.

An unverified target on the Free plan runs the public posture checks (DNS and email posture, domain registration, TLS, HTTP headers, HTTPS/MITM posture, technology fingerprint). The additional checks included in your plan, such as HTTP methods, exposed files and API surfaces, require ownership verification of the domain (DNS or HTTP challenge) in the app: <https://sitelemetry.com/app>. When a result leaves checks unmeasured for this reason, the summary lists them under **What was not measured** and the `status` output is `partial`. Unmeasured checks are not passes.

Protected checks on a verified target also require that the connected account has accepted the current Sitelemetry audit authorization terms. When the server reports that this is missing, the run ends with `status: verification_required` and the summary names the missing step (ownership verification of the target, its renewal, or the authorization terms), each of which is completed in the app. No audit is started and no allowance is used in that case.

## Plans and quota

The public plan catalogue at `https://sitelemetry.com/api/plans` is the source of truth; the action reads it at run time for the plan section of the report. At the time of writing:

| Plan | Audit kinds | Security modules | Security scans per month |
| --- | --- | --- | --- |
| Free | security | 10 | 10 |
| Starter | full, security, seo, ai, accessibility, performance, integrations, search-console | 13 | 100 |
| Professional | same seven audit kinds | 24 | 2500 |
| Enterprise | same seven audit kinds | 27 | 25000 |

Each completed audit consumes one unit of the monthly allowance; polling a running audit does not consume more. When an audit kind is not included in the connected plan, the run ends with `status: plan_required`; when the monthly allowance is used up, with `status: quota_exhausted`. Neither fails the job, and no audit is started in those cases. The summary and comment then contain a short, factual plan and usage section with links to <https://sitelemetry.com/pricing> and the app.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `target` | yes | | Website URL or domain to audit. |
| `api-key` | yes | | Sitelemetry MCP API key (use a secret). |
| `audit` | no | `security` | `security`, `seo`, `ai_visibility`, `integrations`, `accessibility`, `performance` or `full`. |
| `profile` | no | | Security depth profile (`passive`, `baseline`, `deep`, `all`) for `security` and `full`; must be included in the connected plan. |
| `fail-on` | no | `high` | Fail the job when a finding at or above this severity is reported: `none`, `low`, `medium`, `high` or `critical`. |
| `sarif-file` | no | `sitelemetry.sarif` | SARIF output path, relative to the workspace. Always written, even when no audit ran (empty result set). |
| `comment` | no | `true` | Post or update one pull request comment on `pull_request` events when `GITHUB_TOKEN` is available. |
| `base-url` | no | `https://sitelemetry.com` | Sitelemetry base URL. |
| `timeout-minutes` | no | `20` | Total time budget for starting and polling the audit. |

## Outputs

| Output | Description |
| --- | --- |
| `score` | Measured score from 0 to 100 (blended score for `full`); empty when not measured. |
| `findings-total` | Total number of findings. |
| `findings-critical` | Number of critical findings. |
| `findings-high` | Number of high findings. |
| `sarif-file` | Absolute path of the SARIF 2.1.0 file. |
| `status` | `completed`, `partial`, `blocked`, `quota_exhausted`, `plan_required` or `verification_required`. |
| `report-url` | Link to the full report when the result contains one. |

### Exit code

- `completed` and `partial`: the job fails when any finding is at or above `fail-on` (`none` never fails).
- `blocked` (rejected API key, transport failure, tool error, time budget exceeded): the job fails unless `fail-on` is `none`. An audit that is still running when the budget ends keeps running on the Sitelemetry side; the summary names the job id.
- `plan_required`, `quota_exhausted`, `verification_required`: the job passes with a warning annotation. Gate on the `status` output if you want different behavior.

## Examples

### Fail the pull request on high or critical findings

```yaml
- uses: sitelemetry/sitelemetry-audit-action@v0
  with:
    target: https://www.example.com
    api-key: ${{ secrets.SITELEMETRY_API_KEY }}
    fail-on: high
```

### Audit a Vercel preview deployment

Vercel (and other deployment providers) emit a `deployment_status` event with the preview URL. Run the audit on that event and pass the URL as the target:

```yaml
on:
  deployment_status:

permissions:
  contents: read
  security-events: write
  pull-requests: write

jobs:
  preview-audit:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: sitelemetry/sitelemetry-audit-action@v0
        with:
          target: ${{ github.event.deployment_status.target_url }}
          api-key: ${{ secrets.SITELEMETRY_API_KEY }}
          audit: security
          fail-on: none
```

The preview hostname must be reachable from the public internet and you must be authorized to audit it. `deployment_status` is not a `pull_request` event, so no comment is posted; the report is in the job summary.

### Full audit with a non-failing report

```yaml
- uses: sitelemetry/sitelemetry-audit-action@v0
  with:
    target: https://www.example.com
    api-key: ${{ secrets.SITELEMETRY_API_KEY }}
    audit: full
    fail-on: none
    timeout-minutes: 30
```

### Use the outputs

```yaml
- uses: sitelemetry/sitelemetry-audit-action@v0
  id: audit
  with:
    target: https://www.example.com
    api-key: ${{ secrets.SITELEMETRY_API_KEY }}
- run: echo "status=${{ steps.audit.outputs.status }} score=${{ steps.audit.outputs.score }} high=${{ steps.audit.outputs.findings-high }}"
```

## What the action sends and stores

- To `sitelemetry.com`: the target URL and the audit options you configure (`audit`, `profile`), authenticated with your API key. Nothing from the repository, the workflow or the runner is sent.
- To `api.github.com`: the pull request comment, when enabled, using the workflow's `GITHUB_TOKEN`.
- On the runner: the SARIF file and the job summary. Findings can include URLs and response details of the audited site; treat the SARIF file as you would any security report.

The pull request comment carries the hidden marker `<!-- sitelemetry-audit -->` (plus a per-audit-kind marker) so reruns update the existing comment instead of adding new ones.

## Development

```sh
node --test          # unit tests plus an integration test against a local mock server
npm run check        # syntax check of every source file
```

## License

MIT, see [LICENSE](LICENSE).
