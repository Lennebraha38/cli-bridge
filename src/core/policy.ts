import type { PolicyConfig, ToolDescriptor } from './types.js';
import { redactSecrets } from './util.js';

export const DEFAULT_POLICY: PolicyConfig = {
  mode: 'denylist',
  allowed: [],
  denied: [],
  allowShell: false,
  blockDangerous: true,
};

/**
 * Command fragments that can destroy a machine. They are rejected before a
 * process is spawned, even when the tool itself is allowed.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(\/|\/\*|~|~\/\*|\$HOME)/i, reason: 'recursive delete of a root/home path' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, reason: 'recursive delete of /' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'formats a drive' },
  { pattern: /\bdel\s+.*\/[fsq]\b/i, reason: 'forced recursive delete' },
  { pattern: /\bRemove-Item\b.*-Recurse.*-Force.*([a-z]:\\?\s*$|"\s*$)/i, reason: 'forced recursive delete of a drive root' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\s/i, reason: 'creates a filesystem' },
  { pattern: /\bdd\s+[^\n]*of=\/dev\/(sd|nvme|disk)/i, reason: 'raw write to a block device' },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/i, reason: 'shuts the machine down' },
  { pattern: /\bvssadmin\s+delete\s+shadows/i, reason: 'deletes shadow copies' },
  { pattern: /\bdiskpart\b/i, reason: 'repartitions disks' },
  { pattern: /\bcipher\s+\/w/i, reason: 'wipes free space' },
  { pattern: /:\(\)\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
];

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export class Policy {
  constructor(private config: PolicyConfig = DEFAULT_POLICY) {}

  update(config: Partial<PolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get current(): PolicyConfig {
    return this.config;
  }

  /** Check a tool id / binary name against the allow/deny lists. */
  checkTool(tool: Pick<ToolDescriptor, 'id' | 'bin'>): PolicyDecision {
    const name = tool.id.toLowerCase();
    const bin = tool.bin.toLowerCase();

    for (const denied of this.config.denied) {
      const d = denied.toLowerCase();
      if (name === d || bin === d || name.startsWith(d + ':')) {
        return { allowed: false, reason: `tool "${tool.id}" is on the deny list` };
      }
    }

    if (this.config.mode === 'allowlist') {
      const hit = this.config.allowed.some((a) => {
        const al = a.toLowerCase();
        return al === name || al === bin || name.startsWith(al + ':');
      });
      if (!hit) {
        return { allowed: false, reason: `tool "${tool.id}" is not in the allow list` };
      }
    }

    return { allowed: true };
  }

  /** Inspect the argv of a call for destructive commands. */
  checkArgs(args: string[]): PolicyDecision {
    if (!this.config.blockDangerous) return { allowed: true };
    const joined = args.join(' ');
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(joined)) {
        return { allowed: false, reason: `blocked dangerous command: ${reason}` };
      }
    }
    return { allowed: true };
  }

  checkShell(requested: boolean): PolicyDecision {
    if (requested && !this.config.allowShell) {
      return { allowed: false, reason: 'shell mode is disabled by policy' };
    }
    return { allowed: true };
  }

  /** Apply redaction to output when enabled. */
  scrub(text: string): string {
    return redactSecrets(text);
  }
}
