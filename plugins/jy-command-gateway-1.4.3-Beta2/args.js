// 指令参数的公共解析：@用户 / QQ 号，以及时间。
//
// 被两处用：index.js（元指令 /权限查询）与 builtin-commands.js（/禁言 这些自带指令）。
// 单独放一个文件，是为了别让"怎么从消息里认出一个人"这件事有两份实现慢慢跑偏。

/**
 * 从消息里挑出目标用户（QQ 号）。
 *
 * 三个来源按可信度排序，第一个能给出 QQ 的胜出：
 *   1. 消息段里的艾特段（协议给的 QQ，最可信）；
 *   2. 正文里的 `(QQ:123)` —— 核心把艾特段转成文本时补上的规范化写法；
 *   3. 参数里裸写的 QQ 号。
 * 正文里手打的 `@昵称` 没有 QQ，认不出来 → 返回 null（调用方回用法提示，不猜）。
 *
 * @param {{args?: string, segments?: Array|null, ats?: Array}} input
 * @returns {{qq: string, name: string}|null}
 */
export function pickTarget(input = {}) {
  const argsText = String(input.args ?? '');
  const segs = Array.isArray(input.segments) ? input.segments : [];
  const segAt = segs.find((x) => x?.type === 'at' && /^\d+$/.test(String(x?.data?.qq ?? '')));
  const leadingAt = (input.ats || []).find((a) => a?.qq && a.qq !== 'all' && /^\d+$/.test(a.qq));

  const qq = (segAt && String(segAt.data.qq))
    || (argsText.match(/QQ[:：]\s*(\d{4,12})/i) || [])[1]
    || (argsText.match(/\d{4,12}/) || [])[0]
    || (leadingAt && leadingAt.qq)
    || '';
  if (!qq) return null;

  // 显示名：正文 `@昵称(QQ:…)` 里的昵称 > 前导艾特带的名字 > 没有
  // 昵称可以含空格（"Death's End"）：@ 后续的词只要不以数字开头就并进昵称 ——
  // 时长一类的参数（`1`、`30分钟`）都以数字开头，正好在那里收住。
  const named = argsText.match(/@([^\s@(]+(?:\s+[^\s@(\d][^\s@()]*)*)(?:\(QQ[:：](\d{4,12})\))?/i);
  const name = (named && (!named[2] || named[2] === qq) ? named[1] : '')
    || (leadingAt && leadingAt.qq === qq ? String(leadingAt.name || '').trim() : '');
  return { qq, name: name || '' };
}

/** 显示成 `张三（10001）`；没名字就只给 QQ 号。 */
export function formatWho(target) {
  if (!target) return '';
  return target.name ? `${target.name}（${target.qq}）` : String(target.qq);
}

// ── 回问协议端拿真名 ────────────────────────────────────────────────────
//
// 背景：核心把艾特段渲染成 `@昵称(QQ:xxx)` 时，昵称是它自己查 NapCat 得来的
//（src/app.js 的 resolveAtName，进程内缓存），但这份缓存不开放给插件。
// 插件手里只有 at 段的 QQ 和渲染后的文本 —— 文本里的"昵称"既可能被截断
//（含空格的 "Death's End"），也可能和时长参数混在一起（"Team 6 10" 里的 6）。
// 最稳的手段：拿着 at 段的 QQ **回到协议端再问一次** get_group_member_info，
// 用协议确认的真名做显示与参数剥离。核心渲染路径也是这么干的。

/** 真名缓存：`群号:QQ` -> { name, at }。与核心 resolveAtName 同款防膨胀。 */
const memberNameCache = new Map();
const MEMBER_NAME_TTL_MS = 5 * 60 * 1000;

/**
 * 查某个群成员的显示名（群名片 > 昵称），带 5 分钟缓存。
 *
 * 查不到（没连接、协议失败、目标不在群里）返回 '' —— 调用方自行回退到
 * 从消息文本里抠出来的名字（pickTarget 的结果），不要让查询失败打断指令。
 *
 * @param {{ qq: string, chat?: {chatId?: string|number}, ctx?: {onebot?: {call?: Function}}} } input
 * @returns {Promise<string>}
 */
export async function resolveMemberName({ qq, chat, ctx } = {}) {
  const userId = String(qq ?? '').trim();
  const groupId = Number(chat?.chatId);
  const call = ctx?.onebot?.call;
  if (!/^\d+$/.test(userId) || !Number.isFinite(groupId) || !groupId || typeof call !== 'function') return '';
  const key = `${groupId}:${userId}`;
  const hit = memberNameCache.get(key);
  if (hit && Date.now() - hit.at < MEMBER_NAME_TTL_MS) return hit.name;
  try {
    const info = await call('get_group_member_info', { group_id: groupId, user_id: Number(userId) });
    const name = String(info?.card || info?.nickname || '').trim();
    if (name) {
      memberNameCache.set(key, { name, at: Date.now() });
      if (memberNameCache.size > 500) memberNameCache.clear();
      return name;
    }
  } catch { /* 查不到就回退，不打断指令 */ }
  return '';
}

/**
 * 从参数文本里剥掉「@目标（含 QQ 后缀）」与裸 QQ 号，剩下的交给 parseDuration 等。
 *
 * 拿到协议确认的真名时按真名精确剥 —— 这是唯一能可靠处理
 * "Team 6 10"（昵称含数字词）这类写法的方式；没拿到真名时退回启发式
 * （@ 后续词不以数字开头就并入昵称），即 pickTarget 同款口径。
 */
export function stripTargetArg(argsText, knownName = '') {
  let text = String(argsText ?? '');
  const name = String(knownName ?? '').trim();
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`@\\s*${esc}(?:\\s*\\(QQ[:：]\\d+\\))?`, 'gi'), ' ');
  }
  return text
    .replace(/@[^\s@(]+(?:\s+[^\s@(\d][^\s@()]*)*(?:\(QQ[:：]\d+\))?/gi, ' ')
    .replace(/\d{4,12}/g, ' ')
    .trim();
}

const UNIT_SECONDS = {
  秒: 1,
  分钟: 60,
  分: 60,
  小时: 3600,
  时: 3600,
  天: 86400
};

/** 把秒数写成人话：3600 → 1小时，1800 → 30分钟。 */
export function humanDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  if (!n) return '解除';
  if (n % 86400 === 0) return `${n / 86400}天`;
  if (n % 3600 === 0) return `${n / 3600}小时`;
  if (n % 60 === 0) return `${n / 60}分钟`;
  return `${n}秒`;
}

/**
 * 解析时间参数。
 *   · 空 → defaultSeconds（/禁言 的默认 30 分钟）
 *   · 纯数字 → **分钟**（和"默认 30 分钟"同一个单位，符合直觉）
 *   · 带单位 → `30秒` / `5分钟` / `2小时` / `1天`（只认一个单位，不认 `1小时30分`）
 *   · `0` / `0分钟` → 0 秒（禁言里等于解禁）
 * 解析不了返回 null（调用方回用法提示）。
 */
export function parseDuration(raw, { defaultSeconds = 1800, maxSeconds = 30 * 86400 } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return { seconds: defaultSeconds, explicit: false };
  let seconds = null;
  if (/^\d+$/.test(text)) {
    seconds = Number(text) * 60;           // 纯数字 = 分钟
  } else {
    const m = text.match(/^(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|时|天)$/);
    if (m) seconds = Math.round(Number(m[1]) * UNIT_SECONDS[m[2]]);
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds > maxSeconds) return { seconds: maxSeconds, explicit: true, clamped: true };
  return { seconds, explicit: true };
}
