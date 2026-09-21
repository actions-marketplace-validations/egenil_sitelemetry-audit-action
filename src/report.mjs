// Markdown for the job summary and the pull request comment.
import { SEVERITIES, clip } from './outcome.mjs';
import { formatPrice, kindLabel } from './plans.mjs';

export const MARKER = '<!-- sitelemetry-audit -->';
export const kindMarker = (kind) => `<!-- sitelemetry-audit:kind=${kind} -->`;
// The pricing link names the platform that produced the report.
const UTM_SOURCES = Object.freeze({ github: 'github-action', gitlab: 'gitlab-ci', cli: 'cli' });
export const pricingUrl = (platform = 'github') => `https://sitelemetry.com/pricing?utm_source=${UTM_SOURCES[platform] || UTM_SOURCES.github}&utm_medium=ci`;
export const PRICING_URL = pricingUrl('github');
export const APP_URL = 'https://sitelemetry.com/app';

const AUDIT_LABELS = Object.freeze({
  security: 'Security', seo: 'Technical SEO', ai_visibility: 'AI visibility', integrations: 'Integrations',
  accessibility: 'Accessibility', performance: 'Performance', full: 'Full'
});
const STATUS_TEXT = Object.freeze({
  completed: 'Completed',
  partial: 'Completed with partial coverage',
  blocked: 'Not completed',
  quota_exhausted: 'Not run - the monthly audit allowance of the connected account is exhausted',
  plan_required: 'Not run - this audit kind is not included in the connected plan',
  verification_required: 'Not run - ownership verification of the target is required'
});
// verification_required covers several server-side prerequisites; the heading and
// the next step follow the reason the server reported.
const VERIFICATION_TEXT = Object.freeze({
  authorization_consent_required: 'Not run - the connected account must accept the current audit authorization terms',
  target_reverification_required: 'Not run - ownership verification of the target must be renewed',
  verification_scope_required: 'Not run - the current verification of the target does not cover the requested host-level checks'
});
export function statusHeading(model) {
  return (model.status === 'verification_required' && VERIFICATION_TEXT[model.reason]) || STATUS_TEXT[model.status] || model.status;
}
export function verificationStep(model) {
  if (model.status === 'verification_required' && model.reason === 'authorization_consent_required') {
    return `Review and accept the current audit authorization terms for the connected account in the app, then rerun: ${APP_URL}`;
  }
  if (model.status === 'verification_required' || model.notMeasured.some((line) => /verification/i.test(line))) {
    return `Verify ownership of the target in the app (DNS or HTTP challenge) to include the protected checks: ${APP_URL}`;
  }
  return null;
}
const cell = (value, max = 160) => clip(value, max).replace(/\|/g, '\\|');
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function severityBreakdown(counts) {
  return SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => `${counts[severity]} ${severity}`).join(', ') || 'none';
}

// Neutral plan and usage facts. Shown when a plan or quota gate stopped the audit,
// or when the connected account is on the Free plan.
export function renderPlanSection(model, plans, platform = 'github') {
  if (!['quota_exhausted', 'plan_required'].includes(model.status) && model.plan !== 'free') return [];
  const free = plans?.find((plan) => plan.id === 'free') || null;
  const paid = (plans || []).filter((plan) => plan.id !== 'free');
  const lines = ['### Plan and usage', ''];
  if (model.status === 'quota_exhausted') {
    lines.push('The connected account has used its monthly audit allowance. It resets at the start of the next billing period. This run did not start an audit and did not consume allowance.');
  } else if (model.status === 'plan_required') {
    lines.push(`The ${AUDIT_LABELS[model.kind] || model.kind} audit is not included in the connected account's plan. This run did not start an audit and did not consume allowance.`);
  } else {
    lines.push(`The connected account is on the Free plan${free ? `: ${free.moduleCount} public security modules and ${free.securityScans} security scans per month` : ''}.`);
  }
  if (model.remainingScans != null) lines.push(`Remaining security scans in the current period: ${model.remainingScans}.`);
  if (paid.length) {
    lines.push('', 'Paid plans include these audit kinds and security module counts:', '',
      '| Plan | Price | Audit kinds | Security modules | Security scans / month |', '| --- | --- | --- | --- | --- |');
    for (const plan of paid) {
      lines.push(`| ${cell(plan.label)} | ${formatPrice(plan)} | ${plan.auditKinds.map(kindLabel).join(', ') || 'see pricing'} | ${plan.moduleCount ?? 'see pricing'} | ${plan.securityScans ?? 'see pricing'} |`);
    }
  }
  lines.push('', `Plan details: ${pricingUrl(platform)}`, `Target verification and account settings: ${APP_URL}`);
  return lines;
}

