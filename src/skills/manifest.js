// Skill Manifest 规范化与校验。
//
// 加载单元统称 Skill，按**语义**分两型（见下面的 DIR_KIND）：
//   确定性型（plugins/）—— 核心通过**能力名**取用，满足条件必然执行，不经过 LLM
//   LLM 型（skills/）  —— 注册**工具**进模型的 function 列表，由模型决定何时调用
// 两型走同一条 normalizeManifest，字段与扩展点完全等价；"通过能力名依赖而不是
// 硬编码 Skill 名字"这一点对两型都成立 —— 替换实现不需要改核心代码。
//
// manifest 字段：
//   id                  唯一标识（目录名不一致时以 manifest 为准）
//   name                显示名
//   version             语义化版本
//   apiVersion          Skill API 版本（当前 1）
//   enabledByDefault    默认开关（用户没配置过时用这个）
//   category            model | message | knowledge | media | utility
//   description         一句话说明（UI 展示）
//   requires            依赖的能力名数组（如 ['web.fetch']）
//   capabilities        本 Skill 提供的能力名数组
//   configSchema        配置项声明（UI 据此渲染表单）
//   settings            该 Skill 的默认配置值
//   prompt              提示词片段声明（见 promptSections）
//   deprecated          标记为过期的 Skill（仍可加载，UI 提示）

export const SKILL_API_VERSION = 1;

/**
 * 两型的目录语义（本项目唯一约定）：
 *
 *   plugins/  确定性型（kind = 'plugin'）
 *             提供**能力**（providers）或**钩子**（hooks）。核心代码按能力名取用，
 *             满足条件就一定被执行 —— 不经过 LLM，模型想忽略也忽略不掉。
 *
 *   skills/   LLM 型（kind = 'skill'）
 *             注册**工具**（registerTool）+ 提示词片段。工具进模型的 function 列表，
 *             用不用、什么时候用由模型自己判断。
 *
 * ⚠️ 这只是**语义归类**，不是能力限制：两种清单文件（plugin.json / skill.json）
 * 走同一条 normalizeManifest，功能完全等价。
 */
export const DIR_KIND = { plugins: 'plugin', skills: 'skill' };
export const KIND_LABEL = { plugin: '确定性型', skill: 'LLM 型' };

