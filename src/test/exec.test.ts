import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, resolveBin } from '../core/exec.js';
import { runOperation } from '../core/operations/runner.js';
import { registry } from '../core/registry.js';

test('resolveBin finds node', () => {
  const resolved = resolveBin('node');
  assert.ok(resolved, 'node should be resolvable');
  assert.ok(resolved!.toLowerCase().includes('node'));
});

test('run captures stdout and the exit code', async () => {
  const result = await run({
    tool: 'node',
    bin: 'node',
    args: ['-e', 'console.log("hello bridge")'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'hello bridge');
});

test('run reports a failing exit code', async () => {
  const result = await run({
    tool: 'node',
    bin: 'node',
    args: ['-e', 'process.exit(3)'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
});

test('run pipes stdin to the process', async () => {
  const result = await run({
    tool: 'node',
    bin: 'node',
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    stdin: 'piped content',
  });
  assert.equal(result.stdout, 'piped content');
});

test('run returns an error for an unknown binary', async () => {
  const result = await run({ tool: 'nope', bin: 'definitely-not-a-real-binary-xyz' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not found/);
});

test('run enforces the timeout', async () => {
  const result = await run({
    tool: 'node',
    bin: 'node',
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeoutMs: 400,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('builtin json.query works without any external tool', async () => {
  await registry.load();
  const result = await runOperation('json.query', {
    input: { json: '{"items":[{"id":1},{"id":2}]}', filter: '$.items[*].id' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, [1, 2]);
  assert.equal(result.builtin, true);
});

test('builtin file.write and file.read round trip', async () => {
  await registry.load();
  const path = join(tmpdir(), `cli-bridge-test-${process.pid}.txt`);
  const written = await runOperation('file.write', { input: { path, content: 'round trip' } });
  assert.equal(written.ok, true);
  const read = await runOperation('file.read', { input: { path } });
  assert.equal(read.output, 'round trip');
  rmSync(path, { force: true });
});

test('sys.info always works', async () => {
  await registry.load();
  const result = await runOperation('sys.info', {});
  assert.equal(result.ok, true);
  assert.ok((result.output as { platform: string }).platform);
});
