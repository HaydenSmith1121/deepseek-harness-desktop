'use strict';

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { SettingsStore } = require('./settings-store');
const { readJson, writeJson } = require('./json-store');
const api = require('./api-client');
const { costOf } = require('./stats');
const { runBatch, runCompare } = require('./batch-runner');

function registerIpc({ getWindow }) {
  const userDataPath = () => app.getPath('userData');
  const settings = new SettingsStore(path.join(userDataPath(), 'settings.json'));
  const conversationsFile = () => path.join(userDataPath(), 'conversations.json');

  const activeChats = new Map(); // conversationId -> AbortController
  const activeRuns = new Map(); // 'batch' | 'compare' -> AbortController

  function safeSend(channel, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  // ---------- app ----------
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    productName: 'DeepSeek Harness',
    userDataPath: userDataPath()
  }));
  ipcMain.handle('app:openDataDir', async () => shell.openPath(userDataPath()));

  // ---------- settings ----------
  ipcMain.handle('settings:get', () => settings.load());
  ipcMain.handle('settings:set', (_e, patch) => settings.patch(patch || {}));

  // ---------- models ----------
  ipcMain.handle('models:list', async () => {
    const s = await settings.load();
    return api.listModels({ baseUrl: s.baseUrl, apiKey: s.apiKey, timeoutMs: Math.min(s.timeoutMs, 30000) });
  });

  // ---------- conversations ----------
  ipcMain.handle('conversations:list', async () => {
    const list = await readJson(conversationsFile(), []);
    if (!Array.isArray(list)) return [];
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  });

  ipcMain.handle('conversations:save', async (_e, conversation) => {
    if (!conversation || !conversation.id) return { ok: false };
    const list = await readJson(conversationsFile(), []);
    const arr = Array.isArray(list) ? list : [];
    const i = arr.findIndex((c) => c.id === conversation.id);
    const record = { ...conversation, updatedAt: Date.now() };
    if (i >= 0) arr[i] = record;
    else arr.unshift(record);
    await writeJson(conversationsFile(), arr);
    return { ok: true };
  });

  ipcMain.handle('conversations:delete', async (_e, id) => {
    const list = await readJson(conversationsFile(), []);
    const arr = (Array.isArray(list) ? list : []).filter((c) => c.id !== id);
    await writeJson(conversationsFile(), arr);
    return { ok: true };
  });

  // ---------- chat (streaming) ----------
  ipcMain.handle('chat:send', async (_e, payload) => {
    const s = await settings.load();
    const { conversationId, messages, params = {} } = payload || {};
    if (!conversationId) return { ok: false, error: 'missing conversationId' };
    if (!s.apiKey) {
      safeSend('chat:error', { conversationId, message: '未配置 API Key，请先到「设置」页填写' });
      return { ok: false, error: 'no api key' };
    }
    if (activeChats.has(conversationId)) {
      return { ok: false, error: '该会话已有请求进行中' };
    }
    const controller = new AbortController();
    activeChats.set(conversationId, controller);
    const model = params.model || (s.defaults && s.defaults.model) || 'deepseek-chat';

    (async () => {
      const t0 = Date.now();
      try {
        const body = api.buildBody({
          model,
          messages,
          system: params.system,
          temperature: params.temperature,
          topP: params.topP,
          maxTokens: params.maxTokens,
          frequencyPenalty: params.frequencyPenalty,
          presencePenalty: params.presencePenalty,
          stop: params.stop,
          stream: true
        });
        const stream = api.createChatStream({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          body,
          timeoutMs: s.timeoutMs,
          signal: controller.signal
        });
        let usage = null;
        let finishReason = null;
        for await (const ev of stream) {
          if (ev.type === 'delta') {
            safeSend('chat:chunk', { conversationId, content: ev.content, reasoning: ev.reasoning });
          } else if (ev.type === 'usage') {
            usage = ev.usage;
          } else if (ev.type === 'finish') {
            finishReason = ev.finishReason;
          }
        }
        safeSend('chat:done', {
          conversationId,
          usage,
          finishReason,
          latencyMs: Date.now() - t0,
          cost: usage ? costOf(usage, model, s.prices) : 0
        });
      } catch (err) {
        safeSend('chat:error', {
          conversationId,
          message: err && err.message ? err.message : String(err),
          aborted: controller.signal.aborted
        });
      } finally {
        activeChats.delete(conversationId);
      }
    })();

    return { ok: true };
  });

  ipcMain.handle('chat:abort', (_e, conversationId) => {
    const c = activeChats.get(conversationId);
    if (c) c.abort();
    return { ok: true };
  });

  // ---------- batch ----------
  ipcMain.handle('batch:run', async (_e, payload) => {
    const s = await settings.load();
    if (!s.apiKey) return { error: '未配置 API Key，请先到「设置」页填写' };
    const { items, config } = payload || {};
    if (!Array.isArray(items) || !items.length) return { error: '没有可运行的测试项' };
    if (activeRuns.has('batch')) return { error: '已有批量任务进行中' };
    const controller = new AbortController();
    activeRuns.set('batch', controller);
    try {
      const out = await runBatch({
        client: api.makeClient(s),
        items,
        config,
        settings: s,
        signal: controller.signal,
        onProgress: (p) => safeSend('batch:progress', p)
      });
      return out;
    } finally {
      activeRuns.delete('batch');
    }
  });
  ipcMain.handle('batch:abort', () => {
    const c = activeRuns.get('batch');
    if (c) c.abort();
    return { ok: true };
  });

  // ---------- compare ----------
  ipcMain.handle('compare:run', async (_e, payload) => {
    const s = await settings.load();
    if (!s.apiKey) return { error: '未配置 API Key，请先到「设置」页填写' };
    const { prompts, configs, repeats } = payload || {};
    if (!Array.isArray(prompts) || !prompts.length) return { error: '没有可运行的 Prompt' };
    if (!Array.isArray(configs) || !configs.length) return { error: '没有对比配置' };
    if (activeRuns.has('compare')) return { error: '已有对比任务进行中' };
    const controller = new AbortController();
    activeRuns.set('compare', controller);
    try {
      const out = await runCompare({
        client: api.makeClient(s),
        prompts,
        configs,
        repeats: repeats || 1,
        settings: s,
        signal: controller.signal,
        onProgress: (p) => safeSend('compare:progress', p)
      });
      return out;
    } finally {
      activeRuns.delete('compare');
    }
  });
  ipcMain.handle('compare:abort', () => {
    const c = activeRuns.get('compare');
    if (c) c.abort();
    return { ok: true };
  });
}

module.exports = { registerIpc };
