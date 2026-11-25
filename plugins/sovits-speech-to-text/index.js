// plugins/sovits-speech-to-text/index.js
//
// 语音回复的反向：别人发来的 QQ 语音 → GPT-SoVITS 自带的中文 FunASR → 文字。
// 核心在 segmentsToText 里对 record 段调用 media.transcribe；没有这个能力时
// 语音只显示成 [语音]。这里提供那个能力，失败一律返回 ok:false，核心退回占位，
// 消息不会因为识别出错而丢失。

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const ID = 'sovits-speech-to-text';
const WORK_DIR = path.join(DATA_DIR, ID, 'inbox');
const RUN_LOG = path.join(DATA_DIR, ID, 'runtime.log');
const DEFAULT_API = 'http://127.0.0.1:9881';

const G = (globalThis.__sovitsSpeechToText = globalThis.__sovitsSpeechToText || {
  cfgOf: null,
  log: null,
  warn: null,
  server: { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' }
});
if (!G.server) G.server = { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' };

const errText = (e) => String(e?.message ?? e);

function rtLog(tag, message) {
  try {
    fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(RUN_LOG, `${stamp} [${tag}] ${message}\n`, 'utf8');
  } catch { /* 日志不能弄坏收消息 */ }
}

function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const str = (k, d = '') => {
    const v = c[k];
    return (v === undefined || v === null) ? d : String(v).trim();
  };
  const device = str('device', 'auto');
  return {
    asrUrl: (str('asrUrl', DEFAULT_API) || DEFAULT_API).replace(/\/+$/, ''),
    autoStartApi: c.autoStartApi !== false,
    pythonPath: str('pythonPath'),
    apiWorkDir: str('apiWorkDir'),
    device: ['auto', 'cuda', 'cpu'].includes(device) ? device : 'auto',
    timeoutMs: Math.min(180000, Math.max(5000, Number(c.timeoutMs) || 90000)),
    apiStartTimeoutMs: Math.min(600000, Math.max(10000, Number(c.apiStartTimeoutMs) || 180000))
  };
}

function readiness() {
  const s = settings();
  try {
    const url = new URL(s.asrUrl);
    if (!url.hostname) return { ok: false, reason: '识别服务地址没有主机名' };
  } catch {
    return { ok: false, reason: `识别服务地址无效：${s.asrUrl}` };
  }
  return { ok: true, reason: '' };
}

function probePort(c, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(c.asrUrl); } catch { return resolve(false); }
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(Number(url.port || 80), url.hostname || '127.0.0.1'); } catch { finish(false); }
  });
}

async function fetchJson(url, options, timeoutMs) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text().catch(() => '');
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function ensureServer(c) {
  const up = await probePort(c);
  G.server.ok = up;
  G.server.at = Date.now();
  if (up) {
    G.server.lastError = '';
    return { ok: true };
  }
  const error = '识别服务没在运行。它由 comfy-dafeiyu 启动，请先打开那个项目。';
  G.server.lastError = error;
  return { ok: false, error };
}

function decodeFileUrl(value) {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('file:')) return '';
  try {
    const u = new URL(raw);
    let p = decodeURIComponent(u.pathname || '');
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return '';
  }
}

