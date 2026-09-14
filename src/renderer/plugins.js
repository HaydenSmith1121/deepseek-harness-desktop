'use strict';

/* ============ DeepSeek Harness · 插件管理 ============ */
/* 独立作用域，避免与 app.js 的顶层 const 冲突 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const DEFAULT_PARAMS = [
    '{',
    '  "type": "object",',
    '  "properties": {',
    '    "keyword": { "type": "string", "description": "要查询的内容" }',
    '  },',
    '  "required": ["keyword"]',
    '}',
  ].join('\n');

  const data = { plugins: [], builtin: [] };
  let editingId = null;
  let demoMode = false;

  /* ---------------- 渲染 ---------------- */
  function paramSummary(parameters) {
    let p = parameters;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch { return ''; }
    }
    const props = (p && p.properties) || {};
    const required = new Set((p && p.required) || []);
    const names = Object.keys(props);
    if (!names.length) return '无参数';
    return names
      .map((n) => {
        const t = (props[n] && props[n].type) || 'any';
        const mark = required.has(n) ? '必填' : '可选';
        return `${n} (${t}, ${mark})`;
      })
      .join(' · ');
  }

  function pluginCard(p) {
    const card = document.createElement('div');
    card.className = 'plugin-card' + (p.enabled ? '' : ' disabled');

    const head = document.createElement('div');
    head.className = 'plugin-head';

    const name = document.createElement('span');
    name.className = 'plugin-name';
    name.textContent = p.name;

    const tag = document.createElement('span');
    tag.className = 'plugin-tag';
    tag.textContent = `${p.method || 'GET'} · 自定义`;

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.title = '启用 / 停用';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.enabled;
    cb.addEventListener('change', async () => {
      if (demoMode) {
        p.enabled = cb.checked;
        render();
        return;
      }
      await window.harness.setPluginEnabled({ id: p.id, enabled: cb.checked });
      await reload();
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    sw.append(cb, slider);

    const edit = document.createElement('button');
    edit.className = 'btn-mini';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openEditor(p));

    const del = document.createElement('button');
    del.className = 'btn-mini danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const ok = await window.ui.askConfirm({
        title: '删除插件',
        desc: `插件「${p.name}」将被移除，模型将不再能调用它。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      if (demoMode) {
        data.plugins = data.plugins.filter((x) => x.id !== p.id);
        render();
        return;
      }
      await window.harness.deletePlugin(p.id);
      await reload();
    });

    head.append(name, tag, spacer, sw, edit, del);

    const desc = document.createElement('div');
    desc.className = 'plugin-desc';
    desc.textContent = p.description || '（无描述）';

    const url = document.createElement('div');
    url.className = 'plugin-url';
    url.textContent = `${p.method || 'GET'} ${p.url}`;

    const args = document.createElement('div');
    args.className = 'plugin-args';
    args.innerHTML = '参数：<b></b>';
    args.querySelector('b').textContent = paramSummary(p.parameters);

    card.append(head, desc, url, args);
    return card;
  }

  function builtinCard(t) {
    const card = document.createElement('div');
    card.className = 'plugin-card';

    const head = document.createElement('div');
    head.className = 'plugin-head';
    const name = document.createElement('span');
    name.className = 'plugin-name';
    name.textContent = t.name;
    const tag = document.createElement('span');
    tag.className = 'plugin-tag builtin';
    tag.textContent = '内置';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.append(name, tag, spacer);

    const desc = document.createElement('div');
    desc.className = 'plugin-desc';
    desc.textContent = t.description || '';

    const args = document.createElement('div');
    args.className = 'plugin-args';
    args.innerHTML = '参数：<b></b>';
    args.querySelector('b').textContent = paramSummary(t.parameters);

    card.append(head, desc, args);
    return card;
  }

  function render() {
    const list = $('#plugin-list');
    list.innerHTML = '';
    if (!data.plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'plugin-empty';
      empty.textContent = '还没有装插件。点右上角「＋ 安装插件」把任意 HTTP 接口接给智能体，或「导入 JSON」批量安装。';
      list.appendChild(empty);
    } else {
      for (const p of data.plugins) list.appendChild(pluginCard(p));
    }

    const builtin = $('#builtin-list');
    builtin.innerHTML = '';
    for (const t of data.builtin) builtin.appendChild(builtinCard(t));

    $('#plugin-count').textContent =
      data.plugins.filter((p) => p.enabled).length + ' / ' + data.plugins.length + ' 已启用';
  }

  async function reload() {
    if (demoMode) { render(); return; }
    const r = await window.harness.listPlugins();
    data.plugins = r.plugins || [];
    data.builtin = r.builtin || [];
    render();
  }

  /* ---------------- 编辑器 ---------------- */
  function showError(msg) {
    const el = $('#plugin-modal-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function openEditor(plugin) {
    editingId = plugin ? plugin.id : null;
    showError('');
    $('#plugin-modal-title').textContent = plugin ? '编辑插件' : '安装插件';
    $('#plugin-name').value = plugin ? plugin.name : '';
    $('#plugin-method').value = plugin ? plugin.method || 'GET' : 'GET';
    $('#plugin-desc').value = plugin ? plugin.description || '' : '';
    $('#plugin-url').value = plugin ? plugin.url || '' : '';
    $('#plugin-headers').value = plugin ? plugin.headers || '' : '';
    $('#plugin-body').value = plugin ? plugin.body || '' : '';
    $('#plugin-params').value = plugin && plugin.parameters
      ? (typeof plugin.parameters === 'string' ? plugin.parameters : JSON.stringify(plugin.parameters, null, 2))
      : DEFAULT_PARAMS;
    $('#plugin-timeout').value = plugin ? plugin.timeoutMs || 30000 : 30000;
    $('#plugin-enabled').value = plugin ? String(!!plugin.enabled) : 'true';
    $('#plugin-modal').classList.remove('hidden');
    $('#plugin-name').focus();
  }

  function closeEditor() {
    $('#plugin-modal').classList.add('hidden');
    editingId = null;
  }

  async function saveEditor() {
    let parameters;
    try {
      parameters = JSON.parse($('#plugin-params').value || '{}');
    } catch (err) {
      showError('参数 Schema 不是合法 JSON：' + err.message);
      return;
    }
    const payload = {
      id: editingId || undefined,
      name: $('#plugin-name').value.trim(),
      method: $('#plugin-method').value,
      description: $('#plugin-desc').value.trim(),
      url: $('#plugin-url').value.trim(),
      headers: $('#plugin-headers').value.trim(),
      body: $('#plugin-body').value,
      parameters,
      timeoutMs: Number($('#plugin-timeout').value) || 30000,
      enabled: $('#plugin-enabled').value === 'true',
    };
    if (!payload.name) { showError('请填写工具名'); return; }
    if (!payload.url) { showError('请填写接口地址'); return; }

    if (demoMode) {
      const i = data.plugins.findIndex((x) => x.id === editingId);
      const item = Object.assign({}, payload, { id: editingId || 'demo-' + Date.now() });
      if (i >= 0) data.plugins[i] = item;
      else data.plugins.push(item);
      closeEditor();
      render();
      return;
    }

    const r = await window.harness.savePlugin(payload);
    if (!r.ok) { showError(r.error || '保存失败'); return; }
    closeEditor();
    await reload();
  }

  /* ---------------- 导入 ---------------- */
  function openImport() {
    $('#import-text').value = '';
    $('#import-result').textContent = '';
    $('#import-filename').textContent = '未选择文件';
    $('#import-modal').classList.remove('hidden');
  }

  function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      $('#import-filename').textContent = f.name;
      const reader = new FileReader();
      reader.onload = () => { $('#import-text').value = String(reader.result || ''); };
      reader.onerror = () => { $('#import-result').textContent = '文件读取失败'; };
      reader.readAsText(f, 'utf-8');
    });
    input.click();
  }

  async function doImport() {
    const text = $('#import-text').value.trim();
    const out = $('#import-result');
    if (!text) { out.textContent = '请先选择文件或粘贴 JSON'; return; }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      out.textContent = 'JSON 解析失败：' + err.message;
      return;
    }
    if (demoMode) {
      const list = Array.isArray(parsed) ? parsed : parsed.plugins || [];
      for (const p of list) {
        data.plugins.push(Object.assign({ enabled: true, method: 'GET', id: 'demo-' + Math.random().toString(36).slice(2, 8) }, p));
      }
      render();
      out.textContent = `已导入 ${list.length} 个插件（演示模式）`;
      return;
    }
    const r = await window.harness.importPlugins(parsed);
    if (!r.ok) {
      out.textContent = '导入失败：' + (r.error || '未知错误') +
        (r.errors && r.errors.length ? ' ／ ' + r.errors.join('；') : '');
      return;
    }
    out.textContent = `已导入：${r.added.join('、')}` +
      (r.errors && r.errors.length ? ` ／ 跳过 ${r.errors.length} 条：${r.errors.join('；')}` : '');
    await reload();
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    $('#plugin-add').addEventListener('click', () => openEditor(null));
    $('#plugin-import').addEventListener('click', openImport);
    $('#btn-plugin-save').addEventListener('click', saveEditor);
    $('#btn-plugin-cancel').addEventListener('click', closeEditor);
    $('#btn-plugin-close').addEventListener('click', closeEditor);
    $('#plugin-modal').addEventListener('click', (e) => {
      if (e.target === $('#plugin-modal')) closeEditor();
    });
    $('#btn-import-close').addEventListener('click', () => $('#import-modal').classList.add('hidden'));
    $('#btn-import-cancel').addEventListener('click', () => $('#import-modal').classList.add('hidden'));
    $('#btn-import-file').addEventListener('click', pickFile);
    $('#btn-import-do').addEventListener('click', doImport);
    $('#import-modal').addEventListener('click', (e) => {
      if (e.target === $('#import-modal')) $('#import-modal').classList.add('hidden');
    });
  }

  /* ---------------- 演示（截图用） ---------------- */
  window.__loadPluginsDemo = function () {
    $('#settings-modal').classList.add('hidden');
    demoMode = true;
    window.ui.switchView('plugins');
    data.plugins = [
      {
        id: 'demo-p1', name: 'weather_query', enabled: true, method: 'GET',
        description: '查询指定城市的实时天气，返回温度、湿度与天气描述。',
        url: 'https://api.example.com/weather?city={{city}}',
        parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，如 杭州' } }, required: ['city'] },
        timeoutMs: 30000,
      },
      {
        id: 'demo-p2', name: 'kb_search', enabled: true, method: 'POST',
        description: '在公司内部知识库里检索文档，返回最相关的若干段落。',
        url: 'https://kb.example.com/api/search',
        parameters: { type: 'object', properties: { keyword: { type: 'string' }, top_k: { type: 'integer' } }, required: ['keyword'] },
        timeoutMs: 30000,
      },
      {
        id: 'demo-p3', name: 'ticket_create', enabled: false, method: 'POST',
        description: '在工单系统里创建一条新工单（写操作，默认需要确认）。',
        url: 'https://ticket.example.com/api/issues',
        parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
        timeoutMs: 30000,
      },
    ];
    if (!data.builtin.length) {
      data.builtin = [
        { name: 'read_file', description: '读取工作目录下某个文本文件的内容。二进制文件不支持。大文件只返回前一部分。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'write_file', description: '把文本内容写入文件（自动创建父目录）。写入工作目录之外会请求用户确认。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        { name: 'list_dir', description: '列出目录内容（含文件大小），用于探索项目结构。', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'run_command', description: '在用户操作系统的 shell 中执行命令，超时 120 秒。执行前通常需要用户确认。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'search_files', description: '按文件名通配符递归搜索文件（支持 * 和 **）。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
        { name: 'web_fetch', description: '抓取一个 http/https 网页或 API 的原始内容（截断到 8000 字符）。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      ];
    }
    render();
  };

  window.pluginsView = { reload };

  bind();
  reload();
})();
