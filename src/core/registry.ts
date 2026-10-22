import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, CATALOG_BY_BIN, CATALOG_BY_ID } from './catalog.js';
import { inferCapabilities, scanPath } from './discovery/scan.js';
import { resolveBin, run } from './exec.js';
import type { ToolDescriptor } from './types.js';
import { bridgeHome, ensureDir, readJsonFile, writeJsonFile } from './util.js';

interface CacheFile {
  scannedAt: number;
  tools: ToolDescriptor[];
}

function cacheFile(): string {
  return join(bridgeHome(), 'cache', 'tools.json');
}

export interface RegistryOptions {
  /** Re-scan PATH even when a cache exists. */
  refresh?: boolean;
  /** Include binaries that live in system directories. */
  includeSystem?: boolean;
}

/**
 * The registry knows every tool the bridge can talk to.
 *
 * It merges three sources:
 *   1. the static catalog (rich metadata + install recipes)
 *   2. binaries discovered on PATH (the long tail)
 *   3. user supplied plugins
 */
export class Registry {
  private tools = new Map<string, ToolDescriptor>();
  private loaded = false;
  private dirs: Array<{ dir: string; scope: string; binaries: number }> = [];

  async load(options: RegistryOptions = {}): Promise<void> {
    if (this.loaded && !options.refresh) return;

    const cache = readJsonFile<CacheFile | null>(cacheFile(), null);
    const cacheFresh = cache && Date.now() - cache.scannedAt < 5 * 60_000;

    if (cacheFresh && !options.refresh && cache) {
      for (const tool of cache.tools) this.tools.set(tool.id, tool);
      this.loaded = true;
      return;
    }

    this.refresh(options);
    this.loaded = true;
  }

  /** Re-scan the machine and rebuild the registry. */
  refresh(options: RegistryOptions = {}): void {
    const scan = scanPath();
    this.dirs = scan.dirs;

    const merged = new Map<string, ToolDescriptor>();

    // 1. Catalog entries that are actually installed.
    for (const entry of CATALOG) {
      const found = scan.binaries.get(entry.id.toLowerCase());
      const resolved = found?.path ?? resolveBin(entry.bin);
      if (!resolved) continue;

      const tool: ToolDescriptor = {
        id: entry.id,
        bin: found?.bin ?? entry.bin,
        title: entry.title,
        description: entry.description,
        category: entry.category,
        capabilities: entry.capabilities,
        source: 'catalog',
        path: resolved,
        scope: found?.scope ?? 'user',
      };
      if (entry.defaultArgs) tool.defaultArgs = entry.defaultArgs;
      if (entry.io) tool.io = entry.io;
      if (entry.install) tool.install = entry.install;
      if (entry.examples) tool.examples = entry.examples;
      if (entry.tags) tool.tags = entry.tags;
      if (entry.dangerous) tool.dangerous = entry.dangerous;
      if (entry.notes) tool.notes = entry.notes;
      merged.set(tool.id, tool);
    }

    // 2. Everything else found on PATH.
    for (const [id, info] of scan.binaries) {
      if (merged.has(id)) continue;

      const catalogHit = CATALOG_BY_BIN.get(info.bin.toLowerCase())?.[0];
      const descriptor: ToolDescriptor = {
        id,
        bin: info.bin,
        title: catalogHit?.title ?? id,
        description: catalogHit?.description ?? `${info.bin} (discovered on PATH, no catalog metadata)`,
        category: catalogHit?.category ?? 'other',
        capabilities: catalogHit?.capabilities ?? inferCapabilities(id),
        source: 'path',
        path: info.path,
        scope: info.scope,
      };
      if (catalogHit?.install) descriptor.install = catalogHit.install;
      merged.set(id, descriptor);
    }

    // 3. Catalog entries that are not installed stay visible but flagged.
    for (const entry of CATALOG) {
      if (merged.has(entry.id)) continue;
      const tool: ToolDescriptor = {
        id: entry.id,
        bin: entry.bin,
        title: entry.title,
        description: entry.description,
        category: entry.category,
        capabilities: entry.capabilities,
        source: 'catalog',
        scope: 'system',
      };
      if (entry.defaultArgs) tool.defaultArgs = entry.defaultArgs;
      if (entry.io) tool.io = entry.io;
      if (entry.install) tool.install = entry.install;
      if (entry.examples) tool.examples = entry.examples;
      if (entry.tags) tool.tags = entry.tags;
      if (entry.notes) tool.notes = entry.notes;
      merged.set(tool.id, tool);
    }

    this.tools = merged;
    this.persist();
  }

