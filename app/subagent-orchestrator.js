/**
 * 只读子智能体编排（第六轮 A1）
 *
 * 职责：父运行创建 1–4 个**只读**子运行，各自独立 runId / 事件 / 取消 / 预算 / 能力快照，
 * 并把结果以「未经采纳」的形态交给宿主。本模块**不碰**网络、不碰 Electron、不写主记忆。
 *
 * 硬边界（A0 复核结论 + A1 指令）：
 *   · 子运行**永不**创建孙运行（父 run 带 parentRunId 即拒绝）；
 *   · 子运行**永不**写主记忆、**永不**自动合并结果（bundle.adopted 恒为空，mergePolicy='none'）；
 *   · 权限只能**降级**不能升级：派生结果对 fs.write/exec/memory.write/subagents.spawn/
 *     desktop.input 一律 denied，遥测与能力缓存都不能把它抬回去；
 *   · `unknown` 能力不得当作支持：默认拒绝派生，只有显式受限探测才允许，且窗口被压到保守上限；
 *   · 子运行使用**独立 threadId**（sub:<parentRunId>:<i>），因此不会改写主线程的会话版本、
 *     累计用量或侧聊父快照——这是「不混入已通过的侧聊同步逻辑」的结构性保证。
 *
 * 与既有模块的复用（不重写）：
 *   · run-registry：run 身份、单调 seq、JSONL 落盘、按 run 取消、正文增量（stream.delta）；
 *   · text-stream：delta 的 append/ignore/repair 判定，保证重复事件幂等；
 *   · context-budget：子运行窗口与预算口径；
 *   · model-capability：能力来源 / 置信度 / 版本（本模块只读，不扩权）。
 *
 * 执行器 `runChild` 由宿主注入（便于单测与 stub 上游），签名见 startChild()。
 */
'use strict';

const B = require('./context-budget.js');
const TS = require('./text-stream.js');

const VERSION = 'subagent-orchestrator/a1';

const LIMITS = {
  maxChildren: 4,          // A0：1–4 并发
  childPoolRatio: 0.5,     // childPool = min(parentAvailable × 0.5, providerCap)
  minChildWindow: 4096,    // 子窗口下限（低于此值如实标 window_below_min）
  maxTaskChars: 8000,      // 单子任务描述上限，防止把整篇上下文塞进去
  maxResultChars: 8000,    // 结构化结果 answer 上限
  maxPartialChars: 4000,   // 失败时保留的部分正文上限
  unknownWindowCap: 32000, // 能力未知/降级时的保守窗口上限
  trustMinConfidence: 0.75,// 低于该置信度的能力不得当作「完整能力」
};

const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'interrupted']);

/* ============================ 权限矩阵 ============================ */

// 8 类权限 × 3 档（allow / read-only / denied）。子运行的上限写死在表里，
// 派生时只能取「父权限 ∩ 子上限」，所以永远不可能升级。
const PERMISSION_KINDS = [
  'fs.read', 'fs.write', 'exec', 'memory.read',
  'memory.write', 'subagents.spawn', 'desktop.input', 'net.fetch',
];
const CHILD_CEILING = {
  'fs.read': 'read-only',      // 只读，且范围被 readRoots 进一步收窄
  'fs.write': 'denied',
  'exec': 'denied',
  'memory.read': 'read-only',  // 只读父快照，不读主记忆的可写句柄
  'memory.write': 'denied',
  'subagents.spawn': 'denied', // 无孙运行
  'desktop.input': 'denied',   // 不做物理键鼠（D0/D1 另立阶段）
  'net.fetch': 'denied',
};
const LEVEL = { denied: 0, 'read-only': 1, allow: 2 };
const LEVEL_NAME = ['denied', 'read-only', 'allow'];

function levelOf(v) {
  return Object.prototype.hasOwnProperty.call(LEVEL, v) ? LEVEL[v] : 0;
}
function nameOf(n) { return LEVEL_NAME[n] || 'denied'; }

/**
 * 派生子运行权限：取父权限与子上限的较小值。
 * 返回里显式带 upgraded（恒为空），便于测试直接断言「没有一处被抬高」。
 */
function derivePermissions(parentPermissions) {
  const parent = parentPermissions || {};
  const permissions = {};
  const inherited = [];
  const denied = [];
  for (const k of PERMISSION_KINDS) {
    const pv = levelOf(parent[k]);
    const cv = levelOf(CHILD_CEILING[k]);
    const v = Math.min(pv, cv);
    permissions[k] = nameOf(v);
    if (v > 0) inherited.push(k); else denied.push(k);
  }
  return { permissions: permissions, inherited: inherited, denied: denied, upgraded: [], ceiling: Object.assign({}, CHILD_CEILING) };
}

