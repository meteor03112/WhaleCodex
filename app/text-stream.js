/**
 * 正文增量事件的应用规则（活跃 run 续订 · 读取端）
 *
 * 前后端共用同一份判定：workbench.js 用它把 stream.delta 落到气泡上，
 * Node 单测直接 require 这个文件测真实实现（不复制逻辑）。
 *
 * 事件形状（由 run-registry.js 的 flushText 产生）：
 *   { requestId, channel, offset, text, total }
 * 不变量：同一 (runId, requestId, channel) 内 offset 严格连续、不重叠。
 *
 * 状态：{ requestId, len, text, baseOffset, truncated }
 *   len 是累计字符数（含被服务端截断掉的部分），text 是当前可显示的文本。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WhaleTextStream = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function init(requestId) {
    return { requestId: requestId == null ? null : String(requestId), len: 0, text: '', baseOffset: 0, truncated: false };
  }

  /** 用后端快照做初值（attach 或修复时用）。 */
  function fromSnapshot(snap) {
    var c = (snap && snap.content) || {};
    var text = String(c.text == null ? '' : c.text);
    var len = typeof c.len === 'number' ? c.len : text.length;
    var baseOffset = typeof c.baseOffset === 'number' ? c.baseOffset : Math.max(0, len - text.length);
    return {
      requestId: snap && snap.requestId != null ? String(snap.requestId) : null,
      len: len,
      text: text,
      baseOffset: baseOffset,
      truncated: !!(c.truncated || baseOffset > 0),
    };
  }

  /**
   * 应用一条 stream.delta。
   * @returns {{action:'append'|'ignore'|'repair'|'reset', state:object}}
   *   append  正常追加
   *   ignore  重复帧（已收到过）
   *   repair  缺帧/部分重叠 → 调用方应拉 /text 快照整体替换
   *   reset   请求切换（新气泡）
   */
  function apply(state, ev) {
    var s = state || init(null);
    var p = ev || {};
    var text = String(p.text == null ? '' : p.text);
    var off = Number(p.offset);
    var reqId = p.requestId == null ? '' : String(p.requestId);

    if (!text || !isFinite(off)) return { action: 'ignore', state: s };

    // 请求切换：清空后按新请求重新判断（重试/协议回退会产生新 requestId）
    if (reqId !== String(s.requestId == null ? '' : s.requestId)) {
      var fresh = init(reqId);
      var r = apply(fresh, ev);
      return { action: 'reset', state: r.state };
    }

    if (off === s.len) {
      return {
        action: 'append',
        state: {
          requestId: s.requestId, len: s.len + text.length, text: s.text + text,
          baseOffset: s.baseOffset, truncated: s.truncated,
        },
      };
    }
    // 已经收到过（重复帧）
    if (off + text.length <= s.len) return { action: 'ignore', state: s };
    // 中间缺了一段，或与已有内容部分重叠：交给快照修复
    return { action: 'repair', state: s };
  }

  /**
   * 只把「正文」通道拼进答案气泡。
   * reasoning 是模型的思考过程，不是答案；混进来会让气泡显示成思考稿。
   * 事件缺 channel 时按正文处理（兼容旧事件）。
   */
  function isContent(ev) {
    var ch = ev && ev.channel;
    return !ch || ch === 'content';
  }

  return { init: init, fromSnapshot: fromSnapshot, apply: apply, isContent: isContent };
});
