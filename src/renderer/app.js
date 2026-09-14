'use strict';

/* ============ DeepSeek Harness 渲染层 ============ */

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  providers: [],
  sessions: [],
  folders: [],
  sessionId: null,
  sessionTitle: '',
  view: 'chat',
  collapsed: new Set(),   // 折叠的文件夹 id
  archiveOpen: false,
  running: false,
  runId: null,
  unsubscribe: null,
};

/* ---- markdown ---- */
const md = (text) => {
  try {
    return marked.parse(text || '', { breaks: true, gmd: false, gfm: true, async: false });
  } catch {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
};

const TOOL_ICONS = {
  read_file: '📖', write_file: '✏️', list_dir: '📁',
  run_command: '⌨️', search_files: '🔍', web_fetch: '🌐',
};

/* ============================================================
 *  主题
 * ============================================================ */
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 只改界面，不落盘（截图模式 / 内部调用） */
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const btn = $('#btn-theme');
  if (btn) {
    btn.textContent = t === 'light' ? '☀️' : '🌙';
    btn.title = t === 'light' ? '切换到深色（夜间模式）' : '切换到浅色（白天模式）';
  }
  const sel = $('#input-theme');
  if (sel) sel.value = t;
}

async function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  if (state.settings) state.settings.theme = next;
  await window.harness.setSettings({ theme: next });
}

/* ============================================================
 *  通用弹窗（输入 / 确认）
 * ============================================================ */
let dlgResolve = null;
let dlgMode = 'text';

function closeDlg(result) {
  const r = dlgResolve;
  dlgResolve = null;
  $('#dlg-modal').classList.add('hidden');
  if (r) r(result);
}

function askText({ title, label = '名称', value = '', placeholder = '', hint = '', okText = '确定', desc = '' }) {
  return new Promise((resolve) => {
    dlgResolve = resolve;
    dlgMode = 'text';
    $('#dlg-title').textContent = title || '';
    $('#dlg-label').textContent = label;
    $('#dlg-input').value = value;
    $('#dlg-input').placeholder = placeholder;
    $('#dlg-hint').textContent = hint;
    $('#dlg-hint').classList.toggle('hidden', !hint);
    $('#dlg-desc').textContent = desc;
    $('#dlg-desc').classList.toggle('hidden', !desc);
    $('#dlg-field').classList.remove('hidden');
    const ok = $('#dlg-ok');
    ok.textContent = okText;
    ok.classList.remove('btn-danger');
    $('#dlg-modal').classList.remove('hidden');
    const inp = $('#dlg-input');
    inp.focus();
    inp.select();
  });
}

function askConfirm({ title, desc = '', okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    dlgResolve = resolve;
    dlgMode = 'confirm';
    $('#dlg-title').textContent = title || '';
    $('#dlg-desc').textContent = desc;
    $('#dlg-desc').classList.toggle('hidden', !desc);
    $('#dlg-field').classList.add('hidden');
    const ok = $('#dlg-ok');
    ok.textContent = okText;
    ok.classList.toggle('btn-danger', !!danger);
    $('#dlg-modal').classList.remove('hidden');
    ok.focus();
  });
}

function bindDlg() {
  $('#dlg-ok').addEventListener('click', () => {
    if (dlgMode === 'text') {
      const v = $('#dlg-input').value.trim();
      if (!v) return;
      closeDlg(v);
    } else {
      closeDlg(true);
    }
  });
  $('#dlg-cancel').addEventListener('click', () => closeDlg(dlgMode === 'text' ? null : false));
  $('#dlg-close').addEventListener('click', () => closeDlg(dlgMode === 'text' ? null : false));
  $('#dlg-modal').addEventListener('click', (e) => {
    if (e.target === $('#dlg-modal')) closeDlg(dlgMode === 'text' ? null : false);
  });
  $('#dlg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#dlg-ok').click(); }
  });
}

/* ============================================================
 *  弹出菜单
 * ============================================================ */
function closeMenu() {
  $('#popmenu').classList.add('hidden');
}

function openMenu(anchor, items) {
  const menu = $('#popmenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it.separator) {
      const d = document.createElement('div');
      d.className = 'popmenu-sep';
      menu.appendChild(d);
      continue;
    }
    if (it.header) {
      const d = document.createElement('div');
      d.className = 'popmenu-label';
      d.textContent = it.label;
      menu.appendChild(d);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'popmenu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenu();
      await it.onClick();
    });
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const x = Math.min(r.left, window.innerWidth - mw - 8);
  let y = r.bottom + 4;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = y + 'px';
}

/* ============================================================
 *  初始化
 * ============================================================ */
async function init() {
  welcomeTemplate = $('#welcome').outerHTML;
  state.settings = await window.harness.getSettings();
  const info = await window.harness.appInfo();
  $('#app-version').textContent = 'v' + info.version;

  applyTheme(state.settings.theme);
  state.unsubscribe = window.harness.onEvent(handleAgentEvent);

  bindUi();
  await refreshProviders();
  await refreshSessions();

  // 恢复最近会话或新建
  const alive = state.sessions.filter((s) => !s.archived);
  if (alive.length) {
    await openSession(alive[0].id);
  } else {
    await newSession(false);
  }
  applySettingsToUi();

  if (!state.settings.hasApiKey) openSettings();
}

