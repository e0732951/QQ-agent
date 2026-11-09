// 指令前置自带的那 8 条指令：禁言 / 解禁 / 全体禁言 / 全体解禁 / 暂停 / 继续 / 抛骰子 / 猜拳。
//
// 声明写在 plugin.json 的 commands[]，实现在这里 —— 也是"插件作者可以直接照抄"的样板：
//   · 群管理动作走 ctx.onebot.call（官方已给的句柄，走设置里的 HTTP 地址）；
//   · 发送一律靠"返回文本"让前置代发（不用自己碰发送队列）；
//   · 失败用 { ok:false, error } 回一句人话，原始错误只进日志。

import { pickTarget, formatWho, parseDuration, humanDuration, resolveMemberName, stripTargetArg } from './args.js';

const GROUP_ONLY = '（仅群聊）';

/** 群管理动作失败时，把协议端的错误翻译成人话；翻不出来就原样带一句（截断）。 */
function groupError(error) {
  const msg = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
  if (/retcode=-?1\b|权限|管理人|管理员|permission|admin|forbidden/i.test(msg)) {
    return '机器人没有这个群的管理权限：先在 QQ 里把机器人设成群管理员，再试一次。';
  }
  return `协议端拒绝了这次操作：${msg.slice(0, 120)}`;
}

/** 群管理类指令的公共前置检查：必须是群聊，且拿得到群号。 */
function requireGroup(ctx, chat) {
  // 在私聊里发群管理指令不是"失败"，是一句用法提示 —— 所以走 text 而不是 error
  if (chat?.kind !== 'group') return { text: `这条指令${GROUP_ONLY}：请在群里发。` };
  const groupId = Number(chat.chatId);
  if (!Number.isFinite(groupId) || !groupId) return { error: '拿不到群号，没法执行。' };
  if (!ctx?.onebot?.call) return { error: '当前没有可用的协议连接，稍后再试。' };
  return { groupId };
}

/** 统一处理 requireGroup 的三种结果；返回非空表示这一轮到此为止。 */
const guardGroup = (ctx, chat, result) => (result.text ? { text: result.text } : (result.error ? { ok: false, error: result.error } : null));

const RPS = ['石头', '剪刀', '布'];
const BEATS = { 石头: '剪刀', 剪刀: '布', 布: '石头' };

