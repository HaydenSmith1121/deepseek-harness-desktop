'use strict';

/* ============ DeepSeek Harness 渲染层 ============ */

const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  sessions: [],
  sessionId: null,
  sessionTitle: '',
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

/* ============ 初始化 ============ */
async function init() {
  state.settings = await window.harness.getSettings();
  const info = await window.harness.appInfo();
  $('#app-version').textContent = 'v' + info.version;

  state.unsubscribe = window.harness.onEvent(handleAgentEvent);

  bindUi();
  await refreshSessions();

  // 恢复最近会话或新建
  if (state.sessions.length) {
    await openSession(state.sessions[0].id);
  } else {
    await newSession(false);
  }
  applySettingsToUi();

  if (!state.settings.hasApiKey) openSettings();
}

function bindUi() {
  $('#btn-new-chat').addEventListener('click', () => newSession(true));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', closeSettings);
  $('#btn-settings-save').addEventListener('click', saveSettings);
  $('#btn-save-key').addEventListener('click', saveApiKey);
  $('#btn-pick-workspace').addEventListener('click', pickWorkspace);
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
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });

  document.querySelectorAll('.example').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#input').value = btn.dataset.prompt;
      $('#input').dispatchEvent(new Event('input'));
      $('#input').focus();
    });
  });

  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#settings-modal')) closeSettings();
  });
}

/* ============ 会话 ============ */
async function refreshSessions() {
  state.sessions = await window.harness.listSessions();
  renderSessionList();
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');
    item.innerHTML = `<span class="s-title"></span><button class="s-del" title="删除">✕</button>`;
    item.querySelector('.s-title').textContent = s.title || '新对话';
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('s-del')) return;
      openSession(s.id);
    });
    item.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.harness.deleteSession(s.id);
      if (s.id === state.sessionId) await newSession(false);
      await refreshSessions();
      if (!state.sessions.length) await newSession(false);
    });
    list.appendChild(item);
  }
}

async function newSession(switchFocus) {
  if (state.running) return;
  const s = await window.harness.createSession();
  state.sessionId = s.id;
  state.sessionTitle = s.title;
  await refreshSessions();
  renderMessages([]);
  if (switchFocus) $('#input').focus();
}

async function openSession(id) {
  if (state.running) return;
  const s = await window.harness.getSession(id);
  if (!s) return;
  state.sessionId = id;
  state.sessionTitle = s.title;
  renderSessionList();
  renderMessages(s.messages || []);
}

function renderMessages(messages) {
  const chat = $('#chat');
  chat.innerHTML = '';
  $('#welcome').classList.add('hidden');
  if (!messages.length) {
    const w = $('#welcome').cloneNode(true);
    w.classList.remove('hidden');
    w.querySelectorAll('.example').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('#input').value = btn.dataset.prompt;
        $('#input').dispatchEvent(new Event('input'));
        $('#input').focus();
      });
    });
    chat.appendChild(w);
  }
  for (const m of messages) appendMessageEl(m);
  updateTopbar();
  scrollBottom();
}

/* ============ 消息渲染 ============ */
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
  contentEl.innerHTML = md(obj.rawContent);
  return obj;
}

function buildToolCard({ callId, name, args, status }) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.callId = callId || '';
  const icon = TOOL_ICONS[name] || '🔧';
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
    return a.path || a.pattern || a.url || '';
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

/* ============ Agent 事件 ============ */
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

/* ============ 发送 / 停止 ============ */
async function send() {
  if (state.running) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

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

/* ============ 设置 ============ */
function openSettings() {
  applySettingsToUi();
  $('#settings-modal').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-modal').classList.add('hidden');
}

function applySettingsToUi() {
  const s = state.settings;
  $('#input-model').value = s.model;
  $('#input-temperature').value = s.temperature;
  $('#temp-value').textContent = s.temperature;
  $('#input-maxtokens').value = s.maxTokens;
  $('#input-approval').value = s.approvalMode;
  $('#input-workspace').value = s.workspace || '';
  $('#input-baseurl').value = s.baseUrl || '';
  const ks = $('#key-status');
  if (s.hasApiKey) {
    ks.textContent = `已保存 (${s.apiKeyMasked}${s.apiKeyPlain ? ' · 未加密' : ' · 已加密'})`;
    ks.style.color = s.apiKeyPlain ? 'var(--yellow)' : 'var(--green)';
  } else {
    ks.textContent = '未配置';
    ks.style.color = 'var(--red)';
  }
  updateTopbar();
}

async function saveApiKey() {
  const key = $('#input-apikey').value.trim();
  if (!key) return;
  const r = await window.harness.setApiKey(key);
  if (r.ok) {
    $('#input-apikey').value = '';
    state.settings = await window.harness.getSettings();
    applySettingsToUi();
  }
}

async function saveSettings() {
  await window.harness.setSettings({
    model: $('#input-model').value,
    temperature: Number($('#input-temperature').value),
    maxTokens: Number($('#input-maxtokens').value),
    approvalMode: $('#input-approval').value,
    baseUrl: $('#input-baseurl').value.trim() || 'https://api.deepseek.com',
  });
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
  const labels = { 'confirm-dangerous': '确认危险操作', 'confirm-all': '全部确认', 'auto': '全自动' };
  const next = order[(order.indexOf(state.settings.approvalMode) + 1) % order.length];
  await window.harness.setSettings({ approvalMode: next });
  state.settings = await window.harness.getSettings();
  updateTopbar();
}

function updateTopbar() {
  const s = state.settings;
  if (!s) return;
  $('#topbar-title').textContent = state.sessionTitle || '新对话';
  $('#badge-model').textContent = s.model;
  const labels = { 'confirm-dangerous': '🛡 确认危险操作', 'confirm-all': '🛡 全部确认', 'auto': '⚡ 全自动' };
  const badge = $('#badge-approval');
  badge.textContent = labels[s.approvalMode] || s.approvalMode;
  badge.style.color = s.approvalMode === 'auto' ? 'var(--yellow)' : 'var(--green)';
  $('#badge-workspace').textContent = s.workspace || '未设置工作目录';
  $('#badge-workspace').title = s.workspace || '';
}

/* ============ 工具函数 ============ */
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

/* ============ 演示模式（--screenshot 截图用） ============ */
window.__loadDemo = function () {
  state.settings = state.settings || { model: 'deepseek-chat', approvalMode: 'confirm-dangerous', workspace: 'C:\\Users\\demo\\my-project' };
  state.sessionTitle = '帮我分析这个项目的结构';
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
  $('#topbar-title').textContent = state.sessionTitle;
  $('#badge-model').textContent = state.settings.model;
  $('#badge-approval').textContent = '🛡 确认危险操作';
  $('#badge-workspace').textContent = state.settings.workspace;
};

init();
