/**
 * cli-bridge public API.
 *
 * ```ts
 * import { registry, runOperation, runChain } from 'cli-bridge';
 *
 * await registry.load();
 * const result = await runOperation('http.request', { input: { url: 'https://example.com' } });
 * ```
 */

export * from './core/types.js';

export { registry, Registry } from './core/registry.js';
export { callTool } from './core/runner.js';
export { runChain, parseShorthand, interpolate, resolveReference } from './core/chain.js';
export { listOperations, OPERATIONS, OPERATION_BY_ID } from './core/operations/index.js';
export { runOperation, selectImplementation, operationBackends } from './core/operations/runner.js';
export { jsonPath } from './core/operations/jsonpath.js';
export { BridgeServer, startServer } from './server/server.js';
export { BridgeMcpServer, runMcpServer } from './mcp/mcp-server.js';
export { loadConfig, saveConfig, updateConfig, DEFAULT_CONFIG } from './core/config.js';
export { Policy, DEFAULT_POLICY } from './core/policy.js';
export { run, resolveBin } from './core/exec.js';
export { scanPath, inferCapabilities } from './core/discovery/scan.js';
export { CATALOG } from './core/catalog.js';
export { installTool, planInstall, detectManagers, findInstallable } from './install/installer.js';
export { bridgeHome } from './core/util.js';
