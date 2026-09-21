// Local stand-in for the hosted MCP endpoint, /api/plans and the GitHub comments API.
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const TEST_API_KEY = 'sl_test_key_123456';
const TOOLS = ['audit_security', 'audit_seo', 'audit_ai_visibility', 'audit_integrations', 'audit_accessibility', 'audit_performance', 'audit_full'];
export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const actionRequired = (reason, text) => ({
  isError: false,
  content: [{ type: 'text', text }],
  structuredContent: { status: 'action_required', reason, auditExecuted: false, usageConsumed: false }
});
const running = (job) => ({
  content: [{ type: 'text', text: `The audit is still running. Call the same tool with the returned pollArguments unchanged.\n\npollArguments:\n${JSON.stringify(job.pollArguments)}` }],
  structuredContent: { status: 'running', jobId: job.id, executionComplete: false, nextAction: 'poll_same_tool', pollArguments: job.pollArguments, retryAfterMs: 10 }
});
const readBody = (req) => new Promise((resolve) => { let data = ''; req.on('data', (chunk) => { data += chunk; }); req.on('end', () => resolve(data)); });
function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

export async function startMockServer({ apiKey = TEST_API_KEY, runningPolls = 2, tools = TOOLS } = {}) {
  const calls = [];
  const comments = [];
  const jobs = new Map();
  let busyCalls = 0;
  let nextCommentId = 1;
  let base = '';

  function handleCall(message, reply, rpcError, res) {
    const { name, arguments: args = {} } = message.params || {};
    // Like the hosted server, a tool outside the connected plan answers with the
    // entitlement gate; any other unlisted tool is a JSON-RPC error.
    if (!tools.includes(name)) {
      let unlistedHost;
      try { unlistedHost = new URL(args.target).hostname; } catch { unlistedHost = String(args.target); }
      if (unlistedHost === 'plan-result.example') return reply(actionRequired('entitlement_required', 'Audit not started. No audit quota was used. The requested audit requires Starter or higher access and is not included in the connected Free account.'));
      return rpcError(-32602, `Unknown tool: ${name}`);
    }
    if (Object.hasOwn(args, 'jobId')) {
      const job = jobs.get(args.jobId);
      if (!job || job.tool !== name) return reply(actionRequired('audit_job_argument_mismatch', 'The audit job arguments do not match. Call the same tool with the returned pollArguments unchanged.'));
      job.polls += 1;
      return reply(job.polls < runningPolls ? running(job) : job.final);
    }
    let host;
    try { host = new URL(args.target).hostname; } catch { host = String(args.target); }
    const completed = fixture('security-completed.json');
    switch (host) {
      case 'ok.example': {
        const id = `mj_${String(jobs.size).padStart(32, '0')}`;
        const job = { id, tool: name, polls: 0, final: completed, pollArguments: { target: 'https://ok.example/', jobId: id } };
        jobs.set(id, job);
        return reply(running(job));
      }
      case 'sync.example': return reply(completed);
      case 'sse.example':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: completed })}\n\n`);
      case 'free.example': return reply(fixture('security-partial-free.json'));
      case 'full.example': return reply(fixture('full-partial.json'));
      case 'plan.example': return json(res, 402, { error: 'This feature is not included in Free. Upgrade your plan to continue.', code: 'PLAN_UPGRADE_REQUIRED', feature: 'seo' });
      case 'plan-result.example': return reply(actionRequired('entitlement_required', 'Audit not started. No audit quota was used. The requested audit requires Starter or higher access and is not included in the connected Free account.'));
      case 'quota.example': return reply(actionRequired('usage_limit_reached', 'Audit not started. No audit quota was used. The current audit allowance is exhausted. Retry after the allowance resets.'));
      case 'quota-rpc.example': return rpcError(-32603, 'Monthly security scan limit reached for this account (monthly allowance: 10).');
      case 'verify.example': return reply(actionRequired('target_verification_required', 'Audit not started. No audit quota was used. Verify ownership of this target in Sitelemetry or Google Search Console before retrying. No plan change is required.'));
      case 'consent.example': return reply(actionRequired('authorization_consent_required', 'Audit not started. No audit quota was used. Review and accept the current audit authorization terms in your account before retrying.'));
      case 'busy.example':
        if (busyCalls++ === 0) return json(res, 429, { error: 'Another audit is already running for this account. Please retry shortly.' }, { 'retry-after': '0' });
        return reply(completed);
      case 'error.example': return reply({ content: [{ type: 'text', text: 'Error: audit failed' }], isError: true });
      default: return reply({ content: [{ type: 'text', text: `Error: unknown fixture host ${host}` }], isError: true });
    }
  }

  function handleMcp(req, res, body) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (bearer !== apiKey) {
      return json(res, 401, { error: 'Unauthorized. Connect with Sitelemetry OAuth or provide a Sitelemetry MCP API key as a Bearer token.' },
        { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="audit"` });
    }
    let message;
    try { message = JSON.parse(body); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (message.id === undefined || message.id === null) { res.writeHead(202); return res.end(); }
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: message.id, result });
    const rpcError = (code, text) => json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mock-sitelemetry', version: '0.0.0' }, instructions: 'Mock server.' });
      case 'tools/list':
        return reply({ tools: tools.map((name) => ({ name, inputSchema: { type: 'object', properties: { target: { type: 'string' }, jobId: { type: 'string' } } } })) });
      case 'tools/call':
        return handleCall(message, reply, rpcError, res);
      default:
        return rpcError(-32601, `Method not found: ${message.method}`);
    }
  }

  function handleGithub(req, res, url, body) {
    const list = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname);
    const single = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && list) return json(res, 200, comments);
    if (req.method === 'POST' && list) {
      const comment = { id: nextCommentId++, body: JSON.parse(body).body, html_url: `${base}/comments/${nextCommentId - 1}` };
      comments.push(comment);
      return json(res, 201, comment);
    }
    if (req.method === 'PATCH' && single) {
      const comment = comments.find((row) => row.id === Number(single[1]));
      if (!comment) return json(res, 404, { message: 'Not Found' });
      comment.body = JSON.parse(body).body;
      comment.updated = true;
      return json(res, 200, comment);
    }
    return json(res, 404, { message: 'Not Found' });
  }

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: body ? safeParse(body) : null });
    if (url.pathname === '/api/plans') return json(res, 200, fixture('plans.json'));
    if (url.pathname === '/mcp') return handleMcp(req, res, body);
    if (url.pathname.startsWith('/repos/')) return handleGithub(req, res, url, body);
    return json(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    calls,
    comments,
    toolCalls: () => calls.filter((call) => call.path === '/mcp' && call.body?.method === 'tools/call'),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}
