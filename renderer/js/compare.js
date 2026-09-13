'use strict';

/* Model comparison page. */
window.Harness = window.Harness || {};
Harness.pages = Harness.pages || {};

(function () {
  const { $, $$, el, toast, fmtCost, fmtTokens, fmtDuration } = U;

  const state = {
    configs: [],
    running: false,
    lastRun: null
  };

  let configTbody, promptsArea, repeatsInput, runBtn, abortBtn, progressWrap, progressBar, progressText, resultsBox;

  function defaultConfigs() {
    return [
      { id: 'c1', label: 'V3', model: 'deepseek-chat', temperature: 1.0, maxTokens: 1024 },
      { id: 'c2', label: 'R1', model: 'deepseek-reasoner', temperature: '', maxTokens: 1024 }
    ];
  }

  function cacheDom() {
    configTbody = $('#compare-config-tbody');
    promptsArea = $('#compare-prompts');
    repeatsInput = $('#compare-repeats');
    runBtn = $('#btn-compare-run');
    abortBtn = $('#btn-compare-abort');
    progressWrap = $('#compare-progress-wrap');
    progressBar = $('#compare-progress-bar');
    progressText = $('#compare-progress-text');
    resultsBox = $('#compare-results');
  }

  function renderConfigs() {
    configTbody.innerHTML = '';
    state.configs.forEach((cfg, i) => {
      const del = el('button', {
        class: 'icon-btn danger',
        title: '删除',
        onclick: () => { state.configs.splice(i, 1); renderConfigs(); }
      });
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

      const modelSel = el('select', { onchange: (e) => { cfg.model = e.target.value; } },
        el('option', { value: 'deepseek-chat' }, 'deepseek-chat (V3)'),
        el('option', { value: 'deepseek-reasoner' }, 'deepseek-reasoner (R1)')
      );
      modelSel.value = cfg.model;

      configTbody.append(el('tr', {},
        el('td', {}, el('input', { type: 'text', value: cfg.label, oninput: (e) => { cfg.label = e.target.value; } })),
        el('td', {}, modelSel),
        el('td', {}, el('input', { type: 'number', step: '0.1', min: '0', max: '2', value: cfg.temperature, oninput: (e) => { cfg.temperature = e.target.value; } })),
        el('td', {}, el('input', { type: 'number', min: '1', max: '8192', value: cfg.maxTokens, oninput: (e) => { cfg.maxTokens = e.target.value; } })),
        el('td', {}, del)
      ));
    });
  }

  function addConfig() {
    state.configs.push({
      id: 'c' + Date.now().toString(36),
      label: '配置 ' + (state.configs.length + 1),
      model: 'deepseek-chat',
      temperature: 1.0,
      maxTokens: 1024
    });
    renderConfigs();
  }

  // ---------- run ----------
  async function run() {
    if (state.running) return;
    const prompts = promptsArea.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!prompts.length) { toast('请输入至少一个 Prompt', 'err'); return; }
    if (!state.configs.length) { toast('请至少添加一个对比配置', 'err'); return; }

    const configs = state.configs.map((c) => ({
      id: c.id,
      label: c.label || c.model,
      model: c.model,
      temperature: c.temperature,
      maxTokens: Number(c.maxTokens) || 1024
    }));
    const repeats = Math.max(1, Number(repeatsInput.value) || 1);

    state.running = true;
    runBtn.disabled = true;
    abortBtn.classList.remove('hidden');
    progressWrap.classList.remove('hidden');
    setProgress(0, prompts.length * configs.length * repeats);

    try {
      const out = await HarnessAPI.compare.run({ prompts, configs, repeats });
      if (out && out.error) { toast(out.error, 'err', 4000); return; }
      state.lastRun = out;
      renderResults(out);
      toast(out.aborted ? '对比已中止（部分结果已保留）' : '对比完成', out.aborted ? undefined : 'ok');
    } catch (e) {
      toast('运行失败：' + (e && e.message ? e.message : e), 'err', 4000);
    } finally {
      state.running = false;
      runBtn.disabled = false;
      abortBtn.classList.add('hidden');
    }
  }

  function setProgress(done, total) {
    progressBar.style.width = total ? (done / total * 100).toFixed(1) + '%' : '0%';
    progressText.textContent = `${done} / ${total}`;
  }

  // ---------- results ----------
  function renderResults(out) {
    resultsBox.classList.remove('hidden');

    // per-config cards
    const statsRow = $('#compare-config-stats');
    statsRow.innerHTML = '';
    for (const c of out.perConfig) {
      statsRow.append(el('div', { class: 'stat-card' },
        el('div', { class: 'stat-label' }, c.label + ' · ' + c.model),
        el('div', { class: 'stat-value' }, c.avgLatencyMs != null ? fmtDuration(c.avgLatencyMs) : '—'),
        el('div', { class: 'stat-sub' },
          `均 ${fmtTokens(c.avgTotalTokens)} tokens · ${fmtCost(c.avgCost)} / 次 · ${c.errorCount ? c.errorCount + ' 错误' : '无错误'}`)
      ));
    }

    // charts
    const chartsBox = $('#compare-charts');
    chartsBox.innerHTML = '';
    const items = out.perConfig;
    const chartDefs = [
      {
        title: '平均响应耗时（越低越好）', axis: 'ms',
        make: (c) => ({ label: c.label, value: c.avgLatencyMs || 0, display: fmtDuration(c.avgLatencyMs) })
      },
      {
        title: '平均输出 Tokens', axis: 'tokens',
        make: (c) => ({ label: c.label, value: c.avgCompletionTokens || 0, display: fmtTokens(c.avgCompletionTokens) })
      },
      {
        title: '平均单次费用（¥）', axis: 'cny',
        make: (c) => ({ label: c.label, value: c.avgCost || 0, display: fmtCost(c.avgCost) })
      }
    ];
    for (const def of chartDefs) {
      chartsBox.append(el('div', { class: 'chart-card' },
        el('h4', {}, def.title),
        el('div', { html: Charts.barChart(items.map(def.make), { axis: def.axis }) })
      ));
    }

    // prompt selector
    const sel = $('#compare-prompt-select');
    sel.innerHTML = '';
    out.prompts.forEach((p, i) => {
      const opt = el('option', { value: String(i) }, truncate(p, 40));
      sel.append(opt);
    });
    sel.onchange = () => renderAnswers(out, Number(sel.value));
    renderAnswers(out, 0);
    resultsBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderAnswers(out, promptIndex) {
    const box = $('#compare-answers');
    box.innerHTML = '';
    out.configs.forEach((cfg, ci) => {
      // take the first successful run of this config for this prompt
      const runs = out.results.filter((r) => r.configId === cfg.id && r.promptIndex === promptIndex);
      const r = runs.find((x) => x.ok !== false && !x.error) || runs[0];
      const color = Charts.PALETTE[ci % Charts.PALETTE.length];
      const head = el('div', { class: 'answer-head' },
        el('span', { class: 'dot', style: `background:${color}` }),
        el('span', {}, cfg.label + ' · ' + cfg.model),
        el('span', { class: 'answer-meta' },
          r && !r.error
            ? `${fmtDuration(r.latencyMs)} · ${r.usage ? fmtTokens(r.usage.totalTokens) + ' tok · ' : ''}${fmtCost(r.cost)}`
            : '失败')
      );
      const body = el('div', { class: 'answer-body' });
      body.innerHTML = r && !r.error ? Md.render(r.content) : '<p style="color:var(--err)">⚠️ ' + U.escapeHtml((r && r.error) || '无结果') + '</p>';
      box.append(el('div', { class: 'answer-card' }, head, body));
    });
  }

  function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function init() {
    cacheDom();
    state.configs = defaultConfigs();
    renderConfigs();
    $('#btn-add-config').addEventListener('click', addConfig);
    runBtn.addEventListener('click', run);
    abortBtn.addEventListener('click', () => HarnessAPI.compare.abort());
    HarnessAPI.compare.onProgress((p) => setProgress(p.done, p.total));
    promptsArea.value = '用一句话解释什么是快速排序。\n写一个判断回文字符串的 Python 函数。';
  }

  Harness.pages.compare = { init };
})();
