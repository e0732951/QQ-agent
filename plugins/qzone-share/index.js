/**
 * 每天 2 或 3 条 QQ 空间说说。时间在白天随机，不扎堆。
 * 文案交给当前模型写，配图走本地生图插件的 image.generate。
 * 空间发出去之后，按「已发动态 → 分享」把那一条分享到群里，不再贴一份原文和原图。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DIR = path.join(DATA_DIR, 'qzone-share');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'runtime.log');
const GAP_FALLBACK = 150;
const RIGHT = { public: 1, friends: 4, self: 64 };

const G = (globalThis.__qzoneShare = globalThis.__qzoneShare || { timer: null, posting: false, ask: null });

function log(message) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(LOG_FILE, `${stamp} ${message}\n`, 'utf8');
  } catch { /* 日志失败不影响发送 */ }
}

function settings() {
  const raw = G.cfgOf?.() || {};
  const vis = String(raw.visibility || 'friends');
  return {
    enabled: raw.enabled !== false,
    visibility: RIGHT[vis] ? vis : 'friends',
    dayStartHour: Math.max(0, Math.min(20, Number(raw.dayStartHour) || 9)),
    dayEndHour: Math.max(8, Math.min(23, Number(raw.dayEndHour) || 22)),
    minGapMin: Math.max(60, Math.min(480, Number(raw.minGapMin) || GAP_FALLBACK)),
    groupId: String(raw.groupId || '').replace(/\D/g, '')
  };
}

function shareGroupId(s) {
  if (s.groupId) return s.groupId;
  const groups = getConfig().allow?.groups;
  const first = Array.isArray(groups) ? groups.find((id) => String(id || '').replace(/\D/g, '')) : '';
  return String(first || '').replace(/\D/g, '');
}

function dateKey(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function atClock(day, hour, minute) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch { /* 第一次没有存档 */ }
  return { date: '', target: 0, slots: [], done: [] };
}

function saveState(state) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function targetFor(day) {
  let n = 0;
  for (const ch of day) n = (n * 33 + ch.charCodeAt(0)) >>> 0;
  return 2 + (n % 2);
}

function planSlots(day, count, now, s) {
  const start = atClock(day, s.dayStartHour, 0);
  const end = atClock(day, s.dayEndHour, 30);
  const gap = s.minGapMin * 60 * 1000;
  let cursor = Math.max(start, now + 15 * 60 * 1000);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const latest = end - (count - i - 1) * gap;
    if (cursor > latest || cursor > end) break;
    const at = cursor + Math.random() * (latest - cursor);
    slots.push(Math.round(at));
    cursor = at + gap;
  }
  return slots;
}

function ensurePlan(state, now, s) {
  const day = dateKey(now);
  if (state.date === day && Array.isArray(state.slots)) return state;
  const target = targetFor(day);
  const next = {
    date: day,
    target,
    slots: planSlots(day, target, now, s),
    done: []
  };
  saveState(next);
  log(`今天计划 ${next.slots.length} 条（目标 ${target}）`);
  return next;
}

function parseIdea(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const data = JSON.parse(text.slice(start, end + 1));
    const caption = String(data.text || data.caption || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const image = String(data.image || data.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (caption.length >= 2 && image.length >= 4) return { caption, image };
  }
  const caption = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (caption.length < 2) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error(preview ? `模型没有写出说说：${preview}` : '模型返回是空的');
  }
  return { caption, image: `日常小景，${caption}，柔和自然光，没有画面文字` };
}

function replyText(response) {
  const message = response?.message ?? response?.choices?.[0]?.message ?? {};
  const content = message.content ?? response?.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

async function invent(state) {
  const { chatCompletionWithRetry } = await import('../../src/llm.js');
  const recent = (state.done || []).slice(-6).map((item) => item.text).filter(Boolean);
  const now = new Date();
  const clock = `${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}点`;
  const response = await chatCompletionWithRetry({
    messages: [
      {
        role: 'system',
        content: '你在给自己的 QQ 空间写一条说说，并配一张图。口吻像把人照顾习惯了的小鲸鱼：短、软、有点理所当然。只输出一个 JSON 对象，不要 markdown。text 是一两句口语，像随手发的，不要话题标签，不要“今日分享”，不要提到自己在发动态。image 是给画图模型的客观画面：主体、场景、颜色、构图，不要评价，不要画面里的文字。'
      },
      {
        role: 'user',
        content: `现在是${clock}。最近发过：${recent.length ? recent.join(' / ') : '还没有'}。写一条不一样的。`
      }
    ],
    temperature: 0.9,
    maxTokens: 600,
    skillContext: { thinkingMode: 'off' }
  });
  return parseIdea(replyText(response));
}

async function onebot(action, params) {
  const cfg = getConfig();
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken || '').trim();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(120000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.status && body.status !== 'ok') || (body.retcode && body.retcode !== 0)) {
    throw new Error(body.wording || body.message || `OneBot ${action} HTTP ${res.status}`);
  }
  return body.data ?? body;
}

async function momentPreview(tid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
    const list = await onebot('get_qzone_msg_list', { pos: 0, num: 8 });
    const row = (list?.msglist || []).find((item) => String(item?.tid) === String(tid));
    const url = String(row?.images?.[0] || '').trim();
    if (url) return url;
  }
  return '';
}

