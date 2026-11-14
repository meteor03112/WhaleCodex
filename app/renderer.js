// Modified for public source portability, 2026-11-14.

const $ = s => document.querySelector(s);
const store = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
};
/* 模型可在工具栏与设置里切换；本地记住上次选择，服务端目录为准 */
const MODEL_FALLBACK = 'deepseek-ai/deepseek-v4.1-flash';
const MODEL_LABEL_FALLBACK = {
  'deepseek-ai/deepseek-v4.1-flash':'DeepSeek-V4.1-Flash',
  'nvidia/nemotron-3-ultra-550b-a55b':'Nemotron-3-Ultra-550B',
  'nvidia/nemotron-3.5-lightning-30b-a3b':'Nemotron-3.5-Lightning',
  'nvidia/nemotron-3.5-bolt-e4b':'Nemotron-3.5-Bolt',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning':'Nemotron-3-Nano-Omni',
  'nvidia/nemotron-3.5-super-vl-120b-a12b':'Nemotron-3.5-Super-VL',
  'poolside/laguna-xs-2.1':'Poolside-Laguna-XS',
  'stepfun-ai/step-5-preview':'Step-5-Preview',
  'minimaxai/minimax-m3.1-flash':'MiniMax-M3.1-Flash',
  'z-ai/glm-5.3-flash':'GLM-5.3-Flash'
};
/* Agent 引擎别名：让用户能直接看到「模型名会不会被引擎关掉工具」 */
function renderEngineAlias(s){
  const box = $('#engineAliasBox');
  if(!box) return;
  const real = (s && s.model) || MODEL || '';
  const eng = (s && s.engineModel) || real;
  const aliased = eng && real && eng !== real;
  box.innerHTML =
    '<div>真实模型：<b>' + escapeHtml(real) + '</b></div>'
    + '<div>引擎收到：<b>' + escapeHtml(eng) + '</b>'
    + (aliased
        ? ' <span style="color:var(--accent)">（已用别名规避「引擎按模型名关工具」）</span>'
        : ' <span style="color:var(--text-3)">（同名直通）</span>')
    + '</div>';
}

/* ---------- 设置页分类导航 ---------- */
const SET_PAGES = {
  model:{ t:'模型与接口', s:'切换当前模型、管理 API 密钥模板，并查看每个模型的实况。' },
  gen:{ t:'生成', s:'思考深度，以及排队或限流时的自动切换策略。' },
  agent:{ t:'Agent 安全', s:'工作目录白名单与安全模式；越界会被直接拒绝。' },
  ctx:{ t:'上下文与目录', s:'上下文上限、自动归档阈值、数据目录与记忆注入。' },
  voice:{ t:'语音', s:'本地识别模型、识别语言，以及外部语音与机器人服务。' },
  diag:{ t:'自检与诊断', s:'一键自检、模型协议档位与模型活动日志。' }
};
let setCat = 'model';
function showSetPage(cat){
  if(!SET_PAGES[cat]) cat = 'model';
  setCat = cat;
  document.querySelectorAll('#setNav .set-nav-i').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  document.querySelectorAll('#setBody .set-page').forEach(p => { p.hidden = p.dataset.cat !== cat; });
  const meta = SET_PAGES[cat];
  const t = $('#setPageTitle'), sub = $('#setPageSub');
  if(t) t.textContent = meta.t;
  if(sub) sub.textContent = meta.s;
  const body = $('#setBody'); if(body) body.scrollTop = 0;
  const sel = $('#setCompactCat');
  if(sel && sel.value !== cat) sel.value = cat;
  try { store.set('whale.setCat', cat); } catch(e) {}
}
/* 分类搜索匹配：分类名 + 该分类内的分组标题与字段名（不搜输入框里的值） */
function setCatMatches(cat, q){
  if(!q) return true;
  const meta = SET_PAGES[cat];
  const label = ((meta && meta.t) || '').toLowerCase();
  if(label.includes(q)) return true;
  const page = document.querySelector('#setBody .set-page[data-cat="' + cat + '"]');
  if(!page) return false;
  const secText = Array.from(page.querySelectorAll('.sect-t,.fld > label'))
    .map(x => x.textContent).join(' ').toLowerCase();
  return secText.includes(q);
}
/* 搜索：桌面导航与紧凑入口共用同一份结果，不允许一边无结果另一边仍留六项 */
function filterSetNav(q){
  q = String(q || '').trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#setNav .set-nav-i').forEach(it => {
    const hit = setCatMatches(it.dataset.cat, q);
    it.style.display = hit ? '' : 'none';
    if(hit) shown++;
  });
  document.querySelectorAll('#setNav .set-nav-g').forEach(g => {
    let n = g.nextElementSibling, any = false;
    while(n && !n.classList.contains('set-nav-g')){
      if(n.classList.contains('set-nav-i') && n.style.display !== 'none') any = true;
      n = n.nextElementSibling;
    }
    g.style.display = any ? '' : 'none';
  });
  // 紧凑下拉：同步过滤，无匹配时禁用选择器（但不清空表单、不写非法 cat）
  const sel = $('#setCompactCat');
  if(sel){
    let any = false;
    Array.from(sel.options).forEach(o => {
      const hit = setCatMatches(o.value, q);
      o.hidden = !hit;
      o.disabled = !hit;
      if(hit) any = true;
    });
    sel.disabled = !any;
  }
  const hint = $('#setFootNote');
  if(hint) hint.textContent = q ? (shown ? ('找到 ' + shown + ' 个分类') : '没有匹配的设置项') : '改动点保存后生效';
}
function bindSetNav(){
  const nav = $('#setNav');
  if(nav && !nav.dataset.bound){
    nav.dataset.bound = '1';
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('.set-nav-i');
      if(b) showSetPage(b.dataset.cat);
    });
  }
  const q = $('#setSearch');
  if(q && !q.dataset.bound){
    q.dataset.bound = '1';
    q.addEventListener('input', () => filterSetNav(q.value));
    q.addEventListener('keydown', (e) => {
      if(e.key !== 'Enter') return;
      const first = Array.from(document.querySelectorAll('#setNav .set-nav-i')).find(x => x.style.display !== 'none');
      if(first) showSetPage(first.dataset.cat);
    });
  }
  // 紧凑分类下拉：选项从 SET_PAGES 生成，变化只调用 showSetPage
  const sel = $('#setCompactCat');
  if(sel && !sel.dataset.bound){
    sel.dataset.bound = '1';
    if(!sel.options.length){
      Object.keys(SET_PAGES).forEach(cat => {
        const o = document.createElement('option');
        o.value = cat; o.textContent = SET_PAGES[cat].t;
        sel.appendChild(o);
      });
    }
    sel.value = setCat;
    sel.addEventListener('change', () => showSetPage(sel.value));
  }
  // 紧凑搜索框：与桌面搜索框共享查询与结果
  const cq = $('#setCompactSearch');
  if(cq && !cq.dataset.bound){
    cq.dataset.bound = '1';
    cq.addEventListener('input', () => {
      const desk = $('#setSearch'); if(desk) desk.value = cq.value;
      filterSetNav(cq.value);
    });
    cq.addEventListener('keydown', (e) => {
      if(e.key !== 'Enter') return;
      const first = Array.from(document.querySelectorAll('#setNav .set-nav-i')).find(x => x.style.display !== 'none');
      if(first) showSetPage(first.dataset.cat);
    });
  }
  // 署名区：复制来源与许可（纯文本，不为外链放宽窗口导航）
  const lc = $('#btnCopyLicense');
  if(lc && !lc.dataset.bound){
    lc.dataset.bound = '1';
    lc.addEventListener('click', () => {
      const text = [
        '主题：鲸鱼娘 · 未至之境（Whale Girl · The Unreached）1.0.0',
        '作者：stushansusu',
        '来源：https://github.com/zhu1090093659/dsh-web/tree/971cc3e1f6f5b52bbcd86802a9be0e0c50fc32f1/market/dist/assets/skins/whale-fantasy',
        '许可：CC BY-NC-SA 4.0  https://creativecommons.org/licenses/by-nc-sa/4.0/',
        '适配：为 WhaleCodex 原生界面重新映射选择器与资源加载；宏观布局参考 WorkBuddy；未引入 DSH 插件宿主。',
      ].join('\n');
      copy(text);
    });
  }
}

let MODEL = store.get('whale.model', MODEL_FALLBACK);
let MODEL_LABEL = MODEL_LABEL_FALLBACK[MODEL] || MODEL;
const MODEL_CATALOG_FALLBACK = {
  'deepseek-ai/deepseek-v4.1-flash':{ wire:'chat', group:'旗舰', health:'congested', desc:'旗舰 · 强制思考（NIM 队列可能拥塞）' },
  'nvidia/nemotron-3-ultra-550b-a55b':{ wire:'responses', group:'旗舰', health:'ok', desc:'550B MoE · 1M 上下文 · 长程 agent / 工具调用' }
};
let modelList = Object.keys(MODEL_LABEL_FALLBACK);
let modelLabels = Object.assign({}, MODEL_LABEL_FALLBACK);
let modelCatalog = Object.assign({}, MODEL_CATALOG_FALLBACK);
// 云端返回的模型显示名（provider 获取可用模型时填充），labelOf 优先用它
let cloudModelNames = {};
// 模型 → 所属模板 id（后端下发）；用户手动勾选的自定义模型也靠它路由 / 分组
let modelOwners = {};
function labelOf(m){
  if(modelLabels && modelLabels[m]) return modelLabels[m];
  if(cloudModelNames && cloudModelNames[m]) return cloudModelNames[m];
  // 未知模型：取 id 最后一段作为友好名（如 a/b/model-x → model-x）
  const seg = String(m||'').split('/').pop();
  return seg || m;
}
// 模型胶囊：文字只截断中间，右箭头用统一 SVG（字符 ⌄ 在不同字体下会歪/偏大）
function setModelPill(){
  const btn=$('#btnModel'); if(!btn) return;
  btn.innerHTML='<span class="mp-name"></span><span class="mp-eff"></span>'+ICON.chev;
  // 卡片打开时入口切成原版的「选择推理强度」形态；任何一次重绘都要守住这个状态，
  // 否则拖档位 → setDepth → setModelPill 会把文字刷回模型名（实测踩过）。
  const opened = !!(window.ReasoningSlider && ReasoningSlider.isOpen());
  const n=btn.querySelector('.mp-name'); if(n) n.textContent = opened ? '选择推理强度' : MODEL_LABEL;
  const e=btn.querySelector('.mp-eff'); if(e) e.textContent = opened ? '' : depthTitle(depth);
  btn.title = opened ? '选择推理强度' : (MODEL_LABEL+' · 推理强度 '+depthTitle(depth));
  btn.setAttribute('aria-label', opened ? '选择推理强度' : (MODEL_LABEL+'，推理强度 '+depthTitle(depth)));
}

/* 线性图标（贴近 DSH 的描边风格） */
const ICON = {
  plus:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  shield:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/></svg>',
  send:'<svg class="ic" viewBox="0 0 24 24" style="stroke-width:2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop:'<svg class="ic" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  archive:'<svg class="ic" viewBox="0 0 24 24"><path d="M3 7h18v3H3zM5 10v9h14v-9M10 14h4"/></svg>',
  download:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  gear:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  book:'<svg class="ic" viewBox="0 0 24 24"><path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5z"/><path d="M8 3v18"/></svg>',
  bot:'<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 14h.01M15 14h.01M9 17h6"/></svg>',
  file:'<svg class="ic" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>',
  copy:'<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 00-2 2v9"/></svg>',
  chev:'<svg class="chev" viewBox="0 0 12 12"><path d="M3 4.6 6 7.6 9 4.6"/></svg>',
  mic:'<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>',
  refresh:'<svg class="ic" viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2.6 6"/><path d="M20 5v6h-6"/></svg>',
  folder:'<svg class="ic" viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
  trash:'<svg class="ic" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  pencil:'<svg class="ic" viewBox="0 0 24 24"><path d="M4 20h4l10-10a2.1 2.1 0 10-3-3L5 17l-1 3z"/><path d="M13 7l3 3"/></svg>',
  chatPlus:'<svg class="ic" viewBox="0 0 24 24"><path d="M20 14a3 3 0 01-3 3H8l-4 3V6a3 3 0 013-3h6"/><path d="M18 3v6M15 6h6"/></svg>',
  layers:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path d="M4 12.5L12 17l8-4.5M4 16.5L12 21l8-4.5"/></svg>',
  cpu:'<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>',
  eraser:'<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/></svg>'
};

// localStorage 只作为旧版数据源：加载磁盘成功后立刻清掉，避免两份数据分叉
let legacyChats = store.get('whale.chats', []);
if (!Array.isArray(legacyChats)) legacyChats = [];
let chats = legacyChats.slice();
let activeId = chats.length ? chats[0].id : null;
let history = [];
let mode = 'chat';
let depth = store.get('whale.depth','high');
let busy = false;
let switchAbort = false;   // 因切换模型而中止：不弹"已停止"，避免和"已切换"两条提示打架
let abort = null;
let stepCount = 0, roundCount = 0, totalTokens = 0;
// P0：当前这次运行的 runId（后端分配）。停止只取消它，不再走全局 /api/stop。
let currentRunId = '';
// P1：最近一次投影（真实指标）。缺失一律显示「未上报」，不补 0。
let lastStats = null;
let memoryPrefix = '';
let cfg = {compactAt:100000, contextLimit:350000, injectMemory:true};
let lastRun = null;        // 最近一次运行 {node, content}，供「重试这一轮」重跑
let lastPromptTokens = 0;  // 上一轮服务端返回的真实 prompt_tokens，作为上下文占用的基准
let ctxLimit = 350000;     // 模型上下文上限（token）
let compactAt = 100000;    // 达到该值触发自动归档

if (window.marked) marked.setOptions({breaks:true, gfm:true});

/* ---------- 工具 ---------- */
function fmtK(n){ return n>=1e6 ? (n/1e6).toFixed(1)+'M' : n>=1000 ? (n/1000).toFixed(1)+'K' : String(n); }
function estTokens(t){ if(!t) return 0; let c=0,o=0; for(const ch of t){ /[\u3000-\u9fff\uff00-\uffef]/.test(ch)?c++:o++; } return Math.round(c+o*0.3); }
function copy(text){
  const s = String(text||'');
  if(!s){ toast('没有可复制的内容'); return; }
  const done = ()=>toast('已复制');
  const fallback = ()=>{
    try{
      const ta=document.createElement('textarea');
      ta.value=s; ta.style.cssText='position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      const ok=document.execCommand('copy'); ta.remove();
      ok?done():toast('复制失败，请手动选择文本');
    }catch(e){ toast('复制失败，请手动选择文本'); }
  };
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(s).then(done).catch(fallback);
  } else fallback();
}
let toastTimer=null;
function toast(msg){
  let el=$('#toast');
  if(!el){
    el=document.createElement('div'); el.id='toast'; el.className='whale-toast';
    el.style.cssText='position:fixed;left:50%;top:64px;transform:translateX(-50%);padding:7px 14px;z-index:200;opacity:0;transition:.2s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent=msg; el.style.opacity='1';
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{ el.style.opacity='0'; },1400);
}

/* ---------- 渲染 markdown ---------- */
function renderMD(text){
  try{
    const html = marked.parse(text||'');
    const clean = DOMPurify.sanitize(html,{USE_PROFILES:{html:true}});
    const div = document.createElement('div');
    div.innerHTML = clean;
    // 表格只加局部横滚容器：保留原消息根与既有 hljs / 复制 / 保存增强
    div.querySelectorAll('table').forEach(table => {
      if(table.parentElement && table.parentElement.classList.contains('whale-table-scroll')) return;
      const region = document.createElement('div');
      region.className = 'whale-table-scroll';
      region.tabIndex = 0;
      region.setAttribute('role', 'region');
      region.setAttribute('aria-label', '表格，可横向滚动');
      table.replaceWith(region);
      region.appendChild(table);
    });
    div.querySelectorAll('pre code').forEach(el=>{
      try{ hljs.highlightElement(el); }catch(e){}
      const pre = el.parentElement;
      const bar = document.createElement('div');
      bar.className='code-bar';
      bar.style.cssText='position:absolute;right:8px;top:6px;display:flex;gap:6px';
      const b1=document.createElement('button'); b1.textContent='复制';
      b1.className='code-btn';
      b1.onclick=()=>copy(el.textContent);
      const b2=document.createElement('button'); b2.textContent='保存';
      b2.className='code-btn save';
      b2.onclick=()=>saveCode(el.textContent);
      bar.appendChild(b1); bar.appendChild(b2);
      pre.appendChild(bar);
    });
    return div;
  }catch(e){ const d=document.createElement('div'); d.textContent=text||''; return d; }
}
async function saveCode(code){
  const name = prompt('保存文件名（如 src/a.js）：');
  if(!name) return;
  try{
    const r = await fetch('/api/save-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,content:code})});
    const j = await r.json();
    toast(j.ok ? '已保存：'+j.path : '保存失败：'+(j.error||'未知'));
  }catch(e){ toast('保存失败'); }
}

/* ---------- 会话 ---------- */
/* 会话落盘：不再把整份数组塞 localStorage（写满 5MB 后 setItem 静默失败，
   新会话会悄悄存不进去）。改成按会话分片写磁盘，350ms 防抖合并写入。 */
let chatSaveTimer = null;
const dirtyChats = new Set();
let chatsReady = false;      // 磁盘加载完成前不写盘，避免用旧内存覆盖磁盘
let chatWriteError = null;

function saveChats(){
  const c = cur();
  if (c) { dirtyChats.add(c.id); c.updatedAt = Date.now(); }
  schedulePeekRender();
  if (!chatsReady) return;
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(flushChatSave, 350);
}
function flushChatSave(){
  clearTimeout(chatSaveTimer); chatSaveTimer = null;
  const ids = [...dirtyChats]; dirtyChats.clear();
  ids.forEach(id=>{
    const c = chats.find(x=>x.id===id);
    if (!c) return;
    try{
      fetch('/api/chats/'+encodeURIComponent(id), {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(c), keepalive: true
      }).then(r=>r.json()).then(j=>{
        if (j && j.ok === false){ chatWriteError = j.error || '未知错误'; toast('会话保存失败：'+chatWriteError); }
      }).catch(()=>{});
    }catch(e){}
  });
}
function deleteChatOnDisk(id){
  dirtyChats.delete(id);
  try{ fetch('/api/chats/'+encodeURIComponent(id), { method:'DELETE', keepalive:true }); }catch(e){}
}
function cur(){ return chats.find(c=>c.id===activeId); }
function flushCurrentChat(){
  const c=cur();
  if(c){ c.messages = history.slice(); saveChats(); }
}
function newChat(){
  flushCurrentChat();   // 切换前先落盘，避免当前会话最后几条消息丢失
  const c = { id: Date.now().toString(36), title:'新会话', messages:[] };
  chats.unshift(c); activeId=c.id; history=[];
  saveChats(); renderList(); renderTranscript(); updateTitle(); updateStats(); refreshThreadStats();
}
// 全文搜索：本地先按标题过滤（即时），后端再补上"消息正文命中"的结果
let searchHits = [];
let searchTimer = null;
let searchSeq = 0;

function mergeSearchList(q){
  if (!q) return chats.map(c=>({c, hit:null}));
  const needle = q.toLowerCase();
  const seen = new Set();
  const out = [];
  chats.forEach(c=>{
    if (String(c.title||'').toLowerCase().includes(needle)){ seen.add(String(c.id)); out.push({c, hit:null}); }
  });
  searchHits.forEach(h=>{
    if (seen.has(String(h.id))) return;
    const c = chats.find(x=>String(x.id)===String(h.id));
    if (c){ seen.add(String(h.id)); out.push({c, hit:h}); }
  });
  return out;
}

/* ---------- 会话记录：分组 / 时间 / 条数 / 重命名 ---------- */
function chatMsgs(c){ return (c && c.id===activeId) ? history : ((c && Array.isArray(c.messages)) ? c.messages : []); }
function chatCount(c){ return chatMsgs(c).length; }
function chatStamp(c){ return (c && (c.updatedAt || c.created)) || 0; }
function pad2(n){ return n<10 ? '0'+n : ''+n; }
function dayDiff(ts){
  if(!ts) return 9999;
  const d=new Date(ts), now=new Date();
  const a=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  const b=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  return Math.round((b-a)/86400000);
}
function timeLabel(ts){
  if(!ts) return '';
  const d=new Date(ts), diff=dayDiff(ts);
  const hm=pad2(d.getHours())+':'+pad2(d.getMinutes());
  if(diff<=0) return hm;
  if(diff===1) return '昨天 '+hm;
  if(diff<7) return diff+' 天前';
  if(d.getFullYear()===new Date().getFullYear()) return (d.getMonth()+1)+'月'+d.getDate()+'日';
  return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate();
}
function dayBucket(ts){
  const diff=dayDiff(ts);
  if(diff<=0) return '今天';
  if(diff===1) return '昨天';
  if(diff<7) return '近 7 天';
  if(diff<30) return '近 30 天';
  return '更早';
}
function autoTitle(text, images){
  let t=String(text||'')
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/[#>*`_~\r\n]+/g,' ')
    .replace(/\s+/g,' ').trim();
  if(!t) t = (images && images.length) ? '图片对话' : '新会话';
  return t.length>24 ? t.slice(0,24)+'…' : t;
}

function renderList(){
  const box = $('#chatList'); box.innerHTML='';
  const q = ($('#search').value||'').trim();
  const list = mergeSearchList(q);
  if(!list.length){
    const d=document.createElement('div');
    d.className='sb-empty';
    d.textContent = q ? (searchTimer ? '搜索中…' : '没有匹配的会话') : '还没有会话';
    box.appendChild(d); renderPeekRail(); renderPeek(); return;
  }
  if(q){
    // 搜索态平铺，不分组，命中优先
    const g = document.createElement('div'); g.className='sb-group';
    g.textContent = '搜索结果 · '+list.length+' 个';
    box.appendChild(g);
    list.forEach(({c, hit})=> box.appendChild(chatRow(c, hit)));
  } else {
    const order = ['今天','昨天','近 7 天','近 30 天','更早'];
    const buckets = new Map();
    list.slice().sort((a,b)=>chatStamp(b.c)-chatStamp(a.c)).forEach(({c, hit})=>{
      const k = dayBucket(chatStamp(c));
      if(!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({c, hit});
    });
    order.forEach(k=>{
      const arr = buckets.get(k);
      if(!arr || !arr.length) return;
      const g = document.createElement('div'); g.className='sb-group'; g.textContent=k;
      box.appendChild(g);
      arr.forEach(({c, hit})=> box.appendChild(chatRow(c, hit)));
    });
  }
  renderPeekRail();
  renderPeek();
}

function chatRow(c, hit){
  const row = document.createElement('div');
  row.className = 'sb-item-row'+(c.id===activeId?' on':'')+(hit?' hit':'');
  const txt = document.createElement('div'); txt.className='txt';
  const t = document.createElement('div'); t.className='t'; t.textContent = c.title || '新会话';
  txt.appendChild(t);

  const meta = document.createElement('div'); meta.className='meta';
  const n = chatCount(c);
  meta.textContent = [timeLabel(chatStamp(c)), n ? n+' 条' : '空会话'].filter(Boolean).join(' · ');
  txt.appendChild(meta);

  if(hit && hit.snippet){
    const s = document.createElement('div'); s.className='s'; s.textContent=hit.snippet; s.title=hit.snippet;
    txt.appendChild(s);
  }

  const acts = document.createElement('div'); acts.className='sb-acts';
  const bRename = document.createElement('button'); bRename.title='重命名'; bRename.innerHTML=ICON.pencil;
  bRename.onclick = (e)=>{ e.stopPropagation(); startRename(row, txt, t, c); };
  const bCopy = document.createElement('button'); bCopy.title='复制该会话'; bCopy.innerHTML=ICON.copy;
  bCopy.onclick = (e)=>{ e.stopPropagation(); flushCurrentChat(); copy(chatToMd(c)); };
  const bDel = document.createElement('button'); bDel.title='删除该会话'; bDel.className='danger'; bDel.innerHTML=ICON.trash;
  bDel.onclick = (e)=>{ e.stopPropagation(); delChatGuarded(c); };
  acts.appendChild(bRename); acts.appendChild(bCopy); acts.appendChild(bDel);

  row.appendChild(txt); row.appendChild(acts);
  row.onclick = ()=> openChat(c.id);
  row.ondblclick = (e)=>{ e.stopPropagation(); startRename(row, txt, t, c); };
  return row;
}

function startRename(row, txt, tEl, c){
  if(row.querySelector('.rename')) return;
  const inp = document.createElement('input');
  inp.className='rename'; inp.value = c.title || '';
  tEl.style.display='none';
  txt.insertBefore(inp, tEl);
  inp.focus(); inp.select();
  let done=false;
  const finish = (ok)=>{
    if(done) return; done=true;
    const v = inp.value.trim();
    if(ok && v && v !== c.title){
      c.title = v.slice(0,60);
      c.updatedAt = Date.now();
      saveChats(); renderList(); updateTitle();
    } else {
      inp.remove(); tEl.style.display='';
    }
  };
  inp.onclick = (e)=> e.stopPropagation();
  inp.ondblclick = (e)=> e.stopPropagation();
  inp.onblur = ()=> finish(false);
  inp.onkeydown = (e)=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); finish(true); }
    else if(e.key==='Escape'){ e.preventDefault(); finish(false); }
  };
}
/* 切换会话（侧栏与右侧速览共用同一入口，避免两处逻辑漂移） */
function openChat(id){
  if(!id || id===activeId) return;
  flushCurrentChat();
  const c = chats.find(x=>x.id===id);
  if(!c) return;
  activeId = id; history = (c.messages||[]).slice();
  renderList(); renderTranscript(); updateTitle(); updateStats(); refreshThreadStats();
}

/* ---------- 右侧：会话记录（只列你的提问，悬停展开、点击定位） ---------- */
let peekHideTimer = null;
let peekRenderTimer = null;
let peekOpenTimer = null;
let peekCooldownUntil = 0;

// 把一条消息压成一行纯文本
function peekPlain(m){
  const raw = String((m && m.content) || '');
  let t = raw
    .replace(/```[\s\S]*?```/g,'（代码块）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,'（图片）')
    .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/[#>*`_~]+/g,' ')
    .replace(/\s+/g,' ').trim();
  if(t) return t;
  const n = (m && m.images) ? m.images.length : 0;
  if(n) return '（'+n+' 张图片）';
  return '（空提问）';
}
// 当前会话里所有「你」的提问（带原始下标，用于定位）
function peekTurns(){
  const out = [];
  (history || []).forEach((m,i)=>{
    if(m.role !== 'user') return;
    out.push({ i, text: peekPlain(m) });
  });
  return out;
}
// 贴边刻度：一条提问一道，最新一道加深
function renderPeekRail(){
  const rail = $('#peekRail'); if(!rail) return;
  const qs = peekTurns();
  rail.innerHTML = '';
  if(!qs.length){ rail.style.display = 'none'; return; }
  rail.style.display = 'flex';
  const MAX = 28;                                   // 提问太多时抽样，避免挤成一片
  const step = Math.ceil(qs.length / MAX);
  const shown = qs.filter((_,k)=> k % step === 0);
  shown.forEach((q,k)=>{
    const d = document.createElement('div');
    d.className = 'rk' + (k === shown.length-1 ? ' cur' : '');
    rail.appendChild(d);
  });
}
function renderPeek(){
  const panel = $('#peek'), list = $('#peekList');
  if(!panel || !list) return;
  if(!panel.classList.contains('show')) return;      // 收起时不白算
  const qs = peekTurns();
  list.innerHTML = '';
  if(!qs.length){
    const d = document.createElement('div'); d.className = 'pk-empty';
    d.textContent = '当前会话还没有提问';
    list.appendChild(d); return;
  }
  const frag = document.createDocumentFragment();
  qs.forEach(q=>{
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pk-row';
    row.title = q.text;
    const t = document.createElement('span'); t.className = 'pk-t'; t.textContent = q.text;
    const tick = document.createElement('span'); tick.className = 'pk-tick';
    row.appendChild(t); row.appendChild(tick);
    row.onclick = ()=> jumpToMessage(q.i);
    frag.appendChild(row);
  });
  list.appendChild(frag);
  list.scrollTop = list.scrollHeight;                // 默认停在最新一条
}
function schedulePeekRender(){
  clearTimeout(peekRenderTimer);
  peekRenderTimer = setTimeout(()=>{ renderPeekRail(); renderPeek(); }, 200);
}
function jumpToMessage(i){
  const node = $('#inner').querySelectorAll(':scope > .msg')[i];
  if(!node){ toast('该条消息当前不可见'); return; }
  autoFollow = false;
  try{ node.scrollIntoView({block:'center', behavior:'smooth'}); }
  catch(e){ node.scrollIntoView(); }
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  setTimeout(()=>node.classList.remove('flash'), 1400);
}
function showPeek(){
  clearTimeout(peekHideTimer); clearTimeout(peekOpenTimer);
  $('#peek').classList.add('show');
  document.body.classList.add('peek-open');
  renderPeek();
}
function closePeekNow(){
  $('#peek').classList.remove('show');
  document.body.classList.remove('peek-open');
  peekCooldownUntil = Date.now() + 320;              // 防：鼠标退到贴边处又立刻弹回来
}
function hidePeek(){
  clearTimeout(peekHideTimer);
  peekHideTimer = setTimeout(closePeekNow, 220);
}
/* 交互：鼠标贴到右边缘 → 刻度展开成提问清单；移开淡出 */
(function bindPeek(){
  const rail = $('#peekRail'), panel = $('#peek');
  if(!rail || !panel) return;
  rail.addEventListener('mouseenter', ()=>{
    if(Date.now() < peekCooldownUntil) return;
    clearTimeout(peekHideTimer); clearTimeout(peekOpenTimer);
    peekOpenTimer = setTimeout(showPeek, 90);
  });
  rail.addEventListener('mouseleave', hidePeek);
  panel.addEventListener('mouseenter', ()=>{ clearTimeout(peekHideTimer); });
  panel.addEventListener('mouseleave', hidePeek);
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape') closePeekNow();
  });
  renderPeekRail();
})();
function delChatGuarded(c){
  const n = chatCount(c);
  if(n > 0 && !confirm('删除会话「'+(c.title||'新会话')+'」？\n共 '+n+' 条消息，删除后无法恢复。')) return;
  delChat(c.id);
}
function delChat(id){
  flushCurrentChat();
  deleteChatOnDisk(id);
  const wasActive = (activeId===id);
  chats = chats.filter(c=>c.id!==id);
  if(wasActive){
    activeId = chats.length?chats[0].id:null;
    history = activeId?chats[0].messages.slice():[];
    if(!activeId){ newChat(); return; }
  }
  saveChats(); renderList();
  if(wasActive) renderTranscript(true);   // 删的不是当前会话就不用重绘正文
  updateTitle(); updateStats();
}
function updateTitle(){
  const c=cur();
  $('#title').textContent = c?(c.title||'新会话'):'新会话';
}

