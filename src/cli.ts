#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChain, parseShorthand } from './core/chain.js';
import { loadConfig, updateConfig } from './core/config.js';
import { listOperations } from './core/operations/index.js';
import { operationBackends } from './core/operations/runner.js';
import { Policy } from './core/policy.js';
import { registry } from './core/registry.js';
import { callTool } from './core/runner.js';
import { detectManagers, findInstallable, installTool, planInstall } from './install/installer.js';
import { startServer } from './server/server.js';
import { runMcpServer } from './mcp/mcp-server.js';
import { bridgeHome, splitArgs, truncate } from './core/util.js';

/* ------------------------------------------------------------------ */
/* tiny argument helpers                                               */
/* ------------------------------------------------------------------ */

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i += 2;
        continue;
      }
      flags[body] = true;
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      i++;
      continue;
    }
    positionals.push(arg);
    i++;
  }

  return { flags, positionals, rest };
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdList(args: ParsedArgs): Promise<void> {
  const includeSystem = args.flags.all === true || args.flags.system === true;
  const category = typeof args.flags.category === 'string' ? args.flags.category : undefined;
  const query = typeof args.flags.q === 'string' ? args.flags.q : undefined;

  const tools = query
    ? registry.search(query, 500)
    : registry.list({ includeSystem, category });

  if (args.flags.json === true) {
    printJson(
      tools.map((tool) => ({
        id: tool.id,
        title: tool.title,
        description: tool.description,
        category: tool.category,
        capabilities: tool.capabilities,
        installed: registry.isInstalled(tool),
        path: tool.path,
        source: tool.source,
      })),
    );
    return;
  }

  if (tools.length === 0) {
    out(c.dim('no tools found - run "bridge rescan" to refresh'));
    return;
  }

  const width = Math.min(28, Math.max(...tools.map((tool) => tool.id.length)));
  for (const tool of tools) {
    const installed = registry.isInstalled(tool);
    const mark = installed ? c.green('●') : c.dim('○');
    const name = tool.id.padEnd(width);
    const caps = c.cyan(truncate(tool.capabilities.slice(0, 3).join(', '), 38));
    out(`${mark} ${name}  ${c.dim(tool.category.padEnd(10))} ${caps}`);
  }
  out('');
  out(c.dim(`${tools.filter((tool) => registry.isInstalled(tool)).length} installed / ${tools.length} listed`));
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positionals.join(' ');
  if (!query) {
    out(c.red('usage: bridge search <query>'));
    process.exitCode = 1;
    return;
  }
  const tools = registry.search(query, 30);

  if (args.flags.json === true) {
    printJson(
      tools.map((tool) => ({
        id: tool.id,
        description: tool.description,
        capabilities: tool.capabilities,
        installed: registry.isInstalled(tool),
      })),
    );
    return;
  }

  if (tools.length === 0) {
    out(c.dim(`nothing found for "${query}"`));
    return;
  }

  for (const tool of tools) {
    const mark = registry.isInstalled(tool) ? c.green('●') : c.dim('○');
    out(`${mark} ${c.bold(tool.id.padEnd(16))} ${truncate(tool.description, 80)}`);
    out(`  ${c.dim(tool.capabilities.join(', '))}`);
  }
}

async function cmdDescribe(args: ParsedArgs): Promise<void> {
  const id = args.positionals[0];
  if (!id) {
    out(c.red('usage: bridge describe <tool>'));
    process.exitCode = 1;
    return;
  }

  const tool = registry.get(id);
  if (!tool) {
    out(c.red(`unknown tool "${id}"`));
    process.exitCode = 1;
    return;
  }

  const installed = registry.isInstalled(tool);
  const version = installed ? await registry.probeVersion(tool) : undefined;

  if (args.flags.json === true) {
    printJson({ ...tool, installed, version });
    return;
  }

  out(c.bold(tool.title) + c.dim(`  (${tool.id})`));
  out(tool.description);
  out('');
  out(`${c.dim('category:')}    ${tool.category}`);
  out(`${c.dim('capabilities:')} ${tool.capabilities.join(', ')}`);
  out(`${c.dim('installed:')}   ${installed ? c.green('yes') : c.yellow('no')}`);
  if (tool.path) out(`${c.dim('path:')}        ${tool.path}`);
  if (version) out(`${c.dim('version:')}     ${version}`);
  if (tool.io) out(`${c.dim('io:')}          stdin=${tool.io.stdin ?? 'text'} output=${tool.io.output ?? 'text'}`);
  if (tool.install) {
    const managers = detectManagers();
    const plan = planInstall(tool, managers);
    out(`${c.dim('install:')}      ${plan ? plan.label : (tool.install.manual ?? 'no recipe')}`);
  }
  if (tool.examples?.length) {
    out('');
    out(c.dim('examples:'));
    for (const example of tool.examples) out(`  ${example}`);
  }
}

