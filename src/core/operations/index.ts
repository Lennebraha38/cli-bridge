import { join } from 'node:path';
import type {
  ExecResult,
  OpContext,
  OpImpl,
  OpInputValues,
  OperationSpec,
} from '../types.js';
import {
  builtinFileList,
  builtinFileRead,
  builtinFileWrite,
  builtinHttpDownload,
  builtinHttpRequest,
  builtinJsonQuery,
  builtinSysInfo,
  builtinTextSearch,
  builtinWebSearch,
} from './builtins.js';

/* ----------------------------- helpers ----------------------------- */

function str(input: OpInputValues, key: string, fallback = ''): string {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function num(input: OpInputValues, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(input: OpInputValues, key: string, fallback = false): boolean {
  const value = input[key];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'on';
}

function headerArgs(input: OpInputValues): string[] {
  const raw = input.headers;
  const args: string[] = [];
  if (!raw) return args;
  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) args.push('-H', `${line.slice(0, idx).trim()}: ${line.slice(idx + 1).trim()}`);
    }
    return args;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      args.push('-H', `${key}: ${String(value)}`);
    }
  }
  return args;
}

const STATUS_MARKER = '__BRIDGE_STATUS__';

/**
 * Windows Schannel cannot check certificate revocation on machines where the
 * CRL endpoint is unreachable, which makes every HTTPS call fail with
 * CRYPT_E_NO_REVOCATION_CHECK. This flag turns that check off.
 */
const CURL_WINDOWS_TLS_ARGS = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];

/* --------------------------- http.request -------------------------- */

const curlRequest: OpImpl = {
  tool: 'curl',
  prefer: 100,
  build(input) {
    const args = ['-sS', ...CURL_WINDOWS_TLS_ARGS];
    const method = str(input, 'method', 'GET').toUpperCase();
    if (method && method !== 'GET') args.push('-X', method);
    args.push(...headerArgs(input));
    if (bool(input, 'followRedirects', true)) args.push('-L');
    if (bool(input, 'insecure')) args.push('-k');
    const timeoutMs = num(input, 'timeoutMs', 0);
    if (timeoutMs > 0) args.push('--max-time', String(Math.ceil(timeoutMs / 1000)));
    const output = str(input, 'output');
    if (output) args.push('-o', output);
    if (input.bodyFile) args.push('--data-binary', `@${str(input, 'bodyFile')}`);
    else if (input.body !== undefined) args.push('--data-raw', str(input, 'body'));
    args.push('-w', `\n${STATUS_MARKER}%{http_code}`);
    args.push(str(input, 'url'));
    return { args };
  },
  parse(result: ExecResult) {
    const marker = result.stdout.lastIndexOf(STATUS_MARKER);
    if (marker === -1) return undefined;
    const status = Number(result.stdout.slice(marker + STATUS_MARKER.length).trim());
    result.stdout = result.stdout.slice(0, marker).replace(/\n$/, '');
    result.meta = { ...(result.meta ?? {}), status };
    if (Number.isFinite(status)) {
      result.ok = status < 400;
      if (!result.ok) result.error = `HTTP ${status}`;
    }
    return undefined;
  },
};

const httpieRequest: OpImpl = {
  tool: 'httpie',
  prefer: 60,
  build(input) {
    const args = ['-sS', str(input, 'method', 'GET').toUpperCase(), str(input, 'url')];
    const raw = input.headers;
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        args.push(`${key}:${String(value)}`);
      }
    }
    return { args, stdin: input.body !== undefined ? str(input, 'body') : undefined };
  },
};

const wgetRequest: OpImpl = {
  tool: 'wget',
  prefer: 40,
  build(input) {
    const args = ['-q', '-O', '-'];
    if (str(input, 'method', 'GET').toUpperCase() !== 'GET') {
      // wget has no native POST without --post-data
      args.push('--post-data', str(input, 'body'));
    }
    args.push(str(input, 'url'));
    return { args };
  },
};

