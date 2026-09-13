'use strict';

/* Global helpers shared by all renderer modules. */
window.U = (function () {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtCost(cny) {
    const v = Number(cny) || 0;
    return '¥' + (v < 0.01 && v > 0 ? v.toFixed(6) : v.toFixed(4));
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  function fmtDuration(ms) {
    const v = Number(ms) || 0;
    if (v >= 60000) return (v / 60000).toFixed(1) + ' min';
    if (v >= 1000) return (v / 1000).toFixed(2) + 's';
    return v + 'ms';
  }

  function fmtPct(x, digits = 1) {
    if (x === null || x === undefined) return '—';
    return (x * 100).toFixed(digits) + '%';
  }

  let toastStack = null;
  function toast(message, type, ms) {
    if (!toastStack) toastStack = $('#toast-stack');
    const t = el('div', { class: 'toast ' + (type || '') }, message);
    toastStack.append(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, ms || 2600);
  }

  let modalMask = null, modalEl = null;
  function modal(title, bodyNode, actions) {
    if (!modalMask) modalMask = $('#modal-mask');
    if (!modalEl) modalEl = $('#modal');
    modalEl.innerHTML = '';
    modalEl.append(el('h3', {}, title));
    const body = el('div', { class: 'result-detail' });
    if (bodyNode) body.append(bodyNode);
    modalEl.append(body);
    const bar = el('div', { class: 'modal-actions' });
    for (const a of actions || [{ label: '关闭' }]) {
      bar.append(el('button', {
        class: 'btn ' + (a.kind || 'ghost') + ' sm',
        onclick: () => { closeModal(); if (a.onClick) a.onClick(); }
      }, a.label));
    }
    modalEl.append(bar);
    modalMask.classList.remove('hidden');
  }
  function closeModal() {
    if (modalMask) modalMask.classList.add('hidden');
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 400);
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return {
    $, $$, el, escapeHtml, fmtCost, fmtTokens, fmtDuration, fmtPct,
    toast, modal, closeModal, downloadText, debounce, uid
  };
})();
