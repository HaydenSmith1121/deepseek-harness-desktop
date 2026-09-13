'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Md = require('../renderer/js/markdown');

test('escapes raw HTML (XSS-safe)', () => {
  const html = Md.render('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<img'));
});

test('renders fenced code blocks and preserves content', () => {
  const html = Md.render('before\n```python\nprint("<hi>")\n```\nafter');
  assert.ok(html.includes('<pre class="md-code">'));
  assert.ok(html.includes('&lt;hi&gt;'));
  assert.ok(html.includes('<code>'));
});

test('renders inline formatting', () => {
  const html = Md.render('**bold** and *italic* and `code` and [link](https://x.com)');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code class="inline">code</code>'));
  assert.ok(html.includes('<a href="https://x.com"'));
});

test('renders headings and lists', () => {
  const html = Md.render('# Title\n\n- one\n- two\n\n1. first\n2. second');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>first</li>'));
});

test('renders pipe tables', () => {
  const html = Md.render('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>a</th>'));
  assert.ok(html.includes('<td>2</td>'));
});

test('renders blockquote and hr', () => {
  const html = Md.render('> quoted\n\n---');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<hr/>'));
});

test('empty and null input render to empty string', () => {
  assert.equal(Md.render(''), '');
  assert.equal(Md.render(null), '');
});