/* ---------- 消息渲染 ---------- */
// 增量渲染：同一会话只是新增消息时，只 append 新的几条。
// 以前每次都 innerHTML='' 全量重建，几百条的会话切一次要重建整棵 DOM，
// 代码块高亮全部重跑，展开的推理块和滚动位置也一起丢。
let renderedChatId = null;
let renderedCount = 0;
function renderTranscript(force){
  const box = $('#inner');
  const domCount = box.querySelectorAll(':scope > .msg').length;
  const canAppend = !force && renderedChatId === activeId && renderedCount > 0
    && history.length > renderedCount && domCount === renderedCount;
  // 渲染前判断是否贴底：增量追加只有在“原本就在底部”时才跟随
  const tPrev = $('#transcript');
  const wasNearBottom = tPrev ? isNearBottom(tPrev, 90) : true;
  scrollLock = true;
  try{
    if (canAppend){
      for(let i=renderedCount;i<history.length;i++){
        const m = history[i];
        if(m.role==='user') addUser(m.content, m.images);
        else { const node = addAI(m.content, m.reasoning||''); setResponseAttachments(node, m.attachments); }
      }
      renderedCount = history.length;
    } else {
      box.innerHTML='';
      if(!history.length){
        const e=document.createElement('div');
        e.className='empty';
        e.innerHTML='<div class="big"><img src="/icon.png" alt=""></div><div class="t">开始对话</div><div class="s">发消息，或用 / 调用指令、@ 引用文件</div>';
        box.appendChild(e);
      } else {
        history.forEach(m=>{
          if(m.role==='user') addUser(m.content, m.images);
          else { const node = addAI(m.content, m.reasoning||''); setResponseAttachments(node, m.attachments); }
        });
      }
      renderedChatId = activeId;
      renderedCount = history.length;
    }
  } finally {
    scrollLock = false;
  }
  if (canAppend){
    // 增量：用户在上方看历史就原地不动，只亮出“回到底部”小钮
    if (autoFollow && wasNearBottom) jumpToBottom();
    else updateJumpBtn(true);
  } else {
    // 全量重建（切会话/归档/首次进入）：直接落到底部
    jumpToBottom();
    // 图片等异步内容撑高后校准一次；期间用户若已上翻则不打扰
    setTimeout(()=>{ if(autoFollow) jumpToBottom(); }, 80);
    updateJumpBtn(false);
  }
  schedulePeekRender();
}
function updateJumpBtn(visible){
  const b = $('#jumpBottom');
  if(!b) return;
  const t = $('#transcript');
  const show = visible !== undefined ? visible : (t ? !isNearBottom(t, 90) : false);
  b.classList.toggle('show', !!show);
}
function jumpToBottom(){
  const t = $('#transcript');
  if(!t) return;
  autoFollow = true;
  t.scrollTop = t.scrollHeight;
  updateJumpBtn(false);
}
// 用户主动往上翻时停止自动跟随，滚回底部再自动恢复
function followNow(){
  const t = $('#transcript');
  if(!t) return;
  autoFollow = true;
  t.scrollTop = t.scrollHeight;
  updateJumpBtn(false);
}
function isNearBottom(t, gap){
  return (t.scrollHeight - t.scrollTop - t.clientHeight) <= (gap || 90);
}
function scrollBottom(){
  if(scrollLock) return;
  if(!autoFollow){ updateJumpBtn(true); return; }   // 用户正在上面看历史，别把他拽回来
  const t = $('#transcript');
  if(!t) return;
  requestAnimationFrame(()=>{
    if(!autoFollow) return;
    t.scrollTop = t.scrollHeight;
  });
}
function onTranscriptScroll(){
  const t = $('#transcript');
  if(!t) return;
  // 同步判断，不排 rAF：窗口隐藏时 rAF 不触发会导致状态卡住
  const near = isNearBottom(t, 90);
  autoFollow = near;
  updateJumpBtn(!near);
}
let scrollLock = false;
let autoFollow = true;
function addUser(text, images){
  const d=document.createElement('div'); d.className='msg user';
  const b=document.createElement('div'); b.className='body';
  if(images && images.length){
    const wrapImg=document.createElement('div');
    wrapImg.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px';
    images.forEach(src=>{
      const im=document.createElement('img');
      im.src=src; im.style.cssText='max-width:220px;max-height:180px;border-radius:10px;display:block';
      wrapImg.appendChild(im);
    });
    b.appendChild(wrapImg);
  }
  if(text){ const t=document.createElement('div'); t.textContent=text; b.appendChild(t); }
  d.appendChild(b);
  const tools=document.createElement('div'); tools.className='msg-tools';
  const cbtn=document.createElement('button'); cbtn.title='复制'; cbtn.innerHTML=ICON.copy;
  cbtn.onclick=(e)=>{ e.stopPropagation(); copy(text||''); };
  tools.appendChild(cbtn); d.appendChild(tools);
  // 首次发消息时清掉空状态占位，否则"开始对话"会一直挂在第一条消息上方
  const em=$('#inner').querySelector('.empty'); if(em) em.remove();
  $('#inner').appendChild(d);
  // 游标跟着真实 DOM 走：实时发送是自己 append 的，不走 renderTranscript，
  // 不在这里同步的话下次判断会以为 DOM 与游标不一致，增量永远命中不了
  if(renderedChatId === activeId) renderedCount++;
  schedulePeekRender();
  return d;
}
function addAI(text, reasoning){
  const d=document.createElement('div'); d.className='msg ai';
  const wrap=document.createElement('div');
  if(reasoning) wrap.appendChild(thinkBlock(reasoning, false));
  const b=document.createElement('div'); b.className='body';
  b.appendChild(renderMD(text||''));
  wrap.appendChild(b);
  const tools=document.createElement('div'); tools.className='msg-tools';
  const c1=document.createElement('button'); c1.title='复制'; c1.innerHTML=ICON.copy;
  c1.onclick=()=>copy(d.__text || b.innerText);
  tools.appendChild(c1);
  wrap.appendChild(tools);
  d.appendChild(wrap);
  const emAi=$('#inner').querySelector('.empty'); if(emAi) emAi.remove();
  $('#inner').appendChild(d);
  d.__body = b; d.__wrap = wrap; d.__text = text||'';
  if(renderedChatId === activeId) renderedCount++;
  scrollBottom();
  schedulePeekRender();
  return d;
}
function thinkBlock(text, running){
  const det=document.createElement('details');
  det.className='think'+(running?' running':'');
  det.open = !!running;
  const s=document.createElement('summary');
  s.innerHTML='<span class="dot"></span><span class="lbl">'+(running?'思考中…':'已思考')+'</span>';
  const c=document.createElement('div'); c.className='content'; c.textContent=text||'';
  det.appendChild(s); det.appendChild(c);
  det.__content=c; det.__summary=s;
  return det;
}

// F1 attachment cards are rendered by the isolated attachment-ui.js module.
// Keeping this adapter avoids any legacy path/token handling in the chat renderer.
function renderAttachmentCard(msgNode, info){
  if (!msgNode || !window.WhaleAttachments) return null;
  let host = msgNode.__attachmentHost;
  if (!host) {
    host = document.createElement('div'); host.className = 'response-attachments';
    (msgNode.__wrap || msgNode).appendChild(host);
    msgNode.__attachmentHost = host;
  }
  return window.WhaleAttachments.render(host, info);
}
function setResponseAttachments(node, items){
  if (!Array.isArray(items)) return;
  node.__attachments = node.__attachments || [];
  for (const item of items) {
    if (!item || typeof item.attachmentId !== 'string' || !item.sessionId) continue;
    if (node.__attachments.some(a => a.attachmentId === item.attachmentId)) continue;
    node.__attachments.push(item);
    renderAttachmentCard(node, item);
  }
}

function updateAI(node, text, reasoning, thinking){
  if(reasoning!==undefined && reasoning!==null){
    let det = node.__wrap.querySelector('.think');
    if(!det){ det = thinkBlock(reasoning, !!thinking); node.__wrap.insertBefore(det, node.__body); }
    det.__content.textContent = reasoning;
    if(thinking){ det.classList.add('running'); det.__summary.querySelector('.lbl').textContent='思考中…'; }
    else { det.classList.remove('running'); det.__summary.querySelector('.lbl').textContent='已思考'; det.open=false; }
  }
  if(text!==undefined){
    node.__text = text;
    node.__body.innerHTML='';
    node.__body.appendChild(renderMD(text));
  }
  scrollBottom();
  schedulePeekRender();
}
function addRunError(message, code, opts){
  const d=document.createElement('div'); d.className='run-error';
  const r1=document.createElement('div'); r1.className='row1';
  r1.innerHTML='<span class="dot"></span><span class="ttl">本轮运行失败</span>'+(code?'<span class="code">'+code+'</span>':'');
  const r2=document.createElement('div'); r2.className='detail';
  r2.textContent = (message && typeof message==='object') ? JSON.stringify(message) : String(message||'');
  d.appendChild(r1); d.appendChild(r2);
  if(opts && opts.retry){
    const bar=document.createElement('div'); bar.className='acts';
    const b=document.createElement('button'); b.className='retry'; b.textContent=opts.retryLabel||'重试这一轮';
    b.onclick=()=>{ d.remove(); if(typeof opts.retry==='function') opts.retry(); };
    bar.appendChild(b);
    if(opts.hint){ const h=document.createElement('span'); h.className='hint'; h.textContent=opts.hint; bar.appendChild(h); }
    d.appendChild(bar);
  }
  $('#inner').appendChild(d);
  scrollBottom();
  return d;
}
// 模型自动降级 / 协议回退等"过程说明"，不打断对话但要让用户知道换了来源
// beforeNode：插到该消息气泡之前，保证"先说明、后回答"的阅读顺序
function addRunNote(text, beforeNode){
  if(!text) return null;
  const d=document.createElement('div'); d.className='run-note';
  d.innerHTML='<span class="ico">⇄</span><span class="txt"></span>';
  d.querySelector('.txt').textContent=text;
  const inner=$('#inner');
  // node.__wrap 是气泡内层，真正的消息块是它的父元素（.msg）；必须插到消息块之前
  const box = beforeNode && beforeNode.__wrap ? beforeNode.__wrap.parentNode : null;
  const anchor = box && box.parentNode === inner ? box : null;
  if(anchor) inner.insertBefore(d, anchor); else inner.appendChild(d);
  scrollBottom();
  return d;
}
function addTool(name, detail, body){
  const det=document.createElement('details'); det.className='tool';
  const s=document.createElement('summary');
  s.innerHTML='<span class="k">'+name+'</span><span class="v">'+(detail||'')+'</span>';
  const pre=document.createElement('pre'); pre.textContent=body||'';
  det.appendChild(s); det.appendChild(pre);
  $('#inner').appendChild(det);
  scrollBottom();
  return det;
}

/* ---------- 状态栏 ---------- */
function ctxTokens(){
  let n = 0;
  for(const m of history){
    n += estTokens(m.content);
    if(m.reasoning) n += Math.round(estTokens(m.reasoning) * 0.25);
  }
  return Math.max(n, lastPromptTokens);
}
function updateStats(){
  // P1：轮/步、速度、用量、缓存的唯一权威来源是后端投影（applyRunStats）。
  // 这里只负责上下文占用估算，绝不再写 stRound 覆盖新投影。
  const used = ctxTokens();
  const base = compactAt || 100000;
  const pct = base > 0 ? used / base : 0;
  const el = $('#stCtx');
  if(el){
    el.textContent = '上下文 ' + fmtK(used) + ' / ' + fmtK(base);
    el.classList.toggle('bad', pct >= 0.9);
    el.classList.toggle('warn', pct >= 0.7 && pct < 0.9);
    el.title = '模型上下文上限 ' + fmtK(ctxLimit) + ' token；估算达到 ' + fmtK(base) + ' 时自动归档并载入记忆';
  }
}
function setStats(o){
  // 旧接口已废弃：统计栏只接受后端投影。保留空壳避免历史调用点抛错，
  // 但绝不写任何数值，防止 finally / done / 会话恢复把真实投影覆盖掉。
}

/* 新一轮开始：只显示「等待」，不清空会话累计，也不用估算填数。 */
function setStatsPending(){
  const sp = $('#stSpeed');
  if(sp){ sp.textContent = '生成中，等待用量回报'; sp.title = '上游只在末尾回报用量的端点，运行中显示等待；收到合法 usage 立即结算'; }
  const ca = $('#stCache');
  if(ca){ ca.textContent = '缓存等待回报'; ca.title = '本轮尚未收到缓存字段；不当作 0%'; }
  const r = $('#stRound');
  if(r){ r.title = '轮次由后端 turn.accepted 分配，前端不累加'; }
}

/* P1：把后端投影写进状态栏。所有数值都带可用性，缺失显示「未上报」而不是 0。 */
function applyRunStats(st){
  if(!st) return;
  // 切会话后迟到的旧 run 投影不能串到当前会话
  if(st.sessionId && activeId && st.sessionId !== activeId) return;
  lastStats = st;
  if(st.runId) currentRunId = st.runId;
  // 每次合法投影递增本地 revision（按 session+thread 隔离），供 GET 恢复判断是否过期。
  // 不能用 run-registry 的 lastSeq 跨 run 比较：它每个 run 都从 0 重新开始，旧 run 的大 seq
  // 会掩盖新 run 的小 seq，导致迟到的旧 GET 把 UI 退回上一轮。
  bumpStatsRev(st.sessionId, st.threadId);
  const r = $('#stRound');
  if(r){
    const t = st.turnOfThread || st.turn || 0;
    r.textContent = t + ' 轮' + (st.step ? (' · ' + st.step + ' 步') : '');
    r.title = st.step
      ? ('第 ' + t + ' 轮 · 第 ' + st.step + ' 步（步 = 一次逻辑模型推理，重试/切换不增加步）')
      : ('第 ' + t + ' 轮（尚未观测到模型请求）');
  }
  const sp = $('#stSpeed');
  if(sp){
    if(st.speed && st.speed.measurable){
      sp.textContent = st.speed.tokensPerSec + ' tok/s';
      sp.title = (st.speed.label || '生成速度') + '：上游上报的输出 token ÷ 真实生成窗口 '
        + Math.round(st.speed.windowMs) + 'ms（不含排队/工具耗时）';
    } else if(st.speed && st.speed.fallback){
      sp.textContent = '~' + st.speed.tokensPerSec + ' tok/s';
      sp.title = '请求吞吐（含等待）：' + Math.round(st.speed.windowMs) + 'ms 内上报的输出 token；无法观测生成窗口时的替代口径';
    } else if(st.state === 'running' || st.phase === 'generating' || st.phase === 'started'){
      sp.textContent = '生成中，等待用量回报';
      sp.title = '上游尚未回报用量；只有末尾 usage 的端点会在结束时立即结算，不用字符数或定时器造数';
    } else if(st.usageState === 'missing' || (st.sessionUsage && st.sessionUsage.reportedRequests === 0)){
      sp.textContent = '不可测 · 上游未上报';
      sp.title = '本次请求上游没有返回 usage，无法计算速度；不使用字符估算冒充精确值';
    } else {
      sp.textContent = '— tok/s';
      sp.title = '生成窗口不足两个真实生成事件，或上游用量不完整，速度不可测';
    }
  }
  const tk = $('#stTokens');
  if(tk){
    const su = st.sessionUsage;
    const u = st.usage || {};
    if(su && su.totalTokens > 0){
      tk.textContent = fmtK(su.totalTokens) + ' tok';
      const lines = [
        '总用量 = 当前会话累计 input + output（缓存读取已含在 input、reasoning 已含在 output，不重复加）',
        '会话累计：输入 ' + fmtK(su.inputTokens) + ' · 输出 ' + fmtK(su.outputTokens)
          + ' · 缓存读取 ' + fmtK(su.cacheReadTokens),
        '本轮：输入 ' + (u.inputTokens == null ? '未上报' : fmtK(u.inputTokens))
          + ' · 输出 ' + (u.outputTokens == null ? '未上报' : fmtK(u.outputTokens)),
        '已结算请求 ' + (su.reportedRequests || 0) + ' 次；未上报 ' + (su.missingRequests || 0) + ' 次',
      ];
      if(su.partial) lines.push('⚠ 已知累计 ' + fmtK(su.totalTokens) + ' tok · 部分用量未上报');
      tk.title = lines.join('\n');
      tk.classList.toggle('partial', !!su.partial);
    } else if(su && su.missingRequests > 0){
      tk.textContent = '— tok';
      tk.title = '上游未上报任何用量；不显示估算值。已记录 ' + su.missingRequests + ' 次未上报请求';
    } else {
      tk.textContent = '0 tok';
      tk.title = '当前会话尚无已结算用量';
    }
  }
  const ca = $('#stCache');
  if(ca){
    const c = st.cache || {};
    if(c.state === 'reported'){
      ca.textContent = '缓存命中 ' + c.rate + '%';
      const u = st.usage || {};
      ca.title = '输入 token 缓存命中：' + (u.cacheReadTokens) + ' / ' + (u.inputTokens) + '（上游上报）';
    } else if(c.state === 'partial'){
      ca.textContent = '缓存命中 ' + c.rate + '%（部分）';
      ca.title = c.note || '部分请求缓存未上报，命中率只代表已知部分';
    } else if(c.state === 'na'){
      ca.textContent = '缓存不适用';
      ca.title = c.note || '';
    } else if(c.state === 'invalid'){
      ca.textContent = '缓存数据无效';
      ca.title = c.note || '';
    } else if(st.state === 'running'){
      ca.textContent = '缓存等待回报';
      ca.title = '上游支持末尾回报时，结束立即显示命中率';
    } else {
      ca.textContent = '缓存未上报';
      ca.title = c.note || '上游没有返回缓存字段；不当作 0%';
    }
  }
}

/* 切会话 / 刷新恢复：从后端拉取该线程的权威累计，避免把上一会话的统计留在当前实时条。 */
let statsReqSeq = 0;
// 本地 revision：每收到一次合法投影就 +1，按 session+thread 隔离。
// 它单调递增、不依赖 run 内部 seq，因此能可靠判断「GET 发起后是否有更新的实时投影」。
const statsRev = new Map();
function statsRevKey(sid, tid){ return String(sid || '') + '#' + String(tid || 'main'); }
function bumpStatsRev(sid, tid){ const k = statsRevKey(sid, tid); const v = (statsRev.get(k) || 0) + 1; statsRev.set(k, v); return v; }
async function refreshThreadStats(){
  const sid = activeId || '';
  const seq = ++statsReqSeq;
  const revAtStart = statsRev.get(statsRevKey(sid, 'main')) || 0;
  try{
    const r = await fetch('/api/threads/stats?sessionId=' + encodeURIComponent(sid) + '&threadId=main');
    const j = await r.json();
    // 迟到响应保护：会话已切换、已有更新的请求，或该线程实时投影的 revision
    // 在 GET 发起后已前进 → 丢弃旧快照，绝不让恢复数据覆盖新投影。
    if(seq !== statsReqSeq || (activeId || '') !== sid || (statsRev.get(statsRevKey(sid, 'main')) || 0) > revAtStart) return;
    const s = j && j.stats; if(!s) return;
    const rr = $('#stRound');
    if(rr){ rr.textContent = (s.turn || 0) + ' 轮'; rr.title = '当前会话累计轮次（后端权威，前端不累加）'; }
    const sp = $('#stSpeed');
    if(sp){ sp.textContent = '— tok/s'; sp.title = '本会话本轮尚未开始生成'; }
    const ca = $('#stCache');
    if(ca){ ca.textContent = '缓存未上报'; ca.title = '切会话后已复位，等待本轮上游回报'; }
    const tk = $('#stTokens');
    const u = s.usage;
    if(tk){
      if(u && u.totalTokens > 0){
        tk.textContent = fmtK(u.totalTokens) + ' tok';
        tk.title = '会话累计 input + output；输入 ' + fmtK(u.inputTokens) + ' · 输出 ' + fmtK(u.outputTokens)
          + (u.partial ? '\n⚠ 已知累计 ' + fmtK(u.totalTokens) + ' tok · 部分用量未上报' : '');
        tk.classList.toggle('partial', !!u.partial);
      } else if(u && (u.missingRequests || 0) > 0){
        // 有请求但上游没回报：显示缺失，不写成 0
        tk.textContent = '累计 — tok';
        tk.title = '上游未上报 ' + u.missingRequests + ' 次请求的用量；不显示为 0';
        tk.classList.add('partial');
      } else {
        tk.textContent = '0 tok';
        tk.title = '当前会话尚无已结算用量';
        tk.classList.remove('partial');
      }
    }
  }catch(e){}
}

/* ---------- 思考深度 ---------- */
const DEPTHS = [
  // 2026-11-08：off 档已移除——后端对 deepseek-v4.1 无条件 thinking:true
  // t = 滑杆卡片里的两字档位标题（卡片宽度 262px，标题居中 14px，单字会显得空）
  {v:'minimal', n:'极少', d:'极简思考', t:'极简'},
  {v:'low', n:'低', d:'轻度思考', t:'轻度'},
  {v:'medium', n:'中', d:'中度思考', t:'中度'},
  {v:'high', n:'高', d:'深度思考', t:'深度'}
];
function depthTitle(v){
  const d = DEPTHS.find(x=>x.v===v) || DEPTHS[DEPTHS.length-1];
  return d.t;
}

/* ---------- 菜单 ---------- */
function openMenu(el, items, onPick, anchor){
  el.innerHTML='';
  items.forEach(it=>{
    if(it.hdr){
      const h=document.createElement('div'); h.className='mi hdr'; h.textContent=it.label;
      el.appendChild(h); return;
    }
    const d=document.createElement('div');
    d.className='mi'+(it.sel?' sel':'')+(it.act?' act':'');
    d.innerHTML=(it.dot?'<span class="mdot '+it.dot+'"></span>':'')
      +'<span>'+it.label+'</span>'+(it.key?'<span class="k">'+it.key+'</span>':'');
    d.onclick=(e)=>{ e.stopPropagation(); onPick(it); if(!it.keepOpen) closeMenus(); };
    el.appendChild(d);
  });
  el.classList.add('show');
  markMenuState(el.id, true);
  const r = anchor.getBoundingClientRect();
  const h = el.offsetHeight || 120;
  el.style.left = Math.max(8, r.left) + 'px';
  let top = r.top - h - 8;
  // 上方放不下就翻到下方；下方也放不下就贴住视口底部（配合 CSS max-height 滚动）
  if (top < 8) top = Math.min(r.bottom + 8, Math.max(8, window.innerHeight - h - 8));
  el.style.top = Math.max(8, top) + 'px';
}
let openMenuId = '';
function markMenuState(panelId, open){
  const map = { menuModel:'#btnModel', menuPerm:'#btnPerm' };
  const b = map[panelId] ? $(map[panelId]) : null;
  if(b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  if(open) openMenuId = panelId; else if(openMenuId === panelId) openMenuId = '';
}
function closeMenus(){
  ['#menuModel','#menuPerm','#menuSlash'].forEach(s=>{ const e=$(s); if(e){ e.classList.remove('show'); markMenuState(e.id, false); } });
}
document.addEventListener('click', closeMenus);

/* ---------- 上下文自动归档 ---------- */
function keywordsOf(text){
  const raw = String(text||'').toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z0-9_.\-]{3,}/g) || [];
  return Array.from(new Set(raw)).slice(0, 40).join(' ');
}
async function fetchMemoryPack(q){
  try{
    const r = await fetch('/api/memory/recall',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:q||'', max:2})});
    const j = await r.json();
    return (j && j.ok) ? (j.pack||'') : '';
  }catch(e){ return ''; }
}
async function writeMemoryCard(summary, msgs){
  const ts = new Date();
  const pad = n => String(n).padStart(2,'0');
  const stamp = ts.getFullYear()+'-'+pad(ts.getMonth()+1)+'-'+pad(ts.getDate())+' '+pad(ts.getHours())+':'+pad(ts.getMinutes());
  const title = '记忆-' + ((cur()||{}).title || '会话');
  const body = '# 记忆卡 '+stamp+'\n\n## 摘要\n\n'+(summary||'（无摘要）')+'\n\n## 关键对话\n\n' +
    msgs.slice(-12).map(m => (m.role==='user'?'- 我：':'- 鲸鱼娘：') + String(m.content||'').replace(/\s+/g,' ').slice(0,300)).join('\n') + '\n';
  try{
    await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title, reason:'自动归档', target:'memory', content:body})});
  }catch(e){}
}

// 把过长的旧对话归档 + 写记忆卡 + 读回相关记忆，重建上下文
async function autoArchive(){
  const keep = 8;
  const cut = Math.max(0, history.length - keep);
  if(cut <= 2) return false;
  const old = history.slice(0, cut);
  const rest = history.slice(cut);

  let summary = '';
  try{
    const r = await fetch('/api/summarize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:old})});
    const j = await r.json();
    if(j && j.ok) summary = j.summary || '';
  }catch(e){}
  if(!summary){
    summary = old.map(m => (m.role==='user'?'我：':'鲸鱼娘：') + String(m.content||'').slice(0,200)).join('\n').slice(0,800);
  }

  // 1) 全文进聊天记录目录
  try{
    const md = '# 自动归档\n\n' + old.map(m => (m.role==='user'?'## 我\n\n':'## 鲸鱼娘\n\n') + (m.content||'')).join('\n\n');
    await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:(cur()||{}).title||'会话', reason:'自动归档（上下文达阈值）', target:'chatArchive', content:md})});
  }catch(e){}

  // 2) 写记忆卡，之后可被关键词检索回来
  await writeMemoryCard(summary, old);

  // 3) 读记忆库：用摘要 + 最近对话做关键词，取最相关的两条
  const pack = await fetchMemoryPack(keywordsOf(summary + ' ' + rest.slice(-2).map(m=>m.content||'').join(' ')));

  // 4) 重建上下文：摘要 + 相关记忆 + 最近几轮
  const head = '【前情摘要】\n' + summary + (pack ? '\n\n【记忆库摘录】\n' + pack : '');
  history = [{role:'user', content:head}, {role:'assistant', content:'（已载入前情摘要与相关记忆，继续）'}].concat(rest);
  lastPromptTokens = 0;
  const c = cur(); if(c){ c.messages = history.slice(); saveChats(); }
  renderTranscript(true); updateStats();
  return true;
}

// 发送前检查：快满就自动归档，保证记忆不断
async function ensureContext(extraText){
  const used = ctxTokens() + estTokens(extraText||'');
  const limit = Math.min(compactAt||100000, Math.round((ctxLimit||350000) * 0.85));
  if(used < limit) return false;
  if(history.length < 6) return false;
  toast('上下文接近上限，正在归档…');
  let ok = false;
  try{ ok = await autoArchive(); }catch(e){ ok = false; }
  toast(ok ? '已归档，记忆已续上' : '归档失败，本轮照常发送');
  return ok;
}

/* ---------- 发送 ---------- */
async function send(){
  if(busy) return;
  const raw = $('#input').value.trim();
  if(!raw && !attachments.length) return;

  // 未配置密钥 → 无可用模型，禁止发送并引导去配置
  if(!MODEL || !modelList.length){
    toast('尚未配置 API Key，无法发送。请到设置里配置密钥。');
    openSettings();
    return;
  }

  // 斜杠指令（无附件时）
  if(raw.startsWith('/') && !attachments.length){
    $('#input').value='';
    handleSlash(raw);
    return;
  }

  // 音视频附件不会被当作文本发送：必须先转写为文字，避免「只贴音视频就发送」导致空消息 + 丢失附件
  if(attachments.some(a=>a.kind==='media')){
    const vid = attachments.some(a=>a.kind==='media' && a.media==='video');
    toast(vid ? '视频需先点「🎬 转写」提取音轨文字，或移除后再发送' : '音频需先点「🎤 转写」转为文字，或移除后再发送');
    return;
  }

  const {content, images} = buildOutgoing(raw);
  $('#input').value='';
  attachments = [];
  renderAttach();
  autoGrow();

  // 先判断上下文，必要时自动归档 + 读回记忆（归档期间锁住发送，避免二次提交）
  busy = true;
  try{
    await ensureContext(content);
  }catch(e){
    busy = false;
    toast('整理上下文失败：' + (e.message||e));
    return;
  }
  busy = false;

  addUser(raw, images);
  followNow();
  history.push({role:'user', content, images});
  const c = cur();
  if(c){
    // 只在没有标题时用首条消息起名：以前每发一条消息就把会话改名成这句话，
    // 导致历史列表里所有会话名都是"最后一句"，看起来像假的会话记录。
    if(!c.title || c.title==='新会话' || c.title==='（未命名）') c.title = autoTitle(raw, images);
    c.messages = history.slice(); saveChats(); renderList(); updateTitle();
  }

  await runTurn(content, null);
}

