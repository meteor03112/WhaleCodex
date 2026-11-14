'use strict';

// Main-process-only authority: never expose register or arbitrary paths over IPC.
// This module has no Electron dependency and NEVER deletes or modifies user files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE_EXTENSIONS = new Set([
  '.txt', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.tsv', '.json',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.zip',
]);
const ACTIONS = new Set(['show', 'open', 'drag']);
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new StoreError(code, message); }
function resultError(error) {
  if (error instanceof StoreError) return { ok: false, error: error.code, message: error.message };
  const code = error && error.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'NOT_FOUND', message: 'File or parent directory does not exist.' };
  if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'ACCESS_DENIED', message: 'File or directory is not readable.' };
  return { ok: false, error: 'IO_ERROR', message: 'Unable to validate the attachment file.' };
}
function nonempty(value, code, label) {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${label} must be a nonempty string.`);
}
function comparable(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function samePath(a, b) { return comparable(a) === comparable(b); }
function contains(root, file) {
  const relative = path.relative(comparable(root), comparable(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function localPath(value) {
  nonempty(value, 'INVALID_PATH', 'Path');
  if (value.includes('\0')) fail('INVALID_PATH', 'NUL is not allowed in paths.');
  // Reject UNC, device/extended namespace paths, including forward-slash forms.
  if (/^[\\/]{2}/.test(value)) fail('UNC_NOT_ALLOWED', 'UNC and device namespace paths are not allowed.');
  const withoutDrive = /^[a-z]:[\\/]/i.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(':')) fail('ADS_NOT_ALLOWED', 'Alternate data streams and colon-bearing paths are not allowed.');
  if (!path.isAbsolute(value) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) fail('INVALID_PATH', 'An absolute local path with an explicit drive on Windows is required.');
  const components = withoutDrive.split(/[\\/]/);
  if (components.includes('..')) fail('INVALID_PATH', 'Parent traversal components are not allowed.');
  if (process.platform === 'win32' && components.some(part => part && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    fail('INVALID_PATH', 'Ambiguous or reserved Windows path components are not allowed.');
  }
  return path.resolve(value);
}
function checkedPath(value, directory) {
  const absolute = localPath(value);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let stat = fs.lstatSync(current, { bigint: true });
  if (stat.isSymbolicLink()) fail('LINK_NOT_ALLOWED', 'Symbolic links and junctions are not allowed.');
  if (!stat.isDirectory()) fail('NOT_DIRECTORY', 'A parent path is not a directory.');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail('LINK_NOT_ALLOWED', 'Symbolic links and junctions are not allowed in any path component.');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('NOT_DIRECTORY', 'A parent path is not a directory.');
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    fail(directory ? 'NOT_DIRECTORY' : 'NOT_REGULAR_FILE', directory ? 'Allowed roots must be directories.' : 'Attachments must be ordinary files, not directories or devices.');
  }
  const real = fs.realpathSync.native(absolute);
  // lstat above rejects links/junctions in every component. realpath may still
  // canonicalize a harmless Windows 8.3 alias, so retain the canonical path rather
  // than misclassifying it as a reparse point. Reparse points are already rejected.
  return { filePath: localPath(real), stat };
}
function identity(stat) { return [stat.dev, stat.ino, stat.birthtimeNs].join(':'); }
function fingerprint(stat) { return [identity(stat), stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':'); }
function snapshot(filePath, maxBytes) {
  const before = checkedPath(filePath, false);
  if (before.stat.size > BigInt(maxBytes)) fail('FILE_TOO_LARGE', `Attachment exceeds the ${maxBytes} byte limit.`);
  let fd;
  try {
    fd = fs.openSync(before.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || fingerprint(opened) !== fingerprint(before.stat)) fail('FILE_CHANGED', 'File changed while it was being opened.');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) fail('FILE_TOO_LARGE', `Attachment exceeds the ${maxBytes} byte limit.`);
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = checkedPath(filePath, false);
    if (fingerprint(after) !== fingerprint(opened) || fingerprint(current.stat) !== fingerprint(opened) || BigInt(total) !== opened.size) {
      fail('FILE_CHANGED', 'File changed while its contents were being checked.');
    }
    return { filePath: before.filePath, fingerprint: fingerprint(opened), size: total, sha256: hash.digest('hex') };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class AttachmentStore {
  #records = new Map();
  #leases = new Map();
  #clock;
  #ttlMs;
  #maxFileSize;
  #maxRecords;

  constructor({ clock = Date.now, ttlMs = 30 * 60 * 1000, maxFileSize = DEFAULT_MAX_BYTES, maxRecords = 500 } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function returning epoch milliseconds');
    for (const [name, value] of Object.entries({ ttlMs, maxFileSize, maxRecords })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (maxRecords > 500) throw new RangeError('maxRecords must not exceed 500');
    this.#clock = clock;
    this.#ttlMs = ttlMs;
    this.#maxFileSize = maxFileSize;
    this.#maxRecords = maxRecords;
  }

  get size() { return this.#records.size; }
  get leaseCount() { return this.#leases.size; }
  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.#ttlMs)) fail('INVALID_CLOCK', 'clock must return valid epoch milliseconds.');
    return now;
  }
  #revoke(id) {
    const record = this.#records.get(id);
    if (!record) return false;
    for (const leaseId of record.leases) this.#leases.delete(leaseId);
    this.#records.delete(id);
    return true;
  }
  #cleanup(now) {
    let removed = 0;
    for (const [id, record] of this.#records) {
      if (record.attachment.expiresAt <= now && record.leases.size === 0) {
        this.#revoke(id);
        removed++;
      }
    }
    return removed;
  }

  register({ filePath, allowedRoots, sessionId, sourceId, mime, expectedSha256 } = {}) {
    try {
      nonempty(sessionId, 'INVALID_SESSION', 'sessionId');
      nonempty(sourceId, 'INVALID_SOURCE', 'sourceId');
      if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) fail('ROOTS_REQUIRED', 'Explicit nonempty allowedRoots are required.');
      if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(expectedSha256))) fail('INVALID_SHA256', 'expectedSha256 must be a 64-character hexadecimal SHA-256.');
      if (mime !== undefined && (typeof mime !== 'string' || !mime.trim() || /[\r\n\0]/.test(mime))) fail('INVALID_MIME', 'mime must be a nonempty single-line string.');
      const now = this.#now();
      this.#cleanup(now);
      if (this.#records.size >= this.#maxRecords) fail('CAPACITY_EXCEEDED', 'Attachment record capacity is exhausted.');
      const roots = allowedRoots.map(root => checkedPath(root, true));
      const candidateChecked = checkedPath(filePath, false);
      const candidate = candidateChecked.filePath;
      const root = roots.find(item => contains(item.filePath, candidate));
      if (!root) fail('OUTSIDE_ALLOWED_ROOTS', 'Attachment is outside the explicitly allowed roots.');
      const file = snapshot(candidate, this.#maxFileSize);
      if (expectedSha256 && file.sha256 !== expectedSha256.toLowerCase()) fail('SHA256_MISMATCH', 'Attachment does not match expectedSha256.');
      const checkedRoot = checkedPath(root.filePath, true);
      if (identity(checkedRoot.stat) !== identity(root.stat)) fail('FILE_CHANGED', 'Allowed root changed during validation.');
      let attachmentId;
      do { attachmentId = crypto.randomBytes(24).toString('base64url'); } while (this.#records.has(attachmentId));
      const attachment = Object.freeze({
        attachmentId, sessionId, sourceId, name: path.basename(file.filePath),
        mime: mime || 'application/octet-stream', size: file.size, sha256: file.sha256,
        expiresAt: now + this.#ttlMs,
      });
      this.#records.set(attachmentId, { attachment, filePath: file.filePath, fingerprint: file.fingerprint, rootPath: root.filePath, rootIdentity: identity(root.stat), leases: new Set() });
      return { ok: true, attachment: { ...attachment } };
    } catch (error) { return resultError(error); }
  }

  resolve(id, sessionId, { action = 'show' } = {}) {
    try {
      nonempty(sessionId, 'INVALID_SESSION', 'sessionId');
      nonempty(id, 'INVALID_ID', 'attachmentId');
      if (!ACTIONS.has(action)) fail('INVALID_ACTION', 'action must be show, open, or drag.');
      const record = this.#records.get(id);
      if (!record) fail('NOT_FOUND', 'Attachment is unknown or has been revoked.');
      if (record.attachment.sessionId !== sessionId) fail('SESSION_MISMATCH', 'Attachment belongs to another session.');
      const now = this.#now();
      if (record.attachment.expiresAt <= now) {
        if (record.leases.size === 0) this.#revoke(id);
        fail('EXPIRED', 'Attachment has expired; an existing lease does not authorize new operations.');
      }
      // show means reveal THIS regular file in its parent, never open a directory.
      // MIME is descriptive only; it cannot grant execution privileges.
      if (action !== 'show' && !SAFE_EXTENSIONS.has(path.extname(record.filePath).toLowerCase())) {
        fail('UNSAFE_FILE_TYPE', 'This file type cannot be opened or dragged; reveal it in its folder instead.');
      }
      try {
        const root = checkedPath(record.rootPath, true);
        if (identity(root.stat) !== record.rootIdentity || !contains(root.filePath, record.filePath)) fail('FILE_CHANGED', 'Allowed root was replaced.');
        const file = snapshot(record.filePath, this.#maxFileSize);
        if (file.fingerprint !== record.fingerprint || file.sha256 !== record.attachment.sha256) fail('FILE_CHANGED', 'Attachment was replaced or modified after registration.');
      } catch (error) {
        this.#revoke(id);
        throw error;
      }
      return { ok: true, filePath: record.filePath, attachment: { ...record.attachment } };
    } catch (error) { return resultError(error); }
  }

  // Hold metadata for an already-authorized long operation. A lease does not
  // extend TTL, preserve authorization after endSession, or lock the user file.
  lease(id, sessionId, action = 'show') {
    const resolved = this.resolve(id, sessionId, { action });
    if (!resolved.ok) return resolved;
    if (this.#leases.size >= this.#maxRecords * 4) return { ok: false, error: 'LEASE_CAPACITY_EXCEEDED', message: 'Too many active attachment leases.' };
    let leaseId;
    do { leaseId = crypto.randomBytes(24).toString('base64url'); } while (this.#leases.has(leaseId));
    this.#leases.set(leaseId, id);
    this.#records.get(id).leases.add(leaseId);
    return { ...resolved, leaseId };
  }

  release(leaseId) {
    const id = this.#leases.get(leaseId);
    if (!id) return { ok: true, released: false };
    this.#leases.delete(leaseId);
    const record = this.#records.get(id);
    if (record) record.leases.delete(leaseId);
    try {
      this.#cleanup(this.#now());
      return { ok: true, released: true };
    } catch (error) { return resultError(error); }
  }

  cleanup() {
    try { return { ok: true, removed: this.#cleanup(this.#now()) }; }
    catch (error) { return resultError(error); }
  }

  endSession(sessionId) {
    try {
      nonempty(sessionId, 'INVALID_SESSION', 'sessionId');
      let revoked = 0;
      for (const [id, record] of this.#records) {
        if (record.attachment.sessionId === sessionId) { this.#revoke(id); revoked++; }
      }
      return { ok: true, revoked };
    } catch (error) { return resultError(error); }
  }
}

// Path-returning consumers must resolve immediately before Electron actions.
// No portable path API can prevent a hostile writer racing AFTER resolve returns;
// leases only protect metadata, not filesystem contents or OS handles.
module.exports = { AttachmentStore };
