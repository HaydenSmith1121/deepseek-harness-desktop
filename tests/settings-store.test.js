'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SettingsStore, DEFAULT_SETTINGS, deepMerge } = require('../main/settings-store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-')), 'settings.json');
}

test('load returns defaults when file missing', async () => {
  const store = new SettingsStore(tmpFile());
  const s = await store.load();
  assert.equal(s.baseUrl, DEFAULT_SETTINGS.baseUrl);
  assert.equal(s.concurrency, 3);
  assert.ok(s.prices['deepseek-chat']);
  assert.ok(s.prices['deepseek-reasoner']);
});

test('patch persists to disk and survives a new store instance', async () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  await store.patch({ apiKey: 'sk-test', concurrency: 8, prices: { 'deepseek-chat': { output: 9 } } });

  const store2 = new SettingsStore(file);
  const s = await store2.load();
  assert.equal(s.apiKey, 'sk-test');
  assert.equal(s.concurrency, 8);
  // deep-merged: unspecified price fields keep defaults
  assert.equal(s.prices['deepseek-chat'].output, 9);
  assert.equal(s.prices['deepseek-chat'].cacheHit, DEFAULT_SETTINGS.prices['deepseek-chat'].cacheHit);
  // other models untouched
  assert.ok(s.prices['deepseek-reasoner']);
});

test('patch ignores undefined values', async () => {
  const store = new SettingsStore(tmpFile());
  await store.load();
  await store.patch({ apiKey: undefined, timeoutMs: 5000 });
  const s = await store.load();
  assert.equal(s.apiKey, '');
  assert.equal(s.timeoutMs, 5000);
});

test('deepMerge merges nested objects without mutating base', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2] };
  const merged = deepMerge(base, { a: { y: 9, z: 3 } });
  assert.deepEqual(merged, { a: { x: 1, y: 9, z: 3 }, list: [1, 2] });
  assert.deepEqual(base.a, { x: 1, y: 2 });
});