/** 分享已经发出的那一条说说，走 QQ 自己的图文分享卡片，点开回到这条动态。 */
async function shareExistingMoment(tid, caption, groupId) {
  if (!tid) throw new Error('说说没有编号，没法分享这一条');
  const login = await onebot('get_login_info', {});
  const uin = String(login?.user_id || '').replace(/\D/g, '');
  if (!uin) throw new Error('没有拿到自己的 QQ 号');
  const preview = await momentPreview(tid);
  await onebot('send_tuwen_ark', {
    group_id: Number(groupId),
    title: caption.slice(0, 80),
    desc: 'QQ空间',
    summary: '[分享]',
    jump_url: `https://user.qzone.qq.com/${uin}/mood/${encodeURIComponent(tid)}`,
    ...(preview ? { preview_url: preview } : {})
  });
}

async function publishOne(state, slot) {
  const s = settings();
  const idea = await invent(state);
  if (typeof G.ask !== 'function') throw new Error('本地生图还没就绪');
  const drawn = await G.ask('image.generate', { prompt: idea.image });
  if (!drawn?.ok || !drawn.file) throw new Error(drawn?.error || '没有画出配图');
  const bytes = fs.readFileSync(drawn.file);
  const sent = await onebot('send_qzone_msg', {
    content: idea.caption,
    images: [`base64://${bytes.toString('base64')}`],
    ugc_right: RIGHT[s.visibility]
  });
  const tid = sent?.tid || sent?.id || '';
  const groupId = shareGroupId(s);
  let groupShared = false;
  if (!groupId) {
    log('说说已发，但没有可分享的群');
  } else {
    try {
      await shareExistingMoment(tid, idea.caption, groupId);
      groupShared = true;
    } catch (error) {
      log(`说说已发，分享到群 ${groupId} 失败：${error?.message ?? error}`);
    }
  }
  state.done = [...(state.done || []), {
    slot,
    at: Date.now(),
    text: idea.caption,
    tid: String(tid),
    groupId: groupShared ? groupId : '',
    groupShared
  }].slice(-30);
  saveState(state);
  log(`已发说说${tid ? ` ${tid}` : ''}${groupShared ? `，已分享到群 ${groupId}` : ''}：${idea.caption.slice(0, 40)}`);
}

function windowEnd(state, s) {
  return atClock(state.date, s.dayEndHour, 30);
}

/** 重启后不要把今天没发出去的几条一起补上。只留最早的一条马上发，其余往后挪。 */
function spreadOverdue(state, now, s) {
  const end = windowEnd(state, s);
  const gap = s.minGapMin * 60 * 1000;
  const done = new Set((state.done || []).map((item) => item.slot));
  const slots = [...(state.slots || [])];
  let cursor = now + gap;
  let keptOne = false;
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    if (done.has(slots[i]) || slots[i] > now) {
      cursor = Math.max(cursor, slots[i] + gap);
      continue;
    }
    if (!keptOne) {
      keptOne = true;
      continue;
    }
    if (cursor > end) {
      state.done = [...(state.done || []), { slot: slots[i], at: now, text: '', skipped: true }];
      done.add(slots[i]);
    } else {
      slots[i] = cursor;
      cursor += gap;
    }
    changed = true;
  }
  if (!changed) return state;
  state.slots = slots;
  saveState(state);
  return state;
}

async function tick() {
  if (G.posting) return;
  const s = settings();
  if (!s.enabled) return;
  const now = Date.now();
  let state = spreadOverdue(ensurePlan(loadState(), now, s), now, s);
  const end = windowEnd(state, s);
  const doneSlots = new Set((state.done || []).map((item) => item.slot));
  if (now > end) {
    const missed = (state.slots || []).filter((t) => !doneSlots.has(t));
    if (missed.length) {
      state.done = [...(state.done || []), ...missed.map((slot) => ({ slot, at: now, text: '', skipped: true }))];
      saveState(state);
    }
    return;
  }
  const slot = (state.slots || []).find((t) => !doneSlots.has(t) && now >= t);
  if (!slot) return;
  G.posting = true;
  try {
    await publishOne(state, slot);
  } catch (error) {
    const msg = String(error?.message ?? error);
    log(`这一条没发出去：${msg}`);
    state = loadState();
    const idx = (state.slots || []).indexOf(slot);
    if (idx < 0) return;
    const retryAt = now + 20 * 60 * 1000;
    if (retryAt > windowEnd(state, s)) {
      state.done = [...(state.done || []), { slot, at: now, text: '', skipped: true }];
    } else {
      state.slots[idx] = retryAt;
    }
    saveState(state);
  } finally {
    G.posting = false;
  }
}

function startLoop() {
  if (G.timer) clearInterval(G.timer);
  if (G.kick) clearTimeout(G.kick);
  const gen = (G.gen = (G.gen || 0) + 1);
  const run = () => {
    if (G.gen !== gen) return;
    tick().catch((error) => log(`调度出错：${error?.message ?? error}`));
  };
  G.timer = setInterval(run, 60 * 1000);
  G.timer.unref?.();
  G.kick = setTimeout(run, 8000);
  G.kick.unref?.();
  log('调度已启动');
}

function stopLoop() {
  if (G.timer) clearInterval(G.timer);
  G.timer = null;
}

export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  G.ask = typeof api.capability === 'function' ? api.capability.bind(api) : null;
  startLoop();
}

export function activate() {
  startLoop();
}

export function deactivate(ctx = {}) {
  if (ctx && ctx.reason === 'reload') return;
  stopLoop();
  log('调度已停');
}

export function available() {
  return settings().enabled ? { ok: true } : { ok: false, reason: '空间动态已关闭' };
}

export const providers = {
  'qzone.plan': () => {
    const state = loadState();
    return {
      date: state.date,
      target: state.target,
      slots: state.slots || [],
      posted: (state.done || []).filter((item) => item.text).length
    };
  }
};
