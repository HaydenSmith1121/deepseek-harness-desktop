'use strict';

/**
 * DeepSeek API client (main process).
 * OpenAI-compatible endpoints of DeepSeek:
 *   POST {base}/chat/completions
 *   GET  {base}/models
 * Streaming follows SSE with `data: {...}` lines and `data: [DONE]` terminator.
 * DeepSeek specific fields:
 *   - delta.reasoning_content (deepseek-reasoner chain of thought)
 *   - usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   - stream_options: { include_usage: true } makes the last chunk carry usage
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const REASONER_UNSUPPORTED = new Set([
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty'
]);

class ApiError extends Error {
  constructor(status, message, code) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseUrl(url) {
  let u = String(url || '').trim() || DEFAULT_BASE_URL;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/, '');
  u = u.replace(/\/v1$/, '');
  return u;
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

/**
 * Build the request body. Sanitizes params:
 * - drops empty values
 * - drops params unsupported by deepseek-reasoner
 * - prepends system message when given
 * - enables stream_options.include_usage for streams (DeepSeek specific)
 */
function buildBody(params) {
  const messages = Array.isArray(params.messages) ? params.messages.slice() : [];
  if (params.system && !messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: String(params.system) });
  }
  const body = {
    model: params.model,
    messages,
    stream: !!params.stream
  };
  if (body.stream) body.stream_options = { include_usage: true };
  const isReasoner = /reasoner/i.test(String(params.model || ''));
  // camelCase in, snake_case out (matches DeepSeek/OpenAI request schema)
  const numericParams = [
    ['temperature', 'temperature'],
    ['topP', 'top_p'],
    ['maxTokens', 'max_tokens'],
    ['frequencyPenalty', 'frequency_penalty'],
    ['presencePenalty', 'presence_penalty']
  ];
  for (const [srcKey, apiKey] of numericParams) {
    const v = params[srcKey];
    if (v === undefined || v === null || v === '') continue;
    if (isReasoner && REASONER_UNSUPPORTED.has(apiKey)) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    body[apiKey] = num;
  }
  if (Array.isArray(params.stop) && params.stop.length) body.stop = params.stop.map(String);
  else if (typeof params.stop === 'string' && params.stop.trim()) {
    body.stop = params.stop.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return body;
}

/**
 * Extract complete SSE events from a buffer.
 * Returns { events, rest, done } where events are parsed JSON payloads,
 * rest is the unconsumed tail, done=true after `data: [DONE]`.
 */
function extractSseEvents(buf) {
  const events = [];
  let rest = String(buf).replace(/\r\n/g, '\n');
  let done = false;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      try {
        events.push(JSON.parse(data));
      } catch {
        /* tolerate malformed lines */
      }
    }
    if (done) break;
  }
  return { events, rest, done };
}

function normalizeUsage(u) {
  const usage = u || {};
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cacheHit = Number(usage.prompt_cache_hit_tokens) || 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(usage.total_tokens) || prompt + completion,
    cacheHitTokens: cacheHit,
    cacheMissTokens:
      usage.prompt_cache_miss_tokens !== undefined
        ? Number(usage.prompt_cache_miss_tokens) || 0
        : // 未上报未命中数时保守按「全部未命中」估算（命中为 0 时即等于 prompt）
          Math.max(0, prompt - cacheHit)
  };
}

async function toApiError(res) {
  let message = `HTTP ${res.status}`;
  let code;
  try {
    const j = await res.json();
    message = (j.error && j.error.message) || j.message || message;
    code = j.error && j.error.code;
  } catch {
    /* keep default */
  }
  return new ApiError(res.status, message, code);
}

function combineSignals(timeoutMs, external) {
  const signals = [];
  if (external) signals.push(external);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function listModels({ baseUrl, apiKey, timeoutMs, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${base}/models`, {
    method: 'GET',
    headers: buildHeaders(apiKey),
    signal: combineSignals(timeoutMs, signal)
  });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  const list = Array.isArray(data.data) ? data.data : [];
  return list.map((m) => ({ id: m.id, object: m.object }));
}

/**
 * Non-streaming chat completion. Returns
 * { content, reasoning, usage, finishReason, latencyMs, raw }
 */
async function chat({ baseUrl, apiKey, body, timeoutMs, signal, t0 }) {
  const base = normalizeBaseUrl(baseUrl);
  const started = t0 || Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ ...body, stream: false }),
    signal: combineSignals(timeoutMs, signal)
  });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || '',
    usage: normalizeUsage(data.usage),
    finishReason: choice.finish_reason || null,
    latencyMs: Date.now() - started,
    raw: { id: data.id, model: data.model, created: data.created }
  };
}

/**
 * Streaming chat completion. Async generator yielding:
 *   { type: 'delta', content, reasoning }
 *   { type: 'finish', finishReason }
 *   { type: 'usage', usage }
 */
async function* createChatStream({ baseUrl, apiKey, body, timeoutMs, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: combineSignals(timeoutMs, signal)
  });
  if (!res.ok) throw await toApiError(res);
  if (!res.body) {
    const data = await res.json();
    const choice = (data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    if (msg.content || msg.reasoning_content) {
      yield { type: 'delta', content: msg.content || '', reasoning: msg.reasoning_content || '' };
    }
    if (data.usage) yield { type: 'usage', usage: normalizeUsage(data.usage) };
    if (choice.finish_reason) yield { type: 'finish', finishReason: choice.finish_reason };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parsed = extractSseEvents(buf);
    buf = parsed.rest;
    for (const ev of parsed.events) {
      if (ev.usage) yield { type: 'usage', usage: normalizeUsage(ev.usage) };
      const choice = ev.choices && ev.choices[0];
      if (choice) {
        const delta = choice.delta || {};
        const content = delta.content || '';
        const reasoning = delta.reasoning_content || '';
        if (content || reasoning) yield { type: 'delta', content, reasoning };
        if (choice.finish_reason) yield { type: 'finish', finishReason: choice.finish_reason };
      }
    }
    if (parsed.done) finished = true;
  }
}

function makeClient(settings) {
  const ctx = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    timeoutMs: settings.timeoutMs
  };
  return {
    chat: (opts) =>
      chat({
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey,
        timeoutMs: ctx.timeoutMs,
        ...opts
      }),
    stream: (opts) =>
      createChatStream({
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey,
        timeoutMs: ctx.timeoutMs,
        ...opts
      }),
    listModels: (opts) =>
      listModels({
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey,
        timeoutMs: ctx.timeoutMs,
        ...opts
      })
  };
}

module.exports = {
  ApiError,
  DEFAULT_BASE_URL,
  REASONER_UNSUPPORTED,
  normalizeBaseUrl,
  buildHeaders,
  buildBody,
  extractSseEvents,
  normalizeUsage,
  chat,
  createChatStream,
  listModels,
  makeClient
};