/**
 * Parse the arguments of `bridge call`.
 *
 * Bridge flags must come *before* the tool name; everything after the tool
 * name is forwarded to the tool verbatim (so `git log --oneline -3` works).
 */
function parseCallArgs(argv: string[]): { tool: string; toolArgs: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set(['stdin', 'stdin-file', 'cwd', 'timeout', 'json-args', 'env']);

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--') {
      index++;
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        index++;
        continue;
      }
      if (valueFlags.has(body) && argv[index + 1] !== undefined) {
        flags[body] = argv[index + 1]!;
        index += 2;
        continue;
      }
      flags[body] = true;
      index++;
      continue;
    }
    break;
  }

  const tool = argv[index] ?? '';
  return { tool, toolArgs: argv.slice(index + 1), flags };
}

async function cmdCall(rawArgv: string[]): Promise<void> {
  const { tool: toolId, toolArgs, flags } = parseCallArgs(rawArgv);

  if (!toolId) {
    out(c.red('usage: bridge call [flags] <tool> [args...]'));
    out(c.dim('example: bridge call git log --oneline -10'));
    out(c.dim('flags: --json --stdin <text> --stdin-file <path> --cwd <dir> --timeout <ms> --json-args \'["-H","x"]\''));
    process.exitCode = 1;
    return;
  }

  let toolArgsFinal = toolArgs;
  if (typeof flags['json-args'] === 'string') {
    try {
      toolArgsFinal = JSON.parse(flags['json-args']) as string[];
    } catch (error) {
      out(c.red(`--json-args is not valid JSON: ${error instanceof Error ? error.message : error}`));
      process.exitCode = 1;
      return;
    }
  }

  let stdin: string | undefined;
  if (typeof flags.stdin === 'string') stdin = flags.stdin;
  else if (typeof flags['stdin-file'] === 'string') stdin = readFileSync(flags['stdin-file'], 'utf8');
  else if (flags.stdin === true) stdin = readFileSync(0, 'utf8');

  const config = loadConfig();
  const policy = new Policy(config.policy);

  const result = await callTool(
    {
      tool: toolId,
      args: toolArgsFinal,
      stdin,
      cwd: typeof flags.cwd === 'string' ? flags.cwd : undefined,
      timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : config.exec.timeoutMs,
    },
    policy,
  );

  if (flags.json === true) {
    printJson(result);
  } else {
    if (result.stdout) out(result.stdout.replace(/\n$/, ''));
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.ok) {
      out(c.red(`\n[exit ${result.exitCode ?? '-'}] ${result.error ?? 'failed'}`));
    }
  }

  if (!result.ok) process.exitCode = result.exitCode ?? 1;
}

