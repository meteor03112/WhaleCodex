'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AttachmentStore } = require(path.resolve(__dirname, '../app/attachment-store.js'));

function fixture(t, options = {}) {
  const tempParent = fs.realpathSync.native(os.tmpdir());
  const base = fs.mkdtempSync(path.join(tempParent, 'attachment-store-test-'));
  const root = path.join(base, 'allowed 中文 空格');
  fs.mkdirSync(root);
  const file = path.join(root, '报告 测试.txt');
  fs.writeFileSync(file, 'hello 附件\n');
  let now = 10000;
  const store = new AttachmentStore({ clock: () => now, ...options });
  t.after(() => {
    // Only remove the exact test-owned directory allocated by mkdtemp, never a
    // user-selected attachment/root. Validate its resolved location first.
    assert.equal(path.dirname(path.resolve(base)), tempParent);
    assert.ok(path.basename(base).startsWith('attachment-store-test-'));
    assert.equal(fs.lstatSync(base).isSymbolicLink(), false);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    base, root, file, store, tick: value => { now += value; },
    register: (extra = {}) => store.register({ filePath: file, allowedRoots: [root], sessionId: 'session-1', sourceId: 'source-1', mime: 'text/plain', ...extra }),
  };
}
function error(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, code);
  assert.equal(typeof result.message, 'string');
}
function attachment(f, extra) {
  const result = f.register(extra);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.attachment;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

test('exports a plain Node class; Chinese/spaces round trip without path disclosure', t => {
  const f = fixture(t);
  const a = attachment(f);
  assert.deepEqual(Object.keys(a).sort(), ['attachmentId', 'sessionId', 'sourceId', 'name', 'mime', 'size', 'sha256', 'expiresAt'].sort());
  assert.equal(a.name, '报告 测试.txt');
  assert.equal(a.sha256, digest(f.file));
  assert.equal(a.size, fs.statSync(f.file).size);
  assert.equal(a.expiresAt, 10000 + 30 * 60 * 1000);
  assert.equal(a.filePath, undefined);
  for (const action of ['open', 'show', 'drag']) {
    const result = f.store.resolve(a.attachmentId, 'session-1', { action });
    assert.equal(result.ok, true);
    assert.equal(result.filePath, f.file);
  }
});

test('requires explicit nonempty roots, session and source', t => {
  const f = fixture(t);
  for (const allowedRoots of [undefined, [], null, '']) error(f.register({ allowedRoots }), 'ROOTS_REQUIRED');
  for (const sessionId of [undefined, null, '', '  ']) error(f.register({ sessionId }), 'INVALID_SESSION');
  for (const sourceId of [undefined, null, '', '  ']) error(f.register({ sourceId }), 'INVALID_SOURCE');
  error(f.register({ allowedRoots: [''] }), 'INVALID_PATH');
  assert.equal(f.store.size, 0);
});

test('rejects sibling-prefix and traversed paths outside roots', t => {
  const f = fixture(t);
  const sibling = `${f.root}-not-allowed`;
  fs.mkdirSync(sibling);
  const outside = path.join(sibling, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  error(f.register({ filePath: outside }), 'OUTSIDE_ALLOWED_ROOTS');
  error(f.register({ filePath: `${f.root}${path.sep}..${path.sep}outside.txt` }), 'INVALID_PATH');
  error(f.register({ filePath: 'relative.txt' }), 'INVALID_PATH');
  if (process.platform === 'win32') error(f.register({ filePath: '\\root-relative.txt' }), 'INVALID_PATH');
});

test('rejects Windows UNC, extended/device namespaces and ADS explicitly', t => {
  const f = fixture(t);
  for (const filePath of ['\\\\server\\share\\file.txt', '//server/share/file.txt', '\\\\?\\C:\\file.txt', '\\\\.\\C:\\file.txt']) error(f.register({ filePath }), 'UNC_NOT_ALLOWED');
  error(f.register({ filePath: `${f.file}:hidden` }), 'ADS_NOT_ALLOWED');
  error(f.register({ allowedRoots: [`${f.root}:hidden`] }), 'ADS_NOT_ALLOWED');
  error(f.register({ allowedRoots: ['\\\\server\\share'] }), 'UNC_NOT_ALLOWED');
});

test('rejects linked parent directories, including junctions, inside allowed roots', t => {
  const f = fixture(t);
  const realDirectory = path.join(f.root, 'real');
  fs.mkdirSync(realDirectory);
  fs.writeFileSync(path.join(realDirectory, 'data.txt'), 'data');
  const linkedDirectory = path.join(f.root, 'link');
  fs.symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  error(f.register({ filePath: path.join(linkedDirectory, 'data.txt') }), 'LINK_NOT_ALLOWED');
});

test('checks root parent chains, not just root leaf', t => {
  const f = fixture(t);
  const linked = path.join(f.base, 'linked-root');
  fs.symlinkSync(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(f.root, 'nested'));
  const nestedFile = path.join(linked, 'nested', 'data.txt');
  fs.writeFileSync(nestedFile, 'data');
  error(f.register({ filePath: nestedFile, allowedRoots: [path.join(linked, 'nested')] }), 'LINK_NOT_ALLOWED');
  error(f.register({ allowedRoots: [linked] }), 'LINK_NOT_ALLOWED');
});

test('rejects file symlinks', t => {
  const f = fixture(t);
  const linked = path.join(f.root, 'linked.txt');
  try { fs.symlinkSync(f.file, linked, 'file'); }
  catch (err) {
    if (process.platform === 'win32' && err.code === 'EPERM') { t.skip('Windows account cannot create file symlinks; junction parent tests still run.'); return; }
    throw err;
  }
  error(f.register({ filePath: linked }), 'LINK_NOT_ALLOWED');
});

test('reports missing, non-regular and invalid root files distinctly', t => {
  const f = fixture(t);
  error(f.register({ filePath: path.join(f.root, 'missing.txt') }), 'NOT_FOUND');
  error(f.register({ filePath: f.root }), 'NOT_REGULAR_FILE');
  error(f.register({ allowedRoots: [f.file] }), 'NOT_DIRECTORY');
  error(f.register({ allowedRoots: [path.join(f.base, 'missing')] }), 'NOT_FOUND');
});

test('enforces default 100 MiB and custom size limits before reading', t => {
  const f = fixture(t);
  const huge = path.join(f.root, 'huge.txt');
  const fd = fs.openSync(huge, 'w');
  try { fs.ftruncateSync(fd, 100 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  error(f.register({ filePath: huge }), 'FILE_TOO_LARGE');
  const tiny = new AttachmentStore({ maxFileSize: 1 });
  error(tiny.register({ filePath: f.file, allowedRoots: [f.root], sessionId: 's', sourceId: 'x' }), 'FILE_TOO_LARGE');
});

test('validates expected SHA256 and permits uppercase digest', t => {
  const f = fixture(t);
  error(f.register({ expectedSha256: 'not-a-digest' }), 'INVALID_SHA256');
  error(f.register({ expectedSha256: '0'.repeat(64) }), 'SHA256_MISMATCH');
  attachment(f, { expectedSha256: digest(f.file).toUpperCase() });
});

test('enforces session on resolve/lease and rejects invalid action/id', t => {
  const f = fixture(t);
  const a = attachment(f);
  for (const session of [undefined, '', '  ', null]) {
    error(f.store.resolve(a.attachmentId, session), 'INVALID_SESSION');
    error(f.store.lease(a.attachmentId, session, 'open'), 'INVALID_SESSION');
  }
  error(f.store.resolve(a.attachmentId, 'session-2'), 'SESSION_MISMATCH');
  error(f.store.lease(a.attachmentId, 'session-2', 'open'), 'SESSION_MISMATCH');
  error(f.store.resolve(a.attachmentId, 'session-1', { action: 'execute' }), 'INVALID_ACTION');
  error(f.store.resolve('', 'session-1'), 'INVALID_ID');
  error(f.store.resolve('unknown', 'session-1'), 'NOT_FOUND');
  assert.equal(f.store.resolve(a.attachmentId, 'session-1').ok, true);
});

test('expires directly on resolve without registration or cleanup', t => {
  const f = fixture(t, { ttlMs: 10 });
  const a = attachment(f);
  f.tick(10);
  error(f.store.resolve(a.attachmentId, 'session-1'), 'EXPIRED');
  assert.equal(f.store.size, 0);
  assert.equal(fs.existsSync(f.file), true);
});

test('cleanup only revokes metadata and never deletes user files', t => {
  const f = fixture(t, { ttlMs: 10 });
  attachment(f);
  f.tick(11);
  assert.deepEqual(f.store.cleanup(), { ok: true, removed: 1 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'hello 附件\n');
});

test('detects same-size content modification even if mtime is restored', t => {
  const f = fixture(t);
  const a = attachment(f);
  const originalStat = fs.statSync(f.file);
  fs.writeFileSync(f.file, Buffer.alloc(a.size, 0x78));
  fs.utimesSync(f.file, originalStat.atime, originalStat.mtime);
  error(f.store.resolve(a.attachmentId, 'session-1', { action: 'open' }), 'FILE_CHANGED');
  assert.equal(f.store.size, 0);
  assert.equal(fs.existsSync(f.file), true);
});

test('detects replacement by a different inode with identical contents', t => {
  const f = fixture(t);
  const a = attachment(f);
  const replacement = path.join(f.root, 'new.txt');
  fs.writeFileSync(replacement, fs.readFileSync(f.file));
  // Exact destinations are test-owned absolute fixture paths.
  assert.equal(path.dirname(f.file), f.root);
  fs.renameSync(f.file, path.join(f.root, 'old.txt'));
  fs.renameSync(replacement, f.file);
  error(f.store.resolve(a.attachmentId, 'session-1'), 'FILE_CHANGED');
});

test('detects missing files on later resolve and revokes metadata', t => {
  const f = fixture(t);
  const a = attachment(f);
  assert.equal(path.dirname(f.file), f.root);
  fs.renameSync(f.file, path.join(f.root, 'moved.txt'));
  error(f.store.resolve(a.attachmentId, 'session-1'), 'NOT_FOUND');
  assert.equal(f.store.size, 0);
});

test('detects replacement of an allowed root by a new ordinary directory', t => {
  const f = fixture(t);
  const a = attachment(f);
  const contents = fs.readFileSync(f.file);
  assert.equal(path.dirname(f.root), f.base);
  fs.renameSync(f.root, path.join(f.base, 'old-root'));
  fs.mkdirSync(f.root);
  fs.writeFileSync(f.file, contents);
  error(f.store.resolve(a.attachmentId, 'session-1'), 'FILE_CHANGED');
  assert.equal(f.store.size, 0);
});

test('detects newly linked parent paths on later resolve', t => {
  const f = fixture(t);
  const a = attachment(f);
  const moved = path.join(f.base, 'moved-root');
  assert.equal(path.dirname(f.root), f.base);
  fs.renameSync(f.root, moved);
  fs.symlinkSync(moved, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  error(f.store.resolve(a.attachmentId, 'session-1'), 'LINK_NOT_ALLOWED');
  assert.equal(f.store.size, 0);
});

test('bounds records at configured capacity and reclaims expired metadata', t => {
  const f = fixture(t, { maxRecords: 2, ttlMs: 10 });
  attachment(f);
  attachment(f);
  error(f.register(), 'CAPACITY_EXCEEDED');
  assert.equal(f.store.size, 2);
  f.tick(11);
  attachment(f);
  assert.equal(f.store.size, 1);
  assert.equal(fs.existsSync(f.file), true);
});

test('default record cap is 500 and cannot be configured higher', t => {
  const f = fixture(t);
  for (let i = 0; i < 500; i++) attachment(f);
  assert.equal(f.store.size, 500);
  error(f.register(), 'CAPACITY_EXCEEDED');
  assert.throws(() => new AttachmentStore({ maxRecords: 501 }), /500/);
});

test('session end revokes only matching records and all their leases', t => {
  const f = fixture(t);
  const a = attachment(f);
  const b = attachment(f, { sessionId: 'session-2' });
  const leased = f.store.lease(a.attachmentId, 'session-1', 'drag');
  assert.equal(leased.ok, true);
  assert.deepEqual(f.store.endSession('session-1'), { ok: true, revoked: 1 });
  error(f.store.resolve(a.attachmentId, 'session-1'), 'NOT_FOUND');
  assert.equal(f.store.resolve(b.attachmentId, 'session-2').ok, true);
  assert.equal(f.store.leaseCount, 0);
  assert.deepEqual(f.store.release(leased.leaseId), { ok: true, released: false });
  error(f.store.endSession(''), 'INVALID_SESSION');
  assert.equal(fs.existsSync(f.file), true);
});

test('IDs are opaque, random, distinct and not path/hash derived', t => {
  const f = fixture(t);
  const ids = new Set();
  for (let i = 0; i < 60; i++) {
    const a = attachment(f);
    assert.match(a.attachmentId, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a.attachmentId, a.sha256.slice(0, 32));
    ids.add(a.attachmentId);
  }
  assert.equal(ids.size, 60);
});

test('active/unknown types cannot open or drag, regardless of MIME', t => {
  const f = fixture(t);
  for (const extension of ['exe', 'cmd', 'bat', 'ps1', 'js', 'mjs', 'html', 'htm', 'svg', 'lnk', 'url', 'hta', 'docm', 'xlsm', 'unknown']) {
    const dangerous = path.join(f.root, `payload.${extension}`);
    fs.writeFileSync(dangerous, 'content');
    const a = attachment(f, { filePath: dangerous, mime: 'image/png' });
    for (const action of ['open', 'drag']) error(f.store.resolve(a.attachmentId, 'session-1', { action }), 'UNSAFE_FILE_TYPE');
    assert.equal(f.store.resolve(a.attachmentId, 'session-1', { action: 'show' }).ok, true);
  }
});

test('ordinary documents/images/data can open and drag; directories cannot show', t => {
  const f = fixture(t);
  for (const extension of ['md', 'txt', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'zip', 'PDF']) {
    const filePath = path.join(f.root, `普通 文件.${extension}`);
    fs.writeFileSync(filePath, 'data');
    const a = attachment(f, { filePath });
    for (const action of ['open', 'drag']) assert.equal(f.store.resolve(a.attachmentId, 'session-1', { action }).ok, true);
  }
  error(f.register({ filePath: f.root }), 'NOT_REGULAR_FILE');
});

test('lease pins metadata but cannot extend authorization past expiry', t => {
  const f = fixture(t, { ttlMs: 10, maxRecords: 1 });
  const a = attachment(f);
  const first = f.store.lease(a.attachmentId, 'session-1', 'open');
  const second = f.store.lease(a.attachmentId, 'session-1', 'drag');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.leaseId, second.leaseId);
  f.tick(10);
  assert.deepEqual(f.store.cleanup(), { ok: true, removed: 0 });
  error(f.store.resolve(a.attachmentId, 'session-1'), 'EXPIRED');
  error(f.store.lease(a.attachmentId, 'session-1', 'open'), 'EXPIRED');
  error(f.register(), 'CAPACITY_EXCEEDED');
  assert.equal(f.store.size, 1);
  assert.deepEqual(f.store.release(first.leaseId), { ok: true, released: true });
  assert.equal(f.store.size, 1);
  assert.deepEqual(f.store.release(second.leaseId), { ok: true, released: true });
  assert.equal(f.store.size, 0);
  assert.deepEqual(f.store.release(second.leaseId), { ok: true, released: false });
  assert.equal(fs.existsSync(f.file), true);
});

test('leases are bounded and integrity failures invalidate existing leases', t => {
  const f = fixture(t, { maxRecords: 1 });
  const a = attachment(f);
  const leases = [];
  for (let i = 0; i < 4; i++) {
    const result = f.store.lease(a.attachmentId, 'session-1', 'show');
    assert.equal(result.ok, true);
    leases.push(result.leaseId);
  }
  error(f.store.lease(a.attachmentId, 'session-1', 'show'), 'LEASE_CAPACITY_EXCEEDED');
  fs.writeFileSync(f.file, 'tampered');
  error(f.store.resolve(a.attachmentId, 'session-1'), 'FILE_CHANGED');
  assert.equal(f.store.leaseCount, 0);
  assert.equal(f.store.size, 0);
  for (const id of leases) assert.deepEqual(f.store.release(id), { ok: true, released: false });
});

test('returned metadata cannot mutate authoritative records', t => {
  const f = fixture(t);
  const a = attachment(f);
  const id = a.attachmentId;
  a.sessionId = 'attacker';
  a.expiresAt = 0;
  a.sha256 = 'fake';
  const resolved = f.store.resolve(id, 'session-1');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attachment.sha256, digest(f.file));
  resolved.attachment.sourceId = 'fake';
  assert.equal(f.store.resolve(id, 'session-1').attachment.sourceId, 'source-1');
});

test('constructor and clock reject invalid limits without throwing from operations', t => {
  for (const option of [{ ttlMs: 0 }, { maxFileSize: -1 }, { maxRecords: 1.5 }, { clock: 123 }]) assert.throws(() => new AttachmentStore(option));
  const f = fixture(t, { clock: () => NaN });
  error(f.register(), 'INVALID_CLOCK');
  error(f.store.cleanup(), 'INVALID_CLOCK');
});
