'use strict';

/* Pure-SVG bar charts (no external libraries). */
window.Charts = (function () {
  const PALETTE = ['#4d6bfe', '#22c3aa', '#f0b429', '#f2637e', '#9b6dff', '#3ec2f7', '#ff9350'];

  function niceMax(v) {
    if (!v || v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * base;
  }

  /**
   * items: [{ label, value, display }]
   * Returns an SVG string.
   */
  function barChart(items, opts) {
    const options = opts || {};
    const W = 460, H = 210;
    const padL = 46, padR = 14, padT = 14, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const list = (items || []).filter((it) => Number.isFinite(it.value));
    const max = niceMax(Math.max(0, ...list.map((it) => it.value)));
    const n = Math.max(list.length, 1);
    const slot = iw / n;
    const barW = Math.min(slot * 0.52, 64);

    const parts = [];
    // grid lines + y labels
    for (let g = 0; g <= 4; g++) {
      const y = padT + ih - (ih * g) / 4;
      const val = (max * g) / 4;
      parts.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#263145" stroke-width="1" ${g === 0 ? '' : 'stroke-dasharray="3 4"'}/>`);
      parts.push(`<text x="${padL - 7}" y="${y + 4}" fill="#5d6b80" font-size="10" text-anchor="end">${formatAxis(val, options.axis)}</text>`);
    }
    // bars
    list.forEach((it, idx) => {
      const cx = padL + slot * idx + slot / 2;
      const h = max > 0 ? (Math.max(it.value, 0) / max) * ih : 0;
      const y = padT + ih - h;
      const color = it.color || PALETTE[idx % PALETTE.length];
      parts.push(`<rect x="${cx - barW / 2}" y="${y}" width="${barW}" height="${Math.max(h, 1)}" rx="4" fill="${color}" opacity="0.92"/>`);
      parts.push(`<text x="${cx}" y="${y - 6}" fill="#e6edf3" font-size="10.5" font-weight="600" text-anchor="middle">${it.display != null ? it.display : round(it.value)}</text>`);
      parts.push(`<text x="${cx}" y="${H - padB + 16}" fill="#93a1b5" font-size="10" text-anchor="middle">${escapeXml(shorten(it.label, 16))}</text>`);
    });
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  }

  function formatAxis(v, axis) {
    if (axis === 'ms') return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 's' : Math.round(v) + '';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    if (v < 1 && v > 0) return v.toFixed(2);
    return String(Math.round(v * 100) / 100);
  }

  function round(v) {
    if (Math.abs(v) >= 100) return Math.round(v).toString();
    return (Math.round(v * 100) / 100).toString();
  }

  function shorten(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { barChart, PALETTE };
})();
