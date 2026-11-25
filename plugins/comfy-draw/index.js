/**
 * 本地生图。工作流来自本机 comfy-dafeiyu 上一次已经成功的 Z-Image Turbo：
 * UNET z_image_turbo_bf16 + CLIP qwen_3_4b(lumina2) + VAE ae，
 * 8 步、cfg 1、res_multistep、AuraFlow shift 3、1024。
 * 同一时间只画一张，避免 8GB 显存叠两份模型。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const TOOL = 'comfy-draw__draw_image';
const OUT_DIR = path.join(DATA_DIR, 'comfy-draw');

const DEFAULTS = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8188',
  unetName: 'z_image_turbo_bf16.safetensors',
  clipName: 'qwen_3_4b.safetensors',
  vaeName: 'ae.safetensors',
  width: 1024,
  height: 1024,
  steps: 8,
  timeoutMs: 180000,
  memberGapMin: 5
};

let cfgOf = () => ({});
let log = () => {};
let drawing = false;
const RECENT_MS = 3 * 60 * 1000;
const recentByChat = (globalThis.__comfyDrawRecent = globalThis.__comfyDrawRecent || new Map());
const drawQuota = (globalThis.__comfyDrawQuota = globalThis.__comfyDrawQuota || new Map());
const nudgeAt = (globalThis.__comfyNudgeAt = globalThis.__comfyNudgeAt || new Map());
const NUDGE_MS = 10 * 60 * 1000;

function normPrompt(text) {
  return String(text || '').toLowerCase().replace(/[\s，。、“”‘’！？、,.!?'"\-：:；;]/g, '');
}

/** 同一次要求里模型常把提示词改几个字再画一遍。大部分用词一样就当成同一张。 */
function sameRequest(a, b) {
  const x = normPrompt(a);
  const y = normPrompt(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 16 && (x.includes(y) || y.includes(x))) return true;
  const count = (s) => {
    const g = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const k = s.slice(i, i + 2);
      g.set(k, (g.get(k) || 0) + 1);
    }
    return g;
  };
  const gx = count(x);
  const gy = count(y);
  let inter = 0;
  let left = 0;
  let right = 0;
  for (const n of gx.values()) left += n;
  for (const [k, n] of gy) {
    right += n;
    inter += Math.min(n, gx.get(k) || 0);
  }
  const total = left + right;
  return total > 0 && (2 * inter) / total >= 0.82;
}

function cfg() {
  const raw = cfgOf() || {};
  const merged = { ...DEFAULTS, ...raw };
  const gap = Number(merged.memberGapMin);
  merged.memberGapMin = Number.isFinite(gap) ? Math.max(0, Math.min(120, Math.round(gap))) : 5;
  return merged;
}

function requesterId(ctx) {
  const list = ctx?.session?.trigger;
  const self = String(ctx?.selfId || '');
  if (!Array.isArray(list)) return '';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const id = String(list[i]?.senderId || '');
    if (id && id !== 'self' && id !== self) return id;
  }
  return '';
}

async function groupOwner(onebot, groupId) {
  const box = globalThis.__qqGroupOwner = globalThis.__qqGroupOwner || new Map();
  const key = String(groupId);
  const hit = box.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  if (!onebot?.call) return hit || null;
  let list = [];
  try {
    const data = await onebot.call('get_group_member_list', { group_id: Number(groupId) });
    list = Array.isArray(data) ? data : [];
  } catch {
    return hit || null;
  }
  const owner = list.find((m) => m && m.role === 'owner' && m.user_id != null);
  if (!owner) return hit || null;
  const info = {
    id: String(owner.user_id),
    name: String(owner.card || owner.nickname || ''),
    at: Date.now()
  };
  box.set(key, info);
  return info;
}

async function comfyReady() {
  const c = cfg();
  if (c.enabled === false) return { ok: false, error: '本地生图已经关掉。' };
  try {
    const alive = await readJson(`${baseOf(c)}/system_stats`, 4000);
    if (!alive.ok) return { ok: false, down: true };
    return { ok: true };
  } catch {
    return { ok: false, down: true };
  }
}

