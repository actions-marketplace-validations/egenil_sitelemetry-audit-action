// Turn a raw audit outcome into one normalized model and decide the exit code.
import { createHash } from 'node:crypto';
import { McpHttpError, McpRpcError } from './mcp-client.mjs';

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
export const FAIL_ON = Object.freeze(['none', 'low', 'medium', 'high', 'critical']);
export const STATUSES = Object.freeze(['completed', 'partial', 'blocked', 'quota_exhausted', 'plan_required', 'verification_required']);

// Pre-execution gates the server reports as status "action_required".
const REASON_STATUS = Object.freeze({
  entitlement_required: 'plan_required',
  usage_limit_reached: 'quota_exhausted',
  target_verification_required: 'verification_required',
  target_reverification_required: 'verification_required',
  verification_scope_required: 'verification_required',
  authorization_consent_required: 'verification_required'
});
const PLAN_TEXT = /requires (?:starter|professional|enterprise)(?: or higher)? access|not included in (?:the connected|free|the current plan|your plan)|upgrade your plan/i;
const QUOTA_TEXT = /monthly .*limit reached|allowance is exhausted|usage limit reached/i;
const VERIFY_TEXT = /ownership|verif(?:y|ied|ication)|authorization terms/i;

export function statusFromText(text, code) {
  if (code === 'PLAN_UPGRADE_REQUIRED' || PLAN_TEXT.test(text)) return 'plan_required';
  if (code === 'COMMERCIAL_USAGE_LIMIT_REACHED' || QUOTA_TEXT.test(text)) return 'quota_exhausted';
  if (VERIFY_TEXT.test(text)) return 'verification_required';
  return 'blocked';
}

export const clip = (value, max = 400) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const urlOrNull = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);
function pick(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const key of path.split('.')) value = value?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