const httpRequestOp: OperationSpec = {
  id: 'http.request',
  title: 'HTTP request',
  description: 'Perform an HTTP request. Uses curl, httpie or wget; falls back to a built-in fetch client.',
  capability: 'http.request',
  inputs: [
    { name: 'url', type: 'string', required: true, description: 'Target URL', example: 'https://api.github.com/repos/opencode/opencode' },
    { name: 'method', type: 'string', description: 'HTTP method', default: 'GET' },
    { name: 'headers', type: 'object', description: 'Request headers' },
    { name: 'query', type: 'object', description: 'Query string parameters' },
    { name: 'body', type: 'string', description: 'Request body' },
    { name: 'bodyFile', type: 'string', description: 'Read the body from a file' },
    { name: 'output', type: 'string', description: 'Write the response body to this file' },
    { name: 'timeoutMs', type: 'number', description: 'Request timeout' },
    { name: 'followRedirects', type: 'boolean', description: 'Follow 3xx redirects', default: true },
    { name: 'insecure', type: 'boolean', description: 'Skip TLS verification', default: false },
  ],
  outputs: [
    { name: 'body', type: 'string', description: 'Response body' },
    { name: 'json', type: 'object', description: 'Parsed body when it is JSON' },
    { name: 'status', type: 'number', description: 'HTTP status code' },
  ],
  impls: [curlRequest, httpieRequest, wgetRequest],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinHttpRequest(input, ctx),
  },
};

/* -------------------------- http.download -------------------------- */

const curlDownload: OpImpl = {
  tool: 'curl',
  prefer: 100,
  build(input) {
    const args = ['-sSL', ...CURL_WINDOWS_TLS_ARGS, '-o', str(input, 'output')];
    if (bool(input, 'insecure')) args.push('-k');
    args.push(str(input, 'url'));
    return { args };
  },
};

const wgetDownload: OpImpl = {
  tool: 'wget',
  prefer: 60,
  build(input) {
    return { args: ['-q', '-O', str(input, 'output'), str(input, 'url')] };
  },
};

const httpDownloadOp: OperationSpec = {
  id: 'http.download',
  title: 'Download a file',
  description: 'Download a URL to a local file.',
  capability: 'http.request',
  inputs: [
    { name: 'url', type: 'string', required: true, description: 'Source URL' },
    { name: 'output', type: 'string', required: true, description: 'Destination path' },
    { name: 'insecure', type: 'boolean', description: 'Skip TLS verification', default: false },
  ],
  outputs: [{ name: 'path', type: 'string', description: 'Path of the downloaded file' }],
  impls: [curlDownload, wgetDownload],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinHttpDownload(input, ctx),
  },
};

/* ---------------------------- json.query --------------------------- */

const jqQuery: OpImpl = {
  tool: 'jq',
  prefer: 100,
  build(input) {
    const raw = bool(input, 'raw') ? '-r' : '-c';
    return { args: [raw, str(input, 'filter', '.')], stdin: str(input, 'json', str(input, 'input', '')) };
  },
  parse(result) {
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) return null;
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
    return parsed.length === 1 ? parsed[0] : parsed;
  },
};

const gojqQuery: OpImpl = {
  tool: 'gojq',
  prefer: 90,
  build(input) {
    return { args: [str(input, 'filter', '.')], stdin: str(input, 'json', str(input, 'input', '')) };
  },
};

const jsonQueryOp: OperationSpec = {
  id: 'json.query',
  title: 'Query JSON',
  description: 'Filter JSON with a jq-like expression. Uses jq, gojq or jaq; falls back to a built-in JSONPath engine.',
  capability: 'json.transform',
  inputs: [
    { name: 'filter', type: 'string', required: true, description: 'jq expression or JSONPath', example: '.items[] | select(.state=="open")' },
    { name: 'json', type: 'string', description: 'JSON document (can be piped via stdin)' },
    { name: 'raw', type: 'boolean', description: 'Output raw strings instead of JSON', default: false },
  ],
  outputs: [{ name: 'result', type: 'object', description: 'Query result' }],
  impls: [jqQuery, gojqQuery],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinJsonQuery(input, ctx),
  },
};

