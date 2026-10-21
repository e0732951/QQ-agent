// plugins/sovits-voice-reply/index.js
//
// 用本机 GPT-SoVITS 里你自己训练/配置的音色，把机器人「要发出去的文字」变成 QQ 原生语音。
//
// ── 为什么是插件（plugins/）而不是技能（skills/）────────────────────────────
// 规则完全写死：要发送的这句文字 → 用我的音色念出来 → 发语音。
// 不需要模型理解人话、也不需要模型判断"什么时候该用语音" → **确定性型** → plugins/。
// 零 token：不注册工具、不写提示词、不叫模型；只有"真正发送"的那一下变了。
//（反过来，"由机器人自己决定要不要说话"的那种是 skills/ 里的 LLM 型工具，
//  那是另一个东西——本项目里已经有的 mimo-tts 就是那一型。）
//
// ── 挂在哪一层（这是本插件最关键的实现决定）────────────────────────────────
// 核心没有给"外发文本"的 hook（orchestrator 只跑 before-context / before-llm-messages /
// after-response / before-tool / after-tool，都不在发送路径上）。而 sender.js 里
// **所有**文字最后都汇聚到 OneBotClient.prototype.sendText —— 这就是唯一的收口点，
// 所以只能"包一层"（同目录的 typo-sim 也是挂在这一层，理由相同）。
//
// 包在这一层而不是重写 sender.js 的队列逻辑，是因为：
//   · 调用它的 sender.js 已经把限频、去重做完了，我们返回的 message_id 也会被正常留档；
//   · 我们发 record 段用的还是 this.sendSegments —— 也就是 sendText 自己的实现，
//     没有绕过 sender.js 的发送管道（sender.js 里明确写了插件不得绕过 sendMedia 直接发段；
//     这里不是"插件自己另起一条发送路径"，而是"替 sendText 换了个段类型"）。
//
// ── 绝不丢消息 ────────────────────────────────────────────────────────────
// 配置不全 / 合成失败 / 发送失败 / 补丁里任何异常 → 一律回落成"照原样发文字"。
// 这个插件的底线是：最坏情况等于没装它，绝不会因为语音出问题而让机器人不说话。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../src/config.js';
import { OneBotClient } from '../../src/onebot.js';

const ID = 'sovits-voice-reply';
const DEFAULT_API = 'http://127.0.0.1:9880';
// 合成出来的临时语音放数据目录下（不要用系统 temp：容易被清理工具顺手删掉，
// 也看不到到底生成了什么）。路径与 fileTtlMinutes 都由设置控制。
const WORK_DIR = path.join(DATA_DIR, ID, 'voice');
// 插件自己的运行日志。
// ⚠️ 为什么必须自己写一份：插件的 api.log/api.warn 走的是 console，而核心的日志文件
//    只收核心自己的 logger，**不会**收插件打的东西。于是"接口没启动 → 合成失败 → 退回文字"
//    这种最需要排查的事，在项目日志里一个字都看不到，用户看到的就是"没反应"。
//    这个文件就是为了消灭这种静默失效。
const RUN_LOG = path.join(DATA_DIR, ID, 'runtime.log');
// 自动拉起的语音接口，它的输出也留档（起不来时全靠它看原因）
const API_LOG = path.join(DATA_DIR, ID, 'api-server.log');
const RUN_LOG_MAX = 512 * 1024;