export function renderReport(model, { plans = null, maxFindings = 10, platform = 'github' } = {}) {
  const lines = [`## Sitelemetry ${AUDIT_LABELS[model.kind] || model.kind} audit: ${cell(model.target, 200)}`, ''];
  lines.push(`**Status:** ${statusHeading(model)}`);
  const measured = model.status === 'completed' || model.status === 'partial';
  if (!measured && model.message) lines.push('', `> ${cell(model.message, 700)}`);
  if (measured) {
    lines.push('', `**Score:** ${model.score == null ? 'not measured' : `${model.score}/100${model.grade ? ` (${model.grade})` : ''}`}`);
    lines.push(`**Findings:** ${model.total} (${severityBreakdown(model.counts)})${model.passingChecks ? ` - ${model.passingChecks} passing checks` : ''}`);
    if (model.pillars) {
      lines.push('', '| Pillar | Score | Findings |', '| --- | --- | --- |');
      for (const [name, pillar] of Object.entries(model.pillars)) lines.push(`| ${cell(name)} | ${pillar?.score ?? 'n/a'} | ${pillar?.findings ?? 0} |`);
    }
    const top = [...model.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)).slice(0, maxFindings);
    if (top.length) {
      lines.push('', '### Top findings', '', '| Severity | Finding | Location | Fix |', '| --- | --- | --- | --- |');
      for (const finding of top) {
        const title = `${cell(finding.title, 120)}${finding.pillar ? ` (${cell(finding.pillar, 30)})` : ''}`;
        lines.push(`| ${capitalize(finding.severity)} | ${title} | ${cell(finding.location || '-', 80)} | ${cell(finding.fix || '-', 200)} |`);
      }
      if (model.total > top.length) lines.push('', `_${model.total - top.length} more finding(s) are listed in the SARIF file${model.truncated ? ' and in the full report in the app' : ''}._`);
    } else {
      lines.push('', 'No findings were reported for the measured checks.');
    }
    if (model.status === 'partial') {
      lines.push('', '### What was not measured', '', 'Unmeasured checks are not passes.', '');
      for (const line of model.notMeasured) lines.push(`- ${cell(line, 300)}`);
      if (!model.notMeasured.length) lines.push('- Some requested measurements were unavailable; the full result in the app lists them.');
    }
  }
  if (model.reportUrl) lines.push('', `[Open the full report](${model.reportUrl})`);
  const step = verificationStep(model);
  if (step) lines.push('', step);
  const planSection = renderPlanSection(model, plans, platform);
  if (planSection.length) lines.push('', ...planSection);
  const meta = [`Audit kind: ${model.kind}`, model.tool ? `Tool: ${model.tool}` : '', model.jobId ? `Job: ${model.jobId}` : ''].filter(Boolean).join(' - ');
  lines.push('', `<sub>${meta} - Only the target URL and audit options were sent to Sitelemetry.</sub>`);
  return `${lines.join('\n')}\n`;
}

export function renderComment(model, options) {
  return `${MARKER}\n${kindMarker(model.kind)}\n${renderReport(model, options)}`;
}
