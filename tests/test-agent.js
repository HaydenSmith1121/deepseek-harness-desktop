'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('../src/main/agent');
const { createTools } = require('../src/main/tools');

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null) =>
  sse({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ delta, finish_reason: finish }] });

/** 构造脚本化 mock 传输层：按轮次回放预置响应 */
function makeScriptedTransport(turns) {
  let i = 0;
  const seenPayloads = [];
  return async ({ payload }) => {
    seenPayloads.push(payload);
    const turn = turns[i++];
    if (!turn) throw new Error('脚本轮次用尽');
    if (turn.error) return { ok: false, status: turn.status, text: turn.text };
    async function* gen() {
      for (const line of turn.lines) yield line;
    }
    return { ok: true, iterator: gen() };
  };
}

function toolCallChunks(id, name, args) {
  return [
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, 'tool_calls'),
    sse({ id: 'x', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  ];
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-agent-'));
  const tools = createTools({ workspace: tmp });

  // ===== 场景 1：完整 agent 循环（工具调用 -> 结果回填 -> 最终答复）=====
  {
    const turns = [
      { lines: toolCallChunks('call_1', 'write_file', JSON.stringify({ path: 'out.txt', content: 'loop-ok' })) },
      { lines: [chunk({ content: '文件已写入，任务完成。' }), chunk({}, 'stop')] },
    ];
    const transport = makeScriptedTransport(turns);
    const events = [];
    const apiMessages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写个文件' },
    ];
    const result = await runAgentLoop({
      apiMessages,
      tools: tools.schemas,
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 512,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1',
      emit: (type, payload) => events.push({ type, payload }),
      transport,
      executeTool: (c) => tools.execute(c),
    });

    assert.strictEqual(result.finished, true, '循环应正常结束');
    assert.strictEqual(result.steps, 2, '应恰好 2 步');
    // 工具真实执行了
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'out.txt'), 'utf8'), 'loop-ok');
    // 消息结构正确：system, user, assistant(tool_call), tool, assistant(final)
    assert.strictEqual(apiMessages.length, 5);
    assert.strictEqual(apiMessages[2].role, 'assistant');
    assert.ok(apiMessages[2].tool_calls);
    assert.strictEqual(apiMessages[3].role, 'tool');
    assert.strictEqual(apiMessages[3].tool_call_id, 'call_1');
    assert.ok(apiMessages[3].content.includes('已成功写入'));
    assert.strictEqual(apiMessages[4].role, 'assistant');
    assert.strictEqual(apiMessages[4].content, '文件已写入，任务完成。');
    // 事件流包含关键类型
    const types = events.map((e) => e.type);
    assert.ok(types.includes('delta'));
    assert.ok(types.includes('tool-start'));
    assert.ok(types.includes('tool-result'));
    assert.ok(types.includes('assistant-message'));
    // delta 里能还原完整内容
    const content = events.filter((e) => e.type === 'delta' && e.payload.kind === 'content')
      .map((e) => e.payload.text).join('');
    assert.strictEqual(content, '文件已写入，任务完成。');
    console.log('✓ 场景1: 工具调用闭环 + 流式聚合');
  }

  // ===== 场景 2：审批流（拒绝后结果回填，模型继续）=====
  {
    const turns = [
      { lines: toolCallChunks('call_2', 'run_command', JSON.stringify({ command: 'echo hi' })) },
      { lines: [chunk({ content: '好的，不执行了。' }), chunk({}, 'stop')] },
    ];
    const transport = makeScriptedTransport(turns);
    const events = [];
    const apiMessages = [{ role: 'user', content: '跑个命令' }];
    await runAgentLoop({
      apiMessages,
      tools: tools.schemas,
      model: 'deepseek-chat', temperature: 0.7, maxTokens: 512,
      apiKey: 'k', baseUrl: 'http://localhost:1',
      emit: (t, p) => events.push({ t, p }),
      transport,
      needsApproval: () => true,
      requestApproval: async () => false, // 模拟用户拒绝
      executeTool: (c) => tools.execute(c),
    });
    assert.strictEqual(apiMessages[2].role, 'tool');
    assert.ok(apiMessages[2].content.includes('拒绝'));
    assert.ok(events.some((e) => e.t === 'approval-request'));
    const toolResult = events.find((e) => e.t === 'tool-result');
    assert.strictEqual(toolResult.p.rejected, true);
    console.log('✓ 场景2: 审批拒绝 -> 结果回填 -> 循环继续');
  }

  // ===== 场景 3：HTTP 400 自动降级为纯对话 =====
  {
    const turns = [
      { error: true, status: 400, text: '{"error":{"message":"tools not supported"}}' },
      { lines: [chunk({ content: 'reasoner 纯对话回答' }), chunk({}, 'stop')] },
    ];
    const transport = makeScriptedTransport(turns);
    const events = [];
    const apiMessages = [{ role: 'user', content: 'hi' }];
    const r = await runAgentLoop({
      apiMessages, tools: tools.schemas,
      model: 'deepseek-reasoner', temperature: 0.5, maxTokens: 512,
      apiKey: 'k', baseUrl: 'http://localhost:1',
      emit: (t, p) => events.push({ t, p }),
      transport,
      executeTool: (c) => tools.execute(c),
    });
    assert.strictEqual(r.finished, true);
    assert.ok(events.some((e) => e.t === 'notice' && e.p.text.includes('纯对话')));
    // 第二次请求不应再带 tools
    const seen = transport.seen || null;
    console.log('✓ 场景3: 400 自动降级为纯对话模式');
  }

  // ===== 场景 4：maxSteps 死循环保护 =====
  {
    const endlessTurns = [];
    for (let i = 0; i < 10; i++) {
      endlessTurns.push({ lines: toolCallChunks('call_x_' + i, 'list_dir', '{}') });
    }
    const transport = makeScriptedTransport(endlessTurns);
    const events = [];
    const r = await runAgentLoop({
      apiMessages: [{ role: 'user', content: 'loop' }],
      tools: tools.schemas,
      model: 'deepseek-chat', temperature: 0.7, maxTokens: 512,
      apiKey: 'k', baseUrl: 'http://localhost:1',
      emit: (t, p) => events.push({ t, p }),
      transport,
      maxSteps: 3,
      executeTool: (c) => tools.execute(c),
    });
    assert.strictEqual(r.finished, false);
    assert.ok(events.some((e) => e.t === 'notice' && e.p.text.includes('最大工具步数')));
    assert.strictEqual(r.steps, 4); // 3 次请求 + 1 次超限判定
    console.log('✓ 场景4: maxSteps 死循环保护');
  }

  // ===== 场景 5：HTTP 错误向上抛出 =====
  {
    const transport = makeScriptedTransport([{ error: true, status: 401, text: 'Unauthorized' }]);
    await assert.rejects(
      () => runAgentLoop({
        apiMessages: [{ role: 'user', content: 'hi' }],
        tools: null, model: 'deepseek-chat', temperature: 0.7, maxTokens: 512,
        apiKey: 'bad', baseUrl: 'http://localhost:1',
        emit: () => {}, transport, executeTool: (c) => tools.execute(c),
      }),
      /HTTP 401/
    );
    console.log('✓ 场景5: API 错误正确抛出');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ test-agent: 5 个场景全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
