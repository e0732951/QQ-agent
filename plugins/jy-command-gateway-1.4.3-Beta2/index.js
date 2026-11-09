// 指令前置：在消息进入会话之前拦截 /指令，并路由给「指令插件」执行。
//
// 为什么是"消息入口"而不是钩子：钩子最早也发生在会话已创建之后，而且被禁止
// 发消息、发请求。指令要能即时回结果，就必须在会话诞生之前、且握着发送器。
// 核心为此在 src/app.js 的消息入口留了一个薄调用点（command.dispatch）。
//
// 反馈闭环：命中且认领 → 不存档、不建会话；未命中/权限不足/未接入/插件抛错 → 原样放行。
// 认领的指令执行完后，还可以「执行后放行」（passthrough）：按原文或改写后的文本
// 把这条消息放回正常聊天流程 —— 契约见本目录 README.md 第 8.3 节。
//
// 权限：一张「QQ → 权限等级」的表，未在表里的用「默认权限」行的值。
//      触发者等级 >= 接入项权限等级才放行，否则整条消息按普通消息走聊天流程。
//
// 元指令：前置自带、不占接入列表的两个功能（/帮助、/权限查询），
//        它们自己的权限等级也在设置页配（见 META_DEFS）。
//
// ⚠️ 本文件 import 了核心 config.js 只为把"最近调用记录 + 累计次数"写回配置
//    （插件没有写配置的 API，UI 又需要读到这份数据）。这是刻意取舍，记录在
//    本目录的 docs/adr/0003-command-gateway-core-call-site.md。

import { getConfig, updateConfig } from '../../src/config.js';
import { apply as applyCorePatch, revert as revertCorePatch, summarize as summarizeCorePatch } from './patch.mjs';
import { createServices } from './services.js';
import { BUILTIN_COMMANDS } from './builtin-commands.js';
import { pickTarget, formatWho, resolveMemberName } from './args.js';

let api = null;
let cfg = () => ({});
/** 核心句柄：由消息入口的调用点带进来（store/sessions/reminders/模型/搜索…），服务能力用它。 */
let host = null;

/**
 * 自己的插件 id（配置命名空间就是它）。
 *
 * 不硬编码：清单里的 id 改一次，代码就该跟着变 —— 由加载器在 setup 时告诉插件。
 * 这里留一个兜底值，只为 setup 之前的极端情况（正常流程下 setup 一定先跑）。
 */
let PLUGIN_ID = 'jy-command-gateway-1.4.3-Beta2';
/**
 * 早期用过的 id：当前 id 还没有任何配置时，从这些旧 id 里把配置搬过来
 * （用户把 id 改成带版本号那种情况）。按"越新越靠前"的顺序尝试。
 *
 * 京玉版适配：id 前面加了 `jy-` 前缀，所以 0.4 那串 id 也留在表里 ——
 * 用户从 0.4 那套配置迁过来（或者以后 JY 版自己换 `-Beta2`）都能自动接上。
 */
const LEGACY_IDS = ['jy-command-gateway-1.4.3-Beta', 'command-gateway-1.4.3-Beta', 'command-gateway-1.4.2-Beta', 'command-gateway-1.4.1-Beta', 'command-gateway-1.4.0', 'command-gateway-1.3.3', 'command-gateway-1.3.2', 'command-gateway-1.3.1', 'command-gateway-1.3', 'command-gateway'];

const RECENT_MAX = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const PERM_MIN = 0;
const PERM_MAX = 100000;
/** 默认权限行的兜底值：没配过 = 0，与设置页的初始状态一致。 */
const PERM_DEFAULT_LEVEL = 0;
/** 新接入项的默认权限等级：比默认权限高一级，所以新加的指令默认不对未指定的人开放。 */
const PERM_ROUTE_DEFAULT = 1;
/** 权限表的固定行名：它不是 QQ 号，而是"未在表里的所有人"。 */
const PERM_DEFAULT_ROW = 'default';
/** 每页帮助条数（用户定的：一次最多 10 条）。 */
const HELP_PAGE_SIZE = 10;

/**
 * 元指令：前置自带、不占用接入列表的功能。每个都有自己的权限等级，
 * 配置里缺哪一行就用这里的默认值（0 = 人人可用，1 = 默认权限的人用不了）。
 *
 * ⚠️ 这里的指令词是**保留词**：设置页会拦住把它们当接入项指令词的行为
 *    （ui/app.js 的 CG_RESERVED_WORDS 是同一份清单）。
 */
const META_DEFS = {
  help: { words: ['帮助', 'help', '指令'], permission: 0 },
  permission: { words: ['权限查询', '查询权限', 'perm'], permission: 1 }
};

/** 冷却表：`chatKey|指令标识` -> 上次执行时间戳。 */
const cooldown = new Map();
/** 已处理过的消息 id：协议端重连/重推时，同一条指令不能执行两次。 */
const seenMessages = new Map();
/** 每个会话一条执行链：同一会话的指令串行，避免两条指令同时跑导致回复乱序。 */
const chatQueues = new Map();
/** 最近调用记录（内存工作副本，节流写回配置）。 */
let recentCalls = [];
/** 累计调用次数：`pluginId:指令id` → { calls, lastAt }，与 recentCalls 一起节流落盘。 */
let routeStats = {};
let persistTimer = null;

export function setup(skillApi) {
  api = skillApi;
  cfg = skillApi.config;
  if (skillApi?.id) PLUGIN_ID = String(skillApi.id);
  migrateLegacyConfig();
  try {
    const saved = cfg().recentCalls;
    recentCalls = Array.isArray(saved) ? saved.slice(0, RECENT_MAX) : [];
    routeStats = (cfg().stats && typeof cfg().stats === 'object') ? { ...cfg().stats } : {};
  } catch {
    recentCalls = [];
    routeStats = {};
  }
}

export function available() {
  return { ok: true };
}

