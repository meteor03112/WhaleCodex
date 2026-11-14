'use strict';
// 高精度语音模型按需下载（用户显式触发，绝不自动联网）
// 信任链：内置 Ed25519 公钥验 models.json.sig 的离线签名 → 清单内 sha256 → 模型文件落盘复验。
// 模型清单签名密钥与分发 GPG 私钥分离，服务器只存公开文件，泄露也拿不到签发能力。
// 下载走主进程 Node，不经过渲染进程，因此无需放宽 CSP 的 connect-src。
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_HOST = 'maplewind.xyz';
const SIGNING_ALG = 'ed25519';
const BASE_PATH = '/whalecodex/';
const MANIFEST_NAME = 'models.json';
const SIG_NAME = 'models.json.sig';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIG_BYTES = 4096;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const FILE_RE = /^ggml-[a-z0-9][a-z0-9._-]{0,63}\.bin$/;

// 域名白名单：只接受公网 DNS 名称，拒绝 IP 字面量 / 回环 / 内网保留后缀，
// 防止把本地服务当作 SSRF 跳板。测试时通过注入 transport 绕过网络层。
function normalizeHost(h) {
  let s = String(h || '').trim().toLowerCase();
  // 只接受裸域名；带协议 / 路径 / 用户名 / 端口的输入一律拒绝，避免静默改写
  if (/[\\/@?#:]/.test(s) || s.indexOf('://') >= 0) throw new Error('模型源只填域名，不要带协议或路径');
  if (!s || s.length > 253 || !/^[a-z0-9.-]+$/.test(s)) throw new Error('模型源域名不合法');
  if (s.indexOf('..') >= 0 || s[0] === '.' || s[s.length - 1] === '-' || s.indexOf('.') < 1) throw new Error('模型源域名不合法');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s) || s.indexOf(':') >= 0) throw new Error('模型源不接受 IP 地址');
  if (s === 'localhost' || /(^|\.)(local|internal|localhost|test|example|invalid|onion)$/.test(s)) throw new Error('模型源必须为公网域名');
  for (const part of s.split('.')) {
    if (!part || part.length > 63 || part[0] === '-' || part[part.length - 1] === '-') throw new Error('模型源域名不合法');
  }
  return s;
}

function effectiveHost(h) {
  return h ? normalizeHost(h) : DEFAULT_HOST;
}

function assertUrl(urlStr, expectedHost) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') throw new Error('模型下载仅允许 HTTPS');
  if (u.hostname.toLowerCase() !== expectedHost) throw new Error('重定向到非模型源域名，已拒绝');
  return u;
}

function defaultGet(urlStr, opts, expectedHost) {
  const u = assertUrl(urlStr, expectedHost);
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: opts.headers || {}, timeout: TIMEOUT_MS }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    req.on('timeout', () => req.destroy(new Error('模型源连接超时')));
    req.on('error', reject);
  });
}

async function request(urlStr, opts, expectedHost, transport, redirects) {
  const n = redirects || 0;
  if (n > MAX_REDIRECTS) throw new Error('重定向次数过多');
  const r = transport && typeof transport.get === 'function'
    ? await transport.get(urlStr, opts)
    : await defaultGet(urlStr, opts, expectedHost);
  if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
    const next = new URL(r.headers.location, urlStr).toString();
    assertUrl(next, expectedHost);
    if (r.stream && r.stream.destroy) r.stream.destroy();
    return request(next, opts, expectedHost, transport, n + 1);
  }
  return r;
}

async function readLimited(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on('data', (c) => {
      n += c.length;
      if (n > maxBytes) { stream.destroy(); reject(new Error('响应体超过上限')); return; }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function verifyManifestSignature(raw, sigBuf, appDir) {
  const pem = fs.readFileSync(path.join(appDir, 'vendor', 'models-signing-public.pem'), 'utf8');
  const pub = crypto.createPublicKey(pem);
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error('内置模型签名公钥类型异常');
  if (!Buffer.isBuffer(sigBuf) || sigBuf.length !== 64) throw new Error('模型清单签名长度异常');
  if (!crypto.verify(null, raw, pub, sigBuf)) throw new Error('模型清单签名无效或已被篡改');
  return true;
}

function validateManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.models)) throw new Error('模型清单格式错误');
  const seen = Object.create(null);
  const models = m.models.map((e) => {
    if (!e || typeof e !== 'object') throw new Error('模型条目格式错误');
    const key = String(e.key || '');
    const file = String(e.file || '');
    const sha256 = String(e.sha256 || '').toLowerCase();
    const size = Number(e.size);
    if (!KEY_RE.test(key) || !FILE_RE.test(file)) throw new Error('模型清单含非法文件名');
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('模型清单缺少合法 sha256');
    if (!Number.isSafeInteger(size) || size <= 0 || size > 4 * 1024 * 1024 * 1024) throw new Error('模型清单 size 不合法');
    if (seen[key] || seen[file]) throw new Error('模型清单存在重复条目');
    seen[key] = 1; seen[file] = 1;
    return { key, file, sha256, size, label: String(e.label || key).slice(0, 64) };
  });
  return { version: Number(m.version) || 1, models };
}

