# 补丁说明：这个插件改了核心的哪些地方、怎么改的

**先看这段**：「指令前置」不是纯插件（不是"零侵入"）。它必须在**会话诞生之前**拿到消息、
并且能自己发消息，而插件体系的钩子最早也在会话之后、且被禁止发消息发请求。
所以核心要留几处很薄的接入点 —— 本文就是那几处接入点的**完整清单**，
以及它们是怎么被自动打上/摘掉的。

**它现在还是"共享缝"的提供者**：同一个消息入口的拦截位不再让每个插件各自插一块补丁
（隐私模式原来就自己插过一块，那是二次侵入的现场），而是由这里的 `dispatch` 块驱动一条
**拦截链**；模型直连（`ai.ask`）、搜索（`search.web`）、插件数据目录（`api.storage`）等
也一并从这里对外提供。别的插件只声明、不插补丁 —— 见本文 §3 与 README 第 14、15 节。

> 你不需要照本文手工复制代码：插件启用时会自动打、停用时会自动摘（见下一节）。
> 本文的用途是：① 出冲突时知道该看哪几处；② 想手工核对/维护时知道"改了什么、为什么"。

---

## 1. 自动补丁：怎么运作

三件事由 `patch.mjs` 负责（补丁代码本体在 `patches/` 下）：

| 时机 | 动作 |
|---|---|
| 启用插件（含每次软件启动、每次重扫插件） | 检查核心文件；缺哪处就补哪处；已补齐则什么都不做 |
| 停用插件 | 按标记把补丁摘掉，恢复到干净状态 |
| 保存插件文件触发的热重载 | **不摘**（`deactivate` 的 reason 是 `reload`）—— 否则每按一次保存就摘一次再打一次 |

五条硬规矩（第 5 条是 v4 加的）：

1. **标记块**。每一处插入都被 `// ── [[command-gateway:<id>]] … [[/command-gateway:<id>]] ──` 包起来。
   幂等（已在就不重复插）、可检测（一眼看出有没有）、可精确摘除（只删这一段）。
2. **原子**。任何一个锚点找不到或不唯一、或文件处于半打状态（只有一个标记）→
   **一个文件都不写**，状态报 `conflict` 交给人处理。宁可不打，也不留半残。
3. **不吞升级**。停用时先按标记精确摘除；文件被外部改过（上游升级、你自己改过）时
   **不拿旧备份去覆盖它**，只报冲突。备份只在"文件确实还是我们打过的那个版本"时兜底。
4. **改完要重启**。补丁改的是进程已经加载过的文件，本次启动不生效 ——
   设置页顶部会写明「需要重启软件才生效」。
5. **旧版本块原位升级**（v4 起）。插件升级改了某块的内容时，磁盘上的还是旧内容：
   状态识别为 `stale`（标记在、内容对不上），下次启用/启动时按字节跨度摘掉旧块、
   在同一锚点插当前内容 —— 与手工"摘→打"等效，之后同样需要重启。

备份放在同目录的 `backup/`：原文件一份字节级副本 + `manifest.json`（路径、原始哈希、
打完后的哈希、首次备份时间、补丁版本）。备份**只在首次打补丁时生成、之后一直保留**，
冲突时它是唯一的"原件"。

### 状态与手工操作

设置页「指令前置」顶部那一行就是状态：`已打（v1）` / `已摘除` / `有冲突` / `需要重启软件才生效`。
它由插件在启用/停用时写回**本插件自己的配置段**（`config.skills[<本插件的 id>].patch`）。

> 两个名字别混：插件的 **id** 可以带版本号（例如 `command-gateway-1.4.3-Beta`，配置段跟着它走），
> 而核心文件里的 **标记前缀 `command-gateway:` 是固定的** —— 它标记的是"这段代码归本插件的补丁所有"，
> 与插件 id 无关，改 id 不需要重打补丁，老标记照样能认出来、摘干净。
> 反过来，插件代码里**不要写死自己的 id**：`index.js` 用 `setup(api)` 给的 `api.id`，
> 设置页用 `ctx.pluginId`；旧的 id 留在 `LEGACY_IDS` 里，配置会自动迁移过来。

想在命令行看/手工处理（在项目根目录执行）：

