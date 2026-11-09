# 指令插件开发标准（接入「指令前置」）

本目录是「指令前置」插件的全部内容：

- `plugin.json` / `index.js` —— 插件本体（解析、权限、路由、元指令、回执、调用记录）
- `services.js` —— 对外提供的服务能力（ai.ask / search.web / 插件存储…，见第 14 节）
- `builtin-commands.js` / `args.js` —— 自带指令的实现与参数解析（见第 16 节，可直接照抄）
- `settings-ui.js` —— 控制台里本插件的设置页（由核心挂载，样式自带）
- `patch.mjs` / `patches/` / `backup/` —— 核心补丁：启用时打、停用时摘、启动时自愈
- `README.md`（本文件）—— 指令插件的开发标准：交给 AI 照着写新的指令插件
- `UPGRADE.md` —— 补丁说明：改了核心的哪些地方、怎么改的、出冲突怎么办
- `docs/adr/` —— 与这个前置插件有关的决策记录

> **两个读者，两种读法：**
>
> - **人类**：读第 0、1、12、13 节就够 —— 怎么用、怎么验收、出问题查哪里。
> - **AI**：把第 2–11 节当施工规范，逐条照做。字段名、能力名、返回值一律以本文为准；
>   本文没有规定的，不要发明新写法。
>
> 目标：把本文件 + 一句「我要做什么指令」交给 AI，就能产出可直接落地的
> `plugins/<id>/plugin.json` 与 `plugins/<id>/index.js`，不需要追问、不需要猜字段。

---

## 0. 速查（三句话）

| 想知道的 | 答案 |
|---|---|
| 指令怎么配 | 写在你清单的 `commands[]` 里（`word` / `argsHint` / `description` / `permission`…）——**装了就生效**，不需要用户"接入" |
| 用户能改什么 | 「设置 → 指令前置」那张表会把你的声明列出来，用户可以改指令词、别名、权限等级、超时，或停用某一条（改动只存差异） |
| 谁能用 | 触发者等级 **≥** 指令等级才放行；不够就**当普通消息放行**（不回复、不报错） |
| 前置自带什么 | 两个**元指令**：`/帮助`、`/权限查询`。不占接入列表，权限等级单独配 |
| 执行完还能接着聊吗 | 能。清单里声明 `passthrough`（或返回值里写 `passthrough`），指令执行完会把消息按原文/改写后放回聊天流程，见 8.5 |
| 我想少写代码 | 直接调第 14 节的能力：`ai.ask`（问模型）、`search.web`（搜索）、`api.storage`（存数据）… 都不用你 import 核心 |

---

## 1. 给使用者的用法（人类）

把下面这段原样发给 AI，替换最后一行：

```
请先完整读取 plugins/command-gateway/README.md，
严格按里面的「AI 输出要求」和「通用级接入标准」实现一个指令插件。
插件功能：<用一两句话描述，例如：发 /天气 城市名，返回该城市今天的天气>
```

需要联网的插件，再附加 `doc/extend_development/skill-reference.md`（api 全表与权限）；
需要操作 QQ（禁言、撤回、发图）再附加 `doc/extend_development/snowluma-capabilities.md`。

本文件就在「指令前置」插件自己的目录里（`plugins/command-gateway/`），
跟着插件一起分发：以后想加指令插件，让 AI 读这个文件即可。

插件落地后三步启用：

1. 插件页启用「指令前置」，再启用你的指令插件（声明即生效，**不需要**再去"接入"一次）；
2. 想让别人也能用，就去「设置 → 指令前置」的权限表里给他加一行 —— 或者把你这条指令的权限等级调低；
3. 在 QQ 里发 `/指令名 参数`。

> ⚠️ **启用「指令前置」后要重启一次软件**（换新版本也一样）：它需要在核心文件里接一个调用点，
> 而运行中的进程改不动已经加载的代码。设置页顶部那行「核心补丁」会明确写出"需要重启软件才生效"。

> ⚠️ **默认是收紧的**：默认权限 0、没声明权限等级的指令默认等级 1，所以「不配权限表 = 只有权限 ≥1 的人能用」。
> 这是刻意的（敏感的指令不配就没人能用），不是插件坏了 —— 细节见 7.2。

> 🛑 **暂停时指令彻底静默**（京玉版 1.4.3-Beta2.3 起）：机器人被 `/暂停` 之后，**所有指令一律不生效**
> —— 包括 `/帮助` 这类元指令。它们是「被认领但什么都不做」：**不回话、不进存档、不建会话**，
> 恢复处理积压时模型也看不到，彻底像没发生过。
>
> ⚠️ 默认**不豁免任何指令**，所以暂停后在 QQ 里发什么都没反应，**只能去控制台点恢复**。
> 想留个后门就在设置页「暂停时仍可用的指令词」里填「继续」（逗号分隔可填多个）。
>
> 另一个开关：取消勾选「暂停时静默全部指令」→ 回到旧行为（暂停时指令照常可用）。
>
> 拦截类插件（清单里声明了 `intercept` 的）不受影响：它们在指令之前被问，而且本身不发消息。

---

## 2. AI 输出要求（硬性，违反即返工）

1. 输出两个文件的**完整内容**：`plugins/<id>/plugin.json` 和 `plugins/<id>/index.js`。
2. 不许省略、不许用 `// ...` 或「其余同上」代替代码、不许只给 diff。
3. 不许改核心（`src/`）、不许改别的插件、不许 `import` 任何 `src/` 下的模块。
4. **指令信息一律写进 `plugin.json` 的 `commands[]`**（指令词、参数格式、说明、示例、权限等级）——
   不要求另外写 README，人/AI 想知道这插件提供什么，看清单就够。
