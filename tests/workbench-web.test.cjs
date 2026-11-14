'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Workbench } = require('../app/workbench-service.js');
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'workbench-web-'));
  const wb = new Workbench({ ROOT: root });
  const created = [], destroyed = [];
  wb.attachViewFactory({
    create(id, url, bounds, callback) { const v = { id, url, bounds, callback, visible: bounds && bounds.width > 1 }; created.push(v); return v; },
    setBounds(v, bounds) { v.bounds = bounds; v.visible = bounds.width > 1 && bounds.height > 1; },
    destroy(v) { destroyed.push(v); v.visible = false; },
    nav() { return { ok: true }; },
  });
  const web = wb.addTab({ type: 'web' });
  wb.setUi({ open: true, layout: 'docked', activeTabId: web.id });
  wb.setViewsVisible(true, web.id);
  t.after(() => { wb.destroy(); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('workbench-web-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { wb, web, created, destroyed };
}
const bounds = { x: 5, y: 10, width: 600, height: 400 };
test('switching columns hides native web and rejects stale open/bounds/visible; return can restore', t => {
  const { wb, web, created } = fixture(t);
  assert.equal(wb.openWeb(web.id, 'https://example.com', bounds).ok, true);
  const v = created[0];
  const files = wb.addTab({ type: 'files' });
  wb.setUi({ activeTabId: files.id });
  assert.equal(v.visible, false);
  assert.ok(wb.openWeb(web.id, 'https://example.org', bounds).error);
  assert.equal(wb.setViewBounds(web.id, bounds).ok, false);
  assert.equal(wb.setViewsVisible(true, web.id).ok, false);
  assert.equal(created.length, 1);
  wb.setUi({ activeTabId: web.id });
  assert.equal(wb.setViewsVisible(true, web.id).ok, true);
  assert.equal(wb.setViewBounds(web.id, bounds).ok, true);
  assert.equal(v.visible, true);
});
test('overlay hide and closed workspace cannot be undone by delayed bounds or open', t => {
  const { wb, web, created } = fixture(t);
  wb.openWeb(web.id, 'https://example.com', bounds);
  wb.hideAllViews();
  assert.equal(wb.setViewBounds(web.id, bounds).ok, false);
  wb.openWeb(web.id, 'https://example.org', bounds);
  assert.equal(created.at(-1).visible, false);
  wb.setUi({ open: false });
  assert.equal(wb.setViewsVisible(true, web.id).ok, false);
  assert.ok(wb.openWeb(web.id, 'https://example.net', bounds).error);
});
test('close webpage disposes view, clears persisted URL and ignores late navigation callback', t => {
  const { wb, web, created, destroyed } = fixture(t);
  wb.openWeb(web.id, 'https://example.com', bounds);
  const old = created[0];
  assert.equal(wb.navView(web.id, 'close').ok, true);
  old.callback({ url: 'https://example.org', title: 'late event' });
  assert.equal(web.url, undefined);
  assert.equal(wb.views.size, 0);
  assert.deepEqual(destroyed, [old]);
  wb.flush();
  const saved = JSON.parse(fs.readFileSync(wb.stateFile, 'utf8'));
  assert.equal(saved.tabs.find(tab => tab.id === web.id).url, undefined);
});
test('close tab always destroys view and prevents late requests recreating it', t => {
  const { wb, web, created, destroyed } = fixture(t);
  wb.openWeb(web.id, 'https://example.com', bounds);
  wb.closeTab(web.id);
  created[0].callback({ url: 'https://example.org', title: 'late' });
  assert.equal(web.url, undefined);
  assert.equal(wb.state.tabs.some(tab => tab.id === web.id), false);
  assert.equal(destroyed.length, 1);
  assert.ok(wb.openWeb(web.id, 'https://example.org', bounds).error);
});
test('replacement view ignores callback from disposed predecessor', t => {
  const { wb, web, created, destroyed } = fixture(t);
  wb.openWeb(web.id, 'https://example.com', bounds);
  wb.openWeb(web.id, 'https://example.org', bounds);
  created[0].callback({ url: 'https://stale.example.com', title: 'stale' });
  assert.equal(web.url, 'https://example.org/');
  assert.equal(destroyed.length, 1);
});