async function runTurn(content, reuseNode){
  const node = reuseNode || addAI('', '', false);
  if(reuseNode){
    node.__text = '';
    node.__body.innerHTML = '';
    const det = node.__wrap.querySelector('.think');
    if(det) det.remove();
  }
  lastRun = { node, content };
  currentRunId = '';          // 新一轮：清掉上一轮 runId，避免停止误取消旧 run
  busy = true; $('#btnSend').disabled=false; $('#btnSend').classList.add('stop'); $('#btnSend').innerHTML=ICON.stop;
  // 轮次由后端 turn.accepted 分配；前端只显示等待，不再自己累加 roundCount。
  setStatsPending();
  abort = new AbortController();

  try{
    if(mode==='agent') await runAgent(content, node);
    else await runChat(node);
  }catch(err){
    if(err && err.name==='AbortError'){
      if(!switchAbort) toast('已停止');
      switchAbort=false;
      // 被打断的一轮必须收尾，否则气泡会一直挂着"思考中…"
      const det = node.__wrap && node.__wrap.querySelector('.think');
      if(det){
        det.classList.remove('running');
        const lbl = det.__summary && det.__summary.querySelector('.lbl');
        if(lbl) lbl.textContent = '已停止';
        det.open = false;
      }
      if(!node.__text && node.__body && !node.__body.textContent.trim()){
        node.__body.innerHTML='<div class="stopped-note">已停止生成（本轮未完成）</div>';
      }
    }
    else {
      // Agent 模式会真实改文件/跑命令，重试可能重复执行，所以不提供一键重试
      const canRetry = mode!=='agent' && !(err && err.retryable === false);
      const sug = err && err.suggest;
      let opts = canRetry ? { retry: retryTurn, hint: '从上一轮提问重新生成，不会重复发送' }
                 : (mode==='agent' ? { retry:null, hint:'Agent 模式不自动重试，避免重复执行命令' } : null);
      // 上游明确给了可用替代模型时，按钮直接变成"换到 X 重试"，一步到位
      if(mode!=='agent' && sug && sug!==MODEL){
        opts = { retry: ()=>{ setModel(sug).then(()=>retryTurn()); },
                 retryLabel: '换到 ' + labelOf(sug) + ' 重试',
                 hint: '该模型当前可用' };
      }
      addRunError(err.message||String(err), (err&&err.code)||'ERROR', opts);
    }
  }finally{
    busy=false; abort=null; switchAbort=false;
    stopWait();
    $('#btnSend').classList.remove('stop'); $('#btnSend').innerHTML=ICON.send;
    $('#btnSend').disabled = !$('#input').value.trim();
    const c2 = cur(); if(c2){ c2.messages = history.slice(); saveChats(); }
    updateStats();
  }
}

async function retryTurn(){
  if(busy) return;
  if(!lastRun) { toast('没有可重试的轮次'); return; }
  const last = history[history.length-1];
  if(!last || last.role !== 'user'){
    toast('上下文已变化，无法重试'); return;
  }
  await runTurn(lastRun.content, lastRun.node);
}


/* ---------- 排队等待计时（2026-11-08） ----------
   NIM 排队时上游一个字节都不吐，界面会像死了一样。
   服务端每 2s 推 phase:queued 校准时间；前端本地 500ms 自刷新，即使心跳断了也能看见。 */
let waitTimer=null, waitStart=0, waitPhase='queued', waitReason='queued', waitHint=null;
function fmtWait(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  return s<60 ? s+' 秒' : Math.floor(s/60)+' 分 '+String(s%60).padStart(2,'0')+' 秒';
}
function waitLabel(){
  const t='已等待 '+fmtWait(Date.now()-waitStart);
  if(waitPhase==='queued'){
    const sec=Math.floor((Date.now()-waitStart)/1000);
    // 实测 NIM 在约 5 分钟时返回 504，等太久要提前告诉用户，别一直干等
    const warn=sec>=120 ? '（排队偏久：NIM 网关实测约 5 分钟后会超时，请别反复重试）' : '';
    if(waitReason==='retry_other_wire') return '⏳ '+t+' · 上游报错，正在换协议重试…';
    if(waitReason==='failover') return '⏳ '+t+' · 已切换备用模型，正在重新排队…';
    return '⏳ '+t+' · 上游排队中'+(waitReason==='retry_no_think'?'（补跑一次）':'')+warn;
  }
  if(waitPhase==='thinking') return '⏳ '+t+' · 正在思考…';
  if(waitPhase==='generating') return '⏳ '+t+' · 正在生成…';
  return '⏳ '+t+' · 上游已响应，正在整理…';
}
function paintWait(){
  const t=waitLabel();
  if(waitHint && waitHint.isConnected){
    const w=waitHint.querySelector('.wt'); if(w) w.textContent=t;
  }
  const st=$('#stWait'); if(st) st.textContent=t;
}
function startWait(node){
  stopWait();
  waitStart=Date.now(); waitPhase='queued'; waitReason='queued';
  waitHint=document.createElement('div'); waitHint.className='wait-hint';
  waitHint.innerHTML='<span class="spin"></span><span class="wt"></span><span class="wn">排队期间请耐心等待，反复重试会重新排到队尾</span>';
  if(node && node.__wrap && node.__body) node.__wrap.insertBefore(waitHint,node.__body);
  const st=$('#stWait'); if(st) st.style.display='';
  paintWait();
  waitTimer=setInterval(paintWait,500);
}
function setWaitPhase(p,reason){
  if(!waitTimer) return;
  waitPhase=p; if(reason) waitReason=reason;
  paintWait();
}
function stopWait(){
  if(waitTimer){ clearInterval(waitTimer); waitTimer=null; }
  if(waitHint){ waitHint.remove(); waitHint=null; }
  const st=$('#stWait'); if(st){ st.style.display='none'; st.textContent=''; }
}

async function readSSE(res, onEv){
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf='';
  while(true){
    const {value,done} = await reader.read();
    if(done) break;
    buf += dec.decode(value,{stream:true});
    let i;
    while((i=buf.indexOf('\n\n'))>=0){
      const frame = buf.slice(0,i); buf = buf.slice(i+2);
      for(const line of frame.split('\n')){
        if(!line.startsWith('data:')) continue;
        let ev; try{ ev = JSON.parse(line.slice(5).trim()); }catch(e){ continue; }
        onEv(ev);
      }
    }
  }
}

// 「深入偏好」开关（滑杆卡片左上角闪电）：只在下一条发出的消息末尾追加一次，
// 之后自动复位；历史记录里不保留这句，避免每轮重复。
let boostPending = false;
const BOOST_NOTE = '\n\n[偏好] 请优先深入分析这个问题，必要时分多步推理。';

function apiMessages(){
  const arr = history.map(m=>{
    if(m.role==='user' && m.images && m.images.length){
      const parts=[{type:'text', text:m.content || '请描述这张图片'}];
      m.images.forEach(u=>parts.push({type:'image_url', image_url:{url:u}}));
      return {role:'user', content:parts};
    }
    return {role:m.role, content:m.content||''};
  });
  // 新会话首次发言：把记忆库摘要作为背景一起带上（设置里可关）
  if(memoryPrefix && cfg.injectMemory!==false && history.length<=1){
    arr.unshift({role:'user', content: memoryPrefix + '\n\n以上是我的历史记忆，请作为背景参考；下面开始正式对话。'});
  }
  // 深入偏好：只作用一次，失败重试不会重复追加
  if(boostPending && arr.length){
    for(let i=arr.length-1;i>=0;i--){
      if(arr[i].role!=='user') continue;
      if(typeof arr[i].content==='string') arr[i].content += BOOST_NOTE;
      else if(Array.isArray(arr[i].content)){
        const t=arr[i].content.find(x=>x && x.type==='text');
        if(t) t.text += BOOST_NOTE;
      }
      break;
    }
    boostPending = false;
    const sw=$('#btnModel'); if(sw) sw.classList.remove('boost-on');
  }
  return arr;
}

async function runChat(node){
  startWait(node);
  const res = await fetch('/api/chat',{
    method:'POST', headers:{'Content-Type':'application/json'}, signal:abort.signal,
    body: JSON.stringify({ messages: apiMessages(), model: MODEL, thinkingDepth: depth, sessionId: activeId })
  });
  if(!res.ok){
    const e = new Error('服务端 HTTP '+res.status);
    e.retryable = (res.status===429 || res.status>=500);
    e.code = 'HTTP';
    throw e;
  }

  let acc='', think='', started=Date.now(), ttft=null;
  let errMsg='', errRetryable=true, stopped=false, errSuggest=null, errCode=null, errReset=null;
  let failNoteEls=[];
  // 流式渲染节流：每条 delta 都重跑 marked+DOMPurify，长回答会越来越慢（O(n) 每帧）。
  // 压到约 70ms 一次，人眼看着仍是连续出字，但总渲染次数降到 1/4 以下。
  let paintAt=0, paintTimer=null, wantText=false, wantThink=false;
  function schedulePaint(){
    if(paintTimer) return;
    const wait = Math.max(0, 70 - (performance.now() - paintAt));
    paintTimer = setTimeout(()=>{
      paintTimer = null; paintAt = performance.now();
      const t = wantText ? acc : undefined;
      const r = wantThink ? think : undefined;
      wantText = false; wantThink = false;
      updateAI(node, t, r, true);
    }, wait);
  }
  await readSSE(res, ev=>{
    if(ev.run && ev.run.runId) currentRunId = ev.run.runId;
    if(ev.stats) applyRunStats(ev.stats);
    if(ev.phase==='queued'){
      if(typeof ev.waitedMs==='number') waitStart = Date.now()-ev.waitedMs;
      setWaitPhase('queued', ev.reason);
    }
    if(ev.phase==='first_byte') setWaitPhase('first_byte');
    if(ev.phase==='retry_no_think') setWaitPhase('queued','retry_no_think');
    if(ev.phase==='retry_other_wire'){ setWaitPhase('queued','retry_other_wire'); if(ev.note) toast(ev.note); }
    // 排队超时/限流 → 后端已自动换模型，这里必须显式告知，否则用户会以为还是原模型在答
    if(ev.phase==='model_failover'){
      setWaitPhase('queued','failover');
      if(ev.note){ const el=addRunNote(ev.note,node); if(el) failNoteEls.push(el); }
    }
    if(ev.phase==='model_switched' && ev.note){
      // 中间过程已由 switched 汇总，避免同一件事出现两行
      failNoteEls.forEach(el=>{ try{ el.remove(); }catch(e){} });
      failNoteEls = [];
      addRunNote(ev.note, node);
    }
    if(ev.phase==='recovered'){ errMsg=''; }   // 换协议重试成功，撤销刚才的失败提示
    if(ev.stopped) stopped = true;
    if(ev.reasoning){
      if(ttft===null){ ttft=Date.now()-started; }
      setWaitPhase('thinking');
      think += ev.reasoning;
      wantThink = true;
      schedulePaint();
    }
    if(ev.delta){
      if(ttft===null){ ttft=Date.now()-started; }
      if(!acc) stopWait();   // 正文第一字到了，等待提示功成身退
      acc += ev.delta;
      wantText = true;
      schedulePaint();
    }
    if(ev.error){
      errMsg = (typeof ev.error==='string') ? ev.error
        : ((ev.error && ev.error.message) || JSON.stringify(ev.error));
      errRetryable = ev.retryable !== false;
      if(ev.code) errCode = ev.code;
      if(ev.suggest) errSuggest = ev.suggest;
      if(ev.resetAt) errReset = ev.resetAt;
    }
    if(ev.done){
      updateAI(node, acc, think, false);
      if(ev.model){
        const nm=(id)=> id ? (modelLabels[id] || String(id).split('/').pop()) : '—';
        const el=$('#stActual');
        const switched = !!(ev.requested && ev.requested !== ev.model);
        setChipModel(ev.model, switched);
        if(el && switched) el.title += '\n界面选的是 '+nm(ev.requested)+'，上游不可用后已自动切换';
      }
      if(ev.stats){
        applyRunStats(ev.stats);
        if(ev.usage && ev.usage.prompt_tokens) lastPromptTokens = ev.usage.prompt_tokens;
      } else if(ev.usage){
        // 兼容旧后端：只保留真实 prompt_tokens 作为上下文占用基准，
        // 绝不再调用 setStats 覆盖统计栏（统计一律由后端投影驱动）。
        const u=ev.usage;
        if(u.prompt_tokens) lastPromptTokens = u.prompt_tokens;
      }
    }
    // F1: server-registered response attachments → render through the isolated UI module.
    if(Array.isArray(ev.attachments)) setResponseAttachments(node, ev.attachments);
    // Legacy download event: only accept a server-issued attachment object, never a path/token.
    if(ev.download && ev.status === 'completed' && ev.attachment && window.WhaleAttachments){
      setResponseAttachments(node, [ev.attachment]);
    }
  });
  stopWait();
  updateAI(node, acc, think, false);
  updateStats();

  if(errMsg && !acc){
    const e = new Error(errMsg);
    e.retryable = errRetryable;
    e.code = errCode || 'UPSTREAM';
    e.suggest = errSuggest;
    e.resetAt = errReset;
    throw e;
  }
  if(errMsg && acc){
    addRunError(errMsg, 'UPSTREAM', { retry: retryTurn, hint: '已保留本轮已生成的部分，可重试' });
  }
  if(!acc && !think){
    if(!stopped && !errMsg) throw new Error('模型没有返回任何内容');
    return;   // 主动停止且无内容：不写进上下文
  }
  history.push({role:'assistant', content: acc || '（无输出）', reasoning: think, attachments: node.__attachments || []});
}

let pendingText='';

async function runAgent(task, node){
  const sb = $('#aSandbox').value;
  if(sb==='danger-full-access' && !confirm('「完全权限」允许 Agent 读写全盘。确定继续吗？')){
    updateAI(node,'（已取消完全权限任务）','',false); toast('已取消'); return;
  }
  const dir = $('#aDir').value || '';
  const res = await fetch('/api/agent',{
    method:'POST', headers:{'Content-Type':'application/json'}, signal:abort.signal,
    body: JSON.stringify({ task, dir, sandbox: sb, model: MODEL, confirmDanger: sb==='danger-full-access', sessionId: activeId, threadId: 'main' })
  });
  if(!res.ok) throw new Error('HTTP '+res.status);
  let acc='', think='', lastTool=null, snapRunId=null;
  const sbxStat={ perm:sb, dir, files:0, cmds:0, risky:0 };
  await readSSE(res, ev=>{
    if(ev.run && ev.run.runId) currentRunId = ev.run.runId;
    if(ev.stats) applyRunStats(ev.stats);
    if(ev.status){ node.__wrap.querySelector('.body').textContent = '⏳ '+(ev.status||''); }
    if(ev.reasoning){ think += ev.reasoning; updateAI(node, undefined, think, true); }
    if(ev.snapshot){
      sbxStat.files = ev.snapshot.files||0;
      if(ev.snapshot.runId) snapRunId = ev.snapshot.runId;
    }
    if(ev.warning) toast(ev.warning);
    if(ev.log){
      const line = String(ev.log);
      const isCmd = line.startsWith('$ ');
      if(isCmd) sbxStat.cmds++;
      if(ev.risky) sbxStat.risky++;
      lastTool = addTool(isCmd?'exec':'tool', isCmd?line.slice(2):line.slice(0,80), line+(ev.risky?' ⚠ 高危':''));
    }
    if(ev.agent_text){ acc = ev.agent_text; updateAI(node, acc, think, true); }
    if(Array.isArray(ev.attachments)) setResponseAttachments(node, ev.attachments);
    if(ev.error){ addRunError(ev.error,'AGENT'); }
  });
  updateAI(node, acc||'（执行完成，无文字输出）', think, false);
  addSandboxBar(node, sbxStat);
  if(snapRunId) addRestoreButton(node, snapRunId, dir);
  history.push({role:'assistant', content: acc||'（执行完成）', reasoning: think, attachments: node.__attachments || []});
}
function addRestoreButton(node, runId, dir){
  const tools = node.__wrap && node.__wrap.querySelector('.msg-tools');
  if(!tools) return;
  const b=document.createElement('button');
  b.textContent='还原本轮'; b.title='把文件恢复到本轮任务开始前';
  b.style.cssText='width:auto;height:auto;padding:2px 8px;font-size:11.5px';
  b.onclick=async()=>{
    if(!confirm('把工作目录文件恢复到本轮任务开始前？任务中新增的文件不会被删除。')) return;
    try{
      const r=await fetch('/api/agent/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId,dir})});
      const j=await r.json();
      toast(j.ok?('已恢复 '+j.restored+' 个文件'):('还原失败：'+(j.error||'未知')));
    }catch(e){ toast('还原失败'); }
  };
  tools.appendChild(b);
}

/* ---------- 斜杠指令 ---------- */
const SLASH_GROUPS = [
  { g:'会话', items:[
    { cmd:'/new',     label:'新建会话', key:'new',     icon:'chatPlus', desc:'开一个空白对话' },
    { cmd:'/clear',   label:'清空会话', key:'clear',   icon:'eraser',   desc:'删除当前会话的全部消息' },
    { cmd:'/compact', label:'压缩上下文', key:'compact', icon:'layers',  desc:'把较早的消息归档成摘要' },
  ]},
  { g:'设置', items:[
    { cmd:'/model',      label:'切换模型', key:'model',      icon:'cpu',    desc:'选择本轮使用的模型' },
    { cmd:'/permission', label:'切换权限', key:'permission', icon:'shield', desc:'沙箱模式与审批策略' },
  ]},
];
function handleSlash(cmd){
  const name = cmd.slice(1).split(/\s+/)[0];
  if(name==='new'){ newChat(); toast('已新建会话'); return; }
  if(name==='clear'){ history=[]; const c=cur(); if(c){ c.messages=[]; saveChats(); } renderTranscript(); toast('已清空当前会话'); return; }
  if(name==='compact'){ doCompact(); return; }
  if(name==='model'){ openModelMenu($('#btnModel')); return; }
  if(name==='permission'||name==='perm'){ openPermMenu($('#btnPerm')); return; }
  toast('未知指令：'+name);
}
let slashSel = 0;
function slashQuery(){
  const v=$('#input').value;
  const m=/^\/([A-Za-z]*)$/.exec(v);
  return m ? m[1].toLowerCase() : null;
}
function slashFlat(){
  const out=[];
  SLASH_GROUPS.forEach(g=>g.items.forEach(it=>out.push(it)));
  return out;
}
function hideSlash(){ const el=$('#menuSlash'); if(el){ el.classList.remove('show'); el.innerHTML=''; } }
function slashMenu(){
  const q = slashQuery();
  const el = $('#menuSlash');
  if(!el || q===null){ hideSlash(); return; }
  const matched = SLASH_GROUPS.map(g=>({
    g:g.g,
    items:g.items.filter(it=>!q || it.key.startsWith(q) || it.label.includes(q))
  })).filter(g=>g.items.length);
  if(!matched.length){
    el.innerHTML='<div class="ck-empty">没有匹配的指令</div>';
  } else {
    el.innerHTML='';
    const scroller=document.createElement('div'); scroller.className='ck-scroll';
    matched.forEach(g=>{
      const t=document.createElement('div'); t.className='ck-group'; t.textContent=g.g;
      scroller.appendChild(t);
      g.items.forEach(it=>{
        const d=document.createElement('div'); d.className='ck-item'; d.dataset.cmd=it.cmd;
        d.innerHTML='<span class="ck-ic">'+(ICON[it.icon]||'')+'</span>'+
          '<span class="ck-name">'+it.label+'</span>'+
          '<span class="ck-key">'+it.key+'</span>'+
          '<span class="ck-desc">'+it.desc+'</span>';
        d.onmousedown=(e)=>{ e.preventDefault(); runSlash(it.cmd); };
        scroller.appendChild(d);
      });
    });
    const foot=document.createElement('div'); foot.className='ck-foot';
    foot.innerHTML='<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span>';
    el.appendChild(scroller); el.appendChild(foot);
    if(slashSel >= scroller.querySelectorAll('.ck-item').length) slashSel = 0;
  }
  el.classList.add('show');
  // 先显示再量高度，保证从输入框上方展开（而不是压住输入框）
  const inp=$('#input'), box=inp.closest('.composer') || inp;
  const r=box.getBoundingClientRect();
  const w=Math.min(Math.max(r.width, 420), 560);
  el.style.width=w+'px';
  el.style.left=Math.max(12, r.left+8)+'px';
  const h=el.offsetHeight;
  let top=r.top-8-h;
  if(top<12) top=Math.min(window.innerHeight-h-12, r.bottom+8);
  el.style.top=top+'px';
  markSlashSel();
}
function markSlashSel(){
  const el=$('#menuSlash'); if(!el) return;
  const items=[...el.querySelectorAll('.ck-item')];
  items.forEach((n,i)=>n.classList.toggle('sel', i===slashSel));
  const cur=items[slashSel];
  if(cur && cur.scrollIntoView) cur.scrollIntoView({block:'nearest'});
}
function runSlash(cmd){
  const inp=$('#input');
  inp.value='';
  hideSlash();
  autoGrow();
  inp.focus();
  handleSlash(cmd);
}

/* ---------- 上下文压缩 ---------- */
async function doCompact(){
  if(!history.length){ toast('没有可压缩的内容'); return; }
  toast('压缩中…');
  try{
    const keep = 4;
    const old = history.slice(0, Math.max(0, history.length-keep));
    const rest = history.slice(Math.max(0, history.length-keep));
    const r = await fetch('/api/summarize',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: old })
    });
    const j = await r.json();
    const summary = j.ok ? j.summary : '';
    if(!summary){ toast('摘要生成失败'); return; }
    history = [{role:'user',content:'【前情摘要】\n'+summary}, {role:'assistant',content:'（已载入前情摘要，继续）'}].concat(rest);
    const c=cur(); if(c){ c.messages=history.slice(); saveChats(); }
    renderTranscript(true); updateStats();
    toast('已压缩');
  }catch(e){ toast('压缩失败'); }
}

