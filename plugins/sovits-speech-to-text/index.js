// plugins/sovits-speech-to-text/index.js
//
// 语音回复的反向：别人发来的 QQ 语音 → GPT-SoVITS 自带的中文 FunASR → 文字。
// 核心在 segmentsToText 里对 record 段调用 media.transcribe；没有这个能力时
// 语音只显示成 [语音]。这里提供那个能力，失败一律返回 ok:false，核心退回占位，
// 消息不会因为识别出错而丢失。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';

const ID = 'sovits-speech-to-text';
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASR_SCRIPT = path.join(PLUGIN_DIR, 'asr_server.py');
const WORK_DIR = path.join(DATA_DIR, ID, 'inbox');
const RUN_LOG = path.join(DATA_DIR, ID, 'runtime.log');
const API_LOG = path.join(DATA_DIR, ID, 'asr-server.log');
const DEFAULT_API = 'http://127.0.0.1:9881';

const MODELS = {
  asr: 'tools/asr/models/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
  vad: 'tools/asr/models/speech_fsmn_vad_zh-cn-16k-common-pytorch'
};

const G = (globalThis.__sovitsSpeechToText = globalThis.__sovitsSpeechToText || {
  cfgOf: null,
  log: null,
  warn: null,
  server: { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' }
});
if (!G.server) G.server = { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function modelPaths(workDir) {
  return {
    asr: path.join(workDir, MODELS.asr),
    vad: path.join(workDir, MODELS.vad),
    punc: path.join(workDir, MODELS.punc)
  };
}

function readiness() {
  const s = settings();
  if (!s.pythonPath || !fs.existsSync(s.pythonPath)) return { ok: false, reason: `找不到 python：${s.pythonPath || '(未设置)'}` };
  if (!fs.existsSync(ASR_SCRIPT)) return { ok: false, reason: '找不到 asr_server.py' };
  if (!s.apiWorkDir || !fs.existsSync(s.apiWorkDir)) return { ok: false, reason: `找不到 GPT-SoVITS 根目录：${s.apiWorkDir || '(未设置)'}` };
  const models = modelPaths(s.apiWorkDir);
  for (const [name, file] of Object.entries(models)) {
    if (!fs.existsSync(path.join(file, 'model.pt'))) return { ok: false, reason: `找不到${name}模型：${file}` };
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

function startServer(c) {
  G.server.starting = (async () => {
    G.server.lastTryAt = Date.now();
    G.server.attempts += 1;
    let fd = null;
    try {
      const check = readiness();
      if (!check.ok) throw new Error(check.reason);
      const url = new URL(c.asrUrl);
      const models = modelPaths(c.apiWorkDir);
      fs.mkdirSync(path.dirname(API_LOG), { recursive: true });
      fd = fs.openSync(API_LOG, 'a');
      const child = spawn(c.pythonPath, ['-u', '-s', ASR_SCRIPT], {
        cwd: c.apiWorkDir,
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          ASR_HOST: url.hostname || '127.0.0.1',
          ASR_PORT: String(url.port || '9881'),
          ASR_DEVICE: c.device,
          ASR_WORKDIR: c.apiWorkDir,
          ASR_MODEL: models.asr,
          ASR_VAD: models.vad
        },
        stdio: ['ignore', fd, fd]
      });
      child.unref();
      rtLog('启动', `已拉起识别服务（pid ${child.pid}）`);
      const deadline = Date.now() + c.apiStartTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(1500);
        if (await probePort(c, 800)) {
          G.server.ok = true;
          G.server.at = Date.now();
          G.server.attempts = 0;
          G.server.lastError = '';
          rtLog('启动', `识别服务已就绪（用了约 ${Math.round((Date.now() - G.server.lastTryAt) / 1000)} 秒）`);
          return { ok: true };
        }
      }
      throw new Error(`等了 ${Math.round(c.apiStartTimeoutMs / 1000)} 秒识别服务还没起来，看 ${API_LOG}`);
    } catch (error) {
      const msg = errText(error);
      G.server.ok = false;
      G.server.lastError = msg;
      rtLog('启动失败', msg);
      try { G.warn?.(msg); } catch { /* ignore */ }
      return { ok: false, error: msg };
    } finally {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* 子进程已拿到句柄 */ }
      G.server.starting = null;
    }
  })();
  return G.server.starting;
}

async function ensureServer(c) {
  if (G.server.starting) return G.server.starting;
  const up = await probePort(c);
  G.server.ok = up;
  G.server.at = Date.now();
  if (up) return { ok: true };
  if (!c.autoStartApi) return { ok: false, error: '识别服务没在运行（自动启动是关的）' };
  const backoff = [60000, 300000, 900000][Math.min(G.server.attempts, 2)];
  const waited = Date.now() - G.server.lastTryAt;
  if (G.server.attempts > 0 && waited < backoff) {
    const left = Math.ceil((backoff - waited) / 1000);
    return { ok: false, error: `上次启动失败（${G.server.lastError || '见 asr-server.log'}），${left} 秒后再试` };
  }
  return startServer(c);
}

function isLocal(c) {
  try {
    const h = String(new URL(c.asrUrl).hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

async function stopServer(c) {
  if (!isLocal(c)) return;
  if (!(await probePort(c, 800))) { G.server.ok = false; return; }
  try { await fetchJson(`${c.asrUrl}/control?command=exit`, {}, 8000); } catch { /* 进程先退出时连接会被重置 */ }
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (!(await probePort(c, 400))) {
      G.server.ok = false;
      G.server.attempts = 0;
      G.server.lastError = '';
      rtLog('停止', '识别服务已退出');
      return;
    }
  }
  rtLog('停止', '发了退出指令，但端口还在');
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

async function materialize(record, onebot) {
  const direct = await savePayload(record, 'bin');
  if (direct && fs.existsSync(direct) && fs.statSync(direct).size > 64) return { file: direct, owned: direct.startsWith(WORK_DIR) };

  const id = String(record?.file || record?.file_id || '').trim();
  if (onebot && id && typeof onebot.call === 'function') {
    const data = await onebot.call('get_record', { file: id, file_id: id, out_format: 'wav' }, 30000);
    const saved = await savePayload(data, 'wav');
    if (saved) return { file: saved, owned: saved.startsWith(WORK_DIR) };
  }
  const url = String(record?.url || '');
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const saved = await downloadUrl(url);
    return { file: saved, owned: true };
  }
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

export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  G.log = (...a) => api.log?.(...a);
  G.warn = (...a) => (api.warn ?? api.log)?.(...a);
  const check = readiness();
  rtLog('加载', check.ok ? '已加载' : `还没配好：${check.reason}`);
  if (check.ok && settings().autoStartApi) ensureServer(settings()).catch(() => {});
}

export function available() {
  const check = readiness();
  if (check.ok && settings().autoStartApi && !G.server.ok && !G.server.starting) {
    ensureServer(settings()).catch(() => {});
  }
  return check;
}

export function activate() {
  const check = readiness();
  if (check.ok && settings().autoStartApi) ensureServer(settings()).catch(() => {});
}

export function deactivate(ctx = {}) {
  if (ctx && ctx.reason === 'reload') return;
  stopServer(settings()).catch(() => {});
}

export function dispose() { /* 热重载由加载器处理 */ }

export function promptSections() {
  if (!readiness().ok) return [];
  return [{
    id: 'sovits-speech-to-text',
    title: '语音消息',
    priority: 35,
    content: '别人发来的语音如果已经识别出来，会写成「[语音转文字] 后面是原话」。把它当成对方亲口说的话来回应。识别可能有同音错字，意思清楚就按意思回，不要说自己听不到语音。只写着「[语音]」的才是没能识别的语音。'
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
  }
};
