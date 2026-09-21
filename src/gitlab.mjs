// GitLab CI plumbing: merge request context and the single merge request note.
import { CLIENT_INFO } from './mcp-client.mjs';

// The predefined CI variables that identify the merge request and the API. The
// note needs a personal or project access token with the api scope: CI_JOB_TOKEN
// cannot create notes, so it is never used here.
export function mergeRequestContext(env = process.env) {
  const iid = Number(env.CI_MERGE_REQUEST_IID);
  if (!Number.isInteger(iid) || iid <= 0 || !(env.CI_MERGE_REQUEST_PROJECT_ID || env.CI_PROJECT_ID) || !env.CI_API_V4_URL) return null;
  return {
    apiUrl: env.CI_API_V4_URL,
    projectId: String(env.CI_MERGE_REQUEST_PROJECT_ID || env.CI_PROJECT_ID),
    iid,
    projectUrl: env.CI_MERGE_REQUEST_PROJECT_URL || env.CI_PROJECT_URL || null,
    token: typeof env.SITELEMETRY_GITLAB_TOKEN === 'string' && env.SITELEMETRY_GITLAB_TOKEN.trim() ? env.SITELEMETRY_GITLAB_TOKEN.trim() : null
  };
}

// Create or update the single note that carries the marker. Returns the note URL.
export async function upsertMergeRequestNote({ apiUrl, projectId, iid, token, body, marker, projectUrl = null, fetchImpl = globalThis.fetch }) {
  const base = `${String(apiUrl).replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`;
  const headers = {
    'private-token': token,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}`
  };
  const request = async (method, url, payload) => {
    const response = await fetchImpl(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitLab API ${method} ${url} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  let existing = null;
  for (let page = 1; page <= 5 && !existing; page += 1) {
    const notes = await request('GET', `${base}?per_page=100&page=${page}&sort=asc&order_by=created_at`);
    if (!Array.isArray(notes) || notes.length === 0) break;
    existing = notes.find((note) => note && !note.system && typeof note.body === 'string' && note.body.includes(marker)) || null;
    if (notes.length < 100) break;
  }
  const trimmed = body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n_Note truncated; see the sitelemetry-summary.md artifact for the full report._\n` : body;
  const saved = existing
    ? await request('PUT', `${base}/${existing.id}`, { body: trimmed })
    : await request('POST', base, { body: trimmed });
  const url = projectUrl && saved?.id != null ? `${String(projectUrl).replace(/\/+$/, '')}/-/merge_requests/${iid}#note_${saved.id}` : null;
  return { url, updated: Boolean(existing) };
}
