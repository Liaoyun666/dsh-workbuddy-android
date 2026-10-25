#!/usr/bin/env node
/**
 * 包契约自检 —— 发布前跑一遍，防止「本地好好的，发出去装不上」。
 *
 * 查的是 DSHA 文档里写明的硬要求：合法 npm 名、版本、type、dsh.bundle.patch
 * 指向的文件真的存在且含包名、入口存在、导出的东西真的导得出来、
 * files 白名单不漏文件，以及零运行时依赖（安卓容器是 Linux arm64/glibc）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const notes = [];

/** @param {string} message */
function fail(message) {
  problems.push(message);
}

/** @param {string} message */
function pass(message) {
  notes.push(message);
}

const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) {
  console.error('✗ 没有 package.json');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// 1. 名字与版本
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
if (!NPM_NAME.test(pkg.name ?? '')) fail(`name 不是合法 npm 名：${pkg.name}`);
else pass(`name = ${pkg.name}`);
if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(pkg.version ?? '')) fail(`version 不是合法语义版本：${pkg.version}`);
else pass(`version = ${pkg.version}`);

// 2. 模块类型与入口
if (pkg.type !== 'module') fail('type 必须是 module（本插件用 ESM）');
else pass('type = module');
const entry = pkg.main || pkg?.cordis?.entry;
if (!entry) fail('缺少 main 或 cordis.entry');
else if (!existsSync(join(root, entry))) fail(`入口文件不存在：${entry}`);
else pass(`入口存在：${entry}`);

// 3. 激活门：dsh.bundle.patch
const patch = pkg?.dsh?.bundle?.patch;
if (!patch) fail('缺少 dsh.bundle.patch —— DSHA 不会把它当插件加载');
else {
  const patchPath = join(root, patch);
  if (!existsSync(patchPath)) fail(`dsh.bundle.patch 指向的文件不存在：${patch}`);
  else {
    const text = readFileSync(patchPath, 'utf8');
    if (!/-\s*insert:/.test(text)) fail('cordis.patch.yml 里没有 - insert: 段落');
    if (!text.includes(pkg.name)) fail(`cordis.patch.yml 里没有出现包名 ${pkg.name}`);
    pass(`补丁有效：${patch}（${Buffer.byteLength(text)} 字节）`);
  }
}

// 4. 依赖：运行时必须为零，否则安卓 arm64 上装不上原生模块
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) fail(`不允许运行时依赖，当前有：${runtimeDeps.join(', ')}`);
else pass('零运行时依赖');
const peerDeps = Object.keys(pkg.peerDependencies ?? {});
if (peerDeps.length > 0) notes.push(`有 ${peerDeps.length} 个 peerDependencies（由宿主提供，可接受）`);

// 5. 所有 exports 指向的文件必须存在
const exportsMap = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports ?? {};
for (const [key, target] of Object.entries(exportsMap)) {
  const relative = String(target).replace(/^\.\//, '');
  if (!existsSync(join(root, relative))) fail(`exports["${key}"] 指向的文件不存在：${target}`);
}
if (Object.keys(exportsMap).length > 0) pass(`exports ${Object.keys(exportsMap).length} 项，文件都在`);

// 6. files 白名单（两边的 ./ 先 normalize，否则 './cordis.patch.yml' 与 'cordis.patch.yml' 对不上）
const files = (pkg.files ?? []).map((pattern) => String(pattern).replace(/^\.\//, ''));
const requiredFiles = ['lib', 'tools', String(patch ?? '').replace(/^\.\//, ''), 'README.md', 'LICENSE'].filter(
  (item) => item !== '',
);
for (const required of requiredFiles) {
  const covered = files.some(
    (pattern) => pattern === required || pattern.startsWith(`${required}/`) || required.startsWith(`${pattern}/`),
  );
  if (!covered) fail(`files 白名单漏了 ${required}`);
}
if (problems.length === 0) pass(`files 覆盖：${files.join(', ')}`);

// 7. dshhub 元数据
const hub = pkg?.dsh?.dshhub;
if (!hub) fail('缺少 dsh.dshhub 元数据');
else {
  if (hub.schemaVersion !== 1) fail('dsh.dshhub.schemaVersion 必须是 1');
  if (!hub.displayName) fail('dsh.dshhub.displayName 缺失');
  if (!hub.summary) fail('dsh.dshhub.summary 缺失');
  const network = hub.capabilities?.network;
  if (!Array.isArray(network) || network.length === 0) fail('dshhub.capabilities.network 必须列出本插件会连的主机');
  else {
    for (const host of network) {
      if (!/^https?:\/\//.test(String(host))) fail(`network 项不是 http(s) 主机：${host}`);
    }
    pass(`声明网络目标 ${network.length} 个：${network.join(', ')}`);
  }
  const reads = hub.capabilities?.reads;
  if (Array.isArray(reads) && reads.length === 0) notes.push('dshhub.capabilities.reads 为空');
}

// 8. 导出面：真的 import 一次，确认工具表拿得到
try {
  const module = await import(pathToFileURL(join(root, entry)).href);
  if (typeof module.apply !== 'function') fail('入口没有导出 apply(ctx, config)');
  else pass('导出了 apply()');
  if (typeof module.name !== 'string') fail('入口没有导出 name');
  else if (module.name !== pkg.name) fail(`导出的 name(${module.name}) 与包名(${pkg.name}) 不一致`);
  else pass(`导出的 name 与包名一致：${module.name}`);

  // 本插件从 lib/tools.js 暴露工具表，而不是从入口：入口保持薄。
  const toolsModule = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href);
  if (typeof toolsModule.buildTools !== 'function') fail('lib/tools.js 没有导出 buildTools()');
  else {
    // Point every call at a dead port: the check must not touch the network.
    const tools = toolsModule.buildTools({
      env: { DSH_HOME: join(root, '.contract-check-home') },
      baseUrl: 'http://127.0.0.1:1',
    });
    if (!Array.isArray(tools) || tools.length === 0) fail('buildTools() 没有返回工具');
    else {
      for (const tool of tools) {
        if (!tool.name || !tool.description) fail(`工具缺少 name/description：${JSON.stringify(tool.name)}`);
        if (!tool.parameters) fail(`工具 ${tool.name} 缺少 parameters`);
        if (typeof tool.execute !== 'function') fail(`工具 ${tool.name} 缺少 execute`);
      }
      const provided = hub?.capabilities?.provides ?? [];
      for (const name of provided) {
        if (!tools.some((tool) => tool.name === name)) fail(`dshhub 声明提供了 ${name}，但 buildTools() 里没有`);
      }
      pass(`工具 ${tools.length} 个：${tools.map((tool) => tool.name).join(', ')}`);
    }
  }
} catch (error) {
  fail(`import 入口失败：${/** @type {Error} */ (error).message}`);
}

if (problems.length > 0) {
  console.error('✗ 包契约不通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('✓ 插件包契约通过');
for (const note of notes) console.log(`  · ${note}`);
