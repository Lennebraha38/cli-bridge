import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { Capability, ToolDescriptor } from '../types.js';
import { isWindows } from '../util.js';

export interface PathEntry {
  dir: string;
  scope: 'user' | 'system';
  binaries: number;
}

export interface ScanResult {
  scannedAt: number;
  dirs: PathEntry[];
  /** Raw binaries found on PATH (id = file name without extension). */
  binaries: Map<string, { bin: string; path: string; scope: 'user' | 'system' }>;
}

const EXECUTABLE_EXTENSIONS = isWindows()
  ? new Set(['.exe', '.cmd', '.bat', '.com'])
  : new Set(['']);

/** Binary names that are never useful as CLI tools. */
const NOISE = [
  /^uninstall/i,
  /^setup$/i,
  /^install(er)?$/i,
  /^update(r)?$/i,
  /^vcredist/i,
  /^dxsetup/i,
  /^vc_redist/i,
  /^(repair|modify|remove)/i,
  /^desktop/i,
  /^(readme|license|changelog)/i,
];

function isNoise(name: string): boolean {
  return NOISE.some((pattern) => pattern.test(name));
}

/** Decide whether a PATH directory belongs to the user or to the system. */
function classifyScope(dir: string): 'user' | 'system' {
  const normalized = dir.toLowerCase().replace(/\\/g, '/');
  const home = homedir().toLowerCase().replace(/\\/g, '/');

  if (isWindows()) {
    if (normalized.startsWith('c:/windows') || normalized.startsWith('c:/program files')) {
      return 'system';
    }
    return 'user';
  }

  if (normalized.startsWith('/usr/bin') || normalized.startsWith('/usr/sbin') || normalized.startsWith('/bin') || normalized.startsWith('/sbin')) {
    return 'system';
  }
  if (normalized.startsWith('/usr/local') || normalized.startsWith('/opt/homebrew') || normalized.startsWith('/opt/')) {
    return 'user';
  }
  if (normalized.startsWith(home)) return 'user';
  return 'system';
}

/** All PATH entries for the current process. */
export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(delimiter)) {
    if (!part.trim()) continue;
    const expanded = part.startsWith('~')
      ? join(homedir(), part.slice(1))
      : part;
    const dir = resolve(expanded);
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Scan every PATH directory for executables.
 * Cheap enough to run on demand, cached by the registry.
 */
export function scanPath(env: NodeJS.ProcessEnv = process.env): ScanResult {
  const binaries = new Map<string, { bin: string; path: string; scope: 'user' | 'system' }>();
  const dirs: PathEntry[] = [];

  for (const dir of pathEntries(env)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    const scope = classifyScope(dir);
    let count = 0;

    for (const name of entries) {
      if (isNoise(name)) continue;
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const hasExt = name.includes('.');
      if (hasExt && !EXECUTABLE_EXTENSIONS.has(ext)) continue;
      if (!hasExt && isWindows()) continue;

      const full = join(dir, name);
      try {
        const stats = statSync(full);
        if (!stats.isFile()) continue;
        // Skip enormous installers masquerading as CLI tools.
        if (stats.size > 120 * 1024 * 1024) continue;
      } catch {
        continue;
      }

      const id = (hasExt ? name.slice(0, name.lastIndexOf('.')) : name).toLowerCase();
      if (!id) continue;
      if (binaries.has(id)) continue;

      binaries.set(id, { bin: name, path: full, scope });
      count++;
    }

    dirs.push({ dir, scope, binaries: count });
  }

  return { scannedAt: Date.now(), dirs, binaries };
}

/** Name based capability guessing for binaries that are not in the catalog. */
export function inferCapabilities(id: string, description = ''): Capability[] {
  const text = `${id} ${description}`.toLowerCase();
  const caps = new Set<Capability>();

  const rules: Array<[RegExp, Capability]> = [
    [/curl|wget|httpie|\bhttp\b|restler|insomnia/, 'http.request'],
    [/jq|json|yaml|\byq\b|dasel|toml/, 'json.transform'],
    [/csv|tsv|mlr|xsv/, 'csv.transform'],
    [/ripgrep|grep|ag\b|ack\b|fzf|rg\b/, 'text.search'],
    [/sed|awk|perl|tr\b|cut\b|sort|uniq/, 'text.process'],
    [/git|hg\b|svn|mercurial/, 'vcs.operate'],
    [/docker|podman|nerdctl|container/, 'container.manage'],
    [/kube|kubectl|helm|k9s|kustomize/, 'k8s.manage'],
    [/aws|az\b|gcloud|doctl|oci\b|cloud/, 'cloud.manage'],
    [/terraform|pulumi|ansible|vagrant|packer/, 'infra.manage'],
    [/psql|mysql|sqlite|mongo|redis|clickhouse|duckdb|influx/, 'db.query'],
    [/ffmpeg|ffprobe|avconv|vlc|media/, 'media.transcode'],
    [/magick|convert\b|graphicsmagick|vips/, 'image.process'],
    [/pandoc|pdf|docx|typst|asciidoc|wkhtml|soffice|libreoffice/, 'doc.render'],
    [/tesseract|ocr/, 'ocr.read'],
    [/7z|zip|tar\b|zstd|xz\b|gzip|bzip/, 'archive.manage'],
    [/node|python|ruby|perl|php|java\b|dotnet|deno|bun\b|go\b|rust/, 'code.run'],
    [/eslint|prettier|ruff|black|mypy|lint|shellcheck|clippy|biome/, 'code.lint'],
    [/pytest|jest|vitest|mocha|test|cypress|playwright/, 'test.run'],
    [/ssh|scp|sftp|rsync|mosh/, 'remote.exec'],
    [/dig|nslookup|host\b|ping|traceroute|nmap|netstat|ss\b/, 'net.inspect'],
    [/gpg|age\b|sops|vault|openssl|pass\b/, 'secret.manage'],
    [/npm|pnpm|yarn|pip|cargo|gem|apt|dnf|brew|winget|scoop|choco|uv\b/, 'package.manage'],
    [/ollama|llm|aider|gpt|claude|gemini/, 'llm.chat'],
    [/tree|fd\b|find|locate/, 'file.search'],
    [/cat\b|bat\b|head|tail|less\b|more\b/, 'file.read'],
    [/cp\b|mv\b|rm\b|del\b|copy|move/, 'file.write'],
    [/ps\b|top\b|htop|tasklist|taskkill|systemctl/, 'process.inspect'],
  ];

  for (const [pattern, capability] of rules) {
    if (pattern.test(text)) caps.add(capability);
  }
  if (caps.size === 0) caps.add('cli.exec');
  return [...caps];
}
