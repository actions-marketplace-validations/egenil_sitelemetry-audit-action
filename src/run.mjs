#!/usr/bin/env node
// Entry point of the GitHub Action, the GitLab CI/CD component and plain CLI use.
// Inputs arrive as INPUT_* environment variables on every platform.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUDIT_TOOLS, runAudit } from './audit.mjs';
import { pullRequestNumber, upsertPullRequestComment } from './github.mjs';
import { mergeRequestContext, upsertMergeRequestNote } from './gitlab.mjs';
import { buildGitlabReport } from './gitlab-report.mjs';
import { ACTION_VERSION, McpRpcError, createMcpClient } from './mcp-client.mjs';
import { FAIL_ON, exitCodeFor, interpretOutcome } from './outcome.mjs';
import { DEFAULT_GITLAB_REPORT_FILE, annotateFor, createPlatformIo, detectPlatform, workspaceDir, writeTextFile } from './platform.mjs';
import { fetchPlans } from './plans.mjs';
import { kindMarker, renderComment, renderReport } from './report.mjs';
import { buildSarif } from './sarif.mjs';

const PLATFORM_LABELS = Object.freeze({ github: 'GitHub Actions', gitlab: 'GitLab CI', cli: 'CLI' });

export function readInputs(env = process.env) {
  const get = (name, fallback = '') => {
    const value = env[`INPUT_${name}`];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  // INPUT_GITLAB_REPORT: "true" writes gl-sast-report.json, a path writes that
  // file, "false" disables the report (also on GitLab), unset follows the platform.
  const gitlabReport = get('GITLAB_REPORT');
  const inputs = {
    target: get('TARGET'),
    apiKey: get('API_KEY'),
    audit: get('AUDIT', 'security').toLowerCase(),
    profile: get('PROFILE'),
    failOn: get('FAIL_ON', 'high').toLowerCase(),
    sarifFile: get('SARIF_FILE', 'sitelemetry.sarif'),
    comment: get('COMMENT', 'true').toLowerCase() !== 'false',
    baseUrl: get('BASE_URL', 'https://sitelemetry.com'),
    timeoutMinutes: Number(get('TIMEOUT_MINUTES', '20')),
    gitlabReport: gitlabReport.toLowerCase() === 'false' ? false : gitlabReport.toLowerCase() === 'true' ? DEFAULT_GITLAB_REPORT_FILE : gitlabReport || null
  };
  const problems = [];
  if (!inputs.target) problems.push('The "target" input is required.');
  if (!inputs.apiKey) problems.push('The "api-key" input is required (sign in at https://sitelemetry.com/app to create one).');
  if (!AUDIT_TOOLS[inputs.audit]) problems.push(`Unsupported "audit" value "${inputs.audit}". Use one of: ${Object.keys(AUDIT_TOOLS).join(', ')}.`);
  if (!FAIL_ON.includes(inputs.failOn)) problems.push(`Unsupported "fail-on" value "${inputs.failOn}". Use one of: ${FAIL_ON.join(', ')}.`);
  if (!Number.isFinite(inputs.timeoutMinutes) || inputs.timeoutMinutes <= 0) problems.push('The "timeout-minutes" input must be a positive number.');
  try {
    if (!/^https?:$/.test(new URL(inputs.baseUrl).protocol)) throw new Error('scheme');
  } catch {
    problems.push('The "base-url" input must be an http(s) URL.');
  }
  return { inputs, problems };
}

async function execute(inputs, log) {
  const client = createMcpClient({ baseUrl: inputs.baseUrl, apiKey: inputs.apiKey });
  const deadline = Date.now() + inputs.timeoutMinutes * 60_000;
  const tool = AUDIT_TOOLS[inputs.audit];
  const init = await client.initialize();
  log(`Connected to ${client.endpoint} (${init?.serverInfo?.name || 'server'} ${init?.serverInfo?.version || ''}, protocol ${init?.protocolVersion || 'unknown'}).`);
  // tools/list is plan-scoped on the server (a Free account sees only the tools its
  // plan includes). The audit call itself is still made: for a tool outside the
  // plan the server answers with a pre-execution gate that names the reason and
  // consumes no allowance, which is more useful in the report than a local guess.
  let listed = null;
  try {
    const tools = await client.listTools();
    if (tools.length) listed = tools.some((entry) => entry?.name === tool);
    if (listed === false) log(`tools/list does not include ${tool} for the connected account; asking the server for its reason.`);
  } catch (error) {
    log(`tools/list unavailable (${error.message}); continuing with the audit call.`);
  }
  if (inputs.profile && inputs.audit !== 'security' && inputs.audit !== 'full') log(`The "profile" input applies to security and full audits only; ignoring it for ${inputs.audit}.`);
  const minWaitMs = Number(process.env.SITELEMETRY_ACTION_MIN_WAIT_MS) || 1000;
  const run = await runAudit({ client, kind: inputs.audit, target: inputs.target, profile: inputs.profile, deadline, minWaitMs, log });
  if (listed === false && run.outcome === 'error' && run.error instanceof McpRpcError) {
    const text = `The ${tool} tool is not available to the connected account (${run.error.message}). Audit not started; no audit allowance was used.`;
    return { outcome: 'result', tool, result: { isError: false, content: [{ type: 'text', text }], structuredContent: { status: 'action_required', reason: 'entitlement_required', auditExecuted: false, usageConsumed: false } } };
  }
  return run;
}

// One review comment per audit kind: a pull request comment on GitHub, a merge
// request note on GitLab. Reruns update the existing one through its marker.
async function postReviewComment({ platform, env, model, plans, io, log }) {
  const marker = kindMarker(model.kind);
  const body = () => renderComment(model, { plans, platform });
  if (platform === 'github') {
    const pullNumber = pullRequestNumber(env);
    if (!pullNumber) return;
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return log('Skipping the pull request comment: GITHUB_TOKEN is not available to this step.');
    try {
      const saved = await upsertPullRequestComment({ apiUrl: env.GITHUB_API_URL, repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, pullNumber, body: body(), marker });
      log(`${saved.updated ? 'Updated' : 'Posted'} the pull request comment${saved.url ? `: ${saved.url}` : ''}.`);
    } catch (error) {
      io.annotate('warning', `Could not post the pull request comment: ${error.message}`);
    }
    return;
  }
  if (platform !== 'gitlab') return;
  const mr = mergeRequestContext(env);
  if (!mr) return;
  if (!mr.token) return log('Skipping the merge request note: SITELEMETRY_GITLAB_TOKEN is not set. CI_JOB_TOKEN cannot create notes; add a project access token with the api scope as a masked CI/CD variable named SITELEMETRY_GITLAB_TOKEN.');
  try {
    const saved = await upsertMergeRequestNote({ ...mr, body: body(), marker });
    log(`${saved.updated ? 'Updated' : 'Posted'} the merge request note${saved.url ? `: ${saved.url}` : ''}.`);
  } catch (error) {
    io.annotate('warning', `Could not post the merge request note: ${error.message}`);
  }
}

export async function main(env = process.env) {
  const log = (message) => console.log(message);
  const platform = detectPlatform(env);
  const io = createPlatformIo(platform, env, log);
  const { inputs, problems } = readInputs(env);
  io.mask(inputs.apiKey);
  const startedAt = new Date();
  const kind = AUDIT_TOOLS[inputs.audit] ? inputs.audit : 'security';
  const target = inputs.target || '(missing)';
  let model;
  if (problems.length) {
    model = { ...interpretOutcome({ outcome: 'error', error: new Error(problems.join(' ')) }, { kind, target }), reason: 'invalid_inputs' };
  } else {
    log(`Sitelemetry audit ${ACTION_VERSION} on ${PLATFORM_LABELS[platform]}: ${kind} audit of ${target}`);
    try {
      model = interpretOutcome(await execute(inputs, log), { kind, target });
    } catch (error) {
      model = interpretOutcome({ outcome: 'error', error }, { kind, target });
    }
  }
  const wantsPlans = ['quota_exhausted', 'plan_required'].includes(model.status) || model.plan === 'free';
  const plans = wantsPlans && !problems.length ? await fetchPlans(inputs.baseUrl) : null;

  const workspace = workspaceDir(platform, env);
  const sarifPath = resolve(workspace, inputs.sarifFile);
  writeTextFile(sarifPath, `${JSON.stringify(buildSarif(model), null, 2)}\n`);
  log(`SARIF written to ${sarifPath} (${model.findings.length} result(s)).`);
  const gitlabReportFile = inputs.gitlabReport ?? (platform === 'gitlab' ? DEFAULT_GITLAB_REPORT_FILE : null);
  if (gitlabReportFile) {
    const reportPath = resolve(workspace, gitlabReportFile);
    writeTextFile(reportPath, `${JSON.stringify(buildGitlabReport(model, { startedAt, endedAt: new Date() }), null, 2)}\n`);
    log(`GitLab security report written to ${reportPath} (${model.findings.length} vulnerability(ies)).`);
  }

  io.summary(renderReport(model, { plans, platform }));
  io.outputs({
    score: model.score ?? '',
    'findings-total': model.total,
    'findings-critical': model.counts.critical,
    'findings-high': model.counts.high,
    'sarif-file': sarifPath,
    status: model.status,
    ...(model.reportUrl ? { 'report-url': model.reportUrl } : {})
  });
  if (inputs.comment) await postReviewComment({ platform, env, model, plans, io, log });

  const code = exitCodeFor(model, inputs.failOn);
  const headline = `Sitelemetry ${model.kind} audit: ${model.status}${model.score != null ? `, score ${model.score}/100` : ''}, ${model.total} finding(s)`;
  if (model.status === 'blocked') io.annotate(code ? 'error' : 'warning', `${headline}. ${model.message}`);
  else if (model.status === 'completed' || model.status === 'partial') io.annotate(code ? 'error' : 'notice', code ? `${headline}. Findings at or above "${inputs.failOn}" severity fail this job.` : headline);
  else io.annotate('warning', `${headline}. ${model.message}`);
  return code;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    annotateFor(detectPlatform())('error', `Sitelemetry audit action failed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