function bindUi() {
  $('#btn-new-chat').addEventListener('click', () => newSession(true));
  $('#btn-new-folder').addEventListener('click', () => newFolderFlow());
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', closeSettings);
  $('#btn-settings-save').addEventListener('click', saveSettings);
  $('#btn-save-key').addEventListener('click', saveApiKey);
  $('#btn-pick-workspace').addEventListener('click', pickWorkspace);
  $('#btn-fetch-models').addEventListener('click', fetchModelsForActive);
  $('#set-provider').addEventListener('change', switchProvider);
  $('#btn-provider-new').addEventListener('click', () => openProviderModal(null));
  $('#btn-provider-edit').addEventListener('click', () => openProviderModal(activeProvider()));
  $('#btn-provider-del').addEventListener('click', deleteActiveProvider);
  $('#btn-provider-close').addEventListener('click', closeProviderModal);
  $('#btn-provider-cancel').addEventListener('click', closeProviderModal);
  $('#btn-provider-save').addEventListener('click', saveProviderFlow);
  $('#btn-provider-fetch').addEventListener('click', fetchModelsInModal);
  $('#provider-preset').addEventListener('change', onPresetChange);
  $('#btn-send').addEventListener('click', send);
  $('#btn-stop').addEventListener('click', stop);
  $('#badge-approval').addEventListener('click', cycleApprovalMode);

  const input = $('#input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', autosizeInput);

  document.querySelectorAll('.example').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#input').value = btn.dataset.prompt;
      autosizeInput();
      $('#input').focus();
    });
  });

  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#settings-modal')) closeSettings();
  });
  $('#provider-modal').addEventListener('click', (e) => {
    if (e.target === $('#provider-modal')) closeProviderModal();
  });

  document.querySelectorAll('#nav .nav-btn').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popmenu')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); closeDlg(dlgMode === 'text' ? null : false); }
  });

  bindDlg();
}

/* ---- 视图切换 ---- */
function switchView(view) {
  state.view = view === 'plugins' ? 'plugins' : 'chat';
  document.body.dataset.view = state.view;
  $('#main').classList.toggle('hidden', state.view !== 'chat');
  $('#view-plugins').classList.toggle('hidden', state.view !== 'plugins');
  document.querySelectorAll('#nav .nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  if (state.view === 'plugins' && window.pluginsView) window.pluginsView.reload();
}

/* ============================================================
 *  会话 + 文件夹
 * ============================================================ */
async function refreshSessions() {
  const [sessions, folders] = await Promise.all([
    window.harness.listSessions(),
    window.harness.listFolders(),
  ]);
  state.sessions = sessions;
  state.folders = folders;
  renderSidebar();
}

function hintEl(text) {
  const d = document.createElement('div');
  d.className = 'folder-empty';
  d.textContent = text;
  return d;
}

function renderSidebar() {
  const list = $('#session-list');
  list.innerHTML = '';

  const visible = state.sessions.filter((s) => !s.archived);
  const folderIds = new Set(state.folders.map((f) => f.id));
  const rootSessions = visible.filter((s) => !s.folderId || !folderIds.has(s.folderId));

  if (!rootSessions.length && !state.folders.length) {
    list.appendChild(hintEl('还没有会话，点上面「＋ 新建对话」开始'));
  }

  for (const s of rootSessions) list.appendChild(sessionItem(s));

  for (const f of state.folders) {
    list.appendChild(folderBlock(f, visible.filter((s) => s.folderId === f.id)));
  }

  renderArchive();
}

function sessionItem(s) {
  const item = document.createElement('div');
  item.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');

  const title = document.createElement('span');
  title.className = 's-title';
  title.textContent = s.title || '新对话';

  const more = document.createElement('button');
  more.className = 's-more';
  more.textContent = '⋯';
  more.title = '更多操作';

  item.append(title, more);
  item.addEventListener('click', (e) => {
    if (e.target === more) return;
    openSession(s.id);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openSessionMenu(more, s);
  });
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(more, s);
  });
  return item;
}

function openSessionMenu(anchor, s) {
  const items = [
    { label: '✏️ 重命名', onClick: () => renameSessionFlow(s) },
    { label: '📦 归档', onClick: () => archiveSession(s.id, true) },
    { separator: true },
    { label: '📁 移动到文件夹', header: true },
  ];
  if (s.folderId) {
    items.push({ label: '　· 未分组', onClick: () => moveSession(s.id, null) });
  }
  for (const f of state.folders) {
    if (f.id === s.folderId) continue;
    items.push({ label: '　· ' + f.name, onClick: () => moveSession(s.id, f.id) });
  }
  items.push({
    label: '　· ＋ 新建文件夹…',
    onClick: async () => {
      const name = await askText({ title: '新建文件夹', label: '文件夹名称', placeholder: '例如：前端重构', okText: '创建' });
      if (!name) return;
      const r = await window.harness.createFolder(name);
      if (r.ok && r.folder) await moveSession(s.id, r.folder.id);
    },
  });
  items.push({ separator: true });
  items.push({ label: '🗑 删除会话', danger: true, onClick: () => deleteSessionFlow(s) });
  openMenu(anchor, items);
}

