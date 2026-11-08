import test from 'node:test';
import assert from 'node:assert/strict';
import { clearStoredOpen, setStoredOpen, storedOpen } from '../src/lib/panelState';

// Virtualized rows unmount as they leave the window, so a card's open state has
// to live outside the component. These are the rules that make that honest.

test('no choice until one is made', () => {
  clearStoredOpen();
  assert.equal(storedOpen('tool:c1'), undefined);
});

test('a choice is remembered per key', () => {
  clearStoredOpen();
  setStoredOpen('tool:c1', false);
  assert.equal(storedOpen('tool:c1'), false);
  setStoredOpen('thinking:2', true);
  assert.equal(storedOpen('thinking:2'), true);
  assert.equal(storedOpen('tool:c1'), false, 'other keys are untouched');
});

test('sessions do not share keys', () => {
  clearStoredOpen();
  setStoredOpen('a/thinking:0', true);
  assert.equal(storedOpen('b/thinking:0'), undefined);
});

test('the store is bounded', () => {
  clearStoredOpen();
  for (let i = 0; i < 600; i++) setStoredOpen(`k${i}`, true);
  assert.equal(storedOpen('k0'), undefined, 'oldest keys are dropped');
  assert.equal(storedOpen('k599'), true);
  clearStoredOpen();
});
