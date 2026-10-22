import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runChain } from '../core/chain.js';
import { loadConfig } from '../core/config.js';
import { listOperations } from '../core/operations/index.js';
import { runOperation } from '../core/operations/runner.js';
import { Policy } from '../core/policy.js';
import { registry } from '../core/registry.js';
import { callTool } from '../core/runner.js';
import { installTool } from '../install/installer.js';
import type { BridgeConfig } from '../core/types.js';

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function textResult(payload: unknown, isError = false): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * MCP server that exposes the bridge to AI coding agents
 * (Claude Code, opencode, Cursor, Gemini CLI, ...).
 *
 * Every discovered CLI tool becomes an MCP tool named `cli_<tool>` so an agent
 * can call it directly, and a set of meta tools (`bridge_search`,
 * `bridge_run_op`, `bridge_chain`) allow semantic, chainable usage.
 */
export class BridgeMcpServer {
  private server: Server;
  private config: BridgeConfig;
  private policy: Policy;

  constructor(config?: BridgeConfig) {
    this.config = config ?? loadConfig();
    this.policy = new Policy(this.config.policy);
    this.server = new Server(
      { name: 'cli-bridge', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.register();
  }

  private register(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolDefinitions(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      try {
        switch (name) {
          case 'bridge_search':
            return textResult(this.search(args));
          case 'bridge_list':
            return textResult(this.list(args));
          case 'bridge_ops':
            return textResult(
              listOperations().map((op) => ({
                id: op.id,
                title: op.title,
                description: op.description,
                inputs: op.inputs,
                outputs: op.outputs,
              })),
            );
          case 'bridge_call':
            return textResult(await this.call(args));
          case 'bridge_run_op':
            return textResult(await this.runOp(args));
          case 'bridge_chain':
            return textResult(await this.chain(args));
          case 'bridge_install':
            return textResult(await this.install(args));
          default:
            break;
        }

        if (name.startsWith('cli_')) {
          const toolId = name.slice(4);
          return textResult(await this.call({ tool: toolId, ...args }));
        }

        return textResult({ error: `unknown tool "${name}"` }, true);
      } catch (error) {
        return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    });
  }

  /** Tool definitions exposed to MCP clients. */
  toolDefinitions(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [
      {
        name: 'bridge_search',
        description:
          'Search the CLI tools and operations available on this machine. Use it first to find the right tool for a task.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms (tool id, capability or description)' },
            limit: { type: 'number', description: 'Maximum results', default: 20 },
          },
          required: ['query'],
        },
      },
      {
        name: 'bridge_list',
        description: 'List every CLI tool discovered on this machine with its capabilities and install state.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category (http, json, vcs, container...)' },
            includeSystem: { type: 'boolean', description: 'Include system wide binaries', default: false },
          },
        },
      },
      {
        name: 'bridge_ops',
        description: 'List the semantic operations that can chain multiple CLI tools together.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'bridge_call',
        description:
          'Call any CLI tool directly. Arguments are passed as an argv array (no shell interpolation).',
        inputSchema: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool id, e.g. "git", "jq", "curl"' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments' },
            stdin: { type: 'string', description: 'Content piped to the process' },
            cwd: { type: 'string', description: 'Working directory' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
          },
          required: ['tool'],
        },
      },
      {
        name: 'bridge_run_op',
        description:
          'Run a semantic operation such as http.request, json.query, vcs.log or media.info. Falls back to built-in implementations when the tool is missing.',
        inputSchema: {
          type: 'object',
          properties: {
            op: { type: 'string', description: 'Operation id' },
            input: { type: 'object', description: 'Operation input' },
            stdin: { type: 'string', description: 'Content piped to the operation' },
            cwd: { type: 'string', description: 'Working directory' },
          },
          required: ['op'],
        },
      },
      {
        name: 'bridge_chain',
        description:
          'Run a pipeline of operations. Later steps can read earlier results with {{steps.<id>.stdout}} or {{steps.<id>.json}}.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  op: { type: 'string' },
                  tool: { type: 'string' },
                  args: { type: 'array', items: { type: 'string' } },
                  with: { type: 'object' },
                },
              },
            },
            input: { type: 'object' },
            cwd: { type: 'string' },
          },
          required: ['steps'],
        },
      },
      {
        name: 'bridge_install',
        description: 'Install a CLI tool using the package manager available on this machine.',
        inputSchema: {
          type: 'object',
          properties: { tool: { type: 'string', description: 'Tool id, e.g. "jq"' } },
          required: ['tool'],
        },
      },
    ];

    if (this.config.mcp.exposeTools) {
      const listed = registry
        .list({ includeSystem: false })
        .filter((tool) => registry.isInstalled(tool))
        .slice(0, this.config.mcp.maxTools);

      for (const tool of listed) {
        tools.push({
          name: `cli_${tool.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          description: `${tool.title} - ${tool.description} Capabilities: ${tool.capabilities.join(', ')}.`,
          inputSchema: {
            type: 'object',
            properties: {
              args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments' },
              stdin: { type: 'string', description: 'Content piped to the process' },
              cwd: { type: 'string', description: 'Working directory' },
              timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
            },
          },
        });
      }
    }

    return tools;
  }

  private search(args: Record<string, unknown>): unknown {
    const query = String(args.query ?? '');
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const tools = registry.search(query, limit).map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      capabilities: tool.capabilities,
      installed: registry.isInstalled(tool),
      path: tool.path,
    }));
    const operations = listOperations()
      .filter((op) => !query || `${op.id} ${op.title} ${op.description}`.toLowerCase().includes(query.toLowerCase()))
      .map((op) => ({ id: op.id, title: op.title, description: op.description, capability: op.capability }));
    return { query, tools, operations };
  }

  private list(args: Record<string, unknown>): unknown {
    const includeSystem = args.includeSystem === true;
    const category = typeof args.category === 'string' ? args.category : undefined;
    return registry.list({ includeSystem, category }).map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      capabilities: tool.capabilities,
      installed: registry.isInstalled(tool),
      source: tool.source,
    }));
  }

  private async call(args: Record<string, unknown>): Promise<unknown> {
    const result = await callTool(
      {
        tool: String(args.tool ?? ''),
        args: Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [],
        stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      },
      this.policy,
    );
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      json: result.json,
      error: result.error,
    };
  }

  private async runOp(args: Record<string, unknown>): Promise<unknown> {
    const result = await runOperation(String(args.op ?? ''), {
      input: (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>,
      stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    });
    return {
      ok: result.ok,
      op: result.op,
      implementation: result.impl,
      builtin: result.builtin,
      output: result.output,
      stdout: result.result.stdout,
      stderr: result.result.stderr,
      exitCode: result.result.exitCode,
      error: result.error,
    };
  }

  private async chain(args: Record<string, unknown>): Promise<unknown> {
    const result = await runChain(
      {
        steps: Array.isArray(args.steps) ? (args.steps as never) : [],
        input: (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      },
      { policy: this.policy },
    );
    return result;
  }

  private async install(args: Record<string, unknown>): Promise<unknown> {
    const id = String(args.tool ?? '');
    const tool = registry.get(id) ?? undefined;
    if (!tool) return { ok: false, error: `unknown tool "${id}"` };
    const result = await installTool(tool);
    if (result.ok) registry.refresh({ includeSystem: this.config.discovery.includeSystem });
    return { ok: result.ok, plan: result.plan?.label, output: result.output, error: result.error };
  }

  async connectStdio(): Promise<void> {
    await registry.load({ includeSystem: this.config.discovery.includeSystem });
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

/** Entry point used by `bridge mcp`. */
export async function runMcpServer(config?: BridgeConfig): Promise<void> {
  const server = new BridgeMcpServer(config);
  await server.connectStdio();
}
