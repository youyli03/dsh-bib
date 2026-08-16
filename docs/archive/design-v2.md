# DSH「内嵌浏览器」插件 — 设计文档 v2（浏览器扩展 + 中继桥方案）

> 状态：方案定稿（会话讨论产物），待实现
> 日期：2026 年 · 会话讨论产物
> 目标运行时：DSH Web GUI（http://127.0.0.1:3080）
> 组件：动态 Cordis 插件（Host + Client）+ Edge 扩展（MV3）+ node 中继桥

## 0. 与 v1 的关系

- v1（`design.md`）：headless Edge + profile 拷贝方案，已定稿，但有两处硬伤。
- v2：浏览器扩展 + 中继桥方案，**作废** v1 的 §4（profile 拷贝）与 §2 的 headless 限制。
- 可复用部分：9 个 `browser_*` 工具、Client 面板结构、Host↔Client RPC、Host↔桥 JSONL 协议框架——全部沿用，仅底层通道更换。

## 1. 为什么换方案（v1 的两处硬伤）

1. **profile 拷贝「静默残缺」**：Edge 运行时拷贝 Cookies（SQLite WAL）/ Local Storage（LevelDB）会得到不一致快照——拷贝本身可能不报错，但登录态静默失效。比明确失败更糟。
2. **headless 检测**：个别站点会拒绝 headless 访问。

v2 通过「直接用用户真实浏览器的真实标签页」在结构上消灭这两个问题，而不是缓解。

## 2. 总体架构（四层）

```
用户真实 Edge（已登录、可见）
  └─ 扩展（MV3: chrome.debugger + screencast 帧流 + 命令轮询）
        │  127.0.0.1:<随机端口> + token + Origin 校验
        ▼
   node 中继桥（纯 HTTP 转发，无任何 Edge 逻辑）
        │  JSONL over stdio
        ▼
   Host 插件（browser_* 工具 + 帧缓存 + 桥生命周期）
        │  harness.handle('bib/*')   Client→Host 单向 RPC
        ▼
   Client 悬浮面板（shell.overlay 浮动层）
```

核心替换：不再「伪造一个 Edge」，而是让用户真实 Edge 里的扩展用 `chrome.debugger` 直接拿到真实标签页的 CDP。

## 3. 原理

### 3.1 chrome.debugger（CDP 通道）

- 扩展声明 `"debugger"` 权限后，可 attach 到自己的标签页，随后像 DevTools 一样收发任意 CDP 命令：`Page.navigate`、`Input.dispatchMouseEvent`、`Runtime.evaluate`、`Page.startScreencast`。
- **无需**远程调试端口、无需 headless、无需改浏览器启动参数。
- 注意：新版 Chrome 要求 `chrome.debugger.attach` 需要**用户手势** → 由扩展弹窗/面板的「attach」按钮点击天然满足。

### 3.2 登录态

页面即用户真实浏览器，cookie / localStorage 天然存在——**无需拷贝、无 DPAPI、无文件锁、无时效问题**。上一轮讨论的「锁」问题（拷贝可能静默残缺）在这里结构性消失。

### 3.3 帧流

`Page.startScreencast` → 每帧必须回 `screencastFrameAck` 否则流停（v1 已知坑，原样移到扩展实现）。

### 3.4 专用标签页

AI 控制时**新开一个专用标签页**并 attach 该页，不抢占用户当前正在用的标签。额外收益：用户能亲眼看到 AI 在操作自己的真实浏览器（v1 的 headless 反而看不到），透明性更好。

## 4. 组件设计

### 4.1 Edge 扩展（MV3）

- manifest 权限：`debugger`、`tabs`、`storage`；background service worker + popup 弹窗。
- **popup**：连接码输入（端口 + token）、attach / 断开按钮（同时提供用户手势）、连接状态灯。
- **service worker**：attach 后转发 CDP 事件；收到 `screencastFrame` → 先 ack → 再 POST 给中继桥；**长轮询 GET /command** 取待执行命令并执行。
- **保活**：MV3 SW 空闲约 30s 会被杀 → 持续 screencast 帧消息保持活跃 + 断线自动重连（必要时用 offscreen document 兜底）。
- **配对**：token 存 `chrome.storage.local`。