export function normalizeFinding(raw, index = 0) {
  const severity = SEVERITIES.includes(raw?.severity) ? raw.severity : 'info';
  const title = clip(raw?.title || 'Untitled finding', 200);
  const id = typeof raw?.findingKey === 'string' && raw.findingKey
    ? raw.findingKey
    : `finding-${index}-${createHash('sha256').update(title).digest('hex').slice(0, 8)}`;
  return {
    id,
    severity,
    title,
    evidence: clip(raw?.evidence, 1000),
    impact: clip(raw?.impact, 600),
    fix: clip(raw?.remediation || raw?.fix || raw?.recommendation, 800),
    category: clip(raw?.category, 80),
    location: clip(raw?.location || raw?.url || raw?.path, 2048),
    pillar: clip(raw?.pillar, 40)
  };
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

// Everything the result says was skipped, unavailable or gated. Unmeasured is not a pass.
export function notMeasuredLines(structured) {
  const lines = [];
  for (const row of structured.failedPillars || []) lines.push(`${row.pillar}: ${row.error || 'failed'}`);
  const coverage = structured.auditDetails?.planCoverage;
  for (const row of coverage?.skippedPillars || []) {
    lines.push(`${row.pillar}: ${row.reason === 'not_in_plan' ? 'not included in the connected plan' : 'outside the connected account scope'}`);
  }
  if (coverage?.skippedSecurityModules?.length) lines.push(`Security modules outside the connected plan: ${coverage.skippedSecurityModules.join(', ')}`);
  // A pillar that ran but could not measure (for example Performance without
  // PageSpeed data) keeps a null score; the server marks its scope unavailable.
  for (const [name, pillar] of Object.entries(structured.auditDetails?.pillars || {})) {
    if (pillar?.scope?.status === 'unavailable') lines.push(`${name}: unavailable (no measurement for this target)`);
  }
  const scopes = [structured.auditDetails?.scope, ...Object.values(structured.auditDetails?.pillars || {}).map((pillar) => pillar?.scope)];
  for (const scope of scopes.filter(Boolean)) {
    if (scope.verificationRequiredModules?.length) {
      lines.push(`Security modules that require ownership verification of the target: ${scope.verificationRequiredModules.join(', ')}`);
    }
    for (const row of scope.moduleResults || []) {
      if (!['unavailable', 'partial'].includes(row?.status)) continue;
      // The server lists the skipped or errored checks of a module as "reasons".
      const reasons = (Array.isArray(row.reasons) ? row.reasons : [row.reason]).filter((reason) => typeof reason === 'string' && reason.trim());
      lines.push(`Module ${row.module}: ${row.status}${reasons.length ? ` (${clip(reasons.join('; '), 300)})` : ''}`);
    }
  }
  return [...new Set(lines)];
}

function emptyModel(kind, target, tool, jobId) {
  return {
    kind, target, tool: tool || null, jobId: jobId || null, status: 'blocked', reason: null, message: '',
    score: null, grade: null, counts: countBySeverity([]), total: 0, returnedFindings: 0, truncated: false,
    findings: [], pillars: null, notMeasured: [], plan: null, remainingScans: null, reportUrl: null, passingChecks: null
  };
}

export function interpretOutcome(run, { kind, target }) {
  const model = emptyModel(kind, target, run.tool, run.jobId);
  if (run.outcome === 'timeout') {
    const suffix = run.jobId ? ` Sitelemetry keeps running job ${run.jobId} in the background; rerun later or open the app.` : '';
    return { ...model, reason: 'timeout', message: `The audit did not finish within the time budget.${suffix}` };
  }
  if (run.outcome === 'error') {
    const { error } = run;
    if (error instanceof McpHttpError) {
      if (error.status === 401 || error.status === 403) {
        return { ...model, reason: 'unauthorized', message: `Sitelemetry rejected the request (HTTP ${error.status}): ${error.message}` };
      }
      const status = error.status === 402 ? 'plan_required' : statusFromText(error.message, error.code);
      return { ...model, status: status === 'verification_required' ? 'blocked' : status, reason: error.code || `http_${error.status}`, message: error.message };
    }
    if (error instanceof McpRpcError) return { ...model, status: statusFromText(error.message, null), reason: `rpc_${error.code ?? 'error'}`, message: error.message };
    return { ...model, reason: 'transport', message: error?.message || String(error) };
  }
  const result = run.result || {};
  const text = (Array.isArray(result.content) ? result.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
  const structured = result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : {};
  if (structured.status === 'action_required') {
    return { ...model, status: REASON_STATUS[structured.reason] || 'blocked', reason: structured.reason || 'action_required', message: text || 'The audit was not started.' };
  }
  if (result.isError) return { ...model, status: statusFromText(text, null), reason: 'tool_error', message: text || 'The audit tool returned an error.' };
  if (structured.status === 'running') return { ...model, reason: 'incomplete', message: 'The audit is still running.' };

  const findings = (Array.isArray(structured.findings) ? structured.findings : []).map(normalizeFinding);
  const notMeasured = notMeasuredLines(structured);
  const partial = structured.status === 'partial' || structured.complete === false
    || ['partial', 'unavailable'].includes(structured.coverageStatus) || notMeasured.length > 0;
  const serverCounts = structured.counts && typeof structured.counts === 'object' ? structured.counts : null;
  const counts = countBySeverity(findings);
  if (serverCounts) for (const severity of SEVERITIES) counts[severity] = numberOrNull(serverCounts[severity]) ?? counts[severity];
  const total = numberOrNull(structured.total) ?? findings.length;
  const plan = pick(structured, ['auditDetails.scope.plan', 'auditDetails.planCoverage.plan'])
    || Object.values(structured.auditDetails?.pillars || {}).map((pillar) => pillar?.scope?.plan).find(Boolean) || null;
  return {
    ...model,
    status: partial ? 'partial' : 'completed',
    message: text,
    score: numberOrNull(structured.score ?? structured.blended),
    grade: typeof structured.grade === 'string' ? structured.grade : null,
    counts,
    total,
    returnedFindings: findings.length,
    truncated: structured.findingsTruncated === true || findings.length < total,
    findings,
    pillars: structured.pillars && typeof structured.pillars === 'object' ? structured.pillars : null,
    notMeasured,
    plan: typeof plan === 'string' ? plan : null,
    remainingScans: numberOrNull(pick(structured, ['usage.remaining.securityScans', 'remainingSecurityScans', 'allowance.remaining.securityScans'])),
    reportUrl: urlOrNull(pick(structured, ['reportUrl', 'report.url', 'links.report'])),
    passingChecks: numberOrNull(structured.passingChecks)
  };
}

// Findings decide the exit code only for completed/partial audits. A blocked run
// (bad key, transport failure, timeout) fails the job unless fail-on is "none".
// Plan, quota and verification gates never fail the job; the status output does.
export function exitCodeFor(model, failOn) {
  if (!FAIL_ON.includes(failOn)) throw new Error(`Unsupported fail-on value: ${failOn}`);
  if (model.status === 'completed' || model.status === 'partial') {
    if (failOn === 'none') return 0;
    const threshold = SEVERITIES.indexOf(failOn);
    return SEVERITIES.slice(0, threshold + 1).some((severity) => model.counts[severity] > 0) ? 1 : 0;
  }
  if (model.status === 'blocked') return failOn === 'none' ? 0 : 1;
  return 0;
}