async function cmdOp(args: ParsedArgs): Promise<void> {
  const opId = args.positionals[0];
  if (!opId) {
    out(c.red('usage: bridge op <operation> [--key value ...] [--input \'{"json":"..."}\']'));
    process.exitCode = 1;
    return;
  }

  const input: Record<string, unknown> = {};

  if (typeof args.flags.input === 'string') {
    const raw = args.flags.input.startsWith('@')
      ? readFileSync(args.flags.input.slice(1), 'utf8')
      : args.flags.input;
    try {
      Object.assign(input, JSON.parse(raw) as Record<string, unknown>);
    } catch (error) {
      out(c.red(`--input is not valid JSON: ${error instanceof Error ? error.message : error}`));
      process.exitCode = 1;
      return;
    }
  }

  for (const [key, value] of Object.entries(args.flags)) {
    if (key === 'input' || key === 'json' || key === 'cwd' || key === 'timeout') continue;
    if (value === true) input[key] = true;
    else if (value === false) input[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) input[key] = Number(value);
    else if (value === 'false') input[key] = false;
    else input[key] = value;
  }

  let stdin: string | undefined;
  if (typeof args.flags.stdin === 'string') stdin = args.flags.stdin;
  else if (args.flags.stdin === true) stdin = readFileSync(0, 'utf8');

  const { runOperation } = await import('./core/operations/runner.js');
  const result = await runOperation(opId, {
    input,
    stdin,
    cwd: typeof args.flags.cwd === 'string' ? args.flags.cwd : undefined,
    timeoutMs: typeof args.flags.timeout === 'string' ? Number(args.flags.timeout) : undefined,
  });

  if (args.flags.json === true) {
    printJson({ ok: result.ok, implementation: result.impl, builtin: result.builtin, output: result.output, stdout: result.result.stdout, stderr: result.result.stderr, exitCode: result.result.exitCode, error: result.error });
  } else {
    const output = result.output;
    if (typeof output === 'string') out(output);
    else if (output !== undefined) printJson(output);
    else if (result.result.stdout) out(result.result.stdout.replace(/\n$/, ''));
    if (!result.ok) {
      if (result.result.stderr) process.stderr.write(result.result.stderr);
      out(c.red(`\n[exit ${result.result.exitCode ?? '-'}] ${result.error ?? 'failed'}`));
    }
  }

  if (!result.ok) process.exitCode = 1;
}

