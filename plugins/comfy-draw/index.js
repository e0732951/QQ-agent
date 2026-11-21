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
  timeoutMs: 180000
};

let cfgOf = () => ({});
let log = () => {};
let drawing = false;

function cfg() {
  const raw = cfgOf() || {};
  return { ...DEFAULTS, ...raw };
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
      '图会直接发到当前聊天。不要再调用 send_image 或 search_images 去找一张替代，也不要说“已发送”。想配话就另发一句短的。',
      '没人要求你画的时候不要调用。ComfyUI 没开或正在画上一张时，工具会告诉你失败原因，照实说，不要假装已经画了。'
    ].join('')
  }];
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
      const made = await generateStill({ prompt: args?.prompt, width: args?.width, height: args?.height });
      if (!made.ok) return { content: `${made.error} 不要假装已经画了。`, isError: true };
      const saved = made.file;
      const bytes = fs.readFileSync(saved);
      try {
        if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') {
          return { content: '图已经生成，但当前会话发不出去。', isError: true };
        }
        const sent = await ctx.sender.sendImage(ctx.chatKey, {
          file: saved,
          dataUrl: `base64://${bytes.toString('base64')}`
        }, {
          replyToMessageId: args?.replyToMessageId ?? null
        });
        if (ctx.session?.sent) {
          ctx.session.sent.push({
            type: 'image',
            text: '[图片]',
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
        }
        ctx.emit?.('session-update', ctx.session?.id);
        log(`已发图 ${Math.round(bytes.length / 1024)}KB，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
        return {
          content: `图已经发到当前聊天（${made.width}×${made.height}，消息 id ${sent?.message_id ?? '未知'}）。不要再调用 send_image，不要说已发送。想配话就另发一句短的。`
        };
      } catch (error) {
        return { content: `图已经生成，但发送失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export const providers = {
  'image.generate': (args) => generateStill(args)
};
