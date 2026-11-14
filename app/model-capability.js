/**
 * 模型上下文能力发现与缓存（第六轮 P3）
 *
 * 职责：按 providerId + modelId 解析「这个模型到底有多大窗口、最大输出多少」，
 * 并按可信度记录来源。**不做任何历史裁剪**，只回答"预算能用多少"。
 *
 * 设计约束（对应 P3 指令）：
 *   · 来源优先级：provider 元数据 → 管理员显式配置 → 保守默认（过期远程元数据不参与）；
 *   · `/models` 不能盲信：必须校验模型 id 一致、字段为合法整数、数值在合理范围；
 *   · 缓存按 providerId+modelId 联合键隔离，带过期时间，别名变化即失效；
 *   · usage 校准只做渐进调整（连续 N 次偏差超阈值才动，单次限幅）；
 *   · 上游 context 超限错误只能触发重新探测/降低预算，**绝不扩大窗口**。
 *
 * 本模块不发起网络请求：`fetchModels` 由调用方注入，便于单测覆盖
 * 成功 / 模型不匹配 / 字段非法 / 不支持 / 超时 等分支。
 */
'use strict';

const CONF = {
  provider: 0.95,    // provider /models 元数据（已通过校验）
  explicit: 0.90,    // 管理员显式配置
  calibrated: 0.75,  // 经真实 usage 校准后的估算
  fallback: 0.30,    // 保守默认值
};

const LIMITS = {
  contextWindow: { min: 4096, max: 2000000 },
  maxOutputTokens: { min: 256, max: 200000 },
};

const DEFAULTS = {
  ttlMs: 6 * 60 * 60 * 1000,   // 远程元数据有效期
  calibrateMinSamples: 10,      // 至少连续观察这么多次才允许调整
  calibrateBias: 0.08,          // 偏差超过 8% 才调整
  calibrateMaxStep: 0.15,       // 单次调整幅度上限
  calibrateWindow: 20,          // 采样窗口
  factorMin: 0.5,
  factorMax: 2.0,
  fallbackWindow: 128000,
  fallbackOutput: 4096,
  fallbackReasoningReserve: 0,
};

function keyOf(providerId, modelId) {
  return String(providerId || 'unknown') + '|' + String(modelId || '');
}

/** 严格取正整数：字符串数字仅接受纯数字（拒绝 "128k" 这类被改写的值）。 */
function strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function inRange(v, spec) {
  return typeof v === 'number' && v >= spec.min && v <= spec.max;
}

/**
 * 校验 provider 的 /models 返回。
 * @returns {{ok:boolean, reason?:string, contextWindow?:number, maxOutputTokens?:number, matchedId?:string}}
 */
function validateModelsPayload(payload, wireModel) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload_not_object' };
  const list = Array.isArray(payload.data) ? payload.data
    : (Array.isArray(payload.models) ? payload.models : null);
  if (!list) return { ok: false, reason: 'no_model_list' };

  const want = String(wireModel || '');
  const hit = list.find((m) => m && String(m.id || m.name || '') === want);
  if (!hit) return { ok: false, reason: 'model_not_found' };

  // 字段可能平铺，也可能放在 meta/capabilities 里；两处都接受，但值必须合法
  const meta = (hit.meta && typeof hit.meta === 'object') ? hit.meta : {};
  const caps = (hit.capabilities && typeof hit.capabilities === 'object') ? hit.capabilities : {};
  const pick = (names) => {
    for (const n of names) {
      if (hit[n] !== undefined) return hit[n];
      if (meta[n] !== undefined) return meta[n];
      if (caps[n] !== undefined) return caps[n];
    }
    return undefined;
  };

  const rawWin = pick(['context_window', 'contextWindow', 'max_context_length', 'context_length']);
  const rawOut = pick(['max_output_tokens', 'maxOutputTokens', 'max_tokens']);

  const win = strictInt(rawWin);
  const out = strictInt(rawOut);

  if (win === null) return { ok: false, reason: 'invalid_context_window', matchedId: want };
  if (!inRange(win, LIMITS.contextWindow)) return { ok: false, reason: 'context_window_out_of_range', matchedId: want };
  if (out !== null && !inRange(out, LIMITS.maxOutputTokens)) {
    return { ok: false, reason: 'max_output_out_of_range', matchedId: want };
  }
  if (out !== null && out > win) return { ok: false, reason: 'output_exceeds_window', matchedId: want };

  return {
    ok: true, matchedId: want,
    contextWindow: win,
    maxOutputTokens: out === null ? null : out,
    tokenizer: (typeof pick(['tokenizer', 'encoding']) === 'string') ? pick(['tokenizer', 'encoding']) : null,
  };
}