/* --------------------------- yaml.query --------------------------- */

const yqQuery: OpImpl = {
  tool: 'yq',
  prefer: 100,
  build(input) {
    return { args: ['eval', str(input, 'filter', '.')], stdin: str(input, 'yaml', str(input, 'input', '')) };
  },
};

const yamlQueryOp: OperationSpec = {
  id: 'yaml.query',
  title: 'Query YAML',
  description: 'Filter YAML with a yq expression.',
  capability: 'yaml.transform',
  inputs: [
    { name: 'filter', type: 'string', required: true, description: 'yq expression', example: '.spec.replicas' },
    { name: 'yaml', type: 'string', description: 'YAML document (can be piped via stdin)' },
  ],
  outputs: [{ name: 'result', type: 'object', description: 'Query result' }],
  impls: [yqQuery],
};

/* ------------------------------ files ------------------------------ */

const fileReadOp: OperationSpec = {
  id: 'file.read',
  title: 'Read a file',
  description: 'Read a file from disk.',
  capability: 'file.read',
  inputs: [
    { name: 'path', type: 'string', required: true, description: 'File path' },
  ],
  outputs: [
    { name: 'content', type: 'string', description: 'File contents' },
    { name: 'sha256', type: 'string', description: 'SHA-256 of the file' },
  ],
  impls: [],
  builtin: {
    tool: '__builtin__',
    prefer: 100,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinFileRead(input, ctx),
  },
};

const fileWriteOp: OperationSpec = {
  id: 'file.write',
  title: 'Write a file',
  description: 'Write content to a file, creating directories as needed.',
  capability: 'file.write',
  inputs: [
    { name: 'path', type: 'string', required: true, description: 'Target path' },
    { name: 'content', type: 'string', description: 'Content to write (can be piped via stdin)' },
    { name: 'append', type: 'boolean', description: 'Append instead of overwrite', default: false },
  ],
  outputs: [{ name: 'path', type: 'string', description: 'Written path' }],
  impls: [],
  builtin: {
    tool: '__builtin__',
    prefer: 100,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinFileWrite(input, ctx),
  },
};

const fileListOp: OperationSpec = {
  id: 'file.list',
  title: 'List files',
  description: 'List the entries of a directory tree.',
  capability: 'file.search',
  inputs: [
    { name: 'path', type: 'string', description: 'Directory to walk', default: '.' },
    { name: 'depth', type: 'number', description: 'Maximum depth', default: 3 },
    { name: 'pattern', type: 'string', description: 'Regular expression filter' },
    { name: 'limit', type: 'number', description: 'Maximum entries', default: 5000 },
  ],
  outputs: [{ name: 'entries', type: 'array', description: 'Directory entries' }],
  impls: [],
  builtin: {
    tool: '__builtin__',
    prefer: 100,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinFileList(input, ctx),
  },
};

/* ---------------------------- text.search -------------------------- */

const ripgrepSearch: OpImpl = {
  tool: 'rg',
  prefer: 100,
  build(input, ctx) {
    const args = ['--line-number', '--with-filename', '--color', 'never'];
    if (bool(input, 'ignoreCase')) args.push('-i');
    const glob = str(input, 'glob');
    if (glob) args.push('--glob', glob);
    const maxCount = num(input, 'maxCount', 0);
    if (maxCount > 0) args.push('--max-count', String(maxCount));
    args.push(str(input, 'pattern'));
    args.push(str(input, 'path', '.'));
    return { args, cwd: ctx.cwd };
  },
  parse(result) {
    const matches = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        return match ? { file: match[1], line: Number(match[2]), text: match[3]?.trim() } : { file: '', line: 0, text: line };
      });
    return matches;
  },
};

