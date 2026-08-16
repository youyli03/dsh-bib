# dsh-bib 设计③ — Host 插件设计

> 组件：`plugin/`，动态 Cordis 插件（Host 半区）
> 定位：桥生命周期管家 + `browser_*` 模型工具 + `bib/*` RPC 服务端 + 帧缓存。
> 配套：`bridge-api.md`（桥契约）、`client-panel.md`（Client 半区）、`design-v2.md`（总纲）

## 1. 职责边界

Host 半区**只做纯逻辑**，不碰 OS 级操作（那些在桥里）：

1. 把桥脚本写盘（`fs` 服务）→ `subprocess.spawn('node', [桥脚本])` → 管理桥生命周期。
2. 实现 9 个 `browser_*` 模型工具（`harness.registerTool`），调用 → JSONL 命令 → 桥 → 扩展 → CDP。
3. 实现 `bib/*` RPC（`harness.handle`），供 Client 面板轮询帧、推输入、启停。
4. 维护状态机 + 帧缓存（最新一帧 + url/title）。
5. 生成 token（连接码），暴露给面板。

## 2. 运行时依赖（勘察结论，实现时以 Inspect 为准）

| 服务 | 用途 | 备注 |
|---|---|---|
| `subprocess` | `spawn('node', [script])`，handle 暴露可写 stdin / 可读 stdout / `terminate()` | 桥的进程载体 |
| `fs` | 把桥脚本写入工作区 | 插件每次启动重写，避免版本漂移 |
| `timer` | 命令超时、轮询节流、健康检查 | |
| `harness` | `registerTool` / `handle` | 工具与 RPC |
| `ctx` | `effect` / `on` 生命周期清理 | 所有副作用必须可逆 |

Host 侧**没有** `process` / `fetch` / `WebSocket` / `net` / `http`——因此桥必须存在，且 Host 与桥只能走 stdio。

## 3. 状态机（Host 视角）

```
        bib/start 或 工具首次调用
  stopped ───────────────────────► starting ── spawn 桥 ──► running
    ▲  ▲                            │                         │
    │  │                            │ 桥 ready 超时/崩溃         │ 扩展离线（无帧>5s）
    │  └────────────────────────────┘                         ▼
    │                                                     degraded ──► running（扩展重连）
    └──────────────── bib/stop / 插件 stop / 桥 exit ◄──────────┘
```

- `stopped`：桥未启动。`browser_*` 调用返回明确错误「浏览器未启动」。
- `starting`：已 spawn，等桥 `ready`（5s 超时 → 失败回 `stopped`）。
- `running`：桥就绪。扩展可能尚未 attach（此时是「桥在线、扩展离线」子状态）。
- `degraded`：曾收到过帧但最近 >5s 无帧/无心跳（扩展掉线或页面停帧）→ 面板黄灯；工具照常转发（桥会返回错误），不阻断。
- 任何状态收到 `bib/stop` / 插件 stop → 清理桥。

## 4. 桥生命周期

### 4.1 写盘

- 桥脚本内容以字符串内嵌在插件代码里（或从 `plugin/bridge/bridge.js` 读取——插件是 Cordis 插件，脚本最终以源码形式存在，写盘用 `fs` 服务）。
- 每次启动写到一个固定路径（如工作区 `.dsh-bib/bridge.js`），**覆盖写**，保证与当前插件版本一致。

### 4.2 spawn

```
subprocess.spawn('node', [桥路径], { stdin:'pipe', stdout:'pipe' })
```

- handle.stdin 可写、handle.stdout 可读（按行切分 → JSON.parse，容错跳过坏行）。
- 记录 `spawnAt`，用于健康判断。

### 4.3 配置与 ready

- spawn 后立即向 stdin 写配置行：`{"id":0,"cmd":"config","token":<16hex>}`。
- 等 stdout `{"type":"ready","port":N}` → 状态 `running`，缓存连接码 `127.0.0.1:N#<token>`。
- 5s 无 ready → `terminate()` → 回 `stopped`，`bib/status` 返回错误。

### 4.4 清理（ctx.effect 注册）

```
ctx.effect(() => {
  // 注册时：spawn 桥、绑定 stdout/stderr 处理、timer
  return () => {
    // 注销时（插件 stop/update）：
    // 1. 向 stdin 写 {"cmd":"shutdown"}（尽力优雅退出）
    // 2. 1s 后仍未退出 → handle.terminate() 强杀
    // 3. 清 pending 命令（全部 reject）、清帧缓存、清 timer、置 stopped
  };
});
```

- 桥被杀后扩展侧自然失联（专用标签页由扩展清理或遗留为新标签——v1 接受遗留，v2 做回收）。

## 5. 模型工具（harness.registerTool × 9）

工具签名与 v1 一致（`design-v2.md` §6）。内部统一走 `sendCommand(cmd, params, timeoutMs)`：

