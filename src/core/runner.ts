import { registry } from './registry.js';
import { run } from './exec.js';
import { Policy } from './policy.js';
import type { ExecOptions, ExecResult, ToolDescriptor } from './types.js';

export interface CallToolOptions extends ExecOptions {
  /** Tool id or binary name. */
  tool: string;
}

export interface CallToolResult extends ExecResult {
  descriptor?: ToolDescriptor;
}

function denied(tool: string, reason: string, options: CallToolOptions): CallToolResult {
  return {
    ok: false,
    tool,
    bin: tool,
    argv: options.args ?? [],
    cwd: options.cwd ?? process.cwd(),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: reason,
    durationMs: 0,
    truncated: false,
    timedOut: false,
    error: reason,
  };
}

/**
 * Call a tool by id.
 * The tool is resolved from the registry, checked against the policy and then
 * executed without a shell.
 */
export async function callTool(options: CallToolOptions, policy?: Policy): Promise<CallToolResult> {
  const descriptor = registry.get(options.tool);
  if (!descriptor) {
    return denied(options.tool, `unknown tool "${options.tool}" (run "bridge list" to see what is available)`, options);
  }

  if (policy) {
    const toolDecision = policy.checkTool(descriptor);
    if (!toolDecision.allowed) return denied(descriptor.id, toolDecision.reason ?? 'blocked by policy', options);

    const args = [...(descriptor.defaultArgs ?? []), ...(options.args ?? [])];
    const argsDecision = policy.checkArgs(args);
    if (!argsDecision.allowed) return denied(descriptor.id, argsDecision.reason ?? 'blocked by policy', options);

    const shellDecision = policy.checkShell(Boolean(options.shell));
    if (!shellDecision.allowed) return denied(descriptor.id, shellDecision.reason ?? 'blocked by policy', options);
  }

  const args = [...(descriptor.defaultArgs ?? []), ...(options.args ?? [])];

  const result = await run({
    tool: descriptor.id,
    bin: descriptor.bin,
    path: descriptor.path,
    args,
    stdin: options.stdin,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    shell: options.shell,
    signal: options.signal,
  });

  const scrubbed = policy ? { ...result, stdout: policy.scrub(result.stdout), stderr: policy.scrub(result.stderr) } : result;
  return { ...scrubbed, descriptor };
}