const agSearch: OpImpl = {
  tool: 'ag',
  prefer: 70,
  build(input, ctx) {
    const args = ['--nocolor'];
    if (bool(input, 'ignoreCase')) args.push('-i');
    args.push(str(input, 'pattern'));
    args.push(str(input, 'path', '.'));
    return { args, cwd: ctx.cwd };
  },
};

const textSearchOp: OperationSpec = {
  id: 'text.search',
  title: 'Search text',
  description: 'Search files for a regular expression.',
  capability: 'text.search',
  inputs: [
    { name: 'pattern', type: 'string', required: true, description: 'Regular expression' },
    { name: 'path', type: 'string', description: 'File or directory to search', default: '.' },
    { name: 'glob', type: 'string', description: 'Glob filter for file names' },
    { name: 'ignoreCase', type: 'boolean', description: 'Case insensitive', default: false },
    { name: 'maxCount', type: 'number', description: 'Maximum matches', default: 200 },
  ],
  outputs: [{ name: 'matches', type: 'array', description: 'Matching lines' }],
  impls: [ripgrepSearch, agSearch],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinTextSearch(input, ctx),
  },
};

/* ----------------------------- code.run ---------------------------- */

const codeRunOp: OperationSpec = {
  id: 'code.run',
  title: 'Run code',
  description: 'Execute a snippet with the available runtime (node, python, deno, bun, pwsh, bash...).',
  capability: 'code.run',
  inputs: [
    { name: 'language', type: 'string', required: true, description: 'Runtime name', example: 'node' },
    { name: 'code', type: 'string', description: 'Source code to execute' },
    { name: 'file', type: 'string', description: 'Script file to execute' },
    { name: 'args', type: 'array', description: 'Arguments passed to the script' },
    { name: 'env', type: 'object', description: 'Extra environment variables' },
  ],
  outputs: [
    { name: 'stdout', type: 'string', description: 'Program output' },
    { name: 'exitCode', type: 'number', description: 'Exit code' },
  ],
  impls: [],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: async (input, ctx) => {
      const language = str(input, 'language', 'node').toLowerCase();
      const code = str(input, 'code');
      const file = str(input, 'file');
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
      const env = (input.env && typeof input.env === 'object') ? (input.env as Record<string, string>) : undefined;

      if (language !== 'node' && language !== 'js' && language !== 'javascript' && language !== 'ts') {
        return {
          ok: false,
          tool: '__builtin__',
          bin: '__builtin__',
          argv: [],
          cwd: ctx.cwd,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 0,
          truncated: false,
          timedOut: false,
          error: `runtime "${language}" is not available; install it or use another operation`,
        };
      }

      const { run } = await import('../exec.js');
      const execArgs = file ? [file, ...args] : ['-e', code, ...args];
      return run({
        tool: 'node',
        bin: 'node',
        path: process.execPath,
        args: execArgs,
        cwd: ctx.cwd,
        env,
        timeoutMs: ctx.timeoutMs,
      });
    },
  },
};

/* ------------------------------ vcs -------------------------------- */

const gitLog: OpImpl = {
  tool: 'git',
  prefer: 100,
  build(input, ctx) {
    const args = ['log', `--max-count=${num(input, 'maxCount', 20)}`];
    const format = str(input, 'format', '%H%x1f%h%x1f%an%x1f%aI%x1f%s');
    args.push(`--pretty=format:${format}`);
    const branch = str(input, 'branch');
    if (branch) args.push(branch);
    return { args, cwd: str(input, 'repo') ? join(ctx.cwd, str(input, 'repo')) : ctx.cwd };
  },
  parse(result) {
    const sep = '';
    const commits = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(sep);
        return {
          sha: parts[0],
          shortSha: parts[1],
          author: parts[2],
          date: parts[3],
          subject: parts.slice(4).join(sep),
        };
      });
    return commits;
  },
};