/* ============================ 只读范围 ============================ */

/** 规范化根路径：统一分隔符；Windows 大小写不敏感，用 key 做比较、raw 做展示。 */
function normalizeRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(roots) ? roots : [])) {
    if (typeof r !== 'string') continue;
    const raw = r.trim().replace(/[\\/]+$/, '');
    if (!raw) continue;
    const unified = raw.replace(/\//g, '\\');
    const key = process.platform === 'win32' ? unified.toLowerCase() : unified;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: unified, key: key });
  }
  return out;
}

/** child 是否等于 parent 或位于其下（按分隔符边界，避免同前缀兄弟目录误命中）。 */
function isSubPath(childKey, parentKey) {
  if (childKey === parentKey) return true;
  const sep = '\\';
  return childKey.indexOf(parentKey + sep) === 0;
}

/**
 * 校验子运行只读范围：必须是父范围的**真子集**。
 *   · 越界 → read_scope_outside_parent
 *   · 与父范围完全等同 → read_scope_not_subset（等于没有收窄）
 *   · 未指定 → 空范围（合法，等于「不给读」）
 */
function deriveReadRoots(parentRoots, requested) {
  const P = normalizeRoots(parentRoots);
  const R = normalizeRoots(requested);
  if (!R.length) {
    return { ok: true, roots: [], strictSubset: true, note: 'no_read_scope', parentRoots: P.map((x) => x.raw) };
  }
  if (!P.length) {
    return { ok: false, reason: 'read_scope_outside_parent', offender: R[0].raw, parentRoots: [] };
  }
  for (const r of R) {
    const inside = P.some((p) => isSubPath(r.key, p.key));
    if (!inside) return { ok: false, reason: 'read_scope_outside_parent', offender: r.raw, parentRoots: P.map((x) => x.raw) };
  }
  // 真子集判定：R 覆盖了 P 的每一项（在「R ⊆ P」前提下只可能是完全相等）
  const coversAll = P.every((p) => R.some((r) => isSubPath(p.key, r.key)));
  if (coversAll) {
    return { ok: false, reason: 'read_scope_not_subset', offender: R.map((x) => x.raw), parentRoots: P.map((x) => x.raw) };
  }
  return { ok: true, roots: R.map((x) => x.raw), strictSubset: true, parentRoots: P.map((x) => x.raw) };
}

/* ============================ 能力状态 ============================ */

/**
 * 能力状态三档（严格按 A0 的两条硬约束）：
 *   known    —— 来源 provider/explicit/calibrated 且置信度达标：可按完整能力使用
 *   degraded —— 有来源但置信度不达标：可用但**不是完整能力**，窗口压到保守上限
 *   unknown  —— 没有任何可信元数据（含 fallback 保守默认）：**不得当作支持**，
 *               默认拒绝派生；只有显式 allowUnknownProbe 才做受限探测
 * 注意：这里只读能力缓存，绝不写回、绝不因遥测而提高窗口。
 */
function capabilityStatus(rec) {
  if (!rec || typeof rec !== 'object') {
    return {
      status: 'unknown', fullCapability: false, source: null, confidence: 0,
      contextWindow: 0, maxOutputTokens: null, version: null, note: 'no_capability_record',
      unknownReason: 'no_capability_record',
    };
  }
  const conf = typeof rec.confidence === 'number' ? rec.confidence : 0;
  const win = Math.max(0, Math.floor(Number(rec.contextWindow) || 0));
  const base = {
    source: rec.source || null, confidence: conf, version: rec.version || null,
    contextWindow: win,
    maxOutputTokens: typeof rec.maxOutputTokens === 'number' ? rec.maxOutputTokens : null,
    note: rec.note || null,
  };
  // 保守默认不是「支持」：窗口数字只是占位，不能作为能力依据
  if (rec.source === 'fallback' || !rec.source) {
    return Object.assign({ status: 'unknown', fullCapability: false, unknownReason: 'untrusted_metadata' }, base);
  }
  const trusted = (rec.source === 'provider' || rec.source === 'explicit' || rec.source === 'calibrated')
    && conf >= LIMITS.trustMinConfidence;
  if (trusted) return Object.assign({ status: 'known', fullCapability: true }, base);
  return Object.assign({ status: 'degraded', fullCapability: false, unknownReason: 'low_confidence' }, base);
}

/* ============================ 预算 ============================ */

/**
 * 子预算池：childPool = min(parentAvailable × ratio, providerCap)。
 * 逐个孩子的 tokenCap 之和**恒不超过** childPool（余数按序分配，绝不四舍五入放大）。
 */