function folderBlock(f, items) {
  const block = document.createElement('div');
  block.className = 'folder-block';

  const collapsed = state.collapsed.has(f.id);

  const head = document.createElement('div');
  head.className = 'folder-head';
  const caret = document.createElement('span');
  caret.className = 'folder-caret';
  caret.textContent = collapsed ? '▶' : '▼';
  const icon = document.createElement('span');
  icon.textContent = '📁';
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = f.name;
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(items.length);
  const addBtn = document.createElement('button');
  addBtn.className = 'folder-btn';
  addBtn.textContent = '＋';
  addBtn.title = '在此文件夹下新建会话';
  const moreBtn = document.createElement('button');
  moreBtn.className = 'folder-btn';
  moreBtn.textContent = '⋯';
  moreBtn.title = '文件夹操作';

  head.append(caret, icon, name, count, addBtn, moreBtn);
  head.addEventListener('click', (e) => {
    if (e.target === addBtn || e.target === moreBtn) return;
    if (state.collapsed.has(f.id)) state.collapsed.delete(f.id);
    else state.collapsed.add(f.id);
    renderSidebar();
  });
  addBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await newSession(true, f.id);
  });
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderMenu(moreBtn, f);
  });

  const body = document.createElement('div');
  body.className = 'folder-body' + (collapsed ? ' hidden' : '');
  for (const s of items) body.appendChild(sessionItem(s));
  const addRow = document.createElement('div');
  addRow.className = 'folder-add-row';
  addRow.textContent = '＋ 在此新建会话';
  addRow.addEventListener('click', () => newSession(true, f.id));
  body.appendChild(addRow);

  block.append(head, body);
  return block;
}

