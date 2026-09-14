'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:set-api-key', key),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  pickWorkspace: () => ipcRenderer.invoke('dialog:pick-workspace'),

  // 会话
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: () => ipcRenderer.invoke('sessions:create'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  // Agent
  startAgent: (payload) => ipcRenderer.invoke('agent:start', payload),
  stopAgent: (runId) => ipcRenderer.invoke('agent:stop', runId),
  respondApproval: (payload) => ipcRenderer.invoke('agent:approval', payload),

  // 事件订阅（返回取消订阅函数）
  onEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },

  // 评测台（批量评测 / 模型对比）
  labModels: () => ipcRenderer.invoke('lab:models'),
  labRunBatch: (payload) => ipcRenderer.invoke('lab:run-batch', payload),
  labRunCompare: (payload) => ipcRenderer.invoke('lab:run-compare', payload),
  labStop: (runId) => ipcRenderer.invoke('lab:stop', runId),
  labOpenDataset: () => ipcRenderer.invoke('lab:open-dataset'),
  labExport: (payload) => ipcRenderer.invoke('lab:export', payload),
  onLabEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('lab:event', listener);
    return () => ipcRenderer.removeListener('lab:event', listener);
  },

  // 应用信息
  appInfo: () => ipcRenderer.invoke('app:info'),
});
