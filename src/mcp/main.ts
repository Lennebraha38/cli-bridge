#!/usr/bin/env node
/**
 * Standalone MCP entry point.
 *
 * MCP clients start this file directly, without the CLI argument parser:
 *   node dist/mcp/main.js
 */
import { runMcpServer } from './mcp-server.js';

runMcpServer().catch((error: unknown) => {
  process.stderr.write(`cli-bridge mcp failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