5. 字段名、能力名、返回值一律以本文为准；本文没有规定的，不要发明新写法。
6. 输出末尾附「自检结果」，逐条回答第 11 节的问题。

---

## 3. 通用级接入标准（S1–S14，必须全部满足）

| 编号 | 标准 | 谁来保证 |
|---|---|---|
| S1 | 命中指令的消息不存档、不建会话、不进模型 | 前置已实现，你不用写 |
| S2 | 未命中 / 权限不够 / 插件异常时，消息照常走聊天流程 | 前置已实现，你不用写 |
| S3 | 权限判定不要自己写、也不要绕过（不读配置文件判断权限） | 前置已实现，你不用写 |
| S4 | 能力名三处一致：`command.capability` = `capabilities[]` 里的项 = `providers` 的键 | **你** |
| S5 | 执行能力必须是 `async` 函数 | **你** |
| S6 | 发消息一律走 `payload.ctx.sender`，不直接调 OneBot | **你** |
| S7 | 指令词以清单声明为准、用户可覆盖；代码不能依赖具体词 | **你** |
| S8 | 参数缺失或非法时，返回可读的用法提示 | **你** |
| S9 | 失败要能看见：抛错，或返回 `{ ok:false, error }`（不能静默 `return`） | **你** |
| S10 | 超过 30 秒的任务，必须在清单里声明 `timeoutMs` | **你** |
| S11 | 不在插件里解析斜杠、不判断前缀、不拦消息（那是前置的职责） | **你** |
| S12 | 指令词不能用元指令的保留词；涉及发奖/签到/写数据要自己判重 | **你** |
| S13 | 指令信息写在 `commands[]` 里：`word` + `argsHint` + `description`（+ 可选的 `aliases`/`examples`/`permission`/`timeoutMs`） | **你** |
| S14 | 声明了指令或拦截的插件，清单里必须写 `"requires": ["command.dispatch"]`（依赖前置的"分发"能力）。前置缺失/停用时会显示「依赖未就绪」，而不是安静地毫无反应 | **你** |

---

## 4. 职责边界：谁做什么

越界是最常见的返工原因，先把边界划清：

| 事情 | 归谁 |
|---|---|
| 去前导引用 / 艾特、认前缀、切出指令词与参数 | 前置 |
| 权限判定（谁能用这条指令）、冷却、同消息去重、同会话串行 | 前置 |
| 超时兜底与失败回执、`/帮助`、`/权限查询` | 前置 |
| 这条指令**具体干什么**、业务参数怎么解析、结果长什么样 | **你** |
| 业务判重（同一个人不能领两次奖）、输入长度与格式校验 | **你** |

---

## 5. 最小可用模板

```json
// plugins/weather-command/plugin.json
{
  "id": "weather-command",
  "name": "天气指令",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "发 /天气 城市名 查询天气。",
  "enabledByDefault": false,
  "capabilities": ["command.weather-command"],
  "requires": ["command.dispatch"],
  "commands": [
    {
      "id": "weather",
      "word": "天气",
      "aliases": ["tq"],
      "capability": "command.weather-command",
      "description": "查询城市天气",
      "argsHint": "[城市名]",
      "examples": ["/天气 珠海"],
      "timeoutMs": 20000,
      "permission": 1
    }
  ],
  "settings": {},
  "configSchema": {}
}
```

```js
// plugins/weather-command/index.js
export const providers = {
  // ⚠️ 必须是 async；同步抛错会被前置的错误隔离吞掉，表现为"静默成功无回复"
  'command.weather-command': async ({ args }) => {
    if (!args) return { text: '用法：/天气 城市名' };
    return { text: `${args}：晴，25℃` };   // 返回文本 → 前置代发
  }
};

export function available() {
  return { ok: true };
}
```

---

## 6. 运行链路

```
QQ 消息
  ↓
核心消息入口（存档 / 建会话之前）→ 调用 command.dispatch
  ↓  仅当「指令前置」已启用
拦截链：清单里声明了 intercept 的插件按 order 依次被问（隐私模式这类想独占通道的排在前面）
  ├─ 谁先返回 { handled:true } 谁独占这条消息（不存档、不建会话），后面的不再被问
  └─ 都没认领 → 继续
  ↓
指令前置自己这一轮：解析（去前导引用/艾特 → 必须以 / 开头 → 取出指令词）
  ├─ 元指令（帮助/help/指令、权限查询/查询权限/perm）→ 过它自己的权限等级 → 执行
  └─ 普通指令 → 在**有效指令表**（插件声明 + 用户覆盖）里按主词与别名找
                 ↓ 找到且触发者等级 ≥ 该指令等级
                 认领并执行
  ↓  命中 + 不在冷却 + 不是重复推送
认领：这条消息不存档、不建会话
  ↓  异步、同会话串行（不阻塞消息热路径）
调用你在清单里声明的能力，传入第 8 节的 payload
  ↓
你的插件执行；要发消息用 payload.ctx.sender
  ↓  （可选）声明/返回了 passthrough —— 见 8.5
执行后放行：这条消息按原文或改写后的文本重新进入聊天流程
（存档 + 触发模型回复；不再过一遍拦截链，媒体段原样保留）
```

任何一步不成立（没命中、权限不够、冷却中、插件没装、插件抛错）都会让这条消息**原样进入聊天流程**，
表现得跟没装这个插件完全一样。

---

## 7. 清单字段与权限

### 7.1 `commands[]`（指令插件必须写）

