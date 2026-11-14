'use strict';
// Real product modules + real temporary files; Electron/DOM are explicit test
// doubles. These are integration boundary tests, NOT a real GUI/user drag test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const APP = path.resolve(__dirname, '../app');
const { AttachmentStore } = require(path.join(APP, 'attachment-store.js'));
const { installAttachmentIpc } = require(path.join(APP, 'attachment-ipc.js'));
const { collectResponseAttachments } = require(path.join(APP, 'response-attachments.js'));

function fixture(t, options = {}) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent, 'f1-integration-test-'));
  const root = path.join(base, '允许 中文 空格');
  fs.mkdirSync(root);
  const file = path.join(root, '报告 文件.txt');
  fs.writeFileSync(file, 'real attachment bytes');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), parent);
    assert.ok(path.basename(base).startsWith('f1-integration-test-'));
    assert.equal(fs.lstatSync(base).isSymbolicLink(), false);
    fs.rmSync(base, { recursive: true, force: true });
  });
  let now = 1000;
  const store = new AttachmentStore({ clock: () => now, ...options });
  const registered = store.register({ filePath: file, allowedRoots: [root], sessionId: 'session-a', sourceId: 'response-1' });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return { base, root, file, store, attachment: registered.attachment, tick: ms => { now += ms; } };
}
function fail(result, code) { assert.equal(result.ok, false); assert.equal(result.error, code); }
function ipcHarness(f, installer = installAttachmentIpc, url = 'http://127.0.0.1:43123/') {
  // Mirrors main.src.js trustedWindows: loopback HTTP, not file: navigation.
  const handles = new Map(), listeners = new Map(), effects = [];
  const mainFrame = { url };
  const wc = { mainFrame, startDrag: data => { effects.push({ kind: 'drag', data }); } };
  const window = { isDestroyed: () => false, webContents: wc };
  const icon = { mockNativeImage: true };
  const shell = {
    openPath: async filePath => { effects.push({ kind: 'open', filePath }); return ''; },
    showItemInFolder: filePath => { effects.push({ kind: 'show', filePath }); },
  };
  const nativeImage = { createFromDataURL: data => { assert.match(data, /^data:image\/png;base64,.+/); return icon; } };
  const ipcMain = { handle: (name, handler) => handles.set(name, handler), on: (name, handler) => listeners.set(name, handler) };
  const auth = installer({ ipcMain, store: f.store, shell, nativeImage, trustedWindows: () => [{ window, url }] });
  const req = { attachmentId: f.attachment.attachmentId, sessionId: 'session-a' };
  const event = () => ({ sender: wc, senderFrame: mainFrame });
  return { handles, listeners, effects, mainFrame, wc, window, shell, icon, req, event, auth, url };
}
function loadIpcWithTimers() {
  const timers = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'attachment-ipc.js'), 'utf8'), {
    module, exports: module.exports, URL,
    setTimeout: (fn, delay) => { const timer = { fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; } }; timers.push(timer); return timer; },
  }, { filename: 'attachment-ipc.js' });
  return { installer: module.exports.installAttachmentIpc, timers };
}

test('IPC installs only ID-based action endpoints, never a renderer path registration entry', t => {
  const f = fixture(t), h = ipcHarness(f);
  assert.deepEqual([...h.handles.keys()].sort(), ['file:open', 'file:show-in-folder']);
  assert.deepEqual([...h.listeners.keys()], ['file:start-drag']);
});

test('IPC rejects absent/foreign sender, subframe, missing session and malformed payload without effects', async t => {
  const f = fixture(t), h = ipcHarness(f);
  const variants = [
    [null, h.req],
    [{ sender: {}, senderFrame: h.mainFrame }, h.req],
    [{ sender: h.wc, senderFrame: { url: h.url } }, h.req],
    [{ sender: h.wc }, h.req],
    [h.event(), null],
    [h.event(), { attachmentId: h.req.attachmentId }],
    [h.event(), { attachmentId: h.req.attachmentId, sessionId: '' }],
    [h.event(), { filePath: f.file, sessionId: 'session-a' }],
  ];
  for (const [event, req] of variants) {
    for (const channel of ['file:open', 'file:show-in-folder']) fail(await h.handles.get(channel)(event, req), 'UNTRUSTED_ATTACHMENT_REQUEST');
    if (event) { h.listeners.get('file:start-drag')(event, req); fail(event.returnValue, 'UNTRUSTED_ATTACHMENT_REQUEST'); }
  }
  h.window.isDestroyed = () => true;
  fail(await h.handles.get('file:open')(h.event(), h.req), 'UNTRUSTED_ATTACHMENT_REQUEST');
  assert.equal(h.effects.length, 0);
  assert.equal(f.store.leaseCount, 0);
});

