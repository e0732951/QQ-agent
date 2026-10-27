// 本地资料库（插件 id 仍是 sticker-memory，旧指纹和描述接着用）。
// 图片和视频都记指纹 + 描述。下次同一份内容再出现，直接把描述交给模型，
// 拦下 get_message_images / get_sticker_image / read_video，不再看一遍。
// 自动遗忘默认关。打开后，早于 forgetDays 天的记录从最旧的一条开始删除。
//
// ══════════════════════════════════════════════════════════════════════════
// 一、为什么是**插件**（plugins/，确定性型），不是技能（skills/）
// ══════════════════════════════════════════════════════════════════════════
// 按 doc/extend_development/skill-development.md §0 的三问判断法：
//
//   第一问「触发时机能用 if 描述吗？」
//     if (模型正要调 get_message_images / get_sticker_image)        → ✅ 能，死条件
//     if (这条消息里的图片指纹已经在记忆库里)                        → ✅ 能，死条件
//   第二问「漏触发一次的代价是什么？」
//     漏一次 = 白白多花一次识图 token、多等一次模型。这不是"少个花活"，
//     而是这个功能的存在意义本身（省时间、省 token）。→ 必须每次都跑
//   第三问「参数从哪来？」
//     参数全是系统给的：会话、消息 id、媒体 url/file、图片字节。→ 插件
//
//   三问一致 → 插件。所以它用 hooks + 工具（不声明任何自建能力）：钩子由核心
//   在固定时机必然调用，"想不想省"不由模型决定；模型只负责一件事 —— 第一次
//   看完图后把含义记下来（remember_image 工具），那是"要不要写笔记"的语义判断。
//
//   （为什么没有 providers：`plugin-development.md` §5 写得很清楚 —— 自建能力名
//     核心不认识，只有别的 Skill 会用 api.capability() 找它。本插件没有这样的
//     消费方，声明成 capability 只会被审计报成"公开能力、暂无消费方"。）
//
// ⚠️ 关键事实（读源码 + 文档确认，决定了整个设计）：
//   · 收消息时图片只渲染成 [图片] 占位（src/onebot.js segmentsToText），
//     模型**不会**自动看到图 —— 唯一的看图入口是核心工具
//     get_message_images（别人的图）与 get_sticker_image（自己的收藏）。
//     所以"跳过图像识别"= 在这两个工具执行前拦下它。
//   · 5 个 hook 只在**一次模型会话运行**里触发（orchestrator.js 的 #runAgent），
//     没触发会话的消息看不见 —— 恰好本功能只在"要看图"时才需要介入。
//   · before-tool 能返回 { block: true, reason }，顶层会把 reason 原样当作
//     工具结果文本回给模型（orchestrator.js:1147）。所以缓存命中的含义就是
//     这样"零成本地"喂给模型的：不是报错，而是一句说明。
//
// ══════════════════════════════════════════════════════════════════════════
// 二、指纹与命中率（这一节是"能不能真省下来"的关键）
// ══════════════════════════════════════════════════════════════════════════
// 同一个表情包，QQ 每次下发的 url 往往带不同的 rkey（会过期），所以**不能只
// 靠 url 认图**。这里的键有三层，任意一层命中即算认识：
//   src:<内容 sha1>   图片字节的哈希 —— 最可靠，跨群跨人通用（首选）
//   file:<file 字段>  OneBot 给的图片标识（文件名或资源 id）
//   st:<表情 id/resId> 机器人自己的收藏表情身份
// 首见一张图要下载一次字节才能算 src 键（此后永久有效，老图库也自动受益）。
// 为了不拖慢对话：解析带预算（默认 2.8 秒，见 maxDownloadMs 设置），超预算就
// **本轮不拦截**（照常看图），但下载在后台继续 —— 下一次再遇到就已经命中了。
//
//   · 视频不整段下载来算指纹：QQ 的文件名、B站 BV 号先对上；
//     本地文件还在时再抽样哈希（头尾各 256KB + 体积）。
//   · 自动遗忘（autoForget，默认关）：打开后，记下时间早于 forgetDays 的记录
//     从最旧的一条开始删除。关掉就一直留着，直到手动忘掉或顶到条数上限。
//
// ══════════════════════════════════════════════════════════════════════════
// 三、边界（都不会让对话出错）
// ══════════════════════════════════════════════════════════════════════════
//   · 所有 hook 内部全程 try/catch：本插件出任何问题都只是"没生效"，
//     绝不中断对话（hook 超时/抛错本身也只记日志、跳过该 Skill）。
//   · 网络：清单声明了 permissions: ["web_fetch"]，但优先走核心的
//     safe-fetch.safeFetchBinary —— 与项目其它联网模块同一套 SSRF 口径
//     （DNS 全记录内网检查 + 固定 IP 防 rebinding）。只有拿不到核心模块时，
//     才退回自带的护栏下载器（只放行公网 http(s)、限 12MB、8 秒超时、只收图片）。
//   · 只读别人，不写别人的库：不改 data/stickers.json（那是 StickerManager
//     的内存态，外部写会互相覆盖）。表情库的备注走模型自己的 sticker_note。
//   · 图片和视频都记。指纹是内容本身，同一份字节才会命中；内容变了就是新的一条。
//   · 缓存落在 data/sticker-memory/，不用 process.cwd() 当锚点。
//   · 不写任何密钥/Cookie：全部数据都在本机 data/sticker-memory/cache.json。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const PLUGIN_ID = 'sticker-memory';
const DIR = path.join(DATA_DIR, PLUGIN_ID);
const CACHE_FILE = path.join(DIR, 'cache.json');
const FLUSH_DEBOUNCE_MS = 8000;
const MAX_BYTES = 12 * 1024 * 1024;
const MIN_VIEW_LINK_MS = 10 * 60 * 1000;      // "刚看过"的关联有效期（10 分钟）
const MAX_PENDING_PER_CHAT = 6;
const MAX_NOTE_CHARS = 400;
const MAX_VALUE_CHARS = 180;

const REMEMBER_TOOL = 'sticker-memory__remember_image';
const FORGET_TOOL = 'sticker-memory__forget_cached_image';

/** 与 plugin.json 的 settings 保持一致（留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  maxCacheEntries: 2000,
  maxDownloadMs: 2800,
  autoForget: false,
  forgetDays: 30,
  hotTrendManaged: true,
  hotTrendMaxEntries: 300,
  hotTrendAutoForget: true,
  hotTrendForgetDays: 7
};

let cfg = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};
let safeFetchBinary = null;
let apiFetch = null;

// ─────────────────────────────────────────────── 配置

function conf() {
  let merged = { ...DEFAULTS };
  try {
    const raw = cfg();
    if (raw && typeof raw === 'object') merged = { ...merged, ...raw };
  } catch { /* 配置读不到就用默认值 */ }
  return {
    enabled: merged.enabled !== false,
    maxCacheEntries: clamp(Number(merged.maxCacheEntries), 50, 20000, DEFAULTS.maxCacheEntries),
    maxDownloadMs: clamp(Number(merged.maxDownloadMs), 200, 4500, DEFAULTS.maxDownloadMs),
    autoForget: merged.autoForget === true,
    forgetDays: clamp(Math.round(Number(merged.forgetDays)), 1, 3650, DEFAULTS.forgetDays),
    hotTrendManaged: merged.hotTrendManaged !== false,
    hotTrendMaxEntries: clamp(Math.round(Number(merged.hotTrendMaxEntries)), 20, 2000, DEFAULTS.hotTrendMaxEntries),
    hotTrendAutoForget: merged.hotTrendAutoForget !== false,
    hotTrendForgetDays: clamp(Math.round(Number(merged.hotTrendForgetDays)), 1, 3650, DEFAULTS.hotTrendForgetDays)
  };
}

