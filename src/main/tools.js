'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.mp3', '.mp4', '.avi', '.mkv', '.woff', '.woff2', '.ttf', '.otf',
  '.db', '.sqlite', '.sqlite3', '.class', '.pyc', '.wasm',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', '.next']);

const MAX_OUTPUT_CHARS = 8000;
const MAX_FILE_BYTES = 200 * 1024;

/** 判断 target 是否位于 base 目录内部（含 base 自身） */
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n...[输出过长，已截断，原始长度 ${s.length} 字符]`;
}

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

/**
 * 创建工具集。
 * @param {object} opts
 * @param {string|(() => string)} opts.workspace 工作目录（可为 getter，便于设置热更新）
 * @returns {{ execute: (call: object) => Promise<string>, schemas: object[] }}
 */
function createTools({ workspace }) {
  const ws = () => (typeof workspace === 'function' ? workspace() : workspace);

  const resolveSafe = (p) => path.resolve(ws(), p || '.');

  const impl = {
    async read_file(args) {
      const fp = resolveSafe(args.path);
      if (!fs.existsSync(fp)) throw new Error(`文件不存在: ${fp}`);
      const ext = path.extname(fp).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) return `（二进制文件 ${ext}，不支持文本读取）`;
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) throw new Error(`这是一个目录，请使用 list_dir: ${fp}`);
      if (stat.size > MAX_FILE_BYTES) {
        return truncate(fs.readFileSync(fp, 'utf8'), MAX_OUTPUT_CHARS) +
          `\n...[文件较大 (${stat.size} 字节)，仅显示前一部分]`;
      }
      return fs.readFileSync(fp, 'utf8');
    },

    async write_file(args) {
      if (typeof args.content !== 'string') throw new Error('write_file 需要 content 字符串参数');
      const fp = resolveSafe(args.path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content, 'utf8');
      return `已成功写入 ${Buffer.byteLength(args.content, 'utf8')} 字节到 ${fp}`;
    },

    async list_dir(args) {
      const dp = resolveSafe(args.path);
      if (!fs.existsSync(dp)) throw new Error(`目录不存在: ${dp}`);
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      const lines = [];
      for (const e of entries.slice(0, 500)) {
        const full = path.join(dp, e.name);
        if (e.isDirectory()) {
          lines.push(`[目录] ${e.name}/`);
        } else {
          let size = '';
          try { size = ` (${fs.statSync(full).size} 字节)`; } catch { /* ignore */ }
          lines.push(`[文件] ${e.name}${size}`);
        }
      }
      if (entries.length > 500) lines.push(`...[共 ${entries.length} 项，仅显示前 500 项]`);
      return lines.join('\n') || '(空目录)';
    },

    async run_command(args) {
      const cmd = String(args.command || '').trim();
      if (!cmd) throw new Error('run_command 需要 command 参数');
      return new Promise((resolve) => {
        exec(cmd, {
          cwd: ws(),
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          env: process.env,
        }, (err, stdout, stderr) => {
          let out = '';
          if (stdout) out += String(stdout);
          if (stderr) out += (out ? '\n[stderr]\n' : '') + String(stderr);
          if (err) {
            out += (out ? '\n' : '') + `[退出码 ${err.code ?? 'N/A'}]`;
            if (err.killed) out += '（命令超时 120 秒，已被终止）';
          }
          resolve(truncate(out || '(命令执行完成，无输出)'));
        });
      });
    },

    async search_files(args) {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) throw new Error('search_files 需要 pattern 参数');
      const root = resolveSafe(args.path);
      if (!fs.existsSync(root)) throw new Error(`目录不存在: ${root}`);
      const rx = globToRegex(pattern);
      const results = [];
      const walk = (dir) => {
        if (results.length >= 200) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= 200) return;
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            walk(path.join(dir, e.name));
          } else if (rx.test(e.name)) {
            results.push(path.relative(ws(), path.join(dir, e.name)));
          }
        }
      };
      walk(root);
      return results.length
        ? `找到 ${results.length} 个匹配文件:\n` + results.join('\n')
        : `未找到匹配 "${pattern}" 的文件`;
    },

    async web_fetch(args) {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https URL');
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
        headers: { 'User-Agent': 'DeepSeekHarnessDesktop/0.1' },
      });
      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();
      return `HTTP ${resp.status} ${contentType}\n\n` + truncate(text);
    },
  };

  const schemas = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取工作目录下某个文本文件的内容。二进制文件不支持。大文件只返回前一部分。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对工作目录的路径，也支持绝对路径' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '把文本内容写入文件（自动创建父目录）。写入工作目录之外会请求用户确认。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目标文件路径' },
            content: { type: 'string', description: '要写入的完整文本内容（覆盖写）' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出目录内容（含文件大小），用于探索项目结构。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径，默认工作目录' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: '在用户操作系统的 shell 中执行命令（Windows 为 cmd，macOS/Linux 为 sh），工作目录为设定的工作区，超时 120 秒。执行前通常需要用户确认。',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '要执行的完整命令行' } },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: '按文件名通配符递归搜索文件（支持 * 和 **，自动跳过 node_modules/.git 等）。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '文件名模式，如 *.py、config*.json' },
            path: { type: 'string', description: '搜索起始目录，默认工作目录' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取一个 http/https 网页或 API 的原始内容（截断到 8000 字符），用于查资料。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整 URL' } },
          required: ['url'],
        },
      },
    },
  ];

  async function execute(call) {
    const name = call.function.name;
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch (err) {
      throw new Error(`工具参数不是合法 JSON: ${err.message}`);
    }
    const fn = impl[name];
    if (!fn) throw new Error(`未知工具: ${name}`);
    return await fn(args);
  }

  return { execute, schemas, isInside };
}

module.exports = { createTools, isInside, truncate, globToRegex, BINARY_EXTENSIONS };