test('IPC rejects main frame navigation to wrong path, remote URL and malformed URL', async t => {
  const f = fixture(t), h = ipcHarness(f);
  for (const url of ['file:///different.html', 'https://example.test/index.html', 'not a URL']) {
    h.mainFrame.url = url;
    fail(await h.handles.get('file:open')(h.event(), h.req), 'UNTRUSTED_ATTACHMENT_REQUEST');
  }
  assert.equal(h.effects.length, 0);
});

test('IPC rejects protocol/host/port changes even when pathname matches', async t => {
  const f = fixture(t), h = ipcHarness(f);
  const pathname = new URL(h.url).pathname;
  for (const url of [`custom:${pathname}`, `file://untrusted-host${pathname}`, 'https://127.0.0.1:43123/', 'http://untrusted-host:43123/', 'http://127.0.0.1:43124/']) {
    h.mainFrame.url = url;
    fail(await h.handles.get('file:open')(h.event(), h.req), 'UNTRUSTED_ATTACHMENT_REQUEST');
  }
  assert.equal(h.effects.length, 0);
});

test('IPC fails closed if a non-production file trust URL is accidentally configured', async t => {
  const f = fixture(t);
  const h = ipcHarness(f, installAttachmentIpc, pathToFileURL(path.join(APP, 'index.html')).href);
  const pathname = new URL(h.url).pathname;
  for (const url of [h.url, `custom:${pathname}`, `file://untrusted-host${pathname}`]) {
    h.mainFrame.url = url;
    fail(await h.handles.get('file:open')(h.event(), h.req), 'UNTRUSTED_ATTACHMENT_REQUEST');
  }
  assert.equal(h.effects.length, 0);
});

test('real registration resolves exact files through mocked open/show and releases leases', async t => {
  const f = fixture(t), h = ipcHarness(f);
  assert.equal((await h.handles.get('file:open')(h.event(), { ...h.req, filePath: 'C:/attacker.exe' })).ok, true);
  assert.equal(f.store.leaseCount, 0);
  assert.equal((await h.handles.get('file:show-in-folder')(h.event(), h.req)).ok, true);
  assert.equal(f.store.leaseCount, 0);
  assert.deepEqual(h.effects, [{ kind: 'open', filePath: f.file }, { kind: 'show', filePath: f.file }]);
  assert.equal(fs.existsSync(f.file), true);
});

test('IPC holds lease during asynchronous open and releases it after completion', async t => {
  const f = fixture(t, { ttlMs: 10 }), h = ipcHarness(f);
  let finish;
  h.shell.openPath = () => new Promise(resolve => { finish = resolve; });
  const pending = h.handles.get('file:open')(h.event(), h.req);
  assert.equal(f.store.leaseCount, 1);
  f.tick(11);
  assert.equal(f.store.cleanup().removed, 0);
  finish('');
  assert.equal((await pending).ok, true);
  assert.equal(f.store.leaseCount, 0);
  assert.equal(f.store.size, 0);
  assert.equal(fs.existsSync(f.file), true);
});

test('IPC shell failures return errors and always release leases', async t => {
  const f = fixture(t), h = ipcHarness(f);
  h.shell.openPath = async () => 'No associated application';
  fail(await h.handles.get('file:open')(h.event(), h.req), 'OPEN_FAILED');
  assert.equal(f.store.leaseCount, 0);
  h.shell.openPath = async () => { throw new Error('mock shell rejected'); };
  fail(await h.handles.get('file:open')(h.event(), h.req), 'FILE_ACTION_FAILED');
  h.shell.showItemInFolder = () => { throw new Error('mock reveal rejected'); };
  fail(await h.handles.get('file:show-in-folder')(h.event(), h.req), 'FILE_ACTION_FAILED');
  assert.equal(f.store.leaseCount, 0);
});

