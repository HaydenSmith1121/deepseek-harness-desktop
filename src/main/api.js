'use strict';

/**
 * OpenAI 兼容端点的公共部分。
 *
 * 服务商适配说明（重要）：
 * 本文件里的 baseUrl 一律**保留**结尾的 `/v1` —— 绝大多数第三方 OpenAI 兼容
 * 服务（OpenAI / Moonshot / 智谱 / 通义兼容模式 / OpenRouter / Ollama …）都必须
 * 带 `/v1` 才能命中接口，只有 DeepSeek 官方同时接受带与不带。因此这里只做
 * 「去尾部斜杠」与「去多余的 /chat/completions 后缀」两件事。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 30000;

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
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  return u;
}

function buildHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function combineSignals(timeoutMs, external) {
  const signals = [];
  if (external) signals.push(external);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
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

/**
 * 拉取某个服务商可用模型列表。
 * @returns {Promise<string[]>} 模型 id 数组
 */
async function listModels({ baseUrl, apiKey, timeoutMs, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${base}/models`, {
    method: 'GET',
    headers: buildHeaders(apiKey),
    signal: combineSignals(timeoutMs || DEFAULT_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return list
    .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || ''))
    .filter(Boolean);
}

module.exports = {
  ApiError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  normalizeBaseUrl,
  buildHeaders,
  combineSignals,
  toApiError,
  listModels,
};
