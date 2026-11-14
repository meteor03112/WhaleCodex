// Modified for optional public helper configuration, 2026-11-14.
/**
 * desktop-bridge.js — agent-desktop D1 语义适配器（补强版）
 *
 * 职责：把 agent-desktop CLI 的原始返回归一为统一的动作结果模型，
 * 管理快照会话/隐私/清理，提供语义工具的调用入口。
 *
 * ═══ 补强要点（对应《D1 报告复核后补强与动态验收指令》§二）═══
 *
 * §1 快照治理自动闭环
 *   · 会话隔离走 helper 原生 `--session`，快照落在 sessions/<id>/snapshots/；
 *   · 核实真实目录：全局 ~/.agent-desktop/snapshots 与 sessions/<id>/snapshots；
 *   · 删除前做规范化绝对路径 + 允许根校验（防穿越/链接跳转）；
 *   · 启动回收 + 周期回收 + 会话结束回收；跨会话统计。
 *
 * §2 非阻塞执行、取消、急停
 *   · 全部 helper 调用改为**异步 spawn**（不再 spawnSync），不阻塞事件循环；
 *   · desktop_wait 用 setTimeout，不用 busy wait；
 *   · 支持 AbortSignal 取消；开关关闭时拒绝新动作。
 *
 * §3 执行前限制物理输入
 *   · **参数构造层**就不生成 --headed / --xy / mouse-* / drag / hover，
 *   · 工具白名单不含任何物理命令；
 *   · 运行时把 --headed 视为违规参数（防御性断言）；
 *   · 事后检测到 physical_synthetic 标 rejected + stopSubsequent，不是唯一防护。
 *
 * §4 二次验证与 snapshot-bound ref
 *   · 权威重试判据是 disposition.retry（"safe" 才可重试），不自行推断；
 *   · delivered_unverified 后只做观察验证，不重投；
 *   · 新快照后必须重新定位并换新 ref。
 *
 * §5 隐私与观察可用性分层
 *   · 日志/遥测/证据默认脱敏（不含标题/正文/输入值）；
 *   · 但**已授权的观察调用**返回定位所需的最小控件信息，否则工具不可用。
 *
 * §6 授权与窗口白名单
 *   · 动作前校验窗口白名单；未配置白名单则动作一律拒绝（fail closed）。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VERSION = 'desktop-bridge/d1-supplement';

// ── helper 固定信息（启动前校验） ──────────────────────────────────
const HELPER = {
  path: process.env.WHALE_DESKTOP_HELPER || path.join(process.resourcesPath || path.join(__dirname, '..', 'external-resources'), 'desktop', 'agent-desktop.exe'),
  version: '1.3.0',
  commit: 'a7765959eb44d27d0f9b0799066e377b6d1d2cd1',
  sha256: 'f7f161f1ddd0b072235d0531f8a3176a99288c7632c1be3aabef21f864457d94',
  protocolVersion: '2.6',
  assetSha256: '511d5625a4c5d9e592d161369211f2d53cb36573a5022722bb9831d784c26c68',
};

// ── 快照治理配置（真实目录，非自建） ─────────────────────────────
const SNAPSHOT_LIMITS = {
  maxSnapshotsPerSession: 20,
  maxTotalBytes: 50 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
  // helper 真实 state root（可用 AGENT_DESKTOP_HOME 覆盖）
  stateRoot: process.env.AGENT_DESKTOP_HOME || path.join(os.homedir(), '.agent-desktop'),
};

// ── 动作结果模型（7 状态） ────────────────────────────────────────
const Delivery = Object.freeze({
  DELIVERED_VERIFIED: 'delivered_verified',
  DELIVERED_UNVERIFIED: 'delivered_unverified',
  NOT_DELIVERED_SAFE_RETRY: 'not_delivered_safe_retry',
  REJECTED: 'rejected',
  STALE: 'stale',
  AMBIGUOUS: 'ambiguous',
  WINDOW_GONE: 'window_gone',
});

// ── 错误类别 ──────────────────────────────────────────────────────
const ErrorCategory = Object.freeze({
  HELPER_CRASH: 'helper_crash',
  HELPER_TIMEOUT: 'helper_timeout',
  PROTOCOL_ERROR: 'protocol_error',
  PHYSICAL_SYNTHETIC: 'physical_synthetic',
  POLICY_DENIED: 'policy_denied',
  STALE_REF: 'stale_ref',
  SNAPSHOT_NOT_FOUND: 'snapshot_not_found',
  WINDOW_NOT_FOUND: 'window_not_found',
  AMBIGUOUS_TARGET: 'ambiguous_target',
  INVALID_ARGS: 'invalid_args',
  UNAUTHORIZED_WINDOW: 'unauthorized_window',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

// ── 工具白名单（全部语义；无 mouse/drag/hover/press 等物理命令） ──
const TOOLS = Object.freeze([
  'desktop_status',
  'desktop_list_windows',
  'desktop_snapshot',
  'desktop_get',
  'desktop_is',
  'desktop_find',
  'desktop_wait',
  'desktop_click_ref',
  'desktop_set_value_ref',
]);

// 动作工具（产生投递语义，需要 disposition 解析）
const ACTION_TOOLS = new Set(['desktop_click_ref', 'desktop_set_value_ref']);

// 明确禁止的 CLI 子命令（物理输入 / 焦点 / 坐标），永不构造
const FORBIDDEN_CLI_COMMANDS = Object.freeze([
  'double-click', 'triple-click', 'mouse-move', 'mouse-click', 'mouse-down',
  'mouse-up', 'mouse-wheel', 'drag', 'hover', 'key-down', 'key-up',
  'focus-window', 'minimize', 'maximize', 'resize-window', 'move-window',
  'launch', 'close-app', 'type', 'press', 'scroll', 'scroll-to',
  'screenshot', 'open-system-surface', 'dismiss-notification',
  'dismiss-all-notifications', 'notification-action',
]);

// 明确禁止的 CLI 参数（物理投递 / 坐标 / 敏感导出）
const FORBIDDEN_CLI_FLAGS = Object.freeze([
  '--headed', '--xy', '--x', '--y', '--screenshot', '--debug', '--cdp',
]);

// ═════════════════════════════════════════════════════════════════
// 1. 执行前物理输入防护（参数构造层）
// ═════════════════════════════════════════════════════════════════

/**
 * 断言参数数组不含任何物理输入开关或禁止子命令。
 * 这是**执行前**防护：在 spawn 之前就拒绝，而不是执行后检测。
 * @param {string[]} args
 * @returns {{ok:boolean, violation?:string}}
 */
function assertSafeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, violation: 'empty_args' };
  }
  const cmd = args[0];
  if (FORBIDDEN_CLI_COMMANDS.includes(cmd)) {
    return { ok: false, violation: `forbidden_command:${cmd}` };
  }
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const flag = a.split('=')[0];
    if (FORBIDDEN_CLI_FLAGS.includes(flag)) {
      return { ok: false, violation: `forbidden_flag:${flag}` };
    }
  }
  return { ok: true };
}

// ═════════════════════════════════════════════════════════════════
// 2. Helper 异步调用（非阻塞 + 超时 + 可取消）
// ═════════════════════════════════════════════════════════════════

/**
 * 异步调用 helper（不阻塞事件循环）。
 * @param {string[]} args
 * @param {{timeoutMs?:number, signal?:AbortSignal, sessionId?:string}} opts
 * @returns {Promise<object>} 归一化 envelope
 */
function runHelper(args, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 30000;

  // 执行前防护
  const safe = assertSafeArgs(args);
  if (!safe.ok) {
    return Promise.resolve({
      ok: false,
      errorCategory: ErrorCategory.POLICY_DENIED,
      error: { code: 'POLICY_DENIED', message: safe.violation, disposition: { delivery: 'not_delivered', retry: 'unsafe' } },
    });
  }

  const argv = args.slice();
  // 会话作用域：helper 原生 --session
  if (opts.sessionId) {
    argv.push('--session', String(opts.sessionId));
  }

  return new Promise((resolve) => {
    let settled = false;
    let child;
    let helperStarted = false;  // P0: 追踪 helper 是否已尝试启动
    let helperExited = false;   // P0: 追踪 helper 是否已正常退出
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // P0: 启动前显式检查 signal.aborted → 确实未投递
    if (opts.signal && opts.signal.aborted) {
      return finish({
        ok: false,
        errorCategory: ErrorCategory.CANCELLED,
        error: { code: 'CANCELLED_BEFORE_START', message: 'aborted before spawn' },
        _cancelPhase: 'before_start',
      });
    }

    try {
      child = spawn(HELPER.path, argv, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: opts.signal,
      });
      helperStarted = true;  // 已尝试启动
    } catch (e) {
      return finish({ ok: false, errorCategory: ErrorCategory.HELPER_CRASH, error: { code: 'SPAWN_FAILED', message: e.message } });
    }

    const chunks = [];
    let stderrBuf = '';
    let bytes = 0;
    const MAX_BYTES = 10 * 1024 * 1024;

    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) {
        try { child.kill(); } catch {}
        return finish({ ok: false, errorCategory: ErrorCategory.PROTOCOL_ERROR, error: { code: 'OUTPUT_TOO_LARGE', message: 'stdout exceeded 10MB' } });
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      if (stderrBuf.length < 4000) stderrBuf += c.toString('utf8');
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({
        ok: false,
        errorCategory: ErrorCategory.HELPER_TIMEOUT,
        error: { code: 'TIMEOUT', message: `helper exceeded ${timeoutMs}ms`, disposition: { delivery: 'not_delivered', retry: 'unsafe' } },
      });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      const cancelled = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
      if (cancelled) {
        // P0: AbortSignal 可能在子进程执行中触发，甚至桌面动作已发生
        // 只有 helperStarted=false 才确信未投递；否则结果未知
        finish({
          ok: false,
          errorCategory: ErrorCategory.CANCELLED,
          error: { code: helperStarted ? 'CANCELLED_DURING_EXECUTION' : 'CANCELLED_BEFORE_START', message: e.message },
          _cancelPhase: helperStarted ? 'during_execution' : 'before_start',
        });
      } else {
        finish({
          ok: false,
          errorCategory: ErrorCategory.HELPER_CRASH,
          error: { code: 'SPAWN_ERROR', message: e.message },
        });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      helperExited = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        return finish({
          ok: false,
          errorCategory: ErrorCategory.PROTOCOL_ERROR,
          error: { code: 'EMPTY_OUTPUT', message: `no stdout (exit ${code})`, disposition: { delivery: 'not_delivered', retry: 'unsafe' } },
          stderr: stderrBuf.slice(0, 500),
        });
      }
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        return finish({
          ok: false,
          errorCategory: ErrorCategory.PROTOCOL_ERROR,
          error: { code: 'NON_JSON_OUTPUT', message: text.slice(0, 200), disposition: { delivery: 'not_delivered', retry: 'unsafe' } },
        });
      }
      finish({
        ok: parsed.ok === true,
        version: parsed.version,
        command: parsed.command,
        data: parsed.data,
        error: parsed.ok === false ? (parsed.error || { code: 'UNKNOWN' }) : undefined,
        exitCode: code,
      });
    });
  });
}

