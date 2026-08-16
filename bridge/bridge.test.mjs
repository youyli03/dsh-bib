// dsh-bib 桥冒烟测试：起桥 → 模拟 Host(stdin) + 扩展(HTTP) 两侧，验证全部契约。
// 运行：node bridge.test.mjs   （需与 bridge.js 同目录）

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'a1b2c3d4e5f6a7b8';
let bridge;
let port = 0;
let outEvents = [];   // stdout 消息队列
let waiters = [];
const results = [];

function record(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
}

function pushMsg(obj) {
  outEvents.push(obj);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.pred(obj)) {
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(obj);
    }
  }
}

function waitMsg(pred, timeoutMs = 3000) {
  const hit = outEvents.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve, reject, timer: null };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    waiters.push(w);
  });
}

function httpReq(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* ignore */ }
        resolve({
          status: res.statusCode,
          json,
          aca: res.headers['access-control-allow-origin'],
          allowHeaders: res.headers['access-control-allow-headers'] || '',
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const okHeaders = () => ({
  'X-Bib-Token': TOKEN,
  'Origin': 'chrome-extension://abc123def456ghi789',
  'Host': `127.0.0.1:${port}`,
});

// ---------------- 启动桥 ----------------
function startBridge() {
  return new Promise((resolve, reject) => {
    bridge = spawn(process.execPath, [path.join(dir, 'bridge.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    bridge.stdout.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { pushMsg(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    });
    bridge.stderr.on('data', () => { /* ignore */ });
    bridge.on('exit', (code) => pushMsg({ type: 'exit', code }));
    bridge.on('error', reject);
    // 配置（模拟 Host 首条消息）
    bridge.stdin.write(JSON.stringify({ id: 0, cmd: 'config', token: TOKEN }) + '\n');
    waitMsg((m) => m.type === 'ready', 5000).then((m) => {
      port = m.port;
      resolve();
    }).catch(reject);
  });
}

function sendHostCmd(obj) {
  bridge.stdin.write(JSON.stringify(obj) + '\n');
}

// ---------------- 测试序列 ----------------
const tests = [
  ['鉴权：无 token → 401', async () => {
    const r = await httpReq('GET', '/ping', { headers: { Origin: okHeaders().Origin, Host: okHeaders().Host } });
    return r.status === 401 && r.json.error.code === 'UNAUTHORIZED';
  }],
  ['鉴权：token 错误 → 401', async () => {
    const r = await httpReq('GET', '/ping', { headers: { ...okHeaders(), 'X-Bib-Token': 'wrong' } });
    return r.status === 401;
  }],
  ['鉴权：伪造 Origin → 403 BAD_ORIGIN', async () => {
    const r = await httpReq('GET', '/ping', { headers: { ...okHeaders(), Origin: 'http://evil.example' } });
    return r.status === 403 && r.json.error.code === 'BAD_ORIGIN';
  }],
  ['鉴权：Host 头不符 → 403 BAD_HOST', async () => {
    const r = await httpReq('GET', '/ping', { headers: { ...okHeaders(), Host: '127.0.0.1:9999' } });
    return r.status === 403 && r.json.error.code === 'BAD_HOST';
  }],
  ['GET /ping 合法 → 200 pong', async () => {
    const r = await httpReq('GET', '/ping', { headers: okHeaders() });
    return r.status === 200 && r.json.pong === true;
  }],
  ['未知端点 → 404', async () => {
    const r = await httpReq('GET', '/nope', { headers: okHeaders() });
    return r.status === 404;
  }],
  ['命令队列：stdin navigate → GET /command 取到', async () => {
    sendHostCmd({ id: 1, cmd: 'navigate', url: 'https://example.com' });
    const r = await httpReq('GET', '/command', { headers: okHeaders() });
    return r.status === 200 && r.json.id === 1 && r.json.cmd === 'navigate' && r.json.url === 'https://example.com';
  }],
  ['命令队列：FIFO 两条顺序取', async () => {
    sendHostCmd({ id: 2, cmd: 'click', x: 10, y: 20 });
    sendHostCmd({ id: 3, cmd: 'type', text: 'hi' });
    const a = await httpReq('GET', '/command', { headers: okHeaders() });
    const b = await httpReq('GET', '/command', { headers: okHeaders() });
    return a.json.id === 2 && b.json.id === 3 && a.json.cmd === 'click' && a.json.x === 10 && b.json.cmd === 'type';
  }],
  ['长轮询：空队列挂起后超时返回 {}（10s）', async () => {
    const t0 = Date.now();
    const r = await httpReq('GET', '/command', { headers: okHeaders() });
    const dt = Date.now() - t0;
    return r.status === 200 && Object.keys(r.json).length === 0 && dt >= 9000;
  }],
  ['POST /frame 合法 → stdout frame', async () => {
    const p = httpReq('POST', '/frame', { headers: okHeaders(), body: { seq: 1.5, data: 'aGVsbG8=', width: 800, height: 600 } });
    const m = await waitMsg((x) => x.type === 'frame');
    const r = await p;
    return r.status === 200 && m.seq === 1.5 && m.width === 800 && m.data === 'aGVsbG8=';
  }],
  ['POST /frame 非法（data 非字符串）→ 400', async () => {
    const r = await httpReq('POST', '/frame', { headers: okHeaders(), body: { seq: 1, data: 42, width: 1, height: 1 } });
    return r.status === 400;
  }],
  ['POST /event state → stdout state', async () => {
    const p = httpReq('POST', '/event', { headers: okHeaders(), body: { type: 'state', url: 'https://a.com', title: 'A' } });
    const m = await waitMsg((x) => x.type === 'state');
    const r = await p;
    return r.status === 200 && m.url === 'https://a.com' && m.title === 'A';
  }],
  ['POST /event cmdResult ok → stdout ok（归一化）', async () => {
    sendHostCmd({ id: 4, cmd: 'eval', expression: '1+1' });
    const c = await httpReq('GET', '/command', { headers: okHeaders() });
    const p = httpReq('POST', '/event', { headers: okHeaders(), body: { type: 'cmdResult', id: 4, ok: true, result: { value: 2 } } });
    const m = await waitMsg((x) => x.type === 'ok' && x.id === 4);
    const r = await p;
    return r.status === 200 && c.json.id === 4 && m.result.value === 2;
  }],
  ['POST /event cmdResult err → stdout err', async () => {
    sendHostCmd({ id: 5, cmd: 'navigate', url: 'x' });
    await httpReq('GET', '/command', { headers: okHeaders() });
    const p = httpReq('POST', '/event', { headers: okHeaders(), body: { type: 'cmdResult', id: 5, ok: false, error: { code: 'TIMEOUT' } } });
    const m = await waitMsg((x) => x.type === 'err' && x.id === 5);
    const r = await p;
    return r.status === 200 && m.error.code === 'TIMEOUT';
  }],
  ['POST /event 未知 type → 400', async () => {
    const r = await httpReq('POST', '/event', { headers: okHeaders(), body: { type: 'bogus' } });
    return r.status === 400;
  }],
  ['CORS 预检：OPTIONS 带扩展 Origin → 204 + ACAO + Allow-Headers', async () => {
    const r = await httpReq('OPTIONS', '/command', { headers: okHeaders() });
    return r.status === 204 && r.aca === okHeaders().Origin && r.allowHeaders.includes('X-Bib-Token');
  }],
  ['CORS 预检：OPTIONS 非扩展 Origin → 204 无 ACAO（不泄露）', async () => {
    const r = await httpReq('OPTIONS', '/command', { headers: { ...okHeaders(), Origin: 'http://evil.example' } });
    return r.status === 204 && r.aca === undefined;
  }],
  ['CORS 响应：GET /ping 带扩展 Origin → ACAO 回声', async () => {
    const r = await httpReq('GET', '/ping', { headers: okHeaders() });
    return r.status === 200 && r.aca === okHeaders().Origin;
  }],
  ['shutdown → exit 0', async () => {
    const p = waitMsg((x) => x.type === 'exit', 3000);
    sendHostCmd({ cmd: 'shutdown' });
    const m = await p;
    return m.code === 0;
  }],
];

// ---------------- 执行 ----------------
let failures = 0;
try {
  await startBridge();
  console.log(`桥已就绪，端口 ${port}\n`);
  for (const [name, fn] of tests) {
    try {
      const ok = await fn();
      record(name, ok);
      if (!ok) failures++;
    } catch (e) {
      record(name, false, e.message);
      failures++;
    }
  }
} catch (e) {
  console.error('FATAL: ' + (e && e.stack || e));
  failures++;
}

console.log(`\n${results.length - failures}/${results.length} 通过`);
if (bridge && bridge.exitCode === null) {
  try { bridge.kill(); } catch { /* ignore */ }
}
process.exit(failures === 0 ? 0 : 1);
