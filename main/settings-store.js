'use strict';

const { readJson, writeJson } = require('./json-store');

const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 120000,
  concurrency: 3,
  retries: 1,
  prices: {
    'deepseek-chat': { cacheHit: 0.2, cacheMiss: 0.8, output: 2.0 },
    'deepseek-reasoner': { cacheHit: 0.5, cacheMiss: 2.0, output: 8.0 }
  },
  defaults: {
    model: 'deepseek-chat',
    temperature: 1.0,
    topP: 1.0,
    maxTokens: 2048,
    system: ''
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  async load() {
    if (this.data) return this.data;
    const loaded = await readJson(this.filePath, null);
    this.data = deepMerge(structuredClone(DEFAULT_SETTINGS), loaded || {});
    return this.data;
  }

  async patch(patch) {
    await this.load();
    this.data = deepMerge(this.data, patch || {});
    await writeJson(this.filePath, this.data);
    return structuredClone(this.data);
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, deepMerge };