function makeRecord(o) {
  const now = o.now;
  const ttl = typeof o.ttlMs === 'number' ? o.ttlMs : DEFAULTS.ttlMs;
  const rec = {
    providerId: o.providerId,
    modelId: o.modelId,
    contextWindow: o.contextWindow,
    maxOutputTokens: o.maxOutputTokens,
    tokenizer: o.tokenizer || null,
    source: o.source,
    confidence: typeof o.confidence === 'number' ? o.confidence : (CONF[o.source] || CONF.fallback),
    observedAt: now,
    expiresAt: o.source === 'provider' ? now + ttl : (o.source === 'explicit' ? now + ttl : 0),
    reasoningReserve: o.reasoningReserve || 0,
    calibrationFactor: typeof o.calibrationFactor === 'number' ? o.calibrationFactor : 1,
    providerHardLimit: o.contextWindow,
    version: 0,
    note: o.note || null,
  };
  rec.version = versionOf(rec);
  return rec;
}

/** 能力版本：窗口/输出/来源/校准因子变化即变版本，便于在 contextPlan 里追溯。 */
function versionOf(rec) {
  const s = [rec.contextWindow, rec.maxOutputTokens, rec.source, rec.calibrationFactor].join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}

function fresh(rec, now, ttlMs) {
  if (!rec) return false;
  if (rec.source === 'fallback') return true;       // 默认值永远可用，但不是"可信元数据"
  if (!rec.expiresAt) return false;
  return now < rec.expiresAt;
}

/**
 * 能力注册表。
 * @param {object} o
 *   fetchModels({base, apiKey}) → Promise<payload>（失败抛错，可带 .code）
 *   explicit({providerId, modelId}) → {contextWindow, maxOutputTokens, reasoningReserve} | null
 *   now() / ttlMs / log(fn)
 */