/* ---------- 模型 / 权限 ---------- */
// 真实探活快照：有就按它着色，没有才退回内置静态快照（并明确标注）
let liveHealth={at:null,map:{}};
let healthProbing=false;
let settingsHasKey=false;
const HEALTH_TAG={ok:'可用',slow:'偏慢',congested:'排队',locked:'未开通',no_key:'未配置密钥',unknown:'未知'};
function clearHealthView(message){
  liveHealth={at:null,map:{}};
  const list=$('#sHealthList'); if(list) list.innerHTML='';
  const note=$('#sHealthNote');
  if(note) note.textContent=message||'尚未配置 API Key，接入后才会显示真实模型。';
}
function healthAgeText(){
  if(healthProbing) return liveHealth.at ? '正在重新检测…' : '正在检测全部模型…';
  if(!liveHealth.at) return '内置快照（未探活）';
  const m=Math.round((Date.now()-liveHealth.at)/60000);
  return m<1 ? '探活于刚刚' : m<60 ? '探活于 '+m+' 分钟前' : '探活于 '+Math.round(m/60)+' 小时前';
}
async function loadHealthSnapshot(){
  try{
    const j=await (await fetch('/api/model-health')).json();
    if(!j || j.noKey || !j.at || !Array.isArray(j.results) || !j.results.length){
      clearHealthView();
      return;
    }
    liveHealth.at=j.at; liveHealth.map={};
    j.results.forEach(r=>{ if(r && r.model) liveHealth.map[r.model]=r; });
  }catch{}
}
// 探活很贵（每个模型都要真发一次请求），所以 12 小时内优先复用上次结果。
// 超过 12 小时、或用户手动点「重新检测」时才真正打上游。
const HEALTH_TTL_MS = 12 * 3600 * 1000;
async function refreshHealth(opts){
  const o=opts||{};
  if(healthProbing && !o.force) return;
  // 无模型（未接入 key / 已解绑）时不探活，并彻底清掉旧快照渲染。
  if(!modelList.length){
    if(!settingsHasKey) clearHealthView();
    renderModelChip();
    return;
  }
  const age = liveHealth.at ? (Date.now()-liveHealth.at) : Infinity;
  if (!o.force && age < HEALTH_TTL_MS) { renderModelChip(); return; }
  healthProbing=true;
  try{
    const probeList = (availableModels && availableModels.length) ? availableModels : modelList;
    const j=await (await fetch('/api/model-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({models:probeList})})).json();
    if(j && j.at){
      liveHealth.at=j.at; liveHealth.map={};
      (j.results||[]).forEach(r=>{ liveHealth.map[r.model]=r; });
    }
  }catch(e){
    if(o.notify) toast('模型检测失败：'+(e.message||e));
  }finally{
    healthProbing=false;
    renderModelChip();
    const ms=$('#modalSettings');
    if(ms && ms.classList.contains('show')){
      const rs=Object.values(liveHealth.map).filter(r=>r && modelList.includes(r.model));
      if(rs.length){ paintHealthRows(rs); paintHealthNote(rs); }
      else { const hl=$('#sHealthList'); if(hl) hl.innerHTML=''; paintHealthNote([]); }
    }
    // 浮层开着时只重绘列表，保留用户已输入的搜索词与滚动位置
    const mm=$('#menuModel');
    if(mm && mm.classList.contains('show') && switcherEls) paintSwitcherList();
  }
}
function modelHealth(m){
  const live=liveHealth.map[m];
  if(live && live.level) return live.level;
  const meta=modelCatalog[m]||{};
  return meta.health || 'unknown';
}
// 状态栏模型胶囊：小圆点着色 + 名称，替代以前的脑子 emoji
let chipModel=null, chipSwitched=false;
function setChipModel(id, switched){
  chipModel=id||null; chipSwitched=!!switched; renderModelChip();
}
function renderModelChip(){
  const el=$('#stActual'), nameEl=$('#stActualName');
  if(!el || !nameEl) return;
  const id = chipModel || MODEL;
  const nm = id ? labelOf(id) : '未配置密钥';
  nameEl.textContent=(chipSwitched?'已切 ':'')+nm;
  el.classList.toggle('sw', chipSwitched);
  el.title=(chipSwitched?'本轮已切换作答模型：':'本轮实际作答：')+nm
    +'\n健康度：'+(HEALTH_TAG[modelHealth(id)]||'未知')+'（'+healthAgeText()+'）';
  const dot=el.querySelector('.dot');
  if(dot) dot.className='dot '+(chipSwitched?'congested':(id?modelHealth(id):'no_key'));
}
/* ---------- 统一模型视图（设置页下拉 / 设置页速选器 / 输入框浮层） ----------
   三处共用唯一数据源 modelList + modelCatalog + modelOwners + MODEL：
   任何一处的选择都走 selectModel()，任何一次数据变化都走 renderAllModelViews()，
   因此不会再出现「设置里改了输入框没变」或「勾选的模型只在其中一处出现」。 */
let switcherEls = null;   // 输入框浮层当前 DOM（仅浮层打开时有效）

function modelAccountOf(m){
  const meta = modelCatalog[m] || {};
  const pid = meta.provider || modelOwners[m] || '';
  const p = providers.find(x => x && x.id === pid);
  if(p) return { key:p.id, name:p.name || p.id };
  // 内置目录里没写 provider 的（NIM 那批）统一归到内置 NIM 模板
  const nim = providers.find(x => x && (x.id === 'builtin-nvidia' || x.builtin === true));
  if(nim) return { key:nim.id, name:nim.name || 'NVIDIA NIM' };
  return { key:'__other__', name: meta.group || '其他' };
}
function modelGroups(){
  const order = [];
  providers.forEach(p=>{ if(p && p.id && order.indexOf(p.id)<0) order.push(p.id); });
  const map = {};
  modelList.forEach(m=>{
    const a = modelAccountOf(m);
    if(!map[a.key]) map[a.key] = { key:a.key, name:a.name, ids:[] };
    map[a.key].ids.push(m);
  });
  const keys = order.filter(k=>map[k]);
  Object.keys(map).forEach(k=>{ if(keys.indexOf(k)<0) keys.push(k); });
  return keys.map(k=>map[k]);
}
function modelTags(m){
  const meta = modelCatalog[m] || {};
  const isBuiltin = !!meta.wire;                 // catalog 登记的内置精选模型
  const owner = providers.find(p => p && Array.isArray(p.models) && p.models.includes(m));
  const picked = !isBuiltin && !!owner;          // 用户在某个模板里手动勾选进来的
  const origin = isBuiltin ? '内置精选' : (owner ? ('已勾选 · '+(owner.name||owner.id)) : '未登记');
  const caps = [meta.vision?'视图':'', meta.tools?'工具':''].filter(Boolean).join('/');
  const ctx = meta.ctx ? Math.round(meta.ctx/1000)+'K' : '128K';
  // 初始化早期 liveHealth 可能尚未就绪，健康度取不到也要保证列表能渲染
  let h='unknown'; try{ h=modelHealth(m)||'unknown'; }catch(e){}
  const hTxt = h==='ok'?'可用':h==='slow'?'偏慢':h==='congested'?'排队':h==='locked'?'未开通':'未知';
  return { caps, ctx, h, hTxt, label: labelOf(m), picked, origin,
           tag: meta.health==='congested'?'（排队）':meta.health==='slow'?'（偏慢）':'' };
}
// provider 勾选状态变化后，按「内置精选目录 + 所有模板已勾选」重建主列表与归属，
// 让三处视图和勾选状态始终一致（不必等点保存）。
function syncModelListWithProviders(){
  // 严格区分「已勾选」与「仅云端可见但未勾选」：
  //   · 内置精选目录（catalog 登记、带 wire）常驻，这是应用配置好的高质量模型；
  //   · 其余模型只允许来自某个模板的勾选白名单 p.models；
  //   · 云端 /models 拉到但没勾选的模型绝不进主列表，也绝不写进 modelOwners（不绑定路由）。
  const builtin = Object.keys(modelCatalog).filter(m => modelCatalog[m] && modelCatalog[m].wire);
  const picked = [], owners = {};
  providers.forEach(p=>{
    if(!p || p.enabled===false || !Array.isArray(p.models)) return;
    p.models.forEach(m=>{
      if(!m) return;
      if(!owners[m]) owners[m] = p.id;          // 只绑定已勾选模型
      if(!picked.includes(m)) picked.push(m);
    });
  });
  modelOwners = Object.assign({}, owners);        // 不保留已取消勾选的旧映射
  modelList = builtin.concat(picked.filter(m=>!builtin.includes(m)));
  renderAllModelViews();
}
function renderAllModelViews(){
  try{ paintModelSelect(); }catch(e){}
  try{ paintModelPicker(); }catch(e){}
  try{ paintSwitcherList(); }catch(e){}
  setModelPill();
}
function syncModelNote(m){
  const meta = modelCatalog[m] || {};
  const note = $('#sModelNote'); if(!note) return;
  const h = meta.health==='ok'?'实测可用':meta.health==='slow'?'可用但偏慢':meta.health==='congested'?'会排队（自动降级）':meta.health==='locked'?'本账号未开通':'自定义模型';
  const caps = [meta.vision?'视图':'', meta.tools?'工具':''].filter(Boolean).join('/');
  const owner = modelAccountOf(m).name;
  note.textContent = (meta.desc||'自定义模型（协议自动探测）') + ' · ' + owner
    + ' · 协议 ' + (meta.wire||'自动探测') + ' · 状态 ' + h
    + (meta.ctx?(' · 上下文 '+(meta.ctx>=1000?Math.round(meta.ctx/1000)+'K':meta.ctx)):'')
    + (caps?(' · 能力 '+caps):'');
}
// ① 设置页原生下拉
function paintModelSelect(){
  const sel = $('#sModel'); if(!sel) return;
  sel.innerHTML='';
  if(!modelList.length){
    const o=document.createElement('option'); o.value=''; o.textContent='未配置密钥 · 模型不可用';
    o.disabled=true; sel.appendChild(o); sel.value='';
    const note=$('#sModelNote'); if(note) note.textContent='尚未配置 API Key，配置后模型列表才会出现。';
    return;
  }
  modelGroups().forEach(g=>{
    const og=document.createElement('optgroup'); og.label=g.name+' · '+g.ids.length+' 个';
    g.ids.forEach(m=>{
      const t=modelTags(m);
      const o=document.createElement('option'); o.value=m;
      o.textContent=t.label+t.tag+(t.picked?' · 已勾选':'');
      o.title=t.origin;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  sel.value = MODEL;
  sel.onchange = ()=>{ const m=sel.value; if(m){ syncModelNote(m); selectModel(m); } };
  syncModelNote(MODEL);
}
// ② 设置页可展开 / 可搜索 / 可滚轮滚动的速选器
function paintModelPicker(){
  const box=$('#sModelList'), sum=$('#sModelPickerSum'), search=$('#sModelSearch');
  if(!box) return;
  const paint=()=>{
    const kw=String((search&&search.value)||'').trim().toLowerCase();
    box.innerHTML=''; let shown=0;
    modelGroups().forEach(g=>{
      const ids=g.ids.filter(m=>{
        const meta=modelCatalog[m]||{};
        return !kw || (m+' '+(meta.label||'')+' '+(meta.desc||'')+' '+g.name).toLowerCase().indexOf(kw)>=0;
      });
      if(!ids.length) return;
      const h=document.createElement('div'); h.className='mp-group'; h.textContent=g.name+' · '+ids.length+' 个'; box.appendChild(h);
      ids.forEach(m=>{
        const t=modelTags(m);
        const row=document.createElement('div'); row.className='mp-row'+(m===MODEL?' sel':'');
        const nm=document.createElement('span'); nm.className='mp-nm'; nm.textContent=t.label; row.appendChild(nm);
        if(t.caps){ const c=document.createElement('span'); c.className='mp-cap'; c.textContent=t.caps; row.appendChild(c); }
        if(t.picked){ const c=document.createElement('span'); c.className='mp-origin'; c.textContent='已勾选'; row.appendChild(c); }
        const tag=document.createElement('span'); tag.className='mp-tag'; tag.textContent=t.ctx; row.appendChild(tag);
        row.title=m+' · '+t.origin;
        row.onclick=()=>selectModel(m);
        box.appendChild(row); shown++;
      });
    });
    if(!shown){ const e=document.createElement('div'); e.className='mp-empty'; e.textContent='没有匹配「'+kw+'」的模型'; box.appendChild(e); }
    if(sum) sum.textContent='展开模型列表 · 共 '+modelList.length+' 个（可滚动 / 搜索选择）';
  };
  if(search) search.oninput=paint;
  paint();
}
// 兼容旧调用点：设置页刷新统一收敛到 renderAllModelViews
function fillModelSelect(){ renderAllModelViews(); }

// ③ 输入框模型胶囊 → DSH 风格浮层：按 API 账号分组、搜索、可滚动、当前项高亮，
//    顺带切换推理等级；点一行即切换，三处视图同步。
function paintSwitcherList(){
  const el=$('#menuModel');
  if(!el || !el.classList.contains('show') || !switcherEls) return;
  const {list, search, foot, count} = switcherEls;
  const kw=String((search&&search.value)||'').trim().toLowerCase();
  list.innerHTML='';
  if(!modelList.length){
    const e=document.createElement('div'); e.className='msw-empty';
    e.textContent='尚未配置 API Key，请先在设置里接入模板';
    list.appendChild(e);
    if(count) count.textContent='0 个';
    if(foot) foot.textContent='当前：未配置密钥';
    return;
  }
  let shown=0;
  modelGroups().forEach(g=>{
    const ids=g.ids.filter(m=>{
      const meta=modelCatalog[m]||{};
      return !kw || (m+' '+(meta.label||'')+' '+(meta.desc||'')+' '+g.name).toLowerCase().indexOf(kw)>=0;
    });
    if(!ids.length) return;
    const h=document.createElement('div'); h.className='msw-group'; h.textContent=g.name+' · '+ids.length+' 个'; list.appendChild(h);
    ids.forEach(m=>{
      const t=modelTags(m);
      const row=document.createElement('div'); row.className='msw-row'+(m===MODEL?' sel':'');
      const dot=document.createElement('i'); dot.className='mdot '+t.h; row.appendChild(dot);
      const nm=document.createElement('span'); nm.className='msw-nm'; nm.textContent=t.label; row.appendChild(nm);
      if(t.caps){ const c=document.createElement('span'); c.className='msw-cap'; c.textContent=t.caps; row.appendChild(c); }
      if(t.picked){ const c=document.createElement('span'); c.className='msw-origin'; c.textContent='已勾选'; row.appendChild(c); }
      const tag=document.createElement('span'); tag.className='msw-tag'; tag.textContent=t.ctx; row.appendChild(tag);
      row.title=m+' · '+g.name+' · '+t.origin+(t.caps?'\n能力 '+t.caps:'')+'\n'+t.hTxt;
      row.onclick=(e)=>{ e.stopPropagation(); selectModel(m); closeMenus(); };
      list.appendChild(row); shown++;
    });
  });
  if(!shown){ const e=document.createElement('div'); e.className='msw-empty'; e.textContent='没有匹配「'+kw+'」的模型'; list.appendChild(e); }
  if(count) count.textContent='共 '+modelList.length+' 个';
  if(foot) foot.textContent='当前：'+MODEL_LABEL+' · 点击模型即切换';
}
function openModelMenu(anchor){
  const el=$('#menuModel'); if(!el) return;
  el.className='menu mswitch';
  el.innerHTML='';
  el.onclick=(e)=>e.stopPropagation();   // 输入搜索词时不触发 document 的 closeMenus
  const top=document.createElement('div'); top.className='msw-top';
  top.innerHTML='<span class="msw-title">切换模型</span><span class="msw-count"></span>';
  el.appendChild(top);
  const depthRow=document.createElement('div'); depthRow.className='msw-depth';
  const dl=document.createElement('span'); dl.textContent='推理等级'; depthRow.appendChild(dl);
  const btns=document.createElement('div'); btns.className='msw-depth-btns';
  DEPTHS.forEach(d=>{
    const b=document.createElement('button'); b.type='button'; b.textContent=d.n;
    b.className=(d.v===depth?'on':''); b.title=d.d;
    b.onclick=async(e)=>{
      e.stopPropagation();
      depth=d.v; store.set('whale.depth',d.v);
      const sd=$('#sDepth'); if(sd) sd.value=d.v;
      Array.from(btns.children).forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      try{ await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thinkingDepth:d.v})}); }catch(err){}
      toast('推理等级：'+d.n);
    };
    btns.appendChild(b);
  });
  depthRow.appendChild(btns); el.appendChild(depthRow);
  const search=document.createElement('input');
  search.type='text'; search.className='msw-search'; search.placeholder='搜索模型名称或 ID…';
  el.appendChild(search);
  const list=document.createElement('div'); list.className='msw-list'; el.appendChild(list);
  const foot=document.createElement('div'); foot.className='msw-foot'; el.appendChild(foot);
  switcherEls={ list, search, foot, count: top.querySelector('.msw-count') };
  search.oninput=paintSwitcherList;
  el.classList.add('show');
  markMenuState('menuModel', true);
  paintSwitcherList();
  const r=anchor.getBoundingClientRect();
  const h=el.offsetHeight || 380;
  el.style.left=Math.max(8, Math.min(r.left, window.innerWidth-348))+'px';
  let t=r.top-h-8;
  if(t<8) t=Math.min(r.bottom+8, Math.max(8, window.innerHeight-h-8));
  el.style.top=Math.max(8,t)+'px';
  setTimeout(()=>{ try{ search.focus(); }catch(e){} },0);
}
// 唯一的切换入口：任何一处点选都走这里，改完立刻重绘三处视图。
async function selectModel(m){
  if(!m || !modelList.includes(m)) return;
  if(m===MODEL){ renderAllModelViews(); return; }
  if(busy){ switchAbort=true; try{ stopRun(true); }catch(e){} }
  MODEL=m; MODEL_LABEL=labelOf(m);
  store.set('whale.model', m);
  setChipModel(null);
  renderAllModelViews();
  let synced=false;
  try{
    const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:m})});
    synced=r.ok;
  }catch(e){}
  const meta=modelCatalog[m]||{};
  toast(synced ? '已切换：'+MODEL_LABEL+(meta.wire?' · '+meta.wire+' 协议':'') : '本机已切换，但同步服务端失败（重启后可能恢复默认）');
}
function setModel(m){ return selectModel(m); }

const PERM_LABELS = {
  'workspace-write':'仅工作区可写',
  'read-only':'只读',
  'danger-full-access':'完全权限'
};
function syncPermLabel(){
  const v = $('#aSandbox').value;
  const label = PERM_LABELS[v] || v;
  $('#permLabel').textContent = label;
  store.set('whale.sandbox', v);
  const badge = $('#modeBadge');
  if(badge) badge.title = '当前生效权限：' + label;
  renderSandboxChip();
}
function openPermMenu(anchor){
  const cur = $('#aSandbox').value;
  const items = [
    {v:'workspace-write', label:'仅工作区可写'},
    {v:'read-only', label:'只读'},
    {v:'danger-full-access', label:'完全权限（需确认）'}
  ].map(x => Object.assign({}, x, {sel: x.v===cur}));
  openMenu($('#menuPerm'), items, (it)=>{
    $('#aSandbox').value = it.v;          // 真正改到发给后端的权限值
    syncPermLabel();
    if(it.v==='danger-full-access') setMode('agent');   // 保留原有进入 Agent 模式的入口
  }, anchor);
}
function setMode(m){
  mode = m;
  $('#modeBadge').textContent = m==='agent' ? 'Agent' : '聊天';
}

/* ---------- 设置 ---------- */
// 真实接入的模型（云端 /v1/models 返回的全部模型，含 id + name）
let availableModels = null;
// 排队降级链（用户可在设置里自定义）
let failoverChain = null;
// 多提供商（DSH 风格）：settings.providers 的前端镜像 + 当前激活 id + 展开中的卡片
let providers = [];
let activeProviderId = '';
let openProvId = '';
// 每个 provider 对应的云端可用模型缓存：{ providerId: [{id,name}] }
const provCloudCache = {};
async function refreshAvailable(){
  // 所有启用模板里「获取可用模型 → 勾选 → 保存」的模型都必须进主列表。
  // 旧实现只拿 activeProvider 的白名单去和「当前模型密钥」的云端列表取交集，
  // 会把其他模板勾选的模型全部过滤掉 → 设置页 / 聊天输入框都看不到刚保存的勾选结果。
  const extra = [];
  providers.forEach(p=>{
    if(!p || p.enabled===false || !Array.isArray(p.models)) return;
    p.models.forEach(m=>{ if(m && !modelList.includes(m) && !extra.includes(m)) extra.push(m); });
  });
  if(extra.length) modelList = modelList.concat(extra);
  // 云端列表只用来补友好显示名，绝不再覆盖 modelList：
  // 上游临时 404 / 额度不足 / 当前激活的是另一把密钥，都不该让已保存的模型凭空消失。
  try{
    const j = await (await fetch('/api/available-models')).json();
    if(j && j.ok && Array.isArray(j.models)){
      // 只给「主列表里已内置 / 已勾选」的模型补友好名；未勾选的云端模型不写进全局映射
      j.models.forEach(x=>{ if(x && x.id && modelList.includes(x.id)) cloudModelNames[x.id] = x.name || x.id; });
      availableModels = j.models.map(x=>x&&x.id).filter(Boolean);
    } else if(j && j.hasKey === false){
      availableModels = [];
    }
  }catch(e){
    availableModels = null;
  }
  renderAllModelViews();   // 勾选模型合并进来后立刻同步三处视图
}
function syncModels(s){
  if(!s || typeof s!=='object') return;
  settingsHasKey = !!s.hasKey;
  if(!settingsHasKey) clearHealthView();
  // 后端目录为准（含实测健康状态）；不做并集，避免留下已下线/未开通的旧模型
  // 无密钥时后端返回空 models，这里清空模型列表，界面显示「未配置密钥」空态
  if(Array.isArray(s.models)){
    modelList = s.models.slice();
  }
  if(s.labels && typeof s.labels==='object') modelLabels = Object.assign({}, modelLabels, s.labels);
  if(s.catalog && typeof s.catalog==='object')
    modelCatalog = Object.assign({}, MODEL_CATALOG_FALLBACK, s.catalog);
  if(s.modelOwners && typeof s.modelOwners==='object')
    modelOwners = Object.assign({}, s.modelOwners);
  const remembered = store.get('whale.model', null);
  const fromServer = s.model || MODEL_FALLBACK;
  if(modelList.length){
    MODEL = (remembered && modelList.indexOf(remembered)>=0) ? remembered
          : (modelList.indexOf(fromServer)>=0 ? fromServer : modelList[0]);
    MODEL_LABEL = labelOf(MODEL);
  } else {
    MODEL = null; MODEL_LABEL = '未配置密钥';
  }
  store.set('whale.model', MODEL || MODEL_FALLBACK);
  setModelPill();
  setChipModel(null);
  renderAllModelViews();   // 数据一变，设置下拉 / 速选器 / 输入框浮层一起刷新
}
/* 设置页下拉 / 速选器的实现已统一到上方 renderAllModelViews() 一组函数，
   这里不再保留第二份渲染逻辑：三处共用同一份数据，避免状态不同步。 */

