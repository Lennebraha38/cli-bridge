import { runOperation } from './operations/runner.js';
import { callTool } from './runner.js';
import type { Policy } from './policy.js';
import type {
  ChainResult,
  ChainSpec,
  ChainStep,
  ChainStepResult,
  OpInputValues,
} from './types.js';

export interface ChainScope {
  steps: Record<string, ChainStepResult>;
  input: OpInputValues;
  env: Record<string, string | undefined>;
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Walk into a value with a list of path parts. */
function traverse(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

/** Resolve a dotted reference such as `steps.fetch.json` or `input.query`. */
export function resolveReference(reference: string, scope: ChainScope): unknown {
  const parts = reference.split('.');
  const head = parts[0];

  if (head === 'steps') {
    const id = parts[1];
    if (!id) return undefined;
    const step = scope.steps[id];
    if (!step) return undefined;
    const field = parts[2] ?? 'stdout';
    switch (field) {
      case 'json': {
        const value = step.json;
        const rest = parts.slice(3);
        return rest.length ? traverse(value, rest) : value;
      }
      case 'stdout':
        return traverse(step.stdout, parts.slice(3));
      case 'stderr':
        return traverse(step.stderr, parts.slice(3));
      case 'exitCode':
        return step.exitCode;
      case 'durationMs':
        return step.durationMs;
      case 'ok':
        return step.ok;
      case 'error':
        return step.error;
      default:
        return undefined;
    }
  }

  if (head === 'input') {
    const key = parts.slice(1).join('.');
    return key ? scope.input[key] : scope.input;
  }

  if (head === 'env') {
    const key = parts.slice(1).join('.');
    return scope.env[key];
  }

  return undefined;
}

/**
 * Interpolate `{{...}}` placeholders inside an arbitrary value.
 * When the whole string is a single placeholder the original type is kept.
 */
export function interpolate<T>(value: T, scope: ChainScope): T {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const single = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
    if (single?.[1]) {
      const resolved = resolveReference(single[1].trim(), scope);
      return (resolved === undefined ? value : resolved) as T;
    }

    return value.replace(PLACEHOLDER, (match, reference: string) => {
      const resolved = resolveReference(reference.trim(), scope);
      if (resolved === undefined) return match;
      if (typeof resolved === 'string') return resolved;
      if (typeof resolved === 'number' || typeof resolved === 'boolean') return String(resolved);
      return JSON.stringify(resolved);
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, scope)) as T;
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(item, scope);
    }
    return out as T;
  }

  return value;
}

function stepId(step: ChainStep, index: number): string {
  return step.id ?? `step${index + 1}`;
}

/**
 * Run a chain of operations and/or tool calls.
 *
 * Each step can consume the output of the previous one:
 *   {{steps.fetch.json}}   parsed JSON of a previous step
 *   {{steps.fetch.stdout}} raw output of a previous step
 */
export async function runChain(spec: ChainSpec, options: { policy?: Policy } = {}): Promise<ChainResult> {
  const started = Date.now();
  const scope: ChainScope = {
    steps: {},
    input: spec.input ?? {},
    env: { ...process.env, ...(spec.env ?? {}) },
  };

  const results: ChainStepResult[] = [];
  const stopOnError = spec.stopOnError ?? true;
  let previousStdout = '';

  for (let index = 0; index < spec.steps.length; index++) {
    const step = spec.steps[index]!;
    const id = stepId(step, index);

    const resolvedStep = interpolate(step, scope);
    const withValues: OpInputValues = (resolvedStep.with as OpInputValues) ?? {};

    let stdin = resolvedStep.stdin;
    if (stdin === undefined && resolvedStep.pipe !== false && previousStdout) {
      stdin = previousStdout;
    }

    let result: ChainStepResult;

    if (resolvedStep.op) {
      const opResult = await runOperation(resolvedStep.op, {
        input: withValues,
        cwd: resolvedStep.cwd ?? spec.cwd,
        stdin,
        env: spec.env,
        timeoutMs: resolvedStep.timeoutMs,
      });
      result = {
        id,
        op: resolvedStep.op,
        ok: opResult.ok,
        exitCode: opResult.result.exitCode,
        stdout: opResult.result.stdout,
        stderr: opResult.result.stderr,
        json: opResult.output,
        durationMs: opResult.result.durationMs,
        error: opResult.error,
      };
    } else if (resolvedStep.tool) {
      const toolResult = await callTool(
        {
          tool: resolvedStep.tool,
          args: resolvedStep.args,
          stdin,
          cwd: resolvedStep.cwd ?? spec.cwd,
          env: spec.env,
          timeoutMs: resolvedStep.timeoutMs,
        },
        options.policy,
      );
      result = {
        id,
        tool: resolvedStep.tool,
        ok: toolResult.ok,
        exitCode: toolResult.exitCode,
        stdout: toolResult.stdout,
        stderr: toolResult.stderr,
        json: toolResult.json,
        durationMs: toolResult.durationMs,
        error: toolResult.error,
      };
    } else {
      result = {
        id,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: 'step needs either "op" or "tool"',
        durationMs: 0,
        error: 'step needs either "op" or "tool"',
      };
    }

    results.push(result);
    scope.steps[id] = result;
    previousStdout = result.stdout;

    if (!result.ok && stopOnError && !resolvedStep.continueOnError) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        steps: results,
        error: `step "${id}" failed: ${result.error ?? result.stderr.trim() ?? 'unknown error'}`,
      };
    }
  }

  return { ok: results.every((step) => step.ok), durationMs: Date.now() - started, steps: results };
}

/** Parse a compact pipeline description like "http.request url=... | json.query filter=...". */
export function parseShorthand(source: string): ChainSpec {
  const steps: ChainStep[] = [];

  for (const chunk of source.split('|')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const op = parts.shift() ?? '';
    const withValues: OpInputValues = {};

    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx);
      let value: string = part.slice(idx + 1);
      if (/^-?\d+(\.\d+)?$/.test(value)) value = String(Number(value));
      else if (value === 'true' || value === 'false') value = String(value === 'true');
      withValues[key] = value;
    }

    steps.push({ op, with: withValues });
  }

  return { steps };
}
