'use strict';

/* Batch evaluation page. */
window.Harness = window.Harness || {};
Harness.pages = Harness.pages || {};

(function () {
  const { $, $$, el, toast, modal, fmtCost, fmtTokens, fmtDuration, fmtPct, downloadText } = U;

  const state = {
    items: [],       // [{ prompt, expectKeywords: [] }]
    running: false,
    lastRun: null    // { results, summary, ... }
  };

  let tbody, emptyBox, countEl, runBtn, abortBtn, progressWrap, progressBar, progressText, resultsBox;
  let modelSel, tempInput, maxTokensInput, systemInput;

  const SAMPLE = [
    { prompt: '1 公里等于多少米？只回答数字。', expectKeywords: ['1000'] },
    { prompt: '"hello world" 全部转成大写，只输出结果。', expectKeywords: ['HELLO WORLD'] },
    { prompt: '计算 17 * 23 = ?只输出数字。', expectKeywords: ['391'] },
    { prompt: '中国的首都是哪里？只回答城市名。', expectKeywords: ['北京'] }
  ];

  function cacheDom() {
    tbody = $('#batch-tbody');
    emptyBox = $('#batch-empty');
    countEl = $('#batch-count');
    runBtn = $('#btn-batch-run');
    abortBtn = $('#btn-batch-abort');
    progressWrap = $('#batch-progress-wrap');
    progressBar = $('#batch-progress-bar');
    progressText = $('#batch-progress-text');
    resultsBox = $('#batch-results');
    modelSel = $('#batch-model');
    tempInput = $('#batch-temp');
    maxTokensInput = $('#batch-maxtokens');
    systemInput = $('#batch-system');
  }

  // ---------- items table ----------
  function renderItems() {
    tbody.innerHTML = '';
    state.items.forEach((item, i) => {
      const del = el('button', {
        class: 'icon-btn danger',
        title: '删除',
        onclick: () => { state.items.splice(i, 1); renderItems(); }
      });
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      const row = el('tr', {},
        el('td', { class: 'muted' }, String(i + 1)),
        el('td', {}, el('textarea', {
          rows: '2',
          value: item.prompt,
          oninput: (e) => { item.prompt = e.target.value; }
        })),
        el('td', {}, el('input', {
          type: 'text',
          value: (item.expectKeywords || []).join(', '),
          placeholder: '如：北京,首都',
          oninput: (e) => {
            item.expectKeywords = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          }
        })),
        el('td', {}, del)
      );
      tbody.append(row);
    });
    emptyBox.style.display = state.items.length ? 'none' : 'block';
    countEl.textContent = state.items.length + ' 条';
  }

  function addItem(item) {
    state.items.push({ prompt: item.prompt || '', expectKeywords: item.expectKeywords || [] });
  }

  function openImport() {
    const area = el('textarea', {
      rows: '10',
      placeholder: '每行一条，格式：\nPrompt | 关键词1,关键词2\n或只写 Prompt（不判分）\n\n示例：\n中国的首都是哪里？ | 北京\n计算 2+2 | 4'
    });
    modal('从文本导入', area, [
      { label: '取消' },
      {
        label: '导入', kind: 'primary',
        onClick: () => {
          const lines = area.value.split('\n').map((l) => l.trim()).filter(Boolean);
          let added = 0;
          for (const line of lines) {
            const idx = line.indexOf('|');
            let prompt, kws;
            if (idx === -1) { prompt = line; kws = []; }
            else {
              prompt = line.slice(0, idx).trim();
              kws = line.slice(idx + 1).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
            }
            if (prompt) { addItem({ prompt, expectKeywords: kws }); added++; }
          }
          renderItems();
          toast(`已导入 ${added} 条`);
        }
      }
    ]);
    setTimeout(() => area.focus(), 60);
  }

  // ---------- run ----------
  async function run() {
    if (state.running) return;
    const items = state.items
      .map((it, id) => ({ id, prompt: (it.prompt || '').trim(), expectKeywords: it.expectKeywords || [] }))
      .filter((it) => it.prompt);
    if (!items.length) { toast('请先添加至少一条 Prompt', 'err'); return; }

    const config = {
      model: modelSel.value,
      temperature: tempInput.value,
      maxTokens: Number(maxTokensInput.value) || 1024,
      system: systemInput.value.trim()
    };

    state.running = true;
    runBtn.disabled = true;
    abortBtn.classList.remove('hidden');
    progressWrap.classList.remove('hidden');
    setProgress(0, items.length);

    try {
      const out = await HarnessAPI.batch.run({ items, config });
      if (out && out.error) { toast(out.error, 'err', 4000); return; }
      state.lastRun = out;
      renderResults(out);
      toast(out.aborted ? '评测已中止（部分结果已保留）' : '评测完成', out.aborted ? undefined : 'ok');
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
    const s = out.summary;

    const statsRow = $('#batch-stats');
    statsRow.innerHTML = '';
    statsRow.append(
      statCard('总数', s.total, ''),
      statCard('通过 / 判分项', s.passed + ' / ' + s.scored, s.accuracy != null && s.accuracy >= 0.8 ? 'ok' : ''),
      statCard('准确率', fmtPct(s.accuracy), s.accuracy != null && s.accuracy >= 0.8 ? 'ok' : (s.accuracy != null && s.accuracy < 0.5 ? 'err' : '')),
      statCard('API 错误', s.apiErrors, s.apiErrors ? 'err' : 'ok'),
      statCard('平均耗时', s.avgLatencyMs != null ? fmtDuration(s.avgLatencyMs) : '—', ''),
      statCard('总 Tokens', fmtTokens(s.totalTokens), '', '出 ' + fmtTokens(s.totalCompletionTokens)),
      statCard('总费用', fmtCost(s.totalCost), 'brand', '模型 ' + (out.model || ''))
    );

    const rt = $('#batch-result-tbody');
    rt.innerHTML = '';
    out.results.forEach((r) => {
      const statusCell = r.error
        ? el('span', { class: 'tag err' }, '失败')
        : r.passed === null
          ? el('span', { class: 'tag dim' }, '完成')
          : r.passed
            ? el('span', { class: 'tag ok' }, '通过')
            : el('span', { class: 'tag err' }, '未过');

      const kwCell = el('td');
      if (r.error) kwCell.append(el('span', { class: 'muted' }, '—'));
      else if (!r.expectKeywords || !r.expectKeywords.length) kwCell.append(el('span', { class: 'muted' }, '未判分'));
      else {
        const lower = String(r.content || '').toLowerCase();
        for (const kw of r.expectKeywords) {
          const hit = lower.includes(kw.toLowerCase());
          kwCell.append(el('span', { class: 'kw-chip ' + (hit ? 'hit' : 'miss') }, kw));
        }
      }

      const row = el('tr', { style: 'cursor:pointer', onclick: () => showDetail(r) },
        el('td', {}, statusCell),
        el('td', {}, truncate(r.prompt, 60)),
        kwCell,
        el('td', {}, r.error ? '—' : fmtDuration(r.latencyMs)),
        el('td', {}, r.usage ? fmtTokens(r.usage.totalTokens) : '—'),
        el('td', {}, r.cost ? fmtCost(r.cost) : '—')
      );
      rt.append(row);
    });
    resultsBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function statCard(label, value, kind, sub) {
    return el('div', { class: 'stat-card' },
      el('div', { class: 'stat-label' }, label),
      el('div', { class: 'stat-value ' + (kind || '') }, value),
      sub ? el('div', { class: 'stat-sub' }, sub) : null
    );
  }

  function showDetail(r) {
    const box = el('div');
    const meta = el('div', { class: 'detail-meta' });
    meta.innerHTML = `耗时 ${r.error ? '—' : fmtDuration(r.latencyMs)} · tokens ${r.usage ? fmtTokens(r.usage.totalTokens) : '—'} · 费用 ${r.cost ? fmtCost(r.cost) : '—'}${r.error ? '<br>错误：' + U.escapeHtml(r.error) : ''}`;
    box.append(meta);
    box.append(el('pre', {}, r.content || r.error || ''));
    modal('#' + ((r.index != null ? r.index : 0) + 1) + ' 号结果', box, [{ label: '关闭' }]);
  }

  function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ---------- export ----------
  function exportJson() {
    if (!state.lastRun) return;
    const name = 'batch-eval-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    downloadText(name, JSON.stringify(state.lastRun, null, 2), 'application/json');
  }

  function exportCsv() {
    if (!state.lastRun) return;
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, '\\n') + '"';
    const rows = [['#', 'prompt', 'status', 'passed', 'keywords', 'latency_ms', 'tokens', 'cost_cny', 'output']];
    for (const r of state.lastRun.results) {
      rows.push([
        String(r.index + 1), r.prompt || '', r.error ? 'error' : 'ok',
        r.passed === null ? '' : String(r.passed),
        (r.expectKeywords || []).join('|'),
        String(r.latencyMs || 0), r.usage ? String(r.usage.totalTokens) : '',
        String(r.cost || 0), r.content || r.error || ''
      ]);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    downloadText('batch-eval-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.csv', csv, 'text/csv;charset=utf-8');
  }

  // ---------- init ----------
  function init() {
    cacheDom();
    $('#btn-batch-import').addEventListener('click', openImport);
    $('#btn-batch-sample').addEventListener('click', () => {
      SAMPLE.forEach(addItem);
      renderItems();
      toast('已填充 4 条示例');
    });
    $('#btn-batch-clear').addEventListener('click', () => { state.items = []; renderItems(); });
    runBtn.addEventListener('click', run);
    abortBtn.addEventListener('click', () => HarnessAPI.batch.abort());
    $('#btn-export-json').addEventListener('click', exportJson);
    $('#btn-export-csv').addEventListener('click', exportCsv);
    HarnessAPI.batch.onProgress((p) => setProgress(p.done, p.total));
    renderItems();
  }

  Harness.pages.batch = { init };
})();
