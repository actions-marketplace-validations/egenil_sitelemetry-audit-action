# Sitelemetry Audit Action

Run a [Sitelemetry](https://sitelemetry.com) website audit from GitHub Actions and get the result as a SARIF file (for the code-scanning tab), a job summary and one pull request comment. The action is a thin client: it talks to the hosted Sitelemetry MCP endpoint with your API key, polls long audits until they finish, and turns the findings into CI artifacts. No npm dependencies, no build step (Node.js 20 or newer; developed and tested on Node.js 24). The same client runs as a [GitLab CI/CD component](#gitlab-cicd) and from a plain shell.

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
        uses: egenil/sitelemetry-audit-action@v0
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
- uses: egenil/sitelemetry-audit-action@v0
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
      - uses: egenil/sitelemetry-audit-action@v0
        with:
          target: ${{ github.event.deployment_status.target_url }}
          api-key: ${{ secrets.SITELEMETRY_API_KEY }}
          audit: security
          fail-on: none
```

The preview hostname must be reachable from the public internet and you must be authorized to audit it. `deployment_status` is not a `pull_request` event, so no comment is posted; the report is in the job summary.

### Full audit with a non-failing report

```yaml
- uses: egenil/sitelemetry-audit-action@v0
  with:
    target: https://www.example.com
    api-key: ${{ secrets.SITELEMETRY_API_KEY }}
    audit: full
    fail-on: none
    timeout-minutes: 30
```

### Use the outputs

```yaml
- uses: egenil/sitelemetry-audit-action@v0
  id: audit
  with:
    target: https://www.example.com
    api-key: ${{ secrets.SITELEMETRY_API_KEY }}
- run: echo "status=${{ steps.audit.outputs.status }} score=${{ steps.audit.outputs.score }} high=${{ steps.audit.outputs.findings-high }}"
```

## GitLab CI/CD

The same client runs as a GitLab CI/CD component. When `GITLAB_CI=true` it uses no GitHub workflow commands and writes, relative to `CI_PROJECT_DIR`:

| File | Purpose |
| --- | --- |
| `gl-sast-report.json` | GitLab security report (SAST schema 15.1.4), one vulnerability per finding. Uploaded with `artifacts:reports:sast`, it feeds the merge request security widget and the Vulnerability Report (GitLab Ultimate features; the artifact itself is stored on every tier). |
| `sitelemetry.env` | The outputs as dotenv variables `SCORE`, `FINDINGS_TOTAL`, `FINDINGS_CRITICAL`, `FINDINGS_HIGH`, `SARIF_FILE`, `STATUS` and `REPORT_URL`. Uploaded with `artifacts:reports:dotenv`, later jobs read them as CI/CD variables. Path: `SITELEMETRY_OUTPUT_FILE`. |
| `sitelemetry-summary.md` | The markdown report (what the Action puts in the job summary). Path: `SITELEMETRY_SUMMARY_FILE`. |
| `sitelemetry.sarif` | The SARIF 2.1.0 file, as on GitHub (`sarif_file` input). |

In a merge request pipeline it also posts or updates one merge request note with the report (same hidden markers as the pull request comment) when `SITELEMETRY_GITLAB_TOKEN` is set.

### Use the component

```yaml
include:
  - component: gitlab.com/sitelemetry/audit-action/audit@0.2.2
    inputs:
      target: https://www.example.com
      fail_on: high
```

Add `SITELEMETRY_API_KEY` as a masked CI/CD variable (**Settings > CI/CD > Variables**); the component's `api_key` input defaults to it. The job `sitelemetry-audit` runs in the `test` stage on merge request pipelines and on the default branch, in `node:24-alpine`, with `allow_failure: false` so findings at or above `fail_on` fail the pipeline.

Until the component is published in the CI/CD Catalog (see below), or on an instance that cannot reach the gitlab.com catalog, include the template straight from this repository. `include:remote` accepts the same inputs:

```yaml
include:
  - remote: https://raw.githubusercontent.com/egenil/sitelemetry-audit-action/v0/templates/audit.yml
    inputs:
      target: https://www.example.com
```

The component inputs are `target`, `api_key`, `audit`, `profile`, `fail_on`, `sarif_file`, `comment`, `base_url`, `timeout_minutes`, `stage` (default `test`) and `image` (default `node:24-alpine`). They are passed to the client as the same `INPUT_*` environment variables the Action uses (`INPUT_TARGET`, `INPUT_API_KEY`, `INPUT_AUDIT`, `INPUT_PROFILE`, `INPUT_FAIL_ON`, `INPUT_SARIF_FILE`, `INPUT_COMMENT`, `INPUT_BASE_URL`, `INPUT_TIMEOUT_MINUTES`), so a hand-written job can set them directly and run `node src/run.mjs`. `INPUT_GITLAB_REPORT` (`true`, `false` or a path) controls the security report outside GitLab.

### Merge request note

GitLab's `CI_JOB_TOKEN` cannot create merge request notes, so the note needs a token of its own: create a project access token (**Settings > Access tokens**) with the `api` scope and the Reporter role, and store it as a masked CI/CD variable named `SITELEMETRY_GITLAB_TOKEN`. Without it the job logs `Skipping the merge request note` and the report is still available as `sitelemetry-summary.md` and in the security widget. The client never sends `CI_JOB_TOKEN` anywhere.

### Publishing the component to the CI/CD Catalog

Catalog components must live in a project on the GitLab instance that uses them, so this repository has to be mirrored to gitlab.com:

1. Create the project `sitelemetry/audit-action` on gitlab.com (a project description and a `README.md` are required for the catalog) and push this repository to it, or set it up as a pull mirror of the GitHub repository.
2. Enable **Settings > General > Visibility, project features, permissions > CI/CD Catalog project**.
3. Add a release: tag a commit with a semantic version (`0.2.0`) and create the release from a pipeline job that uses the `release` keyword. Every such release publishes that version of `templates/audit.yml` to the catalog as `gitlab.com/sitelemetry/audit-action/audit@0.2.2`.

The full walkthrough, including a release job and the dotenv outputs in downstream jobs, is in [docs/gitlab.md](docs/gitlab.md). Plan and quota facts are the same as above; the pricing link in GitLab reports carries `utm_source=gitlab-ci`.

## What the client sends and stores

- To `sitelemetry.com`: the target URL and the audit options you configure (`audit`, `profile`), authenticated with your API key. Nothing from the repository, the workflow or the runner is sent.
- To `api.github.com`: the pull request comment, when enabled, using the workflow's `GITHUB_TOKEN`.
- To your GitLab instance (`CI_API_V4_URL`): the merge request note, when enabled, using `SITELEMETRY_GITLAB_TOKEN`.
- On the runner: the SARIF file and the job summary on GitHub; the SARIF file, `gl-sast-report.json`, `sitelemetry.env` and `sitelemetry-summary.md` on GitLab and in plain CLI use. Findings can include URLs and response details of the audited site; treat these files as you would any security report.

The pull request comment and the merge request note carry the hidden marker `<!-- sitelemetry-audit -->` (plus a per-audit-kind marker) so reruns update the existing one instead of adding new ones.

## Development

```sh
node --test          # unit tests plus integration tests (GitHub, GitLab and CLI modes) against a local mock server
npm run check        # syntax check of every source file
```

## License

MIT, see [LICENSE](LICENSE).