const SOURCE_POLICIES = {
  media: {
    label: '图片和视频',
    managed: (c) => c.enabled,
    maxEntries: (c) => c.maxCacheEntries,
    autoForget: (c) => c.autoForget,
    forgetDays: (c) => c.forgetDays
  },
  'hot-trend-tracker': {
    label: '热梗',
    managed: (c) => c.enabled && c.hotTrendManaged,
    maxEntries: (c) => c.hotTrendMaxEntries,
    autoForget: (c) => c.hotTrendAutoForget,
    forgetDays: (c) => c.hotTrendForgetDays
  }
};

function policyOf(sourceId) {
  const def = SOURCE_POLICIES[sourceId];
  if (!def) return { available: false, source: sourceId, managed: false };
  const c = conf();
  return {
    available: true,
    source: sourceId,
    label: def.label,
    managed: Boolean(def.managed(c)),
    maxEntries: def.maxEntries(c),
    autoForget: Boolean(def.autoForget(c)),
    forgetDays: def.forgetDays(c)
  };
}

/** 热梗这类按时间堆积的记录：打开遗忘就删掉早于天数的，再按上限留下较新的。 */
function retainTopics(topics, policy, now = nowMs()) {
  const list = Array.isArray(topics) ? topics.filter((t) => t && t.title) : [];
  let alive = list;
  if (policy?.autoForget && policy.forgetDays > 0) {
    const cutoff = now - policy.forgetDays * 86400000;
    alive = list.filter((t) => Number(t.lastSeenAt || t.firstSeenAt || 0) >= cutoff);
  }
  const max = Math.max(1, Number(policy?.maxEntries) || alive.length || 1);
  if (alive.length <= max) return alive;
  return alive
    .slice()
    .sort((a, b) => Number(b.lastSeenAt || b.firstSeenAt || 0) - Number(a.lastSeenAt || a.firstSeenAt || 0)
      || Number(b.score || 0) - Number(a.score || 0))
    .slice(0, max);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─────────────────────────────────────────────── 小工具

function clean(s, max = MAX_NOTE_CHARS) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 提示词里的值要防注入：去掉换行/方括号，避免被当成系统指令。 */
function safeValue(s, max = MAX_VALUE_CHARS) {
  return clean(s, max).replace(/[[\]{}<>]/g, '').trim();
}

function nowMs() {
  return Date.now();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/** 只放行公网 http(s) 直链（与项目里其它联网模块的 SSRF 口径一致）。 */
function isPublicHttpUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127|10|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host.includes(':')) return false;
  return true;
}

function fileUriToPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return '';
  try {
    let pathname = decodeURIComponent(new URL(value).pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return '';
  }
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 32);
}

function isAnimationMarker(summary) {
  const s = String(summary ?? '');
  return /动画表情|動畫表情|animated|sticker|表情包|meme/i.test(s);
}

// ─────────────────────────────────────────────── 记忆库存储层

/** 内存库：entry = { src,file,st,vid,extra,kind,chatKey,note,source,createdAt,usedAt,useCount,hits } */
const store = {
  entries: new Map(),
  byKey: new Map(),
  buckets: new Map(),
  loadedAt: 0,
  dirty: false,
  lastFlush: 0
};

function keysOf(entry) {
  const keys = [];
  if (entry.src) keys.push(`src:${entry.src}`);
  if (entry.file) keys.push(`file:${entry.file}`);
  if (entry.st) keys.push(`st:${entry.st}`);
  if (entry.vid) keys.push(`vid:${entry.vid}`);
  for (const k of Array.isArray(entry.extra) ? entry.extra : []) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

function indexEntry(entry) {
  for (const k of keysOf(entry)) store.byKey.set(k, entry);
}

function unindexEntry(entry) {
  for (const k of keysOf(entry)) {
    if (store.byKey.get(k) === entry) store.byKey.delete(k);
  }
}

function loadStore() {
  if (store.loadedAt) return;
  store.loadedAt = nowMs();
  store.buckets = new Map();
  const raw = readJson(CACHE_FILE, null);
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const note = clean(item.note);
    if (!note) continue;
    const entry = {
      src: clean(item.src, 64),
      file: clean(item.file, 200),
      st: clean(item.st, 120),
      vid: clean(item.vid, 80),
      extra: Array.isArray(item.extra)
        ? item.extra.map((k) => clean(k, 220)).filter((k) => /^(src|file|st|vid):/.test(k)).slice(0, 8)
        : [],
      kind: item.kind === 'video' ? 'video' : 'image',
      chatKey: clean(item.chatKey, 60),
      note,
      source: item.source === 'model' ? 'model' : 'observed',
      createdAt: num(item.createdAt, nowMs()),
      usedAt: num(item.usedAt, 0),
      useCount: Math.max(0, num(item.useCount, 0)),
      hits: Math.max(0, num(item.hits, 0))
    };
    if (!entry.src && !entry.file && !entry.st && !entry.vid && !entry.extra.length) continue;
    store.entries.set(`${entry.src}|${entry.file}|${entry.st}|${entry.vid}|${entry.createdAt}`, entry);
    indexEntry(entry);
  }
  const buckets = raw?.buckets;
  if (buckets && typeof buckets === 'object' && !Array.isArray(buckets)) {
    for (const [id, bucket] of Object.entries(buckets)) {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      store.buckets.set(id, bucket);
    }
  }
  importHotTrendFile();
  forgetExpired();
  if (list.length) log(`资料库已加载：${store.entries.size} 条（${path.basename(CACHE_FILE)}）`);
}

function flushStore(force = false) {
  if (!store.dirty) return false;
  const now = nowMs();
  if (!force && now - store.lastFlush < FLUSH_DEBOUNCE_MS) return false;
  store.lastFlush = now;
  store.dirty = false;
  try {
    forgetExpired();
    trimStore();
    writeJsonAtomic(CACHE_FILE, {
      version: 3,
      savedAt: new Date(now).toISOString(),
      entries: [...store.entries.values()].map((e) => ({
        src: e.src, file: e.file, st: e.st, vid: e.vid || '', extra: e.extra || [],
        kind: e.kind === 'video' ? 'video' : 'image',
        chatKey: e.chatKey,
        note: e.note, source: e.source,
        createdAt: e.createdAt, usedAt: e.usedAt, useCount: e.useCount, hits: e.hits
      })),
      buckets: Object.fromEntries(store.buckets)
    });
    store.dirty = false;
    return true;
  } catch (error) {
    warn(`记忆库写盘失败：${error?.message ?? error}`);
    store.dirty = true;
    return false;
  }
}

