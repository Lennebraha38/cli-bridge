import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { jsonPath, applyAggregate } from '../core/operations/jsonpath.js';

const sample = {
  store: {
    book: [
      { title: 'Dune', price: 12.5, tags: ['scifi'] },
      { title: 'Neuromancer', price: 9.99, tags: ['scifi', 'cyber'] },
      { title: 'Emma', price: 7, tags: ['classic'] },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  count: 3,
};

test('jsonPath resolves nested children', () => {
  assert.deepEqual(jsonPath(sample, '$.store.bicycle.color'), ['red']);
});

test('jsonPath resolves array indexes', () => {
  assert.deepEqual(jsonPath(sample, '$.store.book[0].title'), ['Dune']);
});

test('jsonPath resolves wildcards', () => {
  const matches = jsonPath(sample, '$.store.book[*].title');
  assert.deepEqual(matches, ['Dune', 'Neuromancer', 'Emma']);
});

test('jsonPath supports filters', () => {
  const matches = jsonPath(sample, "$.store.book[?(@.price<10)].title");
  assert.deepEqual(matches, ['Neuromancer', 'Emma']);
});

test('jsonPath supports recursive descent', () => {
  const matches = jsonPath(sample, '$..price');
  assert.equal(matches.length, 4);
  assert.ok(matches.includes(12.5));
  assert.ok(matches.includes(19.95));
});

test('jsonPath returns the root for $', () => {
  assert.deepEqual(jsonPath(sample, '$'), [sample]);
});

test('applyAggregate computes length and keys', () => {
  assert.equal(applyAggregate(sample.store.book, 'length'), 3);
  assert.deepEqual(applyAggregate(sample.store.bicycle, 'keys'), ['color', 'price']);
  assert.deepEqual(applyAggregate([3, 1, 2], 'sort'), [1, 2, 3]);
});
