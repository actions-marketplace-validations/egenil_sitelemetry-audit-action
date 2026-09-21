import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_API_KEY, TEST_GITLAB_TOKEN, startMockServer } from './mock-server.mjs';

const RUN = fileURLToPath(new URL('../src/run.mjs', import.meta.url));
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
let server;
const dirs = [];

before(async () => { server = await startMockServer(); });
after(async () => {
  await server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function parseOutputs(text) {
  const outputs = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      outputs[heredoc[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (lines[i].includes('=')) {
      const [name, ...rest] = lines[i].split('=');
      outputs[name] = rest.join('=');
    }
  }
  return outputs;
}

// The mock server lives in this process, so the child must run asynchronously.
// "github" reproduces an Actions step on a pull request (event "push" for a branch
// build), "gitlab" a GitLab CI job in a merge request pipeline (event "push" for a
// branch pipeline) and "cli" a plain shell. The token is the platform's review token.
function runAction(inputs, { platform = 'github', event = 'pull_request', token = platform === 'github' ? 'ghs_test_token' : TEST_GITLAB_TOKEN, env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-action-'));
  dirs.push(dir);
  // Drop inherited CI variables (Windows matches names case-insensitively, and the
  // self-test workflow itself runs inside Actions).
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|INPUT_|GITLAB_|CI_|SITELEMETRY_)/i.test(key)));
  const env = {
    ...inherited,
    INPUT_TARGET: 'https://ok.example', INPUT_API_KEY: TEST_API_KEY, INPUT_AUDIT: 'security', INPUT_PROFILE: '',
    INPUT_FAIL_ON: 'high', INPUT_SARIF_FILE: 'out/sitelemetry.sarif', INPUT_COMMENT: 'true', INPUT_BASE_URL: server.url,
    INPUT_TIMEOUT_MINUTES: '1', ...inputs,
    SITELEMETRY_ACTION_MIN_WAIT_MS: '10'
  };
  let summary;
  let output;
  if (platform === 'github') {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    summary = join(dir, 'summary.md');
    output = join(dir, 'output.txt');
    writeFileSync(summary, '');
    writeFileSync(output, '');
    Object.assign(env, {
      GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'octo/site', GITHUB_TOKEN: token, GITHUB_API_URL: server.url, GITHUB_WORKSPACE: dir
    });
  } else {
    summary = join(dir, extra.SITELEMETRY_SUMMARY_FILE || 'sitelemetry-summary.md');
    output = join(dir, extra.SITELEMETRY_OUTPUT_FILE || 'sitelemetry.env');
    if (platform === 'gitlab') {
      Object.assign(env, {
        GITLAB_CI: 'true', CI: 'true', CI_PROJECT_DIR: dir, CI_PROJECT_ID: '42', CI_API_V4_URL: `${server.url}/api/v4`,
        CI_PROJECT_URL: 'https://gitlab.example/octo/site', CI_JOB_TOKEN: 'job-token-never-sent', SITELEMETRY_GITLAB_TOKEN: token,
        ...(event === 'push' ? { CI_PIPELINE_SOURCE: 'push' } : { CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '7' })
      });
    }
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) if (env[key] == null) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN], { env, cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`run.mjs did not finish within 60s\n${stdout}\n${stderr}`)); }, 60_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
      resolve({ code, stdout, stderr, summary: read(summary), outputs: parseOutputs(read(output)), dir });
    });
  });
}