  private persist(): void {
    const dir = ensureDir(join(bridgeHome(), 'cache'));
    writeJsonFile(join(dir, 'tools.json'), {
      scannedAt: Date.now(),
      tools: [...this.tools.values()],
    } satisfies CacheFile);
  }

  /** Register a tool manually (used by plugins and `bridge add`). */
  register(tool: ToolDescriptor): void {
    this.tools.set(tool.id, tool);
    this.persist();
  }

  get(id: string): ToolDescriptor | undefined {
    const direct = this.tools.get(id.toLowerCase());
    if (direct) return direct;
    return [...this.tools.values()].find((tool) => tool.bin.toLowerCase() === id.toLowerCase());
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** True when the tool is present on the machine. */
  isInstalled(tool: ToolDescriptor | undefined): boolean {
    if (!tool) return false;
    if (tool.path && existsSync(tool.path)) return true;
    return Boolean(resolveBin(tool.bin));
  }

  list(options: { includeSystem?: boolean; includeMissing?: boolean; category?: string } = {}): ToolDescriptor[] {
    const includeSystem = options.includeSystem ?? false;
    const includeMissing = options.includeMissing ?? true;

    return [...this.tools.values()]
      .filter((tool) => {
        if (options.category && tool.category !== options.category) return false;
        if (!includeSystem && tool.scope === 'system' && tool.source !== 'catalog') return false;
        if (!includeMissing && !this.isInstalled(tool)) return false;
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  search(query: string, limit = 50): ToolDescriptor[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.list().slice(0, limit);
    const scored: Array<{ tool: ToolDescriptor; score: number }> = [];

    for (const tool of this.tools.values()) {
      const haystack = `${tool.id} ${tool.title} ${tool.description} ${tool.category} ${tool.capabilities.join(' ')}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      let score = 0;
      if (tool.id.toLowerCase() === q) score += 100;
      if (tool.id.toLowerCase().startsWith(q)) score += 40;
      if (tool.title.toLowerCase().includes(q)) score += 20;
      if (tool.capabilities.some((c) => c.includes(q))) score += 15;
      if (haystack.includes(q)) score += 5;
      if (this.isInstalled(tool)) score += 3;
      scored.push({ tool, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
      .slice(0, limit)
      .map((entry) => entry.tool);
  }

  /** Tools that provide a given capability. */
  byCapability(capability: string): ToolDescriptor[] {
    return [...this.tools.values()].filter((tool) => tool.capabilities.includes(capability as never));
  }

  get pathDirs(): Array<{ dir: string; scope: string; binaries: number }> {
    return this.dirs;
  }

  /** Probe the version of a tool. Cheap enough for a single tool. */
  async probeVersion(tool: ToolDescriptor): Promise<string | undefined> {
    const candidates: string[][] = [
      ['--version'],
      ['version'],
      ['-v'],
      ['--help'],
    ];
    for (const args of candidates) {
      const result = await run({
        tool: tool.id,
        bin: tool.bin,
        path: tool.path,
        args,
        timeoutMs: 5000,
        maxBuffer: 16 * 1024,
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
        return first.trim().slice(0, 120);
      }
    }
    return undefined;
  }
}

export const registry = new Registry();
export { CATALOG_BY_ID, CATALOG_BY_BIN };
