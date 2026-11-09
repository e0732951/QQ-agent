# 京玉版适配说明（jy-1.4.3-Beta / Beta2）

这份文件只讲**和 0.4 版那一份的差异**，方便以后上游升版时照着移植。
插件功能本身看 README.md，补丁引擎的设计取舍看 docs/adr/。

目标环境：京玉版（社区整合版 2026-09-22，本地目录 `QQ-Agent-整合版-20260922`）。

## 一、为什么需要适配

0.4 的补丁表在 0.4 的核心上 18 个块全部命中。搬到京玉版上实测：**16 个能打、2 个挂不上**，
而补丁是原子写入 —— 一个块冲突就一个文件都不写，所以表现是"插件装了、启用了，指令毫无反应"。

两个挂不上的块：

| 块 | 0.4 的锚点 | 京玉版上的情况 |
|---|---|---|
| `dispatch` | 注释行「`// ── 指令禁言：群内任何人 @机器人 …`」 | 上游把「指令禁言」整块删了，连注释带 `maybeTriggerCommandMute` 一起消失 → `findSoleAnchor` 返回 -1 |
| `reload-shortcut` | `  Menu.setApplicationMenu(null);` | 这句在新核心里出现**两次**（B 站登录窗 482 行 / 主窗口 644 行）→ 不唯一 |

除此之外还有一处**不会立刻显形**的问题：`dispatch` 块里引用了 `reminders`、
`maybeTriggerCommandMute`、`forwardLinkedMedia`，这三个名字在京玉版核心里**都不存在**
（连 `src/reminders.js` 这个文件都没有）。补丁就算打上去，也会在每条消息拼 host 对象时
抛 ReferenceError、被块自己的 `try/catch` 吞掉 —— 用户看到的是"毫无反应 + 日志刷分发失败"。

## 二、锚点对照表（7 个块换了锚，11 个保持原样）

换锚的原则：**锚在注释上的换成锚在代码行上**（注释是最容易被上游顺手改掉的东西）；
同一段代码在文件里出现多次的，加作用域锚（`scope` + 默认 200 行窗口内唯一）。

| 块 | 文件 | 京玉版锚点 |
|---|---|---|
| `dispatch` | src/app.js | 位置一（京玉版）：`scope: async function ingestMessage(kind, id, event) {` + `    const incoming = store.appendIncoming(`（before）<br>位置二（0.3.1/0.4.0）：同一 scope + `    store.appendIncoming(\`${kind}:${id}\`, {`（before） |
| `plugin-assets` | src/app.js | `    if (req.method === 'GET') {`（before，全文唯一） |
| `manifest-normalizers` | src/skills/manifest.js | `function normalizePrompt(prompt) {`（before） |
| `status-fields` | src/skills/manager.js | `      implementedCapabilities: Object.keys(skill.providers \|\| {}),`（before） |
| `plugin-storage` | src/plugin-loader.js | `const APP_ROOT = path.resolve(`（before） |
| `loader-api` | src/plugin-loader.js | `    log: (...args) => console.log(`（before） |
| `reload-shortcut` | electron/main.js | `scope: function createWindow(port) {` + `  Menu.setApplicationMenu(null);`（after） |

⚠️ `dispatch` 的两个位置**不是"首选 + 兜底"，是给不同核心版本用的**：京玉版把存档那行改成了
`const incoming = store.appendIncoming(…)`，0.3.1 / 0.4.0 还是 `store.appendIncoming(…, {`。
两者的作用域和语义位置完全相同，只是那一行的写法不同 —— 所以这份插件**同时支持三个版本**。
第一次移植时我只写了京玉版那一处，实测在 0.3.1 / 0.4.0 上"旧块原位升级"会直接失败
（锚点找不到 → 原子放弃 → 一个文件都不写），补上第二个位置后三个版本全绿。

其余 11 个块（`manifest-fields`、`manifest-locals`、`loader-import`、以及 ui/app.js 的 8 个）
本来就是代码行锚，实测在京玉版上唯一命中，保持不动。

