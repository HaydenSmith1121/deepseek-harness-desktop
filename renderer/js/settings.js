'use strict';

/* Settings page. */
window.Harness = window.Harness || {};
Harness.pages = Harness.pages || {};

(function () {
  const { $, el, toast } = U;

  let apiKeyInput, baseUrlInput, timeoutInput, concurrencyInput, retriesInput, priceTbody;
  let settings = null;

  function cacheDom() {
    apiKeyInput = $('#set-apikey');
    baseUrlInput = $('#set-baseurl');
    timeoutInput = $('#set-timeout');
    concurrencyInput = $('#set-concurrency');
    retriesInput = $('#set-retries');
    priceTbody = $('#price-tbody');
  }

  function renderPrices() {
    priceTbody.innerHTML = '';
    for (const [model, price] of Object.entries(settings.prices || {})) {
      priceTbody.append(el('tr', {},
        el('td', { style: 'font-weight:600' }, model),
        el('td', {}, el('input', {
          type: 'number', step: '0.1', min: '0', value: price.cacheHit,
          'data-model': model, 'data-key': 'cacheHit'
        })),
        el('td', {}, el('input', {
          type: 'number', step: '0.1', min: '0', value: price.cacheMiss,
          'data-model': model, 'data-key': 'cacheMiss'
        })),
        el('td', {}, el('input', {
          type: 'number', step: '0.1', min: '0', value: price.output,
          'data-model': model, 'data-key': 'output'
        }))
      ));
    }
  }

  function collectPrices() {
    const prices = JSON.parse(JSON.stringify(settings.prices || {}));
    priceTbody.querySelectorAll('input[data-model]').forEach((inp) => {
      const m = inp.dataset.model, k = inp.dataset.key;
      if (!prices[m]) prices[m] = {};
      prices[m][k] = Number(inp.value) || 0;
    });
    return prices;
  }

  function fillForm() {
    apiKeyInput.value = settings.apiKey || '';
    baseUrlInput.value = settings.baseUrl || 'https://api.deepseek.com';
    timeoutInput.value = Math.round((settings.timeoutMs || 120000) / 1000);
    concurrencyInput.value = settings.concurrency || 3;
    retriesInput.value = settings.retries != null ? settings.retries : 1;
    renderPrices();
  }

  async function save() {
    const patch = {
      apiKey: apiKeyInput.value.trim(),
      baseUrl: baseUrlInput.value.trim() || 'https://api.deepseek.com',
      timeoutMs: Math.max(5, Number(timeoutInput.value) || 120) * 1000,
      concurrency: Math.min(16, Math.max(1, Number(concurrencyInput.value) || 3)),
      retries: Math.max(0, Number(retriesInput.value) || 0),
      prices: collectPrices()
    };
    settings = await HarnessAPI.settings.set(patch);
    window.APP_SETTINGS = settings;
    updateApiStatus();
    const tip = $('#settings-saved-tip');
    tip.textContent = '已保存 ✓';
    setTimeout(() => { tip.textContent = ''; }, 2000);
    toast('设置已保存', 'ok');
  }

  async function testConnection() {
    const resultBox = $('#conn-result');
    // temporarily save the key first so the test uses current input
    await HarnessAPI.settings.set({ apiKey: apiKeyInput.value.trim(), baseUrl: baseUrlInput.value.trim() || 'https://api.deepseek.com' });
    resultBox.className = 'conn-result';
    resultBox.textContent = '正在连接…';
    try {
      const models = await HarnessAPI.models.list();
      resultBox.className = 'conn-result ok';
      resultBox.textContent = '✓ 连接成功，可用模型：' + models.map((m) => m.id).join('、');
      updateApiStatus();
    } catch (e) {
      resultBox.className = 'conn-result err';
      resultBox.textContent = '✗ 连接失败：' + (e && e.message ? e.message : e);
    }
  }

  function updateApiStatus() {
    const dot = $('#api-status-dot');
    const text = $('#api-status-text');
    if (window.APP_SETTINGS && window.APP_SETTINGS.apiKey) {
      dot.className = 'status-dot ok';
      text.textContent = 'API 已配置';
    } else {
      dot.className = 'status-dot warn';
      text.textContent = '未配置 API Key';
    }
  }

  function init() {
    cacheDom();
    $('#btn-toggle-key').addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });
    $('#btn-test-conn').addEventListener('click', testConnection);
    $('#btn-save-settings').addEventListener('click', save);
    $('#btn-open-datadir').addEventListener('click', async () => {
      const info = await HarnessAPI.app.openDataDir();
    });

    (async () => {
      settings = await HarnessAPI.settings.get();
      window.APP_SETTINGS = settings;
      fillForm();
      updateApiStatus();
      const info = await HarnessAPI.app.info();
      $('#app-version').textContent = 'v' + (info.version || '1.0.0');
      $('#datadir-path').textContent = info.userDataPath || '';
    })();
  }

  Harness.pages.settings = { init, updateApiStatus };
})();
