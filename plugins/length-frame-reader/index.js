// plugins/length-frame-reader/index.js
//
// 按时长抽帧，给模型看动图和视频。
//   · video.frames / video.frames.available：src/video-reader.js 在「抽帧」路线上调用
//   · image.animated-frames：看图工具把 GIF / 动态 WebP 换成一组静帧
// 抽多少帧由「抽帧频率」和片长决定，调用方如果指定了 count 就按它抽（仍受上限约束）。
// 画面不超过 maxP（默认 1080p）时保持原尺寸。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const G = (globalThis.__lengthFrameReader = globalThis.__lengthFrameReader || { cfgOf: null });

function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const num = (k, d, lo, hi) => {
    const n = Number(c[k]);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  const fpsRaw = Number(c.sampleFps);
  const sampleFps = Number.isFinite(fpsRaw) ? Math.min(8, Math.max(0.1, Math.round(fpsRaw * 1000) / 1000)) : 2;
  return {
    ffmpegDir: String(c.ffmpegDir ?? '').trim(),
    sampleFps,
    maxFrames: num('maxFrames', 36, 1, 60),
    maxP: num('maxP', 1080, 240, 2160),
    jpegQuality: num('jpegQuality', 2, 1, 8),
    timeoutMs: num('timeoutMs', 60000, 5000, 180000)
  };
}

/**
 * 按抽帧频率决定张数。
 * 频率 × 时长没超过上限时，按这个频率从片头往后抽。
 * 超过上限时 spread 为 true：改为铺满整段，避免长视频只剩下开头。
 */
export function framesForRate(durationSec, sampleFps = 2, maxFrames = 36) {
  const cap = Math.max(1, Math.min(60, Math.round(Number(maxFrames) || 36)));
  const rate = Math.min(8, Math.max(0.1, Number(sampleFps) || 2));
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return { count: Math.min(4, cap), rate, spread: false };
  const raw = Math.max(1, Math.round(d * rate));
  return { count: Math.min(cap, raw), rate, spread: raw > cap };
}

/** 1080p → 横屏长边 1920、竖屏宽边 1080。比上限小的不放大。 */
export function fitScale(maxP) {
  const p = Math.max(240, Math.min(2160, Math.round(Number(maxP) || 1080)));
  const longCap = Math.round(p * 16 / 9 / 2) * 2;
  const shortCap = Math.round(p / 2) * 2;
  return `scale='trunc(min(if(gte(iw,ih),${longCap},${shortCap}),iw)/2)*2':-2:flags=lanczos`;
}

function bin(name) {
  const dir = settings().ffmpegDir;
  if (dir) {
    const direct = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(direct)) return direct;
    const nested = path.join(dir, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(nested)) return nested;
  }
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function ffmpegReady() {
  const file = bin('ffmpeg');
  if (path.isAbsolute(file)) return fs.existsSync(file);
  return true;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('抽帧超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(String(stderr || stdout || `退出码 ${code}`).slice(0, 400)));
    });
  });
}

function rateToFps(rate) {
  const [num, den] = String(rate || '').split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) return 0;
  return num / den;
}

async function probeDuration(file) {
  try {
    const out = await run(bin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration:stream=duration', '-of', 'json', file
    ], 15000);
    const parsed = JSON.parse(out);
    const candidates = [
      Number(parsed?.format?.duration),
      ...(Array.isArray(parsed?.streams) ? parsed.streams.map((s) => Number(s?.duration)) : [])
    ];
    const known = candidates.find((n) => Number.isFinite(n) && n > 0);
    if (known) return known;
  } catch { /* 下面用逐帧计数补 */ }
  // 动态 WebP 经常不写时长。只对动图逐帧数，避免长视频被整段解码。
  if (!/\.(gif|webp)$/i.test(file)) return 0;
  try {
    const out = await run(bin('ffprobe'), [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames,avg_frame_rate', '-of', 'json', file
    ], 20000);
    const stream = JSON.parse(out)?.streams?.[0] || {};
    const frames = Number(stream.nb_read_frames);
    const fps = rateToFps(stream.avg_frame_rate);
    if (frames > 0 && fps > 0) return frames / fps;
  } catch { /* 时长未知时按短片抽 */ }
  return 0;
}

function isAnimatedBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const gif = buf.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return true;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  const at = buf.indexOf('VP8X');
  return at >= 0 && buf.length > at + 8 && (buf[at + 8] & 0x02) !== 0;
}

async function extractFile(file, { count, durationSec } = {}) {
  const s = settings();
  if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' };
  const duration = Number(durationSec) > 0 ? Number(durationSec) : await probeDuration(file);
  const planned = framesForRate(duration, s.sampleFps, s.maxFrames);
  const n = count > 0 ? Math.min(s.maxFrames, Math.max(1, Math.round(Number(count)))) : planned.count;
  // 指定了张数，或张数被上限截断时，均匀铺满整段；否则严格按设定频率从片头抽。
  const fps = duration > 0.05 && (count > 0 || planned.spread) ? (n / duration) : planned.rate;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-frames-'));
  const pattern = path.join(dir, 'f_%02d.jpg');
  const loopOnce = /\.(gif|webp)$/i.test(file);
  try {
    await run(bin('ffmpeg'), [
      '-y',
      ...(loopOnce ? ['-ignore_loop', '1'] : []),
      '-i', file,
      '-vf', `fps=${fps.toFixed(4)},${fitScale(s.maxP)}`,
      '-frames:v', String(n),
      '-q:v', String(s.jpegQuality),
      pattern
    ], s.timeoutMs);
    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).sort();
    if (!names.length) return { ok: false, error: '没有抽出画面' };
    const frames = names.map((name) => {
      const bytes = fs.readFileSync(path.join(dir, name));
      return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    });
    const times = frames.map((_, i) => Number((duration > 0 ? ((i + 0.5) / frames.length) * duration : i / Math.max(fps, 0.001)).toFixed(2)));
    return { ok: true, frames, times, durationSec: Number(duration.toFixed(2)) || 0 };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function extractBuffer(buffer, options) {
  if (!isAnimatedBuffer(buffer)) return { ok: false, skip: true };
  const gif = buffer.toString('ascii', 0, 6).startsWith('GIF');
  const tmp = path.join(os.tmpdir(), `qqa-anim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${gif ? 'gif' : 'webp'}`);
  fs.writeFileSync(tmp, buffer);
  try {
    return await extractFile(tmp, options);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
}

export function available() {
  if (!ffmpegReady()) return { ok: false, reason: `找不到 ffmpeg：${settings().ffmpegDir || '(未设置目录，且不在 PATH)'}` };
  return { ok: true };
}

export function promptSections() {
  if (!available().ok) return [];
  return [{
    id: 'length-frame-reader',
    title: '动图和视频',
    priority: 34,
    content: 'GIF、动态 WebP 和视频会按设定频率抽成几张静帧给你看，时间点写在说明里。画面是原清晰度（超过上限才会缩小）。把它们按先后顺序理解成一段动作，不要说自己看不到动图或视频。帧与帧之间的过程你看不到。'
  }];
}

export const providers = {
  'video.frames.available': async () => (ffmpegReady() ? { ok: true } : { ok: false, reason: '找不到 ffmpeg' }),
  'video.frames': async ({ filePath, count, durationSec } = {}) => {
    const r = await extractFile(String(filePath || ''), { count, durationSec });
    if (!r.ok) return { frames: [], times: [], error: r.error || '抽帧失败' };
    return { frames: r.frames, times: r.times, durationSec: r.durationSec };
  },
  'image.animated-frames': async ({ buffer, count, durationSec } = {}) => {
    const buf = Buffer.isBuffer(buffer) ? buffer : null;
    if (!buf) return { ok: false, skip: true };
    return extractBuffer(buf, { count, durationSec });
  }
};

export const internals = { framesForRate, fitScale, extractFile, isAnimatedBuffer };