⚠️ **界面块只对得上锚点还不够**：2026-09-23 真事故 —— `sidebar-menu` 块写死了
`menu.push(...)`，而京玉版的侧栏变量叫 `menuGroups`（分组数组，0.3.1/0.4.0 才叫 `menu`）。
锚点命中、文件语法正确、补丁状态 patched，但一进设置页就 ReferenceError，
整个设置页渲染中断（症状：**设置页整片空白**）。
现在块里两个分支都认（`typeof` 兜住，两个都没有就什么都不做），
并有 `_jy-dev/ui-smoke-test.mjs` 把"设置页真的能渲染出来"钉死。
**教训：界面块必须跑一遍渲染，不能只看锚点和语法。**

⚠️ 同一批的第二个坑（同一天）：插件设置页的侧栏入口依赖 `state.skills`，而
**0.4 的界面有四处会给它赋值（进设置页、记忆设置、工具页…），京玉版的设置页根本不拉
`/api/skills`** —— 于是 `state.skills` 永远是空的，侧栏里永远不会出现「指令前置」的配置页
（症状：设置页正常了，但看不到插件的配置页）。
现在块里自己补一次：`ensurePluginSkills()` 拉 `/api/skills` → 存进 `state.skills` →
重画侧栏与当前分区（30 秒内只试一次，拿到数据后永久短路）。
界面冒烟测试已经从**"state.skills 为空"这个真实起点**出发验证这条路径。

顺带一条不是 bug 的说明：`/帮助` 列的是**清单里的 `commands[]`**（
「指令」），而「隐私模式」是 `intercept`（拦截者）—— 它按自己的指令词直接认领私聊消息，
本来就不该出现在 `/帮助` 里（0.3.1/0.4.0 也一样）。分发验收测试里把这条也钉住了。

### 隐私模式改成「走指令通道的拦截者」（2026-09-23，作者要求）

它的开关本来就是指令（`/隐私模式 人设`、`/结束隐私模式`），所以清单里补了 `commands[]`：
**开/停走指令通道**（进 `/帮助`、进设置页指令表、受权限与启用管），**会话期间的每句话才拦截**。

* 「开」：拦截者**整个让出去**（`handled:false`）。在指令表里就按指令办 —— 权限不够 →
  前置的语义是"当普通消息放行"（不认领、不执行、不回执）；够权限 → 执行并回执。
  指令表拿不到时（老核心/别的调用点）才回落到自己开（保持向后兼容）。
* 「停」：优先让给指令通道（那里有回执）；只有指令表不可用、或这条指令被关掉/权限不够时，
  拦截者才自己兜住 —— **"随时能停"是安全底线**，不能因为关掉一条指令就卡在隐私模式里。
* 会话期间：仍然由 `intercept` 接管（这一段本来就不该走权限表）。
* 前置为此给拦截者多递了两个**只读**字段：`effectiveRoutes`（合并覆盖表后的有效指令表）
  与 `permissionLevel`（触发者权限等级）。原来的字段一个没动，别的拦截者可以继续忽略它们。
* 设置页新增「拦截者」小节（只读）：列出谁在指令之前被问、order 多少、哪部分走权限表，
  免得再出现"这插件到底录进去没有"。

### `/帮助` 补参数写法说明 + 每条带例子（2026-09-23）

有用户看完帮助后发了 `/禁言 @Death's End [时间=1分钟]` —— 把参数说明里的**方括号原样打了出去**。
现在 `/帮助` 的**每一页**都带两行格式说明：

```
格式：
<尖括号> = 这里填你的参数内容；
[方括号] = 可以不填，不填就用里面的默认值。（例：[时间=30分钟] 是"时间可以不写，默认 30 分钟"正确写法见每条的"例："）
```

并且每条指令后面跟一个**真例子**（取清单里的 `examples[0]`，没有就不显示）：
`/禁言 @用户 [时间=30分钟] —— … · 例：/禁言 @张三`。
顺手给「远程关机」补了 `examples`（`/关闭电脑 30`、`/关闭电脑 取消`、`/关闭电脑 立即`）。

