# dsh-bib 设计⑤ — 时序与错误恢复

> 组件：全局设计——把 extension / bridge / plugin(Host+Client) 四部分的交互时序、超时参数、故障恢复串成完整图景。
> 配套：`extension-design.md`、`bridge-api.md`、`host-plugin.md`、`client-panel.md`

## 1. 端到端时序

### 1.1 冷启动（人工：面板启动 → 扩展 attach → 帧流开始）

```
Client面板        Host插件            中继桥             Edge扩展            Edge浏览器
   │  bib/start    │                  │                 │                  │
   ├──────────────►│ spawn node       │                 │                  │
   │               ├─────────────────►│                 │                  │
   │               │  {"cmd":"config","token":"..."}    │                  │
   │               ├─────────────────►│                 │                  │
   │               │                  │ 找端口/起 http   │                  │
   │               │  {"type":"ready","port":49152}     │                  │
   │               │◄─────────────────┤                 │                  │
   │  bib/status   │                  │                 │                  │
   │◄──────────────┤  {state:running, code:"127.0.0.1:49152#a1b2..."}        │
   │ 显示连接码 ────┼─────────────────────────────────────┼─ 用户粘贴连接码    │
   │               │                  │  GET /command(挂起) ◄─ SW 开始轮询     │
   │               │                  │◄─────────────────┤                 │
   │               │  browser_open → {"id":1,"cmd":"navigate","url":"..."}   │
   │               ├─────────────────►│  queue ──► GET /command 返回 ──────►│
   │               │                  │─────────────────►│ chrome.debugger.attach
   │               │                  │                  │  (用户手势: popup)
   │               │                  │                  ├─ Page.enable / startScreencast
   │               │                  │                  │  screencastFrame ─┐
   │               │                  │◄─── POST /frame ◄─┘ (先 ack)          │
   │               │  {"type":"frame","seq":...}                              │
   │               │◄─────────────────┤                 │                  │
   │               │  cache 最新帧     │                 │                  │
   │  bib/poll 250ms◄────────────────────────────────────┘                  │
   │◄──────────────┤  {seq, data, url, title}  → 渲染 <img>                  │
```

要点：attach 由**用户手势**触发（popup 打开即手势）；`navigate` 命令排队等待 attach 完成后由扩展执行。

### 1.2 命令往返（模型工具 browser_click）

```
模型          Host插件               中继桥               Edge扩展
 │ browser_click {x:100,y:240}        │                  │
 ├──────────────► sendCommand(id=2)   │                  │
 │               ├── {"id":2,"cmd":"click","x":100,"y":240} ──►
 │               │                  ├── GET /command → 返回 id=2 ──►
 │               │                  │◄── Input.dispatchMouseEvent ×2 (CDP)
 │               │                  │◄── POST /event {type:"cmdResult","id":2,"ok":true}
 │               │  {"type":"ok","id":2,"result":{}} ◄──┤
 │               │◄─────────────────┤                  │
 │◄──────────────┤  resolve pending[2]                 │
 │ {ok:true}     │                  │                  │
```

### 1.3 帧流（常驻）

```
Edge扩展 ── screencastFrame ──ack──► (每帧)
   │ POST /frame {seq,data,w,h}
   ▼
中继桥 ── stdout {"type":"frame",...} ──► Host 缓存（seq 去重，只留最新）
                                              ▲
Client ── bib/poll(250ms) ──► 仅 seq 变化时返回 data 非空 ──► <img> 渲染
```

### 1.4 页面状态变化

```
Edge扩展: Page.frameNavigated / Page.titleChanged
   │ POST /event {type:"state",url,title}
   ▼
中继桥 ── stdout {"type":"state",...} ──► Host 更新 url/title ──► bib/poll 带出
```

## 2. 故障场景与恢复策略

### 2.1 扩展 SW 被浏览器杀掉（空闲 ~30s）

| 环节 | 表现 | 恢复 |
|---|---|---|
| 帧停、命令无响应 | Host 侧 `degraded`（>5s 无帧/无心跳）；工具超时报 `TIMEOUT` | 扩展 SW 被唤醒（用户开 popup / 收到 chrome 事件）→ 从 storage 读配对 → 若需 attach 则等手势；每 3s `GET /ping` 重连桥 |
| 兜底保活 | – | 扩展每 25s 发一次幂等 CDP 命令制造事件（`extension-design.md` §6.7） |

### 2.2 桥崩溃 / 被强杀

| 环节 | 表现 | 恢复 |
|---|---|---|
| Host 读 stdout EOF / 收到 `{"type":"exit"}` | 状态 → `stopped`；pending 命令全部 reject（`BRIDGE_DIED`）；帧缓存清空 | Host **不自动重启桥**（避免循环）——面板显示 error，用户点「启动」重来；扩展侧 3s ping 失败 → 停止轮询，等待新桥地址 |

