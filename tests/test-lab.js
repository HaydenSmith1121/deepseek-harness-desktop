'use strict';

/**
 * 评测台单元测试：API 客户端 / 并发调度 / 成本统计 / 批量与对比执行器。
 * 全部使用 mock client，不发起任何真实网络请求。
 */

const assert = require('assert');
const api = require('../src/main/api');
const { runWithConcurrency } = require('../src/main/scheduler');
const { costOf, summarize, summarizeConfig, DEFAULT_PRICES } = require('../src/main/stats');
const { runBatch, runCompare, judgePass, parseImportLine, parseDataset } = require('../src/main/batch');

let passed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

async function ta(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可编程 mock 客户端；behavior 返回 { content, usage, latencyMs } 或抛错 */
function mockClient(behavior) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    chat: async ({ body }) => {
      const n = calls++;
      return behavior(body, n);
    },
  };
}

function usage(promptTokens, completionTokens, cacheHit = 0) {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: promptTokens - cacheHit,
  };
}

async function main() {
  /* ==================== api ==================== */

  t('normalizeBaseUrl 去除尾部斜杠 / 路径 / v1', () => {
    assert.strictEqual(api.normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com');
    assert.strictEqual(api.normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
    assert.strictEqual(api.normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com');
    assert.strictEqual(api.normalizeBaseUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com');
    assert.strictEqual(api.normalizeBaseUrl(''), api.DEFAULT_BASE_URL);
  });

  t('buildBody camelCase -> snake_case，stream 附带 include_usage', () => {
    const body = api.buildBody({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 1024,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      stream: true,
    });
    assert.strictEqual(body.model, 'deepseek-chat');
    assert.strictEqual(body.temperature, 0.5);
    assert.strictEqual(body.top_p, 0.9);
    assert.strictEqual(body.max_tokens, 1024);
    assert.strictEqual(body.frequency_penalty, 0.1);
    assert.strictEqual(body.presence_penalty, 0.2);
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
    assert.strictEqual(body.topP, undefined, '不应残留 camelCase 字段');
  });

  t('buildBody 对 deepseek-reasoner 剔除不支持的采样参数', () => {
    const body = api.buildBody({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.9,
      topP: 0.8,
      presencePenalty: 0.3,
      maxTokens: 2048,
    });
    assert.strictEqual(body.temperature, undefined);
    assert.strictEqual(body.top_p, undefined);
    assert.strictEqual(body.presence_penalty, undefined);
    assert.strictEqual(body.max_tokens, 2048, 'max_tokens 应当保留');
  });

  t('buildBody 忽略空值并只在缺失时插入 system', () => {
    const b1 = api.buildBody({ model: 'm', messages: [], temperature: '', topP: null, system: 'SYS' });
    assert.strictEqual(b1.temperature, undefined);
    assert.strictEqual(b1.top_p, undefined);
    assert.deepStrictEqual(b1.messages, [{ role: 'system', content: 'SYS' }]);

    const b2 = api.buildBody({
      model: 'm',
      messages: [{ role: 'system', content: '已有' }],
      system: 'SYS',
    });
    assert.strictEqual(b2.messages.length, 1, '不应重复插入 system');
    assert.strictEqual(b2.messages[0].content, '已有');
  });

  t('buildBody stop 支持字符串与数组', () => {
    const a = api.buildBody({ model: 'm', messages: [], stop: 'a, b ,c' });
    assert.deepStrictEqual(a.stop, ['a', 'b', 'c']);
    const b = api.buildBody({ model: 'm', messages: [], stop: ['x', 'y'] });
    assert.deepStrictEqual(b.stop, ['x', 'y']);
  });

  t('extractSseEvents 按空行切分、识别 [DONE]、容忍脏数据', () => {
    const buf =
      'data: {"a":1}\n\n' +
      'data: not-json\n\n' +
      'data: {"b":2}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"c":3}\n\n';
    const r = api.extractSseEvents(buf);
    assert.strictEqual(r.events.length, 2);
    assert.deepStrictEqual(r.events[0], { a: 1 });
    assert.deepStrictEqual(r.events[1], { b: 2 });
    assert.strictEqual(r.done, true);
  });

  t('extractSseEvents 保留未闭合的尾部缓冲', () => {
    const r = api.extractSseEvents('data: {"a":1}\n\ndata: {"b":');
    assert.strictEqual(r.events.length, 1);
    assert.strictEqual(r.done, false);
    assert.strictEqual(r.rest, 'data: {"b":');
  });

  t('normalizeUsage 归一化缓存命中字段', () => {
    const u = api.normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 64,
    });
    assert.strictEqual(u.cacheHitTokens, 64);
    assert.strictEqual(u.cacheMissTokens, 36);
    assert.strictEqual(u.totalTokens, 120);

    const e = api.normalizeUsage(undefined);
    assert.deepStrictEqual(e, {
      promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
    });
  });

  /* ==================== scheduler ==================== */

  await ta('runWithConcurrency 保持结果顺序且不超并发上限', async () => {
    let inflight = 0;
    let peak = 0;
    const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await delay(Math.random() * 8);
      inflight--;
      return n * 10;
    });
    const res = await runWithConcurrency(tasks, 3);
    assert.deepStrictEqual(res, [10, 20, 30, 40, 50, 60, 70]);
    assert.ok(peak <= 3, `并发峰值 ${peak} 不应超过 3`);
  });

  await ta('runWithConcurrency 中止后不留稀疏空洞', async () => {
    const ac = new AbortController();
    const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
      if (n === 2) ac.abort();
      return n;
    });
    const res = await runWithConcurrency(tasks, 1, { signal: ac.signal });
    assert.strictEqual(res.length, 5, '长度必须与任务数一致');
    // 并发 1：第 0 个跑完，第 1 个在中止前已派发并跑完，其余 3 个不再派发
    assert.strictEqual(res[0], 1);
    assert.strictEqual(res[1], 2);
    assert.strictEqual(res.filter((v) => v === undefined).length, 3);
    assert.strictEqual(res.hasOwnProperty(2), true, '不能是稀疏数组');
  });

  await ta('runWithConcurrency onTaskDone 抛错不影响主流程', async () => {
    const res = await runWithConcurrency([async () => 1, async () => 2], 2, {
      onTaskDone: () => {
        throw new Error('boom');
      },
    });
    assert.deepStrictEqual(res, [1, 2]);
  });

  /* ==================== stats ==================== */

  t('costOf 按命中/未命中/输出分段计价', () => {
    const price = DEFAULT_PRICES['deepseek-chat'];
    const cost = costOf(usage(1e6, 1e6, 5e5), 'deepseek-chat');
    const expect = (5e5 / 1e6) * price.cacheHit + (5e5 / 1e6) * price.cacheMiss + (1e6 / 1e6) * price.output;
    assert.ok(Math.abs(cost - expect) < 1e-9, `期望 ${expect}，实际 ${cost}`);
  });

  t('costOf 未知模型回退到 deepseek-chat 价格', () => {
    const c = costOf(usage(1e6, 0, 0), 'some-future-model');
    assert.strictEqual(c, DEFAULT_PRICES['deepseek-chat'].cacheMiss);
  });

  t('summarize 统计通过率 / 错误 / 延迟 / 成本', () => {
    const s = summarize([
      { ok: true, passed: true, latencyMs: 100, cost: 0.01, usage: usage(10, 20, 5) },
      { ok: true, passed: false, latencyMs: 300, cost: 0.02, usage: usage(30, 40) },
      { ok: false, error: 'boom', latencyMs: 0, cost: 0, usage: null },
    ]);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.scored, 2);
    assert.strictEqual(s.passed, 1);
    assert.strictEqual(s.accuracy, 0.5);
    assert.strictEqual(s.apiErrors, 1);
    assert.strictEqual(s.okCount, 2);
    assert.strictEqual(s.avgLatencyMs, 200);
    assert.strictEqual(s.minLatencyMs, 100);
    assert.strictEqual(s.maxLatencyMs, 300);
    assert.strictEqual(s.totalPromptTokens, 40);
    assert.strictEqual(s.totalCompletionTokens, 60);
    assert.ok(Math.abs(s.totalCost - 0.03) < 1e-9);
    assert.strictEqual(s.accuracy, 0.5);
  });

  t('summarize 无判定用例时 accuracy 为 null', () => {
    const s = summarize([{ ok: true, passed: null, latencyMs: 10, cost: 0, usage: null }]);
    assert.strictEqual(s.accuracy, null);
    assert.strictEqual(s.scored, 0);
  });

  t('summarizeConfig 按配置聚合', () => {
    const rows = [
      { configId: 'a', ok: true, latencyMs: 100, cost: 0.01, content: 'xxxx', usage: usage(10, 20) },
      { configId: 'a', ok: true, latencyMs: 300, cost: 0.03, content: 'xx', usage: usage(10, 20) },
      { configId: 'b', ok: false, error: 'e', latencyMs: 50, cost: 0, content: '' },
    ];
    const a = summarizeConfig('a', { label: 'A', model: 'deepseek-chat' }, rows);
    assert.strictEqual(a.runs, 2);
    assert.strictEqual(a.okCount, 2);
    assert.strictEqual(a.errorCount, 0);
    assert.strictEqual(a.avgLatencyMs, 200);
    assert.strictEqual(a.avgTotalTokens, 30);
    assert.strictEqual(a.avgOutputChars, 3);
    assert.ok(Math.abs(a.totalCost - 0.04) < 1e-9);

    const b = summarizeConfig('b', { label: 'B', model: 'deepseek-reasoner' }, rows);
    assert.strictEqual(b.errorCount, 1);
    assert.strictEqual(b.avgLatencyMs, null);
  });

  /* ==================== batch：解析 ==================== */

  t('judgePass 要求全部关键词命中；空列表返回 null', () => {
    assert.strictEqual(judgePass(['http', '协议'], 'HTTP 是超文本传输协议'), true);
    assert.strictEqual(judgePass(['http', '缺失词'], 'HTTP 是超文本传输协议'), false);
    assert.strictEqual(judgePass([], '任意'), null);
    assert.strictEqual(judgePass(undefined, '任意'), null);
  });

  t('parseImportLine 支持中英文逗号与无关键词', () => {
    assert.deepStrictEqual(parseImportLine('解释 HTTP | http,协议'), {
      prompt: '解释 HTTP', expectKeywords: ['http', '协议'],
    });
    assert.deepStrictEqual(parseImportLine('解释 HTTP | http，协议'), {
      prompt: '解释 HTTP', expectKeywords: ['http', '协议'],
    });
    assert.deepStrictEqual(parseImportLine('就一句话'), { prompt: '就一句话', expectKeywords: [] });
    assert.strictEqual(parseImportLine('   '), null);
  });

  t('parseDataset 跳过空行与注释行并编号', () => {
    const items = parseDataset('# 注释\n\n第一条 | kw\n第二条\n   \n');
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(items[0], { id: 1, prompt: '第一条', expectKeywords: ['kw'] });
    assert.deepStrictEqual(items[1], { id: 2, prompt: '第二条', expectKeywords: [] });
  });

  /* ==================== batch：执行 ==================== */

  await ta('runBatch 正常执行并汇总', async () => {
    const client = mockClient(async (body) => {
      const p = body.messages[0].content;
      return {
        content: `回答:${p}`,
        reasoning: '',
        usage: usage(10, 5, 2),
        finishReason: 'stop',
        latencyMs: 42,
      };
    });
    const r = await runBatch({
      client,
      items: parseDataset('苹果 | 回答\n香蕉'),
      config: { model: 'deepseek-chat', temperature: 0.7, maxTokens: 512, system: 'S' },
      settings: { concurrency: 2, retries: 0 },
    });
    assert.strictEqual(r.results.length, 2);
    assert.strictEqual(r.aborted, false);
    assert.strictEqual(r.model, 'deepseek-chat');
    assert.strictEqual(r.summary.okCount, 2);
    assert.strictEqual(r.summary.scored, 1);
    assert.strictEqual(r.summary.passed, 1);
    assert.strictEqual(r.summary.totalPromptTokens, 20);
    assert.ok(r.summary.totalCost > 0);
    assert.strictEqual(client.calls, 2);
  });

  await ta('runBatch 请求体带上 system 与 max_tokens', async () => {
    let seen = null;
    const client = mockClient(async (body) => {
      seen = body;
      return { content: 'ok', usage: usage(1, 1), latencyMs: 1 };
    });
    await runBatch({
      client,
      items: [{ prompt: 'hi' }],
      config: { model: 'deepseek-chat', system: '你是助手', maxTokens: 256, temperature: 0.3 },
      settings: { concurrency: 1 },
    });
    assert.strictEqual(seen.stream, false);
    assert.strictEqual(seen.max_tokens, 256);
    assert.strictEqual(seen.temperature, 0.3);
    assert.deepStrictEqual(seen.messages[0], { role: 'system', content: '你是助手' });
  });

  await ta('runBatch 失败重试后成功，且只重试失败项', async () => {
    let attempt = 0;
    const client = mockClient(async () => {
      attempt++;
      if (attempt === 1) throw new Error('网络抖动');
      return { content: 'ok', usage: usage(3, 4), latencyMs: 7 };
    });
    const r = await runBatch({
      client,
      items: [{ prompt: 'only' }],
      config: { model: 'deepseek-chat' },
      settings: { concurrency: 1, retries: 2 },
    });
    assert.strictEqual(attempt, 2, '第一次失败后应重试一次即成功');
    assert.strictEqual(r.results[0].ok, true);
    assert.strictEqual(r.summary.apiErrors, 0);
  });

  await ta('runBatch 重试耗尽后记为失败且不抛出', async () => {
    const client = mockClient(async () => {
      throw new Error('持久失败');
    });
    const r = await runBatch({
      client,
      items: [{ prompt: 'a' }, { prompt: 'b' }],
      config: { model: 'deepseek-chat' },
      settings: { concurrency: 2, retries: 1 },
    });
    assert.strictEqual(client.calls, 4, '2 条 × (1+1) 次尝试');
    assert.strictEqual(r.summary.apiErrors, 2);
    assert.strictEqual(r.summary.okCount, 0);
    assert.ok(r.results.every((x) => x.error === '持久失败'));
  });

  await ta('runBatch 中止后结果长度完整、无空洞', async () => {
    const ac = new AbortController();
    let n = 0;
    const client = mockClient(async () => {
      n++;
      if (n === 1) ac.abort();
      return { content: 'x', usage: usage(1, 1), latencyMs: 1 };
    });
    const r = await runBatch({
      client,
      items: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' }],
      config: { model: 'deepseek-chat' },
      settings: { concurrency: 1 },
      signal: ac.signal,
    });
    assert.strictEqual(r.results.length, 4);
    assert.ok(r.results.every((x) => x !== undefined), '不允许出现空洞');
    assert.strictEqual(r.aborted, true);
    assert.ok(r.results.filter((x) => x.error === 'aborted').length >= 1);
    assert.deepStrictEqual(r.summary, summarize(r.results));
  });

  await ta('runBatch 上报进度', async () => {
    const seen = [];
    const client = mockClient(async () => ({ content: 'x', usage: usage(1, 1), latencyMs: 1 }));
    await runBatch({
      client,
      items: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
      config: { model: 'deepseek-chat' },
      settings: { concurrency: 1 },
      onProgress: (p) => seen.push(`${p.done}/${p.total}`),
    });
    assert.deepStrictEqual(seen, ['1/3', '2/3', '3/3']);
  });

  await ta('runCompare 对每个配置跑遍所有提示词与重复次数', async () => {
    const client = mockClient(async (body) => ({
      content: `m=${body.model}`,
      usage: usage(10, 10),
      latencyMs: body.model === 'deepseek-reasoner' ? 200 : 100,
    }));
    const r = await runCompare({
      client,
      prompts: ['p1', 'p2'],
      configs: [
        { id: 'a', label: 'A', model: 'deepseek-chat' },
        { id: 'b', label: 'B', model: 'deepseek-reasoner' },
      ],
      repeats: 2,
      settings: { concurrency: 4 },
    });
    assert.strictEqual(client.calls, 2 * 2 * 2);
    assert.strictEqual(r.results.length, 8);
    assert.strictEqual(r.perConfig.length, 2);
    const a = r.perConfig.find((c) => c.id === 'a');
    const b = r.perConfig.find((c) => c.id === 'b');
    assert.strictEqual(a.avgLatencyMs, 100);
    assert.strictEqual(b.avgLatencyMs, 200);
    assert.strictEqual(a.runs, 4);
    assert.ok(r.perConfig.every((c) => c.errorCount === 0));
  });

  await ta('runCompare 单条失败不影响其他配置统计', async () => {
    let call = 0;
    const client = mockClient(async () => {
      call++;
      if (call === 1) throw new Error('偶发失败');
      return { content: 'ok', usage: usage(5, 5), latencyMs: 10 };
    });
    const r = await runCompare({
      client,
      prompts: ['p1'],
      configs: [
        { id: 'a', label: 'A', model: 'deepseek-chat' },
        { id: 'b', label: 'B', model: 'deepseek-chat' },
      ],
      repeats: 1,
      settings: { concurrency: 1 },
    });
    assert.strictEqual(r.results.length, 2);
    const total = r.perConfig.reduce((acc, c) => acc + c.errorCount, 0);
    assert.strictEqual(total, 1);
    assert.strictEqual(r.perConfig.reduce((acc, c) => acc + c.okCount, 0), 1);
  });

  /* ==================== 结果 ==================== */

  console.log(`\n共 ${passed + failures.length} 组断言，通过 ${passed} 组`);
  if (failures.length) {
    for (const f of failures) console.error('✗ ' + f);
    process.exit(1);
  }
  console.log('✓ test-lab: 全部通过');
}

main().catch((err) => {
  console.error('✗ test-lab 运行异常:', err);
  process.exit(1);
});