⚠️ 注意 `/帮助` 只列**发信人有权使用**的指令（没权限的指令连存在都不该知道），
所以不同人看到的页数与内容不一样；测试里给足了权限才看得到全部 13 条。
另外权限表只认**数字 QQ**，非数字的行会被丢掉。

⚠️ 有一处**不再靠 scope**：`plugin-assets` 的落点离它所在函数的开头有一千七百多行，
超出窗口；这行锚点本身全局唯一，所以直接全文锚。哪天上游再加一个同样缩进的
`if (req.method === 'GET') {`，它会变成"不唯一"→ 报冲突（方向是安全的，不会乱插）。

## 三、块内容的改动（只改 dispatch 一个块）

### ⚠️ 回归修复（2026-09-23，朋友实测反馈）

软引用改造那一版**漏了 host 上的 `chat` / `search` / `personas`**（原版 1.4.3 是有的，
见 0.4 那份 patch 文件第 53 / 58 / 59 行）：

* `ai.ask` → `host.chat(...)`　`search.web` → `host.search(...)`　`persona.apply` → `host.personas()`
  这三条服务能力**全挂**，于是所有 `api.capability('ai.ask')` 的插件都中招（不止表情包）。
* 现在按原样加回 `makePluginHost()`（`import('./llm.js')` / `web-search.js` / `personas.js`，
  京玉版核心里这三个模块都在、导出名一致）。
* 顺手给 `services.js` 加了一道护栏：核心里没有某个口子时
  （例：京玉版已经没有 `reminders`，所以 `schedule.cron` 在它上面天然不可用）
  抛的是「这版核心没有提供「X」—— 这个能力在你这份核心上不可用」，
  而不是 `Cannot read properties of undefined (reading 'pending')`。
* 回归：`patch-test` 现在断言 host 上必须有这三个函数；新增 `services-test.mjs` 走正常路径
  与"缺口子"两条路。
* ⚠️ 这个修复在**块内容**里，属于核心侧改动 → **要重启一次**才生效（插件侧的 services.js 是热重载）。

`patches/src__app.js__dispatch.js` 从"点名 16 个核心符号"改成**软引用**：

* 核心句柄一律从 `pluginHost` 取；可选的那些（`sessions`/`stickers`/`sender`/`onebot`/
  `memory`/`DATA_DIR`/`getConfig`/`updateConfig`）用 `typeof x === 'undefined' ? undefined : x`
  包住 —— `typeof` 对不存在的名字也安全，不会抛错。
* 老核心（0.4）才有的 `maybeTriggerCommandMute`、`forwardLinkedMedia` 也这样取；京玉版上
  自然是 `undefined`，调用处是 `?.()`，所以是"跳过这一项"，不是"报错"。
  **同一份块因此能在两个分支上跑**。
* `reminders` 直接去掉（京玉版已经没有这个模块了；0.4 上它只被"服务能力"用，去掉不影响指令）。
* 分发失败的日志**只记第一次**（`globalThis.__cgDispatchErrorLogged`）：这条路径上出问题
  会让每条消息都进来一次，全刷出来会把日志淹掉。
* 必需项（`skillManager`/`store`/`orchestrator`/`emit`/`log`）仍然直接引用 —— 缺了宁可炸得
  看得见；而且它们写在补丁表的 `needs` 里，安装前就会被拦下来并说清缺了谁。

## 四、引擎升级（patch.mjs，PATCH_VERSION 5 → 6）

1. **作用域锚**：`place.scope` + `place.window`（默认 200 行）。先要求 scope 唯一命中且落在
   行首，再只在这个窗口里找 anchor，同样要求窗口内唯一。
2. **依赖自检 `needs`**：每个块申报"我引用了哪些核心自己提供的符号"。缺任何一个 →
   状态报 `incompatible`、apply 拒绝写入，并在设置页那一行写清缺了谁。
   （注意：本插件**别的块**引入的名字不能列进来，例如 plugin-loader.js 的 `DATA_DIR`
   由 `loader-import` 块引入。）
