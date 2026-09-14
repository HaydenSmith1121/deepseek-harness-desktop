'use strict';

const { SseParser } = require('./sse');

class AbortError extends Error {
  constructor() {
    super('生成已被用户中止');
    this.name = 'AbortError';
  }
}

const DEFAULT_MAX_STEPS = 25;

/**
 * 构建 agent 系统提示词。
 */
function buildSystemPrompt({ workspace, platform, extra }) {
  const plat = platform === 'win32' ? 'Windows（shell 为 cmd）'
    : platform === 'darwin' ? 'macOS（shell 为 zsh/sh）' : 'Linux（shell 为 sh）';
  return [
    '你是运行在「DeepSeek Harness 桌面版」中的智能体（Agent）。',
    '你拥有操作本机的工具集，用户授权你在指定工作区内完成真实任务。',
    '',
    `# 环境`,
    `- 工作目录（工作区）: ${workspace}`,
    `- 操作系统: ${plat}`,
    `- 今天日期: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '# 工具使用规则',
    '1. 需要了解文件/目录情况时，先 list_dir 或 search_files 探查，再 read_file 精读，不要凭空猜测文件内容。',
    '2. 写文件用 write_file（自动建父目录）；执行系统命令用 run_command（有 120 秒超时）。',
    '3. 需要联网查资料时用 web_fetch。',
    '4. 涉及删除、覆盖重要文件、安装软件等危险命令要谨慎，并先向用户说明你打算做什么。',
    '5. 每次只发起完成当前目标所必需的工具调用；一个任务可以多步完成（上限 25 步）。',
    '6. 除了内置工具，用户可能还装了「插件工具」（第三方 HTTP 接口），用法看各自的参数说明。',
    '7. 任务完成后，用简洁的 Markdown 总结你做了什么、结果在哪里。',
    '',
    '# 回复风格',
    '- 始终使用简体中文回复（代码与命令除外）。',
    '- 回答直接、准确，不要空话；给出关键路径与结论。',
    extra ? `\n# 补充指令\n${extra}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 真实 DeepSeek 传输层（OpenAI 兼容 /chat/completions，SSE 流式）。
 */
async function realTransport({ payload, apiKey, baseUrl, signal }) {
  const resp = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, text };
  }
  async function* iterator() {
    for await (const chunk of resp.body) yield chunk;
  }
  return { ok: true, iterator: iterator() };
}

/**
 * 消费一次流式响应，聚合 content / reasoning_content / tool_calls / usage，
 * 同时通过 emit('delta') 向外转发增量。
 */
async function consumeStream(iterator, signal, emit) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let usage = null;
  const decoder = new TextDecoder();

  const parser = new SseParser((obj) => {
    if (!obj) return;
    if (obj.usage) usage = obj.usage;
    const choice = (obj.choices && obj.choices[0]) || {};
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      emit('delta', { kind: 'content', text: delta.content });
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      emit('delta', { kind: 'reasoning', text: delta.reasoning_content });
    }
    for (const tc of delta.tool_calls || []) {
      const i = typeof tc.index === 'number' ? tc.index : 0;
      if (!toolCalls[i]) {
        toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function && tc.function.name) toolCalls[i].function.name = tc.function.name;
      if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
    }
  });

  for await (const chunk of iterator) {
    if (signal && signal.aborted) throw new AbortError();
    parser.feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  }
  parser.feed(decoder.decode());
  parser.end();
  return { content, reasoning, toolCalls, usage };
}

/**
 * Agent 主循环：流式请求 -> (可选)工具调用 -> 回填结果 -> 继续，直到给出最终答复。
 *
 * @param {object} opts
 * @param {object[]} opts.apiMessages  完整消息数组（含 system），会被原地追加 assistant/tool 消息
 * @param {object[]|null} opts.tools   OpenAI function 格式 schema
 * @param {string} opts.model          deepseek-chat | deepseek-reasoner
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @param {string} opts.apiKey
 * @param {string} opts.baseUrl
 * @param {(type: string, payload: object) => void} opts.emit
 * @param {(call: object) => boolean} opts.needsApproval
 * @param {(call: object) => Promise<boolean>} opts.requestApproval
 * @param {(call: object) => Promise<string>} opts.executeTool
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.transport]  可注入的传输层（测试用）
 * @param {number} [opts.maxSteps]
 */
async function runAgentLoop(opts) {
  const {
    apiMessages, tools, model, temperature, maxTokens,
    apiKey, baseUrl, emit, signal,
    needsApproval = () => false,
    requestApproval = async () => true,
    executeTool,
    transport = realTransport,
    maxSteps = DEFAULT_MAX_STEPS,
  } = opts;

  let steps = 0;
  let toolsDisabled = false;
  let lastUsage = null;

  while (true) {
    if (signal && signal.aborted) throw new AbortError();
    steps += 1;
    if (steps > maxSteps) {
      emit('notice', { text: `已达单次任务最大工具步数（${maxSteps}），自动停止执行并总结。` });
      break;
    }

    const payload = {
      model,
      messages: apiMessages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      stream_options: { include_usage: true },
    };
    if (tools && !toolsDisabled) payload.tools = tools;

    let res;
    try {
      res = await transport({ payload, apiKey, baseUrl, signal });
    } catch (err) {
      if (signal && signal.aborted) throw new AbortError();
      throw new Error(`网络请求失败: ${err && err.message ? err.message : String(err)}`);
    }

    if (!res.ok) {
      // 部分模型（如旧版 deepseek-reasoner）不支持工具调用：HTTP 400 时自动降级为纯对话
      if (tools && !toolsDisabled && res.status === 400) {
        toolsDisabled = true;
        emit('notice', { text: '当前模型不接受工具调用，已自动切换为纯对话模式继续回答。' });
        continue;
      }
      throw new Error(`模型接口错误 (HTTP ${res.status}): ${String(res.text || '').slice(0, 500)}`);
    }

    const { content, reasoning, toolCalls, usage } = await consumeStream(res.iterator, signal, emit);
    if (usage) lastUsage = usage;

    const assistantMsg = { role: 'assistant', content: content || '' };
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    apiMessages.push(assistantMsg);
    emit('assistant-message', {
      message: {
        role: 'assistant',
        content: assistantMsg.content,
        reasoning_content: assistantMsg.reasoning_content || null,
        tool_calls: assistantMsg.tool_calls || null,
      },
      usage,
    });

    if (!toolCalls.length) {
      return { finished: true, steps, usage: lastUsage };
    }

    for (const call of toolCalls) {
      if (signal && signal.aborted) throw new AbortError();
      const name = call.function.name;
      let approved = true;
      if (needsApproval(call)) {
        emit('approval-request', { callId: call.id, name, args: call.function.arguments });
        approved = await requestApproval(call);
      }

      let result;
      let isError = false;
      if (!approved) {
        result = '用户拒绝了本次操作。';
        isError = true;
      } else {
        emit('tool-start', { callId: call.id, name, args: call.function.arguments });
        try {
          result = await executeTool(call);
        } catch (err) {
          result = `工具执行出错: ${err && err.message ? err.message : String(err)}`;
          isError = true;
        }
      }
      result = String(result ?? '').slice(0, 20000);
      emit('tool-result', { callId: call.id, name, result, isError, rejected: !approved });
      apiMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  return { finished: false, steps, usage: lastUsage };
}

module.exports = {
  runAgentLoop,
  realTransport,
  consumeStream,
  buildSystemPrompt,
  AbortError,
  DEFAULT_MAX_STEPS,
};
