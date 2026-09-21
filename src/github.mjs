// GitHub Actions plumbing: outputs, job summary, masking, annotations, PR comments.
import { appendFileSync, readFileSync } from 'node:fs';
import { CLIENT_INFO } from './mcp-client.mjs';

export function mask(value) {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

export function annotate(level, message) {
  const text = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::${level}::${text}\n`);
}

export function setOutput(name, value, file = process.env.GITHUB_OUTPUT) {
  if (!file) return;
  const text = String(value ?? '');
  const delimiter = `sl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, text.includes('\n') ? `${name}<<${delimiter}\n${text}\n${delimiter}\n` : `${name}=${text}\n`);
}

export function appendSummary(markdown, file = process.env.GITHUB_STEP_SUMMARY) {
  if (file) appendFileSync(file, `${markdown}\n`);
}

export function pullRequestNumber(env = process.env) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) || !env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const number = event?.pull_request?.number ?? event?.number;
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

// Create or update the single comment that carries the marker. Returns the comment URL.
export async function upsertPullRequestComment({ apiUrl, repository, token, pullNumber, body, marker, fetchImpl = globalThis.fetch }) {
  const base = `${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}/repos/${repository}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}`
  };
  const request = async (method, url, payload) => {
    const response = await fetchImpl(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub API ${method} ${url} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  let existing = null;
  for (let page = 1; page <= 5 && !existing; page += 1) {
    const comments = await request('GET', `${base}/issues/${pullNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments) || comments.length === 0) break;
    existing = comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(marker)) || null;
    if (comments.length < 100) break;
  }
  const trimmed = body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n_Comment truncated; see the job summary for the full report._\n` : body;
  const saved = existing
    ? await request('PATCH', `${base}/issues/comments/${existing.id}`, { body: trimmed })
    : await request('POST', `${base}/issues/${pullNumber}/comments`, { body: trimmed });
  return { url: saved?.html_url || null, updated: Boolean(existing) };
}
