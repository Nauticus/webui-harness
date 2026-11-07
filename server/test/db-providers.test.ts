import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB before the module (and its data dir) is initialized.
process.env.WEBLISAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-dbtest-'));

const db = await import('../src/db');

test('parseProviderModels: legacy string[] is normalized', () => {
  assert.deepEqual(db.parseProviderModels('["a", "b"]'), [{ id: 'a' }, { id: 'b' }]);
});

test('parseProviderModels: object entries keep a valid contextWindow', () => {
  const json = JSON.stringify([
    { id: 'x', contextWindow: 128000 },
    { id: 'y' },
    { id: 'z', contextWindow: -5 },
    { id: 'w', contextWindow: 'big' },
    { id: '' },
    'legacy',
    42,
  ]);
  assert.deepEqual(db.parseProviderModels(json), [
    { id: 'x', contextWindow: 128000 },
    { id: 'y' },
    { id: 'z' },
    { id: 'w' },
    { id: 'legacy' },
  ]);
});

test('parseProviderModels: garbage -> []', () => {
  assert.deepEqual(db.parseProviderModels('nope'), []);
  assert.deepEqual(db.parseProviderModels('{}'), []);
});

test('setProviderModels preserves context windows across re-detection', () => {
  const row = db.createProvider({ name: 'p1' });
  db.setProviderModels(row.id, { models: ['a', 'b'], error: '' });
  db.setModelContextWindows(row.id, { a: 1000 });

  // Re-detection keeps 'a' (with its window), drops 'b', adds 'c'.
  db.setProviderModels(row.id, { models: ['a', 'c'], error: '' });
  assert.deepEqual(db.parseProviderModels(db.getProvider(row.id)!.models), [
    { id: 'a', contextWindow: 1000 },
    { id: 'c' },
  ]);
});

test('setModelContextWindows sets, clears, and validates', () => {
  const row = db.createProvider({ name: 'p2' });
  db.setProviderModels(row.id, { models: ['a', 'b'], error: '' });

  db.setModelContextWindows(row.id, { a: 5000, b: 2000 });
  assert.deepEqual(db.parseProviderModels(db.getProvider(row.id)!.models), [
    { id: 'a', contextWindow: 5000 },
    { id: 'b', contextWindow: 2000 },
  ]);

  // Clear one, leave the other untouched.
  db.setModelContextWindows(row.id, { a: null });
  assert.deepEqual(db.parseProviderModels(db.getProvider(row.id)!.models), [
    { id: 'a' },
    { id: 'b', contextWindow: 2000 },
  ]);

  // Non-positive / non-finite values are dropped.
  db.setModelContextWindows(row.id, { b: -1 });
  assert.deepEqual(db.parseProviderModels(db.getProvider(row.id)!.models), [
    { id: 'a' },
    { id: 'b' },
  ]);

  assert.equal(db.setModelContextWindows('missing-id', { a: 1 }), undefined);
});
