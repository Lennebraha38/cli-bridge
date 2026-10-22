import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, arch, cpus, freemem, hostname, platform, release, totalmem, uptime, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { ExecResult, OpContext, OpInputValues } from '../types.js';
import { tryParseJson } from '../util.js';
import { applyAggregate, jsonPath } from './jsonpath.js';

function ok(tool: string, extra: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    tool,
    bin: tool,
    argv: [],
    cwd: process.cwd(),
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    truncated: false,
    timedOut: false,
    ...extra,
  };
}

function fail(tool: string, error: string, extra: Partial<ExecResult> = {}): ExecResult {
  return ok(tool, { ok: false, exitCode: 1, error, ...extra });
}

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

function headersMap(input: OpInputValues): Record<string, string> {
  const raw = input.headers;
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = String(value);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

async function fetchImpl(
  input: OpInputValues,
  ctx: OpContext,
  mode: 'request' | 'download' | 'search',
): Promise<ExecResult> {
  const started = Date.now();
  let url = str(input, 'url');
  if (mode === 'search') {
    url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(str(input, 'query'))}`;
  }
  if (!url) return fail('__builtin__', 'url is required');

  const query = input.query;
  if (query && typeof query === 'object') {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      parsed.searchParams.set(key, String(value));
    }
    url = parsed.toString();
  }

  const method = str(input, 'method', mode === 'search' ? 'GET' : 'GET').toUpperCase();
  const timeoutMs = num(input, 'timeoutMs', ctx.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = headersMap(input);
    const body = input.body !== undefined ? str(input, 'body') : undefined;
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: bool(input, 'followRedirects', true) ? 'follow' : 'manual',
      signal: controller.signal,
    });

    const meta: Record<string, unknown> = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      url: response.url,
    };

    if (mode === 'download') {
      const target = resolve(ctx.cwd, str(input, 'output'));
      mkdirSync(dirname(target), { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(target, buffer);
      return ok('__builtin__', {
        stdout: target,
        durationMs: Date.now() - started,
        meta: { ...meta, output: target, bytes: buffer.length },
      });
    }

    const text = await response.text();

    if (mode === 'search') {
      const limit = num(input, 'limit', 10);
      const results: Array<{ title: string; url: string }> = [];
      const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null && results.length < limit) {
        const href = match[1] ?? '';
        const title = (match[2] ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
        const resolvedHref = href.startsWith('//') ? `https:${href}` : href;
        results.push({ title, url: resolvedHref });
      }
      return ok('__builtin__', {
        stdout: JSON.stringify(results, null, 2),
        json: results,
        durationMs: Date.now() - started,
        meta: { ...meta, count: results.length },
      });
    }

    const parsed = tryParseJson(text);
    const result = ok('__builtin__', {
      stdout: text,
      durationMs: Date.now() - started,
      meta,
      exitCode: response.ok ? 0 : 1,
      ok: response.ok,
    });
    if (parsed !== undefined) result.json = parsed;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail('__builtin__', message, { durationMs: Date.now() - started, stderr: message });
  } finally {
    clearTimeout(timer);
  }
}

export const builtinHttpRequest = (input: OpInputValues, ctx: OpContext): Promise<ExecResult> =>
  fetchImpl(input, ctx, 'request');

export const builtinHttpDownload = (input: OpInputValues, ctx: OpContext): Promise<ExecResult> =>
  fetchImpl(input, ctx, 'download');

export const builtinWebSearch = (input: OpInputValues, ctx: OpContext): Promise<ExecResult> =>
  fetchImpl(input, ctx, 'search');

/* ------------------------------------------------------------------ */
/* json                                                                */
/* ------------------------------------------------------------------ */

export const builtinJsonQuery = async (
  input: OpInputValues,
  ctx: OpContext,
): Promise<ExecResult> => {
  const started = Date.now();
  const raw = input.json !== undefined ? str(input, 'json') : (input.input !== undefined ? str(input, 'input') : '');
  const filter = str(input, 'filter', '$');

  let source: unknown;
  if (raw.trim()) {
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
      return fail('__builtin__', 'input is not valid JSON', { stderr: 'input is not valid JSON' });
    }
    source = parsed;
  } else {
    const stdin = ctx as OpContext & { stdin?: string };
    const piped = stdin.stdin ?? '';
    if (!piped.trim()) return fail('__builtin__', 'no JSON provided (use "json" or pipe stdin)');
    const parsed = tryParseJson(piped);
    if (parsed === undefined) return fail('__builtin__', 'piped stdin is not valid JSON');
    source = parsed;
  }

  const trimmed = filter.trim();
  const aggregate = /^(length|keys|values|type|add|sort|reverse|unique|min|max)$/.test(trimmed);
  let result: unknown;

  if (aggregate) {
    result = applyAggregate(source, trimmed);
  } else if (trimmed === '$' || trimmed === '' || trimmed === '.') {
    result = source;
  } else {
    const matches = jsonPath(source, trimmed);
    result = matches.length === 1 ? matches[0] : matches;
  }

  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return ok('__builtin__', {
    stdout: text ?? 'null',
    json: result,
    durationMs: Date.now() - started,
  });
};

/* ------------------------------------------------------------------ */
/* files                                                               */
/* ------------------------------------------------------------------ */

export const builtinFileRead = async (input: OpInputValues, ctx: OpContext): Promise<ExecResult> => {
  const started = Date.now();
  const path = resolve(ctx.cwd, str(input, 'path'));
  try {
    const content = readFileSync(path, 'utf8');
    const parsed = tryParseJson(content);
    const result = ok('__builtin__', {
      stdout: content,
      durationMs: Date.now() - started,
      meta: { path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') },
    });
    if (parsed !== undefined) result.json = parsed;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail('__builtin__', message, { stderr: message, durationMs: Date.now() - started });
  }
};

export const builtinFileWrite = async (input: OpInputValues, ctx: OpContext): Promise<ExecResult> => {
  const started = Date.now();
  const path = resolve(ctx.cwd, str(input, 'path'));
  const content = input.content !== undefined ? str(input, 'content') : '';
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (bool(input, 'append')) {
      const existing = (() => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return '';
        }
      })();
      writeFileSync(path, existing + content, 'utf8');
    } else {
      writeFileSync(path, content, 'utf8');
    }
    return ok('__builtin__', {
      stdout: path,
      durationMs: Date.now() - started,
      meta: { path, bytes: content.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail('__builtin__', message, { stderr: message, durationMs: Date.now() - started });
  }
};

export const builtinFileList = async (input: OpInputValues, ctx: OpContext): Promise<ExecResult> => {
  const started = Date.now();
  const root = resolve(ctx.cwd, str(input, 'path', '.'));
  const maxDepth = num(input, 'depth', 3);
  const limit = num(input, 'limit', 5000);
  const pattern = str(input, 'pattern');
  const matcher = pattern ? new RegExp(pattern, 'i') : null;

  const entries: Array<{ path: string; type: string; size: number }> = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || entries.length >= limit) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= limit) return;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (!matcher || matcher.test(name)) {
        entries.push({ path: relative(ctx.cwd, full) || full, type: stats.isDirectory() ? 'dir' : 'file', size: stats.size });
      }
      if (stats.isDirectory()) walk(full, depth + 1);
    }
  };

  try {
    walk(root, 0);
    return ok('__builtin__', {
      stdout: JSON.stringify(entries, null, 2),
      json: entries,
      durationMs: Date.now() - started,
      meta: { root, count: entries.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail('__builtin__', message, { stderr: message });
  }
};

/* ------------------------------------------------------------------ */
/* text search                                                         */
/* ------------------------------------------------------------------ */

export const builtinTextSearch = async (input: OpInputValues, ctx: OpContext): Promise<ExecResult> => {
  const started = Date.now();
  const pattern = str(input, 'pattern');
  if (!pattern) return fail('__builtin__', 'pattern is required');

  const root = resolve(ctx.cwd, str(input, 'path', '.'));
  const maxCount = num(input, 'maxCount', 200);
  const ignoreCase = bool(input, 'ignoreCase', false);
  const glob = str(input, 'glob');
  const globMatcher = glob ? new RegExp(glob.replace(/\*/g, '.*')) : null;

  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, ignoreCase ? 'i' : 'g');
  } catch (error) {
    return fail('__builtin__', `invalid pattern: ${error instanceof Error ? error.message : error}`);
  }

  const matches: Array<{ file: string; line: number; text: string }> = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || matches.length >= maxCount) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (matches.length >= maxCount) return;
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.venv') continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (stats.size > 5 * 1024 * 1024) continue;
      if (globMatcher && !globMatcher.test(name)) continue;
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        matcher.lastIndex = 0;
        if (matcher.test(line)) {
          matches.push({ file: relative(ctx.cwd, full) || full, line: index + 1, text: line.trim().slice(0, 400) });
          if (matches.length >= maxCount) break;
        }
      }
    }
  };

  try {
    walk(root, 0);
    return ok('__builtin__', {
      stdout: matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n'),
      json: matches,
      durationMs: Date.now() - started,
      meta: { count: matches.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail('__builtin__', message, { stderr: message });
  }
};

/* ------------------------------------------------------------------ */
/* system                                                              */
/* ------------------------------------------------------------------ */

export const builtinSysInfo = async (_input: OpInputValues, ctx: OpContext): Promise<ExecResult> => {
  const info = {
    platform: platform(),
    arch: arch(),
    release: release(),
    hostname: hostname(),
    user: userInfo().username,
    home: homedir(),
    cwd: ctx.cwd,
    cpus: cpus().length,
    memoryTotal: totalmem(),
    memoryFree: freemem(),
    uptimeSeconds: Math.round(uptime()),
    node: process.version,
  };
  return ok('__builtin__', { stdout: JSON.stringify(info, null, 2), json: info });
};