test('polls a running job to completion, writes SARIF, outputs and one pull request comment', async () => {
  const first = await runAction({});
  assert.equal(first.code, 1, `one high finding fails with fail-on high\n${first.stdout}\n${first.stderr}`);
  assert.equal(first.outputs.status, 'completed');
  assert.equal(first.outputs.score, '82');
  assert.equal(first.outputs['findings-total'], '4');
  assert.equal(first.outputs['findings-high'], '1');
  assert.equal(first.outputs['findings-critical'], '0');
  assert.equal(first.outputs['report-url'], undefined);
  assert.ok(existsSync(first.outputs['sarif-file']));
  const sarif = JSON.parse(readFileSync(first.outputs['sarif-file'], 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results.length, 4);
  assert.match(first.summary, /82\/100 \(B\)/);
  assert.match(first.summary, /HSTS header is missing/);
  assert.match(first.stdout, /Audit accepted as job mj_/);

  const masks = first.stdout.split(`::add-mask::${TEST_API_KEY}`).length - 1;
  assert.equal(masks, 1, 'the key is masked exactly once');
  assert.equal(first.stdout.split(TEST_API_KEY).length - 1, 1, 'the key never appears in logs apart from the mask command');
  assert.ok(!first.summary.includes(TEST_API_KEY));

  const toolCalls = server.toolCalls();
  const started = toolCalls.find((call) => call.body.params.arguments.target === 'https://ok.example' && !call.body.params.arguments.jobId);
  assert.ok(started, 'the audit was started with the target');
  const polls = toolCalls.filter((call) => call.body.params.arguments.jobId);
  assert.equal(polls.length, 2);
  for (const poll of polls) assert.deepEqual(poll.body.params.arguments, { target: 'https://ok.example/', jobId: poll.body.params.arguments.jobId });
  assert.ok(server.calls.some((call) => call.path === '/mcp' && call.body?.method === 'initialize'));
  assert.equal(server.calls.find((call) => call.path === '/mcp').headers.authorization, `Bearer ${TEST_API_KEY}`);
  assert.equal(server.calls.find((call) => call.path === '/mcp').headers.accept, 'application/json, text/event-stream');

  assert.equal(server.comments.length, 1);
  assert.ok(server.comments[0].body.startsWith('<!-- sitelemetry-audit -->'));
  assert.match(first.stdout, /Posted the pull request comment/);

  const second = await runAction({});
  assert.equal(second.code, 1);
  assert.equal(server.comments.length, 1, 'the existing comment is updated instead of duplicated');
  assert.equal(server.comments[0].updated, true);
  assert.match(second.stdout, /Updated the pull request comment/);
});

test('fail-on critical passes when only high findings exist', async () => {
  const result = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_FAIL_ON: 'critical', INPUT_COMMENT: 'false' });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.outputs.status, 'completed');
  assert.match(result.stdout, /::notice::Sitelemetry security audit: completed, score 82\/100, 4 finding\(s\)/);
});

test('HTTP 402 PLAN_UPGRADE_REQUIRED becomes plan_required with the plan section', async () => {
  const result = await runAction({ INPUT_TARGET: 'https://plan.example', INPUT_AUDIT: 'seo', INPUT_COMMENT: 'false' });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.outputs.status, 'plan_required');
  assert.equal(result.outputs['findings-total'], '0');
  assert.match(result.summary, /Not run - this audit kind is not included in the connected plan/);
  assert.match(result.summary, /### Plan and usage/);
  assert.match(result.summary, /\| Starter \| \$49\/month \|/);
  assert.match(result.summary, /\| Professional \| \$149\/month \|.*\| 24 \|/);
  assert.ok(result.summary.includes('https://sitelemetry.com/pricing?utm_source=github-action&utm_medium=ci'));
  assert.ok(result.summary.includes('https://sitelemetry.com/app'));
  assert.match(result.stdout, /::warning::/);
  const sarif = JSON.parse(readFileSync(result.outputs['sarif-file'], 'utf8'));
  assert.equal(sarif.runs[0].results.length, 0);
  assert.ok(server.calls.some((call) => call.path === '/api/plans'));
});

test('an action_required entitlement gate is also plan_required', async () => {
  const result = await runAction({ INPUT_TARGET: 'https://plan-result.example', INPUT_AUDIT: 'full', INPUT_COMMENT: 'false' });
  assert.equal(result.outputs.status, 'plan_required');
  assert.match(result.summary, /requires Starter or higher access/);
});

