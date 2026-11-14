'use strict';
// Electron dependencies are injected so authorization and effects can be tested independently.
function installAttachmentIpc({ ipcMain, store, shell, nativeImage, trustedWindows }) {
  function authorize(event, req) {
    if (!event || !req || typeof req.attachmentId !== 'string' || !req.attachmentId ||
        typeof req.sessionId !== 'string' || !req.sessionId) return false;
    return trustedWindows().some(({ window, url }) => {
      if (!window || window.isDestroyed()) return false;
      const wc = window.webContents;
      if (event.sender !== wc || !event.senderFrame || event.senderFrame !== wc.mainFrame) return false;
      try {
        const actual = new URL(event.senderFrame.url), expected = new URL(url);
        // Only the exact loopback HTTP origin is trusted; same pathname under file:/custom:
        // or another host must never authorize file actions.
        return actual.protocol === 'http:' && actual.hostname === expected.hostname &&
          actual.port === expected.port && actual.pathname === expected.pathname;
      } catch { return false; }
    });
  }
  const deny = () => ({ ok: false, error: 'UNTRUSTED_ATTACHMENT_REQUEST' });
  async function invoke(event, req, action) {
    if (!authorize(event, req)) return deny();
    const result = store.lease(req.attachmentId, req.sessionId, action);
    if (!result.ok) return result;
    try {
      if (action === 'open') {
        const error = await shell.openPath(result.filePath);
        return error ? { ok: false, error: 'OPEN_FAILED', message: error } : { ok: true };
      }
      shell.showItemInFolder(result.filePath);
      return { ok: true };
    } catch (error) { return { ok: false, error: 'FILE_ACTION_FAILED', message: String(error.message || error) }; }
    finally { store.release(result.leaseId); }
  }
  ipcMain.handle('file:open', (event, req) => invoke(event, req, 'open'));
  ipcMain.handle('file:show-in-folder', (event, req) => invoke(event, req, 'show'));
  ipcMain.on('file:start-drag', (event, req) => {
    if (!authorize(event, req)) { event.returnValue = deny(); return; }
    const result = store.lease(req.attachmentId, req.sessionId, 'drag');
    if (!result.ok) { event.returnValue = result; return; }
    try {
      // NativeImage must be non-empty; an empty path is not a default icon contract.
      const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
      if (typeof icon.isEmpty === 'function' && icon.isEmpty()) {
        event.returnValue = { ok: false, error: 'DRAG_ICON_UNAVAILABLE' }; return;
      }
      event.sender.startDrag({ file: result.filePath, icon });
      event.returnValue = { ok: true, state: 'native_drag_started' };
    } catch (error) {
      event.returnValue = { ok: false, error: 'DRAG_FAILED', message: String(error.message || error) };
    } finally {
      // Electron has no cross-platform drop-completed callback. Keep only a bounded metadata
      // lease; user-owned files are NEVER deleted, including while/after the native drag runs.
      const timer = setTimeout(() => store.release(result.leaseId), 60000);
      if (timer.unref) timer.unref();
    }
  });
  return { authorize };
}
module.exports = { installAttachmentIpc };
