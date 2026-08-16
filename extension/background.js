// dsh-bib 扩展后台（MV3 service worker）
// 职责：attach 真实标签页 → 转发 CDP 帧/状态到中继桥 → 从中继桥取命令执行。
// 契约见 docs/bridge-api.md 与 docs/extension-design.md

const state = {
  cfg: null,            // {origin, port, token}
  base: null,           // http://127.0.0.1:<port>
  tabId: null,          // 激活标签
  tabs: new Map(),      // tabId -> {url, title}
  attached: new Set(),  // 已 attach 的 tabId
  lastFrame: null,      // {seq, data, width, height}
  lastCmd: null,        // 最近命令结果 {cmd, ok, error, at}（调试）
  polling: false,
  loadWait: null,       // navigate 等待 domContent
  loadTimer: null,
  lastModelOpAt: 0,     // 最近一次模型交互命令的时间戳（空白弹窗归因用）
  creatingOwn: false,   // 正在创建/接管自己的标签（onCreated 关闭逻辑跳过）
};

const INTERACTIVE = new Set([
  'button', 'link', 'checkbox', 'combobox', 'menuitem', 'radio', 'slider',
  'spinbutton', 'textbox', 'searchbox', 'listbox', 'tab', 'switch', 'treeitem',
  'option', 'input', 'menu', 'menubar',
]);

// ---------------- 基础 helper ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

function strVal(v) { return v && v.value !== undefined ? String(v.value) : ''; }

function boundingBox(n) {
  if (!n.properties) return null;
  for (const p of n.properties) {
    if (p.name === 'bounding box' && p.value && p.value.value &&
        typeof p.value.value.x === 'number' && typeof p.value.value.y === 'number') {
      return { x: p.value.value.x, y: p.value.value.y, width: p.value.value.width || 0, height: p.value.value.height || 0 };
    }
  }
  return null;
}

const extOrigin = () => chrome.runtime.getURL('').replace(/\/$/, '');

// DSH Web GUI 的本地地址（webServer 服务监听处）；自动发现桥的 port+token
// 若你的 DSH Web 端口不是 3080，请同步修改此处。
const DSH_ORIGIN = 'http://127.0.0.1:3080';
const BRIDGE_INFO_PATH = '/dsh-bib/bridge-info';

// ---------------- 桥通信 ----------------
async function post(path, body) {
  const res = await fetch(state.base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bib-Token': state.cfg.token,
      'Origin': extOrigin(),
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error('bridge ' + res.status);
  return res;
}

async function getCmd() {
  const res = await fetch(state.base + '/command', {
    method: 'GET',
    headers: { 'X-Bib-Token': state.cfg.token, 'Origin': extOrigin() },
    cache: 'no-store',
  });
  if (res.status !== 200) return null;
  const j = await res.json();
  return j && j.cmd ? j : null;
}

// ---------------- 标签持久化（SW 重启后恢复 attach） ----------------
async function rememberTab(tabId) {
  try {
    const cur = await chrome.storage.local.get('bib');
    await chrome.storage.local.set({ bib: cur.bib || {}, bibTab: tabId });
  } catch { /* ignore */ }
}
async function forgetTab() {
  try { await chrome.storage.local.remove('bibTab'); } catch { /* ignore */ }
}

// ---------------- 心跳注入（保活 SW，命令即时响应） ----------------
// MV3 SW 30s 空闲即被终止，且 setTimeout/fetch 不保活。唯一可靠手段：
// 被控页面持续产生渲染变化 → screencast 持续出帧 → chrome.debugger 事件
// 持续唤醒/保活 SW → 命令轮询永在线。注入 2px 隐藏动画（width 变化触发
// layout→绘制→screencast 出帧），对页面零视觉影响。
const HEARTBEAT_SCRIPT = `
(() => {
  try {
    if (document.getElementById('__bibBeatEl')) return;
    if (!document.getElementById('__bibBeatStyle')) {
      const st = document.createElement('style');
      st.id = '__bibBeatStyle';
      st.textContent = '@keyframes __bibBeat { 0%{width:2px;opacity:.98} 100%{width:3px;opacity:1} } #__bibBeatEl{position:fixed;left:0;top:0;width:2px;height:2px;opacity:.98;animation:__bibBeat .6s ease-in-out infinite alternate;pointer-events:none;z-index:2147483646;background:transparent}';
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = '__bibBeatEl';
    document.body.appendChild(el);
  } catch (e) {}
})();
`;

async function injectHeartbeat(tabId) {
  try {
    await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: HEARTBEAT_SCRIPT });
  } catch { /* ignore */ }
  try {
    await send(tabId, 'Runtime.evaluate', { expression: HEARTBEAT_SCRIPT });
  } catch { /* ignore */ }
}