function openFolderMenu(anchor, f) {
  openMenu(anchor, [
    { label: '✏️ 重命名文件夹', onClick: async () => {
      const name = await askText({ title: '重命名文件夹', label: '文件夹名称', value: f.name, okText: '保存' });
      if (!name) return;
      await window.harness.renameFolder(f.id, name);
      await refreshSessions();
    } },
    { label: '＋ 在此新建会话', onClick: () => newSession(true, f.id) },
    { label: '📦 归档全部会话', onClick: async () => {
      const ids = state.sessions.filter((s) => s.folderId === f.id && !s.archived).map((s) => s.id);
      if (!ids.length) return;
      for (const id of ids) await window.harness.archiveSession(id, true);
      await refreshSessions();
      if (!state.sessions.some((s) => s.id === state.sessionId && !s.archived)) await newSession(false);
    } },
    { separator: true },
    { label: '🗑 删除文件夹', danger: true, onClick: async () => {
      const ok = await askConfirm({
        title: '删除文件夹',
        desc: `「${f.name}」将被删除，里面的会话会回到「未分组」，不会被删除。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await window.harness.deleteFolder(f.id);
      state.collapsed.delete(f.id);
      await refreshSessions();
    } },
  ]);
}

async function newFolderFlow() {
  const name = await askText({ title: '新建文件夹', label: '文件夹名称', placeholder: '例如：前端重构', okText: '创建' });
  if (!name) return;
  await window.harness.createFolder(name);
  await refreshSessions();
}

async function renameSessionFlow(s) {
  const title = await askText({
    title: '重命名会话',
    label: '会话标题',
    value: s.title || '',
    okText: '保存',
  });
  if (!title) return;
  await window.harness.renameSession(s.id, title);
  if (s.id === state.sessionId) state.sessionTitle = title;
  await refreshSessions();
  updateTopbar();
}

async function moveSession(id, folderId) {
  await window.harness.moveSession(id, folderId);
  if (folderId) state.collapsed.delete(folderId);
  await refreshSessions();
}

async function archiveSession(id, archived) {
  await window.harness.archiveSession(id, archived);
  if (archived) state.archiveOpen = true;
  if (id === state.sessionId && archived) {
    await newSession(false);
  } else {
    await refreshSessions();
  }
}

async function deleteSessionFlow(s) {
  const ok = await askConfirm({
    title: '删除会话',
    desc: `「${s.title || '新对话'}」将被永久删除，无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  await window.harness.deleteSession(s.id);
  if (s.id === state.sessionId) await newSession(false);
  await refreshSessions();
  if (!state.sessions.filter((x) => !x.archived).length) await newSession(false);
}

function renderArchive() {
  const box = $('#archive-section');
  box.innerHTML = '';
  const archived = state.sessions.filter((s) => s.archived);

  const head = document.createElement('div');
  head.className = 'archive-head';
  const caret = document.createElement('span');
  caret.className = 'folder-caret';
  caret.textContent = state.archiveOpen ? '▼' : '▶';
  const label = document.createElement('span');
  label.textContent = '📦 已归档';
  const count = document.createElement('span');
  count.className = 'count-tag';
  count.textContent = String(archived.length);
  head.append(caret, label, count);
  head.addEventListener('click', () => {
    state.archiveOpen = !state.archiveOpen;
    renderArchive();
  });
  box.appendChild(head);

  if (!state.archiveOpen || !archived.length) return;

  const body = document.createElement('div');
  body.className = 'archive-body';
  for (const s of archived) {
    const it = document.createElement('div');
    it.className = 'archive-item';
    const t = document.createElement('span');
    t.className = 'a-title';
    t.textContent = s.title || '新对话';
    t.title = '点击查看';
    t.style.cursor = 'pointer';
    t.addEventListener('click', () => openSession(s.id));
    const restore = document.createElement('button');
    restore.textContent = '还原';
    restore.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.harness.archiveSession(s.id, false);
      await refreshSessions();
    });
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '彻底删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: '彻底删除',
        desc: `「${s.title || '新对话'}」将被永久删除，无法恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await window.harness.deleteSession(s.id);
      if (s.id === state.sessionId) await newSession(false);
      await refreshSessions();
    });
    it.append(t, restore, del);
    body.appendChild(it);
  }
  box.appendChild(body);
}

async function newSession(switchFocus, folderId = null) {
  if (state.running) return;
  const s = await window.harness.createSession(folderId || null);
  state.sessionId = s.id;
  state.sessionTitle = s.title;
  if (folderId) state.collapsed.delete(folderId);
  await refreshSessions();
  renderMessages([]);
  if (switchFocus) {
    switchView('chat');
    $('#input').focus();
  }
}

async function openSession(id) {
  if (state.running) return;
  const s = await window.harness.getSession(id);
  if (!s) return;
  state.sessionId = id;
  state.sessionTitle = s.title;
  renderSidebar();
  renderMessages(s.messages || []);
  switchView('chat');
}

/* ============================================================
 *  消息渲染
 * ============================================================ */
let welcomeTemplate = null; // 启动时缓存欢迎页模板（renderMessages 会清空 #chat）

function renderMessages(messages) {
  const chat = $('#chat');
  chat.innerHTML = '';
  if (!messages.length && welcomeTemplate) {
    const holder = document.createElement('div');
    holder.innerHTML = welcomeTemplate;
    const w = holder.firstElementChild;
    w.classList.remove('hidden');
    w.querySelectorAll('.example').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('#input').value = btn.dataset.prompt;
        autosizeInput();
        $('#input').focus();
      });
    });
    chat.appendChild(w);
  }
  for (const m of messages) appendMessageEl(m);
  updateTopbar();
  scrollBottom();
}

function appendMessageEl(m) {
  const chat = $('#chat');
  const welcome = chat.querySelector('.welcome');
  if (welcome) welcome.remove();

  if (m.role === 'user') {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.innerHTML = `<div class="bubble"></div>`;
    el.querySelector('.bubble').textContent = m.content;
    chat.appendChild(el);
    return el;
  }

  if (m.role === 'assistant') {
    const el = buildAssistantBubble(m.content || '', m.reasoning_content || '');
    if (m.tool_calls && m.tool_calls.length) {
      for (const call of m.tool_calls) {
        // 历史消息里的工具调用：直接渲染成已完成卡片
        el.toolContainer.appendChild(buildToolCard({
          callId: call.id,
          name: call.function.name,
          args: call.function.arguments,
          status: 'done',
        }));
      }
    }
    $('#chat').appendChild(el.root);
    return el.root;
  }

  if (m.role === 'tool') {
    // 历史里孤立的 tool 消息：尝试归并到上一个 assistant 的对应卡片
    const cards = $('#chat').querySelectorAll(`[data-call-id="${cssEscape(m.tool_call_id)}"]`);
    if (cards.length) {
      setToolCardResult(cards[0], m.content, false);
    }
    return null;
  }
  return null;
}

function buildAssistantBubble(content, reasoning) {
  const root = document.createElement('div');
  root.className = 'msg msg-assistant';

  const reasoningEl = document.createElement('details');
  reasoningEl.className = 'reasoning hidden';
  reasoningEl.innerHTML = `<summary>💭 思考过程</summary><div class="reasoning-body"></div>`;
  const reasoningBody = reasoningEl.querySelector('.reasoning-body');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const contentEl = document.createElement('div');
  contentEl.className = 'md-content';
  bubble.appendChild(contentEl);

  const toolContainer = document.createElement('div');
  toolContainer.className = 'tool-container';

  root.appendChild(reasoningEl);
  root.appendChild(bubble);
  root.appendChild(toolContainer);

  const obj = {
    root, reasoningEl, reasoningBody, bubble, contentEl, toolContainer,
    rawContent: content || '',
    rawReasoning: reasoning || '',
    finalized: false,
  };

  if (obj.rawReasoning) {
    reasoningEl.classList.remove('hidden');
    reasoningBody.textContent = obj.rawReasoning;
  }
  // 只有工具调用、没有正文的一步：不要留一个空气泡
  if (!obj.rawContent) bubble.classList.add('hidden');
  contentEl.innerHTML = md(obj.rawContent);
  return obj;
}

function buildToolCard({ callId, name, args, status }) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.callId = callId || '';
  const icon = TOOL_ICONS[name] || '🧩';
  const argSummary = summarizeArgs(name, args);
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-args" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--text-faint)">${escapeHtml(argSummary)}</span>
      <span class="tool-status">${status === 'running' ? '执行中…' : status === 'pending' ? '待确认' : '已完成'}</span>
    </div>
    <div class="tool-body">
      <div class="tool-section"><div class="tool-label">参数</div><pre class="tool-pre args"></pre></div>
      <div class="tool-section result-section"><div class="tool-label">结果</div><pre class="tool-pre result"></pre></div>
    </div>`;
  card.querySelector('.tool-pre.args').textContent = prettyArgs(args);
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));

  const statusEl = card.querySelector('.tool-status');
  if (status === 'running') statusEl.className = 'tool-status running';
  else if (status === 'pending') { statusEl.className = 'tool-status'; card.classList.add('pending-approval'); }

  return card;
}

function setToolCardStatus(card, text, cls) {
  const el = card.querySelector('.tool-status');
  el.textContent = text;
  el.className = 'tool-status ' + cls;
}

function setToolCardResult(card, result, isError) {
  card.classList.remove('pending-approval');
  const pre = card.querySelector('.tool-pre.result');
  pre.textContent = result || '(空)';
  pre.closest('.tool-section').style.display = result ? '' : 'none';
  if (isError) {
    setToolCardStatus(card, '失败', 'error');
    card.classList.add('denied');
  } else {
    setToolCardStatus(card, '已完成', 'ok');
  }
}

function summarizeArgs(name, argsJson) {
  try {
    const a = JSON.parse(argsJson || '{}');
    if (name === 'run_command') return a.command || '';
    if (name === 'web_fetch') return a.url || '';
    return a.path || a.pattern || a.url || a.query || a.city || Object.values(a)[0] || '';
  } catch {
    return '';
  }
}

function prettyArgs(argsJson) {
  try {
    return JSON.stringify(JSON.parse(argsJson || '{}'), null, 2);
  } catch {
    return argsJson || '';
  }
}

/* ============================================================
 *  Agent 事件
 * ============================================================ */
let live = null; // 当前运行中的 UI 引用

function resetLive() {
  live = null;
}

function handleAgentEvent(evt) {
  if (evt.sessionId !== state.sessionId) return; // 其他会话的后台运行，不渲染
  const { type, payload } = evt;

  switch (type) {
    case 'delta': {
      if (!live) {
        live = buildAssistantBubble('', '');
        $('#chat').appendChild(live.root);
      }
      if (payload.kind === 'content') {
        live.bubble.classList.remove('hidden');
        live.rawContent += payload.text;
        live.contentEl.innerHTML = md(live.rawContent) + '<span class="cursor"></span>';
      } else if (payload.kind === 'reasoning') {
        live.rawReasoning += payload.text;
        live.reasoningEl.classList.remove('hidden');
        live.reasoningBody.textContent = live.rawReasoning;
        live.reasoningBody.scrollTop = live.reasoningBody.scrollHeight;
      }
      maybeScroll();
      break;
    }

    case 'approval-request': {
      if (!live) {
        live = buildAssistantBubble('', '');
        $('#chat').appendChild(live.root);
      }
      const card = buildToolCard({ callId: payload.callId, name: payload.name, args: payload.args, status: 'pending' });
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      actions.innerHTML = `<button class="btn-approve">✓ 批准执行</button><button class="btn-deny">✕ 拒绝</button>`;
      actions.querySelector('.btn-approve').addEventListener('click', () => {
        window.harness.respondApproval({ runId: state.runId, callId: payload.callId, approved: true });
        actions.remove();
        card.classList.remove('pending-approval');
        setToolCardStatus(card, '执行中…', 'running');
      });
      actions.querySelector('.btn-deny').addEventListener('click', () => {
        window.harness.respondApproval({ runId: state.runId, callId: payload.callId, approved: false });
        actions.remove();
        card.classList.remove('pending-approval');
        card.classList.add('denied');
        setToolCardStatus(card, '已拒绝', 'error');
      });
      card.appendChild(actions);
      live.toolContainer.appendChild(card);
      card.classList.add('open');
      maybeScroll();
      break;
    }

    case 'tool-start': {
      if (live) {
        let card = live.toolContainer.querySelector(`[data-call-id="${cssEscape(payload.callId)}"]`);
        if (!card) {
          card = buildToolCard({ callId: payload.callId, name: payload.name, args: payload.args, status: 'running' });
          live.toolContainer.appendChild(card);
        } else {
          setToolCardStatus(card, '执行中…', 'running');
        }
        maybeScroll();
      }
      break;
    }

    case 'tool-result': {
      if (live) {
        const card = live.toolContainer.querySelector(`[data-call-id="${cssEscape(payload.callId)}"]`);
        if (card) setToolCardResult(card, payload.result, payload.isError);
        maybeScroll();
      }
      break;
    }

    case 'assistant-message': {
      // 一步结束：固化本轮内容
      if (live) {
        if (live.rawContent) live.bubble.classList.remove('hidden');
        live.contentEl.innerHTML = md(live.rawContent);
        live.finalized = true;
        resetLive();
      }
      if (payload.usage) {
        const tag = document.createElement('div');
        tag.className = 'usage-tag';
        const u = payload.usage;
        tag.textContent = `tokens: 输入 ${u.prompt_tokens ?? '—'} · 输出 ${u.completion_tokens ?? '—'}`;
        $('#chat').appendChild(tag);
      }
      maybeScroll();
      break;
    }

    case 'notice': {
      const el = document.createElement('div');
      el.className = 'notice';
      el.textContent = 'ℹ️ ' + payload.text;
      $('#chat').appendChild(el);
      maybeScroll();
      break;
    }

    case 'run-error': {
      if (live) { live.finalized = true; resetLive(); }
      const el = document.createElement('div');
      el.className = 'error-msg';
      el.textContent = '❌ ' + payload.message;
      $('#chat').appendChild(el);
      setRunning(false);
      scrollBottom();
      break;
    }

    case 'run-end': {
      if (live) {
        if (live.rawContent) live.bubble.classList.remove('hidden');
        live.contentEl.innerHTML = md(live.rawContent);
        live.finalized = true;
        resetLive();
      }
      setRunning(false);
      refreshSessions();
      break;
    }
  }
}

/* ============================================================
 *  发送 / 停止 / 输入框高度
 * ============================================================ */
const INPUT_MAX_H = 240;

/** 自动增高；超过上限就停止增高，之后内部滚动但滚动条隐藏（见 style.css） */
function autosizeInput() {
  const el = $('#input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, INPUT_MAX_H) + 'px';
}

async function send() {
  if (state.running) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosizeInput();

  const r = await window.harness.startAgent({ sessionId: state.sessionId, text });
  if (!r.ok) {
    const el = document.createElement('div');
    el.className = 'error-msg';
    el.textContent = '❌ ' + (r.error || '启动失败');
    $('#chat').appendChild(el);
    scrollBottom();
    return;
  }
  state.runId = r.runId;
  appendMessageEl({ role: 'user', content: text });
  setRunning(true);
  scrollBottom();
}

function stop() {
  if (state.runId) window.harness.stopAgent(state.runId);
}

function setRunning(v) {
  state.running = v;
  $('#btn-send').disabled = v;
  $('#btn-stop').classList.toggle('hidden', !v);
  $('#composer-hint').textContent = v ? '智能体正在执行任务…' : '';
  if (!v) { state.runId = null; resetLive(); }
}

/* ============================================================
 *  设置
 * ============================================================ */
function openSettings() {
  applySettingsToUi();
  $('#settings-modal').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-modal').classList.add('hidden');
}

async function refreshProviders() {
  const r = await window.harness.listProviders();
  state.providers = r.providers || [];
  state.activeProviderId = r.activeProviderId;
}

function activeProvider() {
  return state.providers.find((p) => p.id === state.activeProviderId) || state.providers[0] || null;
}

function renderProviderSelect() {
  const sel = $('#set-provider');
  sel.innerHTML = '';
  for (const p of state.providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label + (p.hasApiKey ? '' : '（未配置 Key）');
    sel.appendChild(o);
  }
  sel.value = state.activeProviderId || '';
}

function renderModelOptions(models) {
  const dl = $('#model-options');
  dl.innerHTML = '';
  for (const m of models || []) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
}

function applySettingsToUi() {
  const s = state.settings;
  if (!s) return;
  const ap = activeProvider();

  renderProviderSelect();
  renderModelOptions(ap ? ap.models : []);
  $('#input-model').value = s.model || '';
  $('#input-baseurl').value = ap ? ap.baseUrl : '';
  $('#input-temperature').value = s.temperature;
  $('#temp-value').textContent = s.temperature;
  $('#input-maxtokens').value = s.maxTokens;
  $('#input-approval').value = s.approvalMode;
  $('#input-workspace').value = s.workspace || '';
  $('#input-theme').value = s.theme || currentTheme();
  $('#model-hint').textContent = ap && ap.models.length
    ? `可选项来自「${ap.label}」的候选模型，也可直接手填。`
    : '可直接填写模型名，也可点「拉取模型」从服务商读取列表。';

  const ks = $('#key-status');
  if (s.hasApiKey) {
    ks.textContent = `已保存 (${s.apiKeyMasked}${s.apiKeyPlain ? ' · 未加密' : ' · 已加密'})`;
    ks.style.color = s.apiKeyPlain ? 'var(--yellow)' : 'var(--green)';
  } else {
    ks.textContent = ap ? `「${ap.label}」未配置` : '未配置';
    ks.style.color = 'var(--red)';
  }

  applyTheme(s.theme || currentTheme());
  updateTopbar();
}

async function saveApiKey() {
  const key = $('#input-apikey').value.trim();
  if (!key) return;
  const r = await window.harness.setProviderKey({ id: state.activeProviderId, apiKey: key });
  if (!r.ok) {
    $('#key-status').textContent = r.error || '保存失败';
    $('#key-status').style.color = 'var(--red)';
    return;
  }
  $('#input-apikey').value = '';
  state.settings = r.settings;
  await refreshProviders();
  applySettingsToUi();
}

async function switchProvider() {
  const id = $('#set-provider').value;
  if (!id || id === state.activeProviderId) return;
  await setActiveProvider(id);
}

async function setActiveProvider(id) {
  const r = await window.harness.activateProvider(id);
  if (r.ok) state.settings = r.settings;
  await refreshProviders();
  applySettingsToUi();
}

async function fetchModelsForActive() {
  const btn = $('#btn-fetch-models');
  const hint = $('#model-hint');
  btn.disabled = true;
  hint.textContent = '正在拉取模型列表…';
  const r = await window.harness.fetchProviderModels({ id: state.activeProviderId });
  btn.disabled = false;
  if (!r.ok) {
    hint.textContent = '拉取失败：' + r.error;
    return;
  }
  renderModelOptions(r.models);
  hint.textContent = `拉取到 ${r.models.length} 个模型，输入框可直接选择。`;
  // 顺带把列表存回服务商，下次打开就有候选
  const ap = activeProvider();
  if (ap && r.models.length) {
    await window.harness.saveProvider({
      id: ap.id, label: ap.label, preset: ap.preset, baseUrl: ap.baseUrl, models: r.models,
    });
    await refreshProviders();
  }
}

async function saveSettings() {
  const r = await window.harness.setSettings({
    model: $('#input-model').value.trim(),
    temperature: Number($('#input-temperature').value),
    maxTokens: Number($('#input-maxtokens').value),
    approvalMode: $('#input-approval').value,
    theme: $('#input-theme').value,
  });
  if (r.ok) state.settings = r.settings;

  // 接口地址改动写回当前服务商
  const ap = activeProvider();
  const newBase = $('#input-baseurl').value.trim();
  if (ap && newBase && newBase !== ap.baseUrl) {
    const r2 = await window.harness.saveProvider({
      id: ap.id, label: ap.label, preset: ap.preset, baseUrl: newBase, models: ap.models,
    });
    if (r2.ok) state.settings = r2.settings;
  }

  await refreshProviders();
  state.settings = await window.harness.getSettings();
  applySettingsToUi();
  closeSettings();
}

async function pickWorkspace() {
  const r = await window.harness.pickWorkspace();
  if (r.ok) {
    state.settings.workspace = r.workspace;
    applySettingsToUi();
  }
}

async function cycleApprovalMode() {
  const order = ['confirm-dangerous', 'confirm-all', 'auto'];
  const next = order[(order.indexOf(state.settings.approvalMode) + 1) % order.length];
  const r = await window.harness.setSettings({ approvalMode: next });
  if (r.ok) state.settings = r.settings;
  updateTopbar();
}

function updateTopbar() {
  const s = state.settings;
  if (!s) return;
  $('#topbar-title').textContent = state.sessionTitle || '新对话';
  const ap = activeProvider();
  $('#badge-provider').textContent = ap ? ap.label : '—';
  $('#badge-provider').title = ap ? ap.baseUrl : '';
  $('#badge-model').textContent = s.model;
  const labels = { 'confirm-dangerous': '🛡 确认危险操作', 'confirm-all': '🛡 全部确认', 'auto': '⚡ 全自动' };
  const badge = $('#badge-approval');
  badge.textContent = labels[s.approvalMode] || s.approvalMode;
  badge.style.color = s.approvalMode === 'auto' ? 'var(--yellow)' : 'var(--green)';
  $('#badge-workspace').textContent = s.workspace || '未设置工作目录';
  $('#badge-workspace').title = s.workspace || '';
}

/* ============================================================
 *  服务商管理
 * ============================================================ */
const PROVIDER_PRESETS = [
  { key: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
  { key: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'] },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { key: 'dashscope', label: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { key: 'siliconflow', label: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet'] },
  { key: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'] },
  { key: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] },
];

let editingProviderId = null;

function renderPresetOptions() {
  const sel = $('#provider-preset');
  sel.innerHTML = '';
  for (const p of PROVIDER_PRESETS) {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.label;
    sel.appendChild(o);
  }
}

function onPresetChange() {
  const preset = PROVIDER_PRESETS.find((p) => p.key === $('#provider-preset').value);
  if (!preset) return;
  $('#provider-label').value = preset.label;
  $('#provider-baseurl').value = preset.baseUrl;
  $('#provider-models').value = preset.models.join('\n');
}

function openProviderModal(provider) {
  editingProviderId = provider ? provider.id : null;
  $('#provider-modal-title').textContent = provider ? '编辑模型服务商' : '新增模型服务商';
  $('#provider-key').value = '';
  $('#provider-test-result').textContent = '';
  if (provider) {
    $('#provider-preset').value = provider.preset || 'custom';
    $('#provider-label').value = provider.label;
    $('#provider-baseurl').value = provider.baseUrl;
    $('#provider-models').value = (provider.models || []).join('\n');
    $('#provider-key').placeholder = provider.hasApiKey ? '留空则不改动已保存的 Key' : 'sk-...';
  } else {
    $('#provider-preset').value = 'deepseek';
    onPresetChange();
    $('#provider-key').placeholder = 'sk-...';
  }
  $('#provider-modal').classList.remove('hidden');
  $('#provider-label').focus();
}

function closeProviderModal() {
  $('#provider-modal').classList.add('hidden');
  editingProviderId = null;
}

async function fetchModelsInModal() {
  const btn = $('#btn-provider-fetch');
  const out = $('#provider-test-result');
  const baseUrl = $('#provider-baseurl').value.trim();
  if (!baseUrl) {
    out.textContent = '请先填写接口地址';
    return;
  }
  btn.disabled = true;
  out.textContent = '正在请求…';
  const r = await window.harness.fetchProviderModels({
    id: editingProviderId,
    baseUrl,
    apiKey: $('#provider-key').value.trim() || undefined,
  });
  btn.disabled = false;
  if (!r.ok) {
    out.textContent = '失败：' + r.error;
    return;
  }
  $('#provider-models').value = r.models.join('\n');
  out.textContent = `成功，共 ${r.models.length} 个模型`;
}

async function saveProviderFlow() {
  const label = $('#provider-label').value.trim();
  const baseUrl = $('#provider-baseurl').value.trim();
  if (!label) { $('#provider-test-result').textContent = '请填写名称'; return; }
  if (!baseUrl) { $('#provider-test-result').textContent = '请填写接口地址'; return; }

  const models = $('#provider-models').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const payload = {
    id: editingProviderId || undefined,
    label,
    preset: $('#provider-preset').value,
    baseUrl,
    models,
  };
  const key = $('#provider-key').value.trim();
  if (key) payload.apiKey = key;

  const r = await window.harness.saveProvider(payload);
  if (!r.ok) {
    $('#provider-test-result').textContent = r.error || '保存失败';
    return;
  }
  const created = !editingProviderId;
  const newId = r.provider ? r.provider.id : null;
  closeProviderModal();
  await refreshProviders();
  if (created && newId) await setActiveProvider(newId);
  state.settings = await window.harness.getSettings();
  applySettingsToUi();
}

async function deleteActiveProvider() {
  const ap = activeProvider();
  if (!ap) return;
  if (state.providers.length <= 1) {
    await askConfirm({ title: '无法删除', desc: '至少要保留一个服务商。', okText: '知道了' });
    return;
  }
  const ok = await askConfirm({
    title: '删除服务商',
    desc: `「${ap.label}」及其保存的 API Key 将从本机移除。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  const r = await window.harness.deleteProvider(ap.id);
  if (r.ok) state.settings = r.settings;
  await refreshProviders();
  state.settings = await window.harness.getSettings();
  applySettingsToUi();
}

/* ============================================================
 *  工具函数
 * ============================================================ */
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

let scrollTimer = null;
function maybeScroll() {
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => { scrollTimer = null; scrollBottom(); }, 120);
}

function scrollBottom() {
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
}

/* ============================================================
 *  对外接口（供 plugins.js 使用）
 * ============================================================ */
window.ui = {
  askText,
  askConfirm,
  switchView,
  applyTheme,
  escapeHtml,
  get state() { return state; },
};

/* ============================================================
 *  演示模式（--screenshot 截图用）
 * ============================================================ */
window.__setTheme = applyTheme;
renderPresetOptions();

window.__loadDemo = function () {
  $('#settings-modal').classList.add('hidden');
  state.folders = [
    { id: 'demo-f1', name: '前端重构', createdAt: 1 },
    { id: 'demo-f2', name: '数据管道', createdAt: 2 },
  ];
  state.sessions = [
    { id: 'demo-s1', title: '帮我分析这个项目的结构', updatedAt: 5, folderId: null, archived: false },
    { id: 'demo-s2', title: '把日志解析脚本改成流式', updatedAt: 4, folderId: 'demo-f1', archived: false },
    { id: 'demo-s3', title: '整理依赖升级清单', updatedAt: 3, folderId: 'demo-f1', archived: false },
    { id: 'demo-s4', title: '定时任务为什么夜里失败', updatedAt: 2, folderId: 'demo-f2', archived: false },
    { id: 'demo-s5', title: '旧的接口联调记录', updatedAt: 1, folderId: null, archived: true, archivedAt: 1 },
  ];
  state.sessionId = 'demo-s1';
  state.sessionTitle = '帮我分析这个项目的结构';
  state.archiveOpen = true;
  renderSidebar();

  const demo = [
    { role: 'user', content: '帮我分析当前工作目录的项目结构，说说这是个什么项目。' },
    {
      role: 'assistant', content: '',
      tool_calls: [{
        id: 'call_demo_1', type: 'function',
        function: { name: 'list_dir', arguments: '{"path": "."}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_demo_1', content: '[目录] src/\n[目录] tests/\n[文件] package.json (486 字节)\n[文件] README.md (2310 字节)\n[文件] main.py (1240 字节)' },
    {
      role: 'assistant', content: '这是一个结构清晰的 **Python + Node 混合项目**，整体分析如下：\n\n## 项目结构\n\n```\n.\n├── src/          # 源代码目录\n├── tests/        # 测试目录\n├── main.py       # 程序入口\n├── package.json  # Node 工具链配置\n└── README.md     # 项目说明\n```\n\n## 结论\n\n- 入口是 `main.py`，配套 `tests/` 单元测试\n- `package.json` 说明前端/工具链用了 Node\n- 项目规模较小，属于典型的**命令行工具型项目**\n\n需要我进一步阅读 `main.py` 并总结核心逻辑吗？',
      reasoning_content: '用户想了解项目结构。我先用 list_dir 看了根目录，发现是 Python 项目带 Node 工具链。可以给出结论了。',
    },
  ];
  renderMessages(demo);
};

init();
