/*!
 * reasoning-slider.js —— 推理强度滑杆（原生实现）
 *
 * 视觉与交互一比一复刻 dsh-codex-excellent-slider（MIT，作者 karina2256，
 * 上游 NNNOOOMII/dsh-codex-power-slider、Microqian2th/dsh-codex-effort-slider）。
 * 原插件是 DSH Web 的 React 插件，本文件改写为零依赖原生实现，几何、色值、
 * 动效时长与关键帧均按原仓库源码逐项对齐，仅把「宿主注入」换成我方接口。
 *
 * 对外接口（挂 window.ReasoningSlider）：
 *   init(opts)      注入数据源
 *   toggle(anchor)  打开 / 关闭
 *   close()         关闭
 *   isOpen()        是否打开
 *   refresh()       外部状态变化后重绘
 */
(function () {
  'use strict';

  /* ======================================================================
   * 几何常量：与插件源码完全一致（CARD_W / CARD_PAD / TRACK_H / KNOB_D）
   * ==================================================================== */
  var CARD_W = 262;
  var CARD_PAD = 13;
  var TRACK_H = 22;
  var KNOB_D = 25;
  var TRACK_INSET = TRACK_H / 2;
  var TIP_W = 300;
  var INK_SCALE = KNOB_D / 46;
  var QUOTA_HINT = '使用额度消耗更快';

  var GOLDEN = 0.6180339887498949;
  var STAR_MIN = 0.5;
  var STAR_DUR_MEAN = 1.5;
  var STAR_DUR_SPREAD = 0.08;
  var MAX_SPEED = 2;
  var MIN_HEIGHT_SLOTS = 3;
  var ENERGY_START = 0.05;
  var ENERGY_END = 2 / 3;

  var C_BLUE = [59, 130, 246];
  var C_VIOLET = [168, 85, 247];
  var C_DEEP = [124, 58, 237];

  var INK_SPECS = [
    { angle: -95, radius: 49, size: 7.0, ink: '#20204f', delay: 0 },
    { angle: -63, radius: 46, size: 6.8, ink: '#21214b', delay: 14 },
    { angle: -30, radius: 52, size: 7.2, ink: '#242750', delay: 6 },
    { angle: -2, radius: 48, size: 7.0, ink: '#252851', delay: 22 },
    { angle: 38, radius: 51, size: 7.4, ink: '#20204f', delay: 10 },
    { angle: 86, radius: 45, size: 6.6, ink: '#21214b', delay: 28 },
    { angle: 163, radius: 47, size: 7.0, ink: '#242750', delay: 16 },
    { angle: 220, radius: 50, size: 7.2, ink: '#252851', delay: 4 }
  ];
  var INK_START_RADIUS = 24;
  var INK_START_DELAY = 70;
  var INK_DURATION = 400;
  var INK_TOTAL = INK_START_DELAY + INK_DURATION + 28;

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  /* 档位标题配色：左端浅灰蓝 → 深蓝 → 最高档走紫色渐变（与原插件一致） */
  var TITLE_COLORS = ['#8ea9c9', '#4b7fe0', '#2563eb'];
  function titleColorFor(i) { return TITLE_COLORS[Math.min(Math.max(i, 0), TITLE_COLORS.length - 1)]; }
  var rgb = function (c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; };
  var mix = function (a, b, t) {
    var k = clamp(t, 0, 1);
    return [
      Math.round(a[0] + (b[0] - a[0]) * k),
      Math.round(a[1] + (b[1] - a[1]) * k),
      Math.round(a[2] + (b[2] - a[2]) * k)
    ];
  };
  function fillColor(pct) {
    var t = clamp(pct, 0, 1);
    if (t <= ENERGY_START) return rgb(C_BLUE);
    if (t <= ENERGY_END) return rgb(mix(C_BLUE, C_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
    return rgb(mix(C_VIOLET, C_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
  }
  function fillBg(pct) {
    return 'linear-gradient(90deg, ' + rgb(C_BLUE) + ', ' + fillColor(pct) + ')';
  }
  function energyFor(pct) {
    return clamp((clamp(pct, 0, 1) - ENERGY_START) / (1 - ENERGY_START), 0, 1);
  }
  function speedFor(pct) { return Math.min(MAX_SPEED, Math.max(0.35, 3 * clamp(pct, 0, 1) - 1)); }

  /* 确定性伪随机：同一档位每次渲染粒子位置一致，不抖。 */
  function hash01(index, salt) {
    var value = (index + 1) * salt * 2654435761 % 4294967296;
    return ((value >>> 8) % 1000) / 1000;
  }

  /* 22 颗星：相位黄金比低差异序列 + 高度槽确定性排列（防并成一坨）。 */
  var PARTICLES = (function () {
    var count = 22, out = [], i;
    for (i = 0; i < count; i++) out.push({ y: 0, phase: (i + 1) * GOLDEN % 1 });
    var byPhase = [];
    for (i = 0; i < count; i++) byPhase.push(i);
    byPhase.sort(function (a, b) { return out[a].phase - out[b].phase; });
    var slots = null;
    for (var salt = 71; salt < 4000 && slots === null; salt++) {
      var cand = [];
      for (i = 0; i < count; i++) cand.push(i);
      cand.sort(function (a, b) {
        var ha = hash01(a, salt), hb = hash01(b, salt);
        return ha === hb ? a - b : ha - hb;
      });
      var ok = true;
      for (var k = 1; k < count && ok; k++) if (Math.abs(cand[k] - cand[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
      if (ok) slots = cand;
    }
    if (slots === null) { slots = []; for (i = 0; i < count; i++) slots.push((i * 5) % count); }
    for (var rank = 0; rank < count; rank++) out[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
    return out;
  })();

  function starDuration(i, speed) {
    var sp = Math.min(MAX_SPEED, Math.max(0.35, typeof speed === 'number' ? speed : MAX_SPEED));
    var spread = 1 - STAR_DUR_SPREAD + 2 * STAR_DUR_SPREAD * hash01(i, 29);
    return (STAR_DUR_MEAN * MAX_SPEED) / sp * spread;
  }
  function starDelay(i, dur) {
    var p = PARTICLES[i] || { phase: 0 };
    var jitter = hash01(i, 53) * 0.03;
    return -((p.phase + jitter) % 1) * dur;
  }
  function starBright(i) { return STAR_MIN + (1 - STAR_MIN) * hash01(i, 61); }

  /* ======================================================================
   * 样式
   * ==================================================================== */
  var CSS = ''
    + '.rs-scope,.rs-pop,.rs-tip,.rs-models{'
    + '--rs-card:#ffffff;--rs-line:rgba(0,0,0,.07);'
    + '--rs-accent:#5b8cff;--rs-accent-dim:#3d74e8;'
    + '--rs-sub:#6b6b6b;--rs-sub-hover:#111111;--rs-icon:#8a8a8a;'
    + '--rs-track:#ececec;--rs-dot:#c4c4c4;--rs-knob:#ffffff;'
    + '--rs-panel:#ffffff;--rs-row-hover:#f1f1f1;--rs-row:#161616;'
    + '--rs-dim:#8a8a8a;--rs-tip:#f6f6f6;--rs-tip-text:#161616;'
    + '--rs-shadow:0 18px 48px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.08);}'

    /* 触发器内嵌的档位小字（挂在输入框胶囊里，不属于浮层） */
    + '.mp-eff{color:var(--text-3);font-size:12px;max-width:96px;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap;transition:color .18s ease}'
    + '#btnModel:hover .mp-eff{color:var(--text-2)}'
    /* 卡片打开时，胶囊切成原版的「选择推理强度」胶囊形态（30px 行高不变，只改内距/圆角/底色） */
    + '#btnModel.is-open{height:30px;padding:0 14px;gap:6px;border-radius:999px;'
    + 'background:#f1f1f1;border-color:transparent;color:var(--text)}'
    + '#btnModel.is-open .chev{transform:rotate(180deg)}'

    /* ---------- 卡片 ---------- */
    + '.rs-pop{position:fixed;z-index:88;width:' + CARD_W + 'px;box-sizing:border-box;'
    + 'padding:10px ' + CARD_PAD + 'px 9px;border-radius:16px;border:1px solid var(--rs-line);'
    + 'background:var(--rs-card);color:var(--rs-row);box-shadow:var(--rs-shadow);'
    + 'font-family:inherit;-webkit-font-smoothing:antialiased;'
    + 'animation:rs-pop-in .17s cubic-bezier(.2,0,0,1)}'
    + '@keyframes rs-pop-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}'

    + '.rs-head{position:relative;text-align:center}'
    + '.rs-title{font-size:14px;font-weight:600;line-height:1.25;letter-spacing:.01em;'
    + 'color:var(--rs-accent);transition:color .18s ease}'
    + '.rs-title.is-ultra{background:linear-gradient(92deg,#5a55f0 0%,#a9a6ff 58%,#7f86f0 100%);'
    + '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}'

    + '.rs-segment{display:inline-flex;flex-direction:column;align-items:center;gap:2px;'
    + 'min-width:124px;padding:6px 16px 7px;margin:0 auto;'
    + 'border:1px solid transparent;border-radius:12px;background:none;font:inherit;cursor:pointer;'
    + 'transition:background .12s ease,border-color .12s ease}'
    + '.rs-segment:hover,.rs-segment.is-open{background:var(--rs-row-hover);border-color:var(--rs-line)}'
    + '.rs-segment:focus-visible{outline:2px solid var(--rs-accent);outline-offset:2px}'

    + '.rs-sub{display:inline-flex;align-items:center;justify-content:center;gap:4px;'
    + 'border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--rs-sub);'
    + 'cursor:inherit;border-radius:0;transition:color .15s ease,opacity .12s ease-out;'
    + 'max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.rs-segment:hover .rs-sub,.rs-segment.is-open .rs-sub{color:var(--rs-sub-hover)}'
    + '.rs-sub svg{flex:none;width:10px;height:10px;opacity:.7}'

    + '.rs-reset{position:absolute;top:1px;right:-6px;width:27px;height:27px;display:grid;'
    + 'place-items:center;border:0;background:none;padding:0;color:var(--rs-icon);cursor:pointer;'
    + 'border-radius:8px;transition:background .15s ease,color .15s ease}'
    + '.rs-reset:hover{background:var(--rs-row-hover);color:var(--rs-sub-hover)}'
    + '.rs-reset[disabled]{opacity:.4;cursor:default}'

    + '.rs-boost{position:absolute;top:1px;left:-6px;width:27px;height:27px;display:grid;'
    + 'place-items:center;border:0;background:none;padding:0;color:var(--rs-dim);cursor:pointer;'
    + 'border-radius:8px;transition:background .15s ease,color .15s ease,box-shadow .15s ease}'
    + '.rs-boost:hover{background:var(--rs-row-hover);color:var(--rs-sub-hover)}'
    + '.rs-boost.is-on{color:#b0b4ff;box-shadow:0 0 0 1px rgba(176,180,255,.32),0 0 10px rgba(176,180,255,.55)}'
    + '@media (prefers-reduced-motion:reduce){.rs-boost{transition:none}}'

    + '.rs-subwrap{margin-top:2px;display:grid;place-items:center;height:16px;line-height:16px;'
    + 'font-size:11.5px;color:var(--rs-sub)}'
    + '.rs-subwrap>*{grid-area:1 / 1}'
    + '.rs-quota{opacity:0;pointer-events:none;user-select:none;white-space:nowrap;'
    + 'transition:opacity .12s ease-out}'
    + '.rs-subwrap[data-notice=true] .rs-quota{opacity:1}'
    + '.rs-subwrap[data-notice=true] .rs-sub{opacity:0;pointer-events:none}'
    + '@media (prefers-reduced-motion:reduce){.rs-quota,.rs-sub{transition:none}}'

    /* ---------- 滑轨 ---------- */
    + '.rs-track{position:relative;margin-top:11px;height:' + TRACK_H + 'px;border-radius:999px;'
    + 'background:var(--rs-track);cursor:pointer;touch-action:none;'
    + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}'
    + '.rs-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:999px;overflow:hidden;'
    + 'pointer-events:none;background:linear-gradient(90deg,var(--rs-accent-dim),var(--rs-accent));'
    + 'transition:width .18s cubic-bezier(.2,.9,.25,1),background .24s ease}'

    + '.rs-ultra{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;'
    + '--rs-sweep:1.8s;--rs-haze-alpha:.035;'
    + 'background-image:'
    + 'radial-gradient(ellipse at 54% 28%,rgba(211,203,255,.14) 0%,rgba(185,175,255,.05) 38%,rgba(185,175,255,0) 72%),'
    + 'linear-gradient(90deg,var(--rs-accent-dim) 0%,#4f86f0 25%,var(--rs-accent) 50%,'
    + '#7c3aed 60%,#8b5cf6 68%,#9333ea 74%,#8b5cf6 79%,#7c3aed 88%,#6d28d9 100%);'
    + 'background-size:100% 100%,200% 100%;background-repeat:no-repeat;background-position:0 0,0% 0%;'
    + 'animation:rs-ultra-sweep var(--rs-sweep) linear both,rs-ultra-in .2s ease-out both}'
    + '@keyframes rs-ultra-in{from{opacity:0}to{opacity:1}}'
    + '@keyframes rs-ultra-sweep{'
    + '0%{background-position:0 0,67% 0%;animation-timing-function:cubic-bezier(.30,.70,.35,1)}'
    + '12%{background-position:0 0,80% 0%;animation-timing-function:cubic-bezier(.28,.06,.30,1)}'
    + '100%{background-position:0 0,100% 0%}}'

    + '.rs-haze{position:absolute;inset:0;pointer-events:none;border-radius:inherit;'
    + 'background:radial-gradient(ellipse at 61% 58%,'
    + 'rgba(218,204,255,var(--rs-haze-alpha)) 0%,rgba(199,187,255,.022) 34%,rgba(199,187,255,0) 72%);'
    + 'animation:rs-haze-breathe 13.6s ease-in-out infinite;animation-delay:-4.2s}'
    + '@keyframes rs-haze-breathe{0%,100%{opacity:.55}50%{opacity:.9}}'

    + '.rs-aurora{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}'
    + '.rs-aurora>i{position:absolute;top:-30%;bottom:-30%;left:-50%;width:200%;display:block;'
    + 'background-repeat:no-repeat;opacity:0;animation-name:rs-aurora-in;animation-duration:.9s;'
    + 'animation-timing-function:ease-out;animation-fill-mode:both}'
    + '.rs-aurora>.a1{background-image:radial-gradient(7% 170% at 50% 45%,'
    + 'rgba(236,236,255,.40) 0%,rgba(236,236,255,.15) 46%,rgba(236,236,255,0) 76%);'
    + 'animation-name:rs-aurora-in,rs-aurora-x1,rs-aurora-breathe;'
    + 'animation-duration:.9s,8.5s,4.5s;animation-delay:2.4s,0.7s,3.3s;'
    + 'animation-iteration-count:1,infinite,infinite;animation-direction:normal,alternate,alternate;'
    + 'animation-timing-function:ease-out,ease-in-out,ease-in-out;animation-fill-mode:both,both,none}'
    + '.rs-aurora>.a2{background-image:radial-gradient(10% 180% at 50% 55%,'
    + 'rgba(92,128,238,.38) 0%,rgba(92,128,238,.14) 50%,rgba(92,128,238,0) 78%);'
    + 'animation-name:rs-aurora-in,rs-aurora-x2;animation-duration:.9s,13s;'
    + 'animation-delay:2.6s,-1.5s;animation-iteration-count:1,infinite;'
    + 'animation-direction:normal,alternate;animation-timing-function:ease-out,linear}'
    + '.rs-aurora>.a3{background-image:radial-gradient(5% 160% at 50% 50%,'
    + 'rgba(172,152,255,.30) 0%,rgba(172,152,255,.11) 52%,rgba(172,152,255,0) 80%);'
    + 'animation-name:rs-aurora-in,rs-aurora-x3;animation-duration:.9s,16s;'
    + 'animation-delay:2.8s,-5.5s;animation-iteration-count:1,infinite;'
    + 'animation-direction:normal,alternate;animation-timing-function:ease-out,linear}'
    + '.rs-aurora>.a4{background-image:radial-gradient(8% 140% at 50% 60%,'
    + 'rgba(56,84,190,.30) 0%,rgba(56,84,190,.11) 55%,rgba(56,84,190,0) 82%);'
    + 'animation-name:rs-aurora-in,rs-aurora-x4;animation-duration:.9s,23s;'
    + 'animation-delay:3s,-10.7s;animation-iteration-count:1,infinite;'
    + 'animation-direction:normal,alternate;animation-timing-function:ease-out,linear}'
    + '@keyframes rs-aurora-in{from{opacity:0}to{opacity:1}}'
    + '@keyframes rs-aurora-breathe{from{opacity:1}to{opacity:.72}}'
    + '@keyframes rs-aurora-x1{from{transform:translate3d(-16%,1.4px,0)}to{transform:translate3d(16%,-1.4px,0)}}'
    + '@keyframes rs-aurora-x2{from{transform:translate3d(14%,-1.6px,0)}to{transform:translate3d(-14%,1.6px,0)}}'
    + '@keyframes rs-aurora-x3{from{transform:translate3d(-10%,1.8px,0)}to{transform:translate3d(10%,-1.8px,0)}}'
    + '@keyframes rs-aurora-x4{from{transform:translate3d(8%,-1px,0)}to{transform:translate3d(-8%,1px,0)}}'

    /* 22 颗能量星尘：从右往左横穿，随能量渐入 */
    + '.rs-efstars{position:absolute;top:0;bottom:0;left:0;right:0;overflow:hidden;pointer-events:none;z-index:2}'
    + '.rs-efstar{position:absolute;left:0;right:0;height:3px;margin-top:-1.5px;pointer-events:none;'
    + 'animation-name:rs-efstar-sweep;animation-timing-function:linear;animation-iteration-count:infinite}'
    + '.rs-efstar-dot{position:absolute;left:100%;top:0;width:3px;height:3px;margin-left:-1.5px;'
    + 'border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.85);'
    + 'opacity:var(--rs-b,1);transform:scale(var(--rs-b,1))}'
    + '@keyframes rs-efstar-sweep{0%{transform:translate3d(0,0,0);opacity:0}6%{opacity:1}'
    + '94%{opacity:1}100%{transform:translate3d(-100%,0,0);opacity:0}}'
    + '.rs-efstar-dot{background:#f5f3ff;box-shadow:0 0 5px rgba(216,180,254,.95)}'

    + '.rs-knob{position:absolute;top:50%;width:' + KNOB_D + 'px;height:' + KNOB_D + 'px;border-radius:50%;'
    + 'background:var(--rs-knob);z-index:3;transform:translate(-50%,-50%);'
    + 'box-shadow:0 2px 10px rgba(0,0,0,.38),0 0 0 1px rgba(0,0,0,.05);'
    + 'transition:left .18s cubic-bezier(.2,.9,.25,1);will-change:left}'
    + '.rs-track.is-dragging{cursor:grabbing}'
    + '.rs-track.is-dragging .rs-knob{transform:translate(-50%,-50%) scale(1.045);transition:none}'
    + '.rs-track.is-dragging .rs-fill{transition:none}'
    + '.rs-track.is-locked{cursor:default;opacity:.6}'

    /* 墨点溅射 */
    + '.rs-ink-ring{position:absolute;top:50%;width:0;height:0;overflow:visible;pointer-events:none;z-index:2}'
    + '.rs-ink-ray{position:absolute;left:0;top:0;width:0;height:0;opacity:0;'
    + 'transform:translate3d(var(--x0),var(--y0),0)}'
    + '.rs-ink-ray::before{content:"";position:absolute;left:0;top:0;width:var(--size);height:var(--size);'
    + 'border-radius:50%;background:var(--ink);transform:translate(-50%,-50%)}'
    + '.rs-ink-ring.is-bursting .rs-ink-ray{animation-name:rs-ink-fly,rs-ink-fade;'
    + 'animation-duration:var(--duration),var(--duration);animation-delay:var(--delay,0ms),var(--delay,0ms);'
    + 'animation-timing-function:cubic-bezier(.16,.58,.30,1),linear;animation-iteration-count:1,1;'
    + 'animation-fill-mode:both,both}'
    + '@keyframes rs-ink-fly{from{transform:translate3d(var(--x0),var(--y0),0)}'
    + 'to{transform:translate3d(var(--x1),var(--y1),0)}}'
    + '@keyframes rs-ink-fade{0%{opacity:.85}12%,42%{opacity:1}100%{opacity:0}}'

    /* ---------- 模型列表浮层 ---------- */
    + '.rs-models{position:fixed;z-index:89;box-sizing:border-box;display:flex;flex-direction:column;'
    + 'width:' + CARD_W + 'px;max-height:min(360px,calc(100vh - 96px));padding:6px 6px 8px;'
    + 'border-radius:16px;border:1px solid var(--rs-line);background:var(--rs-card);color:var(--rs-row);'
    + 'box-shadow:var(--rs-shadow);overflow:hidden;font-family:inherit;'
    + 'animation:rs-pop-in .17s cubic-bezier(.2,0,0,1)}'
    + '.rs-models-head{flex:none;display:flex;align-items:center;justify-content:space-between;'
    + 'padding:4px 6px 6px;font-size:11.5px;line-height:16px;color:var(--rs-dim)}'
    + '.rs-models-close{width:22px;height:22px;display:grid;place-items:center;border:0;border-radius:7px;'
    + 'background:none;color:var(--rs-icon);cursor:pointer;font-size:12px;line-height:1}'
    + '.rs-models-close:hover{background:var(--rs-row-hover);color:var(--rs-sub-hover)}'
    + '.rs-models-body{min-height:0;overflow-y:auto;overscroll-behavior:contain}'
    + '.rs-group+.rs-group{margin-top:4px;border-top:1px solid var(--rs-line);padding-top:4px}'
    + '.rs-group-head{display:block;padding:8px 10px 4px}'
    + '.rs-group-name{font-size:11.5px;font-weight:600;color:var(--rs-dim);line-height:16px;letter-spacing:.02em}'
    + '.rs-row{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:8px;'
    + 'font-size:13px;color:var(--rs-row);cursor:pointer;white-space:nowrap}'
    + '.rs-row:hover{background:var(--rs-row-hover)}'
    + '.rs-row-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}'
    + '.rs-row-tick{flex:none;width:14px;height:14px;color:var(--rs-row)}'
    + '.rs-row.is-cur .rs-row-nm{font-weight:500}'

    + '.rs-tip{position:fixed;z-index:90;width:' + TIP_W + 'px;box-sizing:border-box;'
    + 'padding:8px 10px;border-radius:10px;background:var(--rs-tip);color:var(--rs-tip-text);'
    + 'font-size:11.5px;line-height:1.5;box-shadow:0 6px 22px rgba(0,0,0,.18);pointer-events:none;'
    + 'font-family:inherit}'
    + '.rs-note{padding:8px 4px 2px;font-size:11.5px;line-height:1.5;color:var(--rs-dim);text-align:center}'

    + '@media (prefers-reduced-motion:reduce){'
    + '.rs-ultra,.rs-haze,.rs-efstar,.rs-efstar-dot{animation:none}'
    + '.rs-ultra{background-position:0 0,100% 0%}'
    + '.rs-haze{opacity:1}'
    + '.rs-aurora>i{animation:none;opacity:.6;transform:translateX(0)}'
    + '.rs-ink-ring{display:none}}';

  function injectStyle() {
    if (document.getElementById('rs-style')) return;
    var s = document.createElement('style');
    s.id = 'rs-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ======================================================================
   * 状态
   * ==================================================================== */
  var opts = null;
  var pop = null, modelsEl = null, tipEl = null;
  var anchorEl = null;
  var open = false;
  var view = 'card';           // card | models
  var ratio = 0;               // 当前显示位置 0..1
  var dragRatio = null;
  var dragActive = false;
  var burstAt = 0;
  var inkTimer = 0;
  var noticeTimer = 0;

  function tiers() { return (opts && opts.tiers) || []; }
  function indexOfDepth(v) {
    var t = tiers();
    for (var i = 0; i < t.length; i++) if (t[i].v === v) return i;
    return t.length ? t.length - 1 : -1;
  }
  function ratioOfIndex(i) {
    var n = tiers().length;
    if (n <= 1) return 0;
    return i / (n - 1);
  }
  function isUltraIndex(i) { return tiers().length >= 3 && i === tiers().length - 1; }
  function posAt(r) { return 'calc(' + TRACK_INSET + 'px + (100% - ' + TRACK_H + 'px) * ' + r + ')'; }

  /* ======================================================================
   * 渲染
   * ==================================================================== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function starsHtml(r) {
    var count = Math.round(energyFor(r) * PARTICLES.length);
    var speed = speedFor(r);
    var layer = el('div', 'rs-efstars');
    layer.dataset.count = String(count);
    layer.style.opacity = (0.6 + 0.4 * energyFor(r)).toFixed(3);
    for (var i = 0; i < count; i++) {
      var p = PARTICLES[i];
      var dur = starDuration(i, speed);
      var row = el('div', 'rs-efstar');
      row.style.top = p.y.toFixed(3) + '%';
      row.style.animationDuration = dur.toFixed(3) + 's';
      row.style.animationDelay = starDelay(i, dur).toFixed(3) + 's';
      var dot = el('span', 'rs-efstar-dot');
      dot.style.setProperty('--rs-b', starBright(i).toFixed(3));
      row.appendChild(dot);
      layer.appendChild(row);
    }
    return layer;
  }

  function buildFill(r) {
    var fill = el('div', 'rs-fill');
    fill.style.width = posAt(r);
    fill.style.background = fillBg(r);
    fill.appendChild(starsHtml(r));
    var idx = Math.round(r * (tiers().length - 1));
    if (isUltraIndex(idx)) {
      var ultra = el('div', 'rs-ultra');
      ultra.appendChild(el('i', 'rs-haze'));
      var au = el('div', 'rs-aurora');
      ['a1', 'a2', 'a3', 'a4'].forEach(function (c) { au.appendChild(el('i', c)); });
      ultra.appendChild(au);
      fill.appendChild(ultra);
    }
    return fill;
  }

  function buildInk() {
    var ring = el('div', 'rs-ink-ring');
    ring.style.left = posAt(ratio);
    INK_SPECS.forEach(function (sp) {
      var a = sp.angle * Math.PI / 180;
      var r0 = INK_START_RADIUS * INK_SCALE;
      var r1 = sp.radius * INK_SCALE;
      var ray = el('div', 'rs-ink-ray');
      ray.style.setProperty('--x0', (Math.cos(a) * r0).toFixed(2) + 'px');
      ray.style.setProperty('--y0', (Math.sin(a) * r0).toFixed(2) + 'px');
      ray.style.setProperty('--x1', (Math.cos(a) * r1).toFixed(2) + 'px');
      ray.style.setProperty('--y1', (Math.sin(a) * r1).toFixed(2) + 'px');
      ray.style.setProperty('--size', (sp.size * INK_SCALE).toFixed(2) + 'px');
      ray.style.setProperty('--ink', sp.ink);
      ray.style.setProperty('--duration', INK_DURATION + 'ms');
      ray.style.setProperty('--delay', (INK_START_DELAY + sp.delay) + 'ms');
      ring.appendChild(ray);
    });
    return ring;
  }

  function buildCard() {
    var n = tiers();
    var idx = indexOfDepth(opts.getDepth());
    if (idx < 0) idx = n - 1;
    ratio = ratioOfIndex(idx);
    var tier = n[idx] || { title: '—', desc: '' };

    var card = el('div', 'rs-pop rs-scope');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '推理强度');
    card.onclick = function (e) { e.stopPropagation(); };

    /* ---- 头部 ---- */
    var head = el('div', 'rs-head');

    var boost = el('button', 'rs-boost');
    boost.type = 'button';
    boost.title = '下一条消息附加「优先深入分析」偏好（仅一次）';
    boost.setAttribute('aria-label', '深入偏好开关');
    boost.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></svg>';
    if (opts.getBoost && opts.getBoost()) boost.classList.add('is-on');
    boost.onclick = function (e) {
      e.stopPropagation();
      var on = !(opts.getBoost && opts.getBoost());
      if (opts.setBoost) opts.setBoost(on);
      boost.classList.toggle('is-on', on);
      if (opts.onBoostToggle) opts.onBoostToggle(on);
    };
    head.appendChild(boost);

    /* 档位标题 + 模型名 = 一整块圆角分段（原插件把这两行包在同一个 button 里，
       整块才是「打开模型列表」的点击区）。这里必须照做，否则会多出一行、
       卡片比原版高一行，视觉上完全不同。 */
    var seg = el('button', 'rs-segment');
    seg.type = 'button';
    seg.setAttribute('aria-haspopup', 'dialog');
    seg.title = '切换模型';

    var title = el('span', 'rs-title', tier.title || '—');
    if (isUltraIndex(idx)) title.classList.add('is-ultra');
    else title.style.color = titleColorFor(idx);
    seg.appendChild(title);

    var modelName = (opts.getModel && opts.getModel().label) || '未配置模型';
    var subwrap = el('div', 'rs-subwrap');
    subwrap.dataset.notice = 'false';
    subwrap.appendChild(el('span', 'rs-quota', QUOTA_HINT));
    var sub = el('span', 'rs-sub');
    sub.appendChild(el('span', null, modelName));
    sub.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" '
      + 'stroke-width="1.4" stroke-linecap="round"><path d="M4.2 2.4 7.8 6l-3.6 3.6"/></svg>');
    subwrap.appendChild(sub);
    seg.appendChild(subwrap);

    seg.onclick = function (e) { e.stopPropagation(); showModels(); };
    head.appendChild(seg);

    var reset = el('button', 'rs-reset');
    reset.type = 'button';
    reset.title = '恢复默认档位';
    reset.setAttribute('aria-label', '恢复默认');
    reset.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.2"/></svg>';
    reset.onclick = function (e) { e.stopPropagation(); commitDepth(opts.defaultDepth, true); };
    head.appendChild(reset);

    card.appendChild(head);

    /* ---- 滑轨 ---- */
    var track = el('div', 'rs-track');
    track.setAttribute('role', 'slider');
    track.tabIndex = 0;
    track.setAttribute('aria-label', '推理强度');
    track.setAttribute('aria-valuemin', '1');
    track.setAttribute('aria-valuemax', String(n.length || 1));
    track.setAttribute('aria-valuenow', String(idx + 1));
    track.setAttribute('aria-valuetext', tier.title || '');
    track.appendChild(buildFill(ratio));
    if (burstAt) track.appendChild(buildInk());
    var knob = el('div', 'rs-knob');
    knob.style.left = posAt(ratio);
    track.appendChild(knob);

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('keydown', onKey);
    card.appendChild(track);

    if (!n.length) {
      card.appendChild(el('div', 'rs-note', '当前没有可用模型，无法调节推理强度'));
    }

    pop = card;
    document.body.appendChild(card);
    if (burstAt) playInk();
    positionCard();
    updateQuota(tier);
  }

  function updateQuota(tier) {
    if (!pop) return;
    var sw = pop.querySelector('.rs-subwrap');
    if (!sw) return;
    var isMax = isUltraIndex(indexOfDepth(opts.getDepth()));
    clearTimeout(noticeTimer);
    sw.dataset.notice = 'false';
    if (isMax) {
      sw.dataset.notice = 'true';
      noticeTimer = setTimeout(function () { if (sw) sw.dataset.notice = 'false'; }, 1600);
    }
  }

  function positionCard() {
    if (!pop || !anchorEl) return;
    var r = anchorEl.getBoundingClientRect();
    var h = pop.offsetHeight || 120;
    var left = Math.round(r.left + r.width / 2 - CARD_W / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
    var top = Math.round(r.top - h - 8);
    if (top < 8) top = Math.min(r.bottom + 8, Math.max(8, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  /* ======================================================================
   * 拖拽 / 键盘
   * ==================================================================== */
  function ratioFromEvent(e) {
    var track = pop && pop.querySelector('.rs-track');
    if (!track) return 0;
    var b = track.getBoundingClientRect();
    var usable = b.width - TRACK_H;
    if (usable <= 0) return 0;
    return clamp((e.clientX - b.left - TRACK_INSET) / usable, 0, 1);
  }

  function paint(r, dragging) {
    if (!pop) return;
    var fill = pop.querySelector('.rs-fill');
    var knob = pop.querySelector('.rs-knob');
    var track = pop.querySelector('.rs-track');
    if (!fill || !knob) return;
    if (dragging) {
      fill.style.width = posAt(r);
      fill.style.background = fillBg(r);
      knob.style.left = posAt(r);
      /* 拖动中星尘随位置实时更新。粒子数只在跨过阈值时才变，
         所以只在「数量变了」时重建 DOM，否则每帧重建 22 个节点会明显掉帧。 */
      var want = Math.round(energyFor(r) * PARTICLES.length);
      var layer = fill.querySelector('.rs-efstars');
      if (!layer || Number(layer.dataset.count) !== want) {
        if (layer) layer.remove();
        layer = starsHtml(r);
        layer.dataset.count = String(want);
        fill.insertBefore(layer, fill.firstChild);
      } else {
        layer.style.opacity = (0.6 + 0.4 * energyFor(r)).toFixed(3);
      }
      var ultra = fill.querySelector('.rs-ultra');
      var wantUltra = isUltraIndex(Math.round(r * (tiers().length - 1)));
      if (wantUltra && !ultra) {
        var u = el('div', 'rs-ultra');
        u.appendChild(el('i', 'rs-haze'));
        var au = el('div', 'rs-aurora');
        ['a1', 'a2', 'a3', 'a4'].forEach(function (c) { au.appendChild(el('i', c)); });
        u.appendChild(au);
        fill.appendChild(u);
      } else if (!wantUltra && ultra) {
        ultra.remove();
      }
      if (track) track.classList.add('is-dragging');
    }
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragActive = true;
    dragRatio = ratioFromEvent(e);
    paint(dragRatio, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }

  function onMove(e) {
    if (!dragActive) return;
    dragRatio = ratioFromEvent(e);
    paint(dragRatio, true);
  }

  function onUp() {
    if (!dragActive) return;
    dragActive = false;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    var track = pop && pop.querySelector('.rs-track');
    if (track) track.classList.remove('is-dragging');
    var n = tiers().length;
    if (!n) return;
    var idx = Math.round((dragRatio == null ? ratio : dragRatio) * (n - 1));
    dragRatio = null;
    commitDepth(tiers()[idx].v, false);
  }

  function onKey(e) {
    var n = tiers();
    if (!n.length) return;
    var idx = indexOfDepth(opts.getDepth());
    var next = idx;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n.length - 1, idx + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n.length - 1;
    else if (e.key === 'Escape') { close(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (next !== idx) commitDepth(n[next].v, false);
  }

  /* ======================================================================
   * 提交档位
   * ==================================================================== */
  function commitDepth(v, fromReset) {
    var n = tiers();
    var idx = indexOfDepth(v);
    if (idx < 0) return;
    var prev = indexOfDepth(opts.getDepth());
    var wasUltra = isUltraIndex(prev);
    if (opts.setDepth) {
      try { opts.setDepth(n[idx].v); } catch (e) { }
    }
    /* 重新渲染卡片（保持打开） */
    if (pop) { pop.remove(); pop = null; }
    buildCard();
    /* 到最高档那一下溅墨 */
    if (isUltraIndex(idx) && !wasUltra && !fromReset) burstInk();
    if (opts.onDepthChange) opts.onDepthChange(n[idx].v);
  }

  function burstInk() {
    if (!pop) return;
    var track = pop.querySelector('.rs-track');
    if (!track) return;
    var old = track.querySelector('.rs-ink-ring');
    if (old) old.remove();
    burstAt = Date.now();
    var ring = buildInk();
    track.insertBefore(ring, track.querySelector('.rs-knob'));
    playInk();
    clearTimeout(inkTimer);
    inkTimer = setTimeout(function () {
      burstAt = 0;
      var r = pop && pop.querySelector('.rs-ink-ring');
      if (r) r.remove();
    }, INK_TOTAL + 60);
  }

  function playInk() {
    var ring = pop && pop.querySelector('.rs-ink-ring');
    if (!ring) return;
    void ring.offsetWidth;
    ring.classList.add('is-bursting');
  }

  /* ======================================================================
   * 模型列表
   * ==================================================================== */
  function showModels() {
    if (!pop) return;
    view = 'models';
    hideTip();
    var cardRect = pop.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    if (modelsEl) modelsEl.remove();

    var box = el('div', 'rs-models rs-scope');
    box.onclick = function (e) { e.stopPropagation(); };
    var head = el('div', 'rs-models-head');
    head.appendChild(el('span', null, '选择模型'));
    var closeBtn = el('button', 'rs-models-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '返回';
    closeBtn.onclick = function (e) { e.stopPropagation(); hideModels(); };
    head.appendChild(closeBtn);
    box.appendChild(head);

    var body = el('div', 'rs-models-body');
    var groups = (opts.getGroups && opts.getGroups()) || [];
    var cur = (opts.getModel && opts.getModel().id) || '';
    var total = 0;
    groups.forEach(function (g) {
      if (!g.ids || !g.ids.length) return;
      var gEl = el('div', 'rs-group');
      var gh = el('div', 'rs-group-head');
      gh.appendChild(el('div', 'rs-group-name', g.name));
      gEl.appendChild(gh);
      g.ids.forEach(function (id) {
        var label = opts.labelOf ? opts.labelOf(id) : id;
        var row = el('div', 'rs-row' + (id === cur ? ' is-cur' : ''));
        row.dataset.id = id;
        row.appendChild(el('span', 'rs-row-nm', label));
        if (id === cur) {
          row.insertAdjacentHTML('beforeend', '<svg class="rs-row-tick" viewBox="0 0 16 16" fill="none" '
            + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M3 8.5 6.5 12 13 4.5"/></svg>');
        }
        row.onmouseenter = function () { showTip(row, label, id); };
        row.onmouseleave = hideTip;
        row.onclick = function (e) {
          e.stopPropagation();
          hideTip();
          if (opts.selectModel) {
            Promise.resolve(opts.selectModel(id)).then(function () {
              hideModels();
              if (pop) { pop.remove(); pop = null; }
              buildCard();
            }).catch(function () { hideModels(); });
          } else { hideModels(); }
        };
        gEl.appendChild(row);
        total++;
      });
      body.appendChild(gEl);
    });
    if (!total) body.appendChild(el('div', 'rs-note', '尚未配置 API Key，请先在设置里接入模板'));
    box.appendChild(body);

    document.body.appendChild(box);
    modelsEl = box;

    /* 列表落下来占卡片原来的位置：以卡片底边为基准向上生长 */
    var h = box.offsetHeight;
    var top = cardRect.bottom - h;
    if (top < 8) top = 8;
    var left = Math.max(8, Math.min(cardRect.left, window.innerWidth - CARD_W - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  function hideModels() {
    view = 'card';
    hideTip();
    if (modelsEl) { modelsEl.remove(); modelsEl = null; }
    if (pop) pop.style.visibility = '';
  }

  function showTip(row, label, id) {
    hideTip();
    if (!row) return;
    var text = label;
    if (opts.descOf) {
      var d = opts.descOf(id);
      if (d) text = d;
    }
    var t = el('div', 'rs-tip rs-scope', text);
    document.body.appendChild(t);
    var r = row.getBoundingClientRect();
    var w = TIP_W;
    var left = r.right + 5;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 5);
    var top = Math.round(r.top + r.height / 2 - t.offsetHeight / 2);
    top = Math.max(8, Math.min(top, window.innerHeight - t.offsetHeight - 8));
    t.style.left = left + 'px';
    t.style.top = top + 'px';
    tipEl = t;
  }
  function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

  /* ======================================================================
   * 打开 / 关闭
   * ==================================================================== */
  function toggle(anchor) {
    if (open) { close(); return; }
    anchorEl = anchor || anchorEl;
    open = true;
    /* 先通知外部改入口文字，再算卡片位置 —— 入口宽度会从「模型名+档位」变成
       「选择推理强度」，若先定位再改文字，卡片会偏一段（实测）。 */
    if (opts && opts.onOpenChange) opts.onOpenChange(true);
    buildCard();
    setTimeout(function () { document.addEventListener('pointerdown', onDocDown, true); }, 0);
  }

  function onDocDown(e) {
    if (!open) return;
    if (pop && pop.contains(e.target)) return;
    if (modelsEl && modelsEl.contains(e.target)) return;
    if (anchorEl && anchorEl.contains(e.target)) return;
    close();
  }

  function close() {
    if (!open) return;
    open = false;
    dragActive = false;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    document.removeEventListener('pointerdown', onDocDown, true);
    hideModels();
    hideTip();
    clearTimeout(inkTimer);
    clearTimeout(noticeTimer);
    burstAt = 0;
    if (pop) { pop.remove(); pop = null; }
    if (opts && opts.onOpenChange) opts.onOpenChange(false);
  }

  function refresh() {
    if (!open) return;
    if (modelsEl) { hideModels(); }
    if (pop) { pop.remove(); pop = null; }
    buildCard();
  }

  window.addEventListener('resize', function () {
    if (!open) return;
    if (modelsEl) { hideModels(); }
    positionCard();
  });

  window.ReasoningSlider = {
    init: function (o) {
      injectStyle();
      opts = o || {};
      if (opts.defaultDepth == null) opts.defaultDepth = 'high';
      return this;
    },
    toggle: toggle,
    close: close,
    isOpen: function () { return open; },
    refresh: refresh,
    /* 供外部（设置页 / 快捷键）直接提交 */
    setDepth: function (v) { commitDepth(v, true); },
    ratioOfIndex: ratioOfIndex,
    indexOfDepth: indexOfDepth,
    isUltraIndex: isUltraIndex,
    _internals: { PARTICLES: PARTICLES, fillBg: fillBg, energyFor: energyFor, speedFor: speedFor, starDuration: starDuration, starBright: starBright }
  };
})();
