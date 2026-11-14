/**
 * WhaleCodex 工作台前端控制器
 *
 * 命名空间：.whale-workbench / .wb-*，不改动已验收主题根变量。
 * 关键隔离：侧聊有自己的 busy / abort / runId / history / stats，
 * 发送、停止、关闭、切页签都不触碰主任务的全局状态。
 */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);
  // 侧聊正文里的 http/https 链接可点击（DOM 净化：只创建文本节点与 <a>，不注入 HTML）
  function linkify(text) {
    const s = String(text == null ? '' : text);
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"'）】]+/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0]; a.textContent = m[0]; a.rel = 'noreferrer';
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }

  const S = {
    open: false, width: 360, activeTabId: null, tabs: [], drawer: false,
    panels: new Map(),       // tabId -> {el, type, ...}
    downloads: new Map(),    // downloadId -> latest server record (shared across panel rebuilds)
    side: new Map(),         // tabId -> 侧聊状态
    webSlot: null, ro: null, lastBounds: null,
    badgeTimer: null, lastSessionId: '',
    backendLayout: 'hidden', // 后端当前期望布局（docked/detached/hidden），由 state 轮询同步
  };
  // 工具窗模式：只渲染工作台，不加载主聊天脚本。
  // 既认 ?wb=1，也认独立页面路径（工具窗直接加载 workbench-window.html）。
  const STANDALONE = /(?:^|[?&])wb=1(?:&|$)/.test(location.search)
    || /workbench-window\.html$/i.test(location.pathname);

  function currentSessionId() {
    if (STANDALONE) return S.lastSessionId || '';
    try { return activeId || ''; } catch (e) { return ''; }
  }
  function currentModel() { try { return MODEL || ''; } catch (e) { return ''; } }
  function parentHistory() {
    try { return (history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || '') })); } catch (e) { return []; }
  }

  async function api(sub, opt) {
    const o = opt || {};
    const r = await fetch('/api/workbench/' + sub, {
      method: o.method || (o.body ? 'POST' : 'GET'),
      headers: o.body ? { 'Content-Type': 'application/json' } : {},
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (o.sse) return r;
    return r.json();
  }
  const post = (sub, body) => api(sub, { body: body || {} });

  function toast(msg) {
    try { if (typeof window.toast === 'function') return window.toast(msg); } catch (e) {}
    let t = $('#wbToast');
    if (!t) { t = document.createElement('div'); t.id = 'wbToast'; t.className = 'wb-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ===================== 布局：工作台在主聊天边界之外 =====================
   * 宽窗：作为 .app 的兄弟列停靠在主聊天右侧（不覆盖主输入/停止/统计）。
   * 窄窗：主窗口内不显示任何覆盖抽屉，改用独立工具窗。 */
  let toolWindowBusy = false;
  let lastToolCloseAt = 0;
  async function openToolWindow() {
    if (toolWindowBusy) return;
    toolWindowBusy = true;
    try { await post('window', { action: 'open' }); }
    catch (e) { toast('工具窗打开失败：' + e.message); }
    finally { setTimeout(() => { toolWindowBusy = false; }, 800); }
  }

  function layout() {
    const el = $('#workbench'), sp = $('#wbSplitter'), toggle = $('#hbWorkbench');
    if (!el) return;
    if (STANDALONE) {
      S.open = true;
      el.hidden = false;
      el.classList.remove('wb-drawer');
      el.style.width = '100%';
      if (sp) sp.hidden = true;
      document.documentElement.classList.add('wb-standalone');
      reportWebBounds();
      return;
    }
    if (!S.open) {
      el.hidden = true; if (sp) sp.hidden = true;
      document.documentElement.classList.remove('wb-on');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      hideWebForOverlay(true);
      return;
    }
    const sb = $('.sidebar');
    const sbw = sb ? Math.round(sb.getBoundingClientRect().width) : 264;
    const clientW = document.documentElement.clientWidth;
    const C = clientW - sbw;
    // 硬阈值：左导航 + 主聊天 560 + 间隔 6 + 工作台 320
    const canDock = C >= (560 + 6 + 320);
    if (!canDock) {
      el.hidden = true; if (sp) sp.hidden = true;
      document.documentElement.classList.remove('wb-on');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      hideWebForOverlay(true);
      openToolWindow();
      return;
    }
    // 宽窗停靠时关闭工具窗：同一工作台只保留一个活动视图，不复制线程。
    // 只有后端确实处于 detached（工具窗真的存在）时才发关闭——否则会把
    // 刚设成 docked 的状态又打回 hidden，导致「重开工作台永远打不开」。
    if (S.backendLayout === 'detached' && Date.now() - lastToolCloseAt > 1500) {
      lastToolCloseAt = Date.now();
      post('window', { action: 'close' }).catch(() => {});
    }
    let w = Math.min(S.width, 440, C - 560 - 6);
    w = Math.max(320, Math.round(w));
    el.hidden = false;
    el.classList.remove('wb-drawer');
    el.style.width = w + 'px';
    if (sp) sp.hidden = false;
    document.documentElement.classList.add('wb-on');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    reportWebBounds();
  }

  async function setOpen(open, opts) {
    S.open = !!open;
    // 先建默认页签再 layout：窄窗会立刻开工具窗，工具窗需要从 state 读到已有 tab。
    if (open && !S.tabs.length && !(opts && opts.noDefault)) {
      await addTab('side', '侧聊');
    }
    const sb = $('.sidebar');
    const sbw = sb ? Math.round(sb.getBoundingClientRect().width) : 264;
    const canDockNow = (document.documentElement.clientWidth - sbw) >= (560 + 6 + 320);
    // 若当前是「独立工具窗」承载，用户在主窗再打开工作台时，必须走真正的停靠迁移
    // （由后端做宽度校验 + 确认后关闭工具窗），否则会出现同一工作台两份视图、
    // 期望 layout=docked 而实际一直 detached 的不一致。
    if (S.open && S.backendLayout === 'detached' && canDockNow) {
      try {
        const r = await post('window', { action: 'dock' });
        if (r && r.ok) S.backendLayout = 'docked';
      } catch (e) {}
    }
    const want = S.open ? (canDockNow ? 'docked' : 'detached') : 'hidden';
    // 先把期望布局告诉后端，再按本地状态渲染：反过来会出现「layout() 先关工具窗 →
    // 后端把期望打成 hidden → 随后的 ui 又被下一次 reconcile 覆盖」的顺序竞争。
    S.backendLayout = want;
    try {
      await post('ui', {
        open: S.open, width: S.width, activeTabId: S.activeTabId, sessionId: currentSessionId(),
        layout: want,
      });
    } catch (e) {}
    layout();
    if (!open && !STANDALONE) { try { await post('window', { action: 'close' }); } catch (e) {} }
  }

  /* ===================== Tab 管理 ===================== */
  function tabTitle(t) {
    return ({ side: '侧聊', web: '网页', files: '文件', downloads: '下载', git: 'Git' })[t.type] || t.type;
  }
  function tabIcon(t) {
    return ({ side: '◈', web: '◉', files: '▤', downloads: '⇩', git: '⑂' })[t.type] || '▪';
  }
  const FUNCS = [
    { type: 'side', label: '侧聊', icon: '◈' },
    { type: 'web', label: '网页', icon: '◉' },
    { type: 'files', label: '文件', icon: '▤' },
    { type: 'downloads', label: '下载', icon: '⇩' },
    { type: 'git', label: 'Git', icon: '⑂' },
  ];
  function currentFunc() {
    const t = S.tabs.find((x) => x.id === S.activeTabId);
    return t ? t.type : 'side';
  }
  /** 第二行是固定功能导航，不再把每个侧聊线程挤成一排页签。 */
  function renderTabs() {
    const box = $('#wbTabs'); if (!box) return;
    box.innerHTML = '';
    const active = currentFunc();
    for (const f of FUNCS) {
      const b = document.createElement('button');
      b.className = 'wb-nav-btn' + (active === f.type ? ' on' : '');
      b.dataset.func = f.type;
      const cur = S.tabs.find((x) => x.id === S.activeTabId);
      if (active === f.type && cur) b.dataset.id = cur.id;
      b.title = f.label;
      b.setAttribute('aria-label', f.label);
      b.innerHTML = '<span class="wi">' + f.icon + '</span><span class="wt">' + f.label + '</span>';
      b.onclick = () => switchFunc(f.type);
      box.appendChild(b);
    }
    const name = $('#wbPanelName');
    if (name) {
      const f = FUNCS.find((x) => x.type === active);
      name.textContent = f ? f.label : '工作台';
    }
  }
  async function switchFunc(type) {
    const list = S.tabs.filter((t) => t.type === type);
    if (list.length) return focusTab(list[list.length - 1].id);
    return addTab(type, tabTitle({ type }));
  }
  // tabs 变化（新增/归档/关闭）后统一刷新所有已存在侧聊面板的选择器，
  // 否则旧面板看不到新实例，或仍列出已归档实例（缺陷 #6）。
  function refreshSidePickers() {
    for (const [, p] of S.panels) {
      if (p && typeof p.paintPick === 'function') { try { p.paintPick(); } catch (e) {} }
    }
  }
  async function addTab(type, title, resourceId) {
    let t;
    try { t = await post('tabs', { type, title: title || tabTitle({ type }), resourceId, sessionId: currentSessionId() }); }
    catch (e) { toast('新建页签失败：' + e.message); return null; }
    if (!t || t.error) { toast('新建页签失败：' + (t && t.error)); return null; }
    S.tabs.push(t); S.activeTabId = t.id;
    await buildPanel(t);
    // 新建后必须设为活动面板：否则面板保持 hidden，出现「有页签但无可见面板」。
    focusTab(t.id);
    refreshSidePickers();
    return t;
  }
  async function closeTab(id) {
    const t = S.tabs.find((x) => x.id === id);
    const p = S.panels.get(id);
    if (!t) return;
    if (t.type === 'web' && p && p.url) {
      try { await post('web/nav', { tabId: id, action: 'close' }); } catch (e) {}
    }
    if (p) {
      if (p.ro) { try { p.ro.disconnect(); } catch (e) {} }
      // 明确移除 DOM：只删 Map/数组会让已关闭面板继续留在页面上，
      // 用户看到的就是「关闭按钮没作用」。
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    const stx = S.side.get(id);
    if (stx) {
      if (stx.staleTimer) { try { clearInterval(stx.staleTimer); } catch (e) {} }
      if (stx.bgTimer) { try { clearInterval(stx.bgTimer); } catch (e) {} }
      // 关闭页签只退订事件流，不动 run（与「退订不影响执行」一致）
      if (typeof stx.stopAttach === 'function') { try { stx.stopAttach(); } catch (e) {} }
    }
    S.panels.delete(id); S.side.delete(id);
    S.tabs = S.tabs.filter((x) => x.id !== id);
    try { await post('tabs/close', { id }); } catch (e) {}
    if (S.activeTabId === id) {
      const sameFunc = S.tabs.filter((x) => x.type === t.type);
      S.activeTabId = sameFunc.length ? sameFunc[sameFunc.length - 1].id
        : (S.tabs.length ? S.tabs[S.tabs.length - 1].id : null);
    }
    if (S.activeTabId && S.panels.has(S.activeTabId)) focusTab(S.activeTabId);
    else { renderTabs(); showEmptyPanel(); }
    refreshSidePickers();
  }
  function showEmptyPanel() {
    const body = $('#wbBody');
    if (!body) return;
    body.querySelectorAll('.wb-empty-panel').forEach((e) => e.remove());
    if (body.querySelector('.wb-panel')) return;
    const d = document.createElement('div');
    d.className = 'wb-panel wb-empty-panel';
    d.innerHTML = '<div class="wb-empty">当前没有打开的页签。<br>用上方功能导航打开侧聊、网页、文件、下载或 Git。</div>';
    body.appendChild(d);
  }
  function focusTab(id) {
    S.activeTabId = id;
    const body = $('#wbBody');
    if (body) body.querySelectorAll('.wb-empty-panel').forEach((e) => e.remove());
    // 同一时刻只显示一个活动面板；其余不占布局、不接收指针。
    for (const [tid, p] of S.panels) if (p.el) p.el.hidden = tid !== id;
    renderTabs();
    try { post('ui', { activeTabId: id, sessionId: currentSessionId() }); } catch (e) {}
    // 切离网页时先收起原生视图，避免 WebContentsView 盖住侧聊/文件面板。
    const cur = S.panels.get(id);
    if (!cur || cur.type !== 'web') { post('web/visible', { visible: false }).catch(() => {}); }
    reportWebBounds();
  }

  /* ===================== 面板构建 ===================== */
  async function buildPanel(t) {
    const body = $('#wbBody'); if (!body) return;
    const el = document.createElement('div');
    el.className = 'wb-panel wb-panel-' + t.type;
    el.dataset.id = t.id; el.hidden = true;
    body.appendChild(el);
    const p = { el, type: t.type, tab: t };
    S.panels.set(t.id, p);
    if (t.type === 'side') await buildSidePanel(p);
    else if (t.type === 'web') buildWebPanel(p);
    else if (t.type === 'files') buildFilesPanel(p);
    else if (t.type === 'downloads') buildDownloadsPanel(p);
    else if (t.type === 'git') buildGitPanel(p);
    return p;
  }

  /* ---------- 侧聊：独立会话 + 不可变快照 ---------- */
  function snapVerText(snap) {
    if (!snap) return '版本未知';
    if (typeof snap.parentVersion !== 'number') return '版本未知（历史快照）';
    return '会话版本 ' + snap.parentVersion;
  }
  function sideMessages(st, question) {
    const snap = st.thread && st.thread.snapshot;
    const msgs = [];
    if (snap && snap.messageCount) {
      const lines = [
        '[父任务只读快照 · 截至 ' + snapVerText(snap)
          + ' · 快照 ' + snap.hash + ' · ' + new Date(snap.createdAt).toLocaleString() + ']',
        snap.boundary,
      ];
      if (snap.inFlight) lines.push('（父任务仍在执行：' + snap.inFlight.note + '）');
      lines.push('--- 快照开始 ---');
      for (const m of snap.messages) lines.push((m.role === 'user' ? '用户：' : '助手：') + m.content);
      lines.push('--- 快照结束 ---');
      msgs.push({ role: 'user', content: lines.join('\n') });
      msgs.push({ role: 'assistant', content: '已收到父任务只读快照。我会独立回答侧问；父任务由另一 run 继续执行，快照不是要求我重做父任务，未完成片段不会被当作已完成结果。' });
    }
    for (const m of st.history) msgs.push({ role: m.role, content: m.content });
    msgs.push({ role: 'user', content: question });
    return msgs;
  }

  // Keep native-file cards outside the replaceable Markdown body.
  function sideMessageBody(el) {
    if (!el.__messageBody) {
      const body = document.createElement('div'); body.className = 'wb-msg-body';
      while (el.firstChild) body.appendChild(el.firstChild);
      el.appendChild(body); el.__messageBody = body;
    }
    return el.__messageBody;
  }
  function renderSideAttachments(el, items) {
    if (!el || !Array.isArray(items)) return;
    sideMessageBody(el);
    el.__attachments = el.__attachments || [];
    for (const item of items) {
      if (!item || typeof item.attachmentId !== 'string' || !item.attachmentId || !item.sessionId) continue;
      if (el.__attachments.some(a => a.attachmentId === item.attachmentId)) continue;
      el.__attachments.push(item);
      if (!el.__attachmentHost) {
        el.__attachmentHost = document.createElement('div');
        el.__attachmentHost.className = 'wb-msg-attachments'; el.appendChild(el.__attachmentHost);
      }
      if (window.WhaleAttachments) window.WhaleAttachments.render(el.__attachmentHost, item);
    }
  }

  /* 助手消息：marked + DOMPurify 安全渲染；代码块带语言与复制按钮。 */
  function renderMarkdownInto(el, text, streaming) {
    el = sideMessageBody(el);
    const src = String(text || '');
    let html;
    try {
      if (window.marked && window.DOMPurify) {
        html = window.marked.parse(src, { breaks: true, gfm: true });
        html = window.DOMPurify.sanitize(html, {
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
          FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
          ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        });
      } else {
        html = esc(src).replace(/\n/g, '<br>');
      }
    } catch (e) { html = esc(src).replace(/\n/g, '<br>'); }
    el.innerHTML = html;
    el.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.querySelector('.wb-copy')) return;
      pre.classList.add('wb-code');
      const lang = (String(code.className).match(/language-([\w-]+)/) || [])[1] || 'code';
      const bar = document.createElement('div');
      bar.className = 'wb-code-bar';
      const lab = document.createElement('span');
      lab.className = 'wb-code-lang'; lab.textContent = lang;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'wb-copy'; btn.textContent = '复制';
      btn.title = '复制代码';
      btn.onclick = async () => {
        try { await navigator.clipboard.writeText(code.textContent || ''); btn.textContent = '已复制'; }
        catch (e) { btn.textContent = '复制失败'; }
        setTimeout(() => { btn.textContent = '复制'; }, 1600);
      };
      bar.appendChild(lab); bar.appendChild(btn);
      pre.insertBefore(bar, code);
    });
    el.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(h)) { a.target = '_blank'; a.rel = 'noreferrer'; }
      else a.removeAttribute('href');
    });
  }

  /* 侧聊统计：严格区分 running / missing / reported，缺失不写 0。 */
  function applySideStats(el, st) {
    if (!el || !st) return;
    const turn = st.turnOfThread || st.turn || 0;
    const su = st.sessionUsage || {};
    const sp = st.speed || {};
    const running = st.state === 'running';
    let speed;
    if (sp.measurable) speed = sp.tokensPerSec + ' tok/s';
    else if (sp.fallback) speed = '~' + sp.tokensPerSec + ' tok/s（含等待）';
    else if (running) speed = '生成中 · 等待用量回报';
    else speed = '速度不可测';
    let tok;
    if (typeof su.totalTokens === 'number' && su.totalTokens > 0) tok = '累计 ' + fmtK(su.totalTokens) + ' tok';
    else if (running) tok = '累计 — tok';
    else if ((su.missingRequests || 0) > 0) tok = '累计 — tok（上游未上报 ' + su.missingRequests + ' 次）';
    else tok = '累计 0 tok';
    el.textContent = turn + ' 轮 · ' + speed + ' · ' + tok;
    el.title = '本侧聊独立累计；输入 ' + (su.inputTokens == null ? '未上报' : fmtK(su.inputTokens))
      + ' · 输出 ' + (su.outputTokens == null ? '未上报' : fmtK(su.outputTokens))
      + (su.partial ? ' · 部分请求未上报' : '');
  }

  async function buildSidePanel(p) {
    let thread = null;
    try { const t = await api('threads?tabId=' + encodeURIComponent(p.tab.id), {}); if (t && !t.error) thread = t; } catch (e) {}
    if (!thread) {
      try { thread = await post('threads', { parentSessionId: currentSessionId(), messages: parentHistory(), model: currentModel(), tabId: p.tab.id }); }
      catch (e) { p.el.innerHTML = '<div class="wb-empty">创建侧聊失败：' + esc(e.message) + '</div>'; return; }
    }
    const st = {
      thread, busy: false, abort: null, runId: '', history: [], stats: null, node: null,
      // 同步态直接采信后端三态判定（synced / stale / unknown），前端不再自己猜。
      syncState: thread.syncState || 'unknown',
      runState: null, backgroundRun: null, bgSettled: false, statsRev: 0,
    };
    for (const m of (thread.messages || [])) {
      if (m && (m.role === 'user' || m.role === 'assistant')) {
        const attachments = m.role === 'assistant' && Array.isArray(m.attachments) ? m.attachments : [];
        if (String(m.content || '').trim() || attachments.length) {
          st.history.push({ role: m.role, content: String(m.content || ''), attachments });
        }
      }
    }
    S.side.set(p.tab.id, st);
    p.el.innerHTML =
      '<div class="wb-side-bar">' +
        '<label class="wb-side-pick-label" for="wbp-' + p.tab.id + '">当前侧聊</label>' +
        '<select class="wb-side-pick" id="wbp-' + p.tab.id + '" title="切换侧聊实例"></select>' +
        '<button class="wb-mini" data-a="new" title="新建侧聊">＋新侧聊</button>' +
        '<button class="wb-mini" data-a="archive" title="归档当前侧聊（只关视图，历史保留）">归档</button>' +
      '</div>' +
      '<div class="wb-sync-row">' +
        '<span class="wb-sync-text">主记忆：未同步</span>' +
        '<button class="wb-sync-btn" data-a="sync" aria-pressed="false" title="为下一次侧聊请求刷新父对话只读快照">' +
          '<span class="wb-sync-check">✓</span><span class="wb-sync-label">同步主记忆</span></button>' +
      '</div>' +
      '<div class="wb-side-log" id="wbsl-' + p.tab.id + '"></div>' +
      '<div class="wb-side-stats" id="wbss-' + p.tab.id + '">— 轮 · 速度不可测 · 累计 — tok</div>' +
      '<div class="wb-side-run" id="wbrun-' + p.tab.id + '" hidden></div>' +
      '<div class="wb-side-composer">' +
        '<textarea id="wbsi-' + p.tab.id + '" rows="2" placeholder="向侧聊提问（不打断主任务）"></textarea>' +
        '<div class="wb-side-actions">' +
          '<button class="wb-mini" data-a="stop" title="只停止本侧聊">停止本侧聊</button>' +
          '<button class="wb-mini primary" data-a="send">发送</button>' +
        '</div>' +
      '</div>';
    const log = $('#wbsl-' + p.tab.id, p.el);
    const input = $('#wbsi-' + p.tab.id, p.el);
    const statsEl = $('#wbss-' + p.tab.id, p.el);
    const pick = $('.wb-side-pick', p.el);
    st.node = log;
    // 草稿/滚动持久化（同源 localStorage，主窗与工具窗共享）：迁移窗口不丢草稿与滚动（缺陷 #4）。
    const draftKey = 'wb-draft:' + p.tab.id, scrollKey = 'wb-scroll:' + p.tab.id;
    try { const d = localStorage.getItem(draftKey); if (d) input.value = d; } catch (e) {}
    input.addEventListener('input', () => { try { localStorage.setItem(draftKey, input.value); } catch (e) {} });

    const paintPick = async () => {
      const sides = S.tabs.filter((t) => t.type === 'side');
      let archived = [];
      try {
        const j = await api('threads/list?sessionId=' + encodeURIComponent(st.thread.parentSessionId), {});
        if (j && Array.isArray(j.threads)) archived = j.threads.filter((t) => t.archived);
      } catch (e) {}
      let html = sides.map((t, i) => '<option value="' + t.id + '">' + esc('侧聊 ' + (i + 1)) + '</option>').join('');
      // 归档线程不删除：作为「选择即恢复」的历史入口列在同一选择器里（验收阻断项 4）。
      if (archived.length) {
        html += '<optgroup label="已归档（选择即恢复）">'
          + archived.map((t) => '<option value="arc:' + t.id + '">'
            + esc((t.title || '侧聊') + ' · v' + (t.snapshotVersions || 1)) + '</option>').join('')
          + '</optgroup>';
      }
      pick.innerHTML = html;
      pick.value = p.tab.id;
    };
    paintPick();
    p.paintPick = paintPick;   // 供 tabs 变化后统一刷新（缺陷 #6）
    pick.onchange = async () => {
      const v = pick.value;
      if (v && v.indexOf('arc:') === 0) {
        const r = await post('threads/restore', { id: v.slice(4) });
        if (r && r.ok && r.tab) {
          if (!S.tabs.find((x) => x.id === r.tab.id)) { S.tabs.push(r.tab); await buildPanel(r.tab); }
          focusTab(r.tab.id);
          refreshSidePickers();
          toast('已恢复归档侧聊（沿用原线程与快照）');
        } else {
          toast('恢复失败：' + ((r && r.error) || '未知错误'));
          paintPick();
        }
        return;
      }
      focusTab(v);
    };

    /* ---------- 主记忆同步：只读刷新 + 版本/哈希校验 + 幂等 ----------
     * 原则（对应指令 §一.2）：
     *   1) 绝不用本地历史伪装主记忆——同步只让后端读权威会话；
     *   2) 写请求必须带 parentVersion 或 parentContentHash，否则后端会（正确地）拒绝；
     *   3) 版本未知时如实显示，不把"未知"画成"已同步"；
     *   4) 冲突（stale / 哈希不符 / 版本超前）保留侧聊内容，不静默覆盖。 */
    st.master = {};          // 最近一次只读权威快照
    st.refreshing = false;
    st.conflictReason = '';

    const paintSync = () => {
      const snap = st.thread.snapshot || {};
      const btn = $('[data-a="sync"]', p.el);
      const txt = $('.wb-sync-text', p.el);
      if (!btn || !txt) return;
      const label = btn.querySelector('.wb-sync-label');
      const hasVer = typeof snap.parentVersion === 'number';
      const ver = hasVer ? ('会话版本 ' + snap.parentVersion) : '版本未知';
      const vers = st.thread.snapshotVersions || 1;
      const m = st.master || {};

      // ① 正在刷新
      if (st.refreshing) {
        btn.disabled = true;
        btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
        label.textContent = '刷新中…';
        txt.textContent = '主记忆：正在读取权威版本…';
        return;
      }
      btn.disabled = false;

      // ② 冲突待处理（stale / 哈希不符 / 版本超前）
      if (st.syncState === 'conflict') {
        btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
        label.textContent = '重新读取';
        txt.textContent = '主记忆：' + (st.conflictReason || '内容已变化')
          + ' · 侧聊内容已保留，请重新读取后再决定是否同步';
        return;
      }

      // ③ 已同步
      if (st.syncState === 'synced') {
        btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
        label.textContent = '已同步';
        txt.textContent = '主记忆：已同步到 ' + ver + ' · 快照 v' + vers
          + (st.thread.versionConsistent === false ? '（采集期间父会话有新内容）' : '');
        return;
      }

      // ④ 已有新内容
      if (st.syncState === 'stale') {
        btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
        label.textContent = '同步主记忆';
        const now = typeof st.thread.parentVersionNow === 'number'
          ? ('版本 ' + st.thread.parentVersionNow) : '版本未知';
        txt.textContent = '主记忆：已有新内容（快照 ' + ver + '，父会话现为 ' + now + '），点右侧同步';
        return;
      }

      // ⑤ 版本未知
      btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false');
      if (m && m.contentHash) {
        // 版本不可考但内容可读 → 允许按内容哈希校验同步，但绝不宣称"版本已确认"
        label.textContent = '同步主记忆';
        txt.textContent = hasVer
          ? ('主记忆：快照 ' + ver + '，可凭内容哈希 ' + String(m.hash || '').slice(0, 8) + ' 校验同步')
          : '主记忆：版本不可考（历史会话），可凭内容哈希校验同步';
      } else {
        btn.disabled = true;   // 连权威内容都读不到 → 明确不可写
        label.textContent = '同步主记忆';
        txt.textContent = '主记忆：版本未知（不可写）'
          + (m && m.error ? ' · ' + m.error : ' · 请刷新主会话后重试');
      }
    };
    st.paintSync = paintSync;

    /** 只读刷新：拿主会话权威版本 + 内容哈希。失败即返回 null（调用方不得发写请求）。 */
    const refreshMaster = async (silent) => {
      const sid = st.thread.parentSessionId;
      if (!sid) { st.master = { error: '缺少会话 id' }; return null; }
      if (!silent) { st.refreshing = true; paintSync(); }
      try {
        const m = await api('parent?sessionId=' + encodeURIComponent(sid) + '&threadId=main', {});
        if (m && m.error) throw new Error(m.detail || m.error);
        st.master = m || {};
        return m;
      } catch (e) {
        st.master = { error: String(e.message || e).slice(0, 120) };
        return null;
      } finally {
        if (!silent) { st.refreshing = false; paintSync(); }
      }
    };
    st.refreshMaster = refreshMaster;

    paintSync();
    // 首次打开就取一次权威快照：否则界面只能显示"版本未知"（原缺陷即由此而来）
    refreshMaster(true).then(() => paintSync());

    // 父记忆推进后转 stale：向后端核对权威版本（不是 run 局部 seq）。
    const refreshStale = async () => {
      try {
        const t = await api('threads?tabId=' + encodeURIComponent(p.tab.id), {});
        if (t && !t.error) {
          st.thread = t;
          // 冲突态由用户显式操作解除，不被轮询悄悄覆盖
          if (st.syncState !== 'conflict') st.syncState = t.syncState || 'unknown';
          paintSync();
        }
      } catch (e) {}
    };
    st.refreshStale = refreshStale;
    st.staleTimer = setInterval(refreshStale, 8000);

    /* 恢复：权威累计 + 运行态 + 未完成片段（验收阻断项 2）。
     * 三个必须做对的地方：
     *   1) 零轮次 / 零 token 也要应用快照，否则旧数字残留；
     *   2) 恢复 running 态要如实标注「后台运行 + 通过轮询同步片段」，不冒充恢复了流；
     *   3) 用本地 revision 丢弃迟到响应，避免旧快照覆盖新投影。 */
    const runEl = $('#wbrun-' + p.tab.id, p.el);
    const RUN_LABEL = { created: '已创建', running: '后台运行中', finished: '已完成', cancelled: '已停止', interrupted: '被中断', failed: '失败' };
    const paintRun = (info) => {
      if (!runEl) return;
      if (!info) { runEl.hidden = true; runEl.textContent = ''; return; }
      runEl.hidden = false;
      runEl.textContent = '上一轮：' + (RUN_LABEL[info.state] || info.state)
        + (info.source === 'persisted' ? '（重启前记录）' : '')
        + (info.state === 'running'
          ? (info.subscribable ? ' · 正在轮询片段' : ' · 无法续订，可刷新最终结果')
          : ' · 不可续订');
      runEl.title = info.runId ? ('runId ' + info.runId) : '';
    };
    const applyUsage = (usage, turn) => {
      st.stats = { turn: turn || 0, turnOfThread: turn || 0, sessionUsage: usage || {}, speed: {}, state: 'idle' };
      applySideStats(statsEl, st.stats);
    };

    const restoreState = async () => {
      const sid = st.thread.parentSessionId, tid = st.thread.threadId;
      if (!sid || !tid) return null;
      const revAtStart = st.statsRev || 0;
      try {
        const r = await fetch('/api/threads/state?sessionId=' + encodeURIComponent(sid)
          + '&threadId=' + encodeURIComponent(tid));
        const j = await r.json();
        if ((st.statsRev || 0) > revAtStart) return null;   // 期间已有更新的实时投影 → 丢弃
        if (!j || !j.ok) return null;
        applyUsage(j.usage, j.turn);                        // 零值也应用
        paintRun(j.latestRun || null);
        st.runState = j.latestRun || null;
        return j;
      } catch (e) { return null; }
    };
    st.restoreState = restoreState;

    // 后台 run 片段轮询：明确标注这是轮询同步，不是续订流。
    const bgNodeFor = () => {
      let n = $('.wb-bg-run', p.el);
      if (!n) { n = document.createElement('div'); n.className = 'wb-msg ai wb-bg-run'; log.appendChild(n); }
      return n;
    };
    const dropBgNode = () => { const n = $('.wb-bg-run', p.el); if (n && n.parentNode) n.parentNode.removeChild(n); };
    /* 活跃 run 续订（第五轮）：快照初值 + afterSeq 游标订阅。
     * 只有 window.WhaleTextStream 不可用（脚本没加载/被关）时才退回 2s 轮询降级路径。 */
    const TS = window.WhaleTextStream;
    let sseAbort = null;
    const stopAttach = () => { if (sseAbort) { try { sseAbort.abort(); } catch (e) {} sseAbort = null; } };
    st.stopAttach = stopAttach;

    const paintStream = (state, note) => {
      const head = state.truncated ? '> （更早内容已折叠，仅显示最近部分）\n\n' : '';
      renderMarkdownInto(bgNodeFor(), head + state.text + (note ? '\n\n' + note : ''), !note);
    };

    const attachRun = async (lr) => {
      if (!TS || !lr || !lr.runId) return false;
      stopAttach();
      let state = TS.init(null);
      try {
        const r = await fetch('/api/runs/' + encodeURIComponent(lr.runId) + '/text');
        if (r.ok) {
          const snap = await r.json();
          if (snap && snap.ok) {
            state = TS.fromSnapshot(snap);
            if (state.text) paintStream(state, '> （该轮在后台运行：已按事件游标接上，不是轮询快照）');
          }
        }
      } catch (e) {}
      const afterSeq = typeof lr.lastSeq === 'number' ? lr.lastSeq : 0;
      sseAbort = new AbortController();
      try {
        const res = await fetch('/api/runs/' + encodeURIComponent(lr.runId)
          + '/events?afterSeq=' + afterSeq, { signal: sseAbort.signal });
        if (!res.ok || !res.body) return false;
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          buf += dec.decode(step.value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (line.indexOf('data:') !== 0) continue;
              let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
              if (j.type === 'stream.delta') {
                // 只拼正文：推理通道不是答案，混进来会让气泡变成思考稿
                if (!TS.isContent(j.payload)) continue;
                const ap = TS.apply(state, j.payload);
                if (ap.action === 'append') {
                  state = ap.state;
                  paintStream(state, '> （该轮在后台运行：按事件游标实时续订）');
                } else if (ap.action === 'reset') {
                  state = ap.state;
                } else if (ap.action === 'repair') {
                  // 缺帧/重叠：拉一次后端快照整体替换，绝不猜、不拼接
                  try {
                    const rr = await fetch('/api/runs/' + encodeURIComponent(lr.runId) + '/text');
                    const sn = await rr.json();
                    if (sn && sn.ok) { state = TS.fromSnapshot(sn); paintStream(state, '> （检测到缺帧，已用后端快照整体修复）'); }
                  } catch (e) {}
                }
                continue;
              }
              if (j.type === 'attachment.ready' && j.payload && Array.isArray(j.payload.attachments)) {
                renderSideAttachments(bgNodeFor(), j.payload.attachments);
                continue;
              }
              if (j.type === 'run.finished' || j.type === 'run.failed'
                || j.type === 'run.cancelled' || j.type === 'run.interrupted') {
                const tail = j.type.replace('run.', '');
                renderMarkdownInto(bgNodeFor(),
                  (state.truncated ? '> （更早内容已折叠）\n\n' : '') + state.text
                  + '\n\n> （该轮已结束：' + (RUN_LABEL[tail] || tail) + '）', false);
                st.backgroundRun = null; st.bgSettled = true;
                stopAttach();
                st.statsRev = (st.statsRev || 0) + 1;
                if (typeof st.restoreState === 'function') st.restoreState();
                return true;
              }
            }
          }
        }
      } catch (e) { /* abort 或断流：保持当前文本，重新打开面板会再次 attach */ }
      return true;
    };
    st.attachRun = attachRun;

    if (!TS) {
      // 降级路径：没有 text-stream.js 时维持旧的 2s 轮询（不删，便于回滚）
      st.bgTimer = setInterval(async () => {
        if (st.busy || !st.thread) return;
        const j = await restoreState();
        if (!j || !j.latestRun) { dropBgNode(); st.backgroundRun = null; return; }
        const lr = j.latestRun;
        if (lr.state === 'running') {
          st.backgroundRun = lr;
          if (lr.partialText) {
            renderMarkdownInto(bgNodeFor(),
              lr.partialText + '\n\n> （该轮在后台运行，本面板按 2s 轮询同步片段，不是续订事件流；完整结果以终态为准）', true);
          }
          return;
        }
        if (!st.bgSettled) {
          st.bgSettled = true;
          st.backgroundRun = null;
          if (lr.partialText) {
            renderMarkdownInto(bgNodeFor(), lr.partialText + '\n\n> （后台 run 已结束：' + (RUN_LABEL[lr.state] || lr.state) + '，以上为结束时收到的正文）', false);
          } else {
            dropBgNode();
          }
        }
      }, 2000);
    }

    restoreState().then((j) => {
      const lr = j && j.latestRun;
      if (!lr || lr.state !== 'running') return;
      st.backgroundRun = lr;
      // 可续订 → 走事件游标；不可续订（如重启前遗留）→ 如实说明只能等终态
      if (TS && lr.subscribable) { attachRun(lr); return; }
      if (lr.partialText) {
        renderMarkdownInto(bgNodeFor(),
          lr.partialText + '\n\n> （该轮在后台运行，但当前实例无法续订事件流；本面板按 2s 轮询片段，完整结果以终态为准）', true);
      }
    });

    const addMsg = (role, text, streaming) => {
      const d = document.createElement('div');
      d.className = 'wb-msg ' + (role === 'user' ? 'user' : 'ai');
      if (role === 'assistant') renderMarkdownInto(d, text, !!streaming);
      else d.appendChild(document.createTextNode(String(text || '')));
      log.appendChild(d); log.scrollTop = log.scrollHeight;
      return d;
    };
    for (const m of st.history) {
      const node = addMsg(m.role, m.content, false);
      if (m.role === 'assistant') renderSideAttachments(node, m.attachments);
    }
    // 恢复滚动位置（迁移窗口后不跳回顶部）
    try { const sv = Number(localStorage.getItem(scrollKey)); if (sv > 0) log.scrollTop = sv; } catch (e) {}
    log.addEventListener('scroll', () => { try { localStorage.setItem(scrollKey, String(log.scrollTop)); } catch (e) {} });
    p.addMsg = addMsg;

    $('[data-a="send"]', p.el).onclick = () => sideSend(p.tab.id, input.value.trim());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sideSend(p.tab.id, input.value.trim()); }
    });
    $('[data-a="stop"]', p.el).onclick = () => sideStop(p.tab.id);
    $('[data-a="new"]', p.el).onclick = () => addTab('side', '侧聊');
    $('[data-a="archive"]', p.el).onclick = () => {
      if (!confirm('归档当前侧聊？只关闭视图，线程历史保留。')) return;
      closeTab(p.tab.id);
    };
    $('[data-a="sync"]', p.el).onclick = async () => {
      const btn = $('[data-a="sync"]', p.el);
      if (btn.disabled) return;
      const prevState = st.syncState;   // 失败时恢复到同步前状态，绝不写成「已同步」

      // ① 强制刷新权威快照：拿不到就不发写请求（指令 §一.3.3）
      const m = await refreshMaster(false);
      if (!m) {
        toast('同步失败：无法读取主会话（' + ((st.master && st.master.error) || '未知原因') + '），未发起写入');
        return;
      }

      btn.disabled = true;
      btn.querySelector('.wb-sync-label').textContent = '同步中…';
      // ② 幂等键：同一次点击重试不会产生两份主记忆
      const reqId = 'sync-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

      try {
        // ③ 不提交客户端历史：同步只让后端读权威会话，避免"本地快照伪装主记忆"。
        //    带 parentVersion（可考时）+ parentContentHash（始终带）供服务端校验。
        const t = await post('threads/sync', {
          id: st.thread.id,
          parentSessionId: st.thread.parentSessionId,
          parentVersion: typeof m.currentVersion === 'number' ? m.currentVersion : undefined,
          parentContentHash: m.contentHash,
          requestId: reqId,
        });

        // ④ 冲突：保留侧聊内容，给出明确处置提示，绝不静默覆盖
        if (t && t.error) {
          if (t.error === 'stale_client_content' || t.error === 'content_hash_mismatch'
            || t.error === 'parent_version_ahead') {
            st.syncState = 'conflict';
            st.conflictReason = String(t.detail || t.error).slice(0, 80);
            paintSync();
            toast('主记忆已变化，未覆盖：' + st.conflictReason);
            return;
          }
          throw new Error(t.detail || t.error);
        }

        st.thread = t;
        st.syncState = t.syncState || 'unknown';
        st.conflictReason = '';

        // ⑤ 用服务端回传的新版本/新哈希更新本地，不再靠猜
        if (t.syncResult) {
          st.master = Object.assign({}, st.master, {
            currentVersion: t.syncResult.parentVersion,
            contentHash: t.syncResult.contentHash,
            hash: t.syncResult.hash,
            versionKnown: t.syncResult.versionKnown,
            source: t.syncResult.source,
          });
        }
        paintSync();

        const sr = t.syncResult || {};
        const sv = typeof sr.parentVersion === 'number'
          ? ('会话版本 ' + sr.parentVersion) : '版本不可考（历史会话）';
        toast('已同步：' + sv
          + '（来源 ' + (sr.source === 'disk' ? '服务端会话' : '客户端历史') + '）'
          + (sr.replayed ? ' · 幂等重放' : '')
          + '，下一次提问生效');
      } catch (e) {
        st.syncState = prevState; paintSync();   // 保持原状态，label/aria 由 paintSync 统一
        toast('同步失败：' + e.message);
      } finally { btn.disabled = false; }
    };
  }

  async function sideSend(tabId, text) {
    const st = S.side.get(tabId);
    const p = S.panels.get(tabId);
    if (!st || !p || !text || st.busy) return;
    st.busy = true; st.abort = new AbortController(); st.runId = '';
    st.backgroundRun = null; st.bgSettled = false;
    const oldBg = $('.wb-bg-run', p.el); if (oldBg && oldBg.parentNode) oldBg.parentNode.removeChild(oldBg);
    p.addMsg('user', text, false);
    const input = $('#wbsi-' + tabId, p.el); if (input) input.value = '';
    try { localStorage.removeItem('wb-draft:' + tabId); } catch (e) {}
    const aiNode = p.addMsg('assistant', '', true);
    const statsEl = $('#wbss-' + tabId, p.el);
    const log = st.node;
    let acc = '', paintAt = 0, timer = null;
    const paint = (force) => {
      const now = Date.now();
      if (!force && now - paintAt < 120) {
        if (!timer) timer = setTimeout(() => { timer = null; paint(true); }, 120);
        return;
      }
      paintAt = now;
      renderMarkdownInto(aiNode, acc, !force);
      if (log) log.scrollTop = log.scrollHeight;
    };
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: st.abort.signal,
        body: JSON.stringify({
          messages: sideMessages(st, text), model: st.thread.model || currentModel(),
          thinkingDepth: 'minimal', sessionId: st.thread.parentSessionId,
          threadId: st.thread.threadId,
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            if (ev.run && ev.run.runId) st.runId = ev.run.runId;
            if (ev.delta) { acc += ev.delta; paint(false); }
            if (Array.isArray(ev.attachments)) renderSideAttachments(aiNode, ev.attachments);
            if (ev.stats) { st.stats = ev.stats; st.statsRev = (st.statsRev || 0) + 1; applySideStats(statsEl, ev.stats); }
            if (ev.error) {
              const msg = typeof ev.error === 'string' ? ev.error : (ev.error.message || '');
              acc += '\n\n> ⚠ ' + msg;
              paint(true);
            }
          }
        }
      }
      paint(true);
      const answer = acc || '（无输出）';
      const attachments = aiNode.__attachments || [];
      st.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer, attachments });
      try { await post('threads/message', { id: st.thread.id, role: 'user', content: text }); } catch (e) {}
      try { await post('threads/message', { id: st.thread.id, role: 'assistant', content: answer, attachments }); } catch (e) {}
    } catch (e) {
      if (e.name === 'AbortError') {
        if (acc) renderMarkdownInto(aiNode, acc + '\n\n> （已停止，未完成）', false);
        else aiNode.textContent = '（本侧聊已停止）';
        if (acc) {
          const attachments = aiNode.__attachments || [];
          st.history.push({ role: 'user', content: text }, { role: 'assistant', content: acc + '\n\n（已停止，未完成）', attachments });
          try { await post('threads/message', { id: st.thread.id, role: 'user', content: text }); } catch (x) {}
          try { await post('threads/message', { id: st.thread.id, role: 'assistant', content: acc + '\n\n（已停止，未完成）', attachments }); } catch (x) {}
        }
      } else {
        renderMarkdownInto(aiNode, '> 侧聊失败：' + e.message, false);
      }
    } finally {
      st.busy = false; st.abort = null;
      if (timer) { clearTimeout(timer); timer = null; }
    }
  }

  /* 停止：只取消本侧聊的 run。终态不靠固定延时猜测，而是按 runId 轮询到终态再取最终投影。
   * 取消是异步的：上游可能还有最后一个 usage 帧在路上，固定 250ms 会漏掉最终统计。 */
  async function sideStop(tabId) {
    const st = S.side.get(tabId); if (!st) return;
    const runId = st.runId;
    if (st.abort) { try { st.abort.abort(); } catch (e) {} }
    if (runId) fetch('/api/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' }).catch(() => {});
    st.busy = false;
    toast('已停止该侧聊，主任务继续运行');
    const p = S.panels.get(tabId);
    if (!p) return;
    const TERMINAL = { finished: 1, cancelled: 1, interrupted: 1, failed: 1 };
    const t0 = Date.now();
    let state = null;
    if (runId) {
      // 最多等 8 秒；每 200ms 查一次，拿到终态立即停止。
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch('/api/runs/' + encodeURIComponent(runId));
          if (r.ok) {
            const j = await r.json();
            state = j && j.run ? j.run.state : null;
            if (state && TERMINAL[state]) break;
          }
        } catch (e) {}
        await new Promise((res) => setTimeout(res, 200));
      }
    }
    st.statsRev = (st.statsRev || 0) + 1;
    if (typeof st.restoreState === 'function') await st.restoreState();
    const runEl = $('#wbrun-' + tabId, p.el);
    if (runEl) {
      runEl.hidden = false;
      runEl.textContent = state && TERMINAL[state]
        ? ('上一轮：' + ({ finished: '已完成', cancelled: '已停止', interrupted: '被中断', failed: '失败' }[state])
           + ' · 最终统计已取回（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）')
        : '上一轮：已请求停止，但 8 秒内未确认终态；可点「刷新最终结果」再取一次';
    }
  }

  /* ---------- 网页 Tab：主进程 WebContentsView ---------- */
  function buildWebPanel(p) {
    p.el.innerHTML =
      '<div class="wb-bar">' +
        '<button class="wb-mini" data-a="back">←</button><button class="wb-mini" data-a="forward">→</button>' +
        '<button class="wb-mini" data-a="reload">↻</button>' +
        '<input class="wb-url" placeholder="https://…（在应用内网页页签打开）">' +
        '<button class="wb-mini primary" data-a="go">打开</button>' +
        '<button class="wb-mini" data-a="read" title="交给模型后台阅读，不弹网页">后台阅读</button>' +
      '</div>' +
      '<div class="wb-read-note">桌面内嵌网页由主进程 WebContentsView 承载（独立 session，不注入主 UI 令牌）。点击聊天里的链接也会打开这里。</div>' +
      '<div class="wb-web-slot" id="wbweb-' + p.tab.id + '"><div class="wb-web-hint">输入网址或点击聊天中的链接</div></div>' +
      '<pre class="wb-read-out" hidden></pre>';
    const input = $('.wb-url', p.el), out = $('.wb-read-out', p.el);
    const slot = $('#wbweb-' + p.tab.id, p.el);
    p.slot = slot;
    const go = async () => {
      const url = input.value.trim(); if (!url) return;
      const r = await post('web/open', { tabId: p.tab.id, url, bounds: slotBounds(slot) });
      if (r.error) return toast(r.error);
      p.url = url; reportWebBounds();
    };
    $('[data-a="go"]', p.el).onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    for (const a of ['back', 'forward', 'reload']) {
      $('[data-a="' + a + '"]', p.el).onclick = () => post('web/nav', { tabId: p.tab.id, action: a }).catch(() => {});
    }
    $('[data-a="read"]', p.el).onclick = async () => {
      const url = input.value.trim(); if (!url) return;
      out.hidden = false; out.textContent = '后台读取中…';
      const d = await post('web/read', { url, maxChars: 6000 });
      out.textContent = d.error ? ('读取失败：' + d.error)
        : ['最终 URL: ' + d.finalUrl, '状态: ' + d.status + ' · 获取时间: ' + d.fetchedAt,
           '来源: ' + d.sourceKind + ' · 截断: ' + (d.truncated ? '是' : '否'), '', d.text].join('\n');
    };
    if (p.tab.url) {
      // 重启后 WebContentsView 是内存态，需要按持久化的 URL 重新挂载。
      p.url = p.tab.url; input.value = p.tab.url;
      post('web/open', { tabId: p.tab.id, url: p.tab.url, bounds: slotBounds(slot) }).catch(() => {});
    }
    const ro = new ResizeObserver(() => reportWebBounds());
    ro.observe(slot); p.ro = ro;
  }
  function slotBounds(slot) {
    if (!slot) return null;
    const r = slot.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function activeWebPanel() {
    const p = S.panels.get(S.activeTabId);
    return p && p.type === 'web' && !p.el.hidden ? p : null;
  }
  function overlayVisible() {
    const sels = ['.set-modal:not([hidden])', '.rs-pop:not([hidden])', '.rs-scope.is-open', '#btnModel.is-open'];
    return sels.some((s) => { const e = $(s); return e && e.getBoundingClientRect().width > 4; });
  }
  function reportWebBounds() {
    if (!S.open) return;
    const p = activeWebPanel();
    if (!p || !p.slot || !p.url || overlayVisible()) { post('web/visible', { visible: false }).catch(() => {}); return; }
    const b = slotBounds(p.slot);
    if (!b || b.width < 20 || b.height < 20) return;
    S.lastBounds = b;
    post('web/visible', { visible: true }).catch(() => {});
    post('web/bounds', { tabId: p.tab.id, bounds: b }).catch(() => {});
  }
  function hideWebForOverlay(force) {
    if (force || overlayVisible()) post('web/visible', { visible: false }).catch(() => {});
  }

  /* ---------- 文件 Tab ---------- */
  function buildFilesPanel(p) {
    p.el.innerHTML =
      '<div class="wb-bar"><input class="wb-dir" placeholder="目录（需在 Agent 白名单内）"><button class="wb-mini" data-a="ls">浏览</button>' +
      '<button class="wb-mini" data-a="up">上级</button></div>' +
      '<div class="wb-split"><div class="wb-tree"></div><div class="wb-preview">' +
        '<div class="wb-file-head"><span class="wb-file-name">未选择文件</span>' +
        '<button class="wb-mini primary" data-a="save" hidden>保存</button></div>' +
        '<textarea class="wb-file-text" spellcheck="false" hidden></textarea>' +
        '<div class="wb-file-view"></div></div></div>' +
      '<div class="wb-foot-note">仅显示 Agent 根目录白名单内的文件；保存带版本校验，冲突时要求刷新。</div>';
    const dirIn = $('.wb-dir', p.el), tree = $('.wb-tree', p.el), view = $('.wb-file-view', p.el);
    const ta = $('.wb-file-text', p.el), saveBtn = $('[data-a="save"]', p.el), nameEl = $('.wb-file-name', p.el);
    p.dir = ''; p.file = null; p.version = ''; p.dirty = false;
    // 浏览器环境没有 Node 的 path 模块，按目录分隔符自行拼接。
    const join = (d, n) => (d.endsWith('\\') || d.endsWith('/') ? d + n : d + (d.includes('\\') ? '\\' : '/') + n);
    const ls = async (dir) => {
      const j = await api('files?dir=' + encodeURIComponent(dir || ''), {});
      if (j.error) { tree.innerHTML = '<div class="wb-empty">' + esc(j.error) + '</div>'; return; }
      p.dir = j.dir; dirIn.value = j.dir;
      tree.innerHTML = '';
      for (const e of j.entries) {
        const d = document.createElement('div');
        d.className = 'wb-tree-row ' + e.type;
        d.textContent = (e.type === 'dir' ? '▸ ' : '· ') + e.name + (e.type === 'file' ? '  (' + fmtK(e.size) + 'B)' : '');
        d.onclick = () => e.type === 'dir' ? ls(join(j.dir, e.name)) : openFile(join(j.dir, e.name));
        tree.appendChild(d);
      }
      if (!j.entries.length) tree.innerHTML = '<div class="wb-empty">空目录</div>';
    };
    p.ls = ls;
    const openFile = async (f) => {
      const j = await api('file?path=' + encodeURIComponent(f), {});
      ta.hidden = true; saveBtn.hidden = true; view.innerHTML = '';
      if (j.error) { nameEl.textContent = j.name || '无法预览'; view.innerHTML = '<div class="wb-empty">' + esc(j.error) + '</div>'; return; }
      nameEl.textContent = j.name + ' · ' + fmtK(j.size) + 'B';
      p.file = f; p.dirty = false;
      if (j.kind === 'text') {
        p.version = j.version; ta.hidden = false; saveBtn.hidden = false; ta.value = j.text;
        ta.oninput = () => { p.dirty = true; saveBtn.textContent = '保存 *'; };
      } else if (j.kind === 'image') {
        const im = document.createElement('img'); im.src = 'data:' + j.mime + ';base64,' + j.data;
        im.className = 'wb-img'; view.appendChild(im);
      } else {
        view.innerHTML = '<div class="wb-empty">' + esc(j.note || '该类型预览未实现') + '</div>';
      }
    };
    $('[data-a="ls"]', p.el).onclick = () => ls(dirIn.value.trim());
    $('[data-a="up"]', p.el).onclick = () => {
      const d = p.dir || '';
      const up = d.replace(/[\\/][^\\/]+[\\/]?$/, '');
      ls(up || d);
    };
    saveBtn.onclick = async () => {
      if (!p.file) return;
      const r = await api('file', { method: 'PUT', body: { path: p.file, text: ta.value, version: p.version } });
      if (r.error) return toast(r.error);
      p.version = r.version; p.dirty = false; saveBtn.textContent = '保存'; toast('已保存');
    };
    p.ls = ls; p.join = join;
    ls('');
  }

  /* ---------- 下载 Tab ---------- */
  function acceptDownloads(records) {
    if (!Array.isArray(records)) return;
    const terminal = status => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
    for (const record of records) {
      const id = record && (record.id || record.download);
      if (typeof id !== 'string' || !id) continue;
      const old = S.downloads.get(id);
      // A delayed state poll must not roll a completed SSE record back to progress.
      if (old && terminal(old.status) && !terminal(record.status)) continue;
      if (old && !terminal(record.status) && Number(record.receivedBytes || 0) < Number(old.receivedBytes || 0)) continue;
      const merged = Object.assign({}, old || {}, record, { id });
      S.downloads.set(id, merged);
      for (const panel of S.panels.values()) if (panel.type === 'downloads' && panel.renderDownload) panel.renderDownload(merged);
    }
  }
  function renderDownloadRecord(list, rows, record) {
    let row = rows.get(record.id);
    if (!row) {
      const el = document.createElement('div'); el.className = 'wb-dl-record'; el.dataset.downloadId = record.id;
      const summary = document.createElement('div'); summary.style.whiteSpace = 'pre-wrap';
      const host = document.createElement('div'); host.className = 'wb-dl-attachments';
      const notice = document.createElement('div'); notice.className = 'wb-dl-err';
      el.appendChild(summary); el.appendChild(host); el.appendChild(notice); list.appendChild(el);
      row = { el, summary, host, notice, attachmentId: null }; rows.set(record.id, row);
    }
    if (record.status === 'completed') {
      row.summary.className = 'wb-dl-ok';
      row.summary.textContent = '✓ 完成\n文件：' + (record.attachment && record.attachment.name || record.path && record.path.split(/[\\/]/).pop() || '下载文件')
        + '\n大小：' + (record.size == null ? '未知' : record.size + ' B') + '\nSHA256：' + (record.sha256 || '未知');
      row.notice.textContent = !record.attachment && record.attachmentError ? '文件已保存，但附件操作未启用：' + record.attachmentError : '';
      if (record.attachment && row.attachmentId !== record.attachment.attachmentId && window.WhaleAttachments) {
        row.host.textContent = ''; window.WhaleAttachments.render(row.host, record.attachment);
        row.attachmentId = record.attachment.attachmentId;
      }
    } else {
      row.summary.className = ['failed', 'cancelled', 'interrupted'].includes(record.status) ? 'wb-dl-err' : '';
      row.summary.textContent = (record.status || 'requested') + ' · ' + fmtK(record.receivedBytes || 0) + 'B'
        + (record.totalBytes ? ' / ' + fmtK(record.totalBytes) + 'B' : '（长度未知，不伪造百分比）')
        + (record.error ? '\n' + record.error : '');
    }
  }
  function buildDownloadsPanel(p) {
    p.el.innerHTML =
      '<div class="wb-form">' +
        '<label>下载 URL</label><input class="wb-dl-url" placeholder="https://…/file.zip">' +
        '<label>目标目录（Agent 白名单内）</label><input class="wb-dl-dir" placeholder="留空使用默认目录">' +
        '<label>文件名（可选）</label><input class="wb-dl-name" placeholder="自动从 URL / Content-Disposition 推断">' +
        '<button class="wb-mini primary" data-a="dl">开始下载</button>' +
        '<button class="wb-mini" data-a="cancel">取消</button>' +
      '</div>' +
      '<div class="wb-dl-list"></div>';
    const url = $('.wb-dl-url', p.el), dir = $('.wb-dl-dir', p.el), name = $('.wb-dl-name', p.el);
    const list = $('.wb-dl-list', p.el);
    const rows = new Map();
    p.renderDownload = record => renderDownloadRecord(list, rows, record);
    for (const record of S.downloads.values()) p.renderDownload(record);
    const start = $('[data-a="dl"]', p.el);
    start.onclick = async () => {
      const u = url.value.trim(); if (!u) return;
      start.disabled = true;
      try {
      const res = await fetch('/api/workbench/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u, dir: dir.value.trim(), filename: name.value.trim(), sessionId: currentSessionId() }),
      });
      if (!res.ok || !res.body) throw new Error('下载请求失败：HTTP ' + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            if (ev.download) { p.dlId = ev.download; acceptDownloads([ev]); }
            else if (ev.error) toast(String(ev.error));
          }
        }
      }
      } catch (e) { toast('下载失败：' + String(e.message || e)); }
      finally { start.disabled = false; }
    };
    $('[data-a="cancel"]', p.el).onclick = async () => {
      if (!p.dlId) return toast('当前没有可取消的下载');
      const j = await post('download/cancel', { id: p.dlId });
      toast(j.ok ? '已取消该下载' : (j.error || '下载已结束'));
    };
  }

  /* ---------- Git Tab ---------- */
  function buildGitPanel(p) {
    p.el.innerHTML =
      '<div class="wb-bar"><input class="wb-git-dir" placeholder="仓库目录"><button class="wb-mini" data-a="status">status</button>' +
      '<button class="wb-mini" data-a="diff">diff --stat</button></div>' +
      '<div class="wb-form wb-git-write">' +
        '<label>路径（逗号分隔；留空=全部）</label><input class="wb-git-paths" placeholder="src/a.js, README.md">' +
        '<label>提交信息（仅提交时使用）</label><input class="wb-git-msg" placeholder="fix: 说明这次改动">' +
        '<div class="wb-git-btns">' +
          '<button class="wb-mini" data-a="stage">暂存</button>' +
          '<button class="wb-mini" data-a="unstage">取消暂存</button>' +
          '<button class="wb-mini primary" data-a="commit">提交</button>' +
        '</div>' +
      '</div>' +
      '<pre class="wb-git-out"></pre>' +
      '<div class="wb-foot-note">status / diff 只读直接执行；暂存与提交需要你点击按钮并二次确认，路径限制在仓库内，不自动提交。</div>';
    const dir = $('.wb-git-dir', p.el), out = $('.wb-git-out', p.el);
    const pathsIn = $('.wb-git-paths', p.el), msgIn = $('.wb-git-msg', p.el);
    const run = async (action) => {
      out.textContent = '读取中…';
      const j = await api('git?dir=' + encodeURIComponent(dir.value.trim()) + '&action=' + action, {});
      out.textContent = j.error ? ('错误：' + j.error) : (j.output || '（无变更）');
    };
    const write = async (action) => {
      const paths = pathsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (action === 'commit') {
        if (!msgIn.value.trim()) return toast('请填写提交信息');
        if (!confirm('确认提交到 ' + (dir.value.trim() || '当前目录') + ' ？\n\n' + msgIn.value.trim())) return;
      }
      out.textContent = '执行中…';
      const r = await post('git/write', { dir: dir.value.trim(), action, paths, message: msgIn.value.trim() });
      out.textContent = r.ok ? (r.output || '完成') : ('失败：' + (r.error || ''));
      if (r.ok) toast('已' + ({ stage: '暂存', unstage: '取消暂存', commit: '提交' }[action] || action));
    };
    $('[data-a="status"]', p.el).onclick = () => run('status');
    $('[data-a="diff"]', p.el).onclick = () => run('diff');
    $('[data-a="stage"]', p.el).onclick = () => write('stage');
    $('[data-a="unstage"]', p.el).onclick = () => write('unstage');
    $('[data-a="commit"]', p.el).onclick = () => write('commit');
  }

  /* ===================== 链接点击委托 ===================== */
  function onLinkClick(e) {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (!a) return;
    if (a.closest('pre, code')) return;                              // 代码块内不拦截
    if (a.closest('.wb-panel') && !a.closest('.wb-side-log')) return; // 工作台内部链接不拦截，侧聊正文除外
    let href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault(); e.stopPropagation();
    openLinkInWeb(href);
  }
  async function openLinkInWeb(url) {
    if (!S.open) await setOpen(true, { noDefault: true });
    let t = S.tabs.find((x) => x.type === 'web' && x.id === S.activeTabId);
    if (!t) t = S.tabs.find((x) => x.type === 'web');
    if (!t) t = await addTab('web', '网页');
    if (!t) return;
    focusTab(t.id);
    const p = S.panels.get(t.id);
    const inp = p && $('.wb-url', p.el);
    if (inp) inp.value = url;
    const r = await post('web/open', { tabId: t.id, url, bounds: slotBounds(p && p.slot) });
    if (r.error) return toast(r.error);
    p.url = url; t.url = url; t.title = url.replace(/^https?:\/\//, '').slice(0, 28);
    renderTabs(); reportWebBounds();
  }

  /* ===================== 分隔条拖拽 ===================== */
  function initSplitter() {
    const sp = $('#wbSplitter'); if (!sp) return;
    let dragging = false;
    sp.addEventListener('pointerdown', (e) => {
      dragging = true; sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    });
    sp.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = $('#workbench').getBoundingClientRect();
      const sb = $('.sidebar'); const sbw = sb ? sb.getBoundingClientRect().width : 264;
      const C = document.documentElement.clientWidth - sbw;
      const fromRight = rect.right - e.clientX;
      S.width = Math.max(320, Math.min(Math.min(520, Math.floor(C * 0.45)), C - 566, Math.round(fromRight)));
      layout();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; sp.classList.remove('drag');
      post('ui', { width: S.width }).catch(() => {});
      reportWebBounds();
    };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
  }

  /* ===================== 入口与恢复 ===================== */
  async function initStandalone() {
    document.documentElement.classList.add('wb-standalone');
    S.open = true;
    let st = null;
    try { st = await api('state', {}); } catch (e) {}
    if (st) {
      S.width = st.width || 360;
      if (st.layout) S.backendLayout = st.layout;
      S.activeTabId = st.activeTabId;
      S.tabs = st.tabs || [];
      acceptDownloads(st.downloads);
      S.lastSessionId = st.lastSessionId || '';
      for (const t of S.tabs) await buildPanel(t);
      if (S.activeTabId && S.panels.has(S.activeTabId)) focusTab(S.activeTabId);
      else if (S.tabs.length) focusTab(S.tabs[0].id);
      else renderTabs();
    }
    layout();
    document.addEventListener('click', onLinkClick, true);
    window.addEventListener('resize', () => { layout(); reportWebBounds(); });
    const closeBtn = $('#wbClose');
    if (closeBtn) closeBtn.onclick = async () => {
      try { await post('window', { action: 'close' }); } catch (e) {}
      try { window.close(); } catch (e) {}
    };
    const dock = $('#wbDock');
    if (dock) dock.onclick = async () => {
      // 停靠：让主窗工作台真实可见（后端置 open/layout），成功后才关工具窗；
      // 主窗过窄时后端会拒绝，这里保持工具窗并说明原因（缺陷 #4）。
      let r;
      try { r = await post('window', { action: 'dock' }); }
      catch (e) { return toast('停靠失败：' + e.message); }
      if (r && r.ok) { try { window.close(); } catch (e) {} }
      else toast((r && r.reason) || '主窗过窄，无法停靠；已保持工具窗');
    };
    // 与主窗口同步：新增**和移除**都要同步，否则另一窗口归档的实例仍列在选择器里。
    setInterval(async () => {
      try {
        const s = await api('state', {});
        if (s) acceptDownloads(s.downloads);
        if (!s || !Array.isArray(s.tabs)) return;
        let changed = false;
        const ids = new Set(s.tabs.map((t) => t.id));
        for (const t of S.tabs.slice()) {
          if (ids.has(t.id)) continue;
          const p2 = S.panels.get(t.id);
          if (p2 && p2.el && p2.el.parentNode) p2.el.parentNode.removeChild(p2.el);
          const sx = S.side.get(t.id);
          if (sx) {
            if (sx.staleTimer) { try { clearInterval(sx.staleTimer); } catch (e) {} }
            if (sx.bgTimer) { try { clearInterval(sx.bgTimer); } catch (e) {} }
          }
          S.panels.delete(t.id); S.side.delete(t.id);
          S.tabs = S.tabs.filter((x) => x.id !== t.id);
          changed = true;
        }
        for (const t of s.tabs) {
          if (S.panels.has(t.id)) continue;
          S.tabs.push(t); await buildPanel(t); changed = true;
        }
        if (s.activeTabId && s.activeTabId !== S.activeTabId && S.panels.has(s.activeTabId)) focusTab(s.activeTabId);
        if (changed) refreshSidePickers();
      } catch (e) {}
    }, 2500);
  }

  async function init() {
    if (STANDALONE) { await initStandalone(); return; }
    const toggle = $('#hbWorkbench');
    if (!toggle) return;
    let st = null;
    try { st = await api('state', {}); } catch (e) {}
    if (st) {
      S.width = st.width || 360; S.activeTabId = st.activeTabId;
      S.tabs = st.tabs || [];
      acceptDownloads(st.downloads);
      for (const t of S.tabs) await buildPanel(t);
      S.open = !!st.open;
      if (S.activeTabId && S.panels.has(S.activeTabId)) focusTab(S.activeTabId);
      else if (S.tabs.length) focusTab(S.tabs[0].id);
      else renderTabs();
      layout();
    }
    toggle.onclick = () => setOpen(!S.open);
    const x = $('#wbClose'); if (x) x.onclick = () => setOpen(false);
    const dock = $('#wbDock');
    if (dock) dock.onclick = async () => {
      try { await post('window', { action: 'detach' }); }
      catch (e) { return toast('打开工具窗失败：' + e.message); }
      S.open = false; layout();
      toast('已分离到独立工具窗');
    };
    initSplitter();
    document.addEventListener('click', onLinkClick, true);
    window.addEventListener('resize', () => { layout(); reportWebBounds(); });
    window.addEventListener('scroll', () => reportWebBounds(), true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Escape' && S.open && S.drawer) setOpen(false);   // Esc 只收抽屉，不停止任务
    });
    // 浮层出现时收缩原生视图，避免盖住设置/滑块
    setInterval(() => { if (overlayVisible()) hideWebForOverlay(true); else reportWebBounds(); }, 1200);
    // 运行中 badge
    const badge = $('#wbRunBadge');
    const tick = async () => {
      try {
        const s = await api('state', {});
        if (s) acceptDownloads(s.downloads);
        if (s && (s.layout === 'docked' || s.layout === 'detached' || s.layout === 'hidden')) S.backendLayout = s.layout;
        if (badge) { badge.hidden = !s.running; badge.textContent = String(s.running || 0); }
        if (toggle) toggle.classList.toggle('running', !!s.running);
      } catch (e) {}
    };
    tick(); setInterval(tick, 4000);
    /* 跨窗口状态机协调（阻断项 3）：后端 layout 是**期望**值，这里负责
     *   · docked  → 真的把主窗工作台拉起，并实测可见性后回传一次确认（后端凭它才关工具窗）
     *   · detached→ 主窗收起（工具窗接管），不重复渲染同一工作台
     *   · hidden  → 收起
     * 同时同步另一窗口的页签新增/移除。 */
    let ackedReq = null;
    const reconcileLayout = async () => {
      try {
        const s = await api('state', {});
        if (s) acceptDownloads(s.downloads);
        if (!s) return;
        if (s.layout === 'docked' || s.layout === 'detached' || s.layout === 'hidden') S.backendLayout = s.layout;
        if (Array.isArray(s.tabs)) {
          let changed = false;
          const ids = new Set(s.tabs.map((t) => t.id));
          for (const t of S.tabs.slice()) {
            if (ids.has(t.id)) continue;
            const p2 = S.panels.get(t.id);
            if (p2 && p2.el && p2.el.parentNode) p2.el.parentNode.removeChild(p2.el);
            const sx = S.side.get(t.id);
            if (sx) {
              if (sx.staleTimer) { try { clearInterval(sx.staleTimer); } catch (e) {} }
              if (sx.bgTimer) { try { clearInterval(sx.bgTimer); } catch (e) {} }
            }
            S.panels.delete(t.id); S.side.delete(t.id);
            S.tabs = S.tabs.filter((x) => x.id !== t.id);
            changed = true;
          }
          for (const t of s.tabs) {
            if (S.panels.has(t.id)) continue;
            S.tabs.push(t); await buildPanel(t); changed = true;
          }
          if (changed) refreshSidePickers();
        }
        if (s.layout === 'docked') {
          if (!S.open) { S.open = true; layout(); }
          // 每次停靠请求只确认一次（凭 dockRequestAt 判断），避免每 1.5s 写一次状态。
          if (s.dockRequestAt && ackedReq !== s.dockRequestAt) {
            ackedReq = s.dockRequestAt;
            const el = $('#workbench');
            const sb = $('.sidebar');
            const sbw = sb ? Math.round(sb.getBoundingClientRect().width) : 264;
            const canDock = (document.documentElement.clientWidth - sbw) >= (560 + 6 + 320);
            const visible = !!(el && !el.hidden && el.getBoundingClientRect().width > 200);
            try {
              await post('ui', { dockAck: {
                at: Date.now(), requestAt: s.dockRequestAt, canDock: canDock, visible: visible,
                clientWidth: document.documentElement.clientWidth,
              } });
            } catch (e) {}
          }
        } else if (s.layout === 'detached') {
          if (S.open) { S.open = false; layout(); }
        } else if (s.layout === 'hidden') {
          if (S.open && !S.drawer) { S.open = false; layout(); }
        }
      } catch (e) {}
    };
    setInterval(reconcileLayout, 1500);
  }

  function boot() {
    // renderer.js 在后面加载；等其顶层变量就绪再初始化。
    setTimeout(init, 60);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供主聊天在需要时直接调用（例如「在网页页签打开」按钮）
  window.WhaleWorkbench = { open: () => setOpen(true), close: () => setOpen(false), openLink: openLinkInWeb, state: S };
})();