/* ---------- 高精度语音模型按需下载（用户显式触发，绝不自动联网） ---------- */
let asrModelsTimer = null;
function asrFmtSize(n){
  n = Number(n)||0;
  return n >= 1073741824 ? (n/1073741824).toFixed(2)+' GB' : (n/1048576).toFixed(1)+' MB';
}
function asrSetStatus(t){ const el=$('#sAsrDlStatus'); if(el) el.textContent=t; }
async function refreshAsrModels(force){
  try{
    const opt = force ? {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'} : {};
    const r = await fetch(force ? '/api/asr/models/refresh' : '/api/asr/models', opt);
    const j = await r.json();
    renderAsrModels(j);
    if(force && j.ok === false) asrSetStatus('刷新失败：'+(j.reason||'未知错误'));
  }catch(e){ asrSetStatus('读取模型状态失败：'+(e.message||e)); }
}
function renderAsrModels(j){
  const box=$('#sAsrModelList'); if(!box || !j) return;
  box.textContent='';
  const models = Array.isArray(j.models) ? j.models : [];
  const cur=$('#sAsrCurrent');
  if(cur) cur.textContent = j.modelReady
    ? '当前模型：' + (j.modelFile || '已安装') + (j.activeModel ? ' · 引擎已加载' : ' · 首次说话时加载')
    : '当前模型：未安装，请在下方下载语音模型（首次使用必须下载）';
  if(!models.length){
    const d=document.createElement('div'); d.className='note';
    d.textContent='尚未加载清单。点击「刷新模型清单」从 '+(j.host||'官方源')+' 获取（仅此步会联网）。';
    box.appendChild(d);
  }
  for(const m of models){
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(128,128,128,.18);font-size:12px';
    const name=document.createElement('div'); name.style.cssText='flex:1;min-width:0';
    name.textContent = m.label + ' · ' + asrFmtSize(m.size) + (m.installed ? ' · 已安装' : (m.partial ? ' · 未下完，可续传' : ''));
    row.appendChild(name);
    const acts = m.installed ? [['use','设为当前'],['delete','删除']] : [['download','下载']];
    for(const [act,label] of acts){
      const b=document.createElement('button'); b.type='button'; b.dataset.act=act; b.dataset.key=m.key; b.textContent=label;
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  const p=j.progress||{}, wrap=$('#sAsrDlBarWrap'), bar=$('#sAsrDlBar');
  if(wrap && bar){
    if(p.state === 'running'){
      wrap.style.display='block';
      const pct = p.total ? Math.min(100, Math.round(p.loaded/p.total*100)) : 0;
      bar.style.width = pct+'%';
      asrSetStatus('正在下载 '+p.key+' … '+asrFmtSize(p.loaded)+' / '+asrFmtSize(p.total)+'（'+pct+'%）');
      if(!asrModelsTimer) asrModelsTimer=setInterval(()=>{
        const modal=$('#modalSettings');
        if(!modal || !modal.classList.contains('show')){ clearInterval(asrModelsTimer); asrModelsTimer=null; return; }
        refreshAsrModels(false);
      }, 900);
    }else{
      if(asrModelsTimer){ clearInterval(asrModelsTimer); asrModelsTimer=null; }
      wrap.style.display='none';
      if(p.state === 'error') asrSetStatus('下载失败：'+(p.error||'未知错误'));
      else if(p.state === 'done') asrSetStatus('下载完成并通过 sha256 校验；下次说话将按新模型重新加载。');
      else if(models.length) asrSetStatus('模型源：'+(j.host||'')+(j.isDefaultHost?'（内置默认）':'（自定义）')+'；当前实际模型：'+(j.activeModel||'未启动')+(j.requestedModel && j.requestedModel!==j.activeModel?'；设置选择：'+j.requestedModel:''));
      else asrSetStatus('未加载模型清单');
    }
  }
  if(j.engine === false) asrSetStatus('未检测到语音引擎（安装包内 whisper 目录缺失），下载模型也无法使用。');
}
async function asrModelAction(act,key){
  if(act === 'use'){
    try{
      const r=await fetch('/api/asr/models/use',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
      const j=await r.json();
      if(j.ok === false){ asrSetStatus('操作失败：'+(j.reason||'未知错误')); return; }
      asrSetStatus('已切换为 '+key+'，下次说话按新模型加载。');
      await refreshAsrModels(false);
    }catch(e){ asrSetStatus('操作失败：'+(e.message||e)); }
    return;
  }
  try{
    const r=await fetch('/api/asr/models/'+act,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const j=await r.json();
    if(j.ok === false){ asrSetStatus('操作失败：'+(j.reason||'未知错误')); renderAsrModels(j); return; }
    if(act === 'download') asrSetStatus('已开始下载 '+key+' …');
    await refreshAsrModels(false);
  }catch(e){ asrSetStatus('操作失败：'+(e.message||e)); }
}

let lastAgentCapsSettings = null;
function capsEsc(x){
  return String(x == null ? '' : x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderAgentCaps(s){
  const box = $('#agentCapsBox'); if(!box || !s) return;
  const caps = s.agentCapabilities || {};
  const catalog = s.catalog || {};
  const labels = s.labels || {};
  const names = {native:'原生工具', text:'文本协议', unknown:'待学习', unavailable:'不可用'};
  const colors = {native:'#3fb950', text:'#d29922', unknown:'#8b949e', unavailable:'#f85149'};
  let known = 0;
  const rows = Object.keys(catalog).map(function(m){
    const c = caps[m] || null;
    const mode = c && c.mode ? c.mode : 'unknown';
    if(mode !== 'unknown') known++;
    const label = labels[m] || m;
    const ev = c && c.evidence ? c.evidence : '首次使用时自动判定';
    const col = colors[mode] || colors.unknown;
    return '<div title="' + capsEsc(ev) + '" style="display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line,#3b3f4a)">' +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + capsEsc(label) + '</span>' +
      '<span style="color:' + col + ';white-space:nowrap">' + (names[mode] || mode) + '</span></div>';
  });
  box.innerHTML = rows.length ? rows.join('') : '<span class="note">暂无已登记模型</span>';
  const hint = $('#agentCapsHint');
  if(hint && !hint.textContent) hint.textContent = '已学习 ' + known + ' / ' + rows.length + ' 个模型';
}

async function openSettings(){
  try{ setModelPill(); }catch(e){}
  let s={};
  try{ s = await (await fetch('/api/settings')).json(); }catch(e){}
  cfg = Object.assign(cfg, s);
  try {
    renderEngineAlias(s);
    bindSetNav();
    if($('#setVer') && s.version) $('#setVer').textContent = s.version;
    showSetPage(store.get('whale.setCat','model'));
  } catch(e) {}
  // 多提供商（先设，refreshAvailable 要用白名单过滤）
  providers = (Array.isArray(s.providers) ? s.providers : []).map(p => Object.assign({}, p));
  activeProviderId = s.activeProviderId || (providers.length ? providers[0].id : '');
  if(!openProvId || !providers.some(p => p.id === openProvId)) openProvId = '';
  syncModels(s);
  await refreshAvailable();      // 接入 key 后，用云端真实模型校准列表
  fillModelSelect();
  renderProviders();
  $('#sDepth').value = (s.thinkingDepth && s.thinkingDepth !== 'off') ? s.thinkingDepth : (depth && depth !== 'off' ? depth : 'high');
  // 以服务端为准校准本地深度，避免「设置里改了、滑块还显示旧档」
  if($('#sDepth').value && $('#sDepth').value !== depth){
    depth = $('#sDepth').value;
    store.set('whale.depth', depth);
    setModelPill();
    try{ if(window.ReasoningSlider) ReasoningSlider.refresh(); }catch(e){}
  }
  $('#sLimit').value = s.contextLimit||350000;
  $('#sCompact').value = s.compactAt||100000;
  $('#sDirChat').value = (s.dirs&&s.dirs.chatArchive)||'';
  $('#sDirMem').value = (s.dirs&&s.dirs.memory)||'';
  $('#sDirTest').value = (s.dirs&&s.dirs.testFiles)||'';
  $('#sInject').checked = s.injectMemory!==false;
  $('#sAgentRoots').value = (s.agentRoots||[]).join('\n');
  $('#sAgentSafe').checked = s.agentSafeMode === true;
  lastAgentCapsSettings = s; renderAgentCaps(s);
  failoverChain = (Array.isArray(s.failoverChain) && s.failoverChain.length) ? s.failoverChain.slice() : null;
  $('#sFailover').value = s.autoFailover === false ? 'off' : 'on';
  renderFailoverPreset();
  $('#sAsrLang').value = s.asrLang === 'auto' ? 'auto' : 'zh';
  if($('#sAsrAudioCtx')) $('#sAsrAudioCtx').value = String(s.asrAudioCtx == null ? 768 : s.asrAudioCtx);
  if($('#sAsrHost')) $('#sAsrHost').value = s.asrModelHost || '';
  if($('#sVoiceTts')) $('#sVoiceTts').value = (s.voice && s.voice.tts) || '';
  if($('#sVoiceBot')) $('#sVoiceBot').value = (s.voice && s.voice.bot) || '';
  if($('#sVoiceTtsState')) { $('#sVoiceTtsState').textContent='未检测'; $('#sVoiceTtsState').style.color=''; }
  if($('#sVoiceBotState')) { $('#sVoiceBotState').textContent='未检测'; $('#sVoiceBotState').style.color=''; }
  if($('#sAsrCurrent') && s.asrInstalled === false)
    $('#sAsrCurrent').textContent = '当前模型：尚未下载或引擎缺失 —— 请在本页下方下载模型。';
  $('#modalSettings').classList.add('show');
  try { refreshAsrModels(false); } catch(e) {}
  // 无密钥时绝不渲染旧快照；有密钥也只显示当前模型目录内的结果。
  if(!settingsHasKey){
    clearHealthView();
  } else {
    const liveRs=Object.values(liveHealth.map).filter(r=>r && modelList.includes(r.model));
    if(liveRs.length){ paintHealthRows(liveRs); paintHealthNote(liveRs); }
    else { const hl=$('#sHealthList'); if(hl) hl.innerHTML=''; paintHealthNote([]); }
  }
  const healthBtn=$('#sHealth'); if(healthBtn) healthBtn.disabled=!settingsHasKey||!modelList.length;
  loadModelActivity();
}

/* ---------- 多提供商（API 密钥模板）管理 ---------- */
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function createProviderDraft(){
  return {
    id: 'p'+(providers.length+1)+'-'+Date.now().toString(36),
    name: '', apiKey: '', base: '',
    protocol: 'openai', models: [], enabled: true, _draft: true,
  };
}
// 没有任何提供商时，直接展开一份未保存的新建表单。
// 这样「API 地址」始终可见，不会再被藏进一个必须先点「添加」才出现的折叠卡片里。
function ensureProviderEditor(){
  if(providers.length) return;
  const p=createProviderDraft();
  providers.push(p);
  activeProviderId=p.id;
  openProvId=p.id;
}
// 生成 provider 卡片 DOM（DSH 风格：头行 + 可折叠配置体 + 模型目录）
function renderProviders(){
  const list=$('#sProvList'); if(!list) return;
  const addBtn=$('#sProvAdd');
  const provNote=$('#sProvNote');
  // 每个已保存的 API 接入模板都渲染成一个独立区块（DSH 风格），与密钥是否为空无关。
  // 旧逻辑在 hasKey=false 时把整块列表清空，导致「保存了模板却看不到卡片」；
  // 现在即使密钥暂时缺失也保留卡片，用户可就地补密钥 / 编辑 / 删除。
  if(addBtn) addBtn.style.display='';
  if(provNote) provNote.textContent='每个模板单独保存接口地址、密钥与已勾选模型；点卡片展开编辑，右侧可删除。';
  list.innerHTML='';
  if(!providers.length){
    list.innerHTML='<div class="prov-empty">还没有保存的 API 接入模板，点下方「＋ 添加 API 提供商」新建。</div>';
    return;
  }
  // 不再自动 ensureProviderEditor：内置预设（如 NVIDIA NIM）已在 providers 里，直接渲染即可。
  providers.forEach(p => {
    const isActive = p.id === activeProviderId;
    const isOpen = p.id === openProvId;
    const card=document.createElement('div');
    card.className='prov-card'+(isActive?' active':'')+(isOpen?' open':'');
    card.dataset.id=p.id;

    const head=document.createElement('div');
    head.className='prov-head';
    const statusTag = p._draft ? '未保存'
      : (p.apiKey ? (p.builtin ? '已登录' : (isActive ? '当前使用' : '已配置')) : '缺少密钥');
    head.innerHTML =
      '<span class="prov-dot'+(p.apiKey?' on':' off')+'"></span>' +
      '<span class="prov-name">'+escapeHtml(p.name||'新 API 提供商（未保存）')+'</span>' +
      '<span class="prov-kind">'+(p.builtin?'内置':'自定义')+'</span>' +
      '<span class="prov-mcnt">'+(Array.isArray(p.models)?p.models.length:0)+' 个模型</span>' +
      '<span class="prov-tag'+((isActive||p.builtin)&&p.apiKey&&!p._draft?' active':'')+'">'+statusTag+'</span>' +
      '<span class="prov-act edit" data-act="edit">编辑</span>' +
      '<span class="prov-act del" data-act="del">删除</span>';
    head.addEventListener('click', (e)=>{
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if(act==='edit'){ openProvId = openProvId===p.id ? '' : p.id; renderProviders(); return; }
      if(act==='del'){ deleteProvider(p.id); return; }
      // 点头部其他区域：展开/收起
      openProvId = openProvId===p.id ? '' : p.id; renderProviders();
    });
    card.appendChild(head);

    // 折叠体：显示名称 / API 地址 / 协议 / 模型目录 / 设为当前
    const body=document.createElement('div');
    body.className='prov-body';
    body.innerHTML =
      '<div class="fld"><label>显示名称</label><input class="p-name" type="text" placeholder="例如 我的 API 后端"></div>' +
      '<div class="fld"><label>接口地址</label><input class="p-base" type="text" placeholder="https://integrate.api.nvidia.com/v1"><div class="note">每个提供商可保存不同的接口地址；解绑后会清空，不会自动填回。</div></div>' +
      '<div class="fld"><label>API 密钥</label><input class="p-key" type="password" placeholder="nvapi-…（留空不修改已保存的密钥）"></div>' +
      '<div class="fld"><label>API 协议</label><select class="p-proto">' +
        '<option value="openai">OpenAI Chat Completions</option>' +
        '<option value="responses">OpenAI Responses</option>' +
      '</select></div>' +
      '<div class="prov-models">' +
        '<div class="prov-models-hd">' +
          '<span class="lbl">模型目录<small>（已选 '+(p.models||[]).length+' 个）</small></span>' +
          '<span class="spacer"></span>' +
          '<button class="lk" data-m="fetch">获取可用模型</button>' +
          '<button class="lk" data-m="selall">全选可见</button>' +
          '<button class="lk danger" data-m="clear">清空</button>' +
        '</div>' +
        '<input class="pm-search" type="text" placeholder="搜索模型名称或 ID，支持关键字过滤…">' +
        '<div class="prov-mlist" data-mlist></div>' +
      '</div>' +
      '<div class="row2" style="margin-top:12px">' +
        '<button class="p-save" type="button">保存此提供商</button>' +
        (isActive ? '' : '<button class="p-use" type="button" style="color:var(--accent)">设为当前</button>') +
      '</div>';

    // 填充已有值
    body.querySelector('.p-name').value = p.name||'';
    body.querySelector('.p-base').value = p.base||'';
    body.querySelector('.p-key').value = '';   // 不回显密钥，留空表示不修改
    body.querySelector('.p-proto').value = (p.protocol==='responses'?'responses':'openai');

    // 模型目录：合并「已选 + 云端可见」，支持关键字搜索、自由勾选 / 取消勾选 / 再勾选。
    // 搜索只重绘列表本身，不动整张卡片，名称 / 地址 / 密钥输入不会被清空。
    const mlist=body.querySelector('[data-mlist]');
    const searchEl=body.querySelector('.pm-search');
    if(!Array.isArray(p.models)) p.models=[];
    let kw = String(p._search||'').trim().toLowerCase();
    if(searchEl) searchEl.value = p._search || '';
    const collect = () => {
      const ids = p.models || [];
      const cloud = provCloudCache[p.id] || [];
      const all = [];
      const seen = new Set();
      ids.forEach(id => { if(id && !seen.has(id)){ seen.add(id); all.push({id, name: labelOf(id)}); } });
      cloud.forEach(c => { if(c && c.id && !seen.has(c.id)){ seen.add(c.id); all.push(c); } });
      return all;
    };
    const visibleOf = (all) => kw ? all.filter(m => ((m.id||'')+' '+(m.name||'')).toLowerCase().indexOf(kw)>=0) : all;
    const renderMlist = () => {
      const all = collect();
      const filtered = visibleOf(all);
      if(!all.length){
        mlist.innerHTML='<div class="pm-empty">暂无模型，点「获取可用模型」自动识别</div>';
        return;
      }
      if(!filtered.length){
        mlist.innerHTML='<div class="pm-empty">没有匹配「'+escapeHtml(kw)+'」的模型</div>';
        return;
      }
      mlist.innerHTML='';
      filtered.forEach(m => {
        const row=document.createElement('div');
        row.className='pm-row';
        const cb=document.createElement('input'); cb.type='checkbox'; cb.checked = p.models.includes(m.id);
        cb.addEventListener('change', ()=>{
          if(cb.checked){ if(!p.models.includes(m.id)) p.models.push(m.id); }
          else p.models = p.models.filter(x => x!==m.id);
          // 只更新计数，不重绘整张卡片，避免清掉尚未保存的名称/地址/密钥输入。
          const count=body.querySelector('.prov-models-hd small');
          if(count) count.textContent='（已选 '+p.models.length+' 个）';
          // 勾选 / 取消立即同步到三处切换视图，不必等点「保存」
          syncModelListWithProviders();
        });
        const idEl=document.createElement('span'); idEl.className='pm-id'; idEl.textContent=m.id; idEl.title=m.id;
        const nmEl=document.createElement('span'); nmEl.className='pm-nm'; nmEl.textContent=m.name||'';
        row.appendChild(cb); row.appendChild(idEl); row.appendChild(nmEl);
        mlist.appendChild(row);
      });
    };
    if(searchEl) searchEl.addEventListener('input', ()=>{
      kw = searchEl.value.trim().toLowerCase();
      p._search = searchEl.value;
      renderMlist();
    });
    renderMlist();

    // 「获取可用模型」：按此 provider 的 key/base 拉云端真实模型（含草稿里刚填、尚未保存的密钥）
    body.querySelector('[data-m="fetch"]').addEventListener('click', async (e)=>{
      const btn=e.currentTarget;
      const name = body.querySelector('.p-name').value.trim();
      const tidy = tidyKeyInput(body.querySelector('.p-key').value.trim() || p.apiKey);
      const base = tidyBaseInput(body.querySelector('.p-base').value.trim() || p.base);
      const key = tidy.key;
      if(tidy.dirty && key) toast('密钥含中文/省略号等非法字符，已自动清理');
      if(!key){ toast('请先填入 API 密钥再获取可用模型'); return; }
      if(!base){ toast('请先填写接口地址再获取可用模型'); return; }
      // 拉取后需要重绘模型目录，先把表单值接回 provider，避免输入被重绘清空。
      // 这里存的是规整后的值，之后点「保存」不会把带中文/省略号的脏密钥写进配置。
      p.name=name; p.base=base; p.apiKey=key;
      p.protocol=body.querySelector('.p-proto').value;
      p._search = body.querySelector('.pm-search') ? body.querySelector('.pm-search').value : '';
      btn.disabled=true; const old=btn.textContent; btn.textContent='获取中…';
      try{
        // 用 POST 传密钥：密钥不进 URL（避免超长与编码问题），后端统一规整脏字符并返回可读诊断
        const j = await (await fetch('/api/available-models', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ key, base })
        })).json();
        const noteRaw = (j && Array.isArray(j.notes) && j.notes.length) ? j.notes.join('；') : '';
        const errText = (j && j.err) || '无可用模型，请检查密钥与接口地址';
        // err 与 notes 可能是同一句话（例如脱敏密钥），避免提示重复两遍
        const note = noteRaw && errText.indexOf(noteRaw) < 0 ? '（'+noteRaw+'）' : '';
        if(j && j.ok && j.hasKey){
          const arr = j.models || [];
          provCloudCache[p.id] = arr;
          // 云端可见的全部模型名同步进全局，供 labelOf 使用
          arr.forEach(x => { if(x && x.id) cloudModelNames[x.id] = x.name || x.id; });
          // 自动勾选「目前已经选择的模型」：当前正在用的模型（空态时回退到后端当前模型）
          // + 本模板此前已勾选的，前提是它在云端可见。其余保持未勾选，
          // 用户可搜索后自行取消勾选或勾选别的模型。
          const visible = new Set(arr.map(x => x && x.id).filter(Boolean));
          const current = MODEL || (cfg && cfg.model) || '';
          if(!Array.isArray(p.models)) p.models=[];
          let added=0;
          [current].concat(p.models.slice()).filter(Boolean).forEach(id=>{
            if(visible.has(id) && !p.models.includes(id)){ p.models.push(id); added++; }
          });
          // 只重绘模型列表，不重绘整张卡片：名称 / 地址 / 密钥 / 搜索词全部保持用户刚填的状态。
          renderMlist();
          syncModelListWithProviders();   // 自动勾选的模型立即进入三处切换视图
          const cnt=body.querySelector('.prov-models-hd small');
          if(cnt) cnt.textContent='（已选 '+p.models.length+' 个）';
          btn.disabled=false; btn.textContent=old;
          toast('已识别 '+arr.length+' 个可用模型'+(added?'，已自动勾选当前模型 '+(current||''):'')+'；可搜索、取消勾选或勾选其他模型'+note);
        } else {
          toast('获取失败：' + errText + note);
          btn.disabled=false; btn.textContent=old;
        }
      }catch(err){
        toast('获取失败：'+(err.message||err));
        btn.disabled=false; btn.textContent=old;
      }
    });

    // 全选当前搜索结果里可见的模型（方便一次勾选一批）
    body.querySelector('[data-m="selall"]').addEventListener('click', ()=>{
      const vis = visibleOf(collect());
      vis.forEach(m=>{ if(!p.models.includes(m.id)) p.models.push(m.id); });
      renderMlist();
      const count=body.querySelector('.prov-models-hd small');
      if(count) count.textContent='（已选 '+p.models.length+' 个）';
      syncModelListWithProviders();
      if(vis.length) toast('已勾选当前可见的 '+vis.length+' 个模型');
    });

    // 清空模型目录
    body.querySelector('[data-m="clear"]').addEventListener('click', ()=>{
      p.models = [];
      renderMlist();
      const count=body.querySelector('.prov-models-hd small');
      if(count) count.textContent='（已选 0 个）';
      syncModelListWithProviders();
    });

    // 保存此提供商
    body.querySelector('.p-save').addEventListener('click', async ()=>{
      const name = body.querySelector('.p-name').value.trim();
      const base = tidyBaseInput(body.querySelector('.p-base').value);
      const tidy = tidyKeyInput(body.querySelector('.p-key').value);
      const key = tidy.key;
      const proto = body.querySelector('.p-proto').value;
      if(!name){ toast('请填写显示名称'); return; }
      if(!base){ toast('请填写接口地址'); return; }
      if(tidy.dirty && !key){ toast('密钥含中文/省略号等非法字符，清理后为空，请重新粘贴完整密钥'); return; }
      if(!key && !p.apiKey){ toast('请填写 API 密钥'); return; }
      if(tidy.dirty && key) toast('密钥含非法字符，已自动清理后保存');
      p.name = name;
      p.base = base;
      if(key) p.apiKey = key;
      p.protocol = proto;
      try{
        await persistProviders();
        toast('已保存「'+name+'」');
        // 保存后重新拉一次设置，刷新激活状态与模型列表
        await reloadAfterProviderChange();
      }catch(e){ toast('保存失败：'+(e.message||e)); }
    });

    // 设为当前
    const useBtn = body.querySelector('.p-use');
    if(useBtn) useBtn.addEventListener('click', async ()=>{
      activeProviderId = p.id;
      openProvId = '';
      await persistProviders();
      toast('已切换当前提供商：'+p.name);
      await reloadAfterProviderChange();
    });

    card.appendChild(body);
    list.appendChild(card);
  });
}
// 规整用户粘贴的密钥 / 接口地址：HTTP 请求头只接受 Latin-1，
// 中文、省略号（…）、零宽字符混进 Authorization 会直接抛 ByteString 错误。
function tidyKeyInput(v){
  const raw = String(v==null?'':v);
  const key = raw.replace(/[\u200B-\u200D\uFEFF\u2060]/g,'')
                 .replace(/[^\x20-\x7E]/g,'')
                 .trim();
  return { key, dirty: key !== raw.trim() };
}
function tidyBaseInput(v){
  return String(v==null?'':v).replace(/[^\x20-\x7E]/g,'').replace(/[\s"'`<>]/g,'').trim();
}
// 新增一个空的 provider 卡片；接口地址默认留空，由用户明确填写后保存。
function addProvider(){
  const p = createProviderDraft();
  providers.push(p);
  openProvId = p.id;
  renderProviders();
}
// 删除 provider（解绑该密钥模板）；若删的是当前激活的，接口地址一并清空
async function deleteProvider(id){
  const p = providers.find(x => x.id===id);
  if(!p) return;
  const msg = p.builtin
    ? '确定删除内置预设「'+(p.name||'')+'」吗？\n删除后将解绑已保存的 API 密钥与接口地址。'
    : '确定删除提供商「'+(p.name||'未命名')+'」吗？\n删除后其密钥、接口地址与模型目录将一并移除。';
  if(!confirm(msg)) return;
  try{
    // 内置预设（NVIDIA NIM）删除 = 解绑：清空密钥与接口地址，回到「未配置」空态
    const body = p.builtin ? { unbindKey: true } : { deleteProviderId: id };
    const r = await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j = await r.json();
    if(!j.ok){ toast('删除失败'); return; }
    if(provCloudCache[id]) delete provCloudCache[id];
    toast(p.builtin ? '已解绑密钥' : '已删除提供商');
    await reloadAfterProviderChange();
  }catch(e){ toast('删除失败：'+(e.message||e)); }
}
// 把前端 providers 状态持久化到后端 settings.json
async function persistProviders(){
  const clean = providers
    // 已保存的模板即使密钥暂时为空也保留（可就地补填）；只有草稿必须填齐才落盘
    .filter(p => p && p.name && p.base && (!p._draft || p.apiKey))
    .map(p => ({
      id: p.id, name: p.name, apiKey: p.apiKey, base: p.base,
      protocol: p.protocol, models: p.models||[], enabled: p.enabled!==false,
      builtin: p.builtin === true,
    }));
  // 新模板保存后自动成为当前激活项，避免 activeProviderId 悬空导致模板「看起来没生效」
  let activeId = activeProviderId;
  if(!clean.some(p=>p.id===activeId)) activeId = clean.length ? clean[0].id : '';
  activeProviderId = activeId;
  const body = { providers: clean, activeProviderId };
  const r = await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j = await r.json().catch(()=>({}));
  if(!j.ok) throw new Error(j.error || '保存失败');
  return j;
}
// provider 变更后：重拉 settings，刷新模型列表 / 胶囊 / 实况
async function reloadAfterProviderChange(){
  let s={};
  try{ s = await (await fetch('/api/settings')).json(); }catch(e){}
  providers = (Array.isArray(s.providers) ? s.providers : []).map(p => Object.assign({}, p));
  activeProviderId = s.activeProviderId || (providers.length ? providers[0].id : '');
  syncModels(s);
  await refreshAvailable();
  fillModelSelect();
  renderProviders();
  // 无 key 时清空实况列表，避免残留「未配置密钥」假模型
  if(!s.hasKey){
    clearHealthView();
  } else {
    const liveRs=Object.values(liveHealth.map).filter(r=>r && modelList.includes(r.model));
    if(liveRs.length){ paintHealthRows(liveRs); paintHealthNote(liveRs); }
    else { const hl=$('#sHealthList'); if(hl) hl.innerHTML=''; paintHealthNote([]); }
  }
  const healthBtn=$('#sHealth'); if(healthBtn) healthBtn.disabled=!s.hasKey||!modelList.length;
}
// 排队降级链的预设：显示当前预设了哪些模型；无可用模型时禁用
function renderFailoverPreset(){
  const sel=$('#sFailover'), note=$('#sFailoverPresetNote'), btn=$('#sFailoverPreset');
  const chain = failoverChain || [];
  const hasModels = modelList.length > 0;
  // 无任何模型/预设时，排队下拉只留「关闭」，且禁用预设按钮
  if(sel){
    const onOpt = sel.querySelector('option[value="on"]');
    if(onOpt) onOpt.style.display = hasModels ? '' : 'none';
    if(!hasModels && sel.value === 'on') sel.value = 'off';
  }
  if(btn) btn.disabled = !hasModels;
  if(note){
    if(!hasModels) note.textContent = '接入 API Key 后才有模型可预设';
    else if(!chain.length) note.textContent = '尚未预设，将用内置默认链（550B → Lightning → Bolt）';
    else note.textContent = '预设顺序：' + chain.map(m => labelOf(m)).join(' → ');
  }
}
// 打开预设模型多选菜单：点选切换，顺序即降级顺序
function openFailoverPreset(anchor){
  if(!modelList.length){ toast('尚未接入模型，无法预设'); return; }
  const chain = failoverChain ? failoverChain.slice() : [];
  const items = [];
  items.push({ hdr:true, label:'预设备用模型（点选，顺序即切换顺序）' });
  modelList.forEach(m=>{
    const idx = chain.indexOf(m);
    items.push({ v:m, label:(idx>=0 ? (idx+1)+'. ' : '') + labelOf(m), sel: idx>=0, keepOpen:true });
  });
  items.push({ hdr:true, label:'——' });
  items.push({ act:'done', label:'完成', keepOpen:true });
  openMenu($('#menuFailover'), items, (it)=>{
    if(it.act==='done'){ closeMenus(); return; }
    if(it.v){
      const i = chain.indexOf(it.v);
      if(i>=0) chain.splice(i,1); else chain.push(it.v);
      failoverChain = chain;
      // 立即重画菜单以刷新序号与勾选，同时更新说明
      renderFailoverPreset();
      openFailoverPreset(anchor);
    }
  }, anchor);
}
// 设置里的模型实况列表（启动自动探活和手动检测共用同一套渲染）
function paintHealthRows(rs){
  const list=$('#sHealthList'); if(!list) return;
  list.innerHTML='';
  // 最后一道防线：无密钥/无模型时一律空白；切换提供商后也不显示上一份快照里的模型。
  if(!settingsHasKey || !modelList.length) return;
  const rows=(Array.isArray(rs)?rs:[]).filter(x=>x && modelList.includes(x.model));
  rows.slice().sort((a,b)=>(a.ms||9e9)-(b.ms||9e9)).forEach(x=>{
    const row=document.createElement('div'); row.className='hrow';
    const lv=x.level||(x.ok?(x.ms<3000?'ok':'slow'):'congested');
    const dot=`<span class="mdot ${lv}"></span>`;
    const nm=document.createElement('span'); nm.className='nm';
    nm.textContent=labelOf(x.model);
    if(!x.ok){ row.title=x.err||'不可用'; row.classList.add('bad'); }
    const st=document.createElement('span'); st.className='st';
    st.textContent = x.ok ? '200' : (x.status==='timeout' ? '超时' : (lv==='locked' ? '未开通' : (lv==='no_key' ? '未配置密钥' : String(x.status))));
    const ms=document.createElement('span'); ms.className='ms';
    ms.textContent = x.ok ? ((x.ms/1000).toFixed(1)+'s') : '';
    row.innerHTML=dot; row.appendChild(nm); row.appendChild(st); row.appendChild(ms);
    list.appendChild(row);
  });
}
function paintHealthNote(rs){
  const note=$('#sHealthNote'); if(!note) return;
  if(!settingsHasKey){ note.textContent='尚未配置 API Key，接入后才会显示真实模型。'; return; }
  if(!rs.length){ note.textContent='未检测。接入模型后可点「检测全部模型」获取真实状态。'; return; }
  const age = healthProbing ? '正在重新检测（下面是上一次结果）' : healthAgeText();
  note.textContent=`可用 ${rs.filter(x=>x.ok).length} / ${rs.length} · 右列为正文首字耗时 · ${age}`;
}
// 主动探活：只在这里发小请求，平时绝不空耗配额
async function checkModelHealth(){
  const btn=$('#sHealth'), note=$('#sHealthNote');
  if(!btn || btn.disabled) return;
  if(healthProbing){ toast('启动自动检测还在进行，请稍候'); return; }
  // 无模型（未接入 key / 已解绑）时直接提示，不发请求
  if(!modelList.length){ if(note) note.textContent='尚未配置 API Key，接入后才会显示真实模型。'; return; }
  btn.disabled=true; const old=btn.textContent; btn.textContent='检测中…';
  if(note) note.textContent='正在流式试探首字，普通模型最多等 15 秒、偏慢模型 45 秒…';
  const list=$('#sHealthList'); if(list) list.innerHTML='';
  try{
    // 用真实接入的模型列表探活，而不是固定的内置模板
    const probeList = (availableModels && availableModels.length) ? availableModels : modelList;
    const r=await fetch('/api/model-health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({models:probeList})});
    const j=await r.json();
    const rs=(j&&j.results)||[];
    // 同步到菜单状态点：设置里测完，模型胶囊里显示的也是这次结果
    if(j && j.at){ liveHealth.at=j.at; liveHealth.map={}; rs.forEach(x=>{ liveHealth.map[x.model]=x; }); }
    paintHealthRows(rs);
    paintHealthNote(rs);
  }catch(e){
    if(note) note.textContent='检测失败：'+(e.message||e);
  }finally{
    btn.disabled=!settingsHasKey||!modelList.length; btn.textContent=old||'检测全部模型';
    renderModelChip();
  }
}

/* ---------- 模型活动日志 ---------- */
// 设置里只放入口 + 最近 3 条（板块不增高），明细全部进独立面板
let maEntries=[], maFile='', maTotal=0, maFilter='all', maQuery='';
function maBadge(e){
  const switched = maSwitched(e);
  if(switched) return { cls:'sw', text:'已切换' };
  if(e.kind==='agent'){
    if(e.outcome==='ok') return { cls:'ok', text:'Agent 完成' };
    if(e.outcome==='rejected') return { cls:'stopped', text:'Agent 拒绝' };
    return { cls:'err', text:'Agent 失败' };
  }
  switch(e.outcome){
    case 'ok': return { cls:'ok', text:'正常' };
    case 'empty': return { cls:'empty', text:'无正文' };
    case 'stopped': case 'aborted': return { cls:'stopped', text:'已停止' };
    default: return { cls:'err', text:'失败' };
  }
}
function maEl(tag,cls,text){
  const n=document.createElement(tag);
  if(cls) n.className=cls;
  if(text!==undefined) n.textContent=String(text);
  return n;
}
function maName(id){ return id ? (modelLabels[id] || String(id).split('/').pop()) : '—'; }
function maSwitched(e){ return !!(e.actual && e.requested && e.actual!==e.requested); }
function maFmtMs(ms){ return typeof ms==='number' ? (ms/1000).toFixed(ms<10000?2:1)+'s' : '—'; }
function maMetaSeg(e){
  const seg=[];
  if(typeof e.ttft==='number') seg.push('首字 '+maFmtMs(e.ttft));
  if(typeof e.ms==='number') seg.push('总 '+maFmtMs(e.ms));
  if(typeof e.chars==='number') seg.push(e.chars+' 字');
  if(e.wire) seg.push(e.wire);
  return seg.join(' · ');
}
function maAttemptText(a){
  const nm=maName(a.model);
  if(a.result==='timeout') return nm+'（排队 '+(a.waitedMs?Math.round(a.waitedMs/1000)+'s':'超时')+'）';
  if(a.result==='http') return nm+'（HTTP '+a.status+(a.code?(' '+a.code):'')+'）';
  return nm+'（连接失败'+(a.msg?('：'+a.msg):'')+'）';
}
// 设置面板里的紧凑行
function maRowMini(e){
  const row=maEl('div','ma-row');
  const l1=maEl('div','ma-l1');
  l1.appendChild(maEl('span','ma-time', new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})));
  const m=maEl('span','ma-model');
  if(maSwitched(e)){
    m.appendChild(maEl('span','req', maName(e.requested)));
    m.appendChild(maEl('span','arw','→'));
    m.appendChild(maEl('span','act sw', maName(e.actual)));
  } else {
    m.textContent=maName(e.actual||e.requested);
  }
  l1.appendChild(m);
  const b=maBadge(e);
  l1.appendChild(maEl('span','ma-badge '+b.cls, b.text));
  row.appendChild(l1);
  const l2=maEl('div','ma-l2');
  l2.appendChild(maEl('span','ma-meta', maMetaSeg(e)||'—'));
  if(e.reason) l2.appendChild(maEl('span','ma-why','· '+e.reason));
  row.appendChild(l2);
  return row;
}
function maCell(k,v){
  const c=maEl('div','lg-cell');
  c.appendChild(maEl('div','k',k));
  c.appendChild(maEl('div','v',v));
  return c;
}
// 面板里的明细行：时间/模型流/结论 + 关键指标 + 原因与尝试链 + 原始 JSON
function maRowFull(e){
  const row=maEl('div','lg-row');
  const h=maEl('div','lg-h');
  h.appendChild(maEl('span','lg-time', new Date(e.at).toLocaleString('zh-CN',{hour12:false}).slice(5)));
  const f=maEl('span','lg-flow');
  const reqN=maName(e.requested), actN=maName(e.actual||e.requested);
  if(maSwitched(e)){
    f.appendChild(maEl('span','lg-m req',reqN));
    f.appendChild(maEl('span','lg-arw','→'));
    f.appendChild(maEl('span','lg-m act',actN));
  } else {
    f.appendChild(maEl('span','lg-m',actN));
  }
  if(e.kind==='agent') f.appendChild(maEl('span','lg-tag','Agent'));
  f.title = reqN + (maSwitched(e)?(' → '+actN):'');
  h.appendChild(f);
  const b=maBadge(e);
  h.appendChild(maEl('span','ma-badge '+b.cls, b.text));
  row.appendChild(h);

  const tk=e.tokens||{};
  const hasTok = (tk.prompt_tokens||tk.completion_tokens||tk.total_tokens);
  const cps = (typeof e.ms==='number' && e.ms>0 && typeof e.chars==='number' && e.chars>0)
    ? (e.chars/(e.ms/1000)).toFixed(1)+' 字/s' : '—';
  const g=maEl('div','lg-grid');
  g.appendChild(maCell('正文首字', typeof e.ttft==='number' ? maFmtMs(e.ttft) : '—'));
  g.appendChild(maCell('总耗时', typeof e.ms==='number' ? maFmtMs(e.ms) : '—'));
  g.appendChild(maCell('正文字数', typeof e.chars==='number' ? e.chars+' 字' : '—'));
  g.appendChild(maCell('出字速度', cps));
  g.appendChild(maCell('token 入/出', hasTok ? ((tk.prompt_tokens||0)+' / '+(tk.completion_tokens||0)) : '—'));
  g.appendChild(maCell('协议', e.wire||'—'));
  row.appendChild(g);

  const det=[];
  if(e.reason) det.push('原因：'+e.reason);
  if(Array.isArray(e.attempts) && e.attempts.length) det.push('尝试链：'+e.attempts.map(maAttemptText).join(' → '));
  if(Array.isArray(e.notes) && e.notes.length) det.push('处理：'+e.notes.join('；'));
  if(typeof e.reasoningChars==='number' && e.reasoningChars) det.push('推理正文 '+e.reasoningChars+' 字');
  if(e.kind==='agent'){
    if(e.sandbox) det.push('沙箱 '+e.sandbox);
    if(e.dir) det.push('目录 '+e.dir);
    if(e.runId) det.push('runId '+String(e.runId).slice(0,10));
  } else if(e.session) {
    det.push('会话 '+String(e.session).slice(0,10));
  }
  if(e.thinkingBudget) det.push('输出预算 '+e.thinkingBudget);
  if(det.length) row.appendChild(maEl('div','lg-notes', det.join(' · ')));

  const pre=maEl('pre','lg-pre', JSON.stringify(e,null,2));
  row.appendChild(pre);
  row.title='点击展开原始记录';
  row.onclick=(ev)=>{ if(ev.target===pre) return; row.classList.toggle('open'); };
  return row;
}
function maFail(e){
  return !!(e.outcome && e.outcome!=='ok' && e.outcome!=='aborted' && e.outcome!=='stopped');
}
function maMatch(e){
  if(maFilter==='switched' && !maSwitched(e)) return false;
  if(maFilter==='fail' && !maFail(e)) return false;
  if(maFilter==='empty' && e.outcome!=='empty') return false;
  if(maFilter==='agent' && e.kind!=='agent') return false;
  if(maFilter==='chat' && e.kind==='agent') return false;
  if(maQuery){
    const hay=[maName(e.requested), maName(e.actual), e.reason||'', e.wire||'',
      (e.notes||[]).join(' '), e.dir||'', e.outcome||''].join(' ').toLowerCase();
    if(hay.indexOf(maQuery)<0) return false;
  }
  return true;
}
function renderMaMini(){
  const list=$('#maList'); if(!list) return;
  list.innerHTML='';
  if(!maEntries.length){ list.appendChild(maEl('div','ma-empty','还没有记录，发一条消息后自动出现')); return; }
  maEntries.slice(0,3).forEach(e=>{
    const row=maRowMini(e);
    row.title='点击查看完整日志';
    row.onclick=openActPanel;
    list.appendChild(row);
  });
}
function renderMaPanel(){
  const panel=$('#maPanel'), stats=$('#maStats');
  if(stats){
    const ok=maEntries.filter(e=>e.outcome==='ok' && !maSwitched(e)).length;
    const sw=maEntries.filter(maSwitched).length;
    const bad=maEntries.filter(maFail).length;
    const ag=maEntries.filter(e=>e.kind==='agent').length;
    stats.innerHTML='';
    [['条记录',maEntries.length],['正常',ok],['已切换',sw],['失败',bad],['Agent',ag]].forEach(([k,v])=>{
      const s=maEl('span');
      s.appendChild(maEl('b','',v));
      s.appendChild(document.createTextNode(' '+k));
      stats.appendChild(s);
    });
  }
  if(!panel) return;
  const rows=maEntries.filter(maMatch);
  const foot=$('#maFoot');
  if(foot) foot.textContent=(rows.length===maEntries.length ? maEntries.length : rows.length+' / '+maEntries.length)+' 条'
    +(maFile?(' · '+maFile):'')+' · 点任意一条可展开原始记录';
  panel.innerHTML='';
  if(!rows.length){
    panel.appendChild(maEl('div','ma-empty', maEntries.length ? '没有符合筛选条件的记录' : '还没有记录'));
    return;
  }
  rows.forEach(e=>panel.appendChild(maRowFull(e)));
}
async function loadModelActivity(){
  const list=$('#maList'), note=$('#maNote');
  if(list && !maEntries.length) list.innerHTML='<div class="ma-empty">读取中…</div>';
  try{
    const j=await (await fetch('/api/model-activity?limit=600')).json();
    maEntries=(j&&j.entries)||[];
    maFile=(j&&j.file)||'';
    maTotal=(j&&j.total)||maEntries.length;
    if(note) note.textContent = maEntries.length
      ? `${maTotal} 条 · 最新 ${new Date(maEntries[0].at).toLocaleString('zh-CN',{hour12:false}).slice(5)}`
      : '还没有记录，发一条消息后自动出现';
    renderMaMini();
    renderMaPanel();
  }catch(err){
    if(list) list.innerHTML='<div class="ma-empty">读取失败：'+(err&&err.message||err)+'</div>';
  }
}
function openActPanel(){
  $('#modalActLog').classList.add('show');
  renderMaPanel();
  loadModelActivity();
}
async function saveSettings(){
  const picked = $('#sModel') ? $('#sModel').value : MODEL;
  // 底部「保存」必须连 API 接入模板一起提交：把卡片里正在编辑（含尚未保存的草稿）的
  // 名称 / 地址 / 密钥 / 协议接回 providers，否则用户填完 API 点这里会全部丢失。
  const cards = document.querySelectorAll('#sProvList .prov-card');
  cards.forEach(card=>{
    const p = providers.find(x=>x.id===card.dataset.id);
    if(!p) return;
    const nm=card.querySelector('.p-name'), bs=card.querySelector('.p-base'),
          ky=card.querySelector('.p-key'), pr=card.querySelector('.p-proto');
    if(nm) p.name = nm.value.trim();
    if(bs) p.base = bs.value.trim();
    if(ky && ky.value.trim()) p.apiKey = ky.value.trim();  // 留空 = 不修改已保存的密钥
    if(pr) p.protocol = pr.value;
  });
  // 草稿只有填齐「名称 + 地址 + 密钥」才落盘；已保存过的模板一律保留，避免误删。
  const cleanProviders = providers
    .filter(p => p && (!p._draft || (p.name && p.base && p.apiKey)))
    .map(p => ({
      id: p.id, name: p.name, apiKey: p.apiKey, base: p.base,
      protocol: p.protocol, models: p.models||[], enabled: p.enabled!==false,
      builtin: p.builtin === true,
    }));
  const hadDraft = providers.some(p=>p && p._draft);
  let activeId = activeProviderId;
  if(!cleanProviders.some(p=>p.id===activeId)) activeId = cleanProviders.length ? cleanProviders[0].id : '';
  const body = {
    model: picked,
    providers: cleanProviders,
    activeProviderId: activeId,
    thinkingDepth: $('#sDepth').value,
    contextLimit: Number($('#sLimit').value)||350000,
    compactAt: Number($('#sCompact').value)||100000,
    injectMemory: $('#sInject').checked,
    autoFailover: $('#sFailover').value !== 'off',
    failoverChain: (failoverChain && failoverChain.length) ? failoverChain : [],
    agentRoots: $('#sAgentRoots').value.split('\n').map(x=>x.trim()).filter(Boolean),
    agentSafeMode: $('#sAgentSafe').checked,
    asrLang: $('#sAsrLang').value,
    asrAudioCtx: Number($('#sAsrAudioCtx') ? $('#sAsrAudioCtx').value : 768),
    asrModelHost: $('#sAsrHost') ? $('#sAsrHost').value.trim() : '',
    voice: { tts: $('#sVoiceTts') ? $('#sVoiceTts').value.trim() : '', bot: $('#sVoiceBot') ? $('#sVoiceBot').value.trim() : '' },
    dirs:{ chatArchive:$('#sDirChat').value.trim(), memory:$('#sDirMem').value.trim(), testFiles:$('#sDirTest').value.trim() }
  };
  try{
    const r = await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j = await r.json();
    if(j.ok){
      if(picked && picked!==MODEL){ MODEL=picked; MODEL_LABEL=labelOf(picked); }
      store.set('whale.model', MODEL || picked);
      depth = body.thinkingDepth;
      store.set('whale.depth', depth);   // 与滑块共用同一份本地状态，重启后不会回退
      setModelPill();
      try{ if(window.ReasoningSlider) ReasoningSlider.refresh(); }catch(e){}
      ctxLimit = body.effectiveContextLimit || body.contextLimit;
      compactAt = body.compactAt;
      updateStats();
      activeProviderId = activeId;
      // 重拉设置并重绘卡片：草稿立刻变成已保存模板，模型下拉框同步刷新。
      await reloadAfterProviderChange();
      toast(hadDraft ? ('已保存 '+cleanProviders.length+' 个 API 接入模板，可继续编辑或关闭') : '已保存');
      // 保存成功后面板保持打开，让用户直接看到已保存的模板卡片；需要关闭可点「取消」或右上角 ×。
      return;
    }
    else toast('保存失败：'+(j.error||'未知错误'));
  }  catch(e){ toast('保存失败：'+(e.message||e)); }
  $('#modalSettings').classList.remove('show');
}

/* ---------- 记忆库 ---------- */
async function loadMemory(q){
  try{
    const r = await fetch('/api/memory/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:q||''})});
    const j = await r.json();
    const box=$('#memList'); box.innerHTML='';
    if(j.ok && j.results && j.results.length){
      j.results.forEach(it=>{
        const d=document.createElement('div'); d.className='mem';
        d.innerHTML='<div class="n">'+it.name+'</div><div class="e">'+(it.excerpt||'')+'</div>';
        d.onclick=()=>{ $('#input').value += '\n> 引用记忆：'+it.name+'\n'+(it.excerpt||'').slice(0,300)+'\n'; $('#drawer').classList.remove('show'); $('#input').focus(); };
        box.appendChild(d);
      });
    } else {
      box.innerHTML='<div style="font-size:12.5px;color:var(--text-3);padding:8px 2px">暂无记忆条目</div>';
    }
  }catch(e){ $('#memList').innerHTML='<div style="font-size:12.5px;color:var(--danger)">搜索失败</div>'; }
}
async function fetchMemoryPrefix(){
  try{
    const r = await fetch('/api/memory/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:''})});
    const j = await r.json();
    if(!j.ok||!j.results||!j.results.length){ memoryPrefix=''; return; }
    let s='【记忆库摘要（最近 5 条）】\n';
    j.results.slice(0,5).forEach((it,i)=>{ s += (i+1)+'. '+it.name+'\n   '+(it.excerpt||'').slice(0,120)+'\n'; });
    memoryPrefix = s;
  }catch(e){ memoryPrefix=''; }
}

/* ---------- 附件：粘贴 / 拖拽 / 选择 ---------- */
let attachments = [];
let attSeq = 0;

function readAs(f, asText){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result); r.onerror=rej;
    asText ? r.readAsText(f) : r.readAsDataURL(f);
  });
}
function isImageFile(f){
  const ext=(f.name.split('.').pop()||'').toLowerCase();
  return /^image\//.test(f.type||'') || ['png','jpg','jpeg','gif','webp','bmp'].includes(ext);
}
// 可转写媒体：音频 + 视频容器（视频只取音轨，用于「读视频里的说话内容」）
// 注意：能不能转，取决于 Chromium 能不能解码该容器的音轨 —— 实测只支持 mp4/mov/m4v/webm/ogv。
// mkv/avi/wmv/flv 等需要额外转码组件（ffmpeg），因此不列入可转写范围，避免"看似支持实则报错"。
const AUDIO_EXT = ['mp3','wav','m4a','ogg','flac','aac','aiff','wma','opus'];
const VIDEO_EXT = ['mp4','m4v','mov','webm','ogv'];
const VIDEO_UNSUPPORTED = ['mkv','avi','wmv','flv','mpg','mpeg','ts','3gp','rmvb','rm'];
function mediaKindOf(f){
  const ext=((f && f.name || '').split('.').pop()||'').toLowerCase();
  const t=((f && f.type) || '').toLowerCase();
  if(VIDEO_UNSUPPORTED.includes(ext)) return 'video-unsupported';
  if(/^video\//.test(t)) return 'video';
  if(/^audio\//.test(t)) return 'audio';
  if(VIDEO_EXT.includes(ext)) return 'video';
  if(AUDIO_EXT.includes(ext)) return 'audio';
  return '';
}
function isAudioFile(f){ return mediaKindOf(f)==='audio'; }
async function addFiles(fileList){
  const files = Array.from(fileList||[]);
  for(const f of files){
    const mk = mediaKindOf(f);
    if(mk === 'video-unsupported'){
      toast(f.name+' 的容器（'+((f.name.split('.').pop()||'').toLowerCase())+'）本机解不了音轨，请先转成 mp4/webm，或直接截图发送');
      continue;
    }
    const capMB = mk==='video' ? 500 : 50;
    if(f.size && f.size > capMB*1024*1024){
      toast(f.name+' 超过 '+capMB+'MB，已跳过'+(mk==='video'?'（长视频建议先裁剪）':'（长音频建议先裁剪）'));
      continue;
    }
    const img = isImageFile(f);
    try{
      if(img){
        const d = await readAs(f,false);
        attachments.push({ id:'a'+(++attSeq), name:f.name||'粘贴的图片', kind:'image', dataUrl:d });
      } else if(mk){
        attachments.push({ id:'a'+(++attSeq), name:f.name||(mk==='video'?'视频':'音频'), kind:'media', media:mk, file:f });
      } else {
        const t = await readAs(f,true);
        const ext=(f.name.split('.').pop()||'txt').toLowerCase();
        attachments.push({ id:'a'+(++attSeq), name:f.name||'文件', kind:'file', text:t, ext });
      }
    }catch(e){ toast('读取失败：'+f.name); }
  }
  renderAttach();
}
function renderAttach(){
  const box = $('#attachStrip'); box.innerHTML='';
  attachments.forEach(a=>{
    const d=document.createElement('div'); d.className='att';
    if(a.kind==='image'){
      const im=document.createElement('img'); im.src=a.dataUrl; d.appendChild(im);
    } else if(a.kind==='media'){
      const isVid = a.media==='video';
      const ic=document.createElement('span'); ic.innerHTML = isVid ? ICON.file : ICON.mic; ic.style.color='var(--text-3)'; if(ic.firstChild) d.appendChild(ic.firstChild);
      const tb=document.createElement('button'); tb.className='rm'; tb.style.color='var(--accent)'; tb.style.fontSize='11px';
      tb.textContent = isVid ? '🎬 转写' : '🎤 转写';
      tb.title = isVid ? '提取视频音轨并转写为文字（画面内容需另行截图）' : '将音频转写为文字并插入';
      tb.onclick=()=>transcribeAttachment(a, tb);
      d.appendChild(tb);
    } else {
      const ic=document.createElement('span'); ic.innerHTML=ICON.file; ic.style.color='var(--text-3)'; if(ic.firstChild) d.appendChild(ic.firstChild);
    }
    const nm=document.createElement('span'); nm.className='nm'; nm.textContent=a.name; d.appendChild(nm);
    const rm=document.createElement('button'); rm.className='rm'; rm.textContent='✕'; rm.title='移除';
    rm.onclick=()=>{ attachments = attachments.filter(x=>x.id!==a.id); renderAttach(); };
    d.appendChild(rm);
    box.appendChild(d);
  });
  autoGrow();
}
function buildOutgoing(text){
  const imgs = attachments.filter(a=>a.kind==='image').map(a=>a.dataUrl);
  const fileParts = attachments.filter(a=>a.kind==='file')
    .map(a=>'```'+(a.ext||'')+'\n// '+a.name+'\n'+a.text+'\n```').join('\n\n');
  const content = [text, fileParts].filter(Boolean).join('\n\n');
  return { content, images: imgs };
}

/* 粘贴文件 / 截图 */
document.addEventListener('paste', async (e)=>{
  const items = (e.clipboardData && e.clipboardData.items) || [];
  const files = [];
  for(const it of items){
    if(it.kind==='file'){ const f=it.getAsFile(); if(f) files.push(f); }
  }
  if(files.length){
    e.preventDefault();
    const named = files.map((f,i)=> f.name && f.name!=='image.png' ? f : new File([f], '截图-'+(attachments.length+i+1)+'.png', {type:f.type}));
    await addFiles(named);
    toast('已添加 '+files.length+' 个附件');
  }
});

/* 拖拽文件进窗口 */
let dragDepth = 0;
window.addEventListener('dragenter', (e)=>{
  if(!e.dataTransfer) return;
  const hasFile = Array.from(e.dataTransfer.types||[]).includes('Files');
  if(!hasFile) return;
  e.preventDefault(); dragDepth++; $('#dropHint').classList.add('show');
});
window.addEventListener('dragover', (e)=>{
  if(e.dataTransfer && Array.from(e.dataTransfer.types||[]).includes('Files')){
    e.preventDefault(); e.dataTransfer.dropEffect='copy';
  }
});
window.addEventListener('dragleave', (e)=>{
  dragDepth = Math.max(0, dragDepth-1);
  if(dragDepth===0) $('#dropHint').classList.remove('show');
});
window.addEventListener('drop', async (e)=>{
  if(!e.dataTransfer) return;
  const files = e.dataTransfer.files;
  if(files && files.length){
    e.preventDefault();
    dragDepth=0; $('#dropHint').classList.remove('show');
    await addFiles(files);
    toast('已添加 '+files.length+' 个附件');
  }
});

/* ---------- 输入框 ---------- */
function autoGrow(){
  const el=$('#input');
  el.style.height='auto';
  el.style.height = Math.min(180, el.scrollHeight)+'px';
  $('#btnSend').disabled = busy ? false : !el.value.trim();
}
$('#input').addEventListener('input', ()=>{
  autoGrow();
  // 只有「整行就是 / 加可选字母」时才弹指令面板；正文里打 / 不打扰
  const q=slashQuery();
  if(q!==null){ if(!$('#menuSlash').classList.contains('show')) slashSel=0; slashMenu(); }
  else hideSlash();
});
$('#input').addEventListener('keydown', e=>{
  const open = $('#menuSlash').classList.contains('show');
  if(open){
    const items=[...$('#menuSlash').querySelectorAll('.ck-item')];
    if(e.key==='ArrowDown' || e.key==='ArrowUp'){
      e.preventDefault();
      if(items.length){
        slashSel = (slashSel + (e.key==='ArrowDown'?1:-1) + items.length) % items.length;
        markSlashSel();
      }
      return;
    }
    if(e.key==='Escape'){ e.preventDefault(); hideSlash(); return; }
    if((e.key==='Enter' || e.key==='Tab') && items.length){
      e.preventDefault();
      runSlash(items[Math.max(0,Math.min(slashSel,items.length-1))].dataset.cmd);
      return;
    }
  }
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); if(!busy) send(); }
  if(e.key==='Escape'){ if(busy) stopRun(); else closeMenus(); }
});

function stopRun(silent){
  if(abort){ try{ abort.abort(); }catch(e){} }
  // 只取消本次 run；没有 runId 时（旧路径/极早期失败）才退回全局停止
  if(currentRunId){
    fetch('/api/runs/'+encodeURIComponent(currentRunId)+'/cancel',{method:'POST'}).catch(()=>{});
  }
  // 没有 runId（极早期失败）只断开本地请求：绝不再调用全局 /api/stop，
  // 否则会误停主任务 / 侧聊等其他 run。
  busy=false; abort=null;
  $('#btnSend').classList.remove('stop'); $('#btnSend').innerHTML=ICON.send;
  if(!silent) toast('已停止');
}

/* ---------- 事件绑定 ---------- */
$('#btnSend').onclick = ()=>{ busy ? stopRun() : send(); };
$('#btnNew').onclick = ()=> newChat();
$('#search').oninput = ()=>{
  const q = ($('#search').value||'').trim();
  clearTimeout(searchTimer);
  if (!q){ searchHits = []; searchTimer = null; renderList(); return; }
  // 先按标题即时过滤，200ms 后再补全文命中，避免每敲一个字就扫一遍磁盘
  renderList();
  const mySeq = ++searchSeq;
  searchTimer = setTimeout(async ()=>{
    try{
      const j = await (await fetch('/api/chats/search?q='+encodeURIComponent(q))).json();
      if (mySeq !== searchSeq) return;      // 输入已变，丢弃过期结果
      searchHits = Array.isArray(j) ? j : [];
    }catch(e){ searchHits = []; }
    searchTimer = null;
    renderList();
  }, 200);
};
$('#btnAttach').onclick = ()=> $('#fileInput').click();
$('#btnMic').onclick = ()=>{ if(mic.active) stopMic(); else if(!mic.busy) startMic(false); };
$('#btnMicStop').onclick = ()=> hardStopMic();
document.addEventListener('keydown', (e)=>{
  if(e.isComposing) return;
  // Ctrl+D 切换录音；长按 Alt 说话（松开即识别）
  if(e.ctrlKey && !e.shiftKey && !e.altKey && (e.key==='d'||e.key==='D')){
    e.preventDefault(); if(mic.active) stopMic(); else if(!mic.busy) startMic(false); return;
  }
  // 长按 Alt 只在输入框聚焦（光标闪烁）时触发，避免在别处误触
  const inputFocused = document.activeElement && document.activeElement.id==='input';
  if(e.key==='Alt' && !e.repeat && !mic.active && !mic.busy && !e.ctrlKey && !e.metaKey && inputFocused){
    e.preventDefault(); startMic(true); return;
  }
  if(e.key==='Escape' && mic.active){
    e.preventDefault(); micCleanup(); micChip('');
  }
});
document.addEventListener('keyup', (e)=>{ if(e.key==='Alt' && mic.active && mic.byAlt) stopMic(); });
window.addEventListener('blur', ()=>{ if(mic.active) stopMic(); });
$('#fileInput').onchange = async ()=>{ await addFiles($('#fileInput').files); $('#fileInput').value=''; };
// 同一个按钮点第二次要收起菜单（否则只能点空白处才能关）
function bindMenuToggle(btnSel, panelSel, openFn){
  const btn = $(btnSel), panel = $(panelSel);
  if(!btn) return;
  btn.setAttribute('aria-expanded','false');
  btn.setAttribute('aria-haspopup','true');
  btn.onclick = (e)=>{
    e.stopPropagation();
    const open = panel && panel.classList.contains('show');
    closeMenus();
    if(!open) openFn(btn);
  };
}
// 输入框模型胶囊 → 推理强度卡片（原生复刻 dsh-codex-excellent-slider）
// 原「切换模型」浮层（openModelMenu）保留为不可达回退，避免其它调用点报错。
(function bindReasoningSlider(){
  const btn = $('#btnModel');
  if(!btn || !window.ReasoningSlider) return;
  ReasoningSlider.init({
    tiers: DEPTHS.map(d=>({v:d.v, title:d.t, desc:d.d})),
    defaultDepth: 'high',
    getDepth: ()=>depth,
    setDepth: (v)=>{
      depth = v;
      store.set('whale.depth', v);
      const sd = $('#sDepth'); if(sd) sd.value = v;
      setModelPill();
      fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({thinkingDepth:v})}).catch(()=>{});
    },
    onDepthChange: (v)=>{
      const d = DEPTHS.find(x=>x.v===v);
      toast('推理强度：'+(d?d.t:v));
    },
    getModel: ()=>({ id: MODEL, label: MODEL_LABEL }),
    getGroups: ()=> modelGroups().map(g=>({ name: g.name, ids: g.ids.slice() })),
    labelOf: (m)=> labelOf(m),
    descOf: (m)=>{
      const meta = modelCatalog[m] || {};
      const t = modelTags(m);
      return [t.label, meta.desc || '', '上下文 '+t.ctx, t.hTxt].filter(Boolean).join(' · ');
    },
    selectModel: (m)=> Promise.resolve(selectModel(m)).then(()=>{ setModelPill(); }),
    getBoost: ()=> boostPending,
    setBoost: (v)=>{ boostPending = !!v; },
    onBoostToggle: (on)=> toast(on ? '下一条消息将附加「优先深入分析」偏好' : '已取消偏好附加'),
    onOpenChange: (o)=>{
      btn.setAttribute('aria-expanded', o ? 'true' : 'false');
      btn.classList.toggle('is-open', !!o);
      // 原版行为：卡片打开时入口切成「选择推理强度」，避免同一组信息上下各显示一遍
      const nm = btn.querySelector('.mp-name'), ef = btn.querySelector('.mp-eff');
      if(o){
        if(nm) nm.textContent = '选择推理强度';
        if(ef) ef.textContent = '';
      } else {
        setModelPill();
      }
      if(o) openMenuId = 'menuModel'; else if(openMenuId==='menuModel') openMenuId='';
    }
  });
  btn.onclick = (e)=>{
    e.stopPropagation();
    closeMenus();
    ReasoningSlider.toggle(btn);
  };
})();
bindMenuToggle('#btnPerm', '#menuPerm', (b)=> openPermMenu(b));
$('#aSandbox').onchange = syncPermLabel;
$('#navAgent').onclick = ()=>{ $('#aDir').value = store.get('whale.dir',''); $('#modalAgent').classList.add('show'); };
$('#navMemory').onclick = ()=>{ $('#drawer').classList.add('show'); loadMemory(''); };
$('#navSettings').onclick = openSettings;
$('#hbSettings').onclick = openSettings;
$('#drawerClose').onclick = ()=> $('#drawer').classList.remove('show');
$('#memSearch').onclick = ()=> loadMemory($('#memQ').value.trim());
$('#memQ').addEventListener('keydown', e=>{ if(e.key==='Enter') loadMemory($('#memQ').value.trim()); });

$('#sCancel').onclick = ()=> $('#modalSettings').classList.remove('show');
$('#sClose').onclick = ()=> $('#modalSettings').classList.remove('show');
$('#modalSettings').addEventListener('click', (e)=>{ if(e.target.id==='modalSettings') $('#modalSettings').classList.remove('show'); });
$('#modalAgent').addEventListener('click', (e)=>{ if(e.target.id==='modalAgent') $('#modalAgent').classList.remove('show'); });
$('#modalActLog').addEventListener('click', (e)=>{ if(e.target.id==='modalActLog') $('#modalActLog').classList.remove('show'); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ $('#modalSettings').classList.remove('show'); $('#modalAgent').classList.remove('show'); $('#modalSandbox').classList.remove('show'); $('#modalActLog').classList.remove('show'); closeMenus(); } });
$('#sSave').onclick = saveSettings;
if($('#btnReProbe')) $('#btnReProbe').onclick = async ()=>{
  const hint = $('#agentCapsHint');
  if(hint) hint.textContent = '正在重置…';
  try{
    const r = await fetch('/api/agent/capabilities',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});
    const j = await r.json();
    const s = lastAgentCapsSettings || {};
    s.agentCapabilities = j.capabilities || {};
    renderAgentCaps(s);
    if(hint) hint.textContent = '已重置，下次使用自动重新学习';
  }catch(e){ if(hint) hint.textContent = '重置失败：' + (e.message||e); }
};
/* ---------- 一键自检 ---------- */
let lastSelfcheck = null;

