'use strict';

/**
 * WhaleCodex 模型适配层 / Model Adapter Layer
 * ==========================================================================
 * 目标：让任意已接入的模型都能稳定跑通 Codex 的 Agent 工具循环，且这套能力
 *       是一个内聚的生态，而不是散落在各处的 if/else 补丁。
 *
 * 统一边界：Codex 引擎永远只说 Responses 协议（wire_api="responses"），
 *           所有模型差异都在这一层收敛，引擎与渲染层不感知具体模型。
 *
 *   /api/agent ──> AgentRuntime（编排 / 护栏）
 *                    └─> Codex 引擎（执行器）
 *                          └─> /v1/responses
 *                                └─> ModelAdapter.plan()     本层：寻址 / 工具 / 协议
 *                                      └─> 上游 chat/completions
 *                                └─> ModelAdapter.finalize() 本层：统一回转为 function_call
 *
 * 分层（自下而上）：
 *   L1 Schema      Responses 工具定义 → 规范 chat/completions function 定义
 *   L2 Capability  能力注册表：运行时自学习 + 持久化 + 档位查询
 *   L3 Protocol    native（标准 tool_calls） / text（结构化文本降级）
 *   L4 Guard       Agent 运行时护栏：步数 / 重复 / 预算 / 墙钟
 *   L5 Retry       失败分类 / 指数退避 / 降级链
 *   Façade         createAdapter()：唯一对外入口，主进程只跟它打交道
 *
 * 设计约束：
 *   1. 纯 CommonJS 模块，不 require electron / fs / http，可被 Node 独立 require 做单元测试。
 *   2. 所有副作用（配置读取、上游寻址、消息转换、日志、时钟）通过 options 注入。
 *   3. 不改动 Codex 引擎，不改动 SSE 事件协议，不写入任何凭据。
 *   4. 任何一步失败都必须可降级，绝不阻断主链路。
 */

// ---------------------------------------------------------------------------
// 常量与通用工具
// ---------------------------------------------------------------------------

const PROTOCOL = Object.freeze({
  NATIVE: 'native',        // 上游原生支持 tool_calls
  TEXT: 'text',            // 上游不支持 tools，走结构化文本协议
  UNKNOWN: 'unknown',      // 未探测：先按 native 试，失败自学习降级
  UNAVAILABLE: 'unavailable',
});

const FAILURE = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  TIMEOUT: 'timeout',
  UPSTREAM_ERROR: 'upstream_error',
  AUTH: 'auth',
  UNSUPPORTED_TOOLS: 'unsupported_tools',
  FATAL: 'fatal',
});

const TEXT_TAG = 'whale_tool';

const DEFAULTS = Object.freeze({
  maxTools: 64,
  maxDescription: 4000,
  maxOutputTokens: 32768,
  minOutputTokens: 256,
  textMissThreshold: 2,     // 连续 N 次「请求带 tools 但只回文本」才降级，避免偶发误判
  guard: {
    maxTurns: 60,
    maxCalls: 120,
    maxRepeatedCalls: 3,
    maxTotalTokens: 400000,
    maxWallMs: 30 * 60 * 1000,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 800,
    maxDelayMs: 12000,
    jitter: 0.25,
  },
});

function cloneJson(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return fallback; }
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

function short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function safeToolName(s) {
  // 上游（NIM / OpenAI 兼容层）只允许 [a-zA-Z0-9_-]；点号会让整个 tools 数组 400。
  return String(s == null ? '' : s).trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}

/** 参数 schema 必须是合法 object 形态，否则上游会整单 400。 */
function normalizeSchema(raw, warnings, name) {
  let p = raw;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (e) { p = null; }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    if (raw != null) warnings.push({ name, reason: 'invalid_parameters_replaced' });
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  const out = cloneJson(p, null);
  if (!out) return { type: 'object', properties: {}, additionalProperties: false };
  if (!out.type) out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object') out.properties = {};
  return out;
}

