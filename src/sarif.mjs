// SARIF 2.1.0 writer: one rule per finding identity, one result per finding.
import { createHash } from 'node:crypto';
import { ACTION_VERSION } from './mcp-client.mjs';

const LEVELS = Object.freeze({ critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' });
const SECURITY_SEVERITY = Object.freeze({ critical: '9.5', high: '8.0', medium: '5.5', low: '2.5', info: '0.0' });

const slug = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

// Finding keys look like "sf2:<scope>:id:<source-id>:loc:<hash>:occ:<n>" or
// "sf2:<scope>:issue:<category>:title-<hash>:loc:<hash>:occ:<n>". The same issue
// at different locations shares one rule, so the location and occurrence parts drop.
export function ruleIdFor(finding, kind) {
  const match = /^sf2:([^:]+):(id|issue):(.+?)(?::loc:|$)/.exec(finding.id || '');
  if (match) {
    const scope = slug(match[1]) || slug(kind) || 'audit';
    const identity = match[2] === 'id' ? slug(match[3]) : slug(match[3].split(':')[0]) + '-' + digest(finding.title);
    return `sitelemetry/${scope}/${identity || digest(finding.title)}`;
  }
  return `sitelemetry/${slug(finding.pillar || kind) || 'audit'}/${slug(finding.title) || 'finding'}-${digest(finding.title)}`;
}

export function targetUrl(target) {
  const raw = String(target || '').trim();
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).toString(); } catch { return raw; }
}

export function locationFor(finding, target) {
  const base = targetUrl(target);
  let uri = base;
  const location = String(finding.location || '');
  if (/^https?:\/\//i.test(location)) uri = location;
  else if (location.startsWith('/')) { try { uri = new URL(location, base).toString(); } catch { uri = base; } }
  return {
    physicalLocation: { artifactLocation: { uri } },
    ...(location && location !== uri ? { logicalLocations: [{ name: location, kind: 'resource' }] } : {})
  };
}

export function buildSarif(model, { informationUri = 'https://sitelemetry.com' } = {}) {
  const rules = [];
  const ruleIndex = new Map();
  const results = [];
  for (const finding of model.findings) {
    const ruleId = ruleIdFor(finding, model.kind);
    if (!ruleIndex.has(ruleId)) {
      ruleIndex.set(ruleId, rules.length);
      rules.push({
        id: ruleId,
        name: finding.title.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 80) || 'Finding',
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.impact || finding.title },
        help: { text: finding.fix || 'No remediation guidance was provided.', markdown: finding.fix ? `**Fix:** ${finding.fix}` : 'No remediation guidance was provided.' },
        defaultConfiguration: { level: LEVELS[finding.severity] || 'note' },
        properties: {
          tags: ['sitelemetry', model.kind, finding.category, finding.pillar].filter(Boolean),
          'security-severity': SECURITY_SEVERITY[finding.severity] || '0.0',
          severity: finding.severity
        }
      });
    }
    results.push({
      ruleId,
      ruleIndex: ruleIndex.get(ruleId),
      level: LEVELS[finding.severity] || 'note',
      message: { text: finding.evidence ? `${finding.title}. ${finding.evidence}`.slice(0, 1200) : finding.title },
      locations: [locationFor(finding, model.target)],
      partialFingerprints: { 'sitelemetry/findingKey/v1': finding.id },
      properties: { severity: finding.severity, category: finding.category, pillar: finding.pillar || undefined, impact: finding.impact || undefined }
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Sitelemetry', organization: 'Sitelemetry', version: ACTION_VERSION, informationUri, rules } },
      automationDetails: { id: `sitelemetry/${model.kind}/${slug(new URL(targetUrl(model.target)).hostname || 'target')}` },
      invocations: [{
        executionSuccessful: model.status === 'completed' || model.status === 'partial',
        properties: { target: model.target, kind: model.kind, status: model.status, score: model.score, total: model.total }
      }],
      results,
      properties: { status: model.status, notMeasured: model.notMeasured }
    }]
  };
}