async function fetchManifest(opts) {
  const o = opts || {};
  const host = effectiveHost(o.host);
  const appDir = o.appDir;
  const transport = o.transport || null;
  const base = 'https://' + host + BASE_PATH;
  const jr = await request(base + MANIFEST_NAME, { headers: { accept: 'application/json' } }, host, transport, 0);
  if (jr.status !== 200) throw new Error('模型清单 HTTP ' + jr.status);
  const raw = await readLimited(jr.stream, MAX_MANIFEST_BYTES);
  const sr = await request(base + SIG_NAME, { headers: { accept: 'application/octet-stream' } }, host, transport, 0);
  if (sr.status !== 200) throw new Error('模型清单签名 HTTP ' + sr.status);
  const sig = await readLimited(sr.stream, MAX_SIG_BYTES);
  verifyManifestSignature(raw, sig, appDir);
  return Object.assign({ host }, validateManifest(JSON.parse(raw.toString('utf8'))));
}

function safeEntry(manifest, key) {
  const e = (manifest && manifest.models || []).find((x) => x.key === key);
  if (!e) throw new Error('清单中没有该模型');
  return e;
}

async function downloadModel(opts) {
  const o = opts || {};
  const host = effectiveHost(o.host);
  const appDir = o.appDir;
  const destDir = o.destDir;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : function () {};
  const entry = safeEntry(o.manifest, o.key);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, entry.file);
  const part = dest + '.part';
  if (fs.existsSync(dest)) return { file: entry.file, size: entry.size, cached: true, sha256: entry.sha256 };

  let offset = 0;
  if (fs.existsSync(part)) {
    const st = fs.statSync(part);
    offset = st.size < entry.size ? st.size : 0;
    if (offset >= entry.size) { try { fs.unlinkSync(part); } catch (e) {} offset = 0; }
  }
  const headers = {};
  if (offset > 0) headers.range = 'bytes=' + offset + '-';
  const r = await request('https://' + host + BASE_PATH + encodeURIComponent(entry.file),
    { headers }, host, o.transport || null, 0);
  if (r.status !== 200 && r.status !== 206) throw new Error('模型下载 HTTP ' + r.status);
  if (offset > 0 && r.status !== 206) {
    // 源站不支持 Range，从头重下
    try { fs.unlinkSync(part); } catch (e) {}
    offset = 0;
  }
  const ws = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
  let got = offset;
  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      try { r.stream.destroy(); } catch (x) {}
      try { ws.destroy(); } catch (x) {}
      reject(e);
    };
    r.stream.on('data', (c) => {
      got += c.length;
      if (got > entry.size) { fail(new Error('下载数据超过清单声明大小')); return; }
      if (!ws.write(c)) { r.stream.pause(); ws.once('drain', () => r.stream.resume()); }
      try { onProgress({ key: entry.key, loaded: got, total: entry.size }); } catch (x) {}
    });
    r.stream.on('end', () => ws.end());
    r.stream.on('error', fail);
    ws.on('finish', resolve);
    ws.on('error', fail);
  });
  if (got !== entry.size) throw new Error('下载不完整（' + got + '/' + entry.size + '）');
  const actual = await sha256File(part);
  if (actual !== entry.sha256) {
    try { fs.unlinkSync(part); } catch (e) {}
    throw new Error('模型 sha256 校验失败，已丢弃');
  }
  try { fs.unlinkSync(dest); } catch (e) {}
  fs.renameSync(part, dest);
  return { file: entry.file, size: entry.size, sha256: actual, cached: false };
}

function installedModels(destDir, manifest) {
  const out = [];
  for (const e of (manifest && manifest.models || [])) {
    const p = path.join(destDir, e.file);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      out.push({ key: e.key, file: e.file, size: st.size, complete: st.size === e.size });
    }
  }
  return out;
}

module.exports = {
  DEFAULT_HOST,
  SIGNING_ALG,
  normalizeHost,
  effectiveHost,
  fetchManifest,
  downloadModel,
  verifyManifestSignature,
  installedModels,
  sha256File,
  safeEntry,
};