function computeChildPool(o) {
  const src = o || {};
  const avail = Math.max(0, Math.floor(Number(src.parentAvailable) || 0));
  const ratioRaw = Number(src.ratio);
  const ratio = (isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw < 1) ? ratioRaw : LIMITS.childPoolRatio;
  const capRaw = Number(src.providerCap);
  const providerCap = (isFinite(capRaw) && capRaw > 0) ? Math.floor(capRaw) : avail;
  const pool = Math.max(0, Math.min(Math.floor(avail * ratio), providerCap));
  const n = Math.max(1, Math.floor(Number(src.n) || 1));
  const base = Math.floor(pool / n);
  const rem = pool - base * n;
  const perChild = [];
  for (let i = 0; i < n; i++) perChild.push(base + (i < rem ? 1 : 0));
  const allocated = perChild.reduce((a, b) => a + b, 0);
  return {
    parentAvailable: avail, providerCap: providerCap, ratio: ratio,
    pool: pool, perChild: perChild, allocated: allocated, unallocated: pool - allocated,
  };
}

/* ============================ 结构化结果 ============================ */

/** 从正文里取结构化结果：优先 ```json 代码块，其次整段就是一个 JSON 对象。 */
function extractJsonValue(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());
  candidates.push(s);
  for (const c of candidates) {
    if (!c) continue;
    if (c[0] !== '{' && c[0] !== '[') continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch (e) { /* 继续尝试下一个候选 */ }
  }
  return null;
}

/**
 * 校验子运行的结构化结果。
 * 失败一律 `trusted:false` 并给出可读原因——**校验不过的结果不得被采纳**，
 * 由宿主决定是丢弃还是让用户确认（A1 不自动采纳）。
 */
function validateChildResult(raw, opts) {
  const o = opts || {};
  const maxChars = Number(o.maxResultChars) > 0 ? Math.floor(Number(o.maxResultChars)) : LIMITS.maxResultChars;
  let value = null, format = 'none';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    value = raw; format = 'object';
  } else {
    const s = String(raw == null ? '' : raw);
    const j = extractJsonValue(s);
    if (j) { value = j; format = 'json'; }
  }
  const preview = (v) => String(v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v))).slice(0, 400);
  if (!value) return { trusted: false, reason: 'not_structured', format: format, rawPreview: preview(raw) };
  if (Array.isArray(value)) return { trusted: false, reason: 'not_object', format: format, rawPreview: preview(value) };
  if (typeof value.answer !== 'string' || !value.answer.trim()) {
    return { trusted: false, reason: 'missing_answer', format: format, rawPreview: preview(value) };
  }
  if (value.answer.length > maxChars) {
    return { trusted: false, reason: 'answer_too_long', format: format, rawPreview: preview(value.answer) };
  }
  if (value.findings !== undefined) {
    if (!Array.isArray(value.findings)) {
      return { trusted: false, reason: 'findings_not_array', format: format, rawPreview: preview(value) };
    }
    for (const f of value.findings) {
      if (!f || typeof f !== 'object' || typeof f.claim !== 'string' || !f.claim.trim()) {
        return { trusted: false, reason: 'finding_missing_claim', format: format, rawPreview: preview(value) };
      }
      if (f.evidence !== undefined && typeof f.evidence !== 'string') {
        return { trusted: false, reason: 'finding_bad_evidence', format: format, rawPreview: preview(value) };
      }
    }
  }
  if (value.confidence !== undefined) {
    const c = Number(value.confidence);
    if (!isFinite(c) || c < 0 || c > 1) {
      return { trusted: false, reason: 'bad_confidence', format: format, rawPreview: preview(value) };
    }
  }
  if (value.citations !== undefined) {
    if (!Array.isArray(value.citations) || value.citations.some((x) => typeof x !== 'string')) {
      return { trusted: false, reason: 'bad_citations', format: format, rawPreview: preview(value) };
    }
  }
  return {
    trusted: true, format: format, reason: null,
    value: {
      answer: value.answer.trim(),
      findings: Array.isArray(value.findings) ? value.findings.map((f) => ({ claim: f.claim.trim(), evidence: f.evidence || null })) : [],
      confidence: value.confidence === undefined ? null : Number(value.confidence),
      citations: Array.isArray(value.citations) ? value.citations.slice() : [],
      needsMore: value.needsMore === true,
    },
  };
}

/* ============================ 编排器 ============================ */

/**
 * @param {object} o
 *   registry     RunRegistry（必需）
 *   capability   model-capability 注册表（可选；缺省则能力恒为 unknown）
 *   runChild     async(ctx) → {text, usage?, structured?, error?}（必需，宿主注入）
 *   budget       context-budget 模块（默认 require）
 *   textStream   text-stream 模块（默认 require）
 *   now / log / limits
 */
