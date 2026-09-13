'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const tests = ['test-sse.js', 'test-tools.js', 'test-agent.js'];
let failed = 0;

for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n✗ ${failed} 个测试文件失败`);
  process.exit(1);
}
console.log('\n✓ 全部测试通过');
