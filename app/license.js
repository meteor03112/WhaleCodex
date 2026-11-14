// license.js — 离线授权（RSA 验签 + 机器指纹）
// 公钥内嵌于此，仅用于验签；私钥由构建方安全保管，不随包发布。
// 授权串格式： <base64url(payload)>.<base64url(RSA-SHA256签名)>
//   payload = { v:1, mid:机器指纹(可空=不绑机), exp:过期时间戳ms(可空), email?, note? }
'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// —— 内嵌公钥（与 whale_license_private.pem 配对）——
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqqbJB8Q/psjbw01FoI4T
1s2EF+N1IEpE8odj3ntx/+euFVGSEVFekME4RYzEZ7dvbKuhBoboI0uYgsrq8R6A
StQr2lLMXEv/gjZQ91P8opW2aNDTc9Eoky52U445LZ9KcFFlH78MlWEcHFPXgYUW
25qeKptJLfQS+RWJ1714siBOCkLGWjTn+Nh+6VRD+SmB+ScDjGS3RKI9v4TDfEIc
EQALyUAXl1CYBJSnUU6Y0knWQIbVfz9iBtmabXtTsuwo+9eiCDMX3BBrFpksSIxX
Ot9zs2GTRdO8QfLpFzNEjnbwNw138xsGt++6NGtzdfRzYB/oNE4lJSU4FYne+4VR
PwIDAQAB
-----END PUBLIC KEY-----`;

let LICENSE_FILE = null;
function init(rootDir) { LICENSE_FILE = path.join(rootDir, 'license.json'); }
function setLicenseFile(p) { LICENSE_FILE = p; }

// 稳定的机器指纹：Windows 取 MachineGuid；Linux/macOS 取 /etc/machine-id；兜底取 主机名+用户 哈希
function machineId() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F\-]+)/.exec(out);
      if (m) return 'win-' + m[1].trim().toLowerCase();
    } else {
      // Linux/macOS：优先稳定的系统级机器标识（容器/虚拟机多为空，则退回兜底）
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = fs.readFileSync(f, 'utf8').trim();
          if (id) return 'lx-' + id.toLowerCase();
        } catch (e) {}
      }
    }
  } catch (e) {}
  const seed = os.hostname() + '|' + (os.userInfo ? os.userInfo().username : '') + '|' + process.platform;
  return 'fb-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64udec(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); return Buffer.from(s, 'base64'); }

function verifyLicense(licStr) {
  try {
    if (!licStr || typeof licStr !== 'string') return { ok: false, reason: '缺少授权' };
    const parts = licStr.split('.');
    if (parts.length !== 2) return { ok: false, reason: '授权格式错误' };
    const payloadBuf = b64udec(parts[0]);
    const sig = b64udec(parts[1]);
    const ok = crypto.verify('RSA-SHA256', payloadBuf, PUBLIC_KEY_PEM, sig);
    if (!ok) return { ok: false, reason: '授权签名无效' };
    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return { ok: false, reason: '授权已过期' };
    if (payload.mid) {
      const cur = machineId();
      if (payload.mid !== cur) return { ok: false, reason: '本机指纹不匹配（需在授权机器上激活）' };
    }
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: '授权校验异常：' + (e && e.message || e) };
  }
}

function readStored() {
  if (!LICENSE_FILE) return null;
  try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); } catch { return null; }
}
function writeStored(licStr) {
  if (!LICENSE_FILE) return false;
  try { fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true }); fs.writeFileSync(LICENSE_FILE, JSON.stringify({ key: licStr, at: Date.now() })); return true; } catch { return false; }
}
function isActivated() {
  const st = readStored();
  if (!st || !st.key) return false;
  return verifyLicense(st.key).ok;
}
function currentMachineId() { return machineId(); }

module.exports = {
  init, setLicenseFile, verifyLicense, readStored, writeStored,
  isActivated, currentMachineId, machineId, PUBLIC_KEY_PEM,
};