function createOrchestrator(o) {
  const opt = o || {};
  const registry = opt.registry || null;
  const capability = opt.capability || null;
  const budget = opt.budget || B;
  const textStream = opt.textStream || TS;
  const runChild = typeof opt.runChild === 'function' ? opt.runChild : null;
  const now = typeof opt.now === 'function' ? opt.now : (() => Date.now());
  const log = typeof opt.log === 'function' ? opt.log : (() => {});
  const limits = Object.assign({}, LIMITS, opt.limits || {});

  const parents = new Map();   // parentRunId → entry
  const kids = new Map();      // childRunId → child record
  const buffers = new Map();   // childRunId → {content, reasoning}

  function bufOf(runId) {
    let b = buffers.get(runId);
    if (!b) { b = { content: textStream.init(null), reasoning: textStream.init(null) }; buffers.set(runId, b); }
    return b;
  }

  function isTerminalState(s) { return TERMINAL.has(s); }

  /* ---------- 能力解析 ---------- */

  function resolveCapability(q) {
    const src = q || {};
    if (src.record) return Object.assign({ providerId: src.providerId || null, modelId: src.modelId || null },
      capabilityStatus(src.record));
    if (!capability || typeof capability.get !== 'function' || !src.modelId) {
      return Object.assign({ providerId: src.providerId || null, modelId: src.modelId || null },
        capabilityStatus(null));
    }
    let rec = null;
    try {
      rec = capability.get({
        providerId: src.providerId, modelId: src.modelId,
        wireModel: src.wireModel || src.modelId, catalogCtx: src.catalogCtx,
      });
    } catch (e) { rec = null; }
    return Object.assign({ providerId: src.providerId || null, modelId: src.modelId || null },
      capabilityStatus(rec));
  }

  /* ---------- 单子运行 ---------- */

  function publicChild(c) {
    const run = registry ? registry.get(c.runId) : null;
    const proj = registry && run ? registry.project(c.runId) : null;
    const snap = registry && run ? registry.textSnapshot(c.runId) : null;
    const partial = snap && snap.content ? snap.content.text : '';
    return {
      runId: c.runId, index: c.index, state: c.state, model: c.model,
      parentRunId: c.parentRunId,
      tokenCap: c.tokenCap, windowCap: c.windowCap,
      windowBelowMin: c.windowBelowMin === true,
      readRoots: c.readRoots.slice(),
      permissions: Object.assign({}, c.permissions),
      capability: Object.assign({}, c.capability),
      trusted: c.trusted === true,
      trustReason: c.trustReason || null,
      untrusted: c.untrusted || null,
      error: c.error || null,
      partialText: c.state === 'finished' ? '' : String(partial).slice(-limits.maxPartialChars),
      usage: proj ? proj.usage : null,
      usageState: proj ? proj.usageState : 'waiting',
      lastSeq: run ? run.seq : null,
      startedAt: c.startedAt, endedAt: c.endedAt,
      subscribable: !!(run && !isTerminalState(run.state)),
      textEndpoint: '/api/runs/' + c.runId + '/text',
      eventsEndpoint: '/api/runs/' + c.runId + '/events',
    };
  }

  function setState(c, state) {
    c.state = state;
    if (isTerminalState(state) && !c.endedAt) c.endedAt = now();
  }

  function pushDelta(c, channel, text) {
    if (!text || !registry) return;
    const run = registry.get(c.runId);
    if (!run || isTerminalState(run.state)) return;
    registry.pushText(c.runId, c.requestId, channel, text);
  }

  function flush(c) {
    if (!registry) return 0;
    return registry.flushText(c.runId, null);
  }

  /**
   * 启动一个子运行。**永不 reject**：任何失败都落到 child 记录 + run.failed 事件里，
   * 父运行与其它兄弟子运行不受影响。
   */
  async function startChild(entry, c) {
    const run = registry.get(c.runId);
    if (!run) { setState(c, 'failed'); c.error = { code: 'run_missing', message: '子运行未创建' }; return; }
    const ac = new AbortController();
    registry.attach(c.runId, { abort: () => { try { ac.abort(); } catch (e) {} } });
    setState(c, 'running');
    registry.emit(c.runId, 'run.started', { kind: 'sub', model: c.model, parentRunId: c.parentRunId, index: c.index }, 'server');
    registry.emit(c.runId, 'turn.accepted', { model: c.model, parentRunId: c.parentRunId }, 'client');
    registry.emit(c.runId, 'child.started', {
      parentRunId: c.parentRunId, index: c.index, readOnly: true,
      readRoots: c.readRoots.slice(), tokenCap: c.tokenCap, windowCap: c.windowCap,
      capability: { status: c.capability.status, source: c.capability.source, confidence: c.capability.confidence },
    }, 'server');
    registry.emit(c.runId, 'request.started', { requestId: c.requestId, model: c.model }, 'server');
    entry.running += 1;

    try {
      if (!runChild) throw Object.assign(new Error('未注入子运行执行器'), { code: 'no_runner' });
      const r = await runChild({
        runId: c.runId, parentRunId: c.parentRunId, index: c.index,
        task: c.task, model: c.model,
        readOnly: true, readRoots: c.readRoots.slice(), files: c.files.slice(),
        tokenCap: c.tokenCap, windowCap: c.windowCap,
        capability: Object.assign({}, c.capability),
        signal: ac.signal,
        push: (channel, text) => pushDelta(c, channel, text),
        flush: () => flush(c),
      });
      const cur = registry.get(c.runId);
      if (ac.signal.aborted || (cur && cur.state === 'cancelled')) {
        setState(c, 'cancelled');
        return;
      }
      if (r && r.error) {
        throw Object.assign(new Error(String(r.error.message || r.error)), {
          code: String(r.error.code || 'child_error'),
        });
      }
      if (r && r.usage) registry.emit(c.runId, 'request.usage', { requestId: c.requestId, usage: r.usage }, 'provider');
      flush(c);
      registry.emit(c.runId, 'request.completed', { requestId: c.requestId }, 'server');
      let text = (r && typeof r.text === 'string') ? r.text : '';
      if (!text) {
        // 执行器没回正文时，以 run 的正文快照为准（就是 UI 看到的那份）
        const snap0 = registry.textSnapshot(c.runId);
        text = (snap0 && snap0.content) ? snap0.content.text : '';
      }
      const v = validateChildResult((r && r.structured != null) ? r.structured : text,
        { maxResultChars: limits.maxResultChars });
      c.trusted = v.trusted;
      c.trustReason = v.reason;
      c.result = v.trusted ? v.value : null;
      c.untrusted = v.trusted ? null : { reason: v.reason, rawPreview: v.rawPreview };
      registry.emit(c.runId, 'child.result', {
        trusted: v.trusted, reason: v.reason, format: v.format,
        chars: text.length, adopted: false,
      }, 'server');
      setState(c, 'finished');
      registry.emit(c.runId, 'run.finished', { trusted: v.trusted, adopted: false }, 'server');
      log({ kind: 'subagent_child_finished', runId: c.runId, parentRunId: c.parentRunId,
        trusted: v.trusted, reason: v.reason, chars: text.length });
    } catch (e) {
      const cur = registry.get(c.runId);
      const aborted = ac.signal.aborted || (cur && cur.state === 'cancelled');
      const code = aborted ? 'cancelled' : String((e && e.code) || 'child_failed');
      const message = String((e && e.message) || e || 'unknown').slice(0, 400);
      if (aborted) {
        setState(c, 'cancelled');
        log({ kind: 'subagent_child_cancelled', runId: c.runId, parentRunId: c.parentRunId });
      } else {
        flush(c);
        try { registry.emit(c.runId, 'request.failed', { requestId: c.requestId, error: { code: code, message: message } }, 'server'); } catch (x) {}
        const snap = registry.textSnapshot(c.runId);
        const partial = (snap && snap.content ? snap.content.text : '') || '';
        c.error = { code: code, message: message };
        c.trusted = false;
        c.trustReason = 'child_failed';
        registry.emit(c.runId, 'child.failed', {
          reason: code, message: message, partialChars: partial.length,
        }, 'server');
        setState(c, 'failed');
        registry.emit(c.runId, 'run.failed', { error: { code: code, message: message } }, 'server');
        log({ kind: 'subagent_child_failed', runId: c.runId, parentRunId: c.parentRunId, code: code, message: message });
      }
    } finally {
      entry.running = Math.max(0, entry.running - 1);
    }
  }

  /* ---------- 汇总 ---------- */

  function summarize(entry) {
    const list = entry.children;
    const finished = list.filter((c) => c.state === 'finished');
    const failed = list.filter((c) => c.state === 'failed' || c.state === 'cancelled' || c.state === 'blocked');
    const trusted = list.filter((c) => c.state === 'finished' && c.trusted === true);
    const untrusted = list.filter((c) => c.state === 'finished' && c.trusted !== true);
    const allFailed = finished.length === 0 && list.length > 0;
    const pending = list.some((c) => c.state === 'queued' || c.state === 'running');
    return {
      ok: true,
      version: VERSION,
      parentRunId: entry.parentRunId,
      mode: allFailed ? 'single-run' : 'subagents',
      pending: pending,
      degraded: allFailed,
      fallback: allFailed ? {
        mode: 'single',
        reason: 'all_children_failed',
        note: '全部子运行失败：父运行按普通单 run 继续，不把失败伪装成结论',
      } : null,
      children: list.map(publicChild),
      results: trusted.map((c) => ({
        runId: c.runId, index: c.index, trusted: true,
        answer: c.result ? c.result.answer : null,
        findings: c.result ? c.result.findings : [],
        confidence: c.result ? c.result.confidence : null,
        citations: c.result ? c.result.citations : [],
        needsMore: c.result ? c.result.needsMore : false,
        adopted: false,
      })),
      untrusted: untrusted.map((c) => ({
        runId: c.runId, index: c.index, trusted: false,
        reason: c.trustReason, preview: c.untrusted ? c.untrusted.rawPreview : '',
      })),
      // A1 硬规则：永不自动合并。宿主只能把 results 展示给用户或自己决定下一步。
      adopted: [],
      mergePolicy: 'none',
      counts: {
        total: list.length, finished: finished.length, failed: failed.length,
        trusted: trusted.length, untrusted: untrusted.length, running: entry.running,
      },
      budget: Object.assign({}, entry.budget),
      permissions: Object.assign({}, entry.permissions),
      capability: Object.assign({}, entry.capability),
      startedAt: entry.startedAt,
      endedAt: pending ? null : (entry.endedAt || now()),
      rollback: { setting: 'settings.subAgents', value: false, effect: '关闭后不再派生，父运行按普通单 run 执行' },
    };
  }

  /* ---------- 取消 ---------- */

  function cancelChildren(parentRunId, reason) {
    const entry = parents.get(parentRunId);
    if (!entry) return { ok: true, cancelled: [] };
    const cancelled = [];
    for (const c of entry.children) {
      if (c.state === 'queued' || c.state === 'running') {
        try { registry.cancel(c.runId, reason || 'parent_cancelled'); } catch (e) {}
        setState(c, 'cancelled');
        cancelled.push(c.runId);
      }
    }
    return { ok: true, cancelled: cancelled };
  }

  /* ---------- 派生 ---------- */

  /**
   * 创建 1–4 个只读子运行。
   * @returns {{ok:boolean, reason?:string, parentRunId?:string, children?:Array, done?:Promise, ...}}
   * 返回立即生效（子运行已在后台跑），`done` 恒 resolve，绝不 reject。
   */
  function spawn(parentRunId, req) {
    const q = req || {};
    const base = {
      ok: false, version: VERSION, parentRunId: parentRunId || null,
      children: [], rejected: [], mode: 'single-run',
    };
    if (!registry) return Object.assign(base, { reason: 'no_registry' });
    if (q.enabled === false) {
      return Object.assign(base, {
        reason: 'disabled',
        rollback: { setting: 'settings.subAgents', value: false },
        note: '子智能体已全局关闭：父运行按普通单 run 执行',
      });
    }
    const parent = registry.get(parentRunId);
    if (!parent) return Object.assign(base, { reason: 'parent_not_found' });
    // 无孙运行：先判结构规则，再判状态——否则「子运行已结束」会盖掉更具体的拒绝原因
    if (parent.meta && parent.meta.parentRunId) {
      return Object.assign(base, { reason: 'no_grandchild', detail: '子运行不得再派生孙运行' });
    }
    if (isTerminalState(parent.state)) return Object.assign(base, { reason: 'parent_terminal', detail: parent.state });
    if (parents.has(parentRunId) && parents.get(parentRunId).children.some((c) => c.state === 'running' || c.state === 'queued')) {
      return Object.assign(base, { reason: 'already_spawned', detail: '同一父运行已有进行中的子运行' });
    }

    const tasksIn = Array.isArray(q.tasks) ? q.tasks : [];
    if (!tasksIn.length) return Object.assign(base, { reason: 'no_tasks' });
    const truncated = tasksIn.length > limits.maxChildren;
    const tasks = tasksIn.slice(0, limits.maxChildren);

    // 能力：未知默认拒绝；降级可用但压窗口；known 才按完整能力
    const model = q.model || parent.model || null;
    const cap = resolveCapability({
      record: q.capabilityRecord,
      providerId: q.providerId, modelId: q.modelId || (model || ''),
      wireModel: q.wireModel, catalogCtx: q.catalogCtx,
    });
    if (cap.status === 'unknown' && q.allowUnknownProbe !== true) {
      return Object.assign(base, {
        reason: 'capability_unknown',
        capability: cap,
        note: '能力未知不得当作支持：默认拒绝派生；如需探测请显式 allowUnknownProbe=true（窗口压到保守上限）',
      });
    }
    const probeOnly = cap.status !== 'known';
    const effectiveWindow = probeOnly
      ? Math.min(cap.contextWindow || limits.unknownWindowCap, limits.unknownWindowCap)
      : cap.contextWindow;

    // 预算：父可用额度 × 0.5，且不超过 provider 上限
    const parentAvailable = Number.isFinite(Number(q.parentAvailable)) && Number(q.parentAvailable) > 0
      ? Math.floor(Number(q.parentAvailable))
      : (effectiveWindow || limits.unknownWindowCap);
    const providerCap = Number(q.providerCap) > 0 ? Math.floor(Number(q.providerCap))
      : (cap.maxOutputTokens || effectiveWindow || parentAvailable);
    const pool = computeChildPool({
      parentAvailable: parentAvailable, providerCap: providerCap,
      ratio: q.childPoolRatio, n: tasks.length,
    });

    const parentPerm = q.parentPermissions || {
      'fs.read': 'allow', 'fs.write': 'allow', 'exec': 'allow', 'memory.read': 'allow',
      'memory.write': 'allow', 'subagents.spawn': 'allow', 'desktop.input': 'allow', 'net.fetch': 'allow',
    };
    const perm = derivePermissions(parentPerm);
    const parentRoots = q.parentReadRoots || (parent.meta && parent.meta.readRoots) || [];

    const entry = {
      parentRunId: parentRunId,
      startedAt: now(),
      endedAt: null,
      running: 0,
      children: [],
      rejected: [],
      budget: pool,
      permissions: perm.permissions,
      capability: cap,
      unsub: null,
    };

    const jobs = [];
    tasks.forEach((t, i) => {
      const taskText = typeof t === 'string' ? t : (t && typeof t.task === 'string' ? t.task : '');
      const files = (t && Array.isArray(t.files)) ? t.files.filter((f) => typeof f === 'string') : [];
      const reqRoots = (t && Array.isArray(t.readRoots)) ? t.readRoots : (q.readRoots || []);
      if (!taskText.trim()) {
        entry.rejected.push({ index: i, reason: 'invalid_task' });
        return;
      }
      if (taskText.length > limits.maxTaskChars) {
        entry.rejected.push({ index: i, reason: 'task_too_long', chars: taskText.length });
        return;
      }
      const roots = deriveReadRoots(parentRoots, reqRoots);
      if (!roots.ok) {
        // 越界的子运行不创建：以 blocked 记录如实展示，绝不悄悄放宽范围
        entry.children.push({
          runId: null, index: i, state: 'blocked', model: model,
          parentRunId: parentRunId, task: taskText, files: files,
          tokenCap: 0, windowCap: 0, readRoots: [],
          permissions: perm.permissions, capability: cap,
          requestId: null, trusted: false, trustReason: roots.reason,
          error: { code: roots.reason, message: '只读范围不是父范围的真子集', offender: roots.offender },
          startedAt: now(), endedAt: now(),
        });
        entry.rejected.push({ index: i, reason: roots.reason, offender: roots.offender });
        return;
      }
      const tokenCap = pool.perChild[i] || 0;
      // 子窗口不得超过本次分配的 tokenCap；不足下限时如实标记，而不是假装够用
      const rawWin = Math.min(effectiveWindow || tokenCap || limits.minChildWindow, tokenCap || limits.minChildWindow);
      const windowCap = Math.max(limits.minChildWindow, rawWin);
      const windowBelowMin = rawWin < limits.minChildWindow;
      const childRun = registry.create({
        kind: 'sub',
        sessionId: parent.sessionId,
        // 独立 threadId：子运行的事件与用量不并入主线程版本/累计（侧聊父快照不受影响）
        threadId: 'sub:' + parentRunId + ':' + i,
        model: model,
        meta: {
          parentRunId: parentRunId, index: i, readOnly: true,
          readRoots: roots.roots, tokenCap: tokenCap, windowCap: windowCap,
          capability: { status: cap.status, source: cap.source, confidence: cap.confidence, version: cap.version },
          spawnedBy: VERSION,
        },
      });
      const c = {
        runId: childRun.runId, index: i, state: 'queued', model: model,
        parentRunId: parentRunId, task: taskText, files: files,
        tokenCap: tokenCap, windowCap: windowCap, readRoots: roots.roots,
        windowBelowMin: windowBelowMin,
        permissions: perm.permissions, capability: cap,
        requestId: 'req_' + childRun.runId,
        trusted: false, trustReason: null, untrusted: null, error: null, result: null,
        startedAt: now(), endedAt: null,
      };
      entry.children.push(c);
      kids.set(childRun.runId, c);
      registry.emit(childRun.runId, 'child.created', {
        parentRunId: parentRunId, index: i, readOnly: true,
        readRoots: roots.roots, tokenCap: tokenCap, windowCap: windowCap,
        windowBelowMin: windowBelowMin,
        capability: { status: cap.status, source: cap.source, confidence: cap.confidence,
          fullCapability: cap.fullCapability, version: cap.version },
        permissions: perm.permissions, probeOnly: probeOnly,
      }, 'server');
      jobs.push(startChild(entry, c));
    });

    if (!entry.children.some((c) => c.runId)) {
      return Object.assign(base, {
        reason: entry.rejected.length ? 'all_children_rejected' : 'no_valid_task',
        rejected: entry.rejected, capability: cap, permissions: perm.permissions,
        budget: pool,
      });
    }

    parents.set(parentRunId, entry);
    // 父运行一旦进入终态，立即把仍存活的子运行收掉（父取消传播）
    try {
      entry.unsub = registry.subscribe(parentRunId, (ev) => {
        if (ev.type === 'run.cancelled' || ev.type === 'run.failed'
          || ev.type === 'run.interrupted' || ev.type === 'run.finished') {
          cancelChildren(parentRunId, 'parent_terminal:' + ev.type);
        }
      });
    } catch (e) {}

    entry.done = Promise.allSettled(jobs).then(() => {
      entry.endedAt = now();
      const b = summarize(entry);
      log({ kind: 'subagent_bundle', parentRunId: parentRunId, mode: b.mode,
        counts: b.counts, degraded: b.degraded });
      return b;
    });

    const out = summarize(entry);
    out.ok = true;
    out.rejected = entry.rejected;
    out.truncated = truncated;
    out.probeOnly = probeOnly;
    out.done = entry.done;
    out.limits = { maxChildren: limits.maxChildren, childPoolRatio: limits.childPoolRatio };
    return out;
  }

  /* ---------- 读取 ---------- */

  function bundle(parentRunId) {
    const entry = parents.get(parentRunId);
    if (!entry) return { ok: false, reason: 'not_found', parentRunId: parentRunId };
    return summarize(entry);
  }

  function childrenOf(parentRunId) {
    const entry = parents.get(parentRunId);
    if (!entry) return [];
    return entry.children.map(publicChild);
  }

  function stateOf(childRunId) {
    const c = kids.get(childRunId);
    if (!c) return null;
    return publicChild(c);
  }

  /**
   * 幂等消费子运行事件（续订/重连用）。
   * 同一条 stream.delta 重复投递只会被 ignore；缺帧则返回 repair，由调用方拉 /text 快照。
   */
  function ingest(childRunId, events) {
    const b = bufOf(childRunId);
    const out = { applied: 0, ignored: 0, repairs: 0, resets: 0, content: '', reasoning: '' };
    for (const ev of (Array.isArray(events) ? events : [])) {
      if (!ev || ev.type !== 'stream.delta') continue;
      const p = ev.payload || {};
      const channel = p.channel === 'reasoning' ? 'reasoning' : 'content';
      const r = textStream.apply(b[channel], p);
      if (r.action === 'append') { out.applied += 1; b[channel] = r.state; }
      else if (r.action === 'ignore') out.ignored += 1;
      else if (r.action === 'repair') { out.repairs += 1; b[channel] = r.state; }
      else if (r.action === 'reset') { out.resets += 1; b[channel] = r.state; }
    }
    out.content = b.content.text;
    out.reasoning = b.reasoning.text;
    return out;
  }

  /** 用后端快照做初值（attach 时用），保证续订后逐字一致。 */
  function attachSnapshot(childRunId, snap) {
    const b = bufOf(childRunId);
    b.content = textStream.fromSnapshot(snap);
    return { content: b.content.text, len: b.content.len, truncated: b.content.truncated };
  }

  function textOf(childRunId) {
    const b = buffers.get(childRunId);
    return b ? { content: b.content.text, reasoning: b.reasoning.text, len: b.content.len } : null;
  }

  function dispose() {
    for (const [, entry] of parents) {
      if (entry.unsub) { try { entry.unsub(); } catch (e) {} entry.unsub = null; }
    }
    parents.clear();
    kids.clear();
    buffers.clear();
  }

  return {
    VERSION: VERSION,
    limits: limits,
    spawn: spawn,
    bundle: bundle,
    childrenOf: childrenOf,
    stateOf: stateOf,
    cancelChildren: cancelChildren,
    ingest: ingest,
    attachSnapshot: attachSnapshot,
    textOf: textOf,
    resolveCapability: resolveCapability,
    dispose: dispose,
    _parents: parents,
  };
}

module.exports = {
  VERSION, LIMITS, TERMINAL,
  PERMISSION_KINDS, CHILD_CEILING, derivePermissions,
  normalizeRoots, isSubPath, deriveReadRoots,
  capabilityStatus, computeChildPool,
  extractJsonValue, validateChildResult,
  createOrchestrator,
};
