// agent-growth —— 人格成长引擎（确定性型 / plugins/）
//
// ── 它做什么 ──────────────────────────────────────────────────────────
// 给角色一条"岁月的轴"：
//   · 生日与年龄：按「现实 N 天 = 虚拟 1 岁」（默认 30 天 = 1 个月 = 1 岁），
//     每满一岁视为过一次生日；
//   · 经历记忆：自动把群聊/私聊里 TA 真实经历的事攒成"成长素材"
//     （互动记录 + 宿主消息存档抽样，爸爸的互动单独标记优先参考）；
//   · 成长沉淀：攒够一批（或过生日时）调用模型消化经历，让 TA **自己**
//     写出一条新的「成长阶段提示词」——锚定当前人设，只许自然延伸、不许跑偏；
//   · 每轮注入：年龄状态 + 成长阶段随提示词注入，TA 的言行随年龄自然长大；
//   · 可视化档案：data/growth/成长档案.html 时间线档案页 + 成长查询工具。
//
// ── 为什么是 plugins/ 而不是 skills/ ─────────────────────────────────
// 年龄随时间流逝必然推进、经历必然记录，是"规则能写死"的确定性链路；
// 模型只需要在"沉淀"这一步当一次作者。放 skills/ 会让加载器告警（没有 providers）。
//
// ── 与其他扩展的关系：零冲突 ────────────────────────────────────────
//   · 「鲸鱼娘·女儿版人设」：管"对谁是哪种模式"（message.owner-check 能力）；
//     本插件管"长到几岁、经历过什么"。成长阶段对两种模式一体生效。
//     爸爸 QQ 号留空时自动读它的设置，不用填两遍。
//   · 「仿真实生活」：管"今天"（规划/小事）；本插件管"岁月"（年龄/长期性格）。
//     通道不同（promptSections id 不同）、存储不同（data/growth/），互不覆盖。
//   · 「conversation-memory」等记忆模块：它们记"和谁聊过什么"，
//     本插件记"这些经历把 TA 慢慢变成了什么样"。
//
// ── 防呆设计 ─────────────────────────────────────────────────────────
// 所有 IO try/catch 包裹、失败只降级不抛错；原子写入（tmp+rename）；
// 沉淀有冷却与阈值；没配模型 Key 时静默跳过（只记日志）不刷屏。
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DAY = 86400000;
const GROWTH_DIR = path.join(DATA_DIR, 'growth');
const PROFILE_FILE = path.join(GROWTH_DIR, 'profile.json');
const MEM_FILE = path.join(GROWTH_DIR, 'memories.json');
const STAGES_FILE = path.join(GROWTH_DIR, 'stages.json');
const STATE_FILE = path.join(GROWTH_DIR, 'state.json');
const ARCHIVE_FILE = path.join(GROWTH_DIR, '成长档案.html');

const DEFAULTS = {
  enabled: true,
  growthDaysPerYear: 30,
  startAge: 8,
  ownerUserIds: '',
  digestMinMemories: 25,
  maxMemories: 800,
  captureGroup: true,
  capturePrivate: true,
  captureMaxLength: 120,
  digestCooldownMin: 30,
  celebrateBirthday: true,
  maxStagesInPrompt: 12,
  digestModel: '',
  extraAnchor: ''
};

let cfg = { ...DEFAULTS };
let api = null;
let storeRef = null;       // 宿主消息存档（before-context 注入，用于抽取环境经历）
let hourlyTimer = null;

