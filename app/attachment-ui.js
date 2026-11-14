(function (root) {
  'use strict';
  const errors = {
    EXPIRED: '附件授权已过期，请重新生成文件链接。', ATTACHMENT_NOT_FOUND: '附件已失效（应用重启后需要重新生成）。', NOT_FOUND: '附件已失效（应用重启后需要重新生成）。',
    FILE_NOT_FOUND: '文件已被移动或删除。', FILE_CHANGED: '文件已更改，请重新生成附件。',
    CROSS_SESSION: '附件不属于当前会话。', SESSION_MISMATCH: '附件不属于当前会话。', USER_GESTURE_REQUIRED: '请点击按钮或亲手拖动文件。',
    TYPE_NOT_ALLOWED: '此文件类型不允许直接打开或拖出。', UNSAFE_FILE_TYPE: '此文件类型不允许直接打开或拖出。', OPEN_FAILED: '系统无法打开此文件，请检查关联应用。',
  };
  function render(container, info) {
    if (!container || !info || typeof info.attachmentId !== 'string' || !info.sessionId) return null;
    if (Array.from(container.querySelectorAll('.f1-attachment-card')).some(c => c.dataset.attachmentId === info.attachmentId)) return null;
    const card = document.createElement('div');
    card.className = 'f1-attachment-card'; card.dataset.attachmentId = info.attachmentId;
    card.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;margin:8px 0;border:1px solid #64748b;border-radius:8px';
    const label = document.createElement('span'); label.textContent = '📄 ' + (info.name || '附件'); label.style.flex = '1';
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.style.cssText = 'width:100%;font-size:12px';
    const req = { attachmentId: info.attachmentId, sessionId: info.sessionId };
    const report = (result, successText) => { status.textContent = result && result.ok ? (successText || '操作已完成') : errors[result && result.error] || (result && result.message) || (result && result.error) || '文件操作失败'; };
    card.appendChild(label);
    for (const [text, method] of [['打开', 'open'], ['所在目录', 'showInFolder'], ['拖出文件', 'startDrag']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.style.cssText = 'cursor:pointer;padding:4px 8px';
      if (!root.whaleFile) { button.disabled = true; status.textContent = '文件操作仅支持桌面应用。'; }
      if (method === 'startDrag') {
        button.draggable = true;
        button.ondragstart = event => {
          if (!event.isTrusted || !root.whaleFile) { event.preventDefault(); return; }
          try {
            const result = root.whaleFile.startDrag(req); // synchronous in the native dragstart dispatch
            if (!result || !result.ok) event.preventDefault();
            report(result, '拖动已开始，请拖到目标窗口。');
          } catch (e) { event.preventDefault(); report({ message: e.message }); }
        };
        button.onclick = () => { status.textContent = '按住此按钮并拖到资源管理器或支持文件接收的窗口。'; };
      } else {
        button.onclick = async event => {
          if (!event.isTrusted || !root.whaleFile) return;
          try { report(await root.whaleFile[method](req), method === 'open' ? '已交给系统关联程序打开。' : '已在文件夹中定位。'); } catch (e) { report({ message: e.message }); }
        };
      }
      card.appendChild(button);
    }
    card.appendChild(status); container.appendChild(card); return card;
  }
  root.WhaleAttachments = Object.freeze({ render });
})(window);
