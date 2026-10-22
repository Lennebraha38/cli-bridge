import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_POLICY, Policy } from '../core/policy.js';
import { redactSecrets } from '../core/util.js';

function policy(overrides: Partial<typeof DEFAULT_POLICY> = {}): Policy {
  return new Policy({ ...DEFAULT_POLICY, ...overrides });
}

test('deny list blocks a tool', () => {
  const p = policy({ denied: ['rm'] });
  assert.equal(p.checkTool({ id: 'rm', bin: 'rm' }).allowed, false);
  assert.equal(p.checkTool({ id: 'ls', bin: 'ls' }).allowed, true);
});

test('allow list mode blocks everything else', () => {
  const p = policy({ mode: 'allowlist', allowed: ['git'] });
  assert.equal(p.checkTool({ id: 'git', bin: 'git' }).allowed, true);
  assert.equal(p.checkTool({ id: 'curl', bin: 'curl' }).allowed, false);
});

test('dangerous commands are blocked', () => {
  const p = policy();
  assert.equal(p.checkArgs(['rm', '-rf', '/']).allowed, false);
  assert.equal(p.checkArgs(['format', 'C:']).allowed, false);
  assert.equal(p.checkArgs(['rm', '-rf', './build']).allowed, true);
});

test('shell execution is disabled by default', () => {
  const p = policy();
  assert.equal(p.checkShell(true).allowed, false);
  assert.equal(p.checkShell(false).allowed, true);
});

test('secrets are redacted from output', () => {
  const text = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  assert.ok(!redactSecrets(text).includes('abcdefghijklmnopqrstuvwxyz'));
});

test('api keys in assignments are redacted', () => {
  const redacted = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
  assert.ok(!redacted.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'));
});
