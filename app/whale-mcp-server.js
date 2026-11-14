/*
 * 鲸鱼娘工具箱 —— 本地 MCP 服务（stdio / NDJSON JSON-RPC）
 * 由「鲸鱼娘工具箱（本地）」连接器写入 Codex 引擎的 config.toml 后，由 codex 自动拉起。
 * 仅暴露安全、只读、无副作用的工具，供 Agent 在本地调用。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = { name: 'whale-toolbox', version: '1.0.0' };

const TOOLS = [
  {
    name: 'whale_read_file',
    description: '读取一个文本文件的全部内容（UTF-8）。用于让 Agent 查看本地文件。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件绝对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'whale_list_dir',
    description: '列出目录下的文件与子目录名称。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录绝对路径' } },
      required: ['path'],
    },
  },
  {
    name: 'whale_now',
    description: '返回当前本地时间与时区信息。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'whale_calc',
    description: '计算一个纯算术表达式（仅支持 + - * / ( ) 与数字），不执行任何代码。',
    inputSchema: {
      type: 'object',
      properties: { expr: { type: 'string', description: '例如 (12+8)*3/2' } },
      required: ['expr'],
    },
  },
];

function ok(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
function log(...a) {
  process.stderr.write('[whale-mcp] ' + a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ') + '\n');
}

function callTool(name, args) {
  try {
    if (name === 'whale_read_file') {
      const p = String(args.path || '');
      if (!p) throw new Error('缺少 path');
      const txt = fs.readFileSync(p, 'utf8');
      return { content: [{ type: 'text', text: txt.slice(0, 200000) }] };
    }
    if (name === 'whale_list_dir') {
      const p = String(args.path || '');
      if (!p) throw new Error('缺少 path');
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const lines = entries.map(e => (e.isDirectory() ? '[目录] ' : '[文件] ') + e.name);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    if (name === 'whale_now') {
      const now = new Date();
      return {
        content: [{
          type: 'text',
          text: '本地时间：' + now.toLocaleString('zh-CN') +
            '\nISO：' + now.toISOString() +
            '\n时区：' + (process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'),
        }],
      };
    }
    if (name === 'whale_calc') {
      const expr = String(args.expr || '').trim();
      if (!/^[\d\s+\-*/().]+$/.test(expr)) throw new Error('仅支持数字与 + - * / ( )');
      // 仅做算术，绝不使用 eval；用 Function 构造纯数值计算也禁用，这里手动求值。
      const result = safeEval(expr);
      return { content: [{ type: 'text', text: String(result) }] };
    }
    throw new Error('未知工具：' + name);
  } catch (e) {
    return { content: [{ type: 'text', text: '错误：' + (e.message || e) }], isError: true };
  }
}

// 极简、安全的四则运算求值（递归下降），不使用 eval / Function。
function safeEval(expr) {
  const s = expr.replace(/\s+/g, '');
  let i = 0;
  function peek() { return s[i]; }
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]; const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++]; const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function parseFactor() {
    if (peek() === '(') { i++; const v = parseExpr(); if (s[i] === ')') i++; return v; }
    let num = '';
    while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
    const v = parseFloat(num);
    if (Number.isNaN(v)) throw new Error('非法数字：' + num);
    return v;
  }
  const r = parseExpr();
  if (i !== s.length) throw new Error('无法解析的表达式');
  return r;
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('解析失败:', line); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(msg) {
  const id = msg.id;
  try {
    if (msg.method === 'initialize') {
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'initialized') return; // 通知，无需回复
    if (msg.method === 'ping') return ok(id, {});
    if (msg.method === 'tools/list') {
      return ok(id, { tools: TOOLS });
    }
    if (msg.method === 'tools/call') {
      const r = callTool(msg.params && msg.params.name, (msg.params && msg.params.arguments) || {});
      return ok(id, r);
    }
    if (id !== undefined && id !== null) {
      return fail(id, -32601, '不支持的方法：' + (msg.method || ''));
    }
  } catch (e) {
    log('处理出错', e);
    if (id !== undefined && id !== null) fail(id, -32603, String(e.message || e));
  }
}

log('whale-mcp-server 已启动（stdio）');