```bash
node -e "import('./plugins/command-gateway/patch.mjs').then(m=>console.log(JSON.stringify(m.status(),null,2)))"
node -e "import('./plugins/command-gateway/patch.mjs').then(m=>console.log(JSON.stringify(m.apply(),null,2)))"
node -e "import('./plugins/command-gateway/patch.mjs').then(m=>console.log(JSON.stringify(m.revert(),null,2)))"
node test/command-gateway-passthrough-test.mjs   # 往返测试：摘→打→必须逐字节还原（含旧块原位升级）
```

### 改过界面补丁之后，必须再跑一次"真浏览器"检查

补丁测试只能保证**语法**正确与逐字节还原，抓不到**运行时**错误：真实事故是往侧栏菜单数组里
插了一条 `...pluginSections().map(...)`，在旧版里它是数组最后一项（合法），在新版里后面还跟着
`['tools', '工具与技能']` → JS 解析成成员访问，运行时报 `is not iterable`，
整个设置页白屏，而语法检查全绿。

所以改过 `ui/` 的块之后，用 Electron 真跑一次界面（隐藏窗口 + offscreen 截图即可，
见本目录的验证流程），点开「设置」与「指令前置」两个页面，确认：
`#settings-form` 有内容、左栏出现「指令前置」、那一页里有权限表 / 指令表 / 补丁状态。

报 `conflict` 时的处理顺序：

1. 看状态里的 `detail`（会写明是哪个块、哪个文件）；
2. 用编辑器打开那个文件，搜 `command-gateway:` —— 有标记就说明是半打状态，把标记区间整段删掉即可回到干净；
3. 若标记不在、锚点又对不上（上游把附近代码改写了），说明这段核心代码变了形：
   照本文下面那一处补丁**手工**接上去，或把该段锚点改成新版的那一行。

---

## 2. 改了什么：逐处清单

共 6 个文件、17 处插入。每处的代码原样存在 `patches/<文件>__<块 id>.js`，
`patch.mjs` 里的 `PATCHES` 表记录了"插在哪个锚点的前面还是后面"。

### 2.1 `src/app.js`（2 处）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `dispatch` | 「指令禁言」那段之前 | 消息入口的**薄调用点 + 拦截链入口**：在存档/建会话之前调用 `command.dispatch`；认领即 `return`（不存档、不产生会话），异步执行放进 `run()` fire-and-forget。**v4 起**：`run()` 的返回值可以带 `{ passthrough }` —— `releaseClaimed()` 据此把消息按原文或改写文本放回聊天流程（存档 + 指令禁言检查 + 链接媒体转发 + 触发会话；**不重新过拦截链**，媒体段原样保留，存档用消息原始时间戳）。同时把「插件的指令声明（`commands[]`）与拦截声明（`intercept`）」组成目录，并把核心句柄 `ctx.host` / `ctx.chat` 交出去（服务能力与拦截者要用）。抛错一律吞掉并放行。 |
| `plugin-assets` | 「静态 UI」之前 | 只读路由 `/plugin-assets/<插件id>/<文件>`：让控制台能加载插件目录里的设置页模块（`settings-ui.js`）。插件 id 必须对应已注册插件；逐段拒绝 `..` 与控制字符，拼好后用 `path.relative` 二次确认没跳出该插件目录；`no-cache`。 |

### 2.2 `src/skills/manifest.js`（2 处）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `manifest-fields` | `deprecated` 那行之前（manifest 返回值里） | 让清单多保留四个字段：`commands[]`（指令声明，数组）、`command`（兼容旧写法的第一条）、`intercept`（消息入口拦截声明）、`settingsUi`（自带设置页声明），外加 `exposes[]`（对外公开的能力）。 |
| `manifest-normalizers` | 「提示词片段声明」注释之前 | 归一化函数：`normalizeCommands()` / `normalizeCommand()`（校验能力名、默认词、别名、示例、超时、默认权限等级；写法不合法的**那一条**作废）、`normalizeIntercept()`（拦截声明：能力名 + order）与 `normalizeSettingsUi()`（校验分区 id 与界面文件名，禁止 `..`、绝对路径、盘符）。**v4 起**新增 `normalizePassthrough()`（「执行后放行」声明：`original`/`prefix`/`args` 或 `{ mode, onFail }` → `{ mode, onFail }`，脏值 → `null` = 不放行），并在 `normalizeCommand()` 的返回值里透传 `passthrough` 字段。 |

