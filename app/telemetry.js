/**
 * 统一遥测归一化（P1）
 *
 * 设计约束（对应《真实指标与联网工具及并行侧栏-DS执行规划》§4）：
 *   · 字段缺失必须是 null + availability='missing'，**不能 ||0**；真实 0 必须是 0。
 *   · 每个数值带 source（provider / engine）与 scope（request / turn），便于对账。
 *   · 速度用「真实生成窗口」：第一个真实生成事件 → 最后一个真实生成事件，排除排队/退避/工具耗时。
 *   · 无法可靠测量时返回 measurable:false，由 UI 显示「不可测 / 等待用量回报」，不编数字。
 *   · 缓存命中率只在 cacheRead 与 input 都真实上报且 input>0 时计算；矛盾值标 invalid。
 */

'use strict';

const AVAIL = {
  PENDING: 'pending',
  REPORTED: 'reported',
  MISSING: 'missing',
  INVALID: 'invalid',
};

function isInt(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
}

function pickInt(v) {
  if (v === undefined || v === null) return { value: null, state: AVAIL.MISSING };
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) {
    const n = Number(v);
    return isInt(n) && n >= 0 ? { value: n, state: AVAIL.REPORTED } : { value: null, state: AVAIL.INVALID };
  }
  if (!isInt(v)) return { value: null, state: AVAIL.INVALID };
  if (v < 0) return { value: null, state: AVAIL.INVALID };
  return { value: v, state: AVAIL.REPORTED };
}

function deepGet(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 把三种协议的 usage 归一成同一形状。
 * @param {object} raw 上游原始 usage（已脱敏前）
 * @param {'chat'|'responses'|'codex'} protocol
 * @param {{source?:string, scope?:string}} [opts]
 */
function normalizeUsage(raw, protocol, opts) {
  const o = opts || {};
  const source = o.source || (protocol === 'codex' ? 'engine' : 'provider');
  const scope = o.scope || 'request';
  const out = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    availability: {
      input: AVAIL.MISSING,
      output: AVAIL.MISSING,
      cache: AVAIL.MISSING,
      cacheWrite: AVAIL.MISSING,
      reasoning: AVAIL.MISSING,
    },
    source: source,
    scope: scope,
    protocol: protocol,
    reported: false,
  };
  if (!raw || typeof raw !== 'object') return out;

  const set = (key, availKey, p) => {
    const r = pickInt(deepGet(raw, p));
    out[key] = r.value;
    out.availability[availKey] = r.state;
  };

  if (protocol === 'responses') {
    set('inputTokens', 'input', ['input_tokens']);
    set('outputTokens', 'output', ['output_tokens']);
    set('cacheReadTokens', 'cache', ['input_tokens_details', 'cached_tokens']);
    set('reasoningTokens', 'reasoning', ['output_tokens_details', 'reasoning_tokens']);
  } else if (protocol === 'codex') {
    set('inputTokens', 'input', ['input_tokens']);
    set('outputTokens', 'output', ['output_tokens']);
    set('cacheReadTokens', 'cache', ['cached_input_tokens']);
    set('reasoningTokens', 'reasoning', ['reasoning_output_tokens']);
  } else {
    set('inputTokens', 'input', ['prompt_tokens']);
    set('outputTokens', 'output', ['completion_tokens']);
    set('cacheReadTokens', 'cache', ['prompt_tokens_details', 'cached_tokens']);
    set('reasoningTokens', 'reasoning', ['completion_tokens_details', 'reasoning_tokens']);
    // DeepSeek 兼容端点的缓存口径（仅在上面的通用字段缺失时采用）
    if (out.availability.cache !== AVAIL.REPORTED) {
      const hit = pickInt(deepGet(raw, ['prompt_cache_hit_tokens']));
      if (hit.state === AVAIL.REPORTED) {
        out.cacheReadTokens = hit.value;
        out.availability.cache = AVAIL.REPORTED;
        out.cacheSource = 'prompt_cache_hit_tokens';
      }
    }
    if (out.availability.cacheWrite !== AVAIL.REPORTED) {
      const miss = pickInt(deepGet(raw, ['prompt_cache_miss_tokens']));
      if (miss.state === AVAIL.REPORTED) {
        out.cacheWriteTokens = miss.value;
        out.availability.cacheWrite = AVAIL.REPORTED;
      }
    }
  }

  // 只保留可对账的最小原始副本（不含任何凭据；usage 本身不含密钥）
  try {
    out.raw = JSON.parse(JSON.stringify(raw));
  } catch (e) {
    out.raw = null;
  }
  out.reported = out.availability.input === AVAIL.REPORTED
    || out.availability.output === AVAIL.REPORTED;
  return out;
}

