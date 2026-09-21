// GitLab Security Report (SAST, schema 15.x) writer: one vulnerability per finding.
import { createHash } from 'node:crypto';
import { ACTION_VERSION } from './mcp-client.mjs';
import { locationFor, targetUrl } from './sarif.mjs';

export const SCHEMA_VERSION = '15.1.4';
export const SEVERITY_MAP = Object.freeze({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' });
const SCANNER = Object.freeze({ id: 'sitelemetry', name: 'Sitelemetry' });
const VENDOR = Object.freeze({ name: 'Sitelemetry' });
// RFC 4122 URL namespace: the vulnerability id is a UUID v5 of "<target>#<finding key>".
const NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export const gitlabSeverity = (severity) => SEVERITY_MAP[severity] || 'Unknown';

export function uuidV5(name, namespace = NAMESPACE) {
  const hash = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const findingId = (finding, target) => uuidV5(`${targetUrl(target)}#${finding.id}`);

// The schema wants YYYY-MM-DDTHH:MM:SS without fractional seconds or zone.
export const scanTime = (date) => new Date(date).toISOString().slice(0, 19);

function describe(finding) {
  const parts = [];
  if (finding.impact) parts.push(finding.impact);
  if (finding.evidence) parts.push(`Evidence: ${finding.evidence}`);
  if (finding.category) parts.push(`Category: ${finding.category}`);
  return parts.join('\n\n') || finding.title;
}

export function buildVulnerability(finding, model, seen = new Set()) {
  let id = findingId(finding, model.target);
  for (let n = 2; seen.has(id); n += 1) id = uuidV5(`${targetUrl(model.target)}#${finding.id}#${n}`);
  seen.add(id);
  const file = locationFor(finding, model.target).physicalLocation.artifactLocation.uri;
  const identifier = { type: 'sitelemetry_finding', name: finding.title, value: finding.id };
  if (model.reportUrl) identifier.url = model.reportUrl;
  return {
    id,
    category: 'sast',
    name: finding.title.slice(0, 255),
    description: describe(finding).slice(0, 1_048_576),
    severity: gitlabSeverity(finding.severity),
    ...(finding.fix ? { solution: finding.fix } : {}),
    scanner: { ...SCANNER },
    location: { file, start_line: 1 },
    identifiers: [identifier]
  };
}

export function buildGitlabReport(model, { startedAt = new Date(), endedAt = new Date(), informationUri = 'https://sitelemetry.com' } = {}) {
  const seen = new Set();
  const vulnerabilities = model.findings.map((finding) => buildVulnerability(finding, model, seen));
  const measured = model.status === 'completed' || model.status === 'partial';
  return {
    version: SCHEMA_VERSION,
    scan: {
      analyzer: { id: 'sitelemetry-audit', name: 'Sitelemetry Audit', version: ACTION_VERSION, vendor: { ...VENDOR }, url: informationUri },
      scanner: { ...SCANNER, version: ACTION_VERSION, vendor: { ...VENDOR }, url: informationUri },
      type: 'sast',
      start_time: scanTime(startedAt),
      end_time: scanTime(endedAt),
      status: measured ? 'success' : 'failure'
    },
    vulnerabilities
  };
}