const gitStatus: OpImpl = {
  tool: 'git',
  prefer: 100,
  build(input, ctx) {
    return { args: ['status', '--porcelain=v2', '--branch'], cwd: str(input, 'repo') ? join(ctx.cwd, str(input, 'repo')) : ctx.cwd };
  },
  parse(result) {
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const branch = lines.find((line) => line.startsWith('# branch.head'));
    const changes = lines
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        const parts = line.split(' ');
        return { path: parts.slice(8).join(' '), status: parts[1] ?? '', staged: parts[0] === '1' };
      });
    return {
      branch: branch ? branch.split(' ').slice(2).join(' ') : undefined,
      clean: changes.length === 0,
      changes,
    };
  },
};

const vcsLogOp: OperationSpec = {
  id: 'vcs.log',
  title: 'Git log',
  description: 'Read the commit history of a repository.',
  capability: 'vcs.operate',
  inputs: [
    { name: 'repo', type: 'string', description: 'Repository path (defaults to the working directory)' },
    { name: 'maxCount', type: 'number', description: 'Number of commits', default: 20 },
    { name: 'branch', type: 'string', description: 'Branch, tag or revision' },
  ],
  outputs: [{ name: 'commits', type: 'array', description: 'Commit list' }],
  impls: [gitLog],
};

const vcsStatusOp: OperationSpec = {
  id: 'vcs.status',
  title: 'Git status',
  description: 'Show the working tree status of a repository.',
  capability: 'vcs.operate',
  inputs: [
    { name: 'repo', type: 'string', description: 'Repository path' },
  ],
  outputs: [{ name: 'status', type: 'object', description: 'Branch and changed files' }],
  impls: [gitStatus],
};

/* --------------------------- containers ---------------------------- */

const containerList: OpImpl = {
  tool: 'docker',
  prefer: 100,
  build(input) {
    const args = ['ps', '--format', '{{json .}}'];
    if (bool(input, 'all')) args.splice(1, 0, '--all');
    return { args };
  },
  parse(result) {
    const items = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    return items;
  },
};

const containerListOp: OperationSpec = {
  id: 'container.list',
  title: 'List containers',
  description: 'List running (or all) containers.',
  capability: 'container.manage',
  inputs: [{ name: 'all', type: 'boolean', description: 'Include stopped containers', default: false }],
  outputs: [{ name: 'containers', type: 'array', description: 'Container list' }],
  impls: [containerList],
};

/* ------------------------------ k8s -------------------------------- */

const kubectlGet: OpImpl = {
  tool: 'kubectl',
  prefer: 100,
  build(input) {
    const args = ['get', str(input, 'resource')];
    const namespace = str(input, 'namespace');
    if (namespace) args.push('-n', namespace);
    const context = str(input, 'context');
    if (context) args.push('--context', context);
    args.push('-o', str(input, 'format', 'json'));
    return { args };
  },
  parse(result) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout;
    }
  },
};

const k8sGetOp: OperationSpec = {
  id: 'k8s.get',
  title: 'Kubernetes get',
  description: 'Fetch Kubernetes resources as JSON.',
  capability: 'k8s.manage',
  inputs: [
    { name: 'resource', type: 'string', required: true, description: 'Resource type', example: 'pods' },
    { name: 'namespace', type: 'string', description: 'Namespace' },
    { name: 'context', type: 'string', description: 'Kube context' },
    { name: 'format', type: 'string', description: 'Output format', default: 'json' },
  ],
  outputs: [{ name: 'resources', type: 'object', description: 'Kubernetes resources' }],
  impls: [kubectlGet],
};

/* ------------------------------ database --------------------------- */

const psqlQuery: OpImpl = {
  tool: 'psql',
  prefer: 100,
  build(input) {
    const args = ['-t', '-A', '-F', '\t', '-c', str(input, 'query')];
    const database = str(input, 'database');
    if (database) args.push(database);
    return { args };
  },
};

const mysqlQuery: OpImpl = {
  tool: 'mysql',
  prefer: 90,
  build(input) {
    const args = ['--batch', '--raw', '-e', str(input, 'query')];
    const database = str(input, 'database');
    if (database) args.push(database);
    return { args };
  },
};

