'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { createTools, isInside } = require('./tools');
const { runAgentLoop, realTransport, buildSystemPrompt, AbortError } = require('./agent');

const isSmoke = process.argv.includes('--smoke');
const isScreenshot = process.argv.includes('--screenshot');

let win = null;
let store = null;
let tools = null;
/** runId -> { abort: AbortController, approvals: Map<callId, {resolve, timer}> } */
const runs = new Map();

function currentWorkspace() {
  return store.get('workspace');
}

function getApiKey() {
  const enc = store.get('apiKeyEnc');
  if (!enc) return null;
  if (!store.get('apiKeyPlain') && safeStorage.isEncryptionAvailable()) {
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

function setApiKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    store.set({
      apiKeyEnc: safeStorage.encryptString(key).toString('base64'),
      apiKeyPlain: false,
    });
    return { encrypted: true };
  }
  // 加密服务不可用（少见）时降级为 base64 存储，并在 UI 标注
  store.set({
    apiKeyEnc: Buffer.from(key, 'utf8').toString('base64'),
    apiKeyPlain: true,
  });
  return { encrypted: false };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

function publicSettings() {
  const key = getApiKey();
  return {
    model: store.get('model'),
    temperature: store.get('temperature'),
    maxTokens: store.get('maxTokens'),
    baseUrl: store.get('baseUrl'),
    workspace: store.get('workspace'),
    approvalMode: store.get('approvalMode'),
    hasApiKey: !!key,
    apiKeyMasked: key ? maskKey(key) : '',
    apiKeyPlain: !!store.get('apiKeyPlain'),
  };
}

function needsApprovalFor(mode) {
  return (call) => {
    if (mode === 'confirm-all') return true;
    const name = call.function.name;
    if (name === 'run_command') return mode !== 'auto';
    if (name === 'write_file' && mode !== 'auto') {
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const fp = path.resolve(currentWorkspace(), args.path || '.');
        return !isInside(currentWorkspace(), fp);
      } catch {
        return true;
      }
    }
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

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:set-api-key', (_e, key) => {
    if (!key || typeof key !== 'string') return { ok: false, error: 'Key 不能为空' };
    const r = setApiKey(key.trim());
    return { ok: true, ...r };
  });

  ipcMain.handle('settings:set', (_e, partial) => {
    const allowed = ['model', 'temperature', 'maxTokens', 'workspace', 'approvalMode', 'baseUrl'];
    const patch = {};
    for (const k of allowed) {
      if (k in partial) patch[k] = partial[k];
    }
    if (patch.temperature != null) patch.temperature = Math.min(2, Math.max(0, Number(patch.temperature)));
    if (patch.maxTokens != null) patch.maxTokens = Math.min(8192, Math.max(512, Number(patch.maxTokens)));
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

  ipcMain.handle('sessions:list', () => store.listSessions());

  ipcMain.handle('sessions:create', () => {
    const s = store.createSession();
    return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: 0 };
  });

  ipcMain.handle('sessions:get', (_e, id) => {
    const s = store.getSession(id);
    if (!s) return null;
    return { id: s.id, title: s.title, messages: s.messages || [] };
  });

  ipcMain.handle('sessions:rename', (_e, { id, title }) => store.renameSession(id, title));

  ipcMain.handle('sessions:delete', (_e, id) => store.deleteSession(id));

  ipcMain.handle('agent:start', (_e, { sessionId, text }) => {
    const session = store.getSession(sessionId);
    if (!session) return { ok: false, error: '会话不存在' };
    const apiKey = getApiKey();
    if (!apiKey) return { ok: false, error: '尚未配置 DeepSeek API Key，请先在设置中填写' };
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
          tools: tools.schemas,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          apiKey,
          baseUrl: settings.baseUrl || 'https://api.deepseek.com',
          emit,
          signal: abort.signal,
          transport: realTransport,
          needsApproval: needsApprovalFor(settings.approvalMode),
          requestApproval: (call) => requestApproval(runId, call),
          executeTool: (call) => tools.execute(call),
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
    backgroundColor: '#0e1016',
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

  if (isScreenshot) {
    w.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          await w.webContents.executeJavaScript('window.__loadDemo && window.__loadDemo()', true);
          await new Promise((r) => setTimeout(r, 1500));
          const img = await w.webContents.capturePage();
          const out = path.join(app.getAppPath(), 'docs', 'screenshot.png');
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