// ── 共享状态挂在 globalThis 上 ────────────────────────────────────────────
// 热重载会给插件开一个**新的模块实例**。补丁（挂在原型上）和统计如果存在模块作用域里，
// 新实例看不见旧实例装过的补丁 → 再包一层 → 一条消息被处理两次、限频也失效。
// 挂 globalThis：无论换多少个实例，补丁只装一份、账只有一份。
// （同目录 typo-sim 的注释里记着这个坑，这里沿用同一套做法。）
const G = (globalThis.__sovitsVoiceReply = globalThis.__sovitsVoiceReply || {
  installed: false,
  original: null,      // 被我们包住的原始 sendText
  patched: null,       // 我们自己装上去的那一份（用于热重载时精确摘除，不误伤别人的补丁）
  cfgOf: null,         // api.config
  api: null,
  fetch: null,
  log: null,
  warn: null,
  applied: { gpt: '', sovits: '' },   // 已经通过 /set_*_weights 加载过的权重，避免每条都重设
  recent: [],          // 最近合成的时间戳（每分钟限频用）
  inFlight: 0,         // 正在合成几条（本地服务端扛不住并发）
  warned: new Map(),   // 同一句告警 60 秒内只写一次，别把日志刷爆
  // 语音接口（GPT-SoVITS 服务端）的运行状态
  server: { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' },
  stats: { converted: 0, cached: 0, failed: 0, skipped: 0, chars: 0, ms: 0, lastAt: 0, lastText: '', lastWhy: '' }
});
// 热重载时 G 是上一个模块实例留下的对象，可能没有后加的字段 —— 补齐，别让旧状态把自己绊倒
if (!G.server) G.server = { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' };
if (!G.stats) G.stats = { converted: 0, cached: 0, failed: 0, skipped: 0, chars: 0, ms: 0, lastAt: 0, lastText: '', lastWhy: '' };
if (!(G.warned instanceof Map)) G.warned = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 哪些设置算"用户动过手配了音色" —— 只填了其中任意一项，才认为这个插件在被使用。
// 用途见下面 rtLog：没配过的插件不该在硬盘上留下任何文件。
const CONFIG_KEYS = [
  'refAudioPath', 'promptText', 'sovitsWeightsPath', 'gptWeightsPath', 'configPath',
  'pythonPath', 'apiScriptPath', 'apiWorkDir'
];
function userConfigured() {
  try {
    const c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {};
    return CONFIG_KEYS.some((k) => String(c[k] ?? '').trim() !== '');
  } catch {
    return false;
  }
}

/**
 * 插件开关（config.skills[id].enabled）是不是开着的。
 *
 * ⚠️ 为什么自动启动必须看它：setup() 是**加载时**跑的，那时 Skill 还没注册进注册表，
 *    用不了 api.isSkillActive()；而 enabled 就存在同一份配置里，直接读最准。
 *    不看它的后果很反直觉：用户明明把插件关掉了，重启后语音接口还是被拉起来占着显存和端口。
 */
function skillEnabledByConfig() {
  try {
    const c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {};
    return c.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * 写一行自己的运行日志（绝不抛错 —— 日志坏掉不能反过来弄坏发送）。
 * 超过上限就截断重来，避免无限增长。
 *
 * ⚠️ 没配置过就**一个字都不写**：连 `data/sovits-voice-reply/` 这个目录都不会被创建。
 *    装上去但还没配（或者发给别人、对方还没填）的插件，不应该在硬盘上留任何痕迹。
 *    代价是"加载了但没配"这一段没有日志 —— 但那种情况插件页本来就会写明缺什么，
 *    不会变成查不出来的问题。
 */
function rtLog(tag, message) {
  if (!userConfigured()) return;
  try {
    fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
    try { if (fs.statSync(RUN_LOG).size > RUN_LOG_MAX) fs.writeFileSync(RUN_LOG, '', 'utf8'); } catch { /* 首次运行 */ }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(RUN_LOG, `${stamp} [${tag}] ${message}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

const log = (...a) => { try { (G.log || (() => {}))(...a); } catch { /* 日志不能反过来弄坏发送 */ } };
const warn = (...a) => { try { ((G.warn || G.log) || (() => {}))(...a); } catch { /* 同上 */ } };

/** 同一句告警最多每 60 秒写一次（发送路径每分钟可能被调用几十次）。 */
function warnOnce(message) {
  const key = String(message).slice(0, 80);
  const now = Date.now();
  if (now - (G.warned.get(key) || 0) < 60000) return;
  G.warned.set(key, now);
  if (G.warned.size > 60) {
    for (const [k, t] of G.warned) if (now - t > 300000) G.warned.delete(k);
  }
  warn(message);
}

const errText = (e) => String(e?.message ?? e);

/**
 * 同一条"跳过原因"最多每 5 分钟写一次运行日志。
 * 为什么需要：机器人每条消息都会走一遍判定，像"这条超过 60 字"这种原因
 * 一分钟能出现十几次，不节流的话日志会被它淹掉，真正的问题反而看不见。
 */
const rtThrottle = new Map();
function rtLogOnce(tag, reason, extra = '') {
  const key = `${tag}:${reason}`;
  const now = Date.now();
  if (now - (rtThrottle.get(key) || 0) < 300000) return;
  rtThrottle.set(key, now);
  if (rtThrottle.size > 80) {
    for (const [k, t] of rtThrottle) if (now - t > 600000) rtThrottle.delete(k);
  }
  rtLog(tag, extra ? `${reason}　${extra}` : reason);
}
const clampNum = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// ── 设置（manifest.settings 已由核心与用户配置合并好，这里只做归一化与兜底）──
function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const str = (k, d = '') => {
    const v = c[k];
    return (v === undefined || v === null) ? d : String(v).trim();
  };
  return {
    apiUrl: (str('apiUrl', DEFAULT_API) || DEFAULT_API).replace(/\/+$/, ''),
    configPath: str('configPath'),
    sovitsWeightsPath: str('sovitsWeightsPath'),
    gptWeightsPath: str('gptWeightsPath'),
    refAudioPath: str('refAudioPath'),
    promptText: str('promptText'),
    promptLang: str('promptLang', 'zh') || 'zh',
    textLang: str('textLang', 'auto') || 'auto',
    maxChars: clampNum(c.maxChars, 60, 1, 500),
    minChars: clampNum(c.minChars, 1, 1, 500),
    speedFactor: clampNum(c.speedFactor, 1, 0.5, 2),
    alsoSendText: c.alsoSendText === true,
    allowPrivate: c.allowPrivate !== false,
    skipChats: str('skipChats'),
    skipStructured: c.skipStructured !== false,
    maxPerMinute: clampNum(c.maxPerMinute, 10, 1, 120),
    timeoutMs: clampNum(c.timeoutMs, 180000, 5000, 600000),
    fileTtlMinutes: clampNum(c.fileTtlMinutes, 30, 1, 1440),
    // 发完就删（默认）：语音在协议端上传完，本地这份就没用了，留着只是占硬盘
    deleteAfterSend: c.deleteAfterSend !== false,
    pathStyle: str('pathStyle', 'file-url') === 'plain' ? 'plain' : 'file-url',
    quiet: c.quiet === true,
    // ── 语音接口的自动启动（重启电脑后不用再手动开第二个程序）──
    autoStartApi: c.autoStartApi !== false,
    pythonPath: str('pythonPath'),
    apiScriptPath: str('apiScriptPath'),
    apiWorkDir: str('apiWorkDir'),
    apiStartTimeoutMs: clampNum(c.apiStartTimeoutMs, 180000, 10000, 600000)
  };
}

let skipCache = { raw: null, set: null };
function skipChatSet() {
  const raw = settings().skipChats;
  if (skipCache.raw !== raw) {
    skipCache = { raw, set: new Set(String(raw).split(/[,，、;；\s]+/).filter(Boolean)) };
  }
  return skipCache.set;
}

// ── 语音接口（GPT-SoVITS 服务端）：探活 + 自动拉起 ────────────────────────
/**
 * 探一下接口端口通不通（TCP 连接，不发请求，几百微秒）。
 * 用 TCP 而不是 GET：api_v2 的根路径会返回 404，那也算"服务在跑"，但用 HTTP 判断容易误报。
 */
function probeApiPort(c, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(c.apiUrl); } catch { return resolve(false); }
    const host = url.hostname || '127.0.0.1';
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
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
    try { socket.connect(port, host); } catch { finish(false); }
  });
}

/**
 * 保证语音接口在运行：通就直接返回；不通且开了自动启动，就把它拉起来等它就绪。
 *
 * 退避很重要：万一是显卡被占/依赖缺失导致 python 一起来就崩，
 * 不能每条消息都去拉一个新进程。失败后 1 分钟 → 5 分钟 → 15 分钟 才再试，成功后清零。
 *
 * @returns {Promise<{ok: boolean, started?: boolean, error?: string}>}
 */
function ensureApiServer(c) {
  if (G.server.starting) return G.server.starting;      // 已经有人在拉，等同一个结果
  if (!c.autoStartApi) {
    return probeApiPort(c).then((ok) => {
      G.server.ok = ok; G.server.at = Date.now();
      return ok ? { ok: true } : { ok: false, error: '语音接口没在运行（自动启动是关的）' };
    });
  }
  return probeApiPort(c).then((up) => {
    G.server.ok = up; G.server.at = Date.now();
    if (up) return { ok: true };
    const backoff = [60000, 300000, 900000][Math.min(G.server.attempts, 2)];
    const waited = Date.now() - G.server.lastTryAt;
    if (G.server.attempts > 0 && waited < backoff) {
      const left = Math.ceil((backoff - waited) / 1000);
      return { ok: false, error: `上次启动失败（${G.server.lastError || '原因见 api-server.log'}），${left} 秒后再试` };
    }
    return startApiServer(c);
  });
}

/** 真的把 python 拉起来，并等端口就绪。 */
function startApiServer(c) {
  G.server.starting = (async () => {
    G.server.lastTryAt = Date.now();
    G.server.attempts += 1;
    let fd = null;
    try {
      if (!c.pythonPath || !fs.existsSync(c.pythonPath)) throw new Error(`找不到 python：${c.pythonPath || '(未设置)'}`);
      if (!c.apiScriptPath || !fs.existsSync(c.apiScriptPath)) throw new Error(`找不到 api_v2.py：${c.apiScriptPath || '(未设置)'}`);
      const url = new URL(c.apiUrl);
      const host = url.hostname || '127.0.0.1';
      const port = url.port || '9880';
      fs.mkdirSync(path.dirname(API_LOG), { recursive: true });
      fd = fs.openSync(API_LOG, 'a');
      const child = spawn(
        c.pythonPath,
        [c.apiScriptPath, '-a', host, '-p', String(port), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'],
        {
          cwd: c.apiWorkDir || path.dirname(c.apiScriptPath),
          detached: true,          // 让 QQ Agent 退出时不用等它
          windowsHide: true,       // 不弹黑窗口
          stdio: ['ignore', fd, fd]
        }
      );
      child.unref();
      rtLog('启动', `已拉起语音接口（pid ${child.pid}）：${c.pythonPath}`);
      // 等它加载完模型（首次 1~3 分钟）
      const deadline = Date.now() + c.apiStartTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(2000);
        if (await probeApiPort(c, 1000)) {
          G.server.ok = true; G.server.at = Date.now();
          G.server.attempts = 0; G.server.lastError = '';
          rtLog('启动', `语音接口已就绪（用了约 ${Math.round((Date.now() - G.server.lastTryAt) / 1000)} 秒）`);
          return { ok: true, started: true };
        }
      }
      throw new Error(`等了 ${Math.round(c.apiStartTimeoutMs / 1000)} 秒还是没起来，看 ${API_LOG}`);
    } catch (error) {
      const msg = errText(error);
      G.server.ok = false;
      G.server.lastError = msg;
      rtLog('启动失败', msg);
      warnOnce(`自动启动语音接口失败：${msg}`);
      return { ok: false, error: msg };
    } finally {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* 子进程已拿到自己的句柄 */ }
      G.server.starting = null;
    }
  })();
  return G.server.starting;
}

// ── 关掉语音接口（插件开关 = 接口开关）─────────────────────────────────────
// 不走"杀进程"那条路：按 PID / 端口去 taskkill 有可能误伤别人的进程，
// 而插件自动拉起的那个又没有窗口、用户自己也关不掉。
// 改成让接口**自己退出**：gpt-sovits 的 api_v2.py 提供了
//   GET /control?command=exit   →   handle_control('exit')  →  os.kill(os.getpid(), SIGTERM)
// 这条路只影响"插件配置的那个接口"，干净且可解释。

/** 接口是不是跑在本机。远程/共享的接口不该被本机的一个插件开关关掉。 */
function isLocalApi(c) {
  try {
    const h = String(new URL(c.apiUrl).hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 让语音接口退出（用户关掉插件开关时调用）。
 * @returns {Promise<{ok: boolean, stopped?: boolean, already?: boolean, reason?: string}>}
 */
async function stopApiServer(c) {
  if (!isLocalApi(c)) return { ok: false, reason: '接口不在本机（可能是共享的），没有去关它' };
  if (!(await probeApiPort(c, 1200))) { G.server.ok = false; return { ok: true, already: true }; }

  let sendError = null;
  try {
    await fetchWithTimeout(`${c.apiUrl}/control?command=exit`, {}, 15000);
  } catch (error) {
    // ⚠️ 这里报错是**正常现象**，不是失败：api_v2.py 的 /control 是
    //    `handle_control('exit')` → `os.kill(os.getpid(), SIGTERM)` —— 它先把自己杀了，
    //    响应根本来不及发出来，客户端必然看到连接被重置（fetch failed）。
    //    所以绝不能凭"请求失败"就断定没关掉，要看**端口最终有没有释放**。
    sendError = errText(error);
  }

  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!(await probeApiPort(c, 600))) {
      G.server.ok = false;
      G.server.attempts = 0;      // 清掉退避，下次开启立刻就能重新拉起
      G.server.lastError = '';
      G.server.starting = null;
      rtLog('停止', sendError
        ? '已让语音接口退出、端口已释放（接口是直接把自己杀掉的，所以请求会报连接中断，属正常）'
        : '已让语音接口退出、端口已释放');
      return { ok: true, stopped: true };
    }
  }
  return {
    ok: false,
    reason: sendError
      ? `发了退出指令但端口一直没释放（${sendError}）—— 你的接口可能不支持 /control`
      : '发了退出指令，但端口一直没释放'
  };
}

// ── 音色配置：插件设置优先，其次复用外部音色配置文件 ──────────────────────
// 外部文件沿用「自训练语音回复」插件那份格式（%LOCALAPPDATA%\QQAgentVoice\config.json）：
//   { voices: { zh: { modelPath, refAudioPath, promptText, promptLang, speedFactor }, ja: {...} } }
// 这样已经配好那份的人不用再填一遍；没配的人直接在插件设置里填就行。
function defaultConfigPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'QQAgentVoice', 'config.json');
}

function readExternalConfig(s) {
  const explicit = String(s.configPath || '').trim();
  const file = explicit || defaultConfigPath();
  if (!fs.existsSync(file)) {
    // 显式指定了却不存在 = 用户填错了，必须说出来；默认路径没有则是正常情况
    if (explicit) throw new Error(`音色配置文件不存在：${file}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`音色配置文件解析失败（${file}）：${errText(error)}`);
  }
}

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u;
const HAN = /[\u4e00-\u9fff]/;

/** auto 时按内容猜语言：有假名 → 日；纯英文（无汉字）→ 英；其余 → 中。 */
function pickLanguage(text, configured) {
  const fixed = ['zh', 'ja', 'en', 'ko', 'yue'];
  if (fixed.includes(String(configured))) return String(configured);
  const t = String(text || '');
  if (KANA.test(t)) return 'ja';
  if (/[a-zA-Z]/.test(t) && !HAN.test(t)) return 'en';
  return 'zh';
}

/**
 * 相对路径按「GPT-SoVITS 根目录」解析。
 * 为什么需要：底模（预训练模型）在官方文档和 tts_infer.yaml 里都是**相对路径**写法
 * （如 GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth），用户照抄过来时，
 * 如果拿 QQ Agent 自己的工作目录去做 existsSync，会误报"文件不存在"。
 * 绝对路径原样返回。
 */
function absFrom(base, p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return s;
  return base ? path.resolve(base, s) : s;
}

/**
 * 解析"这一条要用哪个音色"。
 * 任何"配不全"的情况都返回 ok:false + 人话原因（既能给 UI 显示，也能进日志）。
 */
function resolveVoice(text) {
  const s = settings();
  const ext = readExternalConfig(s);
  const language = pickLanguage(text, s.textLang);
  const v = (ext && ext.voices && typeof ext.voices === 'object' && ext.voices[language]) || {};
  const pick = (a, b) => {
    const x = String(a ?? '').trim();
    return x || String(b ?? '').trim();
  };
  const base = s.apiWorkDir;

  const voice = {
    modelPath: absFrom(base, pick(s.sovitsWeightsPath, v.modelPath || v.sovitsWeightsPath)),
    gptPath: absFrom(base, pick(s.gptWeightsPath, v.gptWeightsPath)),
    refAudioPath: absFrom(base, pick(s.refAudioPath, v.refAudioPath)),
    promptText: pick(s.promptText, v.promptText),
    promptLang: pick(s.promptLang, v.promptLang) || language,
    speedFactor: Number(v.speedFactor ?? s.speedFactor) || s.speedFactor
  };

  if (!voice.refAudioPath || !voice.promptText) {
    return {
      ok: false,
      reason: '尚未配置音色：请在插件设置里填「参考音频」和「参考文本」（或指定一份音色配置文件）'
    };
  }
  // 权重是**可选**的：留空表示"不切换权重，直接用接口端已经加载好的那份"。
  // 这样没训练过模型、或者用别人音色的人，只要给一段参考音频 + 台词就能用（零样本克隆）。
  const missing = [];
  if (path.isAbsolute(voice.refAudioPath) && !fs.existsSync(voice.refAudioPath)) missing.push(`参考音频 ${voice.refAudioPath}`);
  if (voice.modelPath && path.isAbsolute(voice.modelPath) && !fs.existsSync(voice.modelPath)) missing.push(`SoVITS 权重 ${voice.modelPath}`);
  if (voice.gptPath && path.isAbsolute(voice.gptPath) && !fs.existsSync(voice.gptPath)) missing.push(`GPT 权重 ${voice.gptPath}`);
  if (missing.length) return { ok: false, reason: `文件不存在：${missing.join('；')}` };

  // 缓存指纹：换了音色/权重/参考音频/语速都算另一份音频，不能串用
  voice.key = createHash('sha1')
    .update([voice.modelPath, voice.gptPath, voice.refAudioPath, voice.promptText, voice.promptLang, voice.speedFactor].join('|'))
    .digest('hex')
    .slice(0, 12);
  return { ok: true, language, voice, config: s };
}

// 自检结果缓存：available() 会在每次发送/状态刷新时被调用，不能每次都去 stat 文件。
// 但缓存必须带上"配置指纹" —— 用户刚在设置里填完路径，插件页不能还显示旧的"未配置"
// （只按时间缓存的话就有这个 5 秒的假状态窗口）。
let probeCache = { at: 0, value: null, sig: '' };
function probeSignature() {
  const s = settings();
  return [s.apiUrl, s.configPath, s.sovitsWeightsPath, s.gptWeightsPath, s.refAudioPath, s.promptText, s.promptLang, s.speedFactor].join('|');
}
function probe(force = false) {
  const now = Date.now();
  const sig = probeSignature();
  if (!force && probeCache.value && probeCache.sig === sig && now - probeCache.at < 5000) return probeCache.value;
  let value;
  try {
    const r = resolveVoice('你好');
    value = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (error) {
    value = { ok: false, reason: errText(error) };
  }
  probeCache = { at: now, value, sig };
  return value;
}

/** 插件当前是否真的生效（开关 + 依赖都算上）。核心没接上时按"不生效"处理更安全。 */
function isActive() {
  try {
    if (G.api && typeof G.api.isSkillActive === 'function') return G.api.isSkillActive(ID) === true;
  } catch { /* 判定异常 → 不生效，绝不硬跑 */ }
  return false;
}

// ── 该不该把这条文字转成语音 ──────────────────────────────────────────────
function eligible(chatKey, text) {
  const s = settings();
  if (typeof text !== 'string') return { ok: false, why: '不是文本' };
  const t = text.trim();
  if (!t) return { ok: false, why: '空消息' };
  if (t.length < s.minChars) return { ok: false, why: `短于 ${s.minChars} 字` };
  if (t.length > s.maxChars) return { ok: false, why: `超过 ${s.maxChars} 字（长内容发文字更清楚）` };
  if (!s.allowPrivate && String(chatKey).startsWith('private:')) return { ok: false, why: '私聊不转语音' };
  if (skipChatSet().has(String(chatKey))) return { ok: false, why: '在跳过的会话名单里' };
  // 全是表情/符号的文字念出来是噪音，也常常是空音频
  if (!/[\p{L}\p{N}]/u.test(t)) return { ok: false, why: '没有可朗读的内容' };
  if (s.skipStructured) {
    if (/https?:\/\/|www\./i.test(t)) return { ok: false, why: '含链接' };
    if (/\[CQ:|CQ:/.test(t)) return { ok: false, why: '含 CQ 码' };
    if (/```/.test(t)) return { ok: false, why: '含代码块' };
    if (/\[object Object\]/.test(t)) return { ok: false, why: '内容异常' };
    if (/[A-Za-z]:\\|\/[\w.-]+\/|\.(exe|dll|json|js|mjs|py|log|zip|pth|ckpt)\b/i.test(t)) {
      return { ok: false, why: '含文件路径' };
    }
  }
  return { ok: true, why: '' };
}

/** 每分钟合成条数上限（超出的这条直接发文字）。 */
function underRate() {
  const s = settings();
  const now = Date.now();
  G.recent = G.recent.filter((t) => now - t < 60000);
  return G.recent.length < s.maxPerMinute;
}

function note(kind, why) {
  if (kind === 'skipped') G.stats.skipped += 1;
  else G.stats.failed += 1;
  G.stats.lastWhy = `${kind === 'skipped' ? '跳过' : '失败'}：${why}`;
}

// ── WAV 处理 ──────────────────────────────────────────────────────────────
function findChunk(buffer, id) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunkId === id) return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * 统一成 16kHz 单声道 PCM16 WAV。
 *
 * 为什么要这一步：GPT-SoVITS 默认吐 32kHz（也可能带立体声），而协议端再转 silk 上传时
 * 对采样率/声道最挑；先在这里做掉，能避开一大类"发出去没声音/发不出去"的问题。
 */
function toStandardWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('GPT-SoVITS 返回的不是 WAV（检查服务端 media_type / streaming_mode 设置）');
  }
  const fmt = findChunk(wav, 'fmt ');
  const data = findChunk(wav, 'data');
  if (!fmt || !data || fmt.size < 16) throw new Error('WAV 结构不完整');
  const format = wav.readUInt16LE(fmt.offset);
  const channels = wav.readUInt16LE(fmt.offset + 2);
  const sampleRate = wav.readUInt32LE(fmt.offset + 4);
  const bits = wav.readUInt16LE(fmt.offset + 14);
  if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 8000) {
    throw new Error(`暂不支持该 WAV 格式：format=${format}, channels=${channels}, rate=${sampleRate}, bits=${bits}`);
  }
  const frames = Math.max(0, Math.min(
    Math.floor(data.size / (channels * 2)),
    Math.floor(Math.max(0, wav.length - data.offset) / (channels * 2))
  ));
  if (!frames) throw new Error('WAV 里没有音频数据');

  const source = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += wav.readInt16LE(data.offset + (frame * channels + channel) * 2);
    }
    source[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }
  const targetFrames = Math.max(1, Math.round(frames * 16000 / sampleRate));
  const pcm = Buffer.alloc(targetFrames * 2);
  for (let index = 0; index < targetFrames; index++) {
    const position = index * sampleRate / 16000;
    const left = Math.min(frames - 1, Math.floor(position));
    const right = Math.min(frames - 1, left + 1);
    const fraction = position - left;
    const value = Math.round(source[left] * (1 - fraction) + source[right] * fraction);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2);
  }
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

/**
 * 粗判"这条音频是不是坏掉了"。
 * GPT-SoVITS 偶尔会吐出整段静音、只念了半句就断掉、或开头空一大截的音频 ——
 * 这种发到群里比不发还糟（群友只看到一条没声音的语音），所以宁可换种子重来一次。
 */
function suspiciousWav(wav) {
  const frames = Math.floor((wav.length - 44) / 2);
  if (frames <= 0) return true;
  const windowFrames = 8000;                 // 0.5 秒一个窗口
  const windows = Math.ceil(frames / windowFrames);
  const active = [];
  for (let window = 0; window < windows; window++) {
    const start = window * windowFrames;
    const end = Math.min(frames, start + windowFrames);
    let sum = 0;
    for (let frame = start; frame < end; frame++) {
      const value = wav.readInt16LE(44 + frame * 2);
      sum += value * value;
    }
    if (Math.sqrt(sum / Math.max(1, end - start)) >= 180) active.push(window);
  }
  if (!active.length) return true;           // 全程静音
  const duration = frames / 16000;
  if (duration <= 12) return false;          // 短句不做过度判断
  const first = active[0] * 0.5;
  const last = Math.min(duration, (active[active.length - 1] + 1) * 0.5);
  let maxGap = Math.max(first, duration - last);
  for (let i = 0; i + 1 < active.length; i++) maxGap = Math.max(maxGap, (active[i + 1] - active[i] - 1) * 0.5);
  return first > 5 || active.length / windows < 0.2 || (last - first) / duration < 0.4 || maxGap > 3;
}

// ── GPT-SoVITS API ────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
  const doFetch = G.fetch || globalThis.fetch;
  const response = await doFetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? `：${String(body).slice(0, 300)}` : ''}`);
  }
  return response;
}

/** 切换权重（GPT-SoVITS 的 /set_gpt_weights 与 /set_sovits_weights 都是 GET + query）。 */
async function ensureWeights(c, voice) {
  if (voice.gptPath && G.applied.gpt !== voice.gptPath) {
    await fetchWithTimeout(`${c.apiUrl}/set_gpt_weights?weights_path=${encodeURIComponent(voice.gptPath)}`, {}, 60000);
    G.applied.gpt = voice.gptPath;
  }
  // ⚠️ 必须带 voice.modelPath 这个前提：留空表示"用接口端自己的权重"，
  //    这时候绝不能去调 /set_sovits_weights（空路径会被服务端以 400 拒掉，整条语音就废了）。
  if (voice.modelPath && G.applied.sovits !== voice.modelPath) {
    await fetchWithTimeout(`${c.apiUrl}/set_sovits_weights?weights_path=${encodeURIComponent(voice.modelPath)}`, {}, 120000);
    G.applied.sovits = voice.modelPath;
  }
}

async function synthesize(c, voice, text, language) {
  // 先把语音接口确保起来（没在跑就自动拉起来；关了自动启动就直接报"接口没运行"）
  const api = await ensureApiServer(c);
  if (!api.ok) throw new Error(api.error || '语音接口不可用');
  await ensureWeights(c, voice);
  // 换切分方式 + 换随机种子重试：GPT-SoVITS 少数情况下会生成静音或半截音频，
  // 同一份参数重试常常还是坏的，换个种子基本都能出正常音频。
  const plans = [['cut5', 1234], ['cut5', 42], ['cut1', 20260928]];
  let lastError = null;
  for (const [method, seed] of plans) {
    try {
      const response = await fetchWithTimeout(`${c.apiUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          text_lang: language,
          ref_audio_path: voice.refAudioPath,
          prompt_text: voice.promptText,
          prompt_lang: voice.promptLang || language,
          text_split_method: method,
          batch_size: 1,
          top_k: 5,
          top_p: 0.85,
          temperature: 0.8,
          repetition_penalty: 1.2,
          speed_factor: voice.speedFactor,
          fragment_interval: 0.15,
          seed,
          media_type: 'wav',
          streaming_mode: false
        })
      }, c.timeoutMs);
      const wav = toStandardWav(Buffer.from(await response.arrayBuffer()));
      if (suspiciousWav(wav)) {
        lastError = new Error('生成的音频疑似静音/异常，已换随机种子重试');
        continue;
      }
      return wav;
    } catch (error) {
      lastError = error;
      // 服务端可能重启过（权重回到了默认），下一次 ensureWeights 要重新加载
      G.applied = { gpt: '', sovits: '' };
    }
  }
  throw lastError || new Error('语音合成失败');
}

function cleanupOld(dir, ttlMinutes) {
  try {
    const cutoff = Date.now() - ttlMinutes * 60000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.wav') && !name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 目录还不存在 */ }
}

// 同时最多合成几条：本地服务端（往往还占着显卡）扛不住并发，
// 超出的那条这次直接发文字，等下一轮再说 —— 总比整轮对话卡住强。
const MAX_CONCURRENT = 2;

/**
 * 合成到文件。
 *
 * 两种模式（由 deleteAfterSend 决定）：
 *   · 开（默认）：**一份音频只服务一次发送**，用带随机后缀的独立文件名，
 *     发完立刻删。这样硬盘上不留东西，也不会出现"两条同时发同一句话、
 *     先发完的把文件删了导致后一条失败"。
 *   · 关：按内容哈希缓存复用，靠 fileTtlMinutes 定期清理（想省重复合成的时间就关掉）。
 *
 * 限频只算"真的要合成"的次数 —— 缓存命中不占配额，也不进并发计数。
 * @returns {Promise<{file: string|null, cached?: boolean, reason?: string}>}
 */
async function synthesizeToFile(c, voice, text, language) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  cleanupOld(WORK_DIR, c.fileTtlMinutes);
  const digest = createHash('sha1').update(`${voice.key}|${language}|${text}`).digest('hex').slice(0, 16);
  if (!c.deleteAfterSend) {
    const cacheFile = path.join(WORK_DIR, `voice-${digest}.wav`);
    if (fs.existsSync(cacheFile)) {
      const now = Date.now();
      try { await fsp.utimes(cacheFile, now / 1000, now / 1000); } catch { /* 更新时间失败不影响使用 */ }
      G.stats.cached += 1;
      return { file: cacheFile, cached: true };
    }
  }
  if (G.inFlight >= MAX_CONCURRENT) return { file: null, reason: '同时在合成的条数已达上限' };
  if (!underRate()) return { file: null, reason: `每分钟最多合成 ${c.maxPerMinute} 条` };

  G.inFlight += 1;
  G.recent.push(Date.now());
  try {
    const wav = await synthesize(c, voice, text, language);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const outFile = path.join(WORK_DIR, c.deleteAfterSend ? `voice-${digest}-${stamp}.wav` : `voice-${digest}.wav`);
    const tmp = `${outFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, wav);
    await fsp.rename(tmp, outFile);
    return { file: outFile, cached: false };
  } finally {
    G.inFlight -= 1;
  }
}

/** 发送完成后删掉本地那份（删不掉也不影响消息，只是留给 TTL 清扫兜底）。 */
async function removeSentFile(file) {
  try { await fsp.unlink(file); } catch { /* 已经没了 / 被占用，交给 TTL 清扫 */ }
}

// ── 发送语音段 ────────────────────────────────────────────────────────────
/**
 * 本地文件的几种引用形态。协议端实现差异很大，所以按顺序都试一遍：
 *   file:///C:/... 最通用；C:\... 给不认 file URL 的；base64:// 给跨机/权限受限的场景。
 */
function fileRefs(file, style) {
  const abs = path.resolve(file);
  const url = `file:///${abs.replace(/\\/g, '/')}`;
  const refs = style === 'plain' ? [abs, url] : [url, abs];
  try {
    const bytes = fs.statSync(abs).size;
    if (bytes > 0 && bytes <= 4 * 1024 * 1024) refs.push(`base64://${fs.readFileSync(abs).toString('base64')}`);
  } catch { /* 读不到就只试路径形态 */ }
  return refs;
}

/**
 * 发一条 record 段。
 * 引用/@ 段自己拼：核心的 #replyAtSegments 是私有静态方法，插件拿不到；
 * 但校验规则照抄它（消息 id 可为负、at 必须是纯数字、拒绝 all），不会把非法值塞给协议端。
 */
async function sendRecord(client, kind, id, file, options, s) {
  const segments = [];
  const replyId = String(options?.replyToMessageId ?? '').trim();
  if (/^-?[1-9]\d*$/.test(replyId)) segments.push({ type: 'reply', data: { id: replyId } });
  const atUserId = String(options?.atUserId ?? '').trim();
  if (/^\d+$/.test(atUserId)) segments.push({ type: 'at', data: { qq: atUserId } });

  let lastError = null;
  for (const ref of fileRefs(file, s.pathStyle)) {
    try {
      const res = await client.sendSegments(kind, id, [...segments, { type: 'record', data: { file: ref } }]);
      return { ok: true, res };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError };
}

// ── 补丁 ──────────────────────────────────────────────────────────────────
function installPatch() {
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.sendText !== 'function') return null;
  // 热重载：先把**我们自己**上一份补丁摘掉，再装这一份新的。
  // 只认 G.patched —— 别的插件（如 typo-sim）装的补丁绝不能碰。
  // 这样改完代码立刻生效，也不会一层层套下去。
  if (G.installed && G.patched && proto.sendText === G.patched) proto.sendText = G.original;

  const original = proto.sendText;
  const patched = async function sendTextAsVoice(kind, id, text, options = {}) {
    const args = [kind, id, text, options];
    const chatKey = `${kind}:${id}`;
    try {
      if (!isActive()) return original.apply(this, args);

      const gate = eligible(chatKey, text);
      if (!gate.ok) { note('skipped', gate.why); rtLogOnce('跳过', gate.why, `「${String(text).slice(0, 20)}」`); return original.apply(this, args); }

      const resolved = resolveVoice(text);
      if (!resolved.ok) {
        note('skipped', resolved.reason);
        warnOnce(resolved.reason);
        rtLogOnce('跳过', resolved.reason, `「${String(text).slice(0, 20)}」`);
        return original.apply(this, args);
      }
      const s = resolved.config;

      const spoken = text.trim();
      const startedAt = Date.now();
      const out = await synthesizeToFile(s, resolved.voice, spoken, resolved.language);
      if (!out.file) { note('skipped', out.reason); rtLogOnce('跳过', out.reason, `「${spoken.slice(0, 20)}」`); return original.apply(this, args); }
      const file = out.file;

      const sent = await sendRecord(this, kind, id, file, options, s);
      // 发完就删：语音这时已经上传给协议端了，本地这份留着只是占硬盘。
      // 不管成功失败都删 —— 失败也不会重发同一个文件（下面会退回文字）。
      if (s.deleteAfterSend) await removeSentFile(file);
      if (!sent.ok) {
        const why = `语音发送失败：${errText(sent.error)}`;
        note('failed', why);
        warnOnce(`语音发送失败，这条已改发文字：${errText(sent.error)}`);
        rtLog('失败', `${why} → 这条已改发文字`);
        return original.apply(this, args);
      }

      G.stats.converted += 1;
      G.stats.chars += spoken.length;
      G.stats.ms += Date.now() - startedAt;
      G.stats.lastAt = Date.now();
      G.stats.lastText = spoken;
      rtLog('已发语音', `${resolved.language}｜${spoken.length} 字｜耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s｜${chatKey}｜「${spoken.slice(0, 24)}」`);
      if (!s.quiet) log(`已发语音（${resolved.language}，${spoken.length} 字，${Date.now() - startedAt}ms）：「${spoken.slice(0, 24)}」`);

      if (s.alsoSendText) {
        try { await original.apply(this, args); } catch (error) { warnOnce(`补发文字失败：${errText(error)}`); }
      }
      return sent.res;
    } catch (error) {
      note('failed', errText(error));
      warnOnce(`转语音出错，这条已按文字发送：${errText(error)}`);
      rtLog('失败', `转语音出错 → 这条已改发文字：${errText(error)}`);
      return original.apply(this, args);
    }
  };

  proto.sendText = patched;
  G.original = original;
  G.patched = patched;
  G.installed = true;
  return { original, reused: false };
}

// ── 生命周期（核心约定：setup / available / activate / deactivate / dispose / hooks / providers）──
export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  G.api = api;
  G.fetch = typeof api.fetch === 'function' ? api.fetch : globalThis.fetch;
  G.log = (...a) => api.log?.(...a);
  G.warn = (...a) => (api.warn ?? api.log)?.(...a);

  const installed = installPatch();
  const s = settings();
  if (!installed) {
    warn('挂不上发送钩子（这个版本的核心没有 OneBotClient.prototype.sendText），语音回复不会生效');
    rtLog('加载失败', '挂不上发送钩子（核心没有 OneBotClient.prototype.sendText）');
    return;
  }
  const self = probe(true);
  rtLog('加载', `已加载（上限 ${s.maxChars} 字，每分钟 ${s.maxPerMinute} 条，自动启动接口=${s.autoStartApi ? '开' : '关'}）`
    + (self.ok ? '' : `；尚未配置好 → ${self.reason}`));
  log(`已加载：文字回复 → 语音（API ${s.apiUrl}，上限 ${s.maxChars} 字，每分钟 ${s.maxPerMinute} 条）`
    + (self.ok ? '' : `；⚠️ 还没配置好 → ${self.reason}`));

  // 配置齐全 + 开关开着时，趁着空闲把语音接口先拉起来 —— 这样重启电脑后
  // 用户只要开 QQ Agent，等真正要发语音时接口已经热好了，不用再管第二个程序。
  // 关掉插件开关就**不再拉**（否则会出现"我在界面上关了它，重启后接口又冒出来占着端口"）。
  if (self.ok && s.autoStartApi && skillEnabledByConfig()) {
    ensureApiServer(s).then((r) => {
      if (!r.ok) rtLog('接口', `当前不可用：${r.error || '未知原因'}`);
    }).catch(() => {});
  }

  // 开机清扫一次上一轮遗留的音频（上次崩了/被强杀时可能留下几份没删掉的）。
  // 开"发完就删"时阈值取 1 分钟：远大于一次发送的存活时间，绝对不会误删正在发送的那份。
  if (self.ok) cleanupOld(WORK_DIR, s.deleteAfterSend ? 1 : s.fileTtlMinutes);
}

/**
 * 状态自检：配置缺什么就说清楚缺什么，插件页直接显示这句原因。
 * ⚠️ 这里**故意不看语音接口在不在跑**：如果接口没起就判"不可用"，
 *    插件会连带变成未生效，而"自动把接口拉起来"的代码就永远没机会执行 —— 死锁。
 *    接口状态放在 providers 状态面板和 runtime.log 里表达。
 */
export function available() {
  const p = probe();
  // 顺手推一把自动启动（不阻塞、不等待；ensureApiServer 内部有并发与退避保护）
  if (p.ok) {
    const s = settings();
    if (s.autoStartApi && skillEnabledByConfig() && !G.server.ok && !G.server.starting) {
      ensureApiServer(s).catch(() => {});
    }
  }
  return p;
}

export function activate() {
  installPatch();
  const s = settings();
  if (!probe().ok || !skillEnabledByConfig()) return;
  // 用户刚把开关打开：接口没在跑就把它拉起来
  if (s.autoStartApi) ensureApiServer(s).catch(() => {});
}

/**
 * 插件开关关掉时：把语音接口也一起关掉（开关 = 控制）。
 *
 * ⚠️ 必须区分两种调用，否则会出大问题：
 *   · 核心**热重载**会带 `{reason:'reload'}` 调它 —— 那只是换一份代码，不是用户关了插件。
 *     顺手停接口的后果是"每改一次插件文件，接口就被打断一次，还得再等 40 秒重载模型"。
 *   · 用户在界面上关掉开关时，context 里**没有** reason —— 那才是真的要停。
 *
 * 停的方式是让接口自己退出（`/control?command=exit`），不是杀进程；
 * 接口不在本机时不动它。补丁本身不摘：它每次都会问 isSkillActive，关掉就自动放行文字。
 */
export function deactivate(ctx = {}) {
  if (ctx && ctx.reason === 'reload') return;
  if (!userConfigured()) return;
  const s = settings();
  stopApiServer(s).then((r) => {
    if (!r.ok) rtLog('停止', `没有关掉语音接口：${r.reason}`);
  }).catch(() => { /* 关不掉也不该影响别的 */ });
}

/** 卸载插件时核心会重载模块，这里无需手工还原原型（还原反而可能把别人的补丁一起摘掉）。 */
export function dispose() { /* 故意留空 */ }

/** 状态面板（给「AI 状态」类消费方用）：必须同步、零 IO。 */
export const providers = {
  [`status.${ID}`]: () => {
    const st = G.stats;
    const self = probe();
    const lines = [];
    if (!self.ok) {
      lines.push(['状态', '不可用'], ['原因', self.reason]);
    } else if (!st.converted) {
      lines.push(['状态', '待命中（还没发过语音）']);
    } else {
      lines.push(['已转语音', `${st.converted} 条`], ['平均耗时', `${(st.ms / st.converted / 1000).toFixed(1)} 秒`]);
    }
    // 接口状态：从最近一次探测结果来（providers 必须同步，这里不能真去连端口）
    lines.push(['语音接口', G.server.ok ? '已就绪' : (G.server.lastError ? '未就绪' : '未探测')]);
    if (!G.server.ok && G.server.lastError) lines.push(['接口原因', G.server.lastError]);
    // 开了"发完就删"就没有缓存这回事，别显示一个永远为 0 的计数让人以为坏了
    if (!settings().deleteAfterSend) lines.push(['命中缓存', `${st.cached} 次`]);
    if (st.skipped) lines.push(['按文字发出', `${st.skipped} 条`]);
    if (st.failed) lines.push(['失败已退回文字', `${st.failed} 条`]);
    if (st.lastWhy) lines.push(['最近一次跳过', st.lastWhy]);
    return {
      icon: '🔊',
      title: 'GPT-SoVITS 语音',
      lines,
      tips: self.ok ? [] : ['语音回复尚未配置好，当前所有回复都还是文字'],
      priority: 64
    };
  }
};

// 内部函数暴露给离线自检用（不对外提供能力，别依赖）
export const internals = {
  ID, WORK_DIR, RUN_LOG, API_LOG,
  settings, eligible, resolveVoice, pickLanguage, absFrom, installPatch, userConfigured, skillEnabledByConfig,
  toStandardWav, suspiciousWav, fileRefs, sendRecord, synthesizeToFile, synthesize, probe,
  probeApiPort, ensureApiServer, startApiServer, stopApiServer, isLocalApi, rtLog, removeSentFile, cleanupOld,
  stats: () => ({ ...G.stats }),
  resetStats: () => {
    G.stats = { converted: 0, cached: 0, failed: 0, skipped: 0, chars: 0, ms: 0, lastAt: 0, lastText: '', lastWhy: '' };
  },
  resetServer: () => {
    G.server = { ok: false, at: 0, attempts: 0, lastTryAt: 0, starting: null, lastError: '' };
  },
  serverState: () => ({ ...G.server }),
  state: () => G,
  isPatched: () => !!G.installed
};