一个插件可以声明**多条**指令（各用一个能力，或者共用一个能力、靠 `payload.command` 区分）。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | 否 | string | 这条指令的稳定标识（缺省 = `word`）。用户在设置页的改动按 `插件id:id` 存，改词不会丢配置 |
| `word` | **是** | string | 默认指令词（不含前缀）；用户在设置页可改 |
| `aliases` | 否 | string[] | 默认别名，与主词等效；用户可改 |
| `capability` | 否 | string | 执行能力名，必须小写点分；缺省 = `command.<你的插件 id>` |
| `description` | **是** | string | 一句话说明，`/帮助` 里显示 |
| `argsHint` | 否 | string | 参数格式提示，如 `[城市名]`，`/帮助` 里跟在指令词后面 |
| `examples` | 否 | string[] | 示例（最多 5 条），`/帮助` 里显示第一条，其余给人/AI 看 |
| `timeoutMs` | 否 | number | 本指令最长执行时间，1000~600000；不写用前置默认 30000 |
| `permission` | 否 | number | 默认权限等级，0~100000；不写用前置默认 1（0 = 所有人可用） |
| `passthrough` | 否 | string \| object | **执行后放行**：`"original"`（放原文）/ `"prefix"`（去前缀）/ `"args"`（只放参数），或 `{ "mode": "args", "onFail": "release" }`；不写 = 不放行。见 8.5 |

旧写法 `command: { … }`（单条）仍然兼容，会被归一成只有一条的数组。

### 7.1b `exposes[]` / `intercept` / `settingsUi`（进阶，可选）

| 字段 | 说明 |
|---|---|
| `exposes` | 声明"这些能力是给别的插件用的公开 API"，审计脚本不再把它们当成"没人用的孤儿能力"。只写你确实提供的 |
| `intercept` | 想在**消息进入会话之前**先看一眼：`{ "capability": "message.我的能力", "order": 10 }`。由「指令前置」按 order 从小到大问，谁先返回 `{ handled: true }` 谁独占这条消息（`run()` 里做异步工作）；需要"不用 LLM 的拦截器"才用它，普通指令插件不要用 |
| `settingsUi` | 想在控制台设置页多一个分区：`{ "id": "main", "label": "我的插件", "file": "settings-ui.js" }`，模块契约见本文件同目录的 `settings-ui.js` 顶部注释 |

### 7.1c `requires`：声明硬依赖（官方字段）

`requires` 是官方 manifest 字段，一个**能力名数组**，含义是"缺了这些能力，这个插件就没法工作"。
核心用 `isActive()` 递归检查它（`src/skills/manager.js`）：不满足时插件页显示「依赖未就绪」，
并且**不会**调用这个插件的任何 provider / hook。

对声明了 `commands[]`（或 `intercept`）的插件，有一条硬规定：

```json
"requires": ["command.dispatch"]
```

原因：你的指令是由「指令前置」分发的 —— 没有前置，`/你的指令` 这条链路根本不存在，
属于"缺了就没法工作"。写了它，前置没装/没启用时插件页会直接写明「依赖未就绪」，
而不是安静地毫无反应（用户最容易把后者当成"插件坏了"）。

⚠️ `requires` **只认能力名**，不能写插件 id 或插件名字 —— 核心是按能力名查"有没有提供者"。
要依赖别的插件，就写它 `capabilities[]` 里公开的那个能力名。这也是"指定前置"的唯一正确方式：
写能力名，不写插件名。

如果还要调用前置提供的**服务能力**（`ai.ask` / `search.web` / `session.control` …，见 §14）：
缺了就没法工作 → 继续加进 `requires`；缺了只是少个增强 → 用 `api.capability(...)` 软依赖，别写进 `requires`。

### 7.2 权限等级（谁有资格触发）

权限不是「是不是管理员」，而是一把 **0~100000 的整数标尺**：

- **触发者等级**：设置页权限表里写了他的 QQ 就用他那一行，没写就用「默认权限」行的值（初始 0）。
- **指令等级**：每条指令各有一个（清单里的 `commands[].permission` 是默认值，用户可在设置页覆盖）。
- **判定只有一条**：`触发者等级 ≥ 指令等级` 才执行。不够就**不拦截、不回执**，当普通消息放行。

对你的代码意味着两件事：

1. 你**不用写权限判断** —— 能力被调用时门槛已经过了，不该用的人根本到不了你这里。
2. 但你能拿到 `payload.permission`（触发者等级），可以用它做**分级行为**：

```js
'command.echo': async ({ args, permission }) => {
  if (permission < 100) return { text: '这条指令只对有权限的人开放。' };
  return { text: `管理员专属结果：${args}` };
}
```

这是「同一功能内的分级」，不是门槛 —— 门槛请交给用户在设置页配。

### 7.3 元指令（前置自带，不占接入列表）

| 元指令 | 指令词 | 干什么 | 默认等级 |
|---|---|---|---|
| 帮助 | `帮助`、`help`、`指令`；格式 `/帮助 [页码=1]` | 列出**当前这个人**够得着的指令（**`/帮助` 自己也在列表里**），每页 10 条 | 0（人人可用） |
| 权限查询 | `权限查询`、`查询权限`、`perm` | `/权限查询 @某人` 或 `/权限查询 10001`，报出那个人的权限等级 | 1 |

规则：

- 两个元指令的**权限等级都能在设置页改**；等级不够时同样按普通消息放行。
- **指令词是保留词**：普通指令不许用这些词（设置页会拦下），否则永远轮不到它。
- **分页规则**：`/帮助`、`/帮助 0`、`/帮助 1` 都是第一页；页码不是数字、或者超出总页数也回第一页
  （宁可给第一页，也不回一句"没有这一页"）。