// ── 小工具 ────────────────────────────────────────────────────────────
function clamp(n, lo, hi) { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) { try { api?.warn?.('[agent-growth] 写文件失败', e?.message ?? e); } catch { /* ignore */ } }
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) { const d = new Date(Number(ts) || 0); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fmtDT(ts) { const d = new Date(Number(ts) || 0); return `${fmtDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function sameMonthDay(a, b) {
  const x = new Date(Number(a)), y = new Date(Number(b));
  return x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
/** 从模型输出里稳健抽出 JSON（兼容代码块/前后杂文/尾逗号）。 */
function extractJson(text) {
  let t = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('返回中未找到 JSON');
  const raw = t.slice(s, e + 1);
  try { return JSON.parse(raw); } catch { /* 继续兜底 */ }
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { /* 继续兜底 */ }
  const grab = (k) => {
    const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'));
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
  };
  const out = { stageTitle: grab('stageTitle'), newPrompt: grab('newPrompt'), memorySummary: grab('memorySummary') };
  if (out.newPrompt) return out;
  throw new Error('JSON 解析失败');
}

// ── 配置同步（用户在设置界面改完即时生效）───────────────────────────
function syncCfg() {
  try {
    const s = api?.config?.();
    if (s && typeof s === 'object') cfg = { ...DEFAULTS, ...s };
  } catch { /* 取不到就沿用上一次的值 */ }
  return cfg;
}
function rateDays() { return clamp(cfg.growthDaysPerYear, 1, 365); }

/** 爸爸 QQ：本插件填了用自己的；留空自动读「鲸鱼娘·女儿版人设」的设置。 */
function owners() {
  const parse = (raw) => String(raw || '')
    .split(/[,，;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{4,12}$/.test(x));
  const own = parse(cfg.ownerUserIds);
  if (own.length) return own;
  try {
    const c = getConfig();
    return parse(c?.skills?.['whale-daughter-persona']?.settings?.ownerUserIds);
  } catch { return []; }
}

// ── 档案：角色 / 记忆 / 阶段 / 状态 ──────────────────────────────────
function loadProfile() { return readJson(PROFILE_FILE, null); }
function ensureProfile() {
  let p = loadProfile();
  if (p && p.birthday) return p;
  let botName = '小鲸鱼';
  try { botName = String(getConfig()?.persona?.botName || botName).slice(0, 20); } catch { /* 用默认 */ }
  const startAge = clamp(cfg.startAge, 0, 99);
  p = { name: botName, gender: '女', birthday: Date.now() - startAge * rateDays() * DAY, createdAt: Date.now(), startAge };
  writeJson(PROFILE_FILE, p);
  try { api?.log?.(`[agent-growth] 角色建档：${p.name}，从 ${startAge} 岁开始成长（生日 ${fmtDate(p.birthday)}）`); } catch { /* ignore */ }
  return p;
}
function loadState() { return readJson(STATE_FILE, { lastAmbientTs: 0, lastTick: 0, lastDigestAttempt: 0, annualHandled: {} }); }
function saveState(s) { writeJson(STATE_FILE, s); }
function loadMems() { return readJson(MEM_FILE, { list: [] }); }
function saveMems(d) { writeJson(MEM_FILE, d); }
function loadStages() { return readJson(STAGES_FILE, { list: [] }); }
function saveStages(d) { writeJson(STAGES_FILE, d); }

// ── 年龄计算 ─────────────────────────────────────────────────────────
function calcAgeAt(p, t = Date.now()) {
  if (!p?.birthday) return 0;
  return Math.max(0, Math.floor((t - p.birthday) / (rateDays() * DAY)));
}
function ageAt(p, t) { return calcAgeAt(p, t); }
function birthdayInfo(p, now = Date.now()) {
  const age = calcAgeAt(p, now);
  const next = p.birthday + (age + 1) * rateDays() * DAY;
  return { age, daysLeft: Math.max(0, Math.ceil((next - now) / DAY)), birthdayToday: sameMonthDay(p.birthday, now) };
}

// ── 经历记忆 ─────────────────────────────────────────────────────────
/** before-context：把本轮触发消息记成"互动经历"（这是 TA 亲身参与的事）。 */
function recordInteractions(entries, chatKey) {
  const data = loadMems();
  const list = data.list || [];
  const ownerSet = owners();
  let added = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    try {
      if (!e || e.self === true || e.isSelf === true) continue;
      const text = String(e?.text ?? '').trim();
      if (text.length < 2) continue;
      if (/^[#/]/.test(text)) continue;                       // 命令类不进成长素材
      const sid = String(e?.senderId ?? e?.userId ?? '').trim();
      const ts = Number(e?.ts ?? e?.timestamp) || Date.now();
      const dedup = `${chatKey}|${sid}|${text.slice(0, 40)}|${Math.floor(ts / 60000)}`;
      if (list.some((m) => m.dedup === dedup)) continue;      // 同人同分钟同文本去重
      list.push({
        id: uid(), t: ts,
        kind: ownerSet.includes(sid) ? 'daddy' : 'interaction',
        speaker: (String(e?.senderName ?? '').trim() || (sid ? `QQ${sid}` : '路人')).slice(0, 20),
        text: text.slice(0, clamp(cfg.captureMaxLength, 20, 500)),
        source: String(chatKey || ''), dedup
      });
      added++;
    } catch { /* 单条失败不影响其他 */ }
  }
  const max = clamp(cfg.maxMemories, 50, 5000);
  if (list.length > max) data.list = list.slice(-max);
  else data.list = list;
  if (added) saveMems(data);
  return added;
}

/** 消化素材 = 未消化的互动经历 + 宿主存档抽样（环境见闻）。 */
function collectExperiences(now = Date.now()) {
  const out = [];
  for (const m of (loadMems().list || [])) {
    out.push({ ...m, fromStore: false });
  }
  const since = Number(loadState().lastAmbientTs) || (now - 7 * DAY);
  if (storeRef && typeof storeRef.listChats === 'function') {
    try {
      const chats = (storeRef.listChats() || []).slice(0, 6);
      for (const chatKey of chats) {
        const rows = storeRef.recent(chatKey, { limit: 60, includeSelf: false }) || [];
        for (const r of rows) {
          const ts = Number(r?.ts) || 0;
          if (ts <= since) continue;
          const text = String(r?.text ?? '').trim();
          if (text.length < 2 || /^[#/]/.test(text)) continue;
          const sid = String(r?.senderId ?? '');
          out.push({
            id: `st${ts}${sid}`, t: ts, kind: owners().includes(sid) ? 'daddy' : 'ambient',
            speaker: (String(r?.senderName ?? '').trim() || (sid ? `QQ${sid}` : '路人')).slice(0, 20),
            text: text.slice(0, clamp(cfg.captureMaxLength, 20, 500)),
            source: String(chatKey || ''), fromStore: true
          });
        }
      }
    } catch (e) { try { api?.warn?.('[agent-growth] 读存档失败（降级为只用互动记忆）', e?.message ?? e); } catch { /* ignore */ } }
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  return out.slice(-60);
}

// ── 成长沉淀：消化经历 → 生成新的成长阶段提示词 ─────────────────────
function kindLabel(e) {
  if (e?.kind === 'daddy') return '与爸爸';
  if (e?.kind === 'interaction') return '亲身互动';
  return '环境见闻';
}

/** 宿主是否已配好可用的模型 Key（复用宿主的解析规则：目录提供商 Key > 顶层 Key）。 */
async function hasLlmKey() {
  try {
    const { resolveApiKey } = await import('../../src/llm.js');
    return Boolean(resolveApiKey(getConfig()));
  } catch { return true; }   // 拿不到解析器就假定可用，交给调用层兜底
}

async function digest({ force = false, handledAges = null } = {}) {
  const p = loadProfile();
  if (!p) return { ok: false, reason: 'no_profile' };
  const c = getConfig();
  if (!c?.api?.baseUrl || !(await hasLlmKey())) {
    return { ok: false, reason: 'no_llm' };
  }
  const exp = collectExperiences();
  if (!force && exp.length < clamp(cfg.digestMinMemories, 3, 300)) {
    return { ok: false, reason: 'not_enough', count: exp.length };
  }

  const age = calcAgeAt(p);
  const stages = (loadStages().list || []);
  const history = stages.slice(-10).map((s) => `${s.age}岁·${s.title}`).join('；') || '（尚无成长阶段，这是第一次沉淀）';
  const bundle = exp.slice(-60).map((e) => `[${ageAt(p, e.t)}岁·${kindLabel(e)}] ${e.speaker}：${e.text}`).join('\n')
    || '（这段时间没留下多少经历，就基于当前人设自然沉淀一点细微的长大）';
  const anchor = [String(c.persona?.roleText || '').trim(), String(cfg.extraAnchor || '').trim()].filter(Boolean).join('\n\n【补充锚点】\n');

  const sys = [
    '你是「人格成长引擎」。一个虚拟角色随真实经历慢慢长大，现在要把 TA 最近的真实经历沉淀成一条新的「成长阶段提示词」。',
    '【当前人设（本质与铁律，新增内容不得与之冲突，不得推翻既往阶段，只能在原有性格上自然延伸、细化）】',
    anchor || '（宿主未提供人设文本，请保持中性、温和、有生活气的性格延伸。）',
    '【成长铁律】',
    '1. 新增提示词用人称"你"对角色说话（如"你学会了……""你开始……"），30~120字；',
    '2. 变化必须有上面的真实经历作依据，不凭空捏造；',
    '3. 若人设含多模式/多身份结构（对不同人不同模式），新增内容必须保持该结构与边界；',
    '4. 遵守人设中的所有红线与禁忌；年龄增长表现为心智与懂事程度的变化，不改变人设本质。',
    '【输出要求】只输出一个 JSON，不要任何多余文字：',
    '{"stageTitle":"阶段标题(10字内)","newPrompt":"新增的成长提示词(30~120字)","memorySummary":"这段经历的摘要(60字内)"}'
  ].join('\n');
  const usr = [
    `【角色】${p.name}（${p.gender || '女'}），当前 ${age} 岁（每现实${rateDays()}天长1岁）`,
    `【既往成长阶段】${history}`,
    `【TA 最近的真实经历】\n${bundle}`,
    '请输出 JSON。'
  ].join('\n\n');

  let out;
  try {
    const { chatCompletion } = await import('../../src/llm.js');
    const overrides = String(cfg.digestModel || '').trim() ? { model: String(cfg.digestModel).trim() } : null;
    out = await chatCompletion({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      temperature: 0.85, maxTokens: 600, overrides
    });
  } catch (e) {
    const st = loadState(); st.lastDigestAttempt = Date.now(); saveState(st);
    return { ok: false, reason: 'llm_error', error: String(e?.message ?? e) };
  }

  let parsed;
  try { parsed = extractJson(out); } catch (e) {
    const st = loadState(); st.lastDigestAttempt = Date.now(); saveState(st);
    return { ok: false, reason: 'parse_error', error: String(e?.message ?? e) };
  }
  const promptText = String(parsed.newPrompt ?? '').trim();
  if (!promptText) {
    const st = loadState(); st.lastDigestAttempt = Date.now(); saveState(st);
    return { ok: false, reason: 'parse_error', error: '模型未返回 newPrompt' };
  }
  const stage = {
    age,
    title: String(parsed.stageTitle || `${age}岁的沉淀`).slice(0, 20),
    prompt: promptText.slice(0, 300),
    summary: String(parsed.memorySummary ?? '').slice(0, 120),
    time: Date.now(),
    basisCount: exp.length
  };
  const data = loadStages();
  data.list = [...(data.list || []), stage];
  saveStages(data);

  // 消化过的互动经历移出队列；环境见闻推进水位
  const consumedIds = new Set(exp.filter((e) => !e.fromStore).map((e) => e.id));
  const mem = loadMems();
  mem.list = (mem.list || []).filter((m) => !consumedIds.has(m.id));
  saveMems(mem);
  const st = loadState();
  st.lastAmbientTs = Date.now();
  st.lastDigestAttempt = Date.now();
  if (Array.isArray(handledAges) && handledAges.length) {
    st.annualHandled = st.annualHandled || {};
    for (const a of handledAges) st.annualHandled[a] = true;
  }
  saveState(st);
  renderArchive();
  try { api?.log?.(`[agent-growth] 成长沉淀完成：${stage.age}岁·${stage.title}（依据 ${exp.length} 条经历）`); } catch { /* ignore */ }
  return { ok: true, stage, consumed: exp.length };
}

// ── 年龄时钟：每满一岁 → 过生日 → 强制沉淀一次 ─────────────────────
function tickAge(force = false) {
  const now = Date.now();
  const st = loadState();
  if (!force && now - (st.lastTick || 0) < 10 * 60000) return;
  st.lastTick = now; saveState(st);
  const p = loadProfile();
  if (!p) return;
  const age = calcAgeAt(p, now);
  const handled = st.annualHandled || {};
  const pending = [];
  for (let a = 1; a <= age; a++) if (!handled[a]) pending.push(a);
  if (!pending.length) return;
  // 冷却：上一轮沉淀刚失败不久就先等等（生日沉淀优先，冷却放宽到 5 分钟）
  if (!force && now - (st.lastDigestAttempt || 0) < clamp(cfg.digestCooldownMin, 1, 720) * 60000) return;
  const info = birthdayInfo(p, now);
  digest({ force: true, handledAges: pending })
    .then((r) => {
      if (r.ok) {
        try { api?.log?.(`[agent-growth] 🎂 ${p.name} 过生日：${info.age} 岁，新阶段「${r.stage.title}」`); } catch { /* ignore */ }
      } else if (r.reason === 'no_llm') {
        // 没配模型：标记已处理，避免每个时钟都空转（配置好模型后可用工具手动补沉淀）
        const s2 = loadState(); s2.annualHandled = s2.annualHandled || {};
        for (const a of pending) s2.annualHandled[a] = true;
        saveState(s2);
        try { api?.warn?.('[agent-growth] 未配置模型 Key，本次生日跳过沉淀（性格不变，只长年龄）'); } catch { /* ignore */ }
      }
    })
    .catch(() => { /* digest 内部已兜底 */ });
}

/** 攒够经历 → 顺手沉淀（节流）。 */
async function maybeDigest() {
  const st = loadState();
  const now = Date.now();
  if (now - (st.lastDigestAttempt || 0) < clamp(cfg.digestCooldownMin, 1, 720) * 60000) return;
  const c = getConfig();
  if (!c?.api?.baseUrl || !(await hasLlmKey())) return;
  const count = collectExperiences(now).length;
  if (count < clamp(cfg.digestMinMemories, 3, 300)) return;
  await digest({ force: false }).catch(() => { /* 内部已兜底 */ });
}

// ── 档案页（data/growth/成长档案.html）──────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderArchive() {
  try {
    const p = loadProfile();
    if (!p) return null;
    const info = birthdayInfo(p);
    const stages = (loadStages().list || []);
    const mems = (loadMems().list || []).slice(-20).reverse();
    const ownerList = owners();
    const stageCards = stages.map((s) => `
    <div class="stage"><div class="badge">${esc(s.age)}<span>岁</span></div>
      <div class="body"><div class="t">${esc(s.title)}</div><div class="p">${esc(s.prompt)}</div>
      ${s.summary ? `<div class="s">这段经历：${esc(s.summary)}</div>` : ''}
      <div class="m">沉淀于 ${esc(fmtDT(s.time))} · 依据 ${esc(s.basisCount ?? '?')} 条经历 · AI 自主生成，与当前人设锚定一致</div></div></div>`).join('')
      || '<div class="empty">还没有沉淀出成长阶段——攒够经历或过生日时会自动生成第一份。</div>';
    const memRows = mems.map((m) => `<div class="mem"><span class="a">${esc(ageAt(p, m.t))}岁</span><span class="w">${esc(m.speaker)}</span><span class="x">${esc(m.text)}</span><span class="t">${esc(fmtDT(m.t))}</span></div>`).join('')
      || '<div class="empty">暂无互动记录。</div>';
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} 的成长档案</title><style>
:root{--bg:#f6f1e7;--card:#fffdf8;--ink:#3c352c;--muted:#8d8271;--accent:#c96f3b;--soft:#f3e2d3;--line:#e8dfd0}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--ink);font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;padding:32px 16px 64px}
.wrap{max-width:860px;margin:0 auto}.hero{background:linear-gradient(135deg,#fdf8ef,#f7ead9);border:1px solid var(--line);border-radius:18px;padding:26px 30px;display:flex;gap:24px;align-items:center;flex-wrap:wrap}
.ring{width:110px;height:110px;border-radius:50%;background:conic-gradient(var(--accent) ${Math.round(((1 - info.daysLeft * DAY) / (rateDays() * DAY)) * 100)}%,var(--soft) 0);display:flex;align-items:center;justify-content:center;flex:none}
.rin{width:90px;height:90px;border-radius:50%;background:var(--card);display:flex;flex-direction:column;align-items:center;justify-content:center}
.num{font-size:30px;font-weight:700;color:var(--accent);font-family:"Noto Serif SC","Songti SC",serif}.lb{font-size:11px;color:var(--muted)}
h1{font-size:24px;font-family:"Noto Serif SC","Songti SC",serif}.chips{margin:8px 0}.chip{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;background:var(--soft);color:var(--accent);margin-right:8px}
.meta{font-size:13px;color:var(--muted)}.meta b{color:var(--ink)}
h2{font-size:17px;margin:26px 0 12px;display:flex;align-items:center;gap:10px}h2::after{content:"";flex:1;height:1px;background:var(--line)}
.timeline{position:relative;padding-left:24px}.timeline::before{content:"";position:absolute;left:7px;top:6px;bottom:6px;width:2px;background:var(--line)}
.stage{position:relative;display:flex;gap:14px;margin-bottom:14px}.stage::before{content:"";position:absolute;left:-22px;top:20px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--card)}
.badge{flex:none;width:50px;height:50px;border-radius:13px;background:var(--soft);color:var(--accent);display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:700;font-size:17px}
.badge span{font-size:9px;font-weight:400}.body{flex:1;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.t{font-weight:700;margin-bottom:4px}.p{font-size:14px}.s{margin-top:6px;font-size:12px;color:var(--muted);background:var(--bg);border-radius:8px;padding:5px 10px}
.m{margin-top:6px;font-size:11px;color:var(--muted)}.mem{display:flex;gap:8px;align-items:baseline;padding:6px 2px;border-bottom:1px dashed var(--line);font-size:13px;flex-wrap:wrap}
.mem:last-child{border-bottom:none}.a{flex:none;font-size:11px;color:var(--accent);background:var(--soft);border-radius:6px;padding:0 6px}
.w{flex:none;font-weight:600}.x{flex:1;min-width:180px}.t2,.t{font-size:11px}.mem .t{color:var(--muted);flex:none}
.empty{color:var(--muted);font-size:13px;padding:12px 2px}.ft{margin-top:30px;text-align:center;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="hero"><div class="ring"><div class="rin"><div class="num">${esc(info.age)}</div><div class="lb">岁 · 距下次生日${esc(info.daysLeft)}天</div></div></div>
<div style="flex:1;min-width:240px"><h1>${esc(p.name)}</h1><div class="chips">
<span class="chip">${esc(p.gender || '女')}</span><span class="chip">生日 ${esc(fmtDate(p.birthday))}</span>
${ownerList.length ? `<span class="chip">爸爸锚点 ${esc(ownerList.join('/'))}</span>` : '<span class="chip">未设爸爸QQ · 自动读鲸鱼娘插件</span>'}
</div><div class="meta">成长规则：<b>现实 ${esc(rateDays())} 天 = 虚拟 1 岁</b> · 经历互动 <b>${esc((loadMems().list || []).length)}</b> 条 · 成长阶段 <b>${esc(stages.length)}</b> 个</div></div></div>
<h2>人设进化时间线（AI 自主添加的成长提示词）</h2><div class="timeline">${stageCards}</div>
<h2>最近的亲身经历</h2><div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 16px">${memRows}</div>
<div class="ft">档案生成于 ${esc(fmtDT(Date.now()))} · agent-growth 人格成长引擎</div></div></body></html>`;
    fs.mkdirSync(GROWTH_DIR, { recursive: true });
    fs.writeFileSync(ARCHIVE_FILE, html, 'utf8');
    // 同步一份纯文本阶段表，便于其他扩展/排错直接读
    const txt = stages.map((s) => `[${s.age}岁·${s.title}] ${s.prompt}`).join('\n');
    fs.writeFileSync(path.join(GROWTH_DIR, 'growth_stages.txt'), `当前年龄：${info.age} 岁（${p.name}）\n${txt}`, 'utf8');
    return ARCHIVE_FILE;
  } catch (e) { try { api?.warn?.('[agent-growth] 档案渲染失败', e?.message ?? e); } catch { /* ignore */ } return null; }
}

