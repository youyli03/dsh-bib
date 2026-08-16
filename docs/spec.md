# dsh-bib 功能与 UI 规格（v1 定稿 · 已实现）

> 在 DSH Web GUI 里嵌入一个**可控的真实浏览器视口**：人和模型都能看、都能操作，复用用户 Edge 的登录态。
> 架构一句话：Edge 扩展（`chrome.debugger` attach 真实标签页）↔ node 中继桥（HTTP 转发）↔ Host 插件（工具+RPC）↔ Client 会话内浏览器窗口（帧显示+输入）。

## 1. 主要功能

### 1.1 单激活标签模型（核心）

- **永远只有一个「激活标签」**被显示和控制：帧、树、点击/输入/滚动、截图全部只针对它。
- 标签**集合**可创建/选择：后台标签保持 CDP 会话，**不出帧**（单帧流）。
- 多标签天然共享登录态（同一浏览器实例）；`rev` 全局递增，`lastClick` 按标签记录。
- 新标签 `chrome.tabs.create({active:false})`（不抢用户当前页）。

### 1.2 模型侧（14 个工具，`browser_*`）

> AI 感知三通道：**截图**（`browser_screenshot`）+ **AX 树**（随每次操作返回）+ **eval**（JS 查询）。除标注外作用于激活标签。

| 工具 | 作用 |
|---|---|
| `browser_status` | 运行状态 + 激活标签 url/title |
| `browser_open` | 启动（懒加载）+ 打开 url（**优先复用现有标签导航**，无标签才新建） |
| `browser_navigate` | 激活标签导航并等加载完成 |
| `browser_go` | 历史前进 / 后退 |
| `browser_reload` | 刷新 |
| `browser_click` | 点击：**优先 `ref`**（树节点 ref，自动滚动到元素点中心）；无 ref 按坐标 |
| `browser_type` | 输入文本（绕过 IME，中文可用；末尾换行触发回车） |
| `browser_scroll` | 滚轮 |
| `browser_screenshot` | 返回当前帧 dataURL + 尺寸 |
| `browser_eval` | 执行 JS 并返回值 |
| `browser_tabs` | 列出全部标签 |
| `browser_switch` | 切换激活标签 |
| `browser_activate` | 把激活标签带到前台并聚焦 Edge 窗口（人直接操作） |
| `browser_stop` | 停止浏览器（detach 全部标签，保留标签页） |

### 1.3 AX 树（随操作返回，rev/changed/near 契约）

- **双通道语义提取**：DOM walk（ref 骨架）+ CDP `Accessibility.getFullAXTree`（浏览器引擎权威 role/name）。
  - 浏览器无障碍计算覆盖 aria 关联、`label[for]`、组合文本、shadow DOM 内容等 DOM 启发式推断不到的语义 —— **对所有站点通用，无需站点特例**。
  - AX 独有交互节点（shadow DOM / iframe 内容等 DOM walk 覆盖不到的）经 `DOM.resolveNode` 在页面注册 ref，保证可点击。
  - DOM 侧兜底：`data-*` 语义回退（`data-economy-item` JSON、`data-name`/`data-title`/`data-label`/`data-tooltip`）、父级 data 回退、无文本链接从 href `#id` 提取标识（Steam 库存卡片类）、节点附带 `data` 字段摘要。
- **每次操作后返回完整最新树**：`rev` 只在 `changed:true` 时递增；`changed:false` 时**仍回传最新 nodes 快照**（可被下一次调用覆盖），保证模型在连续操作/静态页面下始终持有可点击的树，而非空摘要。
- **历史树自动压缩（纯正则重写，无模型）**：每次 `browser_*` 调用返回新树前，扫描 session surface 中所有历史 `tool/result`，树块由 `treeSection` 渲染时自带 `⟦BIBTREE⟧` 边界标记，用正则把旧树整体替换成一行占位（保留工具结果的其他内容如点击坐标/附近节点）；通过 `session.append('tool/result', {surfaceOp:{op:'replace'}})` 官方机制重写节点，并先 append `compaction/prune` 记账（shadow-price 协议）—— 对话中始终只有**最新一份完整树**，无 LLM 摘要开销。
- 节点字段：`{role, name, ref, x, y, w, h, data?}`（ref 为 `ref_N` 稳定引用 + WeakRef 映射）。
- **操作后延迟 400ms 抓树**，等待 SPA/异步渲染，保证树反映最新页面。
- **ref 点击**：`browser_click {ref}` 解引用 → `scrollIntoView` → 元素中心坐标 → 真实点击。