function createRegistry(o) {
  const opt = o || {};
  const now = opt.now || (() => Date.now());
  const ttlMs = typeof opt.ttlMs === 'number' ? opt.ttlMs : DEFAULTS.ttlMs;
  const explicitOf = typeof opt.explicit === 'function' ? opt.explicit : (() => null);
  const fetchModels = typeof opt.fetchModels === 'function' ? opt.fetchModels : null;
  const log = typeof opt.log === 'function' ? opt.log : (() => {});

  const cache = new Map();      // key → record
  const inflight = new Map();   // key → Promise
  const calibration = new Map();// key → {samples:[], factor, history:[]}
  const overflows = new Map();  // key → count

  function calibOf(k) {
    let c = calibration.get(k);
    if (!c) { c = { samples: [], factor: 1, history: [] }; calibration.set(k, c); }
    return c;
  }

  function fallbackRecord(providerId, modelId, catalogCtx, reason) {
    const win = (typeof catalogCtx === 'number' && catalogCtx >= LIMITS.contextWindow.min)
      ? catalogCtx : DEFAULTS.fallbackWindow;
    const rec = makeRecord({
      providerId, modelId, contextWindow: win,
      maxOutputTokens: Math.min(DEFAULTS.fallbackOutput, win),
      source: 'fallback', confidence: CONF.fallback,
      now: now(), ttlMs, calibrationFactor: calibOf(keyOf(providerId, modelId)).factor,
      note: reason || 'no_trusted_metadata',
    });
    return rec;
  }

  /** 同步取：显式配置 → 新鲜远程缓存 → 保守默认。绝不发网络请求。 */
  function get(q) {
    const providerId = q.providerId;
    const modelId = q.modelId;
    const k = keyOf(providerId, modelId);
    const ex = explicitOf({ providerId, modelId });
    if (ex && typeof ex.contextWindow === 'number' && ex.contextWindow >= LIMITS.contextWindow.min) {
      const rec = makeRecord({
        providerId, modelId, contextWindow: ex.contextWindow,
        maxOutputTokens: ex.maxOutputTokens || Math.min(DEFAULTS.fallbackOutput, ex.contextWindow),
        source: 'explicit', now: now(), ttlMs,
        reasoningReserve: ex.reasoningReserve || 0,
        calibrationFactor: calibOf(k).factor,
      });
      return rec;
    }
    const cached = cache.get(k);
    if (cached && fresh(cached, now(), ttlMs)) return cached;
    return fallbackRecord(providerId, modelId, q.catalogCtx, cached ? 'metadata_expired' : 'not_discovered');
  }

  /** 异步发现（去重）。返回 Promise<record>；失败时回退并记录原因。 */
  function ensure(q) {
    const providerId = q.providerId;
    const modelId = q.modelId;
    const k = keyOf(providerId, modelId);
    const cached = cache.get(k);
    if (cached && fresh(cached, now(), ttlMs) && !q.refresh) return Promise.resolve(cached);
    if (inflight.has(k)) return inflight.get(k);
    if (!fetchModels || !q.base) {
      const rec = fallbackRecord(providerId, modelId, q.catalogCtx, 'no_fetcher');
      cache.set(k, rec);
      return Promise.resolve(rec);
    }
    const p = Promise.resolve()
      .then(() => fetchModels({ base: q.base, apiKey: q.apiKey }))
      .then((payload) => {
        const v = validateModelsPayload(payload, q.wireModel || modelId);
        if (!v.ok) {
          // 校验失败：先用显式配置，再退保守默认；并把原因留在记录里
          const ex = explicitOf({ providerId, modelId });
          if (ex && typeof ex.contextWindow === 'number') {
            const rec = makeRecord({
              providerId, modelId, contextWindow: ex.contextWindow,
              maxOutputTokens: ex.maxOutputTokens || Math.min(DEFAULTS.fallbackOutput, ex.contextWindow),
              source: 'explicit', now: now(), ttlMs,
              reasoningReserve: ex.reasoningReserve || 0,
              calibrationFactor: calibOf(k).factor,
              note: (ex.note ? ex.note + ' | ' : '') + 'provider_invalid:' + v.reason,
            });
            cache.set(k, rec);
            log({ kind: 'capability_invalid', key: k, reason: v.reason, used: 'explicit' });
            return rec;
          }
          const rec = fallbackRecord(providerId, modelId, q.catalogCtx, 'provider_invalid:' + v.reason);
          cache.set(k, rec);
          log({ kind: 'capability_invalid', key: k, reason: v.reason, used: 'fallback' });
          return rec;
        }
        const rec = makeRecord({
          providerId, modelId, contextWindow: v.contextWindow,
          maxOutputTokens: v.maxOutputTokens || Math.min(DEFAULTS.fallbackOutput, v.contextWindow),
          tokenizer: v.tokenizer,
          source: 'provider', now: now(), ttlMs,
          calibrationFactor: calibOf(k).factor,
        });
        cache.set(k, rec);
        log({ kind: 'capability_discovered', key: k, contextWindow: rec.contextWindow,
          maxOutputTokens: rec.maxOutputTokens, confidence: rec.confidence });
        return rec;
      })
      .catch((e) => {
        const reason = (e && e.code) ? String(e.code) : 'fetch_failed';
        const ex = explicitOf({ providerId, modelId });
        if (ex && typeof ex.contextWindow === 'number') {
          const rec = makeRecord({
            providerId, modelId, contextWindow: ex.contextWindow,
            maxOutputTokens: ex.maxOutputTokens || Math.min(DEFAULTS.fallbackOutput, ex.contextWindow),
            source: 'explicit', now: now(), ttlMs,
            reasoningReserve: ex.reasoningReserve || 0,
            calibrationFactor: calibOf(k).factor,
            note: (ex.note ? ex.note + ' | ' : '') + 'provider_unavailable:' + reason,
          });
          cache.set(k, rec);
          log({ kind: 'capability_fetch_failed', key: k, reason: reason, used: 'explicit' });
          return rec;
        }
        const rec = fallbackRecord(providerId, modelId, q.catalogCtx, 'provider_unavailable:' + reason);
        cache.set(k, rec);
        log({ kind: 'capability_fetch_failed', key: k, reason: reason, used: 'fallback' });
        return rec;
      })
      .then((rec) => { inflight.delete(k); return rec; });
    inflight.set(k, p);
    return p;
  }

  /**
   * 用真实 usage 校准估算系数。
   * 只有连续 minSamples 次偏差都超阈值才调整，且单次限幅；返回调整记录。
   */
  function calibrate(q) {
    const k = keyOf(q.providerId, q.modelId);
    const c = calibOf(k);
    const est = Number(q.estimated);
    const act = Number(q.actual);
    if (!(est > 0) || !(act > 0)) return { changed: false, reason: 'invalid_sample' };
    c.samples.push(act / est);
    if (c.samples.length > DEFAULTS.calibrateWindow) c.samples.shift();
    if (c.samples.length < DEFAULTS.calibrateMinSamples) {
      return { changed: false, reason: 'need_more_samples', samples: c.samples.length };
    }
    const mean = c.samples.reduce((a, b) => a + b, 0) / c.samples.length;
    const bias = mean - 1;
    if (Math.abs(bias) <= DEFAULTS.calibrateBias) return { changed: false, reason: 'within_tolerance', bias: bias };
    // mean = 真实/估算：>1 表示我们低估了，系数要**上调**（不是取倒数）
    const target = Math.min(Math.max(mean, DEFAULTS.factorMin), DEFAULTS.factorMax);
    const step = Math.min(Math.max(target - c.factor, -DEFAULTS.calibrateMaxStep), DEFAULTS.calibrateMaxStep);
    const before = c.factor;
    c.factor = Math.round((c.factor + step) * 1000) / 1000;
    const rec = { at: now(), before: before, after: c.factor, samples: c.samples.length, bias: Math.round(bias * 1000) / 1000, reason: 'consecutive_bias' };
    c.history.push(rec);
    if (c.history.length > 50) c.history.shift();
    c.samples = [];
    log({ kind: 'capability_calibrated', key: k, before: rec.before, after: rec.after, samples: rec.samples, bias: rec.bias });
    return { changed: true, before: rec.before, after: rec.after, samples: rec.samples, bias: rec.bias };
  }

  /**
   * 上游报 context 超限：只允许「重新探测」或「降低硬上限」，绝不扩大。
   * 降低幅度固定 5%，并记录原因。
   */
  function noteOverflow(q) {
    const k = keyOf(q.providerId, q.modelId);
    const n = (overflows.get(k) || 0) + 1;
    overflows.set(k, n);
    const rec = cache.get(k);
    if (rec && rec.source !== 'fallback') {
      const before = rec.contextWindow;
      rec.providerHardLimit = Math.max(LIMITS.contextWindow.min, Math.floor(rec.providerHardLimit * 0.95));
      rec.contextWindow = Math.min(rec.contextWindow, rec.providerHardLimit);
      rec.version = versionOf(rec);
      rec.note = 'lowered_after_overflow#' + n;
      log({ kind: 'capability_overflow', key: k, count: n, before: before, after: rec.contextWindow });
      return { count: n, lowered: true, before: before, after: rec.contextWindow };
    }
    log({ kind: 'capability_overflow', key: k, count: n, lowered: false });
    return { count: n, lowered: false };
  }

  function inspect(q) {
    const k = keyOf(q.providerId, q.modelId);
    const rec = cache.get(k);
    const c = calibration.get(k);
    return {
      key: k,
      cached: rec || null,
      fresh: rec ? fresh(rec, now(), ttlMs) : false,
      calibration: c ? { factor: c.factor, samples: c.samples.length, history: c.history.slice(-5) } : null,
      overflows: overflows.get(k) || 0,
    };
  }

  function clear() { cache.clear(); inflight.clear(); calibration.clear(); overflows.clear(); }

  return { get, ensure, calibrate, noteOverflow, inspect, clear, _keyOf: keyOf };
}

module.exports = {
  CONF, LIMITS, DEFAULTS,
  keyOf, strictInt, validateModelsPayload, makeRecord, versionOf,
  createRegistry,
};