const sqliteQuery: OpImpl = {
  tool: 'sqlite3',
  prefer: 80,
  build(input) {
    const args = ['-json', str(input, 'database', ':memory:'), str(input, 'query')];
    return { args };
  },
  parse(result) {
    try {
      return JSON.parse(result.stdout || '[]');
    } catch {
      return result.stdout;
    }
  },
};

const duckdbQuery: OpImpl = {
  tool: 'duckdb',
  prefer: 70,
  build(input) {
    const sql = str(input, 'query').replace(/;\s*$/, '');
    const args = ['-c', `COPY (${sql}) TO STDOUT (FORMAT json)`];
    const database = str(input, 'database');
    if (database) args.unshift(database);
    return { args };
  },
  parse(result) {
    try {
      return JSON.parse(result.stdout || '[]');
    } catch {
      return result.stdout;
    }
  },
};

const dbQueryOp: OperationSpec = {
  id: 'db.query',
  title: 'Database query',
  description: 'Run a SQL query against PostgreSQL, MySQL, SQLite or DuckDB.',
  capability: 'db.query',
  inputs: [
    { name: 'query', type: 'string', required: true, description: 'SQL statement' },
    { name: 'engine', type: 'string', description: 'postgres | mysql | sqlite | duckdb', default: 'postgres' },
    { name: 'database', type: 'string', description: 'Database name or file' },
  ],
  outputs: [
    { name: 'rows', type: 'array', description: 'Result rows' },
    { name: 'raw', type: 'string', description: 'Raw client output' },
  ],
  impls: [psqlQuery, mysqlQuery, sqliteQuery, duckdbQuery],
};

/* ------------------------------ media ------------------------------ */

const ffprobeInfo: OpImpl = {
  tool: 'ffprobe',
  prefer: 100,
  build(input) {
    return { args: ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', str(input, 'file')] };
  },
  parse(result) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout;
    }
  },
};

const mediaInfoOp: OperationSpec = {
  id: 'media.info',
  title: 'Media info',
  description: 'Inspect audio and video files (ffprobe).',
  capability: 'media.transcode',
  inputs: [{ name: 'file', type: 'string', required: true, description: 'Media file path' }],
  outputs: [{ name: 'streams', type: 'object', description: 'Stream metadata' }],
  impls: [ffprobeInfo],
};

const ffmpegConvert: OpImpl = {
  tool: 'ffmpeg',
  prefer: 100,
  build(input) {
    const args = ['-y'];
    const extra = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
    args.push(...extra, '-i', str(input, 'input'), str(input, 'output'));
    return { args };
  },
};

const mediaConvertOp: OperationSpec = {
  id: 'media.convert',
  title: 'Transcode media',
  description: 'Convert or transcode audio and video with ffmpeg.',
  capability: 'media.transcode',
  inputs: [
    { name: 'input', type: 'string', required: true, description: 'Source file' },
    { name: 'output', type: 'string', required: true, description: 'Target file' },
    { name: 'args', type: 'array', description: 'Extra ffmpeg arguments' },
  ],
  outputs: [{ name: 'output', type: 'string', description: 'Produced file' }],
  impls: [ffmpegConvert],
};

/* ------------------------------ image ------------------------------ */

const magickConvert: OpImpl = {
  tool: 'imagemagick',
  prefer: 100,
  build(input) {
    const args = [str(input, 'input')];
    const resize = str(input, 'resize');
    if (resize) args.push('-resize', resize);
    const extra = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
    args.push(...extra, str(input, 'output'));
    return { args };
  },
};

const imageConvertOp: OperationSpec = {
  id: 'image.convert',
  title: 'Convert image',
  description: 'Resize and convert images with ImageMagick.',
  capability: 'image.process',
  inputs: [
    { name: 'input', type: 'string', required: true, description: 'Source image' },
    { name: 'output', type: 'string', required: true, description: 'Target image' },
    { name: 'resize', type: 'string', description: 'Geometry, e.g. 50%' },
    { name: 'args', type: 'array', description: 'Extra ImageMagick arguments' },
  ],
  outputs: [{ name: 'output', type: 'string', description: 'Produced image' }],
  impls: [magickConvert],
};

