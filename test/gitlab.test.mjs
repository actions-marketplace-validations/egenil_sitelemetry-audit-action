import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, buildGitlabReport, findingId, gitlabSeverity, scanTime, uuidV5 } from '../src/gitlab-report.mjs';
import { mergeRequestContext, upsertMergeRequestNote } from '../src/gitlab.mjs';
import { ACTION_VERSION } from '../src/mcp-client.mjs';
import { interpretOutcome } from '../src/outcome.mjs';
import { normalizePlans } from '../src/plans.mjs';
import { OUTPUT_NAMES, createPlatformIo, detectPlatform, dotenvKey, formatDotenv, outputsToDotenv, workspaceDir } from '../src/platform.mjs';
import { PRICING_URL, pricingUrl, renderComment, renderReport } from '../src/report.mjs';
import { readInputs } from '../src/run.mjs';
import { fixture } from './mock-server.mjs';

const context = { kind: 'security', target: 'https://ok.example' };
const completed = () => interpretOutcome({ outcome: 'result', tool: 'audit_security', result: fixture('security-completed.json') }, context);
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const response = (status, payload) => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });

test('buildGitlabReport follows the SAST security report schema 15.x shape', () => {
  const model = completed();
  const report = buildGitlabReport(model, { startedAt: new Date('2026-09-21T10:00:00.123Z'), endedAt: new Date('2026-09-21T10:02:30.999Z') });
  assert.equal(SCHEMA_VERSION, '15.1.4');
  assert.equal(report.version, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(report), ['version', 'scan', 'vulnerabilities']);
  assert.deepEqual(Object.keys(report.scan), ['analyzer', 'scanner', 'type', 'start_time', 'end_time', 'status']);
  assert.deepEqual(report.scan.analyzer, { id: 'sitelemetry-audit', name: 'Sitelemetry Audit', version: ACTION_VERSION, vendor: { name: 'Sitelemetry' }, url: 'https://sitelemetry.com' });
  assert.deepEqual(report.scan.scanner, { id: 'sitelemetry', name: 'Sitelemetry', version: ACTION_VERSION, vendor: { name: 'Sitelemetry' }, url: 'https://sitelemetry.com' });
  assert.equal(report.scan.type, 'sast');
  assert.equal(report.scan.start_time, '2026-09-21T10:00:00');
  assert.equal(report.scan.end_time, '2026-09-21T10:02:30');
  assert.equal(report.scan.status, 'success');
  assert.equal(scanTime('2026-01-02T03:04:05.678Z'), '2026-01-02T03:04:05');

  assert.equal(report.vulnerabilities.length, 4);
  const [first] = report.vulnerabilities;
  assert.deepEqual(Object.keys(first), ['id', 'category', 'name', 'description', 'severity', 'solution', 'scanner', 'location', 'identifiers']);
  assert.equal(first.category, 'sast');
  assert.equal(first.name, 'HSTS header is missing');
  assert.match(first.description, /^Browsers may still make a plain HTTP request first/);
  assert.match(first.description, /Evidence: Affected location: https:\/\/ok\.example\//);
  assert.match(first.description, /Category: http-headers/);
  assert.equal(first.solution, model.findings[0].fix);
  assert.deepEqual(first.scanner, { id: 'sitelemetry', name: 'Sitelemetry' });
  assert.deepEqual(first.location, { file: 'https://ok.example/', start_line: 1 });
  assert.deepEqual(first.identifiers, [{ type: 'sitelemetry_finding', name: 'HSTS header is missing', value: model.findings[0].id }]);
  assert.deepEqual(report.vulnerabilities[2].location, { file: 'https://ok.example/robots.txt', start_line: 1 }, 'a path resolves against the target');
  assert.deepEqual(report.vulnerabilities[3].location, { file: 'https://ok.example/', start_line: 1 }, 'a finding without a location points at the target');

  const bare = buildGitlabReport({ ...model, findings: [{ ...model.findings[0], fix: '', impact: '', evidence: '', category: '' }] });
  assert.equal('solution' in bare.vulnerabilities[0], false);
  assert.equal(bare.vulnerabilities[0].description, 'HSTS header is missing');
  const linked = buildGitlabReport({ ...model, reportUrl: 'https://sitelemetry.com/app/reports/1' });
  assert.equal(linked.vulnerabilities[0].identifiers[0].url, 'https://sitelemetry.com/app/reports/1');
  for (const status of ['blocked', 'plan_required', 'quota_exhausted', 'verification_required']) {
    const gated = buildGitlabReport({ ...model, status, findings: [] });
    assert.equal(gated.scan.status, 'failure');
    assert.deepEqual(gated.vulnerabilities, []);
  }
  assert.equal(buildGitlabReport({ ...model, status: 'partial' }).scan.status, 'success');
});

test('GitLab severities map from Sitelemetry severities', () => {
  assert.deepEqual(['critical', 'high', 'medium', 'low', 'info', 'bogus', undefined].map(gitlabSeverity), ['Critical', 'High', 'Medium', 'Low', 'Info', 'Unknown', 'Unknown']);
  assert.deepEqual(buildGitlabReport(completed()).vulnerabilities.map((v) => v.severity), ['High', 'Medium', 'Low', 'Info']);
  const full = interpretOutcome({ outcome: 'result', tool: 'audit_full', result: fixture('full-partial.json') }, { kind: 'full', target: 'https://full.example' });
  assert.deepEqual(buildGitlabReport(full).vulnerabilities.map((v) => v.severity), ['High', 'Medium', 'Low']);
  const critical = buildGitlabReport({ ...completed(), findings: [{ ...completed().findings[0], severity: 'critical' }] });
  assert.equal(critical.vulnerabilities[0].severity, 'Critical');
});

test('vulnerability ids are stable UUID v5 values derived from the finding key and the target', () => {
  const model = completed();
  const a = buildGitlabReport(model);
  const b = buildGitlabReport(model);
  assert.deepEqual(a.vulnerabilities.map((v) => v.id), b.vulnerabilities.map((v) => v.id));
  for (const vulnerability of a.vulnerabilities) assert.match(vulnerability.id, UUID_V5);
  assert.equal(new Set(a.vulnerabilities.map((v) => v.id)).size, 4);
  assert.equal(findingId(model.findings[0], 'https://ok.example'), a.vulnerabilities[0].id);
  assert.equal(findingId(model.findings[0], 'ok.example'), a.vulnerabilities[0].id, 'the target normalizes to its URL form');
  assert.notEqual(findingId(model.findings[0], 'https://other.example'), a.vulnerabilities[0].id);
  assert.notEqual(findingId(model.findings[0], 'https://ok.example'), findingId(model.findings[1], 'https://ok.example'));
  // RFC 4122 reference vector: uuid5(NAMESPACE_DNS, "python.org").
  assert.equal(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  const duplicated = buildGitlabReport({ ...model, findings: [model.findings[0], model.findings[0]] });
  assert.equal(duplicated.vulnerabilities[0].id, a.vulnerabilities[0].id);
  assert.notEqual(duplicated.vulnerabilities[1].id, duplicated.vulnerabilities[0].id, 'a repeated key still yields distinct ids');
  assert.match(duplicated.vulnerabilities[1].id, UUID_V5);
});

test('detectPlatform keys on GITHUB_ACTIONS and GITLAB_CI; workspaceDir follows the platform', () => {
  assert.equal(detectPlatform({ GITHUB_ACTIONS: 'true' }), 'github');
  assert.equal(detectPlatform({ GITLAB_CI: 'true' }), 'gitlab');
  assert.equal(detectPlatform({ GITHUB_ACTIONS: 'true', GITLAB_CI: 'true' }), 'github', 'GitHub wins when both are set');
  assert.equal(detectPlatform({}), 'cli');
  assert.equal(detectPlatform({ CI: 'true', GITHUB_ACTIONS: 'false', GITLAB_CI: 'false' }), 'cli');
  assert.equal(detectPlatform({ GITHUB_OUTPUT: '/tmp/out', GITHUB_STEP_SUMMARY: '/tmp/summary' }), 'cli', 'only GITHUB_ACTIONS=true selects GitHub');
  assert.equal(workspaceDir('github', { GITHUB_WORKSPACE: '/w' }), '/w');
  assert.equal(workspaceDir('gitlab', { CI_PROJECT_DIR: '/builds/g/p' }), '/builds/g/p');
  assert.equal(workspaceDir('gitlab', { GITHUB_WORKSPACE: '/w' }), process.cwd(), 'GitLab ignores GitHub variables');
  assert.equal(workspaceDir('github', { CI_PROJECT_DIR: '/builds/g/p' }), process.cwd());
  assert.equal(workspaceDir('cli', { GITHUB_WORKSPACE: '/w', CI_PROJECT_DIR: '/b' }), process.cwd());
  assert.equal(workspaceDir('gitlab', { CI_PROJECT_DIR: '  ' }), process.cwd());
});

test('dotenv outputs use KEY=VALUE lines with the GitLab variable names', () => {
  assert.deepEqual(OUTPUT_NAMES.map(dotenvKey), ['SCORE', 'FINDINGS_TOTAL', 'FINDINGS_CRITICAL', 'FINDINGS_HIGH', 'SARIF_FILE', 'STATUS', 'REPORT_URL']);
  const text = outputsToDotenv({ score: 82, 'findings-total': 4, 'findings-critical': 0, 'findings-high': 1, 'sarif-file': 'C:\\w\\out\\sitelemetry.sarif', status: 'completed' });
  assert.equal(text, 'SCORE=82\nFINDINGS_TOTAL=4\nFINDINGS_CRITICAL=0\nFINDINGS_HIGH=1\nSARIF_FILE=C:\\w\\out\\sitelemetry.sarif\nSTATUS=completed\nREPORT_URL=\n');
  assert.ok(text.trimEnd().split('\n').every((line) => /^[A-Z_]+=[^\n]*$/.test(line)), 'no comments, quotes or empty lines');
  const withUrl = outputsToDotenv({ score: '', status: 'blocked', 'report-url': 'https://sitelemetry.com/app/reports/1' });
  assert.equal(withUrl.split('\n')[0], 'SCORE=');
  assert.equal(withUrl.split('\n')[6], 'REPORT_URL=https://sitelemetry.com/app/reports/1');
  assert.equal(formatDotenv({ A: 'line one\nline two\r\n', B: null, C: 0 }), 'A=line one line two\nB=\nC=0\n', 'values are single-line');
  assert.throws(() => formatDotenv({ 'BAD-KEY': 'x' }), /Invalid dotenv key/);
  assert.throws(() => formatDotenv({ '1KEY': 'x' }), /Invalid dotenv key/);
});

test('the GitLab and CLI sinks write the dotenv and summary files without workflow commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-platform-'));
  try {
    const gitlab = createPlatformIo('gitlab', { CI_PROJECT_DIR: dir, SITELEMETRY_OUTPUT_FILE: 'vars/sitelemetry.env' });
    gitlab.mask('secret-value');
    gitlab.summary('## Report\n');
    gitlab.outputs({ score: 90, status: 'completed', 'sarif-file': join(dir, 'x.sarif') });
    assert.equal(readFileSync(join(dir, 'sitelemetry-summary.md'), 'utf8'), '## Report\n');
    assert.equal(readFileSync(join(dir, 'vars', 'sitelemetry.env'), 'utf8'), `SCORE=90\nFINDINGS_TOTAL=\nFINDINGS_CRITICAL=\nFINDINGS_HIGH=\nSARIF_FILE=${join(dir, 'x.sarif')}\nSTATUS=completed\nREPORT_URL=\n`);
    gitlab.summary('## Second run\n');
    assert.equal(readFileSync(join(dir, 'sitelemetry-summary.md'), 'utf8'), '## Second run\n', 'the summary file is replaced, not appended');
    const cli = createPlatformIo('cli', { SITELEMETRY_SUMMARY_FILE: join(dir, 'cli', 'summary.md') });
    cli.summary('cli\n');
    assert.ok(existsSync(join(dir, 'cli', 'summary.md')));
    const github = createPlatformIo('github', { GITHUB_STEP_SUMMARY: join(dir, 'gh-summary.md'), GITHUB_OUTPUT: join(dir, 'gh-output.txt') });
    github.summary('one\n');
    github.summary('two\n');
    github.outputs({ score: 1, status: 'completed' });
    assert.equal(readFileSync(join(dir, 'gh-summary.md'), 'utf8'), 'one\n\ntwo\n\n', 'GitHub appends to the step summary');
    assert.equal(readFileSync(join(dir, 'gh-output.txt'), 'utf8'), 'score=1\nstatus=completed\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readInputs understands INPUT_GITLAB_REPORT', () => {
  const base = { INPUT_TARGET: 'https://ok.example', INPUT_API_KEY: 'k' };
  assert.equal(readInputs(base).inputs.gitlabReport, null);
  assert.equal(readInputs({ ...base, INPUT_GITLAB_REPORT: 'true' }).inputs.gitlabReport, 'gl-sast-report.json');
  assert.equal(readInputs({ ...base, INPUT_GITLAB_REPORT: 'FALSE' }).inputs.gitlabReport, false);
  assert.equal(readInputs({ ...base, INPUT_GITLAB_REPORT: 'reports/sast.json' }).inputs.gitlabReport, 'reports/sast.json');
  assert.deepEqual(readInputs({ ...base, INPUT_GITLAB_REPORT: 'true' }).problems, []);
});

test('the pricing link names the platform that produced the report', () => {
  assert.equal(pricingUrl('github'), PRICING_URL);
  assert.equal(PRICING_URL, 'https://sitelemetry.com/pricing?utm_source=github-action&utm_medium=ci');
  assert.equal(pricingUrl('gitlab'), 'https://sitelemetry.com/pricing?utm_source=gitlab-ci&utm_medium=ci');
  assert.equal(pricingUrl('cli'), 'https://sitelemetry.com/pricing?utm_source=cli&utm_medium=ci');
  assert.equal(pricingUrl('unknown'), PRICING_URL);
  const plans = normalizePlans(fixture('plans.json').plans);
  const free = interpretOutcome({ outcome: 'result', tool: 'audit_security', result: fixture('security-partial-free.json') }, { kind: 'security', target: 'https://free.example' });
  assert.ok(renderReport(free, { plans, platform: 'gitlab' }).includes('utm_source=gitlab-ci&utm_medium=ci'));
  assert.ok(renderReport(free, { plans }).includes('utm_source=github-action&utm_medium=ci'));
  assert.ok(renderComment(free, { plans, platform: 'gitlab' }).startsWith('<!-- sitelemetry-audit -->\n<!-- sitelemetry-audit:kind=security -->\n'));
  assert.ok(renderComment(free, { plans, platform: 'gitlab' }).includes('utm_source=gitlab-ci'));
});

test('mergeRequestContext reads the predefined CI variables and never uses CI_JOB_TOKEN', () => {
  assert.equal(mergeRequestContext({}), null);
  assert.equal(mergeRequestContext({ CI_MERGE_REQUEST_IID: '7', CI_PROJECT_ID: '42' }), null, 'CI_API_V4_URL is required');
  assert.equal(mergeRequestContext({ CI_MERGE_REQUEST_IID: 'abc', CI_PROJECT_ID: '42', CI_API_V4_URL: 'https://gitlab.example/api/v4' }), null);
  const env = { CI_MERGE_REQUEST_IID: '7', CI_PROJECT_ID: '42', CI_API_V4_URL: 'https://gitlab.example/api/v4', CI_PROJECT_URL: 'https://gitlab.example/g/p', CI_JOB_TOKEN: 'job-token' };
  assert.deepEqual(mergeRequestContext(env), { apiUrl: 'https://gitlab.example/api/v4', projectId: '42', iid: 7, projectUrl: 'https://gitlab.example/g/p', token: null });
  assert.equal(mergeRequestContext({ ...env, SITELEMETRY_GITLAB_TOKEN: ' glpat-x ' }).token, 'glpat-x');
  assert.equal(mergeRequestContext({ ...env, CI_MERGE_REQUEST_PROJECT_URL: 'https://gitlab.example/fork/p' }).projectUrl, 'https://gitlab.example/fork/p');
});

test('upsertMergeRequestNote updates the note that carries the marker, skipping system notes, or creates one', async () => {
  const marker = '<!-- sitelemetry-audit:kind=security -->';
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET') {
      return response(200, [
        { id: 1, system: true, body: `${marker} mentioned in a system note` },
        { id: 3, system: false, body: 'unrelated' },
        { id: 5, system: false, body: `<!-- sitelemetry-audit -->\n${marker}\nold report` }
      ]);
    }
    return response(200, { id: 5 });
  };
  const saved = await upsertMergeRequestNote({ apiUrl: 'https://gitlab.example/api/v4/', projectId: 'group/project', iid: 7, token: 'glpat-x', body: 'new body', marker, projectUrl: 'https://gitlab.example/group/project/', fetchImpl });
  assert.deepEqual(saved, { url: 'https://gitlab.example/group/project/-/merge_requests/7#note_5', updated: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests/7/notes?per_page=100&page=1&sort=asc&order_by=created_at');
  assert.equal(requests[0].headers['private-token'], 'glpat-x');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.deepEqual([requests[1].method, requests[1].url, requests[1].body], ['PUT', 'https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests/7/notes/5', { body: 'new body' }]);

  const created = await upsertMergeRequestNote({
    apiUrl: 'https://gitlab.example/api/v4', projectId: '42', iid: 7, token: 'glpat-x', body: 'first', marker,
    fetchImpl: async (url, init) => (init.method === 'GET' ? response(200, []) : response(201, { id: 9 }))
  });
  assert.deepEqual(created, { url: null, updated: false });
  await assert.rejects(
    upsertMergeRequestNote({ apiUrl: 'https://gitlab.example/api/v4', projectId: '42', iid: 7, token: 'bad', body: 'x', marker, fetchImpl: async () => response(401, { message: '401 Unauthorized' }) }),
    /GitLab API GET .* failed with HTTP 401/
  );
});