- **返回格式**：第一行固定是 `可用指令：`；正文每行一条指令；**最后一行固定写明 `第 X 页 / 共 Y 页`**
  （只有一页时也写）；有多页时倒数第二行给上一页 / 下一页的提示。
- `/权限查询` 的目标按可信度取：消息段里的艾特段 → 正文里的 `@昵称(QQ:123)` → 参数里裸写的 QQ 号。
  认不出目标就回用法提示（不猜）。查的人不在权限表里时，报他**实际生效**的等级并注明「跟随默认权限」。

### 7.4 需要联网时

插件要用 `api.fetch`，必须在清单里声明权限，并在 `setup(api)` 里保存 api：

```json
{ "permissions": ["web_fetch"] }
```

```js
let api = null;
export function setup(skillApi) { api = skillApi; }
```

没有 `web_fetch` 权限时 `api.fetch` 调用即 reject。

### 7.5 硬约束

- `capabilities` 数组必须包含你的执行能力名，`providers` 必须真的实现它（审计会双向检查）。
- 清单文件不能带 UTF-8 BOM。
- 目录名建议与 `id` 一致；不要建 `plugins/shared/` 之类的共享目录（会被当成插件加载）。

### 7.6 指令格式与描述的写法（规范）

`argsHint` 写**格式**，`description` 写**效果**（含使用范围与前置条件）。两者都照下面这套写法，
`/帮助` 才能一眼看懂、用户也不会不知道能填什么：

| 写法 | 含义 | 例子 |
|---|---|---|
| `<必填>` | 必填参数（裸词也当必填） | `<文本>` |
| `[可选]` | 可选参数 | `[城市名]` |
| `[参数=默认值]` | 不写时是什么 | `[时间=30分钟]`、`[面数=6]` |
| `A\|B` | 二选一（枚举） | `[石头\|剪刀\|布]`、`[秒数\|立即\|取消]` |
| `@用户` | 可以 @ 也可以直接给 QQ 号 | `@用户 [时间=30分钟]` |
| `参数...` | 可以重复多个 | `@用户...` |
| 子命令用空格分层 | 一个指令带多个动作 | `/权限查询 设置 [QQ] [等级]` |

另外两条约定：

1. **时间参数统一写 `[时间=30分钟]`**，并接受 `30秒 / 5分钟 / 2小时 / 1天` 这种写法；纯数字按分钟。
2. **使用范围与前置条件写在 `description` 里**，不要塞进 `argsHint`：
   例「（仅群聊；需要机器人是该群管理员）」「（暂停的是模型调用，指令仍然可用）」。
   `/帮助` 只显示描述的第一句，所以第一句要是"这指令干什么"。

参数解析可以照抄本目录的 `args.js`（`pickTarget` 认 @/QQ，`parseDuration` 认时间）。

**拿不准 @ 了谁，就回协议端再问一次** —— `args.js` 的 `resolveMemberName({ qq, chat, ctx })`：
at 段只带 QQ 号，文本里的 `@昵称` 是核心查了群名片渲染出来的，插件侧文本解析可能把
昵称截断（含空格的 "Death's End"）或和参数混在一起（"Team 6 10" 里的 6）。
拿着 at 段的 QQ 调 `get_group_member_info` 拿协议确认的真名（群名片 > 昵称，5 分钟缓存），
再用 `stripTargetArg(args, realName)` 按真名把目标从参数里**精确**剥掉，剩下的才交给
时长等参数解析。查询失败返回 ''，调用方回退到 `pickTarget` 抠出来的名字即可，别让查询失败打断指令。

---

## 8. 执行能力契约

### 8.1 payload 类型（可直接粘贴当 JSDoc）

```js
/**
 * @typedef {object} CommandContext
 * @property {string} kind        会话类型，当前是 'group' | 'private'（开放字符串：以后新增的渠道会直接透传，别写死只有两种）
 * @property {string} chatId      群号或 QQ 号
 * @property {string} chatKey     形如 'group:123' / 'private:456'
 * @property {object} onebot      OneBot 客户端（查询类接口）
 * @property {object} sender      发送队列（发消息**只能**用它）
 * @property {object} store       消息存档
 * @property {object} memory      长期记忆
 * @property {Function} log
 * @property {Function} emit
 */

/**
 * @typedef {object} CommandPayload
 * @property {string} command      实际命中的指令词（用户可能改过）
 * @property {string} prefix       当前前缀，默认 '/'
 * @property {string[]} aliases    这条指令支持的全部指令词（含主词）
 * @property {string} args         指令名之后的原始参数文本（保留空格与换行，可能为空串）
 * @property {string[]} parts      args 按空白切开的数组；无参数时是 []
 * @property {string} raw          **剥离前**的完整消息文本（含 [引用 …]、@昵称）
 * @property {string} rawMessage   协议端最原始的 CQ 字符串
 * @property {Array|null} segments 原始消息段数组
 * @property {{messageId:string,senderName:string,text:string}|null} reply 被引用消息
 * @property {{qq:string,name:string}[]} ats 被艾特的人
 * @property {number} permission   触发者的权限等级（0~100000）；门槛已过，这里是给你做分级用的
 * @property {{kind:string,chatId:string,chatKey:string}} chat
 * @property {{id:string,name:string}} from
 * @property {CommandContext} ctx
 */
```

### 8.2 字段说明