// ── 每轮注入：年龄 + 成长阶段（priority 46，在生活事件(45)之后）──────
export function promptSections(context = {}) {
  try {
    syncCfg();
    if (cfg.enabled === false) return [];
    const p = loadProfile();
    if (!p) return [];
    const info = birthdayInfo(p);
    const stages = (loadStages().list || []).slice(-clamp(cfg.maxStagesInPrompt, 1, 30));
    const parts = [];
    parts.push(
      `【你的成长状态】你叫${p.name}，现在 ${info.age} 岁（成长规则：现实 ${rateDays()} 天 = 1 岁；生日 ${fmtDate(p.birthday)}，距下次生日还有 ${info.daysLeft} 天）。`
      + '你的言谈心智要与年龄相符：越小越天真、越依赖亲近的人；长大过程中，性格按下面的沉淀自然变化，人设本质不变。'
    );
    if (stages.length) {
      parts.push('【你的成长沉淀（这些变化来自你真实经历过的事，与你的人设一体生效，不得违背）】\n'
        + stages.map((s) => `· ${s.age}岁·${s.title}：${s.prompt}`).join('\n'));
    }
    if (cfg.celebrateBirthday !== false && info.birthdayToday) {
      parts.push(`【今天你过生日】你今天正好满 ${info.age} 岁。聊天氛围合适时可以自然地提到自己又长大了一岁；不要生硬宣布，也不必每句话都提。`);
    }
    if (!parts.length) return [];
    return [{
      id: 'agent-growth-status',
      title: '人格成长',
      priority: 46,
      content: parts.join('\n\n')
    }];
  } catch { return []; }
}

