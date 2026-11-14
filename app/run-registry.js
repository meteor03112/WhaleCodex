/**
 * 运行注册表（P0）
 *
 * 目标：给「主聊天 / Agent / 侧聊」提供**按 run 隔离**的身份、事件、取消与投影，
 * 让统计归属、取消归属、护栏归属都不再依赖全局单例。
 *
 * 设计约束（对应《真实指标与联网工具及并行侧栏-DS执行规划》§3）：
 *   · 身份：sessionId / threadId(main|side:xxx) / runId / turnId / stepId / requestId / attemptId。
 *   · 事件：单调 seq，落盘 JSONL 便于重连补发与对账；后端分配身份，UI 只订阅投影。
 *   · 取消：只取消目标 run；不提供隐式「停全部」以外的跨 run 影响。
 *   · 并发：每个 run 自己的 abort、guard、计时、usage，互不污染。
 *   · SSE 断开 ≠ 业务取消：run 生命周期由本注册表持有，订阅者退订不影响执行。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'interrupted']);
// 正文增量事件：单条上限 4096 字符（单帧可控），内存尾部保留 64KB（超出如实标 truncated）
const TEXT_CHUNK = 4096;
const TEXT_TAIL = 64 * 1024;

function nowMs() { return Date.now(); }
function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

class RunRegistry {
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || null;
    this.now = o.now || nowMs;
    this.runs = new Map();      // runId -> run
    this.subs = new Map();      // runId -> Set<fn>
    // 正文增量事件会让单 run 事件数明显变多；attach 不依赖历史重放，挤出不影响续订正确性。
    this.maxEventsInMemory = o.maxEventsInMemory || 8000;
    // 会话级轮次与累计用量：跨 run、跨重启保存，UI 只读投影，不自己累加。
    // key = sessionId|threadId；主会话与侧聊天然隔离，切会话不会串值。
    this.threadCounters = new Map();   // key -> {turn, usage:{...}, lastRun?}
    // 会话级单调版本（事件游标）：**跨 run、跨重启单调递增**。
    // 为什么不能复用 run.seq：每个 run 的 seq 都从 0 起，跨 run 取最大值毫无意义
    // （新 run 的前几条事件序号必然低于旧 run 的高水位），会让父快照误判「未过期」。
    // 版本按 sessionId|threadId 隔离，侧聊事件绝不并入主会话版本。
    this.versions = new Map();         // key -> number
    this.countersFile = this.dir ? path.join(this.dir, '_counters.json') : null;
    this._saveTimer = null;
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) {}
    }
    this._loadCounters();
  }

  _logPath(runId) { return this.dir ? path.join(this.dir, runId + '.jsonl') : null; }

  _threadKey(sessionId, threadId) {
    return String(sessionId || '') + '|' + String(threadId || 'main');
  }

  _loadCounters() {
    if (!this.countersFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.countersFile, 'utf8'));
      if (!j || typeof j !== 'object') return;
      if (j.schemaVersion >= 2 && j.counters && typeof j.counters === 'object') {
        for (const [k, v] of Object.entries(j.counters)) {
          if (v && typeof v === 'object') this.threadCounters.set(k, v);
        }
        const vs = j.versions && typeof j.versions === 'object' ? j.versions : {};
        for (const [k, v] of Object.entries(vs)) {
          if (typeof v === 'number' && isFinite(v) && v >= 0) this.versions.set(k, v);
        }
        return;
      }
      // 旧格式（schemaVersion 缺失）：整份就是 counters。
      // 版本无法从旧文件还原 → 保持空表，读取方返回 null（显示「未知」），绝不伪造 0。
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v === 'object') this.threadCounters.set(k, v);
      }
    } catch (e) { /* 首次运行或文件损坏：从空开始，不伪造历史 */ }
  }

  _saveCounters() {
    if (!this.countersFile) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 250);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** 同步落盘（应用退出 / 测试用），保证累计不因延迟写丢失。 */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.countersFile) return;
    try {
      const counters = {};
      for (const [k, v] of this.threadCounters) counters[k] = v;
      const versions = {};
      for (const [k, v] of this.versions) versions[k] = v;
      const tmp = this.countersFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, counters: counters, versions: versions }));
      fs.renameSync(tmp, this.countersFile);
    } catch (e) {}
  }

  /** 递增某线程的会话级版本。返回递增后的值。 */
  _bumpVersion(sessionId, threadId) {
    const key = this._threadKey(sessionId, threadId);
    const v = (this.versions.get(key) || 0) + 1;
    this.versions.set(key, v);
    this._saveCounters();
    return v;
  }

  /**
   * 线程的当前权威版本。从未记录过事件时返回 null —— 调用方必须显示「未知」，
   * 不能把 null 当 0 用（否则任何旧快照都会被判成「已同步」）。
   */
  threadVersion(sessionId, threadId) {
    const key = this._threadKey(sessionId, threadId);
    return this.versions.has(key) ? this.versions.get(key) : null;
  }

  _threadState(key) {
    let s = this.threadCounters.get(key);
    if (!s) {
      s = {
        turn: 0,
        usage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 0, totalTokens: 0,
          reportedRequests: 0, missingRequests: 0, partial: false,
        },
      };
      this.threadCounters.set(key, s);
    }
    return s;
  }

  /** 按唯一 request 结算一次：重复最终帧、重连、刷新、切会话都不重复累加。 */
  _settle(run, req) {
    if (!req || req.settled) return;
    req.settled = true;
    const key = this._threadKey(run.sessionId, run.threadId);
    const s = this._threadState(key);
    const u = req.usage;
    const hasUsage = !!(u && u.availability && (
      u.availability.input === 'reported' || u.availability.output === 'reported'));
    if (!hasUsage) {
      s.usage.missingRequests += 1;
      s.usage.partial = true;
    } else if (req.fallback) {
      // 引擎整轮 usage 只作兜底：若本轮已有 provider 逐请求上报，就不能再整轮加一次，
      // 否则会重复累计。按请求身份判断，而不是「整 run 是否任意 output 已上报」。
      const providerReported = run.requests.some((r) => r !== req && !r.fallback
        && r.usage && r.usage.availability && r.usage.availability.output === 'reported');
      if (providerReported) {
        s.usage.duplicateSuppressed = (s.usage.duplicateSuppressed || 0) + 1;
        req.fallbackSuppressed = true;
        this._saveCounters();
        return;
      }
      req.fallbackUsed = true;
      s.usage.reportedRequests += 1;
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        const ak = k === 'cacheReadTokens' ? 'cache'
          : k === 'cacheWriteTokens' ? 'cacheWrite'
            : k.replace('Tokens', '');
        if (u.availability[ak] === 'reported' && typeof u[k] === 'number' && u[k] >= 0) s.usage[k] += u[k];
      }
      const inp = u.availability.input === 'reported' ? u.inputTokens : 0;
      const out = u.availability.output === 'reported' ? u.outputTokens : 0;
      if (u.availability.input !== 'reported' || u.availability.output !== 'reported') s.usage.partial = true;
      s.usage.totalTokens += inp + out;
      s.usage.engineFallback = (s.usage.engineFallback || 0) + 1;
      this._saveCounters();
      return;
    } else {
      s.usage.reportedRequests += 1;
      // 缓存读取通常已包含在 input 内，reasoning 通常已包含在 output 内：
      // 总用量只加 input + output，分项另存，绝不重复计入。
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        const ak = k === 'cacheReadTokens' ? 'cache'
          : k === 'cacheWriteTokens' ? 'cacheWrite'
            : k.replace('Tokens', '');
        // 可选分项（缓存写入 / 推理 token / 缓存读取）缺失只是「详情未知」，
        // 不影响 input+output 的总用量，不能把整次请求标成「部分用量未上报」。
        if (u.availability[ak] === 'reported' && typeof u[k] === 'number' && u[k] >= 0) {
          s.usage[k] += u[k];
        }
      }
      const inp = u.availability.input === 'reported' ? u.inputTokens : 0;
      const out = u.availability.output === 'reported' ? u.outputTokens : 0;
      // 只有总量口径本身缺一半，或整次请求完全没上报，才算部分/缺失。
      if (u.availability.input !== 'reported' || u.availability.output !== 'reported') {
        s.usage.partial = true;
      }
      s.usage.totalTokens += inp + out;
    }
    this._saveCounters();
  }

  /** 更新进行中的正文片段（仅内存，供侧聊快照标注未完成）。 */
  setLive(runId, text, reasoning) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (typeof text === 'string') run.liveText = text.slice(-8000);
    if (typeof reasoning === 'string') run.liveReasoning = reasoning.slice(-4000);
  }
  liveTextOf(runId) {
    const run = this.runs.get(runId);
    return run ? { text: run.liveText || '', reasoning: run.liveReasoning || '' } : null;
  }

  /* ---------------- 正文增量事件（活跃 run 续订） ----------------
   * 目的：UI 在窗口迁移/重开/断流后能「接上」正在生成的正文。
   * 做法：正文按增量写成事件（stream.delta），offset 在同一 (run,request,channel)
   *       内严格连续；补发用既有 eventsAfter(afterSeq)，初值用 textSnapshot()。
   * 不变量（单测覆盖）：
   *   · offset 连续、不重叠、不跳号；
   *   · 单条 text ≤ TEXT_CHUNK；
   *   · total === offset + text.length。
   */
  _textKey(requestId, channel) { return String(requestId || '') + '|' + String(channel || 'content'); }

  _textStateOf(run, requestId, channel) {
    const k = this._textKey(requestId, channel);
    let s = run.textState.get(k);
    if (!s) { s = { len: 0, tail: '' }; run.textState.set(k, s); }
    return s;
  }

  /** 追加待发送的正文片段（热路径，只做字符串拼接，不写盘）。 */
  pushText(runId, requestId, channel, text) {
    const run = this.runs.get(runId);
    if (!run || typeof text !== 'string' || !text) return false;
    const k = this._textKey(requestId, channel);
    run.pendText.set(k, (run.pendText.get(k) || '') + text);
    return true;
  }

  /**
   * 把待发送片段写成 stream.delta 事件。返回写入的事件条数。
   * requestId 为 null 时 flush 该 run 全部请求（终态前必须调用）。
   */
  flushText(runId, requestId) {
    const run = this.runs.get(runId);
    if (!run) return 0;
    let n = 0;
    const all = Array.from(run.pendText.keys());
    const keys = requestId == null ? all : all.filter((k) => k.indexOf(String(requestId) + '|') === 0);
    for (const k of keys) {
      const buf = run.pendText.get(k) || '';
      run.pendText.set(k, '');
      if (!buf) continue;
      const sep = k.lastIndexOf('|');
      const reqId = k.slice(0, sep);
      const channel = k.slice(sep + 1);
      const st = this._textStateOf(run, reqId, channel);
      for (let i = 0; i < buf.length; i += TEXT_CHUNK) {
        const piece = buf.slice(i, i + TEXT_CHUNK);
        const offset = st.len;
        st.len += piece.length;
        st.tail = (st.tail + piece).slice(-TEXT_TAIL);
        this.emit(runId, 'stream.delta',
          { requestId: reqId, channel: channel, offset: offset, text: piece, total: st.len }, 'provider');
        n++;
      }
    }
    return n;
  }

  /** attach 用的权威文本快照（尾部截断时如实标 truncated，不假装完整）。 */
  textSnapshot(runId, requestId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    let reqId = requestId == null ? null : String(requestId);
    if (reqId == null) {
      const ids = [];
      for (const k of run.textState.keys()) {
        const id = k.slice(0, k.lastIndexOf('|'));
        if (ids.indexOf(id) < 0) ids.push(id);
      }
      reqId = ids.length ? ids[ids.length - 1] : null;
    }
    const pick = (channel) => {
      const s = reqId == null ? null : run.textState.get(this._textKey(reqId, channel));
      if (!s) return { text: '', baseOffset: 0, len: 0, truncated: false };
      const truncated = s.len > s.tail.length;
      return { text: s.tail, baseOffset: s.len - s.tail.length, len: s.len, truncated: truncated };
    };
    return {
      runId: runId, requestId: reqId, state: run.state,
      content: pick('content'), reasoning: pick('reasoning'),
    };
  }

  /**
   * 从持久化 JSONL 恢复某会话出现过的**最大 run 局部 seq**。
   *
   * 注意：这**不是**会话版本，绝不能拿它当父快照的截止点或过期比较依据。
   * 每个 run 的 seq 各自从 0 起，跨 run 取最大值会出现「新 run 的前几条事件
   * 序号低于旧 run 高水位」的倒挂。会话版本请用 threadVersion()。
   * 本函数仅保留给「按 run 补发事件」的历史排查用途。
   */
  maxSeqForSession(sessionId) {
    if (!this.dir || !sessionId) return 0;
    let files = [];
    try {
      files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => { try { return { f: f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }; } catch (e) { return null; } })
        .filter(Boolean)
        .sort((a, b) => b.t - a.t)
        .slice(0, 60);
    } catch (e) { return 0; }
    let max = 0;
    for (const it of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.dir, it.f), 'utf8'); } catch (e) { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch (x) { continue; }
        if (e.sessionId !== sessionId) continue;
        if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
      }
    }
    return max;
  }

  /** 记录本次请求的上下文预算计划（P1 诊断用，不参与裁剪）。 */
  setContextPlan(runId, plan) {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.contextPlan = plan || null;
    return true;
  }

  /** 供前端切会话 / 恢复时读取该线程的权威累计。 */
  threadStats(sessionId, threadId) {
    const key = this._threadKey(sessionId, threadId);
    const s = this.threadCounters.get(key);
    return {
      sessionId: sessionId || null,
      threadId: threadId || 'main',
      turn: s ? s.turn : 0,
      usage: s ? Object.assign({}, s.usage) : null,
      version: this.threadVersion(sessionId, threadId),
      lastRun: s && s.lastRun ? Object.assign({}, s.lastRun) : null,
    };
  }

  /**
   * 侧聊/主聊恢复用：权威累计 + 最新 run 状态 + 是否可续订 + 未完成片段。
   *
   * 与 threadStats 的区别：这里要回答「这一轮到底跑完了没有」。
   * 内存里有 run 就按真实状态答；重启后内存清空，则回落到持久化的 lastRun 终态，
   * 并明确 source='persisted'（此时流不可续订，只能取最终结果）。
   */
  threadState(sessionId, threadId) {
    const sid = sessionId == null ? null : String(sessionId);
    const tid = String(threadId || 'main');
    const key = this._threadKey(sid, tid);
    const s = this.threadCounters.get(key);
    const mine = [];
    for (const r of this.runs.values()) {
      if (String(r.sessionId == null ? '' : r.sessionId) !== (sid == null ? '' : sid)) continue;
      if (String(r.threadId || 'main') !== tid) continue;
      mine.push(r);
    }
    // 按创建序号（而非 createdAt）排序：同毫秒创建也能确定谁更新。
    mine.sort((a, b) => (b.ord || 0) - (a.ord || 0));
    const latest = mine[0] || null;
    let latestRun = null;
    if (latest) {
      const p = this.project(latest.runId);
      const terminal = TERMINAL.has(latest.state);
      latestRun = {
        runId: latest.runId, state: latest.state, terminal: terminal,
        kind: latest.kind, model: latest.model,
        startedAt: latest.startedAt, endedAt: latest.endedAt,
        turn: latest.turn, step: latest.step, lastSeq: latest.seq,
        usageState: p ? p.usageState : null,
        // 只有内存中仍在跑的 run 才能「接着看」；终态或重启后一律 false。
        subscribable: !terminal,
        partialText: terminal ? '' : String(latest.liveText || '').slice(-4000),
        error: latest.error || null,
        source: 'memory',
      };
    } else if (s && s.lastRun) {
      latestRun = Object.assign({
        terminal: true, subscribable: false, partialText: '',
        usageState: null, error: null,
      }, s.lastRun, { source: 'persisted' });
    }
    return {
      sessionId: sid, threadId: tid,
      turn: s ? s.turn : 0,
      usage: s ? Object.assign({}, s.usage) : null,
      version: this.threadVersion(sid, tid),
      runCount: mine.length,
      latestRun: latestRun,
    };
  }

  create(opts) {
    const o = opts || {};
    const runId = rid('run');
    // 创建序号：同一毫秒内创建多个 run 时，createdAt 无法区分先后，
    // 「最新 run」会随机选到旧的（会把终态误报成运行中）。用单调序号做确定性排序。
    this._runOrd = (this._runOrd || 0) + 1;
    const run = {
      runId: runId,
      ord: this._runOrd,
      threadId: o.threadId || 'main',
      sessionId: o.sessionId || null,
      kind: o.kind || 'chat',
      model: o.model || null,
      state: 'created',
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      seq: 0,
      turn: 0,
      turnBase: this._threadState(this._threadKey(o.sessionId, o.threadId)).turn,
      step: 0,
      turnId: null,
      stepId: null,
      events: [],
      requests: [],
      tools: [],
      usage: null,
      speed: null,
      cache: null,
      error: null,
      meta: o.meta || {},
      abortFns: [],
      guard: o.guard || null,
      proc: null,
      // 进行中的正文/推理片段：只供侧聊快照标注「未完成」，不落盘、不当作已完成事实。
      liveText: '',
      liveReasoning: '',
      // 正文增量：textState 记录每个 (requestId, channel) 的累计长度与尾部；
      // pendText 是待 flush 的片段（热路径只拼字符串，按节流点写事件）。
      textState: new Map(),
      pendText: new Map(),
    };
    this.runs.set(runId, run);
    this.emit(runId, 'run.created', { kind: run.kind, model: run.model, threadId: run.threadId }, 'server');
    return run;
  }

  get(runId) { return this.runs.get(runId) || null; }

  list() {
    const out = [];
    for (const r of this.runs.values()) {
      out.push({ runId: r.runId, threadId: r.threadId, kind: r.kind, state: r.state, model: r.model,
        startedAt: r.startedAt, endedAt: r.endedAt, turn: r.turn, step: r.step });
    }
    return out;
  }

  /** 追加一条事件。返回事件对象（含 seq）。 */
  emit(runId, type, payload, source) {
    const run = this.runs.get(runId);
    if (!run) return null;
    // 终态事件必须先「补完正文」再取 seq：否则 flush 出来的 stream.delta 会拿到
    // 比终态更大的 seq，出现「数组顺序与 seq 顺序相反」，按游标补发就会乱序。
    if (type === 'run.finished' || type === 'run.failed' || type === 'run.cancelled' || type === 'run.interrupted') {
      this.flushText(runId, null);
    }
    run.seq += 1;
    // 会话级版本：与 run.seq 分离。seq 只用于「本 run 事件补发」，
    // 版本才是父快照可比较的截止点（跨 run 单调）。
    const threadV = this._bumpVersion(run.sessionId, run.threadId);
    const ev = {
      schemaVersion: 2,
      seq: run.seq,
      v: threadV,
      runId: run.runId,
      threadId: run.threadId,
      sessionId: run.sessionId,
      type: type,
      at: this.now(),
      mono: process.hrtime.bigint().toString(),
      payload: payload || {},
      source: source || 'server',
    };
    // 状态推进
    switch (type) {
      case 'run.started': run.state = 'running'; run.startedAt = run.startedAt || ev.at; break;
      case 'turn.accepted': {
        // 轮是「同一线程接收的一条用户输入」的序号，跨 run 累计；
        // 自动重试 / 协议回退 / 故障转移属于同一轮的不同 attempt，不增加轮。
        const key = this._threadKey(run.sessionId, run.threadId);
        const ts = this._threadState(key);
        ts.turn = Math.max(ts.turn, run.turnBase) + 1;
        run.turnBase = ts.turn - 1;
        run.turn = ts.turn;
        this._saveCounters();
        run.turnId = (payload && payload.turnId) || rid('turn');
        run.step = 0;
        run.stepId = null;
        ev.payload = Object.assign({}, payload, { turnId: run.turnId, turn: run.turn, turnOfThread: run.turn });
        break;
      }
      case 'step.started':
        run.step += 1;
        run.stepId = (payload && payload.stepId) || rid('step');
        ev.payload = Object.assign({}, payload, { stepId: run.stepId, step: run.step, turn: run.turn });
        break;
      case 'request.started': {
        const givenId = (payload && payload.requestId) || null;
        // 幂等：同一 requestId 重复 started 复用原对象，不 push 新请求，
        // 否则重放/重连会把一次请求拆成两条、重复结算。
        if (givenId) {
          const exist = run.requests.find((r) => r.requestId === givenId);
          if (exist) {
            ev.payload = Object.assign({}, payload, {
              requestId: givenId, index: run.requests.indexOf(exist), duplicate: true,
            });
            break;
          }
        }
        const rawStart = Number(payload && payload.startedAt);
        const req = {
          requestId: givenId || rid('req'),
          attemptId: (payload && payload.attemptId) || null,
          model: (payload && payload.model) || run.model,
          wire: (payload && payload.wire) || null,
          // 允许调用方传真实执行起点（补跑 / 引擎整轮），否则用事件时刻
          startedAt: isFinite(rawStart) && rawStart > 0 ? rawStart : ev.at,
          firstGenAt: null,
          lastGenAt: null,
          genEvents: 0,
          usage: null,
          status: 'running',
          settled: false,
          fallback: !!(payload && payload.fallback),
          noSpeed: !!(payload && payload.noSpeed),
        };
        run.requests.push(req);
        ev.payload = Object.assign({}, payload, { requestId: req.requestId, index: run.requests.length - 1 });
        break;
      }
      case 'request.first_output': {
        const req = this._req(run, payload);
        if (req && req.firstGenAt === null) {
          // 允许补跑 / 后台路径传入真实的首个生成事件时刻，避免用事件补发时刻
          // 冒充生成起点（会算出错误甚至负的窗口）。
          const f = Number(payload && payload.firstGenAt);
          req.firstGenAt = isFinite(f) && f > 0 ? f : ev.at;
        }
        break;
      }
      case 'request.last_output': {
        const req = this._req(run, payload);
        if (req) {
          const last = Number(payload && payload.lastGenAt);
          if (isFinite(last)) req.lastGenAt = last;
          const n = Number(payload && payload.genEvents);
          if (isFinite(n)) req.genEvents = n;
          if (req.firstGenAt === null && isFinite(last)) req.firstGenAt = last;
        }
        break;
      }
      case 'request.usage': {
        const req = this._req(run, payload);
        // 重复最终帧使用最新快照，不重复累加；真正累加只在 request 结算时发生一次。
        if (req && !req.settled) req.usage = (payload && payload.usage) || null;
        break;
      }
      case 'request.completed':
      case 'request.failed': {
        const req = this._req(run, payload);
        if (req) {
          req.status = type === 'request.completed' ? 'completed' : 'failed';
          const rawEnd = Number(payload && payload.completedAt);
          req.completedAt = isFinite(rawEnd) && rawEnd > 0 ? rawEnd : ev.at;
          this._settle(run, req);
        }
        break;
      }
      case 'tool.started': {
        run.tools.push({
          toolCallId: (payload && payload.toolCallId) || rid('tool'),
          name: (payload && payload.name) || '',
          status: 'running',
          startedAt: ev.at,
          endedAt: null,
        });
        ev.payload = Object.assign({}, payload, { toolCallId: run.tools[run.tools.length - 1].toolCallId });
        break;
      }
      case 'tool.finished': {
        const id = payload && payload.toolCallId;
        const t = run.tools.find((x) => x.toolCallId === id);
        if (t) { t.status = (payload && payload.status) || 'done'; t.endedAt = ev.at; }
        break;
      }
      case 'run.finished':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.interrupted': {
        // 正文已在 emit() 入口 flush（见上），这里只做状态推进。
        run.state = type.replace('run.', '');
        run.endedAt = ev.at;
        if (type === 'run.failed') run.error = (payload && payload.error) || null;
        // 终态必须结算所有在途 request：取消 / 断流已上报的用量照样计入，
        // 未上报的保留为「部分用量未上报」，不伪称完整总数。
        for (const req of run.requests) {
          if (!req.completedAt) req.completedAt = ev.at;
          this._settle(run, req);
        }
        // 持久化该线程最后一次 run 的终态：重启后内存 run 清空，
        // 侧聊重开仍需如实显示 finished / cancelled / interrupted（不是「从未运行」）。
        try {
          const ts = this._threadState(this._threadKey(run.sessionId, run.threadId));
          ts.lastRun = {
            runId: run.runId, state: run.state, kind: run.kind, model: run.model,
            startedAt: run.startedAt, endedAt: run.endedAt, turn: run.turn,
            lastSeq: run.seq, threadVersion: ev.v,
            usageState: run.error ? 'partial' : 'reported',
          };
          this._saveCounters();
        } catch (e) {}
        break;
      }
      default: break;
    }

    run.events.push(ev);
    if (run.events.length > this.maxEventsInMemory) run.events.splice(0, run.events.length - this.maxEventsInMemory);

    const lp = this._logPath(runId);
    if (lp) {
      try {
        const line = JSON.stringify(ev) + '\n';
        fs.appendFileSync(lp, line);
        // 记录单 run 日志体积：GC 按体积配额判定时不必反复 stat
        run.logPath = lp;
        run.logBytes = (run.logBytes || 0) + Buffer.byteLength(line, 'utf8');
      } catch (e) {}
    }
    const subs = this.subs.get(runId);
    if (subs) {
      for (const fn of Array.from(subs)) {
        try { fn(ev); } catch (e) {}
      }
    }
    return ev;
  }

  _req(run, payload) {
    const id = payload && payload.requestId;
    // 显式 requestId 必须精确命中；找不到就返回 null，绝不退回「最后一个请求」，
    // 否则迟到/跨 run 的事件会把用量挂到错误的请求上。
    if (id) return run.requests.find((r) => r.requestId === id) || null;
    return run.requests.length ? run.requests[run.requests.length - 1] : null;
  }

  /** 注册本 run 的取消手段（abort / 子进程），只影响该 run。 */
  attach(runId, h) {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (h && typeof h.abort === 'function') run.abortFns.push(h.abort);
    if (h && h.proc) run.proc = h.proc;
    if (h && h.guard) run.guard = h.guard;
    return true;
  }

  /** 只取消目标 run。返回是否真的触发了取消。 */
  cancel(runId, reason) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (TERMINAL.has(run.state)) return { ok: true, already: run.state };
    let killed = false;
    for (const fn of run.abortFns.splice(0)) {
      try { fn(); killed = true; } catch (e) {}
    }
    if (run.proc) {
      try { run.proc.kill(); killed = true; } catch (e) {}
      run.proc = null;
    }
    this.emit(runId, 'run.cancelled', { reason: reason || 'user' }, 'client');
    return { ok: true, killed: killed };
  }

  finish(runId, outcome, extra) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const type = outcome === 'failed' ? 'run.failed' : (outcome === 'cancelled' ? 'run.cancelled' : 'run.finished');
    if (TERMINAL.has(run.state)) return this.project(runId);
    return this.emit(runId, type, extra || {}, 'server');
  }

  subscribe(runId, fn) {
    if (!this.subs.has(runId)) this.subs.set(runId, new Set());
    this.subs.get(runId).add(fn);
    return () => {
      const s = this.subs.get(runId);
      if (s) s.delete(fn);
    };
  }

  /** 从 seq 之后补发（重连用）。 */
  eventsAfter(runId, afterSeq) {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.events.filter((e) => e.seq > (Number(afterSeq) || 0));
  }

  /**
   * 投影：UI 只读这个，不自己累加轮/步。
   * 指标在这里统一计算，避免前端各自估算。
   */
  project(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const tel = require('./telemetry');
    // 被抑制的引擎整轮兜底不参与「本轮」合并，否则本轮用量会翻倍。
    const usages = run.requests
      .filter((r) => !r.fallbackSuppressed)
      .map((r) => r.usage).filter(Boolean);
    const merged = usages.length ? tel.mergeUsage(usages) : null;

    // 速度：只统计「有真实 usage 且可测生成窗口」的 request，按 sum(out)/sum(window)
    let outSum = 0, winSum = 0, measurable = false;
    const perRequest = [];
    for (const r of run.requests) {
      if (!r.usage || r.usage.availability.output !== tel.AVAIL.REPORTED) {
        perRequest.push({ requestId: r.requestId, measurable: false, reason: 'usage_missing' });
        continue;
      }
      // 引擎整轮 usage 没有逐 token 生成窗口，禁止用「请求开始→结束」几毫秒
      // 反推出巨大吞吐；明确标不可测。
      if (r.noSpeed) {
        perRequest.push({ requestId: r.requestId, measurable: false, reason: 'no_generation_window' });
        continue;
      }
      const sp = tel.computeSpeed({
        outputTokens: r.usage.outputTokens,
        firstGenAt: r.firstGenAt,
        lastGenAt: r.lastGenAt,
        events: r.genEvents,
      });
      perRequest.push(Object.assign({ requestId: r.requestId }, sp));
      if (sp.measurable) { outSum += r.usage.outputTokens; winSum += sp.windowMs; measurable = true; }
    }
    let speed = measurable && winSum > 0
      ? { tokensPerSec: Math.round((outSum / (winSum / 1000)) * 10) / 10, windowMs: winSum, measurable: true, basis: 'sum(output)/sum(window)', label: '生成速度' }
      : { tokensPerSec: null, windowMs: winSum, measurable: false, basis: 'sum(output)/sum(window)', label: '生成速度' };
    // 无法测生成窗口时，退一步给「请求吞吐（含等待）」—— 明确标注口径，不冒充生成速度
    if (!speed.measurable) {
      let tOut = 0, tMs = 0;
      for (const r of run.requests) {
        if (r.noSpeed) continue;
        if (!r.usage || r.usage.availability.output !== tel.AVAIL.REPORTED) continue;
        if (!r.completedAt || !r.startedAt || r.completedAt <= r.startedAt) continue;
        tOut += r.usage.outputTokens;
        tMs += (r.completedAt - r.startedAt);
      }
      if (tOut > 0 && tMs > 0) {
        speed = {
          tokensPerSec: Math.round((tOut / (tMs / 1000)) * 10) / 10,
          windowMs: tMs, measurable: false, fallback: true,
          basis: 'sum(output)/sum(request_ms)', label: '请求吞吐（含等待）',
        };
      }
    }

    const cache = merged ? tel.cacheRate(merged) : { rate: null, state: 'missing', note: '缓存未上报' };
    const ts = this.threadStats(run.sessionId, run.threadId);
    const anyUsage = usages.length > 0;
    const usageState = !anyUsage
      ? (TERMINAL.has(run.state) ? 'missing' : 'waiting')
      : (merged && merged.availability && merged.availability.output === tel.AVAIL.REPORTED ? 'reported' : 'partial');

    return {
      runId: run.runId,
      threadId: run.threadId,
      sessionId: run.sessionId,
      kind: run.kind,
      model: run.model,
      state: run.state,
      turn: run.turn,
      turnOfThread: run.turn,
      step: run.step,
      usageState: usageState,
      // 当前线程/会话累计：input + output（缓存读取与 reasoning 已分别包含在其中）。
      sessionUsage: ts.usage,
      sessionTurn: ts.turn,
      turnId: run.turnId,
      stepId: run.stepId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      lastSeq: run.seq,
      contextPlan: run.contextPlan || null,
      usage: merged,
      speed: speed,
      cache: cache,
      requests: perRequest,
      tools: run.tools.map((t) => ({ toolCallId: t.toolCallId, name: t.name, status: t.status })),
      toolCount: run.tools.length,
      error: run.error,
      guard: run.guard && typeof run.guard.snapshot === 'function' ? run.guard.snapshot() : null,
    };
  }

  /** 进程退出时把仍在跑的 run 标成 interrupted（不伪称任务还在跑）。 */
  markAllInterrupted() {
    for (const run of this.runs.values()) {
      if (!TERMINAL.has(run.state) && run.state !== 'created') {
        this.emit(run.runId, 'run.interrupted', { reason: 'app_exit' }, 'server');
      }
    }
  }

  /** 应用真正退出：终止所有执行句柄并写 interrupted 终态（不是 cancelled）。 */
  interruptAll(reason) {
    for (const run of this.runs.values()) {
      if (TERMINAL.has(run.state)) continue;
      for (const fn of run.abortFns.splice(0)) { try { fn(); } catch (e) {} }
      if (run.proc) {
        try { run.proc.kill(); } catch (e) {}
        run.proc = null;
      }
      this.emit(run.runId, 'run.interrupted', { reason: reason || 'app_exit' }, 'server');
    }
  }

  gc(keepMs) {
    const t = this.now() - (keepMs || 30 * 60 * 1000);
    for (const [id, run] of this.runs) {
      if (TERMINAL.has(run.state) && run.endedAt && run.endedAt < t) {
        this.runs.delete(id);
        this.subs.delete(id);
      }
    }
  }

  /**
   * 事件日志清理（第六轮 P2）。
   *
   * 边界（重要）：
   *   · **活跃 run 的事件永不删除**——补发用内存 run.events，但活跃 run 删文件会丢审计与重启取证；
   *   · 删的是审计用 JSONL，**不是续订数据**（续订靠内存 run.events + textState）；
   *   · 终态 run 先满足 TTL 才可删；再按 单run/单session/全局 三级字节配额收缩；
   *   · 刚结束的文件有最小保护期，避免刚跑完就被配额挤掉。
   */
  gcEvents(opts) {
    const o = opts || {};
    const ttlMs = Number(o.terminalTtlMs) > 0 ? Number(o.terminalTtlMs) : 30 * 60 * 1000;
    const perRunBytes = Number(o.perRunBytes) > 0 ? Number(o.perRunBytes) : 8 * 1024 * 1024;
    const perSessionBytes = Number(o.perSessionBytes) > 0 ? Number(o.perSessionBytes) : 32 * 1024 * 1024;
    const globalBytes = Number(o.globalBytes) > 0 ? Number(o.globalBytes) : 128 * 1024 * 1024;
    const minAgeMs = Number(o.minAgeMs) >= 0 ? Number(o.minAgeMs) : 5 * 60 * 1000;
    const now = this.now();
    const out = { at: now, deleted: [], freedBytes: 0, keptActive: 0, scanned: 0, reason: {} };
    if (!this.dir) return out;

    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl') && f !== '_gc.jsonl');
    } catch (e) { return out; }

    const activeIds = new Set();
    for (const [id, run] of this.runs) {
      if (!TERMINAL.has(run.state)) activeIds.add(id);
    }

    const entries = [];
    for (const f of files) {
      const full = path.join(this.dir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      const runId = f.replace(/\.jsonl$/, '');
      entries.push({
        file: f, full: full, runId: runId, bytes: st.size, mtime: st.mtimeMs,
        active: activeIds.has(runId),
        sessionId: this._sessionOfLog(full),
      });
    }
    out.scanned = entries.length;

    const total = () => entries.reduce((n, e) => n + (e.removed ? 0 : e.bytes), 0);
    const remove = (e, reason) => {
      if (e.active || e.removed) return false;
      try { fs.unlinkSync(e.full); } catch (x) { return false; }
      e.removed = true;
      out.deleted.push({ runId: e.runId, bytes: e.bytes, sessionId: e.sessionId, reason: reason });
      out.freedBytes += e.bytes;
      return true;
    };

    out.keptActive = entries.filter((e) => e.active).length;

    // 1) TTL：终态且够老
    for (const e of entries) {
      if (e.active || e.removed) continue;
      if (now - e.mtime >= ttlMs) remove(e, 'ttl');
    }
    // 2) 单 run 超配额
    for (const e of entries) {
      if (e.active || e.removed) continue;
      if (now - e.mtime < minAgeMs) continue;
      if (e.bytes > perRunBytes) remove(e, 'per_run_bytes');
    }
    // 3) 单 session 超配额：删该 session 最旧的终态文件
    const bySession = new Map();
    for (const e of entries) {
      if (e.removed) continue;
      const k = e.sessionId || '(unknown)';
      if (!bySession.has(k)) bySession.set(k, []);
      bySession.get(k).push(e);
    }
    for (const [sid, list] of bySession) {
      let sum = list.reduce((n, e) => n + (e.removed ? 0 : e.bytes), 0);
      if (sum <= perSessionBytes) continue;
      const cands = list.filter((e) => !e.active && !e.removed && now - e.mtime >= minAgeMs)
        .sort((a, b) => a.mtime - b.mtime);
      for (const e of cands) {
        if (sum <= perSessionBytes) break;
        if (remove(e, 'per_session_bytes')) sum -= e.bytes;
      }
    }
    // 4) 全局配额
    let sumAll = total();
    if (sumAll > globalBytes) {
      const cands = entries.filter((e) => !e.active && !e.removed && now - e.mtime >= minAgeMs)
        .sort((a, b) => a.mtime - b.mtime);
      for (const e of cands) {
        if (sumAll <= globalBytes) break;
        if (remove(e, 'global_bytes')) sumAll -= e.bytes;
      }
    }
    out.remainingBytes = total();

    // 清理记录：写清「删了什么、为什么、还剩多少」
    try {
      fs.appendFileSync(path.join(this.dir, '_gc.jsonl'), JSON.stringify(out) + '\n');
    } catch (e) {}
    return out;
  }

  /** 读日志首行拿 sessionId（只读 4KB，避免为 GC 全量读文件）。 */
  _sessionOfLog(full) {
    this._sessionCache = this._sessionCache || new Map();
    if (this._sessionCache.has(full)) return this._sessionCache.get(full);
    let sid = null;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const first = buf.slice(0, n).toString('utf8').split('\n')[0];
      const j = JSON.parse(first);
      sid = j && j.sessionId ? String(j.sessionId) : null;
    } catch (e) { sid = null; }
    this._sessionCache.set(full, sid);
    return sid;
  }
}

module.exports = { RunRegistry: RunRegistry, TERMINAL: TERMINAL };
