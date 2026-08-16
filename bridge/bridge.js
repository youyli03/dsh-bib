'use strict';
// dsh-bib 中继桥 —— 扩展(HTTP) ↔ Host(JSONL stdio) 纯转发
// 协议契约见 docs/bridge-api.md；本文件零第三方依赖。

const http = require('http');
const net = require('net');

let token = null;
let server = null;
let port = 0;
let shuttingDown = false;
let configured = false;

const cmdQueue = [];       // FIFO: 待扩展执行的命令
const waiters = [];        // GET /command 长轮询挂起的 {res, finish}
let pendingCmd = null;     // 最近下发命令 {id, at}，用于 stale 检查
let stdinBuf = '';

const QUEUE_LIMIT = 64;
const STALE_MS = 15000;
const POLL_HOLD_MS = 10000;

// ---------------- stdout JSONL ----------------
function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    shutdown(1);
  }
}

function respond(res, status, body, extraHeaders) {
  if (res.writableEnded) return;
  const origin = res.req ? res.req.headers.origin : '';
  const h = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  // CORS：扩展跨源读取响应必须（仅对扩展 Origin 回声，且只在实际响应上）
  if (origin && origin.startsWith('chrome-extension://')) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  if (extraHeaders) Object.assign(h, extraHeaders);
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

function corsPreflight(res) {
  const origin = res.req ? res.req.headers.origin : '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Bib-Token, Content-Type',
    'Access-Control-Max-Age': '600',
  };
  if (origin && origin.startsWith('chrome-extension://')) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  res.writeHead(204, h);
  res.end();
}

function readJson(req, cb) {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 2e6) req.destroy(new Error('body too large'));
  });
  req.on('end', () => {
    if (req.destroyed) return;
    try { cb(null, JSON.parse(raw || '{}')); }
    catch (e) { cb(e); }
  });
  req.on('error', cb);
}

// ---------------- 鉴权（唯一校验点） ----------------
function authorized(req) {
  if (shuttingDown) return { ok: false, status: 503, code: 'SHUTTING_DOWN' };
  const t = req.headers['x-bib-token'];
  if (!token || typeof t !== 'string' || t !== token) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED' };
  }
  const origin = req.headers['origin'] || '';
  if (!origin.startsWith('chrome-extension://')) {
    return { ok: false, status: 403, code: 'BAD_ORIGIN' };
  }
  const host = req.headers['host'] || '';
  if (host !== '127.0.0.1:' + port) {
    return { ok: false, status: 403, code: 'BAD_HOST' };
  }
  return { ok: true };
}