### 2.3 `src/skills/manager.js`（1 处）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `status-fields` | 「implementedCapabilities」注释之前 | `status()` 视图里多带 `commands` / `command` / `intercept` / `settingsUi` / `exposes`：设置页据此列出指令与覆盖表、挂载插件分区，审计据此区分"公开能力"与孤儿能力。 |

### 2.4 `src/plugin-loader.js`（3 处，新增文件）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `loader-import` | `skills/errors.js` 那行之后 | 引入 `DATA_DIR`（插件数据目录要用数据根）。 |
| `plugin-storage` | 「必须以模块自身位置为锚点」注释之前 | `createPluginStorage(skillId)`：每个插件一个受管目录 `<数据根>/command_data/<插件 id>/`，提供 `read/readJson/write/writeJson/append/list/exists/remove` 与 `dir`；相对路径锁死在自己目录里（拒绝 `..`、绝对路径、盘符），单文件 8MB 上限，写盘用临时文件 + rename。 |
| `loader-api` | 「日志」注释之前 | 把 `storage` 挂进插件 api：`api.storage`（每插件一份，别人碰不到）。 |

### 2.5 `ui/app.js`（8 处）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `state-field` | `settingsSection: 'api',` 之后 | 状态里加 `settingsEntrySeq`：每次点侧栏 +1，插件设置页据此判断"用户新打开了一次"。 |
| `sidebar-menu` | 渲染侧栏的那条语句 `sidebar.innerHTML` **之前**（与菜单里有哪些子页面无关，魔改版删项/加项都不影响；文件候选是 0.3.1 的 `ui/app.js` 与 0.4 的 `ui/app/06-settings-render.js`） | 用 `menu.push(...)` 把"插件自带设置页"的入口追加到菜单末尾（排在固定彩蛋按钮之前）。 |
| `sidebar-click` | `state.settingsSection = el.dataset.section;` 之后 | 进入分区时把 `settingsEntrySeq` 加一。 |
| `render-settings` | `bindSettingsEvents(c);` 之后 | 同步渲染完外壳后，启动插件设置页的挂载。 |
| `render-section` | `const render = sections[sec] …` 之前 | 当前分区是插件分区时，只渲染一个容器（内容由插件模块填）。 |
| `plugin-sections` | `function renderApiSection(c) {` 之前 | 通用机制本体：`pluginSections()`（列出可用的插件分区）、`mountPluginSection()`（动态 `import` 插件模块并挂载）、`unmountPluginSection()`、`makePluginSectionCtx()`（给插件的上下文）。 |
| `save-config` | `saveConfig()` 里 `const patch = {};` 之后 | 当前分区是插件分区时，把"读界面 → 出补丁"交给插件模块的 `read(ctx)`，再写进该插件自己的命名空间。 |
| `plugin-notice` | `snowluma-status` 监听之后 | 接住 `plugin-notice` 事件：插件用 `ui.notify` 能力推来的通知，在右下角浮一个 8 秒后自动消失的框。 |

### 2.6 `electron/main.js`（1 处）

| 块 id | 插在哪 | 做了什么 |
|---|---|---|
| `reload-shortcut` | `Menu.setApplicationMenu(null);` 之后 | 窗口没有应用菜单，`Ctrl+R` / `F5` 默认无效 —— 补上监听，让软件里能重载界面（前端资源是 `no-cache`，重载即拿到新版）。 |

---

## 3. 插件自己的设置页为什么不在核心

界面属于插件，所以它不在 `ui/app.js` 里，而在本目录的 `settings-ui.js`（契约见
[README.md](./README.md)）。核心只提供"插件可以有自己的设置页"这一个通用能力：
清单声明 `settingsUi` → 只读路由把模块送过去 → 设置页动态挂载。

好处很直接：以后再加指令插件、或改设置页长什么样，**都不用碰核心**，
这份补丁清单也不会再变长。

---

## 4. 相关文件

- 补丁引擎：`patch.mjs`；补丁代码：`patches/`；备份与清单：`backup/`
- 对外服务能力：`services.js`（README 第 14 节列了全部能力与参数）
- 决策记录：`docs/adr/0003-command-gateway-core-call-site.md`（薄调用点）、
  `docs/adr/0005-command-gateway-self-patching.md`（自动补丁）、
  `docs/adr/0007-command-declaration-and-shared-seams.md`（声明即生效 + 共享缝）
- 指令插件开发标准：[README.md](./README.md)
