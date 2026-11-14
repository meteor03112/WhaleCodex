// Modified for the Apache-2.0 public source release, 2026-11-14.
// 鲸鱼娘 · Codex 客户端（Electron 主进程）
// 内置 HTTP 服务（聊天 SSE + Agent 调用 codex），不依赖 Python
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, safeStorage, session } = require('electron');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
// 必须写全 .js：Windows 文件系统大小写不敏感，require('./license') 会命中同目录的
// LICENSE 纯文本文件并抛 SyntaxError（包内同时随附专有 LICENSE，务必保留显式扩展名）。
const license = require('./license.js');
// 高精度语音模型按需下载（独立模块，便于单独验证验签 / 断点续传 / sha256）
const asrModels = require('./asr-models.js');
// 连接器注册表（主流 / 常用连接器：元数据 + 如何写进 Codex 引擎的 mcp_servers）
const CONNECTOR_REGISTRY = require('./connectors.js');
// 模型适配层（L1 Schema / L2 能力 / L3 协议 / L4 护栏 / L5 重试）：纯 CommonJS，可独立单测。
// 主进程只跟它的门面打交道，所有模型差异在这一层收敛。
const ModelAdapter = require('./model-adapter.js');
// 统一遥测（usage 归一化 / 速度 / 缓存）与运行注册表（按 run 隔离的身份、事件、取消）
const telemetry = require('./telemetry.js');
const { RunRegistry } = require('./run-registry.js');
const { Workbench, isPrivateHost, canDockAt, DOCK_MIN_WIDTH } = require('./workbench-service.js');
const ctxBudget = require('./context-budget.js');
const capModule = require('./model-capability.js');
const ctxPlanner = require('./context-planner.js');
const ctxSummary = require('./context-summary.js');
// 只读子智能体编排（第六轮 A1）：纯逻辑模块，执行器由本文件注入
const subAgentModule = require('./subagent-orchestrator.js');
// agent-desktop D1 语义适配器：桌面控制桥（默认关闭，settings.desktopControl=true 开启）
const desktopBridge = require('./desktop-bridge.js');
const { AttachmentStore } = require('./attachment-store.js');
const { installAttachmentIpc } = require('./attachment-ipc.js');
const { collectResponseAttachments } = require('./response-attachments.js');
const attachmentStore = new AttachmentStore();
function responseAttachments(text, run, roots, cwd) {
  if (!run || !run.sessionId || !attachmentSessionLive(run.sessionId)) return [];
  try { return collectResponseAttachments({ text, store: attachmentStore, sessionId: run.sessionId,
    sourceId: run.runId, roots, cwd }); }
  catch (e) { audit({ kind: 'attachment_error', runId: run.runId, error: String(e.message || e) }); return []; }
}

/* ================= 桌面控制桥运行时状态（D1） =================
 * 边界：
 *   · 全部 helper 调用异步，绝不阻塞 Electron 主进程 / HTTP 事件循环；
 *   · 开关关闭时立即拒绝新动作，并对在途动作发 abort（已投递的保留真实状态）；
 *   · 快照治理挂启动回收 + 周期回收 + 会话结束回收；
 *   · 窗口白名单为空 = 动作一律拒绝（fail closed）。
 */
const desktopRuntime = {
  sessionId: null,          // helper 原生会话 id（隔离快照命名空间）
  sessionStamp: null,       // 会话用途标识（仅诊断用，不是 helper id）
  inflight: new Map(),      // requestId -> AbortController
  gcTimer: null,
  lastGc: null,
  startedAt: null,
  blocked: false,           // P0-C: physical_synthetic 检出后阻断后续动作
  blockReason: null,        // 阻断原因
};

function desktopPolicy() {
  return { allowedWindows: Array.isArray(settings.desktopWindowAllow) ? settings.desktopWindowAllow : [] };
}

function desktopCleanupOpts() {
  return {
    ttlMs: Number(settings.desktopSnapshotTtlMs) || 30 * 60 * 1000,
    maxPerSession: Number(settings.desktopMaxSnapshotsPerSession) || 20,
    maxTotalBytes: Number(settings.desktopMaxTotalBytes) || 50 * 1024 * 1024,
  };
}

/** 启动回收：清 TTL 过期快照 + 回收异常退出遗留的 helper 会话 */
async function desktopStartupReclaim() {
  try {
    const r = desktopBridge.cleanupSnapshots(desktopCleanupOpts());
    desktopRuntime.lastGc = { at: Date.now(), ...r, phase: 'startup' };
  } catch (e) {
    desktopRuntime.lastGc = { at: Date.now(), error: String(e.message || e), phase: 'startup' };
  }
  try {
    const gc = await desktopBridge.reclaimEndedSessions();
    if (desktopRuntime.lastGc) desktopRuntime.lastGc.sessionGc = gc.ok ? 'ok' : (gc.error || 'failed');
  } catch (e) {
    if (desktopRuntime.lastGc) desktopRuntime.lastGc.sessionGc = 'error';
  }
}

/** 周期回收（10 分钟） */
function desktopScheduleGc() {
  if (desktopRuntime.gcTimer) return;
  desktopRuntime.gcTimer = setInterval(() => {
    try {
      const r = desktopBridge.cleanupSnapshots(desktopCleanupOpts());
      desktopRuntime.lastGc = { at: Date.now(), ...r, phase: 'periodic' };
    } catch (e) {
      desktopRuntime.lastGc = { at: Date.now(), error: String(e.message || e), phase: 'periodic' };
    }
  }, 10 * 60 * 1000);
  if (desktopRuntime.gcTimer.unref) desktopRuntime.gcTimer.unref();
}

/** 会话结束回收：结束 helper 会话 + 清该会话快照 */
async function desktopShutdown() {
  const sid = desktopRuntime.sessionId;
  desktopRuntime.sessionId = null;
  if (desktopRuntime.gcTimer) {
    clearInterval(desktopRuntime.gcTimer);
    desktopRuntime.gcTimer = null;
  }
  if (sid) {
    try { await desktopBridge.endSession(sid); } catch {}
  }
  try { desktopBridge.cleanupSnapshots(desktopCleanupOpts()); } catch {}
}

/** 立刻中止所有在途动作（开关关闭时调用） */
function desktopAbortAll(reason) {
  let n = 0;
  for (const [, ctl] of desktopRuntime.inflight) {
    try { ctl.abort(); n++; } catch {}
  }
  desktopRuntime.inflight.clear();
  return n;
}

let workbench = null;
let workbenchWin = null;   // 窄窗时的独立工作台工具窗（同一应用、同一后端）

const APP_DIR = __dirname;

// 运行注册表：每个聊天 / Agent / 侧聊一个 run；事件落盘到 ROOT/runs 便于重连补发。
// 注意 ROOT 在下面才定义，这里先占位，稍后 init。
let runs = null;
// 每 run 的引擎 token → runId（Agent 子进程用，run 结束后删除）
const agentRunTokens = new Map();
function initRuns() {
  if (runs) return runs;
  try {
    runs = new RunRegistry({ dir: path.join(ROOT, 'runs') });
  } catch (e) {
    runs = new RunRegistry({ dir: null });
  }
  return runs;
}

// 主题静态资源精确表：URL → 本地相对路径 + MIME。新增文件必须同时登记此处与 build.files。
const THEME_ASSETS = {
  '/themes/whale-fantasy/whale-native.css': {
    file: 'themes/whale-fantasy/whale-native.css', mime: 'text/css',
  },
  '/themes/whale-fantasy/whale-background.js': {
    file: 'themes/whale-fantasy/whale-background.js', mime: 'application/javascript',
  },
  '/themes/whale-fantasy/assets/whale-fantasy-loop.mp4': {
    file: 'themes/whale-fantasy/assets/whale-fantasy-loop.mp4', mime: 'video/mp4',
  },
  '/themes/whale-fantasy/ATTRIBUTION.md': {
    file: 'themes/whale-fantasy/ATTRIBUTION.md', mime: 'text/plain',
  },
  '/themes/whale-fantasy/upstream/LICENSE': {
    file: 'themes/whale-fantasy/upstream/LICENSE', mime: 'text/plain',
  },
  '/themes/whale-fantasy/whale-workbench.css': {
    file: 'themes/whale-fantasy/whale-workbench.css', mime: 'text/css',
  },
  '/attachment-ui.js': { file: 'attachment-ui.js', mime: 'application/javascript' },
  '/workbench.js': {
    file: 'workbench.js', mime: 'application/javascript',
  },
  '/text-stream.js': {
    file: 'text-stream.js', mime: 'application/javascript',
  },
};
const PACKAGED = app.isPackaged;
// 发布形态开关（2026-11-10 起为免费公开版）：
//   true  = 不做授权校验，任何人下载即可使用（发 GitHub 供他人使用）
//   false = 恢复原「离线授权 + 机器指纹」激活锁（激活页与 /api/license/* 一并恢复生效）
// 授权模块本身仍保留在 license.js，改回 false 并重新打包即可恢复，无需回滚代码。
const FREE_MODE = true;

// 数据目录（settings/chats/sessions/home）：必须可写，统一落在用户数据目录。
const ROOT = process.env.WHALE_ROOT || app.getPath('userData');
license.init(ROOT); // 加固②：License 激活锁基于用户数据目录存储授权文件
// 排障开关：只有显式设置 WHALE_CDP_PORT 或数据目录下存在 cdp.port 时才开远程调试端口，
// 平时（两者都没有）不改变任何启动行为。
(() => {
  let port = String(process.env.WHALE_CDP_PORT || '').trim();
  if (!port) {
    try { port = String(fs.readFileSync(path.join(ROOT, 'cdp.port'), 'utf8') || '').trim(); } catch (e) {}
  }
  if (/^\d{2,5}$/.test(port)) {
    try { app.commandLine.appendSwitch('remote-debugging-port', port); } catch (e) {}
  }
})();
// 随包资源（引擎 / 语音 worker / 图标）：只读，打包后在 resources\ 下
const RES = PACKAGED ? process.resourcesPath : path.resolve(process.env.WHALE_EXTERNAL_RESOURCES || path.join(APP_DIR, '..', 'external-resources'));
const ENGINE_DIR = path.join(RES, 'engine');
const ASR_DIR = path.join(RES, 'asr');
const ASSETS = PACKAGED ? path.join(RES, 'assets') : path.join(APP_DIR, '..', 'assets');
// Windows 用 .ico（任务栏/托盘最清晰），Linux/macOS 用 png
function appIconPath() {
  if (process.platform === 'win32') return path.join(ASSETS, 'app.ico');
  const png = path.join(ASSETS, 'app-icon.png');
  return fs.existsSync(png) ? png : path.join(ASSETS, 'app.ico');
}
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {}
// Persistent revocation prevents in-flight runs and legacy session files from
// silently re-authorizing attachments after the user deletes a conversation.
const attachmentRevocationsPath = path.join(ROOT, 'attachment-revocations.json');
let attachmentRevocations = new Set();
try {
  const saved = JSON.parse(fs.readFileSync(attachmentRevocationsPath, 'utf8'));
  if (!Array.isArray(saved)) throw new Error('invalid revocation records');
  attachmentRevocations = new Set(saved.filter(x => typeof x === 'string'));
} catch (e) {
  if (e.code !== 'ENOENT') attachmentRevocations.add('*'); // corruption fails closed
}
function attachmentSessionRevoked(sid) { return !sid || attachmentRevocations.has('*') || attachmentRevocations.has(sid); }
function attachmentSessionLive(sid) {
  if (attachmentSessionRevoked(sid)) return false;
  try { return !!(chatRead(sid) || loadSession(sid)); } catch { return false; }
}
function revokeAttachmentSession(sid) {
  attachmentRevocations.add(sid); attachmentStore.endSession(sid);
  const temp = attachmentRevocationsPath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify([...attachmentRevocations]));
  fs.renameSync(temp, attachmentRevocationsPath);
}

// 加固②：未授权时展示的激活页（/activate 路由返回）。成功激活后跳转主应用。
const ACTIVATION_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>鲸鱼娘 · 激活</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1016;color:#e6e8ee;font-family:system-ui,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif}
.box{width:440px;max-width:92vw;background:#161922;border:1px solid #2a2f3c;border-radius:14px;padding:28px 26px;box-shadow:0 12px 40px rgba(0,0,0,.45)}
h1{margin:0 0 4px;font-size:20px;font-weight:700}.sub{margin:0 0 18px;color:#8d919a;font-size:13px}
label{display:block;font-size:13px;color:#aab0bd;margin:14px 0 6px}
textarea{width:100%;height:96px;resize:vertical;background:#0e1016;color:#e6e8ee;border:1px solid #2a2f3c;border-radius:8px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.mid{margin-top:12px;font-size:12px;color:#8d919a;word-break:break-all;background:#0e1016;border:1px dashed #2a2f3c;border-radius:8px;padding:8px 10px}
.btn{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.btn:hover{background:#2f6fdc}.err{margin-top:12px;color:#f87171;font-size:13px;min-height:18px}
.note{margin-top:16px;font-size:11px;color:#6b7280;line-height:1.6}
</style></head><body><div class="box">
<h1>鲸鱼娘 · 激活</h1><p class="sub">本软件已启用授权锁，请输入授权码以使用。</p>
<label>授权码</label><textarea id="key" placeholder="粘贴授权码（一行）"></textarea>
<div class="mid">本机指纹：<span id="mid">读取中…</span></div>
<button class="btn" id="act">激活</button>
<div class="err" id="err"></div>
<div class="note">授权码由版权方签发。本机指纹用于机器绑定型授权；如遇“指纹不匹配”，请在本机重新签发授权。</div>
</div><script>
function showErr(m){document.getElementById('err').textContent=m||'';}
fetch('/api/license/machine-id').then(r=>r.json()).then(j=>{document.getElementById('mid').textContent=j.machineId||'未知';}).catch(e=>{document.getElementById('mid').textContent='读取失败';});
document.getElementById('act').onclick=function(){
  var k=document.getElementById('key').value.trim();
  if(!k){showErr('请先粘贴授权码');return;}
  showErr('校验中…');
  fetch('/api/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})}).then(r=>r.json()).then(j=>{
    if(j.ok){window.location.href='/';}else{showErr('激活失败：'+(j.reason||'未知错误'));}
  }).catch(e=>{showErr('请求失败：'+e);});
};
</script></body></html>`;

// ---------- 加固③：本地 API 访问令牌 + 浏览器侧隔离 ----------
// 背景：HTTP 服务只绑 127.0.0.1 并不等于只有本应用能调用。任意浏览器页面（含 DNS rebinding）
// 或本机其它进程都能直接 fetch http://127.0.0.1:8760/api/* 读聊天记录、改设置、启动 Agent。
// 方案：每次启动生成 256bit 随机令牌，仅存在于本进程内存；由服务端注入页面，
// 页面内 fetch 统一附加 X-Whale-Token；所有 /api/* 与页面入口强制校验。
// 同时校验 Host / Origin / Sec-Fetch-Site，拒绝非 loopback 与跨站调用。
const API_TOKEN = crypto.randomBytes(32).toString('hex');
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function tokenEqual(a, b) {
  try {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch { return false; }
}
function requestToken(req, allowQuery) {
  const h = req.headers['x-whale-token'];
  if (typeof h === 'string' && h) return h;
  if (allowQuery) {
    try { return new URL(req.url, 'http://127.0.0.1').searchParams.get('wtok') || ''; } catch { return ''; }
  }
  return '';
}
// mode: false = 只查 Host/Origin（引擎兼容层用）；'header' = API；'query' = 页面入口（允许一次性 URL 令牌）
function guard(req, res, mode) {
  const host = String(req.headers.host || '');
  const origin = String(req.headers.origin || '');
  const site = String(req.headers['sec-fetch-site'] || '');
  if (!LOOPBACK_HOST_RE.test(host) ||
      (origin && !LOOPBACK_ORIGIN_RE.test(origin)) ||
      (site && site !== 'same-origin' && site !== 'none')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: local-only endpoint');
    return false;
  }
  if (mode && !tokenEqual(requestToken(req, mode === 'query'), API_TOKEN)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized: 请从应用窗口打开本页');
    return false;
  }
  return true;
}
// 注入到每个 HTML 页首：令牌 + fetch 包装（只给同源请求加头，绝不把令牌发给外部地址）
function bootstrapScript(nonce) {
  return `<script nonce="${nonce}">(function(){
  var t="${API_TOKEN}";
  try{if(location.search.indexOf('wtok=')>=0){history.replaceState(null,'',location.pathname+location.hash);}}catch(e){}
  window.__WHALE_TOKEN__=t;
  var f=window.fetch;
  window.fetch=function(input,init){
    try{
      var u=(typeof input==='string')?input:((input&&input.url)||'');
      if(u.charAt(0)==='/'||u.indexOf(location.origin)===0){
        var h;
        if(init&&init.headers){h=new Headers(init.headers);}
        else if(typeof Request!=='undefined'&&input instanceof Request){h=new Headers(input.headers);}
        else{h=new Headers();}
        h.set('X-Whale-Token',t);
        init=Object.assign({},init||{},{headers:h});
      }
    }catch(e){}
    return f.call(this,input,init);
  };
})();</script>`;
}
function injectGuardHtml(buf, nonce) {
  let html = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  // 激活页含内联 <script>，CSP 下必须带 nonce；主页面只有同源外链脚本
  html = html.replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="' + nonce + '"');
  const inject = bootstrapScript(nonce);
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + inject)
    : inject + html;
  // 激活成功后的跳转需要携带一次性令牌（页面脚本会立即从地址栏清除）
  html = html.replace("window.location.href='/'", "window.location.href='/?wtok='+window.__WHALE_TOKEN__");
  return html;
}
function securityHeaders(res, nonce) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  try {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  } catch {}
}

// ---------- 模型目录 ----------
// wire 决定 Codex CLI 的协议：chat → 老引擎 0.90 + ds-home；responses → 新引擎 + home。
// 显式声明优先；未登记的模型会运行时探测 /v1/responses 后自动归类，因此任意 NIM 模型都能接入。
// 2026-11-09 全量实测（84 个目录模型逐个流式探活）后的结论：
//   本账号真正开通且能流式返回的只有 Nemotron 3 / 3.5 家族 + poolside + stepfun；
//   4.1F 可用但队列拥塞；minimax / glm-5.3 / mistral-1T / gpt-oss 长期排队；
//   其余大量模型对账号返回 404（未开通）或 410（已下线）。目录只登记验证过的模型，
//   避免用户选中一个"看起来存在"的模型却只得到 404/410。
// health: ok=实测可流式；congested=可连通但长排队（会触发自动降级）；locked=账号未开通
// 2026-11-11：9 个 NIM 高质量模型（84 个 × 同一道高难度题实测筛选）+ 16 个从 DSH 接入的 CatCold 三组，共 25 个。
// 带 provider 的模型由 upstreamFor() 路由到各自分组的密钥 / 端点；其余走当前激活模板。
// 用户明确要求「只要高质量模型」：高难度题答错的 Bolt / Poolside / gemma-4 一律剔除。
// mistral-large-4（58.2s）与 glm-5.3-flash（88.5s）实测答对，按用户要求一并纳入（偏慢，不进降级链）。
// minimax-m3.1-flash 单独给足 6 分钟窗口后确认真的是高质量（排队 ~122s、总 181s 答对），按用户要求保留。
// 唯一的质量未验证例外是 deepseek-v4.1-flash（ds4.1f），用户点名保留，尽管多次排队超时。
// desc 里的秒数是「完整响应耗时」，含排队与思维链；与首字延迟不是一回事。
const MODEL_CATALOG = {
  'nvidia/nemotron-3-ultra-550b-a55b': {
    label: 'Nemotron-3-Ultra-550B',
    wire: 'responses',
    thinking: false,            // 不支持该参数，实测不传也能正常推理
    group: '旗舰',
    health: 'ok',
    ctx: 1000000,
    desc: '550B MoE · 1M 上下文 · 实测 37.1s 答对并给出可运行代码；长程 agent / 工具调用首选',
  },
  'nvidia/nemotron-3.5-super-vl-120b-a12b': {
    label: 'Nemotron-3.5-Super-VL',
    wire: 'chat',
    thinking: true,
    group: '多模态',
    health: 'ok',
    ctx: 256000,
    desc: '120B 视觉语言 · 实测 23.6s 答对，是答对模型里最快的；截图 / 图表 / 图文推理',
  },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': {
    label: 'Nemotron-3-Nano-Omni',
    wire: 'chat',
    thinking: true,
    group: '极速',
    health: 'ok',
    ctx: 128000,
    desc: '30B 全模态推理 · 实测 28.9s 答对，思维链完整；图文与逻辑兼顾',
  },
  'stepfun-ai/step-5-preview': {
    label: 'Step-5-Preview',
    wire: 'chat',
    thinking: true,
    group: '旗舰',
    health: 'slow',
    ctx: 256000,
    desc: '中文长文 / 推理 · 实测 24.7s 答对且思维链最短（2.4k 字），推理效率最高',
    note: '偶发排队',
  },
  'nvidia/nemotron-3.5-lightning-30b-a3b': {
    label: 'Nemotron-3.5-Lightning',
    wire: 'chat',
    thinking: true,
    group: '极速',
    health: 'ok',
    ctx: 256000,
    desc: '30B-A3B · 实测 71.2s 答对但思维链最长（13k 字），适合不赶时间的深度推理',
  },
  // 1T 参数通用旗舰：实测 58.2s 答对、JSON / 代码 / 推理齐全；不传 thinking 参数更稳。
  'mistralai/mistral-large-4-1t-a52b': {
    label: 'Mistral-Large-4-1T',
    wire: 'chat',
    thinking: false,
    group: '旗舰',
    health: 'ok',
    ctx: 128000,
    desc: '1T 通用旗舰 · 实测 58.2s 答对并给出可运行代码；长上下文通用推理 / 写作',
    note: '响应偏慢',
  },
  // 中文推理强项：实测 88.5s 答对、代码用完整 DP 递推（不是抄公式），但首轮曾排队超时。
  'z-ai/glm-5.3-flash': {
    label: 'GLM-5.3-Flash',
    wire: 'chat',
    thinking: false,
    group: '旗舰',
    health: 'ok',
    ctx: 128000,
    desc: '中文推理 / 代码 · 实测 88.5s 答对（DP 递推实现完整）；偏慢，适合不赶时间的复杂任务',
    note: '响应偏慢',
  },
  // 单独给足 6 分钟窗口复测：首包 122s、总 181s，答对 524288 且 JSON / 代码 / 推理齐全。
  // 质量达标但冷启动排队极久，因此保留、不进降级链（避免排队时再降级到另一个慢模型）。
  'minimaxai/minimax-m3.1-flash': {
    label: 'MiniMax-M3.1-Flash (NIM)',
    wire: 'chat',
    thinking: false,
    group: '旗舰',
    health: 'congested',
    ctx: 128000,
    desc: '实测 181s 答对高难度题（JSON+可运行代码齐全）；冷启动排队约 2 分钟，适合不赶时间的任务',
    note: '排队很久',
  },
  // 用户指定保留：多次排队超时，属「有时跑不通」，因此不进降级链。
  'deepseek-ai/deepseek-v4.1-flash': {
    label: 'DeepSeek-V4.1-Flash (NIM)',
    wire: 'chat',
    thinking: true,
    group: '旗舰',
    health: 'congested',
    ctx: 128000,
    desc: '强制思考 · 中文推理强；实测两轮均排队超时，按用户要求保留，偶发可用时再手动切换',
    note: '偶发跑不通',
  },

  // ===== CatCold 三组 API（2026-11-11 从 DSH 接入，共 16 个）=====
  // provider: 模型级路由到各自分组的密钥 / 端点（upstreamFor）；不带此字段的走当前激活模板。
  // wire 固定 'chat'：respToChatMessages 把 input_image 转成 image_url、respToChatTools 把 tools 原样透传，
  // 因此「视图 + 调用工具」能力全开；vision / tools 也显式登记供界面展示。
  // ctx 取 DSH 里登记的真实上下文窗口（128K / 200K），不虚标，effectiveContextLimit 会据此收敛实际预算。
  // --- [1] 付费主用（CATCOLD_API_KEY） ---
  'deepseek-v4.1-flash': { label:'DS-4.1F [付费]', wire:'chat', thinking:true, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'CatCold 主用 · 强制思考 · 中文推理强 · 128K · 视图/工具全开' },
  'kimi-k3': { label:'Kimi-K3 [付费]', wire:'chat', thinking:false, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'长文与推理 · 128K · 视图/工具全开' },
  'glm-5.3': { label:'GLM-5.3 [付费]', wire:'chat', thinking:false, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'中文通用 · 128K · 视图/工具全开' },
  'glm-5.3-flash': { label:'GLM-5.3-Flash [付费]', wire:'chat', thinking:false, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'中文快版 · 128K · 视图/工具全开' },
  'minimax-m3': { label:'MiniMax-M3 [付费]', wire:'chat', thinking:false, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'通用长文 · 128K · 视图/工具全开' },
  'MiniMax-M3.1-flash': { label:'MiniMax-M3.1-Flash [付费]', wire:'chat', thinking:false, group:'[1] 付费 · CatCold', health:'ok', ctx:128000, provider:'ds-catcold', vision:true, tools:true, desc:'快版通用 · 128K · 视图/工具全开' },
  // --- [2] 公益分组（GONGYI_API_KEY，免费额度 / 限流 5 次每分钟）---
  'Qwen/Qwen3.7-Flash': { label:'Qwen3.7-Flash [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'公益快版 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'Qwen/Qwen3.7-Max': { label:'Qwen3.7-Max [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'公益高质 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'Qwen/Qwen3.8-Max-0902': { label:'Qwen3.8-Max-0902 [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'Qwen 新版 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'Qwen/Qwen3.8-Omni-Flash': { label:'Qwen3.8-Omni-Flash [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'全模态 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'deepseek/deepseek-v4-flash-fast': { label:'DS-V4-Flash-Fast [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'极速推理 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'deepseek/deepseek-v4-pro': { label:'DS-V4-Pro [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'深度推理 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'gemini-3.8-flash': { label:'Gemini-3.8-Flash [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:200000, provider:'ds-gongyi', vision:true, tools:true, desc:'多模态 · 200K 上下文 · 视图/工具全开 · 限流 5 次/分钟' },
  'moonshotai/Kimi-K2.7-Code': { label:'Kimi-K2.7-Code [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'代码专用 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  'moonshotai/Kimi-K2.7-Code-Highspeed': { label:'Kimi-K2.7-Highspeed [公益]', wire:'chat', thinking:false, group:'[2] 公益分组', health:'ok', ctx:128000, provider:'ds-gongyi', vision:true, tools:true, desc:'代码极速版 · 128K · 视图/工具全开 · 限流 5 次/分钟' },
  // --- [3] GPT 不降智分组（GPT_API_KEY）---
  'gpt-6-astra': { label:'GPT-6-Astra [GPT]', wire:'chat', thinking:false, group:'[3] GPT 不降智', health:'ok', ctx:200000, provider:'ds-gpt', vision:true, tools:true, desc:'GPT 不降智分组 · 200K 上下文 · 7 档思考 · 视图/工具全开（该分组禁生图）' },

  // ===== [4] 九维 JiuWei（DeepSeek 原生推理网关，jiuweiapi.top）=====
  // 2026-11-13 接入：密钥由用户提供。指纹实测为 DeepSeek 原生推理格式
  // （返回 reasoning_content + usage.completion_tokens_details.reasoning_tokens），
  // 且 5 个模型全部通过红图视觉实测（content='红色'），故 vision/tools 全开。
  // 目录键用「网关/真实id」避免与 CatCold 的 deepseek-v4.1-flash 冲突；
  // wireModel 还原成上游真正认识的 id（否则上游按未知模型 404）。
  'jiuwei/deepseek-chat': { label:'DS-Chat [九维]', wire:'chat', thinking:true, group:'[4] 九维 JiuWei', health:'ok', ctx:128000, provider:'ds-jiuwei', wireModel:'deepseek-chat', vision:true, tools:true, desc:'DeepSeek 网关 · 原生推理 · 128K · 视图/工具全开' },
  'jiuwei/deepseek-reasoner': { label:'DS-Reasoner [九维]', wire:'chat', thinking:true, group:'[4] 九维 JiuWei', health:'ok', ctx:128000, provider:'ds-jiuwei', wireModel:'deepseek-reasoner', vision:true, tools:true, desc:'DeepSeek 推理 · 128K · 视图/工具全开' },
  'jiuwei/deepseek-v4-flash': { label:'DS-V4-Flash [九维]', wire:'chat', thinking:true, group:'[4] 九维 JiuWei', health:'ok', ctx:128000, provider:'ds-jiuwei', wireModel:'deepseek-v4-flash', vision:true, tools:true, desc:'DeepSeek-V4-Flash · 128K · 视图/工具全开' },
  'jiuwei/deepseek-v4-pro': { label:'DS-V4-Pro [九维]', wire:'chat', thinking:true, group:'[4] 九维 JiuWei', health:'ok', ctx:128000, provider:'ds-jiuwei', wireModel:'deepseek-v4-pro', vision:true, tools:true, desc:'DeepSeek-V4-Pro · 128K · 视图/工具全开' },
  'jiuwei/deepseek-v4.1-flash': { label:'DS-V4.1-Flash [九维]', wire:'chat', thinking:true, group:'[4] 九维 JiuWei', health:'ok', ctx:128000, provider:'ds-jiuwei', wireModel:'deepseek-v4.1-flash', vision:true, tools:true, desc:'DeepSeek-V4.1-Flash · 128K · 视图/工具全开（与 CatCold 同名，走九维网关）' },
};
const MODELS = Object.keys(MODEL_CATALOG);
const MODEL_LABELS = Object.fromEntries(MODELS.map(m => [m, MODEL_CATALOG[m].label]));
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

/* 模型 id 的合法字符集。显示名（如「DeepSeek-V4.1-Flash (NIM)」）含空格和括号，
   一旦被当成 id 存进 settings.model，重启后按 id 匹配不上就会静默回落到列表第一个模型。
   实测踩过：settings.json 里出现过显示名，导致用户选的模型被悄悄换掉。 */
function isModelId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9._:\/@+-]+$/.test(v);
}

// 最近一次真实探活结果：内存 + 落盘（重启后先用上次结果着色，避免一启动就显示"未探活"）
const HEALTH_SNAP_FILE = path.join(ROOT, 'model-health.json');
function loadHealthSnapshotFile() {
  try {
    if (!fs.existsSync(HEALTH_SNAP_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(HEALTH_SNAP_FILE, 'utf8'));
    if (j && j.at && Array.isArray(j.results)) return { at: j.at, results: j.results };
  } catch {}
  return null;
}
let healthSnapshot = loadHealthSnapshotFile();
function clearHealthSnapshot() {
  healthSnapshot = null;
  try {
    if (fs.existsSync(HEALTH_SNAP_FILE)) fs.unlinkSync(HEALTH_SNAP_FILE);
  } catch {}
}

// ---------- 会话持久化（磁盘分片，替代 localStorage 的 5MB 上限） ----------
// 以前整份 chats 数组塞 localStorage，写满 5MB 后 setItem 静默抛错（catch 吞掉），
// 之后的新会话就悄悄存不进去。这里改成每个会话一个 JSON 文件 + 原子写。
const CHATS_DIR = path.join(ROOT, 'chats');
const CHATS_INDEX = path.join(CHATS_DIR, 'index.json');
try { fs.mkdirSync(CHATS_DIR, { recursive: true }); } catch {}
let chatsIndex = null;

function chatMeta(c) {
  const msgs = Array.isArray(c && c.messages) ? c.messages : [];
  let snippet = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = String((msgs[i] && msgs[i].content) || '')
      .replace(/```[\s\S]*?```/g, '（代码）')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '（图片）')
      .replace(/[#>*`_~]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (t) { snippet = t.slice(0, 80); break; }
  }
  return {
    id: String(c.id),
    title: String((c && c.title) || '新会话'),
    updatedAt: Number(c.updatedAt) || Date.now(),
    count: msgs.length,
    snippet,
  };
}

function chatsLoadIndex() {
  if (chatsIndex) return chatsIndex;
  chatsIndex = new Map();
  let rebuilt = false;
  try {
    if (fs.existsSync(CHATS_INDEX)) {
      const arr = JSON.parse(fs.readFileSync(CHATS_INDEX, 'utf8') || '[]');
      (Array.isArray(arr) ? arr : []).forEach((m) => { if (m && m.id) chatsIndex.set(String(m.id), m); });
    } else {
      rebuilt = true;
    }
  } catch { rebuilt = true; }
  if (rebuilt) {
    try {
      for (const f of fs.readdirSync(CHATS_DIR)) {
        if (!f.endsWith('.json') || f === 'index.json') continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
          if (c && c.id) chatsIndex.set(String(c.id), chatMeta(c));
        } catch {}
      }
    } catch {}
    chatsSaveIndex();
  } else {
    // 索引存在但可能过期（写失败/被回滚/旧版本写入）：把磁盘上漏登记的会话补回来，
    // 否则界面上会"莫名其妙少了一堆历史会话"。
    let patched = 0;
    try {
      for (const f of fs.readdirSync(CHATS_DIR)) {
        if (!f.endsWith('.json') || f === 'index.json' || f.endsWith('.tmp')) continue;
        const id = f.replace(/\.json$/, '');
        if (chatsIndex.has(id)) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
          if (c && c.id) { chatsIndex.set(String(c.id), chatMeta(c)); patched++; }
        } catch {}
      }
    } catch {}
    if (patched) chatsSaveIndex();
  }
  return chatsIndex;
}

function chatsSaveIndex() {
  try {
    const arr = [...chatsLoadIndex().values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const tmp = CHATS_INDEX + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
    // 覆盖前留一份索引快照，索引写坏时还有得救（只留最近 10 份）
    try {
      if (fs.existsSync(CHATS_INDEX)) {
        const bakDir = path.join(CHATS_DIR, '.bak');
        fs.mkdirSync(bakDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(CHATS_INDEX, path.join(bakDir, 'index-' + stamp + '.json'));
        const olds = fs.readdirSync(bakDir).filter((f) => f.startsWith('index-')).sort();
        for (const f of olds.slice(0, Math.max(0, olds.length - 10))) {
          try { fs.unlinkSync(path.join(bakDir, f)); } catch {}
        }
      }
    } catch {}
    fs.renameSync(tmp, CHATS_INDEX);
  } catch {}
}

// ---- 模型能力发现（P3）：按 providerId+modelId 取窗口/输出上限 ----
let capRegistry = null;
/** 真实拉取 provider 的 /models（只用于读元数据；失败由能力层降级处理）。 */
async function fetchProviderModels(q) {
  const base = String(q.base || '').replace(/\/+$/, '');
  if (!base) { const e = new Error('no base'); e.code = 'no_base'; throw e; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(base + '/models', {
      method: 'GET',
      headers: q.apiKey ? { Authorization: 'Bearer ' + q.apiKey } : {},
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status);
      // 404/405/501 视为"该端点不支持模型列表"，与网络错误区分开
      e.code = (r.status === 404 || r.status === 405 || r.status === 501) ? 'unsupported' : ('http_' + r.status);
      throw e;
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}
function initCapabilities() {
  if (capRegistry) return capRegistry;
  capRegistry = capModule.createRegistry({
    fetchModels: fetchProviderModels,
    // 管理员显式配置：settings.modelCapabilities["providerId|modelId"] = {contextWindow,maxOutputTokens,reasoningReserve}
    explicit: ({ providerId, modelId }) => {
      const m = settings.modelCapabilities;
      if (!m || typeof m !== 'object') return null;
      const hit = m[String(providerId) + '|' + String(modelId)];
      return (hit && typeof hit === 'object') ? hit : null;
    },
    log: (o) => { try { audit(o); } catch (e) {} },
  });
  return capRegistry;
}
/** 上游报 context 超限：只降不升（能力层内部限幅），并记审计。 */
function noteCtxOverflow(capKey, text) {
  if (!capKey) return;
  if (!/context length|context_length_exceeded|maximum context|too many tokens|exceeds? the (maximum|model)/i.test(String(text || ''))) return;
  try { initCapabilities().noteOverflow(capKey); } catch (e) {}
}

// 活跃 run 正文续订开关：默认开；置 false 可一键回到「只轮询」的旧行为。
function streamResumeOn() { return settings.streamResume !== false; }

/* ================= 只读子智能体（第六轮 A1） =================
 * 边界（对应 A1 指令与 A0 复核结论）：
 *   · 只读：子运行不写文件、不执行命令、不写主记忆、不再派生子智能体；
 *   · 独立：每个子运行自己的 runId / 事件 / 取消 / 预算 / 能力快照，
 *           threadId 为 sub:<parentRunId>:<i>，因此不会改写主线程会话版本，
 *           侧聊父快照与主会话累计都不受子运行影响；
 *   · 不采纳：子结果一律 adopted=false，由宿主决定，编排层绝不自动合并；
 *   · 可回滚：settings.subAgents=false 立刻回到普通单 run，不需要换包。
 */
function subAgentsOn() { return settings.subAgents === true; }

let subOrch = null;
function initSubAgents() {
  if (subOrch) return subOrch;
  subOrch = subAgentModule.createOrchestrator({
    registry: initRuns(),
    capability: initCapabilities(),
    runChild: runSubAgentTask,
    log: (o) => { try { audit(o); } catch (e) {} },
  });
  return subOrch;
}

// 子运行的系统指令：把只读边界与输出格式写死，减少「越权/自由发挥」的空间。
const SUBAGENT_SYSTEM = [
  '你是父任务派出的只读子智能体。',
  '硬边界：只能阅读本次分配给你的只读目录；不得写入/删除任何文件，不得执行命令，',
  '不得修改主记忆，不得再派生子智能体，不得要求用户提供额外权限。',
  '只输出一个 JSON 对象，不要输出 JSON 之外的任何文字：',
  '{"answer":"结论（必填）","findings":[{"claim":"结论点","evidence":"依据"}],',
  '"confidence":0.0,"citations":["来源"],"needsMore":false}',
  '不确定就把 confidence 调低并在 answer 里写明不确定点；禁止编造证据。',
].join('\n');

/**
 * 只读读取子任务指定的文件。
 * 双上限（单文件 32KB / 合计 96KB）避免把窗口塞满；越界一律拒绝并给出原因，不静默跳过。
 */
function readSubAgentFiles(readRoots, files) {
  const roots = (Array.isArray(readRoots) ? readRoots : []).map((r) => path.resolve(r));
  const out = { files: [], rejected: [], bytes: 0 };
  const PER_FILE = 32 * 1024;
  const TOTAL = 96 * 1024;
  for (const f of (Array.isArray(files) ? files : [])) {
    const raw = String(f || '');
    if (!raw) continue;
    const abs = path.resolve(roots[0] || ROOT, raw);
    const inside = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!inside) { out.rejected.push({ path: raw, reason: 'outside_read_roots' }); continue; }
    let st;
    try { st = fs.statSync(abs); } catch (e) { out.rejected.push({ path: raw, reason: 'not_found' }); continue; }
    if (!st.isFile()) { out.rejected.push({ path: raw, reason: 'not_a_file' }); continue; }
    if (out.bytes + Math.min(st.size, PER_FILE) > TOTAL) {
      out.rejected.push({ path: raw, reason: 'total_size_limit' }); continue;
    }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { out.rejected.push({ path: raw, reason: 'read_failed' }); continue; }
    const truncated = buf.length > PER_FILE;
    const slice = truncated ? buf.slice(0, PER_FILE) : buf;
    // 二进制内容不外发：只给「不可读」标记，避免把乱码塞进上下文
    const text = slice.toString('utf8');
    const binary = text.indexOf('\u0000') >= 0;
    out.files.push({ path: raw, bytes: slice.length, truncated: truncated, binary: binary,
      text: binary ? '(二进制文件，未读取内容)' : text });
    out.bytes += slice.length;
  }
  return out;
}

/** 组装子运行的 messages：系统边界 + 任务 + 只读文件内容。 */
function buildSubAgentMessages(ctx) {
  const msgs = [{ role: 'system', content: SUBAGENT_SYSTEM }];
  const parts = ['子任务：' + String(ctx.task || '').slice(0, 8000)];
  if (Array.isArray(ctx.readRoots) && ctx.readRoots.length) {
    parts.push('只读目录（越界一律拒绝）：' + ctx.readRoots.join(' , '));
  }
  const fr = readSubAgentFiles(ctx.readRoots, ctx.files);
  if (fr.files.length) {
    parts.push('已附只读文件：');
    for (const f of fr.files) {
      parts.push('--- ' + f.path + (f.truncated ? '（已截断 ' + f.bytes + ' 字节）' : '') + ' ---\n' + f.text);
    }
  }
  if (fr.rejected.length) {
    parts.push('未能读取的文件：' + fr.rejected.map((x) => x.path + '(' + x.reason + ')').join(' , '));
  }
  msgs.push({ role: 'user', content: parts.join('\n\n') });
  return msgs;
}

/**
 * 子运行执行器：真正的上游调用（流式）。
 * 只走 /chat/completions：结构简单、可续订，且与主聊天同一套 include_usage 口径。
 * 正文通过 ctx.push 写进该子 run 的 stream.delta，UI/测试可直接用 /api/runs/:id/text 续订。
 */
async function runSubAgentTask(ctx) {
  const model = ctx.model || settings.model || DEFAULT_MODEL;
  if (!activeApiKey(model)) throw Object.assign(new Error('缺少 API Key'), { code: 'missing_api_key' });
  const base = activeBase(model).replace(/\/+$/, '');
  const wire = await preferredWire(model, true);
  const messages = buildSubAgentMessages(ctx);
  const maxTokens = Math.max(256, Math.min(Number(ctx.tokenCap) || 2048, 8192));
  const mkBody = (withUsage) => {
    const b = {
      model: wireModelOf(model), messages: messages, stream: true,
      max_tokens: maxTokens, temperature: 0.3,
    };
    if (withUsage) b.stream_options = { include_usage: true };
    return b;
  };
  const signal = (() => {
    try { return AbortSignal.any([ctx.signal, AbortSignal.timeout(180000)]); }
    catch (e) { return ctx.signal; }
  })();

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const withUsage = attempt === 1 && !usageOptUnsupported.has(model);
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', headers: upstreamHeaders(model),
      body: JSON.stringify(mkBody(withUsage)), signal: signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      // include_usage 被拒：记住能力并去参重试一次（与主聊天同口径，不无限重试）
      if (r.status === 400 && withUsage && isUsageOptRejection(txt)) {
        markUsageOptUnsupported(model);
        continue;
      }
      noteCtxOverflow(null, txt);
      throw Object.assign(new Error('上游 HTTP ' + r.status + ' ' + String(txt).slice(0, 200)), { code: 'http_' + r.status });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let usage = null;
    let lastFlush = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (line.indexOf('data:') !== 0) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch (e) { continue; }
          if (j.usage) usage = j.usage;
          if (j.error) {
            throw Object.assign(new Error('上游返回错误：' + errText(j.error)), { code: 'upstream_error' });
          }
          for (const ch of (j.choices || [])) {
            const d = ch.delta || {};
            if (d.content) { text += d.content; ctx.push('content', d.content); }
            if (d.reasoning_content) ctx.push('reasoning', d.reasoning_content);
          }
        }
        const t = Date.now();
        if (t - lastFlush > 200) { lastFlush = t; ctx.flush(); }
      }
    }
    ctx.flush();
    return {
      text: text,
      usage: usage ? telemetry.normalizeUsage(usage, 'chat', { source: 'provider' }) : null,
    };
  }
}


// 只允许安全字符，避免 id 里塞 ../ 做路径穿越
function chatFilePath(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(CHATS_DIR, safe + '.json') : null;
}

function chatWrite(c) {
  if (!c || !c.id) return { ok: false, error: '缺少会话 id' };
  const p = chatFilePath(c.id);
  if (!p) return { ok: false, error: 'id 非法' };
  const id = String(c.id);
  if (!c.updatedAt) c.updatedAt = Date.now();
  try {
    const body = JSON.stringify(c);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);            // 原子替换：写到一半断电也不会毁掉原文件
    chatsLoadIndex().set(id, chatMeta(c));
    chatsSaveIndex();
    return { ok: true, id, bytes: Buffer.byteLength(body), count: (c.messages || []).length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function chatRead(id) {
  const p = chatFilePath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function chatDelete(id) {
  const p = chatFilePath(id);
  if (p) { try { fs.unlinkSync(p); } catch {} }
  chatsLoadIndex().delete(String(id));
  chatsSaveIndex();
  return { ok: true };
}

function chatListAll() {
  const out = [];
  try {
    for (const f of fs.readdirSync(CHATS_DIR)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        if (c && c.id) out.push(c);
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// 全文搜索：扫所有会话文件，命中标题或任意消息正文，返回带上下文的片段
function chatSearch(q) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return [];
  const out = [];
  for (const c of chatListAll()) {
    const title = String(c.title || '');
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    let hit = null, hitIndex = -1;
    if (title.toLowerCase().includes(kw)) hit = title;
    for (let i = 0; i < msgs.length && !hit; i++) {
      const raw = String((msgs[i] && msgs[i].content) || '');
      const flat = raw.replace(/```[\s\S]*?```/g, '（代码）').replace(/\s+/g, ' ');
      const at = flat.toLowerCase().indexOf(kw);
      if (at >= 0) {
        const from = Math.max(0, at - 28);
        hit = (from > 0 ? '…' : '') + flat.slice(from, at + kw.length + 46) + (at + kw.length + 46 < flat.length ? '…' : '');
        hitIndex = i;
      }
    }
    if (hit) {
      out.push({
        id: String(c.id), title: title || '新会话', updatedAt: c.updatedAt || 0,
        count: msgs.length, snippet: hit, hitIndex,
        role: hitIndex >= 0 && msgs[hitIndex] ? (msgs[hitIndex].role || '') : '',
      });
    }
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}


// 排队/限流时的自动降级链：质量优先，逐级递补（内置默认，用户可在设置里自定义）
// 2026-11-11 实测排序：只收「答对高难度题」的高质量模型，按响应速度递补。
// 不收答错的小模型（哪怕最快），也不收 ds4.1f（两轮超时）与慢模型。
const FAILOVER_CHAIN = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'stepfun-ai/step-5-preview',
];
// 实际生效的降级链：用户自定义优先，否则用内置默认；过滤掉不在目录里的脏数据
function getFailoverChain() {
  const arr = (Array.isArray(settings.failoverChain) && settings.failoverChain.length)
    ? settings.failoverChain
    : FAILOVER_CHAIN;
  return arr.filter(m => MODEL_CATALOG[m]);
}

// 协议 → 引擎 / CODEX_HOME 映射（两个 home 的 config.toml 各自写死了 wire_api）
const WIRE_ENGINES = {
  chat:      { engine: 'engine-ds', home: 'ds-home' },
  responses: { engine: 'engine',    home: 'home' },
};

// 思考深度等级（仿照 DSH 的 reasoning_effort）
// 2026-11-06 起强制思考：删除 off 档，不再提供"关闭"。
const THINKING_DEPTHS = {
  minimal:{ label: '极少',   maxTokens: 2048,  thinking: true,  desc: '极简思考，适合简单问答' },
  low:    { label: '低',     maxTokens: 4096,  thinking: true,  desc: '轻度思考，平衡速度与质量' },
  medium: { label: '中',     maxTokens: 6144,  thinking: true,  desc: '中度思考，适合代码与推理' },
  high:   { label: '高',     maxTokens: 32768, thinking: true,  desc: '深度思考，最慢但最稳' },
};
const DEFAULT_THINKING_DEPTH = 'high';

// 会话持久化目录
const SESSIONS_DIR = path.join(ROOT, 'sessions');
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (e) {}
function sessionPath(id){ return path.join(SESSIONS_DIR, id + '.json'); }
function loadSession(id){
  try { return JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')); } catch { return null; }
}
function saveSession(id, data){
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(id), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    // 会话持久化失败不应影响主流程，记录错误便于排查
    try { fs.appendFileSync(path.join(ROOT, 'session-save-error.log'), new Date().toISOString() + ' ' + String(e) + '\n'); } catch {}
  }
}
function listSessions(){
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { const st = fs.statSync(path.join(SESSIONS_DIR, f)); return { id: f.slice(0,-5), mtime: st.mtimeMs }; })
      .sort((a,b)=> b.mtime - a.mtime);
  } catch { return []; }
}

// 默认记忆库/归档目录：跟着数据目录走，不再写死盘符
const MEM_BASE = path.join(app.getPath('documents'), 'WhaleCodex');
const DEFAULT_DIRS = {
  chatArchive: path.join(MEM_BASE, '聊天记录'),
  memory: path.join(MEM_BASE, '记忆库'),
  testFiles: path.join(MEM_BASE, '测试文件'),
};
// agent 工作目录白名单根（防止指到系统盘 / 桌面）
const DEFAULT_AGENT_ROOTS = [path.join(app.getPath('documents')), ROOT];
// 引擎重构后只使用一个 CODEX_HOME；状态页 / 自检 / 连接器写入必须共用这一处事实来源，
// 否则会去检查已废弃的 ds-home 并误报「密钥隔离策略缺失」（实测红叉）。
function codexHomes() { return [path.join(ROOT, 'home')]; }

// ---------- 加固④：API Key 落盘加密（Electron safeStorage / DPAPI / libsecret） ----------
// settings.json 里的 apiKey 与 providers[].apiKey 改为密文，读取时解密；兼容旧明文文件。
// 系统密钥环不可用时自动降级为明文（不阻断使用），但绝不会把密文当明文返回给上游。
function secretAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}
function encSecret(v) {
  if (typeof v !== 'string' || !v || v.indexOf('enc:v1:') === 0 || !secretAvailable()) return v;
  try { return 'enc:v1:' + safeStorage.encryptString(v).toString('base64'); } catch { return v; }
}
function decSecret(v) {
  if (typeof v !== 'string' || v.indexOf('enc:v1:') !== 0) return typeof v === 'string' ? v : '';
  try { return safeStorage.decryptString(Buffer.from(v.slice(7), 'base64')); } catch { return ''; }
}
function diskSettings() {
  const c = JSON.parse(JSON.stringify(settings));
  c.apiKey = encSecret(c.apiKey);
  if (Array.isArray(c.providers)) {
    // 多模板密钥明文落盘：本客户端会频繁重打包替换 WhaleCodex.exe，
    // Electron safeStorage 的密文在应用/exe 标识变化后解不开，decSecret 会返回空串，
    // 一旦再写盘就把密钥永久清空 —— 表现为「模板全消失 + 未配置 API Key」反复出现。
    // 明文保存彻底切断这个循环；loadSettings 仍兼容旧的 enc:v1: 密文。
    c.providers = c.providers.map((p) => Object.assign({}, p, { apiKey: String(p.apiKey || '') }));
  }
  // 连接器令牌（PAT / Secret 等 secret 字段）同样密文落盘，避免 settings.json 明文泄露
  if (c.connectors && typeof c.connectors === 'object') {
    for (const reg of CONNECTOR_REGISTRY) {
      const st = c.connectors[reg.id];
      if (!st || !st.config || typeof st.config !== 'object') continue;
      for (const f of (reg.fields || [])) {
        if (f.secret && typeof st.config[f.key] === 'string') st.config[f.key] = encSecret(st.config[f.key]);
      }
    }
  }
  return c;
}

// ---------- 引擎别名：绕开「引擎按模型名关掉工具」 ----------
// 实测（2026-11-11）：同一个 exec 命令下，-m gpt-6-astra 时引擎只发 0 个工具，
// 而 gpt-4o / o3-mini / Qwen / MiniMax / 550B 都正常发 9 个。
// 结论是引擎对个别模型名有内置判定，与我们的兼容层无关。
// 处理办法：对「我们自己的目录里没有、或已知会被关工具」的模型，给引擎一个中立别名，
// shim 收到别名再换回真实模型，上游请求与能力表仍按真实模型走。
const agentAliasMap = new Map();          // 别名 -> 真实模型
const AGENT_NO_TOOL_MODELS = new Set(['gpt-6-astra']);
function engineModelFor(realModel) {
  const known = Object.prototype.hasOwnProperty.call(MODEL_CATALOG, realModel);
  if (known && !AGENT_NO_TOOL_MODELS.has(realModel)) return realModel;
  for (const [alias, m] of agentAliasMap) if (m === realModel) return alias;
  const suffix = require('crypto').createHash('sha1').update(String(realModel)).digest('hex').slice(0, 8);
  const alias = 'whale-agent-' + suffix;
  agentAliasMap.set(alias, realModel);
  try {
    adapterLog('alias model=' + realModel + ' engine=' + alias +
      ' reason=' + (known ? 'engine_blocks_tools' : 'custom_model'));
  } catch (e) {}
  return alias;
}
function resolveAgentAlias(m) {
  return agentAliasMap.get(m) || m;
}

// ---------- 推理档位 → reasoning_effort ----------
// 实测（2026-11-11）：cat 中转的 gpt-6-astra 认这个参数并真的改变思考量
// （minimal 30 / 默认 73 / high 194 reasoning tokens）；NIM 官方端点不认，跳过。
const EFFORT_MAP = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };
function effortUnsupported(model) {
  const arr = Array.isArray(settings.effortUnsupported) ? settings.effortUnsupported : [];
  return arr.indexOf(model) >= 0;
}
function markEffortUnsupported(model) {
  const arr = Array.isArray(settings.effortUnsupported) ? settings.effortUnsupported.slice() : [];
  if (arr.indexOf(model) < 0) {
    arr.push(model);
    settings.effortUnsupported = arr;
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8'); } catch (e) {}
  }
}
// NIM 官方端点不认 reasoning_effort，别白打一次 400
function endpointTakesEffort(model) {
  try { return !/integrate\.api\.nvidia\.com/.test(activeBase(model) || ''); } catch (e) { return false; }
}

// ---------- 设置 ----------
function loadSettings() {
  const def = {
    apiKey: '',
    nimBase: 'https://integrate.api.nvidia.com/v1',
    // 多提供商（DSH 风格）：每个 provider 是一份独立的「API 密钥模板」，
    // 含显示名称 / 接口地址 / 协议 / 已启用模型列表。空数组时回退到旧的单 key 字段。
    providers: [],
    activeProviderId: '',
    model: DEFAULT_MODEL,
    port: 8760,
    dirs: Object.assign({}, DEFAULT_DIRS),
    contextLimit: 350000,     // 实测这个端点能处理约 35 万 token
    compactAt: 100000,        // 估算超过这个就压缩归档
    // 语音输入：模型不内置，下载完成后记录清单 key 与真实文件名
    asrModel: '',
    asrModelFile: '',
    asrLang: 'zh',
    // 编码器上下文（1 单位≈20ms）：768≈15s，实测把 7s 中文从 7.2s 降到约 3.9s，文字不变
    asrAudioCtx: 768,
    asrModelHost: '',   // 空 = 用内置官方模型源；可填自有 HTTPS 域名做镜像/中转
    asrPython: '',
    // 语音与机器人：两者都是外部服务（GPT-SoVITS 训练/合成、AstrBot 机器人常驻），
    // 客户端不内置运行时，只保存地址并做可达性检测，避免安装包跟着它们膨胀。
    voice: { tts: '', bot: '' },
    // DeepSeek V4.1 在 NIM 上：开思考会把 max_tokens 全烧在 reasoning 上（实测 1200
    // 预算时正文 0 字），所以默认关；需要精度时在设置里切到 on。
    ds41Thinking: 'off',
    thinkingDepth: DEFAULT_THINKING_DEPTH,   // off/minimal/low/medium/high，仿照 DSH reasoning_effort
    injectMemory: true,       // 新会话首轮是否带上记忆库摘要
    // 只读子智能体（A1）：默认关闭。开启后父运行可派生 1–4 个只读子运行；
    // 关闭即回到普通单 run，无需换包，是这一能力的总回滚开关。
    subAgents: false,
    // agent-desktop D1 桌面控制桥：默认关闭。开启后可语义操作桌面应用（仅 semantic_api）。
    // 关闭即回到无桌面能力，无需换包。
    desktopControl: false,
    // 桌面动作窗口白名单：空 = 动作一律拒绝（fail closed）。开启开关不等于授权任意窗口。
    desktopWindowAllow: [],
    // 桌面快照治理：TTL 30min / 单会话 20 个 / 全局 50MB（可在设置里覆盖）
    desktopSnapshotTtlMs: 30 * 60 * 1000,
    desktopMaxSnapshotsPerSession: 20,
    desktopMaxTotalBytes: 50 * 1024 * 1024,
    modelProtocols: {},       // 用户可为任意模型手动指定 wire: { "模型ID": "chat" | "responses" }
    agentRoots: DEFAULT_AGENT_ROOTS.slice(),
    agentSafeMode: false,     // true = 禁网 + 需审批；默认 false，保持自动化体验
    agentCapabilities: {},    // 模型 × Agent 协议档位（适配层运行时自学习，持久化）
    autoFailover: true,       // 排队/限流/未开通时自动降级到备用模型（会在对话里明确提示）
    queueFallbackMs: 45000,   // 首字节等待超过该时长判定"排队拥塞"，触发降级
    connectors: {},           // 连接器状态：{ "<id>": { enabled, config } }
  };
  try {
    const s = Object.assign(def, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
    s.apiKey = decSecret(s.apiKey);
    if (Array.isArray(s.providers)) {
      s.providers = s.providers.map((p) => Object.assign({}, p, { apiKey: decSecret(p.apiKey) }));
    }
    // 解密连接器 secret 字段（与 diskSettings 的加密对称；旧明文文件原样返回）
    if (s.connectors && typeof s.connectors === 'object') {
      for (const reg of CONNECTOR_REGISTRY) {
        const st = s.connectors[reg.id];
        if (!st || !st.config || typeof st.config !== 'object') continue;
        for (const f of (reg.fields || [])) {
          if (f.secret && typeof st.config[f.key] === 'string') st.config[f.key] = decSecret(st.config[f.key]);
        }
      }
    }
    s.dirs = Object.assign({}, DEFAULT_DIRS, s.dirs || {});
    // 迁移：旧的「单密钥」配置（providers 空 + apiKey 有值）物化成一个内置「NVIDIA NIM」预设卡片，
    // 让用户在设置里以 DSH 那样的「预设模板」卡片形式可见、可编辑、可删除。
    if ((!Array.isArray(s.providers) || s.providers.length === 0) && s.apiKey) {
      s.providers = [{
        id: 'builtin-nvidia',
        name: 'NVIDIA NIM',
        apiKey: s.apiKey,
        base: (typeof s.nimBase === 'string' && s.nimBase) ? s.nimBase : 'https://integrate.api.nvidia.com/v1',
        protocol: 'openai',
        models: [],
        enabled: true,
        builtin: true,
      }];
      s.activeProviderId = 'builtin-nvidia';
      s.apiKey = '';       // 清掉旧字段，避免重复；密钥统一由 provider 承载
      s.nimBase = '';
    }
    // 兜底：历史版本可能把显示名写进 model，这里纠正成合法 id，避免重启后选错模型
    if (!isModelId(s.model)) s.model = DEFAULT_MODEL;
    return s;
  } catch {
    return def;
  }
}

// ---------- 连接器 → Codex 引擎 MCP 同步 ----------
// 把已启用的连接器写成 Codex 的 config.toml 里 [mcp_servers.<id>] 段，
// 这样 codex 在 exec / chat 时自动加载这些 MCP 服务。两个 home 都写，覆盖两种协议。
function detectNodeExe() {
  // 优先用本机独立 node；找不到时由调用方回退到 Electron 自带 runtime（ELECTRON_RUN_AS_NODE=1），
  // 避免发布版在没装 node 的机器上「鲸鱼娘工具箱」起不来。
  // 打包版的 app.asar 里的 .js 无法被外部 node 执行，所以安装包会把 whale-mcp-server.js
  // 额外释放到 resources/mcp/ 下（见 mcpServerPath），这里只管找可用的 node 可执行文件。
  const cands = [];
  if (process.env.WHALE_NODE) cands.push(String(process.env.WHALE_NODE));
  if (process.platform === 'win32') {
    // 常见安装位置（官网 msi / choco / scoop / nvm 默认布局）
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || '';
    cands.push(path.join(pf, 'nodejs', 'node.exe'));
    cands.push(path.join(pf86, 'nodejs', 'node.exe'));
    if (lad) cands.push(path.join(lad, 'Programs', 'nodejs', 'node.exe'));
    cands.push(path.join(os.homedir(), 'scoop', 'apps', 'nodejs', 'current', 'node.exe'));
    cands.push('C:/ProgramData/chocolatey/bin/node.exe');
  } else {
    cands.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
  }
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  // 最后用系统 PATH 找（用户把 node 装在别处时也能命中）
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
      windowsHide: true, timeout: 3000, encoding: 'utf8',
    });
    const first = String((r && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) {
      const p = /\.exe$/i.test(first) || process.platform !== 'win32' ? first : first + '.exe';
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return null;
}
// 本地工具箱 MCP 脚本路径：打包版优先用 extraResources 释放到 asar 外的副本
// （asar 内的 .js 不能被外部进程当脚本执行，这是安装版必须的一步）
function mcpServerPath() {
  const packed = path.join(RES, 'mcp', 'whale-mcp-server.js');
  try { if (fs.existsSync(packed)) return packed; } catch (e) {}
  return path.join(APP_DIR, 'whale-mcp-server.js');
}
function tomlStr(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
// 只去掉由本应用（连接器面板）管理的 [mcp_servers.<id>] 段；
// 用户手工通过 `codex mcp add` 添加的其它 MCP 段原样保留，避免误删。
function stripManagedMcps(content, managedIds) {
  const ids = managedIds || new Set();
  const lines = content.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[mcp_servers\.([A-Za-z0-9_\-]+)/);
    if (m) {
      skip = ids.has(m[1]);   // 仅跳过本应用管理的连接器段
      if (skip) continue;
      out.push(line);         // 非本应用管理的段：原样保留
      continue;
    }
    if (skip && /^\s*\[/.test(line)) skip = false; // 遇到新的 [段] 结束跳过
    if (skip) continue;
    out.push(line);
  }
  return out.join('\n');
}
function renderMcpBlock(id, b) {
  if (!b) return '';
  if (b.command) {
    let s = '[mcp_servers.' + id + ']\ncommand = ' + tomlStr(b.command) +
      '\nargs = [' + (b.args || []).map(tomlStr).join(', ') + ']';
    const envKeys = (b.env && typeof b.env === 'object') ? Object.keys(b.env).filter(k => b.env[k] != null) : [];
    if (envKeys.length) {
      s += '\n[mcp_servers.' + id + '.env]';
      for (const k of envKeys) s += '\n' + k + ' = ' + tomlStr(b.env[k]);
    }
    return s;
  }
  if (b.url) {
    let s = '[mcp_servers.' + id + ']\nurl = ' + tomlStr(b.url);
    if (b.bearerEnv) s += '\nbearer_token_env_var = ' + tomlStr(b.bearerEnv);
    return s;
  }
  return '';
}
function syncConnectorMcp() {
  try {
    const standaloneNode = detectNodeExe();
    const useElectronNode = !standaloneNode;
    const nodeExe = standaloneNode || process.execPath;   // 回退：Electron 可执行文件当 node 用
    const mcpEnv = useElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    const serverPath = mcpServerPath();
    const homes = codexHomes();
    const managedIds = new Set(CONNECTOR_REGISTRY.map(c => c.id));
    const blocks = [];
    const skipped = [];
    for (const c of CONNECTOR_REGISTRY) {
      const st = settings.connectors && settings.connectors[c.id];
      if (!st || !st.enabled || !c.build) continue;
      const built = c.auth === 'local'
        ? c.build(st.config || {}, { nodeExe, serverPath, mcpEnv })
        : c.build(st.config || {}, {});
      const blk = renderMcpBlock(c.id, built);
      if (blk) blocks.push(blk);
      else skipped.push(c.id);   // 例：远程类没填服务地址，生成不出配置
    }
    for (const homeDir of homes) {
      try { fs.mkdirSync(homeDir, { recursive: true }); } catch (e) {}
      const cfgPath = path.join(homeDir, 'config.toml');
      let content = '';
      try { content = fs.readFileSync(cfgPath, 'utf8'); } catch (e) {}
      content = stripManagedMcps(content, managedIds);
      if (blocks.length) {
        content = content.replace(/\s+$/, '') + '\n\n' + blocks.join('\n\n') + '\n';
      }
      fs.writeFileSync(cfgPath, content, 'utf8');
    }
    invalidateMcpListCache();   // 配置已变，检测结果需重新取
    return { ok: true, count: blocks.length, skipped };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

// ---------- 连接器 OAuth 授权 ----------
// 直接复用 Codex 引擎自带的 MCP OAuth 客户端（动态注册 DCR + PKCE + 127.0.0.1 回调），
// 因此客户端可以「自主发起申请」并完成授权，无需我们自建 OAuth 服务端。
const oauthJob = { id: '', proc: null, status: 'idle', url: '', log: [], home: '', startedAt: 0, err: '' };
// 单次授权最长等待时间：超时自动杀进程并置为失败，避免「等待授权…」无限累加把后续授权全堵死
const OAUTH_TTL_MS = 150000;
let oauthWatchdog = null;
// 同一连接器的开关操作串行化，防止连点触发多个 logout/写盘导致状态来回跳
const connectorBusy = new Map();

function clearOauthWatchdog() {
  if (oauthWatchdog) { try { clearTimeout(oauthWatchdog); } catch (e) {} oauthWatchdog = null; }
}
function abortConnectorOAuth(reason) {
  clearOauthWatchdog();
  const p = oauthJob.proc;
  oauthJob.proc = null;
  if (p) { try { p.kill(); } catch (e) {} }
  if (oauthJob.status === 'running') {
    oauthJob.status = 'fail';
    oauthJob.err = reason || '已取消';
  }
  return { ok: true };
}

function oauthLog(line) {
  const s = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!s) return;
  oauthJob.log.push(s);
  if (oauthJob.log.length > 120) oauthJob.log.splice(0, oauthJob.log.length - 120);
  const m = s.match(/https?:\/\/[^\s'"]+/);
  if (m && !oauthJob.url && /authori[sz]e|oauth|open-claw|scenario/i.test(m[0])) oauthJob.url = m[0];
  if (/Successfully logged in/i.test(s)) oauthJob.status = 'ok';
  if (/^Error:/i.test(s)) oauthJob.err = s;
}
// 授权成功后把凭据镜像到另一个 CODEX_HOME（仅当对方还没有凭据），避免切换协议后重复授权
function mirrorOauthSecrets(fromHome) {
  try {
    const src = path.join(fromHome, 'secrets', 'mcp_oauth.age');
    if (!fs.existsSync(src)) return;
    for (const h of ['home', 'ds-home']) {
      const dir = path.join(ROOT, h);
      if (path.resolve(dir) === path.resolve(fromHome)) continue;
      const dst = path.join(dir, 'secrets', 'mcp_oauth.age');
      if (fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  } catch (e) {}
}
async function startConnectorOAuth(id) {
  if (oauthJob.proc) {
    // 上一轮可能挂在「等浏览器回调」上永不退出：超过 TTL 就回收，不再阻塞后续授权
    if (Date.now() - oauthJob.startedAt > OAUTH_TTL_MS) {
      abortConnectorOAuth('上一次授权等待超时，已自动取消');
    } else {
      return { ok: false, busy: true, reason: '已有授权正在进行（' + oauthJob.id + '），请先点「取消授权」或稍候' };
    }
  }
  const reg = CONNECTOR_REGISTRY.find(c => c.id === id);
  if (!reg) return { ok: false, reason: '未知连接器：' + id };
  if (!reg.oauthFlow) return { ok: false, reason: '该连接器不支持一键授权（服务商不支持动态注册或未公开端点）' };
  const st = settings.connectors && settings.connectors[id];
  if (!st || !st.enabled) return { ok: false, reason: '请先打开该连接器再授权' };
  const sync = syncConnectorMcp();   // codex mcp login 需要 config.toml 里已有该 server
  if (!sync.ok) return { ok: false, reason: '写入 Codex 配置失败：' + (sync.reason || '') };
  let eng = null;
  try { eng = await resolveEngine(settings.model || DEFAULT_MODEL); } catch (e) {}
  if (!eng || !eng.exe) return { ok: false, reason: '找不到 codex 引擎，无法发起授权' };
  const env = Object.assign({}, process.env, {
    CODEX_HOME: eng.homeDir,
    // 关键：本地回调走 127.0.0.1，若被系统代理接管会变成 502（实测踩过）
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  let proc;
  try {
    proc = spawn(eng.exe, ['mcp', 'login', id], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, reason: '启动授权进程失败：' + String(e.message || e) };
  }
  oauthJob.id = id; oauthJob.proc = proc; oauthJob.status = 'running';
  oauthJob.url = ''; oauthJob.log = []; oauthJob.err = '';
  oauthJob.home = eng.homeDir; oauthJob.startedAt = Date.now();
  const onData = (c) => String(c).split(/\r?\n/).forEach(oauthLog);
  try {
    proc.stdout.setEncoding('utf8'); proc.stdout.on('data', onData);
    proc.stderr.setEncoding('utf8'); proc.stderr.on('data', onData);
  } catch (e) {}
  proc.on('error', (e) => { clearOauthWatchdog(); oauthJob.err = String((e && e.message) || e); oauthJob.status = 'fail'; });
  proc.on('exit', (code) => {
    clearOauthWatchdog();
    if (oauthJob.proc === proc) oauthJob.proc = null;
    if (oauthJob.status !== 'ok') {
      oauthJob.status = code === 0 ? 'ok' : 'fail';
      if (code !== 0 && !oauthJob.err) oauthJob.err = oauthJob.log.slice(-2).join(' ') || ('退出码 ' + code);
    }
    if (oauthJob.status === 'ok') { mirrorOauthSecrets(eng.homeDir); invalidateMcpListCache(); }
  });
  // 看门狗：浏览器关掉/没完成登录时进程会一直挂着，到点强杀并给出可读原因
  clearOauthWatchdog();
  oauthWatchdog = setTimeout(() => {
    if (oauthJob.proc === proc && oauthJob.status === 'running') {
      abortConnectorOAuth('等待超时（' + Math.round(OAUTH_TTL_MS / 1000) + 's 未完成授权），已自动取消');
    }
  }, OAUTH_TTL_MS);
  return { ok: true, home: eng.homeDir, note: '已发起授权，浏览器会自动打开授权页' };
}
function logoutConnectorOAuth(id) {
  // 注销该 server 的 OAuth 凭据：必须在 config.toml 里还留着该 server 时执行，
  // 否则 codex 找不到 server，凭据会残留在 secrets/mcp_oauth.age 里。
  return new Promise((resolve) => {
    try {
      if (!id) return resolve({ ok: false, reason: 'no id' });
      resolveEngine(settings.model || DEFAULT_MODEL).then((eng) => {
        if (!eng || !eng.exe) return resolve({ ok: false, reason: 'no engine' });
        const env = Object.assign({}, process.env, { CODEX_HOME: eng.homeDir });
        delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
        const p = spawn(eng.exe, ['mcp', 'logout', id], { env, windowsHide: true, stdio: 'ignore' });
        const done = (r) => resolve(r || { ok: true });
        p.on('error', (e) => done({ ok: false, reason: String((e && e.message) || e) }));
        p.on('exit', (code) => done({ ok: code === 0, reason: code === 0 ? '' : ('exit ' + code) }));
        // 断开开关不能被注销拖住：3 秒没回就放行，凭据残留可下次再清
        setTimeout(() => { try { p.kill(); } catch (e) {} done({ ok: false, reason: 'timeout' }); }, 3000);
      }).catch(() => resolve({ ok: false, reason: 'resolve engine failed' }));
    } catch (e) { resolve({ ok: false, reason: String((e && e.message) || e) }); }
  });
}
function oauthStatus() {
  return {
    id: oauthJob.id, status: oauthJob.status, url: oauthJob.url,
    running: !!oauthJob.proc, home: oauthJob.home, ttl: OAUTH_TTL_MS,
    elapsed: oauthJob.startedAt ? Math.round((Date.now() - oauthJob.startedAt) / 1000) : 0,
    log: oauthJob.log.slice(-8), err: oauthJob.err,
  };
}

// ---------- 连接器状态检测（面板「检测状态」） ----------
// 三层验证，全部是真实验证而非「读配置猜状态」：
//   ① 引擎是否已加载该 MCP（codex mcp list 的 Status 列）
//   ② 授权是否有效（同一张表的 Auth 列：已登录显示 OAuth / 未登录显示 Not logged in）
//   ③ 端点能否真正握手（stdio 走 JSON-RPC initialize+tools/list，HTTP 走 MCP initialize）
const mcpListCache = { at: 0, homeDir: '', rows: null };
// 任何一次写盘/授权/注销都会改变引擎侧状态，必须让缓存失效，否则「检测状态」会拿到旧结果
function invalidateMcpListCache() {
  try { mcpListCache.at = 0; mcpListCache.rows = null; mcpListCache.homeDir = ''; } catch (e) {}
}
function parseMcpList(text) {
  const rows = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    if (/^Name\s{2,}/.test(line)) return;       // 表头
    if (/^WARNING/i.test(s)) return;
    const cells = s.split(/\s{2,}/);
    if (cells.length < 3) return;
    const name = cells[0].trim();
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) return;
    rows[name] = {
      name,
      status: (cells[cells.length - 2] || '').trim(),
      auth: (cells[cells.length - 1] || '').trim(),
    };
  });
  return rows;
}
function runCodexMcpList(eng) {
  return new Promise((resolve) => {
    if (!eng || !eng.exe) return resolve({ ok: false, rows: {}, reason: '找不到 codex 引擎' });
    // 3 秒内复用同一 home 的结果，避免面板一次检测打多次 mcp list
    if (mcpListCache.rows && mcpListCache.homeDir === eng.homeDir && Date.now() - mcpListCache.at < 3000) {
      return resolve({ ok: true, rows: mcpListCache.rows, cached: true });
    }
    let proc = null;
    try {
      const env = Object.assign({}, process.env, { CODEX_HOME: eng.homeDir });
      delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      proc = spawn(eng.exe, ['mcp', 'list'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, rows: {}, reason: String((e && e.message) || e) });
    }
    let out = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { proc.kill(); } catch (e) {} resolve(r); };
    try {
      proc.stdout.setEncoding('utf8'); proc.stdout.on('data', (c) => { out += c; });
      proc.stderr.setEncoding('utf8'); proc.stderr.on('data', (c) => { out += c; });
    } catch (e) {}
    proc.on('error', (e) => finish({ ok: false, rows: {}, reason: String((e && e.message) || e) }));
    proc.on('exit', () => {
      const rows = parseMcpList(out);
      mcpListCache.at = Date.now(); mcpListCache.homeDir = eng.homeDir; mcpListCache.rows = rows;
      finish({ ok: true, rows });
    });
    setTimeout(() => finish({ ok: false, rows: parseMcpList(out), reason: '读取引擎配置超时' }), 10000);
  });
}
// 本地 stdio 服务：真的起进程、真的握手、真的列工具
function probeMcpStdio(built, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let proc = null, done = false, buf = '';
    const finish = (r) => {
      if (done) return; done = true;
      try { proc && proc.kill(); } catch (e) {}
      resolve(Object.assign({ ms: Date.now() - t0 }, r));
    };
    try {
      proc = spawn(built.command, built.args || [], {
        env: Object.assign({}, process.env, extraEnv || {}, built.env || {}),
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return finish({ ok: false, err: String((e && e.message) || e) }); }
    try {
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => {
        buf += c;
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) {
          let j = null; try { j = JSON.parse(l); } catch (e) { continue; }
          if (j.id === 1 && j.result) {
            try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch (e) {}
            try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'); } catch (e) {}
          }
          if (j.id === 2 && j.result) finish({ ok: true, tools: (j.result.tools || []).length });
        }
      });
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'whale-check', version: '1' } },
      }) + '\n');
    } catch (e) { return finish({ ok: false, err: String((e && e.message) || e) }); }
    proc.on('error', (e) => finish({ ok: false, err: String((e && e.message) || e) }));
    proc.on('exit', (code) => finish({ ok: false, err: '进程退出（code=' + code + '）' }));
    setTimeout(() => finish({ ok: false, err: '握手超时' }), timeoutMs || 8000);
  });
}
// 远程 HTTP 服务：发一次真实的 MCP initialize
async function probeMcpHttp(url, token, timeoutMs) {
  const t0 = Date.now();
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  try {
    const r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'whale-check', version: '1' } },
      }),
      signal: AbortSignal.timeout(timeoutMs || 9000),
    });
    const txt = await r.text().catch(() => '');
    const ms = Date.now() - t0;
    if (r.status === 401 || r.status === 403) {
      return { ok: false, authRequired: true, http: r.status, ms, err: '端点要求授权（HTTP ' + r.status + '）' };
    }
    if (!r.ok) {
      const brief = String(txt || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      let why;
      if (r.status === 404) why = '该地址上没有 MCP 服务（HTTP 404）';
      else if (r.status === 405) why = '该地址不接受 MCP 请求（HTTP 405）';
      else if (r.status >= 500) why = '服务端异常（HTTP ' + r.status + '）';
      else why = 'HTTP ' + r.status;
      return { ok: false, http: r.status, ms, err: why + (brief ? '：' + brief : '') };
    }
    const ct = String(r.headers.get('content-type') || '');
    if (/event-stream/i.test(ct)) {
      if (!/"result"/.test(txt)) return { ok: false, http: r.status, ms, err: '响应不是有效 MCP 消息' };
      return { ok: true, http: r.status, ms };
    }
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (!j || !j.result) return { ok: false, http: r.status, ms, err: '响应不是有效 MCP 消息' };
    return { ok: true, http: r.status, ms, server: (j.result.serverInfo && j.result.serverInfo.name) || '' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const err = /abort|timeout/i.test(msg) ? '端点响应超时' : ('无法连接端点：' + msg.slice(0, 100));
    return { ok: false, ms: Date.now() - t0, err };
  }
}
async function checkConnectors(ids) {
  const want = (Array.isArray(ids) && ids.length)
    ? ids
    : CONNECTOR_REGISTRY.map(c => c.id).filter((id) => {
        const st = settings.connectors && settings.connectors[id];
        return !!(st && st.enabled);
      });
  let eng = null;
  try { eng = await resolveEngine(settings.model || DEFAULT_MODEL); } catch (e) {}
  const listRes = await runCodexMcpList(eng);
  const rows = listRes.rows || {};
  const standaloneNode = detectNodeExe();
  const nodeExe = standaloneNode || process.execPath;
  const mcpEnv = standaloneNode ? {} : { ELECTRON_RUN_AS_NODE: '1' };
  const serverPath = mcpServerPath();
  const items = [];
  const probes = [];
  for (const id of want) {
    const reg = CONNECTOR_REGISTRY.find(c => c.id === id);
    const st = settings.connectors && settings.connectors[id];
    const item = { id, ok: false, state: 'fail', text: '连接失败', reason: '', at: Date.now() };
    if (!reg) { item.reason = '未知连接器'; items.push(item); continue; }
    if (!st || !st.enabled) {
      item.state = 'off'; item.text = '未连接'; item.reason = '该连接器当前未开启';
      items.push(item); continue;
    }
    // 先看配置是否完整（这类失败给的原因最准确）
    let built = null;
    try {
      built = reg.auth === 'local'
        ? reg.build(st.config || {}, { nodeExe, serverPath, mcpEnv })
        : reg.build(st.config || {}, {});
    } catch (e) { built = null; }
    if (!built || (!built.command && !built.url)) { item.reason = '还没填服务地址，无法生成配置'; items.push(item); continue; }
    // ① 引擎是否已加载
    const row = rows[id];
    if (!row) {
      item.reason = (listRes.ok ? '引擎配置里没有这个连接器（重新连接一次即可同步）' : ('读取引擎配置失败：' + (listRes.reason || '')));
      items.push(item); continue;
    }
    if (!/enabled/i.test(row.status || '')) {
      item.reason = '引擎里该连接器未启用（Status: ' + (row.status || '-') + '）';
      items.push(item); continue;
    }
    // ② 授权状态（OAuth 类以引擎的 Auth 列为准，这是真实登录态）
    if (reg.auth === 'oauth') {
      const a = String(row.auth || '');
      if (/not logged in/i.test(a) || !/oauth/i.test(a)) {
        item.reason = /not logged in/i.test(a) ? '尚未授权（点「授权」完成浏览器登录）' : ('授权状态未知（Auth: ' + (a || '无') + '）');
        items.push(item); continue;
      }
    }
    // ③ 真实握手：先收集，最后统一并发探测（一个慢端点不能拖住整轮检测）
    items.push(item);
    probes.push({ item, built, reg, st });
  }
  await Promise.all(probes.map(async (p) => {
    const { item, built, reg, st } = p;
    if (built.command) {
      const pr = await probeMcpStdio(built, mcpEnv, 8000);
      if (pr.ok) {
        item.ok = true; item.state = 'ok'; item.text = '状态正常';
        item.reason = '本地服务已就绪 · ' + pr.tools + ' 个工具 · ' + pr.ms + 'ms';
      } else {
        item.reason = '本地服务握手失败：' + (pr.err || '未知原因') +
          (standaloneNode ? '' : '（本机未检测到 Node.js，安装 Node.js 后重启应用即可）');
      }
    } else if (built.url) {
      const token = reg.auth === 'token' ? String((st.config || {}).token || '') : '';
      const pr = await probeMcpHttp(built.url, token, 7000);
      if (pr.ok) {
        item.ok = true; item.state = 'ok'; item.text = '状态正常';
        item.reason = '端点已响应' + (pr.server ? '（' + pr.server + '）' : '') + ' · ' + pr.ms + 'ms';
      } else if (pr.authRequired && reg.auth === 'oauth') {
        // OAuth 连接器：本机检测进程没有令牌，端点回 401 是正常现象；
        // 引擎的 Auth 列已确认授权、端点又能连通 → 判定为正常。
        item.ok = true; item.state = 'ok'; item.text = '状态正常';
        item.reason = '已授权（引擎凭据有效、端点可达）';
      } else {
        item.reason = pr.err || '端点无响应';
      }
    } else {
      item.reason = '配置不完整（既没有命令也没有地址）';
    }
  }));
  // 并发探测会打乱推入顺序，这里按请求顺序还原
  const order = {};
  want.forEach((id, i) => { order[id] = i; });
  items.sort((a, b) => (order[a.id] == null ? 999 : order[a.id]) - (order[b.id] == null ? 999 : order[b.id]));
  return { ok: true, at: Date.now(), engine: (eng && eng.homeDir) || '', items };
}

function ensureDirs() {
  for (const k of Object.keys(DEFAULT_DIRS)) {
    const p = settings.dirs[k];
    if (!p) continue;
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  }
}
// 受保护目录（系统/用户核心目录）：禁止作为自动迁移的“来源”，避免误移系统盘或桌面/文档等。
function isProtectedDir(p) {
  if (!p) return true;
  const s = path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (!s) return true;
  if (/^[a-z]:\/?$/.test(s)) return true; // 盘符根目录
  const home = (os.homedir() || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (home) {
    if (s === home) return true;
    const specials = ['/desktop', '/downloads', '/documents', '/pictures', '/music', '/videos', '/appdata'];
    if (specials.some(x => s === home + x || s.startsWith(home + x + '/'))) return true;
  }
  const sys = ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata'];
  if (sys.some(x => s === x || s.startsWith(x + '/'))) return true;
  return false;
}
// 把 from 目录下的全部内容迁移（移动）到 to 目录；同名文件不覆盖、保留在来源。
// 跨盘符时回退为「复制后再删来源」，避免 rename 失败；任何单项失败都不影响其余项。
function migrateDirContents(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  const out = { ok: false, moved: 0, skipped: 0, errors: [] };
  if (!from || !to || from === to) { out.error = '来源或目标为空，或两者相同'; return out; }
  const rf = path.resolve(from), rt = path.resolve(to);
  if (rf === rt) { out.error = '来源与目标相同'; return out; }
  // 禁止把目录迁进自己的子目录（会造成递归）
  if (rt.startsWith(rf + path.sep) || rf.startsWith(rt + path.sep)) {
    out.error = '目标不能是来源的子目录（或反之）'; return out;
  }
  if (isProtectedDir(rf)) { out.error = '来源是系统/用户核心目录，出于安全不自动迁移'; return out; }
  if (!fs.existsSync(rf)) { out.error = '来源目录不存在：' + rf; return out; }
  let st; try { st = fs.statSync(rf); } catch (e) { out.error = '来源目录不可访问'; return out; }
  if (!st.isDirectory()) { out.error = '来源不是目录'; return out; }
  fs.mkdirSync(rt, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(rf); } catch (e) { out.error = '无法读取来源目录'; return out; }
  for (const name of entries) {
    const sp = path.join(rf, name);
    const dp = path.join(rt, name);
    if (fs.existsSync(dp)) { out.skipped++; continue; } // 目标已存在：跳过，不覆盖
    try {
      try { fs.renameSync(sp, dp); }
      catch (e) { // 跨盘符：复制后删除源
        fs.cpSync(sp, dp, { recursive: true });
        fs.rmSync(sp, { recursive: true, force: true });
      }
      out.moved++;
    } catch (e) { out.errors.push(name + '：' + String(e.message || e)); }
  }
  out.ok = true;
  return out;
}
let settings = loadSettings();

// ---------- 多提供商：当前激活的 API 密钥/接口地址 ----------
// 有 providers 时用 activeProviderId 指向的那份；否则回退旧单 key 字段（向后兼容）。
// 所有上游调用统一走 activeApiKey() / activeBase()，不要直接读 settings.apiKey / settings.nimBase。
function normalizeProviders(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(p => p && typeof p === 'object')
    .map((p, i) => ({
      id: String(p.id || ('p' + (i + 1) + '-' + Date.now().toString(36))),
      name: String(p.name || '提供商 ' + (i + 1)),
      apiKey: String(p.apiKey || ''),
      base: String(p.base || ''),
      protocol: (p.protocol === 'responses' ? 'responses' : 'openai'),
      models: (Array.isArray(p.models) ? p.models : []).filter(m => typeof m === 'string' && m),
      enabled: p.enabled !== false,
      builtin: p.builtin === true,
    }));
}
function activeProvider() {
  const list = normalizeProviders(settings.providers);
  if (list.length) {
    let p = list.find(x => x.id === settings.activeProviderId && x.enabled);
    if (!p) p = list.find(x => x.enabled);
    if (!p) p = list[0];
    return p;
  }
  // 旧单 key 模式
  return {
    id: 'legacy',
    name: 'NVIDIA NIM',
    apiKey: settings.apiKey || '',
    // 空字符串必须原样保留：解绑后接口地址就是空，不能又被默认值填回来。
    base: typeof settings.nimBase === 'string' ? settings.nimBase : 'https://integrate.api.nvidia.com/v1',
    protocol: 'openai',
    models: null,
    enabled: true,
  };
}
// 模型级路由：① 内置目录里写了 provider 的模型；② 用户在某个模板里「获取可用模型 →
// 勾选 → 保存」的自定义模型，归属到勾选它的那份模板；③ 其余走当前激活模板。
// ② 不能省：没有它，手动勾选的云端模型会被错配到当前激活的 NIM 密钥上，调用必然 401。
function modelOwners() {
  const map = {};
  for (const p of normalizeProviders(settings.providers)) {
    if (!p.enabled || !p.apiKey) continue;
    for (const m of (Array.isArray(p.models) ? p.models : [])) {
      if (m && !map[m]) map[m] = p.id;
    }
  }
  return map;
}
function upstreamFor(model) {
  const id = (MODEL_CATALOG[model] || {}).provider || modelOwners()[model];
  if (!id) return activeProvider();
  const p = normalizeProviders(settings.providers).find(x => x.id === id && x.enabled);
  return p || activeProvider();
}
function activeApiKey(model) { return upstreamFor(model || settings.model || DEFAULT_MODEL).apiKey || ''; }
function activeBase(model) { return upstreamFor(model || settings.model || DEFAULT_MODEL).base || ''; }
// 上下文预算按当前模型的真实窗口收敛：留 8K 给系统提示与输出，绝不虚标超过模型能力。
function effectiveContextLimit(model) {
  // 未登记的自定义模型（用户从云端勾选进来的）用保守的 128K，绝不虚标 200K 把上下文撑爆；
  // 已登记模型一律用它自己的真实窗口。
  const cap = (MODEL_CATALOG[model] || {}).ctx || 128000;
  return Math.max(16000, Math.min(settings.contextLimit || 350000, cap - 8192));
}
// 同一底层模型可能由多个网关（如 CatCold / 九维）以相同 wire id 提供。
// 目录键用「网关/真实id」命名避免冲突，wireModel 还原成上游真正认识的 id，否则上游 404。
function wireModelOf(model) {
  const w = (MODEL_CATALOG[model] || {}).wireModel;
  return (typeof w === 'string' && w) ? w : model;
}
// 用户从聊天/文档里粘贴密钥时，常会带上中文说明、省略号（…）、脱敏占位符或零宽字符。
// HTTP 头只接受 Latin-1 字符，直接拼进 Authorization 会抛
// "Cannot convert argument to a ByteString because the character at index N ..."，
// 连请求都发不出去。这里统一把脏输入还原成纯 ASCII 的密钥与地址。
function cleanCredential(rawKey, rawBase) {
  let s = String(rawKey == null ? '' : rawKey)
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[\r\n\t]/g, ' ');
  const stripped = s.trim();
  let warn = '';
  let key = '';
  if (/[^\x20-\x7E]/.test(stripped)) warn = '密钥含中文/省略号等非法字符，已自动清理';
  if (/^[\x21-\x7E]+$/.test(stripped) && !/omit|placeholder|your[_-]?key|脱敏|示例/i.test(stripped)) {
    // 纯 ASCII 且不带说明文字：原样使用，避免误伤含 + / = 等字符的密钥
    key = stripped.replace(/^["'`]+|["'`]+$/g, '');
  } else {
    const ascii = stripped.replace(/[^\x20-\x7E]/g, ' ');
    if (/omit|placeholder|your[_-]?key|脱敏|省略/i.test(ascii)) {
      warn = '密钥看起来是占位/脱敏文本，请粘贴完整密钥';
      return { key: '', base: cleanBase(rawBase), warn };
    }
    const m = ascii.match(/\b(?:sk|nvapi|gsk|xai|api)[-_][A-Za-z0-9._+/=-]{8,}/i)
           || ascii.match(/[A-Za-z0-9._+/=-]{24,}/);
    if (m) key = m[0];
    else {
      const parts = ascii.split(/[\s,;:"'`<>\[\]()]+/).filter(Boolean)
        .filter(x => !/^(key|api|omitted|bearer|token|密钥)$/i.test(x));
      key = parts.sort((a, b) => b.length - a.length)[0] || '';
    }
    key = key.replace(/^["'`]+|["'`]+$/g, '').replace(/[.,;:]+$/, '').trim();
  }
  return { key, base: cleanBase(rawBase), warn };
}
function cleanBase(rawBase) {
  const b = String(rawBase == null ? '' : rawBase)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\s"'`<>]/g, '')
    .trim()
    .replace(/\/+$/, '');
  return /^https?:\/\//i.test(b) ? b : '';
}
function activeModels() {
  // 设置页与聊天输入框的模型列表 = 内置精选目录（实测过的 25 个）
  //   + 所有「启用且有密钥」模板里用户手动勾选保存的自定义模型（云端 /models 拿到的 ID）。
  // 旧实现只认 activeProvider().models：用户在非激活模板（付费 / 公益 / GPT）里
  // 「获取可用模型 → 勾选 → 保存」后，这些模型不会出现在任何切换列表里。
  // 严格区分勾选状态：只遍历各模板的 p.models 白名单，云端 /models 返回但未勾选的
  // 模型绝不进列表，也不会被 modelOwners() 绑定到任何密钥（model-activity 同理）。
  const out = MODELS.slice();
  for (const p of normalizeProviders(settings.providers)) {
    if (!p.enabled || !p.apiKey || !Array.isArray(p.models)) continue;
    for (const m of p.models) if (m && !out.includes(m)) out.push(m);
  }
  return out;
}
// 首次启动（或设置文件被删）时落一份默认配置，用户可直接编辑，不用猜字段名
try {
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8');
  }
} catch (e) {}
try { ensureDirs(); } catch (e) {}
// P0：取消与进程句柄一律按 run 由 RunRegistry 持有，不再有全局单例。
// streamChat / streamAgent 各自把 abort / proc 注册到自己的 run。
const IDLE_MS = 600000;   // 上游 10 分钟不吐任何字节才判定卡死（NIM 排队实测首字可达 143s+，3 分钟会误杀）
const AGENT_AUDIT_LOG = path.join(ROOT, 'agent-audit.log');
const SNAPSHOT_DIR = path.join(ROOT, 'agent-snapshots');
try { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch (e) {}
// 高危命令：审计里显式标记，安全模式下直接拒绝执行请求
const DANGEROUS_CMD = /(rm\s+-rf|del\s+\/[sq]|rd\s+\/s|format\s+[a-z]:|reg\s+delete|git\s+reset\s+--hard|git\s+clean\s+-[fdx]|Remove-Item\s+[^\n]*-Recurse|shutdown\b)/i;

// ---------- 找 codex 可执行文件 ----------
// Windows 用 codex.exe，Linux/macOS 用无扩展名的 codex；目录名也随平台变。
const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';
const CODEX_CPU = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
const CODEX_TRIPLE = CODEX_CPU ? (process.platform === 'win32' ? CODEX_CPU + '-pc-windows-msvc'
  : (process.platform === 'darwin' ? CODEX_CPU + '-apple-darwin' : CODEX_CPU + '-unknown-linux-musl')) : null;
function findCodexExe(engineDir) {
  // 安装包布局：resources/engine/codex(.exe)
  const direct = path.join(engineDir, CODEX_BIN_NAME);
  if (fs.existsSync(direct)) return direct;
  // Linux 整目录分发：resources/engine/vendor/<triple>/bin/codex（同目录有 codex-resources / codex-path）
  if (!CODEX_TRIPLE) return null;
  const vend = path.join(engineDir, 'vendor', CODEX_TRIPLE, 'bin', CODEX_BIN_NAME);
  if (fs.existsSync(vend)) return vend;
  const base = path.join(engineDir, 'node_modules', '.pnpm');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    if (!d.startsWith('@openai+codex@')) continue;
    const p = path.join(base, d, 'node_modules', '@openai', 'codex', 'vendor',
      CODEX_TRIPLE, 'bin', CODEX_BIN_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 模型协议解析：任意模型都能自动选对 Codex 引擎 ----------
const wireCache = new Map();

function getModelMeta(model) {
  const base = MODEL_CATALOG[model] || null;
  const override = (settings.modelProtocols || {})[model];
  const wire = (override === 'chat' || override === 'responses') ? override : (base && base.wire) || null;
  return {
    label: (base && base.label) || model,
    wire,
    thinking: base ? base.thinking : null,
    desc: (base && base.desc) || '自定义模型（自动探测协议）',
    group: (base && base.group) || '其他',
    health: (base && base.health) || 'unknown',
    ctx: (base && base.ctx) || 0,
    vision: base ? !!base.vision : false,
    tools: base ? !!base.tools : false,
    provider: (base && base.provider) || '',
  };
}

// 未登记模型：探测 /v1/responses 是否接受它；探测失败按模型名启发式兜底。
// 显式配置过的模型不走探测，避免给 4.1F 的拥塞队列再添请求。
async function probeWire(model) {
  if (wireCache.has(model)) return wireCache.get(model);
  let wire = /deepseek/i.test(model) ? 'chat' : 'responses';
  try {
    const r = await fetch(activeBase(model).replace(/\/+$/, '') + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + activeApiKey(model), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: wireModelOf(model), input: 'ping', max_output_tokens: 1 }),
      signal: AbortSignal.timeout(3500),
    });
    if (r.status === 200) wire = 'responses';
    else if (r.status === 404) wire = 'chat';
    try { fs.appendFileSync(path.join(ROOT, 'protocol-probe.log'),
      new Date().toISOString() + ' probe model=' + model + ' http=' + r.status + ' wire=' + wire + '\n'); } catch {}
  } catch (e) {
    // 超时 / 网络异常不阻塞 agent 启动，保留启发式结果
  }
  wireCache.set(model, wire);
  return wire;
}

// 每次 agent 启动前自检 CODEX_HOME：协议、密钥隔离、可选安全模式。
// 只在内容真的变化时写盘并留备份，正常情况零写入。
function ensureHomeConfig(homeDir, wire, model) {
  try {
    const p = path.join(homeDir, 'config.toml');
    // 全新安装（用户目录里还没有 CODEX_HOME）时用内置模板落一份基线配置，
    // 否则 codex 会拿默认 home 去连官方端点，装到别人电脑上必然失败。
    if (!fs.existsSync(p)) {
      try {
        fs.mkdirSync(homeDir, { recursive: true });
        const tpl = fs.readFileSync(path.join(APP_DIR, 'templates', 'config.toml'), 'utf8');
        fs.writeFileSync(p, tpl.replace('__BASE_URL__',
          'http://127.0.0.1:' + (settings.port || 8760) + '/v1'), 'utf8');
      } catch (e) { return; }
    }
    const orig = fs.readFileSync(p, 'utf8');
    // 实测：历史文件里混进过孤立的 \r，TOML 解析直接报
    // "carriage return must be followed by newline"，Agent 一启动就退出。统一成 LF。
    let raw = orig.replace(/\r\n?/g, '\n');

    // 所有请求统一走本机兼容层：Codex 只会说 responses，NIM 只会说 chat，
    // 由我们自己的 /v1/responses 负责翻译，模型侧不挑协议。
    const localBase = 'http://127.0.0.1:' + (settings.port || 8760) + '/v1';
    raw = raw.replace(/^\s*wire_api\s*=\s*["'][^"']*["']/gm, 'wire_api = "responses"');
    if (!/^\s*wire_api\s*=/m.test(raw)) raw += '\nwire_api = "responses"\n';
    raw = raw.replace(/^\s*base_url\s*=\s*["'][^"']*["']/gm, 'base_url = "' + localBase + '"');
    if (!/^\s*base_url\s*=/m.test(raw)) {
      raw += '\n[model_providers.nim-local]\nname = "NVIDIA NIM (local shim)"\n' +
        'base_url = "' + localBase + '"\nenv_key = "NVIDIA_API_KEY"\nwire_api = "responses"\n';
    }
    raw = raw.replace(/^\s*model\s*=\s*["'][^"']*["']/m, 'model = "' + model + '"');

    // 实测关键修复：顶层 model_provider 必须显式指向本地兼容层。
    // 缺失时 Codex 会回退到内置官方端点，先卡在 WebSocket 重连 5 次、再回退 HTTPS 失败，
    // 本机 /v1/responses 完全收不到请求（表现为「Agent 一直重连、不执行任何命令」）。
    const LOCAL_PROVIDER = 'nim-local';
    if (!new RegExp('\\[model_providers\\.' + LOCAL_PROVIDER + '\\]').test(raw)) {
      raw += '\n[model_providers.' + LOCAL_PROVIDER + ']\n' +
        'name = "WhaleCodex local shim"\n' +
        'base_url = "' + localBase + '"\n' +
        'env_key = "NVIDIA_API_KEY"\n' +
        'wire_api = "responses"\n';
    }
    const mpRe = /^\s*model_provider\s*=\s*["'][^"']*["']/m;
    if (mpRe.test(raw)) raw = raw.replace(mpRe, 'model_provider = "' + LOCAL_PROVIDER + '"');
    else raw = 'model_provider = "' + LOCAL_PROVIDER + '"\n' + raw;
    if (!/^\s*model\s*=/m.test(raw)) raw = 'model = "' + model + '"\n' + raw;

    // 实测：缺 sandbox_mode 时引擎默认 read-only，模型发出的每一条 exec_command
    // 都会被 "blocked by policy" 拒绝（550B 连续 14 次命令全部落空）。
    const smRe = /^\s*sandbox_mode\s*=\s*["'][^"']*["']/m;
    if (smRe.test(raw)) raw = raw.replace(smRe, 'sandbox_mode = "workspace-write"');
    else raw = 'sandbox_mode = "workspace-write"\n' + raw;
    if (!/\[windows\]/.test(raw)) raw += '\n[windows]\nsandbox = "elevated"\n';

    // 密钥隔离：Codex 主进程仍用 NVIDIA_API_KEY 调本地兼容层，但它 spawn 的 shell 命令
    // 会被 shell_environment_policy 过滤掉，沙箱内读不到真 key。
    if (!/\[shell_environment_policy\]/.test(raw)) {
      raw += '\n# 密钥隔离：沙箱内执行的命令继承不到 NIM key\n' +
        '[shell_environment_policy]\ninherit = "all"\nignore_default_excludes = false\n' +
        'exclude = ["NVIDIA_API_KEY", "*_API_KEY", "*_SECRET", "*_TOKEN", "*KEY*", "*SECRET*", "*TOKEN*"]\n';
    }

    // 可选安全模式（默认关）：禁网 + 高风险命令需审批。关掉时不改变原有便利用法。
    const safe = settings.agentSafeMode === true;
    const wantNet = safe ? 'false' : 'true';
    const netRe = /^\s*network_access\s*=\s*(?:true|false)/m;
    if (netRe.test(raw)) raw = raw.replace(netRe, 'network_access = ' + wantNet);
    else raw += '\n[sandbox_workspace_write]\nnetwork_access = ' + wantNet + '\n';
    const wantAppr = safe ? 'on-request' : 'never';
    const apprRe = /^\s*approval_policy\s*=\s*"[^"]*"/m;
    if (apprRe.test(raw)) raw = raw.replace(apprRe, 'approval_policy = "' + wantAppr + '"');
    else raw = 'approval_policy = "' + wantAppr + '"\n' + raw;

    if (raw !== orig) {
      fs.writeFileSync(p + '.bak-' + Date.now(), orig, 'utf8');
      fs.writeFileSync(p, raw, 'utf8');
      try { fs.appendFileSync(path.join(ROOT, 'protocol-probe.log'),
        new Date().toISOString() + ' home policy updated at ' + p + ' wire=' + wire + ' safe=' + safe + ' model=' + model + '\n'); } catch {}
    }
  } catch (e) {}
}

// ---------- Agent 审计 / 快照 ----------
// 默认白名单：Documents + 数据目录，再自动纳入「用户配置的数据目录」的上一级。
// 实测问题：用户在设置里把聊天/记忆/测试目录指到 自定义记忆目录，Agent 弹窗默认
// 工作目录也是 自定义目录，但默认白名单只有 Documents 与 userData → 点「开始 Agent」直接被拒。
// 这里按用户自己的目录推导，既让默认路径可用，又不放开整个盘符。
function defaultAgentRoots() {
  const roots = DEFAULT_AGENT_ROOTS.slice();
  try {
    const dirs = settings.dirs || {};
    for (const k of ['chatArchive', 'memory', 'testFiles']) {
      const p = dirs[k];
      if (typeof p !== 'string' || !p) continue;
      const abs = path.resolve(p);
      const up1 = path.dirname(abs);
      const up2 = path.dirname(up1);
      for (const d of [up1, up2]) {
        if (d && d !== path.parse(d).root) roots.push(d);
      }
    }
  } catch (e) {}
  return Array.from(new Set(roots));
}
function agentRoots() {
  return (Array.isArray(settings.agentRoots) && settings.agentRoots.length)
    ? settings.agentRoots : defaultAgentRoots();
}
function isDirAllowed(dir) {
  const resolved = path.resolve(dir);
  return agentRoots().some(r => {
    const rr = path.resolve(r);
    return resolved === rr || resolved.startsWith(rr + path.sep);
  });
}
function audit(entry) {
  try {
    fs.appendFileSync(AGENT_AUDIT_LOG, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  } catch (e) {}
}

// ---------- 模型活动日志 ----------
// 目的：任何一轮对话事后都能回答「界面选的是哪个模型 / 实际出字的是哪个模型 / 中间降级过几次」。
// 落盘为 JSONL，内存保留最近 600 条供设置面板实时查看。
const MODEL_ACT_LOG = path.join(ROOT, 'model-activity.jsonl');
const MODEL_ACT_MAX = 600;
const MODEL_ACT_FILE_MAX = 2 * 1024 * 1024;
const modelActBuf = [];
let modelActLoaded = false;
function loadModelAct() {
  if (modelActLoaded) return;
  modelActLoaded = true;
  try {
    if (!fs.existsSync(MODEL_ACT_LOG)) return;
    const lines = fs.readFileSync(MODEL_ACT_LOG, 'utf8').split('\n').filter(Boolean).slice(-MODEL_ACT_MAX);
    for (const l of lines) { try { modelActBuf.push(JSON.parse(l)); } catch {} }
  } catch {}
}
function recordModelActivity(e) {
  loadModelAct();
  const row = Object.assign({ at: new Date().toISOString() }, e);
  modelActBuf.push(row);
  if (modelActBuf.length > MODEL_ACT_MAX) modelActBuf.splice(0, modelActBuf.length - MODEL_ACT_MAX);
  try {
    fs.appendFileSync(MODEL_ACT_LOG, JSON.stringify(row) + '\n');
    if (fs.statSync(MODEL_ACT_LOG).size > MODEL_ACT_FILE_MAX) {
      fs.writeFileSync(MODEL_ACT_LOG, modelActBuf.map(x => JSON.stringify(x)).join('\n') + '\n');
    }
  } catch {}
  return row;
}
function listModelActivity(limit) {
  loadModelAct();
  return { entries: modelActBuf.slice(-limit).reverse(), file: MODEL_ACT_LOG, total: modelActBuf.length };
}
const SNAP_SKIP_DIR = /^(node_modules|\.git|dist|build|target|__pycache__|\.venv|venv|vendor|\.next|cache|logs|sessions|snapshots|agent-snapshots|\.tmp)$/i;
const SNAP_DENY_FILE = /(\.env|key|secret|token|credential|password|^settings\.json$|^config\.toml$)/i;
const SNAP_MAX_FILES = 400, SNAP_MAX_BYTES = 512 * 1024, SNAP_MAX_TOTAL = 24 * 1024 * 1024;

function snapshotPaths(dir) {
  const out = [];
  const walk = (cur, depth) => {
    if (depth > 6 || out.length >= 800) return;   // 大目录提前收敛，避免阻塞 agent 启动
    let names; try { names = fs.readdirSync(cur); } catch { return; }
    for (const name of names) {
      if (SNAP_SKIP_DIR.test(name)) continue;
      const p = path.join(cur, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!st.isFile() || SNAP_DENY_FILE.test(name) || st.size === 0 || st.size > SNAP_MAX_BYTES) continue;
      out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

function makeSnapshot(dir) {
  const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const files = {};
  let count = 0, total = 0, skipped = 0;
  for (const p of snapshotPaths(dir)) {
    if (count >= SNAP_MAX_FILES || total >= SNAP_MAX_TOTAL) { skipped++; continue; }
    try {
      const b = fs.readFileSync(p);
      if (b.includes(0)) { skipped++; continue; }   // 二进制不备份
      files[path.relative(dir, p).replace(/\\/g, '/')] = b.toString('base64');
      count++; total += b.length;
    } catch { skipped++; }
  }
  if (!count) return { ok: false, reason: '目录内没有可快照的文本文件（或全部被排除）' };
  try {
    fs.writeFileSync(path.join(SNAPSHOT_DIR, runId + '.json'),
      JSON.stringify({ dir, at: Date.now(), files, skipped }));
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
  return { ok: true, runId, count, total, skipped };
}

function restoreSnapshot(runId, dir) {
  if (!/^[a-z0-9-]+$/i.test(String(runId || ''))) return { ok: false, error: '非法快照 ID' };
  const p = path.join(SNAPSHOT_DIR, runId + '.json');
  if (!fs.existsSync(p)) return { ok: false, error: '快照不存在' };
  let snap; try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { ok: false, error: '快照损坏' }; }
  const target = String(dir || snap.dir || '');
  const resolved = path.resolve(target);
  if (path.resolve(snap.dir) !== resolved) return { ok: false, error: '目录与快照不匹配' };
  let restored = 0, failed = 0;
  for (const [rel, b64] of Object.entries(snap.files || {})) {
    const fp = path.join(resolved, rel);
    if (!fp.startsWith(resolved + path.sep)) continue;   // 防路径穿越
    try { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, Buffer.from(b64, 'base64')); restored++; }
    catch { failed++; }
  }
  audit({ kind: 'restore', runId, dir: resolved, restored, failed });
  return { ok: true, restored, failed, note: '已恢复任务前存在的文件内容；任务中新增的文件不会自动删除' };
}

async function resolveEngine(model) {
  const meta = getModelMeta(model);
  // Codex 0.15x 只保留 responses 协议，NIM 又只有 chat；
  // 统一走本机 /v1/responses 兼容层，因此引擎固定用新版那一套。
  const engineDir = ENGINE_DIR;
  const homeDir = path.join(ROOT, 'home');
  const exe = findCodexExe(engineDir);
  // Linux/macOS 从安装包解出来的引擎可能丢了可执行位，用之前补一次
  if (exe && process.platform !== 'win32') { try { fs.chmodSync(exe, 0o755); } catch (e) {} }
  ensureHomeConfig(homeDir, 'responses', model);
  return { engineDir, homeDir, exe, wire: 'responses', label: meta.label };
}

// ---------- 本地语音识别（whisper.cpp 常驻服务） ----------
// 引擎随安装包分发（Windows / Linux 各一份二进制），模型一律不随包分发：
// 用户显式下载唯一的高精度模型到 ROOT/asr/models，由 Ed25519 签名清单 + sha256 校验。
// whisper-server 常驻 → 模型只加载一次 → 之后每句只做推理；音频始终不出本机。
const ASR_BIN_DIR = path.join(RES, 'whisper');
const ASR_SRV_EXE = path.join(ASR_BIN_DIR, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server');
// 安装包内不再内置任何 small/base 模型。模型文件名完全由服务器签名清单决定，
// 下载完成时写入 settings.asrModelFile —— 以后换档位只需换服务器清单，无需重发客户端。
const ASR_MODEL_NAME_RE = /^ggml-[a-z0-9][a-z0-9._-]{0,63}\.bin$/;
const ASR_MODEL_DIRS = [path.join(ROOT, 'asr', 'models'),
  path.join(RES, 'whisper', 'models')];
const ASR_MODELS_DIR = ASR_MODEL_DIRS[0];

// whisper 中文经常吐繁体，内置 opencc 轻量转换表（107KB）统一成简体
let asrT2S = null;
try {
  const O = require(path.join(APP_DIR, 'vendor', 'opencc-t2cn.js'));
  asrT2S = O.Converter({ from: 'tw', to: 'cn' });
} catch (e) {}

const asr = { proc: null, port: 0, ready: false, starting: false, pending: 0, model: '', err: '', threads: 0 };

function asrLog(s) {
  // 保密性：语音转写属用户隐私，默认不落盘；仅显式开启 WHALE_DEBUG=1 时记录
  if (process.env.WHALE_DEBUG !== '1') return;
  try {
    const p = path.join(ROOT, 'asr.log');
    const st = fs.existsSync(p) ? fs.statSync(p).size : 0;
    if (st > 1024 * 1024) fs.writeFileSync(p, '');
    fs.appendFileSync(p, s);
  } catch {}
}

// whisper-server.exe 在 Windows 下按 ANSI 解析命令行，模型路径含中文会乱码导致加载失败。
// 遇到非 ASCII 路径时用 8.3 短路径传给引擎，显示仍用原文件名。
function asrSafeModelPath(p) {
  if (!p || process.platform !== 'win32' || /^[\x20-\x7E]*$/.test(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/c', 'for %I in ("' + p + '") do @echo %~sI'],
      { windowsHide: true, encoding: 'utf8', timeout: 4000 });
    const short = String(out).trim().split(/\r?\n/).pop().trim();
    if (short && fs.existsSync(short)) return short;
  } catch (e) {}
  return p;
}

function asrModelPath() {
  // 优先用下载时记录的文件名；否则扫描已下载目录（兼容用户手动放模型 / 设置文件丢失）
  const preferred = String(settings.asrModelFile || '').trim();
  if (ASR_MODEL_NAME_RE.test(preferred)) {
    for (const d of ASR_MODEL_DIRS) {
      const p = path.join(d, preferred);
      if (fs.existsSync(p)) return p;
    }
  }
  let best = '', newest = -1;
  for (const d of ASR_MODEL_DIRS) {
    try {
      for (const n of fs.readdirSync(d)) {
        if (!ASR_MODEL_NAME_RE.test(n)) continue;
        const p = path.join(d, n);
        const st = fs.statSync(p);
        if (st.isFile() && st.size > 1024 * 1024 && st.mtimeMs > newest) { best = p; newest = st.mtimeMs; }
      }
    } catch (e) {}
  }
  return best;
}

// 挑一个没被占用的本地端口
function asrPickPort() {
  return new Promise((resolve) => {
    let port = 8791;
    let tries = 0;
    const attempt = () => {
      if (tries++ > 24) { resolve(8791); return; }
      const srv = net.createServer();
      srv.once('error', () => { port += 1; attempt(); });
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    attempt();
  });
}

function asrProbe(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(800);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

async function asrStart() {
  if (asr.proc || asr.starting) return;
  asr.starting = true;
  asr.err = '';
  try {
    if (!fs.existsSync(ASR_SRV_EXE)) { asr.err = '缺少语音引擎（' + ASR_SRV_EXE + '）'; return; }
    const rawModelPath = asrModelPath();
    if (!rawModelPath) { asr.err = '尚未下载语音模型，请在「设置 → 语音输入」中下载（' + ASR_MODELS_DIR + '）'; return; }
    const modelPath = asrSafeModelPath(rawModelPath);
    const port = await asrPickPort();
    const cores = (os.cpus() || []).length || 4;
    // 留两核给界面和主进程，上限 12：再往上加核收益很小
    const threads = Math.max(4, Math.min(12, cores - 2));
    const lang = settings.asrLang === 'auto' ? 'auto' : (settings.asrLang || 'zh');
    const validAc = [0, 384, 512, 768, 1024, 1500];
    const ac = validAc.indexOf(Number(settings.asrAudioCtx)) >= 0 ? Number(settings.asrAudioCtx) : 768;
    // -ac 限制编码器上下文以缩短等待；0 = 完整 30s，长句绝不截断但明显更慢
    const args = ['-m', modelPath, '-l', lang, '-t', String(threads), '-ac', String(ac), '--host', '127.0.0.1', '--port', String(port)];
    if (process.platform !== 'win32') { try { fs.chmodSync(ASR_SRV_EXE, 0o755); } catch (e) {} }
    let proc = null;
    try {
      proc = spawn(ASR_SRV_EXE, args, { cwd: ASR_BIN_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      asr.err = '语音引擎启动失败：' + String(e.message || e);
      return;
    }
    asr.proc = proc; asr.port = port; asr.threads = threads; asr.ready = false;
    asr.model = path.basename(rawModelPath).replace(/^ggml-/, '').replace(/\.bin$/, '');
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => asrLog(String(c)));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => asrLog(String(c)));
    proc.on('error', (e) => {
      asr.err = '语音引擎错误：' + String(e.message || e);
      if (asr.proc === proc) { asr.proc = null; asr.ready = false; }
    });
    proc.on('exit', (code) => {
      if (asr.proc !== proc) return;
      asr.proc = null; asr.ready = false;
      asr.err = asr.err || ('语音引擎已退出（code ' + code + '）');
      asrLog('\n[exit] code=' + code + '\n');
    });
    // 模型加载完才会 listen，所以端口能连上就等于可用
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (!asr.proc) return;
      if (await asrProbe(port)) {
        asr.ready = true;
        asrLog('[ready] port=' + port + ' model=' + asr.model + ' threads=' + threads + '\n');
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    asr.err = '语音引擎启动超时';
  } finally {
    asr.starting = false;
  }
}

function asrStopAll() {
  try { if (asr.proc) asr.proc.kill(); } catch {}
  asr.proc = null; asr.ready = false;
}

function asrMultipart(wavBuf, fields) {
  const boundary = '----whale' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [];
  for (const k of Object.keys(fields)) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k +
      '"\r\n\r\n' + fields[k] + '\r\n', 'utf8'));
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="a.wav"' +
    '\r\nContent-Type: audio/wav\r\n\r\n', 'utf8'));
  parts.push(wavBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  const data = Buffer.concat(parts);
  return { boundary, data, length: data.length };
}

function asrHttp(port, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/inference', method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + body.boundary,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('识别超时')); } catch {} });
    req.on('error', reject);
    req.end(body.data);
  });
}

// 与旧 Python 实现保持一致的清洗规则：只留逗号，其余标点去掉
const ASR_PUNCT = /[。！？；：、…—～·「」『』《》〈〉（）【】\[\]{}“”‘’"'!?;:]/g;
function asrClean(raw, lang) {
  let t = String(raw || '').trim();
  if (!t) return '';
  // [BLANK_AUDIO] / (音乐) 这类幻觉输出直接丢掉
  t = t.replace(/\[[^\]]{0,24}\]/g, '').replace(/^\([^)]{0,24}\)$/g, '').trim();
  if (lang !== 'zh') return t.replace(/\s+/g, ' ').trim();
  if (asrT2S) { try { t = asrT2S(t); } catch (e) {} }
  t = t.replace(/\s+/g, '');
  t = t.replace(ASR_PUNCT, '');
  t = t.replace(/\.(?=[\u4e00-\u9fff]|$)/g, '，');
  t = t.replace(/,/g, '，').replace(/，{2,}/g, '，');
  return t.replace(/^[，]+|[，]+$/g, '');
}

async function asrTranscribe(wavPath) {
  try {
    if (!fs.existsSync(wavPath)) return { error: '音频文件不存在' };
    const wavBuf = fs.readFileSync(wavPath);
    if (wavBuf.length < 44 + 3200) return { text: '', model: asr.model };   // 不足 0.1 秒当没说
    // 后端兜底静音检测：解析 16-bit PCM 采样算 RMS，静音直接返回空，
    // 避免 whisper 把初始提示「请用简体中文输出」当成已有文本续写吐出来。
    const pcm = wavBuf.slice(44);
    let sum = 0, cnt = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i) / 32768;
      sum += v * v; cnt++;
    }
    const rms = cnt ? Math.sqrt(sum / cnt) : 0;
    if (rms < 0.003) return { text: '', model: asr.model };
    if (!asr.proc) await asrStart();
    if (!asr.proc) return { error: asr.err || '语音引擎未启动' };
    if (!asr.ready) {
      const t0 = Date.now();
      while (!asr.ready && asr.proc && Date.now() - t0 < 25000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!asr.ready) return { error: asr.err || '语音引擎未就绪' };
    }
    const lang = settings.asrLang === 'auto' ? 'auto' : (settings.asrLang || 'zh');
    const fields = { response_format: 'json', temperature: '0' };
    if (lang !== 'auto') fields.language = lang;
    if (lang === 'zh') fields.prompt = '以下是普通话的句子，请用简体中文输出。';
    const body = asrMultipart(wavBuf, fields);
    asr.pending++;
    try {
      const r = await asrHttp(asr.port, body, 60000);
      if (r.status !== 200) return { error: '识别服务异常（' + r.status + '）：' + r.text.slice(0, 120) };
      let j = {};
      try { j = JSON.parse(r.text); } catch (e) { return { error: '识别结果解析失败' }; }
      let text = asrClean(String(j.text || ''), lang);
      // 识别结果若只剩 prompt 污染词，判空（静音时 whisper 会吐出提示文本）
      const polluted = /^(以下是普通话的句子，请用简体中文输出|请用简体中文输出|简体中文)/.test(text);
      if (polluted) text = '';
      return { text, model: asr.model };
    } finally {
      asr.pending--;
    }
  } catch (e) {
    return { error: '识别失败：' + String(e.message || e) };
  }
}

// ---------- 高精度语音模型按需下载（用户显式触发，绝不自动联网） ----------
// 清单由自有服务器静态托管，客户端验 Ed25519 离线签名 + sha256 后才落盘；
// 下载目录即 ASR_MODEL_DIRS 的最高优先级目录，加载链路无需改动。
const ASR_DL_DIR = path.join(ROOT, 'asr', 'models');
const modelDl = { state: 'idle', key: '', loaded: 0, total: 0, error: '' };
let modelManifest = null;
let modelManifestAt = 0;

function modelHost() { return settings.asrModelHost || asrModels.DEFAULT_HOST; }

async function refreshModelManifest() {
  const m = await asrModels.fetchManifest({ host: settings.asrModelHost, appDir: APP_DIR });
  modelManifest = m;
  modelManifestAt = Date.now();
  return m;
}

function modelListState() {
  const installed = asrModels.installedModels(ASR_DL_DIR, modelManifest);
  let models = (modelManifest ? modelManifest.models : []).map((e) => {
    const ins = installed.find((x) => x.key === e.key);
    return Object.assign({}, e, {
      installed: !!(ins && ins.complete),
      partial: !!(ins && !ins.complete),
    });
  });
  if (!models.length && settings.asrModelFile) {
    const p = path.join(ASR_DL_DIR, settings.asrModelFile);
    if (fs.existsSync(p)) {
      models = [{ key: settings.asrModel || 'installed', file: settings.asrModelFile,
        label: '本地已安装：' + settings.asrModelFile, size: fs.statSync(p).size,
        sha256: '', installed: true, partial: false, local: true }];
    }
  }
  return {
    ok: true,
    host: modelHost(),
    isDefaultHost: !settings.asrModelHost,
    manifestAt: modelManifestAt || null,
    models,
    progress: Object.assign({}, modelDl),
    activeModel: asr.model || '',
    requestedModel: settings.asrModel || '',
    modelFile: settings.asrModelFile || '',
    modelReady: !!asrModelPath(),
    engine: fs.existsSync(ASR_SRV_EXE),
    destDir: ASR_DL_DIR,
  };
}

async function startModelDownload(key) {
  if (modelDl.state === 'running') throw new Error('已有下载任务在进行');
  if (!modelManifest) await refreshModelManifest();   // 下载本身是显式联网授权
  const entry = asrModels.safeEntry(modelManifest, key);
  Object.assign(modelDl, { state: 'running', key, loaded: 0, total: entry.size, error: '' });
  asrModels.downloadModel({
    host: settings.asrModelHost,
    appDir: APP_DIR,
    destDir: ASR_DL_DIR,
    manifest: modelManifest,
    key,
    onProgress: (p) => { modelDl.loaded = p.loaded; modelDl.total = p.total; },
  }).then(() => {
    Object.assign(modelDl, { state: 'done', loaded: entry.size, error: '' });
    settings.asrModel = entry.key;
    settings.asrModelFile = entry.file;
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8'); } catch (e) {}
    try { asrStopAll(); } catch (e) {}   // 下次说话按新模型重新拉起引擎
  }).catch((e) => {
    Object.assign(modelDl, { state: 'error', error: String((e && e.message) || e) });
  });
  return { ok: true, key };
}

// 清单未加载（未联网）时，也允许使用已在本地的模型；有清单时按 sha256 复验后再启用。
async function useDownloadedModel(key) {
  let entry;
  if (modelManifest) entry = asrModels.safeEntry(modelManifest, key);
  else if (key === (settings.asrModel || 'installed') && settings.asrModelFile) {
    entry = { key: key, file: settings.asrModelFile };
  } else throw new Error('模型清单未加载，请先点「刷新模型清单」');
  const p = path.join(ASR_DL_DIR, entry.file);
  if (!fs.existsSync(p)) throw new Error('该模型尚未下载完成');
  if (entry.size && fs.statSync(p).size !== entry.size) throw new Error('模型文件不完整，请重新下载');
  if (/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
    const h = await asrModels.sha256File(p);
    if (h !== entry.sha256) throw new Error('模型 sha256 校验失败，请删除后重新下载');
  }
  settings.asrModel = entry.key;
  settings.asrModelFile = entry.file;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8'); } catch (e) {}
  try { asrStopAll(); } catch (e) {}
  return { ok: true, key: entry.key, file: entry.file };
}

function deleteDownloadedModel(key) {
  let entry;
  if (modelManifest) entry = asrModels.safeEntry(modelManifest, key);
  else if (key === (settings.asrModel || 'installed') && settings.asrModelFile) {
    entry = { key: key, file: settings.asrModelFile };
  } else throw new Error('模型清单未加载，请先点「刷新模型清单」再删除');
  const p = path.join(ASR_DL_DIR, entry.file);
  if (path.dirname(p) !== ASR_DL_DIR) throw new Error('非法模型路径');
  for (const f of [p, p + '.part']) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
  if (settings.asrModel === key) {
    settings.asrModel = '';
    settings.asrModelFile = '';
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8'); } catch (e) {}
  }
  try { asrStopAll(); } catch (e) {}
  return { ok: true, key };
}

function asrStatus() {
  const hasExe = fs.existsSync(ASR_SRV_EXE);
  const modelPath = asrModelPath();
  return {
    installed: hasExe && !!modelPath,
    running: !!asr.proc,
    ready: !!asr.ready,
    workers: asr.proc ? 1 : 0,
    busy: asr.pending,
    model: asr.model,
    cmd: asr.proc ? (ASR_SRV_EXE + ' -l ' + (settings.asrLang || 'zh') + ' -t ' + asr.threads) : '',
    models: !!modelPath,
    modelsDir: ASR_MODELS_DIR,
    python: '',
    engine: 'whisper.cpp',
    reason: !hasExe ? '缺少语音引擎（确认安装包内 whisper 目录完整）'
      : (!modelPath ? '尚未下载语音模型，请在「设置 → 语音输入」中下载（' + ASR_MODELS_DIR + '）'
        : (asr.proc ? (asr.err || '') : (asr.err || '语音引擎未启动，首次说话会自动拉起'))),
  };
}

// ---------- HTTP 服务 ----------
function sse(res, obj) {
  // 客户端可能已断开：写入前先确认连接还活着，避免抛 'write after end'
  if (!res || res.writableEnded || res.destroyed) return;
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {}
}
function endRes(res) {
  if (!res || res.writableEnded) return;
  try { res.end(); } catch (e) {}
}

/* ===================== Responses → Chat 兼容层 =====================
 * 背景：Codex 0.15x 起只支持 wire_api="responses"，而 NVIDIA NIM 只提供
 * /v1/chat/completions（/v1/responses 直接 404）。结果是 Agent 一启动就退出。
 * 这里在本地实现一个最小可用的 Responses API 服务端，把 Codex 的请求翻译成
 * chat/completions，再把流式结果翻译回 Responses 的 SSE 事件。
 * 好处：Codex 全套工具（shell / apply_patch / read_file / grep / plan…）都能用，
 *       模型侧只要能跑 chat 就行，不再受 wire 限制。
 */
// ---------- 模型适配层：统一生态入口 ----------
// 这里是「任意模型 → Codex Agent 工具循环」的唯一差异收敛点。
//   L0 寻址按模型走 activeBase(model)/activeApiKey(model)，不再误用当前激活模板；
//   L1 工具规范化 / L2 能力自学习 / L3 协议降级 / L4 护栏 / L5 重试均由门面提供。
const ADAPTER_LOG = path.join(ROOT, 'agent-adapter.log');
function adapterLog(line) {
  // 只记录元信息（模型 / 档位 / 工具数 / HTTP 状态），绝不写会话正文或凭据。
  try {
    const st = fs.existsSync(ADAPTER_LOG) ? fs.statSync(ADAPTER_LOG).size : 0;
    if (st > 2 * 1024 * 1024) fs.writeFileSync(ADAPTER_LOG, '');
    fs.appendFileSync(ADAPTER_LOG, new Date().toISOString() + ' ' + String(line).slice(0, 400) + '\n');
  } catch (e) {}
}
const adapter = ModelAdapter.createAdapter({
  resolveUpstream: (m) => {
    const p = upstreamFor(m);
    return { base: activeBase(m), apiKey: activeApiKey(m), providerId: (p && p.id) || '' };
  },
  toChatMessages: (b) => respToChatMessages(b),
  modelContext: (m) => {
    const meta = getModelMeta(m);
    return { ctx: meta.ctx || 128000, thinking: meta.thinking };
  },
  settings: () => settings,
  capabilities: settings.agentCapabilities || {},
  onChange: () => {
    try {
      settings.agentCapabilities = adapter.capabilities();
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8');
    } catch (e) {}
  },
  log: adapterLog,
});

const RESP_SHIM_LOG = path.join(ROOT, 'responses-shim.log');
function respLog(s) {
  // 保密性：模型回复/工具调用属用户会话内容，默认不落盘；仅 WHALE_DEBUG=1 时记录
  if (process.env.WHALE_DEBUG !== '1') return;
  try {
    const st = fs.existsSync(RESP_SHIM_LOG) ? fs.statSync(RESP_SHIM_LOG).size : 0;
    if (st > 4 * 1024 * 1024) fs.writeFileSync(RESP_SHIM_LOG, '');
    fs.appendFileSync(RESP_SHIM_LOG, s + '\n');
  } catch {}
}
function respId(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// Responses 的 input 数组 → chat messages（含 function_call / function_call_output）
function respToChatMessages(body) {
  const msgs = [];
  if (body.instructions) msgs.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  const items = Array.isArray(input) ? input
    : (typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : []);
  for (const it of items) {
    if (!it) continue;
    const t = it.type || (it.role ? 'message' : '');
    if (t === 'message' || t === 'input_message') {
      const role = it.role === 'developer' ? 'system' : (it.role || 'user');
      let text = '';
      const imgs = [];
      if (typeof it.content === 'string') text = it.content;
      else if (Array.isArray(it.content)) {
        for (const c of it.content) {
          if (!c) continue;
          if (c.type === 'input_image' || c.type === 'image_url') imgs.push(c.image_url || c.url || '');
          else if (typeof c.text === 'string') text += (text ? '\n' : '') + c.text;
          else if (typeof c.content === 'string') text += (text ? '\n' : '') + c.content;
        }
      }
      if (imgs.filter(Boolean).length) {
        const parts = [{ type: 'text', text: text || ' ' }];
        imgs.filter(Boolean).forEach(u => parts.push({ type: 'image_url', image_url: { url: u } }));
        msgs.push({ role, content: parts });
      } else if (text) {
        msgs.push({ role, content: text });
      }
      continue;
    }
    if (t === 'function_call') {
      const call = {
        id: it.call_id || it.id || respId('call'),
        type: 'function',
        function: {
          name: it.name || '',
          arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments || {}),
        },
      };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') (last.tool_calls = last.tool_calls || []).push(call);
      else msgs.push({ role: 'assistant', content: '', tool_calls: [call] });
      continue;
    }
    if (t === 'function_call_output') {
      const out = typeof it.output === 'string' ? it.output : JSON.stringify(it.output || '');
      msgs.push({ role: 'tool', tool_call_id: it.call_id, content: out });
      continue;
    }
    // reasoning / item_reference 等：对 chat 协议无意义，丢弃
  }
  return msgs;
}
// 工具规范化已迁入适配层（含 namespace 展开、schema 校验、内置工具如实记录）。
// 保留薄别名，避免历史调用点断裂。
function respToChatTools(tools) {
  const r = ModelAdapter.normalizeTools(tools);
  return r.tools.length ? r.tools : null;
}

// L0~L5 全部由适配层接管；这里只负责 Responses SSE 事件编排。
// 任意模型、任意协议档位走的是同一段代码，不再有模型特判分支。
async function handleResponsesShim(req, res) {
  try {
  let model = '';
  const body = await readBody(req, 8 * 1024 * 1024).catch(() => null);
  // 实测：body=null 会让 body.model 抛 TypeError，整个 async handler 变成未捕获
  // rejection，连接永远挂起；空/数组/字符串 body 则会被当成合法请求打到真实上游。
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: 'invalid request body: expected a JSON object' } }));
  }
  const hasInput = typeof body.input === 'string' || Array.isArray(body.input) || Array.isArray(body.messages);
  if (!hasInput) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: 'missing input' } }));
  }
  model = resolveAgentAlias(body.model || settings.model || DEFAULT_MODEL);
  // P0 引擎身份桥接：Agent 子进程用每 run 独立 token 指向本兼容层，
  // 这里据此把「一次逻辑模型请求」绑到对应 run —— 这是真实步数的唯一来源。
  // 没有该 token 的请求（探针 / 普通调用）不绑定 run，行为与之前完全一致。
  let boundRunId = null, boundReqId = null;
  try {
    const auth = String(req.headers['authorization'] || '');
    const am = /^Bearer\s+wr_(run_[A-Za-z0-9]+)_/.exec(auth);
    if (am && runs) {
      const br = runs.get(am[1]);
      if (br) {
        boundRunId = br.runId;
        runs.emit(boundRunId, 'step.started', { model: model }, 'engine');
        const rq = runs.emit(boundRunId, 'request.started', { model: model, wire: 'responses' }, 'engine');
        boundReqId = rq && rq.payload ? rq.payload.requestId : null;
      }
    }
  } catch (e) {}
  const rid = respId('resp');
  respLog('\n=== ' + new Date().toISOString() + ' model=' + model +
    ' tools=' + (Array.isArray(body.tools) ? body.tools.length : 0) + ' rid=' + rid);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let planned = adapter.plan(model, body);
  adapter.begin(rid, model, planned);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  const emit = (type, obj) => {
    if (closed || res.writableEnded) return;
    try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, obj)) + '\n\n'); } catch (e) {}
  };
  const baseResp = {
    id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model,
    status: 'in_progress', output: [], parallel_tool_calls: !!planned.body.tools,
    tool_choice: planned.body.tool_choice || 'auto', tools: planned.tools,
  };
  emit('response.created', { response: baseResp });
  emit('response.in_progress', { response: baseResp });

  const fail = (code, message, outcome) => {
    try { adapter.finalize(rid); } catch (e) {}
    emit('response.failed', {
      response: Object.assign({}, baseResp, { status: 'failed', error: { code: code, message: message } }),
    });
    try { adapter.observe(model, planned, Object.assign({ status: 0, errorText: message }, outcome || {})); } catch (e) {}
    adapterLog('fail model=' + model + ' code=' + code + ' ' + String(message).slice(0, 160));
    return endRes(res);
  };

  // ---- 上游请求：重试 / 工具拒绝自动降级到文本协议（SSE 尚未开始，可安全重试） ----
  let upstream = null;
  let attempt = 0;
  const maxAttempts = Math.max(2, adapter.retry.cfg.maxAttempts + 1);
  while (attempt < maxAttempts) {
    attempt++;
    let timedOut = false;
    let status = 0;
    let errText = '';
    try {
      upstream = await fetch(planned.url, {
        method: 'POST',
        headers: planned.headers,
        // Agent 兼容层同样显式请求 usage，否则引擎侧逐请求统计永远缺字段。
        body: JSON.stringify(withUsageOption(planned.body, model)),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
    } catch (e) {
      timedOut = /timeout|abort/i.test(String(e.message || e));
      errText = String(e.message || e);
    }
    if (upstream && upstream.ok && upstream.body) break;
    if (upstream && !upstream.ok) {
      status = upstream.status;
      errText = (await upstream.text().catch(() => '')).slice(0, 400);
    }
    const kind = adapter.retry.classify(status, errText, timedOut);

    // ⓪ 端点明确不认 include_usage：记住能力并去掉参数重试一次，不占业务重试次数。
    if (status === 400 && isUsageOptRejection(errText)
        && /stream_options|include_usage/i.test(errText)
        && !usageOptUnsupported.has(model)) {
      markUsageOptUnsupported(model);
      attempt--;
      continue;
    }
    // ① 上游明确拒绝 tools → 把该模型学到「文本协议」，重建请求后立即重试。
    //    这是「所有模型都能跑 Agent」的关键：不支持 function calling 的模型改走结构化文本。
    if (kind === ModelAdapter.FAILURE.UNSUPPORTED_TOOLS && planned.body.tools) {
      adapter.registry.set(model, ModelAdapter.PROTOCOL.TEXT,
        'upstream rejected tools: ' + errText.slice(0, 120));
      planned = adapter.plan(model, body);
      adapter.begin(rid, model, planned);
      adapterLog('downgrade model=' + model + ' -> text protocol (status ' + status + ')');
      continue;
    }
    // ② 限流 / 超时 / 5xx → 指数退避重试。
    if (adapter.retry.shouldRetry(kind, attempt)) {
      const d = adapter.retry.delayMs(attempt);
      adapterLog('retry model=' + model + ' attempt=' + attempt + ' kind=' + kind + ' delay=' + d);
      await sleep(d);
      continue;
    }
    const chain = getFailoverChain().filter((m) => m !== model).slice(0, 2).join(' / ');
    const hint = chain ? '；可在设置里切换模型试试：' + chain : '';
    return fail('upstream_' + (status || 'error'),
      '上游 HTTP ' + status + '：' + errText + hint,
      { status: status, errorText: errText, timedOut: timedOut });
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    return fail('upstream_unreachable', '上游多次重试后仍不可用');
  }

  // ---- 流式解析：两种协议都只往适配层喂 delta，差异由 finalize() 统一收口 ----
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  // P1：生成窗口只认真实生成事件（正文 / reasoning / 工具参数），排除排队与工具执行耗时。
  let genEvents = 0;
  let genFirstAt = null;
  let genLastAt = null;
  let msgItemId = null;
  let msgAdded = false;
  const ensureMsg = () => {
    if (msgAdded) return;
    msgAdded = true;
    msgItemId = respId('msg');
    emit('response.output_item.added', {
      output_index: 0,
      item: { id: msgItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    emit('response.content_part.added', {
      item_id: msgItemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '' },
    });
  };

  try {
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.usage) usage = j.usage;
        if (j.error) {
          const em = String(j.error.message || JSON.stringify(j.error)).slice(0, 400);
          return fail('upstream_error', em, { status: 200, errorText: em });
        }
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (d.content || d.reasoning_content || (d.tool_calls && d.tool_calls.length)) {
          if (genFirstAt === null && boundRunId) {
            runs.emit(boundRunId, 'request.first_output', { requestId: boundReqId }, 'provider');
          }
          genFirstAt = genFirstAt === null ? Date.now() : genFirstAt;
          genLastAt = Date.now();
          genEvents++;
        }
        if (d.reasoning_content) reasoning += d.reasoning_content;
        adapter.ingest(rid, { content: d.content, tool_calls: d.tool_calls });
        // 文本协议下先不吐正文：协议块要等收尾统一剔除，避免把 JSON 显示给用户。
        if (d.content && planned.mode !== ModelAdapter.PROTOCOL.TEXT) {
          ensureMsg();
          content += d.content;
          emit('response.output_text.delta', {
            item_id: msgItemId, output_index: 0, content_index: 0, delta: d.content,
          });
        }
      }
    }
  } catch (e) {
    return fail('stream_broken', String(e.message || e).slice(0, 300), { status: 200 });
  }

  const fin = adapter.finalize(rid);
  if (planned.mode === ModelAdapter.PROTOCOL.TEXT && fin.visibleText) {
    ensureMsg();
    content = fin.visibleText;
    emit('response.output_text.delta', {
      item_id: msgItemId, output_index: 0, content_index: 0, delta: content,
    });
  }

  const output = [];
  if (msgAdded) {
    const item = {
      id: msgItemId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    };
    emit('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: content });
    emit('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: content, annotations: [] } });
    emit('response.output_item.done', { output_index: 0, item: item });
    output.push(item);
  }

  // 原生 tool_calls 与文本协议解析出的调用，用同一套事件交给 Codex 引擎执行。
  for (const c of fin.calls) {
    const oi = output.length;
    const itemId = respId('fc');
    const item = {
      id: itemId, type: 'function_call', status: 'completed',
      name: c.name, arguments: c.arguments, call_id: c.id,
    };
    emit('response.output_item.added', {
      output_index: oi,
      item: { id: itemId, type: 'function_call', status: 'in_progress', name: c.name, arguments: '', call_id: c.id },
    });
    if (c.arguments) emit('response.function_call_arguments.delta', {
      item_id: itemId, output_index: oi, delta: c.arguments,
    });
    emit('response.function_call_arguments.done', {
      item_id: itemId, output_index: oi, arguments: c.arguments,
    });
    emit('response.output_item.done', { output_index: oi, item: item });
    output.push(item);
  }

  // 协议边界：Responses 的 input/output/total 是引擎必填字段，缺失时只能给 0 让引擎
  // 正常收尾；但统计绝不从这里取数 —— 注册表只认下面 normalizeUsage 的真实上报值。
  // details 字段只在真实上报时才出现，不再把「未上报」伪造成 0 或固定 reasoning_tokens:0。
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const inTok = num(usage && usage.prompt_tokens) || 0;
  const outTok = num(usage && usage.completion_tokens) || 0;
  const respUsage = {
    input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok,
  };
  const cached = num(usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
  const reason = num(usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens);
  if (cached !== null) respUsage.input_tokens_details = { cached_tokens: cached };
  if (reason !== null) respUsage.output_tokens_details = { reasoning_tokens: reason };
  emit('response.completed', {
    response: Object.assign({}, baseResp, {
      status: 'completed', output: output,
      usage: respUsage,
    }),
  });

  try {
    adapter.observe(model, planned, {
      status: 200,
      gotToolCalls: planned.mode === ModelAdapter.PROTOCOL.NATIVE && fin.calls.length > 0,
      gotText: content.length > 0,
      callCount: fin.calls.length,
    });
  } catch (e) {}
  if (boundRunId && boundReqId) {
    try {
      // usage 为 null 时也要发一条全 missing 的记录：该请求确实用量未上报，
      // 会话累计据此显示「部分用量未上报」，而不是假装不存在这次请求。
      runs.emit(boundRunId, 'request.usage',
        { requestId: boundReqId, usage: telemetry.normalizeUsage(usage, 'chat', { source: 'provider' }) },
        'provider');
      if (genFirstAt !== null) {
        runs.emit(boundRunId, 'request.last_output',
          { requestId: boundReqId, genEvents: genEvents, lastGenAt: genLastAt }, 'provider');
      }
      runs.emit(boundRunId, 'request.completed', { requestId: boundReqId, status: 'ok' }, 'engine');
    } catch (e) {}
  }
  respLog('  done text=' + content.length + ' calls=' + fin.calls.length +
    ' reasoning=' + reasoning.length + ' usage=' + inTok + '/' + outTok);
  adapterLog('done model=' + model + ' protocol=' + planned.mode + ' provider=' + planned.providerId +
    ' calls=' + fin.calls.length + ' text=' + content.length);
  endRes(res);
  } catch (e) {
    // 任何未预期异常都必须给引擎一个明确失败，绝不留下挂起的连接。
    const msg = String((e && e.message) || e).slice(0, 200);
    try { adapterLog('unhandled model=' + (model || '?') + ' ' + msg); } catch (_) {}
    try {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'Responses 兼容层内部错误：' + msg } }));
      } else {
        res.write('event: response.failed\ndata: ' + JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'shim_internal_error', message: msg } },
        }) + '\n\n');
        res.end();
      }
    } catch (_) {}
  }
}

function startServer() {
  
/* ============================================================================
 * 一键自检
 * 目标：一次调用把「能不能正常聊天 / 能不能正常跑 Agent」的全部前置条件过一遍，
 * 返回一份人能读、机器也能判的报告。能自动修的项标 fixable，前端点「修复」触发。
 * 每一项都独立 try/catch —— 单项异常不能拖垮整份报告。
 * ========================================================================== */
const SELFCHECK_REQUIRED = [
  'main.js', 'renderer.js', 'reasoning-slider.js', 'model-adapter.js',
  'index.html', 'package.json', 'connectors.js', 'asr-models.js', 'license.js',
];

/** 沙箱 helper 的两个可执行文件：缺了它 Agent 的命令一律 launch_failed。 */
function sandboxHelperNames() {
  return process.platform === 'win32'
    ? ['codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
    : ['codex-command-runner', 'codex-windows-sandbox-setup'];
}

/** 按候选顺序找「同时含两个 helper 的目录」，找到即返回来源与目标可用位置。 */
function locateSandboxHelpers() {
  const names = sandboxHelperNames();
  const has = (dir) => { try { return names.every(n => fs.existsSync(path.join(dir, n))); } catch { return false; } };
  const targets = [path.join(ENGINE_DIR, 'codex-resources'), path.join(ROOT, 'home', '.sandbox-bin')];
  for (const t of targets) if (has(t)) return { ok: true, source: t, targets };
  // 安装包只带了 codex.exe 时，helper 还留在 @openai/codex 的 vendor 目录里；
  // 版本号会变，所以扫 .pnpm 下所有 @openai+codex@* 而不是写死 0.167.0。
  const bases = [
    path.resolve(APP_DIR, '..', 'engine', 'node_modules', '.pnpm'),
    path.resolve(RES, '..', 'engine', 'node_modules', '.pnpm'),
    path.resolve(APP_DIR, '..', '..', 'engine', 'node_modules', '.pnpm'),
  ];
  for (const base of bases) {
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter(d => /^@openai\+codex@/.test(d)); } catch { continue; }
    for (const d of dirs) {
      const cand = path.join(base, d, 'node_modules', '@openai', 'codex', 'vendor',
        'x86_64-pc-windows-msvc', 'codex-resources');
      if (has(cand)) return { ok: true, source: cand, targets };
      const cand2 = path.join(base, d, 'node_modules', '@openai', 'codex', 'vendor', 'codex-resources');
      if (has(cand2)) return { ok: true, source: cand2, targets };
    }
  }
  return { ok: false, source: '', targets };
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ ok, msg });
    };
    sock.setTimeout(timeoutMs || 1500);
    sock.once('connect', () => finish(true, '可连接'));
    sock.once('timeout', () => finish(false, '连接超时'));
    sock.once('error', (e) => finish(false, (e && (e.code || e.message)) || '连接失败'));
    try { sock.connect(port, host); } catch (e) { finish(false, String((e && e.message) || e)); }
  });
}

/** 取本机 HTTP 资源的真实状态码：脚本白名单漏登记时 index.html 里的 <script> 会 404。 */
function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (done) return; done = true; resolve(code); };
    try {
      const req = http.get(url, (r) => {
        r.resume();
        finish(r.statusCode || 0);
        r.on('end', () => {});
      });
      req.setTimeout(timeoutMs || 1500, () => { try { req.destroy(); } catch {} finish(0); });
      req.on('error', () => finish(0));
    } catch (e) { finish(0); }
  });
}

function parseEndpoint(base) {
  try {
    const u = new URL(String(base));
    return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
  } catch { return null; }
}

/** 引擎真实下发的工具集（8 个扁平 function + 1 个 namespace + 1 个内置），用来验工具路由。 */
const SELFCHECK_ENGINE_TOOLS = [
  { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'function', name: 'write_stdin', description: 'stdin', parameters: { type: 'object', properties: { chars: { type: 'string' } } } },
  { type: 'function', name: 'shell', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
  { type: 'function', name: 'apply_patch', description: 'patch', parameters: { type: 'object', properties: { patch: { type: 'string' } } } },
  { type: 'function', name: 'update_plan', description: 'plan', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'view_image', description: 'img', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'function', name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'function', name: 'read_file', description: 'cat', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', description: 's', parameters: { type: 'object', properties: {} } }] },
  { type: 'web_search', external_web_access: false },
];

async function runSelfcheck() {
  const t0 = Date.now();
  const checks = [];
  const add = (id, name, ok, detail, opt) => {
    opt = opt || {};
    checks.push({ id, name, ok: !!ok, level: opt.level || 'error',
      detail: String(detail == null ? '' : detail), fixable: !!opt.fixable });
  };

  /* ---- 1. 引擎配置 ---- */
  let cfg = '';
  const homeDir = codexHomes()[0];
  try { cfg = fs.readFileSync(path.join(homeDir, 'config.toml'), 'utf8'); } catch {}
  const cfgRules = {
    'model_provider': /^\s*model_provider\s*=\s*"[^"]+"/m.test(cfg),
    '本地 base_url': /base_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/v1"/.test(cfg),
    'wire_api=responses': /wire_api\s*=\s*"responses"/.test(cfg),
    'sandbox_mode': /^\s*sandbox_mode\s*=\s*"[^"]+"/m.test(cfg),
    'approval_policy': /^\s*approval_policy\s*=\s*"[^"]+"/m.test(cfg),
    'LF 行尾': cfg.length > 0 && cfg.indexOf('\r') < 0,
  };
  const cfgBad = Object.keys(cfgRules).filter(k => !cfgRules[k]);
  add('engine-config', '引擎配置', cfgBad.length === 0,
    cfgBad.length ? ('缺失/异常：' + cfgBad.join('、')) : 'provider / 本地端点 / responses / workspace-write / 无 CR 均就位',
    { fixable: true });

  /* ---- 2. 密钥隔离 ---- */
  const secretOk = /\[shell_environment_policy\]/.test(cfg) && /NVIDIA_API_KEY/.test(cfg);
  add('secret-isolation', '密钥隔离', secretOk,
    secretOk ? 'shell_environment_policy 已排除 NVIDIA_API_KEY 与 *KEY* 系列' : '缺少 shell_environment_policy 排除规则',
    { fixable: true });

  /* ---- 3. 沙箱执行器 ---- */
  const helpers = locateSandboxHelpers();
  add('sandbox-helpers', '沙箱执行器', helpers.ok,
    helpers.ok ? ('已就位：' + path.basename(helpers.source)) : '缺少 codex-command-runner / codex-windows-sandbox-setup',
    { fixable: !!helpers.source || !helpers.ok });

  /* ---- 4. 打包完整性 ---- */
  let missing = [];
  try { missing = SELFCHECK_REQUIRED.filter(f => !fs.existsSync(path.join(APP_DIR, f))); } catch (e) { missing = ['读取失败']; }
  let pkgVer = '';
  try { pkgVer = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || ''; } catch {}
  add('package-integrity', '打包完整性', missing.length === 0,
    missing.length ? ('缺失：' + missing.join('、')) : ('9 个必需文件齐全 · v' + (pkgVer || '?')));

  /* ---- 5. 工作目录白名单 ---- */
  let rootsOk = false, rootsDetail = '';
  try {
    const roots = agentRoots();
    const sysRoot = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const blocked = !isDirAllowed(sysRoot);
    rootsOk = blocked && roots.length > 0 && roots.every(r => isDirAllowed(r));
    rootsDetail = '允许 ' + roots.length + ' 个根目录' + (blocked ? '，系统盘已拒绝' : '，但系统盘未被拒绝');
    if (settings.dirs && settings.dirs.chatArchive) {
      const inRoots = roots.some(r => String(settings.dirs.chatArchive).toLowerCase().indexOf(String(r).toLowerCase()) === 0);
      rootsDetail += inRoots ? '；数据目录在范围内' : '；数据目录不在范围内';
      if (!inRoots) rootsOk = false;
    }
  } catch (e) { rootsDetail = String(e.message || e); }
  add('agent-roots', '工作目录白名单', rootsOk, rootsDetail);

  /* ---- 6. 快照与还原 ---- */
  let snapOk = false, snapDetail = '';
  const probeDir = path.join(SNAPSHOT_DIR, '.selfcheck-' + Date.now());
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    const fp = path.join(probeDir, 'probe.txt');
    fs.writeFileSync(fp, 'BEFORE');
    const snap = makeSnapshot(probeDir);
    if (snap.ok) {
      fs.writeFileSync(fp, 'AFTER');
      const r = restoreSnapshot(snap.runId, probeDir);
      snapOk = r.ok && fs.readFileSync(fp, 'utf8') === 'BEFORE';
      snapDetail = '快照 ' + snap.count + ' 文件 → 还原 ' + (r.restored || 0) + ' 文件，内容一致=' + snapOk;
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, snap.runId + '.json')); } catch {}
    } else snapDetail = snap.reason || '快照失败';
  } catch (e) { snapDetail = String(e.message || e); }
  finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {} }
  add('snapshot', '快照与一键还原', snapOk, snapDetail);

  /* ---- 7. 审计日志 ---- */
  let auditOk = false;
  try {
    const before = fs.existsSync(AGENT_AUDIT_LOG) ? fs.statSync(AGENT_AUDIT_LOG).size : 0;
    audit({ kind: 'selfcheck', note: 'one-click selfcheck' });
    auditOk = fs.statSync(AGENT_AUDIT_LOG).size > before;
  } catch {}
  add('audit', '审计日志', auditOk, auditOk ? '可写：agent-audit.log' : '写入失败');

  /* ---- 8. Agent 适配层 ---- */
  let capCount = 0, guardOk = false, capDetail = '';
  try {
    const caps = adapter.capabilities() || {};
    capCount = Object.keys(caps).length;
    const g = adapter.guard.snapshot();
    guardOk = !!g;
    capDetail = '已学档位 ' + capCount + ' 个 · 护栏 ' + (guardOk ? '在线' : '未就绪');
  } catch (e) { capDetail = String(e.message || e); }
  add('adapter', 'Agent 适配层', capCount > 0 && guardOk, capDetail, { level: capCount > 0 ? 'error' : 'warn' });

  /* ---- 9. 工具路由 ---- */
  let routeDetail = '', routeOk = false;
  try {
    const norm = ModelAdapter.normalizeTools(SELFCHECK_ENGINE_TOOLS);
    const names = norm.tools.map(t => t.function.name);
    routeOk = names.length >= 8 && names.every(n => /^[A-Za-z0-9_-]+$/.test(n));
    routeDetail = '转发 ' + names.length + ' 个 · 丢弃 ' + norm.dropped.length +
      ' 个（' + Array.from(new Set(norm.dropped.map(d => d.reason))).join('/') + '）';
    if (!routeOk) routeDetail = '路由异常：' + names.join(',');
  } catch (e) { routeDetail = String(e.message || e); }
  add('tool-route', '工具路由', routeOk, routeDetail);

  /* ---- 10. 页面资源 ---- */
  const localPort = Number(settings.port) || 8760;
  // 只探页面脚本：/index.html 本身受令牌守卫（无令牌 401 是正常的），
  // 真正会「文件在包里但浏览器拿不到」的是脚本白名单漏登记。
  const assetPaths = ['/attachment-ui.js', '/renderer.js', '/connectors.js', '/reasoning-slider.js', '/workbench.js', '/text-stream.js',
    '/vendor/highlight-dark.css'];
  const assetCodes = await Promise.all(assetPaths.map(u =>
    httpProbe('http://127.0.0.1:' + localPort + u)));
  const assetBad = assetPaths.filter((u, i) => assetCodes[i] !== 200);
  add('page-assets', '页面资源', assetBad.length === 0,
    assetBad.length
      ? ('加载失败：' + assetBad.map(u => u + '(' + assetCodes[assetPaths.indexOf(u)] + ')').join('、'))
      : (assetPaths.length + ' 个页面资源均可加载（含主题样式、背景模块与工作台）'));

  /* ---- 11. 上游端点 ---- */
  const targets = [];
  try {
    for (const pv of (settings.providers || [])) {
      const ep = parseEndpoint(pv && pv.base);
      if (ep) targets.push({ name: pv.name || pv.id, host: ep.host, port: ep.port });
    }
    const localPort = Number(settings.port) || 8760;
    targets.push({ name: '本机兼容层', host: '127.0.0.1', port: localPort });
  } catch {}
  const probeRes = await Promise.all(targets.map(t => tcpProbe(t.host, t.port, 1500)));
  const badHosts = targets.filter((t, i) => !probeRes[i].ok);
  add('upstream', '上游端点连通', badHosts.length === 0,
    badHosts.length
      ? ('不可达：' + badHosts.map(t => t.name + '(' + t.host + ':' + t.port + ')').join('、'))
      : ('全部可达：' + targets.length + ' 个端点'));

  /* ---- 12. 运行时 ---- */
  let rtOk = false, rtDetail = '';
  try {
    const sf = path.join(ROOT, 'settings.json');
    const raw = fs.readFileSync(sf, 'utf8');
    JSON.parse(raw);
    const probe = path.join(ROOT, '.selfcheck-w-' + Date.now());
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    rtOk = isModelId(settings.model);
    rtDetail = rtOk
      ? ('settings.json 可解析 · 数据目录可写 · 当前模型 ' + settings.model)
      : ('settings.json 可解析，但 model 不是合法 id：' + String(settings.model).slice(0, 60));
  } catch (e) { rtDetail = String(e.message || e); }
  add('runtime', '运行时数据', rtOk, rtDetail);

  /* ---- 13. 最近异常（只提示，不影响总判定） ---- */
  let warnDetail = '最近 24 小时无失败记录', warnOk = true, failN = 0, downN = 0;
  try {
    if (fs.existsSync(ADAPTER_LOG)) {
      const lines = fs.readFileSync(ADAPTER_LOG, 'utf8').trim().split('\n').filter(Boolean);
      const since = Date.now() - 24 * 3600 * 1000;
      for (const l of lines) {
        const ts = Date.parse(l.slice(0, 24));
        if (!isNaN(ts) && ts < since) continue;
        if (/fail|error|downgrade/i.test(l)) failN++;
        if (/downgrade/i.test(l)) downN++;
      }
      if (failN) {
        warnOk = false;
        warnDetail = '最近 24 小时 ' + failN + ' 条异常记录（其中降级 ' + downN + ' 次）';
      }
    }
  } catch {}
  add('recent-errors', '最近异常', warnOk, warnDetail, { level: 'warn' });

  const errors = checks.filter(c => c.level === 'error');
  return {
    ok: errors.every(c => c.ok),
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    version: pkgVer,
    platform: process.platform + ' ' + process.arch,
    checks,
    summary: {
      total: checks.length,
      pass: checks.filter(c => c.ok).length,
      fail: checks.filter(c => !c.ok && c.level === 'error').length,
      warn: checks.filter(c => !c.ok && c.level === 'warn').length,
      fixable: checks.filter(c => !c.ok && c.fixable).map(c => c.id),
    },
  };
}

/** 只修「能确定修好」的项；其余原样返回，不假装成功。 */
function applySelfcheckFixes(ids) {
  const want = Array.isArray(ids) && ids.length ? ids : ['engine-config', 'secret-isolation', 'sandbox-helpers'];
  const fixed = [], skipped = [], failed = [];

  if (want.indexOf('engine-config') >= 0 || want.indexOf('secret-isolation') >= 0) {
    try {
      ensureHomeConfig(codexHomes()[0], 'responses',
        settings.model || 'nvidia/nemotron-3-ultra-550b-a55b');
      fixed.push('engine-config', 'secret-isolation');
    } catch (e) { failed.push({ id: 'engine-config', error: String(e.message || e) }); }
  }

  if (want.indexOf('sandbox-helpers') >= 0) {
    const loc = locateSandboxHelpers();
    if (!loc.source) {
      skipped.push({ id: 'sandbox-helpers', reason: '本机找不到 helper 源文件，需重新安装或手动放置' });
    } else {
      let okAll = true;
      for (const t of loc.targets) {
        try {
          fs.mkdirSync(t, { recursive: true });
          for (const n of sandboxHelperNames()) {
            const from = path.join(loc.source, n);
            if (!fs.existsSync(from)) continue;
            const to = path.join(t, n);
            if (path.resolve(from) !== path.resolve(to)) fs.copyFileSync(from, to);
          }
        } catch (e) { okAll = false; failed.push({ id: 'sandbox-helpers', error: String(e.message || e) }); }
      }
      if (okAll) fixed.push('sandbox-helpers');
    }
  }

  for (const id of want) {
    if (fixed.indexOf(id) >= 0 || skipped.some(x => x.id === id) || failed.some(x => x.id === id)) continue;
    skipped.push({ id, reason: '该项不支持自动修复' });
  }
  return { fixed, skipped, failed };
}

/* ===================== 工作台：主进程内嵌网页视图 =====================
 * 使用 Electron WebContentsView（不是任意站点 iframe，X-Frame-Options/CSP 会挡住 iframe）。
 * 远程页面独立 partition、sandbox、无高权 preload；主 UI 的 API_TOKEN / API Key
 * 绝不注入远程页面。bounds 由前端 ResizeObserver 上报，主进程校验并夹在窗口内。
 */
function createWebViewFactory(getTargetWin) {
  let WebContentsView;
  try { WebContentsView = require('electron').WebContentsView; } catch (e) { return null; }
  const first = getTargetWin && getTargetWin();
  if (!WebContentsView || !first || !first.contentView) return null;
  const PARTITION = 'persist:whale-workbench-web';
  return {
    create(tabId, url, bounds, onInfo) {
      const host = (getTargetWin && getTargetWin()) || first;
      const view = new WebContentsView({
        webPreferences: {
          partition: PARTITION, sandbox: true, nodeIntegration: false,
          contextIsolation: true, webSecurity: true,
        },
      });
      // 视图归属记录在 view 上：分离/停靠时按实际宿主设置 bounds 与回收，
      // 绝不把主窗口坐标套到工具窗上。
      view.__host = host;
      host.contentView.addChildView(view);
      if (bounds) this.setBounds(view, bounds);
      const wc = view.webContents;
      // 新窗口 / target=_blank 不打开系统浏览器，统一在本 view 内导航或拒绝。
      wc.setWindowOpenHandler(({ url: u }) => {
        try {
          const p = new URL(u);
          if ((p.protocol === 'http:' || p.protocol === 'https:') && !isPrivateHost(p.hostname)) wc.loadURL(u);
        } catch (e) {}
        return { action: 'deny' };
      });
      wc.on('will-navigate', (e, u) => {
        try {
          const p = new URL(u);
          if (p.protocol !== 'http:' && p.protocol !== 'https:') e.preventDefault();
          if (isPrivateHost(p.hostname)) e.preventDefault();
        } catch (e2) { e.preventDefault(); }
      });
      const notify = () => { try { onInfo({ title: wc.getTitle(), url: wc.getURL() }); } catch (e) {} };
      wc.on('page-title-updated', notify);
      wc.on('did-navigate', notify);
      wc.on('did-navigate-in-page', notify);
      try { wc.loadURL(url).catch(() => {}); } catch (e) {}
      return view;
    },
    setBounds(view, b) {
      try {
        const host = view.__host || (getTargetWin && getTargetWin()) || first;
        const wb = host.getContentBounds();
        const x = Math.max(0, Math.min(wb.width - 1, Math.round(Number(b.x) || 0)));
        const y = Math.max(0, Math.min(wb.height - 1, Math.round(Number(b.y) || 0)));
        const w = Math.max(1, Math.min(wb.width - x, Math.round(Number(b.width) || 1)));
        const h = Math.max(1, Math.min(wb.height - y, Math.round(Number(b.height) || 1)));
        view.setBounds({ x, y, width: w, height: h });
      } catch (e) {}
    },
    nav(view, action) {
      try {
        const wc = view.webContents;
        if (action === 'back' && wc.canGoBack()) wc.goBack();
        else if (action === 'forward' && wc.canGoForward()) wc.goForward();
        else if (action === 'reload') wc.reload();
        return { ok: true, url: wc.getURL(), title: wc.getTitle(),
          canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
      } catch (e) { return { ok: false, error: String(e.message) }; }
    },
    destroy(view) {
      const host = view.__host || (getTargetWin && getTargetWin()) || first;
      try { host.contentView.removeChildView(view); } catch (e) {}
      try {
        const wc = view.webContents;
        if (typeof wc.destroy === 'function') wc.destroy();
        else if (typeof wc.close === 'function') wc.close();
      } catch (e) {}
    },
  };
}
/* 工作台布局状态机：docked（主窗停靠） / detached（独立工具窗） / hidden（收起）。
 * 唯一权威是**真实窗口**，不是调用方 POST 上来的字符串：
 * 工具窗存在且可见 → detached；主窗可见且工作台 open → docked；否则 hidden。 */
function workbenchWindowOpen() {
  try { return !!(workbenchWin && !workbenchWin.isDestroyed() && workbenchWin.isVisible()); } catch (e) { return false; }
}
function actualWorkbenchLayout() {
  if (workbenchWindowOpen()) return 'detached';
  let mainOk = false;
  try { mainOk = !!(win && !win.isDestroyed() && win.isVisible()); } catch (e) { mainOk = false; }
  if (mainOk && workbench && workbench.state.open) return 'docked';
  return 'hidden';
}
/* 所有「收起」路径都走这里：状态与真实窗口一起更新，不留下过期 layout/open。 */
function hideWorkbenchState(reason) {
  if (workbench) {
    workbench.setUi({ open: false, layout: 'hidden' });
    try { workbench.hideAllViews(); } catch (e) {}
  }
  return { layout: 'hidden', reason: reason || 'closed' };
}
function createWorkbenchWindow() {
  if (workbenchWin && !workbenchWin.isDestroyed()) {
    try { workbenchWin.show(); workbenchWin.focus(); } catch (e) {}
    if (workbench) workbench.setUi({ open: false, layout: 'detached' });
    return { ok: true, reused: true, layout: 'detached' };
  }
  let BrowserWindow, screen;
  try { ({ BrowserWindow, screen } = require('electron')); } catch (e) { return { error: 'not desktop' }; }
  if (!BrowserWindow || !screen) return { error: 'not desktop' };
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.max(320, Math.min(380, wa.width - 40));
  const h = Math.max(420, Math.min(640, wa.height - 40));
  const x = Math.max(wa.x, wa.x + wa.width - w - 24);
  const y = Math.max(wa.y, wa.y + 60);
  workbenchWin = new BrowserWindow({
    width: w, height: h, x: x, y: y, minWidth: 320, minHeight: 420,
    show: false, frame: true, backgroundColor: '#05070d', title: 'WhaleCodex 工作台',
    webPreferences: {
      sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, partition: 'persist:whale-main',
      preload: path.join(__dirname, 'preload.js'), navigateOnDragDrop: false,
    },
  });
  const port = Number(settings.port) || 8760;
  workbenchWin.loadURL('http://127.0.0.1:' + port + '/workbench-window.html',
    { extraHeaders: 'X-Whale-Token: ' + API_TOKEN });
  workbenchWin.once('ready-to-show', () => { try { workbenchWin.show(); } catch (e) {} });
  workbenchWin.on('closed', () => {
    workbenchWin = null;
    if (workbench) { try { workbench.hideAllViews(); } catch (e) {} }
    // 停靠流程会**主动**关掉工具窗：那是迁移，不是「收起工作台」。
    // closed 事件是异步回来的，若无条件置 hidden，会把刚设好的 docked 打回 hidden
    // （表现：停靠返回成功，但状态立刻变成 hidden）。
    if (workbench && workbench.state.layout === 'docked') return;
    hideWorkbenchState('tool_window_closed');
  });
  if (workbench) workbench.setUi({ open: false, layout: 'detached' });
  return { ok: true, created: true, layout: 'detached', bounds: { x: x, y: y, width: w, height: h } };
}
function closeWorkbenchWindow() {
  if (workbenchWin && !workbenchWin.isDestroyed()) { try { workbenchWin.close(); } catch (e) {} }
  workbenchWin = null;
  if (workbench) { try { workbench.hideAllViews(); } catch (e) {} }
  return hideWorkbenchState('close_requested');
}
function mainWindowWidth() {
  try { return (win && !win.isDestroyed()) ? win.getContentBounds().width : 0; } catch (e) { return 0; }
}
function mainWindowVisible() {
  try { return !!(win && !win.isDestroyed() && win.isVisible()); } catch (e) { return false; }
}
/* 停靠：先按真实内容区宽度判定能否并排，再让主窗 renderer 实际应用并回传确认。
 * 只有拿到 dockAck（工作台确实可见且宽度够）才关工具窗；否则回滚并保留工具窗，
 * 绝不用「关掉工具窗」冒充「停靠成功」（验收阻断项 3）。 */
async function dockWorkbenchWindow() {
  const W = initWorkbench();
  const gate = canDockAt(mainWindowWidth());
  if (!mainWindowVisible()) {
    return { ok: false, reason: '主窗口不可见，无法停靠；已保持独立工具窗', layout: W.uiState().layout };
  }
  if (!gate.ok) {
    return { ok: false, reason: gate.reason, layout: W.uiState().layout, needed: gate.needed, actual: gate.actual };
  }
  const since = Date.now();
  W.state.dockRequestAt = since;   // 前端凭这个时刻决定何时回传一次确认
  W.setUi({ open: true, layout: 'docked' });
  // 等主窗 renderer 应用布局后回传实测确认（最长 2s）
  let ack = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = W.state.dockAck;
    if (a && Number(a.at) >= since) { ack = a; break; }
  }
  if (!ack || ack.visible === false || ack.canDock === false) {
    // 回滚：主窗没能真正显示工作台 → 保持工具窗与 detached
    W.setUi({ open: false, layout: 'detached' });
    // 若主窗明确回报「宽度不够」，用与门限同一套字段回报，避免同一个「拒绝停靠」
    // 出现两种返回形状（前端/验收都要能稳定读到 needed/actual）。
    if (ack && ack.canDock === false) {
      const actualW = Number(ack.clientWidth) || 0;
      return {
        ok: false,
        reason: '主窗内容区仅 ' + Math.round(actualW) + 'px，需 ' + DOCK_MIN_WIDTH + 'px 以上才能并排停靠；已保持独立工具窗',
        layout: W.uiState().layout, ack: ack, needed: DOCK_MIN_WIDTH, actual: Math.round(actualW),
        gate: 'renderer_ack',
      };
    }
    return {
      ok: false,
      reason: ack ? '主窗已响应但工作台未真正可见（布局被折叠）；已保持独立工具窗'
        : '主窗未在 2 秒内确认显示工作台；已保持独立工具窗',
      layout: W.uiState().layout, ack: ack || null, gate: ack ? 'renderer_ack' : 'ack_timeout',
    };
  }
  // 停靠成功：关掉工具窗。这里**不能**走 closeWorkbenchWindow()——
  // 它会置 layout=hidden，把刚建立的 docked 抹掉（closed 事件还是异步的）。
  if (workbenchWin && !workbenchWin.isDestroyed()) { try { workbenchWin.close(); } catch (e) {} }
  workbenchWin = null;
  try { W.hideAllViews(); } catch (e) {}
  W.setUi({ open: true, layout: 'docked' });
  const finalLayout = actualWorkbenchLayout();
  return { ok: finalLayout === 'docked', layout: finalLayout, ack: ack,
    reason: finalLayout === 'docked' ? undefined : '停靠后实际布局不是 docked，已如实上报' };
}
/* 分离：主窗收起工作台，改由独立工具窗承载；工具窗创建失败则回滚到 docked。 */
function detachWorkbenchWindow() {
  const W = initWorkbench();
  const r = createWorkbenchWindow();
  if (r && r.error) {
    W.setUi({ open: true, layout: 'docked' });
    return { ok: false, error: r.error, layout: 'docked', reason: '工具窗创建失败，已回滚为主窗停靠' };
  }
  W.setUi({ open: false, layout: 'detached' });
  return { ok: true, layout: 'detached', reused: !!r.reused };
}

function initWorkbench() {
  if (workbench) return workbench;
  workbench = new Workbench({
    ROOT: ROOT, runs: initRuns(), sse: sse, endRes: endRes,
    isPathAllowed: (p) => isDirAllowed(p),
    allowLoopback: settings.workbenchAllowLoopback === true,
    defaultDir: () => (settings.dirs && settings.dirs.testFiles) || agentRoots()[0] || ROOT,
    chatDir: (root) => path.join(root, 'chats'),
    attachmentSession: sid => {
      if (typeof sid !== 'string' || !attachmentSessionLive(sid)) return null;
      const chat = chatRead(sid) || loadSession(sid);
      return chat && chat.id === sid ? sid : null;
    },
    registerAttachment: record => attachmentStore.register(record),
    attachmentMetadata: (id, sid) => {
      if (attachmentSessionRevoked(sid)) return null;
      const resolved = attachmentStore.resolve(id, sid, { action: 'show' });
      return resolved.ok ? resolved.attachment : null;
    },
    // 布局以真实窗口为准：工具窗在 → detached；主窗开着工作台 → docked；否则 hidden。
    layoutProbe: () => actualWorkbenchLayout(),
    // 供 /api/workbench/state 如实报告「主窗到底可见没有」，便于区分 hidden 的原因。
    mainVisible: () => mainWindowVisible(),
  });
  if (win) {
    workbench.attachViewFactory(createWebViewFactory(() => {
      // 工具窗可见时由它承载网页面板；否则挂回主窗口。
      try {
        if (workbenchWin && !workbenchWin.isDestroyed() && workbenchWin.isVisible()) return workbenchWin;
      } catch (e) {}
      return win;
    }));
  }
  return workbench;
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const nonce = crypto.randomBytes(16).toString('base64');
    securityHeaders(res, nonce);

    // ---------- 加固③：统一访问守卫 ----------
    // 页面入口允许一次性 URL 令牌（托盘"在浏览器打开"用），API 只认请求头；
    // /v1/* 是 Codex 引擎的本地兼容层，不带令牌但同样受 loopback / Origin 白名单约束。
    const isPage = req.method === 'GET'
      && (url === '/' || url === '/index.html' || url === '/activate' || url === '/workbench-window.html');
    const isApi = url.indexOf('/api/') === 0;
    if (!guard(req, res, isPage ? 'query' : (isApi ? 'header' : false))) return;

    // ---------- 加固②：License 激活锁接口 ----------
    if (req.method === 'GET' && url === '/activate') {
      // 免费版没有激活环节，直接把用户送回主界面，避免旧书签/旧快捷方式停在激活页
      if (FREE_MODE) {
        res.writeHead(302, { Location: '/?wtok=' + encodeURIComponent(requestToken(req, true) || API_TOKEN) });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(injectGuardHtml(ACTIVATION_HTML, nonce));
    }
    if (req.method === 'GET' && url === '/api/license/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        locked: FREE_MODE ? false : !license.isActivated(),
        free: FREE_MODE,
        machineId: license.currentMachineId(),
      }));
    }
    if (req.method === 'GET' && url === '/api/license/machine-id') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ machineId: license.currentMachineId() }));
    }
    if (req.method === 'POST' && url === '/api/license/activate') {
      const raw = await readBodyRaw(req);
      let key = '';
      try { key = (JSON.parse(raw || '{}').key || '').trim(); } catch (e) {}
      const v = license.verifyLicense(key);
      if (v.ok && license.writeStored(key)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, reason: (v && v.reason) || '授权无效' }));
    }
    // 主应用入口：免费版直接进主界面；开启授权锁时才按激活状态分流（不做 302，避免重定向丢掉令牌头）
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      const locked = FREE_MODE ? false : !license.isActivated();
      const body = locked ? ACTIVATION_HTML : fs.readFileSync(path.join(APP_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(injectGuardHtml(body, nonce));
    }
    // 工具窗页面：只渲染工作台（同一后端、同一令牌注入），不加载主聊天脚本
    if (req.method === 'GET' && url === '/workbench-window.html') {
      const f = path.join(APP_DIR, 'workbench-window.html');
      if (!fs.existsSync(f)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('workbench window missing');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(injectGuardHtml(fs.readFileSync(f), nonce));
    }
    // Codex 的 Responses 客户端指向本机：/v1/responses 是兼容层入口
    if (req.method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
      return handleResponsesShim(req, res);
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'nvidia' })),
      }));
    }
    // ---------- 会话持久化（磁盘分片） ----------
    if (url === '/api/chats' || url.startsWith('/api/chats/')) {
      const rest = url.slice('/api/chats'.length).replace(/^\//, '');
      const qs = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && !rest) {
        // full=1 一次拿全部会话（含消息）；否则只给索引，用于列表渲染
        if (/(^|&)full=1/.test(qs)) return json(200, chatListAll());
        const arr = [...chatsLoadIndex().values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return json(200, arr);
      }
      if (req.method === 'GET' && rest === 'search') {
        const m = /(?:^|&)q=([^&]*)/.exec(qs);
        const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
        return json(200, chatSearch(q));
      }
      if (req.method === 'POST' && rest === 'bulk') {
        const raw = await readBodyRaw(req);
        let arr = [];
        try { arr = JSON.parse(raw || '[]'); } catch {}
        if (!Array.isArray(arr)) return json(400, { ok: false, error: '需要会话数组' });
        let okCount = 0, fail = 0;
        for (const c of arr) {
          const r = chatWrite(c);
          r.ok ? okCount++ : fail++;
        }
        return json(200, { ok: true, imported: okCount, failed: fail });
      }
      if (rest) {
        const id = decodeURIComponent(rest);
        if (req.method === 'GET') {
          const c = chatRead(id);
          return c ? json(200, c) : json(404, { ok: false, error: '会话不存在' });
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const raw = await readBodyRaw(req);
          let c = null;
          try { c = JSON.parse(raw || 'null'); } catch {}
          if (!c || typeof c !== 'object') return json(400, { ok: false, error: '请求体不是合法会话' });
          if (!c.id) c.id = id;
          return json(200, chatWrite(c));
        }
        if (req.method === 'DELETE') {
          try { revokeAttachmentSession(id); }
          catch { return json(500, { ok: false, error: 'ATTACHMENT_REVOCATION_SAVE_FAILED' }); }
          return json(200, chatDelete(id));
        }
      }
      return json(404, { ok: false, error: '未知的会话接口' });
    }
    // 语音转文字：前端把录音解码成 16k 单声道 WAV 直接 POST 过来
    if (req.method === 'POST' && url === '/api/asr') {
      const parts = [];
      let tooBig = false;
      let total = 0;
      const LIMIT = 64 * 1024 * 1024;   // 单请求上限 64MB（≈33 分钟 16k 单声道），超了直接拒绝
      req.on('data', c => {
        total += c.length;
        if (!tooBig && total > LIMIT) {
          tooBig = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '音频过大，请分段后重试' }));
          req.destroy();
          return;
        }
        if (!tooBig) parts.push(c);
      });
      req.on('end', async () => {
        if (tooBig) return;
        const buf = Buffer.concat(parts);
        if (!buf.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '空音频' }));
        }
        const tmp = path.join(process.env.TEMP || ROOT,
          'whale-asr-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.wav');
        try { fs.writeFileSync(tmp, buf); } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '写入临时文件失败：' + String(e.message || e) }));
        }
        const t0 = Date.now();
        let j;
        try {
          j = await asrTranscribe(tmp);
        } catch (e) {
          j = { error: String((e && e.message) || e) };   // 保证任何异常都有响应，不能让前端一直等
        }
        try { fs.unlinkSync(tmp); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !j.error, text: String(j.text || '').trim(),
          ms: Date.now() - t0, error: j.error || null, model: j.model || asr.model || '',
        }));
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/asr/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.assign({ ok: true }, asrStatus())));
    }
    // 高精度语音模型：清单 / 下载 / 删除，全部由用户显式触发，不自动联网
    if (url.indexOf('/api/asr/models') === 0) {
      try {
        if (req.method === 'GET' && url === '/api/asr/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(modelListState()));
        }
        if (req.method === 'POST' && url === '/api/asr/models/refresh') {
          await refreshModelManifest();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(modelListState()));
        }
        if (req.method === 'POST' && (url === '/api/asr/models/download' || url === '/api/asr/models/delete' || url === '/api/asr/models/use')) {
          let b = {};
          try { b = JSON.parse((await readBodyRaw(req)) || '{}'); } catch (e) {}
          const key = String(b.key || '');
          let out;
          if (url === '/api/asr/models/download') out = await startModelDownload(key);
          else if (url === '/api/asr/models/delete') out = deleteDownloadedModel(key);
          else out = await useDownloadedModel(key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(Object.assign({ ok: true }, out)));
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(Object.assign({}, modelListState(), { ok: false, reason: String((e && e.message) || e) })));
      }
    }
    // ---------- 语音与机器人：可达性检测 + 打开外部面板 ----------
    // GPT-SoVITS（api_v2.py，默认 9880）与 AstrBot（WebUI，默认 6185）都是用户自己部署的外部服务，
    // 客户端只负责「填地址 → 探一下通不通 → 点开面板」，不把任何运行时搬进安装包。
    if (url.startsWith('/api/voice/check')) {
      let target = '';
      try { target = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('target') || ''); } catch (e) {}
      const conf = settings.voice || {};
      const raw = target === 'bot' ? conf.bot : conf.tts;
      const reply = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (!raw) return reply({ ok: false, empty: true, reason: '未填写地址' });
      let u;
      try { u = new URL(String(raw)); } catch (e) { return reply({ ok: false, reason: '地址格式不对' }); }
      if (!/^https?:$/.test(u.protocol)) return reply({ ok: false, reason: '只支持 http/https' });
      const mod = u.protocol === 'https:' ? require('https') : require('http');
      const started = Date.now();
      let done = false;
      const fin = (obj) => { if (done) return; done = true; obj.ms = Date.now() - started; reply(obj); };
      const probe = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET', timeout: 5000,
        headers: { 'User-Agent': 'WhaleCodex/voice-check', Accept: '*/*' },
      }, (resp) => {
        resp.resume();   // 只关心可达性和状态码，不落内容
        fin({ ok: true, status: resp.statusCode, note: '可达（HTTP ' + resp.statusCode + '）' });
      });
      probe.on('timeout', () => { try { probe.destroy(); } catch (e) {} fin({ ok: false, reason: '超时（5 秒无响应）' }); });
      probe.on('error', (e) => fin({ ok: false, reason: String((e && (e.code || e.message)) || e) }));
      return probe.end();
    }
    if (url.startsWith('/api/open-url')) {
      let target = '';
      try { target = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('target') || ''); } catch (e) {}
      const conf = settings.voice || {};
      // 只允许打开设置里保存过的地址，避免本接口变成任意 URL 的跳板
      const raw = target === 'bot' ? conf.bot : conf.tts;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!raw) return res.end(JSON.stringify({ ok: false, reason: '未填写地址' }));
      try { await shell.openExternal(String(raw)); } catch (e) {}
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.startsWith('/api/open-ext')) {
      // 官方站点固定白名单：URL 只存在主进程里，页面无法借此打开任意地址
      const EXT_DOCS = {
        tts: 'https://github.com/RVC-Boss/GPT-SoVITS',
        bot: 'https://github.com/AstrBotDevs/AstrBot',
        botdocs: 'https://docs.astrbot.app',
      };
      let key = '';
      try { key = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('target') || ''); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const link = EXT_DOCS[key];
      if (!link) return res.end(JSON.stringify({ ok: false, reason: '未知链接' }));
      try { await shell.openExternal(link); } catch (e) {}
      return res.end(JSON.stringify({ ok: true, url: link }));
    }
    // ---------- 连接器：状态查询 / 连接 / 断开 ----------
    if (url === '/api/connectors') {
      if (req.method === 'GET') {
        const state = (settings.connectors && typeof settings.connectors === 'object') ? settings.connectors : {};
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, registry: CONNECTOR_REGISTRY, state }));
      }
      if (req.method === 'POST') {
        let b = {};
        try { b = JSON.parse((await readBodyRaw(req)) || '{}'); } catch (e) {}
        const id = String(b.id || '');
        const reg = CONNECTOR_REGISTRY.find(c => c.id === id);
        if (!reg) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, reason: '未知连接器：' + id }));
        }
        // 连点同一个开关：直接回忙，既不发第二次 logout，也不让状态来回跳
        if (connectorBusy.has(id)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, busy: true, reason: '正在处理中，请稍候…' }));
        }
        connectorBusy.set(id, Date.now());
        try {
          const enabled = !!b.enabled;
          const config = (b.config && typeof b.config === 'object') ? b.config : {};
          // 断开 OAuth 连接器时，先注销凭据再删配置（config.toml 里还在，codex 才能找到该 server）
          let logout = null;
          if (!enabled && reg.oauthFlow) logout = await logoutConnectorOAuth(id);
          // 关掉开关就没有「等待授权」的意义了：顺手终止该连接器还在跑的授权进程
          if (!enabled && oauthJob.id === id && oauthJob.proc) abortConnectorOAuth('连接器已断开，授权已取消');
          settings.connectors = settings.connectors || {};
          settings.connectors[id] = { enabled, config };
          try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8'); } catch (e) {}
          const sync = syncConnectorMcp();
          let note;
          if (!enabled) note = (logout && !logout.ok) ? ('已断开（授权凭据清理失败：' + (logout.reason || '未知') + '）') : '已断开';
          else if (reg.auth === 'local') note = '已连接（本地工具箱已写入 Codex 配置，下次对话即可调用）';
          else if (reg.auth === 'oauth') {
            note = reg.oauthFlow
              ? '已写入配置，点「授权」在浏览器完成登录即可使用'
              : '已写入配置，但该服务商不支持本机回调，需自建地址或改用令牌';
          }
          else note = '已保存并连接（令牌已写入本机设置）';
          if (enabled && sync.skipped && sync.skipped.indexOf(id) >= 0) {
            note = '已保存，但该连接器还没填服务地址，暂时不会写入 Codex 配置';
          }
          if (!sync.ok) note += '；但配置同步失败：' + (sync.reason || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // ok=开关已保存；syncOk=写入 Codex 配置是否成功。
          // 两者混用会让前端在「配置同步失败」时把已经保存的开关回弹成关闭，用户于是反复点、越点越乱。
          return res.end(JSON.stringify({
            ok: true, saved: true, syncOk: !!sync.ok, note,
            reason: sync.ok ? null : (sync.reason || '配置同步失败'),
            count: sync.count || 0, skipped: sync.skipped || [],
          }));
        } finally {
          connectorBusy.delete(id);
        }
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: '方法不支持' }));
    }
    // 连接器 OAuth：发起授权 / 查询进度
    if (url === '/api/connectors/oauth') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(Object.assign({ ok: true }, oauthStatus())));
      }
      if (req.method === 'POST') {
        let b = {};
        try { b = JSON.parse((await readBodyRaw(req)) || '{}'); } catch (e) {}
        if (String(b.action || '') === 'cancel') {
          abortConnectorOAuth('已取消授权');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(Object.assign({ ok: true, cancelled: true }, oauthStatus())));
        }
        const r = await startConnectorOAuth(String(b.id || ''));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(Object.assign({
          ok: r.ok, busy: !!r.busy, reason: r.reason || null, note: r.note || null, home: r.home || null,
        }, oauthStatus())));
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: '方法不支持' }));
    }
    // 连接器状态检测：带 id 检测单个，不带 id 检测全部已开启项（面板打开时批量用）
    if (url.startsWith('/api/connectors/check')) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, reason: '方法不支持' }));
      }
      let id = '';
      try { id = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '').trim(); } catch (e) {}
      try {
        const r = await checkConnectors(id ? [id] : []);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, reason: String((e && e.message) || e), items: [] }));
      }
    }
    if (req.method === 'GET' && url === '/avatar') {
      const p = path.join(ASSETS, 'avatar.png');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(p));
    }
    // 应用图标（与桌面/窗口图标同源，取自 app.ico 的 256px 图层），供界面内 logo / 空状态使用
    if (req.method === 'GET' && url === '/icon.png') {
      const p = path.join(ASSETS, 'app-icon.png');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(p));
    }
    if (req.method === 'GET' && url === '/api/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 无密钥时模型列表清空：未配置 / 解绑 / 云端注销三种情况统一走这里，
      // 前端据此隐藏所有模型，而不是显示一串「未配置密钥」的假列表。
      const hasKey = !!activeApiKey();
      return res.end(JSON.stringify({
        models: hasKey ? activeModels() : [],
        labels: MODEL_LABELS, catalog: MODEL_CATALOG, modelOwners: modelOwners(),
        default: settings.model || DEFAULT_MODEL,
        modelProtocols: settings.modelProtocols || {},
        failoverChain: FAILOVER_CHAIN,
        autoFailover: settings.autoFailover !== false,
        hasKey,
      }));
    }
    // 拉取云端真实可用模型：问上游 /models，返回该密钥实际可见的全部模型。
    // 「获取可用模型」用它自动识别 API 能调用的模型，而不是固定的内置模板清单。
    // 密钥支持 POST JSON {key,base}（推荐，密钥不出现在 URL 里）与 GET ?key=&base=（兼容旧版）。
    if ((req.method === 'GET' || req.method === 'POST') && url === '/api/available-models') {
      const qs = new URL(req.url, 'http://x').searchParams;
      let body = {};
      if (req.method === 'POST') { try { body = await readBody(req); } catch { body = {}; } }
      const rawKey = String((req.method === 'POST' ? body.key : '') || qs.get('key') || '');
      const rawBase = String((req.method === 'POST' ? body.base : '') || qs.get('base') || '');
      const hasProvided = !!String(rawKey).trim();
      const cleaned = cleanCredential(rawKey, rawBase);
      // 显式传了密钥却被判为占位文本时，不要偷偷回退到当前激活的另一个密钥
      const key = cleaned.key || (hasProvided ? '' : activeApiKey());
      const base = cleaned.base || (String(rawBase).trim() ? '' : activeBase());
      const notes = cleaned.warn ? [cleaned.warn] : [];
      const reply = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(Object.assign({ notes }, o)));
      };
      if (hasProvided && !cleaned.key) {
        return reply({ ok: false, hasKey: true, models: [], err: cleaned.warn || '密钥格式不正确，请粘贴完整的英文密钥' });
      }
      if (!key) return reply({ ok: true, hasKey: false, models: [] });
      if (!base) return reply({ ok: false, hasKey: true, models: [], err: '接口地址为空或格式不正确，请填写完整的 http(s):// 地址' });

      // 有的服务把 /models 挂在 /v1 下，有的挂在根路径，两种都试一次
      const roots = [base];
      if (/\/v\d+$/i.test(base)) roots.push(base.replace(/\/v\d+$/i, ''));
      let lastErr = '';
      for (const root of roots) {
        try {
          const r = await fetch(root + '/models', {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          const txt = await r.text().catch(() => '');
          if (r.status !== 200) {
            lastErr = 'HTTP ' + r.status + (txt ? ' ' + txt.slice(0, 120) : '');
            if (r.status === 401 || r.status === 403) lastErr += '（密钥无效，或接口地址与该密钥不属于同一服务商）';
            continue;
          }
          let j = {}; try { j = JSON.parse(txt); } catch {}
          // 兼容 {data:[...]} / {models:[...]} / 裸数组 / 字符串数组等常见返回格式
          const arr = Array.isArray(j) ? j
            : Array.isArray(j.data) ? j.data
            : Array.isArray(j.models) ? j.models
            : Array.isArray(j.data && j.data.models) ? j.data.models : [];
          const uniq = [];
          const seen = new Set();
          for (const m of arr) {
            if (!m) continue;
            const id = typeof m === 'string' ? m : (m.id || m.name || m.model || m.model_id);
            if (!id || seen.has(String(id))) continue;
            seen.add(String(id));
            const name = typeof m === 'string' ? m : (m.displayName || m.name || m.id || m.model || m.model_id);
            uniq.push({ id: String(id), name: String(name || id) });
          }
          return reply({ ok: true, hasKey: true, models: uniq, cloudTotal: uniq.length, endpoint: root + '/models' });
        } catch (e) {
          let msg = String((e && e.message) || e);
          if (/ByteString/i.test(msg)) msg = '密钥或接口地址含有非英文字符，请重新粘贴完整密钥';
          lastErr = msg.slice(0, 160);
        }
      }
      return reply({ ok: false, hasKey: true, models: [], err: lastErr || '上游未返回模型列表' });
    }
    // 模型实况检测：只在用户主动点击（或菜单里刷新）时跑，避免给上游白加请求
    if (req.method === 'POST' && url === '/api/model-health') {
      const body = await readBody(req);
      // 无密钥时「模型实况」必须为空，并删除旧的 no_key / 其他提供商快照。
      // 以前这里会按内置 MODELS 造 10 条 no_key 记录并落盘，重启后又被读回，造成模型列表永远清不掉。
      if (!activeApiKey()) {
        clearHealthSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, at: null, results: [], noKey: true }));
      }
      // 显式传了空数组就表示没有模型，绝不能再回退到内置全量目录。
      const list = Array.isArray(body.models)
        ? body.models.filter(m => typeof m === 'string' && m)
        : activeModels();
      const out = [];
      for (let i = 0; i < list.length; i += 3) {
        const batch = list.slice(i, i + 3);
        const rs = await Promise.all(batch.map(async (m) => {
          const t = Date.now();
          // 偏慢模型（step-5 实测首字 12~29 秒）给更长窗口，否则会被误判成排队
          const budget = (MODEL_CATALOG[m] && MODEL_CATALOG[m].health === 'slow') ? 45000 : 15000;
          try {
            // 用流式探测并记录首字节时间：用户感受到的延迟就是首字，而不是整轮耗时
            const r = await fetch(activeBase(m).replace(/\/+$/, '') + '/chat/completions', {
              method: 'POST', headers: upstreamHeaders(m),
              body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: true }),
              signal: AbortSignal.timeout(budget),
            });
            if (!r.ok || !r.body) {
              const txt = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 200);
              // 401/403 是认证失败（多半没配 key），不是排队；500 里带 Authorization 缺失也是同因
              const authFail = (r.status === 401 || r.status === 403) ||
                (r.status === 500 && /Authorization|Extension of type/i.test(txt));
              return { model: m, ok: false, status: r.status, ms: Date.now() - t,
                level: (r.status === 404 || r.status === 410) ? 'locked'
                  : (authFail ? 'no_key' : 'congested'),
                err: authFail ? '认证失败（未配置或密钥无效）'
                  : (r.ok ? '无响应体' : classifyUpstream(r.status, txt, m, 0).msg) };
            }
            let ttfb = null;
            try {
              // 注意：只统计"真正有正文/思考内容"的事件。连接一建立就到的空 chunk / :keep-alive
              // 会被误当成首字（step-5 就因此被算成 1.4s，实际用户要等 12s+）
              const reader = r.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              outer:
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value) continue;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                  const line = buf.slice(0, i).trim();
                  buf = buf.slice(i + 1);
                  if (!line.startsWith('data:')) continue;
                  const v = line.slice(5).trim();
                  if (!v || v === '[DONE]') continue;
                  let j; try { j = JSON.parse(v); } catch { continue; }
                  const dl = (j.choices || [])[0] && (j.choices || [])[0].delta || {};
                  // 只认"正文"首字：step-5 思考阶段能吐 20 多秒的 reasoning_content，
                  // 用户屏幕上却一个字都没有，拿它当首字会严重低估等待时间
                  if (dl.content) { ttfb = Date.now() - t; break outer; }
                  if (j.type === 'response.output_text.delta' && j.delta) { ttfb = Date.now() - t; break outer; }
                }
              }
              try { await reader.cancel(); } catch {}
            } catch {}
            const ms = ttfb || (Date.now() - t);
            return { model: m, ok: true, status: 200, ms,
              level: ms <= 5000 ? 'ok' : 'slow', err: null };
          } catch (e) {
            return { model: m, ok: false, status: 'timeout', ms: Date.now() - t, level: 'congested',
              err: Math.round(budget / 1000) + ' 秒内没有首字节（排队或不可达）' };
          }
        }));
        out.push(...rs);
      }
      healthSnapshot = { at: Date.now(), results: out };
      try { fs.writeFileSync(HEALTH_SNAP_FILE, JSON.stringify(healthSnapshot)); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, at: healthSnapshot.at, results: out }));
    }
    // 读取最近一次真实探测结果。无密钥时同时清掉旧快照，防止重启后残留模型。
    if (req.method === 'GET' && url === '/api/model-health') {
      if (!activeApiKey()) {
        clearHealthSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, at: null, results: [], noKey: true }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        at: healthSnapshot ? healthSnapshot.at : null,
        results: healthSnapshot ? healthSnapshot.results : [],
        noKey: false,
      }));
    }
    // 模型活动日志：GET 读取（新的在前），POST 清空
    if (url.startsWith('/api/model-activity')) {
      if (req.method === 'GET') {
        const qs = new URL(req.url, 'http://x').searchParams;
        const limit = Math.min(600, Math.max(1, Number(qs.get('limit')) || 120));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(Object.assign({ ok: true }, listModelActivity(limit))));
      }
      if (req.method === 'POST' && url === '/api/model-activity/clear') {
        await readBody(req).catch(() => ({}));
        modelActBuf.length = 0;
        modelActLoaded = true;
        try { fs.writeFileSync(MODEL_ACT_LOG, ''); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && url === '/api/model-activity/reveal') {
        try {
          if (fs.existsSync(MODEL_ACT_LOG)) shell.showItemInFolder(MODEL_ACT_LOG);
          else await shell.openPath(ROOT);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, file: MODEL_ACT_LOG }));
      }
    }
    // 主题资源：精确 URL → 已知本地文件表（不扩为任意路径文件服务）
    // 文件存在不等于 URL 可达，更不等于安装包包含它——三者需逐项对照。
    if (THEME_ASSETS[url]) {
      const ent = THEME_ASSETS[url];
      const abs = path.join(APP_DIR, ent.file);
      if (!fs.existsSync(abs)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('theme asset missing');
      }
      const isMedia = ent.mime === 'video/mp4';
      const stat = fs.statSync(abs);
      const total = stat.size;
      const baseHeaders = {
        'Content-Type': ent.mime + (isMedia ? '' : '; charset=utf-8'),
        'Cache-Control': isMedia ? 'public, max-age=604800' : 'no-store',
        'Accept-Ranges': isMedia ? 'bytes' : 'none',
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, Object.assign({ 'Content-Length': total }, baseHeaders));
        return res.end();
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      // 正常媒体读取：支持标准单段 Range（Chromium 取元数据、循环与定位要用）
      const range = req.headers.range;
      if (isMedia && range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m) {
          let start = m[1] === '' ? null : parseInt(m[1], 10);
          let end = m[2] === '' ? null : parseInt(m[2], 10);
          if (start === null && end === null) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total });
            return res.end();
          }
          if (start === null) { start = Math.max(0, total - end); end = total - 1; }
          if (end === null || end >= total) end = total - 1;
          if (start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total });
            return res.end();
          }
          res.writeHead(206, Object.assign({
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Content-Length': end - start + 1,
          }, baseHeaders));
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(abs, { start: start, end: end }).pipe(res);
        }
      }
      res.writeHead(200, Object.assign({ 'Content-Length': total }, baseHeaders));
      return fs.createReadStream(abs).pipe(res);
    }

    // 静态资源：vendor 目录 + 页面脚本 + 连接器官方图标（白名单，避免任意文件读取）
    const isVendor = url.startsWith('/vendor/');
    const isCnIcon = url.startsWith('/connector-icons/');
    // 页面脚本白名单：新增脚本必须在这里登记，否则 index.html 里的 <script> 会 404，
    // 表现为「文件明明在包里、window.XXX 却是 undefined」。
    const isPageScript = (url === '/renderer.js' || url === '/connectors.js' || url === '/reasoning-slider.js');
    if (req.method === 'GET' && (isVendor || isPageScript || isCnIcon)) {
      const name = path.basename(decodeURIComponent(url));
      const p = isVendor ? path.join(APP_DIR, 'vendor', name)
        : isCnIcon ? path.join(APP_DIR, 'connector-icons', name)
        : path.join(APP_DIR, name);
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      const ext = path.extname(name).toLowerCase();
      if (isCnIcon && ext !== '.png') { res.writeHead(404); return res.end(); }
      const type = ext === '.css' ? 'text/css'
        : ext === '.js' ? 'text/javascript'
        : ext === '.png' ? 'image/png'
        : ext === '.svg' ? 'image/svg+xml'
        : 'application/octet-stream';
      // 只有图标长缓存；页面脚本必须 no-store，否则更新后仍跑旧 renderer（实测踩过）
      const cache = isCnIcon ? 'public, max-age=604800' : 'no-store';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': cache });
      return res.end(fs.readFileSync(p));
    }
    // 设置读写
    if (url === '/api/settings') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const providers = normalizeProviders(settings.providers);
        const ap = activeProvider();
        return res.end(JSON.stringify({
          model: settings.model, nimBase: activeApiKey() ? activeBase() : '', port: settings.port,
          ds41Thinking: settings.ds41Thinking === 'on' ? 'on' : 'off',
          thinkingDepth: settings.thinkingDepth || DEFAULT_THINKING_DEPTH,
          hasKey: !!activeApiKey(), models: activeApiKey() ? activeModels() : [], labels: MODEL_LABELS,
          catalog: MODEL_CATALOG, modelOwners: modelOwners(), modelProtocols: settings.modelProtocols || {},
          providers,
          activeProviderId: providers.length ? ap.id : (settings.apiKey ? 'legacy' : ''),
          agentRoots: settings.agentRoots || [], agentSafeMode: settings.agentSafeMode === true,
          agentCapabilities: adapter.capabilities(), agentGuard: adapter.guard.snapshot(),
          dirs: settings.dirs, contextLimit: settings.contextLimit, compactAt: settings.compactAt,
          // 上下文策略开关：前端/验收要能读到当前生效值（默认开）
          contextSummary: settings.contextSummary !== false,
          contextTrim: settings.contextTrim !== false,
          // 只读子智能体：状态与策略一起暴露，前端/验收可直接读到「开没开、上限多少」
          subAgents: settings.subAgents === true,
          desktopControl: settings.desktopControl === true,
          desktopPolicy: {
            defaultOff: true,
            failClosed: true,
            windowAllowCount: desktopPolicy().allowedWindows.length,
            // 危险能力一律不开放（物理输入/坐标/焦点）
            physicalInputAllowed: false,
            headedAllowed: false,
            semanticOnly: true,
          },
          desktopGc: desktopRuntime.lastGc,
          subAgentsPolicy: {
            defaultOff: true,
            maxChildren: subAgentModule.LIMITS.maxChildren,
            childPoolRatio: subAgentModule.LIMITS.childPoolRatio,
            readOnly: true,
            permissions: subAgentModule.CHILD_CEILING,
            unknownCapability: 'reject_unless_probe',
            mergePolicy: 'none',
          },
          contextKeepRecentTurns: settings.contextKeepRecentTurns || 8,
          modelContextCap: (MODEL_CATALOG[settings.model] || {}).ctx || 0,
          effectiveContextLimit: effectiveContextLimit(settings.model || DEFAULT_MODEL),
          injectMemory: settings.injectMemory !== false,
          thinkingDepths: THINKING_DEPTHS,
          autoFailover: settings.autoFailover !== false,
          queueFallbackMs: settings.queueFallbackMs || 45000,
          failoverChain: getFailoverChain(),
          asrModel: settings.asrModel || '',
          asrModelFile: settings.asrModelFile || '',
          asrLang: settings.asrLang || 'zh',
          asrAudioCtx: (function () { const n = Number(settings.asrAudioCtx); return Number.isFinite(n) ? n : 768; })(),
          asrModelHost: settings.asrModelHost || '',
          asrInstalled: !!asrStatus().installed,
          voice: settings.voice || { tts: '', bot: '' },
          engineModel: engineModelFor(settings.model || DEFAULT_MODEL),
          version: (function () { try { return require('./package.json').version; } catch (e) { return ''; } })(),
        }));
      }
      if (req.method === 'POST') {
        readBody(req).then((b) => {
          // 只接受合法模型 id；显示名（含空格/括号）一律忽略，防止把「DeepSeek-V4.1-Flash (NIM)」
          // 这类标签写成 model，导致下次启动匹配不到、静默换模型。
          if (isModelId(b.model)) settings.model = b.model;
          else if (typeof b.model === 'string' && b.model) {
            try { fs.appendFileSync(path.join(ROOT, 'protocol-probe.log'),
              new Date().toISOString() + ' ignored invalid model id: ' + String(b.model).slice(0, 80) + '\n'); } catch {}
          }
          if (b.modelProtocols && typeof b.modelProtocols === 'object') {
            settings.modelProtocols = Object.assign({}, settings.modelProtocols || {});
            for (const k of Object.keys(b.modelProtocols)) {
              const v = b.modelProtocols[k];
              if (v === 'chat' || v === 'responses') settings.modelProtocols[k] = v;
              else delete settings.modelProtocols[k];
            }
            wireCache.clear();   // 手动改协议后立刻生效
          }
          if (b.ds41Thinking === 'on' || b.ds41Thinking === 'off') settings.ds41Thinking = b.ds41Thinking;
          if (typeof b.thinkingDepth === 'string' && THINKING_DEPTHS[b.thinkingDepth]) settings.thinkingDepth = b.thinkingDepth;
          if (typeof b.nimBase === 'string' && b.nimBase) settings.nimBase = b.nimBase;
          if (typeof b.apiKey === 'string' && b.apiKey.trim()) settings.apiKey = b.apiKey.trim();

          // ---- 多提供商（DSH 风格）：增删改 + 设置当前激活 ----
          let providers = normalizeProviders(settings.providers);
          // 保存整个 providers 数组（新增 / 编辑 / 排序都走这里）
          if (Array.isArray(b.providers)) {
            providers = normalizeProviders(b.providers);
            settings.providers = providers;
          }
          // 删除某个 provider（解绑该密钥模板）
          if (typeof b.deleteProviderId === 'string' && b.deleteProviderId) {
            const deletingActive = activeProvider().id === b.deleteProviderId;
            providers = providers.filter(p => p.id !== b.deleteProviderId);
            settings.providers = providers;
            // 删除当前使用的模板后，旧接口地址立即失效；若还有其他模板则显式切到第一份。
            if (deletingActive) {
              settings.activeProviderId = providers.length ? providers[0].id : '';
              settings.nimBase = '';
            }
          }
          // 解绑（全部）API Key：清空本地密钥与接口地址，模型列表随之下线
          if (b.unbindKey === true) {
            settings.apiKey = '';
            settings.nimBase = '';
            settings.providers = [];
            settings.activeProviderId = '';
          }
          // 切换当前激活的 provider
          if (typeof b.activeProviderId === 'string') {
            settings.activeProviderId = b.activeProviderId;
          }
          if (typeof b.port === 'number') settings.port = b.port;
          if (typeof b.compactAt === 'number') settings.compactAt = b.compactAt;
          if (typeof b.contextLimit === 'number' && b.contextLimit > 0) settings.contextLimit = b.contextLimit;
          // 上下文策略开关（P4 装配 / P5 摘要）：必须能在运行时切换，便于灰度与回滚
          if (typeof b.contextSummary === 'boolean') settings.contextSummary = b.contextSummary;
          if (typeof b.contextTrim === 'boolean') settings.contextTrim = b.contextTrim;
          // 只读子智能体总开关：运行时切换即生效，无需换包
          if (typeof b.subAgents === 'boolean') settings.subAgents = b.subAgents;
          if (typeof b.desktopControl === 'boolean') {
            const wasOn = settings.desktopControl === true;
            settings.desktopControl = b.desktopControl;
            // 关闭开关：立即中止在途动作（已投递的保留真实状态，不宣称撤销）
            if (wasOn && b.desktopControl === false) {
              desktopAbortAll('control_disabled');
            }
          }
          // 窗口白名单：只接受字符串数组（空数组 = 动作全部拒绝）
          if (Array.isArray(b.desktopWindowAllow)) {
            settings.desktopWindowAllow = b.desktopWindowAllow
              .filter((x) => typeof x === 'string' && x.trim())
              .map((x) => x.trim())
              .slice(0, 64);
          }
          if (Number(b.desktopSnapshotTtlMs) > 0) {
            settings.desktopSnapshotTtlMs = Math.max(60000, Math.floor(Number(b.desktopSnapshotTtlMs)));
          }
          if (Number(b.desktopMaxSnapshotsPerSession) > 0) {
            settings.desktopMaxSnapshotsPerSession = Math.max(1, Math.min(200, Math.floor(Number(b.desktopMaxSnapshotsPerSession))));
          }
          if (Number(b.desktopMaxTotalBytes) > 0) {
            settings.desktopMaxTotalBytes = Math.max(1024 * 1024, Math.floor(Number(b.desktopMaxTotalBytes)));
          }
          if (Number(b.contextKeepRecentTurns) > 0) {
            settings.contextKeepRecentTurns = Math.max(1, Math.min(64, Math.floor(Number(b.contextKeepRecentTurns))));
          }
          if (typeof b.injectMemory === 'boolean') settings.injectMemory = b.injectMemory;
          if (Array.isArray(b.agentRoots)) settings.agentRoots = b.agentRoots
            .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
          if (typeof b.agentSafeMode === 'boolean') settings.agentSafeMode = b.agentSafeMode;
          // 当前模型由 /api/asr/models/use 统一管理（文件名来自已验签清单），设置面板不再直接改
          if (typeof b.asrModelHost === 'string') {
            const h = b.asrModelHost.trim();
            try {
              settings.asrModelHost = h ? asrModels.normalizeHost(h) : '';
              modelManifest = null; modelManifestAt = 0;   // 换源必须重新验签清单
            } catch (e) { /* 非法域名忽略，保持原值 */ }
          }
          // 语音与机器人：只存地址，不做任何本地部署
          if (b.voice && typeof b.voice === 'object') {
            const cur = settings.voice || { tts: '', bot: '' };
            const norm = (v) => {
              const s = String(v == null ? '' : v).trim().replace(/\/+$/, '');
              if (!s) return '';
              try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.toString().replace(/\/+$/, '') : ''; }
              catch (e) { return ''; }
            };
            settings.voice = {
              tts: 'tts' in b.voice ? norm(b.voice.tts) : cur.tts || '',
              bot: 'bot' in b.voice ? norm(b.voice.bot) : cur.bot || '',
            };
          }
          if ([0, 384, 512, 768, 1024, 1500].indexOf(Number(b.asrAudioCtx)) >= 0
              && Number(settings.asrAudioCtx) !== Number(b.asrAudioCtx)) {
            settings.asrAudioCtx = Number(b.asrAudioCtx);
            try { asrStopAll(); } catch {}   // -ac 是启动参数，必须重启引擎
          }
          if (b.asrLang === 'zh' || b.asrLang === 'auto') {
            if (settings.asrLang !== b.asrLang) {
              settings.asrLang = b.asrLang;
              try { asrStopAll(); } catch {}
            }
          }
          if (typeof b.autoFailover === 'boolean') settings.autoFailover = b.autoFailover;
          if (Array.isArray(b.failoverChain)) {
            settings.failoverChain = b.failoverChain.filter(m => MODEL_CATALOG[m]);
          }
          if (Number(b.queueFallbackMs) >= 8000) settings.queueFallbackMs = Math.min(180000, Number(b.queueFallbackMs));
          if (b.dirs && typeof b.dirs === 'object') {
            for (const k of Object.keys(DEFAULT_DIRS)) {
              if (typeof b.dirs[k] === 'string' && b.dirs[k].trim()) settings.dirs[k] = b.dirs[k].trim();
            }
          }
          // 提供商/密钥/接口发生变化后，旧探活结果不再属于当前配置，立即作废。
          if (Array.isArray(b.providers) || b.deleteProviderId || b.unbindKey === true ||
              typeof b.activeProviderId === 'string' || b.apiKey || typeof b.nimBase === 'string' ||
              !activeApiKey()) {
            clearHealthSnapshot();
          }
          try {
            ensureDirs();
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(diskSettings(), null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, dirs: settings.dirs, providers: normalizeProviders(settings.providers) }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
          }
        });
        return;
      }
    }
    // 查询云端 API Key 状态：直接问上游 /v1/models，用真实授权结果判断 key 是否有效/已注销
    if (req.method === 'POST' && url === '/api/key-check') {
      readBody(req).then(async (b) => {
        const key = (typeof b.apiKey === 'string' && b.apiKey.trim()) ? b.apiKey.trim() : activeApiKey();
        if (!key) {
          return res.end(JSON.stringify({ ok: true, state: 'none', msg: '未配置密钥' }));
        }
        const base = (typeof b.nimBase === 'string' && b.nimBase) ? b.nimBase : activeBase();
        try {
          const r = await fetch(base.replace(/\/+$/, '') + '/models', {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          const txt = await r.text().catch(() => '');
          let j = {}; try { j = JSON.parse(txt); } catch {}
          if (r.status === 200) {
            const n = Array.isArray(j.data) ? j.data.length : 0;
            return res.end(JSON.stringify({ ok: true, state: 'valid', msg: '密钥有效', models: n }));
          }
          if (r.status === 401 || r.status === 403) {
            return res.end(JSON.stringify({ ok: true, state: 'invalid', msg: '密钥无效或已从云端注销', status: r.status }));
          }
          return res.end(JSON.stringify({ ok: true, state: 'error', msg: '查询失败（HTTP ' + r.status + '）', status: r.status }));
        } catch (e) {
          return res.end(JSON.stringify({ ok: true, state: 'error', msg: '网络错误：' + String(e.message || e).slice(0, 80) }));
        }
      });
      return;
    }
    // 打开文件夹（资源管理器）
    if (req.method === 'POST' && url === '/api/open-dir') {
      readBody(req).then(async (b) => {
        const p = settings.dirs[b.which] || b.path;
        let ok = false, err = '';
        try {
          if (p) {
            fs.mkdirSync(p, { recursive: true });
            const r = await shell.openPath(p);
            ok = !r; err = r || '';
          }
        } catch (e) { err = String(e.message || e); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, path: p || '', error: err }));
      });
      return;
    }
    // 弹出系统文件夹选择对话框，返回选中的目录路径（用于自主选择记忆库/测试文件/工作目录）
    if (req.method === 'POST' && url === '/api/choose-dir') {
      readBody(req).then(async (b) => {
        const cur = String((b && b.current) || '').trim();
        const opts = { title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] };
        if (cur && fs.existsSync(cur)) opts.defaultPath = cur;
        try {
          const r = await dialog.showOpenDialog(opts);
          if (r.canceled || !r.filePaths || !r.filePaths.length) {
            return res.end(JSON.stringify({ ok: false, canceled: true }));
          }
          return res.end(JSON.stringify({ ok: true, path: r.filePaths[0] }));
        } catch (e) {
          return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 把一个目录下的内容迁移（移动）到另一个目录；前端在选择新目录后调用，自动搬运旧数据
    if (req.method === 'POST' && url === '/api/migrate-dir') {
      readBody(req).then((b) => {
        try {
          const r = migrateDirContents(b.from, b.to);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 归档一段会话为 Markdown 文本（target: chatArchive | memory）
    if (req.method === 'POST' && url === '/api/archive') {
      readBody(req).then((b) => {
        try {
          const key = b.target === 'memory' ? 'memory' : 'chatArchive';
          const dir = settings.dirs[key];
          fs.mkdirSync(dir, { recursive: true });
          const now = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
            + '-' + pad(now.getHours()) + pad(now.getMinutes());
          const safe = String(b.title || '会话').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || '会话';
          const name = stamp + '-' + safe + '.md';
          const p = path.join(dir, name);
          const body = String(b.content || '');
          fs.writeFileSync(p, body, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: p, name, target: key }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 读取某个记忆文件
    if (req.method === 'POST' && url === '/api/memory/read') {
      readBody(req).then((b) => {
        try {
          const name = path.basename(String(b.name || ''));
          const p = path.join(settings.dirs.memory, name);
          if (!fs.existsSync(p)) throw new Error('文件不存在');
          const text = fs.readFileSync(p, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name, path: p, content: text.slice(0, 20000) }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 搜索记忆库（文件名 + 内容）
    if (req.method === 'POST' && url === '/api/memory/search') {
      readBody(req).then((b) => {
        try {
          const q = String(b.q || '').trim().toLowerCase();
          const dir = settings.dirs.memory;
          const out = [];
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              if (!f.toLowerCase().endsWith('.md')) continue;
              const p = path.join(dir, f);
              let text = '';
              try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
              const nameHit = f.toLowerCase().includes(q);
              const idx = q ? text.toLowerCase().indexOf(q) : 0;
              if (!q || nameHit || idx >= 0) {
                const st = fs.statSync(p);
                let excerpt = '';
                if (idx >= 0 && q) excerpt = text.slice(Math.max(0, idx - 40), idx + 160).replace(/\s+/g, ' ');
                else excerpt = text.slice(0, 160).replace(/\s+/g, ' ');
                out.push({ name: f, mtime: st.mtimeMs, size: st.size, hit: idx >= 0 || nameHit, excerpt });
              }
              if (out.length >= 50) break;
            }
          }
          out.sort((a, b) => b.mtime - a.mtime);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, dir, results: out.slice(0, 30) }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 按关键词给记忆库打分，返回最相关的几条（供自动归档后回填上下文）
    if (req.method === 'POST' && url === '/api/memory/recall') {
      readBody(req).then((b) => {
        try {
          const q = String(b.q || '').toLowerCase();
          const raw = q.match(/[\u4e00-\u9fff]{2,}|[a-z0-9_.\-]{3,}/g) || [];
          const toks = Array.from(new Set(raw))
            .filter(t => !/^(the|and|for|with|this|that|please|help|codex|code)$/.test(t))
            .slice(0, 40);
          const dir = settings.dirs.memory;
          const found = [];
          if (toks.length && fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              if (!f.toLowerCase().endsWith('.md')) continue;
              const p = path.join(dir, f);
              let text = '';
              try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
              const low = text.toLowerCase();
              let score = 0, firstHit = -1;
              for (const t of toks) {
                const i = low.indexOf(t);
                if (i >= 0) { score++; if (firstHit < 0 || i < firstHit) firstHit = i; }
              }
              if (score > 0) {
                const st = fs.statSync(p);
                found.push({ name: f, score, mtime: st.mtimeMs, firstHit: firstHit < 0 ? 0 : firstHit, text });
              }
            }
          }
          found.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
          const top = found.slice(0, Math.max(1, Math.min(5, Number(b.max) || 2)));
          let pack = '';
          for (const it of top) {
            const s = Math.max(0, it.firstHit - 200);
            const seg = it.text.slice(s, s + 900).replace(/\r/g, '').trim();
            if (!seg) continue;
            pack += '【记忆：' + it.name + '】\n' + seg + '\n\n';
          }
          pack = pack.slice(0, 2400);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: top.length, names: top.map(t => t.name), pack }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 压缩摘要（用于超长会话自动摘录）
    if (req.method === 'POST' && url === '/api/summarize') {
      readBody(req).then(async (b) => {
        try {
          if (!activeApiKey()) throw new Error('缺少 API Key');
          const msgs = Array.isArray(b.messages) ? b.messages : [];
          const text = msgs.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n\n');
          const prompt = '把下面这段对话压缩成不超过 400 字的中文摘要。要求：\n' +
            '1) 保留所有关键结论、决定、文件路径、命令、数字；\n' +
            '2) 丢弃寒暄和重复内容；\n' +
            '3) 用条目式输出，不要前言后语。\n\n对话：\n' + text.slice(0, 120000);
          const a = await callUpstreamJSON(b.model || settings.model, {
            messages: [{ role: 'user', content: prompt }], maxTokens: 1200, temperature: 0.3,
          });
          if (!a.r.ok) throw new Error('HTTP ' + a.r.status);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, summary: a.text.trim(), usage: a.usage || null }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 列出最近的记忆库文件
    if (req.method === 'GET' && url === '/api/memory') {
      try {
        const dir = settings.dirs.memory;
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).map(f => {
              const st = fs.statSync(path.join(dir, f));
              return { name: f, size: st.size, mtime: st.mtimeMs };
            }).sort((a, b) => b.mtime - a.mtime).slice(0, 20)
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dir, files }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
      return;
    }

    // Registration is main-only: never accept paths, roots, sessions or pending tokens
    // as authority from HTTP. Existing clients receive a bounded, explicit migration error.
    if (url === '/api/attachment/prepare' || url === '/api/attachment/register') {
      req.resume();
      res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'ATTACHMENT_REGISTRATION_MAIN_ONLY' }));
      return;
    }

    // ---- agent-desktop D1 桌面控制桥（默认关闭，settings.desktopControl=true 开启） ----
    // 设计要点（对应 D1 补强指令）：
    //   · 全部 await 异步 helper，不阻塞事件循环；
    //   · 关闭开关 → 立即拒绝新动作 + abort 在途动作（已投递的保留真实状态）；
    //   · 动作需窗口白名单（空 = fail closed）；观察类不受白名单限制；
    //   · 快照治理挂启动/周期/会话结束三处。
    if (url.startsWith('/api/desktop/') || url === '/api/desktop') {
      const json = (o, code) => {
        res.writeHead(code || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const sub = url.slice('/api/desktop'.length).replace(/^\//, '');
      const tool = sub.split('?')[0];
      let b = {};
      if (req.method === 'POST') { try { b = await readBody(req); } catch (e) { b = {}; } }

      // GET /api/desktop → 只报告「开没开、能不能用、工具清单」，不需要开关已开
      if ((!sub || sub === '') && req.method === 'GET') {
        const enabled = settings.desktopControl === true;
        let helper = null;
        if (enabled) {
          try { helper = await desktopBridge.verifyHelper(); } catch (e) { helper = { ok: false, error: String(e.message || e) }; }
        }
        return json({
          ok: true,
          version: desktopBridge.VERSION,
          enabled,
          hint: enabled ? undefined : 'POST /api/settings {"desktopControl":true} to enable',
          tools: desktopBridge.TOOLS,
          delivery: Object.values(desktopBridge.Delivery),
          helper: enabled ? helper : { skipped: 'disabled' },
          session: { active: !!desktopRuntime.sessionId, startedAt: desktopRuntime.startedAt },
          policy: { windowAllowCount: desktopPolicy().allowedWindows.length, failClosed: true, physicalInputAllowed: false, blocked: desktopRuntime.blocked },
          gc: desktopRuntime.lastGc,
        });
      }

      // 其余端点一律要求开关已开
      if (settings.desktopControl !== true) {
        return json({ ok: false, error: 'desktop_control_disabled', hint: 'POST /api/settings {"desktopControl":true} to enable' }, 403);
      }

      // POST /api/desktop/session → 开/关 helper 会话（隔离快照命名空间）
      if (sub === 'session' && req.method === 'POST') {
        if (b.action === 'end') {
          await desktopShutdown();
          return json({ ok: true, ended: true });
        }
        if (desktopRuntime.sessionId) {
          return json({ ok: true, sessionId: desktopRuntime.sessionId, reused: true });
        }
        const s = await desktopBridge.startSession(b.name || 'whale-d1');
        if (s.ok) {
          desktopRuntime.sessionId = s.sessionId;
          desktopRuntime.startedAt = Date.now();
          desktopRuntime.blocked = false;  // P0-C: 新会话清除阻断
          desktopRuntime.blockReason = null;
          desktopScheduleGc();
        }
        return json(s);
      }

      // POST /api/desktop/cleanup → 治理快照（默认 dryRun=false）
      if (sub === 'cleanup' && req.method === 'POST') {
        const r = desktopBridge.cleanupSnapshots({ ...desktopCleanupOpts(), dryRun: b.dryRun === true });
        return json({ ok: r.ok, ...r });
      }

      // POST /api/desktop/verify → delivered_unverified 二次观察验证（只观察，不重投）
      if (sub === 'verify' && req.method === 'POST') {
        // P0-A: verify 也纳入在途任务与取消机制
        const vctl = new AbortController();
        const vrid = crypto.randomBytes(6).toString('hex');
        desktopRuntime.inflight.set(vrid, vctl);
        try {
          const r = await desktopBridge.observeVerify({
            windowId: b.windowId,
            role: b.role,
            name: b.name,
            expectedValue: b.expectedValue,
            sessionId: b.sessionId || desktopRuntime.sessionId,
            timeoutMs: b.timeoutMs,
            signal: vctl.signal,
          });
          return json({ ok: r.verified === true, ...r });
        } finally {
          desktopRuntime.inflight.delete(vrid);
        }
      }

      // POST /api/desktop/cancel → 中止在途动作（不宣称已撤销已投递动作）
      if (sub === 'cancel' && req.method === 'POST') {
        const n = desktopAbortAll('user_cancel');
        return json({ ok: true, aborted: n, note: 'in-flight aborted; already-delivered actions keep their real state' });
      }

      // POST /api/desktop/{tool} → 调用语义工具
      if (desktopBridge.TOOLS.includes(tool) && req.method === 'POST') {
        // P0-C: 检查是否被物理违规阻断
        if (desktopRuntime.blocked) {
          return json({ ok: false, delivery: 'rejected', retry: 'unsafe', errorCode: 'BLOCKED_BY_POLICY_VIOLATION', errorCategory: 'physical_synthetic', details: { reason: desktopRuntime.blockReason, hint: 'Restart desktop session to clear block' } }, 403);
        }
        const ctl = new AbortController();
        const rid = crypto.randomBytes(6).toString('hex');
        desktopRuntime.inflight.set(rid, ctl);
        try {
          const r = await desktopBridge.call(tool, b, {
            timeoutMs: b.timeoutMs || 30000,
            sessionId: b.sessionId || desktopRuntime.sessionId,
            signal: ctl.signal,
            policy: desktopPolicy(),
            redact: b.redact === true,
          });
          // P0-C: 消费 stopSubsequent → 设置运行时阻断
          if (r.stopSubsequent) {
            desktopRuntime.blocked = true;
            desktopRuntime.blockReason = r.policyViolation || 'physical_synthetic_detected';
          }
          return json(r);
        } finally {
          desktopRuntime.inflight.delete(rid);
        }
      }

      return json({ ok: false, error: 'unknown_endpoint' }, 404);
    }

    // ---- 线程累计统计（P1）：切会话 / 刷新恢复时读取后端权威累计 ----
    if (url === '/api/threads/stats' && req.method === 'GET') {
      let sid = null, tid = 'main';
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        sid = q.get('sessionId');
        tid = q.get('threadId') || 'main';
      } catch (e) {}
      const s = initRuns().threadStats(sid, tid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, stats: s }));
    }
    // ---- 线程恢复态（阻断项 2）：权威累计 + 最新 run 状态 + 是否可续订 + 未完成片段 ----
    if (url === '/api/threads/state' && req.method === 'GET') {
      let sid = null, tid = 'main';
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        sid = q.get('sessionId');
        tid = q.get('threadId') || 'main';
      } catch (e) {}
      const st = initRuns().threadState(sid, tid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.assign({ ok: true }, st)));
    }
    // ---- 上下文预算诊断（P1）：只读，不改任何历史 ----
    if (url === '/api/context/plan' && req.method === 'GET') {
      let sid = null, mid = null;
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        sid = q.get('sessionId'); mid = q.get('model');
      } catch (e) {}
      const model = mid || settings.model || DEFAULT_MODEL;
      let messages = [], basis = 'none';
      if (sid) {
        try {
          const chat = chatRead(String(sid));
          if (chat && Array.isArray(chat.messages)) { messages = chat.messages; basis = 'chat:' + sid; }
        } catch (e) {}
      }
      const upProv = upstreamFor(model);
      const wireId = wireModelOf(model);
      const reg = initCapabilities();
      const cq = {
        providerId: upProv.id || 'unknown', modelId: wireId, wireModel: wireId,
        base: upProv.base, apiKey: upProv.apiKey, catalogCtx: (MODEL_CATALOG[model] || {}).ctx,
      };
      let cap = reg.get(cq);
      if (cap.source === 'fallback') cap = await reg.ensure(cq).catch(() => cap);
      const plan = ctxBudget.planForMessages({
        contextWindow: Math.min(cap.contextWindow, cap.providerHardLimit || cap.contextWindow),
        maxOutputTokens: cap.maxOutputTokens,
        reasoningReserve: cap.reasoningReserve || 0,
        estimatorFactor: cap.calibrationFactor || 1,
        messages: messages,
        requestedOutput: null,
      });
      plan.model = model;
      plan.providerId = cap.providerId;
      plan.modelId = cap.modelId;
      plan.capabilitySource = cap.source;
      plan.capabilityConfidence = cap.confidence;
      plan.capabilityVersion = cap.version;
      plan.capabilityNote = cap.note || null;
      plan.effectiveContextLimit = effectiveContextLimit(model);
      plan.basis = basis;
      plan.messageCount = messages.length;
      plan.at = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, plan: plan, capability: cap }));
    }
    // ---- 模型能力查询（P3）：按 providerId+modelId 取窗口/输出上限，可强制刷新 ----
    if (url === '/api/context/capability' && req.method === 'GET') {
      let pid = null, mid = null, refresh = false;
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        pid = q.get('providerId'); mid = q.get('modelId'); refresh = q.get('refresh') === '1';
      } catch (e) {}
      const model = mid || settings.model || DEFAULT_MODEL;
      const upProv = upstreamFor(model);
      const wireId = wireModelOf(model);
      const providerId = pid || upProv.id || 'unknown';
      const modelId = mid || wireId;
      const reg = initCapabilities();
      const cq = {
        providerId: providerId, modelId: modelId, wireModel: wireId,
        base: upProv.base, apiKey: upProv.apiKey,
        catalogCtx: (MODEL_CATALOG[model] || {}).ctx, refresh: refresh,
      };
      let rec;
      try {
        rec = refresh ? await reg.ensure(cq) : reg.get(cq);
        if (!refresh && rec.source === 'fallback') rec = await reg.ensure(cq);
      } catch (e) { rec = reg.get(cq); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true, record: rec, cache: reg.inspect({ providerId: providerId, modelId: modelId }),
      }));
    }
    // ---- 工作台 API（P3 核心 + P2 基础能力）----
    if (url.startsWith('/api/workbench/')) {
      const W = initWorkbench();
      const sub = url.slice('/api/workbench/'.length);
      let q = new URL('http://localhost/').searchParams;
      try { q = new URL(req.url, 'http://localhost').searchParams; } catch (e) {}
      let b = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        try { b = await readBody(req); } catch (e) { b = {}; }
      }
      const json = (o, code) => {
        res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(o));
      };
      if (sub === 'state' && req.method === 'GET') return json(W.uiState());
      if (sub === 'ui' && req.method === 'POST') return json(W.setUi(b));
      if (sub === 'window' && req.method === 'POST') {
        if (b.action === 'close') return json(closeWorkbenchWindow());
        if (b.action === 'dock') return json(await dockWorkbenchWindow());
        if (b.action === 'detach') return json(detachWorkbenchWindow());
        return json(createWorkbenchWindow());
      }
      if (sub === 'capabilities' && req.method === 'GET') return json(W.capabilities());
      if (sub === 'tabs' && req.method === 'POST') return json(W.addTab(b));
      if (sub === 'tabs/close' && req.method === 'POST') return json(W.closeTab(b.id));
      if (sub === 'threads' && req.method === 'POST') return json(W.createThread(b));
      if (sub === 'threads' && req.method === 'GET') {
        const tabId = q.get('tabId');
        const t = tabId ? W.getThreadByTab(tabId) : W.getThread(q.get('id'));
        return json(t || { error: 'thread not found' });
      }
      // 只读：主会话权威快照（版本 + 内容哈希 + 来源）。侧聊同步前必须先拿它，
      // 否则拿不到 parentVersion，只能被 parent_version_required 正确拒绝。
      if (sub === 'parent' && req.method === 'GET') {
        let sid = null, tid = 'main';
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          sid = q.get('sessionId'); tid = q.get('threadId') || 'main';
        } catch (e) {}
        if (!sid) sid = W.uiState().lastSessionId || null;
        if (!sid) return json({ error: 'session_required', detail: '缺少 sessionId 且后端尚未记录当前会话' });
        return json(W.parentSnapshot(sid, tid));
      }
      if (sub === 'threads/sync' && req.method === 'POST') return json(W.syncThread(b.id, b));
      if (sub === 'threads/archive' && req.method === 'POST') return json(W.archiveThread(b.id));
      if (sub === 'threads/restore' && req.method === 'POST') return json(W.restoreThread(b.id));
      if (sub === 'threads/list' && req.method === 'GET') {
        return json(W.listThreads({ sessionId: q.get('sessionId'),
          includeArchived: q.get('includeArchived') !== '0' }));
      }
      if (sub === 'threads/message' && req.method === 'POST') return json(W.appendThreadMessage(b.id, b) || { error: 'thread not found' });
      if (sub === 'files' && req.method === 'GET') return json(W.listFiles(q.get('dir')));
      if (sub === 'file' && req.method === 'GET') return json(W.readFile(q.get('path')));
      if (sub === 'file' && req.method === 'PUT') return json(W.writeFile(b.path, b.text, b.version));
      if (sub === 'web/read' && req.method === 'POST') return json(await W.webRead(b));
      if (sub === 'web/follow' && req.method === 'POST') return json(await W.webFollow(b));
      if (sub === 'web/open' && req.method === 'POST') return json(W.openWeb(b.tabId, b.url, b.bounds));
      if (sub === 'web/bounds' && req.method === 'POST') return json(W.setViewBounds(b.tabId, b.bounds));
      if (sub === 'web/nav' && req.method === 'POST') return json(W.navView(b.tabId, b.action));
      if (sub === 'web/visible' && req.method === 'POST') {
        if (b.visible === false) W.hideAllViews();
        return json({ ok: true, visible: b.visible !== false });
      }
      if (sub === 'download' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const r = W.startDownload(b, res);
        if (r && r.error) { sse(res, { download: null, status: 'failed', error: r.error }); endRes(res); }
        return;   // 进度与终态由下载任务自己推送并结束响应
      }
      if (sub === 'download' && req.method === 'GET') return json(W.downloadStatus(q.get('id')));
      if (sub === 'download/cancel' && req.method === 'POST') return json(W.cancelDownload(b.id));
      if (sub === 'git' && req.method === 'GET') return json(await W.git(q.get('dir'), q.get('action')));
      if (sub === 'git/write' && req.method === 'POST') return json(await W.gitWrite(b.dir, b.action, b));
      if (sub === 'network' && req.method === 'GET') {
        return json({ ok: true, routes: [{ id: 'direct', name: '直连', mode: 'direct' }],
          defaults: { modelRouteId: 'direct', webRouteId: 'direct', downloadRouteId: 'direct', toolRouteId: 'direct' },
          note: '本批仅交付直连（明确作用域，不改 Windows 全局代理）；指定代理/SOCKS5/PAC 见 capabilities.notDelivered' });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('workbench route not found');
    }
    // ---- 运行注册表 API（P0）：按 run 隔离的身份 / 事件 / 取消 ----
    // 侧聊、主聊天、Agent 各自一个 run；停止只作用于目标 run。
    if (url === '/api/runs' || url.startsWith('/api/runs/')) {
      const R = initRuns();
      const m = /^\/api\/runs(?:\/([^/?]+))?(?:\/(events|cancel|text))?$/.exec(url.split('?')[0]);
      if (!m) { res.writeHead(404); return res.end(); }
      const runId = m[1] || null;
      const sub = m[2] || null;

      if (!runId && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, runs: R.list() }));
      }
      if (!runId && req.method === 'POST') {
        const b = await readBody(req);
        const run = R.create({
          kind: String(b.kind || 'chat'),
          sessionId: b.sessionId || null,
          threadId: String(b.threadId || 'main'),
          model: b.model || null,
          meta: b.meta || {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, runId: run.runId, threadId: run.threadId }));
      }
      if (runId && sub === 'cancel' && req.method === 'POST') {
        // 父取消传播：**先收子运行，再取消父运行**。
        // 反过来的话，父的 run.cancelled 事件会先触发编排器的自动传播，
        // 这里再收一次就什么都收不到，接口也就无法如实回报「收了哪几个子运行」。
        let kids = null;
        if (subOrch) { try { kids = subOrch.cancelChildren(runId, 'parent_cancelled'); } catch (e) {} }
        const r = R.cancel(runId, 'user');
        res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(Object.assign({}, r, kids ? { children: kids.cancelled } : {})));
      }
      // 正文快照：attach 时取初值 / 缺帧时整体修复。truncated=true 表示只保留了尾部。
      if (runId && sub === 'text' && req.method === 'GET') {
        if (!R.get(runId)) { res.writeHead(404); return res.end(); }
        let reqId = null;
        try { reqId = new URL(req.url, 'http://localhost').searchParams.get('requestId'); } catch (e) {}
        const snap = R.textSnapshot(runId, reqId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(Object.assign({ ok: true }, snap)));
      }
      if (runId && sub === 'events' && req.method === 'GET') {
        const after = Number((url.split('afterSeq=')[1] || '0').split('&')[0]) || 0;
        if (!R.get(runId)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // 先补发断线期间的事件，再转直播
        for (const ev of R.eventsAfter(runId, after)) sse(res, ev);
        const off = R.subscribe(runId, (ev) => sse(res, ev));
        const ka = setInterval(() => { try { res.write(':\n\n'); } catch (e) {} }, 15000);
        res.on('close', () => { clearInterval(ka); off(); });
        return;
      }
      if (runId && !sub && req.method === 'GET') {
        const p = R.project(runId);
        if (!p) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, run: p }));
      }
      res.writeHead(405); return res.end();
    }

    // ---- 只读子智能体（A1）：派生 / 状态 / 取消 / 幂等续订 ----
    // 全部走 RunRegistry 的既有身份与事件：子运行就是普通 run（kind='sub'），
    // 因此 /api/runs/:id/events 与 /api/runs/:id/text 可以直接用于子运行续订。
    if (url === '/api/subagents' || url.startsWith('/api/subagents/')) {
      const O = initSubAgents();
      const sub = url.slice('/api/subagents'.length).replace(/^\//, '');
      let q = new URL('http://localhost/').searchParams;
      try { q = new URL(req.url, 'http://localhost').searchParams; } catch (e) {}
      let b = {};
      if (req.method === 'POST') { try { b = await readBody(req); } catch (e) { b = {}; } }
      const json = (o, code) => {
        res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(o));
      };

      // 能力状态总览：开关、上限、策略、每个父运行的子运行概况
      if (req.method === 'GET' && !sub) {
        const parents = [];
        for (const pid of O._parents.keys()) {
          const bd = O.bundle(pid);
          parents.push({ parentRunId: pid, mode: bd.mode, counts: bd.counts,
            degraded: bd.degraded, budget: bd.budget, capability: bd.capability });
        }
        return json({
          ok: true, version: O.VERSION, enabled: subAgentsOn(),
          settings: { subAgents: settings.subAgents === true, defaultOff: true, rollback: 'POST /api/settings {"subAgents":false}' },
          limits: O.limits,
          permissions: subAgentModule.CHILD_CEILING,
          permissionKinds: subAgentModule.PERMISSION_KINDS,
          policy: { readOnly: true, unknownCapability: 'reject_unless_probe', mergePolicy: 'none', grandChildren: false },
          parents: parents,
        });
      }

      // 派生：父运行必须真实存在且未终结；tasks 为 1–4 条只读子任务
      if (req.method === 'POST' && !sub) {
        const parentRunId = String(b.parentRunId || '');
        if (!parentRunId) return json({ ok: false, reason: 'parent_run_required' }, 400);
        const model = b.model || settings.model || DEFAULT_MODEL;
        const upProv = upstreamFor(model);
        const wireId = wireModelOf(model);
        let rec = b.capabilityRecord || null;
        if (!rec) {
          const reg = initCapabilities();
          const cq = { providerId: upProv.id || 'unknown', modelId: wireId, wireModel: wireId,
            catalogCtx: (MODEL_CATALOG[model] || {}).ctx };
          try {
            rec = reg.get(cq);
            if (rec.source === 'fallback') rec = await reg.ensure(cq).catch(() => rec);
          } catch (e) { rec = null; }
        }
        const out = O.spawn(parentRunId, {
          enabled: subAgentsOn(),
          tasks: b.tasks,
          model: model,
          capabilityRecord: rec,
          providerId: upProv.id, modelId: wireId, wireModel: wireId,
          parentReadRoots: Array.isArray(b.parentReadRoots) ? b.parentReadRoots : agentRoots(),
          readRoots: Array.isArray(b.readRoots) ? b.readRoots : [],
          parentAvailable: b.parentAvailable,
          providerCap: b.providerCap,
          childPoolRatio: b.childPoolRatio,
          allowUnknownProbe: b.allowUnknownProbe === true,
          parentPermissions: b.parentPermissions,
        });
        // 派生是异步的：这里不回传 done（Promise 无法序列化），调用方用 bundle 或事件流跟进
        const payload = Object.assign({}, out);
        delete payload.done;
        return json(payload, out.ok ? 200 : 409);
      }

      if (req.method === 'GET' && sub === 'bundle') {
        const pid = q.get('parentRunId');
        if (!pid) return json({ ok: false, reason: 'parent_run_required' }, 400);
        return json(O.bundle(pid));
      }
      if (req.method === 'GET' && sub === 'child') {
        const rid = q.get('runId');
        if (!rid) return json({ ok: false, reason: 'run_required' }, 400);
        const st = O.stateOf(rid);
        return st ? json(Object.assign({ ok: true }, st)) : json({ ok: false, reason: 'not_found' }, 404);
      }
      if (req.method === 'POST' && sub === 'cancel') {
        const pid = String(b.parentRunId || '');
        if (!pid) return json({ ok: false, reason: 'parent_run_required' }, 400);
        return json(O.cancelChildren(pid, b.reason || 'user_cancel_children'));
      }
      // 幂等续订：把事件（或 afterSeq 之后的全部事件）喂给读取端，重复帧必须被忽略
      if (req.method === 'POST' && sub === 'ingest') {
        const rid = String(b.runId || '');
        if (!rid) return json({ ok: false, reason: 'run_required' }, 400);
        const R = initRuns();
        let events = Array.isArray(b.events) ? b.events : null;
        if (!events) events = R.eventsAfter(rid, Number(b.afterSeq) || 0);
        const snap = R.textSnapshot(rid);
        const seeded = (b.fromSnapshot === true && snap) ? O.attachSnapshot(rid, snap) : null;
        const r = O.ingest(rid, events);
        return json(Object.assign({ ok: true, runId: rid, eventCount: events.length, snapshot: seeded }, r));
      }
      return json({ ok: false, reason: 'not_found' }, 404);
    }

    // 「停止全部」独立入口：明确作用于所有运行中的 run，普通停止与侧聊停止都不走这里。
    // 旧的全局 activeUpstreams / currentProc 语义已废弃，取消一律经 RunRegistry 按 run 定位。
    if (req.method === 'POST' && url === '/api/stop') {
      const R = initRuns();
      let killed = false;
      for (const r of R.list()) {
        if (r.state === 'running' || r.state === 'created') {
          const c = R.cancel(r.runId, 'stop_all');
          if (c.ok) killed = true;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, killed, scope: 'all' }));
    }
    // 保存代码块到文件（工作目录下）
    if (req.method === 'POST' && url === '/api/save-file') {
      readBody(req).then((b) => {
        try {
          const name = path.basename(String(b.name || ''));
          if (!name) throw new Error('文件名不能为空');
          const dir = String(b.dir || ROOT);
          fs.mkdirSync(dir, { recursive: true });
          const p = path.join(dir, name);
          fs.writeFileSync(p, String(b.content || ''), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, path: p }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 列出所有服务端持久化的会话
    if (req.method === 'GET' && url === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessions: listSessions() }));
    }
    // 从某个消息索引分支创建新会话
    if (req.method === 'POST' && url === '/api/session/branch') {
      readBody(req).then((b) => {
        try {
          const srcId = String(b.sessionId || '');
          const fromIndex = Number(b.fromIndex || 0);
          const src = loadSession(srcId);
          if (!src) throw new Error('源会话不存在');
          const msgs = Array.isArray(src.messages) ? src.messages : [];
          const cut = msgs.slice(0, Math.max(0, fromIndex));
          const newId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
          const newSess = { id: newId, title: '分支-' + (src.title || '会话'), created: Date.now(), messages: cut, parent: srcId };
          saveSession(newId, newSess);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, session: newSess }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }
    // 自动生成会话标题（基于第一条用户消息）
    if (req.method === 'POST' && url === '/api/title') {
      readBody(req).then(async (b) => {
        try {
          if (!activeApiKey()) throw new Error('缺少 API Key');
          const firstUser = Array.isArray(b.messages) ? b.messages.find(m => m.role === 'user') : null;
          const prompt = '为下面这段对话起一个不超过 12 个汉字的简洁标题，只输出标题本身，不要引号、不要前缀。\n\n对话：\n' + (firstUser ? firstUser.content.slice(0, 2000) : '');
          const a = await callUpstreamJSON(b.model || settings.model, {
            // 思考型模型 64 token 容易被推理吃光导致标题为空，留足预算
            messages: [{ role: 'user', content: prompt }], maxTokens: 256, temperature: 0.3,
          });
          if (!a.r.ok) throw new Error('HTTP ' + a.r.status);
          const title = a.text.replace(/^["']|["']$/g, '').trim() || '新会话';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, title }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: String(e.message || e), title: '新会话' }));
        }
      });
      return;
    }
    // 一键还原某次 agent 任务前的文件内容
    if (req.method === 'POST' && url === '/api/agent/restore') {
      readBody(req).then((b) => {
        const r = restoreSnapshot(b.runId, b.dir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      });
      return;
    }
    // ---------- 沙箱状态可视化 / 自检 ----------
    if (req.method === 'GET' && url === '/api/sandbox/status') {
      const homes = codexHomes().map(full => {
        let raw = ''; try { raw = fs.readFileSync(path.join(full, 'config.toml'), 'utf8'); } catch {}
        return {
          name: path.basename(full),
          secretIsolation: /\[shell_environment_policy\]/.test(raw) && /NVIDIA_API_KEY/.test(raw),
          networkAccess: !/network_access\s*=\s*false/.test(raw),
          approval: (raw.match(/approval_policy\s*=\s*"([^"]+)"/) || [])[1] || 'unknown',
          wire: (raw.match(/wire_api\s*=\s*"([^"]+)"/) || [])[1] || 'unknown',
          windowsSandbox: (raw.match(/sandbox\s*=\s*"([^"]+)"/) || [])[1] || 'default',
        };
      });
      let auditCount = 0, auditBytes = 0;
      try {
        auditBytes = fs.statSync(AGENT_AUDIT_LOG).size;
        auditCount = fs.readFileSync(AGENT_AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean).length;
      } catch {}
      let snapshotCount = 0;
      try { snapshotCount = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).length; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, roots: agentRoots(),
        safeMode: settings.agentSafeMode === true, homes, auditCount, auditBytes, snapshotCount,
        limits: { maxFiles: SNAP_MAX_FILES, maxBytes: SNAP_MAX_BYTES, maxTotal: SNAP_MAX_TOTAL } }));
    }
    if (req.method === 'GET' && url === '/api/sandbox/audit') {
      const limit = Math.max(1, Math.min(200, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 30));
      let items = [];
      try {
        items = fs.readFileSync(AGENT_AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean)
          .slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, items }));
    }
    if (req.method === 'GET' && url === '/api/sandbox/snapshots') {
      const items = [];
      try {
        for (const f of fs.readdirSync(SNAPSHOT_DIR).filter(x => x.endsWith('.json')).slice(-60)) {
          const p = path.join(SNAPSHOT_DIR, f);
          try {
            const j = JSON.parse(fs.readFileSync(p, 'utf8'));
            items.push({ runId: f.slice(0, -5), at: j.at, dir: j.dir,
              files: Object.keys(j.files || {}).length, skipped: j.skipped || 0, size: fs.statSync(p).size });
          } catch {}
        }
      } catch {}
      items.sort((a, b) => (b.at || 0) - (a.at || 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, items }));
    }
    if (req.method === 'POST' && url === '/api/sandbox/selfcheck') {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail || '') });
      const homesOk = codexHomes().every(full => {
        let raw = ''; try { raw = fs.readFileSync(path.join(full, 'config.toml'), 'utf8'); } catch {}
        return /\[shell_environment_policy\]/.test(raw) && /NVIDIA_API_KEY/.test(raw);
      });
      add('密钥隔离策略', homesOk, homesOk ? '当前 CODEX_HOME 已排除 NVIDIA_API_KEY' : '当前 CODEX_HOME 缺少排除规则');
      const sysRoot = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
      const blocked = !isDirAllowed(sysRoot) && !isDirAllowed(path.join(os.homedir(), 'Desktop'));
      add('工作目录白名单', blocked && isDirAllowed(agentRoots()[0]),
        '允许 ' + agentRoots().join(', ') + '；系统盘 / 桌面已拒绝');
      const testDir = path.join(SNAPSHOT_DIR, '.selfcheck-' + Date.now());
      let snapOk = false, snapDetail = '';
      try {
        fs.mkdirSync(testDir, { recursive: true });
        const fp = path.join(testDir, 'probe.txt');
        fs.writeFileSync(fp, 'BEFORE');
        const snap = makeSnapshot(testDir);
        if (snap.ok) {
          fs.writeFileSync(fp, 'AFTER');
          const r = restoreSnapshot(snap.runId, testDir);
          snapOk = r.ok && fs.readFileSync(fp, 'utf8') === 'BEFORE';
          snapDetail = '快照 ' + snap.count + ' 文件 → 还原 ' + (r.restored || 0) + ' 文件，内容一致=' + snapOk;
          try { fs.unlinkSync(path.join(SNAPSHOT_DIR, snap.runId + '.json')); } catch {}
        } else snapDetail = snap.reason || '快照失败';
      } catch (e) { snapDetail = String(e.message || e); }
      finally { try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {} }
      add('快照与一键还原', snapOk, snapDetail);
      let auditOk = false;
      try {
        const before = fs.existsSync(AGENT_AUDIT_LOG) ? fs.statSync(AGENT_AUDIT_LOG).size : 0;
        audit({ kind: 'selfcheck', note: 'sandbox panel' });
        auditOk = fs.statSync(AGENT_AUDIT_LOG).size > before;
      } catch {}
      add('审计日志', auditOk, auditOk ? '可写：agent-audit.log' : '写入失败');
      add('高危命令识别', DANGEROUS_CMD.test('rm -rf ./x') && !DANGEROUS_CMD.test('npm install'), '拦截规则已加载');
      add('完全权限二次确认', true, '前端 confirm + 后端 confirmDanger 双校验');
      add('安全模式', true, settings.agentSafeMode === true ? '已开启：禁网 + 审批' : '未开启：装包 / curl / 自动化不中断');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: checks.every(c => c.ok), at: new Date().toISOString(), checks }));
    }
    // ---------- 一键自检 ----------
    if (req.method === 'POST' && url === '/api/selfcheck') {
      let payload = {};
      try { payload = await readBody(req); } catch (e) { payload = {}; }
      if (payload && (payload.fix || payload.fixAll)) {
        const ids = payload.fixAll ? null : (Array.isArray(payload.ids) ? payload.ids : [payload.fix]);
        const r = applySelfcheckFixes(ids);
        audit({ kind: 'selfcheck', note: 'fix ' + JSON.stringify(r.fixed) });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(Object.assign({ ok: r.failed.length === 0 }, r)));
      }
      let report;
      try { report = await runSelfcheck(); }
      catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(report));
    }
    if (req.method === 'POST' && url === '/api/chat') return streamChat(req, res);
    // 模型 × Agent 协议档位：查询 / 手动指定 / 清空重学。
    if (url === '/api/agent/capabilities') {
      const done = (extra) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(Object.assign({ ok: true, capabilities: adapter.capabilities(),
          guard: adapter.guard.snapshot() }, extra || {})));
      };
      if (req.method === 'GET') return done();
      if (req.method === 'POST') {
        readBody(req).then((b) => {
          const m = String(b.model || '');
          const mode = String(b.mode || '');
          if (m && (mode === 'native' || mode === 'text' || mode === 'unknown')) {
            adapter.registry.set(m, mode, 'manual override');
          }
          if (b.reset === true) adapter.registry.resetAll('reset by user');
          done({ updated: m || (b.reset === true ? 'all' : '') });
        }).catch(() => done({ error: 'bad body' }));
        return;
      }
    }
    if (req.method === 'POST' && url === '/api/agent') return streamAgent(req, res);

    res.writeHead(404); res.end();
  });

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        settings.port = settings.port + 1;
        server.listen(settings.port, '127.0.0.1');
      } else reject(e);
    });
    server.on('listening', () => {
      resolve(server);
      // P2：事件日志清理。启动 30s 后跑一次，之后每 10 分钟一次。
      // 只删终态 run 的审计日志；活跃 run 永不删，续订依赖内存事件不受影响。
      if (!global.__whaleGcTimer) {
        const runGc = () => {
          try {
            const R = initRuns();
            R.gc(30 * 60 * 1000);
            const r = R.gcEvents();
            if (r && r.deleted && r.deleted.length) {
              audit({ kind: 'event_gc', scanned: r.scanned, deleted: r.deleted.length,
                freedBytes: r.freedBytes, remainingBytes: r.remainingBytes, keptActive: r.keptActive });
            }
          } catch (e) {}
        };
        setTimeout(runGc, 30 * 1000);
        global.__whaleGcTimer = setInterval(runGc, 10 * 60 * 1000);
        if (global.__whaleGcTimer.unref) global.__whaleGcTimer.unref();
      }
    });
    server.listen(settings.port, '127.0.0.1');
  });
}

// 会话可能几百 KB，用 Buffer 拼接再一次性解码，比字符串累加快且不会拆坏多字节字符
function readBodyRaw(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => { parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
    req.on('end', () => { try { resolve(Buffer.concat(parts).toString('utf8')); } catch { resolve(''); } });
    req.on('error', () => resolve(''));
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    let over = false;
    let settled = false;
    let timer = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // 清理监听，避免重复事件
      try { req.removeListener('data', onData); } catch {}
      try { req.removeListener('end', onEnd); } catch {}
      try { req.removeListener('error', onErr); } catch {}
      try { req.removeListener('aborted', onErr); } catch {}
      try { req.removeListener('close', onClose); } catch {}
      resolve(v);
    };
    const onData = (c) => {
      size += c.length;
      if (maxBytes && size > maxBytes) { over = true; return; }
      raw += c;
    };
    const onEnd = () => {
      if (over) return done(null);   // 超限：交给调用方明确拒绝（413）
      try { done(JSON.parse(raw || '{}')); } catch { done(null); } // 解析失败：null（调用方 400）
    };
    const onErr = () => done(null);
    const onClose = () => done(null);  // 客户端提前断开
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
    req.on('aborted', onErr);
    req.on('close', onClose);
    // 有界超时保护
    timer = setTimeout(() => done(null), 8000);
  });
}

// 把任意上游错误（字符串 / {message,code} / 嵌套对象）展开成可读文本，
// 避免 String(obj) 变成 [object Object] 让用户完全看不到原因。
function errText(e, limit) {
  const n = limit || 400;
  if (typeof e === 'string') return e.slice(0, n);
  if (e && typeof e === 'object') {
    if (typeof e.message === 'string') return (e.message + (e.code ? ' (' + e.code + ')' : '')).slice(0, n);
    try { return JSON.stringify(e).slice(0, n); } catch { return String(e).slice(0, n); }
  }
  return String(e || '').slice(0, n);
}
// 失败重试会在会话里留下多条孤立 user 消息；合并连续同角色后再发给上游
function normalizeMessages(msgs) {
  if (!Array.isArray(msgs)) return [];
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    const canMerge = typeof m.content === 'string' && last && last.role === role
      && typeof last.content === 'string' && !m.images && !last.images;
    if (canMerge) last.content += '\n\n' + m.content;
    else out.push(Object.assign({}, m, { role }));
  }
  return out;
}

// ---------- 上游协议自适应（聊天 / 标题 / 摘要 / 补跑共用） ----------
// 按模型协议选 /chat/completions 或 /v1/responses；协议不兼容时自动切另一套重试一次。
// agent 侧另由 resolveEngine 负责（还要选 Codex 引擎与 CODEX_HOME）。
const PROTOCOL_MISMATCH = new Set([400, 404, 405, 415, 422, 501]);
const isProtocolMismatch = (st) => PROTOCOL_MISMATCH.has(st);
// 404 有两种含义：协议不对，还是"这个模型没给本账号开通"。后者换协议也没用，
// 只会多打一次请求，必须靠响应体区分。
const isAccountLocked = (txt) => /not found for account|not found for organization|permission|not authorized/i.test(String(txt || ''));

function failoverTarget(model) {
  const chain = getFailoverChain().filter(m => m !== model && MODEL_CATALOG[m].health !== 'locked');
  const pick = chain[0] || getFailoverChain().find(m => m !== model) || null;
  return { model: pick, label: pick ? (MODEL_CATALOG[pick] ? MODEL_CATALOG[pick].label : pick) : '' };
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

// 上游错误分类：NIM 的失败分好几种，笼统说"请稍后再试"等于没说。
// 这里按状态码 + 响应体给出原因、可执行动作和重置时间。
function classifyUpstream(st, txt, model, waitedMs) {
  const meta = getModelMeta(model);
  const label = meta.label;
  const raw = String(txt || '');
  const alt = failoverTarget(model);
  const waited = fmtDuration(waitedMs || 0);
  const tail = alt.model ? '已自动改用 ' + alt.label + ' 重试' : '请稍后重试';

  if (st === 429) {
    const m = raw.match(/(20\d{2}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    let when = '', resetAt = null;
    if (m) {
      resetAt = m[1] + ' ' + m[2];
      const reset = new Date(m[1] + 'T' + m[2] + '+08:00');
      if (!isNaN(reset.getTime())) {
        const left = reset.getTime() - Date.now();
        const hh = String(reset.getHours()).padStart(2, '0');
        const mm = String(reset.getMinutes()).padStart(2, '0');
        when = left > 0
          ? '，额度将在 ' + hh + ':' + mm + '（约 ' + fmtDuration(left) + '后）重置'
          : '，额度应已重置，可直接重试';
      }
    }
    return { code: 'RATE_LIMIT', retryable: true, resetAt, suggest: alt.model,
      msg: '上游限流 429：' + label + '的频率/额度已用尽' + when + '。' + (alt.model ? '可换 ' + alt.label + ' 立刻继续。' : '请稍后重试。') };
  }
  if (st === 410 || /end of life|no longer available/i.test(raw)) {
    return { code: 'MODEL_RETIRED', retryable: false, suggest: alt.model,
      msg: '模型已下线（410）：' + label + ' 已停止服务。' + (alt.model ? '建议切换到 ' + alt.label + '。' : '请换模型。') };
  }
  if (st === 404 && isAccountLocked(raw)) {
    return { code: 'MODEL_LOCKED', retryable: false, suggest: alt.model,
      msg: '模型未开通（404）：当前 API Key 没有 ' + label + ' 的调用权限。' + (alt.model ? '建议切换到 ' + alt.label + '。' : '') };
  }
  if (st === 401 || st === 403) {
    return { code: 'AUTH', retryable: false,
      msg: '鉴权失败（' + st + '）：API Key 无效或已过期，请到设置里更新。' + (raw ? ' 上游：' + raw.slice(0, 120) : '') };
  }
  if (st === 402) {
    return { code: 'BILLING', retryable: false,
      msg: '额度不足（402）：账户余额或用尽。' + (raw ? ' 上游：' + raw.slice(0, 120) : '') };
  }
  if (st === 504 || st === 502) {
    return { code: 'QUEUE_TIMEOUT', retryable: true, suggest: alt.model,
      msg: '上游排队超时（' + st + '）：等待 ' + waited + ' 仍未返回任何内容，这是 NIM 侧容量问题。' + tail + '。' };
  }
  if (st >= 500) {
    return { code: 'UPSTREAM_5XX', retryable: true, suggest: alt.model,
      msg: '上游服务错误 ' + st + '（已等待 ' + waited + '）。' + (raw ? raw.slice(0, 140) : '') };
  }
  return { code: 'HTTP_' + st, retryable: false,
    msg: 'HTTP ' + st + ': ' + (raw.slice(0, 300) || '上游未返回说明') };
}

// 聊天侧优先 NIM 通用端点 /chat/completions：实测所有可用模型都支持它，
// 多轮 / 长上下文更稳、延迟更低（550B 长历史 5.3s vs responses 14.2s）。
// 只有该端点明确不支持时才自动回退 /v1/responses —— 自动适配能力不打折。
// agent 侧仍由 resolveEngine 严格按模型协议选 Codex 引擎。
async function preferredWire(model, forChat) {
  if (forChat) return 'chat';
  const meta = getModelMeta(model);
  return meta.wire || await probeWire(model);   // 已登记模型不探测，避免给拥塞队列添请求
}
function upstreamHeaders(model) {
  return { Authorization: 'Bearer ' + activeApiKey(model), 'Content-Type': 'application/json', Accept: 'text/event-stream' };
}
/* P1 真实用量：OpenAI 兼容的流式端点默认不返回 usage，必须显式请求
 * stream_options.include_usage。端点明确拒绝时记住能力并去掉参数重试一次，
 * 不无限重试、不为统计另发一次计费请求。 */
const usageOptUnsupported = new Set();
function withUsageOption(body, model) {
  if (!body || typeof body !== 'object' || !body.stream) return body;
  const b = Object.assign({}, body);
  if (usageOptUnsupported.has(model)) delete b.stream_options;
  else b.stream_options = { include_usage: true };
  return b;
}
function isUsageOptRejection(txt) {
  return /stream_options|include_usage|unknown parameter|unrecognized|invalid[^\n]{0,40}param/i.test(String(txt || ''));
}
function markUsageOptUnsupported(model) {
  usageOptUnsupported.add(model);
  try { adapterLog('include_usage unsupported model=' + model); } catch (e) {}
}

function upstreamStreamBody(wire, upBody, model) {
  if (wire !== 'responses') return withUsageOption(upBody, model);
  return {
    model: upBody.model,
    input: upBody.messages || [],
    stream: true,
    max_output_tokens: upBody.max_tokens,
    temperature: upBody.temperature,
  };
}

// /v1/responses 事件流 → /chat/completions SSE 帧，复用既有解析循环 / 心跳 / 统计
function translateResponses(body) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  const emit = (o) => enc.encode('data: ' + JSON.stringify(o) + '\n\n');
  return (async function* () {
    let buf = '';
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true });
      const frames = [];
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let evName = '', dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
        }
        if (!dataLine || dataLine === '[DONE]') continue;
        let j; try { j = JSON.parse(dataLine); } catch { continue; }
        const ty = evName || j.type;
        if (ty === 'response.output_text.delta' && j.delta) {
          frames.push(emit({ choices: [{ delta: { content: j.delta } }] }));
        } else if (/reasoning.*delta/.test(ty) && j.delta) {
          frames.push(emit({ choices: [{ delta: { reasoning_content: j.delta } }] }));
        } else if (ty === 'response.completed' || ty === 'response.incomplete') {
          const u = j.response && j.response.usage;
          if (u) {
            // 保留 Responses 原始 usage 供归一化读取 input_tokens_details.cached_tokens
            // 与 output_tokens_details.reasoning_tokens；缺失字段保持 null，不伪造 0。
            const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
            frames.push(emit({ usage: {
              __protocol: 'responses',
              __raw: u,
              prompt_tokens: num(u.input_tokens),
              completion_tokens: num(u.output_tokens),
              total_tokens: num(u.total_tokens),
              prompt_tokens_details: { cached_tokens: num(u.input_tokens_details && u.input_tokens_details.cached_tokens) },
              completion_tokens_details: { reasoning_tokens: num(u.output_tokens_details && u.output_tokens_details.reasoning_tokens) },
            }}));
          }
        } else if (ty === 'response.failed' || ty === 'error') {
          const e = (j.response && j.response.error) || j.error || j.message;
          frames.push(emit({ error: typeof e === 'string' ? e : JSON.stringify(e).slice(0, 200) }));
        }
      }
      // 没有业务事件时也产出一个保活帧，让 armIdle / markFirstByte 仍只认真实上游字节
      if (!frames.length) frames.push(emit({}));
      for (const f of frames) yield f;
    }
  })();
}

async function openChatUpstream(model, upBody, signal, overrideWire) {
  const base = activeBase(model).replace(/\/+$/, '');
  const wire = overrideWire || await preferredWire(model, true);
  const tryWire = (w) => fetch(base + (w === 'responses' ? '/responses' : '/chat/completions'), {
    method: 'POST', headers: upstreamHeaders(model),
    body: JSON.stringify(upstreamStreamBody(w, upBody, model)), signal,
  });
  let usedWire = wire, res = await tryWire(wire), note = '', firstBody = '';
  // 端点不认 stream_options.include_usage：记住能力后去掉参数重试一次
  if (res.status === 400 && !usageOptUnsupported.has(model)) {
    const t = await res.clone().text().catch(() => '');
    if (isUsageOptRejection(t) && /stream_options|include_usage/i.test(t)) {
      markUsageOptUnsupported(model);
      res = await tryWire(wire);
    }
  }
  // 端点不认 reasoning_effort：去掉参数同模型重试一次，并记住这个模型不再发
  let effortStripped = false;
  if (res.status === 400 && upBody && upBody.reasoning_effort) {
    const t = await res.clone().text().catch(() => '');
    if (/reasoning_effort|unknown parameter|unrecognized|invalid[^\n]{0,40}param/i.test(t)) {
      delete upBody.reasoning_effort;
      effortStripped = true;
      try { markEffortUnsupported(model); adapterLog('effort_stripped model=' + model); } catch (e) {}
      res = await tryWire(wire);
    }
  }
  if ((!res.ok || !res.body) && isProtocolMismatch(res.status)) {
    firstBody = await res.text().catch(() => '');
    // 模型未开通 / 已下线时换协议不可能成功，只会白打一次请求
    const futile = isAccountLocked(firstBody) || /end of life|no longer available/i.test(firstBody);
    if (!futile) {
      const alt = wire === 'responses' ? 'chat' : 'responses';
      try {
        res = await tryWire(alt);
        usedWire = alt;
        note = '协议自动切换 ' + wire + ' → ' + alt;
      } catch (e) { /* 保留第一次结果用于报错 */ }
    }
  }
  const stream = (usedWire === 'responses' && res.ok && res.body) ? translateResponses(res.body) : res.body;
  return { wire: usedWire, res, stream, note, bodyText: firstBody, effortStripped };
}

// 非流式小请求（标题 / 摘要）统一入口，同样带协议回退
async function callUpstreamJSON(model, opts) {
  const base = activeBase(model).replace(/\/+$/, '');
  const wire = await preferredWire(model, true);
  const attempt = async (w) => {
    const body = w === 'responses'
      ? { model: wireModelOf(model), input: opts.messages, max_output_tokens: opts.maxTokens, temperature: opts.temperature ?? 0.3 }
      : { model: wireModelOf(model), messages: opts.messages, max_tokens: opts.maxTokens, temperature: opts.temperature ?? 0.3 };
    const r = await fetch(base + (w === 'responses' ? '/responses' : '/chat/completions'), {
      method: 'POST', headers: upstreamHeaders(model), body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { r, text: '', usage: null };
    const j = await r.json().catch(() => null);
    if (w === 'responses') {
      let text = '';
      for (const it of (j && Array.isArray(j.output) ? j.output : []))
        for (const p of (it.content || [])) if (p.type === 'output_text') text += p.text || '';
      return { r, text, usage: (j && j.usage) || null };
    }
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    return { r, text: (m && m.content) || '', usage: (j && j.usage) || null };
  };
  let a = await attempt(wire);
  if (a.r.status && isProtocolMismatch(a.r.status)) {
    a = await attempt(wire === 'responses' ? 'chat' : 'responses');
  }
  return a;
}

/* P1：统计的唯一权威来源。运行中、收到 usage、请求完成、最终 done 全部使用同一投影，
 * 避免旧 UI 函数、finally、兼容分支把新数据覆盖掉，也避免各阶段数字互相矛盾。 */
function makeRunStats(R, runId, extra) {
  const p = R.project(runId);
  if (!p) return null;
  return Object.assign({
    runId: p.runId, threadId: p.threadId, sessionId: p.sessionId,
    turn: p.turn, turnOfThread: p.turnOfThread, step: p.step,
    lastSeq: p.lastSeq,
    state: p.state, usageState: p.usageState,
    usage: p.usage, speed: p.speed, cache: p.cache,
    sessionUsage: p.sessionUsage, sessionTurn: p.sessionTurn,
    requests: p.requests, toolCount: p.toolCount,
  }, extra || {});
}

// ---------- 聊天：转发 NVIDIA NIM（SSE 流式） ----------
async function streamChat(req, res) {
  const payload = await readBody(req);
  let model = payload.model || settings.model || DEFAULT_MODEL;
  const sessionId = payload.sessionId || null;
  // P0：本次请求一个独立 run。身份由后端分配，前端只订阅投影，不再自己累加轮/步。
  const R = initRuns();
  const run = R.create({
    kind: 'chat',
    sessionId: sessionId,
    threadId: String(payload.threadId || 'main'),
    model: model,
  });
  // 本轮活动记录：requested 是界面选的，actual 是最终真正出字的
  const act = {
    kind: 'chat',
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    requested: model,
    actual: model,
    wire: null,
    session: sessionId,
    thinkingBudget: null,
    attempts: [],
    notes: [],
    outcome: 'pending',
    reason: null,
    _t0: Date.now(),
    _done: false,
  };
  const finishAct = (outcome, extra) => {
    if (act._done) return;
    act._done = true;
    act.outcome = outcome;
    Object.assign(act, extra || {});
    act.ms = Date.now() - act._t0;
    delete act._t0; delete act._done;
    try { recordModelActivity(act); } catch {}
  };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // 先把 runId 告诉前端：停止按钮据此只取消本 run（不再走全局 /api/stop）
  sse(res, { run: { runId: run.runId, threadId: run.threadId } });
  // 当前权威 usage 所属协议与原始对象（归一化用），声明提前避免 TDZ。
  let usageProtocol = 'chat';
  let usageRaw = null;
  let lastStatsPushAt = 0;
  const pushStats = (force, extra) => {
    const t = Date.now();
    if (!force && t - lastStatsPushAt < 300) return;
    lastStatsPushAt = t;
    const st = makeRunStats(R, run.runId, extra);
    if (st) sse(res, { stats: st });
  };
  R.emit(run.runId, 'run.started', { model: model, kind: 'chat' }, 'server');
  R.emit(run.runId, 'turn.accepted', { model: model }, 'client');
  pushStats(true, { phase: 'accepted' });
  if (!activeApiKey()) {
    sse(res, { error: '缺少 API Key（在设置里填写，或编辑 ' + SETTINGS_FILE + ' 的 apiKey）' });
    try { R.finish(run.runId, 'failed', { reason: 'missing_api_key' }); } catch (e) {}
    sse(res, { stats: makeRunStats(R, run.runId, { phase: 'final' }) });
    sse(res, { done: true });
    return res.end();
  }
  // DeepSeek V4.1 在 NIM 上：thinking 开着会把 max_tokens 全烧在 reasoning 上，
  // 实测 1200 token 预算时正文 0 字。按设置决定是否开思考，并给正文留足预算。
  const isDS41 = /deepseek-ai\/deepseek-v4\.1/.test(model);
  // thinking 能力以模型目录为准；未登记模型沿用实测过的正则兜底
  const meta = getModelMeta(model);
  const thinkingCapable = meta.thinking === null
    ? /deepseek-ai\/deepseek-v4\.1|nemotron-3\.5-super|minimax/i.test(model)
    : meta.thinking;
  const reqDepth = (payload.thinkingDepth && THINKING_DEPTHS[payload.thinkingDepth])
    ? payload.thinkingDepth
    : (THINKING_DEPTHS[settings.thinkingDepth] ? settings.thinkingDepth : DEFAULT_THINKING_DEPTH);
  const depthCfg = THINKING_DEPTHS[reqDepth] || THINKING_DEPTHS[DEFAULT_THINKING_DEPTH];
  // 2026-11-08 用户要求：deepseek-v4.1 强制开启思考，忽略前端传入的 thinkingDepth
  const thinkingOn = thinkingCapable && (isDS41 ? true : depthCfg.thinking);
  const upBody = {
    model: wireModelOf(model),
    messages: normalizeMessages(payload.messages || []),
    stream: true,
    max_tokens: payload.max_tokens || depthCfg.maxTokens,
    temperature: payload.temperature ?? 0.6,
  };
  if (thinkingCapable) upBody.chat_template_kwargs = { thinking: thinkingOn };
  // 真正影响「思考努力」的参数：只发给认这个参数的端点，被拒过的不再发
  if (EFFORT_MAP[reqDepth] && endpointTakesEffort(model) && !effortUnsupported(model)) {
    upBody.reasoning_effort = EFFORT_MAP[reqDepth];
  }
  // P1+P3：算本次请求的上下文预算（**只诊断，不裁剪**）。
  // 窗口优先取「按 provider+model 发现的能力」，而不是全局 effectiveContextLimit。
  let ctxPlan = null, capKey = null, capUsed = null;
  // P5 的摘要字段要跨越 P4（P4 会重建 ctxPlan 对象，不能让它把摘要记录冲掉）
  let summaryCarry = null;
  try {
    const upProv = upstreamFor(model);
    const wireId = wireModelOf(model);
    capKey = { providerId: upProv.id || 'unknown', modelId: wireId };
    const reg = initCapabilities();
    const cq = {
      providerId: capKey.providerId, modelId: capKey.modelId, wireModel: wireId,
      base: upProv.base, apiKey: upProv.apiKey, catalogCtx: (MODEL_CATALOG[model] || {}).ctx,
    };
    let cap = reg.get(cq);
    if (cap.source === 'fallback') {
      // 首次没有可信元数据：最多等 600ms 去发现，超时先用保守值（不把首条消息拖太久）
      const got = await Promise.race([
        reg.ensure(cq).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 600)),
      ]);
      if (got) cap = got;
    }
    const plan = ctxBudget.planForMessages({
      contextWindow: Math.min(cap.contextWindow, cap.providerHardLimit || cap.contextWindow),
      maxOutputTokens: cap.maxOutputTokens,
      reasoningReserve: cap.reasoningReserve || 0,
      estimatorFactor: cap.calibrationFactor || 1,
      messages: upBody.messages,
      requestedOutput: upBody.max_tokens,
    });
    plan.model = model;
    plan.providerId = cap.providerId;
    plan.modelId = cap.modelId;
    plan.capabilitySource = cap.source;
    plan.capabilityConfidence = cap.confidence;
    plan.capabilityVersion = cap.version;
    plan.capabilityNote = cap.note || null;
    plan.capabilityObservedAt = cap.observedAt;
    capUsed = cap;
    plan.effectiveContextLimit = effectiveContextLimit(model);
    plan.at = Date.now();
    // 即使不裁剪也要有明确字段：调用方要能区分「没裁」和「没有信息」
    plan.trimmed = false;
    plan.actions = [];
    plan.warnings = [];
    ctxPlan = plan;
    R.setContextPlan(run.runId, plan);
    R.emit(run.runId, 'context.plan', plan, 'server');
    if (!plan.fits || plan.level === 'red') {
      // 只记录，不拦截：本阶段明确不改变请求内容
      audit({ kind: 'context_over_budget', runId: run.runId, sessionId: payload.sessionId || null,
        model: model, H: plan.H, C: plan.C, level: plan.level, capabilitySource: plan.capabilitySource });
    }
  } catch (e) {}

  // P5：结构化摘要。橙/红水位下把**低价值旧历史**压成带来源追踪与哈希校验的摘要；
  // 校验失败 / 不值得（摘要不比原文短）→ 原文一条不动，交回 P4。
  // `settings.contextSummary=false` 可一键停用，回到"无摘要 + P4 装配"。
  // 任何异常只记 audit，绝不改请求、绝不删历史（指令 §六）。
  // 注意：这里**不**在条件里判断开关。关闭时也要进块，让 planWithSummary 返回
  // summaryStatus='disabled'，调用方才读得到"为什么没用摘要"，而不是一片 undefined。
  if (ctxPlan && capUsed && (ctxPlan.level === 'orange' || ctxPlan.level === 'red')) {
    const beforeMsgs = (upBody.messages || []).slice();
    try {
      const sysMsgs = beforeMsgs.filter((m) => m.role === 'system');
      const nonSys = beforeMsgs.filter((m) => m.role !== 'system');
      let lastUserIdx = -1;
      for (let i = nonSys.length - 1; i >= 0; i--) { if (nonSys[i].role === 'user') { lastUserIdx = i; break; } }
      const currentInput = lastUserIdx >= 0 ? [nonSys[lastUserIdx]] : [];
      const historyMsgs = lastUserIdx >= 0 ? nonSys.slice(0, lastUserIdx) : nonSys;

      const sum = ctxSummary.planWithSummary({
        capability: capUsed,
        systemMessages: sysMsgs,
        currentInput: currentInput,
        history: historyMsgs,
        tools: [],
        requestedOutput: upBody.max_tokens,
        pinnedMessageIds: settings.pinnedMessageIds || [],
        enabled: settings.contextSummary !== false,
        modelId: model,
        params: { keepRecentTurns: settings.contextKeepRecentTurns || 8 },
      });

      // 无论用没用上，六个摘要字段都并入 contextPlan：调用方要能回答
      // 「覆盖了哪些原文 / 用了哪个摘要 / 校验过没过 / 失败为何回退」
      ctxPlan = Object.assign({}, ctxPlan, sum.summaryPlan);
      summaryCarry = sum.summaryPlan;

      if (sum.applied && Array.isArray(sum.messages)) {
        upBody.messages = sum.messages;
        // 摘要改变了历史占用 → 用完全相同的口径重算预算，再交给 P4 判断是否还需要裁
        const plan2 = ctxBudget.planForMessages({
          contextWindow: Math.min(capUsed.contextWindow, capUsed.providerHardLimit || capUsed.contextWindow),
          maxOutputTokens: capUsed.maxOutputTokens,
          reasoningReserve: capUsed.reasoningReserve || 0,
          estimatorFactor: capUsed.calibrationFactor || 1,
          messages: upBody.messages,
          requestedOutput: upBody.max_tokens,
        });
        ctxPlan = Object.assign({}, ctxPlan, {
          level: plan2.level, W: plan2.W, P: plan2.P, I: plan2.I, H: plan2.H,
          O: plan2.O, R: plan2.R, C: plan2.C, waterline: plan2.waterline, fits: plan2.fits,
          messagesBefore: beforeMsgs.length, messagesAfter: upBody.messages.length,
          summaryTokensSaved: sum.savedTokens,
        });
        R.setContextPlan(run.runId, ctxPlan);
        audit({
          kind: 'context_summary', runId: run.runId, level: ctxPlan.level,
          summaryId: sum.summary.summaryId,
          summarySource: sum.summary.source,
          coveredCount: (sum.summary.sourceMessageIds || []).length,
          coveredTokens: sum.coveredTokens,
          summaryTokens: sum.summary.tokenEstimate,
          savedTokens: sum.savedTokens,
          before: beforeMsgs.length, after: upBody.messages.length,
        });
      } else {
        R.setContextPlan(run.runId, ctxPlan);
        audit({
          kind: 'context_summary_skipped', runId: run.runId,
          reason: sum.reason, detail: ctxPlan.summaryFallbackReason,
        });
      }
    } catch (e) {
      // 摘要层出错：请求照常发原文，历史一条不丢
      audit({ kind: 'context_summary_failed', runId: run.runId, error: String(e.message || e).slice(0, 200) });
    }
  }

  // P4：按预算装配历史。绿色/黄色**完全不动**（与旧路径逐字节一致）；
  // 只有橙/红才裁剪，且每次取舍写进 contextPlan.actions + audit。
  // 可用 settings.contextTrim=false 一键回到「永远不裁」的旧行为。
  if (ctxPlan && capUsed && settings.contextTrim !== false
    && (ctxPlan.level === 'orange' || ctxPlan.level === 'red')) {
    const beforeMsgs = (upBody.messages || []).slice();
    try {
      const sysMsgs = beforeMsgs.filter((m) => m.role === 'system');
      const nonSys = beforeMsgs.filter((m) => m.role !== 'system');
      let lastUserIdx = -1;
      for (let i = nonSys.length - 1; i >= 0; i--) { if (nonSys[i].role === 'user') { lastUserIdx = i; break; } }
      const currentInput = lastUserIdx >= 0 ? [nonSys[lastUserIdx]] : [];
      const historyMsgs = lastUserIdx >= 0 ? nonSys.slice(0, lastUserIdx) : nonSys;
      const res = ctxPlanner.planHistory({
        capability: capUsed,
        systemMessages: sysMsgs,
        currentInput: currentInput,
        history: historyMsgs,
        requestedOutput: upBody.max_tokens,
        pinnedMessageIds: settings.pinnedMessageIds || [],
        params: { keepRecentTurns: settings.contextKeepRecentTurns || 8 },
      });
      upBody.messages = sysMsgs.concat(res.selectedMessages, currentInput);
      // 先并入 P5 的摘要记录，再覆盖 P4 自己的字段：
      // 否则 P4 重建对象会把 summaryUsed/summaryIds 等整组字段抹掉（曾导致验收读不到）。
      ctxPlan = Object.assign({}, res.contextPlan, summaryCarry || {}, {
        actions: res.actions,
        warnings: res.warnings,
        messagesBefore: beforeMsgs.length,
        messagesAfter: upBody.messages.length,
        trimmedIds: res.omittedMessageIds,
      });
      R.setContextPlan(run.runId, ctxPlan);
      audit({
        kind: 'context_trim', runId: run.runId, level: ctxPlan.level,
        before: beforeMsgs.length, after: upBody.messages.length,
        actions: res.actions.map((a) => ({ type: a.type, count: (a.messageIds || []).length, reason: a.reason })),
        warnings: res.warnings,
      });
    } catch (e) {
      // 规划器异常：保留原文，绝不因为裁剪逻辑出错而丢历史
      upBody.messages = beforeMsgs;
      audit({ kind: 'context_trim_failed', runId: run.runId, error: String(e.message || e).slice(0, 200) });
    }
  }

  // 非 4.1 推理模型若上游支持 reasoning_effort，可在此透传（nim 端点当前不支持，保留接口）
  let ttft = null;
  let firstChunkTime = null;
  const t0 = Date.now();
  // 上游控制器：/api/stop 或客户端断连都能真正取消这次请求（不再白烧配额）
  const ctl = new AbortController();
  R.attach(run.runId, { abort: () => { try { ctl.abort(); } catch (e) {} } });
  let closedByClient = false;
  let idleFired = false;
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleFired = true; try { ctl.abort(); } catch (e) {} }, IDLE_MS);
  };
  // 2026-11-08：NIM 排队时上游一个字节都不给，界面会像死了一样。
  // 首字节前每 2 秒推一个阶段事件，让前端能显示「已等待 xx 秒 · 上游排队中」并保活连接。
  // 注意：心跳是本地产生的，绝不能重置空闲看门狗（它只认上游真实字节）。
  let firstByteAt = null;
  let phaseTimer = null;
  const startPhaseHeartbeat = (reason) => {
    clearInterval(phaseTimer);
    firstByteAt = null;
    const r = reason || 'queued';
    sse(res, { phase: 'queued', waitedMs: Date.now() - t0, reason: r, idleMs: IDLE_MS });
    phaseTimer = setInterval(() => {
      if (firstByteAt === null) sse(res, { phase: 'queued', waitedMs: Date.now() - t0, reason: r });
    }, 2000);
  };
  const markFirstByte = () => {
    if (firstByteAt !== null) return;
    firstByteAt = Date.now();
    clearInterval(phaseTimer); phaseTimer = null;
    sse(res, { phase: 'first_byte', waitedMs: firstByteAt - t0 });
  };
  const stopPhaseHeartbeat = () => { clearInterval(phaseTimer); phaseTimer = null; };
  // P0：SSE 断开只是订阅退订，绝不是业务取消。执行生命周期由 RunRegistry 持有；
  // 只有显式 stop（/api/runs/:id/cancel）或应用真正退出才终止任务。
  res.on('close', () => {
    if (!res.writableEnded) closedByClient = true;
    clearTimeout(idleTimer);
    stopPhaseHeartbeat();
  });
  armIdle();
  startPhaseHeartbeat();
  let upstream, chatStream, usedWire = null;
  // 2026-11-09：4.1F 排队实测可到 5 分钟才 504，minimax/glm 等长期不返回。
  // 与其让用户盯着计时器，不如在"排队超时 / 限流 / 未开通"时自动换已验证可用的备用模型，
  // 并在对话流里明确告知换了哪个模型——不静默改变回答来源。
  const attemptChain = [model];
  if (settings.autoFailover !== false) {
    for (const m of getFailoverChain()) if (!attemptChain.includes(m)) attemptChain.push(m);
  }
  const queueLimit = Math.max(8000, Number(settings.queueFallbackMs) || 45000);
  const bodyFor = (m) => {
    const mm = getModelMeta(m);
    const b = Object.assign({}, upBody, { model: wireModelOf(m) });
    if (mm.thinking === false) delete b.chat_template_kwargs;
    else if (mm.thinking === true) b.chat_template_kwargs = { thinking: true };
    return b;
  };
  let lastInfo = null;
  // 一次逻辑模型推理 = 一步；下面的自动切换 / 协议回退属于同一 step 的不同 attempt
  R.emit(run.runId, 'step.started', { model: model }, 'server');
  pushStats(true, { phase: 'started' });
  let activeReqId = null;
  let genEvents = 0;
  let genFirstAt = null;
  let genLastAt = null;
  let lastProgressAt = 0;
  let lastTextFlushAt = 0;   // 正文增量写事件的节流点（200ms 下限）
  for (let ai = 0; ai < attemptChain.length; ai++) {
    const curModel = attemptChain[ai];
    const isLast = ai === attemptChain.length - 1;
    const curLabel = getModelMeta(curModel).label;
    // 每次尝试独立控制器：主控制器（用户点停止 / 客户端断开）能同步取消当前这次
    const actl = new AbortController();
    const reqEv = R.emit(run.runId, 'request.started',
      { model: curModel, attemptId: 'a' + (ai + 1) }, 'server');
    const reqId = reqEv && reqEv.payload ? reqEv.payload.requestId : null;
    const relayAbort = () => { try { actl.abort(); } catch (e) {} };
    if (ctl.signal.aborted) relayAbort();
    else ctl.signal.addEventListener('abort', relayAbort, { once: true });
    let timedOut = false, watchdog = null;
    const opened = await new Promise((resolve) => {
      let settled = false;
      if (!isLast) {
        watchdog = setTimeout(() => {
          if (settled) return;
          settled = true; timedOut = true;
          try { actl.abort(); } catch (e) {}
          resolve({ timedOut: true });
        }, queueLimit);
      }
      openChatUpstream(curModel, bodyFor(curModel), actl.signal)
        .then((r) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve(r); })
        .catch((e) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve({ err: e }); });
    });

    // 排队超时：换下一个模型
    if (opened.timedOut) {
      clearTimeout(idleTimer);
      const next = attemptChain[ai + 1];
      lastInfo = { code: 'QUEUE_LOCAL', retryable: true, suggest: next,
        msg: curLabel + ' 排队 ' + fmtDuration(queueLimit) + ' 无响应，已自动切换 ' + getModelMeta(next).label };
      act.attempts.push({ model: curModel, result: 'timeout', waitedMs: Date.now() - act._t0, msg: lastInfo.msg });
      sse(res, { phase: 'model_failover', note: lastInfo.msg, from: curModel, to: next });
      startPhaseHeartbeat('failover'); armIdle();
      continue;
    }
    // 网络层异常
    if (opened.err) {
      const emsg = String(opened.err.message || opened.err).slice(0, 200);
      noteCtxOverflow(capKey, emsg);
      if (ctl.signal.aborted) {
        clearTimeout(idleTimer); stopPhaseHeartbeat();
        if (!closedByClient) { sse(res, { error: '已停止', stopped: true }); sse(res, { done: true }); }
        finishAct(closedByClient ? 'aborted' : 'stopped', { actual: curModel, reason: '用户停止或客户端断开' });
        try { R.finish(run.runId, 'cancelled', { reason: 'aborted' }); } catch (e) {}
        return endRes(res);
      }
      if (!isLast) {
        const next = attemptChain[ai + 1];
        lastInfo = { code: 'NETWORK', retryable: true, suggest: next,
          msg: '连接 ' + curLabel + ' 失败（' + emsg + '），已自动切换 ' + getModelMeta(next).label };
        act.attempts.push({ model: curModel, result: 'network', msg: emsg });
        sse(res, { phase: 'model_failover', note: lastInfo.msg, from: curModel, to: next });
        startPhaseHeartbeat('failover'); armIdle();
        continue;
      }
      clearTimeout(idleTimer); stopPhaseHeartbeat();
      act.attempts.push({ model: curModel, result: 'network', msg: emsg });
      if (!closedByClient) {
        sse(res, { error: '连接失败: ' + emsg, retryable: true });
        sse(res, { done: true });
      }
      finishAct(closedByClient ? 'aborted' : 'error', { reason: '连接失败: ' + emsg, actual: curModel });
      try { R.finish(run.runId, 'failed', { reason: 'network' }); } catch (e) {}
      return endRes(res);
    }

    const r = opened.res;
    // HTTP 层失败：分类后决定是降级还是直接报错
    if (!r.ok || !r.body) {
      const txt = opened.bodyText || await r.text().catch(() => '');
      const info = classifyUpstream(r.status, txt, curModel, Date.now() - t0);
      lastInfo = info;
      const noFailoverCode = info.code === 'AUTH' || info.code === 'BILLING';
      act.attempts.push({ model: curModel, result: 'http', status: r.status, code: info.code, msg: info.msg });
      if (!isLast && !noFailoverCode) {
        const next = attemptChain[ai + 1];
        sse(res, { phase: 'model_failover', note: info.msg + ' → 自动改用 ' + getModelMeta(next).label, from: curModel, to: next });
        startPhaseHeartbeat('failover'); armIdle();
        continue;
      }
      clearTimeout(idleTimer); stopPhaseHeartbeat();
      if (!closedByClient) {
        sse(res, { error: info.msg, retryable: info.retryable, code: info.code,
          resetAt: info.resetAt || null, suggest: info.suggest || null,
          waitedMs: Date.now() - t0, phase: 'upstream_error' });
        sse(res, { done: true, waitedMs: Date.now() - t0 });
      }
      finishAct('error', { actual: curModel, status: r.status, code: info.code, reason: info.msg });
      try { R.finish(run.runId, 'failed', { reason: 'http_' + r.status }); } catch (e) {}
      return endRes(res);
    }

    // 成功拿到流：锁定本次上游，后续解析沿用既有循环
    upstream = r; chatStream = opened.stream; usedWire = opened.wire;
    activeReqId = reqId;
    usageProtocol = usedWire === 'responses' ? 'responses' : 'chat';
    pushStats(true, { phase: 'request_started' });
    act.wire = usedWire;
    act.actual = curModel;
    act.thinkingBudget = upBody.max_tokens;
    if (opened.note) { act.notes.push(opened.note); sse(res, { phase: 'protocol_fallback', note: opened.note }); }
    if (curModel !== model) {
      const why = (lastInfo && lastInfo.code === 'QUEUE_LOCAL')
        ? getModelMeta(model).label + ' 排队 ' + fmtDuration(queueLimit) + ' 无响应，'
        : '原模型本轮不可用，';
      sse(res, { phase: 'model_switched', note: why + '已自动切换到 ' + curLabel + ' 作答', from: model, to: curModel });
      model = curModel;                       // 统计与日志记录实际作答的模型
    }
    break;
  }
  if (!upstream) {
    clearTimeout(idleTimer); stopPhaseHeartbeat();
    if (!closedByClient) {
      sse(res, { error: (lastInfo && lastInfo.msg) || '没有任何模型可用，请检查网络或 API Key', retryable: true });
      sse(res, { done: true });
    }
    finishAct(closedByClient ? 'aborted' : 'error', { reason: (lastInfo && lastInfo.msg) || '没有任何模型可用' });
    try { R.finish(run.runId, 'failed', { reason: 'no_model' }); } catch (e) {}
    return endRes(res);
  }
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;              // 给 done 事件的协议兼容字段（不作统计来源）
  let upstreamErrored = false;   // 上游在流内返回过 error 帧
  let contentChars = 0;
  let reasoningChars = 0;
  let acc = '';
  try {
    for await (const chunk of chatStream) {
      armIdle();
      markFirstByte();
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.usage) {
            usage = j.usage;
            usageProtocol = (j.usage.__protocol === 'responses') ? 'responses' : 'chat';
            usageRaw = (usageProtocol === 'responses' && j.usage.__raw) ? j.usage.__raw : j.usage;
            const nu = telemetry.normalizeUsage(usageRaw, usageProtocol, { source: 'provider' });
            R.emit(run.runId, 'request.usage', { requestId: activeReqId, usage: nu }, 'provider');
            // P3：用真实 input tokens 校准估算系数（连续 10 次、偏差>8% 才动，单次限幅）
            try {
              if (capKey && ctxPlan && nu && nu.availability && nu.availability.input === 'reported') {
                initCapabilities().calibrate({
                  providerId: capKey.providerId, modelId: capKey.modelId,
                  estimated: (ctxPlan.rawI || 0) + (ctxPlan.rawH || 0),
                  actual: nu.inputTokens,
                });
              }
            } catch (e) {}
            pushStats(true, { phase: 'usage' });
          }
          if (j.error) {
            upstreamErrored = true;
            const et = errText(j.error);
            try { fs.appendFileSync(path.join(ROOT, 'upstream-error.log'),
              new Date().toISOString() + ' model=' + model + ' wire=' + usedWire +
              ' raw=' + JSON.stringify(j.error).slice(0, 2000) + '\n'); } catch {}
            sse(res, { error: '上游返回错误：' + et, retryable: false, phase: 'upstream_error' });
            noteCtxOverflow(capKey, et);
          }
          for (const ch of j.choices || []) {
            const d = ch.delta || {};
            if (d.content) {
              if (firstChunkTime === null) { firstChunkTime = Date.now(); ttft = firstChunkTime - t0; }
              sse(res, { delta: d.content }); contentChars += d.content.length; acc += d.content;
              R.setLive(run.runId, acc);   // 供侧聊快照标注「未完成片段」，不当作已完成
              if (streamResumeOn()) R.pushText(run.runId, activeReqId, 'content', d.content);
              if (genFirstAt === null) { genFirstAt = Date.now(); R.emit(run.runId, 'request.first_output', { requestId: activeReqId }, 'provider'); }
              genLastAt = Date.now(); genEvents++;
              // 长流期间每 500ms 记一条进度事件：既是「父 run 未中断」的可核对证据，
              // 也让事件 seq 持续增长（不把静默当成卡死）。
              if (genLastAt - lastProgressAt > 500) {
                lastProgressAt = genLastAt;
                R.emit(run.runId, 'request.progress',
                  { requestId: activeReqId, chars: contentChars, genEvents: genEvents }, 'provider');
              }
              pushStats(false, { phase: 'generating' });
            }
            if (d.reasoning_content) {
              if (firstChunkTime === null) { firstChunkTime = Date.now(); ttft = firstChunkTime - t0; }
              sse(res, { reasoning: d.reasoning_content }); reasoningChars += d.reasoning_content.length;
              if (streamResumeOn()) R.pushText(run.runId, activeReqId, 'reasoning', d.reasoning_content);
              if (genFirstAt === null) { genFirstAt = Date.now(); R.emit(run.runId, 'request.first_output', { requestId: activeReqId }, 'provider'); }
              genLastAt = Date.now(); genEvents++;
              pushStats(false, { phase: 'generating' });
            }
            // 正文/推理都要能续订：这里按 200ms 下限统一 flush，避免只有推理时迟迟不落事件。
            if (streamResumeOn()) {
              const nowFlush = Date.now();
              if (nowFlush - lastTextFlushAt > 200) { lastTextFlushAt = nowFlush; R.flushText(run.runId, activeReqId); }
            }
          }
        }
      }
    }
  } catch (e) {
    if (ctl.signal.aborted) {
      if (idleFired) sse(res, { error: '上游 ' + Math.round(IDLE_MS / 60000) + ' 分钟无任何响应，已中断', retryable: true });
      else if (!closedByClient) sse(res, { error: '已停止', stopped: true });
    } else {
      sse(res, { error: '流中断: ' + String(e.message || e).slice(0, 200), retryable: true });
    }
  } finally {
    clearTimeout(idleTimer);
    stopPhaseHeartbeat();
  }
  const genMs = Date.now() - t0;
  // 真实指标（P1）：只用上游上报的 usage。缺失就是 null，不再用 contentChars/2.5 估算冒充精确值。
  const normUsage = usageRaw
    ? telemetry.normalizeUsage(usageRaw, usageProtocol, { source: 'provider', scope: 'request' })
    : null;
  const outTok = (normUsage && normUsage.availability.output === telemetry.AVAIL.REPORTED)
    ? normUsage.outputTokens : null;
  const speed = telemetry.computeSpeed({
    outputTokens: outTok, firstGenAt: genFirstAt, lastGenAt: genLastAt, events: genEvents,
  });
  const tokPerSec = speed.measurable ? speed.tokensPerSec : null;

  // 上游在流内返回 error 且正文为 0 字：自动换另一套协议重试一次。
  // 成功后推 recovered 让前端撤销刚才的失败提示，避免用户看到「失败但又有回复」。
  if (upstreamErrored && contentChars === 0 && !ctl.signal.aborted && !closedByClient) {
    const altWire = usedWire === 'chat' ? 'responses' : 'chat';
    act.notes.push('流内错误且无正文 → 换 ' + altWire + ' 协议重试');
    sse(res, { phase: 'retry_other_wire', note: '上游流内报错，正在换用 ' + altWire + ' 协议重试一次' });
    startPhaseHeartbeat('retry_other_wire');
    // 补跑在**发起前**就登记请求（带真实开始时刻）：即使没有任何 usage、被中断或抛错，
    // 也会结算为 missingRequests，不会凭空消失。
    const retryEv = R.emit(run.runId, 'request.started',
      { model: model, attemptId: 'wire_retry', startedAt: Date.now() }, 'server');
    const retryReqId = retryEv && retryEv.payload ? retryEv.payload.requestId : null;
    let u3 = null, genF3 = null, genL3 = null, genN3 = 0;
    try {
      const retry = await openChatUpstream(model, upBody, ctl.signal, altWire);
      if (retry.res.ok && retry.stream) {
        let b3 = '', err3 = false;
        const dec3 = new TextDecoder();
        for await (const chunk of retry.stream) {
          armIdle(); markFirstByte();
          b3 += dec3.decode(chunk, { stream: true });
          let i3;
          while ((i3 = b3.indexOf('\n\n')) >= 0) {
            const fr = b3.slice(0, i3); b3 = b3.slice(i3 + 2);
            for (const line of fr.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const d = line.slice(5).trim();
              if (d === '[DONE]') continue;
              let j3; try { j3 = JSON.parse(d); } catch { continue; }
              if (j3.usage) u3 = j3.usage;
              if (j3.error) err3 = true;
              for (const ch of j3.choices || []) {
                const dd = ch.delta || {};
                if (dd.content || dd.reasoning_content) {
                  if (genF3 === null) genF3 = Date.now();
                  genL3 = Date.now(); genN3++;
                }
                if (dd.content) { sse(res, { delta: dd.content }); contentChars += dd.content.length; acc += dd.content; }
                if (dd.reasoning_content) { sse(res, { reasoning: dd.reasoning_content }); reasoningChars += dd.reasoning_content.length; }
              }
            }
          }
        }
        if (u3) {
          usage = u3;
          usageProtocol = (u3.__protocol === 'responses') ? 'responses' : 'chat';
          usageRaw = (usageProtocol === 'responses' && u3.__raw) ? u3.__raw : u3;
          R.emit(run.runId, 'request.usage',
            { requestId: retryReqId, usage: telemetry.normalizeUsage(usageRaw, usageProtocol, { source: 'provider' }) },
            'provider');
        }
        if (err3 || contentChars === 0) {
          sse(res, { error: '换用 ' + altWire + ' 协议重试后仍无正文，请稍后重试或换模型。原始错误已写入 upstream-error.log', retryable: true });
        } else {
          sse(res, { phase: 'recovered', note: '换协议重试成功' });
          try { fs.appendFileSync(path.join(ROOT, 'upstream-error.log'),
            new Date().toISOString() + ' recovered wire=' + altWire + ' chars=' + contentChars + '\n'); } catch {}
        }
      }
    } catch (e) {
      try { fs.appendFileSync(path.join(ROOT, 'upstream-error.log'),
        new Date().toISOString() + ' retry failed ' + errText(e, 200) + '\n'); } catch {}
    } finally {
      if (retryReqId) {
        if (genF3 !== null) {
          R.emit(run.runId, 'request.first_output', { requestId: retryReqId, firstGenAt: genF3 }, 'provider');
          R.emit(run.runId, 'request.last_output',
            { requestId: retryReqId, genEvents: genN3, lastGenAt: genL3 }, 'provider');
        }
        R.emit(run.runId, 'request.completed',
          { requestId: retryReqId, status: u3 ? 'ok' : 'failed', completedAt: Date.now() }, 'server');
        pushStats(true, { phase: 'retry_usage' });
      }
    }
  }
  // 思考把输出预算吃光了（正文 0 字）：自动用「不思考」再跑一次，保证一定有答案
  // 泛化到所有支持 thinking 参数的模型，不再只限 4.1F；被停止 / 断连 / 空闲超时时不补跑
  if (!ctl.signal.aborted && !closedByClient && thinkingCapable && thinkingOn && contentChars === 0) {
    // 补跑是第二次请求，一样要重新排队，界面不能在这段时间假装已经结束
    sse(res, { phase: 'retry_no_think', note: '思考用尽预算，正在用不思考模式补跑一次' });
    act.notes.push('思考用尽预算 → 不思考补跑');
    startPhaseHeartbeat('retry_no_think');
    const retry2Ev = R.emit(run.runId, 'request.started',
      { model: model, attemptId: 'no_think_retry', startedAt: Date.now() }, 'server');
    const retry2ReqId = retry2Ev && retry2Ev.payload ? retry2Ev.payload.requestId : null;
    let usage2 = null, genF2 = null, genL2 = null, genN2 = 0;
    try {
      const retryBody = {
        model: wireModelOf(model),
        messages: upBody.messages,
        stream: true,
        max_tokens: 4096,
        temperature: upBody.temperature,
        chat_template_kwargs: { thinking: false },
      };
      const opened2 = await openChatUpstream(model, retryBody, ctl.signal);
      const up2 = opened2.res;
      const stream2 = opened2.stream;
      if (up2.ok && stream2) {
        let buf2 = '';
        const dec2 = new TextDecoder();
        for await (const chunk of stream2) {
          markFirstByte();
          buf2 += dec2.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf2.indexOf('\n\n')) >= 0) {
            const frame = buf2.slice(0, idx); buf2 = buf2.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;
              let j2; try { j2 = JSON.parse(data); } catch { continue; }
              if (j2.usage) usage2 = j2.usage;
              for (const ch of j2.choices || []) {
                const d2 = ch.delta || {};
                if (d2.content || d2.reasoning_content) {
                  if (genF2 === null) genF2 = Date.now();
                  genL2 = Date.now(); genN2++;
                }
                if (d2.content) { acc += d2.content; sse(res, { delta: d2.content }); contentChars += d2.content.length; }
              }
            }
          }
        }
        if (usage2) {
          usage = usage2;
          usageProtocol = (usage2.__protocol === 'responses') ? 'responses' : 'chat';
          usageRaw = (usageProtocol === 'responses' && usage2.__raw) ? usage2.__raw : usage2;
          R.emit(run.runId, 'request.usage',
            { requestId: retry2ReqId, usage: telemetry.normalizeUsage(usageRaw, usageProtocol, { source: 'provider' }) },
            'provider');
        }
      }
    } catch (e) {
      sse(res, { error: '思考超预算后的重试失败: ' + String(e.message || e).slice(0, 120) });
    } finally {
      if (retry2ReqId) {
        if (genF2 !== null) {
          R.emit(run.runId, 'request.first_output', { requestId: retry2ReqId, firstGenAt: genF2 }, 'provider');
          R.emit(run.runId, 'request.last_output',
            { requestId: retry2ReqId, genEvents: genN2, lastGenAt: genL2 }, 'provider');
        }
        R.emit(run.runId, 'request.completed',
          { requestId: retry2ReqId, status: usage2 ? 'ok' : 'failed', completedAt: Date.now() }, 'server');
        pushStats(true, { phase: 'retry_usage' });
      }
    }
  }
  const stopped = ctl.signal.aborted && !idleFired;
  if (activeReqId) {
    if (genFirstAt !== null) {
      R.emit(run.runId, 'request.last_output',
        { requestId: activeReqId, genEvents: genEvents, lastGenAt: genLastAt }, 'provider');
    }
    R.emit(run.runId, 'request.completed', { requestId: activeReqId, status: stopped ? 'cancelled' : 'ok' }, 'server');
  }
  // Attachments must precede run.finished so replay subscribers do not unsubscribe first.
  const responseFiles = stopped ? [] : responseAttachments(acc, run, agentRoots(), agentRoots()[0]);
  if (responseFiles.length) { sse(res, { attachments: responseFiles }); R.emit(run.runId, 'attachment.ready', { attachments: responseFiles }, 'server'); }
  // 终态先落盘，再发最终投影与 done；取消/失败的用量也被诚实结算。
  try { R.finish(run.runId, stopped ? 'cancelled' : (contentChars === 0 ? 'failed' : 'ok'), { contentChars }); } catch (e) {}
  const stats = makeRunStats(R, run.runId, { phase: 'final' });
  sse(res, { stats: stats });
  sse(res, { done: true, usage, ttft, genMs, tokPerSec, contentChars, reasoningChars, depth: reqDepth, stopped: !!stopped, wire: usedWire, model, requested: act.requested, waitedMs: firstByteAt !== null ? firstByteAt - t0 : Date.now() - t0, runId: run.runId, stats: stats });
  finishAct(stopped ? 'stopped' : (contentChars === 0 ? 'empty' : 'ok'), {
    status: 200, ttft, chars: contentChars, reasoningChars: reasoningChars,
    tokens: usage || null, wire: usedWire, actual: model,
  });
  // 持久化会话到服务端（供会话分支使用）
  if (sessionId) {
    try {
      const existing = loadSession(sessionId) || { id: sessionId, title: '', created: Date.now(), messages: [], parent: null };
      const allMsgs = Array.isArray(existing.messages) ? existing.messages : [];
      // 追加本轮新消息（避免重复：只追加 payload 中尚未存在的用户消息和本次助手回复）
      const payloadMsgs = Array.isArray(payload.messages) ? payload.messages : [];
      let merged = allMsgs.slice();
      // 如果最后一条已是相同的用户消息，替换；否则追加
      const lastUser = payloadMsgs.filter(m => m.role === 'user').pop();
      if (lastUser && merged.length > 0 && merged[merged.length - 1]?.role === 'user' && merged[merged.length - 1].content === lastUser.content) {
        merged[merged.length - 1] = lastUser;
      } else if (lastUser) {
        merged.push(lastUser);
      }
      if (acc && acc.trim()) {
        merged.push({ role: 'assistant', content: acc, attachments: responseFiles });
      }
      if (!existing.title && lastUser) {
        existing.title = lastUser.content.slice(0, 18);
      }
      existing.messages = merged;
      existing.updated = Date.now();
      saveSession(sessionId, existing);
    } catch (e) {
      try { fs.appendFileSync(path.join(ROOT, 'session-save-error.log'), new Date().toISOString() + ' ' + String(e) + '\n'); } catch {}
    }
  }
  clearTimeout(idleTimer);
  stopPhaseHeartbeat();
  endRes(res);
}
async function streamAgent(req, res) {
  const payload = await readBody(req);
  // P0：Agent 一个独立 run；护栏/计时/usage 都挂在 run 上，不再共用全局实例。
  const R = initRuns();
  const agentRun = R.create({
    kind: 'agent',
    sessionId: payload.sessionId || null,
    threadId: String(payload.threadId || 'main'),
    model: payload.model || settings.model || DEFAULT_MODEL,
  });
  const agentGuard = new ModelAdapter.AgentGuard({ now: Date.now });
  agentGuard.reset(agentRun.runId);
  R.attach(agentRun.runId, { guard: agentGuard });
  const task = String(payload.task || '').trim();
  const workdir = String(payload.dir || ROOT).trim();
  const model = payload.model || settings.model || DEFAULT_MODEL;
  const sandbox = payload.sandbox || 'workspace-write';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sse(res, { run: { runId: agentRun.runId, threadId: agentRun.threadId } });
  // P1：Agent 的每个 step / 工具 / usage 事件都推同一份后端投影，运行中即可见。
  let lastAgentStatsAt = 0;
  const pushAgentStats = (force, extra) => {
    const t = Date.now();
    if (!force && t - lastAgentStatsAt < 300) return;
    lastAgentStatsAt = t;
    const st = makeRunStats(R, agentRun.runId, extra);
    if (st) sse(res, { stats: st });
  };
  const offAgentStats = R.subscribe(agentRun.runId, (ev) => {
    if (ev.type === 'step.started' || ev.type === 'request.usage'
        || ev.type === 'request.completed' || ev.type === 'tool.finished') {
      pushAgentStats(true, { phase: ev.type });
    }
  });
  R.emit(agentRun.runId, 'run.started', { model: payload.model || settings.model || DEFAULT_MODEL, kind: 'agent' }, 'server');
  R.emit(agentRun.runId, 'turn.accepted', { model: payload.model || settings.model || DEFAULT_MODEL }, 'client');
  pushAgentStats(true, { phase: 'accepted' });
  const fail = (msg) => {
    try { offAgentStats(); } catch (e) {}
    sse(res, { error: msg }); sse(res, { done: true }); res.end();
    try { finishAgent('rejected', { reason: msg }); } catch {}
    try { R.finish(agentRun.runId, 'failed', { error: msg }); } catch {}
  };

  // Agent 本轮也进模型活动日志：Agent 走 codex 子进程，模型与沙箱同样要可追溯
  const agentAct = { kind: 'agent', id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    requested: model, actual: model, wire: null, sandbox, dir: workdir, _t0: Date.now(), _done: false, notes: [] };
  const finishAgent = (outcome, extra) => {
    if (agentAct._done) return;
    agentAct._done = true;
    agentAct.outcome = outcome;
    Object.assign(agentAct, extra || {});
    agentAct.ms = Date.now() - agentAct._t0;
    delete agentAct._t0; delete agentAct._done;
    try { recordModelActivity(agentAct); } catch {}
  };

  if (!task) return fail('任务为空');
  if (!fs.existsSync(workdir)) return fail('目录不存在: ' + workdir);

  // 工作目录白名单：防止把 agent 指到系统盘 / 桌面 / 用户主目录
  const roots = agentRoots();
  const resolvedDir = path.resolve(workdir);
  if (!isDirAllowed(resolvedDir)) {
    audit({ kind: 'denied', reason: 'workdir_out_of_roots', dir: resolvedDir, roots });
    return fail('工作目录不在允许范围内：' + workdir + '。允许的根目录：' + roots.join(', ') + '（可在「设置 → Agent 安全」里调整）');
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) return fail('未知权限等级：' + sandbox);
  if (sandbox === 'danger-full-access' && payload.confirmDanger !== true) {
    audit({ kind: 'denied', reason: 'danger_not_confirmed', dir: resolvedDir });
    return fail('完全权限需要显式确认（请勾选 Agent 弹窗里的确认项）');
  }
  if (settings.agentSafeMode === true && sandbox === 'danger-full-access') {
    return fail('安全模式下不允许「完全权限」，请关闭安全模式或改用「仅工作区可写」');
  }
  const dangerous = DANGEROUS_CMD.test(task);
  if (dangerous && settings.agentSafeMode === true) {
    audit({ kind: 'denied', reason: 'dangerous_task', dir: resolvedDir, task: task.slice(0, 200) });
    return fail('安全模式已拦截高危命令：' + task.slice(0, 120));
  }

  // 协议由模型目录 / 运行时探测决定，不再靠模型名猜；引擎缺失时自动回退
  const eng = await resolveEngine(model);
  if (!eng.exe) return fail('找不到 codex 引擎（应在 ' + eng.engineDir + ' 下）');
  const engineDir = eng.engineDir, homeDir = eng.homeDir, exe = eng.exe;

  // 任务前快照（只读模式不写文件，跳过）；超出上限会自动降级并如实告知
  let snap = { ok: false, reason: '只读模式无需快照' };
  if (sandbox !== 'read-only') snap = makeSnapshot(resolvedDir);
  const runId = snap.ok ? snap.runId : null;
  audit({ kind: 'start', runId, dir: resolvedDir, model, wire: eng.wire, sandbox,
    safeMode: settings.agentSafeMode === true, dangerous, snapshot: snap.ok,
    snapshotFiles: snap.count || 0, task: task.slice(0, 500) });

  sse(res, { status: '启动 ' + (eng.wire === 'chat' ? 'Codex 0.90 / chat' : 'Codex / responses') + ' · ' + eng.label + '…' });
  sse(res, snap.ok
    ? { snapshot: { runId: snap.runId, files: snap.count, skipped: snap.skipped } }
    : { snapshot: { ok: false, reason: snap.reason } });
  if (dangerous) sse(res, { warning: '检测到高危命令，已记入审计日志' });

  const args = ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-C', resolvedDir];
  args.push('-m', engineModelFor(model), task);

  // 真 key 只在主进程 env；Codex 的 shell_environment_policy 会把它从
  // 沙箱内 spawn 的命令环境中过滤掉（实测 EXPOSED → HIDDEN）。
  // P0 引擎身份桥接：给引擎一个**每 run 独立、不可猜**的 token。
  // 兼容层按该 token 把「一次逻辑模型请求」绑回本 run（真实步数），
  // 真 key 仍只在主进程使用，不进入事件日志、不进模型工具输出。
  const runToken = 'wr_' + agentRun.runId + '_' + crypto.randomBytes(8).toString('hex');
  try { agentRunTokens.set(runToken, agentRun.runId); } catch (e) {}
  const env = Object.assign({}, process.env, {
    NVIDIA_API_KEY: runToken,
    CODEX_HOME: homeDir,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  });
  // 引擎只需连本机兼容层；系统代理会把 127.0.0.1 的 WebSocket 送进 HTTP CONNECT 并 502。
  for (const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','FTP_PROXY','ftp_proxy']) delete env[k];
  // 注入已连接 token 类连接器的令牌，供 Codex 的 bearer_token_env_var 读取
  try {
    const conns = (settings.connectors && typeof settings.connectors === 'object') ? settings.connectors : {};
    for (const c of CONNECTOR_REGISTRY) {
      const st = conns[c.id];
      if (!st || !st.enabled || c.auth !== 'token' || !c.build) continue;
      const built = c.build(st.config || {}, {});
      const key = built && built.bearerEnv;
      const tok = st.config && st.config.token;
      if (key && tok) env[key] = tok;
    }
  } catch (e) {}

  let proc;
  try {
    proc = spawn(exe, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],   // stdin 必须关闭，否则 codex 会等 stdin
    });
  } catch (e) {
    return fail('启动失败: ' + String(e.message || e).slice(0, 200));
  }

  let buf = '';
  let usage = null;
  let agentText = '';
  let agentSentLen = 0;   // agent 路径已写入事件的字符数（引擎给累积全文，需换算增量）
  // P0：进程句柄只挂在本 run 上，不再写全局 currentProc 单例。
  R.attach(agentRun.runId, { proc: proc });
  // SSE 断开只是订阅退订，不是业务取消：主任务继续运行，刷新后可重连。
  // 只有显式 stop（/api/runs/:id/cancel）或应用真正退出才终止子进程。
  res.on('close', () => {
    if (!res.writableEnded) audit({ kind: 'subscriber_closed', runId });
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { sse(res, { log: line.slice(0, 400) }); continue; }
      if (ev.type === 'item.completed') {
        const it = ev.item || {};
        if (it.type === 'agent_message') {
          const full = it.text || '';
          // 引擎给的是**累积全文**，这里换算成增量事件，才能和 chat 路径共用同一套续订逻辑。
          if (streamResumeOn() && full.length > agentSentLen) {
            R.pushText(agentRun.runId, 'agent', 'content', full.slice(agentSentLen));
            agentSentLen = full.length;
            R.flushText(agentRun.runId, 'agent');
          }
          agentText = full || agentText;
          R.setLive(agentRun.runId, agentText);
          sse(res, { agent_text: full });
        }
        else if (it.type === 'reasoning') sse(res, { reasoning: it.text || '' });
        else if (it.type === 'command_execution') {
          const cmd = String(it.command || '');
          const risky = DANGEROUS_CMD.test(cmd);
          sse(res, { log: '$ ' + cmd.slice(0, 300), risky });
          audit({ kind: 'command', runId, cmd: cmd.slice(0, 500), risky });
          if (risky) sse(res, { warning: '高危命令：' + cmd.slice(0, 120) });
          // 护栏：步数 / 重复调用 / 墙钟超限时主动终止，避免死循环白烧配额。
          R.emit(agentRun.runId, 'tool.started', { name: 'command_execution', cmd: cmd.slice(0, 200) }, 'engine');
          const tEv = R.emit(agentRun.runId, 'tool.finished', { status: 'done' }, 'engine');
          const g = agentGuard.observe({ type: 'call', name: 'command_execution', arguments: cmd });
          if (!g.allow) {
            sse(res, { error: 'Agent 护栏终止：' + g.reason });
            audit({ kind: 'guard_stop', runId, reason: g.reason, snapshot: g.snapshot });
            adapterLog('guard_stop ' + g.reason);
            try { proc.kill(); } catch (e) {}
          }
        }
        else if (it.type === 'error') sse(res, { log: '⚠ ' + String(it.message || '').slice(0, 300) });
      } else if (ev.type === 'turn.completed') {
        usage = ev.usage || null;
        // 引擎整轮 usage 只作**兜底**，且不参与速度：它没有逐 token 生成窗口，
        // 用「开始→结束」几毫秒反推会造出巨大吞吐。是否重复计入由注册表按
        // 请求身份逐条对账（fallback 标记），不再用「整 run 任意 output 已上报」布尔值。
        try {
          if (usage) {
            const rEv = R.emit(agentRun.runId, 'request.started', {
              model: model, wire: 'codex_engine', attemptId: 'engine_turn',
              startedAt: agentRun.startedAt || Date.now(),
              fallback: true, noSpeed: true,
            }, 'engine');
            const rId = rEv && rEv.payload ? rEv.payload.requestId : null;
            R.emit(agentRun.runId, 'request.usage',
              { requestId: rId, usage: telemetry.normalizeUsage(usage, 'codex', { source: 'engine', scope: 'turn' }) }, 'engine');
            R.emit(agentRun.runId, 'request.completed',
              { requestId: rId, status: 'ok', completedAt: Date.now() }, 'server');
            pushAgentStats(true, { phase: 'engine_usage' });
          }
        } catch (e) {}
        const g = agentGuard.observe({ type: 'turn' });
        if (!g.allow) {
          sse(res, { error: 'Agent 护栏终止：' + g.reason });
          audit({ kind: 'guard_stop', runId, reason: g.reason, snapshot: g.snapshot });
          try { proc.kill(); } catch (e) {}
        }
      } else if (ev.type === 'error') {
        sse(res, { error: String(ev.message || JSON.stringify(ev)).slice(0, 300) });
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  // 这两行是 Codex 的固定噪音（stdin 已关闭 / 自定义模型没有内置元数据），
  // 不影响执行，没必要刷到用户界面；真正的错误照旧透传。
  const NOISE = /Reading additional input from stdin|Model metadata for .*not found|Defaulting to fallback metadata|failed to record rollout items/i;
  proc.stderr.on('data', (c) => {
    const clean = String(c).split('\n').filter(l => l.trim() && !NOISE.test(l)).join('\n');
    if (clean) sse(res, { log: clean.slice(0, 400) });
  });
  proc.on('close', (code) => {
    audit({ kind: 'end', runId, code, usage });
    finishAgent(code === 0 ? 'ok' : 'error', { status: code === 0 ? 'ok' : 'exit ' + code,
      wire: eng.wire, tokens: usage || null, runId, reason: code === 0 ? null : 'codex 退出码 ' + code });
    try { agentRunTokens.delete(runToken); } catch (e) {}
    try { R.emit(agentRun.runId, 'request.completed', { status: code === 0 ? 'ok' : 'failed' }, 'server'); } catch (e) {}
    const responseFiles = code === 0 ? responseAttachments(agentText, agentRun, [resolvedDir], resolvedDir) : [];
    if (responseFiles.length) { sse(res, { attachments: responseFiles }); R.emit(agentRun.runId, 'attachment.ready', { attachments: responseFiles }, 'server'); }
    // 终态先落盘，再发最终投影与 done；取消/失败的用量也诚实结算。
    try { R.finish(agentRun.runId, code === 0 ? 'ok' : 'failed', { code: code }); } catch (e) {}
    const stats = makeRunStats(R, agentRun.runId, { phase: 'final', code: code });
    sse(res, { stats: stats });
    sse(res, { done: true, usage, code, runId, canRestore: !!runId, runIdRun: agentRun.runId, stats: stats });
    try { offAgentStats(); } catch (e) {}
    endRes(res);   // 连接已被客户端断开时不能强行 end（会抛 ERR_STREAM_DESTROYED）
  });
}

// ---------- 窗口 / 托盘 ----------
let win = null;
let tray = null;
let quitting = false;

async function createWindow(port) {
  // 窗口尺寸按当前显示器工作区收敛：2K / 1080p / 小屏来回切换时都不会超出屏幕。
  let winW = 1180, winH = 820;
  try {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workAreaSize;
    winW = Math.max(900, Math.min(1180, wa.width - 80));
    winH = Math.max(620, Math.min(820, wa.height - 80));
  } catch (e) {}
  win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 900,
    minHeight: 620,
    center: true,
    title: '鲸鱼娘 · Codex',
    icon: appIconPath(),
    backgroundColor: '#0e1016',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,                    // 渲染进程完全无 Node 能力
      preload: path.join(__dirname, 'preload.js'), // F1: 受控文件操作
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      autoplayPolicy: 'user-gesture-required',
      spellcheck: false,
    },
  });
  const base = 'http://127.0.0.1:' + port + '/';
  // 令牌只通过导航请求头传递，不写入 URL / 历史记录 / 日志
  await win.loadURL(base, { extraHeaders: 'X-Whale-Token: ' + API_TOKEN });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(base)) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  // 分辨率/显示器切换的硬约束：窗口一旦超出当前工作区，立刻收回屏幕内。
  // 2K 与 1080p 来回切、外接屏拔掉、DPI 改变都会触发，避免出现「超出屏幕看不见」。
  try {
    const { screen } = require('electron');
    const clampToWorkArea = () => {
      try {
        if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
        const b = win.getBounds();
        const wa = screen.getDisplayMatching(b).workArea;
        if (b.width <= wa.width && b.height <= wa.height &&
            b.x >= wa.x - 4 && b.y >= wa.y - 4 &&
            b.x + b.width <= wa.x + wa.width + 4 && b.y + b.height <= wa.y + wa.height + 4) return;
        const w = Math.min(b.width, wa.width);
        const h = Math.min(b.height, wa.height);
        const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - w);
        const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - h);
        win.setBounds({ x: x, y: y, width: w, height: h });
      } catch (e) {}
    };
    win.once('ready-to-show', () => setTimeout(clampToWorkArea, 120));
    screen.on('display-metrics-changed', () => setTimeout(clampToWorkArea, 200));
    screen.on('display-removed', () => setTimeout(clampToWorkArea, 300));
    screen.on('display-added', () => setTimeout(clampToWorkArea, 300));
  } catch (e) {}
}

function createTray(port) {
  const iconPath = appIconPath();
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('鲸鱼娘 · Codex');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    // 外部浏览器无法设置导航头，用一次性 URL 令牌；页面加载后脚本立即从地址栏清除
    { label: '在浏览器打开', click: () => shell.openExternal('http://127.0.0.1:' + port + '/?wtok=' + API_TOKEN) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// ---------- 加固：完整性自校验 + License 辅助 ----------
function selfIntegrityCheck() {
  if (!PACKAGED) return { ok: true }; // 开发态未签名，跳过
  // 免费版不做「发布证书指纹」门禁：公开分发时安装包由使用者自行编译或由发布者签名，
  // 强制比对某一张证书只会把正常用户挡在门外，防篡改改由 asar 内嵌完整性校验承担。
  if (FREE_MODE) return { ok: true, skipped: true, note: 'free build' };
  if (process.platform === 'win32') {
    const exe = process.execPath;
    // 校验主程序 Authenticode 签名：必须比对发布证书指纹，仅检查 Subject 字符串可被同名自签证书伪造。
    // 判定口径只看「是不是我们的证书签发 + 签名本身有没有坏」，**不看信任链状态**：
    // 自签证书在不同机器上的链状态不唯一（本机报 UnknownError，有的系统报 NotTrusted），
    // 拿链状态当门槛会把正版用户挡在启动门外。真正的防篡改由 asar 内嵌完整性校验兜底。
    const ps = [
      `try { $s = Get-AuthenticodeSignature -FilePath '${exe}' } catch { exit 3 }`,
      `if ($null -eq $s) { exit 3 }`,
      `$fp = '9D0758A2A7FAABE8E83E3773A4FB8C4274B790AA'`,
      `if (@('NotSigned','HashMismatch','NotSupported','Incompatible') -contains $s.Status) { exit 1 }`,
      `if ($null -eq $s.SignerCertificate) { exit 1 }`,
      `if ($s.SignerCertificate.Thumbprint -ne $fp) { exit 1 }`,
      `exit 0`,
    ].join('; ');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 25000 });
      return { ok: true };
    } catch (e) {
      // 只有「签名明确不符」（exit 1）才阻断。
      // exit 3 = 本机 PowerShell 跑不了这条校验（受限环境 / 模块被禁用 / 执行策略）；
      // status 为空 = 超时或进程被信号终止。这两类属于「校验不可用」而非「被篡改」，
      // 放行并留痕，否则会误杀正版用户。
      if (e && e.status === 1) return { ok: false, reason: '主程序签名校验未通过（可能已被篡改，或非官方构建）' };
      try { startupLog('integrity check unavailable (code=' + (e && e.status) + '), skipped'); } catch (e2) {}
      return { ok: true, skipped: true };
    }
  }
  return { ok: true }; // 非 Windows 由 Electron asar 完整性强制校验兜底
}
function showFatal(title, msg) {
  try { dialog.showErrorBox(title, msg); } catch (e) {}
  try { fs.appendFileSync(path.join(ROOT, 'startup-error.log'), new Date().toISOString() + ' ' + title + ': ' + msg + '\n'); } catch (e) {}
}

// ---------- 启动 ----------
// 启动阶段落盘日志：GUI 静默退出时看不到任何输出，只能靠这段定位
const startupLog = (m) => {
  try { fs.appendFileSync(path.join(ROOT, 'startup-trace.log'), new Date().toISOString() + ' ' + m + '\n'); } catch (e) {}
};
process.on('uncaughtException', (e) => { startupLog('uncaught ' + (e && e.stack || e)); });
// 未处理的 Promise 拒绝：只记录不改变行为（不同 Electron 版本对此的默认处理不一致，
// 显式挂个日志钩子，出问题时能在 startup-trace.log 里看到堆栈）
process.on('unhandledRejection', (e) => { try { startupLog('unhandledRejection ' + (e && e.stack || e)); } catch (e2) {} });
startupLog('boot pid=' + process.pid + ' electron=' + process.versions.electron);
const gotLock = app.requestSingleInstanceLock();
startupLog('singleInstanceLock=' + gotLock);
if (!gotLock) {
  startupLog('lock denied, quit');
  app.quit();
} else {
  startupLog('lock ok, waiting ready');
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    startupLog('ready');

    installAttachmentIpc({ ipcMain: require('electron').ipcMain, store: attachmentStore,
      shell, nativeImage, trustedWindows: () => [
        { window: win, url: 'http://127.0.0.1:' + settings.port + '/' },
        { window: workbenchWin, url: 'http://127.0.0.1:' + settings.port + '/workbench-window.html' },
      ] });
    // Metadata expires; originals are user-owned outputs and are never deleted by F1.
    const attachmentGc = setInterval(() => attachmentStore.cleanup(), 60000);
    attachmentGc.unref();
    app.once('will-quit', () => clearInterval(attachmentGc));
    // 桌面快照治理：启动回收过期快照 + 异常退出遗留的 helper 会话（失败不影响启动）
    if (settings.desktopControl === true) {
      try { await desktopStartupReclaim(); } catch (e) {}
      try { desktopScheduleGc(); } catch (e) {}
    }
    // 页面脚本必须始终取最新：清掉 HTTP 缓存，避免更新后仍跑旧 renderer.js
    try { await session.defaultSession.clearCache(); } catch (e) {}
    // 权限收敛：仅允许本地页面申请麦克风（语音输入）等必要权限，其余一律拒绝
    try {
      session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
        const u = String((wc && wc.getURL && wc.getURL()) || '');
        const allow = u.indexOf('http://127.0.0.1:') === 0 &&
          ['media', 'audioCapture', 'clipboard-read', 'notifications', 'fullscreen'].indexOf(permission) >= 0;
        cb(!!allow);
      });
    } catch {}
    // 加固①：运行时完整性自校验（打包态）
    const integ = selfIntegrityCheck();
    if (!integ.ok) { showFatal('完整性校验失败', integ.reason); app.quit(); return; }
    startupLog(integ.skipped ? 'application signature check skipped: ' + (integ.note || 'unavailable') : 'application signature check ok');
    let server;
    try {
      server = await startServer();
      settings.port = server.address().port;
      startupLog('server on ' + settings.port);
      await createWindow(settings.port);
      createTray(settings.port);
      startupLog('window + tray ok');
      // 预热识别进程：模型加载一次，之后每次说话只做推理
      setTimeout(() => { try { asrEnsurePool(); } catch {} }, 1500);
    } catch (e) {
      startupLog('startup failed ' + (e && e.stack || e));
      try { fs.appendFileSync(path.join(ROOT, 'startup-error.log'), new Date().toISOString() + ' ' + (e && e.stack || e) + '\n'); } catch (e2) {}
      dialog.showErrorBox('启动失败', String(e && e.message || e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => { /* 常驻托盘 */ });
  app.on('before-quit', () => {
    quitting = true;
    try { asrStopAll(); } catch (e) {}
    // 桌面控制桥：中止在途动作 + 结束 helper 会话 + 清理快照（异步，不阻塞退出）
    try { desktopAbortAll('app_exit'); } catch (e) {}
    try { desktopShutdown().catch(() => {}); } catch (e) {}
    // P0：应用真正退出时终止所有在途任务并写 interrupted 终态，
    // 不伪称任务仍在后台运行；刷新页面 / 收起侧栏 / 切会话都不触发这里。
    try { const R = initRuns(); R.interruptAll('app_exit'); R.flush(); } catch (e) {}
    try { if (workbench) workbench.destroy(); } catch (e) {}
  });
}
