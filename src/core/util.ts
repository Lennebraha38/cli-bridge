import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Root directory for all bridge state (config, cache, audit log). */
export function bridgeHome(): string {
  const custom = process.env.CLI_BRIDGE_HOME;
  if (custom && custom.trim()) return resolve(custom.trim());
  const base =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()
      ? process.env.XDG_STATE_HOME
      : join(homedir(), '.cli-bridge');
  return base;
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function isWindows(): boolean {
  return platform() === 'win32';
}

/** The executable suffix used on this platform. */
export function binExtension(): string {
  return isWindows() ? '.exe' : '';
}

/** Split a shell-ish command string into argv (quotes respected). */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]!;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length || has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (cur.length || has) out.push(cur);
  return out;
}

/** Try to parse text as JSON, returning undefined when it is not JSON. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, 'ghp_***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
  [/ASIA[0-9A-Z]{16}/g, 'ASIA***'],
  [/AIza[0-9A-Za-z_\-]{35}/g, 'AIza***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***.***.***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***PRIVATE KEY***'],
];

/** Environment assignment patterns such as API_KEY=abcd... */
const ENV_ASSIGN = /([A-Z][A-Z0-9_]{3,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)?)\s*=\s*("?)([^\s"']{8,})\2/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(ENV_ASSIGN, (_m, name: string, q: string, value: string) => {
    if (name === 'PATH' || name === 'HOME' || name === 'PWD') return `${name}=${q}${value}${q}`;
    return `${name}=${q}***${q}`;
  });
  return out;
}

/** Human readable byte size. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Shorten text for table output. */
export function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + '…';
}

/** Turn arbitrary text into a stable slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
