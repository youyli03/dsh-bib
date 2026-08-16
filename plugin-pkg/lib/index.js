import { defineTool } from '@deepseek-ai/dsh-tools';

export default {
  inject: ['subprocess', 'fs', 'timer', 'tools', 'webServer'],
  apply(ctx) {
    const { subprocess, fs, timer } = ctx;

    // 桥源码（构建时由 scripts/build-host.mjs 从 bridge/bridge.js 内联生成）
    const BRIDGE_CODE = "'use strict';\n// dsh-bib 中继桥 —— 扩展(HTTP) ↔ Host(JSONL stdio) 纯转发\n// 协议契约见 docs/bridge-api.md；本文件零第三方依赖。\n\nconst http = require('http');\nconst net = require('net');\n\nlet token = null;\nlet server = null;\nlet port = 0;\nlet shuttingDown = false;\nlet configured = false;\n\nconst cmdQueue = [];       // FIFO: 待扩展执行的命令\nconst waiters = [];        // GET /command 长轮询挂起的 {res, finish}\nlet pendingCmd = null;     // 最近下发命令 {id, at}，用于 stale 检查\nlet stdinBuf = '';\n\nconst QUEUE_LIMIT = 64;\nconst STALE_MS = 15000;\nconst POLL_HOLD_MS = 10000;\n\n// ---------------- stdout JSONL ----------------\nfunction emit(obj) {\n  try {\n    process.stdout.write(JSON.stringify(obj) + '\\n');\n  } catch {\n    shutdown(1);\n  }\n}\n\nfunction respond(res, status, body, extraHeaders) {\n  if (res.writableEnded) return;\n  const origin = res.req ? res.req.headers.origin : '';\n  const h = {\n    'Content-Type': 'application/json',\n    'Cache-Control': 'no-store',\n  };\n  // CORS：扩展跨源读取响应必须（仅对扩展 Origin 回声，且只在实际响应上）\n  if (origin && origin.startsWith('chrome-extension://')) {\n    h['Access-Control-Allow-Origin'] = origin;\n  }\n  if (extraHeaders) Object.assign(h, extraHeaders);\n  res.writeHead(status, h);\n  res.end(JSON.stringify(body));\n}\n\nfunction corsPreflight(res) {\n  const origin = res.req ? res.req.headers.origin : '';\n  const h = {\n    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',\n    'Access-Control-Allow-Headers': 'X-Bib-Token, Content-Type',\n    'Access-Control-Max-Age': '600',\n  };\n  if (origin && origin.startsWith('chrome-extension://')) {\n    h['Access-Control-Allow-Origin'] = origin;\n  }\n  res.writeHead(204, h);\n  res.end();\n}\n\nfunction readJson(req, cb) {\n  let raw = '';\n  req.on('data', (c) => {\n    raw += c;\n    if (raw.length > 2e6) req.destroy(new Error('body too large'));\n  });\n  req.on('end', () => {\n    if (req.destroyed) return;\n    try { cb(null, JSON.parse(raw || '{}')); }\n    catch (e) { cb(e); }\n  });\n  req.on('error', cb);\n}\n\n// ---------------- 鉴权（唯一校验点） ----------------\nfunction authorized(req) {\n  if (shuttingDown) return { ok: false, status: 503, code: 'SHUTTING_DOWN' };\n  const t = req.headers['x-bib-token'];\n  if (!token || typeof t !== 'string' || t !== token) {\n    return { ok: false, status: 401, code: 'UNAUTHORIZED' };\n  }\n  const origin = req.headers['origin'] || '';\n  if (!origin.startsWith('chrome-extension://')) {\n    return { ok: false, status: 403, code: 'BAD_ORIGIN' };\n  }\n  const host = req.headers['host'] || '';\n  if (host !== '127.0.0.1:' + port) {\n    return { ok: false, status: 403, code: 'BAD_HOST' };\n  }\n  return { ok: true };\n}\n\n// ---------------- HTTP 路由 ----------------\nfunction route(req, res) {\n  const url = req.url || '/';\n\n  // CORS 预检必须最先处理：浏览器 preflight 不带业务头（X-Bib-Token），\n  // 若先走鉴权会被 401 拦截，扩展的所有跨源请求都会失败。\n  if (req.method === 'OPTIONS') return corsPreflight(res);\n\n  const auth = authorized(req);\n  if (!auth.ok) return respond(res, auth.status, { error: { code: auth.code } });\n\n  if (req.method === 'GET' && url === '/ping') {\n    return respond(res, 200, { pong: true });\n  }\n\n  if (req.method === 'GET' && url === '/command') {\n    if (cmdQueue.length > 0) return takeCommand(res);\n    let finished = false;\n    const finish = (body) => {\n      if (finished) return;\n      finished = true;\n      const i = waiters.findIndex((w) => w.res === res);\n      if (i >= 0) waiters.splice(i, 1);\n      respond(res, 200, body);\n    };\n    waiters.push({ res, finish });\n    res.setTimeout(POLL_HOLD_MS, () => finish({}));\n    return;\n  }\n\n  if (req.method === 'POST' && url === '/frame') {\n    return readJson(req, (err, body) => {\n      if (err || !body || typeof body.seq !== 'number' ||\n          typeof body.data !== 'string' || body.data.length === 0 ||\n          !Number.isInteger(body.width) || !Number.isInteger(body.height) ||\n          body.width <= 0 || body.height <= 0) {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      emit({ type: 'frame', seq: body.seq, data: body.data, width: body.width, height: body.height });\n      respond(res, 200, {});\n    });\n  }\n\n  if (req.method === 'POST' && url === '/event') {\n    return readJson(req, (err, body) => {\n      if (err || !body || typeof body.type !== 'string') {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      if (body.type === 'state') {\n        if (typeof body.url !== 'string' || typeof body.title !== 'string') {\n          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n        }\n        emit({ type: 'state', url: body.url, title: body.title });\n      } else if (body.type === 'cmdResult') {\n        if (typeof body.id !== 'number') {\n          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n        }\n        if (pendingCmd && pendingCmd.id === body.id &&\n            Date.now() - pendingCmd.at > STALE_MS) {\n          emit({ type: 'log', level: 'warn', message: 'stale cmdResult dropped: ' + body.id });\n          return respond(res, 200, {});\n        }\n        pendingCmd = null;\n        if (body.ok === true) {\n          emit({ type: 'ok', id: body.id, result: body.result || {} });\n        } else {\n          emit({ type: 'err', id: body.id, error: body.error || { code: 'ERROR' } });\n        }\n      } else if (body.type === 'detached') {\n        emit({ type: 'evt', type: 'detached' });\n      } else if (body.type === 'log') {\n        emit({ type: 'log', level: body.level || 'info', message: String(body.message || '') });\n      } else {\n        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });\n      }\n      respond(res, 200, {});\n    });\n  }\n\n  respond(res, 404, { error: { code: 'NOT_FOUND' } });\n}\n\nfunction takeCommand(res) {\n  const cmd = cmdQueue.shift();\n  pendingCmd = { id: cmd.id, at: Date.now() };\n  respond(res, 200, cmd);\n}\n\n// ---------------- 启动 ----------------\nfunction findPort(cb) {\n  const s = net.createServer();\n  s.on('error', () => cb(0));\n  s.listen(0, '127.0.0.1', () => {\n    const p = s.address().port;\n    s.close(() => cb(p));\n  });\n}\n\nfunction start() {\n  findPort((p) => {\n    if (!p) {\n      emit({ type: 'err', id: 0, error: { code: 'NO_PORT' } });\n      process.exit(2);\n    }\n    port = p;\n    server = http.createServer(route);\n    server.on('error', (e) => {\n      emit({ type: 'err', id: 0, error: { code: 'LISTEN_FAILED', message: String(e && e.message) } });\n      process.exit(2);\n    });\n    server.listen(port, '127.0.0.1', () => {\n      emit({ type: 'ready', port });\n    });\n  });\n}\n\nfunction shutdown(code) {\n  if (shuttingDown) return;\n  shuttingDown = true;\n  if (server) {\n    try { server.close(); } catch { /* ignore */ }\n  }\n  try {\n    emit({ type: 'exit', code: code || 0 });\n  } catch { /* ignore */ }\n  process.exit(code || 0);\n}\n\n// ---------------- stdin（Host 侧命令） ----------------\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => {\n  stdinBuf += chunk;\n  let idx;\n  while ((idx = stdinBuf.indexOf('\\n')) >= 0) {\n    const line = stdinBuf.slice(0, idx).trim();\n    stdinBuf = stdinBuf.slice(idx + 1);\n    if (!line) continue;\n    let msg;\n    try { msg = JSON.parse(line); } catch { continue; }\n    handleHostMessage(msg);\n  }\n});\nprocess.stdin.on('end', () => shutdown(0));\nprocess.stdin.on('error', () => shutdown(0));\n\nfunction handleHostMessage(msg) {\n  if (!configured) {\n    if (msg && msg.cmd === 'config' && typeof msg.token === 'string' &&\n        msg.token.length >= 8) {\n      token = msg.token;\n      configured = true;\n      start();\n    } else {\n      emit({ type: 'err', id: 0, error: { code: 'BAD_CONFIG' } });\n      process.exit(2);\n    }\n    return;\n  }\n\n  if (msg && msg.cmd === 'shutdown') { shutdown(0); return; }\n  if (msg && typeof msg.id === 'number' && typeof msg.cmd === 'string') {\n    if (cmdQueue.length >= QUEUE_LIMIT) {\n      emit({ type: 'err', id: msg.id, error: { code: 'QUEUE_FULL' } });\n      return;\n    }\n    const cmd = { id: msg.id, cmd: msg.cmd };\n    const keys = ['url', 'tabId', 'x', 'y', 'dx', 'dy', 'text', 'expression',\n      'direction', 'method', 'params', 'refresh_tree', 'title', 'ref'];\n    for (const k of keys) {\n      if (msg[k] !== undefined) cmd[k] = msg[k];\n    }\n    cmdQueue.push(cmd);\n    if (waiters.length > 0) {\n      const w = waiters.shift();\n      takeCommand(w.res);\n    }\n  }\n}\n";

    // 桥生命周期全局共享：一个 node 桥 + 一个扩展连接，天然支持多标签。
    // 会话状态按 sessionId 隔离（Map<sessionId, SessionState>）：每个会话持有
    // 自己的激活标签、帧缓存、树 rev、点击点 —— 多会话并发互不覆盖。
    let bridge = null;        // SubprocessHandle
    let outBuf = '';
    let cmdSeq = 1;
    const pending = new Map(); // id -> {resolve, reject, disposer}
    let statusWaiters = [];
    let bridgeStatus = 'stopped'; // stopped|starting|running|degraded|error
    let bridgePort = null;
    let bridgeToken = null;
    let bridgeCode = null;       // 连接码
    let bridgeLastError = '';

    const sessions = new Map(); // sessionId -> SessionState

    function sessionState(sessionId) {
      let s = sessions.get(sessionId);
      if (!s) {
        s = {
          activeTabId: null,
          frame: null,            // {seq, data, width, height}
          lastSeq: -1,
          lastFrameAt: 0,
          rev: 0,
          lastTreeHash: null,
          lastClick: null,        // {x, y}
          tabs: [],
          url: '', title: '',
          lastError: '',
        };
        sessions.set(sessionId, s);
      }
      return s;
    }

    function sessionIdOf(exec) {
      try {
        const agent = exec && exec.agent;
        const id = agent && agent.session && (agent.session.id || agent.session.sessionId);
        return id ? String(id) : null;
      } catch {
        return null;
      }
    }

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
        if (bridgeStatus === status) return resolve(true);
        const t = timer.timeout(() => resolve(false), ms);
        statusWaiters.push(() => { t(); resolve(true); });
      });
    }

    // ---------------- 桥生命周期 ----------------
    async function startBridge() {
      bridgeToken = genToken();
      bridgeStatus = 'starting';
      bridgeLastError = '';
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
        if (bridgeStatus !== 'stopped') {
          bridgeStatus = 'error';
          bridgeLastError = '桥退出 code=' + outcome.exitCode;
        }
        rejectAll('BRIDGE_DIED', '桥已退出');
        emitStatus();
      }).catch((e) => {
        bridgeStatus = 'error';
        bridgeLastError = '桥 spawn 失败: ' + String((e && e.message) || e);
        rejectAll('BRIDGE_SPAWN_FAILED', bridgeLastError);
        emitStatus();
      });
      try {
        bridge.stdin.write(JSON.stringify({ id: 0, cmd: 'config', token: bridgeToken }) + '\n');
      } catch (e) {
        bridgeLastError = '写桥配置失败: ' + String(e);
      }
      timer.timeout(() => {
        if (bridgeStatus === 'starting') {
          bridgeStatus = 'error';
          bridgeLastError = '桥启动超时（未收到 ready）';
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
      bridgeStatus = 'stopped';
      bridgePort = null;
      bridgeCode = null;
      bridgeLastError = '';
      // 停止清空全部会话状态
      for (const s of sessions.values()) {
        s.activeTabId = null;
        s.frame = null;
        s.lastSeq = -1;
        s.url = '';
        s.title = '';
        s.tabs = [];
        s.lastTreeHash = null;
        s.lastClick = null;
        s.lastError = '';
      }
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
          bridgePort = msg.port;
          bridgeStatus = 'running';
          bridgeCode = '127.0.0.1:' + msg.port + '#' + bridgeToken;
          emitStatus();
          break;
        case 'frame':
          // 帧按 tabId 归属会话：命令带 tabId，帧事件本身无会话上下文，
          // Host 侧由下次命令/轮询按各会话 activeTabId 主动截帧校正。
          break;
        case 'state':
          // 全局 url/title 事件不再直接写入；各会话状态由命令返回同步。
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
          if (msg.type === 'detached') bridgeStatus = 'degraded';
          break;
        case 'log':
          console.log('[dsh-bib]', msg.level, msg.message);
          break;
        case 'exit':
          break;
      }
    }

    // ---------------- 命令通道 ----------------
    // cmdTabId：命令目标标签（会话 activeTabId）；省略时走扩展全局激活标签。
    function sendCommand(cmd, params, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (bridgeStatus !== 'running' || !bridge) {
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

    // 按会话执行命令：自动带上该会话的 activeTabId（会话专属标签路由）
    async function sessionCommand(sessionId, cmd, params, timeoutMs) {
      const s = sessionState(sessionId);
      const p = params || {};
      // navigate/go/reload/click/scroll/type/eval/tree/screenshot 都作用于激活标签；
      // switch/newTab 由扩展端管理，这里显式路由。
      if (s.activeTabId != null && ['navigate','go','reload','click','scroll','type','eval','tree','screenshot','activate'].includes(cmd)) {
        p.tabId = s.activeTabId;
      }
      return sendCommand(cmd, p, timeoutMs);
    }

    // ---------------- 树契约 ----------------
    // 每次 browser_* 工具调用结束都返回**最新完整树节点**（可被下一次调用覆盖）：
    // - changed:true  → rev 递增 + 完整 nodes（模型拿新树操作）
    // - changed:false → rev 不变，但仍附最新 nodes 快照（模型始终有可点击的当前树，
    //   而不是只有 summary —— 旧实现只回摘要导致模型在页面静止时失去树锚点）
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

    // 树契约：会话隔离。st 为该会话的 SessionState。
    async function buildTreeFor(exec, sessionId, afterClick) {
      const out = { tree: null };
      try {
        const st = sessionState(sessionId);
        let nodes = [];
        try {
          const r = await sessionCommand(sessionId, 'tree', {}, 10000);
          nodes = (r && r.nodes) || [];
        } catch { /* tree 失败不阻塞操作 */ }
        const hash = hashTree(nodes);
        const changed = hash !== st.lastTreeHash;
        st.lastTreeHash = hash;
        const near = afterClick ? nearest(nodes, st.lastClick, 5) : undefined;
        // 每次工具调用都把对话里更早的树整体压缩掉，只留本次最新树：
        // 压缩在返回新树前执行，本次 tool/result 尚未写入 surface，因此扫描到的
        // browser_* 结果全部是历史树；压缩后本次结果成为唯一完整树。
        await compactOldTrees(exec);
        if (changed) {
          st.rev++;
          out.tree = {
            rev: st.rev,
            changed: true,
            nodes: nodes.slice(0, 300),
            ...(near ? { near } : {}),
          };
        } else {
          // 页面未变化时也回传最新 nodes 快照（可被下一次调用覆盖）：
          // 保证模型在连续操作/静态页面下始终持有可点击的树，而非空摘要。
          out.tree = {
            rev: st.rev,
            changed: false,
            nodes: nodes.slice(0, 300),
            url: st.url,
            summary: { title: st.title, nodeCount: nodes.length },
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
      if (bridgeStatus === 'running') return;
      if (bridgeStatus === 'starting' || bridgeStatus === 'degraded') {
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

    // 操作后主动截帧更新该会话的帧缓存（后台标签 screencast 节流，靠按需截帧保证画面）
    async function applyShotFor(sessionId) {
      try {
        const st = sessionState(sessionId);
        const shot = await sessionCommand(sessionId, 'screenshot', {}, 8000);
        if (shot && shot.data) {
          const seq = (typeof shot.seq === 'number' && shot.seq > st.lastSeq) ? shot.seq : Date.now();
          st.frame = { seq, data: shot.data, width: shot.width || 0, height: shot.height || 0 };
          st.lastSeq = seq;
          st.lastFrameAt = Date.now();
        }
      } catch { /* 截帧失败不阻塞操作 */ }
    }

    // 周期主动截帧：仅为有激活标签的会话截帧（无会话上下文时跳过 —— 帧由
    // 各会话自己的命令/轮询驱动，避免多会话互相覆盖帧缓存）。
    let refreshing = false;
    const refreshTick = timer.interval(async () => {
      if (bridgeStatus !== 'running' || refreshing) return;
      refreshing = true;
      try {
        for (const [sid, st] of sessions) {
          if (st.activeTabId != null && Date.now() - st.lastFrameAt > 1500) {
            try { await applyShotFor(sid); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ } finally {
        refreshing = false;
      }
    }, 2000);
    ctx.effect(() => refreshTick);

    async function runAction(exec, cmdName, cmdArgs, opts) {
      opts = opts || {};
      const sessionId = sessionIdOf(exec);
      if (!sessionId) return errResult('NO_SESSION', '无法确定当前会话');
      try {
        await ensureRunning();
      } catch (e) {
        return errResult(e.code || 'NOT_RUNNING', (e && e.message) || String(e));
      }
      const st = sessionState(sessionId);
      let res;
      try {
        res = await sessionCommand(sessionId, cmdName, cmdArgs, opts.timeout || 10000);
      } catch (e) {
        return errResult(e.code || 'BRIDGE_ERROR', (e && e.message) || String(e));
      }
      const treeWrap = await (async () => {
        await sleep(400);
        return buildTreeFor(exec, sessionId, opts.afterClick);
      })();
      await applyShotFor(sessionId);
      if (res && res.url) st.url = res.url;
      if (res && res.title) st.title = res.title;
      return { ok: true, result: res, tree: treeWrap.tree };
    }

    // ---------------- 工具注册（静态插件：defineTool + ctx.tools.register） ----------------
    // render：GUI 工具卡片的人类可读摘要；同一文本也是模型可见的工具结果，
    // 因此必须同时携带模型需要的结构化数据（AX 树 ref、tabId、eval 值）。
    function shortText(s, n) {
      s = String(s == null ? '' : s);
      const m = n || 400;
      return s.length > m ? s.slice(0, m) + '…' : s;
    }
    function errText(value) {
      if (value && value.ok === false && value.error) {
        return '✗ ' + (value.error.code ? value.error.code + ': ' : '') + (value.error.message || '');
      }
      return '✗ 操作失败';
    }
    function treeSection(value, maxNodes) {
      const tree = value && value.tree;
      if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) return '';
      const cap = maxNodes || 40;
      const lines = tree.nodes.slice(0, cap).map((n) => {
        let extra = '';
        if (n.data && typeof n.data === 'object') {
          const parts = [];
          if (n.data.economy && n.data.economy.type) parts.push(n.data.economy.type);
          if (n.data.economy && n.data.economy.rarity) parts.push(n.data.economy.rarity);
          if (parts.length === 0 && n.data.name) parts.push(n.data.name);
          if (parts.length) extra = ' [' + parts.join(' · ') + ']';
        }
        return '[' + (n.ref || '?') + '] ' + (n.role || '') + (n.name ? ' "' + n.name + '"' : '') +
          extra + ' @(' + n.x + ',' + n.y + ') ' + n.w + 'x' + n.h;
      });
      const more = tree.nodes.length > cap ? '\n… 共 ' + tree.nodes.length + ' 个节点' : '';
      // 树块带边界标记：历史树压缩（compactOldTrees）用正则按标记整体替换，
      // 只压缩旧树、保留工具结果的其他内容（如点击坐标/附近节点）。
      return '\n⟦BIBTREE rev=' + (tree.rev || '?') + '⟧\n' + lines.join('\n') + more + '\n⟦/BIBTREE⟧';
    }
    function registerTool(name, description, params, handler, render) {
      const tool = defineTool({
        name,
        description,
        parameters: params,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) {
            let text;
            if (!value || value.ok === false) {
              text = errText(value);
            } else if (render) {
              try {
                text = render(args, value);
              } catch (e) {
                text = '渲染摘要失败: ' + ((e && e.message) || e);
              }
            } else {
              text = JSON.stringify(value && value.result !== undefined ? value.result : value);
            }
            return [{ type: 'text', text: shortText(text, 3000) }];
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

    registerTool('browser_status', '查询 dsh-bib 浏览器运行状态与当前激活标签的 url/title（按当前会话）。', {
      status: { type: 'string', description: 'stopped|starting|running|degraded|error' },
    }, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      const st = sessionId ? sessionState(sessionId) : null;
      return {
        ok: true,
        result: {
          state: bridgeStatus,
          url: st ? st.url : '',
          title: st ? st.title : '',
          hasFrame: st ? !!st.frame : false,
          seq: st ? st.lastSeq : -1,
          tabs: st ? st.tabs.length : 0,
          activeTab: st ? st.activeTabId : null,
          lastError: st ? st.lastError : bridgeLastError,
        },
      };
    }, (args, value) => {
      const r = value.result || {};
      return ['状态: ' + r.state,
        r.url ? '页面: ' + r.url : '',
        r.title ? '标题: ' + r.title : '',
        typeof r.tabs === 'number' ? '标签: ' + r.tabs : '',
        r.activeTab ? '激活tab: ' + r.activeTab : '',
        r.lastError ? '错误: ' + r.lastError : '',
      ].filter(Boolean).join(' · ');
    });

    registerTool('browser_open', '启动浏览器（若未运行）并在当前会话的专属标签页中打开 url（该会话无标签时新建专属标签，之后复用）。', {
      url: { type: 'string', description: '目标 URL' },
    }, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) return errResult('NO_SESSION', '无法确定当前会话');
      try {
        await ensureRunning();
      } catch (e) {
        return errResult(e.code || 'NOT_RUNNING', (e && e.message) || String(e));
      }
      const st = sessionState(sessionId);
      let res;
      try {
        const tabs = await sendCommand('tabs', {}, 5000);
        const list = (tabs && tabs.tabs) || [];
        // 本会话已有专属标签：复用并导航
        if (st.activeTabId != null && list.some((t) => t.tabId === st.activeTabId)) {
          res = await sessionCommand(sessionId, 'navigate', { url: args.url }, 20000);
          await syncTabs(sessionId);
          await sleep(400);
          const treeWrap = await buildTreeFor(exec, sessionId);
          await applyShotFor(sessionId);
          return { ok: true, result: res, tree: treeWrap.tree };
        }
        // 无专属标签：新建专属标签（newTab 返回 tabId 并激活）
        res = await sendCommand('newTab', { url: args.url }, 15000);
        if (res && res.tabId != null) {
          st.activeTabId = res.tabId;
          await syncTabs(sessionId);
          await sleep(400);
          const treeWrap = await buildTreeFor(exec, sessionId);
          await applyShotFor(sessionId);
          return { ok: true, result: Object.assign({}, res, { url: args.url }), tree: treeWrap.tree };
        }
      } catch { /* tabs/newTab 失败 → 兜底 */ }
      res = await runAction(exec, 'newTab', { url: args.url }, { timeout: 15000 });
      await syncTabs(sessionId);
      return res;
    }, (args, value) => {
      const r = value.result || {};
      const n = value.tree && value.tree.nodes ? value.tree.nodes.length : null;
      return '✓ 已打开 ' + (r.url || args.url) + (r.tabId ? ' (tab ' + r.tabId + ')' : '') + (n != null ? ' · 感知 ' + n + ' 个节点' : '') + treeSection(value);
    });

    registerTool('browser_navigate', '在激活标签页导航到 url 并等待加载完成。', {
      url: { type: 'string', description: '目标 URL' },
    }, (args, exec) => runAction(exec, 'navigate', { url: args.url }, { timeout: 20000 }),
      (args, value) => '✓ 已导航到 ' + args.url + treeSection(value));

    registerTool('browser_go', '激活标签页历史前进或后退。', {
      direction: { type: 'string', enum: ['back', 'forward'], description: '方向' },
    }, (args, exec) => runAction(exec, 'go', { direction: args.direction }),
      (args, value) => '✓ 已' + (args.direction === 'back' ? '返回上一页' : '前进到下一页') + treeSection(value));

    registerTool('browser_reload', '刷新激活标签页。', {}, (args, exec) => runAction(exec, 'reload', {}),
      (args, value) => '✓ 已刷新当前页面' + treeSection(value));

    registerTool('browser_click', '在激活标签页点击。优先用 ref（来自 browser_* 返回的树节点 ref 字段，自动滚动到元素并点中心）；无 ref 时按视口 CSS 坐标点击。', {
      ref: { type: 'string', description: '树节点 ref（可选，优先）' },
      x: { type: 'number', description: 'X 坐标（无 ref 时用）' },
      y: { type: 'number', description: 'Y 坐标（无 ref 时用）' },
    }, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (sessionId && !args.ref) {
        sessionState(sessionId).lastClick = { x: args.x, y: args.y };
      }
      return runAction(exec, 'click', { x: args.x, y: args.y, ref: args.ref }, { afterClick: true });
    }, (args, value) => {
      const near = value.tree && value.tree.near ? value.tree.near.length : null;
      const at = args.ref ? 'ref=' + args.ref : '(' + args.x + ', ' + args.y + ')';
      return '✓ 已点击 ' + at + (near != null ? ' · 附近节点 ' + near + ' 个' : '') + treeSection(value);
    });

    registerTool('browser_type', '在激活标签页输入文本（绕过 IME，中文可用；末尾换行触发回车）。', {
      text: { type: 'string', description: '要输入的文本' },
    }, (args, exec) => runAction(exec, 'type', { text: args.text }),
      (args, value) => '✓ 已输入: ' + shortText(String(args.text || '').replace(/\n/g, '⏎'), 60) + treeSection(value));

    registerTool('browser_scroll', '在激活标签页滚动（先移动到 x,y 再滚 dx,dy）。', {
      x: { type: 'number' }, y: { type: 'number' },
      dx: { type: 'number', description: '水平滚动量' }, dy: { type: 'number', description: '垂直滚动量' },
    }, (args, exec) => runAction(exec, 'scroll', { x: args.x, y: args.y, dx: args.dx, dy: args.dy }),
      (args, value) => '✓ 已滚动 dx=' + (args.dx || 0) + ' dy=' + (args.dy || 0) + treeSection(value));

    registerTool('browser_screenshot', '返回激活标签页当前帧 dataURL（base64 JPEG）与内在尺寸（按当前会话）。', {}, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) return errResult('NO_SESSION', '无法确定当前会话');
      try {
        await ensureRunning();
      } catch (e) {
        return errResult('NOT_RUNNING', '浏览器未启动');
      }
      const st = sessionState(sessionId);
      if (st.frame) {
        return {
          ok: true,
          result: {
            data: 'data:image/jpeg;base64,' + st.frame.data,
            width: st.frame.width,
            height: st.frame.height,
            seq: st.frame.seq,
          },
        };
      }
      try {
        const r = await sessionCommand(sessionId, 'screenshot', {}, 10000);
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
    }, (args, value) => {
      const r = value.result || {};
      return '📷 截图 ' + (r.width || 0) + '×' + (r.height || 0) + (r.seq ? ' (seq ' + r.seq + ')' : '') + '（画面数据已返回给模型）';
    });

    registerTool('browser_eval', '在激活标签页执行 JS 表达式并返回值（JSON 序列化）。', {
      expression: { type: 'string', description: 'JS 表达式' },
    }, (args, exec) => runAction(exec, 'eval', { expression: args.expression }, { timeout: 15000 }),
      (args, value) => {
        const r = value.result || {};
        const v = r.value;
        return '✓ ' + shortText(typeof v === 'string' ? v : JSON.stringify(v), 2000);
      });

    registerTool('browser_tabs', '列出当前会话的标签页（tabId、url、title、是否激活）。', {}, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) return errResult('NO_SESSION', '无法确定当前会话');
      try {
        await ensureRunning();
      } catch (e) {
        return errResult('NOT_RUNNING', '浏览器未启动');
      }
      await syncTabs(sessionId);
      const st = sessionState(sessionId);
      return { ok: true, result: { tabs: st.tabs }, tree: (await buildTreeFor(exec, sessionId)).tree };
    }, (args, value) => {
      const r = value.result || {};
      const tabs = (r.tabs || []).map((t) => (t.active ? '▶' : '') + 'tabId=' + t.tabId + ' ' + (t.title || t.url || '(无标题)'));
      return '标签 ' + (r.tabs || []).length + ' 个:\n' + tabs.join('\n') + treeSection(value);
    });

    registerTool('browser_switch', '切换当前会话的激活标签页（单激活模型：帧流/树/操作只针对该标签）。', {
      tabId: { type: 'number', description: '目标标签 tabId（来自 browser_tabs）' },
    }, async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) return errResult('NO_SESSION', '无法确定当前会话');
      const st = sessionState(sessionId);
      st.activeTabId = args.tabId;
      const res = await runAction(exec, 'switch', { tabId: args.tabId });
      await syncTabs(sessionId);
      return res;
    }, (args, value) => '✓ 已切换到 tab ' + args.tabId + treeSection(value));

    registerTool('browser_activate', '把当前会话激活标签页带到前台并聚焦 Edge 窗口（供人直接操作真实页面）。', {}, (args, exec) => {
      const sessionId = sessionIdOf(exec);
      return runAction(exec, 'activate', {}, { timeout: 10000 });
    }, () => '✓ 已把 Edge 窗口带到前台（人可直接操作）');

    registerTool('browser_stop', '停止浏览器（停 screencast 并 detach 全部标签，保留标签页；清空全部会话状态）。', {}, async () => {
      try {
        await sendCommand('stop', {});
      } catch { /* ignore */ }
      stopBridge();
      return { ok: true, result: {} };
    }, () => '✓ 浏览器已停止（标签页保留）');

    // 同步某会话的标签列表与激活标签
    async function syncTabs(sessionId) {
      try {
        const res = await sendCommand('tabs', {});
        const all = (res && res.tabs) || [];
        const st = sessionState(sessionId);
        // 会话只认自己的专属标签（扩展返回全部标签，这里过滤出本会话的）
        if (st.activeTabId != null) {
          st.tabs = all.filter((t) => t.tabId === st.activeTabId);
          const mine = all.find((t) => t.tabId === st.activeTabId);
          if (mine) {
            st.url = mine.url || st.url;
            st.title = mine.title || st.title;
          }
        } else {
          st.tabs = [];
        }
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
          const str = (k, d) => { const v = q.get(k); return v === null ? d : v; };
          // 会话路由：RPC 必须带 sessionId（Client 从 dock standardProps 注入）
          const sessionId = str('sessionId', '');
          const st = sessionId ? sessionState(sessionId) : null;
          let out;
          switch (name) {
            case 'status':
              out = await bibSafe(async () => ({
                state: bridgeStatus,
                url: st ? st.url : '',
                title: st ? st.title : '',
                hasFrame: st ? !!st.frame : false,
                seq: st ? st.lastSeq : -1,
                code: bridgeStatus === 'running' ? bridgeCode : null,
                tabs: st ? st.tabs : [],
                activeTab: st ? st.activeTabId : null,
                lastError: st ? st.lastError : bridgeLastError,
              }));
              break;
            case 'start':
              out = await bibSafe(async () => {
                await ensureRunning();
                return { ok: true, code: bridgeCode, state: bridgeStatus };
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
                state: bridgeStatus,
                seq: st ? st.lastSeq : -1,
                data: st && st.frame ? st.frame.data : '',
                width: st && st.frame ? st.frame.width : 0,
                height: st && st.frame ? st.frame.height : 0,
                url: st ? st.url : '',
                title: st ? st.title : '',
              };
              break;
            case 'input':
              out = await bibSafe(async () => {
                if (!sessionId) return { ok: false, error: '缺少 sessionId' };
                const type = q.get('type');
                if (type === 'click') {
                  st.lastClick = { x: num('x', 0), y: num('y', 0) };
                  await sessionCommand(sessionId, 'click', { x: st.lastClick.x, y: st.lastClick.y });
                } else if (type === 'scroll') {
                  await sessionCommand(sessionId, 'scroll', { x: num('x', 0), y: num('y', 0), dx: num('dx', 0), dy: num('dy', 0) });
                } else {
                  return { ok: false, error: '未知输入类型' };
                }
                return { ok: true };
              });
              break;
            case 'navigate':
              out = await bibSafe(async () => {
                if (!sessionId) return { ok: false, error: '缺少 sessionId' };
                const action = q.get('action');
                if (action === 'go') {
                  await sessionCommand(sessionId, 'go', { direction: q.get('direction') });
                } else if (action === 'reload') {
                  await sessionCommand(sessionId, 'reload', {});
                } else {
                  await sessionCommand(sessionId, 'navigate', { url: q.get('url') }, 20000);
                }
                return { ok: true };
              });
              break;
            case 'switch':
              out = await bibSafe(async () => {
                if (!sessionId) return { ok: false, error: '缺少 sessionId' };
                st.activeTabId = num('tabId', 0);
                await sessionCommand(sessionId, 'switch', { tabId: st.activeTabId });
                await syncTabs(sessionId);
                return { ok: true };
              });
              break;
            case 'newTab':
              out = await bibSafe(async () => {
                if (!sessionId) return { ok: false, error: '缺少 sessionId' };
                const r = await sendCommand('newTab', { url: q.get('url') || 'about:blank' });
                if (r && r.tabId != null) {
                  st.activeTabId = r.tabId;
                  await syncTabs(sessionId);
                }
                return { ok: true };
              });
              break;
            case 'closeTab':
              out = await bibSafe(async () => {
                if (!sessionId) return { ok: false, error: '缺少 sessionId' };
                await sendCommand('close', { tabId: num('tabId', 0) });
                await syncTabs(sessionId);
                return { ok: true };
              });
              break;
            case 'activate':
              out = await bibSafe(async () => {
                await sessionCommand(sessionId || '', 'activate', {});
                return { ok: true };
              });
              break;
            case 'resetCode':
              out = await bibSafe(async () => {
                await ensureRunning();
                return { ok: true, code: bridgeCode };
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
          const m = bridgeCode && bridgeCode.match(/^127\.0\.0\.1:(\d+)#([0-9a-fA-F]+)$/);
          if (bridgeStatus !== 'running' || !m) {
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