// ---------------------------------------------------------------------------
// L1 · Schema：Responses 工具定义 → 规范 chat/completions function 定义
// ---------------------------------------------------------------------------

/**
 * 实测 Codex 0.167 的 tools 载荷含三类：
 *   - {type:'function', name, description, parameters, strict}  ← 扁平，无 function 子对象
 *   - {type:'namespace', name, tools:[...]}                     ← 多 Agent 工具组
 *   - {type:'web_search'}                                       ← 内置工具（不可搬运）
 * 旧实现只认第一类且不做 schema 校验，namespace / 内置工具被静默丢弃。
 *
 * @returns {{tools:Array, dropped:Array, warnings:Array, sources:Object}}
 */
function normalizeTools(rawTools, opts) {
  const o = opts || {};
  const max = o.maxTools || DEFAULTS.maxTools;
  const keepStrict = o.keepStrict === true;
  const out = [];
  const dropped = [];
  const warnings = [];
  const sources = {};
  const seen = Object.create(null);

  function push(name, description, parameters, strict, source) {
    const n = safeToolName(name);
    if (!n) { dropped.push({ name: String(name || ''), reason: 'empty_name' }); return; }
    if (seen[n]) { dropped.push({ name: n, reason: 'duplicate_name' }); return; }
    if (out.length >= max) { dropped.push({ name: n, reason: 'tool_limit' }); return; }
    const fn = {
      name: n,
      description: short(description, o.maxDescription || DEFAULTS.maxDescription),
      parameters: normalizeSchema(parameters, warnings, n),
    };
    // strict 只在调用方明确要求时透传：不少中转端点不认该字段，会整单 400。
    if (keepStrict && typeof strict === 'boolean') fn.strict = strict;
    out.push({ type: 'function', function: fn });
    sources[n] = source;
    seen[n] = true;
  }

  const list = Array.isArray(rawTools) ? rawTools : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const type = t.type || (t.name ? 'function' : '');

    if (type === 'function') {
      // 同时兼容扁平（Responses）与嵌套（chat）两种写法。
      const src = (t.function && typeof t.function === 'object') ? t.function : t;
      push(src.name || t.name, src.description || t.description,
        src.parameters || t.parameters, src.strict != null ? src.strict : t.strict, 'function');
      continue;
    }

    if (type === 'namespace') {
      const parent = safeToolName(t.name || 'namespace');
      const children = Array.isArray(t.tools) ? t.tools : [];
      if (!o.expandNamespace) {
        // 实测：把 namespace 子工具重命名后暴露给模型，模型确实会调用，但 Codex 引擎的
        // 工具路由器不认重命名后的名字（unsupported call: multi_agent_v1__spawn_agent）。
        // 多 Agent 编排是引擎内部能力，默认不向第三方模型暴露，避免污染主链路。
        dropped.push({ name: parent, reason: 'namespace_tool_not_routable', children: children.length });
        continue;
      }
      for (const c of children) {
        if (!c || typeof c !== 'object') continue;
        const src = (c.function && typeof c.function === 'object') ? c.function : c;
        // 双下划线保留命名空间且满足上游命名规则；点号会被上游判为 invalid name。
        push(parent + '__' + safeToolName(src.name || c.name),
          '[' + parent + '] ' + (src.description || c.description || ''),
          src.parameters || c.parameters, src.strict != null ? src.strict : c.strict, 'namespace');
      }
      if (!children.length) dropped.push({ name: parent, reason: 'empty_namespace' });
      continue;
    }

    // web_search / local_shell / computer 等 Responses 内置工具无法等价搬运到 chat，
    // 交给 Codex 引擎自己处理；如实记录，不再静默丢弃。
    dropped.push({ name: t.name || type || 'unknown', reason: 'builtin_tool_not_portable' });
  }

  return { tools: out, dropped, warnings, sources };
}

