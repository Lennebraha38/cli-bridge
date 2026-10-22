import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ExecOptions, ExecResult } from './types.js';
import { isWindows, tryParseJson } from './util.js';

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1'];

/** Quote an argument for cmd.exe. */
function quoteWindows(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Locate a binary on PATH.
 * Returns the absolute path of the first match.
 */
export function resolveBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes('/') || bin.includes('\\')) {
    const direct = isAbsolute(bin) ? bin : join(process.cwd(), bin);
    return existsSync(direct) ? direct : undefined;
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const extensions = isWindows()
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, bin + ext);
      try {
        if (!existsSync(candidate)) continue;
        const stats = statSync(candidate);
        if (stats.isFile()) return candidate;
      } catch {
        // Broken symlink or inaccessible entry: fall back to a link check.
        try {
          if (lstatSync(candidate).isSymbolicLink()) return candidate;
        } catch {
          /* ignore */
        }
      }
    }
    // On POSIX also try the bare name.
    if (!isWindows()) {
      const candidate = join(dir, bin);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** True when the file is a script that needs cmd.exe to run on Windows. */
function needsCmdWrapper(resolved: string): boolean {
  return isWindows() && /\.(cmd|bat)$/i.test(resolved);
}

export interface RunSpec {
  /** Tool id used in the result payload. */
  tool: string;
  /** Executable name (resolved against PATH). */
  bin: string;
  /** Absolute path when known; otherwise resolved from PATH. */
  path?: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBuffer?: number;
  shell?: boolean;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Spawn a process without a shell and capture its output.
 * This is the single execution path of the whole bridge.
 */
export function run(spec: RunSpec): Promise<ExecResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = spec.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const started = Date.now();

  return new Promise<ExecResult>((resolvePromise) => {
    const resolvedPath = spec.path ?? resolveBin(spec.bin, { ...process.env, ...spec.env });
    if (!resolvedPath) {
      resolvePromise({
        ok: false,
        tool: spec.tool,
        bin: spec.bin,
        argv: spec.args ?? [],
        cwd: spec.cwd ?? process.cwd(),
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
        timedOut: false,
        error: `command not found: ${spec.bin}`,
      });
      return;
    }

    const args = spec.args ?? [];
    const cwd = spec.cwd ?? process.cwd();
    const env = { ...process.env, ...(spec.env ?? {}) } as NodeJS.ProcessEnv;

    let command = resolvedPath;
    let commandArgs = args;
    let useShell = false;

    if (spec.shell) {
      useShell = true;
      commandArgs = args;
    } else if (needsCmdWrapper(resolvedPath)) {
      // .cmd/.bat cannot be executed directly on modern Node without a shell.
      command = env.ComSpec ?? 'cmd.exe';
      const line = [resolvedPath, ...args].map(quoteWindows).join(' ');
      commandArgs = ['/d', '/s', '/c', `"${line}"`];
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, commandArgs, {
        cwd,
        env,
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        ok: false,
        tool: spec.tool,
        bin: spec.bin,
        argv: args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        truncated: false,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length + text.length > maxBuffer) {
          stdout += text.slice(0, Math.max(0, maxBuffer - stdout.length));
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > maxBuffer) {
          stderr += text.slice(0, Math.max(0, maxBuffer - stderr.length));
          truncated = true;
        } else {
          stderr += text;
        }
      }
    };

    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));

    const killTree = (): void => {
      if (child.pid && isWindows()) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeoutMs)
        : undefined;

    const onAbort = (): void => {
      killTree();
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);

      const durationMs = Date.now() - started;
      const ok = !error && !timedOut && exitCode === 0;
      const result: ExecResult = {
        ok,
        tool: spec.tool,
        bin: spec.bin,
        argv: args,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs,
        truncated,
        timedOut,
        error: error ?? (timedOut ? `timed out after ${timeoutMs}ms` : undefined),
      };
      const parsed = tryParseJson(result.stdout);
      if (parsed !== undefined) result.json = parsed;
      resolvePromise(result);
    };

    child.on('error', (err) => finish(null, null, err.message));
    child.on('close', (code, signal) => finish(code, signal));

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* the process may exit before reading stdin */
      });
      child.stdin.end(spec.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Convenience wrapper matching the ExecOptions shape. */
export function execBin(
  tool: string,
  bin: string,
  options: ExecOptions & { path?: string } = {},
): Promise<ExecResult> {
  return run({
    tool,
    bin,
    path: options.path,
    args: options.args,
    stdin: options.stdin,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    shell: options.shell,
    signal: options.signal,
  });
}
