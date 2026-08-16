# dsh-bib 设计② — 中继桥 API 契约

> 组件：`bridge/`，node 子进程（由 Host 插件 spawn）
> 定位：扩展（HTTP）与 Host 插件（JSONL over stdio）之间的**纯转发**中继。无任何 Edge/浏览器逻辑。
> 配套：`extension-design.md`（扩展侧）、`host-plugin.md`（Host 侧）

## 1. 概述

```
        Host 插件                              node 中继桥                         Edge 扩展
  ┌──────────────────┐   JSONL over stdio   ┌──────────────┐    HTTP (127.0.0.1)   ┌────────────┐
  │ 工具 / bib/* RPC  │ ◄──────────────────► │ node http    │ ◄──────────────────► │ SW + CDP    │
  │ 帧缓存 / 生命周期   │   stdin / stdout      │ 端口转发/鉴权   │   帧/事件/命令轮询      │ 真实标签页   │
  └──────────────────┘                      └──────────────┘                       └────────────┘
```

桥是**无状态转发器**：上行（帧/事件）扩展 → 桥 → Host；下行（命令）Host → 桥 → 扩展。桥不缓存帧、不解释命令、不落盘。

## 2. 进程与启动

- 由 Host 插件 `subprocess.spawn('node', [bridge.js])` 启动，cwd 设为 `bridge/`（脚本随插件写盘，见 `host-plugin.md` §4）。
- **首条 stdin 消息 = 配置**（JSONL，命令 `config`）：

```json
{"id":0,"cmd":"config","token":"a1b2c3d4e5f6a7b8"}
```

- 桥收到配置后：`net` 找空闲端口 → `http.createServer` 监听 `127.0.0.1:<port>` → 向 stdout 发：

```json
{"type":"ready","port":49152}
```

- Host 收到 `ready` 后，把 `127.0.0.1:<port>#<token>` 作为连接码交给 Client 面板展示。
- **token 由 Host 生成**（8 字节 CSPRNG → hex，16 字符），仅经 stdin 传给桥、经面板传给用户；桥不落盘。

## 3. 与 Host 的协议（JSONL over stdio）

### 3.1 Host → 桥（stdin），命令

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 递增命令 id，响应原样带回 |
| `cmd` | string | `navigate` / `go` / `reload` / `click` / `scroll` / `type` / `eval` / `screenshot` / `cdp` / `stop` / `ping` |
| `...` | – | 命令参数（见 §3.3） |

命令行示例：

```json
{"id":1,"cmd":"navigate","url":"https://example.com"}
{"id":2,"cmd":"click","x":100,"y":240}
{"id":3,"cmd":"eval","expression":"document.title"}
{"id":4,"cmd":"stop"}
```

### 3.2 桥 → Host（stdout），消息

| `type` | 方向语义 | 载荷 |
|---|---|---|
| `ready` | 桥就绪 | `{port}` |
| `ok` | 命令成功响应 | `{id, result}`，`result` 结构随命令 |
| `err` | 命令失败响应 | `{id, error:{code,message}}` |
| `frame` | 新帧（转发扩展） | `{seq, data(base64 jpeg), width, height}` |
| `state` | 页面状态（转发扩展） | `{url, title}` |
| `evt` | 扩展侧事件（含命令结果回传） | `{type, ...}`，如 `{type:'cmdResult', id, ok, result}` |
| `log` | 桥日志 | `{level:'info'|'warn'|'error', message}` |
| `exit` | 桥即将退出 | `{code}` |

### 3.3 命令与结果契约

