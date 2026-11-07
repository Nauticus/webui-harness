import test from 'node:test';
import assert from 'node:assert/strict';
import { modelBaseId, groupModels } from '../src/providers';

test('modelBaseId: dated snapshots collapse to their alias', () => {
  assert.equal(modelBaseId('gpt-4o-2024-11-20'), 'gpt-4o');
  assert.equal(modelBaseId('gpt-4-2024-08-06'), 'gpt-4');
  assert.equal(modelBaseId('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet');
  assert.equal(modelBaseId('gpt-4o-2024-11-20-01'), 'gpt-4o');
});

test('modelBaseId: known service variants collapse, unknown tags do not', () => {
  assert.equal(modelBaseId('openai/gpt-4o:free'), 'openai/gpt-4o');
  assert.equal(modelBaseId('openai/gpt-4o:extended'), 'openai/gpt-4o');
  assert.equal(modelBaseId('openai/gpt-4o:nitro'), 'openai/gpt-4o');
  assert.equal(modelBaseId('openai/gpt-4o:latest'), 'openai/gpt-4o');
  // Ollama-style size/quant tags are distinct models, not aliases.
  assert.equal(modelBaseId('llama3.1:8b'), 'llama3.1:8b');
  assert.equal(modelBaseId('llama3.1:70b'), 'llama3.1:70b');
  assert.equal(modelBaseId('llama3.1:q4_K_M'), 'llama3.1:q4_K_M');
});

test('modelBaseId: lookalike suffixes are not dates', () => {
  assert.equal(modelBaseId('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(modelBaseId('mistral-small-2402'), 'mistral-small-2402');
  assert.equal(modelBaseId('llama3.1'), 'llama3.1');
});

test('groupModels: collapses aliases, picks the canonical id', () => {
  const groups = groupModels([
    { id: 'gpt-4o-2024-05-13' },
    { id: 'gpt-4o' },
    { id: 'gpt-4o:free' },
    { id: 'gpt-4o-2024-11-20' },
    { id: 'gpt-4o-mini' },
  ]);
  assert.deepEqual(groups, [
    { id: 'gpt-4o', aliases: ['gpt-4o-2024-05-13', 'gpt-4o:free', 'gpt-4o-2024-11-20'] },
    { id: 'gpt-4o-mini', aliases: [] },
  ]);
});

test('groupModels: order follows first appearance; contextWindow comes from the canonical', () => {
  const groups = groupModels([
    { id: 'gpt-4o-2024-11-20', contextWindow: 99999 },
    { id: 'gpt-4o' },
    { id: 'gpt-4o:free', contextWindow: 1 },
    { id: 'other' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.id, 'gpt-4o');
  assert.deepEqual(groups[0]!.aliases, ['gpt-4o-2024-11-20', 'gpt-4o:free']);
  assert.equal(groups[0]!.contextWindow, undefined); // canonical has none
  assert.equal(groups[1]!.id, 'other');
});

test('groupModels: no canonical present means the shortest dated id stands in', () => {
  const groups = groupModels([{ id: 'gpt-4o-2024-11-20' }, { id: 'gpt-4o-2024-05-13' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.id, 'gpt-4o-2024-05-13');
  assert.deepEqual(groups[0]!.aliases, ['gpt-4o-2024-11-20']);
});

test('groupModels: empty in -> empty out', () => {
  assert.deepEqual(groupModels([]), []);
});