| 字段 | 一定有值？ | 说明 |
|---|---|---|
| `args` | 是（可能为空串） | 想自己精确解析参数（引号、多词、子命令）就用它；保留原始空格与换行 |
| `parts` | 是（可能是 `[]`） | 想省事就用它，等价于 `args.split(/\s+/)` |
| `raw` | 是 | **剥离前**的完整文本；解析出问题时可以自己回退重解析 |
| `rawMessage` / `segments` | 看协议端 | 最原始的 CQ 串 / 消息段；同样是保险字段 |
| `reply` | 否，可能是 `null` | 只在消息确实引用了某条消息时非空，用前判空 |
| `ats` | 是（可能是 `[]`） | `name` 可能是空串；只有 `qq` 保证可信 |
| `from.id` | 是 | 触发者的 **QQ 号**（字符串） |
| `from.name` | 可能是空串 | 触发者显示名：群名片 > 昵称 > QQ 号 |
| `chat.kind` | 是 | **消息渠道**：`'group'`（群聊）/ `'private'`（私聊）；以后新增渠道会透传新值 |
| `chat.chatId` | 是 | 群号或对方 QQ 号 |
| `chat.chatKey` | 是 | 会话主键 `'group:123'` / `'private:456'`；发消息、判「是不是同一个会话」都用它 |
| `permission` | 是 | 触发者权限等级。**门槛已在调用你之前判完**，这里只适合做分级行为 |

### 8.3 返回值约定

| 你返回 | 前置的行为 |
|---|---|
| 非空字符串 | 代发这段文本 |
| `{ text: '...' }` | 代发 `text` |
| `{ ok: false, error: '给用户看的原因' }` | 代发「指令 X 执行失败：<你写的 error>」并写日志 |
| `{ passthrough: true }` | 回执照常（`text` 有就发），执行完**按消息原文放行**（见 8.5） |
| `{ passthrough: '改写后的文本' }` | 同上，但放行的是**这段文本**（修改后再进会话） |
| `{ passthrough: false }` | 明确不放行 —— 清单里声明了也以这里为准 |
| `undefined` / `null` / 其它 | 认为你自己已经发过了，不再代发 |

> ⚠️ `{ ok:false, error }` 里的 `error` **会发到群里**（它是你写给用户看的一句话）。
> 想脱敏就直接抛错：抛出的异常文本只进日志与调用记录，群里只会看到固定文案。

不要既自己发送、又返回文本 —— 那样会发两条。

### 8.4 发消息

```js
// 文本（可带引用与 @）：走队列、限频、去重、留档
await ctx.sender.sendTextBatch(chat.chatKey, ['第一段', '第二段'], {
  replyToMessageId: undefined,   // 需要引用时填消息 id
  atUserId: undefined            // 需要 @ 时填 QQ 号（不能是 all）
});

// 图片 / 文件：见 doc/extend_development/skill-reference.md 的 ctx.sender 小节
await ctx.sender.sendMedia(chat.chatKey, [{ type: 'image', data: { file: '/abs/x.png' } }], { label: '[图片]' });
```

**不要**直接调 `onebot.sendSegments` / `sendGroupMsg`：会跳过串行、限频、去重与留档。
发送的纯文本会被核心统一转义 CQ 码（`[CQ:` → `[CQ：`），所以想 @ 人只能用 `atUserId`。

### 8.5 执行后放行（passthrough）—— 指令执行完，让会话接着聊

默认情况下，被指令认领的消息「不存档、不建会话」，执行完就结束了。
「执行后放行」让你把这条消息**放回正常聊天流程**：存档、触发模型回复 ——
就像它没被认领过一样；也可以放一段**改写后的文本**，让模型看到你想让它看到的内容。

**典型场景**

- `/人设 小雪`：指令插件切换人设并回执「已切换」，然后放行原文 ——
  模型看到这条消息，自然地顺着聊起来，而不是切换完就冷场；
- `/翻译 这段话…`：插件把翻译结果发出去，再放行改写后的
  `请基于以下翻译继续对话：…` —— 模型拿到结构化的上下文；
- `/记录 今天完成了 X`：插件写完数据，放行 `args`（只放参数）——
  模型看到「今天完成了 X」，像普通聊天一样回应，看不到指令词。

**两个口子，优先级：返回值 > 清单声明 > 不放行**

1. **清单声明**（默认行为，写在 `commands[]` 里）：

   ```json
   "passthrough": "args"
   ```

   或对象写法（多一个失败策略）：

   ```json
   "passthrough": { "mode": "args", "onFail": "release" }
   ```

   | mode | 模型看到的（以 `/天气 珠海` 为例） | 说明 |
   |---|---|---|
   | `"original"` | `/天气 珠海` | 按原文放行，保留指令上下文 |
   | `"prefix"` | `天气 珠海` | 去掉前缀，指令词保留 |
   | `"args"` | `珠海` | 只放参数 ——「指令是修饰、参数才是本体」的场景 |

   `onFail`：指令执行失败（抛错 / 超时 / 返回 `ok:false`）时还放不放。
   缺省 `"skip"` = **失败不放行**（安全默认：模型不会看到一条执行失败的指令原文然后莫名接话）；
   `"release"` = 失败也放。没参数时 `args` 档没有东西可放，等价于不放行。

2. **返回值**（运行时决定，一次一变）：

   ```js
   // 回执 + 按清单声明的档位放行（没声明就放原文）
   return { text: '已切换人设「小雪」', passthrough: true };

   // 回执 + 修改后再放行 —— 模型看到的是你给的这段文本
   return { text: '已记录', passthrough: '我刚刚用 /记录 存了一条：今天完成了 X' };

   // 这次不放行（清单声明了对也不放）
   return { text: '参数不全，没有继续', passthrough: false };
   ```

   返回值里**写了** `passthrough` 就听返回值的（包括 `ok:false` 的返回）；
   没写才回落到清单声明。`true` = 按声明档放原文（没声明 = 原文）；
   字符串 = 直接用这段文本；空字符串/`false` = 不放。

