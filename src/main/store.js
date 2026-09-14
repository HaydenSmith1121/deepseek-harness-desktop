'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // ---- 生成参数 ----
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 4096,

  // ---- 兼容旧版单服务商字段（迁移到 providers 后仅作兜底）----
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnc: null,
  apiKeyPlain: false,

  // ---- 多服务商（任意 OpenAI 兼容接口）----
  // [{ id, label, preset, baseUrl, keyEnc, keyPlain, models: string[] }]
  providers: null,
  activeProviderId: null,

  // ---- 智能体 ----
  workspace: null,                    // null 时由 main 进程赋予默认工作区
  approvalMode: 'confirm-dangerous',  // auto | confirm-dangerous | confirm-all

  // ---- 界面 ----
  theme: 'dark',                      // dark | light

  // ---- 插件（自定义 HTTP 工具）----
  plugins: [],
};

const MAX_FOLDER_NAME = 40;
const MAX_TITLE = 60;

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
    this.folders = {};
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

  // ================= 会话 / 文件夹持久化 =================

  _loadSessions() {
    if (this._sessionsLoaded) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      this.sessions = raw.sessions || {};
      this.folders = raw.folders || {};
    } catch {
      this.sessions = {};
      this.folders = {};
    }
    this._sessionsLoaded = true;
  }

  _persistSessions() {
    fs.writeFileSync(
      this.sessionsFile,
      JSON.stringify({ sessions: this.sessions, folders: this.folders }, null, 2),
      'utf8'
    );
  }

  /** 老数据补全 folderId / archived 字段 */
  _normalizeSession(s) {
    if (s.folderId === undefined) s.folderId = null;
    if (s.archived === undefined) s.archived = false;
    if (s.archivedAt === undefined) s.archivedAt = null;
    return s;
  }

  listSessions() {
    this._loadSessions();
    return Object.values(this.sessions)
      .map((raw) => {
        const s = this._normalizeSession(raw);
        return {
          id: s.id,
          title: s.title || '新对话',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: (s.messages || []).length,
          folderId: s.folderId || null,
          archived: !!s.archived,
          archivedAt: s.archivedAt || null,
        };
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  createSession(folderId = null) {
    this._loadSessions();
    const id = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    const folder = folderId && this.folders[folderId] ? folderId : null;
    this.sessions[id] = {
      id, title: '新对话', createdAt: now, updatedAt: now, messages: [],
      folderId: folder, archived: false, archivedAt: null,
    };
    this._persistSessions();
    return this.sessions[id];
  }

  getSession(id) {
    this._loadSessions();
    const s = this.sessions[id];
    return s ? this._normalizeSession(s) : null;
  }

  saveSession(id, messages, title) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return;
    s.messages = messages;
    if (title) s.title = String(title).slice(0, MAX_TITLE);
    s.updatedAt = Date.now();
    this._persistSessions();
  }

  renameSession(id, title) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return false;
    const t = String(title || '').trim();
    if (!t) return false;
    s.title = t.slice(0, MAX_TITLE);
    s.updatedAt = Date.now();
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

  /** 移入文件夹（folderId 为 null 表示移出到「未分组」）*/
  moveSession(id, folderId) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return false;
    const target = folderId && this.folders[folderId] ? folderId : null;
    s.folderId = target;
    this._normalizeSession(s);
    this._persistSessions();
    return true;
  }

  /** 归档 / 取消归档 */
  setSessionArchived(id, archived) {
    this._loadSessions();
    const s = this.sessions[id];
    if (!s) return false;
    s.archived = !!archived;
    s.archivedAt = archived ? Date.now() : null;
    this._persistSessions();
    return true;
  }

  // ---- 文件夹 ----

  listFolders() {
    this._loadSessions();
    return Object.values(this.folders).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  createFolder(name) {
    this._loadSessions();
    const label = String(name || '').trim() || '新建文件夹';
    const id = 'fld-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    this.folders[id] = { id, name: label.slice(0, MAX_FOLDER_NAME), createdAt: now };
    this._persistSessions();
    return this.folders[id];
  }

  renameFolder(id, name) {
    this._loadSessions();
    const f = this.folders[id];
    if (!f) return false;
    const label = String(name || '').trim();
    if (!label) return false;
    f.name = label.slice(0, MAX_FOLDER_NAME);
    this._persistSessions();
    return true;
  }

  /** 删除文件夹；其中会话回到「未分组」，不会连带删除 */
  deleteFolder(id) {
    this._loadSessions();
    if (!this.folders[id]) return false;
    delete this.folders[id];
    for (const s of Object.values(this.sessions)) {
      if (s.folderId === id) s.folderId = null;
    }
    this._persistSessions();
    return true;
  }
}

module.exports = { Store, DEFAULTS, MAX_FOLDER_NAME, MAX_TITLE };
