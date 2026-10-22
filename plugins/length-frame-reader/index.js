// plugins/length-frame-reader/index.js
//
// 按时长抽帧，给模型看动图和视频。
//   · video.frames / video.frames.available：src/video-reader.js 在「抽帧」路线上调用
//   · image.animated-frames：看图工具把 GIF / 动态 WebP 换成一组静帧
// 帧数只跟片长有关，调用方如果指定了 count 就按它抽（仍受上限约束）。

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
  return {
    ffmpegDir: String(c.ffmpegDir ?? '').trim(),
    maxFrames: num('maxFrames', 12, 1, 16),
    maxEdge: num('maxEdge', 480, 160, 1280),
    jpegQuality: num('jpegQuality', 5, 2, 12),
    timeoutMs: num('timeoutMs', 60000, 5000, 180000)
  };
}

/** 片长 → 帧数。短表情少抽，长视频均匀多抽，到顶为止。 */
export function framesForDuration(durationSec, maxFrames = 12) {
  const cap = Math.max(1, Math.min(16, Number(maxFrames) || 12));
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return Math.min(4, cap);
  let n = 2;
  if (d > 1.2) n = 4;
  if (d > 3) n = 6;
  if (d > 8) n = 8;
  if (d > 20) n = 10;
  if (d > 60) n = 12;
  return Math.min(n, cap);
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
  const n = count > 0 ? Math.min(s.maxFrames, Math.max(1, Math.round(Number(count)))) : framesForDuration(duration, s.maxFrames);
  const fps = duration > 0.05 ? (n / duration) : 2;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-frames-'));
  const pattern = path.join(dir, 'f_%02d.jpg');
  const loopOnce = /\.(gif|webp)$/i.test(file);
  try {
    await run(bin('ffmpeg'), [
      '-y',
      ...(loopOnce ? ['-ignore_loop', '1'] : []),
      '-i', file,
      '-vf', `fps=${fps.toFixed(4)},scale='min(${s.maxEdge},iw)':-2`,
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
    content: 'GIF、动态 WebP 和视频会按时长抽成几张静帧给你看，时间点写在说明里。把它们按先后顺序理解成一段动作，不要说自己看不到动图或视频。帧与帧之间的过程你看不到。'
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

export const internals = { framesForDuration, extractFile, isAnimatedBuffer };
