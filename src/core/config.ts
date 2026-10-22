import { join } from 'node:path';
import type { BridgeConfig } from './types.js';
import { bridgeHome, ensureDir, readJsonFile, writeJsonFile } from './util.js';

export const DEFAULT_CONFIG: BridgeConfig = {
  server: { host: '127.0.0.1', port: 8791 },
  exec: { timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 },
  policy: {
    mode: 'denylist',
    allowed: [],
    denied: [],
    allowShell: false,
    blockDangerous: true,
  },
  redact: true,
  mcp: { exposeTools: true, maxTools: 150 },
  discovery: { includeSystem: false, scanTimeoutMs: 5_000 },
};

export function configPath(): string {
  return join(bridgeHome(), 'config.json');
}

export function loadConfig(): BridgeConfig {
  const file = readJsonFile<Partial<BridgeConfig>>(configPath(), {});
  return {
    server: { ...DEFAULT_CONFIG.server, ...(file.server ?? {}) },
    exec: { ...DEFAULT_CONFIG.exec, ...(file.exec ?? {}) },
    policy: { ...DEFAULT_CONFIG.policy, ...(file.policy ?? {}) },
    redact: file.redact ?? DEFAULT_CONFIG.redact,
    mcp: { ...DEFAULT_CONFIG.mcp, ...(file.mcp ?? {}) },
    discovery: { ...DEFAULT_CONFIG.discovery, ...(file.discovery ?? {}) },
  };
}

export function saveConfig(config: BridgeConfig): void {
  ensureDir(bridgeHome());
  writeJsonFile(configPath(), config);
}

export function updateConfig(patch: Partial<BridgeConfig>): BridgeConfig {
  const current = loadConfig();
  const next: BridgeConfig = {
    server: { ...current.server, ...(patch.server ?? {}) },
    exec: { ...current.exec, ...(patch.exec ?? {}) },
    policy: { ...current.policy, ...(patch.policy ?? {}) },
    redact: patch.redact ?? current.redact,
    mcp: { ...current.mcp, ...(patch.mcp ?? {}) },
    discovery: { ...current.discovery, ...(patch.discovery ?? {}) },
  };
  saveConfig(next);
  return next;
}
