# dsh-workbuddy-android

**让 DSHA 里的 WorkBuddy 真正能用起来。**

手机上没有 WorkBuddy 桌面版，也没有那把解密凭据的本地密钥，所以 `dsh-workbuddy-bridge` 在安卓上永远是「未登录」——而它的登录按钮点了也没用，因为那个按钮指向的是桌面 App 的能力。

这个插件补的就是这一环：在**有桌面版的电脑**上把已有登录态解出来，打成一行可粘贴的文本，带到手机上写进桥接插件要读的那个文件。

```
电脑                                    手机（DSHA 容器）
workbuddy-android export  ──wb1.…──→  workbuddy-android import
        ↓                                     ↓
  读桌面凭据 + 解密                    写 /root/.dsh/.workbuddy-auth.json
                                              ↓
                                    dsh-workbuddy-bridge 直接可用
```

---

## 它不做什么

说清楚边界，比说清楚功能更省事：

- **不做登录。** 设备码登录是另一条路，本插件只搬运已有的登录态。
- **不在手机上解密。** 解密只在桌面端发生一次；手机端收到的已经是明文，落盘权限 0600。
- **不替代 `dsh-workbuddy-bridge`。** 它仍然是唯一的 provider，本插件只负责把它要读的文件喂进去。
- **不联网拉额度、不改模型目录。** 它只碰凭据文件，和一次可选的连通性验证。

---

## 装

```bash
# 在 DSHA 的终端里
dsha-plugin install Liaoyun666/dsh-workbuddy-android
```

零运行时依赖，不需要编译，不碰原生模块（安卓容器是 Linux arm64/glibc，`sharp`、`better-sqlite3` 那类东西在这里装不上）。

---

## 用

### 一、在电脑上导出

电脑上装好 WorkBuddy 桌面版并已登录，然后：

```bash
node tools/cli.js export
```

stdout 只输出一行 `wb1.` 开头的令牌，人读信息全走 stderr，所以可以直接管道：

```bash
node tools/cli.js export | pbcopy            # macOS
node tools/cli.js export > token.txt         # 或存文件
node tools/cli.js export --out token.txt     # 同上，顺手设成 0600
```

> **桌面版的凭据是加密的。** 插件会自己去问桌面 App 要那把本地密钥（`ELECTRON_RUN_AS_NODE=1` 起一次进程读 binding）。如果失败，最常见的原因不是路径不对，而是**桌面版还开着** —— 单实例锁会让它以 node 模式启动不起来。请先完全退出（包括托盘图标）再试。
>
> 已经有明文凭据文件时不会去启动桌面程序 —— 为了读一个明文 JSON 拉起一个 GUI 程序是很失礼的事。

### 二、把令牌带到手机

自己想办法：复制粘贴、发给自己、扫码都行。**令牌等于登录态**，别贴到公开地方。

### 三、在手机上导入

```bash
node tools/cli.js import --token 'wb1.……'
# 或者
node tools/cli.js import --file token.txt
# 或者
cat token.txt | node tools/cli.js import --stdin
```

导入后会落在 `$DSH_HOME/.workbuddy-auth.json`（默认 `/root/.dsh/.workbuddy-auth.json`），权限 0600，父目录 0700。这个路径和权限不是随便定的 —— `dsh-workbuddy-bridge` 的 `parseOwnDocument` 读的就是这个结构，`version` 必须是 `1`。

### 四、确认

```bash
node tools/cli.js status          # 人读
node tools/cli.js status --json   # 机器读
node tools/cli.js verify --chat   # 真的发一句话（会消耗一点额度）
```

`status` 的退出码是给脚本用的：`0` 可用（含「已过期但能续期」），`1` 不可用，`2` 用法错。

重启 DSHA 或重载会话后，模型选择里就应该出现 WorkBuddy 了。

---

## 五种状态，五种下一步

`status` 不会把一切塞进「能不能用」两个值里，因为每种状态要用户做的事完全不同：

| 状态 | 意思 | 下一步 |
|---|---|---|
| `missing` | 还没导入过 | 去电脑上 `export` |
| `unreadable` | 文件在，但不是桥接插件认的格式 | 删掉重新 `import`（里面有别的重要数据就先备份） |
| `expired` | access token 和 refresh token 都过期了 | 回电脑重新登录、重新导出 |
| `renewable` | access token 过期了，但 refresh token 还能换 | 什么都不用做，桥接插件读到时会自动续期 |
| `ready` | 有可用的 access token | 什么都不用做 |

**`renewable` 是「能用」，不是「有问题」。** 这条最容易踩：把 `renewable` 报成失败，用户就会为了一个本来会自动恢复的状态去重做一整套导出。

