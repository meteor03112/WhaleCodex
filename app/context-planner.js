/**
 * 请求前历史装配（第六轮 P4）
 *
 * 职责：在**不触发上游上下文超限**的前提下，按优先级决定这次请求带哪些历史，
 * 并把每一次取舍写进 `contextPlan.actions`，保证可解释、可回滚。
 *
 * 设计边界（对应 P4 指令）：
 *   · 纯逻辑：不读文件、不发请求、不碰全局状态，便于单测；
 *   · 绿色/黄色水位**完全不改历史**（与旧路径逐字节一致）；
 *   · 橙色/红色才装配，且先按分数补，仍超限才动"最近消息"里的非 pin 项；
 *   · 系统指令、pin、未完成工具链**永不删除**；
 *   · 估算不确定（能力来源 fallback 或无 tokenizer）时额外留余量，不冒险占满；
 *   · 不做摘要（P5 未实施），被丢弃的高价值消息只标记为"P5 候选"。
 */
'use strict';

const B = require('./context-budget.js');

const DEFAULTS = {
  keepRecentTurns: 8,     // 最近 8 轮 = 16 条 user/assistant
  errorMargin: 0.05,      // 估算不确定时的额外余量（占比）
  summaryTrigger: 0.70,
};

/** 单条消息的 token 估算（复用预算模块，保证口径一致）。 */
function tokensOf(m) {
  return B.estimateMessages([m]);
}

/**
 * 可解释的打分：分越高越优先保留。
 * 只做启发式，不做语义模型判断；所有加减项都能在 actions 里说清。
 */
function scoreOf(m, idx, total) {
  if (m.pinned) return 1000;
  if (m.kind === 'tool' && m.toolOpen) return 900;
  let s = m.role === 'user' ? 12 : (m.role === 'assistant' ? 8 : 10);
  if (m.kind === 'tool') s = 3;                       // 已完成的工具输出价值最低
  if (/决定|结论|约束|必须|不得|hash|sha256|验收|通过|失败|错误/.test(String(m.content || ''))) s += 6;
  // 越新越重要（0..5 分）
  s += Math.round((idx / Math.max(1, total)) * 5);
  return s;
}

/** 只把 role/content（以及图片）留给上游，内部字段不外发。 */
function strip(m) {
  const out = { role: m.role, content: m.content };
  if (m.images) out.images = m.images;
  if (m.name) out.name = m.name;
  return out;
}

function buildPlan(budget, extra) {
  return Object.assign({}, budget, extra, { planner: 'context-planner/v1' });
}

/**
 * @param {object} o
 *   capability {contextWindow, providerHardLimit, maxOutputTokens, reasoningReserve, calibrationFactor, source, tokenizer}
 *   systemMessages []      不可删
 *   currentInput []        本轮输入
 *   history []             历史（可带 id / kind / toolOpen / pinned）
 *   tools []               工具定义（占 P）
 *   requestedOutput number
 *   pinnedMessageIds []
 *   taskState object
 *   params {keepRecentTurns, errorMargin, summaryTrigger}
 */
