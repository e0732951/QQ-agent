// 今日塔罗 · 控制台设置分区
//
// 这个文件**不是核心代码**。核心按 plugin.json 里的 settingsUi 声明，
// 用只读路由 /plugin-assets/jy-tarot/settings-ui.js 把它取回控制台，
// 在「设置 → 插件设置」左栏占一个分区「今日塔罗」。
//
// 模块契约（与 command-dressup / memory-star 同一套）：
//   render(ctx) -> string        返回这块分区的 HTML
//   bind(root, ctx) -> cleanup?  绑定事件；返回卸载函数
//   read(ctx) -> object|null     把界面输入读成"要保存的补丁"（核心的自动保存会调它）
//
// ── 为什么 read() 返回 null ────────────────────────────────────────────────
// 本面板自己挂「保存」按钮。核心的自动保存是"输入停 600ms 就保存 + 整页重绘"，
// 会在打字过程中把正在编辑的输入框吹掉（项目里已踩过的坑）。
//
// ── 🔴 为什么改名必须由"面板"直接写，而且**不能用 ctx.api** ──────────────────
// 指令词不由插件清单决定，而由「指令前置」的覆盖表决定：
//     config.skills[前置].overrides = [{ pluginId, id, word?, aliases?, permission?, timeoutMs?, enabled? }]
// 前置**每次分发都现读**配置 ⇒ 写完立刻生效、不依赖任何时机。
//
// ⚠️ 反面那条路（面板只写自己的配置段 → 插件取走落实）**走不通**：
//    插件只在 `setup()` 或"指令被调用"时才跑，而"刷新状态/重载插件"都不会让插件重跑 `setup()`
//    ⇒ 用户保存的词永远等不到执行时机。指令装扮为此返工过。
//
// ⚠️⚠️ 两个实测确认的契约（别照直觉写）：
//   ① `ctx.api` **不是 HTTP 工具**！核心里它是 `api: () => renderApiSection(c)`（返回 HTML）。
//      发请求只能用**原生 fetch**。
//   ② `ctx.config()` 返回的是**本插件自己那一段**配置（`state.config?.skills?.[id] || {}`），
//      **不是整份配置** ⇒ 从这里读 `skills[前置].overrides` 永远拿不到。
//      要读覆盖表得自己 `fetch('/api/config')`。
//
// ── 安全：绝不碰别的插件的条目 ─────────────────────────────────────────────
// 读当前覆盖表 → 只替换**本插件**的条目 → 整体写回。别的插件（如指令装扮的 5 个槽位）原样保留。
// ⚠️ 另有一条硬保护：**读不到旧表就拒绝写**。否则整体写回会把别人的条目全抹掉。
//
// ── 挂载两次 ──────────────────────────────────────────────────────────────
// 核心会把插件设置页挂载两次（侧栏一条、扩展详情一条）。bind() 开头先拆上一次的监听，
// 否则两份监听叠在同一块 DOM 上 ⇒ 点一次「保存」跑两次。

const PLUGIN_ID = 'jy-tarot';
const API_CONFIG = '/api/config';
const API_SKILLS = '/api/skills';
// 与宿主控制台的普通 API 请求保持同一标记。宿主在未配置 server.token 时
// 不依赖它放行；若宿主配置了真实 token，仍须由宿主控制台负责注入真实凭据。
const CONSOLE_MARKER = 'qq-agent-console';

/**
 * 界面上的两条指令。
 *
 * ⚠️ **`id` 必须与 plugin.json 里 `commands[].id` 完全一致** —— 覆盖表是按 `pluginId + id` 定位的。
 * 这里刻意跟着清单写**显式 id**（清单那边也显式声明了），不再靠"缺省 = word"的兜底：
 *   id 由 word 兜底时，以后一改清单里的 word，id 就跟着变 ⇒ 面板写进去的覆盖行键对不上
 *   ⇒ 改名会"保存成功但不生效"。显式 id 从根上杜绝这件事。
 */
