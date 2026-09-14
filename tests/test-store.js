'use strict';

/* 会话文件夹 / 归档 / 持久化 相关断言 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-store-'));

function main() {
  const store = new Store(tmp);

  // ===== 1. 默认值 =====
  assert.strictEqual(store.get('theme'), 'dark', '默认主题应为 dark');
  assert.deepStrictEqual(store.get('plugins'), [], '默认无插件');
  assert.strictEqual(store.get('providers'), null, 'providers 初始为 null（待迁移）');
  console.log('✓ 场景1: 默认值正确');

  // ===== 2. 文件夹 CRUD =====
  const f1 = store.createFolder('  前端重构  ');
  const f2 = store.createFolder('');
  assert.strictEqual(f1.name, '前端重构', '文件夹名应 trim');
  assert.strictEqual(f2.name, '新建文件夹', '空名回退默认');
  assert.strictEqual(store.listFolders().length, 2);

  assert.ok(store.renameFolder(f1.id, '前端大重构'));
  assert.strictEqual(store.listFolders()[0].name, '前端大重构');
  assert.ok(!store.renameFolder(f1.id, '   '), '空名字应被拒绝');
  console.log('✓ 场景2: 文件夹增删改');

  // ===== 3. 会话归属文件夹 =====
  const root = store.createSession();
  const inFolder = store.createSession(f1.id);
  assert.strictEqual(root.folderId, null);
  assert.strictEqual(inFolder.folderId, f1.id);
  assert.strictEqual(store.createSession('不存在的文件夹').folderId, null, '非法 folderId 应归零');

  store.moveSession(root.id, f1.id);
  assert.strictEqual(store.getSession(root.id).folderId, f1.id);
  store.moveSession(root.id, null);
  assert.strictEqual(store.getSession(root.id).folderId, null);
  console.log('✓ 场景3: 会话移动');

  // ===== 4. 归档 / 还原 =====
  assert.ok(!store.getSession(root.id).archived, '默认未归档');
  store.setSessionArchived(root.id, true);
  const a = store.getSession(root.id);
  assert.strictEqual(a.archived, true);
  assert.ok(a.archivedAt > 0, '归档时间应写入');
  store.setSessionArchived(root.id, false);
  assert.strictEqual(store.getSession(root.id).archived, false);
  assert.strictEqual(store.getSession(root.id).archivedAt, null);
  console.log('✓ 场景4: 归档与还原');

  // ===== 5. listSessions 带出 folderId / archived =====
  store.setSessionArchived(root.id, true);
  const list = store.listSessions();
  const found = list.find((s) => s.id === root.id);
  assert.ok(found && found.archived === true && 'folderId' in found, '列表项应带 folderId 与 archived');
  console.log('✓ 场景5: 列表结构');

  // ===== 6. 删除文件夹不连带删会话 =====
  store.moveSession(inFolder.id, f1.id);
  assert.ok(store.deleteFolder(f1.id));
  assert.strictEqual(store.listFolders().length, 1);
  assert.strictEqual(store.getSession(inFolder.id).folderId, null, '会话应回到未分组');
  assert.ok(store.getSession(inFolder.id), '会话本身不能被删');
  console.log('✓ 场景6: 删文件夹保留会话');

  // ===== 7. 重新加载后持久化一致 =====
  const store2 = new Store(tmp);
  assert.strictEqual(store2.listFolders().length, 1);
  assert.strictEqual(store2.listSessions().length, 3);
  assert.strictEqual(store2.getSession(root.id).archived, true);
  console.log('✓ 场景7: 落盘后重新加载一致');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ test-store: 7 个场景全部通过');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
