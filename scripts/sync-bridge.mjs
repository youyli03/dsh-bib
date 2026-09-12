// scripts/sync-bridge.mjs —— 把 bridge/bridge.js 重新内联进静态插件包
// 用法：node scripts/sync-bridge.mjs
//
// 背景：plugin-pkg/lib/index.js 是手工维护的静态包（比 plugin/host.template.js 新一支），
// 不走模板构建；但它的 `const BRIDGE_CODE = "...";` 必须与 bridge/bridge.js 保持一致，
// 否则桥的行为会随文件漂移。本脚本只替换那一个字面量，其余内容原样保留。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = join(root, 'bridge', 'bridge.js');
const targetPath = join(root, 'plugin-pkg', 'lib', 'index.js');

const bridgeSrc = readFileSync(bridgePath, 'utf8');
const src = readFileSync(targetPath, 'utf8');

const MARKER = 'const BRIDGE_CODE = ';
const markerAt = src.indexOf(MARKER);
if (markerAt < 0) {
  console.error('[sync-bridge] 未找到 ' + MARKER + '，中止');
  process.exit(1);
}
const start = src.indexOf('"', markerAt + MARKER.length);
if (start < 0) {
  console.error('[sync-bridge] BRIDGE_CODE 字面量起始引号未找到，中止');
  process.exit(1);
}
// 扫描到闭合引号（跳过转义），避免用正则猜转义
let i = start + 1;
for (; i < src.length; i++) {
  const c = src[i];
  if (c === '\\') { i++; continue; }
  if (c === '"') break;
}
if (i >= src.length || src[i] !== '"') {
  console.error('[sync-bridge] BRIDGE_CODE 字面量未闭合，中止');
  process.exit(1);
}

const previous = JSON.parse(src.slice(start, i + 1));
const out = src.slice(0, start) + JSON.stringify(bridgeSrc) + src.slice(i + 1);

if (previous === bridgeSrc) {
  console.log('[sync-bridge] 已是最新，无需改动（' + bridgeSrc.length + ' 字节）');
  process.exit(0);
}
if (!previous.startsWith("'use strict';")) {
  console.error('[sync-bridge] 现有字面量不像桥源码，为安全中止（前 40 字：' + previous.slice(0, 40) + '）');
  process.exit(1);
}
writeFileSync(targetPath, out);
console.log('[sync-bridge] 已更新 plugin-pkg/lib/index.js 内联桥：' + previous.length + ' -> ' + bridgeSrc.length + ' 字节');
