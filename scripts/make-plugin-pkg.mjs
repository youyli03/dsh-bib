// scripts/make-plugin-pkg.mjs —— 从 deploy.json 生成静态插件包（plugin-pkg/）
// 生成：lib/index.js（host 半区，export default）、lib/client.js（client 半区，ModuleLoader 格式）
// 注意：本脚本必须用 node 执行（node scripts/make-plugin-pkg.mjs），不要在 PowerShell 里内联转写，
// 避免控制台编码破坏中文。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'plugin-pkg');
mkdirSync(join(pkgDir, 'lib'), { recursive: true });

const deploy = JSON.parse(readFileSync(join(root, 'deploy.json'), 'utf8'));

// ---- host 半区：export default { inject, apply } ----
let host = deploy.host;
// 去掉头部注释行（模板注释含占位符说明，不需要进发布物）
const bodyStart = host.indexOf('return {');
if (bodyStart >= 0) {
  host = host.slice(bodyStart);
}
host = host.replace(/^return \{/, 'export default {');
writeFileSync(join(pkgDir, 'lib', 'index.js'), host);

// ---- client 半区：ModuleLoader 格式（window.__ModuleLoader__.load） ----
const client = deploy.client;
const clientBundled = `window.__ModuleLoader__.load({
  id: 'dsh-bib',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require('react');
    const applyPlugin = (() => {
      ${client.replace(/\n/g, '\n      ')}
    })();
    // client 半区返回的 Cordis 插件对象：包一层标准导出
    const plugin = typeof applyPlugin === 'function' ? applyPlugin() : applyPlugin;
    module.exports = plugin;
    return module.exports;
  }
});
`;
writeFileSync(join(pkgDir, 'lib', 'client.js'), clientBundled);

// ---- 包元数据 ----
const pkg = {
  name: 'dsh-bib',
  version: '0.1.0',
  description: 'DSH 内嵌浏览器：真实标签页 CDP 代理（browser_* 工具 + AX 树 + 单标签锁定）',
  type: 'module',
  private: true,
  main: 'lib/index.js',
  dsh: {
    bundle: {
      patch: './cordis.patch.yml',
    },
    client: {
      main: './lib/client.js',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
      platform: 'web',
    },
  },
  engines: { node: '>=18' },
  license: 'MIT',
};
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// ---- 挂载补丁 ----
const patch = `# dsh-bib bundle patch — 声明插件挂载行
- insert:
    - id: dsh-bib
      name: 'dsh-bib'
`;
writeFileSync(join(pkgDir, 'cordis.patch.yml'), patch);

console.log('[make-plugin-pkg] 已生成 plugin-pkg/');
console.log('  lib/index.js  :', (readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).length, '字符');
console.log('  lib/client.js :', (readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8')).length, '字符');
console.log('  package.json  / cordis.patch.yml');