// ---------------- AX 树：页面注入 DOM 遍历（比 CDP Accessibility 域可靠） ----------------
// 参考 chrome-mcp-server：从 DOM 推断 role/label，节点带 ref_* 稳定引用 + 视口坐标。
const AX_TREE_SCRIPT = `
(() => {
  const MAX_NODES = 800;
  const out = [];
  if (!window.__dshbibRefs) window.__dshbibRefs = {};
  if (!window.__dshbibRefCounter) window.__dshbibRefCounter = 0;
  const INTERACTIVE = new Set(['button','link','checkbox','combobox','menuitem','radio','slider','spinbutton','textbox','searchbox','listbox','tab','switch','treeitem','option','menu','heading']);
  const inferRole = (el) => {
    const role = el.getAttribute && el.getAttribute('role');
    if (role) return role;
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type')) || '';
    const map = { a:'link', button:'button', input: type==='submit'||type==='button'?'button':type==='checkbox'?'checkbox':type==='radio'?'radio':'textbox', select:'combobox', textarea:'textbox', h1:'heading',h2:'heading',h3:'heading',h4:'heading',h5:'heading',h6:'heading', img:'image', nav:'navigation', main:'main', header:'banner', footer:'contentinfo', section:'region', article:'article', aside:'complementary', form:'form', table:'table', ul:'list', ol:'list', li:'listitem', label:'label' };
    return map[tag] || 'generic';
  };
  const inferLabel = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const tag = (el.tagName||'').toLowerCase();
    if (tag==='input') { const v=el.value||''; if (v && v.length<50 && v.trim()) return v.trim(); }
    if (['button','a','summary'].includes(tag)) {
      let t=''; for (const n of el.childNodes) if (n.nodeType===3) t+=n.textContent||'';
      if (t.trim()) return t.trim();
      // 标题常包在嵌套元素内（如小红书卡片 <a class="title"> 内是 span）：回退取 textContent
      const all = (el.textContent || '').trim();
      if (all) return all.slice(0, 120);
    }
    return '';
  };
  const walk = (el, depth) => {
    if (out.length >= MAX_NODES || depth > 30) return;
    for (const child of el.children) {
      const role = inferRole(child);
      if (INTERACTIVE.has(role)) {
        const rect = child.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < (window.innerHeight||800) && rect.right > 0 && rect.left < (window.innerWidth||1200)) {
          const name = inferLabel(child);
          if (!name && role !== 'textbox' && role !== 'image') continue;
          const ref = 'ref_' + (++window.__dshbibRefCounter);
          try { window.__dshbibRefs[ref] = new WeakRef(child); } catch (e) { window.__dshbibRefs[ref] = child; }
          out.push({ role, name: (name||'').slice(0,100), ref, x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(document.body || document.documentElement, 0);
  return out;
})()
`;

// ---------------- CDP 生命周期 ----------------
async function attachTab(tabId) {
  if (state.attached.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
  state.attached.add(tabId);
  await send(tabId, 'Page.enable');
  await send(tabId, 'Runtime.enable');
  // 心跳注入不阻塞：后台标签页面加载早期 CDP 命令可能挂起，heartbeat 只是保活辅助
  injectHeartbeat(tabId).catch(() => {});
}

async function startScreencast(tabId) {
  if (!state.attached.has(tabId)) return;
  await send(tabId, 'Page.startScreencast', {
    format: 'jpeg', quality: 40, maxWidth: 800, everyNthFrame: 3,
  });
}

async function stopScreencast(tabId) {
  if (!state.attached.has(tabId)) return;
  try { await send(tabId, 'Page.stopScreencast'); } catch { /* ignore */ }
}

function waitLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    state.loadWait = { tabId, resolve, reject };
    state.loadTimer = setTimeout(() => {
      if (state.loadWait && state.loadWait.tabId === tabId) {
        const w = state.loadWait;
        state.loadWait = null;
        w.reject(new Error('load timeout'));
      }
    }, timeoutMs);
  });
}

