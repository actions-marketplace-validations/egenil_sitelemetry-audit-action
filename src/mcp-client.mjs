// Minimal MCP client over Streamable HTTP (JSON-RPC 2.0). Node built-ins only.

export const ACTION_VERSION = '0.2.2';
export const CLIENT_INFO = Object.freeze({ name: 'sitelemetry-audit-action', version: ACTION_VERSION });
const PROTOCOL_VERSION = '2025-06-18';

export class McpHttpError extends Error {
  constructor(status, body, headers) {
    const payload = body && typeof body === 'object' ? body : {};
    const text = typeof payload.error === 'string' ? payload.error
      : typeof payload.error?.message === 'string' ? payload.error.message
        : typeof payload.message === 'string' ? payload.message : `HTTP ${status}`;
    super(text);
    this.name = 'McpHttpError';
    this.status = status;
    this.code = typeof payload.code === 'string' ? payload.code
      : typeof payload.error?.code === 'string' ? payload.error.code : null;
    this.retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'));
  }
}

export class McpRpcError extends Error {
  constructor(error) {
    super(typeof error?.message === 'string' ? error.message : 'JSON-RPC error');
    this.name = 'McpRpcError';
    this.code = error?.code ?? null;
    this.data = error?.data;
  }
}

export function parseRetryAfter(raw) {
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Parse a text/event-stream body into the JSON payloads carried by its data lines.
export function parseSse(text) {
  const messages = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data.trim()) continue;
    try { messages.push(JSON.parse(data)); } catch { /* keep-alive or non-JSON event */ }
  }
  return messages;
}

// Pick the JSON-RPC response for a request id (batches and streams may carry several).
export function selectResponse(messages, id) {
  const flat = messages.flat().filter((m) => m && typeof m === 'object');
  return flat.find((m) => m.id === id) ?? flat.filter((m) => 'result' in m || 'error' in m).at(-1) ?? null;
}

export function createMcpClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch, requestTimeoutMs = 90_000 }) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/mcp`;
  let nextId = 1;
  let sessionId = null;
  let protocolVersion = PROTOCOL_VERSION;

  async function post(message) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
      'user-agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}`,
      'mcp-protocol-version': protocolVersion,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    };
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(requestTimeoutMs)
    });
    sessionId = response.headers.get('mcp-session-id') || sessionId;
    const text = await response.text();
    if (!response.ok) {
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) || `HTTP ${response.status}` }; }
      throw new McpHttpError(response.status, body, response.headers);
    }
    if (response.status === 202 || !text.trim()) return null;
    const type = response.headers.get('content-type') || '';
    return selectResponse(type.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)], message.id);
  }

  async function rpc(method, params) {
    const response = await post({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });
    if (!response) throw new Error(`Empty response for ${method}.`);
    if (response.error) throw new McpRpcError(response.error);
    return response.result;
  }

  return {
    endpoint,
    async initialize() {
      const result = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      if (typeof result?.protocolVersion === 'string') protocolVersion = result.protocolVersion;
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);
      return result;
    },
    async listTools() {
      const result = await rpc('tools/list');
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    callTool(name, args) {
      return rpc('tools/call', { name, arguments: args });
    }
  };
}
