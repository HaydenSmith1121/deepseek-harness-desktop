'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const api = require('./api');
const { Store } = require('./store');
const { createTools, isInside } = require('./tools');
const { runAgentLoop, realTransport, buildSystemPrompt, AbortError } = require('./agent');
const { validatePlugin, pluginSchema, findPlugin, runPlugin } = require('./plugins');

const isSmoke = process.argv.includes('--smoke');
const isScreenshot = process.argv.includes('--screenshot');
const isScreenshotPlugins = process.argv.includes('--screenshot-plugins');
const themeArg = (process.argv.find((a) => a.startsWith('--theme=')) || '').split('=')[1];

const THEME_BG = { dark: '#0e1016', light: '#f6f7fb' };

// 虚拟机 / 远程桌面等无 GPU 环境的兼容兜底
app.disableHardwareAcceleration();

let win = null;
let store = null;
let tools = null;
/** runId -> { abort: AbortController, approvals: Map<callId, {resolve, timer}> } */
const runs = new Map();

function currentWorkspace() {
  return store.get('workspace');
}

function currentTheme() {
  return store.get('theme') === 'light' ? 'light' : 'dark';
}

/* ==================== 密钥加解密 ==================== */

function decryptKey(enc, plain) {
  if (!enc) return null;
  if (!plain && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }
  try {
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return { keyEnc: safeStorage.encryptString(key).toString('base64'), keyPlain: false };
  }
  // 加密服务不可用（少见）时降级为 base64 存储，并在 UI 标注
  return { keyEnc: Buffer.from(key, 'utf8').toString('base64'), keyPlain: true };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

/* ==================== 模型服务商 ==================== */

const BUILTIN_PRESETS = {
  deepseek: { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  moonshot: { label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'] },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air'] },
  dashscope: { label: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  siliconflow: { label: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3'] },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat'] },
  ollama: { label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'] },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] },
};

const PROVIDER_ID_RX = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 首次运行时把旧版单服务商设置迁移成 providers 数组 */
function ensureProviders() {
  let list = store.get('providers');
  if (Array.isArray(list) && list.length) {
    if (!list.some((p) => p.id === store.get('activeProviderId'))) {
      store.set({ activeProviderId: list[0].id });
    }
    return list;
  }
  list = [{
    id: 'deepseek',
    label: BUILTIN_PRESETS.deepseek.label,
    preset: 'deepseek',
    baseUrl: api.normalizeBaseUrl(store.get('baseUrl') || api.DEFAULT_BASE_URL),
    keyEnc: store.get('apiKeyEnc') || null,
    keyPlain: !!store.get('apiKeyPlain'),
    models: BUILTIN_PRESETS.deepseek.models.slice(),
  }];
  store.set({ providers: list, activeProviderId: 'deepseek' });
  return list;
}

function activeProvider() {
  const list = ensureProviders();
  return list.find((p) => p.id === store.get('activeProviderId')) || list[0];
}

function getProviderKey(provider) {
  if (!provider) return null;
  return decryptKey(provider.keyEnc, provider.keyPlain);
}

function publicProvider(p) {
  const key = getProviderKey(p);
  return {
    id: p.id,
    label: p.label || p.id,
    preset: p.preset || 'custom',
    baseUrl: p.baseUrl || '',
    models: Array.isArray(p.models) ? p.models : [],
    hasApiKey: !!key,
    apiKeyMasked: key ? maskKey(key) : '',
    apiKeyPlain: !!p.keyPlain,
  };
}

function publicSettings() {
  const ap = activeProvider();
  const key = getProviderKey(ap);
  return {
    model: store.get('model'),
    temperature: store.get('temperature'),
    maxTokens: store.get('maxTokens'),
    workspace: store.get('workspace'),
    approvalMode: store.get('approvalMode'),
    timeoutMs: store.get('timeoutMs') || 180000,
    theme: currentTheme(),
    activeProviderId: ap.id,
    activeProvider: publicProvider(ap),
    hasApiKey: !!key,
    apiKeyMasked: key ? maskKey(key) : '',
    apiKeyPlain: !!ap.keyPlain,
    pluginCount: (store.get('plugins') || []).length,
  };
}

/* ==================== 工具（内置 + 插件）==================== */

function enabledPlugins() {
  return (store.get('plugins') || []).filter((p) => p.enabled);
}

function buildToolset() {
  return tools.schemas.concat(enabledPlugins().map(pluginSchema));
}

async function executeToolCall(call) {
  const name = call.function.name;
  if (tools.has(name)) return tools.execute(call);
  const plugin = findPlugin(store.get('plugins') || [], name);
  if (plugin) return runPlugin(plugin, call);
  throw new Error(`未知工具: ${name}`);
}

/* ==================== 审批 ==================== */

function needsApprovalFor(mode) {
  return (call) => {
    if (mode === 'confirm-all') return true;
    if (mode === 'auto') return false;
    const name = call.function.name;
    if (name === 'run_command') return true;
    if (name === 'write_file') {
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const fp = path.resolve(currentWorkspace(), args.path || '.');
        return !isInside(currentWorkspace(), fp);
      } catch {
        return true;
      }
    }
    // 插件工具：只读 GET 放行，会改远端数据的请求要确认
    const plugin = findPlugin(store.get('plugins') || [], name);
    if (plugin) return String(plugin.method || 'GET').toUpperCase() !== 'GET';
    return false;
  };
}

function requestApproval(runId, call) {
  const run = runs.get(runId);
  if (!run) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.approvals.delete(call.id);
      resolve(false); // 10 分钟未响应视为拒绝
    }, 10 * 60 * 1000);
    run.approvals.set(call.id, { resolve, timer });
  });
}