const COMMANDS = [
  { id: '今日塔罗', label: '正式抽牌', hint: '每人每天一次，重复发会重发今天那张' },
  { id: '测塔罗', label: '内部测试通道', hint: '白名单限定，不记账、不限次数' }
];

/** 指令词合法性。与前置设置页的口径一致（面板先拦，插件侧再兜）。 */
const RESERVED_WORDS = ['帮助', 'help', '指令', '权限查询', '查询权限', 'perm'];

function validateWord(word) {
  const w = String(word ?? '').trim();
  if (!w) return '指令词不能为空';
  if (/\s/.test(w)) return '指令词不能包含空格或换行';
  if (w.length > 24) return '指令词太长了（最多 24 个字符）';
  if (/^[\/／]/.test(w)) return '只写词本身，不要带前缀斜杠';
  const lower = w.toLowerCase();
  if (RESERVED_WORDS.some((r) => r.toLowerCase() === lower)) return `「${w}」是前置的元指令保留词，换一个`;
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 当前活动实例的清理函数（模块级，跨重绘保留；bind 开头先调用它）。 */
let activeCleanup = null;
let mountCount = 0;

/** 统一取 JSON；失败抛出可读错误。 */
async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-console-token': CONSOLE_MARKER
    }
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** 判断一个配置对象确实是"整份配置（含 skills 段）"，而不是本插件那一段。 */
function looksFullConfig(v) {
  return !!(v && typeof v === 'object' && v.skills && typeof v.skills === 'object');
}

/**
 * 拿"当前状态"：前置是谁、两条指令的当前有效词、以及整张覆盖表。
 *
 * ⚠️ 优先用 ctx.config()（测试/桩环境会给整份配置）；
 *    真实核心给的只是**本插件那一段**，所以拿不到时要 fetch('/api/config')。
 */
async function loadState(ctx) {
  const out = { gwId: '', prefix: '/', declared: {}, effective: {}, overrides: [], configLoaded: false, usedWords: new Map() };
  let skills = [];
  // ⚠️ 两段必须**各自** try/catch：写在一个 try 里的话，ctx.skills() 一抛错
  //    就再也走不到 fetch 兜底，整个面板会误判成"没找到指令前置"（2026-10-11 审计 P1）。
  try {
    skills = (typeof ctx?.skills === 'function' ? ctx.skills() : null) || [];
  } catch { skills = []; }
  if (!skills.length) {
    try { skills = (await getJson(API_SKILLS)).skills || []; } catch { skills = []; }
  }

  const gw = skills.find((s) => {
    const caps = Array.isArray(s?.capabilities) ? s.capabilities : [];
    const impl = Array.isArray(s?.implementedCapabilities) ? s.implementedCapabilities : [];
    return caps.includes('command.dispatch') || impl.includes('command.dispatch');
  });
  if (!gw?.id) return out;
  out.gwId = String(gw.id);
  for (const c of (Array.isArray(gw.commands) ? gw.commands : [])) {
    if (c?.id) out.declared[String(c.id)] = String(c.word ?? '');
  }

  // 覆盖表：先看 ctx.config() 里有没有（桩/某些宿主会给整份配置），否则自己拉整份配置。
  // ⚠️ 只有**确实拿到整份 `skills` 段**才允许整表回写 —— 这里做了形状校验，避免
  //    "拿到的其实只是本插件那一段"时把别人的条目整片清掉（2026-10-11 审计 P1）。
  let skillsCfg = null;
  try {
    const c = (typeof ctx?.config === 'function' ? ctx.config() : null);
    if (looksFullConfig(c) && c.skills[out.gwId]) { skillsCfg = c.skills; out.configLoaded = true; }
  } catch { /* 走下面的 fetch */ }
  if (!skillsCfg) {
    try {
      const all = await getJson(API_CONFIG);
      if (looksFullConfig(all) && all.skills[out.gwId]) { skillsCfg = all.skills; out.configLoaded = true; }
    } catch { /* 读不到就保持 configLoaded=false ⇒ 保存时会拒绝写 */ }
  }
  const seg = skillsCfg ? skillsCfg[out.gwId] : null;
  out.overrides = Array.isArray(seg?.overrides) ? seg.overrides : [];
  // 指令前缀也是前置的可配置项（默认 `/`，可以改成 `!`）——
  // ⚠️ 别硬编码成 `/`，否则用户改过前缀后面板会显示错误的命令（显示 `/抽牌` 而实际要打 `!抽牌`）。
  const pfx = String(seg?.prefix ?? '').trim();
  if (pfx && !/\s/.test(pfx)) out.prefix = pfx;

  for (const c of COMMANDS) {
    const ov = out.overrides.find((o) => o?.pluginId === PLUGIN_ID && String(o.id) === c.id) || null;
    const w = String(ov?.word ?? '').trim();
    const decl = out.declared[c.id] || c.id;
    out.effective[c.id] = w || decl;
  }

  // 「**别的**插件当前生效的指令词」——用来拦"撞了别人的指令词"。
  // ⚠️ 两个要点：
  //   ① 必须排除**本插件自己**的指令，否则保存时会把"我自己原有的词"当成"被别人占用"
  //      （我第一版就栽在这：点保存直接报"「今日塔罗」已被占用"）。
  //   ② 前置的匹配是 `routes.find(...)` + `toLowerCase()` 等值比较 ⇒ 一旦撞词，
  //      **目录里靠前的那条永远胜出**、后面的永远不可达。所以必须跟**全部**生效词比，
  //      不能只跟本次表单里的两条比。
  const ovAll = out.overrides;
  for (const s of skills) {
    const sid = String(s?.id || '');
    if (sid === PLUGIN_ID) continue;                    // ← 关键：跳掉自己
    for (const c of (Array.isArray(s?.commands) ? s.commands : [])) {
      const cid = String(c?.id ?? '');
      if (!cid) continue;
      const ov = ovAll.find((o) => String(o?.pluginId) === sid && String(o?.id) === cid) || null;
      const w = String(ov?.word ?? '').trim() || String(c?.word ?? '').trim();
      if (!w) continue;
      const key = w.toLowerCase();
      if (!out.usedWords.has(key)) out.usedWords.set(key, { pluginId: sid, id: cid, word: w });
    }
  }
  return out;
}

