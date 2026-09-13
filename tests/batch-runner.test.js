'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runBatch, runCompare, judgePass, parseImportLine } = require('../main/batch-runner');
const { DEFAULT_PRICES } = require('../main/stats');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMockClient(behavior) {
  return {
    chat: async ({ body }) => {
      if (behavior) return behavior(body);
      const prompt = body.messages[body.messages.length - 1].content;
      return {
        content: `echo:${prompt}`,
        reasoning: '',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheHitTokens: 0, cacheMissTokens: 10 },
        finishReason: 'stop',
        latencyMs: 50
      };
    }
  };
}

test('judgePass requires all keywords, case-insensitive', () => {
  assert.equal(judgePass(['北京'], '中国的首都是北京'), true);
  assert.equal(judgePass(['北京', '首都'], '中国的首都是北京'), true);
  assert.equal(judgePass(['上海'], '中国的首都是北京'), false);
  assert.equal(judgePass([], 'anything'), null);
  assert.equal(judgePass(['HELLO'], 'say hello world'), true);
});

test('parseImportLine splits prompt and keywords', () => {
  assert.deepEqual(parseImportLine('中国的首都是哪里？ | 北京,首都'), {
    prompt: '中国的首都是哪里？', expectKeywords: ['北京', '首都']
  });
  assert.deepEqual(parseImportLine('纯 Prompt'), { prompt: '纯 Prompt', expectKeywords: [] });
  assert.equal(parseImportLine('   '), null);
  assert.deepEqual(parseImportLine('中文逗号 | 甲，乙'), { prompt: '中文逗号', expectKeywords: ['甲', '乙'] });
});

test('runBatch produces judged results, costs and summary', async () => {
  const settings = { concurrency: 2, retries: 0, prices: DEFAULT_PRICES };
  const items = [
    { id: 0, prompt: 'q1', expectKeywords: ['echo:q1'] },
    { id: 1, prompt: 'q2', expectKeywords: ['nope'] },
    { id: 2, prompt: 'q3', expectKeywords: [] }
  ];
  const progress = [];
  const out = await runBatch({
    client: makeMockClient(),
    items,
    config: { model: 'deepseek-chat', maxTokens: 100 },
    settings,
    onProgress: (p) => progress.push(p)
  });

  assert.equal(out.results.length, 3);
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.scored, 2);
  assert.equal(out.summary.passed, 1);
  assert.equal(out.summary.accuracy, 0.5);
  assert.equal(out.summary.okCount, 3);
  assert.equal(out.summary.totalTokens, 45);
  // cost: 10 miss tokens + 5 out tokens per item => 15 * (0.8+2.0)/1e6 * 3
  assert.ok(out.summary.totalCost > 0);
  assert.equal(progress.length, 3);
  assert.deepEqual(progress[2], { done: 3, total: 3 });
  assert.equal(out.model, 'deepseek-chat');
});

test('runBatch retries failed requests then records error', async () => {
  let calls = 0;
  const client = {
    chat: async () => {
      calls++;
      if (calls <= 2) throw new Error('500 boom');
      return {
        content: 'ok', reasoning: '', finishReason: 'stop', latencyMs: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0, cacheMissTokens: 1 }
      };
    }
  };
  const out = await runBatch({
    client,
    items: [{ id: 0, prompt: 'p', expectKeywords: [] }],
    config: { model: 'deepseek-chat' },
    settings: { concurrency: 1, retries: 2, prices: DEFAULT_PRICES }
  });
  // retries=2 allows 3 attempts: 2 failures then success on the 3rd call
  assert.equal(calls, 3);
  assert.equal(out.results[0].ok, true);
});

test('runBatch can be aborted mid-way', async () => {
  const controller = new AbortController();
  const client = {
    chat: async () => {
      await delay(30);
      return { content: 'x', reasoning: '', usage: null, finishReason: 'stop', latencyMs: 30 };
    }
  };
  setTimeout(() => controller.abort(), 40);
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i, prompt: 'p' + i, expectKeywords: [] }));
  const out = await runBatch({
    client, items,
    config: { model: 'deepseek-chat' },
    settings: { concurrency: 1, retries: 0, prices: DEFAULT_PRICES },
    signal: controller.signal
  });
  assert.equal(out.aborted, true);
  assert.ok(out.results.some((r) => r.skipped || r.error));
});

test('runCompare builds matrix and per-config summaries', async () => {
  const settings = { concurrency: 4, retries: 0, prices: DEFAULT_PRICES };
  const configs = [
    { id: 'a', label: 'A', model: 'deepseek-chat' },
    { id: 'b', label: 'B', model: 'deepseek-reasoner' }
  ];
  const prompts = ['p1', 'p2'];
  const out = await runCompare({
    client: makeMockClient(),
    prompts, configs, repeats: 1,
    settings,
    onProgress: () => {}
  });
  assert.equal(out.results.length, 4);
  const a = out.perConfig.find((c) => c.id === 'a');
  assert.equal(a.runs, 2);
  assert.equal(a.okCount, 2);
  assert.equal(a.avgTotalTokens, 15);
  // reasoner is priced differently from chat
  const b = out.perConfig.find((c) => c.id === 'b');
  assert.ok(b.totalCost > a.totalCost);
});

test('runCompare repeats each prompt per config', async () => {
  const out = await runCompare({
    client: makeMockClient(),
    prompts: ['only'],
    configs: [{ id: 'x', label: 'X', model: 'deepseek-chat' }],
    repeats: 3,
    settings: { concurrency: 3, retries: 0, prices: DEFAULT_PRICES }
  });
  assert.equal(out.results.length, 3);
  assert.deepEqual(out.results.map((r) => r.repeat).sort(), [0, 1, 2]);
});
