/**
 * 鲸鱼娘 · 未至之境 — 背景视频生命周期
 *
 * 来源：zhu1090093659/dsh-web @ 971cc3e1 / market/dist/assets/skins/whale-fantasy
 * 作者：stushansusu ｜ 许可：CC BY-NC-SA 4.0
 *
 * 设计约束（对应《整体美化计划》§5.3）：
 *   · 同一文档只存在一个背景根和一个 video；重复 mount 不重复监听或解码。
 *   · 路径来自内部固定常量，不接受任意用户 URL。
 *   · 不修改主窗口的全局 autoplayPolicy，不放宽导航或安全边界。
 *   · 页面不可见时暂停；可见且未被用户 / 减少动态效果暂停时尝试恢复。
 *   · 每次播放尝试带递增序号 + 销毁检查，避免 play Promise 在 destroy 后改回 playing。
 *   · 视频失败不阻断输入、消息和设置；只显示真实状态，不无限重试。
 *   · destroy 顺序：标记销毁 → 移除监听 → pause → 清 src → load → 移除节点。
 */
(function () {
  'use strict';

  var SRC = '/themes/whale-fantasy/assets/whale-fantasy-loop.mp4';
  var ROOT_CLASS = 'whale-bg';

  var instance = null;

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function create() {
    var root = document.createElement('div');
    root.className = ROOT_CLASS;
    root.setAttribute('aria-hidden', 'true');

    var video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('preload', 'auto');
    video.setAttribute('tabindex', '-1');
    video.setAttribute('aria-hidden', 'true');

    root.appendChild(video);

    var controller = {
      root: root,
      video: video,
      state: 'loading',
      _destroyed: false,
      _userPaused: false,
      _reduced: reducedMotion(),
      _seq: 0,
      _cleanups: [],
      _report: null,
    };

    function setState(s, detail) {
      if (controller._destroyed && s !== 'destroyed') return;
      controller.state = s;
      if (typeof controller._report === 'function') {
        try { controller._report(s, detail || ''); } catch (e) {}
      }
    }
    controller._setState = setState;

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      controller._cleanups.push(function () { target.removeEventListener(type, fn, opts); });
    }

    function tryPlay(reason) {
      if (controller._destroyed) return;
      if (controller._userPaused) { setState('paused-user'); return; }
      if (controller._reduced) { setState('paused-reduced-motion'); return; }
      if (document.hidden) { setState('paused-hidden'); return; }
      var seq = ++controller._seq;
      var p;
      try { p = video.play(); } catch (e) { setState('blocked', String(e && e.message || e)); return; }
      if (!p || typeof p.then !== 'function') { setState('playing'); return; }
      p.then(function () {
        if (controller._destroyed || seq !== controller._seq) return;
        setState('playing');
      }).catch(function (err) {
        if (controller._destroyed || seq !== controller._seq) return;
        var name = (err && err.name) || '';
        // NotAllowedError = 自动播放被拒绝；AbortError = 被新的 play/pause 打断
        if (name === 'AbortError') return;
        setState('blocked', name || String(err));
      });
    }
    controller._tryPlay = tryPlay;

    on(video, 'error', function () {
      if (controller._destroyed) return;
      setState('unavailable', (video.error && ('code ' + video.error.code)) || '');
    });
    on(video, 'loadeddata', function () {
      if (controller._destroyed) return;
      if (controller.state === 'loading') tryPlay('loadeddata');
    });
    on(video, 'playing', function () {
      if (controller._destroyed) return;
      if (controller.state !== 'playing') setState('playing');
    });
    on(video, 'pause', function () {
      if (controller._destroyed) return;
      // play() 内部触发的短暂 pause 不改变语义状态
      if (controller.state === 'playing' && !video.ended && video.readyState >= 2 && !document.hidden) {
        if (controller._userPaused) setState('paused-user');
      }
    });

    on(document, 'visibilitychange', function () {
      if (controller._destroyed) return;
      if (document.hidden) {
        try { video.pause(); } catch (e) {}
        setState('paused-hidden');
      } else {
        tryPlay('visibility');
      }
    });

    var mq = null;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) {}
    if (mq && typeof mq.addEventListener === 'function') {
      var onMq = function () {
        if (controller._destroyed) return;
        controller._reduced = !!mq.matches;
        if (controller._reduced) {
          try { video.pause(); } catch (e) {}
          setState('paused-reduced-motion');
        } else {
          tryPlay('reduced-motion-off');
        }
      };
      mq.addEventListener('change', onMq);
      controller._cleanups.push(function () { mq.removeEventListener('change', onMq); });
    }

    // 先设好 muted / loop / playsinline，再挂本地 src
    video.src = SRC;
    try { video.load(); } catch (e) {}

    controller.pauseByUser = function () {
      controller._userPaused = true;
      try { video.pause(); } catch (e) {}
      setState('paused-user');
    };
    controller.resumeByUser = function () {
      controller._userPaused = false;
      controller._reduced = reducedMotion();
      if (controller._reduced) { setState('paused-reduced-motion'); return; }
      tryPlay('user');
    };
    controller.destroy = function () {
      if (controller._destroyed) return;
      controller._destroyed = true;
      controller._seq++;
      controller._cleanups.splice(0).forEach(function (fn) { try { fn(); } catch (e) {} });
      try { video.pause(); } catch (e) {}
      try { video.removeAttribute('src'); } catch (e) {}
      try { video.load(); } catch (e) {}
      try { if (root.parentNode) root.parentNode.removeChild(root); } catch (e) {}
      if (instance && instance.root === root) instance = null;
      controller.state = 'destroyed';
    };

    return controller;
  }

  function mount(opts) {
    opts = opts || {};
    // 幂等：已有实例时只更新回调，不重复建节点 / 解码
    if (instance && !instance._destroyed) {
      if (typeof opts.reportState === 'function') instance._report = opts.reportState;
      if (typeof opts.reportState === 'function') {
        try { opts.reportState(instance.state, ''); } catch (e) {}
      }
      return instance;
    }
    if (!document.body) return null;
    var c = create();
    if (typeof opts.reportState === 'function') c._report = opts.reportState;
    document.body.insertBefore(c.root, document.body.firstChild);
    instance = c;
    c._setState('loading');
    // 元数据可能已在缓存里，主动拉一次播放（play() 会触发加载）
    c._tryPlay('mount');
    return c;
  }

  function current() { return instance; }

  /* ── 状态文案：只在 diag 的署名分组里显示真实状态，不做装饰 ───────────── */
  var STATE_TEXT = {
    'loading': '动态背景：加载中',
    'playing': '动态背景：播放中（原版完整循环）',
    'paused-hidden': '动态背景：窗口不可见，已暂停',
    'paused-reduced-motion': '动态背景：系统开启了「减少动态效果」，已暂停（恢复受系统限制）',
    'paused-user': '动态背景：已由你暂停',
    'blocked': '动态背景：被系统阻止播放，可点「重试动态背景」',
    'unavailable': '动态背景：媒体不可用，已退回静态底色',
    'destroyed': '动态背景：已卸载',
  };

  /* 按钮文案必须与点击动作一致（复核清单第 2 项）：
     blocked 之前提示「恢复」但按钮写着「暂停」、第一次点击还会走暂停路径。 */
  var BTN_TEXT = {
    'playing': '暂停动态背景',
    'paused-user': '恢复动态背景',
    'paused-reduced-motion': '恢复动态背景（受系统限制）',
    'blocked': '重试动态背景',
    'unavailable': '动态背景不可用',
    'destroyed': '动态背景不可用',
    'loading': '暂停动态背景',
    'paused-hidden': '暂停动态背景',
  };
  var BTN_TITLE = {
    'paused-reduced-motion': '系统已开启「减少动态效果」，点击恢复不会强行播放；请先在系统设置中关闭该选项',
    'blocked': '重新尝试播放原版循环视频（不修改系统自动播放策略）',
    'unavailable': '媒体文件不可用，已退回静态底色；不会反复重试',
  };

  /* 这些状态点击后应「重试播放」，其余状态点击是「暂停」 */
  var RETRY_STATES = { 'blocked': 1, 'paused-user': 1, 'paused-reduced-motion': 1 };

  function renderState(state) {
    var el = document.getElementById('whaleBackgroundState');
    if (el) el.textContent = STATE_TEXT[state] || ('动态背景：' + state);
    var btn = document.getElementById('whaleBgToggle');
    if (btn) {
      btn.textContent = BTN_TEXT[state] || '暂停动态背景';
      btn.title = BTN_TITLE[state] || '';
      btn.disabled = (state === 'unavailable' || state === 'destroyed');
    }
  }

  function autoMount() {
    if (!document.body) return;
    var c = mount({ reportState: renderState });
    if (!c) return;
    renderState(c.state);
    var btn = document.getElementById('whaleBgToggle');
    if (btn && !btn.__whaleBound) {
      btn.__whaleBound = true;
      btn.addEventListener('click', function () {
        var cur = current();
        if (!cur) return;
        // blocked 也走「重试播放」分支：第一次点击就重试，不再先落到 pauseByUser
        if (RETRY_STATES[cur.state]) cur.resumeByUser();
        else cur.pauseByUser();
      });
    }
  }

  window.WhaleBackground = {
    mount: mount,
    current: current,
    renderState: renderState,
    SRC: SRC,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  } else {
    autoMount();
  }
})();