/** 异步 sleep（非忙等） */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// 3. 错误解析（helper 的 error 是**对象**，不是字符串）
// ═════════════════════════════════════════════════════════════════

/**
 * 从 helper envelope 提取错误码与 disposition。
 * @param {object} raw
 * @returns {{code:string, message:string, delivery:string, retry:string, category:string, recovery?:object}}
 */
function parseError(raw) {
  const e = raw && raw.error;
  if (!e || typeof e !== 'object') {
    return {
      code: 'UNKNOWN', message: typeof e === 'string' ? e : '',
      delivery: 'not_delivered', retry: 'unsafe', category: ErrorCategory.UNKNOWN,
    };
  }
  const code = String(e.code || 'UNKNOWN');
  const disposition = e.disposition || {};
  // 缺失 disposition 时保守处理：视为可能已投递，禁止重试
  const delivery = disposition.delivery || 'unknown';
  const retry = disposition.retry || 'unsafe';
  return {
    code,
    message: String(e.message || '').slice(0, 300),
    delivery,
    retry,
    category: classifyCode(code),
    recovery: e.recovery,
  };
}

function classifyCode(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'STALE_REF') return ErrorCategory.STALE_REF;
  if (c === 'SNAPSHOT_NOT_FOUND') return ErrorCategory.SNAPSHOT_NOT_FOUND;
  if (c === 'WINDOW_NOT_FOUND') return ErrorCategory.WINDOW_NOT_FOUND;
  if (c === 'AMBIGUOUS_TARGET') return ErrorCategory.AMBIGUOUS_TARGET;
  if (c === 'INVALID_ARGS') return ErrorCategory.INVALID_ARGS;
  if (c === 'POLICY_DENIED') return ErrorCategory.POLICY_DENIED;
  if (c === 'TIMEOUT') return ErrorCategory.HELPER_TIMEOUT;
  if (c === 'CANCELLED') return ErrorCategory.CANCELLED;
  return ErrorCategory.UNKNOWN;
}

// ═════════════════════════════════════════════════════════════════
// 4. 动作结果归一化（以 disposition.retry 为权威）
// ═════════════════════════════════════════════════════════════════

/**
 * 把 helper 原始 envelope 归一为 7 种投递状态。
 *
 * 权威判据：
 *   · 成功动作：data.disposition.delivery
 *   · 失败动作：error.disposition.delivery + error.code
 *   · **只有 disposition.retry === 'safe' 才允许重试**
 *
 * @param {object} raw
 * @param {string} toolName
 * @returns {object}
 */
