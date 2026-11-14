/**
 * 上下文预算计算（第六轮 P1：只算不裁）
 *
 * 目标：在模型可承受的窗口内，算出「这次请求到底能用多少历史、留多少输出、离上限还有多远」，
 * 并把结果作为**诊断**输出。本模块**不裁剪任何消息**——真正装配/压缩在后续阶段单独做，
 * 避免一次性替换现有上下文装配逻辑。
 *
 * 为什么需要它：目前 normalizeMessages() 只合并连续同角色消息、完全不裁剪，
 * effectiveContextLimit() 也只用于界面显示，没有任何执行点。
 *
 * 约定：
 *   W 模型上下文窗口 / P 系统与工具 / I 本轮输入 / H 历史 / O 预留输出 / R 安全余量 / C 历史预算
 *   C = max(0, W - P - I - O - R)
 * 不变量（单测覆盖）：P + I + O + R + C <= W，且 C >= 0、O >= 1。
 */
'use strict';

const DEFAULTS = {
  reserveRatio: 0.05,     // 安全余量占比
  minReserve: 2048,       // 安全余量下限（tokens）
  outputRatio: 0.25,      // 输出预算占比上限
  minOutput: 4096,        // 输出预算下限（tokens）
  summaryTrigger: 0.70,   // 黄色水位：历史占用超过该比例就应预摘要
  minWindow: 4096,        // 窗口下限，防止配置异常把预算算成 0
};

/**
 * 无 tokenizer 时的保守估算。
 * CJK 约 1.6 字符/token，其余约 4 字符/token；取偏大值以免低估导致超限。
 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0, other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.6 + other / 4);
}

/** 估算一组消息的 tokens（含每条 4 tokens 的协议开销）。 */
function estimateMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === 'string') n += estimateTokens(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part.text === 'string') n += estimateTokens(part.text);
        else if (part && part.type === 'image_url') n += 800;   // 图片按保守值占位
      }
    }
    n += 4;
  }
  return n;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/** 比例参数必须落在 (0,1) 内；非法值一律回退默认，避免 NaN 污染预算。 */
function pickRatio(v, fallback) {
  const n = Number(v);
  return (isFinite(n) && n > 0 && n < 1) ? n : fallback;
}
/** 正整数参数；非法值回退默认。 */
function pickInt(v, fallback) {
  const n = Number(v);
  return (isFinite(n) && n > 0) ? Math.floor(n) : fallback;
}

/**
 * 计算本次请求的预算。
 * @param {object} o
 *   contextWindow  模型窗口（tokens）
 *   systemTokens   系统提示 + 工具定义
 *   inputTokens    本轮输入（含侧聊快照这类合成输入）
 *   historyTokens  历史消息
 *   requestedOutput 期望输出（可空）
 *   params         覆盖 DEFAULTS 的比例参数
 */
function computeBudget(o) {
  const src = o || {};
  const raw = src.params || {};
  const p = {
    reserveRatio: pickRatio(raw.reserveRatio, DEFAULTS.reserveRatio),
    minReserve: pickInt(raw.minReserve, DEFAULTS.minReserve),
    outputRatio: pickRatio(raw.outputRatio, DEFAULTS.outputRatio),
    minOutput: pickInt(raw.minOutput, DEFAULTS.minOutput),
    summaryTrigger: pickRatio(raw.summaryTrigger, DEFAULTS.summaryTrigger),
    minWindow: DEFAULTS.minWindow,
  };
  const W = Math.max(DEFAULTS.minWindow, Math.floor(Number(src.contextWindow) || 0));
  const P = Math.max(0, Math.floor(Number(src.systemTokens) || 0));
  // 估算系数来自 usage 校准（P3）：只缩放"估算出来的历史/输入"，不缩放窗口本身
  const factorRaw = Number(src.estimatorFactor);
  const factor = (isFinite(factorRaw) && factorRaw > 0) ? factorRaw : 1;
  const rawI = Math.max(0, Math.floor(Number(src.inputTokens) || 0));
  const rawH = Math.max(0, Math.floor(Number(src.historyTokens) || 0));
  const I = Math.round(rawI * factor);
  const H = Math.round(rawH * factor);
  // reasoning 模型的隐藏推理要单独占位（P3）：它是输出侧开销，但会挤占历史预算
  const RR = Math.max(0, Math.floor(Number(src.reasoningReserve) || 0));

  const R = Math.max(Math.floor(p.minReserve), Math.ceil(W * p.reserveRatio));
  // 输出上限：不超过窗口 outputRatio、不挤占 P/I/R/RR，且不超过 provider 的最大输出
  const provOut = Number(src.maxOutputTokens);
  const oCap = (isFinite(provOut) && provOut > 0) ? Math.floor(provOut) : Infinity;
  const oHigh = Math.max(1, Math.min(Math.ceil(W * p.outputRatio), W - P - I - R - RR, oCap));
  const requested = Number(src.requestedOutput);
  const O = isFinite(requested) && requested > 0
    ? Math.min(Math.max(Math.floor(requested), 1), oHigh)
    : Math.min(Math.floor(p.minOutput), oHigh);
  const C = Math.max(0, W - P - I - O - R - RR);

  const waterline = C > 0 ? H / C : (H > 0 ? Infinity : 0);
  return {
    W: W, P: P, I: I, H: H, O: O, R: R, C: C,
    reasoningReserve: RR, estimatorFactor: factor, rawI: rawI, rawH: rawH,
    maxOutputTokens: isFinite(oCap) ? oCap : null,
    waterline: isFinite(waterline) ? Math.round(waterline * 1000) / 1000 : null,
    level: levelOf(waterline, p.summaryTrigger),
    fits: H <= C,
    // 诊断用：还剩多少历史预算
    headroom: Math.max(0, C - H),
    params: { reserveRatio: p.reserveRatio, outputRatio: p.outputRatio, minOutput: p.minOutput, summaryTrigger: p.summaryTrigger },
    estimator: 'char-class-v1',
  };
}

/** 水位分级：绿 ≤ trigger，黄 ≤0.85，橙 ≤0.95，红 >0.95 或放不下。 */
function levelOf(ratio, trigger) {
  const t = isFinite(trigger) ? trigger : DEFAULTS.summaryTrigger;
  if (!isFinite(ratio)) return 'red';
  if (ratio <= t) return 'green';
  if (ratio <= 0.85) return 'yellow';
  if (ratio <= 0.95) return 'orange';
  return 'red';
}

/**
 * 从消息数组直接算预算的便捷入口（P1 用：只观测，不改 messages）。
 * 约定：最后一条 user 消息算「本轮输入」，其余算历史。
 */
function planForMessages(o) {
  const src = o || {};
  const msgs = Array.isArray(src.messages) ? src.messages : [];
  let inputTokens = 0, historyTokens = 0;
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  for (let i = 0; i < msgs.length; i++) {
    const n = estimateMessages([msgs[i]]);
    if (i === lastUserIdx) inputTokens += n; else historyTokens += n;
  }
  return computeBudget({
    contextWindow: src.contextWindow,
    systemTokens: src.systemTokens || 0,
    inputTokens: inputTokens,
    historyTokens: historyTokens,
    requestedOutput: src.requestedOutput,
    params: src.params,
  });
}

module.exports = {
  DEFAULTS: DEFAULTS,
  estimateTokens: estimateTokens,
  estimateMessages: estimateMessages,
  computeBudget: computeBudget,
  levelOf: levelOf,
  planForMessages: planForMessages,
};
