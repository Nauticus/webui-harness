import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB before the module (and its data dir) is initialized.
process.env.WEBLISAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-reasoning-'));

import { effortExtraParams, isReasoningEffort, REASONING_EFFORTS } from '../src/reasoning';
const db = await import('../src/db');

test('isReasoningEffort: accepts the four valid values', () => {
  for (const v of ['' as const, 'low', 'medium', 'high']) assert.equal(isReasoningEffort(v), true);
  assert.equal(REASONING_EFFORTS.length, 4);
});

test('isReasoningEffort: rejects anything else', () => {
  for (const v of ['off', 'LOW', 'xhigh', '  low', 'bogus', 3, null, undefined, true]) {
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
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'o3', 'xhigh'), {});
  assert.deepEqual(effortExtraParams('http://127.0.0.1:8000/v1', 'deepseek', 'OFF'), {});
});

test('effortExtraParams: OpenAI official is strict about model support', () => {
  // Reasoning models get the field.
  assert.deepEqual(effortExtraParams('', 'o3', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'o4-mini', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(effortExtraParams('', 'gpt-5.1', 'medium'), { reasoning_effort: 'medium' });
  // Non-reasoning models: sending the field would 400, so skip it.
  assert.deepEqual(effortExtraParams('', 'gpt-4o', 'high'), {});
  assert.deepEqual(effortExtraParams('https://api.openai.com/v1', 'gpt-4.1-mini', 'low'), {});
  // Provider-prefixed ids (some proxies) still match the o-series shapes.
  assert.deepEqual(effortExtraParams('', 'openai/o3-mini', 'high'), { reasoning_effort: 'high' });
});

test('effortExtraParams: OpenRouter uses reasoning.effort for any model', () => {
  assert.deepEqual(effortExtraParams('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4', 'high'), {
    reasoning: { effort: 'high' },
  });
  assert.deepEqual(effortExtraParams('https://openrouter.ai/api/v1', 'meta-llama/llama-4', 'low'), {
    reasoning: { effort: 'low' },
  });
});

test('effortExtraParams: Ollama has no levels — explicit effort turns thinking on', () => {
  assert.deepEqual(effortExtraParams('http://localhost:11434', 'qwen3', 'low'), { think: true });
  assert.deepEqual(effortExtraParams('http://192.168.1.5:11434', 'gpt-oss-20b', 'high'), { think: true });
});

test('effortExtraParams: Google OpenAI-compatible endpoints use thinking_level for Gemini', () => {
  assert.deepEqual(
    effortExtraParams('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-pro', 'medium'),
    { thinking_config: { thinking_level: 'medium' } }
  );
  // Non-Gemini models on the same endpoint: skip.
  assert.deepEqual(
    effortExtraParams('https://generativelanguage.googleapis.com/v1beta/openai', 'gpt-5', 'high'),
    {}
  );
});

test('effortExtraParams: generic OpenAI-compatible servers get the standard field', () => {
  assert.deepEqual(effortExtraParams('http://127.0.0.1:8000/v1', 'deepseek-chat', 'high'), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(effortExtraParams('http://llm.local:5000', 'llama', 'low'), { reasoning_effort: 'low' });
});

test('sessions: reasoning_effort round-trips through the DB', () => {
  const prov = db.createProvider({ name: 'p', baseUrl: '', apiKey: 'k' });
  const proj = db.createProject({ name: 'proj', cwd: '/tmp', providerId: prov.id });

  const s1 = db.createSession(proj.id, { reasoningEffort: 'high' });
  assert.equal(s1.reasoning_effort, 'high');
  assert.equal(db.getSession(s1.id)!.reasoning_effort, 'high');
  assert.equal(db.listSessions(proj.id)[0]!.reasoning_effort, 'high');

  // Default is auto.
  const s2 = db.createSession(proj.id, {});
  assert.equal(s2.reasoning_effort, '');

  // Patch.
  db.setSessionReasoningEffort(s2.id, 'low');
  assert.equal(db.getSession(s2.id)!.reasoning_effort, 'low');
  db.setSessionReasoningEffort(s2.id, '');
  assert.equal(db.getSession(s2.id)!.reasoning_effort, '');
});
