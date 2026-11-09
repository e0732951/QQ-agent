// 今日塔罗 v3.0 —— 大阿卡纳（主题）+ 小阿卡纳（事件）+ 宫廷牌（另一维度），加一条独立的抽签解读通道。
//
// ── v3 相对 v2 的变化（一句话）────────────────────────────────────────────
//   v2：两牌（大阿卡纳 = 主题、小阿卡纳 = 事件）+ 四领域；/抽签解读 出第二张图。
//   v3：**加第三张宫廷牌**（16 张：4 花色 × 侍从/骑士/王后/国王），它不替代大小阿卡纳，
//       而是在同一张图一里作为"另一维度的信息"多出一块含义；图一仍是"只给牌面与含义、不给建议"。
//       /抽签解读 的版面**一个字都不动**，只在「最终建议」块末尾多一段「宫廷指引」。
//       数据表从 4 张变 5 张（新增 data/data-court.json），素材新增 32 张 jyt-court-*.jpg。
//
// ── 必须守住的四条不变量（都是实测踩出来的，别凭直觉改）──────────────────
//   1) 出图用宿主进程里的 Electron 隐藏窗口渲染 HTML → capturePage().toPNG()。
//      ⚠️ **必须复用一个窗口**：实测每次新建 BrowserWindow，第二次就 ERR_FAILED，
//         进程直接崩（crashpad not connected）。复用时首张 ~350ms、之后 ~200-350ms。
//   2) 渲染窗口**只建一次、永不销毁**（引用挂在 globalThis，跨模块实例共用）。
//      热重载时旧实例 deactivate 不能销毁窗口，否则新实例建不出窗口、功能全废。
//   3) 截图前**必须校验 img.naturalWidth > 0** —— 只看"没抛错"会得到全空白图（假绿）。
//   4) "读账本 → 判定 → 抽牌 → 记账 → 落盘"必须是**没有 await 的同步临界区**：
//      指令前置只按 chatKey 串行，跨群是并发的；中间一旦 await，后写者会把先写者整条覆盖
//      （v1 实测 6 人并发 7 条记录只剩 2 条）。渲染必须放在记账之后。
//
//   v3 新增第五条（只跟版面有关）：**页宽由 builder 返回、渲染层照抄**。
//      图一 1500 / 图二 1180 是两套宽度；body 宽度与 setContentSize/capturePage 的宽度
//      只要差 1px，截图就会切边或垫黑边。所以别在渲染层硬编码宽度。
//
// ── 随机性 ───────────────────────────────────────────────────────────────
//   全部用种子派生：mulberry32(hash(本地日期|QQ|第n次|用途))。
//   同一个人当天结果**恒定**：重启、热重载、反复查询都不跳牌；
//   大阿卡纳 / 小阿卡纳 / 宫廷牌 / 抽签 / action 各自独立取种子，所以"先抽牌还是先抽签"
//   不影响结果，也不会因为多抽一张宫廷牌而把大小阿卡纳洗牌。
//   否则 /抽签解读 可以被反复发送刷到"大吉"，签就没意义了。
//
// ── 时间与账本 ───────────────────────────────────────────────────────────
//   日期一律按**本地时间**算（用户说的"今天"是本地今天），不用 UTC 日期切片。
//   ⚠️ v2 的旧记录（没有 court 字段）**一律判为"今天没抽过"**，与 v2 处理 v1 记录同口径；
//      seq 仍然保留（它是种子的熵来源，连它一起归零会让重启后抽到同一张牌）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildTarotHtml, buildLuckHtml,
  majorAssetName, minorAssetName, courtAssetName, luckAssetName,
  TAROT_WIDTH, LUCK_WIDTH, pageCss
} from './lib/tarot-page.mjs';

/** 清单里的版本号必须与这里一致（打包前用脚本断言，见协议八·4）。 */
export const PLUGIN_VERSION = '3.0.0';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets');
const DATA_DIR = path.join(PLUGIN_DIR, 'data');

/**
 * 数据表：**随插件发布的只读资源**，放在插件目录里，用 fs 直接读。
 *
 * ⚠️ 这里**不能**走 api.storage —— 那是给"运行期可变数据"用的沙箱，它会把相对路径
 *    解析到 `data/command_data/<插件id>/` 下面。所以 `storage.readJson('data/x.json')`
 *    实际找的是 `data/command_data/jy-tarot/data/x.json`，永远读不到，
 *    available() 返回 false ⇒ 插件显示"已开未激活"、指令完全不派发（实测踩过）。
 *    数据表与 assets/ 同性质（只读、随插件版本走），所以和素材一样用 fs 读、并做白名单式访问。
 */
const DATA_FILES = {
  major: 'data-major.json',
  minor: 'data-minor.json',
  court: 'data-court.json',      // v3 新增：宫廷牌 16 张
  luck: 'data-luck.json',
  combo: 'data-combo.json'
};

const TAROT_PER_DAY_DEFAULT = 1;
const RENDER_TIMEOUT_MS = 20000;
// 排队也要有上限，避免 60s 的网关超时后仍迟到发图；为渲染与 sender 发送预留时间。
const QUEUE_WAIT_MS = 25000;
const MAJOR_COUNT = 22;
const MINOR_COUNT = 20;
/** v3：宫廷牌 4 花色 × 侍从/骑士/王后/国王 */
const COURT_COUNT = 16;
const COURT_SUITS = ['wands', 'cups', 'swords', 'pentacles'];
const COURT_RANKS = ['page', 'knight', 'queen', 'king'];
/** 窗口初始宽度取两页里更宽的那个（之后每次渲染都按页面自己的宽度重设） */
const INITIAL_WINDOW_WIDTH = Math.max(TAROT_WIDTH, LUCK_WIDTH);
/** 页面内等待图片解码的超时（图片既不 onload 也不 onerror 时必须能脱身） */
const IMG_WAIT_MS = 8000;
/** 每人每日抽取上限的硬上限（必须与 plugin.json 的 configSchema.dailyLimit.max 一致） */
const MAX_DAILY_LIMIT = 9;
/**
 * history 每人保留**条数**（不是天数：dailyLimit>1 时一天可以写好几条）。
 *
 * ⚠️ 为什么不做成"按 30 天裁剪"：那样每人最多 9 条/天 × 30 天 = 270 条，
 *    乘以群人数会顶到 plugin-loader 给插件的 storage 8MB 单文件上限。
 *    30 条是旧实现的既有口径，这里只是把名字/注释改对，**行为一个字都不改**。
 */
const HISTORY_MAX_ENTRIES = 30;
/** 未抽塔罗就发 /抽签解读 时的回执（用户指定文案；面板可改） */
const NEED_TAROT_TEXT = '抽取塔罗后才可抽签解读哦';
/**
 * 图一的四领域行（爱情/事业/财运/健康）。
 * ⚠️ 这四项**只出现在图一**。图二（抽签解读）刻意只出抽到的**那一个**领域 ——
 *    图二定位是"针对主题+事件给一条建议"，四条并列会冲淡重点（用户明确这么定的）。
 */
const DOMAIN_ATTRS = [
  ['爱情', 'love'],
  ['事业', 'career'],
  ['财运', 'money'],
  ['健康', 'health']
];
/**
 * 测试通道的**临时账本**：测试抽牌专用，与正式账本完全隔离。
 *
 * 三条设计（都是踩出来的，别改回去）：
 *   1) **只有一条，每次 /测塔罗 覆盖**（用户要求）—— 不做历史、不做累加。
 *   2) **按 QQ 分开存**：`{ byQq: { <qq>: entry } }`，但**每人仍然只有一条**。
 *      为什么不能全局就一条：群里两个人同时测，后测的人会把先测的人的牌顶掉，
 *      于是先测那人发 /测抽签 会拿到**别人的牌**（实测复现过），非常难解释。
 *      按 QQ 分开放之后，"覆盖"的语义变成"每人各自覆盖自己的那一条"。
 *   3) **必须落盘**（api.storage），不能只放内存！
 *      内存版实测被坑：插件热重载会重新 import 模块、内存状态归零，
 *      于是"刚 /测塔罗 过，一发 /测抽签 就说没抽过牌"—— 开发期我每改一次代码
 *      就触发一次热重载，用户的测试牌就被清一次。落盘后重载/重启都不丢。
 *      ⚠️ 仍然与正式账本**分开两个文件**，正式通道永远不会读到它。
 *
 * v3：宫廷牌按 idx 一并存下（与 minor 同口径：存序号而不是 id，
 *     这样以后改数据表里的 id 也不会让刚测过的牌失效）。
 * 过期：30 分钟没有新的测试抽牌就视为没有（避免很久以前的牌一直被用）。
 */
const TEST_LEDGER_FILE = 'test-draws.json';
const TEST_LEDGER_TTL_MS = 30 * 60 * 1000;
const TEST_LEDGER_MAX_Q = 50;        // 最多记 50 个人的测试牌，超了丢最旧的
let testLedgerCache = undefined;     // undefined = 还没读；对象 = 已读并缓存

/** 读临时账本（带缓存；落盘，跨热重载不丢）。 */
function loadTestLedger() {
  // ⚠️ 判据必须是"已经是个对象"，不能写成 `!== undefined && !== null`：
  //    那个写法在首次读取失败（缓存被设成 { byQq: {} }）后**每次都会重新读盘**，
  //    读盘本身又会失败又 warn —— 变成每次调用都刷一条警告。对象判断一次就短路。
  if (testLedgerCache && typeof testLedgerCache === 'object') return testLedgerCache;
  try {
    const raw = api?.storage?.readJson?.(TEST_LEDGER_FILE, null);
    testLedgerCache = (raw && typeof raw === 'object' && raw.byQq && typeof raw.byQq === 'object')
      ? { byQq: raw.byQq }
      : { byQq: {} };
  } catch (error) {
    warn('塔罗：读临时账本失败 →', String(error?.message ?? error).slice(0, 100));
    testLedgerCache = { byQq: {} };
  }
  return testLedgerCache;
}