function resolveLoad(tabId) {
  if (state.loadWait && state.loadWait.tabId === tabId) {
    const w = state.loadWait;
    state.loadWait = null;
    clearTimeout(state.loadTimer);
    w.resolve({});
  }
}

// ---------------- 命令实现 ----------------
async function doNavigate(tabId, url) {
  // 导航不需要激活标签：后台标签也能加载（画面靠周期截帧更新），
  // 不打扰用户当前的浏览器焦点。仅 attach 保持控制。
  const loadP = waitLoad(tabId, 15000);
  await send(tabId, 'Page.navigate', { url });
  await loadP;
  const t = state.tabs.get(tabId);
  return { ok: true, result: { url: (t && t.url) || url, title: (t && t.title) || '' } };
}

async function doGo(tabId, direction) {
  const hist = await send(tabId, 'Page.getNavigationHistory');
  const entries = (hist.entries || []).filter((e) => !e.transitionType || true);
  const idx = hist.currentIndex;
  const target = direction === 'back' ? idx - 1 : idx + 1;
  if (target < 0 || target >= entries.length) {
    return { ok: false, error: { code: 'NO_HISTORY' } };
  }
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[target].id });
  return { ok: true, result: {} };
}

async function doReload(tabId) {
  await send(tabId, 'Page.reload', { ignoreCache: false });
  return { ok: true, result: {} };
}

// DOM 派发完整点击序列（后台标签可用，不切走浏览器焦点）
const CLICK_SCRIPT = (refOrNull, x, y) => `
new Promise((resolve) => {
  (() => {
    let el = null;
    if (${refOrNull !== null ? 'window.__dshbibRefs && window.__dshbibRefs[' + JSON.stringify(refOrNull) + ']' : 'null'}) {
      const t = (window.__dshbibRefs && window.__dshbibRefs[${JSON.stringify(String(refOrNull))}]);
      el = t && typeof t.deref === 'function' ? t.deref() : t;
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    } else if (typeof ${x} === 'number' && typeof ${y} === 'number') {
      el = document.elementFromPoint(${x}, ${y});
    }
    if (!el || !el.isConnected) return resolve({ ok: false, error: 'target not found' });
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    const dispatch = (type) => el.dispatchEvent(new MouseEvent(type, opts));
    dispatch('mouseover');
    dispatch('mousemove');
    dispatch('mousedown');
    dispatch('mouseup');
    dispatch('click');
    // 表单元素真实聚焦：DOM 点击后让浏览器焦点落在目标上（后续 DOM 输入依赖 activeElement）
    try { if (el.focus) el.focus(); } catch { /* ignore */ }
    resolve({ ok: true, x: Math.round(cx), y: Math.round(cy) });
  })();
})`;