async function remindDraw(ctx) {
  const chatKey = String(ctx?.chatKey || '');
  const [kind, id] = chatKey.split(':');
  if (kind !== 'group' && kind !== 'private') return false;
  const slot = `draw:${chatKey}`;
  if (Date.now() - (nudgeAt.get(slot) || 0) < NUDGE_MS) return false;
  const onebot = ctx?.onebot;
  if (!onebot?.sendText) return false;
  const owner = kind === 'group' ? await groupOwner(onebot, id) : null;
  const asker = requesterId(ctx);
  const toOwner = Boolean(owner && asker === owner.id);
  const text = toOwner
    ? '呜……画画的小炉子还没点着。群主把 Comfy 打开一下嘛。'
    : '呜……画画的小炉子还没点着，把 Comfy 打开一下嘛。';
  nudgeAt.set(slot, Date.now());
  try {
    await onebot.sendText(kind, id, text, {
      atUserId: !toOwner && owner ? owner.id : null,
      skipVoice: true
    });
    return true;
  } catch {
    nudgeAt.delete(slot);
    return false;
  }
}

/** 群员冷却。群主不限。返回字符串就是要拒绝的原因；返回 { key } 表示这次可以画，成功后再记账。 */
async function quotaHold(ctx) {
  const gap = cfg().memberGapMin;
  if (gap <= 0) return null;
  const [kind, id] = String(ctx?.chatKey || '').split(':');
  if (kind !== 'group') return null;
  const who = requesterId(ctx);
  if (!who) return null;
  const owner = await groupOwner(ctx?.onebot, id);
  if (owner && who === owner.id) return null;
  const key = `${id}:${who}`;
  const last = drawQuota.get(key) || 0;
  const wait = gap * 60 * 1000 - (Date.now() - last);
  if (wait > 0) {
    const left = Math.max(1, Math.ceil(wait / 60000));
    return `这个人 ${gap} 分钟内已经画过一张了，还要再等大约 ${left} 分钟。用一句短的让他们再等等，不要再画。`;
  }
  return { key };
}

function snap(n, fallback) {
  const v = Number(n);
  const base = Number.isFinite(v) ? v : fallback;
  const clamped = Math.max(512, Math.min(1024, Math.round(base)));
  return Math.round(clamped / 16) * 16;
}

function buildWorkflow(c, text, width, height, seed) {
  return {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: c.unetName, weight_dtype: 'default' }
    },
    2: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: c.clipName, type: 'lumina2', device: 'default' }
    },
    3: {
      class_type: 'VAELoader',
      inputs: { vae_name: c.vaeName }
    },
    4: {
      class_type: 'CLIPTextEncode',
      inputs: { text, clip: ['2', 0] }
    },
    5: {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['4', 0] }
    },
    6: {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: 1 }
    },
    7: {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { shift: 3, sampling: 'flow', model: ['1', 0] }
    },
    8: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: Math.max(4, Math.min(12, Math.round(Number(c.steps) || 8))),
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1,
        model: ['7', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0]
      }
    },
    9: {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['3', 0] }
    },
    10: {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'qq-agent', images: ['9', 0] }
    }
  };
}

function baseOf(c) {
  return String(c.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
}

async function readJson(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body };
}

function firstImage(item) {
  const outputs = item?.outputs || {};
  for (const node of Object.values(outputs)) {
    const img = Array.isArray(node?.images) ? node.images[0] : null;
    if (img?.filename) return img;
  }
  return null;
}

function errorText(item, fallback) {
  const messages = item?.status?.messages;
  const hit = Array.isArray(messages)
    ? messages.find((m) => Array.isArray(m) && /error/i.test(String(m[0])))
    : null;
  const detail = hit ? JSON.stringify(hit[1] ?? hit).slice(0, 400) : '';
  return detail || fallback;
}

