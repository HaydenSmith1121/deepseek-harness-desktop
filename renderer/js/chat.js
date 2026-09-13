'use strict';

/* Chat page: multi-conversation streaming chat with live token/cost stats. */
window.Harness = window.Harness || { pages: {} };
Harness.registerPage = Harness.registerPage || function () {};

(function () {
  const { $, $$, el, toast, fmtCost, fmtTokens, fmtDuration, debounce, uid } = U;

  const state = {
    conversations: [],       // [{id, title, model, createdAt, updatedAt, messages:[]}]
    currentId: null,
    streaming: false,
    // streaming buffers for the in-flight assistant message
    streamBuf: { content: '', reasoning: '' },
    streamMsgEl: null,
    sessionTotals: { tokens: 0, cost: 0 }
  };

  // ---------- DOM refs ----------
  let convList, messagesEl, emptyEl, inputArea, btnSend, btnStop, btnClear, btnNew;
  let titleEl, statMsgs, statTokens, statCost;
  let paramModel, paramSystem, paramTemp, lblTemp, paramTopp, lblTopp, paramMaxTokens,
    paramFreq, paramPres, paramStop, noteReasoner;

  function cacheDom() {
    convList = $('#conv-list');
    messagesEl = $('#chat-messages');
    emptyEl = $('#chat-empty');
    inputArea = $('#chat-input-area');
    btnSend = $('#btn-send');
    btnStop = $('#btn-stop');
    btnClear = $('#btn-clear-chat');
    btnNew = $('#btn-new-conv');
    titleEl = $('#chat-title');
    statMsgs = $('#stat-msgs');
    statTokens = $('#stat-tokens');
    statCost = $('#stat-cost');
    paramModel = $('#param-model');
    paramSystem = $('#param-system');
    paramTemp = $('#param-temperature');
    lblTemp = $('#lbl-temp');
    paramTopp = $('#param-topp');
    lblTopp = $('#lbl-topp');
    paramMaxTokens = $('#param-maxtokens');
    paramFreq = $('#param-freq');
    paramPres = $('#param-pres');
    paramStop = $('#param-stop');
    noteReasoner = $('#param-note-reasoner');
  }

  // ---------- conversations ----------
  function newConversation(silent) {
    const conv = {
      id: uid(),
      title: '新会话',
      model: paramModel ? paramModel.value : 'deepseek-chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    state.conversations.unshift(conv);
    state.currentId = conv.id;
    state.sessionTotals = { tokens: 0, cost: 0 };
    renderConvList();
    renderMessages();
    renderStats();
    if (!silent) messagesEl.scrollTop = messagesEl.scrollHeight;
    return conv;
  }

  function currentConv() {
    return state.conversations.find((c) => c.id === state.currentId) || null;
  }

  function renderConvList() {
    convList.innerHTML = '';
    for (const conv of state.conversations) {
      const del = el('button', {
        class: 'icon-btn danger conv-del',
        title: '删除',
        onclick: async (e) => {
          e.stopPropagation();
          await HarnessAPI.conversations.delete(conv.id);
          state.conversations = state.conversations.filter((c) => c.id !== conv.id);
          if (state.currentId === conv.id) {
            if (state.conversations.length) switchTo(state.conversations[0].id);
            else newConversation();
          }
          toast('会话已删除');
        }
      });
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      const item = el('div', {
        class: 'conv-item' + (conv.id === state.currentId ? ' active' : ''),
        onclick: () => switchTo(conv.id)
      }, el('span', { class: 'conv-name' }, conv.title), del);
      convList.append(item);
    }
  }

  async function switchTo(id) {
    if (state.streaming) {
      toast('请先等待或停止当前生成', 'err');
      return;
    }
    state.currentId = id;
    const conv = currentConv();
    if (conv) {
      state.sessionTotals = conv.messages
        .filter((m) => m.role === 'assistant')
        .reduce((acc, m) => ({
          tokens: acc.tokens + ((m.meta && m.meta.totalTokens) || 0),
          cost: acc.cost + ((m.meta && m.meta.cost) || 0)
        }), { tokens: 0, cost: 0 });
      paramModel.value = conv.model || 'deepseek-chat';
    }
    renderConvList();
    renderMessages();
    renderStats();
  }

  async function persistCurrent() {
    const conv = currentConv();
    if (conv && conv.messages.length) await HarnessAPI.conversations.save(conv);
  }

  // ---------- message rendering ----------
  function renderMessages() {
    messagesEl.innerHTML = '';
    const conv = currentConv();
    titleEl.textContent = conv ? conv.title : '新会话';
    if (!conv || !conv.messages.length) {
      messagesEl.append(emptyEl);
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    for (const m of conv.messages) messagesEl.append(renderMessage(m));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessage(m) {
    const isUser = m.role === 'user';
    const avatar = el('div', { class: 'msg-avatar' });
    if (isUser) avatar.textContent = '你';
    else {
      avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none"/></svg>';
    }
    const body = el('div', { class: 'msg-body' });
    body.append(el('div', { class: 'msg-role' }, isUser ? '你' : 'DeepSeek'));

    if (m.reasoning) body.append(renderReasoning(m.reasoning, true));

    const content = el('div', { class: 'msg-content' });
    content.innerHTML = m.streaming ? Md.render(m.content) + '<span class="stream-cursor"></span>' : Md.render(m.content);
    body.append(content);

    if (m.meta) {
      const meta = el('div', { class: 'msg-meta' });
      if (m.meta.latencyMs != null) meta.append(el('span', {}, '⏱ ' + fmtDuration(m.meta.latencyMs)));
      if (m.meta.totalTokens != null) {
        meta.append(el('span', {}, '⇅ ' + fmtTokens(m.meta.totalTokens) + ' tokens（出 ' + fmtTokens(m.meta.completionTokens) + '）'));
      }
      if (m.meta.cost != null) meta.append(el('span', {}, '◈ ' + fmtCost(m.meta.cost)));
      if (m.meta.cacheHitTokens) meta.append(el('span', {}, '⚡ 缓存命中 ' + fmtTokens(m.meta.cacheHitTokens)));
      body.append(meta);
    }
    return el('div', { class: 'msg ' + m.role }, avatar, body);
  }

  function renderReasoning(text, collapsed) {
    const box = el('div', { class: 'reasoning' + (collapsed ? '' : ' open') });
    const toggle = el('button', { class: 'reasoning-toggle' });
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>思考过程';
    const body = el('div', { class: 'reasoning-body' }, text);
    toggle.addEventListener('click', () => box.classList.toggle('open'));
    box.append(toggle, body);
    return box;
  }

  function renderStats() {
    const conv = currentConv();
    const count = conv ? conv.messages.length : 0;
    statMsgs.textContent = count + ' 条消息';
    statTokens.textContent = fmtTokens(state.sessionTotals.tokens) + ' tokens';
    statCost.textContent = fmtCost(state.sessionTotals.cost);
  }

  // ---------- params ----------
  function collectParams() {
    return {
      model: paramModel.value,
      system: paramSystem.value.trim(),
      temperature: paramTemp.value,
      topP: paramTopp.value,
      maxTokens: Number(paramMaxTokens.value) || 2048,
      frequencyPenalty: paramFreq.value,
      presencePenalty: paramPres.value,
      stop: paramStop.value.trim()
    };
  }

  function onModelChange() {
    const isReasoner = paramModel.value === 'deepseek-reasoner';
    noteReasoner.classList.toggle('hidden', !isReasoner);
    [paramTemp, paramTopp, paramFreq, paramPres].forEach((n) => {
      n.disabled = isReasoner;
      n.parentElement.style.opacity = isReasoner ? 0.45 : 1;
    });
  }

  // ---------- send / stream ----------
  async function send() {
    if (state.streaming) return;
    const text = inputArea.value.trim();
    if (!text) return;
    const conv = currentConv() || newConversation(true);
    if (conv.messages.length === 0) {
      conv.title = text.slice(0, 24) + (text.length > 24 ? '…' : '');
    }
    conv.model = paramModel.value;

    const userMsg = { role: 'user', content: text };
    conv.messages.push(userMsg);
    inputArea.value = '';
    autoGrow();

    if (emptyEl.parentNode === messagesEl) emptyEl.classList.add('hidden');
    messagesEl.append(renderMessage(userMsg));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    await persistCurrent();
    renderConvList();

    const params = collectParams();
    const assistantMsg = {
      role: 'assistant',
      content: '',
      reasoning: '',
      streaming: true,
      meta: null
    };
    conv.messages.push(assistantMsg);
    state.streaming = true;
    state.streamBuf = { content: '', reasoning: '' };

    const msgNode = renderMessage(assistantMsg);
    state.streamMsgEl = msgNode;
    messagesEl.append(msgNode);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setStreamingUI(true);

    const res = await HarnessAPI.chat.send({
      conversationId: conv.id,
      messages: conv.messages
        .filter((m) => m !== assistantMsg)
        .map((m) => ({ role: m.role, content: m.content })),
      params
    });
    if (!res.ok) {
      finishStreamWithError(res.error || '发送失败');
    }
  }

  const flushStream = debounce(() => {
    if (!state.streamMsgEl || !state.streaming) return;
    const conv = currentConv();
    const m = conv && conv.messages[conv.messages.length - 1];
    if (!m || m.role !== 'assistant') return;
    m.content = state.streamBuf.content;
    m.reasoning = state.streamBuf.reasoning;
    const fresh = renderMessage({ ...m, streaming: true });
    state.streamMsgEl.replaceWith(fresh);
    state.streamMsgEl = fresh;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 90);

  function onChunk(chunk) {
    if (!state.streaming || !chunk || chunk.conversationId !== state.currentId) return;
    if (chunk.content) state.streamBuf.content += chunk.content;
    if (chunk.reasoning) state.streamBuf.reasoning += chunk.reasoning;
    flushStream();
  }

  function onDone(payload) {
    if (!payload || payload.conversationId !== state.currentId) return;
    const conv = currentConv();
    if (!conv) return;
    const m = conv.messages[conv.messages.length - 1];
    if (!m || m.role !== 'assistant') return;
    m.content = state.streamBuf.content || m.content;
    m.reasoning = state.streamBuf.reasoning || m.reasoning;
    m.streaming = false;
    m.meta = payload.usage ? {
      latencyMs: payload.latencyMs,
      totalTokens: payload.usage.totalTokens,
      completionTokens: payload.usage.completionTokens,
      promptTokens: payload.usage.promptTokens,
      cacheHitTokens: payload.usage.cacheHitTokens,
      cost: payload.cost
    } : { latencyMs: payload.latencyMs, cost: payload.cost, totalTokens: 0, completionTokens: 0 };
    state.sessionTotals.tokens += m.meta.totalTokens || 0;
    state.sessionTotals.cost += m.meta.cost || 0;
    state.streaming = false;
    renderMessages();
    renderStats();
    setStreamingUI(false);
    persistCurrent();
  }

  function onError(payload) {
    if (!payload || payload.conversationId !== state.currentId) return;
    const msg = payload.aborted ? '已停止生成' : payload.message;
    finishStreamWithError(msg);
  }

  function finishStreamWithError(message) {
    const conv = currentConv();
    if (conv) {
      const m = conv.messages[conv.messages.length - 1];
      if (m && m.role === 'assistant') {
        if (!m.content) {
          m.content = '⚠️ ' + message;
        }
        m.streaming = false;
      }
    }
    state.streaming = false;
    renderMessages();
    renderStats();
    setStreamingUI(false);
    if (message && message.indexOf('已停止') === -1) toast(message, 'err', 4200);
    persistCurrent();
  }

  function setStreamingUI(on) {
    btnSend.classList.toggle('hidden', on);
    btnStop.classList.toggle('hidden', !on);
  }

  async function stop() {
    const conv = currentConv();
    if (conv) await HarnessAPI.chat.abort(conv.id);
  }

  function autoGrow() {
    inputArea.style.height = 'auto';
    inputArea.style.height = Math.min(inputArea.scrollHeight, 180) + 'px';
  }

  // ---------- init ----------
  function init() {
    cacheDom();

    paramTemp.addEventListener('input', () => { lblTemp.textContent = Number(paramTemp.value).toFixed(1); });
    paramTopp.addEventListener('input', () => { lblTopp.textContent = Number(paramTopp.value).toFixed(2); });
    paramModel.addEventListener('change', onModelChange);

    btnSend.addEventListener('click', send);
    btnStop.addEventListener('click', stop);
    btnClear.addEventListener('click', async () => {
      const conv = currentConv();
      if (!conv || !conv.messages.length) return;
      conv.messages = [];
      conv.title = '新会话';
      state.sessionTotals = { tokens: 0, cost: 0 };
      renderMessages();
      renderConvList();
      renderStats();
      await persistCurrent();
    });
    btnNew.addEventListener('click', () => newConversation());

    inputArea.addEventListener('input', autoGrow);
    inputArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    $$('.hint-chip', emptyEl).forEach((chip) => {
      chip.addEventListener('click', () => {
        inputArea.value = chip.dataset.fill;
        autoGrow();
        inputArea.focus();
      });
    });

    HarnessAPI.chat.onChunk(onChunk);
    HarnessAPI.chat.onDone(onDone);
    HarnessAPI.chat.onError(onError);

    (async () => {
      const list = await HarnessAPI.conversations.list();
      state.conversations = Array.isArray(list) ? list : [];
      if (state.conversations.length) {
        switchTo(state.conversations[0].id);
        renderConvList();
      } else {
        newConversation();
      }
      // apply default params from settings
      const s = window.APP_SETTINGS;
      if (s && s.defaults) {
        if (s.defaults.model) paramModel.value = s.defaults.model;
        if (s.defaults.temperature != null) { paramTemp.value = s.defaults.temperature; lblTemp.textContent = Number(s.defaults.temperature).toFixed(1); }
        if (s.defaults.topP != null) { paramTopp.value = s.defaults.topP; lblTopp.textContent = Number(s.defaults.topP).toFixed(2); }
        if (s.defaults.maxTokens != null) paramMaxTokens.value = s.defaults.maxTokens;
        if (s.defaults.system) paramSystem.value = s.defaults.system;
        onModelChange();
      }
    })();
  }

  Harness.pages.chat = { init };
})();
