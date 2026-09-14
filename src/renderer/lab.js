'use strict';

/* ============ DeepSeek Harness · 评测台（批量评测 / 模型对比） ============ */
/* 独立作用域，避免与 app.js 的顶层 const 冲突 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  const DEFAULT_SAMPLE_DATASET = [
    '# 每行一条提示词；用 | 分隔期望关键词（命中即判定「通过」）',
    '用一句话解释什么是 HTTP | HTTP,协议',
    '把这句话翻译成英文：今天天气不错',
    '用 Python 写一个函数，判断一个整数是否为质数 | def',
    '总结 Transformer 的核心思想，控制在 50 字以内 | attention,注意力',
    '如果一个项目有 3 个开发、2 周排期，估算需要的测试用例数量并说明理由',
  ].join('\n');

  const DEFAULT_SAMPLE_PROMPTS = [
    '用一句话解释什么是闭包',
    '把「你好，世界」翻译成日语',
    '给一个 5 岁小孩解释什么是重力',
  ].join('\n');

  const lab = {
    view: 'chat',
    tab: 'batch',
    settings: null,
    batch: { runId: null, running: false, result: null },
    compare: { runId: null, running: false, result: null },
    unsubscribe: null,
  };

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function renderMd(text) {
    try {
      if (window.marked && typeof window.marked.parse === 'function') {
        return window.marked.parse(String(text || ''), { breaks: true, gfm: true });
      }
    } catch {
      /* 降级为纯文本 */
    }
    const d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
  }

  const num = (v, digits = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : '—';
  };

  const ms = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v))} ms` : '—');

  const money = (v) => `¥${(Number(v) || 0).toFixed(4)}`;

  function progressText(t) {
    return t ? `${t.done}/${t.total}` : '';
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(view) {
    lab.view = view;
    document.body.dataset.view = view;
    $('#main').classList.toggle('hidden', view !== 'chat');
    $('#view-lab').classList.toggle('hidden', view !== 'lab');
    document.querySelectorAll('#nav .nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'lab' && !lab.settings) loadSettings();
  }

  function switchTab(tab) {
    lab.tab = tab;
    $('#lab-batch').classList.toggle('hidden', tab !== 'batch');
    $('#lab-compare').classList.toggle('hidden', tab !== 'compare');
    document.querySelectorAll('.lab-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    updateExportButtons();
  }

  /* ---------------- 设置同步 ---------------- */
  async function loadSettings() {
    lab.settings = await window.harness.getSettings();
    const s = lab.settings;
    if (!s) return;
    if (!$('#batch-model').value) $('#batch-model').value = s.model || 'deepseek-chat';
    if (!$('#batch-temp').value) $('#batch-temp').value = s.temperature ?? 0.7;
    if (!$('#batch-maxtokens').value) $('#batch-maxtokens').value = s.maxTokens ?? 4096;
    if (!$('#batch-concurrency').value) $('#batch-concurrency').value = 3;
    if (!$('#batch-retries').value) $('#batch-retries').value = 1;
    if (!$('#cmp-repeats').value) $('#cmp-repeats').value = 1;
    if (!$('#cmp-concurrency').value) $('#cmp-concurrency').value = 3;
    if ($('#cmp-configs').children.length === 0) {
      addConfig({ label: 'A · deepseek-chat', model: 'deepseek-chat' });
      addConfig({ label: 'B · deepseek-reasoner', model: 'deepseek-reasoner' });
    }
  }

  function updateExportButtons() {
    const result = lab.tab === 'batch' ? lab.batch.result : lab.compare.result;
    $('#lab-export-json').disabled = !result;
    $('#lab-export-csv').disabled = !result;
  }

  /* ---------------- 批量评测 ---------------- */
  function batchPayload() {
    return {
      text: $('#batch-dataset').value,
      config: {
        model: $('#batch-model').value,
        system: $('#batch-system').value.trim() || undefined,
        temperature: Number($('#batch-temp').value),
        maxTokens: Number($('#batch-maxtokens').value),
      },
      settings: {
        concurrency: Number($('#batch-concurrency').value) || 3,
        retries: Number($('#batch-retries').value) || 0,
      },
    };
  }

  async function runBatch() {
    if (lab.batch.running) return;
    const hint = $('#lab-badge-progress');
    const r = await window.harness.labRunBatch(batchPayload());
    if (!r.ok) {
      hint.textContent = '⚠ ' + (r.error || '启动失败');
      return;
    }
    lab.batch.runId = r.runId;
    lab.batch.result = null;
    setBatchRunning(true);
    $('#lab-badge-progress').textContent = '准备中…';
    renderBatchSummary(null);
    $('#batch-results').innerHTML = '';
    $('#batch-results').appendChild(el('div', 'empty-hint', '正在评测，请稍候…'));
  }

  function setBatchRunning(v) {
    lab.batch.running = v;
    $('#batch-run').disabled = v;
    $('#batch-run').classList.toggle('hidden', v);
    $('#batch-stop').classList.toggle('hidden', !v);
    if (!v) lab.batch.runId = null;
  }

  function stopBatch() {
    if (lab.batch.runId) window.harness.labStop(lab.batch.runId);
  }

  function renderBatchSummary(summary) {
    const box = $('#batch-summary');
    box.innerHTML = '';
    const s = summary || {};
    const cards = [
      { label: '用例总数', value: s.total ?? '—' },
      { label: '成功 / 失败', value: summary ? `${s.okCount ?? 0} / ${s.apiErrors ?? 0}` : '—' },
      {
        label: '关键词通过率',
        value: s.accuracy === null || s.accuracy === undefined ? '—' : `${(s.accuracy * 100).toFixed(1)}%`,
        tone: s.accuracy === null || s.accuracy === undefined ? '' : s.accuracy >= 0.8 ? 'ok' : s.accuracy >= 0.5 ? 'warn' : 'bad',
      },
      { label: '平均延迟', value: summary ? ms(s.avgLatencyMs) : '—' },
      { label: '总 tokens', value: summary ? s.totalTokens ?? 0 : '—' },
      { label: '预估成本', value: summary ? money(s.totalCost) : '—' },
    ];
    for (const c of cards) {
      const card = el('div', 'stat-card' + (c.tone ? ' ' + c.tone : ''));
      card.appendChild(el('div', 'stat-label', c.label));
      card.appendChild(el('div', 'stat-value', c.value));
      box.appendChild(card);
    }
  }

  function renderBatchResults(result) {
    const box = $('#batch-results');
    box.innerHTML = '';
    if (!result || !result.results || !result.results.length) {
      box.appendChild(el('div', 'empty-hint', '没有结果'));
      return;
    }
    const table = el('table', 'result-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['#', '状态', '判定', '延迟', '输入', '输出', '命中缓存', '成本']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    result.results.forEach((r, i) => {
      const tr = el('tr', r.error ? 'row-error' : '');
      tr.appendChild(el('td', 'mono', r.id ?? i + 1));
      const st = el('td');
      const ok = r.ok !== false && !r.error;
      st.appendChild(el('span', 'pill ' + (r.skipped ? 'skip' : ok ? 'ok' : 'bad'), r.skipped ? '跳过' : ok ? '成功' : '失败'));
      tr.appendChild(st);
      const judge = el('td');
      if (r.passed === true) judge.appendChild(el('span', 'pill ok', '通过'));
      else if (r.passed === false) judge.appendChild(el('span', 'pill bad', '未通过'));
      else judge.appendChild(el('span', 'dim', '—'));
      tr.appendChild(judge);
      tr.appendChild(el('td', 'mono', ms(r.latencyMs)));
      tr.appendChild(el('td', 'mono', (r.usage && r.usage.promptTokens) || 0));
      tr.appendChild(el('td', 'mono', (r.usage && r.usage.completionTokens) || 0));
      tr.appendChild(el('td', 'mono', (r.usage && r.usage.cacheHitTokens) || 0));
      tr.appendChild(el('td', 'mono', money(r.cost)));
      tbody.appendChild(tr);

      // 展开行：提示词 / 输出 / 错误
      const detail = el('tr', 'row-detail hidden');
      const td = el('td');
      td.colSpan = 8;
      const inner = el('div', 'detail-inner');
      inner.appendChild(el('div', 'detail-label', '提示词'));
      inner.appendChild(el('pre', 'detail-pre', r.prompt || ''));
      if (r.expectKeywords && r.expectKeywords.length) {
        inner.appendChild(el('div', 'detail-label', '期望关键词'));
        inner.appendChild(el('pre', 'detail-pre', r.expectKeywords.join(', ')));
      }
      if (r.reasoning) {
        inner.appendChild(el('div', 'detail-label', '思考过程'));
        inner.appendChild(el('pre', 'detail-pre', r.reasoning));
      }
      inner.appendChild(el('div', 'detail-label', r.error ? '错误' : '模型输出'));
      if (r.error) {
        inner.appendChild(el('pre', 'detail-pre err', r.error));
      } else {
        const mdBox = el('div', 'detail-md md-content');
        mdBox.innerHTML = renderMd(r.content || '(空)');
        inner.appendChild(mdBox);
      }
      td.appendChild(inner);
      detail.appendChild(td);
      tbody.appendChild(detail);

      tr.addEventListener('click', () => detail.classList.toggle('hidden'));
      tr.classList.add('clickable');
    });

    table.appendChild(tbody);
    box.appendChild(table);
  }

  /* ---------------- 模型对比 ---------------- */
  function addConfig(preset) {
    const box = $('#cmp-configs');
    const cfg = preset || { label: `配置 ${box.children.length + 1}`, model: 'deepseek-chat' };
    const row = el('div', 'cmp-config');

    const head = el('div', 'cmp-config-head');
    const label = el('input', 'cmp-label');
    label.type = 'text';
    label.value = cfg.label || '';
    label.placeholder = '备注名';
    head.appendChild(label);
    const del = el('button', 'btn-mini danger', '✕');
    del.addEventListener('click', () => row.remove());
    head.appendChild(del);
    row.appendChild(head);

    const modelSel = el('select', 'cmp-model');
    for (const m of ['deepseek-chat', 'deepseek-reasoner']) {
      const o = el('option', null, m);
      o.value = m;
      modelSel.appendChild(o);
    }
    modelSel.value = cfg.model || 'deepseek-chat';
    row.appendChild(modelSel);

    const params = el('div', 'cmp-params');
    const temp = el('input', 'cmp-temp');
    temp.type = 'number';
    temp.min = '0';
    temp.max = '2';
    temp.step = '0.1';
    temp.placeholder = '温度';
    temp.value = cfg.temperature ?? '';
    const maxTok = el('input', 'cmp-maxtokens');
    maxTok.type = 'number';
    maxTok.min = '1';
    maxTok.step = '256';
    maxTok.placeholder = '最大 tokens';
    maxTok.value = cfg.maxTokens ?? '';
    params.appendChild(temp);
    params.appendChild(maxTok);
    row.appendChild(params);

    box.appendChild(row);
  }

  function comparePayload() {
    const configs = Array.from($('#cmp-configs').children).map((row, i) => ({
      id: 'cfg-' + (i + 1),
      label: row.querySelector('.cmp-label').value.trim() || `配置 ${i + 1}`,
      model: row.querySelector('.cmp-model').value,
      temperature: row.querySelector('.cmp-temp').value === '' ? undefined : Number(row.querySelector('.cmp-temp').value),
      maxTokens: row.querySelector('.cmp-maxtokens').value === '' ? undefined : Number(row.querySelector('.cmp-maxtokens').value),
    }));
    return {
      text: $('#cmp-prompts').value,
      configs,
      repeats: Number($('#cmp-repeats').value) || 1,
      settings: { concurrency: Number($('#cmp-concurrency').value) || 3 },
    };
  }

  async function runCompare() {
    if (lab.compare.running) return;
    const r = await window.harness.labRunCompare(comparePayload());
    if (!r.ok) {
      $('#lab-badge-progress').textContent = '⚠ ' + (r.error || '启动失败');
      return;
    }
    lab.compare.runId = r.runId;
    lab.compare.result = null;
    setCompareRunning(true);
    $('#lab-badge-progress').textContent = '准备中…';
    $('#cmp-summary').innerHTML = '';
    $('#cmp-summary').appendChild(el('div', 'empty-hint', '正在对比，请稍候…'));
  }

  function setCompareRunning(v) {
    lab.compare.running = v;
    $('#cmp-run').disabled = v;
    $('#cmp-run').classList.toggle('hidden', v);
    $('#cmp-stop').classList.toggle('hidden', !v);
    if (!v) lab.compare.runId = null;
  }

  function stopCompare() {
    if (lab.compare.runId) window.harness.labStop(lab.compare.runId);
  }

  function renderCompareResults(result) {
    const box = $('#cmp-summary');
    box.innerHTML = '';
    if (!result || !result.perConfig || !result.perConfig.length) {
      box.appendChild(el('div', 'empty-hint', '没有结果'));
      return;
    }

    /* 1) 配置汇总表 */
    box.appendChild(el('div', 'section-title', '配置汇总'));
    const table = el('table', 'result-table');
    const hr = el('tr');
    for (const h of ['配置', '模型', '成功/失败', '平均延迟', '平均 tokens', '平均成本', '输出字数']) {
      hr.appendChild(el('th', null, h));
    }
    const thead = el('thead');
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    const best = {
      latency: Math.min(...result.perConfig.filter((c) => c.okCount).map((c) => c.avgLatencyMs || Infinity)),
      cost: Math.min(...result.perConfig.filter((c) => c.okCount).map((c) => c.avgCost || Infinity)),
    };
    for (const c of result.perConfig) {
      const tr = el('tr');
      tr.appendChild(el('td', 'strong', c.label));
      tr.appendChild(el('td', 'mono', c.model));
      tr.appendChild(el('td', 'mono', `${c.okCount}/${c.errorCount}`));
      tr.appendChild(el('td', 'mono' + (c.avgLatencyMs === best.latency ? ' best' : ''), c.avgLatencyMs ? ms(c.avgLatencyMs) : '—'));
      tr.appendChild(el('td', 'mono', c.avgTotalTokens ? Math.round(c.avgTotalTokens) : '—'));
      tr.appendChild(el('td', 'mono' + (c.avgCost === best.cost ? ' best' : ''), money(c.avgCost)));
      tr.appendChild(el('td', 'mono', c.avgOutputChars ? Math.round(c.avgOutputChars) : '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

    /* 2) 逐条并排对比 */
    box.appendChild(el('div', 'section-title', '逐条对比'));
    const byKey = new Map();
    for (const r of result.results) {
      const key = r.promptIndex;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const cfgLabel = new Map(result.perConfig.map((c) => [c.id, c.label]));
    for (const [pi, rows] of [...byKey.entries()].sort((a, b) => a[0] - b[0])) {
      const card = el('div', 'prompt-card');
      card.appendChild(el('div', 'prompt-text', `${pi + 1}. ${result.prompts[pi]}`));
      const grid = el('div', 'compare-grid');
      grid.style.gridTemplateColumns = `repeat(${Math.min(rows.length, 4)}, minmax(0, 1fr))`;
      for (const r of rows) {
        const cell = el('div', 'compare-cell');
        const head = el('div', 'compare-cell-head');
        head.appendChild(el('span', 'strong', cfgLabel.get(r.configId) || r.configId));
        head.appendChild(el('span', 'dim mono', `${ms(r.latencyMs)} · ${(r.usage && r.usage.completionTokens) || 0} tok`));
        cell.appendChild(head);
        if (r.ok === false || r.error) {
          cell.appendChild(el('div', 'compare-error', r.error || '请求失败'));
        } else {
          const body = el('div', 'compare-body md-content');
          body.innerHTML = renderMd(r.content || '(空)');
          cell.appendChild(body);
        }
        grid.appendChild(cell);
      }
      card.appendChild(grid);
      box.appendChild(card);
    }
  }

  /* ---------------- 导出 ---------------- */
  async function exportResult(format) {
    const isBatch = lab.tab === 'batch';
    const result = isBatch ? lab.batch.result : lab.compare.result;
    if (!result) return;
    const r = await window.harness.labExport({
      format,
      result,
      defaultName: isBatch ? 'batch-evaluation' : 'model-comparison',
    });
    if (r.ok) {
      $('#lab-badge-progress').textContent = '已导出 → ' + r.path;
    } else if (r.error) {
      $('#lab-badge-progress').textContent = '⚠ ' + r.error;
    }
  }

  /* ---------------- 事件 ---------------- */
  function handleLabEvent(evt) {
    const { runId, type, payload } = evt;
    const isBatch = lab.batch.runId === runId;
    const isCompare = lab.compare.runId === runId;
    if (!isBatch && !isCompare) return;

    if (type === 'progress') {
      $('#lab-badge-progress').textContent = (isBatch ? '评测中 ' : '对比中 ') + progressText(payload);
      return;
    }
    if (type === 'error') {
      $('#lab-badge-progress').textContent = '⚠ ' + payload.message;
      if (isBatch) {
        setBatchRunning(false);
        $('#batch-results').innerHTML = '';
        $('#batch-results').appendChild(el('div', 'empty-hint err', '运行失败：' + payload.message));
      } else {
        setCompareRunning(false);
        $('#cmp-summary').innerHTML = '';
        $('#cmp-summary').appendChild(el('div', 'empty-hint err', '运行失败：' + payload.message));
      }
      return;
    }
    if (type === 'done') {
      if (isBatch) {
        lab.batch.result = payload;
        setBatchRunning(false);
        renderBatchSummary(payload.summary);
        renderBatchResults(payload);
        $('#lab-badge-progress').textContent =
          `完成 · ${payload.summary.total} 条 / 用时 ${(payload.durationMs / 1000).toFixed(1)}s` +
          (payload.aborted ? '（已中断）' : '');
      } else {
        lab.compare.result = payload;
        setCompareRunning(false);
        renderCompareResults(payload);
        $('#lab-badge-progress').textContent = `完成 · 用时 ${(payload.durationMs / 1000).toFixed(1)}s` + (payload.aborted ? '（已中断）' : '');
      }
      updateExportButtons();
    }
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    document.querySelectorAll('#nav .nav-btn').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });
    document.querySelectorAll('.lab-tab').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    // 批量评测
    $('#batch-run').addEventListener('click', runBatch);
    $('#batch-stop').addEventListener('click', stopBatch);
    $('#batch-sample').addEventListener('click', () => {
      $('#batch-dataset').value = DEFAULT_SAMPLE_DATASET;
    });
    $('#batch-open').addEventListener('click', async () => {
      const r = await window.harness.labOpenDataset();
      if (r.ok) $('#batch-dataset').value = r.text;
      else if (r.error) $('#lab-badge-progress').textContent = '⚠ ' + r.error;
    });

    // 模型对比
    $('#cmp-run').addEventListener('click', runCompare);
    $('#cmp-stop').addEventListener('click', stopCompare);
    $('#cmp-add').addEventListener('click', () => addConfig());
    $('#cmp-sample').addEventListener('click', () => {
      $('#cmp-prompts').value = DEFAULT_SAMPLE_PROMPTS;
    });

    // 导出
    $('#lab-export-json').addEventListener('click', () => exportResult('json'));
    $('#lab-export-csv').addEventListener('click', () => exportResult('csv'));

    lab.unsubscribe = window.harness.onLabEvent(handleLabEvent);
    document.body.dataset.view = 'chat';
  }

  /* ---------------- 截图演示 ---------------- */
  window.__loadLabDemo = function () {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');
    switchView('lab');
    switchTab('batch');
    $('#batch-dataset').value = DEFAULT_SAMPLE_DATASET;
    $('#lab-badge-progress').textContent = '完成 · 5 条 / 用时 6.4s';

    const demo = {
      model: 'deepseek-chat',
      durationMs: 6412,
      summary: {
        total: 5, okCount: 5, apiErrors: 0, scored: 5, passed: 4, accuracy: 0.8,
        avgLatencyMs: 1180, totalTokens: 1382, totalCost: 0.00214,
      },
      results: [
        { id: 1, prompt: '用一句话解释什么是 HTTP', expectKeywords: ['HTTP', '协议'], ok: true, passed: true, latencyMs: 940, usage: { promptTokens: 24, completionTokens: 58, cacheHitTokens: 0, totalTokens: 82 }, cost: 0.000135, content: 'HTTP（超文本传输协议）是浏览器与服务器之间传输网页数据的**应用层协议**，采用请求—响应模型。' },
        { id: 2, prompt: '把这句话翻译成英文：今天天气不错', expectKeywords: [], ok: true, passed: null, latencyMs: 1020, usage: { promptTokens: 20, completionTokens: 14, cacheHitTokens: 0, totalTokens: 34 }, cost: 0.000044, content: 'The weather is nice today.' },
        { id: 3, prompt: '用 Python 写一个函数，判断一个整数是否为质数', expectKeywords: ['def'], ok: true, passed: true, latencyMs: 1480, usage: { promptTokens: 32, completionTokens: 210, cacheHitTokens: 0, totalTokens: 242 }, cost: 0.000446, content: '```python\ndef is_prime(n: int) -> bool:\n    if n < 2:\n        return False\n    for i in range(2, int(n ** 0.5) + 1):\n        if n % i == 0:\n            return False\n    return True\n```' },
        { id: 4, prompt: '总结 Transformer 的核心思想，控制在 50 字以内', expectKeywords: ['attention', '注意力'], ok: true, passed: true, latencyMs: 1290, usage: { promptTokens: 28, completionTokens: 46, cacheHitTokens: 0, totalTokens: 74 }, cost: 0.000114, content: '用**自注意力**并行建模序列中任意位置的依赖，取代循环结构，从而实现大规模高效训练。' },
        { id: 5, prompt: '如果一个项目有 3 个开发、2 周排期，估算需要的测试用例数量并说明理由', expectKeywords: ['用例'], ok: true, passed: false, latencyMs: 1170, usage: { promptTokens: 36, completionTokens: 168, cacheHitTokens: 0, totalTokens: 204 }, cost: 0.000365, content: '按人均每日 3~5 条估算，3 人 × 10 个工作日 ≈ 90~150 条，重点覆盖核心链路与边界条件。' },
      ],
    };
    lab.batch.result = demo;
    renderBatchSummary(demo.summary);
    renderBatchResults(demo);
    updateExportButtons();
  };

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!window.harness || !window.harness.onLabEvent) return;
    bind();
    loadSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