test('quota gates become quota_exhausted whether they arrive as a result or as a JSON-RPC error', async () => {
  const gate = await runAction({ INPUT_TARGET: 'https://quota.example', INPUT_COMMENT: 'false' });
  assert.equal(gate.code, 0);
  assert.equal(gate.outputs.status, 'quota_exhausted');
  assert.match(gate.summary, /monthly audit allowance/);
  assert.match(gate.summary, /### Plan and usage/);
  const rpc = await runAction({ INPUT_TARGET: 'https://quota-rpc.example', INPUT_COMMENT: 'false' });
  assert.equal(rpc.outputs.status, 'quota_exhausted');
  assert.match(rpc.summary, /monthly allowance: 10/);
});

test('verification gates become verification_required with the app link', async () => {
  const result = await runAction({ INPUT_TARGET: 'https://verify.example' });
  assert.equal(result.code, 0);
  assert.equal(result.outputs.status, 'verification_required');
  assert.match(result.summary, /Verify ownership of the target in the app/);
  assert.ok(result.summary.includes('https://sitelemetry.com/app'));
  assert.ok(server.comments.some((comment) => comment.body.includes('ownership verification of the target is required')));

  const consent = await runAction({ INPUT_TARGET: 'https://consent.example', INPUT_COMMENT: 'false' });
  assert.equal(consent.code, 0);
  assert.equal(consent.outputs.status, 'verification_required');
  assert.match(consent.summary, /Not run - the connected account must accept the current audit authorization terms/);
  assert.match(consent.summary, /Review and accept the current audit authorization terms for the connected account in the app/);
  assert.doesNotMatch(consent.summary, /Verify ownership of the target in the app/);
});

test('a tool outside the connected plan is still asked of the server; an unlisted tool the server rejects is plan_required', async () => {
  const limited = await startMockServer({ tools: ['audit_security'] });
  try {
    const gate = await runAction({ INPUT_TARGET: 'https://plan-result.example', INPUT_AUDIT: 'seo', INPUT_COMMENT: 'false', INPUT_BASE_URL: limited.url });
    assert.equal(gate.code, 0, gate.stdout);
    assert.equal(gate.outputs.status, 'plan_required');
    assert.ok(limited.toolCalls().some((call) => call.body.params.name === 'audit_seo'), 'the audit call is still made');
    assert.match(gate.summary, /requires Starter or higher access/);
    assert.match(gate.summary, /### Plan and usage/);
    assert.match(gate.stdout, /tools\/list does not include audit_seo/);
    const unknown = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_AUDIT: 'seo', INPUT_COMMENT: 'false', INPUT_BASE_URL: limited.url });
    assert.equal(unknown.code, 0, unknown.stdout);
    assert.equal(unknown.outputs.status, 'plan_required');
    assert.match(unknown.summary, /not available to the connected account \(Unknown tool: audit_seo\)/);
  } finally {
    await limited.close();
  }
});

test('text/event-stream responses and 429 retries are handled', async () => {
  const sse = await runAction({ INPUT_TARGET: 'https://sse.example', INPUT_FAIL_ON: 'none', INPUT_COMMENT: 'false' });
  assert.equal(sse.code, 0, sse.stdout);
  assert.equal(sse.outputs.status, 'completed');
  assert.equal(sse.outputs.score, '82');
  const busy = await runAction({ INPUT_TARGET: 'https://busy.example', INPUT_FAIL_ON: 'none', INPUT_COMMENT: 'false' });
  assert.equal(busy.code, 0, busy.stdout);
  assert.equal(busy.outputs.status, 'completed');
  assert.match(busy.stdout, /asked to retry later/);
});

test('a rejected API key blocks the run and fails unless fail-on is none', async () => {
  const failed = await runAction({ INPUT_API_KEY: 'wrong-key', INPUT_COMMENT: 'false' });
  assert.equal(failed.code, 1);
  assert.equal(failed.outputs.status, 'blocked');
  assert.match(failed.summary, /Not completed/);
  assert.match(failed.summary, /HTTP 401/);
  assert.match(failed.stdout, /::error::/);
  assert.match(failed.stdout, /::add-mask::wrong-key/);
  const tolerated = await runAction({ INPUT_API_KEY: 'wrong-key', INPUT_FAIL_ON: 'none', INPUT_COMMENT: 'false' });
  assert.equal(tolerated.code, 0);
  assert.equal(tolerated.outputs.status, 'blocked');
});