test('IPC denies cross-session, expired, modified and dangerous files before shell actions', async t => {
  const f = fixture(t), h = ipcHarness(f);
  fail(await h.handles.get('file:open')(h.event(), { ...h.req, sessionId: 'another-session' }), 'SESSION_MISMATCH');
  fail(await h.handles.get('file:open')(h.event(), { ...h.req, sessionId: ' ' }), 'INVALID_SESSION');
  const executable = path.join(f.root, 'do-not-run.cmd');
  fs.writeFileSync(executable, 'echo never executed');
  const unsafe = f.store.register({ filePath: executable, allowedRoots: [f.root], sessionId: 'session-a', sourceId: 's' }).attachment;
  fail(await h.handles.get('file:open')(h.event(), { ...h.req, attachmentId: unsafe.attachmentId }), 'UNSAFE_FILE_TYPE');
  const event = h.event();
  h.listeners.get('file:start-drag')(event, { ...h.req, attachmentId: unsafe.attachmentId });
  fail(event.returnValue, 'UNSAFE_FILE_TYPE');
  fs.writeFileSync(f.file, 'changed');
  fail(await h.handles.get('file:open')(h.event(), h.req), 'FILE_CHANGED');
  assert.equal(h.effects.length, 0);
  const expiring = fixture(t, { ttlMs: 1 }), other = ipcHarness(expiring);
  expiring.tick(1);
  fail(await other.handles.get('file:open')(other.event(), other.req), 'EXPIRED');
  assert.equal(other.effects.length, 0);
});

test('native drag passes real file and nonempty icon to mock; bounded timer releases metadata', t => {
  const f = fixture(t, { ttlMs: 10 }), loaded = loadIpcWithTimers(), h = ipcHarness(f, loaded.installer);
  const event = h.event();
  h.listeners.get('file:start-drag')(event, h.req);
  assert.equal(event.returnValue.ok, true);
  assert.equal(event.returnValue.state, 'native_drag_started');
  assert.equal(h.effects.length, 1);
  assert.equal(h.effects[0].data.file, f.file);
  assert.equal(h.effects[0].data.icon, h.icon);
  assert.equal(f.store.leaseCount, 1);
  assert.equal(loaded.timers.length, 1);
  assert.equal(loaded.timers[0].delay, 60000);
  assert.equal(loaded.timers[0].unrefCalled, true);
  f.tick(11);
  assert.equal(f.store.cleanup().removed, 0);
  loaded.timers[0].fn();
  assert.equal(f.store.leaseCount, 0);
  assert.equal(f.store.size, 0);
  assert.equal(fs.existsSync(f.file), true);
});

test('drag failures are explicit and their leases still have bounded release', t => {
  const f = fixture(t), loaded = loadIpcWithTimers(), h = ipcHarness(f, loaded.installer);
  h.wc.startDrag = () => { throw new Error('mock native drag failure'); };
  const event = h.event();
  h.listeners.get('file:start-drag')(event, h.req);
  fail(event.returnValue, 'DRAG_FAILED');
  assert.equal(loaded.timers.length, 1);
  loaded.timers[0].fn();
  assert.equal(f.store.leaseCount, 0);
  assert.equal(fs.existsSync(f.file), true);
});

function collect(f, text, extra = {}) {
  return collectResponseAttachments({ text, store: f.store, sessionId: 'session-a', sourceId: 'model-response-2', roots: [f.root], cwd: f.root, ...extra });
}

test('collector parses actual markdown including Unicode/spaces, line anchors and deduplicates paths', t => {
  const f = fixture(t);
  const encoded = encodeURIComponent(path.basename(f.file));
  const result = collect(f, `[报告](<${f.file}>)\n[again](${encoded}#L1-L3)\n![image](${encoded})`);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, 'model-response-2');
  assert.equal(result[0].sessionId, 'session-a');
  assert.equal(result[0].filePath, undefined);
  assert.equal(f.store.resolve(result[0].attachmentId, 'session-a').filePath, f.file);
});