// ── 生命周期：启用时打补丁（含每次启动自愈），停用时摘补丁 ─────────────────

/**
 * 启用时（以及每次软件启动、每次重扫插件）跑一次：核心文件里缺我们的调用点就补上。
 *
 * 为什么要自愈：上游新版覆盖 src/ 或 ui/ 之后，调用点会一起消失，症状是
 * "插件装了、启用了，但发指令毫无反应" —— 用户很难自己想到去重打补丁。
 * 补丁改的是**进程已经加载过**的文件，所以这次启动不生效，状态里会写明"需要重启"。
 */
export function activate(context = {}) {
  try {
    const result = applyCorePatch();
    recordPatch(result, context?.reason === 'reload' ? 'reload' : 'activate');
  } catch (error) {
    api?.warn?.('核心补丁自检失败：', error?.message ?? error);
  }
}

/**
 * 停用时摘补丁。
 *
 * ⚠️ 热重载（保存插件文件）也会走 deactivate，reason = 'reload' ——
 * 那种情况**不能**摘：否则你每按一次保存，核心文件就被摘一次再打一次。
 */
export function deactivate(context = {}) {
  if (context?.reason === 'reload') return;
  try {
    const result = revertCorePatch();
    recordPatch(result, 'deactivate');
  } catch (error) {
    api?.warn?.('核心补丁摘除失败：', error?.message ?? error);
  }
}

/** 把补丁状态写回本插件的配置段（设置页从那里读，插件没有别的 UI 通道）。 */
function recordPatch(result, trigger) {
  const summary = summarizeCorePatch(result, { trigger });
  try {
    updateConfig({ skills: { [PLUGIN_ID]: { patch: summary } } });
  } catch { /* 写状态失败不影响补丁本身 */ }
  if (result?.ok === false) {
    const files = (result.conflicts || []).map((c) => c.file).join('、') || '未知文件';
    api?.warn?.(`核心补丁有冲突，已保持原样（${files}）。详见设置页的补丁状态。`);
  } else if (result?.changed?.length) {
    const verb = trigger === 'deactivate' ? '摘除' : '重打';
    api?.log?.(`核心补丁已${verb}：${result.changed.join('、')}${result.needsRestart ? '（需要重启软件才生效）' : ''}`);
  }
}

