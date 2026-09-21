# Sitelemetry audit on GitLab CI/CD

This is the GitLab walkthrough for the [Sitelemetry audit client](../README.md). The same Node.js program that powers the GitHub Action runs as a GitLab CI/CD component: it talks to the hosted Sitelemetry MCP endpoint with your API key, polls long audits until they finish, and turns the findings into GitLab artifacts. No npm dependencies, no build step, Node.js 20 or newer.

Audit kinds: `security` (default), `seo`, `ai_visibility`, `integrations`, `accessibility`, `performance` and `full` (all pillars with one blended score).

## What you get

Every run writes these files to the project directory (`CI_PROJECT_DIR`):

| File | Purpose |
| --- | --- |
| `gl-sast-report.json` | GitLab security report, SAST schema 15.1.4. One vulnerability per finding with a stable id, the Sitelemetry severity mapped to `Critical`, `High`, `Medium`, `Low` or `Info`, the finding's URL as `location.file`, the fix as `solution` and the finding key as identifier. Uploaded with `artifacts:reports:sast`. |
| `sitelemetry.env` | The outputs as a dotenv report (`KEY=VALUE` lines): `SCORE`, `FINDINGS_TOTAL`, `FINDINGS_CRITICAL`, `FINDINGS_HIGH`, `SARIF_FILE`, `STATUS`, `REPORT_URL`. Uploaded with `artifacts:reports:dotenv`. |
| `sitelemetry-summary.md` | The markdown report: status, score, finding counts, top findings, what was not measured, plan and usage. |
| `sitelemetry.sarif` | SARIF 2.1.0, the same file the GitHub Action uploads to code scanning. |