/** 存临时账本。失败只 warn，不打断测试流程（测试通道不该因为写不进去就整条挂掉）。 */
function saveTestLedger(ledger) {
  testLedgerCache = ledger;
  try {
    const st = api?.storage;
    if (!st || typeof st.writeJson !== 'function') return false;
    st.writeJson(TEST_LEDGER_FILE, ledger);
    return true;
  } catch (error) {
    warn('塔罗：写临时账本失败 →', String(error?.message ?? error).slice(0, 100));
    return false;
  }
}

/**
 * 覆盖式写入临时账本（**每人只有一条**），顺带清理过期项与超量项。
 * @param {string} qq
 * @param {object} cards { major, minor, court, majorRev, minorRev, courtRev }（牌面对象）
 */
function rememberTestDraw(qq, cards) {
  const key = String(qq || '');
  if (!key) return;
  const ledger = loadTestLedger();
  const now = Date.now();
  // 清过期
  for (const k of Object.keys(ledger.byQq)) {
    const e = ledger.byQq[k];
    if (!e || !Number.isFinite(e.at) || now - e.at > TEST_LEDGER_TTL_MS) delete ledger.byQq[k];
  }
  ledger.byQq[key] = {
    at: now,
    major: cards.major?.id,
    majorRev: !!cards.majorRev,
    minor: cards.minor?.idx,
    minorRev: !!cards.minorRev,
    court: cards.court?.idx,
    courtRev: !!cards.courtRev
  };
  // 超量：丢最旧的
  const keys = Object.keys(ledger.byQq);
  if (keys.length > TEST_LEDGER_MAX_Q) {
    keys.sort((a, b) => (ledger.byQq[a].at || 0) - (ledger.byQq[b].at || 0));
    for (const k of keys.slice(0, keys.length - TEST_LEDGER_MAX_Q)) delete ledger.byQq[k];
  }
  saveTestLedger(ledger);
}

/**
 * 取某人的测试牌，**还原成牌面对象**（与 cardsOf 的返回形状一致，供渲染直接用）。
 * @param {object} data loadData() 的结果
 * @param {string} qq
 * @returns {object|null}
 */
function getTestDraw(data, qq) {
  const ledger = loadTestLedger();
  const e = ledger.byQq[String(qq || '')];
  if (!e) return null;
  if (!Number.isFinite(e.at) || Date.now() - e.at > TEST_LEDGER_TTL_MS) return null;
  const major = data.major[String(e.major)];
  // 小阿卡纳 / 宫廷牌都按序号还原（存 idx 而不是 id，是为了让"数据表改 id 也不失效"）
  let minor = null;
  for (const m of Object.values(data.minor)) {
    if (m.idx === e.minor) { minor = m; break; }
  }
  let court = null;
  for (const c of Object.values(data.court)) {
    if (c.idx === e.court) { court = c; break; }
  }
  // v3：v2 时代的临时账本没有 court ⇒ 视为"没有测试牌"，让用户重新 /测塔罗（比拿旧牌硬渲染好）
  if (!major || !minor || !court) return null;
  return {
    major, minor, court,
    majorRev: !!e.majorRev, minorRev: !!e.minorRev, courtRev: !!e.courtRev
  };
}

/**
 * 渲染世代号：每发起一次渲染 +1。
 * 用来让"超时后仍在后台跑的旧渲染"能自己发现已过时而退出 —— `Promise.race` 输掉
 * 并不会停止 `done`，它会在**共享窗口**上继续 setContentSize/capturePage，
 * 破坏"同一时刻只渲染一张"这条不变量。
 */
let renderGen = 0;

/** 取会话类型（group/private）。网关通常在 payload.chat.kind，兼容 ctx.kind。 */
function kindOf(payload) {
  return String(payload?.chat?.kind || payload?.ctx?.kind || '');
}

let api = null;

// ── 运行期状态（全部放模块级，且在 deactivate/dispose 里显式释放）──
let dataMajor = null;            // data-major.json
let dataMinor = null;
let dataCourt = null;            // v3：data-court.json
let dataLuck = null;
let dataCombo = null;
let dataError = '';              // 数据表读取失败原因（自检用）
let assetsCache = null;          // 素材文件名清单（启动时扫一次，避免每次渲染都 readdir）
let assetsError = '';
let httpServer = null;           // 本地渲染服务
let httpPort = 0;
let renderWindow = null;         // ★ 复用的渲染窗口（真身挂在 globalThis，见 ensureWindow）
let currentHtml = '';
let deactivated = false;         // 停用后拒绝再渲染（避免热重载后旧实例继续开窗口）
let lifecycle = 0;               // 让关/开之前排队的请求不能在重新启用后复活
let activeRenders = 0;           // 已开始的渲染完成后再关闭其 HTTP 服务
let lastConfigError = '';

const health = {
  startedAt: Date.now(),
  draws: 0,             // 正式通道（/塔罗）调用次数，含重复查询
  luckDraws: 0,         // 正式通道（/抽签解读）调用次数
  testDraws: 0,         // 测试通道（/测塔罗 /测抽签）次数，不记账
  rendered: 0,          // 成功渲染张数
  renderFails: 0,
  blankImages: 0,       // 渲染出来了但图没加载（假绿拦截计数）
  ledgerReadFails: 0,
  ledgerWriteFails: 0,
  legacyDropped: 0,     // v3：因缺 court 被丢弃的 v2 记录数（可观测性：别静默丢）
  renderTimeouts: 0,
  lastError: '',
  lastRenderMs: 0
};

// ── 配置 ──────────────────────────────────────────────────────────────
function conf() {
  try {
    const c = api?.config?.();
    return (c && typeof c === 'object') ? c : {};
  } catch (error) {
    lastConfigError = String(error?.message ?? error).slice(0, 120);
    return {};
  }
}
function log(...args) { try { api?.log?.(...args); } catch { /* 日志失败不影响主流程 */ } }
function warn(...args) { try { api?.warn?.(...args); } catch { /* 同上 */ } }