function planHistory(o) {
  const src = o || {};
  const cap = src.capability || {};
  const p = Object.assign({}, DEFAULTS, src.params || {});
  const systemMessages = Array.isArray(src.systemMessages) ? src.systemMessages : [];
  const currentInput = Array.isArray(src.currentInput) ? src.currentInput
    : (src.currentInput ? [src.currentInput] : []);
  const rawHistory = Array.isArray(src.history) ? src.history : [];
  const tools = Array.isArray(src.tools) ? src.tools : [];

  const history = rawHistory.map((m, i) => Object.assign({}, m, { id: String(m && m.id != null ? m.id : 'm' + i), _i: i }));
  const pinnedIds = new Set((src.pinnedMessageIds || []).map(String));
  history.forEach((m) => { if (pinnedIds.has(m.id)) m.pinned = true; });

  const systemTokens = B.estimateMessages(systemMessages);
  const toolsTokens = B.estimateMessages(tools);
  const inputTokens = B.estimateMessages(currentInput);

  // 估算不确定：能力来自保守默认、或没有 tokenizer → 额外留余量
  const uncertain = (cap.source === 'fallback') || !cap.tokenizer;
  const extraRatio = uncertain ? p.errorMargin : 0;

  const budget = B.computeBudget({
    contextWindow: Math.min(
      Number(cap.contextWindow) || B.DEFAULTS.minWindow,
      Number(cap.providerHardLimit) || Number(cap.contextWindow) || B.DEFAULTS.minWindow
    ),
    systemTokens: systemTokens + toolsTokens,
    inputTokens: inputTokens,
    historyTokens: B.estimateMessages(history),
    requestedOutput: src.requestedOutput,
    reasoningReserve: cap.reasoningReserve || 0,
    estimatorFactor: cap.calibrationFactor || 1,
    maxOutputTokens: cap.maxOutputTokens,
    params: { reserveRatio: B.DEFAULTS.reserveRatio + extraRatio, summaryTrigger: p.summaryTrigger },
  });

  const level = budget.level;
  const baseWarn = uncertain ? ['estimator_uncertain'] : [];

  // 绿色 / 黄色：原样返回，历史一条不动
  if (level === 'green' || level === 'yellow') {
    return {
      selectedMessages: history.map(strip),
      omittedMessageIds: [],
      summaryMessageIds: [],
      contextPlan: buildPlan(budget, {
        level: level, actions: [], trimmed: false,
        selectedTokens: budget.H, selectedCount: history.length, omittedCount: 0,
        fits: true,
      }),
      actions: [],
      warnings: baseWarn,
    };
  }

  // 橙色 / 红色：按优先级装配
  const C = budget.C;
  const recentCount = Math.max(0, Math.floor(p.keepRecentTurns)) * 2;
  const mandatory = [], rest = [];
  history.forEach((m, i) => {
    const isRecent = i >= history.length - recentCount;
    const isOpenTool = m.kind === 'tool' && m.toolOpen;
    if (m.pinned || isOpenTool || isRecent) mandatory.push(m);
    else rest.push(m);
  });

  const selected = mandatory.slice();
  let used = selected.reduce((n, m) => n + tokensOf(m), 0);
  const omitted = [];
  const actions = [];

  const ranked = rest
    .map((m) => ({ m: m, s: scoreOf(m, m._i, history.length) }))
    .sort((a, b) => (b.s - a.s) || (b.m._i - a.m._i));
  const keptFromRest = [];
  for (const it of ranked) {
    const t = tokensOf(it.m);
    if (used + t <= C) { selected.push(it.m); used += t; keptFromRest.push(it.m); }
    else omitted.push(it.m);
  }
  if (keptFromRest.length) {
    actions.push({
      type: 'keep_by_priority',
      messageIds: keptFromRest.map((m) => m.id),
      tokens: keptFromRest.reduce((n, m) => n + tokensOf(m), 0),
      reason: 'fill_remaining_budget',
    });
  }
  if (omitted.length) {
    actions.push({
      type: 'drop_low_value',
      messageIds: omitted.map((m) => m.id),
      tokens: omitted.reduce((n, m) => n + tokensOf(m), 0),
      reason: 'over_history_budget:' + level,
    });
  }

  // 兜底：连强制集都超预算 → 从最近消息里挑非 pin、非未完成工具的最旧项继续让位
  let reducedRecent = [];
  if (used > C) {
    const reducible = selected
      .filter((m) => !m.pinned && !(m.kind === 'tool' && m.toolOpen))
      .sort((a, b) => a._i - b._i);
    for (const m of reducible) {
      if (used <= C) break;
      const i = selected.indexOf(m);
      if (i < 0) continue;
      selected.splice(i, 1);
      used -= tokensOf(m);
      omitted.push(m);
      reducedRecent.push(m);
    }
    if (reducedRecent.length) {
      actions.push({
        type: 'reduce_recent',
        messageIds: reducedRecent.map((m) => m.id),
        tokens: reducedRecent.reduce((n, m) => n + tokensOf(m), 0),
        reason: 'mandatory_exceeds_budget',
      });
    }
  }

  selected.sort((a, b) => a._i - b._i);
  const fits = used <= C;

  return {
    selectedMessages: selected.map(strip),
    omittedMessageIds: omitted.map((m) => m.id),
    // P5 未实施：这里只标记"未来应摘要"的高价值被弃项，不做任何摘要
    summaryMessageIds: omitted
      .filter((m) => scoreOf(m, m._i, history.length) >= 12)
      .map((m) => m.id),
    contextPlan: buildPlan(budget, {
      level: level, actions: actions, trimmed: omitted.length > 0,
      selectedTokens: used, selectedCount: selected.length,
      omittedCount: omitted.length, fits: fits,
    }),
    actions: actions,
    warnings: baseWarn.concat(fits ? [] : ['mandatory_exceeds_budget']),
  };
}

module.exports = { DEFAULTS, planHistory, scoreOf, tokensOf, strip };