export const BUILTIN_COMMANDS = {
  /** /禁言 @用户 [时间=30分钟] */
  'command.mute': async ({ args, ctx, chat, segments, ats }) => {
    const group = requireGroup(ctx, chat);
    const stopped = guardGroup(ctx, chat, group);
    if (stopped) return stopped;
    // 目标可以从「艾特段」「@昵称(QQ:…)」「裸 QQ 号」里认出来 —— 与 /权限查询 同一套解析
    const target = pickTarget({ args, segments, ats });
    if (!target) return { text: '用法：/禁言 @某人 [时间=30分钟]。也可以直接写 QQ 号。' };
    // 拿着 at 段的 QQ 回问协议端拿真名：显示用，也用于把 @昵称 从参数里**精确**剥掉 ——
    // 文本里的昵称既可能被截断（含空格），也可能含数字词（"Team 6"），启发式切不可靠。
    const realName = await resolveMemberName({ qq: target.qq, chat, ctx });
    const parsed = parseDuration(stripTargetArg(args, realName));
    if (!parsed) return { text: '未知的时间格式。用法：/禁言 @某人 [时间=30分钟]，时间可以写 30秒 / 5分钟 / 2小时 / 1天。' };
    const who = formatWho({ ...target, name: realName || target.name });
    try {
      await ctx.onebot.call('set_group_ban', {
        group_id: group.groupId,
        user_id: Number(target.qq),
        duration: parsed.seconds
      });
    } catch (error) {
      return { ok: false, error: groupError(error) };
    }
    if (!parsed.seconds) return { text: `已解除 ${who} 的禁言。` };
    return { text: `已禁言 ${who} ${humanDuration(parsed.seconds)}${parsed.clamped ? '（超过上限，按 30 天算）' : ''}。` };
  },

  /** /解禁 @用户 */
  'command.unmute': async ({ args, ctx, chat, segments, ats }) => {
    const group = requireGroup(ctx, chat);
    const stopped = guardGroup(ctx, chat, group);
    if (stopped) return stopped;
    const target = pickTarget({ args, segments, ats });
    if (!target) return { text: '用法：/解禁 @某人。也可以直接写 QQ 号。' };
    // 真名只为显示更准；拿不到就退回文本里抠出来的名字，不影响动作本身
    const realName = await resolveMemberName({ qq: target.qq, chat, ctx });
    const who = formatWho({ ...target, name: realName || target.name });
    try {
      await ctx.onebot.call('set_group_ban', { group_id: group.groupId, user_id: Number(target.qq), duration: 0 });
    } catch (error) {
      return { ok: false, error: groupError(error) };
    }
    return { text: `已解除 ${who} 的禁言。` };
  },

  /** /全体禁言 */
  'command.whole-mute': async ({ ctx, chat }) => {
    const group = requireGroup(ctx, chat);
    const stopped = guardGroup(ctx, chat, group);
    if (stopped) return stopped;
    try {
      await ctx.onebot.call('set_group_whole_ban', { group_id: group.groupId, enable: true });
    } catch (error) {
      return { ok: false, error: groupError(error) };
    }
    return { text: '已开启全员禁言。' };
  },

  /** /全体解禁 */
  'command.whole-unmute': async ({ ctx, chat }) => {
    const group = requireGroup(ctx, chat);
    const stopped = guardGroup(ctx, chat, group);
    if (stopped) return stopped;
    try {
      await ctx.onebot.call('set_group_whole_ban', { group_id: group.groupId, enable: false });
    } catch (error) {
      return { ok: false, error: groupError(error) };
    }
    return { text: '已解除全员禁言。' };
  },

  /** /暂停 —— 全局暂停**模型调用**（指令类功能照常可用） */
  'command.pause': async ({ ctx }) => {
    const orchestrator = ctx?.host?.orchestrator;
    if (!orchestrator?.setPaused) return { ok: false, error: '拿不到运行器句柄，没法暂停。' };
    if (orchestrator.paused === true) return { text: '已经是暂停状态了。发 /继续 恢复。' };
    orchestrator.setPaused(true, '群里发的暂停指令');
    return { text: '已暂停模型调用：之后的消息不再交给模型，指令类功能照常可用。发 /继续 恢复。' };
  },

  /** /继续 [丢弃积压] */
  'command.resume': async ({ args, ctx }) => {
    const orchestrator = ctx?.host?.orchestrator;
    if (!orchestrator?.setPaused) return { ok: false, error: '拿不到运行器句柄，没法恢复。' };
    const skipBacklog = /丢弃|丢掉|不要积压/.test(String(args || ''));
    const wasPaused = orchestrator.paused === true;
    orchestrator.setPaused(false, '群里发的继续指令');
    if (!wasPaused) return { text: '本来就没在暂停，已经继续。' };
    if (skipBacklog) return { text: '已恢复模型调用；暂停期间积压的消息按你说的丢掉了。' };
    try {
      // 与控制台"恢复"同一套：把暂停期间积压的消息捞起来处理（失败不影响恢复本身）
      await orchestrator.drainBacklogAfterResume?.();
    } catch { /* 积压处理失败不该让"已恢复"这句话变成失败 */ }
    return { text: '已恢复模型调用，暂停期间积压的消息会接着处理。' };
  },

  /** /抛骰子 [面数=6] */
  'command.dice': async ({ args }) => {
    const raw = String(args || '').trim();
    let faces = 6;
    if (raw) {
      if (!/^\d+$/.test(raw)) return { text: '用法：/抛骰子 [面数=6]，面数写 6、20、100 这样的整数。' };
      faces = Number(raw);
      if (faces < 2 || faces > 10000) return { text: '面数要在 2~10000 之间。' };
    }
    const n = 1 + Math.floor(Math.random() * faces);
    return { text: `🎲 ${n}（${faces} 面）` };
  },

  /** /猜拳 [石头|剪刀|布] */
  'command.rps': async ({ args }) => {
    const mine = String(args || '').trim();
    const bot = RPS[Math.floor(Math.random() * RPS.length)];
    if (!mine) return { text: `✊✌️✋ 我出 ${bot}。` };
    if (!RPS.includes(mine)) return { text: '用法：/猜拳 [石头|剪刀|布]。' };
    if (mine === bot) return { text: `我出 ${bot}，你也出 ${mine} —— 平局。` };
    return BEATS[mine] === bot
      ? { text: `我出 ${bot}，你出 ${mine} —— 你赢了。` }
      : { text: `我出 ${bot}，你出 ${mine} —— 我赢了。` };
  }
};
