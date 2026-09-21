import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../src/audit.mjs';
import { McpHttpError, McpRpcError, parseRetryAfter, parseSse, selectResponse } from '../src/mcp-client.mjs';
import { exitCodeFor, interpretOutcome, normalizeFinding } from '../src/outcome.mjs';
import { normalizePlans } from '../src/plans.mjs';
import { APP_URL, MARKER, PRICING_URL, renderComment, renderReport } from '../src/report.mjs';
import { readInputs } from '../src/run.mjs';
import { buildSarif, locationFor, ruleIdFor } from '../src/sarif.mjs';
import { fixture } from './mock-server.mjs';

const context = { kind: 'security', target: 'https://ok.example' };
const completed = () => interpretOutcome({ outcome: 'result', tool: 'audit_security', result: fixture('security-completed.json') }, context);
const plans = normalizePlans(fixture('plans.json').plans);
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

test('SSE bodies and JSON-RPC batches resolve to the matching response', () => {
  const body = ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\nevent: message\ndata: not-json\n\n';
  const messages = parseSse(body);
  assert.equal(messages.length, 1);
  assert.deepEqual(selectResponse(messages, 7).result, { ok: true });
  assert.equal(selectResponse([{ jsonrpc: '2.0', id: 1, result: 'a' }, { jsonrpc: '2.0', id: 2, result: 'b' }], 2).result, 'b');
  assert.equal(selectResponse([[{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]], 3).error.code, -32700);
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(null), null);
});

test('interpretOutcome maps transport, plan, quota and verification outcomes to statuses', () => {
  assert.equal(interpretOutcome({ outcome: 'timeout', tool: 'audit_security', jobId: 'mj_x' }, context).status, 'blocked');
  assert.match(interpretOutcome({ outcome: 'timeout', tool: 'audit_security', jobId: 'mj_x' }, context).message, /mj_x/);
  const unauthorized = interpretOutcome({ outcome: 'error', error: new McpHttpError(401, { error: 'Unauthorized.' }, headers({})) }, context);
  assert.deepEqual([unauthorized.status, unauthorized.reason], ['blocked', 'unauthorized']);
  const paymentRequired = interpretOutcome({ outcome: 'error', error: new McpHttpError(402, { error: 'This feature is not included in Free.', code: 'PLAN_UPGRADE_REQUIRED' }, headers({})) }, context);
  assert.deepEqual([paymentRequired.status, paymentRequired.reason], ['plan_required', 'PLAN_UPGRADE_REQUIRED']);
  const quotaHttp = interpretOutcome({ outcome: 'error', error: new McpHttpError(429, { error: 'Monthly security scan limit reached for this account (monthly allowance: 10).', code: 'COMMERCIAL_USAGE_LIMIT_REACHED' }, headers({ 'retry-after': '60' })) }, context);
  assert.equal(quotaHttp.status, 'quota_exhausted');
  const quotaRpc = interpretOutcome({ outcome: 'error', error: new McpRpcError({ code: -32603, message: 'Monthly security scan limit reached for this account (monthly allowance: 10).' }) }, context);
  assert.equal(quotaRpc.status, 'quota_exhausted');
  const planRpc = interpretOutcome({ outcome: 'error', error: new McpRpcError({ code: -32603, message: 'The requested audit requires Starter or higher access and is not included in the connected Free account.' }) }, context);
  assert.equal(planRpc.status, 'plan_required');
  const gate = (reason) => interpretOutcome({ outcome: 'result', result: { content: [{ type: 'text', text: 'Audit not started.' }], structuredContent: { status: 'action_required', reason, auditExecuted: false, usageConsumed: false } } }, context).status;
  assert.equal(gate('entitlement_required'), 'plan_required');
  assert.equal(gate('usage_limit_reached'), 'quota_exhausted');
  assert.equal(gate('target_verification_required'), 'verification_required');
  assert.equal(gate('authorization_consent_required'), 'verification_required');
  assert.equal(gate('audit_job_unavailable'), 'blocked');
  const toolError = interpretOutcome({ outcome: 'result', result: { isError: true, content: [{ type: 'text', text: 'Error: audit failed' }] } }, context);
  assert.deepEqual([toolError.status, toolError.reason], ['blocked', 'tool_error']);
});

