# DSH「内嵌浏览器」插件 — 设计文档（v1 定稿）

> 状态：设计已定稿，待讨论确认后进入实现。
> 日期：2026 年 · 会话讨论产物
> 目标运行时：DSH Web GUI（http://127.0.0.1:3080），动态 Cordis 插件

## 1. 目标

在 DSH Web GUI 里嵌入一个**可控的真实浏览器视口**（Electron 风格）：

- **人**：在浮动面板里实时看到页面，支持点击、滚轮、URL 导航
- **模型**：通过 `browser_*` 工具直接操作该浏览器（打开、点击、输入、滚动、截图、执行 JS）
- **登录态**：复用用户 Edge 的 cookie，agent 可操作已登录的站点

## 2. 硬约束（运行时勘察结论）

动态插件运行时的可用符号：

| 平台 | 可用符号 | 缺失 |
|---|---|---|
| Host | `ctx` / `harness` / `console` / `btoa` / `atob` / `TextEncoder` / `TextDecoder` | `process` / `child_process` / `WebSocket` / `fetch` |
| Client | `ctx` / `React` / `host` / `styles` / `console` | `document` / `window` / `WebSocket` / `fetch` |

推论：

1. **插件内无法直接开 WebSocket 连 Edge 的 CDP** → CDP 通道必须放在一个 node「桥」子进程里。
2. **iframe 方案不可行**（跨域无法自动化操作 + 大部分站点拒绝嵌入）→ 必须用 CDP screencast 帧流渲染。
3. Host 有 `subprocess` 服务（`spawn` 支持 `stdin:'pipe'` + `stdout:'pipe'`，handle 暴露可写 stdin / 可读 stdout / `terminate()`），有 `fs` 服务（写桥脚本文件），有 `timer` 服务。
4. Host↔Client 官方 RPC 只有 **Client→Host** 单向（`harness.handle` + `host.call`）→ 帧流用 Client 轮询拉取。

## 3. 总体架构（三层）

```
┌──────────────────────┐   harness.handle('bib/*')   ┌─────────────────────────┐
│  Client 悬浮面板       │ ◄─────────────────────────► │  Host 插件               │
│  (shell.overlay 浮动层)│      Client→Host 单向 RPC   │  · 桥生命周期            │
│  · 帧显示 <img>        │      (轮询拉帧/推输入)       │  · browser_* 模型工具     │
│  · 点击/滚轮/URL导航    │                            │  · 状态与帧缓存           │
└──────────────────────┘                            └───────────┬─────────────┘
                                                                │ JSONL over stdio
                                                    ┌───────────▼─────────────┐
                                                    │  node「桥」子进程          │
                                                    │  · 拷贝 Edge profile      │
                                                    │  · 启动 Edge headless     │
                                                    │  · CDP WebSocket 客户端    │
                                                    └───────────┬─────────────┘
                                                                │ CDP (WS)
                                                    ┌───────────▼─────────────┐
                                                    │  Edge (headless=new)     │
                                                    │  真实渲染 + 真实 cookie   │
                                                    └─────────────────────────┘
```

角色分工：

- **桥进程**（完整 Node）承包所有 OS 级操作：`fs.cpSync` 拷 profile、`child_process.spawn` 起 Edge、`net` 找空闲端口、原生 `WebSocket` 连 CDP、`fetch` 探测调试端口。
- **Host 插件**：把桥脚本写入工作区（`fs` 服务）→ `subprocess.spawn('node', [脚本])` → stdin/stdout JSONL；实现 `browser_*` 模型工具与 `bib/*` RPC。
- **Client 面板**：`shell.overlay` 浮动层，React 渲染帧流 + 输入转发。

## 4. Cookie 复用（Edge profile 拷贝）

Edge 正在运行时 profile 目录被锁，不能直接挂。方案：

1. 桥在 `%TEMP%` 下建全新 profile 目录。
2. `fs.cpSync` 拷贝真实 profile 关键文件：
   - `Local State`（DPAPI 主密钥）
   - `Default\Network\Cookies`（cookie 库）+ 旧版 `Default\Cookies`
   - `Default\Local Storage`（登录态存储）
3. DPAPI 加密在同一 Windows 用户下自动解密 → 拷贝后 cookie 直接可用。

启动参数：

```
msedge.exe --headless=new
           --remote-debugging-port=<随机空闲端口>
           --user-data-dir=<拷贝目录>
           --no-first-run --no-default-browser-check
           --remote-allow-origins=*
           about:blank
```

- **headless 原因**：真实 Edge 只当渲染引擎，不弹可见窗口；用户只看到面板内嵌视口。
- 设计预留 `headed` 开关（仅启动参数不同），应对 headless 检测站点。

## 5. 桥协议（JSONL over stdio）

Host → 桥 (stdin)：

```
{"id":1,"cmd":"navigate","url":"https://..."}
{"id":2,"cmd":"input","type":"click","x":100,"y":240}
{"id":3,"cmd":"eval","expression":"document.title"}
{"id":4,"cmd":"cdp","method":"Page.captureScreenshot","params":{...}}
```

桥 → Host (stdout)：

```
{"id":1,"ok":true,"result":{"url":"...","title":"..."}}
{"id":2,"ok":true,"result":{}}
{"type":"frame","data":"<base64 jpeg>","width":1200,"height":800,"seq":42}
{"type":"state","url":"...","title":"..."}
{"type":"ready","port":9333}
{"type":"log","level":"info","message":"..."}
{"type":"exit","code":0}
```

桥内部流程：