/** 解析逗号/换行/空格分隔的 ID 列表。 */
function parseIds(raw) {
  return String(raw ?? '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,12}$/.test(s));
}

/** 按本地时间取日期键。 */
function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 版面右上角那天：2026-10-15 周三 */
function todayText(d = new Date()) {
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${localDayKey(d)} ${w}`;
}

// ── 数据表 ────────────────────────────────────────────────────────────
/**
 * 读一张数据表并做结构自检。
 *
 * 用 fs 从**插件目录**读（理由见上面 DATA_FILES 处的注释）；文件名来自代码里的白名单常量，
 * 不接受任何外部输入，所以没有路径穿越面。
 */
function readData(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (error) {
    throw new Error(`${name} 读取失败：${String(error?.message ?? error).slice(0, 100)}`);
  }
}

function loadData() {
  if (dataMajor && dataMinor && dataCourt && dataLuck && dataCombo) {
    return { major: dataMajor, minor: dataMinor, court: dataCourt, luck: dataLuck, combo: dataCombo };
  }
  const missing = [];
  try {
    const major = readData(DATA_FILES.major);
    if (!major || typeof major !== 'object') throw new Error('不是对象');
    for (let i = 0; i < MAJOR_COUNT; i++) {
      const c = major[String(i)];
      if (!c) { missing.push(`大阿卡纳第 ${i} 张缺失`); continue; }
      for (const side of ['up', 'rev']) {
        if (!c[side] || typeof c[side] !== 'object') { missing.push(`第 ${i} 张缺 ${side}`); continue; }
        for (const k of ['theme', 'lesson', 'advice', 'love', 'career', 'money', 'health',
          'relationship', 'family', 'emotion', 'mind']) {
          if (!String(c[side][k] ?? '').trim()) missing.push(`${c.cn || i} 的 ${side}.${k} 为空`);
        }
      }
    }
    const minor = readData(DATA_FILES.minor);
    if (!minor || typeof minor !== 'object') throw new Error('小阿卡纳不是对象');
    const minorIds = Object.keys(minor);
    if (minorIds.length !== MINOR_COUNT) missing.push(`小阿卡纳应有 ${MINOR_COUNT} 条，实际 ${minorIds.length}`);
    const idxSeen = new Set();
    for (const [id, m] of Object.entries(minor)) {
      if (!m || typeof m !== 'object') { missing.push(`小阿卡纳 ${id} 不是对象`); continue; }
      if (!Number.isInteger(m.idx) || m.idx < 1 || m.idx > MINOR_COUNT) missing.push(`${id} 的 idx 非法`);
      if (idxSeen.has(m.idx)) missing.push(`小阿卡纳序号 ${m.idx} 重复`);
      idxSeen.add(m.idx);
      for (const side of ['up', 'rev']) {
        if (!String(m[side]?.event ?? '').trim()) missing.push(`${id} 缺 ${side}.event`);
      }
      if (!m.suit || !m.point) missing.push(`${id} 缺 suit/point`);
    }
    // v3：宫廷牌表（16 张，正逆各要 core + meaning）
    const court = readData(DATA_FILES.court);
    if (!court || typeof court !== 'object') throw new Error('宫廷牌表不是对象');
    const courtIds = Object.keys(court);
    if (courtIds.length !== COURT_COUNT) missing.push(`宫廷牌应有 ${COURT_COUNT} 张，实际 ${courtIds.length}`);
    const courtIdxSeen = new Set();
    for (const [id, c] of Object.entries(court)) {
      if (!c || typeof c !== 'object') { missing.push(`宫廷牌 ${id} 不是对象`); continue; }
      if (!Number.isInteger(c.idx) || c.idx < 1 || c.idx > COURT_COUNT) missing.push(`宫廷牌 ${id} 的 idx 非法`);
      if (courtIdxSeen.has(c.idx)) missing.push(`宫廷牌序号 ${c.idx} 重复`);
      courtIdxSeen.add(c.idx);
      if (!String(c.cn ?? '').trim()) missing.push(`宫廷牌 ${id} 缺 cn`);
      if (!COURT_SUITS.includes(c.suit)) missing.push(`宫廷牌 ${id} 的 suit 非法`);
      if (!COURT_RANKS.includes(c.rank)) missing.push(`宫廷牌 ${id} 的 rank 非法`);
      for (const side of ['up', 'rev']) {
        if (!String(c[side]?.core ?? '').trim()) missing.push(`宫廷牌 ${id} 缺 ${side}.core`);
        if (!String(c[side]?.meaning ?? '').trim()) missing.push(`宫廷牌 ${id} 缺 ${side}.meaning`);
      }
    }
    const luck = readData(DATA_FILES.luck);
    if (!luck || typeof luck !== 'object') throw new Error('幸运值表不是对象');
    const luckNames = Object.keys(luck);
    if (luckNames.length !== 5) missing.push(`幸运值应有 5 档，实际 ${luckNames.length}`);
    for (const [name, l] of Object.entries(luck)) {
      if (!Array.isArray(l?.action) || !l.action.length) missing.push(`幸运值「${name}」缺 action 词池`);
      if (!Number.isFinite(Number(l?.level))) missing.push(`幸运值「${name}」缺 level`);
    }
    const combo = readData(DATA_FILES.combo);
    for (const k of ['uu', 'ur', 'ru', 'rr']) {
      if (!String(combo?.templates?.[k] ?? '').trim()) missing.push(`组合模板缺 ${k}`);
    }
    if (missing.length) throw new Error(`数据表不完整：${missing.slice(0, 5).join('；')}`);

    dataMajor = major; dataMinor = minor; dataCourt = court; dataLuck = luck; dataCombo = combo;
    dataError = '';
    return { major, minor, court, luck, combo };
  } catch (error) {
    dataError = String(error?.message ?? error).slice(0, 200);
    warn('塔罗数据表读取失败：', dataError);
    return null;
  }
}

// ── 素材清单（启动扫一次；渲染时只做白名单校验，杜绝路径穿越）──
function loadAssets() {
  if (assetsCache) return assetsCache;
  try {
    const names = fs.readdirSync(ASSETS_DIR).filter((f) => /^jyt-[a-z0-9-]+\.jpg$/.test(f));
    assetsCache = new Set(names);
    assetsError = '';
  } catch (error) {
    assetsError = String(error?.message ?? error).slice(0, 160);
    warn('塔罗素材目录读取失败：', assetsError);
    assetsCache = new Set();
  }
  return assetsCache;
}

/**
 * 逐张核对"数据表要求的素材"是否都在。
 *
 * v3 起 121 张（大 44 + 小 40 + 宫廷 32 + 签 5）。为什么值得做：v3 是"加素材"的版本，
 * 最容易出的安装问题是**只换了 js/json、没换 assets**（或反过来）。那种情况下
 * 每次抽牌都只回一句"图片生成失败"，用户看不出是少文件。
 */
function missingAssets(data, assets) {
  const out = [];
  for (const c of Object.values(data.major)) {
    for (const rev of [false, true]) {
      const name = majorAssetName(c.id, rev);
      if (!assets.has(name)) out.push(name);
    }
  }
  for (const m of Object.values(data.minor)) {
    for (const rev of [false, true]) {
      const name = minorAssetName(m, rev);
      if (!assets.has(name)) out.push(name);
    }
  }
  for (const c of Object.values(data.court)) {
    for (const rev of [false, true]) {
      const name = courtAssetName(c, rev);
      if (!assets.has(name)) out.push(name);
    }
  }
  for (const l of Object.values(data.luck)) {
    const name = luckAssetName(l);
    if (!assets.has(name)) out.push(name);
  }
  return out;
}

// ── 抽取 ──────────────────────────────────────────────────────────────
/** FNV-1a：把种子串压成一个 32 位整数。 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32：确定性伪随机（同种子同序列 ⇒ 重启不跳牌）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 取某个用途的随机源。
 * @param {string} qq
 * @param {number} nth   当天第几次（种子的一部分 —— 必须每次调用都变）
 * @param {string} use   'major' | 'minor' | 'court' | 'luck' | 'action'
 */
function rngFor(qq, nth, use) {
  return mulberry32(hashStr(`${localDayKey()}|${qq}|${nth}|jy-tarot|${use}`));
}

/** 小阿卡纳序号 → id（01..20）。 */
function minorIdByIdx(minor, idx) {
  for (const [id, m] of Object.entries(minor)) if (m.idx === idx) return id;
  return '';
}

/** 宫廷牌序号 → id（01..16）。 */
function courtIdByIdx(court, idx) {
  for (const [id, c] of Object.entries(court)) if (c.idx === idx) return id;
  return '';
}

/**
 * 正式通道抽三张牌（确定性：同人同日同 nth 结果恒定）。
 *
 * ⚠️ 三张牌**各自独立的随机源**：这样加宫廷牌不会把原来的大小阿卡纳洗牌
 *    （同一天同一个人抽到的大小阿卡纳还是原来那两张，只有宫廷牌是新增的）。
 *
 * @param {object} data  loadData() 的结果
 * @param {string} qq
 * @param {number} nth
 */
function drawThree(data, qq, nth) {
  const rMajor = rngFor(qq, nth, 'major');
  const majorId = Math.floor(rMajor() * MAJOR_COUNT);
  const majorRev = rMajor() < 0.5;
  const rMinor = rngFor(qq, nth, 'minor');
  const minorIdx = Math.floor(rMinor() * MINOR_COUNT) + 1;
  const minorRev = rMinor() < 0.5;
  const rCourt = rngFor(qq, nth, 'court');
  const courtIdx = Math.floor(rCourt() * COURT_COUNT) + 1;
  const courtRev = rCourt() < 0.5;
  const minorId = minorIdByIdx(data.minor, minorIdx);
  if (!minorId) throw new Error(`小阿卡纳序号 ${minorIdx} 找不到对应牌`);
  const courtId = courtIdByIdx(data.court, courtIdx);
  if (!courtId) throw new Error(`宫廷牌序号 ${courtIdx} 找不到对应牌`);
  return {
    major: Math.max(0, Math.min(MAJOR_COUNT - 1, majorId)),
    majorRev,
    minor: minorId,
    minorRev,
    court: courtId,
    courtRev
  };
}

/**
 * 测试通道：**纯随机**，只为验证出图与发送，不记账、不可复现。
 * @param {object} data
 * @param {{major?:number, majorRev?:boolean, minor?:number, minorRev?:boolean,
 *          court?:number, courtRev?:boolean}} spec
 *        （major 用 0..21，minor 用序号 1..20，court 用序号 1..16；缺省的那部分随机）
 */
function drawTest(data, spec = {}) {
  const pick = (n) => Math.floor(Math.random() * n);
  const majorId = Number.isInteger(spec.major) ? spec.major : pick(MAJOR_COUNT);
  const majorRev = typeof spec.majorRev === 'boolean' ? spec.majorRev : Math.random() < 0.5;
  let id;
  if (Number.isInteger(spec.minor)) {
    id = minorIdByIdx(data.minor, spec.minor);
    if (!id) throw new Error(`小阿卡纳序号 ${spec.minor} 不存在`);
  } else {
    const ids = Object.keys(data.minor);
    id = ids[pick(ids.length)];
  }
  const minorRev = typeof spec.minorRev === 'boolean' ? spec.minorRev : Math.random() < 0.5;
  let courtId;
  if (Number.isInteger(spec.court)) {
    courtId = courtIdByIdx(data.court, spec.court);
    if (!courtId) throw new Error(`宫廷牌序号 ${spec.court} 不存在`);
  } else {
    const ids2 = Object.keys(data.court);
    courtId = ids2[pick(ids2.length)];
  }
  const courtRev = typeof spec.courtRev === 'boolean' ? spec.courtRev : Math.random() < 0.5;
  return { major: majorId, majorRev, minor: id, minorRev, court: courtId, courtRev };
}

/**
 * 抽签：档位 + action 词。
 *
 * @param {object} data
 * @param {string} qq
 * @param {number} seedPos 种子位。**正式通道必须传"这条记录的抽牌时间"（entry.at）**，
 *   不能传全局 seq —— 全局计数会被别人的抽牌推动，导致同一个人的签被改掉。
 *   测试通道（pureRandom）忽略它。
 * @param {boolean} [pureRandom]
 *   false（默认，正式通道）：**种子派生**。理由：/抽签解读 可以被反复发送，若每次独立随机
 *   （各 20%），连点五次必出"大吉"，签就没有意义了。绑定自己的那份牌之后签位恒定。
 *   true（测试通道）：**真随机**。测试通道就是为了"多抽几次看不同签位的图"，跟随账本固定
 *   反而是 bug（用户实测反馈"测抽签不是随机"）。
 */
function drawLuck(data, qq, seedPos, pureRandom = false) {
  const names = Object.keys(data.luck);              // 顺序即 data-luck.json 的书写顺序
  const r = pureRandom
    ? (() => Math.random())
    : rngFor(qq, seedPos, 'luck');
  const name = names[Math.floor(r() * names.length)] || names[0];
  const l = data.luck[name];
  const actions = Array.isArray(l.action) && l.action.length ? l.action : [''];
  const ra = pureRandom ? (() => Math.random()) : rngFor(qq, seedPos, 'action');
  const action = actions[Math.floor(ra() * actions.length)] || actions[0];
  return { name, luck: l, action };
}

/** 组合模板 → 成品句（{field} 与 {action} 都填掉）。 */
function buildTemplate(data, comboKey, field, action) {
  const tpl = String(data.combo?.templates?.[comboKey] ?? '');
  return tpl.replace(/\{field\}/g, field || '').replace(/\{action\}/g, action || '');
}

// ── 账本 ──────────────────────────────────────────────────────────────
// 读写一律走 api.storage（它自己就是原子写 tmp+rename），不要自己拼绝对路径。
function emptyLedger(seq = 0) {
  return { date: localDayKey(), draws: {}, seq: Number(seq) || 0, history: {} };
}
/**
 * 已经计过数的 v2 遗留记录（key = `${qq}|${at}`）。
 *
 * 干什么：`loadLedger()` 每次调用都会把无效记录从**内存里的这份账本**删掉，但**不落盘**，
 *   所以同一条坏记录会在下一次读时再被"丢弃"一遍。若每遍都 `health.legacyDropped += 1`，
 *   这个计数就变成"读了几次"而不是"丢了几条"（协议九·2.3：单条证据被重复计入）。
 *   这里按记录身份去重 —— 同一条只计一次；真正落盘清理后它自然不会再出现。
 *
 * ⚠️ 有上限：超过 500 条就丢最早的一条（只影响"去重记忆"，不影响功能）。
 *    不设上限的话，一个被人手改坏的账本可以把这个 Set 撑到无限大。
 */
const legacyCountedKeys = new Set();
const LEGACY_COUNTED_MAX = 500;

/**
 * 读账本。
 *
 * v2 起账本结构变了（多存小阿卡纳与 history）；v3 又多了宫廷牌。
 * **缺 court 的 v2 记录一律判为"今天没抽过"**，与 v2 处理 v1 记录同口径。
 * ⚠️ seq 仍然保留 —— 它是种子的熵来源，若连它一起归零，重启后同一个人又会被抽到同一张牌。
 */
function loadLedger() {
  try {
    const raw = api?.storage?.readJson?.('draws.json', null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyLedger();
    const today = localDayKey();
    const seq = Number(raw.seq) || 0;
    if (String(raw.date || '') !== today) return emptyLedger(seq);
    const draws = (raw.draws && typeof raw.draws === 'object' && !Array.isArray(raw.draws)) ? raw.draws : {};
    const history = (raw.history && typeof raw.history === 'object' && !Array.isArray(raw.history)) ? raw.history : {};
    // 旧格式的记录（v1 没有 minor、v2 没有 court）不迁移：直接判为"今天没抽过"。
    for (const qq of Object.keys(draws)) {
      if (!isValidEntry(draws[qq])) {
        const badEntry = draws[qq];
        if (badEntry && typeof badEntry === 'object') {
          const badKey = `${qq}|${Number(badEntry.at) || 0}`;
          if (!legacyCountedKeys.has(badKey)) {
            legacyCountedKeys.add(badKey);
            health.legacyDropped += 1;
            if (legacyCountedKeys.size > LEGACY_COUNTED_MAX) {
              legacyCountedKeys.delete(legacyCountedKeys.values().next().value);
            }
          }
        }
        delete draws[qq];
      }
    }
    return { date: today, draws, seq, history };
  } catch (error) {
    health.ledgerReadFails += 1;
    health.lastError = `读账本：${String(error?.message ?? error).slice(0, 80)}`;
    return emptyLedger();
  }
}

/** 一条记录是否合法（牌号必须是真正的整数，且小阿卡纳/宫廷牌的 id 必须存在）。 */
function isValidEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (!isValidMajor(e.major)) return false;
  if (!e.minor || typeof e.minor !== 'object') return false;
  if (typeof e.minor.id !== 'string' || !e.minor.id) return false;
  if (typeof e.minor.reversed !== 'boolean') return false;
  // v3：宫廷牌字段。缺它就说明是 v2 的记录 ⇒ 判为无效（见 loadLedger 注释）
  if (!e.court || typeof e.court !== 'object') return false;
  if (typeof e.court.id !== 'string' || !e.court.id) return false;
  if (typeof e.court.reversed !== 'boolean') return false;
  return true;
}
function isValidMajor(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < MAJOR_COUNT;
}

/**
 * 存账本。
 *
 * ⚠️ 拿不到 writeJson 就**明确失败并留痕**，不假装成功（v1 审计踩过：写了没写进去、
 *    读却永远为空，每日上限整体失效且无人察觉）。
 * 回读校验要连**记录规模**与**本次这条的具体内容**一起验，只比 date 会被"只写 date、
 * 丢 draws"的存储骗过去。
 */
function saveLedger(l, qq) {
  try {
    const st = api?.storage;
    if (!st || typeof st.writeJson !== 'function' || typeof st.readJson !== 'function') {
      throw new Error('宿主没有提供可用的 storage（writeJson/readJson 缺失）');
    }
    st.writeJson('draws.json', l);
    const back = st.readJson('draws.json', null);
    if (!back || typeof back !== 'object') throw new Error('写账本后回读为空');
    if (String(back.date) !== String(l.date)) throw new Error('回读校验失败：date 不一致');
    const backDraws = (back.draws && typeof back.draws === 'object') ? back.draws : {};
    if (Object.keys(backDraws).length !== Object.keys(l.draws || {}).length) {
      throw new Error('回读校验失败：记录条数不一致');
    }
    if (qq != null) {
      const want = l.draws?.[String(qq)];
      const got = backDraws[String(qq)];
      if (want && (!got || got.major !== want.major
        || got.minor?.id !== want.minor?.id
        || got.minor?.reversed !== want.minor?.reversed
        || got.court?.id !== want.court?.id
        || got.court?.reversed !== want.court?.reversed
        || got.majorRev !== want.majorRev)) {
        throw new Error('回读校验失败：本次记录内容不一致');
      }
    }
    if (!isDeepStrictEqual(back, l)) throw new Error('回读校验失败：账本内容不一致');
    return true;
  } catch (error) {
    health.ledgerWriteFails += 1;
    health.lastError = `写账本：${String(error?.message ?? error).slice(0, 80)}`;
    warn('塔罗账本写入失败：', health.lastError);
    return false;
  }
}

/** 取某人的今日记录（结构非法一律当"没抽过"）。 */
function getDraw(l, qq) {
  const d = l.draws?.[String(qq)];
  return isValidEntry(d) ? d : null;
}
function countDraws(l, qq) {
  const d = getDraw(l, qq);
  if (!d) return 0;
  return Array.isArray(d.list) ? Math.max(1, d.list.length) : 1;
}

/** 往 history 追加一条并裁剪到 HISTORY_MAX_ENTRIES 条（不是天，见常量处的注释）。 */
function pushHistory(ledger, qq, entry) {
  const key = String(qq);
  const hist = ledger.history[key] || [];
  hist.push({ date: ledger.date, major: entry.major, minor: entry.minor.id, court: entry.court.id });
  while (hist.length > HISTORY_MAX_ENTRIES) hist.shift();
  ledger.history[key] = hist;
}

// ── 渲染服务（本地 HTTP）──────────────────────────────────────────────
/**
 * 起一个只服务"本次渲染的页面 + 插件自带素材"的本地服务。
 * 只监听 127.0.0.1、随机端口；素材路径走**文件名白名单**，不做路径拼接 ⇒ 无穿越风险。
 */
function startServer() {
  if (httpServer) return Promise.resolve();
  const serverLifecycle = lifecycle;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/' || u.pathname === '/page') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(currentHtml);
          return;
        }
        if (u.pathname.startsWith('/asset/')) {
          const name = decodeURIComponent(u.pathname.slice('/asset/'.length));
          if (!loadAssets().has(name)) { res.writeHead(404); res.end(); return; }
          const buf = fs.readFileSync(path.join(ASSETS_DIR, name));
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
          res.end(buf);
          return;
        }
        res.writeHead(404); res.end();
      } catch (error) {
        health.lastError = `渲染服务：${String(error?.message ?? error).slice(0, 80)}`;
        try { res.writeHead(500); res.end(); } catch { /* 响应已结束 */ }
      }
    });
    server.once('error', (error) => {
      if (httpServer === server) { httpServer = null; httpPort = 0; }
      reject(error);
    });
    // ★ 先把句柄写进模块状态**再** listen：否则"恰好挂在 listen 之前那个宏任务窗口里的
    //   deactivate()"看不到 server（httpPort 还是 0）⇒ 关不掉 ⇒ 端口在停用之后复活。
    httpServer = server;
    server.listen(0, '127.0.0.1', () => {
      if (deactivated || serverLifecycle !== lifecycle) {
        try { server.close(); } catch { /* 已经关了 */ }
        if (httpServer === server) { httpServer = null; httpPort = 0; }
        reject(new Error('插件已停用'));
        return;
      }
      httpPort = server.address().port;
      resolve();
    });
  });
}

// ── 渲染 ──────────────────────────────────────────────────────────────
function getElectron() {
  // 插件是 ESM，拿 Electron 主进程模块要自己 createRequire（不能直接 import 'electron'）
  return import('node:module').then((m) => {
    const req = m.createRequire(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
    return req('electron');
  });
}

/**
 * 保证复用的渲染窗口存在。
 *
 * ★ 三条实测结论（别凭直觉改）：
 *   1) **"销毁窗口后再新建会失败"的真实条件是"销毁了进程里最后一个窗口"**
 *      —— 那会触发 window-all-closed ⇒ Electron 开始退出。只要宿主还有主界面窗口，
 *      "销毁后重建"本身是能成功的；但我们的方案不依赖这一点成立：
 *      只建一次、永不销毁、跨实例复用，任何情况下都安全。
 *   2) **引用必须挂在 globalThis 上，不能只放模块级变量**：热重载会重新 import 一个
 *      新模块实例，模块级变量归零；只认模块级变量的话新实例会以为"还没有窗口"再去建一个。
 *   3) 真到"窗口被外部关掉"那一步，**宁可降级也不要再建**：本次渲染失败 → 上层降级为
 *      纯文字回执，不会把宿主进程搞崩。
 *
 * v3：窗口宽度按**首个渲染页**的宽度建；之后每张图由 renderPng 用 setContentSize 调整。
 */
const WINDOW_KEY = '__jyTarotRenderWindow__';

async function ensureWindow(initialWidth) {
  if (deactivated) throw new Error('插件已停用');
  const windowLifecycle = lifecycle;

  let win = globalThis[WINDOW_KEY];
  if (win && !win.isDestroyed()) { renderWindow = win; return win; }
  if (win && win.isDestroyed()) globalThis[WINDOW_KEY] = null;

  if (globalThis[WINDOW_KEY + '__created']) {
    throw new Error('渲染窗口已被关闭，且本进程不能再新建窗口（本次降级为文字回执）');
  }

  const electron = await getElectron();
  if (deactivated || windowLifecycle !== lifecycle) throw new Error('插件已停用');
  const BrowserWindow = electron?.BrowserWindow;
  if (!BrowserWindow) throw new Error('Electron 未提供 BrowserWindow');

  globalThis[WINDOW_KEY] = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: Math.max(320, Math.round(Number(initialWidth) || INITIAL_WINDOW_WIDTH)),
    height: 900,
    backgroundColor: '#f7f3ea',
    webPreferences: { offscreen: false, backgroundThrottling: false, nodeIntegration: false }
  });
  globalThis[WINDOW_KEY + '__created'] = true;   // 记在全局：跨模块实例生效
  renderWindow = globalThis[WINDOW_KEY];
  renderWindow.on('closed', () => {
    if (globalThis[WINDOW_KEY] === renderWindow) globalThis[WINDOW_KEY] = null;
    renderWindow = null;
  });
  return renderWindow;
}

/**
 * 真正渲染一张 PNG。串行调用（由 renderQueued 保证）。
 *
 * @param {{html:string, width:number}} page  builder 的返回值（宽度是版面自己的宽度）
 */
async function renderPng(page) {
  const width = Math.max(320, Math.round(Number(page?.width) || INITIAL_WINDOW_WIDTH));
  await startServer();
  if (deactivated) throw new Error('插件已停用');
  currentHtml = String(page?.html ?? '');
  const win = await ensureWindow(width);
  if (deactivated) throw new Error('插件已停用');

  // ★★ 世代号：超时只是"race 输了"，`done` 并不会停 —— 它会在共享窗口上继续跑
  //    setContentSize / capturePage，而下一次渲染已经开始，于是串行不变量被打破。
  //    每个 job 领一个世代号，任何 await 之后先检查自己是不是最新世代，不是就立刻退出。
  const gen = ++renderGen;
  const stale = () => gen !== renderGen;

  let timerId = null;
  const timer = new Promise((_, rej) => {
    timerId = setTimeout(() => rej(new Error('渲染超时')), RENDER_TIMEOUT_MS);
    timerId.unref?.();
  });

  const done = (async () => {
    await win.loadURL(`http://127.0.0.1:${httpPort}/page?t=${Date.now()}`);
    if (stale()) throw new Error('本次渲染已被更新的一次取代');

    // 等图片真的解码完，并**校验 naturalWidth** —— 只看"没抛错"会拿到全空白图。
    // 页面里的等待必须自带超时：图片既不 onload 也不 onerror 时会永远挂住。
    const diag = await win.webContents.executeJavaScript(
      '(async () => {'
      + ' var imgs = [...document.images];'
      + ' var wait = Promise.all(imgs.map(function (i) { return i.complete ? 0 : new Promise(function (r) { i.onload = i.onerror = r; }); }));'
      + ' var to = new Promise(function (r) { setTimeout(r, ' + IMG_WAIT_MS + '); });'
      + ' await Promise.race([wait, to]);'
      + ' var bad = imgs.filter(function (i) { return !i.naturalWidth || !i.naturalHeight; });'
      + ' var im = imgs[0];'
      + ' return { n: imgs.length, bad: bad.length, nw: im ? im.naturalWidth : 0, nh: im ? im.naturalHeight : 0,'
      + '   h: document.body.scrollHeight, w: document.body.scrollWidth };'
      + ' })()'
    );
    if (stale()) throw new Error('本次渲染已被更新的一次取代');
    if (!diag || !diag.n || diag.bad || !diag.nw || !diag.nh) {
      health.blankImages += 1;
      throw new Error(`牌面图未加载（images=${diag?.n || 0} bad=${diag?.bad || 0} natural=${diag?.nw || 0}x${diag?.nh || 0}）`);
    }
    // ⚠️ 宽度**固定用页面自己的宽度**，不要用测量出来的 scrollWidth：body 已写死宽度，
    //    但布局抖动时 scrollWidth 会量出 ±2px，于是同内容两次渲染得到不同宽度的图。
    const h = Math.min(Math.max(Number(diag.h) || 900, 320), 3000);
    win.setContentSize(width, h);
    await new Promise((r) => setTimeout(r, 130));
    if (stale()) throw new Error('本次渲染已被更新的一次取代');
    // ★ 用固定矩形截图：不指定矩形时首次建窗那张会量到 1622px、之后都是 1620px。
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: h });
    const png = image.toPNG();
    if (!png || png.length < 5000) {
      health.blankImages += 1;
      throw new Error(`渲染结果疑似空白（${png?.length || 0} 字节）`);
    }
    return png;
  })();

  try {
    return await Promise.race([done, timer]);
  } finally {
    if (timerId) clearTimeout(timerId);
    // 关键：本次渲染结束时把世代推进一格，让还在飞的 `done` 下次检查时立刻退出。
    if (gen === renderGen) renderGen += 1;
    done.catch(() => {});
  }
}

