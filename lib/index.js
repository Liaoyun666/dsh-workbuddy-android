/**
 * dsh-workbuddy-android — 把 WorkBuddy 的登录态从电脑搬到手机。
 *
 * 问题很具体：`dsh-workbuddy-bridge` 读 `/root/.dsh/.workbuddy-auth.json`，
 * 而这个文件只能由它自己写入 —— 它靠 WorkBuddy 桌面版（Electron）的本地密钥
 * 解密桌面凭据来生成。手机上没有 WorkBuddy 桌面版，没有那个密钥，也没有系统
 * 钥匙串，所以在 DSHA 里 workbuddy 永远是「未登录」，而登录按钮点了也没用。
 *
 * 本插件补的就是这一环：在**有桌面版的那台电脑**上把凭据解出来，打成一行
 * 可粘贴的传输令牌（`wb1.` 开头），带到手机上写进那个文件。
 *
 * 设计边界，值得先说清楚：
 *
 *   - 不做登录。设备码登录是另一条路（已有插件在做），本插件只搬运已有登录态。
 *   - 不解密任何东西。解密只发生在桌面端，手机端只接收明文并落盘 0600。
 *   - 不替代 `dsh-workbuddy-bridge`。它仍然是唯一的 provider；本插件只喂它文件。
 *   - 零运行时依赖。安卓容器是 Linux arm64/glibc，原生模块装不上就是崩。
 *
 * @module dsh-workbuddy-android
 */

import { describeCredential } from './credential.js';
import { buildTools, forgetCredential } from './tools.js';
import { inspectCredential } from './status.js';

/** 插件名（loader 用它给 row 编号）。 */
export const name = 'dsh-workbuddy-android';

/** 只用工具面：没有工具注册表就不该启动。 */
export const inject = ['tools'];

/** 给 `dsh plugin` 的配置提示（宿主不一定读，但写上便于人看）。 */
export const Config = {
  authFile: { type: 'string', description: '凭据文件路径，缺省 $DSH_HOME/.workbuddy-auth.json' },
};

/**
 * @param {Record<string, unknown>} [raw]
 */
function resolveConfig(raw = {}) {
  const authFile = typeof raw.authFile === 'string' ? raw.authFile.trim() : '';
  return { authFile: authFile === '' ? undefined : authFile };
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const tools = buildTools(config);

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-workbuddy-android: ${tool.name}`);
  }

  // 启动时看一眼凭据，但**只打一行日志，绝不阻塞**：没有凭据是完全正常的
  // 初始状态，插件照样注册工具（status 会告诉用户怎么办）。
  inspectCredential(config)
    .then((report) => {
      if (!report.exists) {
        ctx.logger?.info?.(
          'dsh-workbuddy-android：这台设备上还没有 WorkBuddy 凭据。要搬一份过来，在电脑上运行 workbuddy-android export',
        );
        return;
      }
      const identity = report.summary?.nickname ?? report.summary?.uid ?? '未知身份';
      ctx.logger?.info?.(`dsh-workbuddy-android：WorkBuddy 凭据${report.label}（${identity}，${report.path}）`);
      if (report.state === 'expired') {
        ctx.logger?.warn?.(
          'dsh-workbuddy-android：凭据已过期且无法续期。请在电脑上重新登录 WorkBuddy 桌面版，再导出一份',
        );
      }
      // 权限太宽只在真有问题时说：Windows 上 stat 恒报 0666，提也没用。
      if (report.mode !== undefined && process.platform !== 'win32' && (report.mode & 0o077) !== 0) {
        ctx.logger?.warn?.(`dsh-workbuddy-android：${report.path} 权限是 ${report.mode.toString(8)}，同一容器里的其它进程也能读到，建议 chmod 600`);
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`dsh-workbuddy-android：检查凭据失败 —— ${error?.message ?? error}`);
    });
}

export { forgetCredential, describeCredential };
