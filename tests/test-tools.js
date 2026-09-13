'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTools, isInside, globToRegex } = require('../src/main/tools');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-tools-'));
const tools = createTools({ workspace: tmp });

const call = (name, args) => ({
  function: { name, arguments: JSON.stringify(args) },
});

async function main() {
  // 1. write_file -> read_file 往返
  let r = await tools.execute(call('write_file', { path: 'a/b/hello.txt', content: '你好 harness' }));
  assert.ok(r.includes('已成功写入'));
  r = await tools.execute(call('read_file', { path: 'a/b/hello.txt' }));
  assert.strictEqual(r, '你好 harness');
  assert.ok(fs.existsSync(path.join(tmp, 'a', 'b', 'hello.txt')), '父目录应自动创建');

  // 2. list_dir
  r = await tools.execute(call('list_dir', { path: 'a' }));
  assert.ok(r.includes('[目录] b/'));

  // 3. read_file 不存在路径要报错
  await assert.rejects(() => tools.execute(call('read_file', { path: 'nope.txt' })));

  // 4. 二进制文件保护
  fs.writeFileSync(path.join(tmp, 'x.png'), Buffer.from([1, 2, 3]));
  r = await tools.execute(call('read_file', { path: 'x.png' }));
  assert.ok(r.includes('二进制文件'));

  // 5. run_command 真实执行
  r = await tools.execute(call('run_command', { command: 'echo harness_ok' }));
  assert.ok(r.includes('harness_ok'), `run_command 输出异常: ${r}`);

  // 6. run_command 失败命令带退出码
  r = await tools.execute(call('run_command', { command: 'exit /b 3' }));
  assert.ok(r.includes('退出码 3'), `退出码输出异常: ${r}`);

  // 7. search_files 通配符 + 跳过 node_modules
  fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'match_me.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'a', 'b', 'match_me.json'), '{}');
  r = await tools.execute(call('search_files', { pattern: 'match_*.json' }));
  assert.ok(r.includes('a/b/match_me.json') || r.includes('a\\b\\match_me.json'), r);
  assert.ok(!r.includes('node_modules'), '应跳过 node_modules');

  // 8. 工具参数坏 JSON 要报错
  await assert.rejects(
    () => tools.execute({ function: { name: 'read_file', arguments: '{bad json' } }),
    /JSON/
  );

  // 9. 未知工具要报错
  await assert.rejects(() => tools.execute(call('nonexistent', {})));

  // 10. isInside 路径守卫
  assert.ok(isInside(tmp, path.join(tmp, 'sub', 'f.txt')));
  assert.ok(isInside(tmp, tmp));
  assert.ok(!isInside(tmp, path.dirname(tmp)));
  assert.ok(!isInside('C:\\ws', 'D:\\outside\\f.txt'));

  // 11. globToRegex 基本语义
  assert.ok(globToRegex('*.py').test('main.py'));
  assert.ok(!globToRegex('*.py').test('dir/main.py'));
  assert.ok(globToRegex('**/*.py').test('dir/sub/main.py'));

  // 清理
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ test-tools: 11 组断言全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
