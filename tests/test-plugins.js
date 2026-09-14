'use strict';

/* 插件系统：校验规则 + 模板替换 + 真实 HTTP 调用 */

const assert = require('assert');
const http = require('http');
const { validatePlugin, pluginSchema, applyTemplate, findPlugin, runPlugin } = require('../src/main/plugins');

const base = {
  name: 'weather_query',
  description: '查天气',
  method: 'GET',
  url: 'https://api.example.com/weather?city={{city}}',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/echo')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: req.url, method: req.method, body, token: req.headers['x-token'] || null }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  // ===== 1. 合法插件 =====
  const ok = validatePlugin(base, { existing: [] });
  assert.ok(ok.ok, ok.error);
  assert.strictEqual(ok.plugin.method, 'GET');
  assert.strictEqual(ok.plugin.enabled, true);
  assert.ok(/^plg-/.test(ok.plugin.id));
  console.log('✓ 场景1: 合法插件通过校验');

  // ===== 2. 各类非法输入 =====
  const bad = [
    [{ ...base, name: '1abc' }, /字母/],
    [{ ...base, name: '' }, /字母/],
    [{ ...base, name: 'run_command' }, /内置工具/],
    [{ ...base, url: 'ftp://x' }, /http/],
    [{ ...base, url: '' }, /接口地址/],
    [{ ...base, method: 'TRACE' }, /请求方式/],
    [{ ...base, parameters: '{"type":"array"}' }, /参数 Schema/],
    [{ ...base, headers: '[1,2]' }, /请求头/],
  ];
  for (const [input, rx] of bad) {
    const r = validatePlugin(input, { existing: [] });
    assert.ok(!r.ok, '应被拒绝: ' + JSON.stringify(input.name));
    assert.ok(rx.test(r.error), `错误文案不符: ${r.error}`);
  }
  console.log('✓ 场景2: 8 类非法输入被拦下');

  // ===== 3. 重名检测（编辑自己时放行）=====
  const existing = [{ id: 'plg-1', name: 'weather_query' }];
  assert.ok(!validatePlugin(base, { existing }).ok, '与他人重名应被拒绝');
  const selfEdit = validatePlugin({ ...base, id: 'plg-1' }, { existing, selfId: 'plg-1' });
  assert.ok(selfEdit.ok, '编辑自己不应误判重名');
  assert.strictEqual(selfEdit.plugin.id, 'plg-1', '编辑时应保留原 id');
  console.log('✓ 场景3: 重名检测');

  // ===== 4. 模板替换 =====
  assert.strictEqual(applyTemplate('a={{x}}', { x: '中 文' }, true), 'a=%E4%B8%AD%20%E6%96%87');
  assert.strictEqual(applyTemplate('a={{x}}', { x: '中 文' }, false), 'a=中 文');
  assert.strictEqual(applyTemplate('{{n}}/{{obj}}', { n: 3, obj: { a: 1 } }, false), '3/{"a":1}');
  assert.strictEqual(applyTemplate('{{missing}}', {}, false), '');
  console.log('✓ 场景4: {{}} 模板替换');

  // ===== 5. schema 形态 =====
  const schema = pluginSchema(ok.plugin);
  assert.strictEqual(schema.type, 'function');
  assert.strictEqual(schema.function.name, 'weather_query');
  assert.deepStrictEqual(schema.function.parameters, base.parameters);
  console.log('✓ 场景5: function schema');

  // ===== 6. findPlugin 只认启用的 =====
  const list = [{ id: 'a', name: 'x', enabled: true }, { id: 'b', name: 'y', enabled: false }];
  assert.ok(findPlugin(list, 'x'));
  assert.strictEqual(findPlugin(list, 'y'), null, '停用的插件不应被派发');
  assert.strictEqual(findPlugin(list, 'z'), null);
  console.log('✓ 场景6: 启用开关生效');

  // ===== 7. 真实 HTTP 调用（GET + 头 + URL 编码）=====
  const server = await startServer();
  const port = server.address().port;
  try {
    const p1 = validatePlugin({
      ...base,
      url: `http://127.0.0.1:${port}/echo?city={{city}}`,
      headers: '{"X-Token":"t-1"}',
    }, { existing: [] }).plugin;
    const out1 = await runPlugin(p1, { function: { name: 'weather_query', arguments: '{"city":"杭 州"}' } });
    assert.ok(out1.includes('HTTP 200'), out1);
    assert.ok(out1.includes('%E6%9D%AD%20%E5%B7%9E'), 'URL 参数应被编码: ' + out1);
    assert.ok(out1.includes('"token":"t-1"'), '自定义请求头应发出: ' + out1);

    // ===== 8. POST + body 模板 =====
    const p2 = validatePlugin({
      name: 'kb_search',
      description: '检索',
      method: 'POST',
      url: `http://127.0.0.1:${port}/echo`,
      body: '{"q":"{{keyword}}","top":{{top}}}',
      parameters: { type: 'object', properties: { keyword: { type: 'string' }, top: { type: 'integer' } } },
    }, { existing: [] }).plugin;
    const out2 = await runPlugin(p2, { function: { name: 'kb_search', arguments: '{"keyword":"闭包","top":3}' } });
    assert.ok(out2.includes('"method":"POST"'), out2);
    assert.ok(out2.includes('\\"q\\":\\"闭包\\"'), 'body 模板应替换: ' + out2);

    // ===== 9. 非 2xx 也要把状态带回给模型 =====
    const p3 = validatePlugin({ ...base, url: `http://127.0.0.1:${port}/boom` }, { existing: [] }).plugin;
    const out3 = await runPlugin(p3, { function: { name: 'x', arguments: '{}' } });
    assert.ok(out3.includes('HTTP 500') && out3.includes('boom'), out3);
    console.log('✓ 场景7-9: 真实 HTTP GET / POST / 错误码');
  } finally {
    server.close();
  }

  // ===== 10. 参数不是 JSON 时报错 =====
  await assert.rejects(
    () => runPlugin(validatePlugin(base, { existing: [] }).plugin, { function: { arguments: '{oops' } }),
    /合法 JSON/
  );
  console.log('✓ 场景10: 非法参数报错');

  console.log('✓ test-plugins: 10 个场景全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