test('interpretOutcome normalizes completed, partial and full results', () => {
  const model = completed();
  assert.equal(model.status, 'completed');
  assert.deepEqual([model.score, model.grade, model.total, model.plan], [82, 'B', 4, 'starter']);
  assert.deepEqual(model.counts, { critical: 0, high: 1, medium: 1, low: 1, info: 1 });
  assert.equal(model.findings[0].fix, 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response.');
  assert.equal(model.findings[2].location, '/robots.txt');

  const free = interpretOutcome({ outcome: 'result', tool: 'audit_security', result: fixture('security-partial-free.json') }, { kind: 'security', target: 'https://free.example' });
  assert.equal(free.status, 'partial');
  assert.equal(free.plan, 'free');
  assert.ok(free.notMeasured.some((line) => line.includes('http-methods, exposure, api-exposure')));
  assert.ok(free.notMeasured.some((line) => line.includes('Module rdap: unavailable (registry_timeout)')));

  const full = interpretOutcome({ outcome: 'result', tool: 'audit_full', result: fixture('full-partial.json') }, { kind: 'full', target: 'https://full.example' });
  assert.equal(full.status, 'partial');
  assert.equal(full.score, 71);
  assert.deepEqual(Object.keys(full.pillars), ['Security', 'SEO']);
  assert.deepEqual(full.notMeasured, ['Performance: PageSpeed Insights was unavailable for this target.']);
  assert.equal(full.findings[0].pillar, 'Security');
  assert.equal(normalizeFinding({ title: 'x', severity: 'bogus' }, 3).severity, 'info');

  // A pillar that ran without a measurement (null score, scope unavailable) and a
  // security module whose skipped checks are listed as "reasons".
  const unmeasured = interpretOutcome({ outcome: 'result', tool: 'audit_full', result: { content: [], structuredContent: {
    status: 'partial', coverageStatus: 'partial', executionComplete: true, complete: true, blended: 70, failedPillars: [], findings: [],
    pillars: { Security: { score: 70, findings: 0 }, Performance: { score: null, findings: 0 } },
    auditDetails: { pillars: {
      Security: { scope: { status: 'partial', plan: 'enterprise', moduleResults: [{ module: 'tls', status: 'unavailable', checkCount: 1, findingCount: 0, reasons: ['The TLS certificate check requires an https:// target.'] }] } },
      Performance: { scope: { status: 'unavailable', method: 'lighthouse_crux' } }
    }, planCoverage: { plan: 'enterprise', skippedPillars: [], skippedSecurityModules: [] } }
  } } }, { kind: 'full', target: 'http://127.0.0.1:8080' });
  assert.equal(unmeasured.status, 'partial');
  assert.equal(unmeasured.score, 70);
  assert.deepEqual(unmeasured.notMeasured, ['Performance: unavailable (no measurement for this target)', 'Module tls: unavailable (The TLS certificate check requires an https:// target.)']);
});

test('exitCodeFor applies the fail-on threshold and treats gates as neutral', () => {
  const model = completed();
  assert.equal(exitCodeFor(model, 'high'), 1);
  assert.equal(exitCodeFor(model, 'critical'), 0);
  assert.equal(exitCodeFor(model, 'medium'), 1);
  assert.equal(exitCodeFor(model, 'none'), 0);
  assert.equal(exitCodeFor({ ...model, counts: { ...model.counts, high: 0 } }, 'high'), 0);
  assert.equal(exitCodeFor({ ...model, status: 'partial' }, 'low'), 1);
  for (const status of ['quota_exhausted', 'plan_required', 'verification_required']) assert.equal(exitCodeFor({ ...model, status }, 'low'), 0);
  assert.equal(exitCodeFor({ ...model, status: 'blocked' }, 'high'), 1);
  assert.equal(exitCodeFor({ ...model, status: 'blocked' }, 'none'), 0);
  assert.throws(() => exitCodeFor(model, 'severe'));
});

test('buildSarif produces SARIF 2.1.0 with one rule per finding identity', () => {
  const model = completed();
  const sarif = buildSarif(model);
  assert.equal(sarif.version, '2.1.0');
  const [run] = sarif.runs;
  assert.equal(run.tool.driver.name, 'Sitelemetry');
  assert.equal(run.results.length, 4);
  assert.equal(run.tool.driver.rules.length, 4);
  assert.deepEqual(run.results.map((r) => r.level), ['error', 'warning', 'note', 'note']);
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'https://ok.example/');
  assert.equal(run.results[2].locations[0].physicalLocation.artifactLocation.uri, 'https://ok.example/robots.txt');
  assert.equal(run.results[3].locations[0].physicalLocation.artifactLocation.uri, 'https://ok.example/');
  assert.equal(run.tool.driver.rules[0].help.text, model.findings[0].fix);
  assert.equal(run.tool.driver.rules[0].id, 'sitelemetry/security-audit/http-headers-hsts-missing');
  assert.equal(run.tool.driver.rules[0].properties['security-severity'], '8.0');
  assert.equal(run.results[0].partialFingerprints['sitelemetry/findingKey/v1'], model.findings[0].id);
  assert.equal(run.results[0].ruleIndex, 0);

  const full = interpretOutcome({ outcome: 'result', tool: 'audit_full', result: fixture('full-partial.json') }, { kind: 'full', target: 'https://full.example' });
  const fullRun = buildSarif(full).runs[0];
  assert.equal(fullRun.results.length, 3);
  assert.equal(fullRun.tool.driver.rules.length, 2, 'the same finding id at two locations shares one rule');
  assert.equal(ruleIdFor({ id: '', title: 'Ad hoc finding' }, 'seo').startsWith('sitelemetry/seo/ad-hoc-finding-'), true);
  assert.equal(locationFor({ location: '' }, 'example.com').physicalLocation.artifactLocation.uri, 'https://example.com/');
  assert.equal(buildSarif({ ...full, findings: [], status: 'blocked' }).runs[0].invocations[0].executionSuccessful, false);
});