test('a tool error and a timeout are blocked runs', async () => {
  const errored = await runAction({ INPUT_TARGET: 'https://error.example', INPUT_COMMENT: 'false' });
  assert.equal(errored.code, 1);
  assert.equal(errored.outputs.status, 'blocked');
  assert.match(errored.summary, /audit failed/);
  const timedOut = await runAction({ INPUT_TARGET: 'https://ok.example', INPUT_TIMEOUT_MINUTES: '0.0001', INPUT_COMMENT: 'false' });
  assert.equal(timedOut.outputs.status, 'blocked');
  assert.match(timedOut.summary, /did not finish within the time budget/);
});

test('full and Free results are reported as partial with the unmeasured section', async () => {
  const full = await runAction({ INPUT_TARGET: 'https://full.example', INPUT_AUDIT: 'full', INPUT_COMMENT: 'false' });
  assert.equal(full.code, 1, 'the high finding fails the job');
  assert.equal(full.outputs.status, 'partial');
  assert.equal(full.outputs.score, '71');
  assert.match(full.summary, /### What was not measured/);
  assert.match(full.summary, /Performance: PageSpeed Insights was unavailable/);
  assert.match(full.summary, /\| SEO \| 62 \| 2 \|/);
  const sarif = JSON.parse(readFileSync(full.outputs['sarif-file'], 'utf8'));
  assert.equal(sarif.runs[0].tool.driver.rules.length, 2);

  const free = await runAction({ INPUT_TARGET: 'https://free.example', INPUT_FAIL_ON: 'high' });
  assert.equal(free.code, 0);
  assert.equal(free.outputs.status, 'partial');
  assert.match(free.summary, /Free plan: 10 public security modules and 10 security scans per month/);
  assert.match(free.summary, /require ownership verification of the target/);
  assert.ok(server.comments.some((comment) => comment.body.includes('<!-- sitelemetry-audit:kind=security -->') && comment.body.includes('free.example')));
});

test('comments are skipped for push events, comment=false and a missing token', async () => {
  const before = server.comments.length;
  await runAction({ INPUT_TARGET: 'https://sync.example' }, { event: 'push' });
  await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_COMMENT: 'false' });
  const noToken = await runAction({ INPUT_TARGET: 'https://sync.example' }, { token: null });
  assert.equal(server.comments.length, before);
  assert.match(noToken.stdout, /GITHUB_TOKEN is not available/);
});

test('invalid inputs block the run without calling the server', async () => {
  const calls = server.calls.length;
  const result = await runAction({ INPUT_TARGET: '', INPUT_AUDIT: 'pentest', INPUT_COMMENT: 'false' });
  assert.equal(result.code, 1);
  assert.equal(result.outputs.status, 'blocked');
  assert.match(result.summary, /"target" input is required/);
  assert.match(result.summary, /Unsupported "audit" value/);
  assert.equal(server.calls.length, calls);
});