function selfcheckRow(c){
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;padding:7px 10px;border-top:1px solid var(--line);align-items:flex-start';
  const mark = document.createElement('span');
  mark.style.cssText = 'flex:none;width:14px;text-align:center;font-weight:700;line-height:18px';
  mark.textContent = c.ok ? '✓' : (c.level === 'warn' ? '!' : '✕');
  mark.style.color = c.ok ? '#16a34a' : (c.level === 'warn' ? '#d97706' : '#dc2626');
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';
  const nm = document.createElement('div');
  nm.style.cssText = 'font-weight:600;color:var(--text);line-height:18px';
  nm.textContent = c.name;
  const dt = document.createElement('div');
  dt.style.cssText = 'color:var(--text-3);line-height:1.55;word-break:break-all';
  dt.textContent = c.detail || '—';
  body.appendChild(nm); body.appendChild(dt);
  row.appendChild(mark); row.appendChild(body);
  return row;
}

function renderSelfcheck(rep){
  const box = $('#selfcheckBox'); if(!box) return;
  box.innerHTML = '';
  if(!rep || !rep.checks){ box.style.display='none'; return; }
  box.style.display = 'block';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px 10px;background:var(--bg-2,#f7f8fa)';
  const st = document.createElement('span');
  st.style.cssText = 'font-weight:700;color:' + (rep.ok ? '#16a34a' : '#dc2626');
  st.textContent = rep.ok ? '全部通过' : ('未通过 ' + rep.summary.fail + ' 项');
  const meta = document.createElement('span');
  meta.style.cssText = 'color:var(--text-3);font-size:11.5px';
  meta.textContent = rep.summary.pass + '/' + rep.summary.total + ' 通过' +
    (rep.summary.warn ? ' · ' + rep.summary.warn + ' 项提示' : '') +
    ' · ' + rep.ms + 'ms · v' + (rep.version || '?');
  head.appendChild(st); head.appendChild(meta);
  box.appendChild(head);
  rep.checks.forEach(c => box.appendChild(selfcheckRow(c)));
  const fixBtn = $('#btnSelfcheckFix');
  if(fixBtn){
    const can = rep.summary.fixable.length > 0;
    fixBtn.disabled = !can;
    fixBtn.textContent = can ? ('修复可修项（' + rep.summary.fixable.length + '）') : '无可修项';
  }
  const copyBtn = $('#btnSelfcheckCopy'); if(copyBtn) copyBtn.disabled = false;
  // 面板在设置弹窗里偏下，跑完自动滚到可见位置，否则用户以为没反应
  try{ box.scrollIntoView({ block:'nearest', behavior:'smooth' }); }catch(e){}
}

async function runSelfcheckUI(){
  const hint = $('#selfcheckHint');
  const btn = $('#btnSelfcheck');
  if(btn) btn.disabled = true;
  if(hint) hint.textContent = '正在自检…（含端点连通，约 1–2 秒）';
  try{
    const r = await fetch('/api/selfcheck', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const j = await r.json();
    if(!j || j.error) throw new Error((j && j.error) || ('HTTP ' + r.status));
    lastSelfcheck = j;
    renderSelfcheck(j);
    if(hint) hint.textContent = j.ok ? '全部通过' : '有未通过项，可尝试修复或查看详情';
    toast(j.ok ? '自检全部通过' : ('自检未通过 ' + j.summary.fail + ' 项'));
  }catch(e){
    if(hint) hint.textContent = '自检失败：' + (e.message || e);
    toast('自检失败：' + (e.message || e));
  }finally{ if(btn) btn.disabled = false; }
}

async function fixSelfcheckUI(){
  const hint = $('#selfcheckHint');
  const ids = (lastSelfcheck && lastSelfcheck.summary && lastSelfcheck.summary.fixable) || [];
  if(!ids.length){ if(hint) hint.textContent = '没有可自动修复的项'; return; }
  if(hint) hint.textContent = '正在修复…';
  try{
    const r = await fetch('/api/selfcheck', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ fix: true, ids }) });
    const j = await r.json();
    const fixed = (j.fixed || []).length, skipped = (j.skipped || []).length, failed = (j.failed || []).length;
    if(hint) hint.textContent = '已修复 ' + fixed + ' 项' + (skipped ? '，跳过 ' + skipped : '') + (failed ? '，失败 ' + failed : '');
    toast('修复完成：' + fixed + ' 项');
    await runSelfcheckUI();
  }catch(e){
    if(hint) hint.textContent = '修复失败：' + (e.message || e);
  }
}

function copySelfcheckUI(){
  if(!lastSelfcheck) return;
  const lines = ['WhaleCodex 自检报告 ' + lastSelfcheck.at + ' · v' + (lastSelfcheck.version||'') + ' · ' + lastSelfcheck.platform,
    '结论：' + (lastSelfcheck.ok ? '全部通过' : '未通过 ' + lastSelfcheck.summary.fail + ' 项'),
    ''];
  lastSelfcheck.checks.forEach(c => {
    lines.push((c.ok ? '[OK] ' : (c.level === 'warn' ? '[提示] ' : '[失败] ')) + c.name + '：' + c.detail);
  });
  const text = lines.join('\n');
  const done = ()=>toast('报告已复制');
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, cb){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); cb(); }catch(e){ toast('复制失败'); }
  ta.remove();
}

if($('#btnSelfcheck')) $('#btnSelfcheck').onclick = runSelfcheckUI;
if($('#btnSelfcheckFix')) $('#btnSelfcheckFix').onclick = fixSelfcheckUI;
if($('#btnSelfcheckCopy')) $('#btnSelfcheckCopy').onclick = copySelfcheckUI;