/** 合并同一 turn 内多个 request 的 usage（只求和真实上报的字段；缺失不当作 0 参与）。 */
function mergeUsage(list) {
  const arr = (list || []).filter(Boolean);
  const acc = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    availability: {
      input: AVAIL.MISSING, output: AVAIL.MISSING, cache: AVAIL.MISSING,
      cacheWrite: AVAIL.MISSING, reasoning: AVAIL.MISSING,
    },
    // 覆盖率：用于判断「缓存命中率」是不是只基于部分请求，不能把已知部分当完整命中率。
    coverage: { requests: arr.length, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 },
    source: arr.length ? arr[0].source : null,
    scope: 'turn',
    reported: false,
    // partial 只表示「总量口径缺 input 或 output」，与会话累计口径一致；
    // 缓存写入/推理等可选分项缺失只记进 missingFields，不把整轮标成不完整。
    partial: false,
    missingFields: [],
  };
  for (const u of arr) {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      const ak = k === 'cacheReadTokens' ? 'cache'
        : k === 'cacheWriteTokens' ? 'cacheWrite'
          : k.replace('Tokens', '');
      if (u.availability[ak] === AVAIL.REPORTED) {
        acc[k] = (acc[k] || 0) + u[k];
        acc.availability[ak] = AVAIL.REPORTED;
        acc.coverage[ak] += 1;
      } else if (u.availability[ak] === AVAIL.MISSING) {
        if (acc.missingFields.indexOf(ak) < 0) acc.missingFields.push(ak);
        if (ak === 'input' || ak === 'output') acc.partial = true;
      }
    }
  }
  acc.reported = acc.availability.output === AVAIL.REPORTED;
  return acc;
}

/**
 * 生成窗口速度。
 * @param {{outputTokens:number|null, firstGenAt:number|null, lastGenAt:number|null, events:number}} p
 */
function computeSpeed(p) {
  const outputTokens = isInt(p.outputTokens) ? p.outputTokens : null;
  const first = Number(p.firstGenAt);
  const last = Number(p.lastGenAt);
  const events = Number(p.events) || 0;
  const windowMs = (isFinite(first) && isFinite(last) && last > first) ? (last - first) : 0;
  if (outputTokens === null) {
    return { tokensPerSec: null, windowMs: windowMs, measurable: false, reason: 'usage_missing' };
  }
  if (events < 2 || windowMs <= 0) {
    return { tokensPerSec: null, windowMs: windowMs, measurable: false, reason: 'window_too_short' };
  }
  const tps = outputTokens / (windowMs / 1000);
  if (!isFinite(tps) || tps <= 0) {
    return { tokensPerSec: null, windowMs: windowMs, measurable: false, reason: 'invalid_value' };
  }
  return { tokensPerSec: Math.round(tps * 10) / 10, windowMs: windowMs, measurable: true, reason: '' };
}

/**
 * 缓存命中率。只有 cacheRead 与 input 都真实上报、input>0 才计算。
 * @returns {{rate:number|null, state:string, note:string}}
 */
function cacheRate(u) {
  if (!u) return { rate: null, state: AVAIL.MISSING, note: '缓存未上报' };
  const inputOk = u.availability && u.availability.input === AVAIL.REPORTED;
  const cacheOk = u.availability && u.availability.cache === AVAIL.REPORTED;
  if (!cacheOk) return { rate: null, state: AVAIL.MISSING, note: '缓存未上报' };
  if (!inputOk) return { rate: null, state: AVAIL.MISSING, note: '输入 token 未上报，无法计算命中率' };
  const input = u.inputTokens;
  const cache = u.cacheReadTokens;
  if (input === 0) return { rate: null, state: 'na', note: '输入为 0，不适用' };
  if (cache === null || cache < 0) return { rate: null, state: AVAIL.INVALID, note: '缓存字段无效' };
  if (cache > input) return { rate: null, state: AVAIL.INVALID, note: '缓存大于输入，字段矛盾' };
  const rate = Math.round((cache / input) * 1000) / 10;
  // 多请求合并时，只有部分请求上报了缓存字段：命中率只能代表已知部分，
  // 必须标 partial，不能当成完整命中率展示。
  const cov = u.coverage;
  if (cov && cov.requests > 0 && cov.cache < cov.requests) {
    return {
      rate, state: 'partial',
      note: '部分请求缓存未上报（' + cov.cache + '/' + cov.requests + '），命中率为已知部分',
    };
  }
  return { rate, state: AVAIL.REPORTED, note: '' };
}

module.exports = {
  AVAIL: AVAIL,
  normalizeUsage: normalizeUsage,
  mergeUsage: mergeUsage,
  computeSpeed: computeSpeed,
  cacheRate: cacheRate,
};