async function cmdChain(args: ParsedArgs): Promise<void> {
  let spec: ReturnType<typeof parseShorthand> | null = null;

  if (typeof args.flags.file === 'string') {
    const raw = readFileSync(args.flags.file, 'utf8');
    spec = JSON.parse(raw) as never;
  } else if (typeof args.flags.steps === 'string') {
    spec = JSON.parse(args.flags.steps) as never;
  } else if (args.positionals.length > 0) {
    spec = parseShorthand(args.positionals.join(' '));
  }

  if (!spec || spec.steps.length === 0) {
    out(c.red('usage: bridge chain <"op key=value | op key=value"> | --file chain.json | --steps \'[...]\''));
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const policy = new Policy(config.policy);
  const result = await runChain(spec, { policy });

  if (args.flags.json === true) {
    printJson(result);
  } else {
    for (const step of result.steps) {
      const mark = step.ok ? c.green('✓') : c.red('✗');
      out(`${mark} ${c.bold(step.id)} ${c.dim(step.op ?? step.tool ?? '')} ${c.dim(`${step.durationMs}ms`)}`);
      if (step.stdout) out(step.stdout.replace(/\n$/, '').split('\n').map((line) => `  ${line}`).join('\n'));
      if (!step.ok && step.stderr) out(c.red(`  ${step.stderr.trim()}`));
    }
  }

  if (!result.ok) process.exitCode = 1;
}

async function cmdOps(args: ParsedArgs): Promise<void> {
  const ops = listOperations();

  if (args.flags.json === true) {
    printJson(ops.map((op) => ({ ...op, backends: operationBackends(op) })));
    return;
  }

  for (const op of ops) {
    const backends = operationBackends(op);
    const available = backends.filter((backend) => backend.available).map((backend) => backend.tool);
    out(`${c.bold(op.id.padEnd(18))} ${c.dim(op.description.slice(0, 70).padEnd(72))} ${c.cyan(available.join(', ') || 'none')}`);
  }
  out('');
  out(c.dim(`${ops.length} operations`));
}

async function cmdServe(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const port = typeof args.flags.port === 'string' ? Number(args.flags.port) : config.server.port;
  const host = typeof args.flags.host === 'string' ? args.flags.host : config.server.host;

  const server = await startServer({ config, host, port });
  out(c.green(`cli-bridge hub listening on http://${server.address.host}:${server.address.port}`));
  out(c.dim(`tools: ${registry.list({ includeSystem: true }).length} | operations: ${listOperations().length}`));
  out(c.dim('press ctrl+c to stop'));

  const shutdown = async (): Promise<void> => {
    out('');
    out(c.dim('shutting down...'));
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdMcp(): Promise<void> {
  await runMcpServer();
}

async function cmdInstall(args: ParsedArgs): Promise<void> {
  const id = args.positionals[0];
  if (!id) {
    out(c.red('usage: bridge install <tool>'));
    process.exitCode = 1;
    return;
  }

  const tool = registry.get(id);
  if (!tool) {
    const candidates = findInstallable(id);
    if (candidates.length > 0) {
      out(c.yellow(`"${id}" is not installed. Did you mean:`));
      for (const candidate of candidates.slice(0, 8)) {
        out(`  ${c.bold(candidate.id.padEnd(16))} ${candidate.description}`);
      }
    } else {
      out(c.red(`unknown tool "${id}"`));
    }
    process.exitCode = 1;
    return;
  }

  const plan = planInstall(tool);
  if (!plan) {
    out(c.red(`no install recipe for "${id}". ${tool.install?.manual ?? ''}`));
    process.exitCode = 1;
    return;
  }

  out(c.dim(`$ ${plan.label}`));
  const result = await installTool(tool);
  if (result.output) out(result.output);

  if (result.ok) {
    registry.refresh({ includeSystem: loadConfig().discovery.includeSystem });
    out(c.green(`✓ ${id} installed`));
  } else {
    out(c.red(`✗ install failed: ${result.error ?? 'unknown error'}`));
    process.exitCode = 1;
  }
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  const managers = detectManagers();
  const tools = registry.list({ includeSystem: true });
  const installed = tools.filter((tool) => registry.isInstalled(tool));

  out(c.bold('cli-bridge doctor'));
  out('');
  out(`${c.dim('node:')}        ${process.version}`);
  out(`${c.dim('platform:')}    ${process.platform} ${process.arch}`);
  out(`${c.dim('bridge home:')} ${bridgeHome()}`);
  out(`${c.dim('tools:')}       ${installed.length} installed of ${tools.length} known`);
  out(`${c.dim('operations:')}  ${listOperations().length}`);
  out(`${c.dim('managers:')}    ${managers.join(', ') || 'none found'}`);
  out(`${c.dim('policy:')}      mode=${config.policy.mode} shell=${config.policy.allowShell ? 'on' : 'off'} dangerous=${config.policy.blockDangerous ? 'blocked' : 'allowed'}`);
  out(`${c.dim('server:')}      http://${config.server.host}:${config.server.port}`);

  const categories = new Map<string, number>();
  for (const tool of installed) {
    categories.set(tool.category, (categories.get(tool.category) ?? 0) + 1);
  }
  if (categories.size > 0) {
    out('');
    out(c.bold('installed by category'));
    for (const [category, count] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
      out(`  ${category.padEnd(14)} ${count}`);
    }
  }
}

async function cmdRescan(): Promise<void> {
  registry.refresh({ includeSystem: loadConfig().discovery.includeSystem });
  const tools = registry.list({ includeSystem: true });
  out(c.green(`✓ registry refreshed: ${tools.length} tools`));
}

async function cmdPolicy(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? 'show';
  const pattern = args.positionals[1];
  const config = loadConfig();

  if (action === 'show') {
    printJson(config.policy);
    return;
  }

  if (!pattern) {
    out(c.red('usage: bridge policy <allow|deny> <tool>'));
    process.exitCode = 1;
    return;
  }

  if (action === 'allow') {
    if (!config.policy.allowed.includes(pattern)) config.policy.allowed.push(pattern);
    if (config.policy.mode !== 'allowlist') config.policy.mode = 'allowlist';
    updateConfig({ policy: config.policy });
    out(c.green(`✓ "${pattern}" is now allowed (mode: allowlist)`));
    return;
  }

  if (action === 'deny') {
    if (!config.policy.denied.includes(pattern)) config.policy.denied.push(pattern);
    updateConfig({ policy: config.policy });
    out(c.green(`✓ "${pattern}" is now denied`));
    return;
  }

  out(c.red(`unknown policy action "${action}"`));
  process.exitCode = 1;
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const mcpEntry = resolve(here, 'mcp', 'main.js');
  const mcpCommand = `node "${mcpEntry}"`;

  out(c.bold('Connect an AI CLI agent to the bridge'));
  out('');
  out(c.bold('opencode') + c.dim('  (recommended, V2 config)'));
  out(`  opencode mcp add cli-bridge --global -- node "${mcpEntry}"`);
  out(JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { 'cli-bridge': { type: 'local', command: ['node', mcpEntry] } } } }, null, 2));
  out(c.bold('Claude Code'));
  out(`  claude mcp add cli-bridge -- ${mcpCommand}`);
  out(c.bold('Claude Desktop') + c.dim('  (claude_desktop_config.json)'));
  out(JSON.stringify({ mcpServers: { 'cli-bridge': { command: 'node', args: [mcpEntry] } } }, null, 2));
  out(c.bold('Cursor') + c.dim('  (.cursor/mcp.json)'));
  out(JSON.stringify({ mcpServers: { 'cli-bridge': { command: 'node', args: [mcpEntry] } } }, null, 2));
  out(c.bold('Gemini CLI') + c.dim('  (~/.gemini/settings.json)'));
  out(JSON.stringify({ mcpServers: { 'cli-bridge': { command: 'node', args: [mcpEntry] } } }, null, 2));
  out(c.bold('Codex CLI') + c.dim('  (~/.codex/config.toml)'));
  out(`  [mcp_servers.cli-bridge]`);
  out(`  command = "node"`);
  out(`  args = ["${mcpEntry.replace(/\\/g, '\\\\')}"]`);
  out('');
  out(c.dim('Run "bridge serve" to expose the same tools over HTTP.'));
}

