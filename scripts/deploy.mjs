// scripts/deploy.mjs —— 生成一键部署描述文件 deploy.json
// 用法：node scripts/deploy.mjs
//
// 产出：dsh-bib 根目录的 deploy.json，包含：
//   - host.js 完整源码（已内联桥代码，构建产物）
//   - client.jsx 完整源码
//   - 部署元信息（名称/用途/建议的 cordis_define 调用参数）
//
// 一键部署流程（DSH 动态插件只能经对话 cordis_define 提交代码）：
//   1. 先跑构建：npm run build（确保 host.js 是最新内联产物）
//   2. 跑本脚本：npm run deploy → 生成 deploy.json
//   3. 在 DSH 对话中对 AI 说：「读取 deploy.json 并部署 dsh-bib」，
//      AI 读文件后用 cordis_define(host=deploy.host, client=deploy.client) 完成。
//   4. 在 Edge 加载 extension/ 目录（开发者模式 → 加载解压缩的扩展）

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const hostPath = join(root, 'plugin', 'host.js');
const clientPath = join(root, 'plugin', 'client.jsx');

if (!existsSync(hostPath)) {
  console.error('[deploy] 缺少 plugin/host.js，请先运行 npm run build');
  process.exit(1);
}
if (!existsSync(clientPath)) {
  console.error('[deploy] 缺少 plugin/client.jsx');
  process.exit(1);
}

const host = readFileSync(hostPath, 'utf8');
const client = readFileSync(clientPath, 'utf8');

// 健康检查：host.js 必须已内联桥代码（代码占位符行未被替换即报错；
// 注释里提到占位符名字不算，故精确匹配代码行）
if (host.includes('const BRIDGE_CODE = __BRIDGE_CODE_INLINE__;')) {
  console.error('[deploy] plugin/host.js 仍含未替换占位符，请先运行 npm run build');
  process.exit(1);
}

const deploy = {
  pluginId: 'dshb',
  name: 'dsh-bib browser viewport',
  purpose: 'DSH 对话内嵌真实浏览器视口：Edge 扩展 attach 真实标签页，模型经 browser_* 工具操作（截图+AX 树感知），单标签锁定（AI 操作不打断浏览）。',
  host: host,
  client: client,
  install: [
    '1. 在 DSH 对话中，用 cordis_define 提交以上 host/client 代码（kind:new, idPrefix:"dshb"），再 cordis_run 激活',
    '2. 在 Edge 打开 edge://extensions → 开发者模式 → 加载解压缩的扩展 → 选择本仓库 extension/ 目录',
    '3. 首次使用：在对话中让模型调用 browser_open <url>；若扩展未自动连接，打开扩展 popup 点一次「连接」',
  ],
};

const outPath = join(root, 'deploy.json');
writeFileSync(outPath, JSON.stringify(deploy, null, 2));

console.log(`[deploy] 已生成 ${outPath}`);
console.log(`  host   : ${host.length} 字符（已内联桥代码）`);
console.log(`  client : ${client.length} 字符`);
console.log('一键部署：在 DSH 对话中对 AI 说「读取 deploy.json 并部署 dsh-bib」');
