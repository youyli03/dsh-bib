// plugin/host.template.js —— dsh-bib Host 半区模板（动态 Cordis 插件）
// 桥生命周期 + 14 个 browser_* 工具 + bib/* RPC + 树契约（rev/changed/near）+ 周期截帧
// 运行时约束：无 process/fetch/WebSocket；subprocess/fs/timer 为服务；harness 为 builtin。
//
// 部署说明：本文件是模板，由 scripts/build-host.mjs 生成 plugin/host.js——
// 构建时把 bridge/bridge.js 的完整源码内联到 __BRIDGE_CODE_INLINE__ 占位符，
// Host 用 `node -e <内联代码>` spawn 桥，无需任何绝对路径配置，clone 即用。

return {
  inject: ['subprocess', 'fs', 'timer'],
  apply(ctx) {
    const { subprocess, fs, timer } = ctx;

    // 桥源码（构建时由 scripts/build-host.mjs 从 bridge/bridge.js 内联生成）
    const BRIDGE_CODE = __BRIDGE_CODE_INLINE__;

    const state = {
      status: 'stopped',      // stopped|starting|running|degraded|error
      port: null,
      token: null,
      code: null,             // 连接码（未 attach 时暴露给面板）
      url: '', title: '',
      frame: null,            // {seq, data, width, height}
      lastSeq: -1,
      lastFrameAt: 0,
      rev: 0,
      lastTreeHash: null,
      lastClick: null,        // {x, y}
      tabs: [],
      activeTabId: null,
      lastError: '',
    };

    let bridge = null;        // SubprocessHandle
    let outBuf = '';
    let cmdSeq = 1;
    const pending = new Map(); // id -> {resolve, reject, disposer}
    let statusWaiters = [];

    // ---------------- 工具 ----------
    function genToken() {
      // Host 无 crypto builtin；PoC 用 Math.random（弱随机，正式版换 CSPRNG）
      let s = '';
      for (let i = 0; i < 4; i++) {
        s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
      }
      return s.slice(0, 16);
    }

    function emitStatus() {
      for (const w of statusWaiters) w();
      statusWaiters = [];
    }

    function waitForStatus(status, ms) {
      return new Promise((resolve) => {
        if (state.status === status) return resolve(true);
        const t = timer.timeout(() => resolve(false), ms);
        statusWaiters.push(() => { t(); resolve(true); });
      });
    }

    // ---------------- 桥生命周期 ----------------
    async function startBridge() {
      state.token = genToken();
      state.status = 'starting';
      state.lastError = '';
      bridge = subprocess.spawn({
        argv: ['node', '-e', BRIDGE_CODE],
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        graceMs: 1000,
      });
      bridge.stdout.on('data', (c) => {
        outBuf += c.toString();
        let i;
        while ((i = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, i).trim();
          outBuf = outBuf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          onBridgeMsg(msg);
        }
      });
      bridge.done.then((outcome) => {
        if (state.status !== 'stopped') {
          state.status = 'error';
          state.lastError = '桥退出 code=' + outcome.exitCode;
        }
        rejectAll('BRIDGE_DIED', '桥已退出');
        emitStatus();
      }).catch((e) => {
        state.status = 'error';
        state.lastError = '桥 spawn 失败: ' + String((e && e.message) || e);
        rejectAll('BRIDGE_SPAWN_FAILED', state.lastError);
        emitStatus();
      });
      try {
        bridge.stdin.write(JSON.stringify({ id: 0, cmd: 'config', token: state.token }) + '\n');
      } catch (e) {
        state.lastError = '写桥配置失败: ' + String(e);
      }
      timer.timeout(() => {
        if (state.status === 'starting') {
          state.status = 'error';
          state.lastError = '桥启动超时（未收到 ready）';
          try { bridge.terminate(); } catch { /* ignore */ }
          emitStatus();
        }
      }, 5000);
    }

    function stopBridge() {
      if (bridge) {
        try { bridge.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch { /* ignore */ }
        timer.timeout(() => { try { bridge.terminate(); } catch { /* ignore */ } }, 1000);
      }
      bridge = null;
      rejectAll('STOPPED', '浏览器已停止');
      state.status = 'stopped';
      state.port = null;
      state.code = null;
      state.frame = null;
      state.lastSeq = -1;
      state.url = '';
      state.title = '';
      state.tabs = [];
      state.activeTabId = null;
      state.lastTreeHash = null;
      state.lastClick = null;
      state.lastError = '';
      emitStatus();
    }

    function rejectAll(code, message) {
      for (const [, p] of pending) {
        try { p.disposer(); } catch { /* ignore */ }
        p.reject(Object.assign(new Error(message), { code }));
      }
      pending.clear();
    }

    function onBridgeMsg(msg) {
      switch (msg.type) {
        case 'ready':
          state.port = msg.port;
          state.status = 'running';
          state.code = '127.0.0.1:' + msg.port + '#' + state.token;
          emitStatus();
          break;
        case 'frame':
          if (msg.seq > state.lastSeq) {
            state.lastSeq = msg.seq;
            state.frame = { seq: msg.seq, data: msg.data, width: msg.width, height: msg.height };
            state.lastFrameAt = Date.now();
          }
          break;
        case 'state':
          state.url = msg.url || '';
          state.title = msg.title || '';
          break;
        case 'ok': {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            p.disposer();
            p.resolve(msg.result || {});
          }
          break;
        }
        case 'err': {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            p.disposer();
            p.reject(Object.assign(new Error((msg.error && msg.error.message) || '桥错误'), { code: (msg.error && msg.error.code) || 'BRIDGE_ERROR' }));
          }
          break;
        }
        case 'evt':
          if (msg.type === 'detached') state.status = 'degraded';
          break;
        case 'log':
          console.log('[dsh-bib]', msg.level, msg.message);
          break;
        case 'exit':
          break;
      }
    }

    // ---------------- 命令通道 ----------------
    function sendCommand(cmd, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (state.status !== 'running' || !bridge) {
          reject(Object.assign(new Error('浏览器未运行'), { code: 'NOT_RUNNING' }));
          return;
        }
        const id = cmdSeq++;
        const disposer = timer.timeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('命令超时'), { code: 'TIMEOUT' }));
        }, timeoutMs || 10000);
        pending.set(id, { resolve, reject, disposer });
        try {
          bridge.stdin.write(JSON.stringify({ id, cmd, ...(params || {}) }) + '\n');
        } catch (e) {
          pending.delete(id);
          disposer();
          reject(Object.assign(new Error(String(e)), { code: 'STDIN_FAILED' }));
        }
      });
    }

    // ---------------- 树契约 ----------------
    // 每次 browser_* 工具调用结束都返回**最新完整树节点**（可被下一次调用覆盖）：
    // changed:true  → rev 递增 + 完整 nodes；changed:false → rev 不变但附最新 nodes 快照。
    // 节点字段：{role, name, ref, x, y, w, h, data?}
    function hashTree(nodes) {
      let s = '';
      for (const n of nodes.slice(0, 300)) {
        s += n.role + '|' + (n.name || '') + '|' + (n.data ? JSON.stringify(n.data) : '') +
          '|' + n.x + ',' + n.y + ',' + n.w + ',' + n.h + ';';
      }
      return s;
    }

    function nearest(nodes, pt, k) {
      if (!pt) return [];
      return nodes
        .map((n) => ({ n, d: Math.hypot(n.x + n.w / 2 - pt.x, n.y + n.h / 2 - pt.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, k)
        .map((x) => ({ role: x.n.role, name: x.n.name, x: x.n.x, y: x.n.y }));
    }

    async function buildTree(exec, afterClick) {
      const out = { tree: null };
      try {
        let nodes = [];
        try {
          const r = await sendCommand('tree', {}, 10000);
          nodes = (r && r.nodes) || [];
        } catch { /* tree 失败不阻塞操作 */ }
        const hash = hashTree(nodes);
        const changed = hash !== state.lastTreeHash;
        state.lastTreeHash = hash;
        const near = afterClick ? nearest(nodes, state.lastClick, 5) : undefined;
        // 每次工具调用都把对话里更早的树整体压缩掉，只留本次最新树：
        // 压缩在返回新树前执行，本次 tool/result 尚未写入 surface，因此扫描到的
        // browser_* 结果全部是历史树；压缩后本次结果成为唯一完整树。
        await compactOldTrees(exec);
        if (changed) {
          state.rev++;
          out.tree = {
            rev: state.rev,
            changed: true,
            nodes: nodes.slice(0, 300),
            ...(near ? { near } : {}),
          };
        } else {
          // 页面未变化时也回传最新 nodes 快照（可被下一次调用覆盖）：
          // 保证模型在连续操作/静态页面下始终持有可点击的树，而非空摘要。
          out.tree = {
            rev: state.rev,
            changed: false,
            nodes: nodes.slice(0, 300),
            url: state.url,
            summary: { title: state.title, nodeCount: nodes.length },
            ...(near ? { near } : {}),
          };
        }
      } catch { /* ignore */ }
      return out;
    }

    // 历史树压缩：纯正则 + session.append replace 重写，无模型、秒级。
    // 树块由 treeSection 渲染时带上 ⟦BIBTREE⟧ 边界标记；每次 browser_* 调用返回新树前，
    // 扫描 surface 中所有历史 tool/result，用正则把旧树块整体替换成一行占位，
    // 通过 session.append('tool/result', {surfaceOp:{op:'replace'}}) 重写该节点
    // （官方 shadow-price 协议：replace 前 append compaction/prune 记账）。
    // 本次结果尚未写入 surface，因此扫描到的树全部是历史树；压缩后本次结果成为唯一完整树。
    async function compactOldTrees(exec) {
      try {
        const agent = exec && exec.agent;
        if (!agent) return;
        const session = agent.session;
        const nodes = session.surface ? session.surface.nodes : null;
        const events = session.events;
        if (!nodes || !events || !Array.isArray(nodes) || nodes.length === 0) return;

        const tokenMeter = ctx.get('tokenMeter');
        const TREE_BLOCK_RE = /\n⟦BIBTREE rev=\d+⟧[\s\S]*?\n⟦\/BIBTREE⟧/g;
        const PLACEHOLDER = '\n（旧树已压缩，最新树见最近一次操作）\n';

        let prunedCount = 0;
        for (const seq of [...nodes]) {
          const ev = events[seq];
          if (!ev || ev.type !== 'tool/result') continue;
          const blocks = ev.data && ev.data.message && ev.data.message.content;
          const result = Array.isArray(blocks) && blocks[0];
          if (!result || result.type !== 'tool-result' || !Array.isArray(result.content)) continue;
          const joined = result.content
            .map((b) => (b && b.type === 'text' ? b.text : ''))
            .join('\n');
          if (!joined.includes('⟦BIBTREE')) continue;

          const newContent = result.content.map((b) => {
            if (!b || b.type !== 'text' || !b.text.includes('⟦BIBTREE')) return b;
            const text = b.text.replace(TREE_BLOCK_RE, PLACEHOLDER);
            return Object.assign({}, b, { text });
          });
          const shadowedTokenCount = tokenMeter && typeof tokenMeter.estimateMessage === 'function'
            ? tokenMeter.estimateMessage(ev.data.message)
            : 0;
          try {
            session.append('compaction/prune', {
              shadowedRange: { start: seq, end: seq },
              shadowedSeqs: [seq],
              shadowedTokenCount,
            });
          } catch { /* 记账失败不阻塞重写 */ }
          const message = Object.assign({}, ev.data.message, { content: [Object.assign({}, result, { content: newContent })] });
          session.append('tool/result', Object.assign({}, ev.data, { message }), {
            surfaceOp: { op: 'replace', start: seq, end: seq },
            sourceEventSeqs: [seq],
          });
          prunedCount++;
        }
        if (prunedCount > 0) console.log('[dsh-bib] 旧树压缩:', prunedCount, '个历史结果已重写');
      } catch (e) {
        console.log('[dsh-bib] 旧树压缩跳过:', (e && e.message) || e);
      }
    }

    // ---------------- 工具执行骨架 ----------------
    async function ensureRunning() {
      if (state.status === 'running') return;
      if (state.status === 'starting' || state.status === 'degraded') {
        const ok = await waitForStatus('running', 5000);
        if (!ok) throw Object.assign(new Error('浏览器未就绪'), { code: 'NOT_RUNNING' });
        return;
      }
      await startBridge();
      const ok = await waitForStatus('running', 5000);
      if (!ok) throw Object.assign(new Error('浏览器启动失败'), { code: 'START_FAILED' });
    }

    function errResult(code, message) {
      return { ok: false, error: { code, message } };
    }

    const sleep = (ms) => new Promise((resolve) => { timer.timeout(resolve, ms); });

    // 操作后主动截帧更新缓存（后台标签 screencast 节流，靠按需截帧保证画面）
    async function applyShot() {
      try {
        const shot = await sendCommand('screenshot', {}, 8000);
        if (shot && shot.data) {
          const seq = (typeof shot.seq === 'number' && shot.seq > state.lastSeq) ? shot.seq : Date.now();
          state.frame = { seq, data: shot.data, width: shot.width || 0, height: shot.height || 0 };
          state.lastSeq = seq;
          state.lastFrameAt = Date.now();
        }
      } catch { /* 截帧失败不阻塞操作 */ }
    }

    // 周期主动截帧：页面自身变化（SPA 懒加载/动画/计时器）时预览也能跟上，
    // 不依赖操作触发。每 2s 检查一次，距上次帧 >1.5s 才真正截（避免与操作后 applyShot 空转）。
    let refreshing = false;
    const refreshTick = timer.interval(async () => {
      if (state.status !== 'running' || refreshing) return;
      if (Date.now() - state.lastFrameAt < 1500) return;
      refreshing = true;
      try {
        await applyShot();
      } catch { /* ignore */ } finally {
        refreshing = false;
      }
    }, 2000);
    ctx.effect(() => refreshTick);

    async function runAction(exec, cmdName, cmdArgs, opts) {
      opts = opts || {};
      try {
        await ensureRunning();
      } catch (e) {
        return errResult(e.code || 'NOT_RUNNING', (e && e.message) || String(e));
      }
      let res;
      try {
        res = await sendCommand(cmdName, cmdArgs, opts.timeout || 10000);
      } catch (e) {
        return errResult(e.code || 'BRIDGE_ERROR', (e && e.message) || String(e));
      }
      const treeWrap = await (async () => {
        await sleep(400);
        return buildTree(exec, opts.afterClick);
      })();
      await applyShot();
      return { ok: true, result: res, tree: treeWrap.tree };
    }

    // ---------------- 工具注册 ----------------
    function registerTool(name, description, params, handler) {
      const tool = harness.defineTool({
        name,
        description,
        parameters: { type: 'object', properties: params },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            return [{ type: 'text', text: JSON.stringify(value) }];
          },
        },
        async execute(args, exec) {
          try {
            return await handler(args, exec);
          } catch (e) {
            return errResult('INTERNAL', String((e && e.message) || e));
          }
        },
      });
      const disposer = harness.registerTool(ctx, tool);
      ctx.effect(() => disposer);
    }

    registerTool('browser_status', '查询 dsh-bib 浏览器运行状态与当前激活标签的 url/title。', {
      status: { type: 'string', description: 'stopped|starting|running|degraded|error' },
    }, async () => ({
      ok: true,
      result: {
        state: state.status,
        url: state.url,
        title: state.title,
        hasFrame: !!state.frame,
        seq: state.lastSeq,
        tabs: state.tabs.length,
        activeTab: state.activeTabId,
        lastError: state.lastError,
      },
    }));

    registerTool('browser_open', '启动浏览器（若未运行）并在标签页中打开 url（优先复用现有激活标签，无标签时新建）。', {
      url: { type: 'string', description: '目标 URL' },
    }, async (args, exec) => {
      try {
        await ensureRunning();
      } catch (e) {
        return errResult(e.code || 'NOT_RUNNING', (e && e.message) || String(e));
      }
      let res;
      try {
        const tabs = await sendCommand('tabs', {}, 5000);
        const list = (tabs && tabs.tabs) || [];
        if (list.length > 0) {
          res = await sendCommand('navigate', { url: args.url }, 20000);
          await syncTabs();
          await sleep(400);
          const treeWrap = await buildTree(exec);
          await applyShot();
          return { ok: true, result: res, tree: treeWrap.tree };
        }
      } catch { /* tabs 查询失败 → 走 newTab 兜底 */ }
      res = await runAction(exec, 'newTab', { url: args.url }, { timeout: 15000 });
      await syncTabs();
      return res;
    });

    registerTool('browser_navigate', '在激活标签页导航到 url 并等待加载完成。', {
      url: { type: 'string', description: '目标 URL' },
    }, (args, exec) => runAction(exec, 'navigate', { url: args.url }, { timeout: 20000 }));

    registerTool('browser_go', '激活标签页历史前进或后退。', {
      direction: { type: 'string', enum: ['back', 'forward'], description: '方向' },
    }, (args, exec) => runAction(exec, 'go', { direction: args.direction }));

    registerTool('browser_reload', '刷新激活标签页。', {}, (args, exec) => runAction(exec, 'reload', {}));

    registerTool('browser_click', '在激活标签页点击。优先用 ref（来自 browser_* 返回的树节点 ref 字段，自动滚动到元素并点中心）；无 ref 时按视口 CSS 坐标点击。', {
      ref: { type: 'string', description: '树节点 ref（可选，优先）' },
      x: { type: 'number', description: 'X 坐标（无 ref 时用）' },
      y: { type: 'number', description: 'Y 坐标（无 ref 时用）' },
    }, async (args, exec) => {
      if (!args.ref) state.lastClick = { x: args.x, y: args.y };
      return runAction(exec, 'click', { x: args.x, y: args.y, ref: args.ref }, { afterClick: true });
    });

    registerTool('browser_type', '在激活标签页输入文本（绕过 IME，中文可用；末尾换行触发回车）。', {
      text: { type: 'string', description: '要输入的文本' },
    }, (args, exec) => runAction(exec, 'type', { text: args.text }));

    registerTool('browser_scroll', '在激活标签页滚动（先移动到 x,y 再滚 dx,dy）。', {
      x: { type: 'number' }, y: { type: 'number' },
      dx: { type: 'number', description: '水平滚动量' }, dy: { type: 'number', description: '垂直滚动量' },
    }, (args, exec) => runAction(exec, 'scroll', { x: args.x, y: args.y, dx: args.dx, dy: args.dy }));

    registerTool('browser_screenshot', '返回激活标签页当前帧 dataURL（base64 JPEG）与内在尺寸。', {}, async () => {
      try {
        await ensureRunning();
      } catch (e) {
        return errResult('NOT_RUNNING', '浏览器未启动');
      }
      if (state.frame) {
        return {
          ok: true,
          result: {
            data: 'data:image/jpeg;base64,' + state.frame.data,
            width: state.frame.width,
            height: state.frame.height,
            seq: state.frame.seq,
          },
        };
      }
      try {
        const r = await sendCommand('screenshot', {}, 10000);
        if (r && r.data) {
          return {
            ok: true,
            result: {
              data: 'data:image/jpeg;base64,' + r.data,
              width: r.width || 0,
              height: r.height || 0,
              seq: r.seq || 0,
            },
          };
        }
        return errResult('NO_FRAME', '扩展亦无帧：' + JSON.stringify(r || {}));
      } catch (e) {
        return errResult('NO_FRAME', '扩展截图失败：' + String((e && e.message) || e) + ' code=' + (e && e.code));
      }
    });

    registerTool('browser_eval', '在激活标签页执行 JS 表达式并返回值（JSON 序列化）。', {
      expression: { type: 'string', description: 'JS 表达式' },
    }, (args, exec) => runAction(exec, 'eval', { expression: args.expression }, { timeout: 15000 }));

    registerTool('browser_tabs', '列出全部标签（tabId、url、title、是否激活）。', {}, async (args, exec) => {
      try {
        await ensureRunning();
      } catch (e) {
        return errResult('NOT_RUNNING', '浏览器未启动');
      }
      const res = await sendCommand('tabs', {});
      await syncTabs();
      return { ok: true, result: { tabs: state.tabs }, tree: (await buildTree(exec)).tree };
    });

    registerTool('browser_switch', '切换激活标签页（单激活模型：帧流/树/操作只针对激活标签）。', {
      tabId: { type: 'number', description: '目标标签 tabId（来自 browser_tabs）' },
    }, async (args, exec) => {
      const res = await runAction(exec, 'switch', { tabId: args.tabId });
      await syncTabs();
      return res;
    });

    registerTool('browser_activate', '把激活标签页带到前台并聚焦 Edge 窗口（供人直接操作真实页面）。', {}, (args, exec) => runAction(exec, 'activate', {}));

    registerTool('browser_stop', '停止浏览器（停 screencast 并 detach 全部标签，保留标签页）。', {}, async () => {
      try {
        await sendCommand('stop', {});
      } catch { /* ignore */ }
      stopBridge();
      return { ok: true, result: {} };
    });

    async function syncTabs() {
      try {
        const res = await sendCommand('tabs', {});
        state.tabs = (res && res.tabs) || [];
        const act = state.tabs.find((t) => t.active);
        state.activeTabId = act ? act.tabId : null;
      } catch { /* ignore */ }
    }

    // ---------------- bib/* RPC（Client→Host） ----------------
    const handle = (method, handler) => {
      const disposer = harness.handle(method, handler);
      ctx.effect(() => disposer);
    };

    handle('bib/status', async () => ({
      state: state.status,
      url: state.url,
      title: state.title,
      hasFrame: !!state.frame,
      seq: state.lastSeq,
      code: state.status === 'running' ? state.code : null,
      tabs: state.tabs,
      activeTab: state.activeTabId,
      lastError: state.lastError,
    }));

    handle('bib/start', async () => {
      try {
        await ensureRunning();
        return { ok: true, code: state.code, state: state.status };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), state: state.status };
      }
    });

    handle('bib/stop', async () => {
      try { await sendCommand('stop', {}); } catch { /* ignore */ }
      stopBridge();
      return { ok: true };
    });

    handle('bib/poll', async () => ({
      state: state.status,
      seq: state.lastSeq,
      data: state.frame ? state.frame.data : '',
      width: state.frame ? state.frame.width : 0,
      height: state.frame ? state.frame.height : 0,
      url: state.url,
      title: state.title,
    }));

    handle('bib/input', async (args) => {
      try {
        await ensureRunning();
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
      try {
        if (args.type === 'click') {
          state.lastClick = { x: args.x, y: args.y };
          await sendCommand('click', { x: args.x, y: args.y });
        } else if (args.type === 'scroll') {
          await sendCommand('scroll', { x: args.x, y: args.y, dx: args.dx, dy: args.dy });
        } else {
          return { ok: false, error: '未知输入类型' };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/navigate', async (args) => {
      try {
        await ensureRunning();
        if (args.action === 'go') {
          await sendCommand('go', { direction: args.direction });
        } else if (args.action === 'reload') {
          await sendCommand('reload', {});
        } else {
          await sendCommand('navigate', { url: args.url }, 20000);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/switch', async (args) => {
      try {
        await ensureRunning();
        await sendCommand('switch', { tabId: args.tabId });
        await syncTabs();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/newTab', async (args) => {
      try {
        await ensureRunning();
        await sendCommand('newTab', { url: args.url || 'about:blank' });
        await syncTabs();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/closeTab', async (args) => {
      try {
        await ensureRunning();
        await sendCommand('close', { tabId: args.tabId });
        await syncTabs();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/activate', async () => {
      try {
        await ensureRunning();
        await sendCommand('activate', {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });

    handle('bib/resetCode', async () => {
      try {
        await ensureRunning();
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
      return { ok: true, code: state.code };
    });

    // ---------------- 自动发现路由（扩展经 DSH Web 发现桥） ----------------
    const webServer = ctx.get('webServer');
    if (webServer) {
      const routeDisposer = webServer.register({
        kind: 'exact',
        path: '/dsh-bib/bridge-info',
        handler: (req, res) => {
          const origin = req.headers.origin || '';
          const json = (status, body) => {
            res.writeHead(status, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
            });
            res.end(JSON.stringify(body));
          };
          if (!origin.startsWith('chrome-extension://')) {
            return json(403, { error: { code: 'BAD_ORIGIN' } });
          }
          const m = state.code && state.code.match(/^127\.0\.0\.1:(\d+)#([0-9a-fA-F]+)$/);
          if (state.status !== 'running' || !m) {
            return json(200, { available: false });
          }
          json(200, { available: true, port: Number(m[1]), token: m[2] });
        },
      });
      ctx.effect(() => routeDisposer);
    }

    // ---------------- 生命周期清理 ----------------
    ctx.effect(() => () => {
      stopBridge();
    });
  },
};