// ---------------------------------------------------------------------------
// L3 · Protocol：结构化文本降级协议
// ---------------------------------------------------------------------------

/** 生成给模型看的工具清单（紧凑、可读、不含实现细节）。 */
function buildToolBrief(tools) {
  const lines = [];
  for (const t of tools || []) {
    const fn = t.function || t;
    const props = (fn.parameters && fn.parameters.properties) || {};
    const req = (fn.parameters && Array.isArray(fn.parameters.required)) ? fn.parameters.required : [];
    const parts = Object.keys(props).map(k => {
      const p = props[k] || {};
      return k + ':' + (p.type || 'any') + (req.indexOf(k) >= 0 ? '!' : '');
    });
    lines.push('- ' + fn.name + '(' + parts.join(', ') + ') — ' + short(fn.description, 160));
  }
  return lines.join('\n');
}

/**
 * 文本协议系统提示：要求模型用 fenced JSON 声明工具调用。
 * 只用一种主格式 + 明确禁止其它写法，降低弱模型的解析歧义。
 */
function buildTextProtocolSystem(tools) {
  const brief = buildToolBrief(tools);
  return [
    'You are running inside the Codex agent runtime. To use a tool you MUST output ONLY a fenced JSON block:',
    '',
    '```' + TEXT_TAG,
    '{"name":"<tool name>","arguments":{<valid JSON arguments>}}',
    '```',
    '',
    'Rules:',
    '1. One tool call per block. Multiple blocks are allowed in one reply.',
    '2. The block must contain exactly one JSON object with "name" and "arguments".',
    '3. Never wrap the JSON in prose, markdown lists, or extra keys. Never explain the call inside the block.',
    '4. If no tool is needed, reply with plain text only. Do NOT emit a block when you are finished.',
    '5. After a tool result arrives, continue from that result; do not repeat a previously successful call.',
    '',
    'Available tools:',
    brief || '(none)',
  ].join('\n');
}

  // 只把「内容看起来是 JSON」的代码块当协议块，避免误删普通的 python/js 代码块。
function isJsonish(s) {
  const t = String(s || '').trim();
  return t.charAt(0) === '{' || t.charAt(0) === '[';
}

