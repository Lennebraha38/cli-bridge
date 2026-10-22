import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpolate, parseShorthand, type ChainScope } from '../core/chain.js';
import type { ChainStepResult } from '../core/types.js';

function scope(): ChainScope {
  const steps: Record<string, ChainStepResult> = {
    fetch: {
      id: 'fetch',
      op: 'http.request',
      ok: true,
      exitCode: 0,
      stdout: 'plain text output',
      stderr: '',
      json: { stars: 42 },
      durationMs: 12,
    },
  };
  return { steps, input: { query: 'nodejs' }, env: { HOME: 'C:\\Users\\Test' } };
}

test('interpolate resolves a step stdout', () => {
  assert.equal(interpolate('{{steps.fetch.stdout}}', scope()), 'plain text output');
});

test('interpolate keeps the type of a json reference', () => {
  assert.deepEqual(interpolate('{{steps.fetch.json}}', scope()), { stars: 42 });
});

test('interpolate embeds references inside a larger string', () => {
  assert.equal(interpolate('stars: {{steps.fetch.json.stars}}', scope()), 'stars: 42');
});

test('interpolate resolves chain input and environment', () => {
  assert.equal(interpolate('{{input.query}}', scope()), 'nodejs');
  assert.equal(interpolate('{{env.HOME}}', scope()), 'C:\\Users\\Test');
});

test('interpolate walks into objects and arrays', () => {
  const result = interpolate({ url: 'https://x/{{input.query}}', list: ['{{steps.fetch.stdout}}'] }, scope());
  assert.deepEqual(result, { url: 'https://x/nodejs', list: ['plain text output'] });
});

test('interpolate leaves unknown references untouched', () => {
  assert.equal(interpolate('{{steps.missing.stdout}}', scope()), '{{steps.missing.stdout}}');
});

test('parseShorthand builds a chain from a pipeline string', () => {
  const spec = parseShorthand('http.request url=https://example.com | json.query filter=.name');
  assert.equal(spec.steps.length, 2);
  assert.equal(spec.steps[0]?.op, 'http.request');
  assert.equal(spec.steps[0]?.with?.url, 'https://example.com');
  assert.equal(spec.steps[1]?.op, 'json.query');
  assert.equal(spec.steps[1]?.with?.filter, '.name');
});

test('parseShorthand converts numeric values', () => {
  const spec = parseShorthand('media.info file=a.mp4');
  assert.equal(spec.steps[0]?.with?.file, 'a.mp4');
});
