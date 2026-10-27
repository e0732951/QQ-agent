/**
 * 表情包管理。
 *
 * 发表情只有一个出口：send_sticker / sender.sendSticker → OneBotClient.sendSticker
 * → sendSegments。这里包住原型：先 add_custom_face 存进 QQ 表情，再给图片段补
 * sub_type，让客户端按小表情渲染。同一地址只入库一次。入库失败仍按表情发送。
 * sendImage（普通发图）不经过这里。
 *
 * 梗鲸技能通过 sticker.manage 读取本插件的搜集参数和发送倾向。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotClient } from '../../src/onebot.js';
import * as meme from './meme/index.js';

const PATCHED = Symbol.for('qq-agent.sticker-send-as-emoji.patched');
const IN_STICKER = Symbol.for('qq-agent.sticker-send-as-emoji.inSticker');
const FACE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/sticker-send-as-emoji/faces.json');
const POLICY_KEYS = [
  'networkEnabled', 'character', 'minShortSide', 'poolSize', 'cacheMinutes', 'promptCandidates',
  'localEnabled', 'localDirectory', 'autoReply', 'count', 'cooldownSeconds', 'maxCount', 'intensity'
];

let faces = null;
let cfg = () => ({});
let log = () => {};
let warn = () => {};
let origSendSticker = null;
let origSendSegments = null;

const DEFAULTS = { enabled: true, subType: 1, debug: false };

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const n = Number(s.subType);
  return {
    ...s,
    enabled: s.enabled !== false,
    subType: Number.isFinite(n) ? n : DEFAULTS.subType,
    debug: s.debug === true,
    groupCollect: s.groupCollect === true
  };
}

function dbg(...args) {
  if (!settings().debug) return;
  try { log('[表情包管理]', ...args); } catch { /* ignore */ }
}

function loadFaces() {
  if (faces) return faces;
  try { faces = JSON.parse(fs.readFileSync(FACE_FILE, 'utf8')); }
  catch { faces = {}; }
  if (!faces || typeof faces !== 'object' || Array.isArray(faces)) faces = {};
  return faces;
}

function saveFaces() {
  try {
    fs.mkdirSync(path.dirname(FACE_FILE), { recursive: true });
    fs.writeFileSync(FACE_FILE, JSON.stringify(loadFaces()));
  } catch { /* 记不住就下次再入库，不影响发送 */ }
}

function faceKey(ref) {
  const text = String(ref || '');
  if (text.length <= 180 && !text.startsWith('base64://')) return text;
  return createHash('sha1').update(text).digest('hex');
}