### 4.2 node 中继桥（最小化）

- 仅用 node 内置 `http`：`POST /frame`、`POST /event`、`GET /command`（长轮询，~100ms 无命令则挂起）。
- 只监听 `127.0.0.1:<随机端口>`；校验 **token + `Origin == chrome-extension://<扩展ID>` + Host 头**（防 DNS rebinding）。
- 与 Host 走 JSONL over stdio（沿用 v1 协议）。
- v1 桥的「找 Edge 路径 / 找空闲端口 / 拷 profile / 探测调试端口 / 杀进程树」职责**全部消失**。

### 4.3 Host 插件

- 桥脚本经 `fs` 服务写入工作区 → `subprocess.spawn('node', [脚本])` → stdin/stdout JSONL（沿用 v1 的运行时勘察结论：Host 无 `process`/`fetch`/`WebSocket`，故桥仍是必需）。
- 缓存最新帧 + url/title；实现 9 个 `browser_*` 工具与 `bib/*` RPC。
- 生命周期：`ctx.effect` 清理 → 杀桥；扩展侧由浏览器自行管理。

### 4.4 Client 面板

- `shell.overlay` 浮动层（沿用 v1 §8 结构）：标题栏（可拖动）/ 工具条 / 视口 `<img>` / 状态区。
- 新增：**连接码显示区**（端口 + token，一次性配对）、「浏览器需保持运行」提示、扩展离线提示。

## 5. 协议

### 5.1 Host ↔ 桥（JSONL over stdio，沿用 v1 §5）

```
Host→桥: {"id":1,"cmd":"navigate","url":"..."}
         {"id":2,"cmd":"input","type":"click","x":100,"y":240}
         {"id":3,"cmd":"eval","expression":"document.title"}
桥→Host: {"id":1,"ok":true,"result":{...}}
         {"type":"frame","data":"<base64 jpeg>","width":1200,"height":800,"seq":42}
         {"type":"state","url":"...","title":"..."}
         {"type":"ready","port":9333} / {"type":"log",...} / {"type":"exit",...}
```

### 5.2 桥 ↔ 扩展（HTTP）

```
扩展→桥: POST /frame   {seq, data(base64), width, height}
         POST /event   {type:"state", url, title}
         GET  /command 长轮询（有命令即返回，否则挂起）
桥→扩展: 200 {id, cmd, ...}  待执行命令
```

### 5.3 Host ↔ Client（沿用 v1 §6）

`bib/status` `bib/start` `bib/stop` `bib/poll`（250ms 拉帧，seq 去重）`bib/input` `bib/navigate` `bib/openExternal`

