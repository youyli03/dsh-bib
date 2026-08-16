# dsh-bib 设计① — Edge 扩展详细设计（MV3）

> 组件：`extension/`，Chromium 扩展（Chrome / Edge 通用，MV3）
> 定位：用户真实浏览器里的「代理」——用 `chrome.debugger` 拿到真实标签页的 CDP，把帧流和状态上送中继桥，从中继桥取命令执行。
> 配套：`bridge-api.md`（桥契约）、`design-v2.md`（总纲）

## 1. 职责边界

扩展**只做三件事**，不存业务状态、不落盘任何页面内容：

1. **attach**：经用户手势 attach 一个专用标签页，建立 CDP 会话。
2. **上行**：把 `screencastFrame` 帧和页面状态（url/title）POST 给中继桥。
3. **下行**：长轮询中继桥取待执行命令，转成 CDP 命令执行，结果回传。

扩展**不做**：桥的启动/停止（Host 管）、token 生成（Host 管）、帧缓存（Host 管）、任何鉴权决策——它只认「配置好的桥地址 + token」。

## 2. 项目结构

```
extension/
├── manifest.json
├── background.js        # service worker：attach、命令循环、帧转发
├── popup/
│   ├── popup.html       # 配对/attach/状态 弹窗
│   ├── popup.js
│   └── popup.css
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md            # 安装指引（开发者模式加载）
```

## 3. manifest.json（完整示例）

```json
{
  "manifest_version": 3,
  "name": "dsh-bib bridge",
  "version": "0.1.0",
  "description": "DSH 内嵌浏览器：真实标签页 CDP 代理",
  "minimum_chrome_version": "116",

  "permissions": ["debugger", "tabs", "storage"],

  "background": {
    "service_worker": "background.js"
  },

  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "dsh-bib bridge",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },

  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

要点：

- **不要** `host_permissions`（不需要访问任意站点；CDP 命令由 debugger 权限承担，帧在 SW 内处理不碰页面 DOM）。
- `"debugger"` 权限是 attach 的前提；`"tabs"` 用于打开/定位专用标签页；`"storage"` 持久化配对信息。
- 无 `externally_connectable`：桥 ↔ 扩展走 HTTP，不用 `chrome.runtime` 消息通道。

## 4. 状态机（扩展视角）

```
        popup 粘贴配对信息
  idle ────────────────────► connecting
  │  ▲                          │ chrome.debugger.attach 成功
  │  │ attach 失败/超时          ▼
  │  └────────────────────── attached ◄──┐
  │        ▲                  │   │      │ SW 被杀后重启
  │        │                  │   ▼      │
  │        │          startScreencast    │
  │        │                  │          │
  │        └──────────────────┘          │
  │          detach / 页面关闭 / 桥失联     │
  └──────────────────────────────────────┘
```

- `idle`：未配置桥地址，或用户点「断开」。
- `connecting`：已拿到桥地址+token，尝试 `chrome.debugger.attach`（attach 必须在用户手势内调用，见 §7）。
- `attached`：CDP 会话建立、screencast 已启动、命令循环运行中。
- SW 被浏览器杀掉（空闲 ~30s）后重启：从 `chrome.storage.local` 读配对信息，若曾处于 `attached` 则自动重连（幂等：目标标签页可能还在，直接重新 attach）。

## 5. 配对流程（一次性）

1. Host 启动桥 → 面板显示连接码：`127.0.0.1:<port>#<token>`（token 8 字节随机 hex，见 `bridge-api.md` §6）。
2. 用户打开扩展 popup，粘贴连接码（或点「自动探测」——popup 向 Host 面板留的约定端口探测，v1 不做，纯手贴）。
3. popup 校验格式 → `chrome.storage.local.set({bridge:{origin, port, token}})` → 触发 `background.js` 开始连接。
4. 连接成功后 popup 显示「已连接 · 端口 <port>」+ 状态灯；失败显示原因。

配对信息只存 `chrome.storage.local`（扩展私有），不经过任何网页。

## 6. background.js 逻辑设计

### 6.1 全局状态（内存）

```js
const state = {
  cfg: null,          // {origin, port, token} 来自 storage
  tabId: null,        // 专用标签页
  attached: false,
  screencastOn: false,
  pendingCmds: new Map(),  // 命令执行中的并发控制（v1 串行，见下）
  pollTimer: null,
}
```

### 6.2 专用标签页（不抢用户当前页）

```js
// 优先复用上次的专用标签页；否则新开一个
async function ensureTarget() {
  if (state.tabId && (await chrome.tabs.get(state.tabId)).id) return state.tabId;
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  state.tabId = tab.id;
  return tab.id;
}
```

- `active: false`：不打断用户当前浏览（但仍需窗口可见，见限制 §8）。
- 目标标签页 URL 统一由 `browser_open` 的导航命令决定，扩展不预设。

### 6.3 attach（用户手势内调用）

```js
chrome.debugger.attach({ tabId }, '1.3', () => {
  if (chrome.runtime.lastError) { /* 上报失败 */ return; }
  state.attached = true;
  chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
    format: 'jpeg', quality: 55, maxWidth: 1200, everyNthFrame: 3,
  });
  startPolling();
});
```

### 6.4 帧上行（必须 ack）

```js
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId !== state.tabId) return;
  switch (method) {
    case 'Page.screencastFrame':
      // 先 ack，否则帧流停止
      chrome.debugger.sendCommand(src, 'Page.screencastFrameAck', { sessionId: params.sessionId });
      post('/frame', { seq: params.metadata.timestamp, data: params.data, width: params.metadata.deviceWidth, height: params.metadata.deviceHeight });
      break;
    case 'Page.frameNavigated':
      if (!params.frame.parentId) post('/event', { type: 'state', url: params.frame.url, title: '' });
      break;
    case 'Page.titleChanged':
      post('/event', { type: 'state', url: currentUrl, title: params.title });
      break;
    case 'Page.domContentEventFired':
      // 供 navigate 命令「等待加载完成」判定使用（见 6.6）
      resolveLoadWait();
      break;
  }
});
```