$('#sHealth').onclick = checkModelHealth;
if($('#btnAsrRefresh')) $('#btnAsrRefresh').onclick = ()=>refreshAsrModels(true);
if($('#sAsrModelList')) $('#sAsrModelList').onclick = (e)=>{
  const b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if(b) asrModelAction(b.dataset.act, b.dataset.key);
};
$('#sProvAdd').onclick = addProvider;
$('#sFailoverPreset').onclick = (e)=>{ openFailoverPreset($('#sFailoverPreset')); };
$('#maOpen').onclick = openActPanel;
$('#maClose').onclick = ()=> $('#modalActLog').classList.remove('show');
$('#maDone').onclick = ()=> $('#modalActLog').classList.remove('show');
$('#maSearch').oninput = (e)=>{ maQuery=String(e.target.value||'').trim().toLowerCase(); renderMaPanel(); };
document.querySelectorAll('#maFilters .fchip').forEach(chip=>{
  chip.onclick = ()=>{
    document.querySelectorAll('#maFilters .fchip').forEach(c=>c.classList.remove('on'));
    chip.classList.add('on');
    maFilter = chip.getAttribute('data-f')||'all';
    renderMaPanel();
  };
});
if($('#maRefresh')) $('#maRefresh').onclick = loadModelActivity;
if($('#maReveal')) $('#maReveal').onclick = async ()=>{
  try{
    const j = await (await fetch('/api/model-activity/reveal',{method:'POST'})).json();
    toast('日志文件：'+(j.file||'model-activity.jsonl'));
  }catch(e){ toast('打开失败'); }
};
if($('#maClear')) $('#maClear').onclick = async ()=>{
  if(!confirm('清空模型活动日志？JSONL 文件会被截断，操作不可恢复。')) return;
  try{
    await fetch('/api/model-activity/clear',{method:'POST'});
    await loadModelActivity();
    toast('已清空模型活动日志');
  }catch(e){ toast('清空失败'); }
};
// 弹出系统文件夹选择框（Electron dialog），返回选中路径；取消返回 null
async function pickFolder(current){
  try{
    const r = await fetch('/api/choose-dir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current:current||''})});
    const j = await r.json();
    if(!j.ok){ if(j.error) toast('选择失败：'+j.error); return null; }
    return j.path || '';
  }catch(e){ toast('选择失败'); return null; }
}
// 调用后端把 from 内容迁移到 to（移动；同名不覆盖）
async function migrateDir(from, to){
  try{
    const r = await fetch('/api/migrate-dir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from, to})});
    return await r.json();
  }catch(e){ return {ok:false, error:String(e.message||e)}; }
}
// 仅持久化目录 / 白名单设置（不关闭设置弹窗）
async function persistDirs(){
  try{
    await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      dirs:{ chatArchive:$('#sDirChat').value.trim(), memory:$('#sDirMem').value.trim(), testFiles:$('#sDirTest').value.trim() },
      agentRoots: $('#sAgentRoots').value.split('\n').map(x=>x.trim()).filter(Boolean),
    })});
  }catch(e){}
}
// 为某个目录输入框选择新文件夹：若与旧值不同，询问是否迁移旧数据，再写入并持久化
async function chooseDirFor(inputSel, label){
  const oldPath = $(inputSel).value.trim();
  const picked = await pickFolder(oldPath);
  if(picked === null || picked === oldPath) return;
  if(oldPath){
    const ok = await confirm('是否将「'+label+'」从\n'+oldPath+'\n迁移（移动）到新目录\n'+picked+' ？\n（同名文件会保留在旧位置，不覆盖）');
    if(ok){
      const r = await migrateDir(oldPath, picked);
      if(r && r.ok){
        let msg = '已迁移 '+r.moved+' 项';
        if(r.skipped) msg += '，跳过 '+r.skipped+' 个同名项';
        if(r.errors && r.errors.length) msg += '；'+r.errors.length+' 项失败';
        toast(msg);
      } else {
        toast('迁移未执行：'+(r && r.error || '未知原因'));
      }
    }
  }
  $(inputSel).value = picked;
  await persistDirs();
}
async function chooseAgentDir(){
  const oldPath = $('#aDir').value.trim() || '';
  const picked = await pickFolder(oldPath);
  if(picked === null || picked === oldPath) return;
  if(oldPath){
    const ok = await confirm('是否将 Agent 工作目录从\n'+oldPath+'\n迁移到\n'+picked+' ？');
    if(ok){ const r = await migrateDir(oldPath, picked); toast(r&&r.ok?('已迁移 '+r.moved+' 项'):('迁移未执行：'+(r&&r.error||''))); }
  }
  $('#aDir').value = picked;
  store.set('whale.dir', picked);
}
document.querySelectorAll('[data-open]').forEach(b=>{
  b.onclick = async ()=>{
    const which=b.getAttribute('data-open');
    if(which==='agentDir'){ await chooseAgentDir(); return; }
    const inputSel = which==='chatArchive'?'#sDirChat':which==='memory'?'#sDirMem':'#sDirTest';
    const label = which==='chatArchive'?'聊天记录目录':which==='memory'?'记忆库目录':'测试文件目录';
    await chooseDirFor(inputSel, label);
  };
});
// 工作目录白名单：点 📂 自主选择目录并加入白名单；可选把原主目录的工作数据迁移过去
if($('#sAgentRootsPick')) $('#sAgentRootsPick').onclick = async ()=>{
  const ta = $('#sAgentRoots');
  const cur = (ta.value.split('\n').map(x=>x.trim()).filter(Boolean)[0]) || '';
  const picked = await pickFolder(cur);
  if(picked === null) return;
  const lines = ta.value.split('\n').map(x=>x.trim()).filter(Boolean);
  if(lines.includes(picked)){ toast('该目录已在白名单中'); return; }
  if(cur && cur !== picked){
    const ok = await confirm('是否将白名单原主目录\n'+cur+'\n下的工作数据迁移到\n'+picked+' ？');
    if(ok){ const r = await migrateDir(cur, picked); toast(r&&r.ok?('已迁移 '+r.moved+' 项'):('迁移未执行：'+(r&&r.error||''))); }
  }
  lines.push(picked);
  ta.value = lines.join('\n');
  await persistDirs();
};

$('#aCancel').onclick = ()=> $('#modalAgent').classList.remove('show');
$('#aClose').onclick = ()=> $('#modalAgent').classList.remove('show');
$('#aSave').onclick = ()=>{
  const dir=$('#aDir').value.trim()||'';
  store.set('whale.dir', dir);
  $('#modalAgent').classList.remove('show');
  setMode('agent');
  $('#prefixTag') && $('#prefixTag').remove();
  toast('已进入 Agent 模式，工作目录：'+dir);
};

$('#hbArchive').onclick = async ()=>{
  if(!history.length){ toast('没有可归档的内容'); return; }
  try{
    const r = await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:(cur()||{}).title||'会话',reason:'手动归档',content:historyToMd()})});
    const j = await r.json();
    toast(j.ok?'已归档':'归档失败');
  }catch(e){ toast('归档失败'); }
};
$('#hbExport').onclick = async ()=>{
  if(!history.length){ toast('没有可导出的内容'); return; }
  try{
    const r = await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:(cur()||{}).title||'会话',reason:'导出',content:historyToMd()})});
    const j = await r.json();
    toast(j.ok?('已导出：'+j.path):'导出失败');
  }catch(e){ toast('导出失败'); }
};
function chatToMd(c){
  const msgs = (c && c.id===activeId) ? history : ((c && Array.isArray(c.messages)) ? c.messages : []);
  if(!msgs.length) return '';
  const title = (c && c.title) || '会话';
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  let md = '# '+title+'  '+ts+'\n\n';
  msgs.forEach(m=>{ md += (m.role==='user'?'## 我\n\n':'## 鲸鱼娘\n\n')+(m.content||'')+'\n\n'; });
  return md;
}
function historyToMd(){ return chatToMd(cur()); }

/* ---------- 沙箱可视化 ---------- */
var sandboxStatus = null;
function sbxEl(tag, cls, text){
  const e=document.createElement(tag);
  if(cls) e.className=cls;
  if(text!==undefined) e.textContent=String(text);
  return e;
}
function fmtTime(t){
  const d = typeof t==='number' ? new Date(t) : new Date(t||Date.now());
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN',{hour12:false}).slice(5);
}
function renderSandboxChip(){
  const el=$('#stSandbox'); if(!el) return;
  const v=$('#aSandbox').value, st=sandboxStatus||{};
  const isolated = Array.isArray(st.homes) && st.homes.length>0 && st.homes.every(h=>h.secretIsolation);
  const map={
    'read-only':{t:'只读',c:'lv-safe'},
    'workspace-write':{t:'工作区可写',c:'lv-safe'},
    'danger-full-access':{t:'完全权限',c:'lv-danger'}
  };
  const m=map[v]||{t:v,c:'lv-warn'};
  el.textContent=m.t+' · '+(isolated?'密钥已隔离':'密钥未隔离')+(st.safeMode?' · 安全模式':'');
  el.className='s sbx '+(isolated?m.c:'lv-danger');
  el.title='点击打开沙箱状态与审计';
}
function sbxCard(k,v,tone){
  const d=sbxEl('div','sbx-card');
  d.appendChild(sbxEl('div','k',k));
  d.appendChild(sbxEl('div','v '+(tone||''),v));
  return d;
}
function renderSbxCards(st){
  const box=$('#sbxCards'); box.innerHTML='';
  const homes=st.homes||[];
  const isolated=homes.length>0 && homes.every(h=>h.secretIsolation);
  const net=homes.some(h=>h.networkAccess);
  const appr=homes.map(h=>h.approval).join(' / ');
  const v=$('#aSandbox').value;
  box.appendChild(sbxCard('当前权限', PERM_LABELS[v]||'—', v==='danger-full-access'?'bad':'ok'));
  box.appendChild(sbxCard('密钥隔离', isolated?'已隔离 HIDDEN':'未隔离', isolated?'ok':'bad'));
  box.appendChild(sbxCard('网络 / 审批', (net?'联网':'禁网')+' · '+appr, st.safeMode?'ok':'warn'));
  box.appendChild(sbxCard('审计 / 快照', (st.auditCount||0)+' 条 / '+(st.snapshotCount||0)+' 份','ok'));
}
function renderSbxAudit(items){
  const box=$('#sbxAudit'); box.innerHTML='';
  if(!items.length){ box.appendChild(sbxEl('div','note','暂无审计记录')); return; }
  items.forEach(it=>{
    const row=sbxEl('div','sbx-row'), left=sbxEl('div');
    const bad = it.risky || it.kind==='denied';
    left.appendChild(sbxEl('span','sbx-tag'+(bad?' risk':it.kind==='start'?' ok':''), it.kind||'—'));
    const desc = it.kind==='command' ? (it.cmd||'').slice(0,70)
      : it.kind==='start' ? (it.task||'').slice(0,60)
      : it.kind==='denied' ? (it.reason||'')
      : it.kind==='end' ? '退出码 '+it.code : (it.note||it.reason||it.kind||'');
    left.appendChild(document.createTextNode(' '+desc));
    left.appendChild(sbxEl('div','sub',(it.dir||'')+(it.sandbox?' · '+it.sandbox:'')+(it.risky?' · 高危':'')));
    row.appendChild(left); row.appendChild(sbxEl('span','sub',fmtTime(it.at)));
    box.appendChild(row);
  });
}
function renderSbxSnaps(items){
  const box=$('#sbxSnaps'); box.innerHTML='';
  if(!items.length){ box.appendChild(sbxEl('div','note','暂无快照')); return; }
  items.forEach(s=>{
    const row=sbxEl('div','sbx-row'), left=sbxEl('div');
    left.appendChild(sbxEl('div','',s.files+' 个文件 · '+(s.dir||'')));
    left.appendChild(sbxEl('div','sub',fmtTime(s.at)+' · '+s.runId+(s.skipped?' · 跳过 '+s.skipped:'')));
    row.appendChild(left);
    const b=sbxEl('button','','还原');
    b.style.cssText='border:1px solid var(--line-strong);background:#fff;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:11.5px;color:var(--text-2)';
    b.onclick=async()=>{
      if(!confirm('把该目录文件恢复到这份快照？任务中新增的文件不会被删除。')) return;
      try{
        const j=await fetch('/api/agent/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:s.runId,dir:s.dir})}).then(r=>r.json());
        toast(j.ok?('已还原 '+j.restored+' 个文件'):('还原失败：'+(j.error||'')));
      }catch(e){ toast('还原失败'); }
    };
    row.appendChild(b); box.appendChild(row);
  });
}
async function refreshSbx(){
  try{
    const [st,au,sn]=await Promise.all([
      fetch('/api/sandbox/status').then(r=>r.json()),
      fetch('/api/sandbox/audit?limit=25').then(r=>r.json()),
      fetch('/api/sandbox/snapshots').then(r=>r.json())
    ]);
    sandboxStatus=st;
    renderSbxCards(st);
    $('#sbxSafe').checked=!!st.safeMode;
    renderSbxAudit(au.items||[]);
    renderSbxSnaps(sn.items||[]);
    renderSandboxChip();
  }catch(e){ toast('读取沙箱状态失败'); }
}
async function openSandboxPanel(){
  $('#modalSandbox').classList.add('show');
  await refreshSbx();
}
async function runSbxSelfcheck(){
  const box=$('#sbxCheckResult'); box.innerHTML='';
  box.appendChild(sbxEl('div','note','正在自检…'));
  try{
    const j=await fetch('/api/sandbox/selfcheck',{method:'POST'}).then(r=>r.json());
    box.innerHTML='';
    (j.checks||[]).forEach(c=>{
      const row=sbxEl('div','sbx-row');
      row.appendChild(sbxEl('span','',(c.ok?'✅ ':'❌ ')+c.name));
      row.appendChild(sbxEl('span','sub',c.detail));
      box.appendChild(row);
    });
    toast(j.ok?'沙箱自检全部通过':'沙箱自检有未通过项');
    await refreshSbx();
  }catch(e){ box.innerHTML=''; box.appendChild(sbxEl('div','note','自检失败：'+e.message)); }
}
function addSandboxBar(node, s){
  const wrap=node.__wrap; if(!wrap) return;
  const bar=sbxEl('div','sbx-bar');
  const item=(k,v,cls)=>{
    const sp=sbxEl('span'); sp.appendChild(sbxEl('b','',k));
    sp.appendChild(document.createTextNode(' '+v)); if(cls) sp.className=cls; return sp;
  };
  bar.appendChild(item('🛡',PERM_LABELS[s.perm]||s.perm));
  bar.appendChild(item('📁',s.dir));
  bar.appendChild(item('📸',s.files?('快照 '+s.files+' 文件'):'无快照（只读 / 目录过大）'));
  bar.appendChild(item('⌘',s.cmds+' 条命令'));
  if(s.risky) bar.appendChild(item('⚠','高危 '+s.risky+' 条','risk'));
  const tools=wrap.querySelector('.msg-tools');
  if(tools) wrap.insertBefore(bar,tools); else wrap.appendChild(bar);
}
$('#navSandbox').onclick = openSandboxPanel;
$('#stSandbox').onclick = openSandboxPanel;
$('#sbxClose').onclick = ()=> $('#modalSandbox').classList.remove('show');
$('#sbxDone').onclick = ()=> $('#modalSandbox').classList.remove('show');
$('#sbxRefresh').onclick = refreshSbx;
$('#sbxCheck').onclick = runSbxSelfcheck;
$('#modalSandbox').addEventListener('click', e=>{ if(e.target.id==='modalSandbox') $('#modalSandbox').classList.remove('show'); });
$('#sbxSafe').onchange = async ()=>{
  try{
    await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({agentSafeMode:$('#sbxSafe').checked})});
    toast($('#sbxSafe').checked?'安全模式已开启':'安全模式已关闭');
    await refreshSbx();
  }catch(e){ toast('切换失败'); }
};

/* ---------- 语音输入（本地 faster-whisper，说完即出字） ---------- */
const mic = { active:false, busy:false, byAlt:false, stream:null, ctx:null, mr:null, chunks:[], t0:0, segT0:0, timer:null, raf:null, analyser:null, heard:false, silentMs:0, lastT:0, committed:0, abort:null };
// 停顿 3.2 秒：先把这一段出字，麦克风继续听；之后接着说会在停顿处补逗号
const MIC_STOP_SILENCE = 3200;
// 提交一段后，超过这么久都没再说话就结束这次听写
const MIC_IDLE_END = 4500;

