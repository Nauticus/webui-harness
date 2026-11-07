import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB before the module (and its data dir) is initialized.
process.env.WEBLISAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-reasoning-'));

import { effortExtraParams, isReasoningEffort, REASONING_EFFORTS } from '../src/reasoning';
const db = await import('../src/db');

test('isReasoningEffort: accepts the five valid values', () => {
  for (const v of ['' as const, 'low', 'medium', 'high', 'xhigh']) assert.equal(isReasoningEffort(v), true);
  assert.equal(REASONING_EFFORTS.length, 5);
});

test('isReasoningEffort: rejects anything else', () => {
  for (const v of ['off', 'LOW', 'Xhigh', '  low', 'bogus', 3, null, undefined, true]) {
    assert.equal(isReasoningEffort(v), false);
  }
});

test('effortExtraParams: auto sends nothing on any provider', () => {
  const urls = ['', 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'http://localhost:11434'];
  for (const url of urls) {
    assert.deepEqual(effortExtraParams(url, 'anything', ''), {});
  }
});

test('effortExtraParams: unrecognized effort values send nothing', () => {
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'o3', 'xhigh-ish'), {});
  assert.deepEqual(effortExtraParams('http://127.0.0.1:8000/v1', 'deepseek', 'OFF'), {});
});

test('effortExtraParams: OpenAI official passes any effort through for any model', () => {
  assert.deepEqual(effortExtraParams('', 'o3', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'o4-mini', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(effortExtraParams('', 'gpt-5.1', 'medium'), { reasoning_effort: 'medium' });
  assert.deepEqual(effortExtraParams('', 'gpt-4o', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(effortExtraParams('', 'openai/o3-mini', 'high'), { reasoning_effort: 'high' });
  // xhigh goes through unchanged — the API decides whether the model
  // accepts it; auto is the fallback when it 400s.
  assert.deepEqual(effortExtraParams('', 'gpt-5.5', 'xhigh'), { reasoning_effort: 'xhigh' });
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'gpt-5.1', 'xhigh'), {
    reasoning_effort: 'xhigh',
  });
});

test('effortExtraParams: OpenRouter uses reasoning.effort for any model', () => {
  assert.deepEqual(effortExtraParams('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4', 'high'), {
    reasoning: { effort: 'high' },
  });
  assert.deepEqual(effortExtraParams('https://openrouter.ai/api/v1', 'meta-llama/llama-4', 'xhigh'), {
    reasoning: { effort: 'xhigh' },
  });
});

test('effortExtraParams: Ollama has no levels — explicit effort turns thinking on', () => {
  assert.deepEqual(effortExtraParams('http://localhost:11434', 'qwen3', 'low'), { think: true });
  assert.deepEqual(effortExtraParams('http://192.168.1.5:11434', 'gpt-oss-20b', 'xhigh'), { think: true });
});

test('effortExtraParams: Google OpenAI-compatible endpoints use thinking_level for any model', () => {
  assert.deepEqual(
    effortExtraParams('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-pro', 'medium'),
    { thinking_config: { thinking_level: 'medium' } }
  );
  assert.deepEqual(
    effortExtraParams('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-pro', 'xhigh'),
    { thinking_config: { thinking_level: 'xhigh' } }
  );
});

test('effortExtraParams: generic OpenAI-compatible servers get the standard field', () => {
  assert.deepEqual(effortExtraParams('http://127.0.0.1:8000/v1', 'deepseek-chat', 'high'), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(effortExtraParams('http://127.0.0.1:8000/v1', 'deepseek-chat', 'xhigh'), {
    reasoning_effort: 'xhigh',
  });
});

test('sessions: reasoning_effort round-trips through the DB', () => {
  const prov = db.createProvider({ name: 'p', baseUrl: '', apiKey: 'k' });
  const proj = db.createProject({ name: 'proj', cwd: '/tmp', providerId: prov.id });

  const s1 = db.createSession(proj.id, { reasoningEffort: 'xhigh' });
  assert.equal(s1.reasoning_effort, 'xhigh');
  assert.equal(db.getSession(s1.id)!.reasoning_effort, 'xhigh');
  assert.equal(db.listSessions(proj.id)[0]!.reasoning_effort, 'xhigh');

  // Default is auto.
  const s2 = db.createSession(proj.id, {});
  assert.equal(s2.reasoning_effort, '');

  // Patch.
  db.setSessionReasoningEffort(s2.id, 'low');
  assert.equal(db.getSession(s2.id)!.reasoning_effort, 'low');
  db.setSessionReasoningEffort(s2.id, '');
  assert.equal(db.getSession(s2.id)!.reasoning_effort, '');
});
