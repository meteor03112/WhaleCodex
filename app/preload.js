'use strict';
// Isolated-world gate: callers cannot supply a boolean to forge a user gesture.
const { contextBridge, ipcRenderer } = require('electron');
let gesture = null;
for (const type of ['click', 'dragstart']) {
  window.addEventListener(type, event => {
    if (!event.isTrusted) return;
    const current = { type, until: Date.now() + 500 };
    gesture = current;
    setTimeout(() => { if (gesture === current) gesture = null; }, 0);
  }, true);
}
function request(req, type) {
  if (!gesture || gesture.type !== type || Date.now() > gesture.until) return null;
  gesture = null;
  if (!req || typeof req.attachmentId !== 'string' || typeof req.sessionId !== 'string') return null;
  return { attachmentId: req.attachmentId, sessionId: req.sessionId };
}
contextBridge.exposeInMainWorld('whaleFile', {
  open: req => {
    const data = request(req, 'click');
    return data ? ipcRenderer.invoke('file:open', data) : Promise.resolve({ ok: false, error: 'USER_GESTURE_REQUIRED' });
  },
  showInFolder: req => {
    const data = request(req, 'click');
    return data ? ipcRenderer.invoke('file:show-in-folder', data) : Promise.resolve({ ok: false, error: 'USER_GESTURE_REQUIRED' });
  },
  // Synchronous IPC keeps native startDrag in the original dragstart dispatch.
  // The handler performs only bounded local-file validation and native drag initiation.
  startDrag: req => {
    const data = request(req, 'dragstart');
    return data ? ipcRenderer.sendSync('file:start-drag', data) : { ok: false, error: 'USER_GESTURE_REQUIRED' };
  },
});
