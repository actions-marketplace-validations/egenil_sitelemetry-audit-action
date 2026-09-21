// CI platform detection and the platform-specific plumbing for masking, annotations,
// outputs and the report. GitHub Actions keeps its workflow commands and files;
// GitLab CI and plain CLI use write a dotenv file and a markdown file instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { annotate as githubAnnotate, appendSummary, mask as githubMask, setOutput } from './github.mjs';

export const PLATFORMS = Object.freeze(['github', 'gitlab', 'cli']);
// Output names as the GitHub Action exposes them; the dotenv keys derive from them.
export const OUTPUT_NAMES = Object.freeze(['score', 'findings-total', 'findings-critical', 'findings-high', 'sarif-file', 'status', 'report-url']);
export const DEFAULT_OUTPUT_FILE = 'sitelemetry.env';
export const DEFAULT_SUMMARY_FILE = 'sitelemetry-summary.md';
export const DEFAULT_GITLAB_REPORT_FILE = 'gl-sast-report.json';

export function detectPlatform(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.GITLAB_CI === 'true') return 'gitlab';
  return 'cli';
}

// Relative output paths resolve against the CI workspace, or the current directory.
export function workspaceDir(platform, env = process.env) {
  const root = platform === 'github' ? env.GITHUB_WORKSPACE : platform === 'gitlab' ? env.CI_PROJECT_DIR : '';
  return root && String(root).trim() ? String(root).trim() : process.cwd();
}

export const dotenvKey = (name) => String(name).toUpperCase().replace(/-/g, '_');

// One KEY=VALUE line per output. GitLab's dotenv report parser accepts neither
// multi-line values, comments nor empty lines, and keys must be identifiers.
export function formatDotenv(values) {
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid dotenv key: ${key}`);
    lines.push(`${key}=${String(value ?? '').replace(/[\r\n]+/g, ' ').trim()}`);
  }
  return `${lines.join('\n')}\n`;
}

export function outputsToDotenv(outputs) {
  return formatDotenv(Object.fromEntries(OUTPUT_NAMES.map((name) => [dotenvKey(name), outputs[name] ?? ''])));
}

export function writeTextFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// Without workflow commands, annotations are plain log lines; errors go to stderr.
export function plainAnnotate(level, message) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${String(level).toUpperCase()}: ${message}\n`);
}

export const annotateFor = (platform) => (platform === 'github' ? githubAnnotate : plainAnnotate);

// The sink every platform offers to run.mjs: mask, annotate, summary and outputs.
export function createPlatformIo(platform, env = process.env, log = () => {}) {
  if (platform === 'github') {
    return {
      platform,
      mask: githubMask,
      annotate: githubAnnotate,
      summary: (markdown) => appendSummary(markdown, env.GITHUB_STEP_SUMMARY),
      outputs: (values) => { for (const [name, value] of Object.entries(values)) setOutput(name, value, env.GITHUB_OUTPUT); }
    };
  }
  const workspace = workspaceDir(platform, env);
  const outputFile = resolve(workspace, env.SITELEMETRY_OUTPUT_FILE || DEFAULT_OUTPUT_FILE);
  const summaryFile = resolve(workspace, env.SITELEMETRY_SUMMARY_FILE || DEFAULT_SUMMARY_FILE);
  return {
    platform,
    // No masking command exists here; the key is simply never written to the log.
    mask: () => {},
    annotate: plainAnnotate,
    summary: (markdown) => { writeTextFile(summaryFile, markdown); log(`Report written to ${summaryFile}.`); },
    outputs: (values) => { writeTextFile(outputFile, outputsToDotenv(values)); log(`Outputs written to ${outputFile} (dotenv).`); }
  };
}