/** 读取配置并补齐默认值；每次调用都可能反映最新的设置。 */
function settings() {
  const s = cfg() || {};
  return {
    permissions: permissionRows(s.permissions),
    metaCommands: metaCommandRows(s.metaCommands),
    // 前缀含空白会导致永远匹配不上（正文已去前导空白），兜底回退 '/'
    prefix: (() => {
      const p = String(s.prefix ?? '/');
      return p && !/\s/.test(p) ? p : '/';
    })(),
    cooldownMs: Math.max(0, Number(s.cooldownMs ?? 3000) || 0),
    privateEnabled: s.privateEnabled !== false,
    defaultTimeoutMs: Math.max(1000, Number(s.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    // 覆盖表：用户对"插件声明的指令"做的本地改动（改词/权限/超时/停用）。
    // 声明本身在插件清单里（manifest.commands），这里只放差异。
    // 兼容字段：早期版本把整张表叫 routes，还读它。
    overrides: overrideRows(Array.isArray(s.overrides) ? s.overrides : s.routes),
    stats: (s.stats && typeof s.stats === 'object') ? s.stats : {},
    // 暂停闸：机器人被 /暂停 时，指令是否一律不生效（连 /帮助 也发不出来）。
    // pauseExemptWords 里的词例外 —— 默认只豁免「继续」，否则就没法从 QQ 里唤醒机器人。
    pauseStopsCommands: s.pauseStopsCommands !== false,
    pauseExemptWords: exemptWords(s.pauseExemptWords),
    moderation: moderationRules(s.moderation)
  };
}

/**
 * 「暂停时仍然可用的指令词」归一化。空 = 暂停时**全部静默**（连 /继续 也不认）。
 *
 * ⚠️ 默认就是空的：暂停之后在 QQ 里发什么都没反应，**只能去控制台点恢复**。
 *    想留个后门就在设置页填词（通常是「继续」），逗号分隔可填多个。
 */
function exemptWords(raw) {
  const src = (raw === undefined || raw === null) ? '' : String(raw);
  return src
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter((x) => x && !/\s/.test(x));
}

/**
 * 消息入口那条缝上唯一的核心调用点（见本目录 UPGRADE.md）。
 *
 * 它现在是一条**拦截链**：清单里声明了 `intercept` 的插件按 order 依次询问，
 * 谁先认领这条消息谁独占（不存档、不建会话），后面的不再被调用；都没认领就原样放行。
 * 指令前置自己也是链上的一员（order 50），排在"隐私模式"这类想优先独占通道的插件之后。
 *
 * 返回必须**同步**：核心据此决定这条消息要不要诞生会话。
 * 异步执行放进各自返回的 run()，核心 fire-and-forget —— 消息热路径不等待网络。
 */
export const providers = {
  'command.dispatch': (payload = {}) => {
    try {
      if (payload.ctx?.host) host = payload.ctx.host;   // 核心句柄：服务能力要用
      const s = settings();
      if (payload.kind === 'private' && s.privateEnabled === false) return { handled: false };
      // 给拦截者补上「有效指令表 + 触发者权限等级」再问它们：
      // 「隐私模式」这类**靠指令启用/停止**的拦截者要据此判断"这条该不该让给指令通道"
      // （让出去 = 走权限、走回执、走冷却；自己拦 = 只在会话期间接管每句话）。
      const enriched = withInterceptorContext(payload, s);
      for (const member of interceptChain(enriched, s)) {
        const decision = member.self ? dispatchSelf(enriched, s) : askInterceptor(member, enriched);
        if (decision && decision.handled === true) return decision;
      }
      return { handled: false };
    } catch (error) {
      api.warn('指令分发失败，已按普通消息放行：', error?.message ?? error);
      return { handled: false };
    }
  },
  // 服务能力：其它插件用 api.capability('ai.ask', …) 调用，见 services.js
  ...createServices({
    getHost: () => host,
    getSettings: settings,
    log: (msg) => api?.log?.(msg)
  }),
  // 自带指令（禁言/解禁/全体禁言/全体解禁/暂停/继续/抛骰子/猜拳）：声明见 plugin.json 的 commands[]
  ...BUILTIN_COMMANDS
};

/** 链上的一员：指令前置自己，它是最后一道（order 50）。 */
const SELF_ORDER = 50;

/**
 * 给拦截者补两个只读字段（原有字段一律不动，不需要的拦截者可以忽略）：
 *   · `effectiveRoutes`  —— 合并了用户覆盖表之后的**有效指令表**（word / aliases / permission / enabled）
 *   · `permissionLevel` —— 触发者当前的权限等级
 *
 * 为什么需要：「隐私模式」这类**靠指令启用/停止**的拦截者要判断
 * "这条消息该不该让给指令通道"（让出去 = 走权限、走回执、走冷却、进 /帮助），
 * 还是"该由我自己拦下"（会话期间的每句话）。
 * 拿不到这两个字段时（别的核心、老的调用点）拦截者会回落到自己的设置。
 */
function withInterceptorContext(payload, s) {
  try {
    const routes = effectiveRoutes(payload, s).map((r) => ({
      pluginId: r.pluginId,
      id: r.id,
      capability: r.capability,
      word: r.word,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
      permission: routeLevel(r),
      enabled: r.enabled !== false
    }));
    return { ...payload, effectiveRoutes: routes, permissionLevel: permissionOf(payload.senderId, s) };
  } catch (error) {
    api?.warn?.('给拦截者补有效指令表失败（拦截者会回落到自己的设置）：', error?.message ?? error);
    return payload;
  }
}

/**
 * 组装拦截链：清单里声明了 intercept 的插件 + 指令前置自己，按 order 升序。
 * 只保留**当前生效**的能力（插件被关掉就不该再问它）。
 */
function interceptChain(payload, s) {
  const catalog = Array.isArray(payload.catalog) ? payload.catalog : [];
  const members = catalog
    .filter((e) => e?.intercept?.capability)
    .filter((e) => e.intercept.capability !== 'command.dispatch')
    .filter((e) => api.hasCapability(e.intercept.capability))
    .map((e) => ({
      pluginId: e.id,
      capability: e.intercept.capability,
      order: Number.isFinite(Number(e.intercept.order)) ? Number(e.intercept.order) : 100,
      self: false
    }));
  members.push({ pluginId: PLUGIN_ID, capability: 'command.dispatch', order: SELF_ORDER, self: true });
  return members.sort((a, b) => a.order - b.order);
}

/** 问链上的一个外部拦截者；它抛错就当没认领（插件坏了不能吞消息）。 */
function askInterceptor(member, payload) {
  try {
    const decision = api.capability(member.capability, payload);
    // 拦截者必须是**同步**返回 { handled } 的：核心要立刻决定这条消息要不要诞生会话，
    // 不可能等一个 Promise。写成 async 的插件会被静默跳过 —— 这里明确喊一声。
    if (decision && typeof decision.then === 'function') {
      api.warn(`拦截链成员 ${member.pluginId} 返回了 Promise：拦截者必须同步返回 { handled }（异步工作放进 run()），已跳过它`);
      Promise.resolve(decision).catch(() => {});
      return null;
    }
    return decision;
  } catch (error) {
    api.warn(`拦截链成员 ${member.pluginId} 出错，跳过它：`, error?.message ?? error);
    return null;
  }
}

/**
 * 这条指令要不要因为「机器人被暂停」而静默。
 *
 * 暂停状态从核心句柄读（`host.orchestrator.paused`）—— 与 /继续 指令、控制台那个
 * 恢复按钮读的是同一个字段，不会出现"界面说在暂停、指令却照跑"的分裂。
 * 拿不到句柄时（别的核心 / 老调用点）一律不拦：宁可照常工作，也不要因为读不到状态
 * 就把所有指令锁死。
 */
function suspendedByPause(word, s) {
  if (s.pauseStopsCommands === false) return false;
  if (host?.orchestrator?.paused !== true) return false;
  const w = String(word || '').toLowerCase();
  return !s.pauseExemptWords.some((x) => x.toLowerCase() === w);
}

/** 指令前置自己那一步：元指令 + 声明过的指令。 */
function dispatchSelf(payload, s) {
  const parsed = parseCommand(payload.text, s.prefix, payload.segments);
  if (!parsed) return { handled: false };

  const level = permissionOf(payload.senderId, s);
  const word = parsed.word;

  // 暂停闸（2026-09-23 加）：机器人被 /暂停 时，指令一律不生效 —— 连 /帮助 都发不出来。
  // ⚠️ 这里返回 **handled:true 且不给 run** = "认领了但什么都不做"：
  //    消息不存档、不建会话、不发消息，恢复处理积压时也不会被模型看到 —— 彻底像没发生过。
  //    为什么不用 handled:false：那是"按普通消息放行"，消息会进存档，
  //    恢复时模型可能对着一条 /帮助 回话，等于指令没生效却还是留下了痕迹。
  //    这与 /赞我 插件在暂停时的「静默」是同一种处理。
  if (suspendedByPause(word, s)) return { handled: true };

  // 元指令（前置自带）优先于插件指令：指令词是保留词，正常配置下不会撞车。
  const meta = matchMeta(word);
  if (meta) {
    if (!metaEnabled(meta, s)) return { handled: false };   // 被关掉的元指令：当普通消息放行
    if (level < metaPermission(meta, s)) return { handled: false };
    if (isDuplicateMessage(payload.messageId)) return { handled: true };
    if (inCooldown(payload.chatKey, `__meta_${meta}__`, s.cooldownMs)) return { handled: true };
    return {
      handled: true,
      run: () => enqueue(payload.chatKey, () => (meta === 'help'
        ? runHelp({ payload, s, level, parsed })
        : runPermissionQuery({ payload, s, parsed })))
    };
  }

  const route = findRoute(effectiveRoutes(payload, s), word);
  if (!route) return { handled: false };

  // 权限不足命中指令：不拦截、不回执，按普通消息放行（用户明确要的"当没看见"）。
  if (level < routeLevel(route)) return { handled: false };

  if (isDuplicateMessage(payload.messageId)) return { handled: true };
  if (inCooldown(payload.chatKey, `${route.pluginId}:${route.id}`, s.cooldownMs)) {
    return { handled: true };   // 冷却中：静默吞掉，既不执行也不放给模型
  }
  return {
    handled: true,
    run: () => enqueue(payload.chatKey, () => runRoute({ payload, s, route, parsed, level, matchedWord: word }))
  };
}

/**
 * 有效指令表 = 插件清单里的声明 + 用户在本地的覆盖。
 *
 * 声明即生效：插件装好、清单里写了 commands，指令就能用（不必再去设置页"接入"一次）。
 * 覆盖只记差异：用户改过的字段写进 overrides，其余仍读声明 —— 插件升级新增一条指令时，
 * 用户不用做任何操作就能用上。
 */
function effectiveRoutes(payload, s) {
  const catalog = Array.isArray(payload.catalog) ? payload.catalog : [];
  const overrideOf = (pluginId, id) => s.overrides.find((o) => o.pluginId === pluginId && o.id === id) || null;
  const out = [];
  for (const entry of catalog) {
    if (!entry?.id || !Array.isArray(entry.commands)) continue;
    // 插件被关掉/卸载时它的指令不该出现（能力不在 = 调不到）
    for (const decl of entry.commands) {
      if (!api.hasCapability(decl.capability)) continue;
      const ov = overrideOf(entry.id, decl.id);
      out.push({
        id: decl.id,
        pluginId: entry.id,
        pluginName: entry.name || entry.id,
        capability: decl.capability,
        word: ov?.word || decl.word,
        aliases: (ov?.aliases === undefined ? decl.aliases : ov.aliases),
        permission: ov?.permission === undefined ? decl.permission : ov.permission,
        timeoutMs: (ov?.timeoutMs === undefined ? decl.timeoutMs : ov.timeoutMs),
        description: decl.description,
        argsHint: decl.argsHint,
        examples: decl.examples,
        // 「执行后放行」声明：核心 manifest 已归一化成 { mode, onFail } 或 null；
        // 这里再兜底归一化一遍，容忍脏数据/旧目录快照里的字符串形式
        passthrough: passthroughOf(decl.passthrough),
        enabled: ov ? ov.enabled !== false : true,
        calls: Number(s.stats[`${entry.id}:${decl.id}`]?.calls) || 0
      });
    }
  }
  return out;
}

// ── 解析 ────────────────────────────────────────────────────────────────

/**
 * 解析指令。返回 null = 不是指令候选（交给正常聊天流程）。
 *
 * 约定：先剥掉前导的引用块与艾特块，剩下的正文必须以指令前缀开头。
 * 引用/艾特只在**协议确实带了对应消息段**时才剥，避免误伤用户手打的 "@名字"。
 */
function parseCommand(text, prefix, segments) {
  const { body, ats } = stripLeadingMeta(text, segments, prefix);
  if (!body || !body.startsWith(prefix)) return null;
  const rest = body.slice(prefix.length);
  // 只有前缀、或前缀后直接跟空白，都不算指令
  if (!rest || /^\s/.test(rest)) return null;
  const m = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { word: m[1], args: String(m[2] ?? '').trim(), ats };
}

/** 剥掉前导的 `[引用 …]` 与 `@昵称(QQ:xxx) `，正文与艾特元数据一起返回。 */
function stripLeadingMeta(text, segments, prefix = '/') {
  let body = String(text ?? '').replace(/^\s+/, '');
  const ats = [];
  const segs = Array.isArray(segments) ? segments : null;
  const hasReplySeg = segs ? segs.some((x) => x?.type === 'reply') : null;
  const atSegs = segs ? segs.filter((x) => x?.type === 'at' && String(x?.data?.qq) !== 'all') : null;

  if (hasReplySeg !== false && body.startsWith('[引用')) {
    const end = body.indexOf(']');
    if (end >= 0) body = body.slice(end + 1).replace(/^\s+/, '');
  }

  // @全体成员 在文本里是普通文本（协议端不是 at 段），同样当元数据剥掉
  if (body.startsWith('@全体成员')) {
    body = body.replace(/^@全体成员\s*/, '');
    ats.push({ name: '全体成员', qq: 'all' });
  }

  // 昵称可以含空格（"Death's End /禁言 1"）：指令前缀就是天然的"昵称到哪为止"锚点，
  // 宽版正则把昵称收到前缀为止；收不拢再退回单词版（@昵称 后面没跟指令的情况）。
  const anchor = String(prefix || '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wideAt = new RegExp(`^@([^\\s@(]+(?:\\s+[^\\s@()]+)*?)(?:\\(QQ:(\\d+)\\))?\\s*(?=${anchor}|$)`);

  const maxAt = atSegs ? atSegs.length : 8;
  for (let i = 0; i < maxAt; i++) {
    if (!body.startsWith('@')) break;
    const m = body.match(wideAt) || body.match(/^@([^\s(]+)(?:\(QQ:(\d+)\))?(?:\s+|$)/);
    if (!m) break;
    ats.push({ name: m[1], qq: m[2] || String(atSegs?.[i]?.data?.qq ?? '') });
    body = body.slice(m[0].length).replace(/^\s+/, '');
  }
  return { body, ats };
}

/** 权限等级收进 0~100000 的整数；空值/脏值回退到 fallback。 */
function clampLevel(raw, fallback = PERM_DEFAULT_LEVEL) {
  if (raw === '' || raw === null || raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(PERM_MAX, Math.max(PERM_MIN, n));
}

/**
 * 覆盖表归一化：只留用户真改过的东西。
 *
 *   { pluginId, id, word?, aliases?, permission?, timeoutMs?, enabled? }
 *
 * 兼容早期版本：那时这张表叫 `routes`，存的是"整条接入项"（带 capability/calls/description），
 * 这里只把能对上号的字段收进来，其余丢掉 —— 声明本身以插件清单为准。
 */
function overrideRows(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const pluginId = String(r?.pluginId ?? '').trim();
    const id = String(r?.id ?? r?.commandId ?? r?.word ?? '').trim();
    if (!pluginId || !id) continue;
    const key = `${pluginId}:${id}`;
    if (seen.has(key)) continue;      // 同一条只留第一次出现的
    seen.add(key);
    const row = { pluginId, id };
    const word = String(r?.word ?? '').trim();
    if (word) row.word = word;
    if (Array.isArray(r?.aliases)) row.aliases = r.aliases.map((x) => String(x).trim()).filter(Boolean);
    if (r?.permission !== undefined && r?.permission !== null && r?.permission !== '') {
      row.permission = clampLevel(r.permission, null);
    }
    if (r?.timeoutMs !== undefined && r?.timeoutMs !== null && r?.timeoutMs !== '') {
      row.timeoutMs = Math.max(0, Math.round(Number(r.timeoutMs) || 0));
    }
    if (r?.enabled === false) row.enabled = false;
    out.push(row);
  }
  return out;
}

/** 内容检查规则：给 moderation.check 能力用。 */
function moderationRules(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const clean = (list) => (Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : []);
  return { words: clean(r.words), patterns: clean(r.patterns) };
}

/**
 * 规范化权限表：丢掉空行与非数字 QQ、去重（留第一次出现的），
 * 并保证「默认权限」行一定存在 —— 它是判定链的兜底，不是装饰。
 */
function permissionRows(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const rows = [];
  const seen = new Set();
  for (const r of list) {
    const qq = String(r?.qq ?? '').trim();
    if (!qq || seen.has(qq)) continue;
    if (qq !== PERM_DEFAULT_ROW && !/^\d+$/.test(qq)) continue;
    seen.add(qq);
    rows.push({ qq, level: clampLevel(r?.level) });
  }
  if (!seen.has(PERM_DEFAULT_ROW)) rows.unshift({ qq: PERM_DEFAULT_ROW, level: PERM_DEFAULT_LEVEL });
  return rows;
}

/** 触发者的权限等级：在表里就用他那一行，否则用默认权限行。 */
function permissionOf(senderId, s) {
  const id = String(senderId ?? '').trim();
  const rows = s.permissions;
  if (id) {
    const hit = rows.find((r) => r.qq === id);
    if (hit) return hit.level;
  }
  const fallback = rows.find((r) => r.qq === PERM_DEFAULT_ROW);
  return fallback ? fallback.level : PERM_DEFAULT_LEVEL;
}

/** 接入项要求的权限等级：没配过（手改配置/更早的数据）按新接入的默认值算。 */
function routeLevel(route) {
  return clampLevel(route?.permission, PERM_ROUTE_DEFAULT);
}

/** 元指令配置：每个元指令一行，缺行/脏值一律回落到 META_DEFS 的默认等级。 */
function metaCommandRows(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return Object.entries(META_DEFS).map(([id, def]) => {
    const row = list.find((r) => String(r?.id ?? '') === id);
    return {
      id,
      permission: clampLevel(row?.permission, def.permission),
      enabled: row ? row.enabled !== false : true
    };
  });
}

/**
 * 把旧 id 的配置搬到当前 id 下。
 *
 * 为什么需要：配置是按 `config.skills[<id>]` 存的，id 一改就等于换了个插件 ——
 * 权限表、覆盖表、元指令设置全都会"失联"，用户还得重配一遍。
 * 只在**当前 id 还没有任何配置**时迁移一次，旧键保留不动（想回退随时能回去）。
 */
function migrateLegacyConfig() {
  try {
    const all = getConfig()?.skills || {};
    const own = all[PLUGIN_ID];
    if (own && typeof own === 'object' && Object.keys(own).length) return;   // 已经有自己的配置
    for (const legacyId of LEGACY_IDS) {
      if (legacyId === PLUGIN_ID) continue;
      const legacy = all[legacyId];
      if (!legacy || typeof legacy !== 'object') continue;
      const { patch, ...keep } = legacy;   // patch 是补丁状态，新 id 要重新检查，不带过去
      if (!Object.keys(keep).length) continue;
      updateConfig({ skills: { [PLUGIN_ID]: keep } });
      api?.log?.(`检测到旧 id（${legacyId}）的配置，已迁移到当前 id（${PLUGIN_ID}）`);
      return;
    }
  } catch (error) {
    api?.warn?.('旧配置迁移失败（不影响加载）：', error?.message ?? error);
  }
}

/** 某个元指令要求的权限等级。 */
function metaPermission(id, s) {
  const row = s.metaCommands.find((r) => r.id === id);
  return row ? row.permission : META_DEFS[id].permission;
}

/** 元指令是否启用（关掉之后它就当普通消息放行）。 */
function metaEnabled(id, s) {
  const row = s.metaCommands.find((r) => r.id === id);
  return row ? row.enabled !== false : true;
}

/** 指令词 → 元指令 id；不是元指令返回 null。大小写不敏感（help / perm）。 */
function matchMeta(word) {
  const w = String(word || '').toLowerCase();
  for (const [id, def] of Object.entries(META_DEFS)) {
    if (def.words.some((x) => x.toLowerCase() === w)) return id;
  }
  return null;
}

/** 一条指令支持的全部指令词：主词 + 别名（去掉含空白的无效词）。 */
function routeWords(route) {
  const main = String(route?.word || '').trim();
  const aliases = Array.isArray(route?.aliases) ? route.aliases.map((x) => String(x || '').trim()) : [];
  return [main, ...aliases].filter((x) => x && !/\s/.test(x));
}

function findRoute(routes, word) {
  const w = String(word || '').toLowerCase();
  return routes.find((r) => r && r.enabled !== false && routeWords(r).some((x) => x.toLowerCase() === w)) || null;
}

/** 同一条消息只处理一次（协议端重连/重推会产生重复事件）。 */
function isDuplicateMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  const now = Date.now();
  const last = seenMessages.get(id);
  if (last && now - last < 300000) return true;
  seenMessages.set(id, now);
  if (seenMessages.size > 1000) {
    for (const [k, ts] of seenMessages) if (now - ts > 300000) seenMessages.delete(k);
  }
  return false;
}

/** 同一会话的指令串行执行：避免两条指令同时跑导致回复乱序。 */
function enqueue(chatKey, task) {
  const prev = chatQueues.get(chatKey) || Promise.resolve();
  const chained = prev.then(() => task());
  const handle = chained.catch(() => {}).finally(() => {
    if (chatQueues.get(chatKey) === handle) chatQueues.delete(chatKey);
  });
  chatQueues.set(chatKey, handle);
  return chained;
}

/** 命中即占用冷却位；返回 true 表示这次应当静默跳过。 */
function inCooldown(chatKey, key, cooldownMs) {
  if (!cooldownMs) return false;
  const k = `${chatKey}|${key}`;
  const now = Date.now();
  const last = cooldown.get(k) || 0;
  if (now - last < cooldownMs) return true;
  cooldown.set(k, now);
  if (cooldown.size > 500) {
    for (const [kk, ts] of cooldown) if (now - ts > 600000) cooldown.delete(kk);
  }
  return false;
}

// ── 执行 ────────────────────────────────────────────────────────────────

async function runRoute({ payload, s, route, parsed, level, matchedWord }) {
  const startedAt = Date.now();
  const word = String(matchedWord || route.word || '').trim();
  const ctx = payload.ctx || {};
  let ok = false;
  let errorText = '';
  try {
    const capability = String(route.capability || `command.${route.pluginId}`).trim();
    if (!api.hasCapability(capability)) {
      // 插件被关闭或已卸载：这是配置问题，给触发者一句可读的说明后结束。
      errorText = 'plugin-unavailable';
      await sendText(ctx, payload.chatKey, `指令「${word}」当前不可用：对应的插件未启用或已卸载。`);
      return passthroughDirective({ result: null, failed: true, decl: route.passthrough, payload, parsed, word: matchedWord });
    }

    // ⚠️ 2026-10-11 修正：原来这里写的是 `resolveTimeout(route, payload.catalog, s.defaultTimeoutMs)`，
    //    而 resolveTimeout 只收 (route, fallbackMs) 两个参数 ⇒ `payload.catalog`（指令数组）
    //    被当成了 fallbackMs，真正的前置默认值被挤到第三位丢掉。
    //    后果：**任何没有在 commands[] 里声明 timeoutMs 的插件，其指令都会"秒超时"**
    //      —— setTimeout(fn, 数组) 被强转成一个天文数字，立刻到期。
    //      表现很迷惑：群里收到"执行失败，详细原因见控制台调用记录"，
    //      但插件的异步工作（比如出图）其实已经跑完并把消息发出了。
    //    实测证据：某插件指令 127ms/152ms 就被判超时，而它正常需要 350ms+；
    //      调用记录里的 error 是 `执行超时（[object Object],...ms）`。
    const timeoutMs = resolveTimeout(route, s.defaultTimeoutMs);
    const commandPayload = {
      command: word,
      prefix: s.prefix,
      aliases: routeWords(route),
      args: parsed.args,
      parts: parsed.args ? parsed.args.split(/\s+/) : [],
      raw: String(payload.text ?? ''),               // 剥离前的完整文本
      rawMessage: String(payload.rawMessage ?? ''),  // 协议端原始 CQ 字符串
      segments: payload.segments ?? null,            // 原始消息段
      reply: await resolveReplyMeta(replyIdOf(payload.segments), ctx),
      ats: parsed.ats,
      permission: level,
      chat: { kind: payload.kind, chatId: payload.chatId, chatKey: payload.chatKey },
      from: { id: String(payload.senderId ?? ''), name: String(payload.senderName ?? '') },
      ctx
    };

    const result = await withTimeout(
      Promise.resolve(api.capability(capability, commandPayload)),
      timeoutMs
    );
    await deliverResult(result, ctx, payload.chatKey, word);
    ok = true;
    // 执行成功：返回值 > 清单声明 > 不放行
    return passthroughDirective({ result, decl: route.passthrough, payload, parsed, word: matchedWord });
  } catch (error) {
    errorText = String(error?.message ?? error);
    api.warn(`指令「${word}」执行失败：${errorText}`);
    try {
      // 回执不带原始错误：错误文本里可能含 Key、内部路径等不该出现在群里的信息。
      // 详情在日志与「设置 → 指令前置 → 最近调用」里。
      await sendText(ctx, payload.chatKey, `指令「${word}」执行失败，详细原因见控制台设置页的调用记录。`);
    } catch { /* 回执失败不掩盖原始错误 */ }
    // 执行失败（抛错/超时，没有返回值可看）：声明了 onFail: "release" 才放行
    return passthroughDirective({ result: null, failed: true, decl: route.passthrough, payload, parsed, word: matchedWord });
  } finally {
    bumpRouteCalls(route);
    recordCall({
      at: new Date().toISOString(),
      chatKey: payload.chatKey,
      sender: String(payload.senderName || payload.senderId || ''),
      command: word,
      ok,
      ms: Date.now() - startedAt,
      error: errorText
    });
  }
}

/**
 * /帮助 [页码] —— 只列**发件人有权使用**的指令，每页 HELP_PAGE_SIZE 条。
 *
 * 页码规则（用户定的）：`/帮助`、`/帮助 0`、`/帮助 1` 都是第一页；
 * 页码不是数字、或者超出总页数 → 也回第一页（宁可给第一页，也不回一句"没有这一页"）。
 */
async function runHelp({ payload, s, level, parsed }) {
  const lines = [];
  // 元指令也列出来（/帮助 自己也算一条可用指令）；都在列表开头，和插件指令分开。
  lines.push(`${s.prefix}帮助 [页码=1] —— 列出你有权使用的指令（每页 ${HELP_PAGE_SIZE} 条）`);
  if (level >= metaPermission('permission', s)) {
    lines.push(`${s.prefix}权限查询 @某人 或 QQ 号 —— 查询某人的权限等级`);
  }
  for (const r of effectiveRoutes(payload, s)) {
    if (!r || r.enabled === false) continue;
    if (level < routeLevel(r)) continue;          // 没权限的指令：连存在都不该知道
    const words = routeWords(r);
    if (!words.length) continue;
    const hint = r.argsHint ? ` ${r.argsHint}` : '';
    const desc = String(r.description || '').trim();
    const alias = words.length > 1
      ? `（别名：${words.slice(1).map((x) => s.prefix + x).join('、')}）`
      : '';
    // 顺手带一个真例子（清单里 examples[0]）：会有用户照着参数提示原样打
    // —— 2026-09-23 真事：有人把 "/禁言 @某人 [时间=1分钟]" 连方括号一起发出去了。
    const example = Array.isArray(r.examples) && r.examples.length ? ` · 例：${String(r.examples[0])}` : '';
    lines.push(`${s.prefix}${words[0]}${hint}${desc ? ` —— ${desc}` : ''}${alias}${example}`);
  }
  const total = Math.max(1, Math.ceil(lines.length / HELP_PAGE_SIZE));
  const page = clampPage(parsed?.args, total);
  const body = lines.slice((page - 1) * HELP_PAGE_SIZE, page * HELP_PAGE_SIZE);
  const nav = [];
  if (page > 1) nav.push(`上一页：${s.prefix}帮助 ${page - 1}`);
  if (page < total) nav.push(`下一页：${s.prefix}帮助 ${page + 1}`);
  const tail = [
    '',
    ...(nav.length ? [nav.join(' · ')] : []),
    `第 ${page} 页 / 共 ${total} 页`
  ];
  // 参数写法说明：**每页都带**（用户可能只看某一页）。
  // 起因：有用户把 [时间=30分钟] 理解成要原样输入，发了 "/禁言 @某人 [时间=1分钟]"。
  const legend = [
    '格式：',
    '<尖括号> = 这里填你的参数内容；',
    '[方括号] = 可以不填，不填就用里面的默认值。（例：[时间=30分钟] 是"时间可以不写，默认 30 分钟"，正确写法见每条的"例："）',
    ''
  ];
  await sendText(payload.ctx, payload.chatKey, ['可用指令：', ...legend, ...body, ...tail].join('\n'));
  // 帮助是元指令，不占用「最近调用」的名额（那里只保留真实指令的执行记录）。
}

/** 页码收口：空/非数字/0/负数/超出总页数 都回第一页。 */
function clampPage(raw, total) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || Math.round(n) < 1) return 1;
  const page = Math.round(n);
  return page > total ? 1 : page;
}

/**
 * /权限查询 [@某人 | QQ号] —— 查某个人的权限等级。
 *
 * 目标优先级：真·艾特段（协议给的 QQ 最可信）→ 参数里的第一个数字串。
 * 查不到（不在权限表里）**不是错误**：返回他实际生效的等级（默认权限行的值），
 * 并说明这来自默认权限 —— 默认权限初始是 0，所以看到的就是 0。
 */
async function runPermissionQuery({ payload, s, parsed }) {
  const target = pickTarget({ args: parsed.args, segments: payload.segments, ats: parsed.ats });
  const usage = `用法：${s.prefix}权限查询 @某人，或 ${s.prefix}权限查询 10001`;
  if (!target) {
    await sendText(payload.ctx, payload.chatKey, usage);
    return;
  }
  // 真名只为显示更准（文本里抠出来的可能被截断）；拿不到就退回，不影响查询。
  // ⚠️ 分发 payload 上没有 `chat` 字段（只有 chatId/kind/chatKey），按 resolveMemberName 要的形状拼一个。
  const realName = await resolveMemberName({ qq: target.qq, chat: { chatId: payload.chatId }, ctx: payload.ctx });
  const who = formatWho({ ...target, name: realName || target.name });
  const hit = s.permissions.find((r) => r.qq === target.qq);
  const fallback = s.permissions.find((r) => r.qq === PERM_DEFAULT_ROW);
  const level = hit ? hit.level : (fallback ? fallback.level : PERM_DEFAULT_LEVEL);
  const tail = hit ? '' : '（不在权限表里，跟随默认权限）';
  await sendText(payload.ctx, payload.chatKey, `${who}，权限等级 ${level}${tail}`);
}

// ── 执行后放行（passthrough）────────────────────────────────────────────

/**
 * 「执行后放行」声明兜底归一化：与核心 manifest 的 normalizePassthrough 同一规则。
 *   "original" | "prefix" | "args" 或 { mode, onFail } → { mode, onFail }；脏值 → null。
 */
function passthroughOf(raw) {
  const obj = typeof raw === 'string'
    ? { mode: raw }
    : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  const mode = String(obj?.mode ?? '').trim().toLowerCase();
  if (!['original', 'prefix', 'args'].includes(mode)) return null;
  const onFail = String(obj?.onFail ?? '').trim().toLowerCase() === 'release' ? 'release' : 'skip';
  return { mode, onFail };
}

/**
 * 「执行后放行」裁决：算出要交给核心的放行指令，随 run() 的返回值带回。
 *
 *   true          → 按消息原文放行（核心用自己手里的原文，含引用/@前缀与媒体段）
 *   非空字符串    → 用这段文本放行（修改后放行）
 *   null          → 不放行，消息到此为止
 *
 * 优先级：子插件返回值 > 清单声明 > 不放行。
 *   · 返回值里写了 passthrough 就听返回值的 —— 包括 ok:false 的返回（两个口子都是
 *     开发者的，运行时说了算）；返回空字符串等于没写（不放行）；
 *   · 只有清单声明时：成功按声明档；失败（抛错/超时/ok:false 且没写返回值）看
 *     onFail —— 缺省 "skip" = 失败不放行。
 */
function passthroughDirective({ result, failed = false, decl, payload, parsed, word }) {
  const rt = (result && typeof result === 'object' && !Array.isArray(result))
    ? result.passthrough
    : undefined;
  if (rt !== undefined && rt !== null) {
    if (rt === false) return null;
    if (rt === true) return decl ? declaredText(decl.mode, payload, parsed, word) : true;
    const text = String(rt).trim();
    return text || null;
  }
  if (!decl) return null;
  // ok:false 的返回也是"执行失败"（前置已经替它发过失败回执），跟抛错/超时同一条路
  const failedNow = failed || (result && typeof result === 'object' && result.ok === false);
  if (failedNow && decl.onFail !== 'release') return null;
  return declaredText(decl.mode, payload, parsed, word);
}

/** 声明档位 → 放行文本：original 交还核心原文；prefix/args 在插件侧拼好字符串。 */
function declaredText(mode, payload, parsed, word) {
  if (mode === 'args') {
    // 去指令词：模型只看到参数。没参数 = 没东西可放行
    return String(parsed?.args ?? '').trim() || null;
  }
  if (mode === 'prefix') {
    // 去前缀：模型看到「天气 珠海」（指令词 + 参数，没有 /）
    const w = String(word || '').trim();
    const a = String(parsed?.args ?? '').trim();
    return [w, a].filter(Boolean).join(' ') || null;
  }
  return true;   // original
}

/** 超时：覆盖值 > 清单声明值（已在 effectiveRoutes 里合好）> 前置默认 30 秒。 */
function resolveTimeout(route, fallbackMs) {
  const own = Number(route.timeoutMs);
  if (Number.isFinite(own) && own >= 1000) return Math.min(600000, Math.round(own));
  return fallbackMs;
}

/** 被引用消息的 id 在 reply 段里，而不是当前消息的 messageId。 */
function replyIdOf(segments) {
  if (!Array.isArray(segments)) return '';
  const seg = segments.find((x) => x?.type === 'reply');
  const id = seg?.data?.id;
  return id != null && String(id).trim() ? String(id) : '';
}

async function resolveReplyMeta(messageId, ctx) {
  if (!messageId || !ctx?.onebot?.getMsg) return null;
  try {
    const msg = await ctx.onebot.getMsg(Number(messageId) || messageId);
    const senderName = String(msg?.sender?.card || msg?.sender?.nickname || '');
    let text = '';
    if (Array.isArray(msg?.message)) {
      text = msg.message.map((seg) => (seg?.type === 'text' ? seg?.data?.text ?? '' : `[${seg?.type}]`)).join('').trim();
    } else if (typeof msg?.message === 'string') {
      text = msg.message;
    }
    return { messageId: String(messageId), senderName, text: text.slice(0, 200) };
  } catch {
    return null;
  }
}

/** 约定：返回字符串 / { text } 由前置代发；{ ok:false, error } 回执失败；其它情况视为子插件自己发过了。 */
async function deliverResult(result, ctx, chatKey, command) {
  if (typeof result === 'string') {
    if (result.trim()) await sendText(ctx, chatKey, result.trim());
    return;
  }
  if (result && typeof result === 'object') {
    if (result.ok === false) {
      // 这里的 error 是**子插件写给用户看的**，会被发到群里 —— 所以只裁剪长度，
      // 不做脱敏；想脱敏的子插件应当改为抛错（抛出的文本只进日志）。
      const why = String(result.error || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 200);
      await sendText(ctx, chatKey, `指令 ${command} 执行失败：${why}`);
      return;
    }
    if (typeof result.text === 'string' && result.text.trim()) {
      await sendText(ctx, chatKey, result.text.trim());
    }
  }
}

async function sendText(ctx, chatKey, text) {
  const sender = ctx?.sender;
  if (sender?.sendTextBatch) await sender.sendTextBatch(chatKey, [text]);
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`执行超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── 记录 ────────────────────────────────────────────────────────────────

/** 累计调用次数：单独记在 stats 里，不去改覆盖表（覆盖表只放用户的改动）。 */
function bumpRouteCalls(route) {
  try {
    const key = `${route.pluginId}:${route.id}`;
    routeStats[key] = {
      calls: (Number(routeStats[key]?.calls) || 0) + 1,
      lastAt: new Date().toISOString()
    };
    schedulePersist();     // 与「最近调用」一起节流落盘，不额外写盘
  } catch { /* 统计失败不影响指令 */ }
}

function recordCall(entry) {
  recentCalls.unshift(entry);
  if (recentCalls.length > RECENT_MAX) recentCalls.length = RECENT_MAX;
  schedulePersist();
}

/**
 * 把累计次数与最近记录写回本插件的配置段（UI 从 /api/config 读取）。
 * 500ms 节流：连点/连发时只落一次盘，不阻塞指令执行。
 */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      updateConfig({
        skills: {
          [PLUGIN_ID]: { recentCalls, stats: routeStats }
        }
      });
    } catch { /* 记录写盘失败不影响指令本身 */ }
  }, 500);
  persistTimer.unref?.();
}