/* ---------------------------- documents ----------------------------- */

const pdftotextExtract: OpImpl = {
  tool: 'pdftotext',
  prefer: 100,
  build(input) {
    return { args: [str(input, 'file'), '-'] };
  },
};

const tesseractRead: OpImpl = {
  tool: 'tesseract',
  prefer: 90,
  build(input) {
    return { args: [str(input, 'file'), 'stdout'] };
  },
};

const docExtractOp: OperationSpec = {
  id: 'doc.extract',
  title: 'Extract document text',
  description: 'Extract text from PDF documents (pdftotext) or images (tesseract).',
  capability: 'doc.extract',
  inputs: [{ name: 'file', type: 'string', required: true, description: 'PDF or image file' }],
  outputs: [{ name: 'text', type: 'string', description: 'Extracted text' }],
  impls: [pdftotextExtract, tesseractRead],
};

const ocrReadOp: OperationSpec = {
  id: 'ocr.read',
  title: 'OCR an image',
  description: 'Read text from an image with tesseract.',
  capability: 'ocr.read',
  inputs: [{ name: 'file', type: 'string', required: true, description: 'Image file' }],
  outputs: [{ name: 'text', type: 'string', description: 'Recognised text' }],
  impls: [tesseractRead],
};

/* ----------------------------- archive ------------------------------ */

const tarCreate: OpImpl = {
  tool: 'tar',
  prefer: 100,
  build(input) {
    const inputs = Array.isArray(input.inputs) ? (input.inputs as unknown[]).map(String) : [];
    return { args: ['-cf', str(input, 'output'), ...inputs] };
  },
};

const sevenZipCreate: OpImpl = {
  tool: '7z',
  prefer: 80,
  build(input) {
    const inputs = Array.isArray(input.inputs) ? (input.inputs as unknown[]).map(String) : [];
    return { args: ['a', str(input, 'output'), ...inputs] };
  },
};

const zipCreate: OpImpl = {
  tool: 'zip',
  prefer: 70,
  build(input) {
    const inputs = Array.isArray(input.inputs) ? (input.inputs as unknown[]).map(String) : [];
    return { args: ['-r', str(input, 'output'), ...inputs] };
  },
};

const archiveCreateOp: OperationSpec = {
  id: 'archive.create',
  title: 'Create archive',
  description: 'Create a tar, 7z or zip archive.',
  capability: 'archive.manage',
  inputs: [
    { name: 'output', type: 'string', required: true, description: 'Archive path' },
    { name: 'inputs', type: 'array', description: 'Files or folders to include' },
  ],
  outputs: [{ name: 'archive', type: 'string', description: 'Archive path' }],
  impls: [tarCreate, sevenZipCreate, zipCreate],
};

/* ------------------------------ network ---------------------------- */

const nslookupQuery: OpImpl = {
  tool: 'nslookup',
  prefer: 100,
  build(input) {
    const args = [str(input, 'host')];
    const type = str(input, 'type');
    if (type) args.push(type);
    return { args };
  },
};

const digQuery: OpImpl = {
  tool: 'dig',
  prefer: 90,
  build(input) {
    const args = ['+short'];
    const type = str(input, 'type');
    if (type) args.push(type);
    args.push(str(input, 'host'));
    return { args };
  },
};

const dnsLookupOp: OperationSpec = {
  id: 'net.dns',
  title: 'DNS lookup',
  description: 'Resolve DNS records.',
  capability: 'dns.lookup',
  inputs: [
    { name: 'host', type: 'string', required: true, description: 'Hostname' },
    { name: 'type', type: 'string', description: 'Record type (A, MX, TXT...)' },
  ],
  outputs: [{ name: 'records', type: 'array', description: 'DNS answers' }],
  impls: [nslookupQuery, digQuery],
};