function importHotTrendFile() {
  const id = 'hot-trend-tracker';
  if (store.buckets.has(id)) return;
  const file = path.join(DATA_DIR, 'hot-trends.json');
  if (!fs.existsSync(file)) return;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!parsed || !Array.isArray(parsed.topics)) return;
  store.buckets.set(id, parsed);
  store.dirty = true;
  if (!flushStore(true)) {
    warn('热梗资料并入后写盘失败，原文件先留着');
    return;
  }
  try { fs.renameSync(file, `${file}.imported`); } catch { /* 原文件留着也不影响，桶里已经有了 */ }
  log(`已把热梗资料并入本地资料库，共 ${parsed.topics.length} 条`);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function libraryBucket(args = {}) {
  const source = String(args.source || '');
  const policy = policyOf(source);
  if (!policy.available) return { available: false, managed: false };
  if (args.action === 'policy' || !args.action) return policy;
  loadStore();
  if (args.action === 'load') {
    const bucket = store.buckets.get(source);
    return { ...policy, store: bucket ? cloneJson(bucket) : null };
  }
  if (args.action === 'save') {
    const incoming = args.store;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { ...policy, ok: false };
    const next = cloneJson(incoming);
    let pruned = 0;
    if (policy.managed && Array.isArray(next.topics)) {
      const kept = retainTopics(next.topics, policy);
      pruned = next.topics.length - kept.length;
      next.topics = kept;
    }
    store.buckets.set(source, next);
    store.dirty = true;
    flushStore(true);
    return { ...policy, ok: true, pruned, total: Array.isArray(next.topics) ? next.topics.length : 0 };
  }
  return policy;
}

function trimStore() {
  const limit = conf().maxCacheEntries;
  if (store.entries.size <= limit) return;
  const sorted = [...store.entries.entries()].sort((a, b) => score(a[1]) - score(b[1]));
  const drop = store.entries.size - limit;
  for (let i = 0; i < drop; i++) {
    const [id, entry] = sorted[i];
    unindexEntry(entry);
    store.entries.delete(id);
  }
  store.dirty = true;
  log(`记忆库超过上限，淘汰 ${drop} 条最久未用的条目`);
}

/** 排序分：用得多的、最近用过的留下。 */
function score(e) {
  return (e.useCount || 0) * 1e12 + (e.usedAt || e.createdAt || 0);
}

function forgetExpired() {
  const c = conf();
  if (!c.autoForget) return 0;
  const cutoff = nowMs() - c.forgetDays * 86400000;
  const old = [...store.entries.entries()]
    .filter(([, e]) => Number(e.createdAt) > 0 && Number(e.createdAt) < cutoff)
    .sort((a, b) => Number(a[1].createdAt) - Number(b[1].createdAt));
  if (!old.length) return 0;
  for (const [id, entry] of old) {
    unindexEntry(entry);
    store.entries.delete(id);
  }
  store.dirty = true;
  log(`自动遗忘：删掉 ${old.length} 条早于 ${c.forgetDays} 天的记录（从最旧的开始）`);
  return old.length;
}

function putEntry({ keys = [], note, chatKey = '', source = 'observed', onlyIfEmpty = false, kind = '' }) {
  loadStore();
  const cleanNote = clean(note);
  if (!cleanNote) return { ok: false, reason: 'note 为空' };
  const parts = keysToObject(keys);
  if (!parts.src && !parts.file && !parts.st && !parts.vid && !(parts.extra || []).length) {
    return { ok: false, reason: '没有可用的指纹' };
  }

  const hit = lookupByKeys(parts);
  if (hit) {
    if (onlyIfEmpty && hit.note) return { ok: true, entry: hit, unchanged: true };
    hit.note = cleanNote;
    hit.source = source;
    hit.usedAt = nowMs();
    hit.useCount = (hit.useCount || 0) + 1;
    if (parts.src && !hit.src) hit.src = parts.src;
    if (parts.file && !hit.file) hit.file = parts.file;
    if (parts.st && !hit.st) hit.st = parts.st;
    if (parts.vid && !hit.vid) hit.vid = parts.vid;
    else if (parts.vid && hit.vid && parts.vid !== hit.vid) {
      const extraKey = `vid:${parts.vid}`;
      if (!keysOf(hit).includes(extraKey)) hit.extra = [...(hit.extra || []), extraKey];
    }
    for (const k of parts.extra || []) {
      if (k && !keysOf(hit).includes(k)) hit.extra = [...(hit.extra || []), k];
    }
    if (kind === 'image' || kind === 'video') hit.kind = kind;
    if (chatKey) hit.chatKey = chatKey;
    indexEntry(hit);
    store.dirty = true;
    return { ok: true, entry: hit, updated: true };
  }

  const entry = {
    src: parts.src, file: parts.file, st: parts.st, vid: parts.vid,
    extra: parts.extra || [],
    kind: kind === 'video' || parts.vid ? 'video' : 'image',
    chatKey: clean(chatKey, 60),
    note: cleanNote,
    source,
    createdAt: nowMs(),
    usedAt: nowMs(),
    useCount: 0,
    hits: 0
  };
  store.entries.set(`${entry.src}|${entry.file}|${entry.st}|${entry.vid}|${entry.createdAt}`, entry);
  indexEntry(entry);
  store.dirty = true;
  return { ok: true, entry, created: true };
}

function lookupByKeys(spec = {}) {
  loadStore();
  const keys = [];
  if (Array.isArray(spec)) keys.push(...spec);
  else {
    if (spec.src) keys.push(`src:${spec.src}`);
    if (spec.file) keys.push(`file:${spec.file}`);
    if (spec.st) keys.push(`st:${spec.st}`);
    if (spec.vid) keys.push(`vid:${spec.vid}`);
    if (Array.isArray(spec.extra)) keys.push(...spec.extra);
  }
  for (const k of keys) {
    const e = store.byKey.get(String(k));
    if (e) return e;
  }
  return null;
}

function forgetEntry(keys = []) {
  loadStore();
  const hit = lookupByKeys(keysToObject(keys));
  if (!hit) return false;
  unindexEntry(hit);
  for (const [id, e] of store.entries) {
    if (e === hit) store.entries.delete(id);
  }
  store.dirty = true;
  return true;
}

// ─────────────────────────────────────────────── 指纹解析

/** key → Promise<keys[]|null>，同一个图只算一次。 */
const keyCache = new Map();
const inflight = new Map();

function rememberKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  for (const k of keys) keyCache.set(k, Promise.resolve(keys));
}

/**
 * 把一张 incoming 图片解析成一组键。带预算：超时返回 null（本轮不拦截，
 * 但后台的 Promise 会继续跑完并把结果写进 keyCache，所以下次就命中了）。
 */
async function resolveMediaKeys(media, budgetMs) {
  if (!media || typeof media !== 'object') return null;
  loadStore();

  const file = clean(media.file, 200);
  const url = String(media.url || '').trim();
  const direct = [];
  if (file) direct.push(`file:${file}`);
  if (file) direct.push(`src:${file.toLowerCase()}`);

  // 0) 内存键缓存（最快路径：上一轮已经算过）
  for (const k of direct) {
    const cached = keyCache.get(k);
    if (cached) return cached;
  }
  // 1) 直接命中记忆库（不下载）
  if (lookupByKeys({ file })) return direct.length ? direct : null;

  // 2) 需要下载字节算 src 键（或命中本机已存在的文件）
  const local = fileUriToPath(url);
  const cacheKey = url || file;
  let job = inflight.get(cacheKey);
  if (!job) {
    job = (async () => {
      const buf = await fetchImageBytes({ url, file, local });
      if (!buf || !buf.length) return null;
      const keys = [];
      if (file) keys.push(`file:${file}`);
      keys.push(`src:${sha1(buf)}`);
      return keys;
    })();
    job.then((keys) => {
      if (keys && keys.length) rememberKeys(keys);
    }).catch(() => { /* 下载失败：本轮不拦截 */ }).finally(() => {
      inflight.delete(cacheKey);
    });
    inflight.set(cacheKey, job);
  }

  const keys = await withBudget(job, budgetMs);
  if (keys && keys.length) {
    rememberKeys(keys);
    return keys;
  }
  return null;
}