| cmd | 参数 | 成功 `result` | 失败语义 |
|---|---|---|---|
| `navigate` | `{url}` | `{url, title}`（等待 domContent 后） | 超时 15s → `err {code:'TIMEOUT'}` |
| `go` | `{direction:'back'|'forward'}` | `{url, title}` | 无历史可走 → `err {code:'NO_HISTORY'}` |
| `reload` | – | `{url, title}` | – |
| `click` | `{x,y}`（视口 CSS 像素） | `{}` | – |
| `scroll` | `{x,y,dx,dy}` | `{}` | – |
| `type` | `{text}`（`\n` 结尾 → 追加 Enter） | `{}` | – |
| `eval` | `{expression}` | `{value}`（`Runtime.evaluate` 的 `result.value`） | JS 异常 → `err {code:'EVAL_ERROR', message}` |
| `screenshot` | – | `{data, width, height, seq}`（最近一帧，Host 侧缓存直接返回，**不下发到桥**，见注） | 无帧 → `err {code:'NO_FRAME'}` |
| `cdp` | `{method, params}` | `{result}`（CDP 原始返回） | 透传 CDP error |
| `stop` | – | `{}` | 停 screencast + detach + 关标签页 |
| `ping` | – | `{pong:true}` | 用于 Host 健康探测 |

> 注：`screenshot` 由 Host 直接读自己的帧缓存返回，不经过桥——桥协议里保留该命令仅为将来「强制取新帧」预留。

### 3.4 帧流转发

扩展 POST 的每一帧，桥**原样**写一行 `{"type":"frame",...}` 到 stdout。不做任何解码/校验（base64 透传）。Host 侧按 `seq` 去重、只保留最新。

### 3.5 命令下行与结果回传

1. Host 发命令行 → 桥放入**先进先出队列**。
2. 扩展 `GET /command` 长轮询 → 桥从队列取一条返回（无则挂起）。
3. 扩展执行完 → `POST /event {"type":"cmdResult","id":...,"ok":...,"result":...}`。
4. 桥把 `cmdResult` 转成 stdout 行：`{"type":"evt","type":"cmdResult",...}`（或直接映射为 `{"type":"ok","id":...}` / `{"type":"err","id":...}`，见 §7 归一化）。
5. Host 收到后按 `id` resolve 对应 pending Promise。

## 4. 与扩展的 HTTP API（仅 127.0.0.1）

### 4.1 通用约定

- Base URL：`http://127.0.0.1:<port>`
- **所有请求必须带** `X-Bib-Token: <token>`，否则 `401`。
- `Origin` 必须是 `chrome-extension://<扩展ID>`，否则 `403`（防任意网页驱动）。
- `Host` 头必须是 `127.0.0.1:<port>`，否则 `403`（防 DNS rebinding）。
- 请求体一律 JSON（`Content-Type: application/json`），UTF-8。
- 响应：`200` 成功；`4xx` 鉴权/格式错误；`5xx` 桥内部错误。

### 4.2 端点

#### `GET /ping` — 健康探测

- 响应：`{"pong":true}`。扩展重连探测、Host 健康检查都用它。

#### `GET /command` — 取待执行命令（长轮询）

- 队列有命令 → 立即返回 `{"id":1,"cmd":"navigate","url":"..."}`
- 队列空 → 挂起最多 **10s**，超时返回 `{}`（扩展收到空立即再轮询，间隔 50ms）
- 响应头 `Cache-Control: no-store`

#### `POST /frame` — 帧上行

```json
{"seq": 1234.567, "data": "<base64 jpeg>", "width": 1200, "height": 800}
```

- `seq`：任意单调值（扩展用 `screencastFrame.metadata.timestamp`）
- 桥校验：`seq` 为 number、`data` 为 string、宽高为正整数；不合格 → `400`（**不转发**）
- 成功 → `200 {}`；桥立即转发一行 `frame` 给 Host

#### `POST /event` — 事件上行

```json
{"type":"state","url":"https://...","title":"..."}
{"type":"cmdResult","id":3,"ok":true,"result":{"value":"..."}}
{"type":"cmdResult","id":4,"ok":false,"error":{"code":"TIMEOUT","message":"..."}}
```

- `state`：页面导航/标题变化（扩展从 `Page.frameNavigated` / `Page.titleChanged` 触发）
- `cmdResult`：命令执行结果（必须携带原 `id`）
- 桥校验 `type` 枚举，其余字段透传 → 转成 stdout 行