/**
 * 把指令词写进「指令前置」的覆盖表。
 *
 * 流程（顺序别改）：读到的快照 → 按"生效词有没有变"过滤 → 写回前重读一次拿最新表 →
 * 以最新表为底重放本插件的词 → POST → **回读校验**（本插件的词写对了吗、别人的条目一字未动吗）。
 *
 * @param {object} ctx
 * @param {{gwId:string, overrides:Array, configLoaded:boolean, effective:object}} state  loadState() 的结果
 * @param {Record<string,string>} desiredById  cmdId → 想要的词
 *        （空串表示"用回声明的词"；本函数**永不删除**覆盖条目，理由见下面那段注释）
 * @returns {Promise<{changed:boolean}>} changed=false 表示**一个字节都没写**
 *          （调用方据此区分"已保存"与"没有改动"，别一律报成功）
 */
async function writeGatewayWords(ctx, state, desiredById) {
  const gwId = state?.gwId;
  if (!gwId) throw new Error('没认出「指令前置」插件，无法写指令词');
  // 🔴 硬保护：读不到旧覆盖表就绝不整体写回，否则会把别的插件的条目全抹掉
  if (!state.configLoaded) throw new Error('读不到当前覆盖表（/api/config 失败），为安全起见拒绝写入');

  const prev = Array.isArray(state.overrides) ? state.overrides : [];

  // ★ 先按"**生效词是否变化**"过滤 —— 这条定义了"什么算改动"。
  //   只比覆盖表字节的话，"用户什么都没动、但表里本来没有本插件的行"也会被当成改动，
  //   于是面板会说"已保存，立刻生效"，而用户眼里什么都没变（2026-10-11 审计的 P0-2）。
  //   用户看到的是生效词，所以判据也用生效词。
  const effectiveNow = (state && state.effective) ? state.effective : {};
  const desiredFiltered = {};
  for (const [id, word] of Object.entries(desiredById)) {   // 遍历"想写的"
    const w = String(word ?? '').trim();
    const before = String(effectiveNow[id] ?? '').trim();
    if (w !== before) desiredFiltered[id] = w;
  }
  if (!Object.keys(desiredFiltered).length) return { changed: false };

  // ★ 乐观锁：写回前**再读一次**，拿最新表当底（别人的条目原样保留），再把本插件的词重放上去。
  //
  //   ⚠️⚠️ 2026-10-11 我自己踩的坑（务必别改回去）：
  //     最初写成 `if (最新表 !== 快照) { 以最新表为底重新合并 }` —— 那样在"没人并发改"的
  //     **正常情况**下会走 else，底表保持最初的快照，于是"以最新表为底"这一步根本没做、
  //     合并结果里**只剩别人的条目**，本插件要写的词全丢 ⇒ 保存静默无效（提示"没有改动"）。
  //     正确做法是**无条件**以最新表为底重新合并（合并本身是幂等的）。
  //
  //   ⚠️ 另注：这里刻意**不写** "next === prev 就提前返回" 的短路分支。
  //     那个条件与下面 payload === prev 完全等价（base 取快照或取最新表时都一样），
  //     留着只会多一份需要同步维护的合并逻辑 —— 本项目因此差点漏掉一次保存失败。
  let base = prev;
  try {
    const fresh = await getJson(API_CONFIG);
    const freshOv = fresh?.skills?.[gwId]?.overrides;
    if (Array.isArray(freshOv)) base = freshOv;
  } catch { /* 读不到最新表就按原快照写（原来是这么做的，不更差） */ }

  const othersFinal = [];
  const byIdFinal = new Map();
  for (const o of base) {
    if (o?.pluginId === PLUGIN_ID) byIdFinal.set(String(o.id), { ...o });
    else othersFinal.push(o);
  }
  for (const [id, word] of Object.entries(desiredFiltered)) {
    const w = String(word ?? '').trim();
    // 空词也照样写进去（统一口径：**永不删除覆盖条目**）。
    // 这样"清空输入框/恢复默认"永远只是把词变成声明的值，语义稳定、可预测。
    //
    // ⚠️ 2026-10-11 审计更正：早先这里的注释说"删掉覆盖行 = 停用该指令"，
    //    那是**指令装扮**的语义（它在清单里声明 `__cd_off_slot-*__` 这种占位词，
    //    "没有覆盖行 ⇒ 用占位词 ⇒ 等于停用"）。本插件的声明词是**真词**，
    //    前置的合并规则是 `word: ov?.word || decl.word`、`enabled: (ov ? ov.enabled !== false : true)`
    //    ⇒ **删掉覆盖行只会回到声明词，不会停用**（前置的 `random` 槽位基线里就没有覆盖行，照样可用）。
    //    所以"不删条目"对本插件**不是必须的**，保留它只是因为语义更稳（不产生无词残行）。
    const cur = byIdFinal.get(id);
    if (cur) cur.word = w;
    else byIdFinal.set(id, { pluginId: PLUGIN_ID, id, word: w });
  }
  const payload = [...othersFinal, ...[...byIdFinal.values()]];
  if (JSON.stringify(payload) === JSON.stringify(prev)) return { changed: false };

  // ⚠️ 回读校验要拿**最终载荷里**的"别人的条目"来比（乐观锁可能换过底表）
  const othersInPayload = payload.filter((o) => o?.pluginId !== PLUGIN_ID);

  const res = await fetch(`/api/skills/${encodeURIComponent(gwId)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER
    },
    body: JSON.stringify({ settings: { overrides: payload } })
  });
  if (!res.ok) throw new Error(`保存失败：HTTP ${res.status}`);
  const resp = await res.json();

  // 回读校验：核心会把写回后的设置视图一起返回（`settings`）—— 用它验最可靠，
  // 不依赖"下一次拉配置"的时机（那正是注释里踩过的坑）。
  const wrote = Array.isArray(resp?.settings?.overrides) ? resp.settings.overrides : null;
  if (!wrote) throw new Error('核心没有返回写回后的覆盖表，无法确认是否成功');
  const mine = wrote.filter((o) => o?.pluginId === PLUGIN_ID);
  for (const [id, word] of Object.entries(desiredFiltered)) {
    const w = String(word ?? '').trim();
    const got = mine.find((o) => String(o.id) === id);
    const gotWord = got ? String(got.word ?? '').trim() : '';
    if (!got) throw new Error(`写回校验失败：${id} 的覆盖条目没写进去`);
    if (gotWord !== w) throw new Error(`写回校验失败：${id} 期望「${w}」实际「${gotWord}」`);
  }
  // 别人插件的条目必须**一字不差**地保留（只比数量不够：同数量但内容被改也验不出来）
  const othersAfter = wrote.filter((o) => o?.pluginId !== PLUGIN_ID);
  if (JSON.stringify(othersAfter) !== JSON.stringify(othersInPayload)) {
    throw new Error(
      `写回校验失败：其它插件的覆盖条目被改动了（写前 ${othersInPayload.length} 条 → 写后 ${othersAfter.length} 条）`
    );
  }

  // 把"盘上确认生效的词"带回去，让调用方能把界面校正到真实状态。
  // ⚠️ 为什么必须做这件事（2026-10-11 我自己漏掉的一半）：
  //   用户在写到一半时又改了输入框、那次点击被在途保护挡下 —— 此时**界面显示 A、盘上是 B**。
  //   只"不静默吞"是不够的：界面必须回到**盘上真实的值**，否则用户以为 A 生效了。
  const confirmed = {};
  for (const [id] of Object.entries(desiredFiltered)) {
    const got = mine.find((o) => String(o.id) === id);
    confirmed[id] = got ? String(got.word ?? '').trim() : '';
  }
  return { changed: true, confirmed };
}

/** 渲染这块分区。async 是允许的（核心会 await）。 */
export async function render(ctx) {
  const st = await loadState(ctx);
  const prefix = st.prefix;                       // 用前置实际配置的前缀，不硬编码
  const noGw = st.gwId ? '' : `
    <div class="hint" style="color:#e0a030">
      ⚠️ 没找到「指令前置」插件（没有任何插件提供 <code>command.dispatch</code>）—— 改名暂时不可用。
    </div>`;
  const noCfg = (st.gwId && !st.configLoaded) ? `
    <div class="hint" style="color:#e0a030">
      ⚠️ 读不到当前覆盖表，保存会被拒绝（避免误删其它插件的配置）。请刷新页面重试。
    </div>` : '';

  const rows = COMMANDS.map((c) => {
    const cur = st.effective[c.id] || c.id;
    const decl = st.declared[c.id] || c.id;
    const custom = cur !== decl;
    return `
      <div class="field">
        <label>${esc(c.label)} <span class="muted">（${esc(c.hint)}）</span></label>
        <input class="jt-word" data-cmd-id="${esc(c.id)}" value="${esc(cur)}" placeholder="如 今日塔罗" />
        <div class="hint">
          现在群里发 <code>${esc(prefix + cur)}</code>
          ${custom ? ' · <b>已自定义</b>' : ' · 用的是插件声明的默认值'}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="plugin-section" data-plugin="${esc(PLUGIN_ID)}">
      <h3>今日塔罗</h3>
      <div class="hint" style="margin-bottom:10px">
        改指令词后<b>立刻生效</b>（写进「指令前置」的覆盖表，前置每次分发都现读配置），
        不需要重启、也不需要重载插件。
        <br />清空 = 用回插件声明的默认词（<b>指令仍然启用</b>，不会被停用）；点「恢复默认」同理。
      </div>
      ${noGw}${noCfg}
      <div id="jt-flash" class="hint" style="min-height:18px"></div>
      ${rows}
      <div style="margin-top:12px">
        <button class="btn" type="button" id="jt-save">保存指令词</button>
        <button class="btn btn-small" type="button" id="jt-reset" style="margin-left:8px">恢复默认</button>
      </div>
      <div class="hint" style="margin-top:14px">
        「每人每日抽取上限 / 测试通道白名单 / 拒绝回执文案」在<b>扩展详情页</b>的
        「今日塔罗 → 设置」里改（那三项是本插件自己的配置，与指令词不是一回事）。
      </div>
    </div>`;
}

/** 绑定事件；返回清理函数。 */
export function bind(root, ctx) {
  // ① 先拆上一次挂载留下的监听（核心会把插件设置页挂载两次）
  if (typeof activeCleanup === 'function') {
    try { activeCleanup(); } catch { /* 旧实例可能已随 DOM 消失 */ }
  }
  activeCleanup = null;
  try { root.dataset.jtInstance = String(++mountCount); } catch { /* 非浏览器环境忽略 */ }

  const flash = root.querySelector('#jt-flash');
  const setFlash = (msg, kind) => {
    if (!flash) return;
    flash.textContent = String(msg || '');
    flash.style.color = kind === 'bad' ? '#e06c6c' : (kind === 'ok' ? '#6cc48a' : '');
  };

  // ★ 在途保护：连点「保存」不能产生交错写。
  //   为什么这条对本面板特别重要：写回的是**整张覆盖表**（连带别人的条目一起回写），
  //   两次并发写各自基于自己那次读到的快照 ⇒ 后写会覆盖先写的效果。
  //
  //   ⚠️ 2026-10-11 审计修过一版：最早写成 `if (busy) return;` —— 那是**静默吞点击**，
  //      而且因为提示没被改动，用户会看到界面上是新词、落盘却是旧词、提示还说"已保存"。
  //      现在改成：**明确告诉用户"上一次还没完成"**，绝不再静默吞。
  let busy = false;
  const setBusy = (b) => {
    busy = b;
    // 按钮保持可点击，让在途点击能进入上面的保护分支并得到明确反馈；
    // 仅用 aria-busy 表示状态，真正的互斥由 busy 闸负责。
    for (const sel of ['#jt-save', '#jt-reset']) {
      const el = root.querySelector(sel);
      if (el) {
        el.disabled = false;
        el.setAttribute('aria-busy', String(b));
      }
    }
  };

  /**
   * 把界面输入收成补丁 + 校验。
   * @param {object} st loadState() 的结果（用来做"跨插件撞词"检查）
   */
  const collect = (st) => {
    const desired = {};
    const problems = [];
    const seen = new Map();
    const used = (st && st.usedWords instanceof Map) ? st.usedWords : new Map();
    for (const input of [...root.querySelectorAll('.jt-word')]) {
      const id = String(input.dataset.cmdId || '');
      const w = String(input.value || '').trim();
      const bad = validateWord(w);
      if (bad) { problems.push(`${id}：${bad}`); continue; }
      const key = w.toLowerCase();
      if (seen.has(key)) { problems.push(`指令词「${w}」重复（${seen.get(key)} 与 ${id}）`); continue; }
      seen.set(key, id);
      // 撞了**别的插件**的生效指令词 ⇒ 前置靠前者胜，撞的那条会不可达
      // （used 表里已经排除了本插件自己，所以这里命中就是真撞别人的）
      const owner = used.get(key);
      if (owner) {
        problems.push(`指令词「${w}」已被 ${owner.pluginId} 的「${owner.word}」占用，换一个（撞词会让其中一条永远触发不到）`);
        continue;
      }
      desired[id] = w;
    }
    return { desired, problems };
  };

  const onSave = async (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (busy) { setFlash('上一次保存还没完成，请稍候…', 'bad'); return; }   // 明确提示，不静默吞
    setBusy(true);
    try {
      setFlash('正在保存…');
      const st = await loadState(ctx);                 // 每次现读，避免用到过期快照
      const { desired, problems } = collect(st);
      if (problems.length) { setFlash(problems.join('；'), 'bad'); return; }
      const r = await writeGatewayWords(ctx, st, desired);
      // ⚠️ 区分"真写了"与"本来就没变化"：没写却报"已保存，立刻生效"是**说假话**，
      //    用户会以为那次改动生效了。（2026-10-11 审计报的 P0）
      setFlash(r.changed ? '已保存，立刻生效 ✅' : '没有改动（已是这个值）', r.changed ? 'ok' : '');
      if (r.changed) { try { ctx?.reload?.(); } catch { /* 重载失败不影响已保存的结果 */ } }
      // ★ 把界面校正到**盘上确认生效的值**：写的过程中用户可能又改了输入框（那次点击被在途保护挡下），
      //   不校正的话界面会停在"没生效的那个词"上 ⇒ 用户以为它生效了。
      //   ⚠️ 这一步必须在 finally（setBusy(false)）**之后**做——否则用户没法再点保存。
      if (r.changed && r.confirmed) {
        setTimeout(() => {
          try {
            let corrected = false;
            for (const inp of [...root.querySelectorAll('.jt-word')]) {
              const id = String(inp.dataset.cmdId || '');
              if (Object.prototype.hasOwnProperty.call(r.confirmed, id) && inp.value !== r.confirmed[id]) {
                inp.value = r.confirmed[id];
                corrected = true;
              }
            }
            // 只在"真被校正过"时才多这一句 —— 否则每次保存都刷一句，反而变噪音
            if (corrected) setFlash('已保存；输入框已按【盘上实际生效的值】校正（保存期间你又改过，那次没有保存）', 'ok');
          } catch { /* 界面校正失败不影响已保存的结果 */ }
        }, 0);
      }
    } catch (err) {
      setFlash(`保存失败：${String(err?.message ?? err).slice(0, 150)}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const onReset = async (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (busy) { setFlash('上一次操作还没完成，请稍候…', 'bad'); return; }   // 明确提示，不静默吞
    setBusy(true);
    try {
      setFlash('正在恢复…');
      const st = await loadState(ctx);
      // 恢复默认 = 把两条都写回**插件声明的词**。
      // （删掉覆盖条目也能回到声明词 —— 对"真词"插件删条目不会停用；
      //   这里选"写词"只是让覆盖表不留无词残行、语义更稳。）
      const desired = {};
      for (const c of COMMANDS) desired[c.id] = st.declared[c.id] || c.id;
      for (const inp of [...root.querySelectorAll('.jt-word')]) {
        const id = String(inp.dataset.cmdId || '');
        if (desired[id] != null) inp.value = desired[id];      // 界面也跟着回默认
      }
      const r = await writeGatewayWords(ctx, st, desired);
      setFlash(r.changed ? '已恢复默认 ✅' : '本来就是默认值', r.changed ? 'ok' : '');
      if (r.changed) { try { ctx?.reload?.(); } catch { /* 同上 */ } }
    } catch (err) {
      setFlash(`恢复失败：${String(err?.message ?? err).slice(0, 150)}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const btnSave = root.querySelector('#jt-save');
  const btnReset = root.querySelector('#jt-reset');
  if (btnSave) btnSave.addEventListener('click', onSave);
  if (btnReset) btnReset.addEventListener('click', onReset);

  activeCleanup = () => {
    if (btnSave) btnSave.removeEventListener('click', onSave);
    if (btnReset) btnReset.removeEventListener('click', onReset);
  };
  return activeCleanup;
}

/** 核心的自动保存会调这个；返回 null = 本面板自己管保存。 */
export function read() {
  return null;
}

/**
 * 仅供自动化测试观察内部状态（生产代码不调用它）。
 * 之所以导出：面板的行为依赖"读到的状态 + 表单值 + 合并结果"三者，
 * 出问题时只看 flash 文案根本分不清是哪一层——本项目为这个坑浪费过好几轮。
 */
export async function __debugState(ctx) {
  const st = await loadState(ctx);
  return {
    gwId: st.gwId,
    prefix: st.prefix,
    configLoaded: st.configLoaded,
    overridesLen: st.overrides.length,
    declared: st.declared,
    effective: st.effective,
    usedWords: [...st.usedWords.entries()]
  };
}
