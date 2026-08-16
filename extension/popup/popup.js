// dsh-bib popup：自动发现后仅需一次手势 attach + 状态
const $ = (id) => document.getElementById(id);
const dot = $('dot');
const stateEl = $('state');
const statusEl = $('status');
const input = $('code');
const codeRow = $('coderow');

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const dbg = s ? 'base=' + (s.base || 'null') + ' cfgPort=' + s.cfgPort + ' polling=' + s.polling +
    ' tab=' + (s.tabId || '-') +
    (s.lastCmd ? ' lastCmd=' + JSON.stringify(s.lastCmd) : ' lastCmd=none') : 'no-status';
  if (s && s.connected) {
    dot.className = 'dot ' + (s.attached ? 'on' : 'off');
    stateEl.textContent = s.attached ? '已连接 · 已 attach' : '已连接 · 未 attach';
    codeRow.style.display = 'none';
    statusEl.textContent = (s.attached ? '链路正常' : '正在尝试 attach…（若失败请点「连接」重试）') + '  [' + dbg + ']';
  } else {
    dot.className = 'dot off';
    stateEl.textContent = '未连接';
    codeRow.style.display = 'block';
    statusEl.textContent = '未发现 DSH 桥：确认 DSH 页面已打开且浏览器已启动（模型调用 browser_open）  [' + dbg + ']';
  }
}

// attach 流程：新建专用标签 → 手势上下文 attach → 启 screencast → SW 接管。
// 关键：attach 放在尽量靠近手势的路径，避免 await 消耗 user activation。
async function attachFlow() {
  statusEl.textContent = 'attach 中…';
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  } catch (e) {
    statusEl.textContent = '建标签失败：' + String((e && e.message) || e);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId: tab.id }, '1.3', () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve();
      });
    });
  } catch (e) {
    statusEl.textContent = 'attach 失败：' + String((e && e.message) || e) +
      '（若提示需用户手势，请点「连接」重试）';
    try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    return;
  }
  try {
    chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {}, () => {});
    chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable', {}, () => {});
    chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.startScreencast', {
      format: 'jpeg', quality: 40, maxWidth: 800, everyNthFrame: 3,
    }, () => {});
  } catch { /* ignore */ }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'adopt', tabId: tab.id });
    statusEl.textContent = (r && r.ok) ? '已连接并 attach 完成' : 'SW 接管失败';
  } catch (e) {
    statusEl.textContent = 'SW 接管失败：' + String((e && e.message) || e);
  }
  await refresh();
}

$('connect').addEventListener('click', () => { attachFlow(); });

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  statusEl.textContent = '已断开';
  await refresh();
});

refresh();

// 顶层自动尝试：点击扩展图标打开 popup 本身是用户手势，
// 若已自动发现桥且未 attach，直接在激活上下文中完成 attach。
(async function autoAttach() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'status' });
    if (s && s.connected && !s.attached) {
      await attachFlow();
    }
  } catch { /* ignore */ }
})();