**放行的行为细节**（都不用你操心，核心统一做）

- 存档用消息**原始时间戳**：你的回执先入档、用户这条消息按真实时间补进去，历史顺序不会乱；
- 原消息的**媒体段原样保留**（`/看图 描述一下` 配图时，模型拿得到图）；
- 群聊的指令禁言检查、链接媒体转发等常规动作照常执行；
- 放行**不会重新过拦截链**（不会触发二次认领/死循环）；
- 模型触发走正常响应档位逻辑 —— 放了行不保证模型一定回，档位说静默就静默。

---

## 9. 安全、错误与幂等

1. **发到群里的文字要能见人**：内部错误（含 Key、路径、堆栈）只走 `ctx.log`。抛错即可脱敏，见 8.3。
2. **不要记录敏感参数**：`ctx.log` 里不要打印 Key、Cookie、完整用户输入。
3. **超时不会中断你的代码**：前置超时后立刻回执失败并停止等待，但你的 Promise 仍在跑；超时后不要再发消息，否则会出现「失败回执 + 迟到结果」两条。
4. **尽量幂等**：前置已做「同消息 id 去重 + 同会话冷却 + 同会话串行」，但发奖、签到、写数据这类指令仍要自己判重。
5. **不要信任 `args`**：可能包含任意文本、CQ 码、超长内容、换行；做长度上限与格式校验。

---

## 10. 完整示例（联网 + 引用 + 自己发送）

```json
{
  "id": "weather-command",
  "name": "天气指令",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "发 /天气 城市名 查询实时天气；也可以引用或 @ 一个人来查他所在的城市。",
  "enabledByDefault": false,
  "capabilities": ["command.weather-command"],
  "requires": ["command.dispatch"],
  "permissions": ["web_fetch"],
  "commands": [
    {
      "id": "weather",
      "word": "天气",
      "capability": "command.weather-command",
      "description": "查询城市实时天气",
      "argsHint": "[城市名]",
      "examples": ["/天气 珠海", "/天气 珠海 明天"],
      "timeoutMs": 15000
    }
  ],
  "settings": {},
  "configSchema": {}
}
```

```js
let api = null;

export function setup(skillApi) {
  api = skillApi;
}

export const providers = {
  'command.weather-command': async ({ args, reply, ats, chat, ctx }) => {
    const city = String(args || '').trim()
      || String(reply?.senderName || '').trim()
      || String(ats?.[0]?.name || '').trim();
    if (!city) return { text: '用法：/天气 城市名，或引用/艾特一个人。' };

    const url = `https://wttr.in/${encodeURIComponent(city)}?format=3&lang=zh`;
    const res = await api.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`天气接口返回 HTTP ${res.status}`);   // 抛错 → 群里只看固定文案
    const text = (await res.text()).trim();
    if (!text) throw new Error('天气接口没有返回内容');

    // 自己发送：此时应当不返回文本，否则会发两条
    await ctx.sender.sendTextBatch(chat.chatKey, [text]);
    return undefined;
  }
};