/**
 * 对外统一的"排队渲染"，保证同一时刻只有一张在渲染。
 *
 * ★ 队列也必须挂在 globalThis 上（和窗口同一个策略）：窗口是跨模块实例共用的，
 *   如果队列还是模块级，热重载时"旧实例还在飞的渲染"会和"新实例的渲染"
 *   同时用同一个窗口 —— 实测表现为旧的那次拿到 ERR_ABORTED、回执降级成纯文字。
 *
 * @param {{html:string, width:number}} page
 */
function renderQueued(page) {
  const QKEY = '__jyTarotRenderQueue__';
  const queuedLifecycle = lifecycle;
  let expired = false;
  let queueTimer;
  const queueTimeout = new Promise((_, reject) => {
    queueTimer = setTimeout(() => {
      expired = true;
      reject(new Error('渲染排队超时，请稍后再试'));
    }, QUEUE_WAIT_MS);
    queueTimer.unref?.();
  });
  if (!globalThis[QKEY]) globalThis[QKEY] = Promise.resolve();
  const run = globalThis[QKEY].then(() => {
    clearTimeout(queueTimer);
    if (expired) throw new Error('渲染排队超时');
    if (deactivated || queuedLifecycle !== lifecycle) throw new Error('插件已停用');
    activeRenders += 1;
    const t0 = Date.now();
    return renderPng(page).then((png) => {
      health.rendered += 1;
      health.lastRenderMs = Date.now() - t0;
      return png;
    }).catch((error) => {
      health.renderFails += 1;
      if (/超时/.test(String(error?.message || ''))) health.renderTimeouts += 1;
      health.lastError = `渲染：${String(error?.message ?? error).slice(0, 120)}`;
      throw error;
    }).finally(() => {
      activeRenders -= 1;
      if (deactivated && activeRenders === 0) stopServer();
    });
  });
  globalThis[QKEY] = run.then(() => undefined, () => undefined);
  return Promise.race([run, queueTimeout]).finally(() => clearTimeout(queueTimer));
}