function normalizeResult(raw, toolName) {
  if (!raw || typeof raw !== 'object') {
    return { delivery: Delivery.REJECTED, retry: 'unsafe', errorCategory: ErrorCategory.PROTOCOL_ERROR };
  }

  // 传输层失败（崩溃/超时/非 JSON）——保守：不标 safe_retry
  if (raw.errorCategory) {
    if (raw.errorCategory === ErrorCategory.POLICY_DENIED) {
      return { delivery: Delivery.REJECTED, retry: 'unsafe', errorCategory: raw.errorCategory, errorCode: 'POLICY_DENIED' };
    }
    if (raw.errorCategory === ErrorCategory.CANCELLED) {
      // P0 修复：区分取消阶段
      // before_start: 确实未投递 → not_delivered_safe_retry
      // during_execution: helper 已启动，动作可能已发生 → delivered_unverified + unsafe
      // 无 _cancelPhase: 保守按 during_execution 处理
      const phase = raw._cancelPhase || 'during_execution';
      if (phase === 'before_start') {
        // 用户取消不触发自动重试（尊重取消意图）
        return {
          delivery: Delivery.NOT_DELIVERED_SAFE_RETRY,
          retry: 'unsafe',  // 不自动重试：尊重取消意图
          errorCategory: raw.errorCategory,
          errorCode: 'CANCELLED_BEFORE_START',
        };
      }
      // 执行中取消：结果未知，不宣称未投递
      return {
        delivery: Delivery.DELIVERED_UNVERIFIED,
        retry: 'unsafe',
        errorCategory: raw.errorCategory,
        errorCode: 'CANCELLED_DURING_EXECUTION',
      };
    }
    // 崩溃/超时/协议错误：结果未知 → 不宣称未投递
    return {
      delivery: Delivery.DELIVERED_UNVERIFIED,
      retry: 'unsafe',
      errorCategory: raw.errorCategory,
      errorCode: raw.error && raw.error.code,
    };
  }

  const isAction = ACTION_TOOLS.has(toolName);

  // ── 成功 ──
  if (raw.ok) {
    const data = raw.data || {};
    const disp = data.disposition || {};
    const steps = data.steps || [];

    // 事后检测物理机制：保留真实投递状态，但标记策略违规 + 停止后续
    const physical = steps.find((s) => s && s.mechanism === 'physical_synthetic');
    if (physical) {
      // P0-C 修复：不简单覆盖为 rejected；保留真实/保守 delivery
      const realDelivery = disp.delivery === 'delivered_verified' ? Delivery.DELIVERED_VERIFIED : Delivery.DELIVERED_UNVERIFIED;
      return {
        delivery: realDelivery,
        retry: 'unsafe',
        errorCategory: ErrorCategory.PHYSICAL_SYNTHETIC,
        errorCode: 'PHYSICAL_SYNTHETIC_DETECTED',
        mechanism: 'physical_synthetic',
        policyViolation: 'physical_synthetic_detected_after_delivery',
        stopSubsequent: true,
      };
    }

    if (!isAction) {
      return { delivery: Delivery.DELIVERED_VERIFIED, retry: 'unsafe' };
    }

    const delivery = disp.delivery;
    const retry = disp.retry === 'safe' ? 'safe' : 'unsafe';

    if (delivery === 'delivered_verified') {
      return {
        delivery: Delivery.DELIVERED_VERIFIED,
        retry,
        mechanism: firstMechanism(steps),
        postState: data.post_state,
        details: data.details,
      };
    }
    if (delivery === 'delivered_unverified') {
      // P1-D 修复：delivered_unverified 强制 retry=unsafe，验证前禁止重投
      return {
        delivery: Delivery.DELIVERED_UNVERIFIED,
        retry: 'unsafe',
        originalRetry: retry,
        mechanism: firstMechanism(steps),
        postState: data.post_state,
      };
    }
    if (delivery === 'not_delivered') {
      return {
        delivery: retry === 'safe' ? Delivery.NOT_DELIVERED_SAFE_RETRY : Delivery.REJECTED,
        retry,
        mechanism: firstMechanism(steps),
      };
    }
    // ok=true 但无 disposition（观察类动作）
    return { delivery: Delivery.DELIVERED_VERIFIED, retry: 'unsafe', mechanism: firstMechanism(steps) };
  }

  // ── 失败：解析 error 对象 ──
  const err = parseError(raw);
  const cat = err.category;

  if (cat === ErrorCategory.STALE_REF) {
    return { delivery: Delivery.STALE, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message, recovery: err.recovery } };
  }
  if (cat === ErrorCategory.SNAPSHOT_NOT_FOUND) {
    return { delivery: Delivery.STALE, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  if (cat === ErrorCategory.WINDOW_NOT_FOUND) {
    return { delivery: Delivery.WINDOW_GONE, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  if (cat === ErrorCategory.AMBIGUOUS_TARGET) {
    return { delivery: Delivery.AMBIGUOUS, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  if (cat === ErrorCategory.POLICY_DENIED) {
    return { delivery: Delivery.REJECTED, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  if (cat === ErrorCategory.INVALID_ARGS) {
    return { delivery: Delivery.REJECTED, retry: err.retry, errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }

  // 其余：按 disposition 保守判断
  // 只有 delivery==='not_delivered' 且 retry==='safe' 才算可安全重试
  if (err.delivery === 'not_delivered' && err.retry === 'safe') {
    return { delivery: Delivery.NOT_DELIVERED_SAFE_RETRY, retry: 'safe', errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  if (err.delivery === 'delivered_unverified' || err.delivery === 'unknown') {
    return { delivery: Delivery.DELIVERED_UNVERIFIED, retry: 'unsafe', errorCode: err.code, errorCategory: cat, details: { message: err.message } };
  }
  return { delivery: Delivery.REJECTED, retry: 'unsafe', errorCode: err.code, errorCategory: cat, details: { message: err.message } };
}

function firstMechanism(steps) {
  if (!Array.isArray(steps)) return undefined;
  for (const s of steps) {
    if (s && s.mechanism) return s.mechanism;
  }
  return undefined;
}

// ═════════════════════════════════════════════════════════════════
// 5. 快照治理（真实目录 + 路径安全 + 跨会话）
// ═════════════════════════════════════════════════════════════════

/**
 * 校验路径位于允许根内（防穿越/链接跳转）。
 * @param {string} target
 * @param {string[]} allowedRoots
 * @returns {{ok:boolean, reason?:string, resolved?:string}}
 */
function assertPathWithin(target, allowedRoots) {
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(target)); }
  catch {
    resolved = path.resolve(target);
  }
  const normalized = path.normalize(resolved);
  for (const root of allowedRoots) {
    let rootResolved;
    try { rootResolved = fs.realpathSync(path.resolve(root)); }
    catch { rootResolved = path.resolve(root); }
    const rootNorm = path.normalize(rootResolved);
    if (normalized === rootNorm) return { ok: false, reason: 'is_root_itself', resolved: normalized };
    // 必须位于 root 之下（带分隔符，避免 /a/bc 匹配 /a/b）
    if (normalized.startsWith(rootNorm + path.sep)) {
      return { ok: true, resolved: normalized };
    }
  }
  return { ok: false, reason: 'outside_allowed_roots', resolved: normalized };
}

/**
 * 收集 helper 真实写入的快照目录：
 *   · 全局：<stateRoot>/snapshots/<snapshotId>/
 *   · 会话：<stateRoot>/sessions/<sessionId>/snapshots/<snapshotId>/
 * @returns {Array<{path:string, mtimeMs:number, bytes:number, sessionId:string|null, snapshotId:string}>}
 */
function collectSnapshotDirs(stateRoot) {
  const root = stateRoot || SNAPSHOT_LIMITS.stateRoot;
  const out = [];

  const addSnapshotsUnder = (snapshotsDir, sessionId) => {
    if (!fs.existsSync(snapshotsDir)) return;
    let names;
    try { names = fs.readdirSync(snapshotsDir); } catch { return; }
    for (const name of names) {
      const p = path.join(snapshotsDir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      // 符号链接不递归删除（防链接跳转）
      try {
        if (fs.lstatSync(p).isSymbolicLink()) continue;
      } catch { continue; }
      let bytes = 0;
      try {
        for (const f of fs.readdirSync(p)) {
          try { bytes += fs.statSync(path.join(p, f)).size; } catch {}
        }
      } catch {}
      out.push({ path: p, mtimeMs: st.mtimeMs, bytes, sessionId, snapshotId: name });
    }
  };

  addSnapshotsUnder(path.join(root, 'snapshots'), null);

  const sessionsDir = path.join(root, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    let ids = [];
    try { ids = fs.readdirSync(sessionsDir); } catch {}
    for (const sid of ids) {
      const sdir = path.join(sessionsDir, sid);
      try { if (!fs.statSync(sdir).isDirectory()) continue; } catch { continue; }
      addSnapshotsUnder(path.join(sdir, 'snapshots'), sid);
    }
  }

  return out;
}

/**
 * 快照治理：TTL + 单会话数量 + 全局容量。删除前校验路径安全。
 *
 * @param {{stateRoot?:string, ttlMs?:number, dryRun?:boolean, maxPerSession?:number, maxTotalBytes?:number}} opts
 * @returns {object}
 */
function cleanupSnapshots(opts) {
  opts = opts || {};
  const root = opts.stateRoot || SNAPSHOT_LIMITS.stateRoot;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : SNAPSHOT_LIMITS.ttlMs;
  const maxPer = opts.maxPerSession != null ? opts.maxPerSession : SNAPSHOT_LIMITS.maxSnapshotsPerSession;
  const maxBytes = opts.maxTotalBytes != null ? opts.maxTotalBytes : SNAPSHOT_LIMITS.maxTotalBytes;
  const dryRun = opts.dryRun === true;

  const allowedRoots = [root];
  const dirs = collectSnapshotDirs(root);
  const now = Date.now();
  let deleted = 0, errors = 0;
  const keep = [];
  const sessionsSeen = new Set();

  const removeDir = (d) => {
    const guard = assertPathWithin(d.path, allowedRoots);
    if (!guard.ok) { errors++; return false; }
    if (dryRun) { deleted++; return true; }
    try {
      fs.rmSync(guard.resolved, { recursive: true, force: true });
      deleted++;
      return true;
    } catch { errors++; return false; }
  };

  // 1) TTL
  for (const d of dirs) {
    if (d.sessionId) sessionsSeen.add(d.sessionId);
    if (now - d.mtimeMs > ttlMs) {
      removeDir(d);
    } else {
      keep.push(d);
    }
  }

  // 2) 单会话数量上限（按会话分组，新的保留）
  const bySession = new Map();
  for (const d of keep) {
    const k = d.sessionId || '__global__';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(d);
  }
  const survivors = [];
  for (const [, list] of bySession) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < list.length; i++) {
      if (i < maxPer) survivors.push(list[i]);
      else if (!removeDir(list[i])) survivors.push(list[i]);
    }
  }

  // 3) 全局容量（最旧优先删）
  let totalBytes = survivors.reduce((s, d) => s + d.bytes, 0);
  if (totalBytes > maxBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const d of survivors) {
      if (totalBytes <= maxBytes) break;
      if (d.__gone) continue;
      if (removeDir(d)) {
        totalBytes -= d.bytes;
        d.__gone = true;
      }
    }
  }

  const finalList = survivors.filter((d) => !d.__gone);
  return {
    ok: errors === 0,
    scanned: dirs.length,
    deleted,
    kept: finalList.length,
    bytes: finalList.reduce((s, d) => s + d.bytes, 0),
    sessions: sessionsSeen.size,
    errors,
    dryRun,
  };
}

/**
 * 回收已结束的 helper 会话（异常退出遗留）。
 * @returns {Promise<object>}
 */
async function reclaimEndedSessions() {
  const r = await runHelper(['session', 'gc', '--ended'], { timeoutMs: 15000 });
  return { ok: r.ok, data: r.data, error: r.error && r.error.code };
}

// ═════════════════════════════════════════════════════════════════
// 6. 观察数据分层（可用性 vs 隐私）
// ═════════════════════════════════════════════════════════════════

/**
 * 观察类返回：保留定位与验证所需的最小控件信息（ref/role/name/actions），
 * 但**不含**输入值正文、也不回传完整树。
 * @param {object} tree
 * @param {{maxNodes?:number, includeName?:boolean}} opts
 * @returns {Array}
 */
function extractAddressable(tree, opts) {
  opts = opts || {};
  const maxNodes = opts.maxNodes || 500;
  const includeName = opts.includeName !== false;
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object' || out.length >= maxNodes) return;
    if (n.ref_id) {
      const item = { ref: n.ref_id, role: n.role || null, actions: n.available_actions || [] };
      if (includeName && n.name) item.name = String(n.name).slice(0, 120);
      out.push(item);
    }
    const kids = n.children;
    if (Array.isArray(kids)) for (const c of kids) walk(c);
  };
  walk(tree);
  return out;
}

/**
 * 脱敏元数据：仅 hash + 计数 + 类别，用于日志/遥测/证据包。
 * @param {object} data
 * @returns {object}
 */
function sanitizeMeta(data) {
  if (!data || typeof data !== 'object') return { hash: '', refCount: 0 };
  const h = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  return {
    hash: h,
    snapshotId: data.snapshot_id || null,
    refCount: data.ref_count || (Array.isArray(data.matches) ? data.matches.length : 0),
    complete: data.complete === true || undefined,
  };
}

// ═════════════════════════════════════════════════════════════════
// 7. 窗口白名单与 ref 绑定授权
// ═════════════════════════════════════════════════════════════════

/**
 * 可信绑定映射：session → snapshot → ref → window
 * 不信任请求方自报的窗口归属；ref 的归属由适配器自己记录。
 */
const refBindings = new Map(); // ref → { windowId, snapshotId, sessionId, ts }

/** 记录 ref 归属（snapshot 成功时调用） */
function recordRefBindings(windowId, snapshotId, sessionId, elements) {
  if (!Array.isArray(elements)) return;
  for (const e of elements) {
    if (e && e.ref) {
      refBindings.set(e.ref, { windowId, snapshotId, sessionId, ts: Date.now() });
    }
  }
  // 防止无限增长：保留最近 2000 条
  if (refBindings.size > 2000) {
    const oldest = [...refBindings.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < oldest.length - 2000; i++) refBindings.delete(oldest[i][0]);
  }
}

/**
 * 校验窗口是否在授权白名单内。
 * 白名单为空 = 拒绝所有动作（fail closed）。
 * @param {string} windowId
 * @param {{allowedWindows?:string[]}} policy
 * @returns {{ok:boolean, reason?:string}}
 */
function assertWindowAllowed(windowId, policy) {
  policy = policy || {};
  const allow = policy.allowedWindows;
  if (!Array.isArray(allow) || allow.length === 0) {
    return { ok: false, reason: 'no_window_whitelist_configured' };
  }
  if (!windowId) return { ok: false, reason: 'window_id_required' };
  if (!allow.includes(windowId)) return { ok: false, reason: 'window_not_in_whitelist' };
  return { ok: true };
}

/**
 * 校验 ref 的真实归属窗口是否在白名单内（P0-B 修复）。
 * 不信任请求方自报的 windowId；以适配器记录的绑定为准。
 * @param {string} ref
 * @param {{allowedWindows?:string[]}} policy
 * @param {string} expectedSessionId
 * @returns {{ok:boolean, reason?:string, boundWindow?:string}}
 */
function assertRefAllowed(ref, policy, expectedSessionId) {
  policy = policy || {};
  const allow = policy.allowedWindows;
  if (!Array.isArray(allow) || allow.length === 0) {
    return { ok: false, reason: 'no_window_whitelist_configured' };
  }
  if (!ref) return { ok: false, reason: 'ref_required' };
  const binding = refBindings.get(ref);
  if (!binding) {
    // ref 不在绑定映射中：可能是外部 ref，拒绝（fail closed）
    return { ok: false, reason: 'ref_not_in_trusted_bindings' };
  }
  // 跨会话引用检查
  if (expectedSessionId && binding.sessionId && binding.sessionId !== expectedSessionId) {
    return { ok: false, reason: 'cross_session_ref' };
  }
  // 以绑定的 windowId 为准，不以请求方自报为准
  if (!allow.includes(binding.windowId)) {
    return { ok: false, reason: 'ref_window_not_in_whitelist', boundWindow: binding.windowId };
  }
  return { ok: true, boundWindow: binding.windowId };
}

// ═════════════════════════════════════════════════════════════════
// 8. 工具实现
// ═════════════════════════════════════════════════════════════════

function argErr(reason) {
  return { ok: false, delivery: Delivery.REJECTED, retry: 'unsafe', errorCode: 'INVALID_ARGS', errorCategory: ErrorCategory.INVALID_ARGS, details: { reason } };
}

/**
 * 统一调用入口（异步）。
 * @param {string} tool
 * @param {object} params
 * @param {object} opts - { timeoutMs, sessionId, signal, policy, redact }
 * @returns {Promise<object>}
 */
async function call(tool, params, opts) {
  if (!TOOLS.includes(tool)) {
    return { ok: false, delivery: Delivery.REJECTED, retry: 'unsafe', errorCode: 'UNKNOWN_TOOL', errorCategory: ErrorCategory.INVALID_ARGS };
  }
  params = params || {};
  opts = opts || {};
  const timeoutMs = Math.max(1000, Math.min(120000, Number(opts.timeoutMs) || 30000));
  const signal = opts.signal;
  const sessionId = opts.sessionId;

  // 动作前窗口白名单校验（§6）+ ref 绑定校验（P0-B）
  if (ACTION_TOOLS.has(tool)) {
    // P0-B: 优先用 ref 绑定校验（不信任请求方自报 windowId）
    if (params.ref) {
      const rb = assertRefAllowed(params.ref, opts.policy, sessionId);
      if (!rb.ok) {
        return {
          ok: false,
          delivery: Delivery.REJECTED,
          retry: 'unsafe',
          errorCode: 'UNAUTHORIZED_WINDOW',
          errorCategory: ErrorCategory.UNAUTHORIZED_WINDOW,
          details: { reason: rb.reason, boundWindow: rb.boundWindow },
        };
      }
    } else {
      // 无 ref 的动作（不应存在，但防御性处理）
      const w = assertWindowAllowed(params.windowId, opts.policy);
      if (!w.ok) {
        return {
          ok: false,
          delivery: Delivery.REJECTED,
          retry: 'unsafe',
          errorCode: 'UNAUTHORIZED_WINDOW',
          errorCategory: ErrorCategory.UNAUTHORIZED_WINDOW,
          details: { reason: w.reason },
        };
      }
    }
  }

  let raw;

  switch (tool) {
    case 'desktop_status':
      raw = await runHelper(['status'], { timeoutMs, sessionId, signal });
      break;

    case 'desktop_list_windows': {
      const args = ['list-windows'];
      if (params.app) args.push('--app', String(params.app));
      raw = await runHelper(args, { timeoutMs, sessionId, signal });
      if (raw.ok && Array.isArray(raw.data)) {
        raw.data = raw.data.map((w) => {
          const o = {
            id: w.id, app_name: w.app_name, pid: w.pid,
            is_focused: w.is_focused, accessible: w.accessible, minimized: w.minimized,
          };
          if (opts.redact) {
            o.titleHash = w.title ? crypto.createHash('sha256').update(String(w.title)).digest('hex').slice(0, 12) : undefined;
          } else {
            o.title = w.title;
          }
          return o;
        });
      }
      break;
    }

    case 'desktop_snapshot': {
      if (!params.windowId) return argErr('window_id_required');
      const args = ['snapshot', '--window-id', String(params.windowId)];
      if (params.interactive !== false) args.push('-i');
      raw = await runHelper(args, { timeoutMs, sessionId, signal });
      break;
    }

    case 'desktop_get': {
      if (!params.ref) return argErr('ref_required');
      const args = ['get', String(params.ref)];
      if (params.property) args.push('--property', String(params.property));
      raw = await runHelper(args, { timeoutMs, sessionId, signal });
      break;
    }

    case 'desktop_is': {
      if (!params.ref) return argErr('ref_required');
      const args = ['is', String(params.ref), '--property', String(params.property || 'visible')];
      raw = await runHelper(args, { timeoutMs, sessionId, signal });
      break;
    }

    case 'desktop_find': {
      if (!params.windowId) return argErr('window_id_required');
      const args = ['snapshot', '--window-id', String(params.windowId)];
      if (params.interactive !== false) args.push('-i');
      raw = await runHelper(args, { timeoutMs, sessionId, signal });
      if (raw.ok && raw.data) {
        raw.data = { snapshot_id: raw.data.snapshot_id, matches: findInTree(raw.data.tree, params) };
      }
      break;
    }

    case 'desktop_wait': {
      // 异步定时器，禁止 busy wait（§2）
      const ms = Math.max(0, Math.min(30000, Number(params.ms) || 0));
      try {
        if (ms > 0) await sleep(ms, signal);
      } catch (e) {
        return { ok: false, delivery: Delivery.REJECTED, retry: 'unsafe', errorCode: 'CANCELLED', errorCategory: ErrorCategory.CANCELLED };
      }
      if (params.windowId && params.resnapshot) {
        raw = await runHelper(['snapshot', '--window-id', String(params.windowId), '-i'], { timeoutMs, sessionId, signal });
      } else {
        return { ok: true, delivery: Delivery.DELIVERED_VERIFIED, retry: 'unsafe', data: { waited: ms } };
      }
      break;
    }

    case 'desktop_click_ref': {
      if (!params.ref) return argErr('ref_required');
      // 绝不加 --headed（执行前防护）
      raw = await runHelper(['click', String(params.ref)], { timeoutMs, sessionId, signal });
      break;
    }

    case 'desktop_set_value_ref': {
      if (!params.ref) return argErr('ref_required');
      if (params.value === undefined) return argErr('value_required');
      raw = await runHelper(['set-value', String(params.ref), String(params.value)], { timeoutMs, sessionId, signal });
      break;
    }

    default:
      return argErr('unreachable');
  }

  const norm = normalizeResult(raw, tool);

  const ret = {
    ok: norm.delivery === Delivery.DELIVERED_VERIFIED,
    delivery: norm.delivery,
    retry: norm.retry,
  };
  if (norm.mechanism) ret.mechanism = norm.mechanism;
  if (norm.errorCode) ret.errorCode = norm.errorCode;
  if (norm.errorCategory) ret.errorCategory = norm.errorCategory;
  if (norm.postState) ret.postState = norm.postState;
  if (norm.details) ret.details = norm.details;
  if (norm.warning) ret.warning = norm.warning;
  // P0-C: 传递 stopSubsequent 和 policyViolation
  if (norm.stopSubsequent) ret.stopSubsequent = true;
  if (norm.policyViolation) ret.policyViolation = norm.policyViolation;
  // P1-D: 传递原始重试字段（区分原始与有效策略）
  if (norm.originalRetry) ret.originalRetry = norm.originalRetry;

  if (raw.ok && raw.data) {
    if (tool === 'desktop_snapshot') {
      ret.snapshotId = raw.data.snapshot_id;
      ret.refCount = raw.data.ref_count;
      ret.elements = extractAddressable(raw.data.tree, { maxNodes: params.maxNodes || 300 });
      ret.meta = sanitizeMeta(raw.data);
      // P0-B: 记录 ref → window 绑定（可信记录，不信任请求方自报）
      if (params.windowId) {
        recordRefBindings(params.windowId, ret.snapshotId, sessionId, ret.elements);
      }
    } else if (tool === 'desktop_find') {
      ret.snapshotId = raw.data.snapshot_id;
      ret.matches = raw.data.matches;
    } else if (tool === 'desktop_get' || tool === 'desktop_is'
      || tool === 'desktop_list_windows' || tool === 'desktop_status') {
      ret.data = raw.data;
    } else if (tool === 'desktop_wait') {
      ret.snapshotId = raw.data.snapshot_id;
      ret.elements = extractAddressable(raw.data.tree, { maxNodes: params.maxNodes || 300 });
    } else {
      ret.meta = sanitizeMeta(raw.data);
    }
  }

  return ret;
}

/**
 * 在快照树中按条件查找（返回 ref + 最小定位信息）。
 */
function findInTree(tree, params) {
  const out = [];
  const max = Math.min(200, Number(params && params.limit) || 50);
  const walk = (n) => {
    if (!n || typeof n !== 'object' || out.length >= max) return;
    let hit = !!n.ref_id;
    if (hit && params.role && n.role !== params.role) hit = false;
    if (hit && params.name && !String(n.name || '').includes(params.name)) hit = false;
    if (hit && params.action && !(n.available_actions || []).includes(params.action)) hit = false;
    if (hit) {
      out.push({
        ref: n.ref_id,
        role: n.role || null,
        name: n.name ? String(n.name).slice(0, 120) : undefined,
        actions: n.available_actions || [],
      });
    }
    const kids = n.children;
    if (Array.isArray(kids)) for (const c of kids) walk(c);
  };
  walk(tree);
  return out;
}

// ═════════════════════════════════════════════════════════════════
// 9. 二次验证（只用观察，不重投）
// ═════════════════════════════════════════════════════════════════

/**
 * delivered_unverified 后做观察验证。
 * §4：只允许观察验证；新 snapshot 后**重新定位目标并换新 ref**。
 *
 * @param {object} p - { windowId, role, name, expectedValue, sessionId, timeoutMs }
 * @returns {Promise<object>}
 */
async function observeVerify(p) {
  p = p || {};
  const opts = { timeoutMs: p.timeoutMs || 20000, sessionId: p.sessionId, signal: p.signal };

  const snap = await call('desktop_snapshot', { windowId: p.windowId, interactive: false }, opts);
  if (!snap.ok) {
    return { verified: false, delivery: snap.delivery, reason: 'snapshot_failed', errorCode: snap.errorCode };
  }

  const fresh = await call('desktop_find', {
    windowId: p.windowId, role: p.role, name: p.name, limit: 20, interactive: false,
  }, opts);
  if (!fresh.ok) {
    return { verified: false, delivery: fresh.delivery, reason: 'find_failed', snapshotId: snap.snapshotId };
  }
  const matches = fresh.matches || [];
  if (matches.length === 0) {
    return { verified: false, delivery: Delivery.STALE, reason: 'target_not_found_in_new_snapshot', snapshotId: snap.snapshotId };
  }
  if (matches.length > 1) {
    return { verified: false, delivery: Delivery.AMBIGUOUS, reason: 'target_ambiguous_in_new_snapshot', candidates: matches.slice(0, 5), snapshotId: snap.snapshotId };
  }

  const newRef = matches[0].ref;

  if (p.expectedValue !== undefined) {
    const got = await call('desktop_get', { ref: newRef, property: 'value' }, opts);
    if (!got.ok) {
      return { verified: false, delivery: got.delivery, reason: 'get_failed', newRef, snapshotId: snap.snapshotId };
    }
    const actual = got.data && got.data.value;
    const same = String(actual) === String(p.expectedValue);
    return {
      verified: same,
      delivery: same ? Delivery.DELIVERED_VERIFIED : Delivery.DELIVERED_UNVERIFIED,
      actualValue: actual,
      newRef,
      snapshotId: snap.snapshotId,
      method: 'value_readback',
    };
  }

  // 无后置条件（click）：只证明目标仍存在，不足以宣称 verified
  return {
    verified: false,
    delivery: Delivery.DELIVERED_UNVERIFIED,
    reason: 'no_postcondition_provided',
    newRef,
    snapshotId: snap.snapshotId,
    method: 'target_still_present_only',
  };
}

// ═════════════════════════════════════════════════════════════════
// 10. Helper 校验
// ═════════════════════════════════════════════════════════════════

async function verifyHelper() {
  if (!fs.existsSync(HELPER.path)) {
    return { ok: false, error: 'helper_not_found' };
  }
  let hash;
  try {
    hash = crypto.createHash('sha256').update(fs.readFileSync(HELPER.path)).digest('hex');
  } catch (e) {
    return { ok: false, error: 'sha256_read_failed', detail: e.message };
  }
  if (hash !== HELPER.sha256) {
    return { ok: false, error: 'sha256_mismatch', expected: HELPER.sha256, actual: hash };
  }
  const r = await runHelper(['status'], { timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, error: 'status_failed', detail: r.error && r.error.code };
  }
  const d = r.data || {};
  if (d.version !== HELPER.version) {
    return { ok: false, error: 'version_mismatch', expected: HELPER.version, actual: d.version };
  }
  if (r.version !== HELPER.protocolVersion) {
    return { ok: false, error: 'protocol_mismatch', expected: HELPER.protocolVersion, actual: r.version };
  }
  return {
    ok: true,
    sha256: hash,
    version: d.version,
    protocol: r.version,
    permissions: d.permissions,
    stateRoot: d.state_root,
  };
}

// ═════════════════════════════════════════════════════════════════
// 11. 会话生命周期
// ═════════════════════════════════════════════════════════════════

/** 创建 helper 会话（拿到 session_id 用于隔离） */
async function startSession(name, timeoutMs) {
  const r = await runHelper(['session', 'start', '--name', String(name || 'whale-d1').slice(0, 128)], {
    timeoutMs: timeoutMs || 15000,
  });
  if (!r.ok) return { ok: false, error: r.error && r.error.code };
  return { ok: true, sessionId: r.data && r.data.session_id, createdAt: r.data && r.data.created_at };
}

/** 结束 helper 会话 */
async function endSession(sessionId, timeoutMs) {
  if (!sessionId) return { ok: false, error: 'session_required' };
  const r = await runHelper(['session', 'end', String(sessionId)], { timeoutMs: timeoutMs || 15000 });
  return { ok: r.ok, error: r.error && r.error.code };
}

// ═════════════════════════════════════════════════════════════════
// 12. 导出
// ═════════════════════════════════════════════════════════════════

module.exports = {
  VERSION,
  HELPER,
  SNAPSHOT_LIMITS,
  Delivery,
  ErrorCategory,
  TOOLS,
  ACTION_TOOLS,
  FORBIDDEN_CLI_COMMANDS,
  FORBIDDEN_CLI_FLAGS,
  // 执行前防护
  assertSafeArgs,
  assertWindowAllowed,
  assertRefAllowed,
  assertPathWithin,
  recordRefBindings,
  // 调用
  call,
  runHelper,
  sleep,
  // 归一化
  normalizeResult,
  parseError,
  classifyCode,
  // 治理
  cleanupSnapshots,
  collectSnapshotDirs,
  reclaimEndedSessions,
  // 隐私分层
  extractAddressable,
  sanitizeMeta,
  // 验证
  observeVerify,
  // 会话
  startSession,
  endSession,
  // helper
  verifyHelper,
  findInTree,
};
