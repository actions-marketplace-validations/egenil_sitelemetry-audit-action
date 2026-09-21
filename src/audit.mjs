// Start an audit and poll it to completion within the time budget.
import { McpHttpError, McpRpcError } from './mcp-client.mjs';

export const AUDIT_TOOLS = Object.freeze({
  security: 'audit_security',
  seo: 'audit_seo',
  ai_visibility: 'audit_ai_visibility',
  integrations: 'audit_integrations',
  accessibility: 'audit_accessibility',
  performance: 'audit_performance',
  full: 'audit_full'
});
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTransientError(error) {
  if (error instanceof McpRpcError) return false;
  if (error instanceof McpHttpError) return error.status >= 500 || error.status === 408;
  return true; // DNS/network failures and request timeouts
}

// The server answers long audits with status "running", a jobId and pollArguments.
// Those arguments are re-sent unchanged to the same tool until the final result.
export async function runAudit({ client, kind, target, profile, deadline, sleep = sleepFor, minWaitMs = 1000, log = () => {} }) {
  const tool = AUDIT_TOOLS[kind];
  const supportsProfile = kind === 'security' || kind === 'full';
  let args = { target, ...(profile && supportsProfile ? { profile } : {}) };
  const remaining = () => deadline - Date.now();
  const wait = async (ms) => {
    const delay = Math.min(Math.max(Number(ms) || 0, minWaitMs), Math.max(0, remaining()));
    if (delay > 0) await sleep(delay);
  };
  let jobId = null;
  let polls = 0;
  let transient = 0;
  let busy = 0;
  let phase = '';
  for (;;) {
    if (remaining() <= 0) return { outcome: 'timeout', tool, jobId, polls };
    let result;
    try {
      result = await client.callTool(tool, args);
    } catch (error) {
      const rateLimited = error instanceof McpHttpError && error.status === 429 && error.code !== 'COMMERCIAL_USAGE_LIMIT_REACHED';
      if (rateLimited && busy++ < 40) {
        const delay = error.retryAfterMs ?? 5000;
        log(`Sitelemetry asked to retry later (${error.message}); waiting ${Math.ceil(delay / 1000)}s.`);
        await wait(delay);
        continue;
      }
      if (isTransientError(error) && transient++ < 3) {
        log(`Transient error (${error.message}); retrying.`);
        await wait(2000 * 2 ** transient);
        continue;
      }
      return { outcome: 'error', tool, error, jobId, polls };
    }
    const structured = result?.structuredContent;
    if (structured?.status === 'running' && typeof structured.jobId === 'string') {
      if (jobId !== structured.jobId) log(`Audit accepted as job ${structured.jobId}; polling until it completes.`);
      // The server says whether the job is queued for capacity or executing.
      const line = (Array.isArray(result?.content) ? result.content : []).find((c) => c?.type === 'text')?.text?.split('\n')[0]?.trim() || '';
      if (line && line !== phase) { phase = line; log(`Sitelemetry: ${line}`); }
      jobId = structured.jobId;
      polls += 1;
      args = structured.pollArguments && typeof structured.pollArguments === 'object' ? structured.pollArguments : { target, jobId };
      await wait(structured.retryAfterMs ?? 2000);
      continue;
    }
    if (structured?.status === 'action_required' && structured.reason === 'audit_job_busy' && busy++ < 10) {
      log('Another audit is already running for this account; retrying shortly.');
      await wait(15_000);
      continue;
    }
    return { outcome: 'result', tool, result, jobId, polls };
  }
}
