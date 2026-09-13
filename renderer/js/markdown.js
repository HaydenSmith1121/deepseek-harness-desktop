/**
 * Mini Markdown renderer (UMD - usable in browser and node tests).
 * Supports: fenced code blocks, inline code, bold/italic, headings, hr,
 * blockquote, unordered/ordered lists, tables, links.
 * All raw HTML in the source is escaped before formatting (XSS-safe).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Md = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(text) {
    let s = esc(text);
    // inline code first (content inside backticks is not further formatted)
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => `<code class="inline">${code}</code>`);
    // bold + italic
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // links [text](url) - only http(s) and relative
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }

  function parseTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function render(src) {
    const text = String(src ?? '').replace(/\r\n/g, '\n');
    // 1. extract fenced code blocks
    const blocks = [];
    let work = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
      blocks.push(
        `<pre class="md-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`
      );
      return `\x00B${blocks.length - 1}\x00`;
    });

    const lines = work.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // placeholder-only line -> code block
      const ph = line.trim().match(/^\x00B(\d+)\x00$/);
      if (ph) { out.push(blocks[Number(ph[1])]); i++; continue; }

      if (!line.trim()) { i++; continue; }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

      // hr
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }

      // blockquote
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
        continue;
      }

      // table
      if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const head = parseTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(parseTableRow(lines[i]));
          i++;
        }
        const thead = '<tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>';
        const tbody = rows
          .map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
          .join('');
        out.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
        continue;
      }

      // paragraph (merge consecutive plain lines)
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4})\s/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !isTableRow(lines[i]) &&
        !lines[i].trim().match(/^\x00B\d+\x00$/)
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br/>')}</p>`);
      else i++;
    }

    return out.join('\n');
  }

  return { render, esc, inline };
});
