'use strict';

const assert = require('assert');
const { SseParser } = require('../src/main/sse');

function collect() {
  const events = [];
  return { events, parser: new SseParser((e) => events.push(e)) };
}

// 1. 单条完整事件
{
  const { events, parser } = collect();
  parser.feed('data: {"a":1}\n\n');
  parser.end();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].a, 1);
}

// 2. 跨块断裂的事件（逐字符喂入）
{
  const { events, parser } = collect();
  const raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
  for (const ch of raw) parser.feed(ch);
  parser.end();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].choices[0].delta.content, 'hi');
}

// 3. 一块里多条事件 + [DONE]
{
  const { events, parser } = collect();
  parser.feed('data: {"x":1}\ndata: {"y":2}\n\ndata: [DONE]\n\n');
  parser.end();
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].x, 1);
  assert.strictEqual(events[1].y, 2);
  assert.strictEqual(events[2], null);
}

// 4. CRLF 行尾
{
  const { events, parser } = collect();
  parser.feed('data: {"z":3}\r\n\r\n');
  parser.end();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].z, 3);
}

// 5. 忽略注释行与坏 JSON，不中断
{
  const { events, parser } = collect();
  parser.feed(': keep-alive\ndata: not-json\n\ndata: {"ok":true}\n\n');
  parser.end();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].ok, true);
}

console.log('✓ test-sse: 5 组断言全部通过');