/** add_custom_face 认本地路径、http 直链和 base64，不认 file:///。 */
function faceArg(ref) {
  const text = String(ref || '');
  if (!text.toLowerCase().startsWith('file:///')) return text;
  let local = text.slice('file:///'.length);
  if (/^\/[a-zA-Z]:/.test(local)) local = local.slice(1);
  try { local = decodeURIComponent(local); } catch { /* 保持原样 */ }
  return local.replace(/\//g, path.sep);
}

/**
 * 先存进 QQ 表情收藏。同一地址只入库一次。
 * 失败或协议端没返回 emoji_id 时仍返回原地址，让后面按表情发出。
 */
async function rememberFace(client, imageUrl) {
  const key = faceKey(imageUrl);
  if (!key || typeof client?.call !== 'function') return imageUrl;
  const known = loadFaces();
  if (known[key]) return imageUrl;
  const ret = await client.call('add_custom_face', { file: faceArg(imageUrl) });
  const emojiId = String(ret?.emoji_id ?? ret?.data?.emoji_id ?? '').trim();
  if (!emojiId) return imageUrl;
  known[key] = emojiId;
  saveFaces();
  dbg(`已存进 QQ 表情：${emojiId}`);
  return imageUrl;
}

function policySettings() {
  const source = settings();
  const out = {};
  for (const key of POLICY_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** 给正在发表情的那一批分段补上 sub_type。只改图片段，不改 reply/at。 */
function markStickerSegments(segments, subType) {
  let changed = 0;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'image') continue;
    const data = seg.data;
    if (!data || typeof data !== 'object') continue;
    if (data.sub_type !== undefined && data.sub_type !== null) continue;
    data.sub_type = subType;
    changed++;
  }
  return changed;
}

function install() {
  const proto = OneBotClient?.prototype;
  if (!proto) { warn('拿不到 OneBotClient 原型，表情标记未挂载（应用版本可能变了）'); return false; }
  if (proto[PATCHED]) return true;

  const sendSticker = proto.sendSticker;
  const sendSegments = proto.sendSegments;
  if (typeof sendSticker !== 'function' || typeof sendSegments !== 'function') {
    warn('OneBotClient 上找不到 sendSticker/sendSegments，表情标记未挂载');
    return false;
  }
  origSendSticker = sendSticker;
  origSendSegments = sendSegments;

  // sendSticker 在第一次 await 之前就会调用 sendSegments，所以标记只包住这次同步调用，
  // 不会在网络等待期间误伤并发的发图。
  proto.sendSegments = function (kind, id, segments) {
    try {
      const s = settings();
      if (s.enabled && this?.[IN_STICKER] && Array.isArray(segments)) {
        const n = markStickerSegments(segments, s.subType);
        if (n) dbg(`已标记 ${n} 个图片段为表情（sub_type=${s.subType}）`);
      }
    } catch (error) {
      try { warn('补 sub_type 失败（本次按普通图片发送）：%s', error?.message ?? error); } catch { /* ignore */ }
    }
    return origSendSegments.call(this, kind, id, segments);
  };

  proto.sendSticker = async function (kind, id, imageUrl, options) {
    let ref = imageUrl;
    if (settings().enabled) {
      try { ref = await rememberFace(this, imageUrl); }
      catch (error) {
        try { warn('存入 QQ 表情失败，仍按表情发送：%s', error?.message ?? error); } catch { /* ignore */ }
      }
    }
    this[IN_STICKER] = true;
    try {
      return origSendSticker.call(this, kind, id, ref, options);
    } finally {
      this[IN_STICKER] = false;
    }
  };

  proto[PATCHED] = true;
  return true;
}

function uninstall() {
  const proto = OneBotClient?.prototype;
  if (!proto || !proto[PATCHED]) return;
  if (typeof origSendSticker === 'function') proto.sendSticker = origSendSticker;
  if (typeof origSendSegments === 'function') proto.sendSegments = origSendSegments;
  delete proto[PATCHED];
  origSendSticker = null;
  origSendSegments = null;
}

const pendingStickers = new Map();

function styleWordList() {
  return String(settings().styleWords ?? settings().styleKeywords ?? '')
    .split(/[\s,，、;；]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

function stickerTargets(entries) {
  const out = [];
  for (const message of entries || []) {
    if (!message || message.self) continue;
    const mid = message.mid;
    if (mid === undefined || mid === null || String(mid) === '') continue;
    for (const media of message.media || []) {
      if (media?.kind !== 'image' || !(media.url || media.file)) continue;
      const label = `${media.summary || ''} ${message.text || ''}`;
      if (!/动画表情|動畫表情/.test(label)) continue;
      out.push({ mid, url: media.url || '', file: media.file || '' });
      break;
    }
  }
  return out;
}

function responseText(response) {
  const message = response?.message || response || {};
  const parts = [message.content, message.reasoning_content];
  for (const call of message.tool_calls || []) {
    parts.push(call?.function?.name, call?.function?.arguments);
  }
  return parts.filter((part) => typeof part === 'string').join('\n');
}

function rememberStickers(ctx) {
  const id = String(ctx?.sessionId || '');
  if (!id || !settings().enabled || !settings().groupCollect) return [];
  const targets = stickerTargets(ctx.triggerEntries);
  pendingStickers.set(id, { at: Date.now(), targets });
  if (pendingStickers.size > 30) {
    const oldest = [...pendingStickers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pendingStickers.delete(oldest[0]);
  }
  return targets;
}

function collectMatched(ctx) {
  const id = String(ctx?.sessionId || '');
  const found = id ? pendingStickers.get(id) : null;
  const targets = found?.targets || [];
  if (!targets.length || typeof ctx?.stickers?.collect !== 'function') return;
  const words = styleWordList();
  const hit = words.filter((word) => responseText(ctx.response).includes(word));
  if (!hit.length) return;
  pendingStickers.delete(id);
  const note = `群内搜集：${hit.slice(0, 3).join(' ')}`.slice(0, 40);
  for (const target of targets) {
    void ctx.stickers.collect(target.mid, { url: target.url, file: target.file, note })
      .then(() => { try { log(`已按关键词收藏群表情 #${target.mid}`); } catch { /* ignore */ } })
      .catch((error) => { try { warn(`关键词收藏失败 #${target.mid}：${error?.message ?? error}`); } catch { /* ignore */ } });
  }
}

function groupCollectSections() {
  const current = settings();
  if (!current.enabled || !current.groupCollect) return [];
  const words = styleWordList();
  const taste = words.length
    ? `关键词是收录条件：${words.join('、')}。看过的表情包只要对得上其中一个，本轮结束前必须调用 collect_sticker。只在回复里提到、不调用收藏，不算收录。`
    : '没有填写风格关键词，按你自己的喜好决定收不收。';
  return [{
    id: 'sticker-group-collect',
    content: `群内表情搜集已开。${taste}messageId 填那条消息的 #数字，note 用一句话写这张图在说什么。截图、照片、广告图不要收，已经在表情库里的不要重复收。`
  }];
}

export function promptSections(ctx) {
  const extra = typeof meme.promptSections === 'function' ? meme.promptSections(ctx) : [];
  return [...groupCollectSections(), ...(Array.isArray(extra) ? extra : [])];
}

export const hooks = {
  'before-context'(ctx) { rememberStickers(ctx); },
  'before-llm-messages'(ctx) {
    const words = styleWordList();
    const targets = pendingStickers.get(String(ctx?.sessionId || ''))?.targets || [];
    if (settings().enabled && settings().groupCollect && words.length && targets.length && Array.isArray(ctx?.messages)) {
      const ids = targets.map((item) => `#${item.mid}`).join('、');
      ctx.messages.push({
        role: 'user',
        content: `【表情包搜集】别人刚发的表情：${ids}。关键词：${words.join('、')}。看完后只要对得上其中一个，就调用 collect_sticker，messageId 用对应的 #数字，note 写这张图在说什么。只回复、不收藏，不算收录。照片和截图不要收。`
      });
    }
    return meme.hooks?.['before-llm-messages']?.(ctx);
  },
  'after-response'(ctx) {
    const out = meme.hooks?.['after-response']?.(ctx);
    try { collectMatched(ctx); } catch { /* 收藏失败不影响回复 */ }
    return out;
  }
};

export async function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  const ok = install();
  const s = settings();
  if (ok) {
    log(s.enabled
      ? `表情包管理已启用：发送前先存入 QQ 表情，再按表情发出（sub_type=${s.subType}）`
      : '表情包管理当前已关闭：表情仍按普通图片发送');
  }
  if (typeof api?.registerTool === 'function') await meme.setup(api);
}

export function activate() { meme.activate?.(); }

export function deactivate() {
  try { meme.deactivate?.(); } catch { /* 检索停不掉也不该挡住卸补丁 */ }
  uninstall();
}
export function dispose() { deactivate(); }
export function available() { return { ok: true }; }

export const providers = {
  'sticker.manage': () => ({ available: true, settings: policySettings() }),
  'sticker-send-as-emoji.status': () => {
    const s = settings();
    const proto = OneBotClient?.prototype;
    return {
      enabled: s.enabled,
      subType: s.subType,
      groupCollect: s.groupCollect,
      networkEnabled: s.networkEnabled !== false,
      patchInstalled: !!(proto && proto[PATCHED]),
      sendStickerPatched: !!(proto && typeof proto.sendSticker === 'function' && proto[PATCHED])
    };
  }
};