/**
 * 把 PNG 落盘到临时文件并发出去；发完即删。
 *
 * ★ **不直连 `ctx.onebot.sendImage`**，走 `ctx.sender.sendImage`：直连协议端会跳过发送
 *   队列的一整套保障（每会话串行、限频、拟人延时、store 留档），跨机部署时本地路径也不会
 *   被转成 base64。指令网关的约定是「发消息一律走 payload.ctx.sender，插件不直接调 OneBot」。
 * ★ 署名：`sender.sendImage` 的第 3 个参数支持 `atUserId` ⇒ 发图时 @ 触发的人。
 *   群里好几个人同时发指令时，光看图分不清是谁抽的；at 段挂在**图片**这条消息上正合适。
 */
async function sendPng(ctx, png, chatKey, atQq = '', word = '') {
  const sender = ctx?.sender;
  if (typeof sender?.sendImage !== 'function') {
    throw new Error('宿主没有提供 sender.sendImage（无法发图）');
  }
  const dir = path.join(api?.storage?.dir || PLUGIN_DIR, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tarot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  // onebot 层要求 atUserId 是纯数字 QQ，否则会抛错导致整条消息发不出去 ⇒ 先自检一次
  const at = /^\d+$/.test(String(atQq || '').trim()) ? String(atQq).trim() : '';
  const note = String(word || '').trim() || '今日塔罗';
  try {
    // ⚠️ 写盘也要在 try 里：原来 writeFileSync 在 try 之外，磁盘满/EIO 时会留下半个文件，
    //    而 unlink 在 finally 里根本轮不到。
    fs.writeFileSync(file, png);
    await sender.sendImage(chatKey, { file, note }, at ? { atUserId: at } : undefined);
  } finally {
    try { fs.unlinkSync(file); } catch { /* 文件不存在或清理失败不影响主结果 */ }
  }
}

// ── 文案 ──────────────────────────────────────────────────────────────
/** 图一的文字回执（可被搜索/引用）。v3：末尾带上宫廷牌。 */
function resultText({ major, majorRev, minor, minorRev, court, courtRev }) {
  const dir = (r) => (r ? '逆位' : '正位');
  return `${major.cn}（${dir(majorRev)}）· ${minor.cn}（${dir(minorRev)}${minor.field ? '·' + minor.field : ''}）`
    + `——${(minorRev ? minor.rev : minor.up).event}`
    + `｜宫廷：${court.cn}（${dir(courtRev)}）`;
}
/** 图二的文字回执。 */
function luckResultText({ luck, action, template }) {
  return `抽签：${luck.name}（把握 ${luck.confidence}%）——${template}`;
}

// ── 组装一张图所需的上下文 ────────────────────────────────────────────
/** 从记录里取出成套的牌面对象（v3：含宫廷牌）。 */
function cardsOf(data, entry) {
  const major = data.major[String(entry.major)];
  const minor = data.minor[entry.minor.id];
  const court = data.court[entry.court?.id];
  if (!major) throw new Error(`数据表里没有第 ${entry.major} 张大阿卡纳`);
  if (!minor) throw new Error(`数据表里没有小阿卡纳 ${entry.minor.id}`);
  if (!court) throw new Error(`数据表里没有宫廷牌 ${entry.court?.id}`);
  return {
    major, minor, majorRev: !!entry.majorRev, minorRev: !!entry.minor.reversed,
    court, courtRev: !!entry.court.reversed
  };
}

/** 抽签解读里那句最终建议用到的领域文案。 */
function fieldTextOf(data, major, majorRev, minor) {
  const attr = minor?.fieldAttr;
  if (!attr) return { text: '', label: minor?.field || '' };
  const side = majorRev ? major.rev : major.up;
  return { text: String(side?.[attr] ?? ''), label: String(minor.field || '') };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/**
 * /塔罗 的完整流程：抽三张牌（确定性/测试）+ 出图一 + 发送。
 * @param {'today'|'test'} mode
 */
async function runTarot({ ctx, qq, chatKey, mode, spec, word = '', who = '' }) {
  if (deactivated) return { text: '插件已停用，暂时抽不了牌。' };
  const data = loadData();
  if (!data) return { text: `塔罗数据表读取失败，暂时抽不了牌。${dataError ? '（' + dataError + '）' : ''}` };
  if (!loadAssets().size) {
    return { text: `塔罗素材缺失，暂时抽不了牌。${assetsError ? '（' + assetsError + '）' : ''}` };
  }
  if (typeof ctx?.sender?.sendImage !== 'function') {
    return { text: '宿主没有提供发图能力（sender.sendImage），暂时抽不了牌。' };
  }
  const limit = Math.max(1, Math.min(MAX_DAILY_LIMIT, Math.floor(Number(conf().dailyLimit) || TAROT_PER_DAY_DEFAULT)));
  const isTest = mode === 'test';

  // ── 两条通道的区别只在这一点 ──
  //    today：查账本 → 抽过就不重复抽（把今天的结果再发一次）→ 抽完记账
  //    test ：**完全不读也不写账本**，纯随机，想抽多少抽多少
  let cards = null;         // { major, minor, court, majorRev, minorRev, courtRev }
  let ledgerNote = '';
  /**
   * 这次是不是"今天已经抽过、把旧结果再发一次"。
   * 用来在回执里加「今日已抽取」—— 不加的话用户会以为又抽了一张新牌（实测反馈的 bug）。
   * 只有**正式通道**会置 true：测试通道不记账，每次都是新抽的。
   */
  let repeated = false;

  if (isTest) {
    // ⚠️ 测试通道拿到的是 { major: 牌号, minor: 小阿卡纳 id, court: 宫廷牌 id }，**不能**丢给 cardsOf()：
    //    那个函数是按账本记录的形状（minor.id / court.id）取牌的，直接传会把 major 当记录对象用，
    //    结果 major 解析成 undefined、渲染时崩在读取 theme 上（实测踩过）。
    //    这里直接查表组装成与正式通道一致的形状。
    const t = drawTest(data, spec || {});
    const major = data.major[String(t.major)];
    const minor = data.minor[t.minor];
    const court = data.court[t.court];
    if (!major) return { text: `数据表里没有第 ${t.major} 张大阿卡纳。` };
    if (!minor) return { text: `数据表里没有小阿卡纳 ${t.minor}。` };
    if (!court) return { text: `数据表里没有宫廷牌 ${t.court}。` };
    cards = { major, minor, court, majorRev: t.majorRev, minorRev: t.minorRev, courtRev: t.courtRev };
    health.testDraws += 1;
    // 覆盖式写入**临时账本**（每人只有一条），供 /测抽签 使用；**不碰正式账本**
    rememberTestDraw(qq, cards);
  } else {
    // ★★ 「读账本 → 判定 → 抽牌 → 记账 → 落盘」必须是**没有 await 的同步临界区** ★★
    //    指令前置只按 chatKey 串行（同群才排队），跨群/群与私聊之间完全不串行。
    //    中间一旦 await，两条并发的 /塔罗 会各自读到旧账本、后写者把先写者整条覆盖。
    //    渲染很慢，所以**先记账、再出图**：渲染失败这次抽取仍算已用掉（牌确实抽出来了）。
    const ledger = loadLedger();
    const already = getDraw(ledger, qq);
    const cnt = countDraws(ledger, qq);
    let nth;
    let entry;
    if (already && cnt >= limit) {
      // 今天已经抽过：**不重新抽**，把今天的结果再发一次。
      // ⚠️ 必须标记 repeated：回执里要写「今日已抽取」，否则用户以为这是一张新牌
      //    （实测反馈的 bug：连发几次都拿到同样的回执，看不出"已经抽过了"）。
      entry = already;
      nth = Number(ledger.seq) || 0;
      repeated = true;
    } else {
      // nth 是种子的一部分 ⇒ 必须每次调用都不同，否则永远抽到同一对牌。
      // 用账本里的递增计数（而不是时间戳），这样重启进程也不会跳牌。
      nth = (Number(ledger.seq) || 0) + 1;
      const picked = drawThree(data, qq, nth);
      entry = { at: Date.now(), major: picked.major, majorRev: picked.majorRev,
        minor: { id: picked.minor, reversed: picked.minorRev },
        court: { id: picked.court, reversed: picked.courtRev } };
      const prev = getDraw(ledger, qq);
      const list = Array.isArray(prev?.list)
        ? prev.list.slice()
        : (prev ? [{ at: prev.at, major: prev.major, majorRev: prev.majorRev,
          minor: prev.minor, court: prev.court }] : []);
      list.push(entry);
      ledger.draws[String(qq)] = {
        at: entry.at, major: entry.major, majorRev: entry.majorRev,
        minor: entry.minor, court: entry.court,
        list: list.slice(-MAX_DAILY_LIMIT)
      };
      ledger.seq = nth;
      pushHistory(ledger, qq, entry);
      const saved = saveLedger(ledger, qq);
      if (!saved) {
        warn('塔罗：账本没写进去，本次抽取不会被记住（下次同一人会再抽一次）');
        ledgerNote = '（注意：账本没写进去，今天可能被重复抽取）';
      }
    }
    cards = cardsOf(data, entry);
    health.draws += 1;
  }

  // 图一的内容 = 主题 + 事件 + 宫廷（另一维度）+ 四领域（取大阿卡纳当前那一位态）
  const domains = DOMAIN_ATTRS.map(([label, attr]) => ({
    label,
    text: String((cards.majorRev ? cards.major.rev : cards.major.up)?.[attr] ?? '')
  }));
  const page = buildTarotHtml({ ...cards, domains, dateText: todayText(), who });

  let png = null;
  let renderErr = '';
  try {
    png = await renderQueued(page);
  } catch (error) {
    renderErr = String(error?.message ?? error).slice(0, 100);
  }

  const label = resultText(cards);
  // 回执前缀：
  //   · 重复抽取（今天已抽过）→「今日已抽取　」—— 让用户一眼看出这不是新牌
  //   · 测试通道 → 「【测试】」—— 测试牌是随机/指定的，不代表今天的运势
  const tag = isTest ? '【测试】' : (repeated ? '今日已抽取　' : '');
  if (!png) {
    return { text: `${tag}${label}（图片生成失败：${renderErr}）${ledgerNote}` };
  }
  try {
    await sendPng(ctx, png, chatKey, qq, word);
  } catch (error) {
    return { text: `${tag}${label}（图片发送失败：${String(error?.message ?? error).slice(0, 80)}）${ledgerNote}` };
  }
  return { text: tag + label + ledgerNote };
}

/**
 * /抽签解读 的完整流程：读账本里今天的塔罗 → 抽签 → 出图二 + 发送。
 * 没抽过塔罗就直接拒绝（不出图、不记账）。
 *
 * @param {object} opts
 * @param {string} [opts.forceLuck] 强制签位（仅测试通道使用）
 * @param {string} [opts.prefix]    指令前缀（用于把提示里的命令写对，别硬编码 /）
 * @param {boolean} [opts.isTest]   测试通道（走临时账本、签位真随机、回执带【测试】）
 */
async function runLuckReading({
  ctx, qq, chatKey, forceLuck = '', word = '', who = '', prefix = '/', isTest = false
}) {
  if (deactivated) return { text: '插件已停用，暂时抽不了签。' };
  const data = loadData();
  if (!data) return { text: `塔罗数据表读取失败，暂时抽不了签。${dataError ? '（' + dataError + '）' : ''}` };
  if (!loadAssets().size) {
    return { text: `塔罗素材缺失，暂时抽不了签。${assetsError ? '（' + assetsError + '）' : ''}` };
  }
  if (typeof ctx?.sender?.sendImage !== 'function') {
    return { text: '宿主没有提供发图能力（sender.sendImage），暂时抽不了签。' };
  }

  const ledger = loadLedger();
  const entry = getDraw(ledger, qq);
  // 取牌完全按通道分开，**没有"谁优先"这回事**：
  //   · /测抽签（测试通道）：只读**临时账本**（/测塔罗 覆盖式写入的那一条）。
  //     它**不读也不写**正式账本 —— 两个世界彻底隔离。
  //   · /抽签解读（正式）：只读正式账本（当天的记录，每天一次、当天恒定）。
  const cards = isTest
    ? getTestDraw(data, qq)
    : (entry ? cardsOf(data, entry) : null);
  if (!cards) {
    // 拒绝文案要**说清该做什么**，不能两种通道回同一句：
    // 测试通道缺的是"测试抽牌"，而它可能是从没测过、也可能是**过期了**（30 分钟）。
    if (isTest) {
      const p = String(prefix || '').trim() || '/';
      return { text: `还没测试抽过牌，或测试抽牌已超过 30 分钟。先发 ${p}测塔罗 再来 ${p}测抽签。` };
    }
    return { text: String(conf().needTarotText || NEED_TAROT_TEXT) || NEED_TAROT_TEXT };
  }
  // 签位的种子必须落在**自己这条记录**上，不能用全局 ledger.seq：
  //   seq 是所有人共用的抽牌计数，别人抽一张它就前进 ⇒ 同一个人的签会被别人改掉
  //   （v2 遗留 bug：连发 /抽签解读 就能等别人抽牌刷出新签）。
  //   用记录的 at（抽牌时间）当种子：同一条记录 ⇒ 签位恒定；本人重抽 ⇒ 新记录 ⇒ 新签。
  //   ⚠️ 测试通道走纯随机，这个种子对它无意义。
  const luckSeed = Number(entry?.at) || 0;

  let luckName = String(forceLuck || '').trim();
  if (luckName && !data.luck[luckName]) {
    return { text: `没有「${luckName}」这个签位。可选：${Object.keys(data.luck).join(' / ')}` };
  }
  // 测试通道**真随机**（多抽几次能看到不同签位）；正式通道种子派生（同一份牌面恒定、刷不动）
  const luckPick = drawLuck(data, qq, luckSeed, isTest);
  const luck = luckName ? data.luck[luckName] : luckPick.luck;
  const action = luckPick.action;

  const comboKey = `${cards.majorRev ? 'r' : 'u'}${cards.minorRev ? 'r' : 'u'}`;
  const fieldName = cards.minor.field || '';
  const template = buildTemplate(data, comboKey, fieldName, action);
  const { text: fieldText, label: fieldLabel } = fieldTextOf(data, cards.major, cards.majorRev, cards.minor);

  const page = buildLuckHtml({
    luck, luckAction: action, template,
    major: cards.major, majorRev: cards.majorRev,
    minor: cards.minor, minorRev: cards.minorRev,
    court: cards.court, courtRev: cards.courtRev,
    fieldText, fieldLabel, dateText: todayText(), who
  });

  if (!isTest) health.luckDraws += 1;

  let png = null;
  let renderErr = '';
  try {
    png = await renderQueued(page);
  } catch (error) {
    renderErr = String(error?.message ?? error).slice(0, 100);
  }
  const label = luckResultText({ luck, action, template });
  const tag = isTest ? '【测试】' : '';
  if (!png) return { text: `${tag}${label}（图片生成失败：${renderErr}）` };
  try {
    await sendPng(ctx, png, chatKey, qq, word);
  } catch (error) {
    return { text: `${tag}${label}（图片发送失败：${String(error?.message ?? error).slice(0, 80)}）` };
  }
  return { text: tag + label };
}

/** 测试通道的白名单闸（/测塔罗 与 /测抽签 共用一份）。 */
function testGate(payload) {
  const c = conf();
  const allow = parseIds(c.testAllowList);
  const from = String(payload?.from?.id ?? '');
  const perm = Number(payload?.permission) || 0;
  if (allow.length && allow.includes(from)) return { ok: true };
  if (perm >= 100000) return { ok: true };   // 超管始终可用（与点赞插件同一口径）
  return { ok: false, text: String(c.testDenyText || '这条是内部测试指令，你不在测试名单里。') };
}

/**
 * 解析 /测塔罗 的参数。
 *
 * 语法（用户定的）：
 *   /测塔罗                      → 大 / 小 / 宫廷**全部随机**
 *   /测塔罗 大 [0-21] [正|逆]     → 大定死（可省），其余随机
 *   /测塔罗 小 [01-20] [正|逆]    → 小定死（可省），其余随机
 *   /测塔罗 宫 [01-16] [正|逆]    → 宫廷定死（可省），其余随机（v3 新增）
 *   /测塔罗 宫 权杖王后 逆        → 宫廷按**中文名**定死（v3 新增，也可写 权杖皇后）
 *   /测塔罗 大 15 逆 小 07 正 宫 03 逆   → 三个都定死
 *   /测塔罗 15 逆                → 旧格式：裸数字仍当大阿卡纳 0-21（向后兼容）
 *
 * ⚠️ 非法参数**不能静默忽略**（用户以为指定了牌号、实际随机），要回一句用法提示。
 *    `大`/`小`/`宫` 切换当前半边；`正`/`逆` 作用于**最近指定的那一半边**。
 * ⚠️ 中文名解析需要数据表（`data` 参数）；纯数字解析不依赖数据，便于单测。
 */
export function parseTestArgs(parts, data = null) {
  const spec = {};
  const bad = [];
  let side = '';
  const courtByCn = (raw) => {
    if (!data?.court) return null;
    // 素材文件名用「皇后」，文案用「王后」—— 两种写法都认
    const want = String(raw ?? '').trim().replace(/皇后/g, '王后');
    for (const c of Object.values(data.court)) {
      if (String(c.cn ?? '') === want) return c;
      if (String(c.name ?? '').toLowerCase() === want.toLowerCase()) return c;
    }
    return null;
  };
  for (const raw of parts) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (p === '大' || p === '大阿卡' || p === '大牌' || /^major$/i.test(p)) { side = 'major'; continue; }
    if (p === '小' || p === '小阿卡' || p === '小牌' || /^minor$/i.test(p)) { side = 'minor'; continue; }
    if (p === '宫' || p === '宫廷' || p === '宫廷牌' || /^court$/i.test(p)) { side = 'court'; continue; }
    if (/^(正|正位|up)$/i.test(p)) {
      if (side === 'minor') spec.minorRev = false;
      else if (side === 'court') spec.courtRev = false;
      else spec.majorRev = false;          // 旧格式：裸正逆当大阿卡
      continue;
    }
    if (/^(逆|逆位|rev|reversed)$/i.test(p)) {
      if (side === 'minor') spec.minorRev = true;
      else if (side === 'court') spec.courtRev = true;
      else spec.majorRev = true;
      continue;
    }
    if (/^\d{1,2}$/.test(p)) {
      const n = Number(p);
      if (side === 'minor') {
        if (n >= 1 && n <= MINOR_COUNT) spec.minor = n;
        else bad.push(`${p}（小阿卡纳序号须 01-${MINOR_COUNT}）`);
      } else if (side === 'court') {
        if (n >= 1 && n <= COURT_COUNT) spec.court = n;
        else bad.push(`${p}（宫廷牌序号须 01-${COURT_COUNT}）`);
      } else {
        // 裸数字（side === ''）按**大阿卡纳**解析：保住旧用法 /测塔罗 15
        if (n >= 0 && n < MAJOR_COUNT) spec.major = n;
        else bad.push(`${p}（大阿卡纳须 0-${MAJOR_COUNT - 1}）`);
      }
      continue;
    }
    // v3：宫廷牌中文名（不必先打「宫」也能识别，方便直接抄牌名）
    const hit = courtByCn(p);
    if (hit) { spec.court = hit.idx; side = 'court'; continue; }
    bad.push(p);
  }
  return { spec, bad };
}

/**
 * 清理 out/ 里上一次运行残留的临时 PNG。
 *
 * 为什么会有残留：图先落盘、再交给 sender 发送；若宿主在"落盘完成 → 发送完成"之间
 * 崩溃/被结束（sender 自带拟人延时，这个窗口是秒级真实的），那个文件就没人删了。
 * 只清理**24 小时前**的，避免误删正在发送中的文件。
 */
function cleanupOutDir() {
  try {
    const dir = path.join(api?.storage?.dir || PLUGIN_DIR, 'out');
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/^tarot-.*\.png$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed += 1; }
      } catch { /* 单个文件失败不影响其它 */ }
    }
    if (removed) log(`塔罗：清理了 ${removed} 个上次残留的临时图片`);
  } catch (error) {
    warn('塔罗：清理 out/ 失败：', String(error?.message ?? error).slice(0, 80));
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────
export function setup(skillApi) {
  api = skillApi;
  // 临时账本缓存置为"未读"：热重载后重新从盘上读（它是落盘的，不会丢）
  testLedgerCache = undefined;
  // 启动就把数据表与素材扫一遍：问题在加载期暴露，而不是等用户抽牌时才炸
  const data = loadData();
  loadAssets();
  if (dataError) warn('塔罗：数据表有问题 →', dataError);
  if (assetsError) warn('塔罗：素材有问题 →', assetsError);
  if (data) {
    const miss = missingAssets(data, loadAssets());
    if (miss.length) warn(`塔罗：素材缺 ${miss.length} 张（如 ${miss.slice(0, 3).join('、')}）`);
  }
  log(`塔罗 v${PLUGIN_VERSION}：已加载（数据表 ${data ? 'OK' : 'FAIL'}，素材 ${loadAssets().size} 张）`);
  cleanupOutDir();
}

export function available() {
  // ⚠️ 这里必须自己 try/catch：available() 是核心判定"插件能不能用"的入口，
  //    一旦抛异常，状态页只会显示一句无信息量的"不可用"，原因反而被吞掉。
  try {
    const data = loadData();
    if (!data) return { ok: false, reason: `数据表不可用：${dataError || '未知原因'}` };
    const assets = loadAssets();
    // 启动时空目录/文件未就位会让第一次扫描缓存成空集，而在位之后不会自动重扫 ——
    // 这里做一次"缓存为空则重扫"，避免装完素材还要重启才认。
    if (!assets.size) {
      assetsCache = null;
      if (!loadAssets().size) {
        return { ok: false, reason: `素材不可用：${assetsError || 'assets 目录里没有 jyt-*.jpg'}` };
      }
    }
    // v3：逐张核对数据表要的素材（121 张）。少一张就明确报出来，别等到抽牌时才"图片生成失败"。
    const miss = missingAssets(data, assets);
    if (miss.length) {
      return { ok: false, reason: `素材缺失 ${miss.length} 张（如 ${miss.slice(0, 3).join('、')}）` };
    }
    return { ok: true };
  } catch (error) {
    const msg = String(error?.message ?? error).slice(0, 160);
    warn('塔罗：available() 自检异常 →', msg);
    return { ok: false, reason: `自检异常：${msg}` };
  }
}

/**
 * 重新启用：**必须复位 deactivated**。
 *
 * ⚠️ 核心的 `setExtensionEnabled()` 走的是 `skillManager.activate(id)` ⇒ 只会调插件的
 *    `activate()`，**不会重新 import 模块**。而 deactivate() 会把 deactivated 置 true，
 *    若不在这里复位，用户把插件**关一次再开**，标志还是 true ⇒ 每次抽牌都只回
 *    "（图片生成失败：插件已停用）"，但照扣当日额度、照写账本。只有重启或热重载才会自愈。
 */
export function activate() {
  deactivated = false;
  // 渲染窗口/服务都是懒启动的（首次渲染时才建），这里不需要预热
  return { ok: true };
}

export function deactivate() {
  deactivated = true;
  lifecycle += 1;
  // ⚠️ 这里**故意不销毁渲染窗口**，只停本地服务。
  //   实测：Electron「销毁一个 BrowserWindow 之后再新建窗口」会让渲染进程直接崩
  //   （连 crashpad 都断开）；而热重载恰好就是"旧实例 deactivate → 新实例 setup"。
  //   窗口改为跨实例复用、只建一次、永不销毁：代价是常驻一个隐藏窗口，
  //   比"热重载后功能全废"划算得多。
  if (activeRenders === 0) stopServer();
  log('塔罗：已停用（渲染窗口按设计保留）');
}

function stopServer() {
  try { httpServer?.close(); } catch { /* 服务未起或已关 */ }
  httpServer = null;
  httpPort = 0;
  currentHtml = '';
}

export function dispose() {
  deactivate();
  // 数据表/素材缓存可以安全释放：重新加载成本很低（它们只是内存里的对象）。
  dataMajor = null; dataMinor = null; dataCourt = null; dataLuck = null; dataCombo = null;
  assetsCache = null;
  // ⚠️ 临时账本**故意不清**：它是落盘的，重新 import 后重新读盘。
  //    若在这里清成 null，热重载时"刚 /测塔罗 过的牌"就白存了。
  testLedgerCache = undefined;
}

// ── 指令能力 ──────────────────────────────────────────────────────────
/** 取公共的 payload 字段。 */
function payloadCtx(payload) {
  const ctx = payload.ctx || {};
  const qq = String(payload.from?.id ?? '');
  const chatKey = String(payload.chat?.chatKey
    || `${kindOf(payload)}:${payload.chat?.chatId || payload.ctx?.chatId || ''}`);
  const word = String(payload.command || '').trim();
  const who = String(payload.from?.name || '').trim();
  const parts = Array.isArray(payload.parts) ? payload.parts.map((s) => String(s).trim()).filter(Boolean) : [];
  const prefix = String(payload.prefix ?? '').trim() || '/';
  return { ctx, qq, chatKey, word, who, parts, prefix };
}

export const providers = {
  /** /塔罗 —— 出图一（主题 + 事件 + 宫廷，不给建议） */
  'command.tarot-today': async (payload = {}) => {
    const { ctx, qq, chatKey, word, who } = payloadCtx(payload);
    if (!qq) return { text: '拿不到你的 QQ 号，抽不了牌。' };
    if (typeof ctx?.sender?.sendImage !== 'function') return { text: '当前协议端没有提供发图能力，稍后再试。' };
    return runTarot({ ctx, qq, chatKey, mode: 'today', word, who });
  },

  /** /抽签解读 —— 出图二（签位 + 最终建议 + 宫廷指引），要先抽过塔罗 */
  'command.tarot-luck': async (payload = {}) => {
    // ⚠️ prefix 必须从 payloadCtx 解构出来再传下去。漏了它就是一个 ReferenceError，
    //    整条指令直接抛错（网关只会回"执行失败，详见控制台"），实测踩过。
    const { ctx, qq, chatKey, word, who, prefix } = payloadCtx(payload);
    if (!qq) return { text: '拿不到你的 QQ 号，抽不了签。' };
    if (typeof ctx?.sender?.sendImage !== 'function') return { text: '当前协议端没有提供发图能力，稍后再试。' };
    return runLuckReading({ ctx, qq, chatKey, word, who, prefix });
  },

  /** /测塔罗 —— 测试通道：不入账、可随机、可指定大/小/宫廷与正逆 */
  'command.tarot-test': async (payload = {}) => {
    const gate = testGate(payload);
    if (!gate.ok) return { text: gate.text };
    const { ctx, qq, chatKey, word, who, parts, prefix } = payloadCtx(payload);
    if (typeof ctx?.sender?.sendImage !== 'function') return { text: '当前协议端没有提供发图能力，稍后再试。' };

    const data = loadData();
    if (!data) return { text: `塔罗数据表读取失败，暂时抽不了牌。${dataError ? '（' + dataError + '）' : ''}` };
    const { spec, bad } = parseTestArgs(parts, data);
    if (bad.length) {
      const w = word || '测塔罗';
      return {
        text: `参数看不懂：${bad.join(' ')}。用法：${prefix}${w} · ${prefix}${w} 大 [0-${MAJOR_COUNT - 1}] [正|逆]`
          + ` · ${prefix}${w} 小 [01-${MINOR_COUNT}] [正|逆] · ${prefix}${w} 宫 [01-${COURT_COUNT}] [正|逆]`
          + ` · ${prefix}${w} 宫 权杖王后 逆 · ${prefix}${w} 大 15 逆 小 07 正 宫 03 逆`
      };
    }
    return runTarot({ ctx, qq, chatKey, mode: 'test', spec, word: word || '测塔罗', who });
  },

  /** /测抽签 —— 测试通道：指定签位看能不能正常出图，不记账 */
  'command.tarot-luck-test': async (payload = {}) => {
    const gate = testGate(payload);
    if (!gate.ok) return { text: gate.text };
    const { ctx, qq, chatKey, word, who, parts, prefix } = payloadCtx(payload);
    if (typeof ctx?.sender?.sendImage !== 'function') { return { text: '当前协议端没有提供发图能力，稍后再试。' }; }

    const data = loadData();
    if (!data) return { text: `塔罗数据表读取失败，暂时抽不了签。${dataError ? '（' + dataError + '）' : ''}` };
    const names = Object.keys(data.luck);
    const want = String(parts[0] || '').trim();
    if (parts.length > 1 || (want && !data.luck[want])) {
      const b = want || parts.join(' ');
      const w = word || '测抽签';
      return { text: `参数看不懂：${b}。用法：${prefix}${w} ${names.join('|')}` };
    }
    return runLuckReading({
      ctx, qq, chatKey, forceLuck: want, word: word || '测抽签', who, prefix, isTest: true
    });
  }
};

// 供自检/测试用（不对外暴露成能力）
export const internals = {
  PLUGIN_VERSION, localDayKey, todayText, hashStr, mulberry32, rngFor,
  drawThree, drawTest, drawLuck, buildTemplate, buildTarotHtml, buildLuckHtml, pageCss,
  majorAssetName, minorAssetName, courtAssetName, luckAssetName,
  rememberTestDraw, getTestDraw, DOMAIN_ATTRS,
  loadData, loadAssets, missingAssets, loadLedger, saveLedger, getDraw, countDraws, isValidEntry,
  parseIds, parseTestArgs, testGate, resultText, health,
  MINOR_COUNT, COURT_COUNT, MAJOR_COUNT, TAROT_WIDTH, LUCK_WIDTH,
  get dataError() { return dataError; },
  get assetsError() { return assetsError; },
  get lastConfigError() { return lastConfigError; },
  get httpPort() { return httpPort; }
};