function withBudget(promise, ms) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

/**
 * 取图片字节。四条来源，依次尝试：
 *   ① data: URL（模型看过图后 store 里可能是这个）
 *   ② 本机 file:/// 路径（自己收藏的表情、QQ 本地缓存）
 *   ③ OneBot get_image 指到的本地文件（协议端缓存）
 *   ④ 公网直链：优先走核心 safe-fetch（SSRF 防护与全项目同源），
 *      拿不到 core 时才退回自己那一份带护栏的 fetch
 */
async function fetchImageBytes({ url = '', file = '', local = '' } = {}) {
  const dataUrl = String(url || '');
  if (/^data:image\//i.test(dataUrl)) {
    const idx = dataUrl.indexOf('base64,');
    if (idx > 0) {
      try { return Buffer.from(dataUrl.slice(idx + 7), 'base64'); } catch { return null; }
    }
    return null;
  }

  const candidates = [];
  if (local) candidates.push(local);
  if (!local && file && (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/'))) candidates.push(file);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.length) return buf;
      }
    } catch { /* 试下一个来源 */ }
  }

  // 协议端缓存：get_image 能把 file 换成可读的本地路径 / 下载地址
  if (file) {
    try {
      const onebot = currentOnebot();
      if (onebot?.call) {
        const ret = await onebot.call('get_image', { file: String(file) });
        const p = ret?.file ? String(ret.file) : '';
        if (p && fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          if (buf.length) return buf;
        }
        const got = String(ret?.url || '');
        if (got && isPublicHttpUrl(got)) return await downloadPublic(got);
      }
    } catch { /* 落到直链 */ }
  }

  if (url && isPublicHttpUrl(url)) return await downloadPublic(url);
  return null;
}

async function downloadPublic(url) {
  if (typeof safeFetchBinary === 'function') {
    try {
      const { buffer } = await safeFetchBinary(String(url), MAX_BYTES);
      return buffer?.length ? buffer : null;
    } catch {
      // 走核心失败（网络/超时/被 SSRF 口径拦下）：不再自己重试一次，
      // 避免"核心说不行、插件偏要试"这种绕过安全口径的行为。
      return null;
    }
  }
  return downloadGuarded(url);
}

/**
 * 退路下载器（只有拿不到核心 safe-fetch 时才走到）：清单声明了 web_fetch 权限，
 * 所以这里才有 api.fetch。护栏照抄项目口径：只放行公网 http(s)、限 12MB、
 * 8 秒超时、只接受图片响应。
 *
 * ⚠️ 与核心 safe-fetch 的差距要说清：核心会做 DNS 全记录内网检查并固定 IP
 *    防 rebinding，这里只做主机名字面量检查。这是"核心模块缺失时仍可用"的
 *    权衡，不是替代品 —— 正常部署里永远走核心那条路。
 */