### 4.3 错误码（桥对外）

| HTTP | body `{error:{code}}` | 含义 |
|---|---|---|
| 401 | `UNAUTHORIZED` | token 缺失/错误 |
| 403 | `BAD_ORIGIN` / `BAD_HOST` | Origin 或 Host 头不符 |
| 400 | `BAD_REQUEST` | JSON 解析失败或字段校验失败 |
| 404 | `NOT_FOUND` | 未知端点 |
| 503 | `SHUTTING_DOWN` | 桥已进入停止流程 |

## 5. 队列与并发约束

- **命令队列 FIFO**，容量上限 64（超出 → 该命令直接 `err {code:'QUEUE_FULL'}` 回 Host，不排队）。
- **扩展同一时刻只执行一条命令**（扩展侧串行，见 `extension-design.md` §6.5）。若扩展 10s 内未回 `cmdResult`，桥标记该 id `STALE` 并在下一条命令返回前**丢弃**该结果（Host 侧按命令超时处理）。
- 帧/事件不排队：直接转发，写 stdout 失败（Host 已死）→ 桥记录 `log` 并进入退出流程（见 §8）。

## 6. token 与安全

- 生成：Host 用 CSPRNG 生成 16 字符 hex。
- 传输：仅经 stdin（Host→桥）与面板展示（Host→用户→手贴进 popup）；**不写日志、不落盘**。
- 校验位置：**桥**（唯一校验点）。扩展与 Host 都不再校验，简化职责。
- 风险与缓解：
  - 本机恶意网页可 `fetch 127.0.0.1` → 被 `Origin` 校验拦（网页 Origin 不是 `chrome-extension://`）。
  - 恶意扩展可伪造 Origin → 但能装扩展的用户本就有浏览器全部权限，超出本组件威胁模型。
  - token 泄露（如截图面板）→ 面板明示连接码一次性展示，可点「重置」令 Host 重新生成。

## 7. cmdResult 归一化（桥 → Host 的两条路径）

为简化 Host 侧实现，桥把 `cmdResult` 直接归一化为标准命令响应：

| 扩展上报 | 桥 → Host stdout |
|---|---|
| `{"type":"cmdResult","id":3,"ok":true,"result":{...}}` | `{"type":"ok","id":3,"result":{...}}` |
| `{"type":"cmdResult","id":4,"ok":false,"error":{...}}` | `{"type":"err","id":4,"error":{...}}` |

Host 无需感知 `evt` 通道的存在（`evt` 仅用于未来扩展自定义事件）。

## 8. 生命周期

| 触发 | 行为 | 退出码 |
|---|---|---|
| Host 发 `stop` 命令（或 `{"cmd":"shutdown"}`） | 关闭 http server → 回 `{"type":"exit","code":0}` → 退出 | 0 |
| stdin EOF（Host 进程死/被 kill） | 同上，尽力清理 | 0 |
| stdout 写失败（Host 已死） | 立即退出 | 1 |
| 监听端口失败 / 配置非法 | stdout `{"type":"err","id":0,"error":{...}}` 后退出 | 2 |
| 空闲超时（可选，v1 不做） | – | – |

- 桥**不**负责杀扩展/浏览器（扩展由浏览器管理，专用标签页由 `stop` 命令关闭）。
- Host 侧兜底：插件 stop/update 时 `handle.terminate()` 强杀桥（见 `host-plugin.md` §5）。

## 9. 交付物

```
bridge/
├── bridge.js          # 单文件实现（node 内置 http/net 即可，零依赖）
└── bridge.test.mjs    # 契约冒烟测试（起桥 → 模拟 Host 与扩展两侧）
```

实现要点：`http.createServer` 单进程单端口；`/command` 挂起用「等待者数组」实现（新命令到达时唤醒队头等待者）；长轮询超时用 `setTimeout`；全部同步小函数，无第三方依赖。