3. **落地前语法体检**：写盘前把成品文本喂给 `node --check`（ESM）或 `vm.Script`（普通脚本，
   京玉版的前端 `ui/app.js` 就是）。解析不过 → 一个文件都不写。Electron 里 `process.execPath`
   是 electron.exe，所以子进程要带 `ELECTRON_RUN_AS_NODE=1`（两条路径都实测过）。
4. **"摘旧块"改成看数据**（2026-09-23 修）：原来无条件吃掉块前面那个换行（假定所有块都以
   `\n` 开头）。但 `sidebar-menu` 是直接贴在两行代码之间的（不带前导空行），于是摘除时
   把 `];` 和下一行并成一行 → 锚点不在行首 → **原位升级失败**。现在只有标记行上方那一行
   确实是空行时才吃掉它。回归测试见 `patch-test.mjs` 第 9 节。

## 五、回归测试

两个脚本，都在 `_jy-dev/`，全程只用临时数据目录，不碰安装目录：

* `patch-test.mjs`（52 项）：干净核心上 18 块可打、往返逐字节还原、幂等、原子拒绝、
  依赖自检、作用域锚失联、语法体检、插件生命周期，以及**会话前缝的兜底语义**
  （把注入块抽到沙箱里跑：没插件 / 插件抛错 / 上游删符号 / 可选句柄缺失 /
  老核心符号存在时各自的行为）。
* `dispatch-acceptance.mjs`（7 项）：把消息直接喂给缝上的那个能力提供者，验
  `/抛骰子` 有回执、`/关闭电脑` 因权限不足被放行、普通聊天不被吞、`/帮助` 有回执、
  关掉插件后缝变成"没插电"。
* `cross-version-test.mjs`（33 项）：同一份补丁表在 **0.3.1 / 0.4.0 / 京玉版** 三种核心上
  各跑两个场景 —— 全新安装（打一次再摘回来，一个字都不许多不许少）与旧块原位升级
  （不许改动任何一行代码，只允许空行差异）。
* `ui-smoke-test.mjs`（15 项）：用最简 DOM 桩把**京玉版的控制台界面真跑一遍**，
  调的就是用户点「设置」时走的那几个函数（`renderSettingsSidebar` / `renderSettings` /
  `renderSettingsSection`），断言不抛错、侧栏里真的出现了插件的设置入口。

```
node _jy-dev/patch-test.mjs
node _jy-dev/dispatch-acceptance.mjs
node _jy-dev/cross-version-test.mjs
node _jy-dev/ui-smoke-test.mjs
```

另外两条手工核对（都在本目录跑，临时数据目录随意）：

```
# 打过补丁的核心能不能真的被加载（不只是语法通过）
node --input-type=module -e "await import('./src/app.js')"
```

## 六、以后上游出 1.5 / 2.0 时怎么移植

1. 先把插件停用（**停用会按标记把补丁摘掉**），或者直接看设置页顶部那行状态。
2. 跑 `node _jy-dev/patch-test.mjs`：第 1 节会列出哪几个块落不下去，以及缺哪些符号。
3. 落不下去的块 → 在 `patch.mjs` 的 `PATCHES` 里改 `scope`/`anchor`；缺符号的块 → 要么补进
   `pluginHost` 的软引用（列表里加一项），要么改 `needs` 并调整块内容。
4. 改完重跑测试：往返逐字节、语法体检、兜底语义三项全绿再启用。

## 七、与 0.4 版的关系

两份源码各自独立维护：0.4 那份在 `E:\Tools\QQ Agent-0.4.0\plugins\command-gateway\`，
京玉版这份就是本目录。差异只有上面这几处（清单 id/版本、7 个锚点、dispatch 块的软引用、
以及三个插件的 LEGACY_IDS 迁移）—— 功能逻辑一行没改。

⚠️ 已知的小尾巴：`plugins/privacy-mode/patch.mjs` 里还留着**旧版引擎**（PATCH_VERSION 1，
补丁表是空的）。它现在没有任何块要打，所以是死代码、行为与新版一致；哪天隐私模式又需要
核心缝时，把本目录的 patch.mjs 抄过去（改 `MARK`、`PM_PATCH_ROOT`、清空 `PATCHES`）即可。
