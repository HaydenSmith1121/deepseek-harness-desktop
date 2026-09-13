'use strict';

/**
 * Usage statistics and cost estimation (CNY).
 * DeepSeek pricing is per million tokens; cache-hit input tokens are much
 * cheaper than cache-miss input tokens. Defaults follow the official
 * published prices and are user-editable in Settings.
 */

const DEFAULT_PRICES = {
  'deepseek-chat': { cacheHit: 0.2, cacheMiss: 0.8, output: 2.0 },
  'deepseek-reasoner': { cacheHit: 0.5, cacheMiss: 2.0, output: 8.0 }
};

function priceFor(model, prices) {
  const m = String(model || 'deepseek-chat');
  if (prices && prices[m]) return prices[m];
  if (prices) {
    for (const [key, value] of Object.entries(prices)) {
      if (key && m.includes(key)) return value;
    }
  }
  return DEFAULT_PRICES[m] || DEFAULT_PRICES['deepseek-chat'];
}

/** Estimated cost in CNY for a normalized usage object. */
function costOf(usage, model, prices) {
  const u = usage || {};
  const price = priceFor(model, prices);
  const hit = (Number(u.cacheHitTokens) || 0) / 1e6 * Number(price.cacheHit);
  const miss = (Number(u.cacheMissTokens) || 0) / 1e6 * Number(price.cacheMiss);
  const out = (Number(u.completionTokens) || 0) / 1e6 * Number(price.output);
  return hit + miss + out;
}

function mean(list) {
  const arr = list.filter((v) => Number.isFinite(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(list) {
  return list.reduce((a, b) => a + (Number(b) || 0), 0);
}

/** Aggregate summary over batch results. */
function summarize(results) {
  const list = results || [];
  const scored = list.filter((r) => r.passed === true || r.passed === false);
  const passed = scored.filter((r) => r.passed === true).length;
  const okList = list.filter((r) => r.ok !== false && !r.error);
  const latencies = okList.map((r) => Number(r.latencyMs) || 0);
  const usages = okList.map((r) => r.usage).filter(Boolean);

  return {
    total: list.length,
    scored: scored.length,
    passed,
    failed: scored.length - passed,
    accuracy: scored.length ? passed / scored.length : null,
    apiErrors: list.filter((r) => r.error || r.ok === false).length,
    okCount: okList.length,
    avgLatencyMs: mean(latencies),
    minLatencyMs: latencies.length ? Math.min(...latencies) : null,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
    totalPromptTokens: sum(usages.map((u) => u.promptTokens)),
    totalCompletionTokens: sum(usages.map((u) => u.completionTokens)),
    totalTokens: sum(usages.map((u) => u.totalTokens)),
    totalCacheHitTokens: sum(usages.map((u) => u.cacheHitTokens)),
    avgCompletionTokens: mean(usages.map((u) => u.completionTokens)),
    totalCost: sum(list.map((r) => Number(r.cost) || 0)),
    avgCost: mean(list.map((r) => Number(r.cost) || 0))
  };
}

/** Per-config aggregate for comparison runs. */
function summarizeConfig(configId, config, results) {
  const list = (results || []).filter((r) => r.configId === configId);
  const okList = list.filter((r) => r.ok !== false && !r.error);
  return {
    id: configId,
    label: (config && config.label) || configId,
    model: config && config.model,
    temperature: config && config.temperature,
    maxTokens: config && config.maxTokens,
    runs: list.length,
    okCount: okList.length,
    errorCount: list.length - okList.length,
    avgLatencyMs: mean(okList.map((r) => Number(r.latencyMs) || 0)),
    avgTotalTokens: mean(okList.map((r) => r.usage && r.usage.totalTokens)),
    avgCompletionTokens: mean(okList.map((r) => r.usage && r.usage.completionTokens)),
    avgCost: mean(okList.map((r) => Number(r.cost) || 0)),
    totalCost: sum(list.map((r) => Number(r.cost) || 0)),
    avgOutputChars: mean(okList.map((r) => String(r.content || '').length))
  };
}

module.exports = { DEFAULT_PRICES, priceFor, costOf, mean, sum, summarize, summarizeConfig };
