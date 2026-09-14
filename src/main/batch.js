'use strict';

const { runWithConcurrency } = require('./scheduler');
const { buildBody, makeClient } = require('./api');
const { costOf, summarize, summarizeConfig } = require('./stats');

/**
 * Keyword-based pass judging. All keywords (case-insensitive substring)
 * must appear in the output. Empty keyword list => null (not scored).
 */
function judgePass(expectKeywords, output) {
  const kws = (Array.isArray(expectKeywords) ? expectKeywords : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (!kws.length) return null;
  const lower = String(output || '').toLowerCase();
  return kws.every((k) => lower.includes(k));
}

/** Parse `prompt | kw1,kw2` import lines. */
function parseImportLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const idx = raw.indexOf('|');
  if (idx === -1) return { prompt: raw, expectKeywords: [] };
  const prompt = raw.slice(0, idx).trim();
  const kws = raw
    .slice(idx + 1)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { prompt, expectKeywords: kws };
}

/**
 * Run a batch evaluation.
 * options:
 *   client    - api client (or mock) with .chat()
 *   items     - [{ id, prompt, expectKeywords }]
 *   config    - { model, temperature, topP, maxTokens, system, ... }
 *   settings  - { concurrency, retries, prices }
 *   signal    - AbortSignal
 *   onProgress - ({ done, total }) => void
 */
async function runBatch(options) {
  const { client, items = [], config = {}, settings = {}, signal, onProgress } = options;
  const concurrency = Math.max(1, Number(settings.concurrency) || 3);
  const retries = Math.max(0, Number(settings.retries) || 0);
  const startedAt = Date.now();

  const tasks = items.map((item, index) => async () => {
    if (signal && signal.aborted) {
      return { index, id: item.id ?? index, prompt: item.prompt, ok: false, error: 'aborted', skipped: true, usage: null, cost: 0, latencyMs: 0, passed: null };
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal && signal.aborted) break;
      const t0 = Date.now();
      try {
        const body = buildBody({
          model: config.model,
          messages: [{ role: 'user', content: String(item.prompt ?? '') }],
          system: config.system,
          temperature: config.temperature,
          topP: config.topP,
          maxTokens: config.maxTokens,
          stream: false
        });
        const r = await client.chat({ body });
        const cost = costOf(r.usage, config.model, settings.prices);
        return {
          index,
          id: item.id ?? index,
          prompt: item.prompt,
          expectKeywords: item.expectKeywords || [],
          ok: true,
          passed: judgePass(item.expectKeywords, r.content),
          content: r.content,
          reasoning: r.reasoning,
          usage: r.usage,
          cost,
          latencyMs: r.latencyMs != null ? r.latencyMs : Date.now() - t0,
          finishReason: r.finishReason
        };
      } catch (err) {
        lastError = err;
      }
    }
    return {
      index,
      id: item.id ?? index,
      prompt: item.prompt,
      expectKeywords: item.expectKeywords || [],
      ok: false,
      error: (lastError && lastError.message) || 'request failed',
      usage: null,
      cost: 0,
      latencyMs: 0,
      passed: null
    };
  });

  const results = await runWithConcurrency(tasks, concurrency, {
    signal,
    onTaskDone: (done, total) => onProgress && onProgress({ done, total })
  });

  // fill slots of tasks never dispatched (aborted before start)
  const filled = results.map((r, i) => r || {
    index: i,
    id: items[i] ? items[i].id : i,
    prompt: items[i] ? items[i].prompt : '',
    expectKeywords: (items[i] && items[i].expectKeywords) || [],
    ok: false,
    error: 'aborted',
    skipped: true,
    usage: null,
    cost: 0,
    latencyMs: 0,
    passed: null
  });

  return {
    results: filled,
    summary: summarize(filled),
    aborted: !!(signal && signal.aborted),
    durationMs: Date.now() - startedAt,
    model: config.model
  };
}

/**
 * Run a comparison: every config answers every prompt (repeated `repeats`).
 * options:
 *   client, prompts: string[], configs: [{id,label,model,temperature,topP,maxTokens,system}],
 *   repeats, settings, signal, onProgress
 */
async function runCompare(options) {
  const { client, prompts = [], configs = [], repeats = 1, settings = {}, signal, onProgress } = options;
  const concurrency = Math.max(1, Number(settings.concurrency) || 3);
  const reps = Math.max(1, Number(repeats) || 1);
  const startedAt = Date.now();

  const jobs = [];
  for (const cfg of configs) {
    for (let pi = 0; pi < prompts.length; pi++) {
      for (let rep = 0; rep < reps; rep++) {
        jobs.push({ cfg, pi, rep });
      }
    }
  }

  const tasks = jobs.map((job) => async () => {
    const t0 = Date.now();
    try {
      const body = buildBody({
        model: job.cfg.model,
        messages: [{ role: 'user', content: String(prompts[job.pi]) }],
        system: job.cfg.system,
        temperature: job.cfg.temperature,
        topP: job.cfg.topP,
        maxTokens: job.cfg.maxTokens,
        stream: false
      });
      const r = await client.chat({ body });
      return {
        configId: job.cfg.id,
        promptIndex: job.pi,
        repeat: job.rep,
        ok: true,
        content: r.content,
        reasoning: r.reasoning,
        usage: r.usage,
        cost: costOf(r.usage, job.cfg.model, settings.prices),
        latencyMs: r.latencyMs != null ? r.latencyMs : Date.now() - t0,
        finishReason: r.finishReason
      };
    } catch (err) {
      return {
        configId: job.cfg.id,
        promptIndex: job.pi,
        repeat: job.rep,
        ok: false,
        error: (err && err.message) || 'request failed',
        content: '',
        usage: null,
        cost: 0,
        latencyMs: Date.now() - t0
      };
    }
  });

  const results = await runWithConcurrency(tasks, concurrency, {
    signal,
    onTaskDone: (done, total) => onProgress && onProgress({ done, total })
  });

  const filled = results.map((r, i) => r || {
    configId: jobs[i].cfg.id,
    promptIndex: jobs[i].pi,
    repeat: jobs[i].rep,
    ok: false,
    error: 'aborted',
    skipped: true,
    content: '',
    usage: null,
    cost: 0,
    latencyMs: 0
  });

  const perConfig = configs.map((cfg) => summarizeConfig(cfg.id, cfg, filled));
  return {
    results: filled,
    perConfig,
    prompts,
    configs,
    aborted: !!(signal && signal.aborted),
    durationMs: Date.now() - startedAt
  };
}

/**
 * Parse a whole dataset text block into items.
 * One item per line; `#` starts a comment line; blank lines ignored.
 * Each line may carry inline expected keywords after `|` for auto scoring.
 */
function parseDataset(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => parseImportLine(line))
    .filter((it) => it && it.prompt)
    .map((it, i) => ({ id: i + 1, prompt: it.prompt, expectKeywords: it.expectKeywords }));
}

module.exports = { runBatch, runCompare, judgePass, parseImportLine, parseDataset };