/** 从一段文本里稳健提取工具调用，容错代码块、标签、裸 JSON、数组与轻微截断。 */
function parseTextToolCalls(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const candidates = [];

  // ① fenced code blocks（仅接受以 { 或 [ 开头的内容）
  const fenced = /```(?:whale_tool|json|JSON|tool)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(raw)) !== null) {
    if (isJsonish(m[1])) candidates.push(m[1]);
  }

  // ② 显式标签
  const tagged = new RegExp('<' + TEXT_TAG + '>\\s*([\\s\\S]*?)\\s*</' + TEXT_TAG + '>', 'g');
  while ((m = tagged.exec(raw)) !== null) candidates.push(m[1]);

  // ③ 全文可能是单个 JSON 对象或数组
  if (isJsonish(raw)) candidates.push(raw);

  const calls = [];
  const seen = new Set();

  // ④ Codex 引擎的 developer instructions 会教模型用 <tool_call> XML 声明调用；
  //    文本协议降级时模型常照这个格式输出，必须一并兼容，否则会解析出 0 个调用。
  const xmlRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let xm;
  while ((xm = xmlRe.exec(raw)) !== null) {
    const body = xm[1] || '';
    const fn = /<function\s*=\s*([^\s>]+)\s*>/i.exec(body);
    const name = fn ? safeToolName(fn[1]) : '';
    if (!name) continue;
    const args = {};
    const pRe = /<parameter\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = pRe.exec(body)) !== null) {
      args[String(pm[1])] = String(pm[2] == null ? '' : pm[2]).trim();
    }
    let argText;
    try { argText = JSON.stringify(args); } catch (e) { argText = '{}'; }
    const key = name + '\u0000' + argText;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ name: name, arguments: argText });
  }
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (!s || s.length > 200000) continue;
    let parsed = null;
    try { parsed = JSON.parse(s); }
    catch (e) {
      // 轻微截断：尝试补齐右花括号，避免流式末尾丢一个字符就全盘失效。
      const trimmed = s.replace(/,\s*$/, '');
      for (const suffix of ['}', '"]}', '"}']) {
        try { parsed = JSON.parse(trimmed + suffix); break; } catch (e2) {}
      }
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const name = safeToolName(item.name || item.tool || item.tool_name);
      if (!name) continue;
      let args = item.arguments != null ? item.arguments : (item.args != null ? item.args : {});
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { /* 保留原始字符串 */ }
      }
      let argText;
      try { argText = typeof args === 'string' ? args : JSON.stringify(args); }
      catch (e) { argText = '{}'; }
      const key = name + '\u0000' + argText;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ name: name, arguments: argText });
    }
  }
  return calls;
}

/** 把文本里的协议块剔掉，只留下给用户看的自然语言；普通代码块原样保留。 */
function stripTextProtocol(text) {
  const tagged = new RegExp('<' + TEXT_TAG + '>\\s*[\\s\\S]*?\\s*</' + TEXT_TAG + '>', 'g');
  return String(text || '')
    .replace(/```(?:whale_tool|json|JSON|tool)?\s*([\s\S]*?)```/g, function (whole, inner) {
      return isJsonish(inner) ? '' : whole;
    })
    .replace(tagged, '')
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// L2 · Capability：能力注册表（运行时自学习 + 持久化）
// ---------------------------------------------------------------------------

class CapabilityRegistry {
  constructor(opts) {
    const o = opts || {};
    this.now = o.now || Date.now;
    this.store = Object.assign(Object.create(null), o.store || {});
    this.textMissThreshold = o.textMissThreshold || DEFAULTS.textMissThreshold;
    this.onChange = o.onChange || function () {};
    this._misses = Object.create(null);
  }

  get(model) {
    const e = this.store[model];
    if (!e) return { mode: PROTOCOL.UNKNOWN, checkedAt: 0, evidence: 'not probed', misses: 0 };
    return Object.assign({}, e);
  }

  set(model, mode, evidence) {
    const prev = this.store[model] ? this.store[model].mode : PROTOCOL.UNKNOWN;
    this.store[model] = {
      mode: mode,
      checkedAt: this.now(),
      evidence: short(evidence || '', 200),
      misses: 0,
    };
    this._misses[model] = 0;
    if (prev !== mode) {
      try { this.onChange(model, mode, evidence); } catch (e) {}
    }
    return this.get(model);
  }

  /**
   * 根据实际交互结果自学习，无需预先跑 25 次探测。
   * @param {string} model
   * @param {object} obs {requestedTools, status, errorText, gotToolCalls, gotText, timedOut}
   */
  learn(model, obs) {
    const o = obs || {};
    const err = String(o.errorText || '');
    const toolRejection = /\btools?\b/i.test(err) &&
      /unsupported|not supported|unknown field|not allowed|does not support/i.test(err);

    if (o.timedOut || o.status === 429 || (o.status >= 500 && o.status < 600)) {
      // 拥塞 / 限流是临时状态，不改档位，交给 RetryPolicy。
      return this.get(model);
    }
    if (o.status === 401 || o.status === 403) {
      return this.set(model, PROTOCOL.UNAVAILABLE, 'auth rejected: ' + short(err, 120));
    }
    if (o.gotToolCalls) {
      return this.set(model, PROTOCOL.NATIVE, 'observed tool_calls');
    }
    if ((o.status === 400 || o.status === 404 || o.status === 422) && toolRejection && o.requestedTools) {
      return this.set(model, PROTOCOL.TEXT, 'upstream rejected tools: ' + short(err, 120));
    }
    if (o.requestedTools && o.gotText && !o.gotToolCalls) {
      this._misses[model] = (this._misses[model] || 0) + 1;
      if (this._misses[model] >= this.textMissThreshold) {
        return this.set(model, PROTOCOL.TEXT, 'replied plain text despite tools request');
      }
      const e = this.get(model);
      e.misses = this._misses[model];
      return e;
    }
    return this.get(model);
  }

  /** 批量重置：只触发一次持久化回调，避免 N 个模型写 N 次 settings.json。 */
  resetAll(evidence) {
    let changed = 0;
    for (const k of Object.keys(this.store)) {
      if (this.store[k].mode !== PROTOCOL.UNKNOWN) changed++;
      this.store[k] = { mode: PROTOCOL.UNKNOWN, checkedAt: this.now(),
        evidence: short(evidence || '', 200), misses: 0 };
      this._misses[k] = 0;
    }
    if (changed) { try { this.onChange('*', PROTOCOL.UNKNOWN, evidence); } catch (e) {} }
    return changed;
  }

  list() { return this.toJSON(); }
  toJSON() { return cloneJson(this.store, {}); }
  load(obj) {
    if (!obj || typeof obj !== 'object') return this;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v.mode === 'string') this.store[k] = Object.assign({}, v);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// L4 · Guard：Agent 运行时护栏
// ---------------------------------------------------------------------------

class AgentGuard {
  constructor(opts) {
    this.cfg = Object.assign({}, DEFAULTS.guard, opts || {});
    this.now = (opts && opts.now) || Date.now;
    this.reset();
  }

  reset(runId) {
    this.runId = runId || 'run_' + this.now();
    this.startedAt = this.now();
    this.turns = 0;
    this.calls = 0;
    this.tokens = 0;
    this.lastKey = '';
    this.repeatCount = 0;
    this.events = [];
    return this;
  }

  /** @returns {{allow:boolean, reason:string, snapshot:object}} */
  observe(ev) {
    const e = ev || {};
    const type = e.type || 'call';
    let reason = '';

    if (type === 'call') {
      this.calls += 1;
      const key = String(e.name || '') + '\u0000' + String(e.arguments || '');
      if (key === this.lastKey) this.repeatCount += 1;
      else { this.lastKey = key; this.repeatCount = 1; }
      if (this.calls > this.cfg.maxCalls) reason = '超过单次任务工具调用上限 ' + this.cfg.maxCalls;
      else if (this.repeatCount > this.cfg.maxRepeatedCalls) {
        reason = '检测到重复调用 ' + String(e.name || '') + ' 连续 ' + this.repeatCount + ' 次，疑似死循环';
      }
    } else if (type === 'turn') {
      this.turns += 1;
      if (this.turns > this.cfg.maxTurns) reason = '超过单次任务轮次上限 ' + this.cfg.maxTurns;
    } else if (type === 'tokens') {
      this.tokens += Math.max(0, Number(e.tokens) || 0);
      if (this.tokens > this.cfg.maxTotalTokens) reason = '超过单次任务 token 预算 ' + this.cfg.maxTotalTokens;
    }

    if (!reason && (this.now() - this.startedAt) > this.cfg.maxWallMs) {
      reason = '超过单次任务墙钟上限 ' + Math.round(this.cfg.maxWallMs / 60000) + ' 分钟';
    }
    if (reason) this.events.push({ at: this.now(), reason: reason });
    return { allow: !reason, reason: reason, snapshot: this.snapshot() };
  }

  snapshot() {
    return {
      runId: this.runId,
      turns: this.turns,
      calls: this.calls,
      tokens: this.tokens,
      repeatCount: this.repeatCount,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      limits: Object.assign({}, this.cfg),
      events: this.events.slice(-10),
    };
  }
}

// ---------------------------------------------------------------------------
// L5 · Retry：失败分类 / 退避 / 降级链
// ---------------------------------------------------------------------------

class RetryPolicy {
  constructor(opts) {
    this.cfg = Object.assign({}, DEFAULTS.retry, opts || {});
    this.random = (opts && opts.random) || Math.random;
  }

  classify(status, errorText, timedOut) {
    if (timedOut) return FAILURE.TIMEOUT;
    const s = Number(status) || 0;
    const err = String(errorText || '');
    if (s === 401 || s === 403) return FAILURE.AUTH;
    if (s === 429) return FAILURE.RATE_LIMITED;
    // 只有「端点确实不支持 tools」才降级协议；工具名/schema 校验失败属于我们自己的
    // 请求构造问题，必须由 L1 规范化修掉，不能误判成能力缺失。
    if ((s === 400 || s === 404 || s === 422) && /\btools?\b/i.test(err) &&
        /unsupported|not supported|unknown field|not allowed|does not support|no such parameter/i.test(err)) {
      return FAILURE.UNSUPPORTED_TOOLS;
    }
    if (s >= 500) return FAILURE.UPSTREAM_ERROR;
    if (s >= 400) return FAILURE.FATAL;
    return FAILURE.FATAL;
  }

  shouldRetry(kind, attempt) {
    if (attempt >= this.cfg.maxAttempts) return false;
    return kind === FAILURE.RATE_LIMITED || kind === FAILURE.TIMEOUT ||
      kind === FAILURE.UPSTREAM_ERROR || kind === FAILURE.UNSUPPORTED_TOOLS;
  }

  delayMs(attempt) {
    const base = this.cfg.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(this.cfg.maxDelayMs, base);
    const jitter = 1 + (this.random() * 2 - 1) * this.cfg.jitter;
    return Math.max(0, Math.round(capped * jitter));
  }

  /** 连续失败后按降级链挑下一个可用模型（跳过自身与不可用档位）。 */
  pickFallback(model, chain, registry) {
    const list = Array.isArray(chain) ? chain : [];
    for (const m of list) {
      if (!m || m === model) continue;
      if (registry && registry.get(m).mode === PROTOCOL.UNAVAILABLE) continue;
      return m;
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// 门面 · createAdapter
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 *   resolveUpstream(model) -> {base, apiKey, providerId}     L0 寻址（模型级，修复路由错配）
 *   toChatMessages(body)   -> chat messages[]                协议转换由主进程注入
 *   modelContext(model)    -> {ctx, thinking}                上下文 / 思考策略
 *   settings()             -> {contextLimit, ...}
 *   capabilities           -> 持久化的档位表
 *   onChange(model, mode)  -> 档位变化回调（写盘）
 *   log(line)              -> 结构化日志
 */
function createAdapter(options) {
  const o = options || {};
  const now = o.now || Date.now;
  const log = o.log || function () {};
  const resolveUpstream = o.resolveUpstream || function () { return { base: '', apiKey: '', providerId: '' }; };
  const toChatMessages = o.toChatMessages || function (body) {
    return typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : [];
  };
  const modelContext = o.modelContext || function () { return { ctx: 128000, thinking: false }; };
  const getSettings = o.settings || function () { return { contextLimit: 350000 }; };
  const toolOptions = o.toolOptions || {};

  const registry = o.registry || new CapabilityRegistry({
    store: o.capabilities || {}, now: now, onChange: o.onChange,
  });
  const guard = o.guard || new AgentGuard({ now: now });
  const retry = o.retry || new RetryPolicy();
  const sessions = new Map();

  // 注入的回调来自主进程（配置 / 上游寻址 / 消息转换）。任一回调因配置异常抛错时，
  // 不能让 /v1/responses 变成未捕获异常把连接挂起；统一降级为安全默认值。
  const guarded = (fn, fallback, label) => (...args) => {
    try {
      const v = fn(...args);
      return v === undefined ? fallback : v;
    } catch (e) {
      try { log('injected ' + label + ' threw: ' + String((e && e.message) || e).slice(0, 120)); } catch (_) {}
      return fallback;
    }
  };
  const resolveUpstreamSafe = guarded(resolveUpstream, { base: '', apiKey: '', providerId: '' }, 'resolveUpstream');
  const toChatMessagesSafe = guarded(toChatMessages, [], 'toChatMessages');
  const modelContextSafe = guarded(modelContext, { ctx: 128000, thinking: false }, 'modelContext');

  function upstreamUrl(base) {
    return String(base || '').replace(/\/+$/, '') + '/chat/completions';
  }

  /** 按模型窗口给每轮输出预算，避免小窗口模型被 32K 撑爆、大窗口模型被 8K 卡住。 */
  function budgetFor(model, body) {
    const mc = modelContextSafe(model) || {};
    const ctx = Number(mc.ctx) || 128000;
    const requested = Number((body && body.max_output_tokens) || 8192);
    const byCtx = clamp(Math.floor(ctx / 16), 2048, DEFAULTS.maxOutputTokens);
    // 显式给出的小预算（能力探测 / ping）原样尊重，不为探测请求放大成本。
    if (requested > 0 && requested < 2048) return clamp(requested, DEFAULTS.minOutputTokens, DEFAULTS.maxOutputTokens);
    return clamp(Math.max(requested, byCtx), DEFAULTS.minOutputTokens, DEFAULTS.maxOutputTokens);
  }

  /**
   * 生成一次上游请求的完整方案。这是适配层的核心输出。
   * @returns {{mode,url,headers,body,tools,dropped,warnings,capability,providerId}}
   */
  function plan(model, body) {
    const req = body || {};
    const cap = registry.get(model);
    const mode = cap.mode === PROTOCOL.TEXT ? PROTOCOL.TEXT : PROTOCOL.NATIVE;
    const norm = normalizeTools(req.tools, toolOptions);
    let messages = toChatMessagesSafe(req);
    if (!Array.isArray(messages)) messages = [];
    const mc = modelContextSafe(model) || {};
    const up = resolveUpstreamSafe(model) || {};

    const upBody = {
      model: model,
      messages: messages,
      stream: true,
      max_tokens: budgetFor(model, req),
    };

    if (mode === PROTOCOL.NATIVE && norm.tools.length) {
      upBody.tools = norm.tools;
      upBody.tool_choice = (typeof req.tool_choice === 'string') ? req.tool_choice : 'auto';
      upBody.parallel_tool_calls = req.parallel_tool_calls !== false;
    } else if (norm.tools.length) {
      // 文本协议：工具清单只进 system prompt，绝不带 tools 字段（否则弱端点直接 400）。
      messages.unshift({ role: 'system', content: buildTextProtocolSystem(norm.tools) });
    }
    // 思考会吃掉每一轮工具回合的预算，对思考型模型统一关；上游不认该参数也不影响主流程。
    if (mc.thinking !== false && !upBody.chat_template_kwargs) {
      upBody.chat_template_kwargs = { thinking: false };
    }

    const headers = {
      Authorization: 'Bearer ' + String(up.apiKey || ''),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    const result = {
      mode: mode,
      url: upstreamUrl(up.base),
      headers: headers,
      body: upBody,
      tools: norm.tools,
      dropped: norm.dropped,
      warnings: norm.warnings,
      sources: norm.sources,
      capability: cap,
      providerId: up.providerId || '',
    };
    try {
      log('plan model=' + model + ' mode=' + mode + ' provider=' + result.providerId +
        ' tools=' + norm.tools.length + ' dropped=' + norm.dropped.length + ' max_tokens=' + upBody.max_tokens);
    } catch (e) {}
    return result;
  }

  /** 开始一次请求会话（用 Responses 的 response id 隔离并发）。 */
  function begin(id, model, planned) {
    sessions.set(id, {
      model: model,
      mode: planned && planned.mode,
      text: '',
      nativeCalls: [],
      startedAt: now(),
    });
    return id;
  }

  /** 喂入流式 delta，两种协议统一在这里累积。 */
  function ingest(id, delta) {
    const s = sessions.get(id);
    if (!s || !delta) return s;
    if (delta.content) s.text += String(delta.content);
    if (Array.isArray(delta.tool_calls)) s.nativeCalls.push.apply(s.nativeCalls, delta.tool_calls);
    return s;
  }

  /**
   * 收尾：把两种协议统一成 function_call 列表。
   * @returns {{calls:Array, visibleText:string, protocol:string}}
   */
  function finalize(id) {
    const s = sessions.get(id) || { mode: PROTOCOL.NATIVE, text: '', nativeCalls: [] };
    const calls = [];

    if (s.mode === PROTOCOL.TEXT) {
      for (const c of parseTextToolCalls(s.text)) {
        calls.push({ id: 'text_' + calls.length + '_' + id, name: c.name, arguments: c.arguments });
      }
    } else {
      // 标准 tool_calls 分片按 index 合并。
      const byIndex = new Map();
      for (const tc of s.nativeCalls) {
        const idx = typeof tc.index === 'number' ? tc.index : byIndex.size;
        let cur = byIndex.get(idx);
        if (!cur) { cur = { id: tc.id || 'call_' + idx + '_' + id, name: '', arguments: '' }; byIndex.set(idx, cur); }
        const fn = tc.function || {};
        if (fn.name) cur.name = safeToolName(fn.name);
        if (fn.arguments) cur.arguments += String(fn.arguments);
      }
      for (const k of Array.from(byIndex.keys()).sort(function (a, b) { return a - b; })) {
        const c = byIndex.get(k);
        if (c.name) calls.push(c);
      }
    }

    const visibleText = s.mode === PROTOCOL.TEXT ? stripTextProtocol(s.text) : s.text;
    sessions.delete(id);
    return { calls: calls, visibleText: visibleText, protocol: s.mode || PROTOCOL.NATIVE };
  }

  /** 让注册表从本次结果里学习；返回更新后的档位。 */
  function observe(model, planned, outcome) {
    const r = outcome || {};
    const obs = {
      requestedTools: !!(planned && planned.body && planned.body.tools && planned.body.tools.length),
      status: r.status,
      errorText: r.errorText || '',
      gotToolCalls: !!r.gotToolCalls,
      gotText: !!r.gotText,
      timedOut: !!r.timedOut,
    };
    const cap = registry.learn(model, obs);
    try {
      log('observe model=' + model + ' mode=' + cap.mode + ' status=' + (r.status || 0) +
        ' calls=' + (r.callCount || 0) + ' evidence=' + cap.evidence);
    } catch (e) {}
    return cap;
  }

  return Object.freeze({
    PROTOCOL: PROTOCOL,
    FAILURE: FAILURE,
    TEXT_TAG: TEXT_TAG,
    plan: plan,
    begin: begin,
    ingest: ingest,
    finalize: finalize,
    observe: observe,
    registry: registry,
    guard: guard,
    retry: retry,
    capabilities: function () { return registry.list(); },
  });
}

module.exports = {
  PROTOCOL: PROTOCOL,
  FAILURE: FAILURE,
  TEXT_TAG: TEXT_TAG,
  DEFAULTS: DEFAULTS,
  normalizeTools: normalizeTools,
  buildToolBrief: buildToolBrief,
  buildTextProtocolSystem: buildTextProtocolSystem,
  parseTextToolCalls: parseTextToolCalls,
  stripTextProtocol: stripTextProtocol,
  CapabilityRegistry: CapabilityRegistry,
  AgentGuard: AgentGuard,
  RetryPolicy: RetryPolicy,
  createAdapter: createAdapter,
};
