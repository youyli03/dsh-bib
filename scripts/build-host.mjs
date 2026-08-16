// scripts/build-host.mjs —— 生成 plugin/host.js（内联桥源码，免路径配置）
// 用法：node scripts/build-host.mjs
// 读取 bridge/bridge.js 与 plugin/host.template.js，
// 将模板中的 __BRIDGE_CODE_INLINE__ 替换为转义后的桥源码字符串，
// 输出 plugin/host.js。生成后即可直接部署（无需修改任何路径）。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const bridgeSrc = readFileSync(join(root, 'bridge', 'bridge.js'), 'utf8');
const template = readFileSync(join(root, 'plugin', 'host.template.js'), 'utf8');

// 内联为 JS 字符串字面量（JSON.stringify 生成 "" 包裹的安全转义）
const inline = JSON.stringify(bridgeSrc);

// 只替换代码行 `const BRIDGE_CODE = __BRIDGE_CODE_INLINE__;`（注释里也提到占位符，不能全局替换）
const MARKER = 'const BRIDGE_CODE = __BRIDGE_CODE_INLINE__;';
if (!template.includes(MARKER)) {
  console.error('[build-host] 模板中未找到 ' + MARKER);
  process.exit(1);
}

const out = template.replace(MARKER, 'const BRIDGE_CODE = ' + inline + ';');
writeFileSync(join(root, 'plugin', 'host.js'), out);

console.log(`[build-host] 已生成 plugin/host.js（内联桥代码 ${bridgeSrc.length} 字节）`);
