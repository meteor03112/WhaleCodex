/**
 * 结构化上下文摘要（第六轮 P5）
 *
 * 职责：在橙/红水位时，把**低价值旧历史**压成一份带来源追踪、可校验、可回滚的结构化摘要，
 * 从而在不删除用户历史的前提下腾出预算。
 *
 * 设计边界（对应 P5 指令）：
 *   · 纯逻辑：不读文件、不发请求、不碰全局状态，可在 Node 里直接 require 做单测；
 *   · **结构化压缩优先**：确定性抽取，不调用模型 → 无递归、无超时、无统计污染；
 *   · 模型摘要为可选增强（`summarize` 可注入），默认不启用；
 *   · 七类内容永不进摘要（系统/开发者、安全约束、pin、未完成工具链、最近消息、要求原文保留）；
 *   · 摘要必须通过字段完整性 + 长度 + contentHash 校验才允许替换原文；
 *   · 校验失败/不值得（摘要不比原文短）→ 保留原文，交回 P4 低价值裁剪；
 *   · 原文不物理删除：摘要只是"这次请求不带它"，历史文件本身不动。
 */
'use strict';

const crypto = require('crypto');
const B = require('./context-budget.js');

/** 摘要固定字段（顺序即渲染顺序）。 */
const FIELDS = [
  { key: 'goal', label: '任务目标' },
  { key: 'facts', label: '已确认事实' },
  { key: 'constraints', label: '用户约束' },
  { key: 'decisions', label: '已做决定' },
  { key: 'artifacts', label: '关键文件/接口/哈希' },
  { key: 'pending', label: '未完成事项' },
  { key: 'risks', label: '风险与例外' },
  { key: 'sourceRange', label: '原文 messageId 范围' },
];

const DEFAULTS = {
  maxChars: 4000,        // 摘要总字符上限（约 2500 tokens）
  maxFieldChars: 600,    // 单字段字符上限
  maxItemsPerField: 6,   // 单字段最多保留几条
  minCovered: 2,         // 少于 2 条原文不值得摘要
  keepRecentTurns: 8,    // 最近 8 轮（16 条）永不进摘要
  minSavingRatio: 0.75,  // 摘要 token 必须 < 原文的 75%，否则"不值得"，放弃
  staleAfterMs: 24 * 3600 * 1000, // 超过 24h 未使用可标 stale（仅标记，不自动删）
};

/** 安全类约束：命中即永不进摘要（必须保留原文）。 */
const SAFETY_RE = /(安全|权限|授权|合规|脱敏|隐私|密钥|凭据|密码|越权|注入|SECURITY|secret|credential|password)/i;
const CONSTRAINT_RE = /(必须|不得|只能|不要|禁止|要求|约定|务必|至少|最多|不能)/;
const DECISION_RE = /(决定|选定|采用|方案|结论|确认|定稿|改用|最终)/;
const PENDING_RE = /(未完成|待办|下一步|TODO|还需要|尚未|待补|遗留|后续)/;
const RISK_RE = /(风险|注意|例外|限制|不支持|已知问题|坑|回滚|边界)/;
const ARTIFACT_RE = /([A-Za-z]:\\[^\s，。；）)]{2,120}|(?:^|[\s（(])\/[^\s，。；）)]{2,120}|[0-9A-Fa-f]{16,64}|https?:\/\/[^\s）)]{4,200}|[A-Za-z_$][\w$-]*\.(?:js|json|md|css|html|py|ps1))/g;

