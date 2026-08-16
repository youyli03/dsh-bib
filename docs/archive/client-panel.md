# dsh-bib 设计④ — Client 面板设计

> 组件：`plugin/client.jsx`，动态 Cordis 插件（Client 半区）
> 定位：`shell.overlay` 浮动层——帧显示、人工操作（点击/滚轮/URL）、配对引导、状态呈现。
> 配套：`host-plugin.md`（Host 半区）、`design-v2.md`（总纲）

## 1. 职责边界

Client 半区**只做展示与输入转发**：

1. 每 ~250ms 轮询 `bib/poll` 拉最新帧与状态，渲染 `<img>`。
2. 捕获面板内点击/滚轮/URL 输入 → 换算坐标 → `bib/input` / `bib/navigate`。
3. 显示连接码（配对引导）、状态灯、错误/降级提示。
4. 启停按钮 → `bib/start` / `bib/stop`。

Client **不做**：命令队列、帧缓存、桥管理、任何鉴权（都在 Host）。

## 2. 运行时约束（勘察结论，实现时以 Inspect 为准）

- Client 可用：`ctx` / `React` / `host`（`host.call(method, args)`）/ `styles` / `console`。
- Client **没有** `document` / `window` / `fetch` / `WebSocket` → 帧只能经 RPC 拉取；RPC 只有 Client→Host 单向。
- UI 必须注册到 Slot（`apply()` 不能直接返回元素）。面板挂 `shell.overlay`（浮动层，自带 `pointer-events:auto`，该层默认点击穿透）。
- 具体 Slot 注册契约与 props 以 Inspect Provider（`Slots.listSubTree` → 精确查询）为准，本节先给设计意图。

## 3. 布局（自上而下）

```
┌──────────────────────────────────────────────┐
│ ● 运行中  dsh-bib 内嵌浏览器        [—] [✕]   │ ← 标题栏（可拖动）
├──────────────────────────────────────────────┤
│ ◀ ▶ ⟳  [https://example.com      ] [前往] [外部] [停止] │ ← 工具条
├──────────────────────────────────────────────┤
│                                              │
│        <img> 帧流（等比缩放，居中）            │ ← 视口区（点击/滚轮转发）
│                                              │
│  提示：模型可用 browser_* 工具操作此页          │
├──────────────────────────────────────────────┤
│ URL: https://…  标题: …   状态: running       │ ← 状态区（可折叠）
└──────────────────────────────────────────────┘
```

### 3.1 标题栏

- 左侧状态灯：`stopped` 灰 / `starting` 黄（闪） / `running` 绿 / `degraded` 橙 / `error` 红。
- 拖动：整栏 `onMouseDown` 记录偏移，移动时更新悬浮层位置（Client 内状态；实现时看 Slot 是否提供定位 API，没有则用 overlay 自有样式）。
- 最小化 `[—]`：收起为仅标题栏（保留状态灯），再点展开。
- 关闭 `[✕]`：仅隐藏面板（不停止浏览器，避免误杀正在跑的会话；停止走工具条「停止」）。

### 3.2 工具条

| 控件 | 行为 |
|---|---|
| ◀ ▶ ⟳ | `bib/navigate {action:'go', direction}` / `{action:'reload'}` |
| URL 输入框 + 前往 | 失焦/回车 → `bib/navigate {url}`（自动补全 `https://` 当无协议时） |
| 外部 | `bib/openExternal`（在系统浏览器打开当前页） |
| 停止 | `bib/stop`（弹确认，因为会杀桥） |
| 连接 | `bib/start`；已运行则显示连接码（见 §4） |

### 3.3 视口区

- `<img>`：`src = data:image/jpeg;base64,<data>`，`width/height` 按容器等比缩放（`object-fit: contain` 语义），`draggable=false`。
- 无帧时显示占位：`stopped` → 「点击「启动」开始」；`starting` → 转圈；`degraded` → 「扩展离线」提示。
- 点击穿透提示：面板默认 `pointer-events:auto`（overlay 默认穿透被覆盖）。

### 3.4 状态区

- 当前 URL / 标题（来自 `bib/poll` 返回）。
- `degraded` 时红字提示：「扩展离线——请在 Edge 打开 dsh-bib 扩展并 attach（或检查专用窗口是否最小化）」。
- 可折叠，默认展开。

## 4. 配对引导（连接码）