async function writeBase64(b64, ext) {
  const clean = String(b64 || '').replace(/^base64:\/\//, '').replace(/\s/g, '');
  if (clean.length < 32) return '';
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  await fsp.writeFile(file, Buffer.from(clean, 'base64'));
  return file;
}

async function downloadUrl(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`下载语音 HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 64) throw new Error('下载到的语音是空的');
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const ext = (path.extname(new URL(url).pathname) || '.bin').replace(/[^.a-z0-9]/gi, '') || '.bin';
  const file = path.join(WORK_DIR, `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  await fsp.writeFile(file, buf);
  return file;
}

async function savePayload(data, fallbackExt = 'wav') {
  if (!data || typeof data !== 'object') return '';
  const b64 = data.base64 || data.file_base64;
  if (b64) return writeBase64(b64, fallbackExt);
  const file = String(data.file || data.path || '').trim();
  if (file.startsWith('base64://') || /^[A-Za-z0-9+/=\s]{256,}$/.test(file)) return writeBase64(file, fallbackExt);
  const local = decodeFileUrl(file) || file;
  if (local && !local.includes('://') && fs.existsSync(local)) return local;
  const url = String(data.url || '');
  if (url.startsWith('http://') || url.startsWith('https://')) return downloadUrl(url);
  if (url.startsWith('file:')) {
    const p = decodeFileUrl(url);
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

function audioKind(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return '';
  }
  const head = buf.toString('latin1');
  if (head.startsWith('RIFF')) return 'wav';
  if (head.includes('#!SILK')) return 'silk';
  if (head.startsWith('#!AMR')) return 'amr';
  if (head.startsWith('OggS')) return 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  return 'unknown';
}

/** FunASR / ffmpeg 能直接读的格式。QQ 的 .amr 链接经常是 SILK，不在此列。 */
function isDecodable(file) {
  return ['wav', 'mp3', 'ogg', 'flac', 'amr', 'm4a'].includes(audioKind(file));
}

function dropOwned(file) {
  if (file && file.startsWith(WORK_DIR)) {
    try { fs.unlinkSync(file); } catch { /* 留给下次 */ }
  }
}

async function materialize(record, onebot) {
  // 消息段里的 url 往往是 SILK（文件名却叫 .amr），ffmpeg 解不开。
  // 协议端的 get_record(out_format=wav) 会转成真正的 wav，优先用它。
  const id = String(record?.file || record?.file_id || '').trim();
  const fileId = id && !id.startsWith('base64://') && !/^[A-Za-z0-9+/=\s]{256,}$/.test(id);
  if (onebot && fileId && typeof onebot.call === 'function') {
    try {
      const data = await onebot.call('get_record', { file: id, file_id: id, out_format: 'wav' }, 30000);
      const saved = await savePayload(data, 'wav');
      if (saved && isDecodable(saved)) return { file: saved, owned: saved.startsWith(WORK_DIR) };
      dropOwned(saved);
    } catch (error) {
      rtLog('取语音', errText(error));
    }
  }

  const direct = await savePayload(record, 'bin');
  if (direct && isDecodable(direct)) return { file: direct, owned: direct.startsWith(WORK_DIR) };
  if (direct && audioKind(direct) === 'silk') {
    dropOwned(direct);
    throw new Error('语音是 SILK，协议端没有转成 wav');
  }
  if (direct) return { file: direct, owned: direct.startsWith(WORK_DIR) };
  return { file: '', owned: false };
}

async function transcribeFile(c, file) {
  const body = await fetchJson(`${c.asrUrl}/asr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file })
  }, c.timeoutMs);
  return String(body.text || '').trim();
}

const LINES_FILE = path.join(DATA_DIR, ID, 'video-lines.json');
const LINE_CAP_SEC = 15 * 60;

function ffmpegBin() {
  const known = 'D:\\modules\\ffmpeg-2026-06-10-git-b29bdd3715-essentials_build\\bin\\ffmpeg.exe';
  if (fs.existsSync(known)) return known;
  return 'ffmpeg';
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegBin(), args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 超时停掉 */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

function lineKeys(media, filePath) {
  const keys = [];
  const bvid = String(media?.bvid || '').trim();
  const aid = String(media?.aid || '').replace(/^av/i, '').trim();
  const page = String(media?.pageUrl || '').trim();
  const file = String(media?.file || '').trim();
  if (bvid) keys.push(bvid, `bv:${bvid}`);
  if (aid) keys.push(`av${aid}`, `av:${aid}`);
  if (page) {
    const hash = crypto.createHash('sha1').update(page).digest('hex').slice(0, 16);
    keys.push(`url:${hash}`, `url_${hash}`);
  }
  if (file) keys.push(`file:${file}`);
  if (!keys.length && filePath) keys.push(`path:${path.basename(String(filePath))}`);
  return keys;
}

function readLineStore() {
  try {
    const data = JSON.parse(fs.readFileSync(LINES_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* 还没有台词存档 */ }
  return {};
}

function savedLines(keys) {
  const data = readLineStore();
  for (const key of keys) {
    const text = String(data[key]?.text || '').trim();
    if (text) return text;
  }
  return '';
}

function writeLines(keys, text) {
  if (!keys.length || !text) return;
  const data = readLineStore();
  const item = { text, at: Date.now() };
  for (const key of keys) data[key] = item;
  fs.mkdirSync(path.dirname(LINES_FILE), { recursive: true });
  const tmp = `${LINES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, LINES_FILE);
}

function takePendingAudio(media) {
  const box = globalThis.__bilibiliQqVideo;
  const pending = box?.pendingAudio;
  if (!pending?.path || !fs.existsSync(pending.path)) return '';
  const page = String(media?.pageUrl || '');
  const bvid = String(media?.bvid || '');
  const aid = String(media?.aid || '');
  const bili = media?.source === 'bilibili-miniapp' || Boolean(bvid);
  const match = (page && pending.pageUrl === page)
    || (bvid && pending.bvid === bvid)
    || (aid && String(pending.aid) === aid)
    || (bili && Date.now() - Number(pending.at || 0) < 120000);
  if (!match) return null;
  box.pendingAudio = null;
  return pending;
}

async function toWav(src) {
  const dest = `${src}.${Date.now().toString(36)}.wav`;
  const ok = await runFfmpeg([
    '-y', '-i', src, '-t', String(LINE_CAP_SEC), '-vn', '-ac', '1', '-ar', '16000', dest
  ], 120000);
  if (!ok || !fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
    try { fs.unlinkSync(dest); } catch { /* 没有半截 */ }
    return '';
  }
  return dest;
}

async function transcribeVideo(file) {
  const c = settings();
  const body = await fetchJson(`${c.asrUrl}/asr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file })
  }, 180000);
  return String(body.text || '').trim();
}

/** 看视频时转写音轨。文字留下，本次下载或抽出的音频删掉。已有台词就不再下载。 */
async function transcriptOf({ media, filePath } = {}) {
  const keys = lineKeys(media, filePath);
  const saved = savedLines(keys);
  if (saved) return { text: saved };
  const owned = [];
  const pending = takePendingAudio(media);
  let src = pending?.path || '';
  if (pending?.bvid && !keys.includes(pending.bvid)) keys.push(pending.bvid);
  if (pending?.pageUrl) {
    const hash = crypto.createHash('sha1').update(String(pending.pageUrl)).digest('hex').slice(0, 16);
    if (!keys.includes(`url_${hash}`)) keys.push(`url_${hash}`);
  }
  if (src) owned.push(src);
  if (!src && filePath && fs.existsSync(String(filePath))) src = String(filePath);
  if (!src) return { text: '' };
  const wav = await toWav(src);
  if (!wav) {
    for (const f of owned) { try { fs.unlinkSync(f); } catch { /* 已经没了 */ } }
    return { text: '' };
  }
  owned.push(wav);
  let keepSource = false;
  try {
    const server = await ensureServer(settings());
    if (!server.ok) {
      keepSource = true;
      return { text: '' };
    }
    const text = await transcribeVideo(wav);
    const kept = text || '（没有听到人说话）';
    writeLines(keys, kept);
    rtLog('视频台词', kept.slice(0, 40));
    return { text: kept };
  } catch (error) {
    keepSource = true;
    rtLog('视频台词失败', errText(error));
    return { text: '' };
  } finally {
    for (const f of owned) {
      if (keepSource && f === src) continue;
      try { fs.unlinkSync(f); } catch { /* 音频用完即删 */ }
    }
  }
}

export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  G.log = (...a) => api.log?.(...a);
  G.warn = (...a) => (api.warn ?? api.log)?.(...a);
  const check = readiness();
  rtLog('加载', check.ok ? '已加载（识别服务由 comfy-dafeiyu 管理）' : `还没配好：${check.reason}`);
  if (check.ok) ensureServer(settings()).catch(() => {});
}

export function available() {
  return readiness();
}

export function activate() {
  const check = readiness();
  if (check.ok) ensureServer(settings()).catch(() => {});
}

export function deactivate() {
  // 识别服务跟着 comfy-dafeiyu 退出，不在这里关。
}

export function dispose() { /* 热重载由加载器处理 */ }

export function promptSections() {
  if (!readiness().ok) return [];
  return [{
    id: 'sovits-speech-to-text',
    title: '语音消息',
    priority: 35,
    content: '别人发来的语音如果已经识别出来，会写成「[语音转文字] 后面是原话」。把它当成对方亲口说的话来回应。识别可能有同音错字，意思清楚就按意思回，不要说自己听不到语音。只写着「[语音]」的才是没能识别的语音。看视频时结果里的「【视频台词】」是这段视频里说的话，转写完音频就删了，只留这段文字，和画面一起理解。写着「（没有听到人说话）」就是没有人声。超过 15 分钟只转写片头这一段。'
  }];
}

export const providers = {
  'media.transcribe': async ({ record, onebot } = {}) => {
    const check = readiness();
    if (!check.ok) return { ok: false, error: check.reason };
    let owned = '';
    try {
      const got = await materialize(record || {}, onebot);
      if (!got.file) return { ok: false, error: '拿不到语音文件' };
      if (got.owned) owned = got.file;
      const server = await ensureServer(settings());
      if (!server.ok) return { ok: false, error: server.error || '识别服务不可用' };
      const text = await transcribeFile(settings(), got.file);
      if (!text) return { ok: false, error: '没有识别到文字' };
      rtLog('识别', `${text.slice(0, 40)}`);
      return { ok: true, text };
    } catch (error) {
      const msg = errText(error);
      rtLog('失败', msg);
      return { ok: false, error: msg };
    } finally {
      if (owned) { try { await fsp.unlink(owned); } catch { /* 留给下次 */ } }
    }
  },
  'video.transcript': async (args = {}) => transcriptOf(args)
};