// ---------------- HTTP 路由 ----------------
function route(req, res) {
  const url = req.url || '/';

  // CORS 预检必须最先处理：浏览器 preflight 不带业务头（X-Bib-Token），
  // 若先走鉴权会被 401 拦截，扩展的所有跨源请求都会失败。
  if (req.method === 'OPTIONS') return corsPreflight(res);

  const auth = authorized(req);
  if (!auth.ok) return respond(res, auth.status, { error: { code: auth.code } });

  if (req.method === 'GET' && url === '/ping') {
    return respond(res, 200, { pong: true });
  }

  if (req.method === 'GET' && url === '/command') {
    if (cmdQueue.length > 0) return takeCommand(res);
    let finished = false;
    const finish = (body) => {
      if (finished) return;
      finished = true;
      const i = waiters.findIndex((w) => w.res === res);
      if (i >= 0) waiters.splice(i, 1);
      respond(res, 200, body);
    };
    waiters.push({ res, finish });
    res.setTimeout(POLL_HOLD_MS, () => finish({}));
    return;
  }

  if (req.method === 'POST' && url === '/frame') {
    return readJson(req, (err, body) => {
      if (err || !body || typeof body.seq !== 'number' ||
          typeof body.data !== 'string' || body.data.length === 0 ||
          !Number.isInteger(body.width) || !Number.isInteger(body.height) ||
          body.width <= 0 || body.height <= 0) {
        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });
      }
      emit({ type: 'frame', seq: body.seq, data: body.data, width: body.width, height: body.height });
      respond(res, 200, {});
    });
  }

  if (req.method === 'POST' && url === '/event') {
    return readJson(req, (err, body) => {
      if (err || !body || typeof body.type !== 'string') {
        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });
      }
      if (body.type === 'state') {
        if (typeof body.url !== 'string' || typeof body.title !== 'string') {
          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });
        }
        emit({ type: 'state', url: body.url, title: body.title });
      } else if (body.type === 'cmdResult') {
        if (typeof body.id !== 'number') {
          return respond(res, 400, { error: { code: 'BAD_REQUEST' } });
        }
        if (pendingCmd && pendingCmd.id === body.id &&
            Date.now() - pendingCmd.at > STALE_MS) {
          emit({ type: 'log', level: 'warn', message: 'stale cmdResult dropped: ' + body.id });
          return respond(res, 200, {});
        }
        pendingCmd = null;
        if (body.ok === true) {
          emit({ type: 'ok', id: body.id, result: body.result || {} });
        } else {
          emit({ type: 'err', id: body.id, error: body.error || { code: 'ERROR' } });
        }
      } else if (body.type === 'detached') {
        emit({ type: 'evt', type: 'detached' });
      } else if (body.type === 'log') {
        emit({ type: 'log', level: body.level || 'info', message: String(body.message || '') });
      } else {
        return respond(res, 400, { error: { code: 'BAD_REQUEST' } });
      }
      respond(res, 200, {});
    });
  }

  respond(res, 404, { error: { code: 'NOT_FOUND' } });
}

function takeCommand(res) {
  const cmd = cmdQueue.shift();
  pendingCmd = { id: cmd.id, at: Date.now() };
  respond(res, 200, cmd);
}

// ---------------- 启动 ----------------
function findPort(cb) {
  const s = net.createServer();
  s.on('error', () => cb(0));
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => cb(p));
  });
}

function start() {
  findPort((p) => {
    if (!p) {
      emit({ type: 'err', id: 0, error: { code: 'NO_PORT' } });
      process.exit(2);
    }
    port = p;
    server = http.createServer(route);
    server.on('error', (e) => {
      emit({ type: 'err', id: 0, error: { code: 'LISTEN_FAILED', message: String(e && e.message) } });
      process.exit(2);
    });
    server.listen(port, '127.0.0.1', () => {
      emit({ type: 'ready', port });
    });
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  try {
    emit({ type: 'exit', code: code || 0 });
  } catch { /* ignore */ }
  process.exit(code || 0);
}

// ---------------- stdin（Host 侧命令） ----------------
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleHostMessage(msg);
  }
});
process.stdin.on('end', () => shutdown(0));
process.stdin.on('error', () => shutdown(0));

function handleHostMessage(msg) {
  if (!configured) {
    if (msg && msg.cmd === 'config' && typeof msg.token === 'string' &&
        msg.token.length >= 8) {
      token = msg.token;
      configured = true;
      start();
    } else {
      emit({ type: 'err', id: 0, error: { code: 'BAD_CONFIG' } });
      process.exit(2);
    }
    return;
  }

  if (msg && msg.cmd === 'shutdown') { shutdown(0); return; }
  if (msg && typeof msg.id === 'number' && typeof msg.cmd === 'string') {
    if (cmdQueue.length >= QUEUE_LIMIT) {
      emit({ type: 'err', id: msg.id, error: { code: 'QUEUE_FULL' } });
      return;
    }
    const cmd = { id: msg.id, cmd: msg.cmd };
    const keys = ['url', 'tabId', 'x', 'y', 'dx', 'dy', 'text', 'expression',
      'direction', 'method', 'params', 'refresh_tree', 'title', 'ref'];
    for (const k of keys) {
      if (msg[k] !== undefined) cmd[k] = msg[k];
    }
    cmdQueue.push(cmd);
    if (waiters.length > 0) {
      const w = waiters.shift();
      takeCommand(w.res);
    }
  }
}
