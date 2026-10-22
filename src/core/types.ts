/**
 * Core type definitions shared by the whole bridge.
 *
 * The bridge models the world in three layers:
 *   Tool      -> a concrete binary that lives on this machine (git, jq, ffmpeg, ...)
 *   Operation -> a semantic, chainable action (http.request, json.query, ...)
 *   Chain     -> a pipeline that wires operations together
 */

/** Semantic capabilities a tool can provide. Used for discovery and routing. */
export const CAPABILITIES = [
  'http.request',
  'json.transform',
  'yaml.transform',
  'csv.transform',
  'text.process',
  'text.search',
  'vcs.operate',
  'issue.track',
  'ci.build',
  'container.manage',
  'k8s.manage',
  'cloud.manage',
  'infra.manage',
  'db.query',
  'file.read',
  'file.write',
  'file.search',
  'file.convert',
  'image.process',
  'media.transcode',
  'doc.render',
  'doc.extract',
  'ocr.read',
  'archive.manage',
  'code.run',
  'code.lint',
  'code.format',
  'test.run',
  'remote.exec',
  'remote.sync',
  'process.inspect',
  'net.inspect',
  'dns.lookup',
  'secret.manage',
  'crypto.sign',
  'data.analysis',
  'plot.render',
  'package.manage',
  'sys.admin',
  'monitoring.query',
  'llm.chat',
  'image.generate',
  'web.search',
  'browser.fetch',
  'note.write',
  'note.query',
  'spreadsheet.manage',
  'cli.exec',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ToolSource = 'catalog' | 'path' | 'user' | 'builtin';

/** How a missing tool can be installed on the current platform. */
export interface InstallSpec {
  winget?: string;
  scoop?: string;
  choco?: string;
  brew?: string;
  apt?: string;
  dnf?: string;
  npm?: string;
  pip?: string;
  pipx?: string;
  gem?: string;
  cargo?: string;
  go?: string;
  /** Direct download url, optionally with a {version} placeholder. */
  url?: string;
  /** Human readable fallback instructions. */
  manual?: string;
}

export interface ToolIo {
  stdin?: 'none' | 'text' | 'json';
  output?: 'text' | 'json' | 'mixed';
}

export interface ToolDescriptor {
  /** Canonical, stable id (e.g. "jq"). */
  id: string;
  /** Executable name looked up on PATH. */
  bin: string;
  title: string;
  description: string;
  category: string;
  capabilities: Capability[];
  source: ToolSource;
  /** Absolute path of the resolved binary (when discovered). */
  path?: string;
  /** Resolved version string, when it could be probed cheaply. */
  version?: string;
  /** Arguments always appended to every call. */
  defaultArgs?: string[];
  io?: ToolIo;
  install?: InstallSpec;
  examples?: string[];
  tags?: string[];
  /** Tools that can destroy data; the bridge refuses them unless allowed. */
  dangerous?: boolean;
  /** Where the binary was found: user-writable paths are shown by default. */
  scope?: 'user' | 'system';
  /** Free-form notes shown by `bridge describe`. */
  notes?: string;
}

export interface ExecOptions {
  args?: string[];
  stdin?: string;
  cwd?: string;
  /** Extra environment variables merged on top of the inherited environment. */
  env?: Record<string, string>;
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Max bytes captured per stream before truncation. */
  maxBuffer?: number;
  /** Enable shell interpretation. Off by default and blocked by policy. */
  shell?: boolean;
  signal?: AbortSignal;
}

export interface ExecResult {
  ok: boolean;
  tool: string;
  bin: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  /** Parsed stdout when it is valid JSON. */
  json?: unknown;
  /** Extra structured data (http status, headers, file path, ...). */
  meta?: Record<string, unknown>;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export type OpInputType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface OpInput {
  name: string;
  type: OpInputType;
  required?: boolean;
  description: string;
  default?: unknown;
  example?: unknown;
}

export interface OpOutput {
  name: string;
  type: OpInputType | 'file';
  description: string;
}

export interface OpInputValues {
  [key: string]: unknown;
}

export interface BuiltCall {
  args: string[];
  stdin?: string;
  cwd?: string;
}

/** Context handed to an implementation while it builds its call. */
export interface OpContext {
  /** Resolve the absolute path of a tool, if available. */
  resolve(toolId: string): string | undefined;
  /** Working directory for the chain/call. */
  cwd: string;
  /** Default timeout. */
  timeoutMs: number;
}

export interface OpImpl {
  /** Tool id used by this implementation, or "__builtin__" for pure-node ones. */
  tool: string;
  /** Build argv (+ optional stdin) from the operation input. */
  build(input: OpInputValues, ctx: OpContext): BuiltCall;
  /** Convert the raw execution result into a structured output. */
  parse?(result: ExecResult, input: OpInputValues): unknown;
  /**
   * Run the implementation without spawning an external tool.
   * Used by the pure-node fallbacks so operations keep working on a bare machine.
   */
  run?(input: OpInputValues, ctx: OpContext): Promise<ExecResult>;
  /** Higher wins when several implementations are available. */
  prefer?: number;
}

export interface OperationSpec {
  id: string;
  title: string;
  description: string;
  capability: Capability;
  inputs: OpInput[];
  outputs: OpOutput[];
  /** Concrete implementations, most preferred first. */
  impls: OpImpl[];
  /** Pure-node fallback used when no external tool is installed. */
  builtin?: OpImpl;
}

/* ------------------------------------------------------------------ */
/* Chains                                                              */
/* ------------------------------------------------------------------ */

export interface ChainStep {
  /** Step id used for interpolation. Auto-generated when omitted. */
  id?: string;
  /** Operation id to run. Mutually exclusive with `tool`. */
  op?: string;
  /** Direct tool call (raw argv) instead of a semantic operation. */
  tool?: string;
  args?: string[];
  stdin?: string;
  cwd?: string;
  /** Operation input values. */
  with?: OpInputValues;
  /** Feed the previous step's stdout into this step's stdin. Default: true. */
  pipe?: boolean;
  timeoutMs?: number;
  /** Keep going when this step fails. Default: false. */
  continueOnError?: boolean;
}

export interface ChainSpec {
  steps: ChainStep[];
  /** Values available as {{input.key}} inside the chain. */
  input?: OpInputValues;
  cwd?: string;
  env?: Record<string, string>;
  /** Stop at the first failing step. Default: true. */
  stopOnError?: boolean;
}

export interface ChainStepResult {
  id: string;
  op?: string;
  tool?: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
  durationMs: number;
  error?: string;
}

export interface ChainResult {
  ok: boolean;
  durationMs: number;
  steps: ChainStepResult[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Policy / configuration                                              */
/* ------------------------------------------------------------------ */

export interface PolicyConfig {
  /** "allowlist" only runs tools that were explicitly allowed. */
  mode: 'allowlist' | 'denylist';
  allowed: string[];
  denied: string[];
  /** Allow `shell: true` calls. */
  allowShell: boolean;
  /** Refuse commands matching destructive patterns. */
  blockDangerous: boolean;
}

export interface BridgeConfig {
  server: { host: string; port: number; token?: string };
  exec: { timeoutMs: number; maxBuffer: number };
  policy: PolicyConfig;
  /** Redact secrets from captured output. */
  redact: boolean;
  /** Expose each discovered CLI tool as its own MCP tool. */
  mcp: { exposeTools: boolean; maxTools: number };
  discovery: { includeSystem: boolean; scanTimeoutMs: number };
}