1. 读首条 stdin 消息拿配置（Edge 路径、profile 模式、起始页）。
2. 找 msedge.exe（候选路径列表 / PATH）。
3. `net` 找空闲端口。
4. 准备 profile 目录（拷贝 or 纯净）。
5. spawn Edge（`--headless=new` + 调试端口 + profile）。
6. `fetch` 轮询 `http://127.0.0.1:PORT/json/version` 直到 200（~10s 上限）。
7. 原生 `WebSocket` 连浏览器 WS。
8. 发 `{type:"ready",port}`。
9. 首次使用时：`Target.createTarget` → `Target.attachToTarget(flatten)` → `Page.enable` / `Network.enable` → `Page.startScreencast({format:'jpeg',quality:55,maxWidth:1200,everyNthFrame:3})`。
10. **每帧必须回 `Page.screencastFrameAck`**，否则帧流停止。
11. `Page.frameNavigated` / `titleChanged` → 发 `{type:"state",...}`。
12. stdin 结束 / WS 断开 / 收到 shutdown → 杀 Edge、退出。

## 6. Host ↔ Client RPC

| 方法 | 方向 | 用途 |
|---|---|---|
| `bib/status` | C→H | 状态（stopped/starting/running/error）+ url/title |
| `bib/start` / `bib/stop` | C→H | 启停浏览器 |
| `bib/poll` | C→H | 每 ~250ms 拉最新帧（seq 去重）+ url/title |
| `bib/input` | C→H | 点击 / 滚轮 / 输入 |
| `bib/navigate` | C→H | URL 导航、后退前进、刷新 |
| `bib/openExternal` | C→H | 在真实 Edge 里打开当前页 |

帧轮询理由：官方 RPC 只有 Client→Host 单向；250ms 轮询 + seq 去重足够流畅。

## 7. 模型工具（harness.registerTool）

| 工具 | 参数 | 说明 |
|---|---|---|
| `browser_status` | – | 运行状态 + 当前 url/title |
| `browser_open` | `url` | 启动（若未启动）+ 导航 |
| `browser_navigate` | `url` | 导航并等加载 |
| `browser_go` | `direction` (back/forward) | 历史前进后退 |
| `browser_click` | `x,y` | 视口 CSS 坐标点击（按下+抬起） |
| `browser_type` | `text` | `Input.insertText` 输入文本（可带 Enter） |
| `browser_scroll` | `x,y,dx,dy` | 滚轮 |
| `browser_screenshot` | – | 返回最新帧 dataURL + 尺寸 |
| `browser_eval` | `expression` | `Runtime.evaluate` 执行 JS 并返回值 |

坐标基准：CDP 视口 CSS 像素；Client 点击按「显示尺寸 / 帧内在尺寸」换算。

## 8. 人工操作面板（Client）

`shell.overlay` 浮动层（`id:'dsh-bib-viewport'`，自带 `pointer-events:auto`，该层默认点击穿透）：

- 标题栏（可拖动）：状态灯、内嵌浏览器、最小化
- 工具条：后退/前进/刷新、URL 输入框 + 前往、在真实 Edge 打开、停止
- 视口区：`<img>` 帧流 + 点击/滚轮转发 + 提示「模型可用 browser_* 工具操作此页」
- 状态区：当前 URL/标题、桥错误信息

## 9. 生命周期与安全

- **启停**：面板按钮或模型工具首次调用触发懒启动；插件 stop/update 时 `ctx.effect` 清理 → `handle.terminate()`（Windows `taskkill /T` 连带杀掉 Edge 子进程）→ 清 pending/timer。
- **安全边界**：
  - cookie 只在桥进程内使用，**绝不把 cookie 值传出桥或写入日志**
  - 桥是完整 Node 权限（profile 拷贝、起进程）——本需求固有，面板明示「此功能以你的 Edge 登录态运行」
  - 授权门：`cordis_run` Client 审批 + 面板「启动」按钮
- **工具可见性**：工具注册属于插件 Fiber，插件停止自动消失。

## 10. 已知限制（v1 如实声明）

- headless 检测：个别站点会拒绝（预留 headed 开关）
- 中文输入法：`Input.insertText` 直接插入文本、绕过 IME，中文可用但无候选窗
- 输入延迟：轮询协议 ~250ms 级
- 平台：v1 仅 Windows（Edge 路径、taskkill）；macOS/Linux 留 v2
- 无剪贴板 / 下载 / 多标签：v2
- 扩展不随 profile 拷贝（v2 可选全量拷贝）

## 11. 实施阶段

- **v1（本次）**：桥 + 面板 + 9 个工具，最小可用闭环
- **v2**：多标签、完整键盘事件、剪贴板、设置页（headless/headed、profile 模式）、扩展拷贝、macOS/Linux

## 12. 已确认决策

| 决策点 | 定稿 |
|---|---|
| 登录态 | 拷贝 Edge profile（Local State + Cookies + Local Storage）到 %TEMP%，DPAPI 自动解密 |
| 实例可见性 | headless=new；预留 headed 开关 |
| 面板位置 | 浮动悬浮窗（shell.overlay），可拖动可最小化（先做，后续可换 slot） |
| 架构 | Client 面板 → Host 插件 → node 桥 → Edge CDP，三层 JSONL 协议 |
| 模型工具 | browser_status/open/navigate/go/click/type/scroll/screenshot/eval 共 9 个 |
| 安全 | cookie 不出桥进程；cordis_run 审批 + 面板「启动」为授权门；插件停止即杀桥+Edge |
| v2 候选 | 多标签、键盘事件、剪贴板、扩展拷贝、headed 开关、macOS/Linux |

---

> **注（v2 修订）**：本方案 §4 profile 拷贝存在「运行中拷贝可能静默残缺」问题（SQLite WAL / LevelDB 不一致快照），且 headless 会被部分站点检测。v2 已改用「浏览器扩展 + 中继桥」方案，见 `design-v2.md`。