export function available() {
  return { ok: true };
}
```

---

## 11. AI 自检清单（输出末尾逐条回答）

1. 能力名是否三处一致（`commands[].capability` / `capabilities[]` / `providers` 的键）？
2. 执行能力是否是 `async` 函数？
3. 是否只用了 payload 与 `ctx.sender`，没有 import 核心、没有直接调 OneBot？
4. 参数缺失时是否返回了可读的用法提示？
5. 失败路径是否抛错或返回 `{ ok:false, error }`（而不是静默 `return`）？
6. 要发给群里的错误文案，是否自己看过一遍（不含内部细节）？
7. 超过 30 秒的步骤是否在清单里声明了 `timeoutMs`？
8. 需要联网时是否声明了 `permissions: ["web_fetch"]` 并在 `setup` 里保存了 api？
9. 指令信息是否都写进了 `commands[]`（`word` / `argsHint` / `description`），代码不依赖具体指令词，且没用元指令保留词？
10. 是否既自己发送、又返回了文本（会变成两条）？
11. 涉及发奖/签到/写数据的指令，是否自己判了重？
12. 清单 JSON 是否合法、不带 BOM，且不需要 `settings`/`configSchema` 时不乱加字段？
13. 要问模型 / 搜索 / 存数据时，是否用了第 14、15 节的能力（`ai.ask` / `search.web` / `api.storage`），而不是自己 import 核心或重造轮子？
14. 清单里是否写了 `"requires": ["command.dispatch"]`（声明了指令或拦截的插件都必须写；写了才能在缺前置时显示「依赖未就绪」）？

---

## 12. 验收测试（人类照着发消息即可）

| 发送内容 | 期望结果 |
|---|---|
| `/指令名` 不带参数 | 返回用法提示，不报错 |
| `/指令名 参数` | 正常执行并回复 |
| `/指令名`（权限不够的人发） | 没有任何指令回复；消息照常进入聊天流程 |
| `/帮助` | 列出**当前这个人**有权使用的指令（每页 10 条），**含 `/帮助` 自己**；最后一行是 `第 1 页 / 共 2 页` |
| `/帮助 2` / `/帮助 0` | 翻页 / 回到第一页；页码非法或超出总页数也是第一页 |
| `/权限查询 @某人` 或 `/权限查询 10001` | 报出那个人的权限等级；不在表里则报默认等级的数值并注明「跟随默认权限」 |
| `/权限查询` 不带目标 | 回用法提示 |
| 连点两次同一指令 | 第二次被冷却静默忽略（默认 3 秒） |
| 指令执行超过声明超时 | 回执「执行失败，详情见设置页调用记录」 |
| 停用对应插件后再发指令 | 回执「当前不可用：对应的插件未启用或已卸载」 |

---

## 13. 常见失败对照表

| 现象 | 原因 | 修法 |
|---|---|---|
| 发指令完全没反应 | 「指令前置」没启用，或**你自己的插件**被关着（声明即生效：插件没开，能力就不可用） | 插件页把「指令前置」和你的插件都启用 |
| 装好了却发不出反应 | 默认权限 0 < 该指令的默认等级 1（默认收紧） | 在权限表里给发送者加一行，或把这条指令的权限等级改成 0 |
| 只有自己能触发 | 这条指令的权限等级比别人的权限高 | 到设置页「权限」表里给对应 QQ 加行、或调低该指令的权限等级 |
| `/帮助` 里看不到该指令 | 插件被停用、清单里 `word` 为空、这条被用户在覆盖表里停用、或看的人权限等级不够 | 检查清单声明与设置页那张表 |
| `/权限查询` 没反应 | 这个人的权限低于元指令的等级（默认 1） | 设置页「元指令」里调低它的等级，或给这个人加权限行 |
| 提示「当前不可用：对应插件未启用或已卸载」 | 子插件被关闭 / 目录被删 | 启用或重新安装该插件 |
| 指令永远匹配不上 | 主指令词含空格；前缀含空格；前缀被改过 | 设置页会拦下含空格的指令词与前缀；改前缀后要用新前缀 |
| 指令词保存不上并出现红字 | 指令词重复、含空格、用了元指令保留词、或填了别名没填主词 | 按提示改（保留词：帮助/help/指令/权限查询/查询权限/perm） |
| 提示执行失败但不知道原因 | 回执刻意脱敏 | 到「设置 → 指令前置 → 最近调用」看错误详情 |
| 连点两次只生效一次 | 冷却机制 | 正常行为；设置页可把冷却改为 0 |
| 超时后又冒出一条结果 | 你的代码没有尊重超时 | 超时后不要再发送；把耗时步骤加超时或异步化 |
| 群里出现两条一样的回复 | 既自己发送、又返回了文本 | 二选一：自己发就 `return undefined` |
| 想限制指令只在某些群生效 | 前置**暂不提供**群范围配置（刻意不做，避免配置层数膨胀） | 在插件里用 `payload.chat.chatId` 自己判断；不在允许范围就 `return undefined` |
| 审计报「孤儿能力」 | 能力没被清单里的 `commands[].capability` 声明覆盖 | 在 `commands[]` 里写上该能力名；如果它是给别的插件用的公开 API，同时写进 `exposes[]` |

---

## 14. 可直接调用的能力（服务）

这些是「指令前置」对外提供的**共享能力**——它们是给插件作者省事的：不用自己 import 核心、
不用自己打补丁、也不用各自重造一份搜索/画图/下载/统计。

用法（二选一）：

```js
// 软依赖：有就用、没有就降级（推荐）
const r = await api.capability('search.web', { query: '珠海 天气', count: 3 });
if (r?.ok) return { text: r.results.map((x) => x.title).join('\n') };