async function cmdCompletions(args: ParsedArgs): Promise<void> {
  const shell = args.positionals[0] ?? 'bash';
  const commands = 'list search describe call op ops chain serve mcp install doctor rescan policy init completions';

  if (shell === 'powershell' || shell === 'pwsh') {
    out(`Register-ArgumentCompleter -Native -CommandName bridge -ScriptBlock { param($wordToComplete) @('${commands.split(' ').join("','")}') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }`);
    return;
  }
  if (shell === 'zsh') {
    out(`#compdef bridge\n_arguments '1:command:(${commands})' '*::arg:->args'`);
    return;
  }
  out(`_bridge() {\n  local commands="${commands}"\n  COMPREPLY=($(compgen -W "$commands" -- "\${COMP_WORDS[1]}"))\n}\ncomplete -F _bridge bridge`);
}

function cmdVersion(): void {
  out('cli-bridge 0.1.0');
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

const HELP = `
${c.bold('cli-bridge')} - connect every CLI tool on this machine to every other CLI tool

${c.bold('usage')}  bridge <command> [options]

${c.bold('discover')}
  list                 list every tool the bridge knows
  search <query>       find tools by name, capability or description
  describe <tool>      show details, version and install recipe
  ops                  list the chainable operations
  doctor               environment report
  rescan               re-scan PATH

${c.bold('run')}
  call <tool> [args]   run a CLI tool (no shell, policy checked)
  op <operation>       run a semantic operation
  chain "<a | b>"      chain operations, feeding output to the next step

${c.bold('connect')}
  serve                start the local HTTP hub
  mcp                  start the MCP server (stdio) for AI agents
  init                 print MCP client configuration snippets

${c.bold('manage')}
  install <tool>       install a missing tool
  policy <allow|deny>  manage the tool allow/deny lists
  completions <shell>  shell completions

${c.bold('examples')}
  bridge list
  bridge call git log --oneline -10
  bridge op http.request --url https://api.github.com
  bridge chain "http.request url=https://api.github.com/repos/opencode/opencode | json.query filter=.stargazers_count"
  bridge install jq
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const args = parseArgs(argv.slice(1));

  if (command === 'help' || args.flags.help === true || command === '--help' || command === '-h') {
    out(HELP);
    return;
  }

  if (command === 'version' || command === '--version') {
    cmdVersion();
    return;
  }

  const config = loadConfig();
  if (command !== 'init' && command !== 'completions' && command !== 'version') {
    await registry.load({ includeSystem: config.discovery.includeSystem });
  }

  switch (command) {
    case 'list':
      return cmdList(args);
    case 'search':
      return cmdSearch(args);
    case 'describe':
      return cmdDescribe(args);
    case 'call':
      return cmdCall(argv.slice(1));
    case 'op':
      return cmdOp(args);
    case 'ops':
      return cmdOps(args);
    case 'chain':
    case 'pipe':
      return cmdChain(args);
    case 'serve':
      return cmdServe(args);
    case 'mcp':
      return cmdMcp();
    case 'install':
      return cmdInstall(args);
    case 'doctor':
      return cmdDoctor();
    case 'rescan':
      return cmdRescan();
    case 'policy':
      return cmdPolicy(args);
    case 'init':
      return cmdInit(args);
    case 'completions':
      return cmdCompletions(args);
    default:
      out(c.red(`unknown command "${command}"`));
      out(c.dim('run "bridge help" to see the available commands'));
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(c.red(`error: ${error instanceof Error ? error.message : String(error)}\n`));
  process.exitCode = 1;
});
