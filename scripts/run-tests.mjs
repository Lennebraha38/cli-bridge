/**
 * Cross-version test runner.
 *
 * `node --test <glob>` only understands glob patterns from Node 21 onwards, and
 * `node --test <dir>` behaves differently between Node 20 and Node 24. Passing
 * explicit file paths works on every supported release, so we collect the
 * compiled test files ourselves and hand them to the runner.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(here, '..', 'dist', 'test');

function collect(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full));
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found.sort();
}

const files = collect(testDir);
if (files.length === 0) {
  console.error(`No compiled test files found in ${testDir}. Run "npm run build" first.`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) from ${testDir}`);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