In a merge request pipeline the job also posts one merge request note with the report and updates it on reruns (see [Merge request note](#merge-request-note)).

The security report appears in the merge request **Security** widget and in **Secure > Vulnerability report** on GitLab Ultimate. On other tiers the report and the other files are still stored as job artifacts and can be downloaded from the job page.

## Prerequisites

1. A Sitelemetry account: sign in at <https://sitelemetry.com/app> (a Free account is enough to start), open **API key** and copy the Sitelemetry MCP API key.
2. In the GitLab project, **Settings > CI/CD > Variables**: add `SITELEMETRY_API_KEY` with the key, flags **Masked** and, if the pipeline runs on protected branches only, **Protected**. Never write the key into `.gitlab-ci.yml`.
3. GitLab 17.0 or newer for CI/CD components and `spec:inputs` (`include:remote` with inputs works from 16.x).
4. A job image with Node.js 20 or newer; the component defaults to `node:24-alpine`.

Audit only websites you own or are explicitly authorized to test. Every audit is performed by Sitelemetry against the live target and is recorded on the connected account.

## Quick start

With the component from the CI/CD Catalog:

```yaml
include:
  - component: gitlab.com/sitelemetry/audit-action/audit@~latest
    inputs:
      target: https://www.example.com
      audit: security
      fail_on: high
```

Without the catalog (or before the component is published there), include the template from the GitHub repository. Inputs work the same way:

```yaml
include:
  - remote: https://raw.githubusercontent.com/egenil/sitelemetry-audit-action/v0/templates/audit.yml
    inputs:
      target: https://www.example.com
```

Either way you get a job named `sitelemetry-audit` in the `test` stage that runs on merge request pipelines and on the default branch. Override the job like any included job, for example to run it only on merge requests:

```yaml
sitelemetry-audit:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `target` | yes | | Website URL or domain to audit. |
| `api_key` | no | `$SITELEMETRY_API_KEY` | Sitelemetry MCP API key; keep the default and set the masked CI/CD variable. |
| `audit` | no | `security` | `security`, `seo`, `ai_visibility`, `integrations`, `accessibility`, `performance` or `full`. |
| `profile` | no | | Security depth profile (`passive`, `baseline`, `deep`, `all`) for `security` and `full`; must be included in the connected plan. |
| `fail_on` | no | `high` | Fail the job when a finding at or above this severity is reported: `none`, `low`, `medium`, `high` or `critical`. |
| `sarif_file` | no | `sitelemetry.sarif` | SARIF output path, relative to the project directory. Always written, even when no audit ran. |
| `comment` | no | `true` | Post or update one merge request note when the pipeline belongs to a merge request and `SITELEMETRY_GITLAB_TOKEN` is set. |
| `base_url` | no | `https://sitelemetry.com` | Sitelemetry base URL. |
| `timeout_minutes` | no | `20` | Total time budget for starting and polling the audit. |
| `stage` | no | `test` | Pipeline stage of the job. |
| `image` | no | `node:24-alpine` | Container image (Node.js 20 or newer). |

The component maps its inputs to the environment variables the client reads on every platform: `INPUT_TARGET`, `INPUT_API_KEY`, `INPUT_AUDIT`, `INPUT_PROFILE`, `INPUT_FAIL_ON`, `INPUT_SARIF_FILE`, `INPUT_COMMENT`, `INPUT_BASE_URL` and `INPUT_TIMEOUT_MINUTES`. Three more variables are GitLab and CLI specific:

| Variable | Default | Description |
| --- | --- | --- |
| `SITELEMETRY_OUTPUT_FILE` | `sitelemetry.env` | Path of the dotenv outputs file. |
| `SITELEMETRY_SUMMARY_FILE` | `sitelemetry-summary.md` | Path of the markdown report. |
| `INPUT_GITLAB_REPORT` | platform default | `true` writes `gl-sast-report.json`, a path writes that file, `false` disables the report. Unset: written on GitLab, not elsewhere. |
| `SITELEMETRY_GITLAB_TOKEN` | | Token for the merge request note (see below). |

## Outputs

The dotenv report exposes the outputs to later jobs in the pipeline as CI/CD variables:

| Variable | Description |
| --- | --- |
| `SCORE` | Measured score from 0 to 100 (blended score for `full`); empty when not measured. |
| `FINDINGS_TOTAL` | Total number of findings. |
| `FINDINGS_CRITICAL` | Number of critical findings. |
| `FINDINGS_HIGH` | Number of high findings. |
| `SARIF_FILE` | Absolute path of the SARIF file. |
| `STATUS` | `completed`, `partial`, `blocked`, `quota_exhausted`, `plan_required` or `verification_required`. |
| `REPORT_URL` | Link to the full report when the result contains one; otherwise empty. |

```yaml
notify:
  stage: deploy
  needs: [sitelemetry-audit]
  script:
    - echo "status=$STATUS score=$SCORE high=$FINDINGS_HIGH critical=$FINDINGS_CRITICAL"
```

To gate on findings inside the audit job use `fail_on`; to react to a status such as `quota_exhausted` without failing, use the `STATUS` variable in a later job.

### Exit code

- `completed` and `partial`: the job fails when any finding is at or above `fail_on` (`none` never fails).
- `blocked` (rejected API key, transport failure, tool error, time budget exceeded): the job fails unless `fail_on` is `none`. An audit that is still running when the budget ends keeps running on the Sitelemetry side; the summary names the job id.
- `plan_required`, `quota_exhausted`, `verification_required`: the job passes with a `WARNING:` log line. Gate on `STATUS` if you want different behavior.

## Merge request note

The note is created through the GitLab REST API (`POST /projects/:id/merge_requests/:iid/notes`) and updated in place on reruns (`PUT .../notes/:note_id`). The note carries the hidden markers `<!-- sitelemetry-audit -->` and `<!-- sitelemetry-audit:kind=<audit> -->`, so one note per audit kind is kept.

`CI_JOB_TOKEN` cannot create notes, and the client never uses it. Provide a token:

1. **Settings > Access tokens**: create a project access token with the `api` scope and the **Reporter** role (the lowest role that can comment on merge requests). A personal access token with `api` scope also works; a project token keeps the note's author tied to the project.
2. **Settings > CI/CD > Variables**: add `SITELEMETRY_GITLAB_TOKEN` with the token, **Masked**.

Without the variable the job prints `Skipping the merge request note: SITELEMETRY_GITLAB_TOKEN is not set.` and continues; the report is still in `sitelemetry-summary.md` and, on Ultimate, in the security widget. The note is also skipped on branch pipelines (no `CI_MERGE_REQUEST_IID`) and with `comment: 'false'`.

## Ownership and authorization

An unverified target on the Free plan runs the public posture checks (DNS and email posture, domain registration, TLS, HTTP headers, HTTPS/MITM posture, technology fingerprint). The additional checks included in your plan, such as HTTP methods, exposed files and API surfaces, require ownership verification of the domain (DNS or HTTP challenge) in the app: <https://sitelemetry.com/app>. When a result leaves checks unmeasured for this reason, the summary lists them under **What was not measured** and `STATUS` is `partial`. Unmeasured checks are not passes.

Protected checks on a verified target also require that the connected account has accepted the current Sitelemetry audit authorization terms. When the server reports that this is missing, the run ends with `STATUS=verification_required` and the summary names the missing step (ownership verification of the target, its renewal, or the authorization terms), each of which is completed in the app. No audit is started and no allowance is used in that case.

## Plans and quota

The public plan catalogue at `https://sitelemetry.com/api/plans` is the source of truth; the client reads it at run time for the plan section of the report. At the time of writing:

| Plan | Audit kinds | Security modules | Security scans per month |
| --- | --- | --- | --- |
| Free | security | 10 | 10 |
| Starter | full, security, seo, ai, accessibility, performance, integrations, search-console | 13 | 100 |
| Professional | same seven audit kinds | 24 | 2500 |
| Enterprise | same seven audit kinds | 27 | 25000 |

Each completed audit consumes one unit of the monthly allowance; polling a running audit does not consume more. When an audit kind is not included in the connected plan, the run ends with `STATUS=plan_required`; when the monthly allowance is used up, with `STATUS=quota_exhausted`. Neither fails the job, and no audit is started in those cases. The summary and the merge request note then contain a short, factual plan and usage section with links to <https://sitelemetry.com/pricing?utm_source=gitlab-ci&utm_medium=ci> and the app.

## The security report

`gl-sast-report.json` follows the GitLab Security Report Schema for SAST, version 15.1.4:

- `scan`: `analyzer` and `scanner` (`sitelemetry-audit` / `sitelemetry`, vendor Sitelemetry, the client version), `type: sast`, `start_time` and `end_time` (`YYYY-MM-DDTHH:MM:SS`), and `status`: `success` for `completed` and `partial` runs, `failure` for every other status (the vulnerability list is then empty).
- `vulnerabilities[]`: `id` (a UUID v5 derived from the finding key and the target, so the same finding keeps its id across runs), `name`, `description` (impact, evidence and category), `severity`, `solution` (the fix, when the audit provides one), `scanner`, `location` (`file` is the finding's URL or the target, `start_line` is 1) and one identifier of type `sitelemetry_finding` whose value is the finding key.

Severity mapping: `critical` to `Critical`, `high` to `High`, `medium` to `Medium`, `low` to `Low`, `info` to `Info`; anything else becomes `Unknown`.

## Running the client without GitLab

Outside GitHub Actions and GitLab CI the client behaves like the GitLab mode without the merge request note: it writes the SARIF file, `sitelemetry.env` and `sitelemetry-summary.md` to the current directory and prints `NOTICE:`, `WARNING:` or `ERROR:` lines instead of workflow commands.

```sh
git clone --depth 1 --branch v0 https://github.com/egenil/sitelemetry-audit-action.git
INPUT_TARGET=https://www.example.com INPUT_API_KEY="$SITELEMETRY_API_KEY" INPUT_FAIL_ON=none \
  node sitelemetry-audit-action/src/run.mjs
cat sitelemetry.env
```

Set `INPUT_GITLAB_REPORT=true` to get `gl-sast-report.json` as well.

## Publishing the component to the CI/CD Catalog

A component can only be included with `include:component` from a project on the same GitLab instance, so the catalog needs a copy of this repository on gitlab.com:

1. Create the project `sitelemetry/audit-action` on gitlab.com (group `sitelemetry`, project `audit`). The catalog requires a project description and a `README.md` at the root, and the component template must be in `templates/`.
2. Push this repository there. **Settings > Repository > Mirroring repositories** can pull from `https://github.com/egenil/sitelemetry-audit-action.git` to keep the copy current.
3. **Settings > General > Visibility, project features, permissions**: enable **CI/CD Catalog project**.
4. Publish a version: tag a commit with a semantic version (for example `v0.2.1`; include it as `audit@v0.2.1` or `audit@~latest`) and let a pipeline create the release with the `release` keyword. Releases created this way appear in the catalog; the tag becomes the component version.

```yaml
# .gitlab-ci.yml of the gitlab.com project
create-release:
  stage: deploy
  image: registry.gitlab.com/gitlab-org/release-cli:latest
  rules:
    - if: $CI_COMMIT_TAG =~ /^\d+\.\d+\.\d+$/
  script:
    - echo "Releasing $CI_COMMIT_TAG"
  release:
    tag_name: $CI_COMMIT_TAG
    description: "Sitelemetry audit component $CI_COMMIT_TAG"
```

After the first release, `include: - component: gitlab.com/sitelemetry/audit-action/audit@~latest` resolves; `@~latest` selects the newest release. The GitHub repository stays the source: the GitLab project is a mirror plus releases.

## What the client sends and stores

- To `sitelemetry.com`: the target URL and the audit options you configure (`audit`, `profile`), authenticated with your API key. Nothing from the repository, the pipeline or the runner is sent.
- To your GitLab instance (`CI_API_V4_URL`): the merge request note, when enabled, using `SITELEMETRY_GITLAB_TOKEN`.
- On the runner: `gl-sast-report.json`, `sitelemetry.env`, `sitelemetry-summary.md` and the SARIF file. Findings can include URLs and response details of the audited site; treat these files as you would any security report. The API key is never written to the log.