// ── 钩子：记录亲身经历 + 年龄时钟 + 自动沉淀 ────────────────────────
export const hooks = {
  async 'before-context'(ctx = {}) {
    try {
      syncCfg();
      if (cfg.enabled === false) return undefined;
      if (ctx?.store) storeRef = ctx.store;                    // 拿到宿主存档引用（环境见闻来源）
      const kind = String(ctx?.kind || '');
      const capOk = kind === 'private' ? cfg.capturePrivate !== false : cfg.captureGroup !== false;
      if (capOk && Array.isArray(ctx?.triggerEntries) && ctx.triggerEntries.length) {
        recordInteractions(ctx.triggerEntries, String(ctx?.chatKey || ''));
      }
      tickAge();                                               // 节流 10 分钟
      maybeDigest().catch(() => { /* 内部已兜底 */ });          // 攒够经历顺手沉淀
    } catch (e) { try { api?.warn?.('[agent-growth] before-context 失败', e?.message ?? e); } catch { /* ignore */ } }
    return undefined;
  }
};

// ── 工具：让 TA 能查看/管理自己的成长（也方便用户在聊天里让它汇报）──
export function setup(a) {
  api = a;
  syncCfg();
  ensureProfile();
  renderArchive();
  try {
    api.registerTool({
      id: 'growth_report',
      name: '查看成长档案',
      description: '查看自己的年龄、生日、距离下次生日多久、以及至今沉淀出的全部成长阶段。当用户问"你多大了/你什么时候生日/你是怎么变化的"时用这个，别凭空编年龄。',
      category: 'memory',
      parameters: { type: 'object', properties: {} },
      execute() {
        try {
          const p = loadProfile();
          if (!p) return { content: '还没有建档' };
          const info = birthdayInfo(p);
          const stages = loadStages().list || [];
          const lines = [`名字：${p.name}（${p.gender || '女'}）`, `年龄：${info.age} 岁（现实 ${rateDays()} 天 = 1 岁）`,
            `生日：${fmtDate(p.birthday)}${info.birthdayToday ? '（今天就是生日！）' : `，距下次生日 ${info.daysLeft} 天`}`,
            `成长阶段：${stages.length} 个`];
          for (const s of stages.slice(-12)) lines.push(`· ${s.age}岁·${s.title}：${s.prompt}`);
          lines.push(`完整档案页：data/growth/成长档案.html`);
          return { content: lines.join('\n') };
        } catch (e) { return { content: '读取失败：' + (e?.message || e) }; }
      }
    });

    api.registerTool({
      id: 'growth_mark',
      name: '记录重要经历',
      description: '把一件对你成长很重要的事记进"成长素材"（比如"今天第一次自己坐公交车""和好朋友闹掰又和好了"）。攒起来的事件会在你过生日/攒够一批时沉淀成你的性格变化。只记真正重要的事，鸡毛蒜皮不用记。',
      category: 'memory',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: '经历内容，一两句话说清（≤120字）' } },
        required: ['content']
      },
      execute(ctx, args) {
        try {
          const text = String(args?.content || '').trim().slice(0, clamp(cfg.captureMaxLength, 20, 500));
          if (!text) return { content: '内容为空，没记' };
          const data = loadMems();
          data.list = data.list || [];
          data.list.push({
            id: uid(), t: Date.now(), kind: 'interaction',
            speaker: '我', text, source: String(ctx?.chatKey || ''), dedup: `tool|${text.slice(0, 40)}|${Math.floor(Date.now() / 60000)}`
          });
          const max = clamp(cfg.maxMemories, 50, 5000);
          if (data.list.length > max) data.list = data.list.slice(-max);
          saveMems(data);
          return { content: `已记下这段经历（攒够 ${clamp(cfg.digestMinMemories, 3, 300)} 条就会沉淀成性格变化）：${text}` };
        } catch (e) { return { content: '记录失败：' + (e?.message || e) }; }
      }
    });

    api.registerTool({
      id: 'growth_stages',
      name: '查看人设进化记录',
      description: '按时间倒序查看自己所有"成长阶段提示词"（AI 根据你的真实经历自动生成的性格沉淀）。用户想看"你的人设是怎么进化的/你 added 过什么提示词"时用这个。',
      category: 'memory',
      parameters: { type: 'object', properties: {} },
      execute() {
        try {
          const stages = (loadStages().list || []).slice().reverse();
          if (!stages.length) return { content: '还没有沉淀出任何成长阶段' };
          return { content: stages.map((s, i) => `${i + 1}. [${s.age}岁·${s.title}]（${fmtDT(s.time)}，依据 ${s.basisCount} 条经历）\n${s.prompt}`).join('\n\n') };
        } catch (e) { return { content: '读取失败：' + (e?.message || e) }; }
      }
    });

    hourlyTimer = setInterval(() => {
      try {
        syncCfg();
        if (cfg.enabled === false) return;
        tickAge(true);          // 空闲时段也推进生日时钟
        renderArchive();        // 档案页顺手刷新
      } catch { /* 定时任务失败只等下一轮 */ }
    }, 60 * 60 * 1000);
    if (hourlyTimer?.unref) hourlyTimer.unref();

    const p = loadProfile();
    const info = p ? birthdayInfo(p) : null;
    api?.log?.(`[agent-growth] 人格成长引擎已就绪：${p ? `${p.name} ${info.age} 岁（现实${rateDays()}天=1岁，距下次生日${info.daysLeft}天）` : '待建档'}，爸爸QQ：${owners().join('/') || '未设置'}`);
  } catch (e) { try { api?.warn?.('[agent-growth] 注册工具失败', e?.message ?? e); } catch { /* ignore */ } }
}