function micChip(text, busy){
  const el=$('#micState'); if(!el) return;
  if(!text){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='inline-flex';
  el.className='mic-state'+(busy?' busy':'');
  el.innerHTML = busy ? '' : '<span class="bars"><i></i><i></i><i></i></span>';
  el.appendChild(document.createTextNode(text));
}
function micTick(){
  if(!mic.active) return;
  if(mic.busy){ mic.timer=setTimeout(micTick,150); return; }
  const s=Math.floor((performance.now()-mic.t0)/1000);
  if(mic.heard && mic.silentMs>700){
    micChip('停顿 '+(mic.silentMs/1000).toFixed(1)+'s · 继续说');
  } else {
    micChip('聆听中 '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0'));
  }
  mic.timer=setTimeout(micTick, 120);
}
function beginSegment(){
  if(!mic.stream) return;
  mic.chunks=[]; mic.heard=false; mic.silentMs=0; mic.lastT=0; mic.segT0=performance.now();
  let mime='audio/webm;codecs=opus';
  if(!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) mime='';
  let mr;
  try{ mr = mime ? new MediaRecorder(mic.stream,{mimeType:mime}) : new MediaRecorder(mic.stream); }
  catch(e){ mr = new MediaRecorder(mic.stream); }
  mic.mr=mr;
  mr.ondataavailable=e=>{ if(e.data && e.data.size) mic.chunks.push(e.data); };
  mr.start(120);
}
function micMonitor(){
  if(!mic.active || !mic.analyser) return;
  const arr=new Float32Array(mic.analyser.fftSize);
  mic.analyser.getFloatTimeDomainData(arr);
  let sum=0; for(let i=0;i<arr.length;i++) sum+=arr[i]*arr[i];
  const rms=Math.sqrt(sum/arr.length);
  const now=performance.now(); const dt=mic.lastT?now-mic.lastT:0; mic.lastT=now;
  if(rms>0.015) { mic.heard=true; mic.silentMs=0; }
  else if(mic.heard && rms<0.009) { mic.silentMs+=dt; }
  if(mic.heard && mic.silentMs>MIC_STOP_SILENCE && !mic.busy){
    // 一段说完了：先出字，麦克风保持开启，接着说会接在同一行（停顿处补逗号）
    commitSegment(true);
    mic.raf=requestAnimationFrame(micMonitor);
    return;
  }
  if(mic.committed>0 && !mic.heard && !mic.busy && now-mic.segT0>MIC_IDLE_END){
    endListening(); return;
  }
  if(now-mic.t0>60000){ stopMic(); return; }
  mic.raf=requestAnimationFrame(micMonitor);
}
async function startMic(byAlt){
  if(mic.active || mic.busy) return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    mic.stream=stream; mic.byAlt=!!byAlt; mic.committed=0; mic.busy=false;
    if(mic.abort){ try{ mic.abort.abort(); }catch(e){} mic.abort=null; }
    beginSegment();
    mic.ctx=new (window.AudioContext||window.webkitAudioContext)();
    const src=mic.ctx.createMediaStreamSource(stream);
    mic.analyser=mic.ctx.createAnalyser();
    mic.analyser.fftSize=2048; mic.analyser.smoothingTimeConstant=.4;
    src.connect(mic.analyser);
    mic.active=true; mic.t0=performance.now();
    $('#btnMic').classList.add('rec');
    micChip('聆听中 0:00');
    showMicStop(true);
    micTick(); micMonitor();
  }catch(e){
    toast('无法使用麦克风：'+(e.message||e));
    micCleanup();
  }
}
function micCleanup(){
  mic.active=false;
  clearTimeout(mic.timer); mic.timer=null;
  if(mic.raf) cancelAnimationFrame(mic.raf);
  mic.raf=null; mic.analyser=null;
  try{ mic.stream && mic.stream.getTracks().forEach(t=>t.stop()); }catch(e){}
  try{ mic.ctx && mic.ctx.close(); }catch(e){}
  mic.stream=null; mic.ctx=null; mic.mr=null;
  const b=$('#btnMic'); if(b) b.classList.remove('rec');
}
function blobFrom(mr, chunks){
  return new Promise(res=>{
    const made=()=>res(new Blob(chunks,{type:(mr&&mr.mimeType)||'audio/webm'}));
    if(!mr || mr.state==='inactive'){ made(); return; }
    let done=false;
    mr.onstop=()=>{ if(!done){ done=true; made(); } };
    try{ mr.stop(); }catch(e){}
    setTimeout(()=>{ if(!done){ done=true; made(); } }, 700);
  });
}
// 解码后的 AudioBuffer → 16kHz 单声道 PCM（Int16）
function pcm16kFromBuffer(ab){
  const chs=[];
  for(let c=0;c<ab.numberOfChannels;c++) chs.push(ab.getChannelData(c));
  const len=ab.length, sr=ab.sampleRate;
  const ratio=sr/16000, outLen=Math.max(1,Math.floor(len/ratio));
  const out=new Int16Array(outLen);
  for(let i=0;i<outLen;i++){
    const pos=i*ratio, i0=Math.floor(pos), i1=Math.min(i0+1,len-1), w=pos-i0;
    let v=0;
    for(let c=0;c<chs.length;c++) v += chs[c][i0]*(1-w) + chs[c][i1]*w;
    v/=chs.length;
    out[i]=Math.max(-1,Math.min(1,v))*32767;
  }
  return out;
}
// PCM 片段 → 16kHz 单声道 WAV
function wavFromPcm16(pcm, from, to){
  const n=Math.max(0, to-from);
  const buf=new ArrayBuffer(44+n*2); const dv=new DataView(buf);
  const wstr=(off,s)=>{ for(let i=0;i<s.length;i++) dv.setUint8(off+i,s.charCodeAt(i)); };
  wstr(0,'RIFF'); dv.setUint32(4,36+n*2,true); wstr(8,'WAVE'); wstr(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,16000,true); dv.setUint32(28,32000,true); dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  wstr(36,'data'); dv.setUint32(40,n*2,true);
  if(n) new Int16Array(buf,44,n).set(pcm.subarray(from, to));
  return buf;
}
// 在目标切点附近找能量最低处，避免把一句话切一半
function quietCut(pcm, target){
  const F=800;                       // 50ms 帧
  const W=16000*3;                   // 前后各 3s 搜索
  const lo=Math.max(F, target-W), hi=Math.min(pcm.length-F-1, target+W);
  let best=target, bestE=Infinity;
  for(let s=lo;s<=hi;s+=F){
    let e=0;
    for(let i=s;i<s+F;i+=8){ const v=pcm[i]/32768; e+=v*v; }
    if(e<bestE){ bestE=e; best=s+Math.floor(F/2); }
  }
  return best;
}
function joinAsrText(a,b){
  const x=(a||'').trim(), y=(b||'').trim();
  if(!x) return y; if(!y) return x;
  const cjk=/[\u4e00-\u9fa5]$/.test(x) && /^[\u4e00-\u9fa5]/.test(y);
  return x + (cjk?'':' ') + y;
}
// whisper 在静音/纯音乐上常见的「字幕组/结尾寒暄」幻觉，按行丢弃
const ASR_NOISE = [
  /^[\s(（【\[]*字幕[:：由]?.*[)）】\]]*$/,
  /^(请不吝)?点赞[、，,]?\s*(订阅|关注|转发|打赏).*$/,
  /^订阅(我们的)?频道.*$/,
  /^(谢谢|感谢)(大家)?(的)?(观看|收看|收听).*$/,
  /^(thanks?|thank you)( for)? watching.*$/i,
  /^amara\.org.*$/i,
];
function cleanAsrText(t){
  const lines = String(t || '').split(/\r?\n/);
  const keep = lines.filter((ln) => {
    const s = ln.trim();
    if (!s) return false;
    return !ASR_NOISE.some((re) => re.test(s));
  });
  return keep.join(' ').replace(/\s{2,}/g, ' ').trim();
}
// 单块上限 4 分钟：长视频/长录音分块送识别，避免一次几百 MB 的 WAV 爆内存
const ASR_CHUNK_SEC = 240;
async function transcribeBlob(blob, signal, onProgress){
  const raw=await blob.arrayBuffer();
  if(!raw.byteLength) return '';
  const AC=window.AudioContext||window.webkitAudioContext;
  const ac=new AC();
  let ab=null;
  try{ ab=await ac.decodeAudioData(raw.slice(0)); }
  catch(e){ throw new Error('音轨解码失败（该文件的音频编码可能不受支持，试试 mp4/mov/m4a/mp3）'); }
  finally{ try{ ac.close(); }catch(e){} }
  // 静音检测：全程 RMS 低于阈值说明没有有效人声，直接返回空，不再送 whisper。
  // 否则 whisper 会把「请用简体中文输出」这类初始提示当成已有文本续写，静音也能吐出 prompt。
  const chs=[];
  for(let c=0;c<ab.numberOfChannels;c++) chs.push(ab.getChannelData(c));
  let sum=0, n=0;
  for(let c=0;c<chs.length;c++){ const d=chs[c]; for(let i=0;i<d.length;i++){ sum+=d[i]*d[i]; n++; } }
  const rms = n ? Math.sqrt(sum/n) : 0;
  if(rms < 0.003) return '';   // 静音，当没说

  const pcm = pcm16kFromBuffer(ab);
  const limit = 16000*ASR_CHUNK_SEC;
  const ctrl = signal ? null : (mic.abort || (mic.abort=new AbortController()));
  const sig = signal || (ctrl && ctrl.signal);

  // 单块（绝大多数短音频走这里，行为与之前一致）
  if(pcm.length <= limit){
    if(onProgress) onProgress(1,1);
    const r=await fetch('/api/asr',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wavFromPcm16(pcm,0,pcm.length), signal:sig});
    const j=await r.json();
    if(!j.ok) throw new Error(j.error||'识别失败');
    return cleanAsrText(j.text||'');
  }

  // 分块（视频 / 长录音）
  const total=Math.ceil(pcm.length/limit);
  let pos=0, idx=0, out='';
  while(pos < pcm.length){
    let end=Math.min(pcm.length, pos+limit);
    if(end < pcm.length) end=quietCut(pcm,end);
    if(end-pos < 16000*0.5) end=Math.min(pcm.length, pos+limit);   // 兜底，避免空块
    idx++;
    if(onProgress) onProgress(idx, total);
    const r=await fetch('/api/asr',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wavFromPcm16(pcm,pos,end), signal:sig});
    const j=await r.json();
    if(!j.ok) throw new Error(j.error||'识别失败');
    out=joinAsrText(out, cleanAsrText(j.text||''));
    pos=end;
  }
  return out;
}
// 硬停止：立即中止正在进行的识别 + 结束录音，丢弃未出字的内容。
// 用于「听不到/一直转圈」时给用户一个明确出口，而不是等静音超时。
function hardStopMic(){
  if(mic.abort){ try{ mic.abort.abort(); }catch(e){} mic.abort=null; }
  if(mic.active || mic.busy){
    mic.mr=null; mic.chunks=[]; mic.active=false;
    clearTimeout(mic.timer); mic.timer=null;
    if(mic.raf) cancelAnimationFrame(mic.raf);
    mic.raf=null;
    micCleanup();
    mic.busy=false;
    $('#btnMic').classList.remove('busy','rec');
    showMicStop(false);
    micChip('已停止', true);
    setTimeout(()=>micChip(''),1200);
  }
}
function showMicStop(on){
  const b=$('#btnMicStop'); if(!b) return;
  b.style.display = on ? 'inline-flex' : 'none';
}
// 把当前这一段提交去识别；keep=true 表示麦克风继续听下一段
async function commitSegment(keep){
  if(mic.busy) return;
  const mr=mic.mr, chunks=mic.chunks;
  mic.mr=null; mic.chunks=[];
  mic.busy=true;
  $('#btnMic').classList.add('busy');
  micChip('正在识别…', true);
  showMicStop(true);
  try{
    const blob=await blobFrom(mr, chunks);
    // 先开下一段录音，避免识别期间把话漏掉
    if(keep && mic.active) beginSegment();
    const text=await transcribeBlob(blob);
    if(text){
      insertDictation((mic.committed?'，':'')+text);
      mic.committed++;
      micChip('已输入 · '+text.length+' 字', true);
    }else if(keep){
      micChip('', true);
    }
  }catch(e){
    if(e && e.name==='AbortError'){ micChip('已停止', true); setTimeout(()=>micChip(''),1200); }
    else { toast('语音识别失败：'+(e.message||e)); micChip('', true); }
  }finally{
    mic.busy=false;
    $('#btnMic').classList.remove('busy');
    showMicStop(false);
  }
}
function endListening(){
  if(!mic.active && !mic.busy) return;
  const mr=mic.mr, chunks=mic.chunks;
  mic.mr=null; mic.chunks=[];
  mic.active=false;
  clearTimeout(mic.timer); mic.timer=null;
  if(mic.raf) cancelAnimationFrame(mic.raf);
  mic.raf=null;
  micCleanup();
  setTimeout(()=>{ if(!mic.active && !mic.busy) micChip(''); }, 1400);
  // 最后一段如果还有没提交的话，补上
  if(chunks && chunks.length) (async()=>{
    mic.busy=true; $('#btnMic').classList.add('busy'); micChip('正在识别…', true);
    showMicStop(true);
    try{
      const blob=await blobFrom(mr, chunks);
      const text=await transcribeBlob(blob);
      if(text){ insertDictation((mic.committed?'，':'')+text); mic.committed++; micChip('已输入 · '+text.length+' 字', true); }
      else micChip('', true);
    }catch(e){ if(e && e.name==='AbortError') micChip('已停止', true); else micChip('', true); }
    finally{ mic.busy=false; $('#btnMic').classList.remove('busy'); showMicStop(false); }
  })();
}
function stopMic(){
  if(!mic.active) return;
  const dur=performance.now()-mic.segT0;
  const mr=mic.mr, chunks=mic.chunks;
  const heard=mic.heard;   // 记录这段有没有真正听到声音
  mic.mr=null; mic.chunks=[];
  mic.active=false;
  micCleanup();
  if(!chunks || !chunks.length){ micChip(''); return; }
  if(dur<350 && !mic.committed){ micChip(''); toast('说话时间太短了'); return; }
  // 全程没听到任何声音：不送识别，直接结束（否则 whisper 会吐出提示词）
  if(!heard && !mic.committed){ micChip('没听到声音', true); setTimeout(()=>micChip(''),1200); return; }
  (async()=>{
    mic.busy=true; $('#btnMic').classList.add('busy'); micChip('正在识别…', true);
    showMicStop(true);
    try{
      const blob=await blobFrom(mr, chunks);
      const text=await transcribeBlob(blob);
      if(!text){ micChip('没有听清，再说一次', true); setTimeout(()=>micChip(''),1400); return; }
      insertDictation((mic.committed?'，':'')+text); mic.committed++;
      micChip('已输入 · '+text.length+' 字', true);
      setTimeout(()=>micChip(''),1200);
    }catch(e){
      if(e && e.name==='AbortError'){ micChip('已停止', true); setTimeout(()=>micChip(''),1200); }
      else { micChip('识别失败', true); toast('语音识别失败：'+(e.message||e)); setTimeout(()=>micChip(''),1600); }
    }finally{
      mic.busy=false;
      $('#btnMic').classList.remove('busy');
      showMicStop(false);
    }
  })();
}
function encodeWav16k(audioBuffer){
  const pcm = pcm16kFromBuffer(audioBuffer);
  return wavFromPcm16(pcm, 0, pcm.length);
}
function insertDictation(text){
  const ta=$('#input');
  const s=ta.selectionStart==null?ta.value.length:ta.selectionStart;
  const e=ta.selectionEnd==null?s:ta.selectionEnd;
  const before=ta.value.slice(0,s), after=ta.value.slice(e);
  const needSpace=/[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(text);
  const piece=(needSpace?' ':'')+text;
  ta.value=before+piece+after;
  const pos=before.length+piece.length;
  ta.setSelectionRange(pos,pos);
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  ta.focus();
  autoGrow();
}

/* ---------- 音视频转写（附件） ---------- */
async function transcribeAttachment(a, btn){
  if(a._busy || !a.file) return;
  a._busy = true;
  const old = btn ? btn.textContent : '';
  const isVid = a.media==='video';
  if(btn){ btn.textContent = isVid ? '解析中…' : '转写中…'; btn.disabled = true; }
  try{
    const ab = await a.file.arrayBuffer();
    const blob = new Blob([ab], { type: a.file.type || (isVid?'video/mp4':'audio/wav') });
    const ctrl = new AbortController();
    const text = await transcribeBlob(blob, ctrl.signal, (i,n)=>{
      if(btn && n>1) btn.textContent = '转写 '+i+'/'+n+'…';
    });
    if(text && text.trim()){
      insertDictation(text.trim());
      attachments = attachments.filter(x=>x.id!==a.id);
      renderAttach();
      toast('已转写 '+text.length+' 字并插入输入框');
    } else {
      toast(isVid ? '这段视频没识别出人声（可能是无声视频或纯背景音乐）' : '没识别出文字（可能是静音或格式不被支持）');
    }
  }catch(e){
    if(e && e.name==='AbortError') toast('已取消');
    else toast('转写失败：'+(e.message||e));
  }finally{
    a._busy = false;
    if(btn){ btn.textContent = old; btn.disabled = false; }
  }
}

/* ---------- 连接器面板 ---------- */
let cnState = {};       // id -> { enabled, config }
let cnPending = {};     // id -> 已展开配置表单（尚未保存）
let cnApiRegistry = []; // 服务端 /api/connectors 返回的注册表（权威来源，兜底脚本加载失败）
let cnHealth = {};      // id -> { state:'ok'|'fail'|'checking', text, reason, at }
let cnCat = '全部';
let cnSearchQ = '';
let cnBusy = {};                          // id -> true：开关请求在途，忽略后续点击
let cnOauth = {};                         // id -> { timer, startedAt, deadline }
const CN_OAUTH_TIMEOUT_MS = 150000;       // 前端兜底：服务端 TTL 同量级

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function escapeAttr(s){ return escapeHtml(s).replace(/'/g,'&#39;'); }
function cnRegistry(){
  // 优先用服务端注册表（始终与主进程一致）；回退到页面脚本注入的 window.WHALE_CONNECTORS
  if (cnApiRegistry && cnApiRegistry.length) return cnApiRegistry;
  return (window.WHALE_CONNECTORS || []);
}
function cnCats(){
  const set = ['全部'];
  cnRegistry().forEach(c=>{ if(!set.includes(c.cat)) set.push(c.cat); });
  return set;
}
async function cnOpen(){
  const m = $('#cnModal'); if(!m) return;
  m.classList.add('show');
  const b = $('#btnConnectors'); if(b) b.setAttribute('aria-expanded','true');
  await cnRefresh();
  await cnRestoreOauth();   // 面板关过/页面刷新过：把服务端仍在跑的授权接回来
  cnCheckAll();   // 打开面板即刷新一次真实状态（引擎加载 + 授权 + 端点）
}
function cnClose(){
  const m = $('#cnModal'); if(m) m.classList.remove('show');
  const b = $('#btnConnectors'); if(b) b.setAttribute('aria-expanded','false');
  // 只停前端轮询，不取消服务端授权进程（用户可能正在浏览器里登录）；重开面板会自动接回
  Object.keys(cnOauth).forEach(id=>{
    const rec = cnOauth[id];
    if(rec && rec.timer){ clearTimeout(rec.timer); rec.timer = null; }
  });
}
async function cnRefresh(){
  try{
    const j = await (await fetch('/api/connectors')).json();
    if(j && j.state) cnState = j.state;
    if(j && Array.isArray(j.registry) && j.registry.length) cnApiRegistry = j.registry;
  }catch(e){ /* 网络异常时保留已有数据，避免面板被清空 */ }
  cnRenderCats(); cnRenderList(); cnRenderStat();
}
function cnRenderStat(){
  const el = $('#cnStat'); if(!el) return;
  const n = Object.keys(cnState).filter(k=>cnState[k] && cnState[k].enabled).length;
  el.textContent = '已连接 '+n+' / '+cnRegistry().length+' 个连接器';
}
function cnRenderCats(){
  const box = $('#cnCats'); if(!box) return;
  box.innerHTML = '';
  cnCats().forEach(c=>{
    const b=document.createElement('div');
    b.className='cn-cat'+(c===cnCat?' on':'');
    b.textContent=c;
    b.onclick=()=>{ cnCat=c; cnRenderCats(); cnRenderList(); };
    box.appendChild(b);
  });
}
function cnRenderList(){
  const box = $('#cnList'); if(!box) return;
  const q = cnSearchQ.trim().toLowerCase();
  const list = cnRegistry().filter(c=>{
    if(cnCat!=='全部' && c.cat!==cnCat) return false;
    if(q && !(c.name.toLowerCase().includes(q) || (c.desc||'').toLowerCase().includes(q) || c.cat.toLowerCase().includes(q))) return false;
    return true;
  });
  if(!list.length){ box.innerHTML='<div class="cn-empty">没有匹配的连接器</div>'; return; }
  box.innerHTML='';
  list.forEach(c=>{
    const st = cnState[c.id] || {};
    const on = !!st.enabled;
    const showForm = on || !!cnPending[c.id];
    const fieldsHtml = (c.fields||[]).map(f=>{
      const val = (st.config && st.config[f.key]) || '';
      return '<input data-f="'+f.key+'" type="'+(f.secret?'password':'text')+'" placeholder="'+escapeAttr(f.placeholder||'')+'" value="'+escapeAttr(val)+'">';
    }).join('');
    const formHtml = ((c.fields&&c.fields.length) && showForm)
      ? '<div class="cn-form show">'+fieldsHtml+'<button type="button" class="cn-save" data-id="'+c.id+'">保存并连接</button><span class="note">连接信息仅保存在本机设置中。</span></div>'
      : '';
    const oauthNote = (on && c.auth==='oauth')
      ? (c.oauthFlow
          ? '<div class="cn-note-oauth">点「授权」会打开浏览器完成该服务商的登录授权（自动注册客户端 + PKCE），凭据由 Codex 引擎加密保存在本机。</div>'
          : '<div class="cn-note-oauth">该服务商的动态注册不接受本机回调，暂不能一键授权；请填写已登记的自建地址，或改用令牌。</div>')
      : '';
    const noteHtml = c.note ? '<div class="cn-note-oauth">'+escapeHtml(c.note)+'</div>' : '';
    const oauthing = !!cnOauth[c.id];
    const busy = !!cnBusy[c.id];
    const authBtn = (on && c.oauthFlow)
      ? '<button type="button" class="cn-oauth'+(oauthing?' cancel':'')+'" data-id="'+c.id+'">'+(oauthing?'取消授权':'授权')+'</button>'
      : '';
    // 「检测状态」：真实探测（引擎加载 + 授权状态 + 端点握手），结果紧随其后显示
    const checkBtn = on
      ? '<button type="button" class="cn-check" data-id="'+c.id+'">检测状态</button>'
      : '';
    const healthHtml = on ? cnHealthHtml(c.id) : '';
    const waitText = oauthing
      ? ('等待授权… ' + Math.max(0, Math.round((Date.now() - cnOauth[c.id].startedAt)/1000)) + 's')
      : '';
    const statHtml = '<span class="cn-stat" data-stat="'+c.id+'">'+
      (oauthing ? waitText : (on ? '' : (c.auth==='local'?'本地运行':(c.auth==='oauth'?'需授权':'需令牌'))))+'</span>';
    const item=document.createElement('div'); item.className='cn-item'; item.dataset.id=c.id;
    item.innerHTML =
      '<div class="cn-ic">'+(c.iconUrl
        ? '<img src="'+escapeAttr(c.iconUrl)+'" alt="" loading="lazy" data-fb="'+escapeAttr(c.icon||'')+'">'
        : escapeHtml(c.icon||''))+'</div>'+
      '<div class="cn-main">'+
        '<div class="cn-name">'+escapeHtml(c.name)+'</div>'+
        '<div class="cn-desc">'+escapeHtml(c.desc)+'</div>'+
        '<div class="cn-row2">'+
          '<span class="cn-toggle'+(on?' on':'')+(busy?' busy':'')+'" data-id="'+c.id+'"><span class="cn-dot"></span>'+(busy?'处理中…':(on?'已连接':'连接'))+'</span>'+
          authBtn+
          checkBtn+
          healthHtml+
          statHtml+
        '</div>'+
        noteHtml+
        formHtml+oauthNote+
      '</div>';
    box.appendChild(item);
  });
}
/* ---------- 连接器状态检测（引擎加载 / 授权 / 端点握手） ---------- */
function cnHealthHtml(id){
  const h = cnHealth[id];
  if(!h) return '<span class="cn-health" data-health="'+id+'">未检测</span>';
  if(h.state==='checking') return '<span class="cn-health wait" data-health="'+id+'">检测中…</span>';
  if(h.ok) return '<span class="cn-health ok" data-health="'+id+'" title="'+escapeAttr(h.reason||'状态正常')+'">状态正常</span>';
  return '<span class="cn-health fail" data-health="'+id+'" title="'+escapeAttr(h.reason||'连接失败')+'">连接失败</span>';
}
function cnPaintHealth(id){
  const el = document.querySelector('[data-health="'+id+'"]'); if(!el) return;
  const h = cnHealth[id];
  let cls = 'cn-health', txt = '未检测', tip = '';
  if(h){
    if(h.state==='checking'){ cls += ' wait'; txt = '检测中…'; }
    else if(h.ok){ cls += ' ok'; txt = '状态正常'; tip = h.reason||''; }
    else if(h.state==='off'){ txt = '未连接'; tip = h.reason||''; }
    else { cls += ' fail'; txt = '连接失败'; tip = h.reason||''; }
  }
  el.className = cls;
  el.textContent = txt;
  if(tip) el.title = tip; else el.removeAttribute('title');
  // 已确认正常且是 OAuth 类 → 授权按钮改称「重新授权」（与状态保持一致）
  const ob = document.querySelector('.cn-oauth[data-id="'+id+'"]');
  if(ob && !ob.disabled && h && h.ok) ob.textContent = '重新授权';
}
// 单个检测：真的去探测（不是刷新页面猜状态）
async function cnCheck(id){
  cnHealth[id] = { state:'checking' };
  cnPaintHealth(id);
  const btn = document.querySelector('.cn-check[data-id="'+id+'"]');
  if(btn){ btn.disabled = true; btn.textContent = '检测中…'; }
  try{
    const j = await (await fetch('/api/connectors/check?id='+encodeURIComponent(id))).json();
    const it = (j && j.items && j.items[0]) || null;
    if(it) cnHealth[id] = it;
    else cnHealth[id] = { state:'fail', reason:(j && j.reason) || '检测无返回' };
  }catch(e){
    cnHealth[id] = { state:'fail', reason:'网络错误：'+(e.message||e) };
  }
  cnPaintHealth(id);
  if(btn){ btn.disabled = false; btn.textContent = '检测状态'; }
}
// 批量检测：面板打开时对全部已连接项跑一次（服务端只起一次 mcp list）
async function cnCheckAll(){
  const ids = Object.keys(cnState).filter(k=>cnState[k] && cnState[k].enabled);
  if(!ids.length) return;
  ids.forEach(i=>{ cnHealth[i] = { state:'checking' }; cnPaintHealth(i); });
  try{
    const j = await (await fetch('/api/connectors/check')).json();
    const got = {};
    (j.items||[]).forEach(it=>{ if(it && it.id){ cnHealth[it.id] = it; got[it.id]=1; } });
    ids.forEach(i=>{ if(!got[i] && cnHealth[i] && cnHealth[i].state==='checking') cnHealth[i] = { state:'fail', reason:(j&&j.reason)||'检测失败' }; });
  }catch(e){
    ids.forEach(i=>{ cnHealth[i] = { state:'fail', reason:'网络错误：'+(e.message||e) }; });
  }
  ids.forEach(cnPaintHealth);
}
/* ---------- 连接器开关：防抖 + 立即反馈 ---------- */
function cnSetToggleLabel(id, text){
  const el = document.querySelector('.cn-toggle[data-id="'+id+'"]');
  if(!el) return;
  for(const n of el.childNodes){ if(n.nodeType===3){ n.nodeValue = text; return; } }
  el.appendChild(document.createTextNode(text));
}
function cnPaintBusy(id, busy){
  const el = document.querySelector('.cn-toggle[data-id="'+id+'"]');
  if(!el) return;
  el.classList.toggle('busy', !!busy);
  const on = !!(cnState[id] && cnState[id].enabled);
  cnSetToggleLabel(id, busy ? '处理中…' : (on ? '已连接' : '连接'));
}
async function cnToggle(id){
  const c = cnRegistry().find(x=>x.id===id); if(!c) return;
  if(cnBusy[id]) return;                                  // 连点：直接丢弃，不叠加请求
  const cur = cnState[id] || {};
  if(cur.enabled && cnOauth[id]) { toast('该连接器正在授权中，请先点「取消授权」'); return; }
  cnBusy[id] = true;
  cnPaintBusy(id, true);                                  // 点击后立刻给出视觉反馈，不再干等
  try{
    if(cur.enabled){
      await cnSave(id, false, cur.config||{});
    } else if(!c.fields || !c.fields.length){
      const ok = await cnSave(id, true, cur.config||{});
      if(ok && c.oauthFlow) cnStartOauth(id);             // 只有保存成功才发起授权，避免「服务端已关、界面在等授权」
    } else {
      if(cnPending[id]) delete cnPending[id]; else cnPending[id]=true;
      cnRenderList();
    }
  } finally {
    delete cnBusy[id];
    cnPaintBusy(id, false);
  }
}
/* ---------- 连接器 OAuth 授权（借 Codex 引擎：DCR + PKCE + 本地回调） ---------- */
function cnStopOauth(id, label){
  const rec = cnOauth[id];
  if(rec && rec.timer){ clearTimeout(rec.timer); rec.timer = null; }
  delete cnOauth[id];
  const btn = document.querySelector('.cn-oauth[data-id="'+id+'"]');
  if(btn){ btn.disabled = false; btn.textContent = label || '授权'; btn.classList.remove('cancel'); }
}
function cnCancelOauth(id){
  cnStopOauth(id, '授权');
  const stat = document.querySelector('[data-stat="'+id+'"]');
  if(stat) stat.textContent = '已取消授权';
  fetch('/api/connectors/oauth',{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'cancel'}),
  }).catch(()=>{});
  toast('已取消授权');
  cnRenderList();
}
async function cnStartOauth(id){
  if(cnOauth[id]) return;                                 // 已在等待中，不重复发起
  const btn = document.querySelector('.cn-oauth[data-id="'+id+'"]');
  const stat = document.querySelector('[data-stat="'+id+'"]');
  if(btn){ btn.disabled = true; btn.textContent = '发起中…'; }
  try{
    const r = await fetch('/api/connectors/oauth',{
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id}),
    });
    const j = await r.json();
    if(!j || !j.ok){
      toast((j && j.reason) || '发起授权失败');
      if(btn){ btn.disabled = false; btn.textContent = '授权'; }
      return;
    }
    const ttl = (j && j.ttl) || CN_OAUTH_TIMEOUT_MS;
    cnOauth[id] = { startedAt: Date.now(), deadline: Date.now() + ttl, timer: null };
    if(stat) stat.textContent = '等待授权…';
    toast('已打开浏览器授权页，请完成登录');
    cnRenderList();                                       // 按钮切换成「取消授权」
    cnPollOauth(id);
  }catch(e){
    toast('发起授权失败：'+(e.message||e));
    if(btn){ btn.disabled = false; btn.textContent = '授权'; }
  }
}
function cnPollOauth(id){
  const rec = cnOauth[id]; if(!rec) return;
  if(rec.timer){ clearTimeout(rec.timer); rec.timer = null; }
  const tick = async ()=>{
    if(!cnOauth[id]) return;
    const stat = document.querySelector('[data-stat="'+id+'"]');
    try{
      const j = await (await fetch('/api/connectors/oauth')).json();
      if(j.id === id && j.status === 'ok'){
        cnStopOauth(id, '重新授权');
        if(stat) stat.textContent = '';
        toast('授权成功');
        cnCheck(id);
        return;
      }
      if(j.id === id && j.status === 'fail'){
        cnStopOauth(id, '重试授权');
        if(stat) stat.textContent = '授权失败';
        toast('授权失败：' + (j.err || '请在浏览器中重试'));
        cnRenderList();
        return;
      }
      if(j.running && j.id !== id){
        cnStopOauth(id, '授权');
        if(stat) stat.textContent = '其他连接器正在授权';
        cnRenderList();
        return;
      }
      if(!j.running && j.id === id && j.status !== 'running'){
        cnStopOauth(id);
        cnRenderList();
        return;
      }
      if(rec.deadline - Date.now() <= 0){
        cnCancelOauth(id);
        if(stat) stat.textContent = '授权超时，请重新发起';
        return;
      }
      if(stat) stat.textContent = '等待授权… ' + (j.elapsed || 0) + 's';
      rec.timer = setTimeout(tick, 2000);
    }catch(e){
      if(!cnOauth[id]) return;
      rec.timer = setTimeout(tick, 3000);
    }
  };
  rec.timer = setTimeout(tick, 1200);
}
// 面板重开/页面刷新后，把服务端仍在跑的授权接回前端（否则界面显示「需授权」、点授权却被拒）
async function cnRestoreOauth(){
  try{
    const j = await (await fetch('/api/connectors/oauth')).json();
    if(j && j.running && j.id && !cnOauth[j.id]){
      const elapsed = (j.elapsed || 0) * 1000;
      cnOauth[j.id] = {
        startedAt: Date.now() - elapsed,
        deadline: Date.now() + ((j.ttl || CN_OAUTH_TIMEOUT_MS) - elapsed),
        timer: null,
      };
      cnRenderList();
      cnPollOauth(j.id);
    }
  }catch(e){}
}
async function cnSave(id, enabled, config){
  if(enabled){
    const c = cnRegistry().find(x=>x.id===id);
    if(c && c.auth==='token' && !(config && String(config.token||'').trim())){
      toast('请先填写令牌再连接'); return false;
    }
  }
  let ok = false;
  try{
    const r = await fetch('/api/connectors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id, enabled, config:config||{}})});
    const j = await r.json();
    if(j && j.busy){
      toast('正在处理中，请稍候…');
    } else if(j && (j.saved === true || j.ok === true)){
      ok = true;
      cnState[id] = { enabled, config: config||{} };
      if(enabled) delete cnPending[id];
      delete cnHealth[id];   // 连接/断开后旧的检测结果失效
      if(j.syncOk === false) toast('已保存，但写入 Codex 配置失败：'+((j&&j.reason)||'未知'));
      else toast(j.note || (enabled ? ('已连接 '+id) : ('已断开 '+id)));
    } else {
      toast('操作失败：'+((j&&j.reason)||'未知错误'));
    }
  }catch(e){ toast('网络错误：'+(e.message||e)); }
  cnRenderList(); cnRenderStat();
  if(enabled && ok) cnCheck(id);   // 连上立即检测一次，直接给出「状态正常 / 连接失败」
  return ok;
}

(function bindConnectors(){
  const open = $('#btnConnectors'); if(open) open.onclick = cnOpen;
  const close = $('#cnClose'); if(close) close.onclick = cnClose;
  const manage = $('#cnManage'); if(manage) manage.onclick = ()=>{ cnClose(); const s=$('#hbSettings'); if(s) s.click(); };
  const search = $('#cnSearch'); if(search) search.addEventListener('input', e=>{ cnSearchQ = e.target.value; cnRenderList(); });
  const modal = $('#cnModal'); if(modal) modal.addEventListener('click', e=>{ if(e.target.id==='cnModal') cnClose(); });
  const list = $('#cnList'); if(list){
    // 官方图标加载失败 → 回退到 emoji（error 不冒泡，必须捕获阶段监听）
    list.addEventListener('error', e=>{
      const t = e.target;
      if(t && t.tagName==='IMG' && t.dataset && t.dataset.fb!==undefined){
        const s=document.createElement('span'); s.textContent = t.dataset.fb || '🔗';
        if(t.parentNode) t.parentNode.replaceChild(s, t);
      }
    }, true);
    list.addEventListener('click', e=>{
      const tog = e.target.closest('.cn-toggle');
      if(tog){ cnToggle(tog.dataset.id); return; }
      const oauthBtn = e.target.closest('.cn-oauth');
      if(oauthBtn){
        const oid = oauthBtn.dataset.id;
        if(cnOauth[oid]) cnCancelOauth(oid); else cnStartOauth(oid);
        return;
      }
      const chk = e.target.closest('.cn-check');
      if(chk){ cnCheck(chk.dataset.id); return; }
      const save = e.target.closest('.cn-save');
      if(save){
        const id = save.dataset.id;
        const item = save.closest('.cn-item');
        const config = {};
        item.querySelectorAll('input[data-f]').forEach(inp=>{ config[inp.dataset.f] = inp.value.trim(); });
        cnSave(id, true, config);
      }
    });
  }
})();

/* ---------- 语音与机器人：外部服务适配（只填地址，不内置运行时） ---------- */
async function voiceSaveNow(){
  // 检测/打开前先把输入框的地址落盘，否则探的是上一次保存的地址，用户会以为没生效
  try{
    await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      voice:{ tts: $('#sVoiceTts') ? $('#sVoiceTts').value.trim() : '',
              bot: $('#sVoiceBot') ? $('#sVoiceBot').value.trim() : '' },
    })});
  }catch(e){}
}
async function voiceCheck(target){
  const isBot = target === 'bot';
  const box = isBot ? $('#sVoiceBotState') : $('#sVoiceTtsState');
  const btn = isBot ? $('#btnVoiceBotCheck') : $('#btnVoiceTtsCheck');
  if(btn) btn.disabled = true;
  if(box){ box.textContent = '检测中…'; box.style.color = ''; }
  await voiceSaveNow();
  try{
    const j = await (await fetch('/api/voice/check?target='+target)).json();
    if(box){
      if(j.ok){ box.textContent = '✔ ' + (j.note || '可达') + ' · ' + j.ms + 'ms'; box.style.color = '#1a7f37'; }
      else { box.textContent = '✘ ' + (j.empty ? '未填写地址' : (j.reason || '连接失败')); box.style.color = '#d1242f'; }
    }
  }catch(e){
    if(box){ box.textContent = '✘ 检测失败：' + (e.message||e); box.style.color = '#d1242f'; }
  }
  if(btn) btn.disabled = false;
}
async function voiceOpen(target){
  await voiceSaveNow();
  try{
    const j = await (await fetch('/api/open-url?target='+target)).json();
    if(!j.ok) toast(j.reason || '未填写地址');
  }catch(e){ toast('打开失败'); }
}
async function voiceExtOpen(key){
  try{
    const j = await (await fetch('/api/open-ext?target='+encodeURIComponent(key))).json();
    if(!j.ok) toast(j.reason || '打开失败');
  }catch(e){ toast('打开失败'); }
}
(function bindVoice(){
  const t = $('#btnVoiceTtsCheck'); if(t) t.onclick = ()=>voiceCheck('tts');
  const to = $('#btnVoiceTtsOpen'); if(to) to.onclick = ()=>voiceOpen('tts');
  const b = $('#btnVoiceBotCheck'); if(b) b.onclick = ()=>voiceCheck('bot');
  const bo = $('#btnVoiceBotOpen'); if(bo) bo.onclick = ()=>voiceOpen('bot');
  document.querySelectorAll('.vlink a[data-ext]').forEach(a=>{
    a.onclick = (e)=>{ e.preventDefault(); voiceExtOpen(a.dataset.ext); };
  });
})();

/* ---------- 图标初始化 ---------- */
function initIcons(){
  const set=(sel, html)=>{ const el=$(sel); if(el) el.innerHTML=html; };
  const setChild=(sel, html)=>{ const el=$(sel); if(!el) return; const s=el.querySelector('.ico'); if(s) s.innerHTML=html; };
  setChild('#navAgent', ICON.bot);
  setChild('#navMemory', ICON.book);
  setChild('#navSettings', ICON.gear);
  set('#hbArchive', ICON.archive);
  set('#hbExport', ICON.download);
  set('#hbSettings', ICON.gear);
  set('#btnAttach', ICON.plus);
  set('#btnPerm', ICON.shield + '<span id="permLabel" style="margin:0 2px">完全权限</span>' + ICON.chev);
  set('#btnSend', ICON.send);
  const micBtn=$('#btnMic'); if(micBtn) micBtn.innerHTML=ICON.mic;
  const setIn=(sel,html)=>{ const el=$(sel); if(!el) return; const s=el.querySelector('.mi-ic'); if(s) s.innerHTML=html; };
  setIn('#maRefresh', ICON.refresh);
  setIn('#maReveal', ICON.folder);
  setIn('#maClear', ICON.trash);
}

/* ---------- 会话存储初始化（磁盘为准 + 旧 localStorage 迁移） ---------- */
async function initChatStore(){
  let disk = [];
  try{
    const r = await fetch('/api/chats?full=1');
    if (r.ok) disk = await r.json();
  }catch(e){}
  if (!Array.isArray(disk)) disk = [];

  if (disk.length){
    chats = disk.slice();
    chatsReady = true;
    // 磁盘已有数据：把 localStorage 里多出来的老会话再补一次，防止上次迁移漏掉
    if (legacyChats.length){
      const have = new Set(chats.map(c=>String(c.id)));
      const extra = legacyChats.filter(c=>c && c.id && !have.has(String(c.id)));
      if (extra.length){
        // 先留一份快照：迁移没成功就绝不能把原数据抹掉
        try{ localStorage.setItem('whale.chats.bak', JSON.stringify(legacyChats)); }catch(e){}
        chats = chats.concat(extra).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
        let moved = false;
        try{
          const r = await fetch('/api/chats/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(extra)});
          const j = await r.json();
          moved = !!(j && j.ok && !j.failed);
        }catch(e){}
        if (moved){ try{ localStorage.removeItem('whale.chats'); }catch(e){} }
        else { chatWriteError = '旧会话迁移未完成，已保留本地备份'; }
      } else {
        try{ localStorage.removeItem('whale.chats'); }catch(e){}
      }
    }
    return;
  }

  if (legacyChats.length){
    // 磁盘是空的：把旧版 localStorage 会话整批搬过去，搬完才清掉原数据
    try{
      const r = await fetch('/api/chats/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(legacyChats)});
      const j = await r.json();
      if (j && j.ok && j.failed === 0){
        chatsReady = true;
        try{ localStorage.removeItem('whale.chats'); }catch(e){}
        toast('已迁移 '+j.imported+' 个历史会话到本地磁盘');
      } else {
        chatsReady = true;   // 迁移不完整：保留 localStorage，下次启动再试
      }
    }catch(e){ chatsReady = true; }
  } else {
    chatsReady = true;
  }
}

/* ---------- 初始化 ---------- */
(async ()=>{
  initIcons();
  cnRefresh();
  setModelPill();
  const savedSb = store.get('whale.sandbox','workspace-write');
  if(PERM_LABELS[savedSb]) $('#aSandbox').value = savedSb;
  syncPermLabel();
  setMode('chat');
  try{
    const s = await (await fetch('/api/settings')).json();
    cfg = Object.assign(cfg, s);
    // 与 openSettings 一致：先设 providers / activeProviderId，refreshAvailable 才能正确识别 legacy 模式
    providers = (Array.isArray(s.providers) ? s.providers : []).map(p => Object.assign({}, p));
    activeProviderId = s.activeProviderId || (providers.length ? providers[0].id : '');
    syncModels(s);
    await refreshAvailable();   // 有 key 时用云端真实模型校准，无 key 则清空
    depth = (s.thinkingDepth && s.thinkingDepth !== 'off') ? s.thinkingDepth : (depth && depth !== 'off' ? depth : 'high');
    if(typeof s.effectiveContextLimit === 'number' && s.effectiveContextLimit > 0) ctxLimit = s.effectiveContextLimit;
    else if(typeof s.contextLimit === 'number' && s.contextLimit > 0) ctxLimit = s.contextLimit;
    if(typeof s.compactAt === 'number' && s.compactAt > 0) compactAt = s.compactAt;
    if(s.dirs && s.dirs.memory) store.set('whale.memdir', s.dirs.memory);
  }catch(e){}
  // 先用上次落盘的探活结果着色（秒开，不再显示"未探活"）
  await loadHealthSnapshot();
  setChipModel(null);
  // 每次启动自动跑一次真实探活，无需用户再手动点"检测全部模型"
  refreshHealth();
  if(cfg.injectMemory!==false) await fetchMemoryPrefix();
  await initChatStore();
  chatsReady = true;   // 兜底：初始化出任何异常，都不能让后续保存被永久跳过
  if(chats.length){
    if(!chats.find(c=>c.id===activeId)) activeId = chats[0].id;
    const c0 = cur() || chats[0];
    activeId = c0.id;
    history = (c0.messages||[]).slice();
  }
  renderList();                 // 先定好 activeId 再画列表，否则当前会话没有高亮
  if(chats.length) renderTranscript(true);
  else newChat();
  updateTitle(); updateStats(); autoGrow(); refreshThreadStats();
  refreshSbx();
  // 首次运行引导：没配 API Key 直接弹设置，别等发消息才看到报错
  try{
    const r0 = await fetch('/api/settings');
    const j0 = await r0.json();
    if(!j0.hasKey && !store.get('whale.keyPrompted', false)){
      store.set('whale.keyPrompted', true);
      toast('首次使用：请先填写 API Key');
      openSettings();
    }
  }catch(e){}
  $('#input').focus();
  window.addEventListener('beforeunload', ()=>{ flushCurrentChat(); flushChatSave(); });
  // 切到后台/最小化时顺手落盘，避免异常退出丢掉最后几条
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden){ flushCurrentChat(); flushChatSave(); } });
  $('#transcript').addEventListener('scroll', onTranscriptScroll, { passive:true });
  const jb = $('#jumpBottom');
  if(jb) jb.addEventListener('click', ()=>{ followNow(); });
})();
