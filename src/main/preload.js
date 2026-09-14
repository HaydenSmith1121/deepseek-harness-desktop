'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  // ---- 设置 ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  pickWorkspace: () => ipcRenderer.invoke('dialog:pick-workspace'),

  // ---- 模型服务商（可接入任意 OpenAI 兼容接口）----
  listProviders: () => ipcRenderer.invoke('providers:list'),
  saveProvider: (payload) => ipcRenderer.invoke('providers:save', payload),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),
  activateProvider: (id) => ipcRenderer.invoke('providers:activate', id),
  fetchProviderModels: (payload) => ipcRenderer.invoke('providers:models', payload),
  setProviderKey: (payload) => ipcRenderer.invoke('providers:set-key', payload),

  // ---- 会话 ----
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (folderId) => ipcRenderer.invoke('sessions:create', folderId),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  moveSession: (id, folderId) => ipcRenderer.invoke('sessions:move', { id, folderId }),
  archiveSession: (id, archived) => ipcRenderer.invoke('sessions:archive', { id, archived }),

  // ---- 文件夹 ----
  listFolders: () => ipcRenderer.invoke('folders:list'),
  createFolder: (name) => ipcRenderer.invoke('folders:create', name),
  renameFolder: (id, name) => ipcRenderer.invoke('folders:rename', { id, name }),
  deleteFolder: (id) => ipcRenderer.invoke('folders:delete', id),

  // ---- 插件 ----
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  savePlugin: (plugin) => ipcRenderer.invoke('plugins:save', plugin),
  deletePlugin: (id) => ipcRenderer.invoke('plugins:delete', id),
  setPluginEnabled: (payload) => ipcRenderer.invoke('plugins:set-enabled', payload),
  importPlugins: (list) => ipcRenderer.invoke('plugins:import', list),

  // ---- 智能体 ----
  startAgent: (payload) => ipcRenderer.invoke('agent:start', payload),
  stopAgent: (runId) => ipcRenderer.invoke('agent:stop', runId),
  respondApproval: (payload) => ipcRenderer.invoke('agent:approval', payload),

  // 事件订阅（返回取消订阅函数）
  onEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },

  // ---- 应用信息 ----
  appInfo: () => ipcRenderer.invoke('app:info'),
});