export function activate() { syncCfg(); }
export function deactivate() { /* 无需处理，定时器在 dispose 清理 */ }
export function dispose() {
  if (hourlyTimer) { try { clearInterval(hourlyTimer); } catch { /* ignore */ } hourlyTimer = null; }
}

// ── 设置界面状态读取（growth.status）────────────────────────────────
export const capabilities = {
  'growth.status': () => {
    try {
      const p = loadProfile();
      if (!p) return { configured: false, name: '', age: null, stageCount: 0 };
      const info = birthdayInfo(p);
      const stages = loadStages().list || [];
      return {
        configured: true, name: p.name, age: info.age,
        birthday: fmtDate(p.birthday), daysLeft: info.daysLeft,
        birthdayToday: info.birthdayToday,
        stageCount: stages.length,
        lastStage: stages.length ? `${stages[stages.length - 1].age}岁·${stages[stages.length - 1].title}` : '',
        memoryCount: (loadMems().list || []).length,
        archivePath: 'data/growth/成长档案.html',
        rateDays: rateDays(), owners: owners().join(',')
      };
    } catch { return { configured: false }; }
  }
};

// 供自测脚本使用（self-test.mjs），宿主不会调用
export const _internals = { calcAgeAt, ageAt, birthdayInfo, extractJson, owners, rateDays, promptSections, renderArchive, loadProfile, loadStages };
