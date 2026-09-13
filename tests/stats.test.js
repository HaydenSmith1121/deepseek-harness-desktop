'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stats = require('../main/stats');

test('costOf prices cache-hit/miss/completion separately (CNY per million)', () => {
  const usage = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, completionTokens: 500_000 };
  // chat defaults: hit 0.2 / miss 0.8 / out 2.0
  const cost = stats.costOf(usage, 'deepseek-chat', null);
  assert.ok(Math.abs(cost - (0.2 + 0.8 + 1.0)) < 1e-9);
});

test('costOf honours custom price table and fuzzy model lookup', () => {
  const prices = { 'my-model': { cacheHit: 1, cacheMiss: 2, output: 3 } };
  const usage = { cacheHitTokens: 100_000, cacheMissTokens: 100_000, completionTokens: 100_000 };
  const cost = stats.costOf(usage, 'my-model-v2', prices);
  assert.ok(Math.abs(cost - (0.1 + 0.2 + 0.3)) < 1e-9);
});

test('costOf falls back to chat pricing for unknown models', () => {
  const usage = { cacheHitTokens: 0, cacheMissTokens: 1_000_000, completionTokens: 0 };
  const cost = stats.costOf(usage, 'totally-unknown', null);
  assert.ok(Math.abs(cost - 0.8) < 1e-9);
});

test('summarize aggregates accuracy, latency, tokens and cost', () => {
  const results = [
    { ok: true, passed: true, latencyMs: 1000, usage: { totalTokens: 100, completionTokens: 40 }, cost: 0.01 },
    { ok: true, passed: false, latencyMs: 3000, usage: { totalTokens: 200, completionTokens: 80 }, cost: 0.02 },
    { ok: true, passed: null, latencyMs: 2000, usage: { totalTokens: 50, completionTokens: 20 }, cost: 0.005 },
    { ok: false, error: 'boom', latencyMs: 0, usage: null, cost: 0 }
  ];
  const s = stats.summarize(results);
  assert.equal(s.total, 4);
  assert.equal(s.scored, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.apiErrors, 1);
  assert.equal(s.okCount, 3);
  assert.equal(s.avgLatencyMs, 2000);
  assert.equal(s.minLatencyMs, 1000);
  assert.equal(s.maxLatencyMs, 3000);
  assert.equal(s.totalTokens, 350);
  assert.ok(Math.abs(s.totalCost - 0.035) < 1e-9);
});

test('summarize returns null accuracy when nothing is scored', () => {
  const s = stats.summarize([{ ok: true, passed: null, latencyMs: 5, usage: null, cost: 0 }]);
  assert.equal(s.accuracy, null);
  assert.equal(s.scored, 0);
});

test('summarizeConfig groups by configId and skips errors in averages', () => {
  const results = [
    { configId: 'a', ok: true, latencyMs: 1000, usage: { totalTokens: 100, completionTokens: 50 }, cost: 0.01, content: '12345' },
    { configId: 'a', ok: true, latencyMs: 3000, usage: { totalTokens: 300, completionTokens: 150 }, cost: 0.03, content: '1234567890' },
    { configId: 'a', ok: false, error: 'x', latencyMs: 99999, usage: null, cost: 0, content: '' },
    { configId: 'b', ok: true, latencyMs: 500, usage: { totalTokens: 10, completionTokens: 5 }, cost: 0.001, content: 'ab' }
  ];
  const c = stats.summarizeConfig('a', { id: 'a', label: 'A', model: 'deepseek-chat' }, results);
  assert.equal(c.runs, 3);
  assert.equal(c.okCount, 2);
  assert.equal(c.errorCount, 1);
  assert.equal(c.avgLatencyMs, 2000);
  assert.equal(c.avgTotalTokens, 200);
  assert.ok(Math.abs(c.totalCost - 0.04) < 1e-9);
  assert.equal(c.avgOutputChars, 7.5);
});