test('collector rejects missing sessions/roots, remote schemes, plain guesses and outside files', t => {
  const f = fixture(t);
  const outside = path.join(f.base, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const before = f.store.size;
  const text = [
    '[remote](https://example.test/file.txt)', '[ftp](ftp://example.test/file.txt)',
    '[data](data:text/plain,hello)', '[js](javascript:alert)', '[sandbox](sandbox:/tmp/file.txt)',
    `[file](<${pathToFileURL(f.file).href}>)`, `[encoded](https%3A%2F%2Fexample.test%2Ffile.txt)`,
    `[outside](<${outside}>)`, '[missing](missing.txt)', '[anchor](#heading)',
    '[invalid](bad%zz.txt)', f.file,
  ].join('\n');
  assert.equal(collect(f, text).length, 0);
  assert.equal(f.store.size, before);
  for (const extra of [{ sessionId: '' }, { sourceId: '' }, { roots: [] }, { roots: undefined }]) {
    assert.equal(collect(f, `[real](<${f.file}>)`, extra).length, 0);
  }
});

test('collector rejects linked parent directories through real AttachmentStore checks', t => {
  const f = fixture(t);
  const linked = path.join(f.root, 'linked');
  const destination = path.join(f.base, 'elsewhere');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'data.txt'), 'data');
  fs.symlinkSync(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(collect(f, '[linked](linked/data.txt)').length, 0);
});

test('collector bounds successful output to 20 records and ignores text after 1 MiB', t => {
  const f = fixture(t);
  const links = [];
  for (let i = 0; i < 23; i++) {
    const name = `data-${i}.txt`;
    fs.writeFileSync(path.join(f.root, name), String(i));
    links.push(`[${i}](${name})`);
  }
  assert.equal(collect(f, links.join('\n')).length, 20);
  assert.equal(collect(f, 'x'.repeat(1024 * 1024) + links[0]).length, 0);
});

function preloadHarness(ipcOverride) {
  const listeners = new Map(), timers = [], calls = [], exposed = {};
  let now = 1000;
  const ipcRenderer = {
    invoke: async (channel, req) => { calls.push({ method: 'invoke', channel, req }); return { ok: true }; },
    sendSync: (channel, req) => { calls.push({ method: 'sendSync', channel, req }); return { ok: true, state: 'native_drag_started' }; },
  };
  const sandbox = {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: ipcOverride || ipcRenderer }; },
    window: { addEventListener: (type, handler, capture) => { assert.equal(capture, true); listeners.set(type, handler); } },
    Date: { now: () => now }, setTimeout: (fn, delay) => { assert.equal(delay, 0); timers.push(fn); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'preload.js'), 'utf8'), sandbox, { filename: 'preload.js' });
  return { api: exposed.whaleFile, calls, listeners, timers, tick: ms => { now += ms; } };
}
const request = () => ({ attachmentId: 'opaque-id', sessionId: 'session-a' });

test('preload refuses missing/synthetic gestures and renderer-supplied trusted flags', async () => {
  const h = preloadHarness();
  fail(await h.api.open({ ...request(), isTrusted: true, userGesture: true }), 'USER_GESTURE_REQUIRED');
  h.listeners.get('click')({ isTrusted: false });
  fail(await h.api.showInFolder(request()), 'USER_GESTURE_REQUIRED');
  h.listeners.get('dragstart')({ isTrusted: false });
  fail(h.api.startDrag(request()), 'USER_GESTURE_REQUIRED');
  assert.equal(h.calls.length, 0);
});

test('preload mocked trusted click permits one open only and strips arbitrary path fields', async () => {
  const h = preloadHarness();
  h.listeners.get('click')({ isTrusted: true }); // VM test input, NOT an actual human/browser event.
  assert.equal((await h.api.open({ ...request(), filePath: 'C:/do-not-pass.exe', action: 'execute' })).ok, true);
  fail(await h.api.open(request()), 'USER_GESTURE_REQUIRED');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].channel, 'file:open');
  assert.deepEqual(Object.keys(h.calls[0].req).sort(), ['attachmentId', 'sessionId']);
  assert.equal(h.calls[0].req.attachmentId, 'opaque-id');
});

