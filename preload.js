'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('harness', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list')
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: (conversationId) => ipcRenderer.invoke('chat:abort', conversationId),
    onChunk: (cb) => subscribe('chat:chunk', cb),
    onDone: (cb) => subscribe('chat:done', cb),
    onError: (cb) => subscribe('chat:error', cb)
  },
  batch: {
    run: (payload) => ipcRenderer.invoke('batch:run', payload),
    abort: () => ipcRenderer.invoke('batch:abort'),
    onProgress: (cb) => subscribe('batch:progress', cb)
  },
  compare: {
    run: (payload) => ipcRenderer.invoke('compare:run', payload),
    abort: () => ipcRenderer.invoke('compare:abort'),
    onProgress: (cb) => subscribe('compare:progress', cb)
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    save: (conversation) => ipcRenderer.invoke('conversations:save', conversation),
    delete: (id) => ipcRenderer.invoke('conversations:delete', id)
  }
});
