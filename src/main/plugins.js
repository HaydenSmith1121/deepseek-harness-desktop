'use strict';

/**
 * 插件系统：把用户自定义的 HTTP 接口包装成模型的可用工具。
 *
 * 插件形态（持久化在 settings.json 的 plugins 数组里）：
 * {
 *   id, name, description,
 *   parameters: JSON Schema（OpenAI function 格式的 parameters）,
 *   method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
 *   url: 'https://host/path?q={{keyword}}',     // {{arg}} 会被参数替换（URL 里做 URL 编码）
 *   headers: '{"X-Token":"..."}',              // 可选，JSON 文本
 *   body: '{"query":"{{keyword}}"}'            // 可选，非 GET 时作为请求体，支持模板
 *   timeoutMs, enabled,
 * }
 */

const { truncate } = require('./tools');

/** 与内置工具重名会直接覆盖内置能力，必须禁止 */
const RESERVED_NAMES = new Set([
  'read_file', 'write_file', 'list_dir', 'run_command', 'search_files', 'web_fetch',
]);

const NAME_RX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const DEFAULT_PARAMETERS = { type: 'object', properties: {}, required: [] };
const MAX_TIMEOUT_MS = 120000;

function safeJsonParse(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 校验 & 归一化一个插件定义。
 * @returns {{ok: boolean, error?: string, plugin?: object}}
 */
function validatePlugin(input, { existing = [], selfId = null } = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: '插件定义必须是对象' };

  const name = String(input.name || '').trim();
  if (!NAME_RX.test(name)) {
    return { ok: false, error: '工具名只能由字母/数字/下划线组成，且不能以数字开头（如 weather_query）' };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `「${name}」是内置工具名，请换一个` };
  }
  const dup = existing.find((p) => p.name === name && p.id !== selfId);
  if (dup) return { ok: false, error: `已存在同名插件「${name}」` };

  const url = String(input.url || '').trim();
  if (!url) return { ok: false, error: '请填写接口地址' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' };

  const method = String(input.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { ok: false, error: '请求方式只支持 GET / POST / PUT / PATCH / DELETE' };
  }

  const parameters = safeJsonParse(input.parameters, null);
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') {
    return { ok: false, error: '参数 Schema 必须是形如 {"type":"object","properties":{...}} 的 JSON' };
  }

  let headers = '';
  if (input.headers !== undefined && input.headers !== null && String(input.headers).trim() !== '') {
    const h = safeJsonParse(input.headers, null);
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      return { ok: false, error: '请求头必须是 JSON 对象，例如 {"X-Api-Key":"..."}' };
    }
    headers = JSON.stringify(h);
  }

  let body = '';
  if (input.body !== undefined && input.body !== null && String(input.body).trim() !== '') {
    body = String(input.body);
  }

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(input.timeoutMs) || 30000)
  );

  return {
    ok: true,
    plugin: {
      id: selfId || input.id || ('plg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
      name,
      description: String(input.description || '').trim() || `调用 ${name}`,
      parameters,
      method,
      url,
      headers,
      body,
      timeoutMs,
      enabled: input.enabled === undefined ? true : !!input.enabled,
    },
  };
}

/** 插件 → OpenAI function schema */
function pluginSchema(p) {
  return {
    type: 'function',
    function: {
      name: p.name,
      description: p.description,
      parameters: p.parameters || DEFAULT_PARAMETERS,
    },
  };
}

/** {{arg}} 模板替换；encode=true 时做 URL 编码（用于拼 URL） */
function applyTemplate(text, args, encode) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w$.[\]-]+)\s*\}\}/g, (_m, key) => {
    const v = args[key];
    if (v === undefined || v === null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

function findPlugin(plugins, name) {
  return (plugins || []).find((p) => p.enabled && p.name === name) || null;
}

/** 执行一个插件调用，返回给模型的文本结果 */
async function runPlugin(plugin, call) {
  let args = {};
  try {
    args = JSON.parse((call.function && call.function.arguments) || '{}');
  } catch (err) {
    throw new Error(`插件参数不是合法 JSON: ${err.message}`);
  }

  const url = applyTemplate(plugin.url, args, true);
  const headers = safeJsonParse(plugin.headers, {}) || {};
  const method = (plugin.method || 'GET').toUpperCase();

  let body;
  if (method !== 'GET' && method !== 'DELETE' && plugin.body) {
    body = applyTemplate(plugin.body, args, false);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(plugin.timeoutMs || 30000),
    redirect: 'follow',
  });
  const text = await res.text();
  const head = `${plugin.name} → HTTP ${res.status} ${res.headers.get('content-type') || ''}`;
  return truncate(`${head}\n\n${text}`);
}

module.exports = {
  RESERVED_NAMES,
  DEFAULT_PARAMETERS,
  validatePlugin,
  pluginSchema,
  applyTemplate,
  findPlugin,
  runPlugin,
};