test('renderReport shows score, counts, top findings, unmeasured checks and the plan section', () => {
  const model = completed();
  const report = renderReport(model, { plans });
  assert.match(report, /\*\*Score:\*\* 82\/100 \(B\)/);
  assert.match(report, /\*\*Findings:\*\* 4 \(1 high, 1 medium, 1 low, 1 info\)/);
  assert.match(report, /\| High \| HSTS header is missing \| https:\/\/ok\.example\/ \| Send Strict-Transport-Security/);
  assert.doesNotMatch(report, /What was not measured/);
  assert.doesNotMatch(report, /Plan and usage/, 'a paid plan gets no plan section');

  const free = interpretOutcome({ outcome: 'result', tool: 'audit_security', result: fixture('security-partial-free.json') }, { kind: 'security', target: 'https://free.example' });
  const freeReport = renderReport(free, { plans });
  assert.match(freeReport, /### What was not measured/);
  assert.match(freeReport, /Unmeasured checks are not passes/);
  assert.match(freeReport, /require ownership verification of the target: http-methods, exposure, api-exposure/);
  assert.match(freeReport, /### Plan and usage/);
  assert.match(freeReport, /Free plan: 10 public security modules and 10 security scans per month/);
  assert.match(freeReport, /\| Starter \| \$49\/month \| Full, Security, SEO, AI visibility, Accessibility, Performance, Integrations, Search Console \| 13 \| 100 \|/);
  assert.match(freeReport, /\| Enterprise \| \$249\/month \|.*\| 27 \| 25000 \|/);
  assert.ok(freeReport.includes(PRICING_URL) && freeReport.includes(APP_URL));
  assert.doesNotMatch(freeReport, /upgrade now|limited time|don't miss/i);

  const quota = { ...model, status: 'quota_exhausted', message: 'Allowance exhausted.', findings: [], total: 0, remainingScans: 0 };
  const quotaReport = renderReport(quota, { plans });
  assert.match(quotaReport, /Not run - the monthly audit allowance/);
  assert.match(quotaReport, /Remaining security scans in the current period: 0/);
  assert.doesNotMatch(quotaReport, /\*\*Score:\*\*/);

  const verify = renderReport({ ...model, status: 'verification_required', message: 'Verify ownership first.', findings: [], total: 0 }, { plans: null });
  assert.match(verify, /Not run - ownership verification of the target is required/);
  assert.match(verify, /Verify ownership of the target in the app/);
  const consent = renderReport({ ...model, status: 'verification_required', reason: 'authorization_consent_required', message: 'Review and accept the current audit authorization terms in your account before retrying.', findings: [], total: 0 }, { plans: null });
  assert.match(consent, /Not run - the connected account must accept the current audit authorization terms/);
  assert.match(consent, /Review and accept the current audit authorization terms for the connected account in the app/);
  assert.doesNotMatch(consent, /Verify ownership of the target in the app/);
  const renew = renderReport({ ...model, status: 'verification_required', reason: 'target_reverification_required', message: 'Renew.', findings: [], total: 0 }, { plans: null });
  assert.match(renew, /ownership verification of the target must be renewed/);

  const full = interpretOutcome({ outcome: 'result', tool: 'audit_full', result: fixture('full-partial.json') }, { kind: 'full', target: 'https://full.example' });
  const fullReport = renderReport(full);
  assert.match(fullReport, /\| Security \| 80 \| 1 \|/);
  assert.match(fullReport, /- Performance: PageSpeed Insights was unavailable for this target\./);

  const comment = renderComment(model, { plans });
  assert.ok(comment.startsWith(`${MARKER}\n<!-- sitelemetry-audit:kind=security -->\n`));
});

test('readInputs validates required inputs and enumerations', () => {
  const base = { INPUT_TARGET: 'https://ok.example', INPUT_API_KEY: 'k' };
  assert.deepEqual(readInputs(base).problems, []);
  assert.equal(readInputs(base).inputs.failOn, 'high');
  assert.equal(readInputs({ ...base, INPUT_COMMENT: 'false' }).inputs.comment, false);
  const bad = readInputs({ INPUT_AUDIT: 'pentest', INPUT_FAIL_ON: 'urgent', INPUT_TIMEOUT_MINUTES: '-2', INPUT_BASE_URL: 'ftp://x' });
  assert.equal(bad.problems.length, 6);
});

test('runAudit re-sends pollArguments unchanged, waits retryAfterMs and honors the deadline', async () => {
  const calls = [];
  const waits = [];
  const pollArguments = { target: 'https://ok.example/', jobId: 'mj_1' };
  const responses = [
    { structuredContent: { status: 'running', jobId: 'mj_1', pollArguments, retryAfterMs: 250 } },
    { structuredContent: { status: 'running', jobId: 'mj_1', pollArguments, retryAfterMs: 50 } },
    { structuredContent: { status: 'completed', score: 90, findings: [] } }
  ];
  const client = { callTool: async (name, args) => { calls.push({ name, args }); return responses.shift(); } };
  const run = await runAudit({ client, kind: 'security', target: 'https://ok.example', profile: 'baseline', deadline: Date.now() + 60_000, sleep: async (ms) => waits.push(ms), minWaitMs: 100 });
  assert.equal(run.outcome, 'result');
  assert.equal(run.polls, 2);
  assert.deepEqual(calls[0], { name: 'audit_security', args: { target: 'https://ok.example', profile: 'baseline' } });
  assert.deepEqual(calls[1].args, pollArguments);
  assert.deepEqual(calls[2].args, pollArguments);
  assert.deepEqual(waits, [250, 100]);

  const forever = { callTool: async () => ({ structuredContent: { status: 'running', jobId: 'mj_2', pollArguments: { jobId: 'mj_2' }, retryAfterMs: 5 } }) };
  let now = 0;
  const clock = { sleep: async (ms) => { now += ms; } };
  const originalNow = Date.now;
  Date.now = () => originalNow() + now;
  try {
    const timedOut = await runAudit({ client: forever, kind: 'seo', target: 'https://ok.example', deadline: originalNow() + 30, sleep: clock.sleep, minWaitMs: 10 });
    assert.deepEqual([timedOut.outcome, timedOut.jobId], ['timeout', 'mj_2']);
  } finally {
    Date.now = originalNow;
  }

  let attempts = 0;
  const busy = { callTool: async () => {
    attempts += 1;
    if (attempts === 1) throw new McpHttpError(429, { error: 'Another audit is already running for this account. Please retry shortly.' }, headers({ 'retry-after': '5' }));
    if (attempts === 2) return { structuredContent: { status: 'action_required', reason: 'audit_job_busy' } };
    return { structuredContent: { status: 'completed', findings: [] } };
  } };
  const busyWaits = [];
  const recovered = await runAudit({ client: busy, kind: 'security', target: 'https://ok.example', deadline: Date.now() + 60_000, sleep: async (ms) => busyWaits.push(ms), minWaitMs: 1 });
  assert.equal(recovered.outcome, 'result');
  assert.deepEqual(busyWaits, [5000, 15_000]);

  const exhausted = { callTool: async () => { throw new McpHttpError(429, { error: 'Monthly limit reached.', code: 'COMMERCIAL_USAGE_LIMIT_REACHED' }, headers({})); } };
  const quota = await runAudit({ client: exhausted, kind: 'security', target: 'https://ok.example', deadline: Date.now() + 60_000, sleep: async () => {}, minWaitMs: 1 });
  assert.equal(quota.outcome, 'error');
  assert.equal(quota.error.code, 'COMMERCIAL_USAGE_LIMIT_REACHED');
});