test('preload separates click and synchronous drag channels', async () => {
  const h = preloadHarness();
  h.listeners.get('click')({ isTrusted: true });
  fail(h.api.startDrag(request()), 'USER_GESTURE_REQUIRED');
  assert.equal((await h.api.showInFolder(request())).ok, true);
  h.listeners.get('dragstart')({ isTrusted: true });
  fail(await h.api.open(request()), 'USER_GESTURE_REQUIRED');
  assert.equal(h.api.startDrag(request()).state, 'native_drag_started');
  fail(h.api.startDrag(request()), 'USER_GESTURE_REQUIRED');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].channel, 'file:show-in-folder');
  assert.equal(h.calls[1].channel, 'file:start-drag');
  assert.equal(h.calls[1].method, 'sendSync');
});

test('preload gesture expires by timeout or clock and malformed requests cannot reach IPC', async () => {
  const h = preloadHarness();
  h.listeners.get('click')({ isTrusted: true });
  h.timers[0]();
  fail(await h.api.open(request()), 'USER_GESTURE_REQUIRED');
  h.listeners.get('click')({ isTrusted: true });
  h.tick(501);
  fail(await h.api.open(request()), 'USER_GESTURE_REQUIRED');
  h.listeners.get('click')({ isTrusted: true });
  fail(await h.api.open({ attachmentId: 'only-id' }), 'USER_GESTURE_REQUIRED');
  assert.equal(h.calls.length, 0);
});

class FakeElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.className = ''; this.textContent = ''; this.disabled = false; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      for (const child of element.children) {
        if (selector === '.f1-attachment-card' && child.className.split(/\s+/).includes('f1-attachment-card')) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}
function uiHarness(whaleFile) {
  const window = whaleFile ? { whaleFile } : {};
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'attachment-ui.js'), 'utf8'), { window, document: { createElement: tag => new FakeElement(tag) } }, { filename: 'attachment-ui.js' });
  return { render: window.WhaleAttachments.render, container: new FakeElement('div') };
}
function info(extra = {}) { return { attachmentId: 'opaque-id', sessionId: 'session-a', name: '<img src=x onerror=alert(1)>.txt', ...extra }; }

test('UI creates real card structure in fake DOM, uses textContent, rejects duplicate/invalid cards', () => {
  const h = uiHarness({});
  const card = h.render(h.container, info());
  assert.equal(h.container.children.length, 1);
  assert.equal(card.children[0].textContent, '📄 <img src=x onerror=alert(1)>.txt');
  assert.equal(card.children[0].children.length, 0);
  assert.equal(card.children.filter(c => c.tagName === 'BUTTON').length, 3);
  assert.equal(card.children.at(-1).attributes.role, 'status');
  assert.equal(h.render(h.container, info()), null);
  assert.equal(h.render(h.container, info({ attachmentId: 'other', sessionId: '' })), null);
  assert.equal(h.container.children.length, 1);
});

test('UI disables desktop-only controls when bridge is absent', () => {
  const h = uiHarness();
  const card = h.render(h.container, info());
  assert.ok(card.children.filter(c => c.tagName === 'BUTTON').every(c => c.disabled));
  assert.match(card.children.at(-1).textContent, /桌面/);
});

test('UI filters synthetic events, sends IDs only and reports action success/error', async () => {
  const calls = [];
  const h = uiHarness({
    open: async req => { calls.push({ kind: 'open', req }); return { ok: false, error: 'EXPIRED' }; },
    showInFolder: async req => { calls.push({ kind: 'show', req }); return { ok: true }; },
  });
  const card = h.render(h.container, info({ filePath: 'C:/should-not-pass' }));
  const [open, show] = card.children.filter(c => c.tagName === 'BUTTON');
  const status = card.children.at(-1);
  await open.onclick({ isTrusted: false });
  assert.equal(calls.length, 0);
  await open.onclick({ isTrusted: true });
  assert.equal(calls.length, 1);
  assert.match(status.textContent, /过期/);
  assert.deepEqual(Object.keys(calls[0].req).sort(), ['attachmentId', 'sessionId']);
  await show.onclick({ isTrusted: true });
  assert.equal(calls.length, 2);
  assert.equal(status.textContent, '已在文件夹中定位。');
});