/* ------------------------------ process ---------------------------- */

const tasklistImpl: OpImpl = {
  tool: 'tasklist',
  prefer: 100,
  build(input) {
    const args = ['/FO', 'CSV', '/NH'];
    const filter = str(input, 'filter');
    if (filter) args.push('/FI', `IMAGENAME eq ${filter}`);
    return { args };
  },
  parse(result) {
    const rows = result.stdout.split(/\r?\n/).filter(Boolean);
    return rows.map((row) => {
      const cells = row.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
      return { name: cells[0], pid: Number(cells[1]), session: cells[2], memory: cells[4] };
    });
  },
};

const psImpl: OpImpl = {
  tool: 'ps',
  prefer: 80,
  build(input) {
    const args = ['aux'];
    const filter = str(input, 'filter');
    if (filter) args.push('--filter', filter);
    return { args };
  },
};

const processListOp: OperationSpec = {
  id: 'process.list',
  title: 'List processes',
  description: 'List running processes.',
  capability: 'process.inspect',
  inputs: [{ name: 'filter', type: 'string', description: 'Process name filter' }],
  outputs: [{ name: 'processes', type: 'array', description: 'Process list' }],
  impls: [tasklistImpl, psImpl],
};

/* ------------------------------- system ---------------------------- */

const sysInfoOp: OperationSpec = {
  id: 'sys.info',
  title: 'System information',
  description: 'Report OS, CPU, memory and runtime information.',
  capability: 'sys.admin',
  inputs: [],
  outputs: [{ name: 'info', type: 'object', description: 'System information' }],
  impls: [],
  builtin: {
    tool: '__builtin__',
    prefer: 100,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinSysInfo(input, ctx),
  },
};

/* ------------------------------- web -------------------------------- */

const duckDuckGoSearch: OpImpl = {
  tool: 'curl',
  prefer: 100,
  build(input) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(str(input, 'query'))}`;
    return { args: ['-sSL', ...CURL_WINDOWS_TLS_ARGS, '-A', 'Mozilla/5.0', url] };
  },
  parse(result) {
    const results: Array<{ title: string; url: string }> = [];
    const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(result.stdout)) !== null) {
      const href = match[1] ?? '';
      results.push({
        title: (match[2] ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(),
        url: href.startsWith('//') ? `https:${href}` : href,
      });
    }
    return results;
  },
};

const webSearchOp: OperationSpec = {
  id: 'web.search',
  title: 'Web search',
  description: 'Search the web (DuckDuckGo HTML endpoint, no API key required).',
  capability: 'web.search',
  inputs: [
    { name: 'query', type: 'string', required: true, description: 'Search terms' },
    { name: 'limit', type: 'number', description: 'Maximum results', default: 10 },
  ],
  outputs: [{ name: 'results', type: 'array', description: 'Search results' }],
  impls: [duckDuckGoSearch],
  builtin: {
    tool: '__builtin__',
    prefer: 10,
    build: () => ({ args: [] }),
    run: (input, ctx) => builtinWebSearch(input, ctx),
  },
};

/* --------------------------- registry ------------------------------ */

export const OPERATIONS: OperationSpec[] = [
  httpRequestOp,
  httpDownloadOp,
  jsonQueryOp,
  yamlQueryOp,
  fileReadOp,
  fileWriteOp,
  fileListOp,
  textSearchOp,
  codeRunOp,
  vcsLogOp,
  vcsStatusOp,
  containerListOp,
  k8sGetOp,
  dbQueryOp,
  mediaInfoOp,
  mediaConvertOp,
  imageConvertOp,
  docExtractOp,
  ocrReadOp,
  archiveCreateOp,
  dnsLookupOp,
  processListOp,
  sysInfoOp,
  webSearchOp,
];

export const OPERATION_BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]));

export function listOperations(): OperationSpec[] {
  return OPERATIONS;
}
