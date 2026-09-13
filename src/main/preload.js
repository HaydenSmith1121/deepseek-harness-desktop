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

  // 应用信息
  appInfo: () => ipcRenderer.invoke('app:info'),
});
