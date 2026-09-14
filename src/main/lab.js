'use strict';

/**
 * 评测台主进程模块：批量评测 / 模型对比。
 * 与对话（agent）完全独立，共用同一份 API Key 与 baseUrl 设置。
 */

const fs = require('fs');
const { dialog } = require('electron');
const api = require('./api');
const { runBatch, runCompare, parseDataset } = require('./batch');

const DEFAULT_TIMEOUT_MS = 180000;

function registerLabIpc({ ipcMain, getWin, getApiKey, store }) {
  /** runId -> AbortController */
  const runs = new Map();

  const emit = (runId, type, payload) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('lab:event', { runId, type, payload });
  };

  function makeClient() {
    const key = getApiKey();
    if (!key) throw new Error('尚未配置 DeepSeek API Key，请先在设置中填写');
    const s = store.all();
    return api.makeClient({
      baseUrl: s.baseUrl || api.DEFAULT_BASE_URL,
      apiKey: key,
      timeoutMs: Number(s.timeoutMs) || DEFAULT_TIMEOUT_MS,
    });
  }

  function prices() {
    const p = store.get('prices');
    return p && typeof p === 'object' ? p : undefined;
  }

  /** 统一的「后台跑 + 事件推送」包装 */
  function startRun(handler) {
    const runId = 'lab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const abort = new AbortController();
    runs.set(runId, abort);
    (async () => {
      try {
        const result = await handler(abort.signal, (progress) => emit(runId, 'progress', progress));
        emit(runId, 'done', result);
      } catch (err) {
        emit(runId, 'error', { message: (err && err.message) || String(err) });
      } finally {
        runs.delete(runId);
      }
    })();
    return { ok: true, runId };
  }

  ipcMain.handle('lab:models', async () => {
    try {
      const models = await makeClient().listModels();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('lab:run-batch', (_e, payload = {}) => {
    let client;
    try {
      client = makeClient();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const items = parseDataset(payload.text);
    if (!items.length) return { ok: false, error: '数据集为空，请至少填写一行提示词' };
    const config = payload.config || {};
    if (!config.model) return { ok: false, error: '请选择模型' };

    return startRun((signal, onProgress) =>
      runBatch({
        client,
        items,
        config,
        settings: {
          concurrency: payload.settings && payload.settings.concurrency,
          retries: payload.settings && payload.settings.retries,
          prices: prices(),
        },
        signal,
        onProgress,
      })
    );
  });

  ipcMain.handle('lab:run-compare', (_e, payload = {}) => {
    let client;
    try {
      client = makeClient();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const prompts = String(payload.text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!prompts.length) return { ok: false, error: '请至少填写一行提示词' };
    const configs = (Array.isArray(payload.configs) ? payload.configs : []).filter((c) => c && c.model);
    if (configs.length < 2) return { ok: false, error: '至少需要两个模型配置才能对比' };

    const repeats = Math.min(10, Math.max(1, Number(payload.repeats) || 1));

    return startRun((signal, onProgress) =>
      runCompare({
        client,
        prompts,
        configs,
        repeats,
        settings: {
          concurrency: payload.settings && payload.settings.concurrency,
          prices: prices(),
        },
        signal,
        onProgress,
      })
    );
  });

  ipcMain.handle('lab:stop', (_e, runId) => {
    const abort = runs.get(runId);
    if (abort) abort.abort();
    return { ok: true };
  });

  ipcMain.handle('lab:stop-all', () => {
    for (const abort of runs.values()) abort.abort();
    return { ok: true };
  });

  /** 读取数据集文件（txt / csv / jsonl 均可按行解析） */
  ipcMain.handle('lab:open-dataset', async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: '导入数据集',
      filters: [
        { name: '文本数据集', extensions: ['txt', 'csv', 'jsonl', 'md'] },
        { name: '全部文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      const text = fs.readFileSync(r.filePaths[0], 'utf8');
      return { ok: true, text, path: r.filePaths[0] };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /** 导出评测结果（json / csv） */
  ipcMain.handle('lab:export', async (_e, payload = {}) => {
    const format = payload.format === 'csv' ? 'csv' : 'json';
    const base = String(payload.defaultName || 'evaluation').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(getWin(), {
      title: '导出评测结果',
      defaultPath: `${base}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      const content =
        format === 'csv' ? toCsv(payload.result) : JSON.stringify(payload.result, null, 2);
      fs.writeFileSync(r.filePath, content, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(result) {
  const rows = (result && result.results) || [];
  const header = [
    '序号', '模型/配置', '提示词', '状态', '判定', '延迟(ms)', '输入tokens',
    '输出tokens', '命中缓存tokens', '成本(元)', '输出', '错误',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const u = r.usage || {};
    lines.push(
      [
        r.index !== undefined ? r.index + 1 : r.promptIndex !== undefined ? r.promptIndex + 1 : '',
        r.configId || result.model || '',
        r.prompt !== undefined ? r.prompt : (result.prompts && result.prompts[r.promptIndex]) || '',
        r.skipped ? '跳过' : r.ok === false || r.error ? '失败' : '成功',
        r.passed === null || r.passed === undefined ? '—' : r.passed ? '通过' : '未通过',
        Math.round(Number(r.latencyMs) || 0),
        u.promptTokens || 0,
        u.completionTokens || 0,
        u.cacheHitTokens || 0,
        Number(r.cost || 0).toFixed(6),
        r.content || '',
        r.error || '',
      ].map(csvCell).join(',')
    );
  }
  // 前置 BOM，Excel 打开中文不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = { registerLabIpc, toCsv };
