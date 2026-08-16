import { defineTool } from '@deepseek-ai/dsh-tools';

export default {
  inject: ['subprocess', 'fs', 'timer', 'tools', 'webServer'],
  apply(ctx) {
    const { subprocess, fs, timer } = ctx;

    // 桥源码（构建时由 scripts/build-host.mjs 从 bridge/bridge.js 内联生成）
    const BRIDGE_CODE = "'use strict';\n// dsh-bib 中继桥 —— 扩展(HTTP) ↔ Host(JSONL stdio) 纯转发\n// 协议契约见 docs/bridge-api.md；本文件零第三方依赖。\n\nconst http = require('http');\nconst net = require('net');\n\nlet token = null;\nlet server = null;\nlet port = 0;\nlet shuttingDown = false;\nlet configured = false;\n\nconst cmdQueue = [];       // FIFO: 待扩展执行的命令\nconst waiters = [];        // GET /command 长轮询挂起的 {res, finish}\nlet pendingCmd = null;     // 最近下发命令 {id, at}，用于 stale 检查\nlet stdinBuf = '';\n\nconst QUEUE_LIMIT = 64;\nconst STALE_MS = 15000;\nconst POLL_HOLD_MS = 10000;\n\n// ---------------- stdout JSONL ----------------\nfunction emit(obj) {\n  try {\n    process.stdout.write(JSON.stringify(obj) + '\\n');\n  } catch {\n    shutdown(1);\n  }\n}\n\nfunction respond(res, status, body, extraHeaders) {\n  if (res.writableEnded) return;\n  const origin = res.req ? res.req.headers.origin : '';\n  const h = {\n    'Content-Type': 'application/json',\n    'Cache-Control': 'no-store',\n  };\n  // CORS：扩展跨源读取响应必须（仅对扩展 Origin 回声，且只在实际响应上）\n  if (origin && origin.startsWith('chrome-extension://')) {\n    h['Access-Control-Allow-Origin'] = origin;\n  }\n  if (extraHeaders) Object.assign(h, extraHeaders);\n  res.writeHead(status, h);\n  res.end(JSON.stringify(body));\n}\n\nfunction corsPreflight(res) {\n  const origin = res.req ? res.req.headers.origin : '';\n  const h = {\n    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',\n    'Access-Control-Allow-Headers': 'X-Bib-Token, Content-Type',\n    'Access-Control-Max-Age': '600',\n  };\n  if (origin && origin.startsWith('chrome-extension://')) {\n    h['Access-Control-Allow-Origin'] = origin;\n  }\n  res.writeHead(204, h);\n  res.end();\n}\n\nfunction readJson(req, cb) {\n  let raw = '';\n  req.on('data', (c) => {\n    raw += c;\n    if (raw.length > 2e6) req.destroy(new Error('body too large'));\n  });\n  req.on('end', () => {\n    if (req.destroyed) return;\n    try { cb(null, JSON.parse(raw || '{}')); }\n    catch (e) { cb(e); }\n  });\n  req.on('error', cb);\n}\n\n// ---------------- 鉴权（唯一校验点） ----------------\nfunction authorized(req) {\n  if (shuttingDown) return { ok: false, status: 503, code: 'SHUTTING_DOWN' };\n  const t = req.headers['x-bib-token'];\n  if (!token || typeof t !== 'string' || t !== token) {\n    return { ok: false, status: 401, code: 'UNAUTHORIZED' };\n  }\n  const origin = req.headers['origin'] || '';\n  if (!origin.startsWith('chrome-extension://')) {\n    return { ok: false, status: 403, code: 'BAD_ORIGIN' };\n  }\n  const host = req.headers['host'] || '';\n  if (host !== '127.0.0.1:' + port) {\n    return { ok: false, status: 403, code: 'BAD_HOST' };\n  }\n  return { ok: true };\n}\n\n// ---------------- HTTP 路由 ----------------\nfunction route(req, res) {\n  const url = req.url || '/';\n\n  // CORS 预检必须最先处理：浏览器 preflight 不带业务头（X-Bib-Token），\n  // 若先走鉴权会被 401 拦截，扩展的所有跨源请求都会失败。\n  if (req.method === 'OPTIONS') return corsPreflight(res);\n\n  const auth = authorized(req);\n  if (!auth.ok) return respond(res, auth.status, { error: { code: auth.code } });\n\n  if (req.method === 'GET' && url === '/ping') {\n    return respond(res, 200, { pong: true });\n  }\n\n  if (req.method === 'GET' && url === '/command') {\n    if (cmdQueue.length > 0) return takeCommand(res);\n    let finished = false;\n    const finish = (body) => {\n      if (finished) return;\n      finished = true;\n      const i = waiters.findIndex((w) => w.res === res);\n      if (i >= 0) waiters.splice(i, 1);\n      respond(res, 200, body);\n    };\n    waiters.push({ res, finish });\n    res.setTimeout(POLL_HOLD_MS, () => finish({}));\n    return;\n  }\n\n  if (req.method === 'POST' && url === '/frame') {\n    return readJson(req, (err, body) => {\n      if (err || !body || typeof body.seq !== 'number' ||\n          typeof body.data !== 'string' || body.data.length === 0 ||\n          !Number.isInteger(body.width) || !Number.isInteger(body.height) ||\n          body.width <= 0 || body.height <= 0) {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      emit({ type: 'frame', seq: body.seq, data: body.data, width: body.width, height: body.height });\n      respond(res, 200, {});\n    });\n  }\n\n  if (req.method === 'POST' && url === '/event') {\n    return readJson(req, (err, body) => {\n      if (err || !body || typeof body.type !== 'string') {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      if (body.type === 'state') {\n        if (typeof body.url !== 'string' || typeof body.title !== 'string') {\n          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n        }\n        emit({ type: 'state', url: body.url, title: body.title });\n      } else if (body.type === 'cmdResult') {\n        if (typeof body.id !== 'number') {\n          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n        }\n        if (pendingCmd && pendingCmd.id === body.id &&\n            Date.now() - pendingCmd.at > STALE_MS) {\n          emit({ type: 'log', level: 'warn', message: 'stale cmdResult dropped: ' + body.id });\n          return respond(res, 200, {});\n        }\n        pendingCmd = null;\n        if (body.ok === true) {\n          emit({ type: 'ok', id: body.id, result: body.result || {} });\n        } else {\n          emit({ type: 'err', id: body.id, error: body.error || { code: 'ERROR' } });\n        }\n      } else if (body.type === 'detached') {\n        emit({ type: 'evt', type: 'detached' });\n      } else if (body.type === 'log') {\n        emit({ type: 'log', level: body.level || 'info', message: String(body.message || '') });\n      } else {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      respond(res, 200, {});\n    });\n  }\n\n  respond(res, 404, { error: { code: 'NOT_FOUND' } });\n}\n\nfunction takeCommand(res) {\n  const cmd = cmdQueue.shift();\n  pendingCmd = { id: cmd.id, at: Date.now() };\n  respond(res, 200, cmd);\n}\n\n// ---------------- 启动 ----------------\nfunction findPort(cb) {\n  const s = net.createServer();\n  s.on('error', () => cb(0));\n  s.listen(0, '127.0.0.1', () => {\n    const p = s.address().port;\n    s.close(() => cb(p));\n  });\n}\n\nfunction start() {\n  findPort((p) => {\n    if (!p) {\n      emit({ type: 'err', id: 0, error: { code: 'NO_PORT' } });\n      process.exit(2);\n    }\n    port = p;\n    server = http.createServer(route);\n    server.on('error', (e) => {\n      emit({ type: 'err', id: 0, error: { code: 'LISTEN_FAILED', message: String(e && e.message) } });\n      process.exit(2);\n    });\n    server.listen(port, '127.0.0.1', () => {\n      emit({ type: 'ready', port });\n    });\n  });\n}\n\nfunction shutdown(code) {\n  if (shuttingDown) return;\n  shuttingDown = true;\n  if (server) {\n    try { server.close(); } catch { /* ignore */ }\n  }\n  try {\n    emit({ type: 'exit', code: code || 0 });\n  } catch { /* ignore */ }\n  process.exit(code || 0);\n}\n\n// ---------------- stdin（Host 侧命令） ----------------\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => {\n  stdinBuf += chunk;\n  let idx;\n  while ((idx = stdinBuf.indexOf('\\n')) >= 0) {\n    const line = stdinBuf.slice(0, idx).trim();\n    stdinBuf = stdinBuf.slice(idx + 1);\n    if (!line) continue;\n    let msg;\n    try { msg = JSON.parse(line); } catch { continue; }\n    handleHostMessage(msg);\n  }\n});\nprocess.stdin.on('end', () => shutdown(0));\nprocess.stdin.on('error', () => shutdown(0));\n\nfunction handleHostMessage(msg) {\n  if (!configured) {\n    if (msg && msg.cmd === 'config' && typeof msg.token === 'string' &&\n        msg.token.length >= 8) {\n      token = msg.token;\n      configured = true;\n      start();\n    } else {\n      emit({ type: 'err', id: 0, error: { code: 'BAD_CONFIG' } });\n      process.exit(2);\n    }\n    return;\n  }\n\n  if (msg && msg.cmd === 'shutdown') { shutdown(0); return; }\n  if (msg && typeof msg.id === 'number' && typeof msg.cmd === 'string') {\n    if (cmdQueue.length >= QUEUE_LIMIT) {\n      emit({ type: 'err', id: msg.id, error: { code: 'QUEUE_FULL' } });\n      return;\n    }\n    const cmd = { id: msg.id, cmd: msg.cmd };\n    const keys = ['url', 'tabId', 'x', 'y', 'dx', 'dy', 'text', 'expression',\n      'direction', 'method', 'params', 'refresh_tree', 'title', 'ref'];\n    for (const k of keys) {\n      if (msg[k] !== undefined) cmd[k] = msg[k];\n    }\n    cmdQueue.push(cmd);\n    if (waiters.length > 0) {\n      const w = waiters.shift();\n      takeCommand(w.res);\n    }\n  }\n}\n";

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
      lastTreeSpan: null,     // 上一份树所在 surface 区间 {start, end}（尽力而为压缩用）
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
    function hashTree(nodes) {
      let s = '';
      for (const n of nodes.slice(0, 300)) {
        s += n.role + '|' + (n.name || '') + '|' + n.x + ',' + n.y + ',' + n.w + ',' + n.h + ';';
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
        if (changed) {
          state.rev++;
          out.tree = {
            rev: state.rev,
            changed: true,
            nodes: nodes.slice(0, 300),
            ...(near ? { near } : {}),
          };
          tryCompactOldTree(exec);
        } else {
          out.tree = {
            rev: state.rev,
            changed: false,
            url: state.url,
            summary: { title: state.title, nodeCount: nodes.length },
            ...(near ? { near } : {}),
          };
        }
      } catch { /* ignore */ }
      return out;
    }

    async function tryCompactOldTree(exec) {
      try {
        const compaction = ctx.get('compaction');
        const agent = exec && exec.agent;
        const span = state.lastTreeSpan;
        if (!compaction || !agent || !span || typeof span.end !== 'number') return;
        await compaction.compactRegion(span.start, span.end, agent);
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

    // ---------------- 工具注册（静态插件：defineTool + ctx.tools.register） ----------------
    function registerTool(name, description, params, handler) {
      const tool = defineTool({
        name,
        description,
        parameters: params,
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
      const disposer = ctx.tools.register(tool);
      ctx.effect(() => disposer, 'dsh-bib: ' + name);
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
    // 静态客户端（dock 窗口）经 webServer 的 /dsh-bib/* HTTP 路由调用 Host；
    // 同源（页面自身 fetch）放行，跨源拒绝；bridge-info 仍走下方 exact 路由。
    const bibOriginOk = (origin) => {
      if (!origin) return true; // 同源 GET 常不带 Origin
      return origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost');
    };

    const bibJson = (res, status, body, origin) => {
      const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (origin && bibOriginOk(origin)) h['Access-Control-Allow-Origin'] = origin;
      res.writeHead(status, h);
      res.end(JSON.stringify(body));
    };

    const bibSafe = async (fn) => {
      try { return await fn(); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    };

    const bibWebServer = ctx.get('webServer');
    if (bibWebServer) {
      const rpcDisposer = bibWebServer.register({
        kind: 'prefix',
        path: '/dsh-bib',
        handler: async (req, res) => {
          let u;
          try { u = new URL(req.url || '/', 'http://x'); } catch { return bibJson(res, 400, { error: { code: 'BAD_URL' } }, req.headers.origin || ''); }
          const origin = req.headers.origin || '';
          if (!bibOriginOk(origin)) return bibJson(res, 403, { error: { code: 'BAD_ORIGIN' } }, origin);
          const name = u.pathname.slice('/dsh-bib/'.length);
          const q = u.searchParams;
          const num = (k, d) => { const v = q.get(k); return v === null ? d : Number(v); };
          let out;
          switch (name) {
            case 'status':
              out = await bibSafe(async () => ({
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
              break;
            case 'start':
              out = await bibSafe(async () => {
                await ensureRunning();
                return { ok: true, code: state.code, state: state.status };
              });
              break;
            case 'stop':
              out = await bibSafe(async () => {
                try { await sendCommand('stop', {}); } catch { /* ignore */ }
                stopBridge();
                return { ok: true };
              });
              break;
            case 'poll':
              out = {
                state: state.status,
                seq: state.lastSeq,
                data: state.frame ? state.frame.data : '',
                width: state.frame ? state.frame.width : 0,
                height: state.frame ? state.frame.height : 0,
                url: state.url,
                title: state.title,
              };
              break;
            case 'input':
              out = await bibSafe(async () => {
                const type = q.get('type');
                if (type === 'click') {
                  state.lastClick = { x: num('x', 0), y: num('y', 0) };
                  await sendCommand('click', { x: state.lastClick.x, y: state.lastClick.y });
                } else if (type === 'scroll') {
                  await sendCommand('scroll', { x: num('x', 0), y: num('y', 0), dx: num('dx', 0), dy: num('dy', 0) });
                } else {
                  return { ok: false, error: '未知输入类型' };
                }
                return { ok: true };
              });
              break;
            case 'navigate':
              out = await bibSafe(async () => {
                const action = q.get('action');
                if (action === 'go') {
                  await sendCommand('go', { direction: q.get('direction') });
                } else if (action === 'reload') {
                  await sendCommand('reload', {});
                } else {
                  await sendCommand('navigate', { url: q.get('url') }, 20000);
                }
                return { ok: true };
              });
              break;
            case 'switch':
              out = await bibSafe(async () => {
                await sendCommand('switch', { tabId: num('tabId', 0) });
                await syncTabs();
                return { ok: true };
              });
              break;
            case 'newTab':
              out = await bibSafe(async () => {
                await sendCommand('newTab', { url: q.get('url') || 'about:blank' });
                await syncTabs();
                return { ok: true };
              });
              break;
            case 'closeTab':
              out = await bibSafe(async () => {
                await sendCommand('close', { tabId: num('tabId', 0) });
                await syncTabs();
                return { ok: true };
              });
              break;
            case 'activate':
              out = await bibSafe(async () => {
                await sendCommand('activate', {});
                return { ok: true };
              });
              break;
            case 'resetCode':
              out = await bibSafe(async () => {
                await ensureRunning();
                return { ok: true, code: state.code };
              });
              break;
            default:
              return bibJson(res, 404, { error: { code: 'NOT_FOUND' } }, origin);
          }
          bibJson(res, 200, out, origin);
        },
      });
      ctx.effect(() => rpcDisposer, 'dsh-bib: bib/* RPC routes');
    }

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