/* ==================== IPC ==================== */

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:set', (_e, partial) => {
    const allowed = ['model', 'temperature', 'maxTokens', 'workspace', 'approvalMode', 'theme', 'timeoutMs', 'activeProviderId'];
    const patch = {};
    for (const k of allowed) {
      if (partial && k in partial) patch[k] = partial[k];
    }
    if (patch.temperature != null) patch.temperature = Math.min(2, Math.max(0, Number(patch.temperature)));
    if (patch.maxTokens != null) patch.maxTokens = Math.min(32768, Math.max(512, Number(patch.maxTokens)));
    if (patch.timeoutMs != null) patch.timeoutMs = Math.min(600000, Math.max(10000, Number(patch.timeoutMs)));
    if (patch.theme != null) patch.theme = patch.theme === 'light' ? 'light' : 'dark';
    if (patch.model != null) {
      const m = String(patch.model).trim();
      if (!m) delete patch.model;
      else patch.model = m;
    }
    if (patch.activeProviderId != null) {
      if (!ensureProviders().some((p) => p.id === patch.activeProviderId)) delete patch.activeProviderId;
    }
    store.set(patch);
    return { ok: true, settings: publicSettings() };
  });

  ipcMain.handle('dialog:pick-workspace', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择智能体工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    store.set({ workspace: r.filePaths[0] });
    return { ok: true, workspace: r.filePaths[0] };
  });

  // ---------------- 模型服务商 ----------------

  ipcMain.handle('providers:list', () => ({
    providers: ensureProviders().map(publicProvider),
    activeProviderId: store.get('activeProviderId'),
  }));

  ipcMain.handle('providers:save', (_e, payload) => {
    const input = payload || {};
    const list = ensureProviders();
    const editing = input.id ? list.find((p) => p.id === input.id) : null;

    const label = String(input.label || '').trim();
    if (!label) return { ok: false, error: '请填写服务商名称' };

    let baseUrl;
    try {
      baseUrl = api.normalizeBaseUrl(input.baseUrl);
    } catch {
      return { ok: false, error: '接口地址不合法' };
    }
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' };

    // models 传了就用传的（允许清空），没传则沿用旧值
    const models = Array.isArray(input.models)
      ? input.models.map((m) => String(m).trim()).filter(Boolean).slice(0, 200)
      : null;

    let id = editing ? editing.id : String(input.id || '').toLowerCase();
    if (!editing) {
      if (!PROVIDER_ID_RX.test(id)) {
        id = 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      }
      if (list.some((p) => p.id === id)) {
        id = id + '-' + Math.random().toString(36).slice(2, 4);
      }
    }

    const next = {
      id,
      label,
      preset: String(input.preset || 'custom'),
      baseUrl,
      keyEnc: editing ? editing.keyEnc : null,
      keyPlain: editing ? editing.keyPlain : false,
      models: models !== null ? models : (editing && editing.models) || [],
    };
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      Object.assign(next, encryptKey(input.apiKey.trim()));
    }

    const out = editing ? list.map((p) => (p.id === id ? next : p)) : list.concat(next);
    store.set({ providers: out });
    if (!editing && (!store.get('activeProviderId') || out.length === 1)) {
      store.set({ activeProviderId: id });
    }
    return { ok: true, provider: publicProvider(next), settings: publicSettings() };
  });

  ipcMain.handle('providers:delete', (_e, id) => {
    const list = ensureProviders();
    if (list.length <= 1) return { ok: false, error: '至少要保留一个服务商' };
    const out = list.filter((p) => p.id !== id);
    store.set({ providers: out });
    if (store.get('activeProviderId') === id) {
      store.set({ activeProviderId: out[0].id });
    }
    return { ok: true, settings: publicSettings() };
  });

  ipcMain.handle('providers:activate', (_e, id) => {
    const list = ensureProviders();
    const p = list.find((x) => x.id === id);
    if (!p) return { ok: false, error: '服务商不存在' };
    const patch = { activeProviderId: id };
    // 切服务商时若当前模型不在新服务商的模型列表里，自动切到第一个
    const model = store.get('model');
    const models = Array.isArray(p.models) ? p.models : [];
    if (models.length && !models.includes(model)) patch.model = models[0];
    store.set(patch);
    return { ok: true, settings: publicSettings() };
  });

  ipcMain.handle('providers:set-key', (_e, payload) => {
    const { id, apiKey } = payload || {};
    const list = ensureProviders();
    const p = list.find((x) => x.id === id);
    if (!p) return { ok: false, error: '服务商不存在' };
    const key = String(apiKey || '').trim();
    if (!key) return { ok: false, error: 'Key 不能为空' };
    Object.assign(p, encryptKey(key));
    store.set({ providers: list });
    return { ok: true, settings: publicSettings() };
  });

  // 支持两种入参：字符串 id（用已保存的配置）或 { id, baseUrl, apiKey }（编辑弹窗里试拉取）
  ipcMain.handle('providers:models', async (_e, payload) => {
    const req = typeof payload === 'string' ? { id: payload } : (payload || {});
    const list = ensureProviders();
    const p = req.id ? list.find((x) => x.id === req.id) : null;

    const baseUrl = req.baseUrl || (p && p.baseUrl);
    if (!baseUrl) return { ok: false, error: '缺少接口地址' };
    const apiKey = (req.apiKey && String(req.apiKey).trim()) || getProviderKey(p);
    if (!apiKey) return { ok: false, error: '请先填写该服务商的 API Key' };

    try {
      const models = await api.listModels({ baseUrl, apiKey, timeoutMs: 20000 });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // ---------------- 会话 ----------------

  ipcMain.handle('sessions:list', () => store.listSessions());

  ipcMain.handle('sessions:create', (_e, folderId) => {
    const s = store.createSession(folderId || null);
    return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: 0, folderId: s.folderId, archived: false };
  });

  ipcMain.handle('sessions:get', (_e, id) => {
    const s = store.getSession(id);
    if (!s) return null;
    return { id: s.id, title: s.title, folderId: s.folderId || null, archived: !!s.archived, messages: s.messages || [] };
  });

  ipcMain.handle('sessions:rename', (_e, { id, title }) => ({ ok: store.renameSession(id, title) }));

  ipcMain.handle('sessions:delete', (_e, id) => ({ ok: store.deleteSession(id) }));

  ipcMain.handle('sessions:move', (_e, { id, folderId }) => ({ ok: store.moveSession(id, folderId || null) }));

  ipcMain.handle('sessions:archive', (_e, { id, archived }) => ({ ok: store.setSessionArchived(id, archived) }));

  // ---------------- 文件夹 ----------------

  ipcMain.handle('folders:list', () => store.listFolders());

  ipcMain.handle('folders:create', (_e, name) => ({ ok: true, folder: store.createFolder(name) }));

  ipcMain.handle('folders:rename', (_e, { id, name }) => ({ ok: store.renameFolder(id, name) }));

  ipcMain.handle('folders:delete', (_e, id) => ({ ok: store.deleteFolder(id) }));

  // ---------------- 插件 ----------------

  ipcMain.handle('plugins:list', () => ({
    plugins: store.get('plugins') || [],
    builtin: tools.schemas.map((s) => s.function),
  }));

  ipcMain.handle('plugins:save', (_e, input) => {
    const list = store.get('plugins') || [];
    const selfId = input && input.id ? input.id : null;
    const r = validatePlugin(input, { existing: list, selfId });
    if (!r.ok) return r;
    const out = selfId
      ? list.map((p) => (p.id === selfId ? r.plugin : p))
      : list.concat(r.plugin);
    store.set({ plugins: out });
    return { ok: true, plugin: r.plugin, plugins: out };
  });

  ipcMain.handle('plugins:delete', (_e, id) => {
    const list = store.get('plugins') || [];
    store.set({ plugins: list.filter((p) => p.id !== id) });
    return { ok: true };
  });

  ipcMain.handle('plugins:set-enabled', (_e, { id, enabled }) => {
    const list = store.get('plugins') || [];
    const out = list.map((p) => (p.id === id ? { ...p, enabled: !!enabled } : p));
    store.set({ plugins: out });
    return { ok: true, plugins: out };
  });

  ipcMain.handle('plugins:import', (_e, payload) => {
    let incoming = payload;
    if (typeof incoming === 'string') {
      try {
        incoming = JSON.parse(incoming);
      } catch (err) {
        return { ok: false, error: 'JSON 解析失败: ' + err.message };
      }
    }
    if (incoming && !Array.isArray(incoming) && Array.isArray(incoming.plugins)) {
      incoming = incoming.plugins;
    }
    if (!Array.isArray(incoming)) return { ok: false, error: '导入内容应为插件数组，或 { "plugins": [...] }' };

    const list = (store.get('plugins') || []).slice();
    const added = [];
    const errors = [];
    for (const raw of incoming) {
      const r = validatePlugin(raw, { existing: list, selfId: null });
      if (!r.ok) {
        errors.push(`${(raw && raw.name) || '(未命名)'}: ${r.error}`);
        continue;
      }
      list.push(r.plugin);
      added.push(r.plugin.name);
    }
    if (added.length) store.set({ plugins: list });
    return { ok: added.length > 0, added, errors, error: added.length ? undefined : (errors[0] || '没有可导入的插件') };
  });

  // ---------------- 智能体 ----------------

  ipcMain.handle('agent:start', (_e, { sessionId, text }) => {
    const session = store.getSession(sessionId);
    if (!session) return { ok: false, error: '会话不存在' };
    const ap = activeProvider();
    const apiKey = getProviderKey(ap);
    if (!apiKey) {
      return { ok: false, error: `尚未配置「${ap.label}」的 API Key，请先在设置中填写` };
    }
    const textStr = String(text || '').trim();
    if (!textStr) return { ok: false, error: '消息不能为空' };

    const settings = store.all();
    session.messages.push({ role: 'user', content: textStr });
    const userCount = session.messages.filter((m) => m.role === 'user').length;
    const title = userCount === 1 ? textStr.slice(0, 30) : session.title;
    store.saveSession(sessionId, session.messages, title);

    const runId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const abort = new AbortController();
    runs.set(runId, { abort, approvals: new Map() });

    const emit = (type, payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', { runId, sessionId, type, payload });
      }
      // 关键节点即时落盘，防止崩溃丢消息
      if (type === 'tool-result' || type === 'assistant-message') {
        store.saveSession(sessionId, session.messages, title);
      }
    };

    (async () => {
      try {
        const apiMessages = [
          { role: 'system', content: buildSystemPrompt({ workspace: currentWorkspace(), platform: process.platform }) },
          ...session.messages,
        ];
        const result = await runAgentLoop({
          apiMessages,
          tools: buildToolset(),
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          apiKey,
          baseUrl: ap.baseUrl,
          emit,
          signal: abort.signal,
          transport: realTransport,
          needsApproval: needsApprovalFor(settings.approvalMode),
          requestApproval: (call) => requestApproval(runId, call),
          executeTool: (call) => executeToolCall(call),
        });
        session.messages = apiMessages.slice(1);
        store.saveSession(sessionId, session.messages, title);
        emit('run-end', { usage: result.usage, steps: result.steps, sessionId });
      } catch (err) {
        if (err instanceof AbortError || (err && err.name === 'AbortError')) {
          emit('run-end', { aborted: true, sessionId });
        } else {
          emit('run-error', { message: (err && err.message) || String(err), sessionId });
        }
      } finally {
        runs.delete(runId);
      }
    })();

    return { ok: true, runId };
  });

  ipcMain.handle('agent:stop', (_e, runId) => {
    const run = runs.get(runId);
    if (run) run.abort.abort();
    return { ok: true };
  });

  ipcMain.handle('agent:approval', (_e, { runId, callId, approved }) => {
    const run = runs.get(runId);
    const p = run && run.approvals.get(callId);
    if (p) {
      clearTimeout(p.timer);
      run.approvals.delete(callId);
      p.resolve(!!approved);
    }
    return { ok: true };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
  }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: THEME_BG[currentTheme()],
    autoHideMenuBar: true,
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  // 默认工作区：用户目录下的专用文件夹
  const defaultWorkspace = path.join(app.getPath('home'), 'DeepSeekHarnessWorkspace');
  store = new Store(app.getPath('userData'));
  if (!store.get('workspace')) {
    try {
      fs.mkdirSync(defaultWorkspace, { recursive: true });
      store.set({ workspace: defaultWorkspace });
    } catch {
      store.set({ workspace: app.getPath('home') });
    }
  }
  ensureProviders();
  tools = createTools({ workspace: currentWorkspace });
  registerIpc();
  const w = createWindow();

  if (isSmoke) {
    w.webContents.on('render-process-gone', (_e, details) => {
      console.error('SMOKE_FAIL render-process-gone:', details.reason);
      app.exit(1);
    });
    w.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        console.log('SMOKE_OK');
        app.quit();
      }, 1000);
    });
    setTimeout(() => {
      // 兜底：加载异常卡住也给出失败信号
      if (!win || win.isDestroyed()) return;
      console.error('SMOKE_FAIL timeout');
      app.exit(1);
    }, 15000);
  }

  if (isScreenshot || isScreenshotPlugins) {
    const demoFn = isScreenshotPlugins ? '__loadPluginsDemo' : '__loadDemo';
    const outName = isScreenshotPlugins ? 'screenshot-plugins.png' : 'screenshot.png';
    // 打包后 app.getAppPath() 是 resources/app.asar（文件），其下不可写 → 落到 userData
    const shotDir = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), 'docs');
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.error(`[renderer] ${sourceId}:${line} ${message}`);
    });
    w.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (themeArg) {
            await w.webContents.executeJavaScript(`window.__setTheme && window.__setTheme('${themeArg}')`, true);
            await new Promise((r) => setTimeout(r, 200));
          }
          await w.webContents.executeJavaScript(`window.${demoFn} && window.${demoFn}()`, true);
          await new Promise((r) => setTimeout(r, 1500));
          const img = await w.webContents.capturePage();
          fs.mkdirSync(shotDir, { recursive: true });
          const out = path.join(shotDir, outName);
          fs.writeFileSync(out, img.toPNG());
          console.log('SCREENSHOT_OK ' + out);
        } catch (err) {
          console.error('SCREENSHOT_FAIL', err);
          app.exit(1);
          return;
        }
        app.quit();
      }, 1200);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
