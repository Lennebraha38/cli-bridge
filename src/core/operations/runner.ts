import { registry } from '../registry.js';
import { run } from '../exec.js';
import type { ExecResult, OpContext, OpInputValues, OperationSpec } from '../types.js';
import { OPERATION_BY_ID } from './index.js';

export interface RunOpOptions {
  input?: OpInputValues;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export interface RunOpResult {
  op: string;
  /** Tool that actually executed the work. */
  impl: string;
  builtin: boolean;
  ok: boolean;
  result: ExecResult;
  /** Structured output produced by the implementation parser. */
  output: unknown;
  error?: string;
}

function contextFor(options: RunOpOptions): OpContext {
  return {
    resolve: (toolId: string) => {
      const tool = registry.get(toolId);
      return tool?.path;
    },
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 60_000,
  };
}

/** Pick the best available implementation for an operation. */
export function selectImplementation(
  spec: OperationSpec,
): { impl: NonNullable<OperationSpec['impls']>[number]; builtin: boolean } | undefined {
  let best: { impl: NonNullable<OperationSpec['impls']>[number]; builtin: boolean; prefer: number } | undefined;

  for (const impl of spec.impls) {
    const tool = registry.get(impl.tool);
    if (!tool || !registry.isInstalled(tool)) continue;
    const prefer = impl.prefer ?? 50;
    if (!best || prefer > best.prefer) best = { impl, builtin: false, prefer };
  }
  if (best) return { impl: best.impl, builtin: false };
  if (spec.builtin) return { impl: spec.builtin, builtin: true };
  return undefined;
}

/** Describe which tools can serve an operation right now. */
export function operationBackends(spec: OperationSpec): Array<{ tool: string; available: boolean; prefer: number }> {
  const entries = spec.impls.map((impl) => {
    const tool = registry.get(impl.tool);
    return { tool: impl.tool, available: Boolean(tool && registry.isInstalled(tool)), prefer: impl.prefer ?? 50 };
  });
  if (spec.builtin) entries.push({ tool: '__builtin__', available: true, prefer: spec.builtin.prefer ?? 10 });
  return entries;
}

/**
 * Execute a semantic operation.
 * Operations pick the best tool available on the machine and fall back to a
 * pure-node implementation when no external tool exists.
 */
export async function runOperation(opId: string, options: RunOpOptions = {}): Promise<RunOpResult> {
  const spec = OPERATION_BY_ID.get(opId);
  if (!spec) {
    const error = `unknown operation "${opId}"`;
    return {
      op: opId,
      impl: '',
      builtin: false,
      ok: false,
      output: undefined,
      error,
      result: {
        ok: false,
        tool: opId,
        bin: opId,
        argv: [],
        cwd: options.cwd ?? process.cwd(),
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
        timedOut: false,
        error,
      },
    };
  }

  const selection = selectImplementation(spec);
  if (!selection) {
    const needed = spec.impls.map((impl) => impl.tool).join(', ');
    const error = `no implementation available for "${opId}" (needs one of: ${needed})`;
    return {
      op: opId,
      impl: '',
      builtin: false,
      ok: false,
      output: undefined,
      error,
      result: {
        ok: false,
        tool: opId,
        bin: opId,
        argv: [],
        cwd: options.cwd ?? process.cwd(),
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
        timedOut: false,
        error,
      },
    };
  }

  const ctx = contextFor(options);
  const input = options.input ?? {};

  // Built-in implementations do everything in-process.
  if (selection.builtin && selection.impl.run) {
    const result = await selection.impl.run(input, { ...ctx, stdin: options.stdin } as OpContext & { stdin?: string });
    const output = selection.impl.parse ? selection.impl.parse(result, input) : (result.json ?? result.stdout);
    return { op: opId, impl: '__builtin__', builtin: true, ok: result.ok, result, output };
  }

  const built = selection.impl.build(input, ctx);
  const tool = registry.get(selection.impl.tool);
  const result = await run({
    tool: selection.impl.tool,
    bin: tool?.bin ?? selection.impl.tool,
    path: tool?.path,
    args: built.args,
    stdin: built.stdin ?? options.stdin,
    cwd: built.cwd ?? options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  let output: unknown = result.json ?? result.stdout;
  if (selection.impl.parse) {
    try {
      output = selection.impl.parse(result, input);
    } catch {
      output = result.stdout;
    }
  }

  return {
    op: opId,
    impl: selection.impl.tool,
    builtin: false,
    ok: result.ok,
    result,
    output,
  };
}