test('GitLab CI: writes the security report, dotenv outputs, the summary file and one merge request note', async () => {
  const first = await runAction({}, { platform: 'gitlab' });
  assert.equal(first.code, 1, `one high finding fails with fail-on high\n${first.stdout}\n${first.stderr}`);
  const sarifPath = join(first.dir, 'out', 'sitelemetry.sarif');
  assert.deepEqual(first.outputs, { SCORE: '82', FINDINGS_TOTAL: '4', FINDINGS_CRITICAL: '0', FINDINGS_HIGH: '1', SARIF_FILE: sarifPath, STATUS: 'completed', REPORT_URL: '' });
  assert.equal(readFileSync(join(first.dir, 'sitelemetry.env'), 'utf8'), `SCORE=82\nFINDINGS_TOTAL=4\nFINDINGS_CRITICAL=0\nFINDINGS_HIGH=1\nSARIF_FILE=${sarifPath}\nSTATUS=completed\nREPORT_URL=\n`);
  assert.ok(existsSync(sarifPath));
  assert.equal(readJson(sarifPath).runs[0].results.length, 4, 'SARIF is still written');
  assert.match(first.summary, /^## Sitelemetry Security audit: https:\/\/ok\.example/);
  assert.match(first.summary, /82\/100 \(B\)/);
  assert.match(first.summary, /HSTS header is missing/);

  // No GitHub workflow commands, and the key never reaches the log on either stream.
  const logs = `${first.stdout}\n${first.stderr}`;
  assert.doesNotMatch(logs, /::(add-mask|error|warning|notice)::/);
  assert.equal(logs.includes(TEST_API_KEY), false, 'the key is never echoed');
  assert.equal(logs.includes(TEST_GITLAB_TOKEN), false, 'the GitLab token is never echoed');
  assert.match(first.stdout, /Sitelemetry audit \S+ on GitLab CI: security audit of https:\/\/ok\.example/);
  assert.match(first.stdout, /Audit accepted as job mj_/);
  assert.match(first.stderr, /^ERROR: Sitelemetry security audit: completed, score 82\/100, 4 finding\(s\)\. Findings at or above "high" severity fail this job\.$/m);

  const report = readJson(join(first.dir, 'gl-sast-report.json'));
  assert.equal(report.version, '15.1.4');
  assert.deepEqual(Object.keys(report), ['version', 'scan', 'vulnerabilities']);
  assert.deepEqual([report.scan.type, report.scan.status, report.scan.analyzer.id, report.scan.scanner.id], ['sast', 'success', 'sitelemetry-audit', 'sitelemetry']);
  assert.match(report.scan.start_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.match(report.scan.end_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(report.vulnerabilities.length, 4);
  assert.deepEqual(report.vulnerabilities.map((v) => v.severity), ['High', 'Medium', 'Low', 'Info']);
  assert.deepEqual(report.vulnerabilities[2].location, { file: 'https://ok.example/robots.txt', start_line: 1 });
  assert.equal(report.vulnerabilities[0].identifiers[0].value, 'sf2:security-audit:id:http-headers.hsts-missing:loc:1a2b3c4d5e6f7a8b9c0d1e2f3a4b:occ:1');
  for (const vulnerability of report.vulnerabilities) {
    assert.match(vulnerability.id, UUID_V5);
    assert.deepEqual(vulnerability.scanner, { id: 'sitelemetry', name: 'Sitelemetry' });
    assert.equal(vulnerability.category, 'sast');
  }

  assert.equal(server.userNotes().length, 1);
  assert.ok(server.userNotes()[0].body.startsWith('<!-- sitelemetry-audit -->\n<!-- sitelemetry-audit:kind=security -->\n'));
  assert.match(first.stdout, /Posted the merge request note: https:\/\/gitlab\.example\/octo\/site\/-\/merge_requests\/7#note_2/);
  const noteCalls = server.calls.filter((call) => call.path.startsWith('/api/v4/'));
  assert.ok(noteCalls.length >= 2);
  assert.ok(noteCalls.every((call) => call.path.startsWith('/api/v4/projects/42/merge_requests/7/notes') && call.headers['private-token'] === TEST_GITLAB_TOKEN && !call.headers.authorization));

  const second = await runAction({}, { platform: 'gitlab' });
  assert.equal(second.code, 1);
  assert.equal(server.userNotes().length, 1, 'the existing note is updated instead of duplicated');
  assert.equal(server.userNotes()[0].updated, true);
  assert.match(second.stdout, /Updated the merge request note/);
  assert.deepEqual(readJson(join(second.dir, 'gl-sast-report.json')).vulnerabilities.map((v) => v.id), report.vulnerabilities.map((v) => v.id), 'vulnerability ids are stable across runs');
});

test('GitLab CI: the note is skipped without an access token, on branch pipelines and with comment=false', async () => {
  const before = server.userNotes().length;
  const apiCalls = () => server.calls.filter((call) => call.path.startsWith('/api/v4/')).length;
  const calls = apiCalls();
  const noToken = await runAction({ INPUT_TARGET: 'https://sync.example' }, { platform: 'gitlab', token: null });
  assert.equal(noToken.outputs.STATUS, 'completed');
  assert.match(noToken.stdout, /Skipping the merge request note: SITELEMETRY_GITLAB_TOKEN is not set\. CI_JOB_TOKEN cannot create notes/);
  const branch = await runAction({ INPUT_TARGET: 'https://sync.example' }, { platform: 'gitlab', event: 'push' });
  assert.equal(branch.outputs.STATUS, 'completed');
  await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_COMMENT: 'false' }, { platform: 'gitlab' });
  assert.equal(server.userNotes().length, before);
  assert.equal(apiCalls(), calls, 'no GitLab API request is made');
});

test('GitLab CI: plan gates link to pricing with utm_source=gitlab-ci and honor the output file variables', async () => {
  const result = await runAction({ INPUT_TARGET: 'https://plan.example', INPUT_AUDIT: 'seo', INPUT_COMMENT: 'false' }, {
    platform: 'gitlab', env: { SITELEMETRY_OUTPUT_FILE: 'out/vars.env', SITELEMETRY_SUMMARY_FILE: 'out/report.md' }
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual([result.outputs.STATUS, result.outputs.FINDINGS_TOTAL, result.outputs.SCORE], ['plan_required', '0', '']);
  assert.ok(existsSync(join(result.dir, 'out', 'vars.env')));
  assert.match(result.summary, /Not run - this audit kind is not included in the connected plan/);
  assert.match(result.summary, /### Plan and usage/);
  assert.ok(result.summary.includes('https://sitelemetry.com/pricing?utm_source=gitlab-ci&utm_medium=ci'));
  assert.equal(result.summary.includes('utm_source=github-action'), false);
  assert.match(result.stdout, /^WARNING: Sitelemetry seo audit: plan_required, 0 finding\(s\)\./m);
  const report = readJson(join(result.dir, 'gl-sast-report.json'));
  assert.equal(report.scan.status, 'failure');
  assert.deepEqual(report.vulnerabilities, []);
});

test('plain CLI use writes the dotenv and summary files; the GitLab report only on request', async () => {
  const plain = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_FAIL_ON: 'none' }, { platform: 'cli' });
  assert.equal(plain.code, 0, `${plain.stdout}\n${plain.stderr}`);
  assert.deepEqual([plain.outputs.STATUS, plain.outputs.SCORE, plain.outputs.SARIF_FILE], ['completed', '82', join(plain.dir, 'out', 'sitelemetry.sarif')]);
  assert.match(plain.summary, /82\/100 \(B\)/);
  assert.equal(existsSync(join(plain.dir, 'gl-sast-report.json')), false);
  assert.match(plain.stdout, /Sitelemetry audit \S+ on CLI:/);
  assert.match(plain.stdout, /^NOTICE: Sitelemetry security audit: completed, score 82\/100, 4 finding\(s\)$/m);
  assert.doesNotMatch(`${plain.stdout}\n${plain.stderr}`, /::notice::|merge request|pull request/);
  assert.equal(`${plain.stdout}\n${plain.stderr}`.includes(TEST_API_KEY), false);

  const requested = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_FAIL_ON: 'none', INPUT_GITLAB_REPORT: 'reports/gl-sast-report.json' }, { platform: 'cli' });
  assert.equal(readJson(join(requested.dir, 'reports', 'gl-sast-report.json')).vulnerabilities.length, 4);
  const flagged = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_FAIL_ON: 'none', INPUT_GITLAB_REPORT: 'true' }, { platform: 'cli' });
  assert.equal(readJson(join(flagged.dir, 'gl-sast-report.json')).scan.type, 'sast');
  const disabled = await runAction({ INPUT_TARGET: 'https://sync.example', INPUT_FAIL_ON: 'none', INPUT_COMMENT: 'false', INPUT_GITLAB_REPORT: 'false' }, { platform: 'gitlab' });
  assert.equal(existsSync(join(disabled.dir, 'gl-sast-report.json')), false, 'INPUT_GITLAB_REPORT=false disables the report on GitLab too');
});