async function cancelPrompt(base, promptId) {
  try {
    const queued = await readJson(`${base}/queue`, 5000);
    const running = queued.body?.queue_running || [];
    const pending = queued.body?.queue_pending || [];
    const mineRunning = running.some((row) => Array.isArray(row) && String(row[1]) === promptId);
    const minePending = pending.some((row) => Array.isArray(row) && String(row[1]) === promptId);
    if (minePending) {
      await fetch(`${base}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(5000)
      });
    }
    if (mineRunning) {
      await fetch(`${base}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    }
  } catch { /* 撤不掉就让它自己跑完 */ }
}

async function waitImage(base, promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { ok, body } = await readJson(`${base}/history/${promptId}`, 8000);
    const item = ok && body ? body[promptId] : null;
    if (item?.status?.completed || item?.status?.status_str === 'error') return item;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await cancelPrompt(base, promptId);
  return null;
}

function keepRecent(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(12)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* 删不掉不影响发送 */ }
  }
}

/** 只生成文件，不发到聊天。QQ 空间和看图工具共用这一次，避免两张图同时上显卡。 */
export async function generateStill({ prompt, width, height } = {}) {
  const c = cfg();
  if (c.enabled === false) return { ok: false, error: '本地生图已经关掉。' };
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (text.length < 2) return { ok: false, error: 'prompt 太短。请写清要画的主体、动作和场景。' };
  if (drawing) return { ok: false, error: '上一张还在画。' };
  const base = baseOf(c);
  const w = snap(width, c.width);
  const h = snap(height, c.height);
  const seed = Math.floor(Math.random() * 2147483647);
  const timeoutMs = Math.max(20000, Math.min(300000, Number(c.timeoutMs) || DEFAULTS.timeoutMs));
  drawing = true;
  try {
    let alive;
    try {
      alive = await readJson(`${base}/system_stats`, 4000);
    } catch (error) {
      return { ok: false, error: `ComfyUI 没连上（${base}）：${error?.message ?? error}` };
    }
    if (!alive.ok) return { ok: false, error: `ComfyUI 没有在 ${base} 响应（HTTP ${alive.status}）。` };

    const workflow = buildWorkflow(c, text, w, h, seed);
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'qq-agent-comfy-draw' }),
      signal: AbortSignal.timeout(20000)
    });
    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw: raw.slice(0, 500) }; }
    if (!res.ok || !body?.prompt_id) {
      const why = body?.error?.message || body?.node_errors || body?.raw || `HTTP ${res.status}`;
      return { ok: false, error: `生图没有排上队：${typeof why === 'string' ? why : JSON.stringify(why).slice(0, 400)}` };
    }
    if (body.node_errors && Object.keys(body.node_errors).length) {
      return { ok: false, error: `工作流有节点错误：${JSON.stringify(body.node_errors).slice(0, 400)}` };
    }
    log(`开始生图 ${w}x${h} seed=${seed}`);
    const item = await waitImage(base, body.prompt_id, timeoutMs);
    if (!item) return { ok: false, error: '画画超时了，这一次已经撤掉。' };
    if (item.status?.status_str === 'error' || item.status?.completed === false) {
      return { ok: false, error: `画画失败：${errorText(item, 'ComfyUI 返回错误')}` };
    }
    const image = firstImage(item);
    if (!image) return { ok: false, error: '队列跑完了，但没有拿到图片。' };
    const view = new URL(`${base}/view`);
    view.searchParams.set('filename', image.filename);
    view.searchParams.set('subfolder', image.subfolder || '');
    view.searchParams.set('type', image.type || 'output');
    const imgRes = await fetch(view, { signal: AbortSignal.timeout(20000) });
    if (!imgRes.ok) return { ok: false, error: `图生成了，但下载失败（HTTP ${imgRes.status}）。` };
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    if (bytes.length < 32) return { ok: false, error: '下载到的图片是空的。' };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const saved = path.join(OUT_DIR, `${Date.now()}.png`);
    fs.writeFileSync(saved, bytes);
    try { keepRecent(OUT_DIR); } catch { /* 清理失败不影响使用 */ }
    log(`生图完成 ${Math.round(bytes.length / 1024)}KB`);
    return { ok: true, file: saved, width: w, height: h };
  } catch (error) {
    return { ok: false, error: `生图失败：${error?.message ?? error}` };
  } finally {
    drawing = false;
  }
}