## 6. 模型工具（沿用 v1 §7，共 9 个，签名不变）

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_status` | – | 运行状态 + 当前 url/title |
| `browser_open` | `url` | 打开专用标签页（attach 若未 attach）+ 导航 |
| `browser_navigate` | `url` | 导航并等加载 |
| `browser_go` | `direction` (back/forward) | 历史前进后退 |
| `browser_click` | `x,y` | 视口 CSS 坐标点击（按下+抬起） |
| `browser_type` | `text` | `Input.insertText` 输入文本（可带 Enter） |
| `browser_scroll` | `x,y,dx,dy` | 滚轮 |
| `browser_screenshot` | – | 返回最新帧 dataURL + 尺寸 |
| `browser_eval` | `expression` | `Runtime.evaluate` 执行 JS 并返回值 |

调用链：工具 → JSONL → 桥 → HTTP → 扩展 → CDP，仅底层实现更换。

## 7. 安全

- **token（随机生成）+ Origin 校验**：真实浏览器里任意网页都能 `fetch` 本地端口，没有这道门的话恶意站点可驱动用户登录态浏览器——这是本方案最关键的安全门。
- **授权门（三层）**：扩展弹窗「attach」（用户手势）→ 面板「启动」→ 模型显式 `browser_open`。
- **真实会话风险**：模型控制的是用户**真实登录**的浏览器，权限比 v1 的隔离拷贝 profile 更大 → 面板明示「此功能以你的真实登录态运行」。
- **工具可见性**：工具注册随插件 Fiber，插件停止自动消失（沿用 v1）。

## 8. v1 ↔ v2 对比

| 维度 | v1 headless + 拷贝 | v2 扩展方案 |
|---|---|---|
| 登录态 | 拷贝 profile，运行中拷贝会静默残缺 | 真实浏览器，天然完整 |
| headless 检测 | 会拒绝 | 不存在 |
| 桥复杂度 | 找 Edge / 找端口 / 拷 profile / 杀进程树 | 纯 HTTP 转发（几十行） |
| 可见性 | headless，用户看不到 | 用户可见真实操作 |
| 浏览器须运行 | 否（桥自拉起） | 是（扩展寄生在真实 Edge 里） |
| 安装成本 | 零 | 手动装 unpacked 扩展（开发者模式） |
| 副作用 | 无 | 标签页顶部黄色调试条 |
| 风险面 | 隔离 profile | 真实登录会话（更大） |
| 平台 | 仅 Windows | 天然跨平台（桥是纯 node） |

## 9. 已知限制（v2 如实声明）

- **手动装扩展**：`edge://extensions` 开开发者模式加载 unpacked；浏览器重装需重装。
- **黄色调试条**：attach 后标签页顶部出现「正在被调试」黄条，无法去除。
- **最小化窗口节流**：occlusion 可能停帧 → 专用窗口不要最小化（待实测确认）。
- **MV3 SW 生命周期**：空闲约 30s 可能被杀 → screencast 持续帧 + 自动重连（或 offscreen document）。
- **`chrome.debugger.attach` 需用户手势**（新版 Chrome 要求）。
- **浏览器须保持运行**；扩展离线时工具报错提示。
- 中文输入法（`Input.insertText` 绕过 IME）、输入延迟 ~250ms：沿用 v1 结论。
- v1 的「仅 Windows」限制在 v2 自动消失（桥跨平台，无 taskkill/Edge 路径依赖）。

## 10. 实施阶段

- **PoC（本次最小闭环）**：扩展（attach + screencast 帧 + 单命令通道 + 配对）+ 中继桥 + Host 的 `browser_open` / `browser_screenshot` + 面板帧显示。验证：帧流、点击输入、token 安全门。
- **v2 完整**：9 工具全量 + 面板完善 + 自动重连 + 断线提示。
- **后续（原 v1 的 v2 候选，扩展方案下大多更易实现）**：多标签、完整键盘事件、剪贴板、headed/headless 设置（扩展方案天然 headed，无需开关）。

## 11. 已确认决策

| 决策点 | 定稿 |
|---|---|
| 浏览器实例 | 用户真实 Edge + 专用标签页（不抢占用户当前页） |
| CDP 通道 | 扩展 `chrome.debugger` attach 真实标签页；桥只做转发 |
| 登录态 | 天然继承，无拷贝、无 DPAPI、无锁 |
| 中继桥 | node `http`（127.0.0.1 + token + Origin/Host 校验），JSONL over stdio |
| 帧流 | screencast + 每帧 ack；Client 250ms 轮询拉帧（seq 去重） |
| 模型工具 | 9 个 `browser_*`（沿用 v1 签名） |
| 授权门 | 扩展 attach（用户手势）+ 面板「启动」+ 模型显式 `browser_open` |
| 安装 | unpacked 开发者模式 + 一次性配对 token |
| v1 作废部分 | §4 profile 拷贝、§2 headless 限制、§10「仅 Windows」 |