### 1.4 用户侧 UI

- **会话内浏览器窗口**（`conversation.input.dock`，输入框上方常驻，不随聊天滚动）：标题栏（状态灯/配对/停止）+ tab 条（多标签/新建）+ 工具条（后退/前进/刷新/URL 前往/切到 Edge）+ 视口 + 状态区。
  - **宽度**：复用宿主 CSS 变量 `--dsh-composer-card-max-width`，与输入框逐像素一致（居中）
  - **圆角**：22px，与输入框（`.uV2eYG_card`）一致
  - **「对话/轨迹」视图切换完整保留**（不替换标题条）
- **对话记录卡片**（`tool.view.cordis`）：对话流内折叠标题条，可展开看视口。
- 人工操作：卡片/窗口内点击、滚轮、URL 导航；「切到 Edge」跳真实标签页。
- 主题跟随：全部使用 `--dsw-alias-*` 真实主题 token。

### 1.5 自动发现与保活（已实现）

- **自动发现**：Host 注册 `webServer` 路由 `/dsh-bib/bridge-info`（Origin 校验 + CORS 回声），扩展 SW 启动 + 周期探测自动拿到 `port+token`，免手动配对（手动连接码为 fallback）。
- **MV3 保活**：被控页注入 2px 隐藏心跳动画 → screencast 持续出帧 → `chrome.debugger` 事件持续 → SW 不终止；`chrome.alarms` 每分钟兜底唤醒。
- **断线自愈**：ping 失败 → 立即 autoDiscover 新桥端口（3s 内）；桥重启换端口自动重连。
- **操作后截帧**：后台标签 screencast 被 Chromium 节流，每次操作后主动 `captureScreenshot` 更新帧缓存（带 `getLayoutMetrics` 尺寸）。

### 1.6 登录态与安全

- 登录态：用户真实 Edge 天然继承（扩展 attach 真实标签页），无拷贝、无锁。
- 安全：桥 token + Origin（`chrome-extension://`）+ Host 头三重校验；CORS preflight 放行；cookie 永不出浏览器；插件停止 → 杀桥、工具消失。

## 2. 架构

```
对话浏览器窗口 (conversation.input.dock) ← bib/poll 500ms 轮询帧
      ↕ harness RPC（Client→Host）
Host 插件 dshb-1（14 工具 + bib/* RPC + bridge-info 路由）
      ↕ JSONL over stdio
node 中继桥（零依赖：鉴权/CORS/命令队列 FIFO/长轮询/帧转发，19 契约测试）
      ↕ HTTP（token 鉴权）
Edge 扩展（MV3：自动发现/alarms 心跳/标签持久化/手势 attach/ref 点击/DOM AX 树）
      ↕ CDP
真实 Edge 标签页（登录态天然）
```

## 3. 明确不做（v1 非目标）

多激活标签并发控制 / 剪贴板 / 完整键盘事件 / 桥自动重启 / macOS-Linux 安装 / 下载 / 设置页。

## 4. 已知遗留

- 旧树压缩（`compaction.compactRegion`）为尽力而为（surface span 未拿到时跳过）。
- token 用 `Math.random`（Host 无 crypto builtin，正式版换 CSPRNG）。
- 扩展 attach 目标的手势要求随 Edge 版本波动（SW 内 attach 当前可用）。