test('UI drag prevents default synchronously, ignores synthetic input and calls sync native bridge', () => {
  let defaultPrevented = false, calls = 0;
  const h = uiHarness({ startDrag: req => {
    assert.equal(defaultPrevented, false);
    assert.equal(req.attachmentId, 'opaque-id');
    calls++;
    return { ok: false, error: 'DRAG_FAILED', message: 'mock drag refused' };
  } });
  const card = h.render(h.container, info());
  const drag = card.children.filter(c => c.tagName === 'BUTTON')[2];
  assert.equal(drag.draggable, true);
  drag.ondragstart({ isTrusted: false, preventDefault() { defaultPrevented = true; } });
  assert.equal(calls, 0);
  defaultPrevented = false;
  drag.ondragstart({ isTrusted: true, preventDefault() { defaultPrevented = true; } });
  assert.equal(calls, 1);
  assert.equal(defaultPrevented, true);
  assert.equal(card.children.at(-1).textContent, 'mock drag refused');
  drag.onclick();
  assert.match(card.children.at(-1).textContent, /按住/);
});

test('fake UI → real preload VM → real IPC → real store composes with mocked Electron effects', async t => {
  const f = fixture(t), loaded = loadIpcWithTimers(), ipc = ipcHarness(f, loaded.installer);
  const preload = preloadHarness({
    invoke: (channel, req) => ipc.handles.get(channel)(ipc.event(), req),
    sendSync: (channel, req) => { const event = ipc.event(); ipc.listeners.get(channel)(event, req); return event.returnValue; },
  });
  const ui = uiHarness(preload.api);
  const card = ui.render(ui.container, f.attachment);
  const [open, show, drag] = card.children.filter(c => c.tagName === 'BUTTON');
  // Explicitly fabricated boundary event objects: no real browser gesture is claimed.
  await open.onclick({ isTrusted: true });
  assert.equal(ipc.effects.length, 0);
  assert.match(card.children.at(-1).textContent, /点击|USER_GESTURE_REQUIRED/);
  preload.listeners.get('click')({ isTrusted: true });
  await open.onclick({ isTrusted: true });
  preload.listeners.get('click')({ isTrusted: true });
  await show.onclick({ isTrusted: true });
  preload.listeners.get('dragstart')({ isTrusted: true });
  drag.ondragstart({ isTrusted: true, preventDefault() {} });
  assert.deepEqual(ipc.effects.map(effect => effect.kind), ['open', 'show', 'drag']);
  assert.equal(ipc.effects[0].filePath, f.file);
  assert.equal(ipc.effects[2].data.file, f.file);
  assert.equal(f.store.leaseCount, 1);
  f.store.endSession('session-a');
  assert.equal(f.store.leaseCount, 0);
  loaded.timers[0].fn(); // Revoked session makes later release a harmless no-op.
  preload.listeners.get('click')({ isTrusted: true });
  await open.onclick({ isTrusted: true });
  assert.equal(ipc.effects.length, 3);
  assert.notEqual(card.children.at(-1).textContent, '');
  assert.equal(fs.existsSync(f.file), true);
});

test('UI catches bridge exceptions rather than reporting success', async () => {
  const h = uiHarness({ open: async () => { throw new Error('mock open error'); }, startDrag: () => { throw new Error('mock drag error'); } });
  const card = h.render(h.container, info());
  const [open, , drag] = card.children.filter(c => c.tagName === 'BUTTON');
  await open.onclick({ isTrusted: true });
  assert.equal(card.children.at(-1).textContent, 'mock open error');
  drag.ondragstart({ isTrusted: true, preventDefault() {} });
  assert.equal(card.children.at(-1).textContent, 'mock drag error');
});
