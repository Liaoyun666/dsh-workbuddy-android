# dsh-workbuddy-android

**让 DSHA 里的 WorkBuddy 真正能用起来。**

手机上没有 WorkBuddy 桌面版，也没有那把解密凭据的本地密钥，所以 `dsh-workbuddy-bridge` 在安卓上永远是「未登录」——而它的登录按钮点了也没用，因为那个按钮指向的是桌面 App 的能力。

这个插件补的就是这一环，**两条路都通**：

```
路一（推荐）手机已经装了 WorkBuddy App
  手机（DSHA 容器）
  workbuddy_capture_from_phone
        ↓ 读 WorkBuddy App 自己的 MMKV 存储（纯 JS 解析）
  写 /root/.dsh/.workbuddy-auth.json
        ↓
  dsh-workbuddy-bridge 直接可用


路二 只有电脑上登录过 WorkBuddy 桌面版
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
- **不在手机上解桌面凭据。** 桌面那套 `$wbEncrypted` 信封只在电脑上解；手机端读的是 App 自己写的 MMKV 明文。
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

### 路一：手机上抓（不用电脑）

手机上装过 WorkBuddy App 并登录过，就这样：

```bash
node tools/cli.js capture
```

它做四件事：用 DSHA 设备 shell `ls` 出 WorkBuddy 的 MMKV 目录、把最新的三个文件 `cp` 到 `Download/DSHA/`、用纯 JS 解出 token、写进 `$DSH_HOME/.workbuddy-auth.json`。跑完顺手把临时副本删掉 —— 共享存储里躺着一份活 token 是隐患。

> **需要 root 或 Shizuku 已授权。** 走的是 DSHA 自己的设备 shell（`/root/dsh-bin/adb-shell`），它优先用 root/Shizuku 直接执行，没有才回落到 ADB。没授权时返回 `POLICY_BLOCKED`，去「设备能力」页打开对应开关 —— 这个错误**重试无效**，必须先去授权。
>
> 参数：`--dry-run` 只看抓到了什么不写文件，`--keep-copy` 保留临时副本（排查用，用完记得自己删）。

也可以在会话里让模型调 `workbuddy_capture_from_phone` 工具，效果一样。

### 路二：从电脑搬

手机上没有 WorkBuddy App，或者 App 里的登录态也过期了，就走这条。

#### 一、在电脑上导出

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

#### 三、在手机上导入

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

## 手机上那张 MMKV 文件长什么样

路一之所以能不解密就读出 token，是因为 MMKV 的格式本身很简单 —— 它是个长度前缀的 map：

```
偏移 0      uint32 LE   后面数据区的字节数
偏移 4      varint      一个占位的假条目大小（每次全量写回都会写入，必须按 varint 跳过，不能当 4 字节）
之后重复    varint keyLen, key, varint valueLen, value
```

`valueLen == 0` 表示这个键被删了（MMKV 靠追加写来删除，不重写整个文件）。**MMKV 不记录类型**：int 是小端字节、字符串是裸 UTF-8、bool 是一字节，只能按长度猜。本插件因此对「全是可打印 ASCII 且长度 2–512」的值优先当字符串读 —— 猜错一个数字无所谓，猜错一个 token 就白干了。

解析器还会同时尝试「跳过占位」和「不跳过占位」两种布局，取条目多的那个：新版全量写回有占位，新建或旧版文件可能没有。

`lib/mmkv.js` 是手写的，不是 `mmkv` 包。理由还是那条：安卓容器装不上原生模块。

### 键名是从 APK 里读出来的，不是猜的

`lib/phone.js` 的 `TOKEN_KEYS` 每一条都对着 `lib/arm64-v8a/libapp.so` 里的字符串池核实过。两点值得说明：

- **真实键名是 `workbuddy_user`，不是 `workbuddy_uid`。** 后者在二进制里出现 0 次（自然得让人想当然，所以特别写在这里）。而且它存的是**一整个 JSON 账号对象**，不是裸 id —— `uidFrom` 会把它打开，认 `uid` / `userId` / `openId` / `id` 等几个名字，最多往下钻三层。抽不出来就当没有 uid，不影响 token 本身。
- 同一套数据有两份键：`workbuddy_*` 和 `codebuddy_*`（后者是沿用 CodeBuddy 的家底）。两套都认，先 `workbuddy_*`。

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

## 给模型用的五个工具

装上之后，agent 能自己回答「workbuddy 为什么没反应」：

| 工具 | 碰什么 | 什么时候该用 |
|---|---|---|
| `workbuddy_status` | 只读本地文件 | 用户说「workbuddy 能不能用」「怎么没反应」 |
| `workbuddy_capture_from_phone` | 设备 shell + 写本地文件 | 手机上登录过 WorkBuddy App、但桥接插件说没登录 |
| `workbuddy_probe` | 只读网络 | 状态显示已登录但用户说用不了 |
| `workbuddy_import` | 只写文件 | 用户手上有一串 `wb1.` 令牌 |
| `workbuddy_refresh` | 网络 + 写文件 | **基本不该用** —— 见下 |

**`workbuddy_refresh` 为什么被劝退。** 凭据还有效时它直接返回 `STILL_FRESH` 什么都不做。理由是 `dsh-workbuddy-bridge` 自己会按需续期，而 WorkBuddy 的 refresh token 是**轮换**的 —— 两边各换一次，先换的那张就作废了。手动续期只在凭据已经过期、桥接插件又不肯动的时候才有意义。

每个失败都返回 `{ ok: false, code, error, hint }`，`hint` 里写明**重试有没有用**。模型看到 `Error: fetch failed` 只会重试；看到「重试无效，必须回电脑重新登录」才会去说人话。

---

## 踩出来的七条硬规矩

这几条不是设计口味，是踩出来的（前三、五条来自 `dsh-workbuddy-bridge`，其余是本插件自己踩的）：

1. **own 格式一字不差。** `{version:1, credential:{…}}`，`accessToken` 必须是非空字符串，缺省字段填 `''`/`0`。桥接插件 `parseOwnDocument` 读回时还会强制 `source:'dsh'`。
2. **刷新响应不带 `domain`。** 谁忘了沿用原凭据的 `domain`，谁就会把 CN 账号指向 global 域名，然后收到一堆 401。
3. **聊天必须 `stream: true`。** 非流式请求上游直接回 `400 / 11101 Non-stream chat request is currently not supported`。思考在 `delta.reasoning_content`，正文在 `delta.content`。
4. **`max_tokens` 要够思考先花完。** 实测：`max_tokens: 32` 时 `finish_reason` 是 `length`，思考把额度吃干净，正文永远是空的；`512` 才拿得到那两个字。推理模型的探测请求不能抠额度，否则它会把「这个模型很正常」报成「没回任何内容」。
5. **桌面密钥是 `sha256(密钥文本)`，不是 `sha256(base64 解码后的字节)`。** 两种算法都能产出好看的 32 字节密钥，只有信封里的 `keyId` 知道谁对（错的会得到 `28ad26a8…`，对的 `9127dea1…`）。这也解释了为什么往返测试抓不到它——加解密共用一套派生，自洽永远是自洽的。
6. **`valueLen` 为 0 是删除，不是空值。** MMKV 用追加写实现删除：写一条长度为 0 的同名键。把它当「空字符串」读，就会把已删除的旧 token 当成当前值。
7. **读 token 之前先看设备 shell 的策略白名单。** DSHA 的 `/root/dsh-bin/adb-shell` 不是自由 shell：`READ` 只允许 `cat/head/tail/ls/find/md5sum/…` 那一小撮，脚本、管道、重定向一律拦；`FILE` 的 `cp` 源路径才允许任意（仅拦短信库）。所以取文件的写法是 `cp 私有路径 → Download/DSHA/`，再由插件用 `node:fs` 读回，**而不是** `cat` 一个二进制文件回来 —— `cat` 的 stdout 会被当文本传，二进制会被改。

---

## 命令行

```
workbuddy-android capture [--dry-run] [--keep-copy] [--json]
workbuddy-android export [--out <文件>] [--file <桌面凭据>] [--electron <程序>] [--json]
workbuddy-android import --token <令牌> | --file <文件> | --stdin [--auth-file <路径>]
workbuddy-android status [--json] [--auth-file <路径>]
workbuddy-android verify [--chat] [--model <id>] [--json]
workbuddy-android refresh [--json]
workbuddy-android forget [--yes]
```

退出码：`0` 成功 / `1` 失败 / `2` 用法错误。

`capture` 和 `export` 是两条不同的路：前者**在手机上跑**，读手机 App 自己的存储；后者**在电脑上跑**，读桌面版的凭据。别在同一台机器上找错方向。

`forget` 必须带 `--yes`：删掉登录态是人的决定，不该被一个走神的回车完成。

---

## 开发

```bash
node --test tests/*.test.js       # 230 个用例
node tools/check-manifest.js      # 插件包契约自检
```

测试不联网、不用真凭据、不需要桌面版、不需要一台真手机。`tools/mock-api.js` 复刻了上游三个真实行为（非流式被拒、刷新不带 domain、思考单独一路）；`tests/phone.test.js` 用一个 `runner` 假扮设备 shell，再用真实的 MMKV 字节构造器生成文件 —— 所以格式解析和「抓到之后怎么处理」都是真跑，只有「能不能 spawn 一个 shell」是假的。

CI 在 Node 20 / 22 / 24 上跑同一套，外加一条端到端：伪造一份桌面凭据 → `export` → `import` → `status --json` 断言 `state=ready` 且身份没丢、令牌没漏。

---

## 相关

- [DSHA](https://github.com/DSH-APP/DSHA) —— 在安卓上跑完整的 DeepSeek Harness
- [dsh-workbuddy-bridge](https://www.npmjs.com/package/dsh-workbuddy-bridge) —— 真正的 WorkBuddy provider，本插件喂给它的就是它要的文件
- [dsha-native-tools](https://github.com/Liaoyun666/dsha-native-tools) / [dsha-capability-map](https://github.com/Liaoyun666/dsha-capability-map) / [dsh-android-portability](https://github.com/Liaoyun666/dsh-android-portability) —— 同一个作者的另外几个安卓侧插件

MIT.