/** 由目录路径推断类型；目录名不认识（测试用自定义根）时返回 null = 不判定。 */
export function kindOfDir(dirPath) {
  const base = String(dirPath ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return DIR_KIND[String(base || '').toLowerCase()] || null;
}

const VALID_CATEGORIES = new Set(['model', 'message', 'knowledge', 'media', 'utility']);

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function cleanString(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/**
 * 规范化 manifest：补默认值、去重、筛掉非法项。
 * 不做"必须合法否则抛错"的强校验 —— 单个 Skill 写错 manifest 不应该拖垮整个启动，
 * 由调用方根据返回的 problems 决定是警告还是拒绝加载。
 */
export function normalizeManifest(raw, { fallbackId = '' } = {}) {
  const problems = [];
  if (!raw || typeof raw !== 'object') {
    return { manifest: null, problems: ['manifest 不是对象'] };
  }

  const id = cleanString(raw.id, fallbackId);
  if (!id) problems.push('缺少 id');
  if (id && !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    problems.push(`id 只能包含字母/数字/._-（当前：${id}）`);
  }

  const name = cleanString(raw.name, id || '未命名 Skill');
  const version = cleanString(raw.version, '0.0.0');
  const apiVersion = Number(raw.apiVersion) || SKILL_API_VERSION;
  if (apiVersion > SKILL_API_VERSION) {
    problems.push(`apiVersion ${apiVersion} 高于当前支持的 ${SKILL_API_VERSION}`);
  }

  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : 'utility';
  if (raw.category && !VALID_CATEGORIES.has(raw.category)) {
    problems.push(`category 非法（${raw.category}），已回退为 utility`);
  }

  const capabilities = [...new Set(asArray(raw.capabilities))];
  const requires = [...new Set(asArray(raw.requires))];

  // 自依赖是配置错误，去掉它而不是让可用性检查永远失败
  const selfDep = requires.filter((r) => capabilities.includes(r));
  const requiresClean = requires.filter((r) => !capabilities.includes(r));

  // ── [[command-gateway:manifest-locals]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 指令声明（新写法 commands[]，旧写法 command{} 也认）
  const commands = normalizeCommands(raw, id);
  // ── [[/command-gateway:manifest-locals]] ──

  return {
    manifest: {
      id,
      name,
      version,
      apiVersion,
      enabledByDefault: raw.enabledByDefault !== false,
      category,
      description: cleanString(raw.description, ''),
      author: cleanString(raw.author, ''),
      requires: requiresClean,
      capabilities,
      configSchema: (raw.configSchema && typeof raw.configSchema === 'object') ? raw.configSchema : {},
      settings: (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) ? raw.settings : {},
      prompt: normalizePrompt(raw.prompt),
      // ── [[command-gateway:manifest-fields]] 「指令前置」插件自动维护，不要手改这一段 ──
      commands,
      // 兼容旧写法：只认第一条（新代码请用 commands）
      command: commands[0] || null,
      // ⚠️ 2026-09-24 核心更新：`intercept` 与 `settingsUi` 已由核心在下面自己归一化
      // （见 normalizeManifest 的 settingsUi / intercept 两行）。这里再写一遍会在
      // 同一个对象字面量里出现重复键，且本块插得更靠前 → 反而被核心的覆盖掉，纯属噪音，故删。
      // 对外公开的能力（给别的插件当 API 用）：0.3.1 的核心自带这一行，0.4.0 的核心没有，
      // 用展开补上 —— 审计据此区分"公开能力"与孤儿能力（见 README §7.1b）。
      ...(Array.isArray(raw.exposes)
        ? { exposes: asArray(raw.exposes).map((x) => String(x).trim()).filter((x) => x && capabilities.includes(x)) }
        : {}),
      // ── [[/command-gateway:manifest-fields]] ──
      deprecated: raw.deprecated === true
    },
    problems
  };
}

/** 提示词片段声明：一律带 priority，且强制低于核心安全规则（100）。 */

// ── [[command-gateway:manifest-normalizers]] 「指令前置」插件自动维护，不要手改这一段 ──
/**
 * 指令声明：告诉「指令前置」本插件提供哪些指令。
 *
 *   commands: [{
 *     id: 'weather',                   // 稳定标识（缺省 = word）；用户在设置页改词不影响它
 *     word: '天气',                     // 默认指令词（不含前缀）
 *     aliases: ['tq'],                 // 默认别名（可省略）
 *     capability: 'command.weather',   // 执行能力名；缺省 = command.<本插件 id>
 *     description: '查询城市天气',       // 帮助列表里的一句话
 *     argsHint: '[城市名]',             // 参数格式提示
 *     examples: ['/天气 珠海'],         // 示例（给人/AI 看）
 *     permission: 100,                 // 默认权限等级；缺省由前置用 1
 *     timeoutMs: 120000,               // 最长执行时间；缺省由前置用 30s
 *     passthrough: 'args'              // 执行后放行：original/prefix/args（缺省不放行，详见 8.3）
 *   }]
 *
 * 旧写法 `command: {…}`（单条）继续兼容，会被归一成只有一条的数组。
 * 能力名必须符合「小写点分」格式；写法不合法的**那一条**作废（不返回），
 * 而不是让整份清单失效 —— 一个插件多声明几条时，坏一条不该拖垮其它条。
 */
function normalizeCommands(raw, id) {
  const list = Array.isArray(raw?.commands)
    ? raw.commands
    : (raw?.command && typeof raw.command === 'object' && !Array.isArray(raw.command) ? [raw.command] : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const one = normalizeCommand(item, id);
    if (!one) continue;
    if (seen.has(one.id)) continue;      // 同 id 只留第一条
    seen.add(one.id);
    out.push(one);
  }
  return out;
}

const CAPABILITY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

function normalizeCommand(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const capability = cleanString(raw.capability, id ? `command.${id}` : '');
  if (!capability || !CAPABILITY_RE.test(capability)) return null;
  const word = cleanString(raw.word, '');
  const timeoutMs = Number(raw.timeoutMs);
  const permission = Number(raw.permission);
  return {
    id: cleanString(raw.id, word) || capability,
    word,
    aliases: [...new Set(asArray(raw.aliases).map((x) => String(x).trim()).filter(Boolean))],
    capability,
    description: cleanString(raw.description, ''),
    argsHint: cleanString(raw.argsHint, ''),
    examples: asArray(raw.examples).map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    // 「执行后放行」声明（v4）：original/prefix/args 或 { mode, onFail } → 归一化；脏值 → null = 不放行
    passthrough: normalizePassthrough(raw.passthrough),
    // 0 = 没声明，由「指令前置」用自己的默认值（30 秒）
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000
      ? Math.min(600000, Math.round(timeoutMs))
      : 0,
    // 默认权限等级；null = 没声明，由「指令前置」用 1（0 是有效等级：所有人可用）
    permission: Number.isFinite(permission) && permission >= 0
      ? Math.min(100000, Math.round(permission))
      : null
  };
}

/**
 * 「执行后放行」声明（README 8.3 节）：指令执行完后把这条消息放回正常聊天流程。
 *   passthrough: "original" | "prefix" | "args" 或 { mode, onFail }
 * original = 按原文放行；prefix = 去前缀（模型看到「天气 珠海」）；args = 去指令词（模型看到「珠海」）。
 * onFail: "release" = 执行失败也放行；缺省 "skip" = 失败不放行。整体缺省 = null = 不放行。
 */
function normalizePassthrough(raw) {
  const obj = typeof raw === 'string'
    ? { mode: raw }
    : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  const mode = String(obj?.mode ?? '').trim().toLowerCase();
  if (!['original', 'prefix', 'args'].includes(mode)) return null;
  const onFail = String(obj?.onFail ?? '').trim().toLowerCase() === 'release' ? 'release' : 'skip';
  return { mode, onFail };
}

// ⚠️ 2026-09-24 核心更新：manifest.js 自带 normalizeIntercept() / normalizeSettingsUi()。
// 本块若再声明同名函数，整个模块会以 "Identifier '…' has already been declared" 解析失败
// （ESM 顶层重复声明是语法错误），核心直接起不来。这两个归一化器因此改由核心提供
// （形状同为 { capability, order } / { id, label, file }，默认值略有不同：
//   核心 order 缺省 0、settingsUi.file 必填；本插件清单两处都显式声明，不受影响）。
// 本块只保留核心还没有的：commands / command / passthrough 归一化。

// ── [[/command-gateway:manifest-normalizers]] ──

function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const sections = Array.isArray(prompt.sections) ? prompt.sections : [];
  const normalized = sections
    .map((s, i) => ({
      id: cleanString(s?.id, `section-${i}`),
      title: cleanString(s?.title, ''),
      content: String(s?.content ?? '').trim(),
      // Skill 不得覆盖核心安全规则：priority 上限 99
      priority: Math.min(99, Number(s?.priority) || 50)
    }))
    .filter((s) => s.content);
  if (!normalized.length && !prompt.instruction) return null;
  if (!normalized.length && prompt.instruction) {
    normalized.push({ id: 'main', title: '', content: String(prompt.instruction).trim(), priority: 50 });
  }
  return { sections: normalized };
}

/** 判断 manifest 是否可用（没有致命问题）。 */
export function isManifestUsable(manifest, problems) {
  if (!manifest) return false;
  return !problems.some((p) => p.startsWith('缺少 id') || p.includes('id 只能包含'));
}