export function promptSections() {
  const c = cfg();
  if (c.enabled === false) return [];
  return [{
    id: 'comfy-draw',
    title: '本地生图',
    priority: 60,
    content: [
      `对方明确让你画画、画一张、按描述出图时，调用 ${TOOL}。`,
      'prompt 写看得见的画面：主体、动作、场景、颜色、构图。中文或英文都可以。不要写好不好看这类评价。',
      '图会直接发到当前聊天。一次要求只画一张，不要连着再调一次。不要再调用 send_image 或 search_images 去找一张替代，也不要说“已发送”。想配话就另发一句短的。',
      '没人要求你画的时候不要调用。同一个群员默认五分钟只能画一张，群主不限；到了上限就用一句短的让他们再等等。Comfy 没开时工具会自己提醒群主，不要再复述那句提醒，也不要假装已经画了。'
    ].join('')
  }];
}

function timedOut(msg) {
  return /超时|timeout|abort/i.test(String(msg || ''));
}

/** 发送超时后看群里是不是已经有这张图，避免重发变成两张。 */
async function alreadyInChat(ctx, sinceMs) {
  const onebot = ctx?.onebot;
  const [kind, id] = String(ctx?.chatKey || '').split(':');
  const selfId = String(ctx?.selfId || onebot?.selfId || '');
  if (!onebot?.call || !selfId || (kind !== 'group' && kind !== 'private')) return null;
  try {
    const data = kind === 'group'
      ? await onebot.call('get_group_msg_history', { group_id: Number(id), count: 8 }, 8000)
      : await onebot.call('get_friend_msg_history', { user_id: Number(id), count: 8 }, 8000);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const sinceSec = Math.floor(sinceMs / 1000) - 3;
    for (const msg of messages) {
      const uid = String(msg?.user_id ?? msg?.sender?.user_id ?? '');
      if (uid !== selfId) continue;
      const rawTime = Number(msg?.time || 0);
      const sec = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime;
      if (!sec || sec < sinceSec) continue;
      const segs = Array.isArray(msg?.message) ? msg.message : [];
      const raw = typeof msg?.raw_message === 'string' ? msg.raw_message : '';
      if (segs.some((s) => s?.type === 'image') || /\[CQ:image|\[图片\]/.test(raw)) {
        return { message_id: msg.message_id ?? null };
      }
    }
  } catch { /* 查不到就当真的没发出去 */ }
  return null;
}

function sentOk(ctx, width, height, messageId, started) {
  if (ctx.session?.sent) {
    ctx.session.sent.push({
      type: 'image',
      text: '[图片]',
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
  }
  ctx.emit?.('session-update', ctx.session?.id);
  log(`已发图，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
  return {
    content: `图已经发到当前聊天（${width}×${height}，消息 id ${messageId ?? '未知'}）。不要再调用 send_image，不要再画一次，不要说已发送。想配话就另发一句短的。`
  };
}

async function sendDrawn(ctx, args, saved, width, height, started) {
  const bytes = fs.readFileSync(saved);
  if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') {
    return { content: '图已经生成，但当前会话发不出去。', isError: true };
  }
  let lastMsg = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const began = Date.now();
    try {
      const sent = await ctx.sender.sendImage(ctx.chatKey, {
        file: saved,
        dataUrl: `base64://${bytes.toString('base64')}`
      }, {
        replyToMessageId: args?.replyToMessageId ?? null
      });
      return sentOk(ctx, width, height, sent?.message_id, started);
    } catch (error) {
      lastMsg = String(error?.message ?? error);
      if (/刚刚发过|已跳过/.test(lastMsg)) {
        return { content: '这张图刚刚已经发到当前聊天了。不要再画，不要再说已发送。' };
      }
      const found = await alreadyInChat(ctx, began);
      if (found) return sentOk(ctx, width, height, found.message_id, started);
      if (!timedOut(lastMsg) || attempt === 1) break;
      log('发图超时，自动再发一次');
    }
  }
  return {
    content: `图已经生成，但发送失败：${lastMsg}。已经自动重发过了。不要叫对方再喊一次。`,
    isError: true
  };
}