### 6.5 命令下行（长轮询，串行执行）

```js
async function pollOnce() {
  const cmd = await fetchJson(`${base}/command`, { timeout: 12000 });
  if (cmd) {
    const res = await execute(cmd);       // 串行：一次只执行一条
    post('/event', { type: 'cmdResult', id: cmd.id, ok: res.ok, result: res.result });
  }
  if (state.attached) pollTimer = setTimeout(pollOnce, 50);  // 无命令间隔 50ms
}
```

- 长轮询挂起时间：桥侧 `GET /command` 最长挂起 ~10s，无命令返回空 → 扩展立即再轮询（间隔 50ms），形成稳定的低延迟下行通道。
- **串行执行**：v1 只允许一条命令在途，避免并发 CDP 命令互相干扰（如点击与导航同时发生）。高吞吐场景 v2 再引入命令 id 并发。

### 6.6 CDP 命令映射表

| 桥命令 `cmd` | CDP 实现 | 备注 |
|---|---|---|
| `navigate {url}` | `Page.navigate {url}` + 等待 `domContentEventFired` | 超时 15s |
| `go {direction}` | `Page.navigateToHistoryEntry`（需先 `Page.getNavigationHistory` 取 entryId） | back/forward |
| `reload` | `Page.reload {ignoreCache:false}` | |
| `click {x,y}` | `Input.dispatchMouseEvent` ×2：`mousePressed` → `mouseReleased`，`button:'left', clickCount:1` | 坐标 = 视口 CSS 像素 |
| `scroll {x,y,dx,dy}` | `Input.dispatchMouseEvent` ×2：`mouseWheel {x,y,deltaX:dx,deltaY:dy}`（先 mouseMoved 到 x,y） | |
| `type {text}` | `Input.insertText {text}`；text 以 `\n` 结尾则追加 `Input.dispatchKeyEvent`（`keyDown`/`keyUp`, `key:'Enter'`） | 绕过 IME，中文可用 |
| `eval {expression}` | `Runtime.evaluate {expression, returnByValue:true, awaitPromise:true}` | 返回 `result.value` 或序列化错误 |
| `screenshot` | 返回最近一帧缓存（Host 侧处理，见 `host-plugin.md`） | 不额外截图，省流量 |
| `cdp {method,params}` | `chrome.debugger.sendCommand({tabId}, method, params)` | 透传逃生门，工具不直接暴露 |
| `stop` | 停 screencast → detach → 关闭专用标签页 | 桥/插件停止时下发 |

### 6.7 保活与重连

- **SW 30s 空闲限制**：screencast 帧事件本身会唤醒/续命 SW（事件驱动的 SW 在收到 debugger 事件时被唤醒）；帧率 ~3-5 fps 足够维持活跃。若页面完全静止（长页面无变化），`everyNthFrame:3` 可能停帧 → 兜底：每 25s 由扩展主动发一次 `Page.startScreencast`（幂等）或 `Runtime.evaluate('void 0')` 制造事件。
- **断线重连**：`fetch` 失败（桥未启动/重启）→ 停止轮询、置 `attached=false` 但**保留配对信息**；每 3s 重试探测桥（`GET /ping`），恢复后自动重新 attach + 重开 screencast。
- **浏览器重启**：SW 与标签页都没了 → 从 storage 恢复配对 → 等用户下次手势 attach（attach 需手势，见 §7）。

## 7. 关键约束与坑

1. **`chrome.debugger.attach` 需要用户手势**（新版 Chromium 要求）：只能在 popup 点击、或面板按钮触发的消息处理里调用。**SW 启动时的自动重连不能在后台直接 attach**——必须等下一次用户交互，或由 popup 打开动作携带手势。设计对策：SW 恢复后进入 `connecting(需手势)` 状态，popup 打开即视为手势信号（popup 打开本身是用户手势）。
2. **每帧必须 `screencastFrameAck`**：漏 ack 帧流会静默停止——ack 必须与业务处理解耦（先 ack 再 POST）。
3. **不要 attach 用户当前活跃标签**：专用标签页策略（§6.2）同时满足「不打扰用户」和「attach 手势可及」。
4. **调试黄条**：attach 期间目标标签页顶部出现「此标签页正在被调试」提示，无法去除（已知限制）。
5. **帧 POST 失败不重试帧**：帧是实时数据，丢帧即丢；只重试 `state`/`cmdResult` 等可靠事件（最多 2 次）。

## 8. 已知限制（扩展侧）

- 最小化/遮挡窗口可能触发 Chromium occlusion 节流 → 帧停；**专用窗口不要最小化**（v1 实测项）。
- 无法获取「用户未授权标签」的登录态——只操作专用标签页（符合设计：隔离、可控）。
- 无剪贴板读写（MV3 剪贴板受限）；`navigator.clipboard` 需要页面焦点 + 用户手势，v2 再议。
- 扩展需 unpacked 开发者模式安装（`edge://extensions` → 开发人员模式 → 加载解压缩的扩展），浏览器重装需重装。

## 9. 交付物（本组件）

```
extension/           # 上述结构
docs/extension-design.md   # 本文档
```

实现阶段（PoC 先行）：manifest + background.js（attach + 帧上行 + 单命令 `navigate`）+ popup（配对）即可验证全链路。
