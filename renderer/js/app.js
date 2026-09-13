'use strict';

/* App shell: navigation, global bridge, page bootstrap. */
(function () {
  // global API bridge (preload exposes window.harness)
  window.HarnessAPI = window.harness;

  document.addEventListener('DOMContentLoaded', () => {
    // close modal on backdrop click
    const mask = document.getElementById('modal-mask');
    mask.addEventListener('click', (e) => {
      if (e.target === mask) U.closeModal();
    });

    // navigation
    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    navItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        navItems.forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
        const page = document.getElementById('page-' + btn.dataset.page);
        if (page) page.classList.add('active');
      });
    });

    // init all pages once
    const pages = (window.Harness && Harness.pages) || {};
    for (const mod of Object.values(pages)) {
      try {
        mod.init();
      } catch (e) {
        console.error('page init failed', e);
      }
    }

    // keep api status fresh once settings page may not have run yet
    if (!window.APP_SETTINGS && window.harness) {
      window.harness.settings.get().then((s) => {
        window.APP_SETTINGS = s;
        const dot = document.getElementById('api-status-dot');
        const text = document.getElementById('api-status-text');
        if (dot && text) {
          if (s.apiKey) { dot.className = 'status-dot ok'; text.textContent = 'API 已配置'; }
          else { dot.className = 'status-dot warn'; text.textContent = '未配置 API Key'; }
        }
      }).catch(() => {});
    }
  });
})();