状态为 `starting` 或 `running` 且扩展未 attach（Host 侧 `bib/status` 返回 `code`）时：

```
┌────────────────────────────┐
│ ① 在 Edge 打开 dsh-bib 扩展   │
│ ② 粘贴连接码：               │
│ 127.0.0.1:49152#a1b2c3d4e5f6a7b8 │
│    [复制] [重置]             │
└────────────────────────────┘
```

- 连接码**仅显示一次**（`bib/status` 只在未 attach 时返回 `code`；attach 后 Host 置空）。
- 「重置」→ `bib/resetCode` 生成新 token（泄露场景）。
- 复制按钮：Client 无 `navigator.clipboard`（无 `window`）→ 用 `host.call('bib/copy', {text})` 由 Host 侧复制？Host 也无剪贴板 → **v1 不做复制按钮**，连接码短（16 字符端口 + 16 字符 token）手抄/手输可接受；或面板以大字展示。

## 5. 交互与坐标换算

### 5.1 坐标基准

CDP 视口 CSS 像素（= 帧内在尺寸 `frame.width × frame.height`）。模型工具直接用该坐标系；**面板点击需把屏幕坐标换算回帧坐标**。

### 5.2 换算公式

```
scaleX = frame.width  / imgBox.clientWidth
scaleY = frame.height / imgBox.clientHeight
x = (e.clientX - imgBox.left) * scaleX
y = (e.clientY - imgBox.top)  * scaleY
```

- `imgBox`：`<img>` 元素的实际渲染盒（等比缩放后）。Client 无 `window`，但 React 合成事件有 `clientX/clientY`，容器尺寸可从事件目标 `getBoundingClientRect()` 取——**实现时确认 Client 环境是否允许读取元素几何**（React 事件对象可用则可行；否则退化为「按显示尺寸比例换算」并注明误差）。
- 点击 → `bib/input {type:'click', x, y}`（取整）。
- 滚轮 → `bib/input {type:'scroll', x, y, dx: e.deltaX, dy: e.deltaY}`（`onWheel` 需 `passive:false` 以 preventDefault，避免页面滚动面板本身——实现时若 React 事件默认被动则用 ref 原生监听，标注待验证）。
- 文本输入：面板不捕获键盘（焦点在 URL 框时除外）；模型输入走 `browser_type`。人工输入文本 v1 不做（URL 框够用）。

## 6. 状态与轮询循环

```
组件挂载：
  timer = setInterval(poll, 250)        // ctx.effect 注册，卸载清理
  poll:
    r = host.call('bib/poll')
    if r.seq !== lastSeq: setFrame(r)   // 帧更新（data 非空）
    setStatus(r.state, r.url, r.title)  // 状态/URL 更新
    若 r.state === 'stopped' && userWantsStart → host.call('bib/start')  // 可选自动重启
```

- `ctx.effect` 注册 timer 与清理（Client 侧同样要求副作用可逆）。
- 轮询失败（Host 重启/RPC 异常）→ 静默重试，状态区显示「正在重连…」；连续失败 5 次 → 显示 error 并降频到 1s。

## 7. 样式与主题

- 优先用 `styles` 提供的主题 token（背景、边框、文字色、圆角、阴影），随 DSH 主题自动明暗。
- 面板固定宽度 ~420px，高度 ~70vh，最大高度 90vh；`position` 由 overlay 机制决定（实现时确认）。
- 状态灯：纯 CSS 圆点（`background` + `box-shadow` 辉光），无图片依赖。
- 视口 `<img>` 背景：深色棋盘格（CSS `conic-gradient`）以区分透明/加载。

## 8. 已知限制（Client 侧）

- 无剪贴板 API → 连接码不提供「复制」按钮（v1）。
- 无 `window`/`document` → 依赖 React 合成事件取坐标；`getBoundingClientRect` 可用性待实现验证，备用方案是比例换算。
- 轮询 250ms → 帧率上限 ~4fps；人工输入延迟 ~250ms（与 v1 一致，如实声明）。
- 面板拖动若 Slot 不提供定位 API，则用 overlay 样式内联定位（实现时定）。

## 9. 交付物

```
plugin/client.jsx     # 本设计实现
```

PoC 先行：面板骨架（标题栏/工具条/视口 img/状态区）+ 250ms 轮询渲染 + 点击转发 + 连接码展示，即可人工验证全链路。