async function doClick(tabId, x, y, ref) {
  // 优先 DOM 派发点击：后台标签也能用，不切走浏览器焦点（单标签锁定模型）
  try {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: CLICK_SCRIPT(ref || null, typeof x === 'number' ? x : null, typeof y === 'number' ? y : null),
      returnByValue: true, awaitPromise: true,
    });
    const v = r.result && r.result.value;
    if (v && v.ok) return { ok: true, result: {} };
  } catch { /* DOM 派发失败，回退 CDP */ }
  // 回退：CDP 坐标点击（需标签在前台；单标签锁定模型下此路径极少触发）
  if (ref) {
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        (() => {
          const t = (window.__dshbibRefs && window.__dshbibRefs[${JSON.stringify(String(ref))}]);
          const el = t && typeof t.deref === 'function' ? t.deref() : t;
          if (!el) return resolve({ error: 'ref not found' });
          el.scrollIntoView({ block: 'center', inline: 'center' });
          setTimeout(() => {
            const rect = el.getBoundingClientRect();
            resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }, 120);
        })();
      })`,
      returnByValue: true, awaitPromise: true,
    });
    const v = r.result && r.result.value;
    if (!v || v.error) {
      return { ok: false, error: { code: 'REF_NOT_FOUND', message: (v && v.error) || 'ref not found' } };
    }
    x = Math.round(v.x);
    y = Math.round(v.y);
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { ok: true, result: {} };
}

async function doScroll(tabId, x, y, dx, dy) {
  // DOM 滚动：后台标签可用，不切走浏览器焦点
  try {
    await send(tabId, 'Runtime.evaluate', {
      expression: `window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); 'ok'`,
      returnByValue: true,
    });
    return { ok: true, result: {} };
  } catch { /* DOM 滚动失败，回退 CDP */ }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx || 0, deltaY: dy || 0 });
  return { ok: true, result: {} };
}

async function doType(tabId, text) {
  const t = String(text || '');
  // DOM 方式输入（后台可用，不切走）：聚焦当前激活元素 → 设置值 → 派发 input 事件。
  // 对 React/Vue 受控组件用原生 setter 触发（避免框架检测不到变更）。
  // 失败（无聚焦输入元素）回退 CDP Input.insertText（需前台；单标签锁定模型下极少触发）。
  try {
    const esc = (s) => JSON.stringify(s);
    const r = await send(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement;
        if (!el || !el.isConnected) return { ok: false, error: 'no focused input' };
        const tag = el.tagName.toLowerCase();
        const isField = tag === 'input' || tag === 'textarea' || el.isContentEditable;
        if (!isField) return { ok: false, error: 'focused el not field: ' + tag };
        const value = ${esc(t.endsWith('\n') ? t.slice(0, -1) : t)};
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype
          : el.isContentEditable ? null : HTMLInputElement.prototype;
        if (proto) {
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, value);
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    const v = r.result && r.result.value;
    if (v && v.ok) {
      if (t.endsWith('\n')) {
        // 回车：派发 keydown Enter（DOM 方式，后台可用）
        await send(tabId, 'Runtime.evaluate', {
          expression: `(() => {
            const el = document.activeElement;
            if (!el) return 'no';
            const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', o));
            el.dispatchEvent(new KeyboardEvent('keyup', o));
            return 'ok';
          })()`,
          returnByValue: true,
        });
      }
      return { ok: true, result: {} };
    }
  } catch { /* DOM 输入失败，回退 CDP */ }
  // 回退：CDP Input.insertText（需前台标签）
  if (t.endsWith('\n')) {
    await send(tabId, 'Input.insertText', { text: t.slice(0, -1) });
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  } else {
    await send(tabId, 'Input.insertText', { text: t });
  }
  return { ok: true, result: {} };
}

async function doEval(tabId, expression) {
  const r = await send(tabId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    return { ok: false, error: { code: 'EVAL_ERROR', message: String(r.exceptionDetails.text || '') } };
  }
  return { ok: true, result: { value: r.result && r.result.value } };
}

async function doTree(tabId) {
  const r = await send(tabId, 'Runtime.evaluate', { expression: AX_TREE_SCRIPT, returnByValue: true });
  return { ok: true, result: { nodes: (r.result && r.result.value) || [] } };
}

async function doScreenshot(tabId) {
  // 实时截帧优先：screencast 在页面静止/后台时被节流，缓存 lastFrame 会永远停留旧画面。
  // captureScreenshot 失败（页面加载中/未就绪）才回退缓存帧。
  try {
    const shot = await send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    if (shot && shot.data) {
      let width = 0;
      let height = 0;
      try {
        const metrics = await send(tabId, 'Page.getLayoutMetrics');
        // captureScreenshot 截的是视口：尺寸必须用视口（cssVisualViewport），
        // 用 cssContentSize（整页内容）会导致 Client 点击坐标换算错位。
        const vp = metrics.cssVisualViewport;
        if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
          width = Math.round(vp.clientWidth); height = Math.round(vp.clientHeight);
        } else {
          const size = metrics.cssContentSize || metrics.contentSize;
          if (size) { width = Math.round(size.width); height = Math.round(size.height); }
        }
      } catch { /* ignore */ }
      state.lastFrame = { data: shot.data, width, height, seq: Date.now() };
      return { ok: true, result: { data: shot.data, width, height, seq: state.lastFrame.seq } };
    }
  } catch { /* 实时截帧失败，回退缓存 */ }
  if (state.lastFrame) {
    return { ok: true, result: { data: state.lastFrame.data, width: state.lastFrame.width, height: state.lastFrame.height, seq: state.lastFrame.seq } };
  }
  return { ok: false, error: { code: 'NO_FRAME', message: '实时截帧失败且无缓存帧' } };
}

async function doActivate(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true, result: {} };
}

async function doNewTab(url) {
  // creatingOwn：我们自己创建的标签不受 onCreated 关闭逻辑干预（防自伤竞态）
  state.creatingOwn = true;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  } finally {
    state.creatingOwn = false;
  }
  state.tabs.set(tab.id, { url: tab.url || '', title: tab.title || '' });
  if (state.tabId != null) await stopScreencast(state.tabId);
  state.tabId = tab.id;
  let needGesture = false;
  try {
    await attachTab(tab.id);
    await startScreencast(tab.id);
    await rememberTab(tab.id);
  } catch (e) {
    needGesture = true;
  }
  return { ok: true, result: { tabId: tab.id, needGesture } };
}

async function doSwitch(tabId) {
  if (!state.tabs.has(tabId)) return { ok: false, error: { code: 'NO_SUCH_TAB' } };
  if (state.tabId != null && state.tabId !== tabId) await stopScreencast(state.tabId);
  state.tabId = tabId;
  // 显式切换标签：带到前台（单标签模型的显式例外）
  try { await chrome.tabs.update(tabId, { active: true }); } catch { /* ignore */ }
  let needGesture = false;
  try {
    await attachTab(tabId);
    await startScreencast(tabId);
    await rememberTab(tabId);
  } catch (e) {
    needGesture = true;
  }
  const t = state.tabs.get(tabId);
  try {
    await post('/event', { type: 'state', url: (t && t.url) || '', title: (t && t.title) || '' });
  } catch { /* ignore */ }
  return { ok: true, result: { tabId, needGesture } };
}

async function doClose(tabId) {
  if (state.attached.has(tabId)) {
    try { await new Promise((res) => chrome.debugger.detach({ tabId }, res)); } catch { /* ignore */ }
    state.attached.delete(tabId);
  }
  state.tabs.delete(tabId);
  if (state.tabId === tabId) {
    state.tabId = null;
    state.lastFrame = null;
    forgetTab();
    const next = state.tabs.keys().next().value;
    if (next != null) {
      state.tabId = next;
      try { await startScreencast(next); } catch { /* ignore */ }
    }
  }
  try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
  return { ok: true, result: {} };
}

async function doTabs() {
  const list = [];
  let focused = null;
  try {
    const q = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    focused = q && q[0] ? q[0].id : null;
  } catch { /* ignore */ }
  for (const [id, t] of state.tabs) {
    list.push({ tabId: id, url: t.url, title: t.title, active: id === state.tabId, focused: id === focused });
  }
  return { ok: true, result: { tabs: list } };
}

async function doStop() {
  for (const id of [...state.attached]) {
    try { await new Promise((res) => chrome.debugger.detach({ tabId: id }, res)); } catch { /* ignore */ }
  }
  state.attached.clear();
  state.tabs.clear();
  state.tabId = null;
  state.lastFrame = null;
  forgetTab();
  return { ok: true, result: {} };
}

// ---------------- 命令分发 ----------------
async function dispatch(cmd, tabId) {
  switch (cmd.cmd) {
    case 'navigate':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doNavigate(tabId, cmd.url);
    case 'go':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doGo(tabId, cmd.direction);
    case 'reload':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doReload(tabId);
    case 'click':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doClick(tabId, cmd.x, cmd.y, cmd.ref);
    case 'scroll':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doScroll(tabId, cmd.x, cmd.y, cmd.dx, cmd.dy);
    case 'type':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doType(tabId, cmd.text);
    case 'eval':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doEval(tabId, cmd.expression);
    case 'tree':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doTree(tabId);
    case 'screenshot':
      if (tabId == null || !state.attached.has(tabId)) return notAttached();
      return await doScreenshot(tabId);
    case 'activate':
      if (tabId == null) return notAttached();
      return await doActivate(tabId);
    case 'newTab':
      return await doNewTab(cmd.url);
    case 'switch':
      return await doSwitch(cmd.tabId);
    case 'close':
      return await doClose(cmd.tabId);
    case 'tabs':
      return await doTabs();
    case 'stop':
      return await doStop();
    case 'ping':
      return { ok: true, result: { pong: true } };
    default:
      return { ok: false, error: { code: 'UNKNOWN_CMD', message: String(cmd.cmd) } };
  }
}

async function execute(cmd) {
  const tabId = cmd.tabId !== undefined ? cmd.tabId : state.tabId;
  // 单标签锁定模型：click/scroll/type 均已 DOM 化（后台可用，不切走浏览器焦点）。
  // 无命令需要强制前台 —— 浏览器焦点完全不受 AI 操作影响。
  // 交互命令打时间戳：随后的空白弹窗可归因于本次模型操作并自动关闭
  if (cmd.cmd === 'click' || cmd.cmd === 'type' || cmd.cmd === 'navigate' ||
      cmd.cmd === 'scroll' || cmd.cmd === 'go' || cmd.cmd === 'reload' || cmd.cmd === 'switch') {
    state.lastModelOpAt = Date.now();
  }
  try {
    return await Promise.race([
      dispatch(cmd, tabId),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('执行超时（8s）：' + cmd.cmd)), 8000);
      }),
    ]);
  } catch (e) {
    return { ok: false, error: { code: 'CMD_TIMEOUT', message: String((e && e.message) || e) } };
  }
}

function notAttached() {
  return { ok: false, error: { code: 'NOT_ATTACHED', message: '未 attach：请在 Edge 打开扩展 popup 并点击「连接」' } };
}

// ---------------- 命令轮询（串行，双层超时防卡死） ----------------
async function pollLoop() {
  if (state.polling) return;
  state.polling = true;
  try {
    while (state.base) {
      const cmd = await getCmd();
      if (!cmd) {
        await sleep(50);
        continue;
      }
      let res;
      try {
        res = await Promise.race([
          execute(cmd),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('loop-timeout:' + cmd.cmd)), 12000);
          }),
        ]);
      } catch (e) {
        res = { ok: false, error: { code: 'LOOP_TIMEOUT', message: String((e && e.message) || e) } };
      }
      state.lastCmd = { cmd: cmd.cmd, ok: res.ok, error: res.error, at: Date.now() };
      try {
        await post('/event', {
          type: 'cmdResult', id: cmd.id, ok: res.ok,
          ...(res.ok ? { result: res.result } : { error: res.error }),
        });
      } catch { /* bridge died mid-report */ }
    }
  } catch {
    state.base = null;
    scheduleReconnect();
  } finally {
    state.polling = false;
  }
}

// ---------------- 断线重连 ----------------
let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer || !state.cfg) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!state.cfg) return;
    state.base = 'http://127.0.0.1:' + state.cfg.port;
    let ok = false;
    try {
      const res = await fetch(state.base + '/ping', {
        headers: { 'X-Bib-Token': state.cfg.token, 'Origin': extOrigin() },
        cache: 'no-store',
      });
      ok = res.status === 200;
    } catch { /* ping 失败 */ }
    if (ok) {
      pollLoop();
    } else {
      // 旧端口不通（桥重启换端口）：立即重新发现，不等 alarms
      const discovered = await autoDiscover();
      if (discovered) pollLoop();
      else scheduleReconnect();
    }
  }, 3000);
}

// ---------------- CDP 事件 ----------------
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!state.attached.has(src.tabId)) return;
  switch (method) {
    case 'Page.screencastFrame': {
      chrome.debugger.sendCommand(src, 'Page.screencastFrameAck', { sessionId: params.sessionId }, () => {});
      state.lastFrame = {
        seq: params.metadata.timestamp,
        data: params.data,
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight,
      };
      if (state.base) post('/frame', state.lastFrame).catch(() => {});
      break;
    }
    case 'Page.frameNavigated':
      if (!params.frame.parentId) {
        const t = state.tabs.get(src.tabId);
        const url = params.frame.url;
        if (t) t.url = url; else state.tabs.set(src.tabId, { url, title: '' });
        if (src.tabId === state.tabId && state.base) {
          post('/event', { type: 'state', url, title: t ? (t.title || '') : '' }).catch(() => {});
        }
      }
      break;
    case 'Page.titleChanged': {
      const t = state.tabs.get(src.tabId);
      if (t) t.title = params.title; else state.tabs.set(src.tabId, { url: '', title: params.title });
      if (src.tabId === state.tabId && state.base) {
        post('/event', { type: 'state', url: t ? (t.url || '') : '', title: params.title }).catch(() => {});
      }
      break;
    }
    case 'Page.domContentEventFired':
      resolveLoad(src.tabId);
      break;
  }
});

chrome.debugger.onDetach.addListener((src) => {
  if (state.attached.has(src.tabId)) {
    state.attached.delete(src.tabId);
    if (src.tabId === state.tabId) {
      state.lastFrame = null;
      forgetTab();
    }
    if (state.base) post('/event', { type: 'detached' }).catch(() => {});
  }
});

// ---------------- 单标签锁定模型 ----------------
// 需求：AI 固定操作一个标签页，所有操作（点击/输入/滚动/截图）都在那个标签页上渲染。
// 因此：点击 target=_blank 弹出的新标签 → 立即关闭，焦点留在原标签；
// 不再接管浏览器激活的其它标签（含 DSH GUI），AI 视角锁定当前标签不变。

// DSH GUI 自身页面（用户操作模型的界面）不是要控制的网页：一律不接管，
// 避免用户切回 GUI 时预览/树变成 GUI 自己（无意义递归），保持目标网页不跳变。
function isDshPage(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.origin === DSH_ORIGIN || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

// 新标签处理：单标签锁定 —— 关闭"从当前 attach 标签弹出"的新标签。
// target=_blank 链接通常带 openerTabId，直接归因关闭；
// 现代站点用 noopener/noreferrer（openerTabId 为 null）或 window.open('') 开的
// 空白标签无法靠 opener 归因 —— 用"空白页 + 刚有模型交互"启发式兜底关闭，
// 避免空白标签堆积，同时不干预用户自己（非模型操作期间）开的标签。
function isBlankUrl(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return u === 'about:blank' || u.startsWith('about:blank#') || u === 'about:blank#blocked';
}
chrome.tabs.onCreated.addListener((tab) => {
  if (!state.base || !tab || tab.id == null) return;
  if (state.creatingOwn) return; // 我们自己创建/接管的标签（newTab/连接流程）：不干预
  if (isDshPage(tab.url)) return; // DSH 自身页面不处理
  if (tab.id === state.tabId || state.tabs.has(tab.id)) return; // 我们自己控制中的标签不动
  const fromAttached = tab.openerTabId != null && state.attached.has(tab.openerTabId);
  const blankPopup = isBlankUrl(tab.url) && (Date.now() - state.lastModelOpAt) < 1200;
  if (!fromAttached && !blankPopup) return; // 非本页弹出/非模型操作触发的空白页：不干预
  // 关闭它，焦点自然回到原标签，AI 继续在原标签操作
  try { chrome.tabs.remove(tab.id); } catch { /* ignore */ }
  // 若原标签因新标签弹出而失去焦点，确保仍被控制（无需切 attach，attach 按 tabId 保持）
});

// 不再跟随浏览器激活标签：AI 视角锁定当前控制标签（state.tabId）不变。
// 用户切到其它标签（含 DSH GUI）不会改变 AI 操作的标签页。
// 注意：chrome.tabs.onActivated 不再接管 —— 若需要切换标签，由模型显式调用
// browser_switch / browser_open（走命令链路 attach+激活），而不是被动跟随。

// ---------------- 保活（MV3 SW 30s 空闲限制） ----------------
setInterval(() => {
  if (state.base && state.tabId != null && state.attached.has(state.tabId)) {
    send(state.tabId, 'Runtime.evaluate', { expression: 'void 0' }).catch(() => {});
  }
}, 25000);

// ---------------- popup 消息 ----------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'connect') {
    state.cfg = { origin: msg.origin, port: msg.port, token: msg.token };
    state.base = 'http://127.0.0.1:' + msg.port;
    chrome.storage.local.set({ bib: state.cfg });
    (async () => {
      let note = '已连接';
      try {
        let tabId = state.tabId;
        if (tabId == null) {
          state.creatingOwn = true;
          let tab;
          try {
            tab = await chrome.tabs.create({ url: 'about:blank', active: false });
          } finally {
            state.creatingOwn = false;
          }
          tabId = tab.id;
          state.tabs.set(tabId, { url: '', title: '' });
          state.tabId = tabId;
        }
        if (!state.attached.has(tabId)) {
          await attachTab(tabId);
          await startScreencast(tabId);
          note = '已连接并 attach';
        }
      } catch (e) {
        note = '连接失败：' + String((e && e.message) || e);
      }
      sendResponse({ ok: true, note });
      pollLoop();
    })();
    return true;
  }
  if (msg.type === 'status') {
    sendResponse({
      connected: !!state.base,
      attached: state.tabId != null && state.attached.has(state.tabId),
      tabId: state.tabId,
      tabs: [...state.tabs.keys()],
      base: state.base,
      cfgPort: state.cfg ? state.cfg.port : null,
      polling: state.polling,
      lastCmd: state.lastCmd || null,
    });
    return false;
  }
  if (msg.type === 'adopt') {
    // popup 已在手势上下文完成 attach；SW 接管状态并接管事件流
    state.tabId = msg.tabId;
    state.tabs.set(msg.tabId, { url: '', title: '' });
    state.attached.add(msg.tabId);
    rememberTab(msg.tabId);
    if (state.base) post('/event', { type: 'state', url: '', title: '' }).catch(() => {});
    pollLoop();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'disconnect') {
    state.cfg = null;
    state.base = null;
    chrome.storage.local.remove(['bib', 'bibTab']);
    for (const id of [...state.attached]) {
      try { chrome.debugger.detach({ tabId: id }, () => {}); } catch { /* ignore */ }
    }
    state.attached.clear();
    state.tabs.clear();
    state.tabId = null;
    state.lastFrame = null;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------------- 自动发现（经 DSH Web 路由拿桥信息，免手动配对） ----------------
async function autoDiscover() {
  try {
    const res = await fetch(DSH_ORIGIN + BRIDGE_INFO_PATH, {
      headers: { 'Origin': extOrigin() },
      cache: 'no-store',
    });
    if (res.status !== 200) return false;
    const j = await res.json();
    if (!j || !j.available || typeof j.port !== 'number' || typeof j.token !== 'string') {
      return false;
    }
    const changed = !state.cfg || state.cfg.port !== j.port || state.cfg.token !== j.token;
    state.cfg = { origin: extOrigin(), port: j.port, token: j.token };
    state.base = 'http://127.0.0.1:' + j.port;
    chrome.storage.local.set({ bib: state.cfg });
    if (changed) {
      // 端口/token 变化（桥重启）：清空旧标签状态，重新连接
      state.attached.clear();
      state.tabs.clear();
      state.tabId = null;
      state.lastFrame = null;
    }
    pollLoop();
    return true;
  } catch {
    return false;
  }
}

// ---------------- SW 启动恢复 + 自动发现轮询 ----------------
async function restoreAttach() {
  const stored = await chrome.storage.local.get(['bib', 'bibTab']);
  if (!stored.bib) return;
  state.cfg = stored.bib;
  state.base = 'http://127.0.0.1:' + stored.bib.port;
  if (stored.bibTab) {
    try {
      const tab = await chrome.tabs.get(stored.bibTab);
      if (tab && tab.id != null) {
        state.tabId = tab.id;
        state.tabs.set(tab.id, { url: tab.url || '', title: tab.title || '' });
        if (!state.attached.has(tab.id)) {
          try {
            await attachTab(tab.id);
            await startScreencast(tab.id);
          } catch { /* attach 失败：等 popup 手势或下个命令 */ }
        }
        if (state.base) {
          post('/event', { type: 'state', url: tab.url || '', title: tab.title || '' }).catch(() => {});
        }
      }
    } catch { /* 标签已关闭 */ }
  }
  pollLoop();
}

(async function init() {
  await restoreAttach();
  await autoDiscover();
  // 周期唤醒：MV3 SW 会被浏览器终止，alarms 保证每分钟唤醒重新发现桥并恢复命令轮询
  chrome.alarms.create('bib-alive', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bib-alive') {
      autoDiscover().then((ok) => {
        if (ok && !state.attached.size) restoreAttach();
      }).catch(() => {});
    }
  });
})();
