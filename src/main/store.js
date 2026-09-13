'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 4096,
  baseUrl: 'https://api.deepseek.com',
  workspace: null,          // null 时由 main 进程赋予默认工作区
  approvalMode: 'confirm-dangerous', // auto | confirm-dangerous | confirm-all
  apiKeyEnc: null,          // safeStorage 加密后的 base64
  apiKeyPlain: false,       // 加密不可用时的明文降级标志
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'settings.json');
    this.sessionsFile = path.join(userDataDir, 'sessions.json');
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this.data, raw);
    } catch { /* 首次运行 */ }
    this.sessions = {};
    this._sessionsLoaded = false;
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(key) { return this.data[key]; }

  set(partial) {
    Object.assign(this.data, partial);
    this.save();
  }

  all() { return { ...this.data }; }

  // ---- 会话 ----

  _loadSessions() {
    if (this._sessionsLoaded) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      this.sessions = raw.sessions || {};
    } catch {
      this.sessions = {};
    }
    this._sessionsLoaded = true;
  }

  _persistSessions() {
    fs.writeFileSync(this.sessionsFile, JSON.stringify({ sessions: this.sessions }, null, 2), 'utf8');
  }

  listSessions() {
    this._loadSessions();
    return Object.values(this.sessions)
      .map((s) => ({
        id: s.id,
        title: s.title || '新对话',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: (s.messages || []).length,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  createSession() {
    this._loadSessions();
    const id = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    this.sessions[id] = { id, title: '新对话', createdAt: now, updatedAt: now, messages: [] };
    this._persistSessions();
    return this.sessions[id];
  }

  getSession(id) {
    this._loadSessions();
    return this.sessions[id] || null;
  }

  saveSession(id, messages, title) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return;
    s.messages = messages;
    if (title) s.title = title;
    s.updatedAt = Date.now();
    this._persistSessions();
  }

  renameSession(id, title) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return false;
    s.title = String(title).slice(0, 60);
    this._persistSessions();
    return true;
  }

  deleteSession(id) {
    this._loadSessions();
    if (!this.sessions[id]) return false;
    delete this.sessions[id];
    this._persistSessions();
    return true;
  }
}

module.exports = { Store, DEFAULTS };