```
sendCommand:
  1. 若状态非 running → reject {code:'NOT_RUNNING'}
  2. 分配 id，pending[id] = {resolve, reject, timer}
  3. stdin 写 {"id":id,"cmd":cmd,...params}
  4. 等待桥 ok/err 或超时（默认 10s，navigate 15s）
  5. 收到 ok/err → resolve/reject + 清 timer
```

| 工具 | 参数 | 返回 | 错误语义 |
|---|---|---|---|
| `browser_status` | – | `{state, url, title, hasFrame, seq}` | 永不失败（降级也返回） |
| `browser_open` | `{url}` | `{url, title}` | 未运行 → 自动 `bib/start` 后再 navigate（懒启动） |
| `browser_navigate` | `{url}` | `{url, title}` | 同 navigate 契约（15s 超时） |
| `browser_go` | `{direction}` | `{url, title}` | `NO_HISTORY` |
| `browser_click` | `{x,y}` | `{}` | 坐标校验 0..width/height（用当前帧尺寸） |
| `browser_type` | `{text}` | `{}` | text 长度 ≤ 2000 |
| `browser_scroll` | `{x,y,dx,dy}` | `{}` | – |
| `browser_screenshot` | – | `{data(dataURL), width, height, seq}` | 无帧 → `NO_FRAME`，提示先 open |
| `browser_eval` | `{expression}` | `{value}` | `EVAL_ERROR`（带 message） |

- 坐标基准：CDP 视口 CSS 像素 = 帧内在尺寸。Client 点击换算见 `client-panel.md` §5.2；模型工具直接用帧尺寸坐标系（`browser_screenshot` 返回的 width/height 即坐标空间）。
- 工具注册随插件 Fiber：插件停止 → 工具自动消失（框架保证）。

## 6. 帧缓存

```
缓存结构：{ seq, data(base64), width, height, at(时间戳) }
```

- stdout 每来一行 `{"type":"frame",...}` → 若 `seq > cache.seq` 则替换缓存（seq 单调，天然去重）。
- `state` 行 → 更新 `{url, title}`。
- 不缓存多帧（v1 单帧最新策略；未来播放可加环形缓冲）。

## 7. bib/* RPC（harness.handle，Client→Host 单向）

| 方法 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `bib/status` | – | `{state, url, title, hasFrame, seq, code(连接码, 仅 starting/running 且未 attach)}` | 面板轮询状态 |
| `bib/start` | – | `{ok, code?}` | 懒启动桥；返回连接码供面板显示 |
| `bib/stop` | – | `{ok}` | 停止桥（走 §4.4 清理） |
| `bib/poll` | – | `{seq, data, width, height, url, title, state}` | 250ms 轮询；无新帧时 `data` 为空串（省流量） |
| `bib/input` | `{type:'click'|'scroll'|'type', x?, y?, dx?, dy?, text?}` | `{ok}` | 面板人工操作 → 转 sendCommand |
| `bib/navigate` | `{url, action?:'go'|'reload'}` | `{ok}` | 面板 URL 导航 |
| `bib/openExternal` | – | `{ok}` | 把当前 url 交给系统浏览器打开（Host 侧用 `subprocess` 起 `cmd /c start <url>`，v1 Windows） |
| `bib/resetCode` | – | `{code}` | 重新生成 token（连接码泄露时重置） |

- 所有 RPC 必须幂等、可重入（面板轮询期间 Host 可能重启桥）。
- `bib/poll` 的帧体：`data` 只在 `seq` 变化时返回非空；Client 依此渲染 `<img src="data:image/jpeg;base64,...">`。

## 8. 与 Client 的协作点

| 事项 | Host 提供 | Client 消费 |
|---|---|---|
| 连接码 | `bib/start` / `bib/status` 返回 | 显示「配对」区 |
| 帧 | `bib/poll` | `<img>` 渲染 + 坐标换算基准 |
| 状态 | `bib/status` | 状态灯 / 黄条 / 错误提示 |
| 人工操作 | `bib/input` / `bib/navigate` | 点击/滚轮/URL 输入 |
| 扩展离线 | `state:'degraded'` + `lastFrameAt` | 显示「扩展离线，请在 Edge 中打开扩展并 attach」 |

## 9. 安全

- token 只在 Host 内存与桥 stdin 中；**不写日志**（stdout 日志行不含 token）。
- 工具层面不加额外鉴权（模型工具本身即授权面；授权门 = 插件审批 + 面板启动 + 扩展 attach，见 `design-v2.md` §7）。
- `browser_eval` 可执行任意 JS——这是设计内能力（「模型控制真实浏览器」），文档与面板明示。

## 10. 交付物

```
plugin/
├── host.js          # Host 半区（含桥脚本字符串或加载 bridge.js）
├── client.jsx       # Client 半区（见 client-panel.md）
└── index.js         # 组装导出（返回 Cordis Plugin）
```

实现顺序（PoC）：host.js 的 桥生命周期 + `browser_open`/`browser_screenshot` + `bib/poll` 即可验证链路；工具与 RPC 其余部分按 §5/§7 表补齐。