> 决策：v1 不做自动重启（重启会换端口 → 扩展需重新配对）。「启动」按钮即重启入口。v2 可做「同 token 同端口复用」自动恢复。

### 2.3 Edge 浏览器关闭 / 专用标签页被关

| 环节 | 表现 | 恢复 |
|---|---|---|
| CDP 会话断开 | 扩展 `chrome.debugger.onDetach` → 置 `attached=false`，通知桥（`POST /event {type:"detached"}`）→ Host `degraded` | 扩展保活重连：检测到浏览器重开（ping 通后）→ 等用户手势重新 attach + 重建专用标签页 |

### 2.4 命令超时 / 卡死

| 场景 | 参数 | 处理 |
|---|---|---|
| 普通命令 | 10s | Host reject `TIMEOUT`；桥标记 `STALE`，丢弃迟到的 `cmdResult` |
| navigate | 15s（等 domContent） | 同上 |
| 扩展 10s 未回 cmdResult | – | 桥在下一个命令返回前丢弃 STALE 结果 |
| GET /command 长轮询 | 挂起 10s | 超时返回 `{}`，扩展 50ms 后再轮询（链路自愈，无状态残留） |

### 2.5 连接码/token 泄露

面板「重置」→ Host 重新生成 token → 桥重启（换 token 需重配）→ 面板显示新连接码。**v1 简化：重置 = 重启桥 + 新 token**，扩展侧需重新粘贴。

### 2.6 插件 stop/update

`ctx.effect` 清理链：stdin 写 `shutdown` → 1s 宽限 → `terminate()` → reject 全部 pending → 清缓存/timer → 状态 `stopped`。扩展侧：桥失联 → 停轮询；专用标签页遗留为新标签（v1 接受，v2 回收）。工具随 Fiber 消失（框架保证）。

## 3. 三侧状态机对齐

| Host | 桥 | 扩展 | 面板灯 |
|---|---|---|---|
| `stopped` | 无进程 | （无关） | 灰 |
| `starting` | 启动中（未 ready） | idle | 黄闪 |
| `running`（桥在线） | listening | idle / connecting | 绿（若未 attach 显示配对引导） |
| `running`（已 attach） | listening | attached | 绿 |
| `degraded` | listening | 离线/停帧 | 橙 + 提示 |
| `error`（桥死） | 退出 | ping 失败停轮询 | 红 |

转换规则：任何一侧异常都以「状态降级 + 面板提示」表达，**不自动升级为错误**（错误只在桥进程死亡/配置失败时出现）。

## 4. 超时参数总表（实现常量，集中在 host-plugin 顶部）

| 参数 | 值 | 用途 |
|---|---|---|
| `BRIDGE_READY_TIMEOUT` | 5s | spawn 后等 ready |
| `CMD_TIMEOUT` | 10s | 普通命令 |
| `NAVIGATE_TIMEOUT` | 15s | navigate/go/reload |
| `DEGRADED_AFTER` | 5s | 无帧/心跳判定扩展离线 |
| `POLL_INTERVAL` | 250ms | Client 轮询 |
| `POLL_RETRY_SLOW` | 1s | 连续失败后的降频 |
| `BRIDGE_SHUTDOWN_GRACE` | 1s | shutdown 后强杀宽限 |
| 扩展 `POLL_GAP` | 50ms | GET /command 空响应后的再轮询间隔 |
| 扩展 `PING_RETRY` | 3s | 桥失联重试探测 |

## 5. 可观测性（v1 最小集）

- 桥：`{"type":"log",...}` → Host 侧按 level 过滤，`error` 级进面板状态区；不打印 token、不打印 cookie、不打印帧体。
- Host：`browser_status` 返回 `{state, url, title, hasFrame, seq, lastFrameAt, lastError}`——模型可直接诊断。
- 扩展：popup 显示 attach 状态 + 最近错误（`chrome.runtime.lastError` 文案）。
- 无远程日志（v1 本地工具，默认不采集）。

## 6. 验证清单（PoC 验收）

1. 冷启动全链路（§1.1）——帧出现在面板。
2. 模型 `browser_open` → 面板可见导航；`browser_click` → 页面响应（命令往返 §1.2）。
3. 断链：kill 桥 → 面板 `error`；重启桥 → 重新配对可恢复（§2.2）。
4. 关专用标签页 → 面板 `degraded` → 重开 popup attach 恢复（§2.3）。
5. 未带 token 的请求 → 401；伪造 Origin → 403（`bridge-api.md` §4.3）。
6. 帧 ack 缺失验证：停掉 ack 后帧流应在数秒内停止（确认扩展实现正确性）。