export function setup(api) {
  cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  log = typeof api.log === 'function' ? api.log : () => {};
  api.registerTool({
    id: 'draw_image',
    name: '本地画画',
    category: 'media',
    icon: '🎨',
    description: '用本机 ComfyUI 按描述生成一张图，并直接发到当前聊天。对方明确要求画画、画一张、生成图片时用。搜网上现成的图仍用 search_images，不要用这个代替。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述。写清主体、动作、场景、颜色、构图。不要写评价。'
        },
        width: { type: 'integer', description: '可选。宽度，512 到 1024，默认用设置里的值。' },
        height: { type: 'integer', description: '可选。高度，512 到 1024，默认用设置里的值。' },
        replyToMessageId: {
          type: ['integer', 'string'],
          description: '可选。引用提出画画的那条消息的 #数字。'
        }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      const started = Date.now();
      const prompt = String(args?.prompt || '');
      const chatKey = String(ctx?.chatKey || '');
      const prev = recentByChat.get(chatKey);
      if (prev && Date.now() - prev.at < RECENT_MS && sameRequest(prev.prompt, prompt)) {
        if (prev.sent) {
          return { content: '这张图刚刚已经发到当前聊天了。不要再画，不要再说已发送。' };
        }
        if (prev.file && fs.existsSync(prev.file)) {
          const again = await sendDrawn(ctx, args, prev.file, prev.width, prev.height, started);
          if (!again.isError) recentByChat.set(chatKey, { ...prev, sent: true, at: Date.now() });
          return again;
        }
      }
      const up = await comfyReady();
      if (!up.ok && up.down) {
        const told = await remindDraw(ctx);
        return {
          content: told
            ? 'Comfy 没开。已经在聊天里卖萌提醒群主去打开了。不要再画，也不要再复述这句提醒。'
            : 'Comfy 没开，刚才已经提醒过群主了。不要再画，也不要再提醒。',
          isError: true
        };
      }
      if (!up.ok) return { content: `${up.error} 不要假装已经画了。`, isError: true };
      const hold = await quotaHold(ctx);
      if (typeof hold === 'string') return { content: hold, isError: true };
      let made = await generateStill({ prompt, width: args?.width, height: args?.height });
      if (!made.ok && timedOut(made.error)) {
        log('画画超时，自动再画一次');
        made = await generateStill({ prompt, width: args?.width, height: args?.height });
      }
      if (!made.ok) {
        const extra = timedOut(made.error) ? '已经自动重画过了。不要叫对方再喊一次。' : '不要假装已经画了。';
        return { content: `${made.error} ${extra}`, isError: true };
      }
      if (hold?.key) drawQuota.set(hold.key, Date.now());
      recentByChat.set(chatKey, {
        at: Date.now(),
        prompt,
        file: made.file,
        width: made.width,
        height: made.height,
        sent: false
      });
      const sent = await sendDrawn(ctx, args, made.file, made.width, made.height, started);
      if (!sent.isError) {
        const cur = recentByChat.get(chatKey);
        if (cur) recentByChat.set(chatKey, { ...cur, sent: true, at: Date.now() });
      }
      return sent;
    }
  });
}

export const providers = {
  'image.generate': (args) => generateStill(args)
};