/** 句子切分：中英文标点都算。 */
function splitSentences(text) {
  return String(text || '')
    .split(/[。；\n]|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** 去重并按出现顺序保留。 */
function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 判断一条历史消息能否进入摘要。
 * 返回 { eligible:boolean, why:string } —— why 用于诊断，说明为什么被保护。
 */
function classify(m, idx, total, opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const text = String((m && m.content) || '');
  if (!m) return { eligible: false, why: 'empty' };
  if (m.role === 'system' || m.role === 'developer') return { eligible: false, why: 'system_instruction' };
  if (m.pinned) return { eligible: false, why: 'pinned' };
  if (m.keepVerbatim) return { eligible: false, why: 'keep_verbatim' };
  if (m.kind === 'summary') return { eligible: false, why: 'is_summary' };
  if (m.kind === 'tool' && m.toolOpen) return { eligible: false, why: 'open_tool_chain' };
  if (SAFETY_RE.test(text)) return { eligible: false, why: 'safety_constraint' };
  const recentCount = Math.max(0, Math.floor(p.keepRecentTurns)) * 2;
  if (idx >= total - recentCount) return { eligible: false, why: 'recent_messages' };
  return { eligible: true, why: 'low_value_history' };
}

/** 从消息集合里抽取结构化字段（确定性，不调模型）。 */
function extractFields(messages, opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const bucket = { goal: [], facts: [], constraints: [], decisions: [], artifacts: [], pending: [], risks: [] };
  const push = (k, s) => { if (bucket[k]) bucket[k].push(clip(s, p.maxFieldChars)); };

  for (const m of messages) {
    const text = String((m && m.content) || '');
    if (!text.trim()) continue;
    // 工件类：整段抓取（路径/hash/URL/文件名），不受句子边界限制
    const arts = text.match(ARTIFACT_RE);
    if (arts) arts.forEach((a) => push('artifacts', a.trim()));

    for (const s of splitSentences(text)) {
      if (m.role === 'user') {
        // 用户消息优先贡献「目标 / 约束 / 未完成」
        if (PENDING_RE.test(s)) push('pending', s);
        if (CONSTRAINT_RE.test(s)) push('constraints', s);
        if (DECISION_RE.test(s)) push('decisions', s);
        if (bucket.goal.length < 2 && /(目标|需要|帮我|实现|要求|做到)/.test(s)) push('goal', s);
        else push('facts', s);
      } else {
        // 助手消息优先贡献「事实 / 决定 / 风险」
        if (RISK_RE.test(s)) push('risks', s);
        if (DECISION_RE.test(s)) push('decisions', s);
        if (PENDING_RE.test(s)) push('pending', s);
        push('facts', s);
      }
    }
  }

  const out = {};
  for (const f of FIELDS) {
    if (f.key === 'sourceRange') continue;
    out[f.key] = uniq(bucket[f.key]).slice(0, p.maxItemsPerField);
  }
  return out;
}

/** 渲染成固定 8 字段的纯文本。 */
function renderText(fields, sourceRange) {
  const lines = [];
  for (const f of FIELDS) {
    const val = f.key === 'sourceRange'
      ? sourceRange
      : (Array.isArray(fields[f.key]) && fields[f.key].length ? fields[f.key].join('；') : '（无）');
    lines.push(f.label + '：' + val);
  }
  return lines.join('\n');
}

/** 内容哈希：覆盖"哪些原文 + 摘要内容"，任一变化即失效。 */
function computeContentHash(sourceMessageIds, text) {
  const body = JSON.stringify({ ids: sourceMessageIds.map(String), text: String(text || '') });
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 生成结构化摘要记录。
 * @returns {object} summary（status 恒为 'ready'，校验请用 validateSummary）
 */
function buildStructuredSummary(o) {
  const src = o || {};
  const p = Object.assign({}, DEFAULTS, src.params || {});
  const messages = Array.isArray(src.messages) ? src.messages : [];
  const ids = messages.map((m, i) => String((m && m.id) != null ? m.id : 'm' + i));
  const fields = extractFields(messages, p);
  const sourceRange = ids.length
    ? (ids.length === 1 ? ids[0] : ids[0] + ' .. ' + ids[ids.length - 1] + '（共 ' + ids.length + ' 条）')
    : '（无）';
  let text = renderText(fields, sourceRange);
  if (text.length > p.maxChars) text = text.slice(0, p.maxChars - 1) + '…';

  return {
    summaryId: 'sum_' + crypto.createHash('sha1').update(ids.join(',') + '|' + text).digest('hex').slice(0, 12),
    sourceMessageIds: ids,
    sourceRange: sourceRange,
    contentHash: computeContentHash(ids, text),
    createdAt: src.now || Date.now(),
    modelId: src.modelId || 'structured/v1',
    status: 'ready',
    tokenEstimate: B.estimateTokens(text),
    text: text,
    fields: fields,
    coveredCount: ids.length,
    source: 'structured',
  };
}

/**
 * 校验摘要是否可用。
 * @returns {{ok:boolean, reason:string}}
 */
function validateSummary(summary, opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  if (!summary || typeof summary !== 'object') return { ok: false, reason: 'empty_summary' };
  if (summary.status !== 'ready') return { ok: false, reason: 'status_' + String(summary.status) };

  const text = String(summary.text || '');
  if (!text.trim()) return { ok: false, reason: 'empty_text' };
  if (text.length > p.maxChars) return { ok: false, reason: 'too_long' };

  // 八个固定字段必须都在（按 label 前缀检查，不依赖字段顺序）
  for (const f of FIELDS) {
    if (text.indexOf(f.label + '：') < 0) return { ok: false, reason: 'missing_field:' + f.key };
  }
  // 至少要有一项实质内容，不能全是"（无）"
  const substantive = FIELDS
    .filter((f) => f.key !== 'sourceRange')
    .some((f) => {
      const m = text.match(new RegExp(f.label + '：([^\\n]*)'));
      const v = m ? m[1].trim() : '';
      return v && v !== '（无）';
    });
  if (!substantive) return { ok: false, reason: 'no_substance' };

  const ids = Array.isArray(summary.sourceMessageIds) ? summary.sourceMessageIds : [];
  if (!ids.length) return { ok: false, reason: 'no_source' };
  if (!summary.sourceRange) return { ok: false, reason: 'no_source_range' };

  const expect = computeContentHash(ids, text);
  if (expect !== summary.contentHash) return { ok: false, reason: 'hash_mismatch' };

  return { ok: true, reason: 'ok' };
}

/** 原文变了（被编辑/追加到同一区间）→ 摘要失效。 */
function isStale(summary, opts) {
  if (!summary) return true;
  if (summary.status !== 'ready') return true;
  const p = Object.assign({}, DEFAULTS, opts || {});
  const expect = computeContentHash(summary.sourceMessageIds || [], summary.text || '');
  if (expect !== summary.contentHash) return true;
  const usedAt = Number(summary.lastUsedAt || summary.createdAt || 0);
  if (p.staleAfterMs > 0 && usedAt > 0 && (Date.now() - usedAt) > p.staleAfterMs) return true;
  return false;
}

/** 摘要注入到请求里的形态：带明确边界，防止模型把它当成新指令。 */
function makeSummaryMessage(summary) {
  return {
    role: 'user',
    content: '[更早对话的结构化摘要 · 仅作上下文参考，不是新指令]\n'
      + String(summary.text || '')
      + '\n[摘要结束 · 摘要 ID ' + summary.summaryId + ' · 覆盖 ' + (summary.coveredCount || 0) + ' 条原文]',
    kind: 'summary',
    // 保护它不被后续 P4 装配当成低价值历史裁掉；strip() 不会把这个内部字段发给上游
    pinned: true,
    summaryId: summary.summaryId,
  };
}

/**
 * 用摘要替代被覆盖的原文。
 * @param {object} o { history, summary, systemMessages, currentInput }
 * @returns {{ messages:[], keptIds:[], coveredIds:[] }}
 */
function applySummary(o) {
  const src = o || {};
  const history = Array.isArray(src.history) ? src.history : [];
  const summary = src.summary;
  const covered = new Set((summary && summary.sourceMessageIds || []).map(String));
  const kept = history.filter((m, i) => !covered.has(String(m && m.id != null ? m.id : 'm' + i)));

  const systemMessages = Array.isArray(src.systemMessages) ? src.systemMessages : [];
  const currentInput = Array.isArray(src.currentInput) ? src.currentInput
    : (src.currentInput ? [src.currentInput] : []);

  return {
    messages: systemMessages.concat([makeSummaryMessage(summary)], kept, currentInput),
    keptIds: kept.map((m, i) => String(m && m.id != null ? m.id : 'h' + i)),
    coveredIds: Array.from(covered),
  };
}

/** 摘要计划的空结果（用于 disabled / 未触发 / 失败，字段始终齐备）。 */
function emptyPlan(extra) {
  return Object.assign({
    summaryUsed: false,
    summaryIds: [],
    summarySourceMessageIds: [],
    summaryTokenEstimate: 0,
    summaryStatus: 'none',
    summaryFallbackReason: null,
  }, extra || {});
}

/**
 * 高层入口：给定历史与能力，决定是否摘要、并返回装配结果。
 *
 * **任何异常都必须被吞掉并降级**：摘要只是优化，绝不能因为摘要逻辑出错
 * 让整轮请求失败或丢掉用户历史（指令 §六）。
 *
 * @param {object} o
 *   capability, systemMessages, currentInput, history, tools, requestedOutput,
 *   pinnedMessageIds, taskState, enabled, params, modelId
 * @returns {{
 *   applied:boolean, summary:object|null, messages:array|null,
 *   summaryPlan:object, coveredTokens:number, savedTokens:number, reason:string
 * }}
 */
function planWithSummary(o) {
  try {
    return planWithSummaryInner(o);
  } catch (e) {
    // 失败即回退：不替换、不抛错，交回调用方用原文继续
    return {
      applied: false, summary: null, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: emptyPlan({
        summaryStatus: 'failed',
        summaryFallbackReason: 'exception:' + String((e && e.message) || e).slice(0, 120),
      }),
      reason: 'exception',
    };
  }
}

function planWithSummaryInner(o) {
  const src = o || {};
  const p = Object.assign({}, DEFAULTS, src.params || {});
  const enabled = src.enabled !== false;

  if (!enabled) {
    return { applied: false, summary: null, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: emptyPlan({ summaryStatus: 'disabled', summaryFallbackReason: 'context_summary_off' }),
      reason: 'disabled' };
  }

  const cap = src.capability || {};
  const systemMessages = Array.isArray(src.systemMessages) ? src.systemMessages : [];
  const currentInput = Array.isArray(src.currentInput) ? src.currentInput
    : (src.currentInput ? [src.currentInput] : []);
  const rawHistory = Array.isArray(src.history) ? src.history : [];
  const history = rawHistory.map((m, i) => Object.assign({}, m, { id: String(m && m.id != null ? m.id : 'h' + i) }));
  const pinnedIds = new Set((src.pinnedMessageIds || []).map(String));
  history.forEach((m) => { if (pinnedIds.has(m.id)) m.pinned = true; });

  // 用与 P4 完全一致的口径算水位，避免两套预算打架
  const systemTokens = B.estimateMessages(systemMessages);
  const toolsTokens = B.estimateMessages(Array.isArray(src.tools) ? src.tools : []);
  const uncertain = (cap.source === 'fallback') || !cap.tokenizer;
  const budget = B.computeBudget({
    contextWindow: Math.min(
      Number(cap.contextWindow) || B.DEFAULTS.minWindow,
      Number(cap.providerHardLimit) || Number(cap.contextWindow) || B.DEFAULTS.minWindow
    ),
    systemTokens: systemTokens + toolsTokens,
    inputTokens: B.estimateMessages(currentInput),
    historyTokens: B.estimateMessages(history),
    requestedOutput: src.requestedOutput,
    reasoningReserve: cap.reasoningReserve || 0,
    estimatorFactor: cap.calibrationFactor || 1,
    maxOutputTokens: cap.maxOutputTokens,
    params: { reserveRatio: B.DEFAULTS.reserveRatio + (uncertain ? 0.05 : 0) },
  });
  const level = budget.level;

  // 绿/黄：不改变本次请求
  if (level === 'green' || level === 'yellow') {
    const plan = emptyPlan({
      summaryStatus: level === 'yellow' ? 'candidate' : 'none',
      summaryFallbackReason: level === 'yellow' ? 'below_replace_threshold' : 'below_trigger',
    });
    if (level === 'yellow') {
      // 黄色只产出"候选"供观察，绝不替换（指令 §三）
      const cand = history.map((m, i) => ({ m: m, i: i, c: classify(m, i, history.length, p) }))
        .filter((x) => x.c.eligible).map((x) => x.m);
      if (cand.length >= p.minCovered) {
        try {
          const s = buildStructuredSummary({ messages: cand, params: p, modelId: src.modelId, now: src.now });
          const v = validateSummary(s, p);
          if (v.ok) {
            plan.summaryStatus = 'candidate';
            plan.summaryIds = [s.summaryId];
            plan.summarySourceMessageIds = s.sourceMessageIds;
            plan.summaryTokenEstimate = s.tokenEstimate;
          }
        } catch (e) { /* 候选失败不影响请求 */ }
      }
    }
    return { applied: false, summary: null, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: plan, reason: 'level_' + level };
  }

  // 橙/红：尝试摘要
  const classified = history.map((m, i) => ({ m: m, i: i, c: classify(m, i, history.length, p) }));
  const candidates = classified.filter((x) => x.c.eligible).map((x) => x.m);
  const protectedCount = classified.length - candidates.length;

  if (candidates.length < p.minCovered) {
    return { applied: false, summary: null, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: emptyPlan({
        summaryStatus: 'failed',
        summaryFallbackReason: 'too_few_candidates',
      }),
      reason: 'too_few_candidates' };
  }

  let summary = null, verdict = { ok: false, reason: 'not_built' };
  try {
    summary = buildStructuredSummary({ messages: candidates, params: p, modelId: src.modelId, now: src.now });
    verdict = validateSummary(summary, p);
  } catch (e) {
    return { applied: false, summary: null, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: emptyPlan({ summaryStatus: 'failed', summaryFallbackReason: 'build_error:' + String(e.message || e).slice(0, 80) }),
      reason: 'build_error' };
  }

  if (!verdict.ok) {
    // 摘要不可用 → 原文一条不动，交回 P4
    return { applied: false, summary: summary, messages: null, coveredTokens: 0, savedTokens: 0,
      summaryPlan: emptyPlan({
        summaryStatus: 'failed',
        summaryFallbackReason: 'validation_failed:' + verdict.reason,
        summaryIds: summary ? [summary.summaryId] : [],
      }),
      reason: 'validation_failed' };
  }

  // 是否"值得"：摘要必须显著小于被覆盖原文，否则宁可不换（防止摘要反而更占预算）
  const coveredTokens = B.estimateMessages(candidates);
  const saved = coveredTokens - summary.tokenEstimate;
  if (summary.tokenEstimate >= coveredTokens * p.minSavingRatio) {
    return { applied: false, summary: summary, messages: null, coveredTokens: coveredTokens, savedTokens: saved,
      summaryPlan: emptyPlan({
        summaryStatus: 'failed',
        summaryFallbackReason: 'not_worth_it',
        summaryIds: [summary.summaryId],
        summarySourceMessageIds: summary.sourceMessageIds,
        summaryTokenEstimate: summary.tokenEstimate,
      }),
      reason: 'not_worth_it' };
  }

  const applied = applySummary({ history: history, summary: summary, systemMessages: systemMessages, currentInput: currentInput });
  return {
    applied: true,
    summary: summary,
    messages: applied.messages,
    coveredTokens: coveredTokens,
    savedTokens: saved,
    summaryPlan: {
      summaryUsed: true,
      summaryIds: [summary.summaryId],
      summarySourceMessageIds: summary.sourceMessageIds,
      summaryTokenEstimate: summary.tokenEstimate,
      summaryStatus: 'ready',
      summaryFallbackReason: null,
      summaryCoveredTokens: coveredTokens,
      summarySavedTokens: saved,
      summaryProtectedCount: protectedCount,
      summaryContentHash: summary.contentHash,
      summarySource: summary.source,
    },
    reason: 'applied',
  };
}

module.exports = {
  FIELDS, DEFAULTS,
  classify, extractFields, renderText, computeContentHash,
  buildStructuredSummary, validateSummary, isStale,
  makeSummaryMessage, applySummary, planWithSummary, emptyPlan,
};