// 硬依赖：没有就判定"依赖未就绪"（插件页会直接写出来）
// plugin.json: "requires": ["search.web"]
```

| 能力 | 参数 | 返回 | 典型指令 |
|---|---|---|---|
| `ai.ask` | `{ prompt }` 或 `{ messages }`，可选 `system` / `temperature` / `maxTokens` | `{ ok, text, model, usage }` | `/AI 问题`、`/翻译`、`/总结` |
| `search.web` | `{ query, count? }` | `{ ok, query, results:[{title,url,snippet}] }` | `/AI搜索 关键词`（搜完再交给 `ai.ask` 归纳） |
| `session.control` | `{ action:'clear'\\|'pause'\\|'resume'\\|'status', chatKey?, reason? }` | `{ ok, ... }` | `/清空上下文`、`/暂停 30分钟` |
| `schedule.cron` | `{ action:'add'\\|'list'\\|'remove', chatKey?, text?, at?, id? }` | `{ ok, item?/items? }` | `/提醒 明天9点 交作业`、`/每日播报 8:00` |
| `sticker.pick` | `{ query?, limit?, random? }` | `{ ok, sticker:{id,url,desc} }` | `/随机表情`、`/搜表情 猫` |
| `moderation.check` | `{ text }` | `{ ok, hits:[{type,pattern,match}] }` | `/审核一下 <文字>`、发奖前的自检 |
| `persona.apply` | `{ name }` | `{ ok, name, id, source }`（找不到给 `{ ok:false, names }`） | `/人设 温柔 少女`（名字可含空格） |

**只有这 7 个是"必须由前置提供"的**（官方没给指令插件这些口子）。剩下的常用能力都在 `payload.ctx` 里，直接用，别绕：

| 官方已给 | 用它做什么 | 例 |
|---|---|---|
| `ctx.store.recent(chatKey, { limit, offset, includeSelf })` | 读这个会话最近的聊天记录（回顾、总结、导出都由你自己格式化） | `/总结本群` |
| `ctx.onebot.call(action, params)` | 协议端全部接口（走设置里的 HTTP 地址）：禁言、全员禁言、踢人、撤回… | `ctx.onebot.call('set_group_ban', { group_id, user_id, duration: 600 })` |
| `ctx.sender.sendTextBatch(...)` / `sendMedia(...)` | 发消息/发图（带队列、限频、去重、留档）——**发消息只能走它** | `/发送`、`/撤回` 之后的回执 |
| `ctx.memory` | 长期记忆 | `/记住 xxx` |
| `ctx.emit('plugin-notice', { text, level })` | 往控制台推一条通知（右下角浮框，8 秒消失） | 插件跑完长任务后提醒 |
| `ctx.from` / `ctx.chat` / `payload.reply` / `payload.ats` | 谁发的、在哪个会话、引用了谁、艾特了谁 | `/禁言 @用户` 的取参 |

规则：

- 全是 `async`；**参数不对会抛错**，"这个能力现在用不了"会返回 `{ ok:false, error }`（比如表情库是空的）。
- `ai.ask` 走的是核心的模型链路（账号池、重试、降级、thinking 适配、计费），而且**默认不留痕**：
  不建会话、不存档、不进记忆。要留痕请自己用 `ctx.store` / `api.storage` 落盘。
- `moderation.check` 的规则来自「设置 → 指令前置 → 内容检查」（关键词 + 正则）。
- 这些能力由**指令前置**提供，所以它没启用时全都拿不到 —— 这也是 `requires` 会显示"依赖未就绪"的原因。

**另外，这些能力早就存在**（由别的插件提供），你同样可以直接用，不必重造：

| 能力 | 提供方 | 干什么 |
|---|---|---|
| `image.generate` | image-generate | 用当前配置生成图片（`/画图 一只猫`） |
| `image.random` | random-image | 随机图片 |
| `media.download` | media-download | 下载视频/图片（`/下载 <链接>`） |
| `media.transcribe` | speech-to-text | 语音转文字（`/转写`，引用一条语音） |
| `memory.search` / `memory.archive` / `memory.status` | conversation-memory | 长期记忆的检索与状态（**官方注入点**，核心自己会问它） |
| `chat.ban-state` | ban-state | 群禁言状态（**官方注入点**） |
| `llm.request-params` / `llm.response` / `llm.usage` / `llm.retry-advisor` | thinking-adapters 等 | 改写模型请求/响应（**官方注入点**，别自己再造一套） |
| `tool.guard` | reply-safety | 工具调用守卫（**官方注入点**） |
| `message.owner-check` / `message.inline-at-normalize` | owner-identity / speaker-identity | 主人判断、@ 规范化（**官方注入点**） |
| `message.owner-check` | owner-identity | 判断是不是主人 |
| `sticker.annotate` | sticker-annotate | 表情标注 |
| `video.frames` | video-frames | 视频抽帧 |

## 15. 插件自己的数据目录（`api.storage`）

要给插件存一点长期数据（签到记录、抽奖名单、统计），**不要自己拼路径**：

```js
export function setup(api) {
  const state = api.storage.readJson('state.json', { signIns: [] });
  state.signIns.push(payload.from.id);
  api.storage.writeJson('state.json', state);
}
```

| 方法 | 说明 |
|---|---|
| `api.storage.dir` | 这个插件的数据目录（绝对路径）；想用别的库直接读写文件时用它 |
| `read(rel, fallback?)` / `readJson(rel, fallback?)` | 读文本 / 读 JSON；读不到返回 `fallback`，不抛错 |
| `write(rel, text)` / `writeJson(rel, value)` | 原子写（临时文件 + rename），单文件上限 8MB |
| `append(rel, text)` | 追加 |
| `list(rel?)` | 列目录：`{ name, dir, size, mtime }[]` |
| `exists(rel)` / `remove(rel)` | 存在 / 删除（目录递归删） |

路径规则：只能写**相对路径**，且锁死在自己的目录里（`..`、绝对路径、盘符一律拒绝）。
目录实际位置是 `<数据根>/command_data/<插件 id>/`（数据根默认 `data/`，测试与多实例 profile 会各用各的）。

---

## 16. 前置自带的 8 条指令（也是范本）

它们由「指令前置」自己声明（写在自己的 `plugin.json` 的 `commands[]` 里）、自己实现，装上前置就有。
实现代码在 `builtin-commands.js`，参数解析在 `args.js` —— 写自己的指令时可以直接照抄这两份。

| 指令 | 格式 | 说明 | 默认权限等级 |
|---|---|---|---|
| 禁言 | `/禁言 @用户 [时间=30分钟]` | 群内禁言；纯数字按分钟，也接 `30秒/5分钟/2小时/1天`；仅群聊，需要机器人是群管理员 | 100000 |
| 解禁 | `/解禁 @用户` | 解除禁言；仅群聊 | 100000 |
| 全体禁言 | `/全体禁言` | 开全员禁言；仅群聊 | 100000 |
| 全体解禁 | `/全体解禁` | 关全员禁言；仅群聊 | 100000 |
| 暂停 | `/暂停` | 全局暂停**模型调用**：不再用模型回复，指令照常可用，正在跑的那一轮不打断 | 100000 |
| 继续 | `/继续 [丢弃积压]` | 恢复模型调用；默认处理暂停期间的积压（与控制台一致），写「丢弃积压」就丢掉 | 100000 |
| 抛骰子 | `/抛骰子 [面数=6]` | 随机掷骰子 | 0 |
| 猜拳 | `/猜拳 [石头\|剪刀\|布]` | 不写参数就让它自己出，写了就分胜负 | 0 |

这几条的指令词是**保留词**，别的插件不能用（前置自己那几行不受限，用户可以给它们改名）。

---

## 相关文档

- [plugin-development.md](../../doc/extend_development/plugin-development.md) —— 确定性型插件主文档（能力、钩子、生命周期、发送纪律）
- [skill-reference.md](../../doc/extend_development/skill-reference.md) —— 共同机制完整参考（api 全表、ctx 全量字段、硬约束）
- [snowluma-capabilities.md](../../doc/extend_development/snowluma-capabilities.md) —— OneBot 接口参数表