async function downloadGuarded(url) {
  if (typeof apiFetch !== 'function') return null;
  if (!isPublicHttpUrl(url)) return null;
  try {
    const resp = await apiFetch(String(url), {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'image/*,*/*;q=0.8' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    });
    if (!resp?.ok) return null;
    const type = String(resp.headers?.get?.('content-type') || '');
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
    const declared = Number(resp.headers?.get?.('content-length') || 0);
    if (declared && declared > MAX_BYTES) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

let onebotRef = null;

function currentOnebot() {
  return onebotRef;
}

const VIDEO_SAMPLE = 256 * 1024;

function sampleFileHash(filePath) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0 || st.size > 2 * 1024 * 1024 * 1024) return '';
    fd = fs.openSync(filePath, 'r');
    const headLen = Math.min(VIDEO_SAMPLE, st.size);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(VIDEO_SAMPLE, st.size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, Math.max(0, st.size - tailLen));
    const hash = crypto.createHash('sha1');
    hash.update(`v1:${st.size}:`);
    hash.update(head);
    hash.update(tail);
    return hash.digest('hex').slice(0, 32);
  } catch {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function cheapVideoKeys(media) {
  const keys = [];
  const file = clean(media?.file, 200);
  const bvid = clean(media?.bvid, 32);
  const aid = clean(media?.aid, 32);
  const pageUrl = String(media?.pageUrl || '').trim();
  if (file) keys.push(`file:${file}`);
  if (bvid) keys.push(`vid:${bvid}`);
  if (aid) keys.push(`vid:${/^av/i.test(aid) ? aid : `av${aid}`}`);
  if (pageUrl) keys.push(`vid:url_${sha1(Buffer.from(pageUrl))}`);
  return keys;
}

/** 视频指纹：先用文件名和 BV 号，本地文件还在时再抽样哈希。不整段下载。 */
async function resolveVideoKeys(media, budgetMs) {
  if (!media || media.kind && media.kind !== 'video') return null;
  loadStore();
  const keys = cheapVideoKeys(media);
  if (keys.some((k) => store.byKey.has(k))) return keys;

  const deadline = nowMs() + Math.max(0, Number(budgetMs) || 0);
  let local = '';
  const pathHint = String(media.path || '').trim();
  if (pathHint && fs.existsSync(pathHint)) local = pathHint;
  const file = clean(media.file, 200);
  if (!local && file && (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/')) && fs.existsSync(file)) local = file;
  if (!local && file && nowMs() < deadline) {
    try {
      const onebot = currentOnebot();
      if (onebot?.call) {
        const ret = await onebot.call('get_video', { file: String(file) });
        const p = ret?.file ? String(ret.file) : '';
        if (p && fs.existsSync(p)) local = p;
      }
    } catch { /* 没有本地文件就只用文件名和 BV 号 */ }
  }
  if (local) {
    const hash = sampleFileHash(local);
    if (hash) keys.push(`src:${hash}`);
  }
  if (keys.length) rememberKeys(keys);
  return keys.length ? keys : null;
}

function addResolved(st, entryId, item) {
  const id = String(entryId || '');
  if (!id || !item?.keys?.length) return;
  const prev = st.resolved.get(id);
  const items = Array.isArray(prev?.items) ? prev.items.slice() : [];
  const idx = items.findIndex((it) => it.media === item.media);
  if (idx >= 0) items[idx] = item;
  else items.push(item);
  st.resolved.set(id, { items, keys: items[0].keys, media: items[0].media });
}

function resolvedItems(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.items) && rec.items.length) return rec.items;
  if (Array.isArray(rec.keys)) return [rec];
  return [];
}

function kindLabel(kind) {
  return kind === 'video' ? '视频' : '图片';
}

function stampKnown(text, kind, note) {
  const value = safeValue(note);
  if (kind === 'video') {
    if (text.includes('[B站视频]')) return text.replace('[B站视频]', `[B站视频·已知资料：${value}]`);
    if (text.includes('[视频]')) return text.replace('[视频]', `[视频·已知资料：${value}]`);
    return `${text}${text ? ' ' : ''}${`[视频·已知资料：${value}]`}`;
  }
  if (text.includes('[图片]')) return text.replace('[图片]', `[图片·已知资料：${value}]`);
  return `${text}${text ? ' ' : ''}${`[图片·已知资料：${value}]`}`;
}

// ─────────────────────────────────────────────── 有效性判定

function validForChat(entry) {
  return Boolean(entry && entry.note);
}

function markHit(entry, chatKey) {
  entry.usedAt = nowMs();
  entry.useCount = (entry.useCount || 0) + 1;
  entry.hits = (entry.hits || 0) + 1;
  if (chatKey) entry.chatKey = entry.chatKey || clean(chatKey, 60);
  store.dirty = true;
  flushStore();
}

// ─────────────────────────────────────────────── 会话内状态（进程内、不落盘）

// sessionId -> { chatKey, resolved:Map<entryId,{keys,media}>, viewed:Map, byMid:Map,
//                saved:[], injected:bool, store:ChatStore|null, stickers:StickerManager|null }
const sessions = new Map();

function sessionState(sessionId, chatKey) {
  const id = String(sessionId || chatKey || 'unknown');
  let st = sessions.get(id);
  if (!st) {
    st = {
      chatKey: String(chatKey || ''),
      resolved: new Map(),
      viewed: new Map(),
      byMid: new Map(),
      saved: [],
      injected: false,
      store: null,
      stickers: null,
      at: nowMs()
    };
    sessions.set(id, st);
    // 保留最近 200 个会话状态，防止长跑内存增长
    if (sessions.size > 200) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
  }
  st.at = nowMs();
  if (!st.chatKey && chatKey) st.chatKey = String(chatKey);
  return st;
}

function pruneSessions() {
  const cutoff = nowMs() - 6 * 3600 * 1000;
  for (const [id, st] of sessions) {
    if (st.at < cutoff) sessions.delete(id);
  }
}

// ─────────────────────────────────────────────── 收藏表情索引（供集合表情复用）

const stickerIndex = new Map();   // key(id / resId / emojiId / qqFile) -> { id, note }
let stickerIndexAt = 0;

/**
 * 从运行期的 StickerManager 快照里建"表情身份 → 已有备注"索引。
 * 只用读，不写回：data/stickers.json 的权威持有者是 StickerManager 自己
 * （它有内存态，外部写会互相覆盖）。TTL 60 秒，避免每轮都重建。
 * 这样"机器人要看自己的收藏表情"这条链也能命中库里的 desc/localNote。
 */
function refreshStickerIndex(manager) {
  const entries = manager && Array.isArray(manager.entries) ? manager.entries : null;
  if (!entries) return false;
  const now = nowMs();
  if (now - stickerIndexAt < 60000 && stickerIndex.size) return true;
  stickerIndexAt = now;
  try {
    stickerIndex.clear();
    for (const e of entries) {
      if (!e) continue;
      const note = clean(e.localNote || e.desc);
      if (!note) continue;
      for (const k of [e.id, e.resId, e.emojiId, e.qqFile]) {
        const key = clean(k, 120);
        if (key) stickerIndex.set(key, { id: e.id, note });
      }
    }
    return true;
  } catch (error) {
    warn(`收藏表情索引刷新失败：${error?.message ?? error}`);
    return false;
  }
}

// ─────────────────────────────────────────────── hook：before-context

export const hooks = {
  /**
   * 组装提示词之前：把本轮触发消息里的图片解析成指纹（会顺手预热缓存）。
   * 这里只"预解析"，不改消息内容 —— 改文本会干扰核心的档位/关键词判定。
   * 真正给模型看的东西在 before-llm-messages 里注入。
   */
  'before-context': async ({ triggerEntries, store: chatStore, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      forgetExpired();
      flushStore();
      pruneSessions();
      const st = sessionState(sessionId, chatKey);
      if (chatStore && typeof chatStore.findByMid === 'function') st.store = chatStore;
      const budget = Math.min(c.maxDownloadMs, 4000);
      const deadline = nowMs() + Math.max(600, budget);

      for (const entry of Array.isArray(triggerEntries) ? triggerEntries : []) {
        const localId = String(entry?.id ?? '');
        const mid = String(entry?.mid ?? '');
        if (localId && mid) st.byMid.set(mid, localId);
        const media = Array.isArray(entry?.media) ? entry.media : [];
        for (const m of media) {
          if (!m || (m.kind !== 'image' && m.kind !== 'sticker' && m.kind !== 'video')) continue;
          const left = deadline - nowMs();
          if (left < 300) return;
          const keys = (m.kind === 'video')
            ? await resolveVideoKeys(m, left)
            : await resolveMediaKeys(m, left);
          if (keys && keys.length) addResolved(st, localId || mid, { keys, media: m });
        }
      }
    } catch (error) {
      warn(`before-context 预解析失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 发消息给模型之前：
   *   ① 把命中记忆库的图片含义**内联**进触发消息（模型不用调任何工具就知道了）；
   *   ② 追加一段系统说明，明确告诉它别再调看图工具。
   */
  'before-llm-messages': async ({ messages, chatKey, sessionId, triggerEntries }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      const st = sessionState(sessionId, chatKey);
      if (st.injected) return;               // 每次运行只注入一次

      const known = [];
      for (const [entryId, rec] of st.resolved) {
        for (const item of resolvedItems(rec)) {
          const entry = lookupByKeys(keysToObject(item.keys));
          if (!entry || !validForChat(entry)) continue;
          known.push({
            entryId,
            note: entry.note,
            keys: item.keys,
            entry,
            kind: item.media?.kind === 'video' ? 'video' : 'image',
            media: item.media
          });
        }
      }

      if (!known.length) return;
      st.injected = true;
      st.saved = known.map((k) => k.entryId);

      for (const k of known) {
        const target = (Array.isArray(triggerEntries) ? triggerEntries : [])
          .find((e) => String(e?.id ?? e?.mid) === String(k.entryId));
        if (!target) continue;
        target.text = stampKnown(String(target.text || ''), k.kind, k.note);
        if (k.media) k.media.knownMeaning = k.note;
      }

      const idx = lastUserIndex(messages);
      if (idx >= 0) {
        const lines = [
          `【本地资料库】本轮有 ${known.length} 条图片或视频已经看过，描述如下（直接用，不用再看）：`,
          ...known.slice(0, 8).map((k) => `- 消息 #${k.entryId}（${kindLabel(k.kind)}）：${safeValue(k.note)}`)
        ];
        lines.push(`这些不要调用 get_message_images、get_sticker_image 或 read_video。第一次见到的，看完后调用 ${REMEMBER_TOOL} 把描述记下来。`);
        appendToMessage(messages[idx], `\n\n${lines.join('\n')}`);
      }

      for (const k of known) markHit(k.entry, chatKey);
      log(`命中资料库 ${known.length} 条，已跳过再看`);
    } catch (error) {
      warn(`before-llm-messages 注入失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之前：真正省 token 的地方。
   * 命中记忆库 → 拦下 get_message_images / get_sticker_image，
   * 把含义当"工具结果文本"还给模型（orchestrator 会把 reason 原样透出）。
   * 未命中 → 放行（模型照常看图），并把"刚看过哪些图"记下来，
   * 等模型看完调 remember_image 时就能对上号。
   */
  'before-tool': async ({ toolName, argsRaw, chatKey, sessionId, session }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      const name = shortToolName(toolName);
      if (name !== 'get_message_images' && name !== 'get_sticker_image' && name !== 'read_video') return;

      const st = sessionState(sessionId, chatKey);
      const args = safeParse(argsRaw) || {};

      if (name === 'read_video') {
        const mid = String(args.messageId ?? args.message_id ?? '').trim();
        if (!mid) return;
        const record = findChatEntry(st, mid);
        const video = (Array.isArray(record?.media) ? record.media : []).find((m) => m && m.kind === 'video');
        if (!video) return;
        const localId = String(record?.id ?? '');
        const rec = localId ? st.resolved.get(localId) : null;
        const cached = resolvedItems(rec).find((it) => it.media === video);
        const keys = cached?.keys || await resolveVideoKeys(video, Math.min(c.maxDownloadMs, 2500));
        const entry = keys && lookupByKeys(keysToObject(keys));
        if (entry && validForChat(entry)) {
          markHit(entry, chatKey);
          if (localId && keys) addResolved(st, localId, { keys, media: video });
          st.viewed.set(mid, { at: nowMs(), localId, keys, kind: 'video' });
          return {
            block: true,
            reason: `系统：已跳过看视频 —— 这条视频已经在【本地资料库】里。描述：${safeValue(entry.note)}。`
              + `请直接用这段描述。若描述不对，用 ${REMEMBER_TOOL} 覆盖，或用 ${FORGET_TOOL} 删掉后下次再看。`
          };
        }
        st.viewed.set(mid, { at: nowMs(), localId, kind: 'video' });
        return;
      }

      if (name === 'get_message_images') {
        const mid = String(args.messageId ?? args.message_id ?? '').trim();
        if (!mid) return;
        const record = findChatEntry(st, mid);
        const media = (Array.isArray(record?.media) ? record.media : [])
          .filter((m) => m && (m.kind === 'image' || m.kind === 'sticker'));

        const resolved = [];
        let known = 0;
        let unreadable = 0;
        const localId = String(record?.id ?? '');
        for (const m of media) {
          const rec = localId ? st.resolved.get(localId) : null;
          const cached = resolvedItems(rec).find((it) => it.media === m);
          const keys = cached?.keys || await resolveMediaKeys(m, Math.min(c.maxDownloadMs, 2500));
          if (!keys) { unreadable += 1; continue; }
          if (localId) addResolved(st, localId, { keys, media: m });
          const entry = lookupByKeys(keysToObject(keys));
          if (entry && validForChat(entry)) {
            known += 1;
            resolved.push({ keys, entry, media: m });
          }
        }

        if (media.length > 0 && unreadable === 0 && known === media.length) {
          for (const r of resolved) markHit(r.entry, chatKey);
          const allKeys = resolved.flatMap((r) => r.keys);
          st.viewed.set(mid, { at: nowMs(), localId: localId || '', keys: allKeys });
          const list = resolved.map((r) => `「${safeValue(r.entry.note)}」`).join('、');
          return {
            block: true,
            reason: `系统：已跳过看图 —— 这些图片已经在【本地资料库】里，描述是 ${list}。`
              + `请直接用上面的描述。若描述不对，用 ${REMEMBER_TOOL} 覆盖。`
          };
        }
        st.viewed.set(mid, { at: nowMs(), localId: localId || '' });
        return;
      }

      // get_sticker_image：自己的收藏表情。库里有备注就别花 token 再看一次图。
      const stickerRef = String(args.stickerId ?? args.sticker_id ?? args.id ?? '').trim();
      if (!stickerRef) return;
      const known = stickerNoteOf(stickerRef);
      if (known) {
        return {
          block: true,
          reason: `系统：这个收藏表情已经在你的表情库里，含义/备注是「${safeValue(known.note)}」。`
            + '不需要再看图 —— 直接用这个理解决定要不要发、发给谁。'
            + `如果这次你觉得描述不对，用 sticker_note 更新备注，或用 ${REMEMBER_TOOL} 覆盖资料库。`
        };
      }
      st.viewed.set(`sticker:${stickerRef}`, { sticker: stickerRef, at: nowMs(), chatKey: String(chatKey || '') });
    } catch (error) {
      warn(`before-tool 拦截判定失败（放行，不影响对话）：${error?.message ?? error}`);
      return;
    }
  },

  /**
   * 工具执行之后：模型刚"看过"哪张图，在这里把它的指纹算出来记下，
   * 等模型看完图调 remember_image 时就能对上号。
   * 此时图片已经发给模型了，"花多久算指纹"不再影响这一轮 —— 但仍然给预算，
   * 免得 hook 撞上 5 秒上限。
   */
  'after-tool': async ({ toolName, result, argsRaw, session, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      if (result?.isError) return;
      const name = shortToolName(toolName);
      const st = sessionState(sessionId, chatKey);
      st.at = nowMs();
      const args = safeParse(argsRaw);

      if (name === 'save_description') {
        const text = clean(args.text || args.note);
        let newest = null;
        for (const [, rec] of st.viewed) {
          if (rec?.kind !== 'video' || nowMs() - rec.at > MIN_VIEW_LINK_MS) continue;
          if (!newest || rec.at > newest.at) newest = rec;
        }
        let keys = Array.isArray(newest?.keys) ? newest.keys : [];
        if (!keys.length && newest?.localId) {
          const resolved = st.resolved.get(String(newest.localId));
          keys = resolvedItems(resolved).filter((it) => it.media?.kind === 'video').flatMap((it) => it.keys || []);
        }
        if (text && keys.length) {
          putEntry({ keys, note: text, chatKey: String(chatKey || ''), source: 'model', kind: 'video' });
          flushStore(true);
        }
        return;
      }

      if (name !== 'get_message_images' && name !== 'get_sticker_image' && name !== 'read_video') return;

      if (name === 'get_sticker_image') {
        const ref = String(args.stickerId ?? args.sticker_id ?? args.id ?? '').trim();
        if (ref) st.viewed.set(`sticker:${ref}`, { sticker: ref, at: nowMs() });
        return;
      }

      const mid = String(args.messageId ?? args.message_id ?? '').trim();
      if (!mid) return;
      const record = findChatEntry(st, mid);
      const wantVideo = name === 'read_video';
      const media = (Array.isArray(record?.media) ? record.media : [])
        .filter((m) => m && (wantVideo ? m.kind === 'video' : (m.kind === 'image' || m.kind === 'sticker')));
      if (!media.length) return;

      const localId = String(record?.id ?? '');
      const picked = [];
      for (const m of media) {
        const rec = localId ? st.resolved.get(localId) : null;
        const cached = resolvedItems(rec).find((it) => it.media === m);
        const keys = cached?.keys || (wantVideo
          ? await resolveVideoKeys(m, Math.min(c.maxDownloadMs, 2500))
          : await resolveMediaKeys(m, Math.min(c.maxDownloadMs, 2500)));
        if (keys && keys.length) {
          if (localId) addResolved(st, localId, { keys, media: m });
          for (const k of keys) if (!picked.includes(k)) picked.push(k);
        }
      }
      st.viewed.set(mid, { at: nowMs(), localId, keys: picked, kind: wantVideo ? 'video' : 'image' });
      void session;
    } catch (error) {
      warn(`after-tool 记录指纹失败（不影响对话）：${error?.message ?? error}`);
    }
  }
};

function keysToObject(keys) {
  const out = { src: '', file: '', st: '', vid: '', extra: [] };
  for (const k of Array.isArray(keys) ? keys : []) {
    const s = String(k);
    if (s.startsWith('src:') && !out.src) out.src = clean(s.slice(4), 64);
    else if (s.startsWith('file:') && !out.file) out.file = clean(s.slice(5), 200);
    else if (s.startsWith('st:') && !out.st) out.st = clean(s.slice(3), 120);
    else if (s.startsWith('vid:') && !out.vid) out.vid = clean(s.slice(4), 80);
    else if (/^(src|file|st|vid):/.test(s)) out.extra.push(clean(s, 220));
  }
  return out;
}

function shortToolName(toolName) {
  const s = String(toolName || '');
  const idx = s.lastIndexOf('__');
  return idx >= 0 ? s.slice(idx + 2) : s;
}

function safeParse(text) {
  try {
    const v = JSON.parse(String(text ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** 往一条消息追加文本（content 可能是字符串或 parts 数组，两种都要照顾）。 */
function appendToMessage(message, text) {
  if (!message) return;
  if (typeof message.content === 'string') { message.content += text; return; }
  if (Array.isArray(message.content)) {
    const last = message.content[message.content.length - 1];
    if (last && last.type === 'text') last.text = `${last.text ?? ''}${text}`;
    else message.content.push({ type: 'text', text: String(text).trim() });
  }
}

function findChatEntry(st, mid) {
  const key = String(mid ?? '').trim();
  if (!key) return null;
  const localId = st?.byMid?.get(key);
  const storeApi = st?.store;
  if (!storeApi?.findByMid) return null;
  try {
    if (localId) {
      const byLocal = storeApi.findByLocalId?.(st.chatKey, localId);
      if (byLocal) return byLocal;
    }
  } catch { /* 落到按 mid 查 */ }
  try {
    return storeApi.findByMid(st.chatKey, key) || null;
  } catch {
    return null;
  }
}

/** 该图片像不像表情包（stickerOnly 生效时用）。不确定时**倾向不缓存**。 */
function isLikelySticker(m) {
  // ① OneBot 对"QQ 表情/动图表情"常带这类 summary 标记 —— 最强信号
  if (isAnimationMarker(m?.summary)) return true;
  const url = String(m?.url || '');
  const file = String(m?.file || '');
  // ② QQ 表情图床 / 明确的表情字样
  if (/qq_expression|gxh\.vip\.qq\.com|[/_-]emoji|表情/i.test(`${url} ${file}`)) return true;
  // ③ 动图基本都是表情包
  if (/\.gif(\?|$)/i.test(`${url} ${file}`)) return true;
  // ④ 拿到了尺寸就按"表情包一般不大"判；尺寸不满足就明确不缓存
  const w = Number(m?.width || m?.w || 0);
  const h = Number(m?.height || m?.h || 0);
  if (w > 0 && h > 0) return Math.min(w, h) <= 400 && Math.max(w, h) <= 600;
  // ⑤ 啥线索都没有（老存档 media 字段不全）：不缓存，让模型自己用 remember_image
  //    决定 —— 宁可少省一点，也不要拿一张截图/照片的旧含义去糊弄群友。
  return false;
}

// ─────────────────────────────────────────────── 收藏表情备注查询

function stickerNoteOf(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const cached = stickerIndex.get(key) || stickerIndex.get(key.replace(/^#/, ''));
  if (cached) return cached;
  // 记忆库兜底：这个表情以前被别人发过、或者被记过含义
  const entry = lookupByKeys({ st: key, file: key });
  return entry ? { id: key, note: entry.note, from: 'memory' } : null;
}

/**
 * 把运行期才拿得到的引用记进会话状态（hook 的载荷里没有 stickers/onebot 这两个对象）：
 *   ctx.store    —— ChatStore，按消息 id 找回 media；
 *   ctx.stickers —— StickerManager，收藏表情的备注来源（顺带刷新备注索引）；
 *   ctx.onebot   —— 下载兜底（get_image 换本地文件）。
 * 全是只读引用，不改变它们的任何状态。
 */
function captureRuntimeRefs(st, ctx) {
  if (!st || !ctx) return;
  if (ctx.store && typeof ctx.store.findByMid === 'function') st.store = ctx.store;
  if (ctx.stickers && Array.isArray(ctx.stickers.entries)) {
    st.stickers = ctx.stickers;
    try { refreshStickerIndex(ctx.stickers); } catch { /* 索引失败不影响主流程 */ }
  }
  if (ctx.onebot && typeof ctx.onebot.call === 'function') onebotRef = ctx.onebot;
}

// ─────────────────────────────────────────────── 工具

function registerStickerMemoryTools(api) {
  api.registerTool({
    id: 'remember_image',
    name: '记下图片或视频',
    description:
      '把你刚看过的图片或视频的描述记进【本地资料库】。以后同一张图或同一个视频再出现时，系统直接用这段描述，不再看一遍。'
      + '什么时候用：刚用 get_message_images、get_sticker_image 或 read_video 看过一份以前没有描述的图片或视频；或者群友说之前的描述不对，要改写。'
      + 'note 用一两句写下画面里是什么。这段话只留在本地，不要发到群里。',
    category: 'sticker',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '画面描述，一两句。'
        },
        scope: {
          type: 'string',
          enum: ['chat', 'global'],
          description: 'chat = 只在当前会话复用（表情包在本群有特定用法时选它）；global = 所有会话通用（默认）。'
        },
        overwrite: {
          type: 'boolean',
          description: '留空或 false 时，库里已有含义就不覆盖（只记第一次的理解）；true = 用这次的覆盖旧含义（群友纠正过的情形）。'
        }
      },
      required: ['note']
    },
    async execute(ctx, args) {
      try {
        const c = conf();
        if (!c.enabled) return { content: '错误：本地资料库已经被关掉了，这次不记录。', isError: true };
        const note = clean(args?.note);
        if (!note || note.length < 2) {
          return { content: '错误：note 太短了。请用一两句写下画面里是什么。', isError: true };
        }

        const st = sessionState(ctx?.session?.id, ctx?.chatKey);
        captureRuntimeRefs(st, ctx);
        const keys = await collectFreshKeys(st);
        if (!keys.length) {
          return {
          content: '错误：没找到你刚看过的图片或视频（可能这一轮你没调用看图或看视频，或者指纹还没算出来）。'
            + `先调用 get_message_images、get_sticker_image 或 read_video 看过之后再调 ${REMEMBER_TOOL}。`,
            isError: true
          };
        }

        let kind = 'image';
        let newest = 0;
        for (const [, rec] of st.viewed) {
          if (!rec || nowMs() - rec.at > MIN_VIEW_LINK_MS) continue;
          if ((rec.at || 0) >= newest && rec.kind) {
            newest = rec.at || 0;
            kind = rec.kind === 'video' ? 'video' : 'image';
          }
        }
        const scope = String(args?.scope || 'global').toLowerCase() === 'chat' ? 'chat' : 'global';
        const overwrite = args?.overwrite === true;
        const res = putEntry({
          keys,
          note,
          kind,
          chatKey: scope === 'chat' ? String(ctx?.chatKey || '') : '',
          source: 'model',
          onlyIfEmpty: !overwrite
        });
        if (!res.ok) return { content: `错误：没能记下来（${res.reason}）。`, isError: true };
        flushStore(true);
        const savedKind = res.entry?.kind === 'video' ? 'video' : 'image';
        log(`已记下一条${kindLabel(savedKind)}（${res.created ? '新增' : res.updated ? '更新' : '未改动'}）：${note.slice(0, 40)}`);
        return {
          content: `已记进本地资料库（${res.created ? '新增' : res.updated ? '已覆盖旧描述' : '库里已有更早的描述，未改动'}）。`
            + '以后同一份内容再出现，系统会直接给出这段描述，不会再看。'
        };
      } catch (error) {
        return { content: `记录失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'list_cached_images',
    name: '查看本地资料库',
    description:
      '列出【本地资料库】里已经记下的图片和视频，以及对应描述。只读，不会再去看画面。',
    category: 'sticker',
    icon: '📒',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选，按含义里的关键词过滤。' },
        limit: { type: 'integer', description: '最多返回几条，1~50，默认 20。' }
      }
    },
    async execute(_ctx, args) {
      try {
        loadStore();
        const q = clean(args?.query, 40).toLowerCase();
        const limit = clamp(Number(args?.limit), 1, 50, 20);
        const all = [...store.entries.values()]
          .filter((e) => (q ? String(e.note).toLowerCase().includes(q) : true))
          .sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt));
        if (!all.length) {
          return { content: q ? `资料库里没有描述包含「${q}」的记录。` : '本地资料库现在是空的。' };
        }
        const lines = [
          `本地资料库共 ${store.entries.size} 条，以下是最近用过的 ${Math.min(limit, all.length)} 条：`
        ];
        for (const e of all.slice(0, limit)) {
          const id = (e.vid || e.src || e.file || e.st || '').slice(0, 12);
          lines.push(`- [${kindLabel(e.kind)}] ${e.note}（用过 ${e.useCount || 0} 次，指纹 ${id}）`);
        }
        lines.push(`要删掉某条用 ${FORGET_TOOL}（传描述里的关键词即可）。`);
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `读取失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'forget_cached_image',
    name: '忘掉一条资料',
    description:
      '把一条图片或视频从【本地资料库】里删掉。下次再遇到同一份内容会重新看。'
      + 'query 传描述里的关键词。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要忘掉的那条记忆的关键词（含义里出现过的词）。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      try {
        loadStore();
        const q = clean(args?.query, 40).toLowerCase();
        if (!q) return { content: '错误：请给一个关键词，例如「白旗」。', isError: true };
        const hits = [...store.entries.values()].filter((e) => String(e.note).toLowerCase().includes(q));
        if (!hits.length) return { content: `资料库里没有描述包含「${q}」的记录，可能已经删过了。` };
        if (hits.length > 5) {
          return {
            content: `关键词「${q}」匹配到 ${hits.length} 条，太宽了，请换个更具体的词。`
              + `\n例如：${hits.slice(0, 3).map((e) => e.note.slice(0, 20)).join(' / ')}`,
            isError: true
          };
        }
        let removed = 0;
        for (const e of hits) { if (forgetEntry(keysOf(e))) removed += 1; }
        flushStore(true);
        return { content: `已忘掉 ${removed} 条：${hits.map((e) => e.note.slice(0, 20)).join(' / ')}。下次再遇到会重新看。` };
      } catch (error) {
        return { content: `删除失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 找出"模型刚看过、但库里还没有"的图的指纹（用于 remember_image 对上号）。 */
async function collectFreshKeys(st) {
  const out = [];
  const push = (keys) => {
    for (const k of keys || []) if (k && !out.includes(k)) out.push(k);
  };
  for (const [, rec] of st.viewed) {
    if (!rec || nowMs() - rec.at > MIN_VIEW_LINK_MS) continue;
    if (rec.sticker) { push([`st:${rec.sticker}`]); continue; }
    if (Array.isArray(rec.keys)) push(rec.keys);
    if (rec.localId) {
      const resolved = st.resolved.get(String(rec.localId));
      for (const item of resolvedItems(resolved)) push(item.keys);
    }
  }
  // 单次最多关联 24 个指纹（一次批量看图时够用，又不会把库撑爆）
  return out.slice(0, MAX_PENDING_PER_CHAT * 4);
}

// ─────────────────────────────────────────────── 生命周期

export async function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : (() => ({ ...DEFAULTS }));
  log = typeof api?.log === 'function' ? api.log : (() => {});
  warn = typeof api?.warn === 'function' ? api.warn : (() => {});
  // 清单声明了 permissions: ["web_fetch"]，这才是 loader 真的给了 fetch；
  // 没声明时拿到的是一个"调用即 reject"的占位函数，这里判掉。
  apiFetch = typeof api?.fetch === 'function' ? api.fetch : null;

  try {
    const mod = await import('../../src/safe-fetch.js');
    safeFetchBinary = typeof mod?.safeFetchBinary === 'function' ? mod.safeFetchBinary : null;
  } catch (error) {
    safeFetchBinary = null;
    warn(`拿不到核心 safe-fetch，改用自带的护栏下载器：${error?.message ?? error}`);
  }
  if (!safeFetchBinary && typeof apiFetch !== 'function') {
    warn('既没有核心 safe-fetch 也没有 web_fetch 权限：首见图将无法算指纹（其余功能不受影响）。');
  }

  registerStickerMemoryTools(api);

  // 懒加载：启动时只读一次文件，不联网、不下图
  try {
    loadStore();
  } catch (error) {
    warn(`记忆库加载失败（将当作空库）：${error?.message ?? error}`);
  }

  const c = conf();
  log(
    `本地资料库已加载：${store.entries.size} 条；`
    + (c.autoForget ? `图片视频：自动遗忘开，早于 ${c.forgetDays} 天从最旧的开始删` : '图片视频：不自动遗忘')
    + (c.hotTrendManaged
      ? `；热梗：接管，上限 ${c.hotTrendMaxEntries}，${c.hotTrendAutoForget ? `早于 ${c.hotTrendForgetDays} 天开始删` : '不自动遗忘'}`
      : '；热梗：不接管')
    + `；数据在 data/${PLUGIN_ID}/`
  );
}

/** 同步自检：拿不到网络/图片字节也能工作（只是首见图算不出指纹）。 */
export function available() {
  return { ok: true };
}

export function activate() {
  loadStore();
  flushStore(true);
}

export function deactivate() {
  flushStore(true);
}

export function dispose() {
  try { flushStore(true); } catch { /* 卸载时写盘失败无所谓 */ }
  for (const job of inflight.values()) { void job; }
  inflight.clear();
  keyCache.clear();
  sessions.clear();
  stickerIndex.clear();
  store.buckets.clear();
  store.entries.clear();
  store.byKey.clear();
  store.loadedAt = 0;
  onebotRef = null;
}

export const providers = {
  'library.bucket': (args = {}) => libraryBucket(args)
};

/**
 * 排障/测试用。对外能力是 library.bucket，热梗插件用它读写自己那一格。
 */
export const internals = {
  get size() { return store.entries.size; },
  keysOf,
  lookupByKeys,
  putEntry,
  forgetEntry,
  flushStore,
  forgetExpired,
  policyOf,
  retainTopics,
  libraryBucket,
  isLikelySticker,
  shortToolName,
  conf,
  sessionState
};