---

## 给模型用的四个工具

装上之后，agent 能自己回答「workbuddy 为什么没反应」：

| 工具 | 碰什么 | 什么时候该用 |
|---|---|---|
| `workbuddy_status` | 只读本地文件 | 用户说「workbuddy 能不能用」「怎么没反应」 |
| `workbuddy_probe` | 只读网络 | 状态显示已登录但用户说用不了 |
| `workbuddy_import` | 只写文件 | 用户手上有一串 `wb1.` 令牌 |
| `workbuddy_refresh` | 网络 + 写文件 | **基本不该用** —— 见下 |

**`workbuddy_refresh` 为什么被劝退。** 凭据还有效时它直接返回 `STILL_FRESH` 什么都不做。理由是 `dsh-workbuddy-bridge` 自己会按需续期，而 WorkBuddy 的 refresh token 是**轮换**的 —— 两边各换一次，先换的那张就作废了。手动续期只在凭据已经过期、桥接插件又不肯动的时候才有意义。

每个失败都返回 `{ ok: false, code, error, hint }`，`hint` 里写明**重试有没有用**。模型看到 `Error: fetch failed` 只会重试；看到「重试无效，必须回电脑重新登录」才会去说人话。

---

## 踩出来的五条硬规矩

这几条不是设计口味，是踩出来的（前三条来自 `dsh-workbuddy-bridge`，后两条是本插件自己踩的）：

1. **own 格式一字不差。** `{version:1, credential:{…}}`，`accessToken` 必须是非空字符串，缺省字段填 `''`/`0`。桥接插件 `parseOwnDocument` 读回时还会强制 `source:'dsh'`。
2. **刷新响应不带 `domain`。** 谁忘了沿用原凭据的 `domain`，谁就会把 CN 账号指向 global 域名，然后收到一堆 401。
3. **聊天必须 `stream: true`。** 非流式请求上游直接回 `400 / 11101 Non-stream chat request is currently not supported`。思考在 `delta.reasoning_content`，正文在 `delta.content`。
4. **`max_tokens` 要够思考先花完。** 实测：`max_tokens: 32` 时 `finish_reason` 是 `length`，思考把额度吃干净，正文永远是空的；`512` 才拿得到那两个字。推理模型的探测请求不能抠额度，否则它会把「这个模型很正常」报成「没回任何内容」。
5. **桌面密钥是 `sha256(密钥文本)`，不是 `sha256(base64 解码后的字节)`。** 两种算法都能产出好看的 32 字节密钥，只有信封里的 `keyId` 知道谁对（错的会得到 `28ad26a8…`，对的 `9127dea1…`）。这也解释了为什么往返测试抓不到它——加解密共用一套派生，自洽永远是自洽的。

---

## 命令行

```
workbuddy-android export [--out <文件>] [--file <桌面凭据>] [--electron <程序>] [--json]
workbuddy-android import --token <令牌> | --file <文件> | --stdin [--auth-file <路径>]
workbuddy-android status [--json] [--auth-file <路径>]
workbuddy-android verify [--chat] [--model <id>] [--json]
workbuddy-android refresh [--json]
workbuddy-android forget [--yes]
```

退出码：`0` 成功 / `1` 失败 / `2` 用法错误。

`forget` 必须带 `--yes`：删掉登录态是人的决定，不该被一个走神的回车完成。

---

## 开发

```bash
node --test tests/*.test.js       # 179 个用例
node tools/check-manifest.js      # 插件包契约自检
```

测试不联网、不用真凭据、不需要桌面版。`tools/mock-api.js` 复刻了上游三个真实行为（非流式被拒、刷新不带 domain、思考单独一路），所以 HTTP 那层是真的在跑，不是打桩。

CI 在 Node 20 / 22 / 24 上跑同一套，外加一条端到端：伪造一份桌面凭据 → `export` → `import` → `status --json` 断言 `state=ready` 且身份没丢、令牌没漏。

---

## 相关

- [DSHA](https://github.com/DSH-APP/DSHA) —— 在安卓上跑完整的 DeepSeek Harness
- [dsh-workbuddy-bridge](https://www.npmjs.com/package/dsh-workbuddy-bridge) —— 真正的 WorkBuddy provider，本插件喂给它的就是它要的文件
- [dsha-native-tools](https://github.com/Liaoyun666/dsha-native-tools) / [dsha-capability-map](https://github.com/Liaoyun666/dsha-capability-map) / [dsh-android-portability](https://github.com/Liaoyun666/dsh-android-portability) —— 同一个作者的另外几个安卓侧插件

MIT.
