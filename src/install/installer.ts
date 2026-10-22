import { resolveBin, run } from '../core/exec.js';
import { CATALOG_BY_ID } from '../core/catalog.js';
import { isWindows } from '../core/util.js';
import type { InstallSpec, ToolDescriptor } from '../core/types.js';

export type Manager = 'winget' | 'scoop' | 'choco' | 'brew' | 'apt' | 'dnf' | 'npm' | 'pip' | 'pipx' | 'gem' | 'cargo' | 'go';

export interface InstallPlan {
  manager: Manager;
  command: string;
  args: string[];
  /** Human readable description. */
  label: string;
}

/** Package managers available on this machine. */
export function detectManagers(): Manager[] {
  const candidates: Manager[] = isWindows()
    ? ['winget', 'scoop', 'choco', 'npm', 'pip', 'pipx', 'cargo', 'go']
    : ['brew', 'apt', 'dnf', 'npm', 'pip', 'pipx', 'cargo', 'go'];

  const available: Manager[] = [];
  for (const manager of candidates) {
    const bin = manager === 'pip' ? 'pip' : manager === 'pipx' ? 'pipx' : manager;
    if (resolveBin(bin)) available.push(manager);
  }
  return available;
}

function plan(manager: Manager, args: string[], label: string): InstallPlan {
  const command = manager === 'pip' ? 'python' : manager;
  const finalArgs = manager === 'pip' ? ['-m', 'pip', ...args] : args;
  return { manager, command, args: finalArgs, label };
}

/** Build an install plan for a tool. */
export function planInstall(tool: ToolDescriptor, available: Manager[] = detectManagers()): InstallPlan | undefined {
  const spec = tool.install as InstallSpec | undefined;
  if (!spec) return undefined;

  const order: Manager[] = isWindows()
    ? ['winget', 'scoop', 'choco', 'npm', 'pipx', 'pip', 'cargo', 'go']
    : ['brew', 'apt', 'dnf', 'npm', 'pipx', 'pip', 'gem', 'cargo', 'go'];

  for (const manager of order) {
    if (!available.includes(manager)) continue;
    const value = (spec as Record<string, string | undefined>)[manager];
    if (!value) continue;

    switch (manager) {
      case 'winget':
        return plan('winget', ['install', '--id', value, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], `winget install ${value}`);
      case 'scoop':
        return plan('scoop', ['install', value], `scoop install ${value}`);
      case 'choco':
        return plan('choco', ['install', value, '-y'], `choco install ${value}`);
      case 'brew':
        return plan('brew', ['install', value], `brew install ${value}`);
      case 'apt':
        return plan('apt', ['install', '-y', value], `apt install ${value}`);
      case 'dnf':
        return plan('dnf', ['install', '-y', value], `dnf install ${value}`);
      case 'npm':
        return plan('npm', ['install', '-g', value], `npm install -g ${value}`);
      case 'pip':
        return plan('pip', ['install', '--user', value], `pip install --user ${value}`);
      case 'pipx':
        return plan('pipx', ['install', value], `pipx install ${value}`);
      case 'gem':
        return plan('gem', ['install', value], `gem install ${value}`);
      case 'cargo':
        return plan('cargo', ['install', value], `cargo install ${value}`);
      case 'go':
        return plan('go', ['install', value], `go install ${value}`);
      default:
        break;
    }
  }

  return undefined;
}

export interface InstallResult {
  ok: boolean;
  plan?: InstallPlan;
  output: string;
  error?: string;
}

/** Install a tool using the best available package manager. */
export async function installTool(
  tool: ToolDescriptor,
  options: { yes?: boolean } = {},
): Promise<InstallResult> {
  const managers = detectManagers();
  const chosen = planInstall(tool, managers);

  if (!chosen) {
    const manual = tool.install?.manual ?? 'no install recipe is known for this tool';
    return { ok: false, output: manual, error: manual };
  }

  const result = await run({
    tool: 'install',
    bin: chosen.command,
    args: chosen.args,
    timeoutMs: 10 * 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (!result.ok && !options.yes) {
    return { ok: false, plan: chosen, output, error: `install failed (exit ${result.exitCode})` };
  }

  return { ok: result.ok, plan: chosen, output, error: result.ok ? undefined : `install failed (exit ${result.exitCode})` };
}

/** Search the catalog for installable tools. */
export function findInstallable(query: string): ToolDescriptor[] {
  const q = query.toLowerCase().trim();
  return [...CATALOG_BY_ID.values()]
    .filter((entry) => {
      if (!entry.install) return false;
      const haystack = `${entry.id} ${entry.title} ${entry.description} ${entry.category}`.toLowerCase();
      return haystack.includes(q);
    })
    .map((entry) => ({
      id: entry.id,
      bin: entry.bin,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      capabilities: entry.capabilities,
      source: 'catalog' as const,
      install: entry.install,
    }));
}
