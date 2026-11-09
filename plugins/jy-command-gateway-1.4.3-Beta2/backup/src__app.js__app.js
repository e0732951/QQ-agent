// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfig, updateConfig, reloadConfig, ROOT, DATA_DIR, PROFILE_ID } from './config.js';
import { customSearch } from './web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from './onebot.js';
import { ChatStore, DEFAULT_HOT_PER_CHAT, msgRef } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices, isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from './price-feed.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { createEventBus, todayKey, sweepStaleTmp } from './util.js';
import { getUsageLedger } from './usage-ledger.js';
import { getConversationMemory, startConversationMemoryMaintenance, stopConversationMemoryMaintenance } from './conversation-memory/runtime.js';
import { startCrazyThursday, stopCrazyThursday } from './crazy-thursday.js';
import { stopApiNewsScheduler } from './api-news.js';
import { costGuardStats } from './conversation-memory/cost-guard.js';
import { activeTodos } from './conversation-memory/pending.js';
import { listAllMemes, saveMeme, removeMeme, memeCount } from './memes.js';
import { botStateView, setBotState, listEmotionProfiles, getEmotionProfile, EMOTION_PROFILES } from './bot-state.js';
import { initExtensions, startExtensionWatch, setExtensionEnabled, listExtensionStatus, skillManager } from './skill-bridge.js';
import { setSkillConfig } from './skills/config.js';
import { SKILL_DIRS } from './plugin-loader.js';
import { ensureLocalJev, stopLocalJev, localJevStatus, jevGate, resetLocalJevStats, secondaryJevEnabled } from './local-jev.js';

/** 节假日表文件状态（控制台显示"表还在不在、覆盖到哪年"，过期不报错只提示）。 */
function calendarFileMeta() {
  const file = path.join(DATA_DIR, 'life-calendar.json');
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      exists: true,
      year: Number(t.year) || 0,
      holidays: Object.keys(t.holidays || {}).length,
      makeup: Object.keys(t.makeupWorkdays || {}).length,
      expired: (Number(t.year) || 0) < new Date().getFullYear()
    };
  } catch {
    return { exists: false, year: 0, holidays: 0, makeup: 0, expired: false };
  }
}

/** 切换情绪性格档并落盘。 */
function setPersonaEmotionProfile(id) {
  updateConfig({ persona: { emotionProfile: id } });
}

/** 本地图片路径 → 绝对路径（SnowLuma 认 file:// 与绝对路径）。 */
function avatarFileArg(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  if (!fs.existsSync(p)) throw new Error(`头像文件不存在: ${p}`);
  return p;
}

/** 读图转 base64://，给 file 路径失败时兜底。 */
function avatarBase64Arg(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  return `base64://${fs.readFileSync(p).toString('base64')}`;
}

/** 开/关亢奋时自动切 QQ 头像。avatarOn / avatarOff 配置在 hypeMode 里。 */
async function switchHypeAvatar(onebot, on) {
  const hm = getConfig().hypeMode || {};
  const target = on ? String(hm.avatarOn || '').trim() : String(hm.avatarOff || '').trim();
  if (!target) return { switched: false, skipped: true, reason: on ? '未配置 avatarOn' : '未配置 avatarOff' };
  // SnowLuma：set_qq_avatar + file:// 或 base64:// 均可
  const attempts = [
    { action: 'set_qq_avatar', file: pathToFileURL(avatarFileArg(target)).href },
    { action: 'set_qq_avatar', file: avatarFileArg(target) },
    { action: 'set_qq_avatar', file: avatarBase64Arg(target) },
    { action: '_set_qq_avatar', file: avatarBase64Arg(target) }
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      await onebot.call(a.action, { file: a.file }, 25000);
      return { switched: true, on: !!on, path: target, action: a.action, via: a.file.startsWith('base64:') ? 'base64' : 'file' };
    } catch (error) {
      lastErr = error;
    }
  }
  throw lastErr || new Error('换头像失败');
}

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();
  // 界面顶部提醒（例如"你连的可能是别的实例的 SnowLuma"），随 /api/status 一起给前端
  let onebotWarning = '';
  // 桥上账号白名单的告警（见 checkBridgeAccounts）
  let snowlumaWarning = '';
  let bridgeWatchTimer = null;
  // 本实例实际监听的端口（start() 里赋值），多实例发现要用
  let listeningPort = 0;
  let instancesCache = { at: 0, list: [] };

  // ── 桥上账号白名单（防止把管理员自己的号也挂上 SnowLuma）──
  // SnowLuma 的自动注入是"发现一个 QQ 进程就注入一个"，很容易连个人号一起挂上。
  // 判定"某个号此刻在桥上"的办法：它的账号配置里写了 OneBot http 端口，
  // 探这个端口是否在监听 —— 在监听就说明那个号的会话真的起着。
  async function scanBridgeAccounts() {
    const dir = snowlumaDir();
    const whitelist = (getConfig().snowluma?.accountWhitelist || []).map(String).filter(Boolean);
    const result = { dir, live: [], strangers: [], whitelist };
    if (!dir || !whitelist.length) return result;
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, 'config'))
        .filter((f) => /^onebot_\d+\.json$/.test(f) && f !== 'onebot_0.json');
    } catch { return result; }
    for (const file of files) {
      const uin = file.replace(/^onebot_/, '').replace(/\.json$/, '');
      let port = 0;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, 'config', file), 'utf8'));
        port = Number((data?.networks?.httpServers || [])[0]?.port) || 0;
      } catch { continue; }
      if (!port) continue;
      if (!(await isPortOpen('127.0.0.1', port, 500))) continue;   // 端口没开 = 这个号没在桥上
      result.live.push(uin);
      if (!whitelist.includes(uin)) result.strangers.push({ uin, port });
    }
    return result;
  }

  /** 用 SnowLuma 自己的网页 API 把某个号从桥上卸载（需要配置里填网页密码）。 */
  async function unhookBridgeAccount(uin, webuiPort) {
    const password = String(getConfig().snowluma?.webuiPassword || '');
    if (!password) return { ok: false, error: '未配置 SnowLuma 网页密码，无法自动卸载' };
    const base = `http://127.0.0.1:${webuiPort}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(8000)
    }).then((r) => r.json()).catch(() => ({}));
    if (!login?.token) return { ok: false, error: 'SnowLuma 网页登录失败（密码不对？）' };
    const headers = { authorization: `Bearer ${login.token}` };
    const list = await fetch(`${base}/api/processes`, { headers, signal: AbortSignal.timeout(8000) })
      .then((r) => r.json()).catch(() => ({}));
    const target = (list?.list || []).find((p) => String(p.uin) === String(uin) && p.injected);
    if (!target) return { ok: false, error: 'SnowLuma 进程列表里找不到这个号（可能已经卸载）' };
    const r = await fetch(`${base}/api/processes/${target.pid}/unload`, { method: 'POST', headers, signal: AbortSignal.timeout(10000) })
      .then((res) => res.json()).catch(() => ({}));
    return { ok: r?.success !== false, pid: target.pid, raw: r };
  }

  async function checkBridgeAccounts({ autoUnhook = null } = {}) {
    const cfgNow = getConfig();
    const whitelist = (cfgNow.snowluma?.accountWhitelist || []).map(String).filter(Boolean);
    if (!whitelist.length) { snowlumaWarning = ''; return { skipped: true }; }
    const scan = await scanBridgeAccounts();
    if (!scan.strangers.length) { snowlumaWarning = ''; return scan; }
    const doUnhook = autoUnhook === null ? cfgNow.snowluma?.autoUnhookStrangers !== false : autoUnhook;
    const webuiPort = snowlumaWebuiPort() || 5099;
    const done = [];
    for (const s of scan.strangers) {
      if (!doUnhook) { done.push(`${s.uin}（仅报警，未卸载）`); continue; }
      const r = await unhookBridgeAccount(s.uin, webuiPort);
      done.push(r.ok ? `${s.uin}（已自动卸载 pid=${r.pid}）` : `${s.uin}（自动卸载失败：${r.error ?? '未知'}）`);
      if (r.ok) log(`[snowluma] 已把非白名单账号 ${s.uin} 从桥上卸载`);
    }
    snowlumaWarning = `SnowLuma 上挂着白名单之外的 QQ 号：${done.join('、')}。`
      + '那不是你的机器人，挂着可能被程序驱动发消息 —— 请检查 SnowLuma 的"自动注入（hookAutoLoad）"是否开着，'
      + '或在它的网页里手动「卸载」；白名单在「QQ 连接」页签的「桥上账号白名单」里维护。';
    log(`[snowluma] ⚠ ${snowlumaWarning}`);
    return scan;
  }

  function startBridgeAccountWatch() {
    if (bridgeWatchTimer) return;
    // 启动 10 秒后先查一次（等 SnowLuma 起来），之后每分钟一次
    setTimeout(() => { checkBridgeAccounts().catch(() => {}); }, 10000);
    bridgeWatchTimer = setInterval(() => { checkBridgeAccounts().catch(() => {}); }, 60000);
    if (bridgeWatchTimer.unref) bridgeWatchTimer.unref();
  }

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    return fs.existsSync(bundled) ? bundled : '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** SnowLuma 网页端口（runtime.json 里的 webuiPort，缺省 5099）。 */
  function snowlumaWebuiPort() {
    try {
      const dir = snowlumaDir();
      if (!dir) return 0;
      const rt = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'runtime.json'), 'utf8'));
      return Number(rt.webuiPort) || 0;
    } catch {
      return 0;
    }
  }

  /** SnowLuma 目录里是否已有登录过的账号（onebot_<uin>.json 是登录后生成的账号级配置）。 */
  function snowlumaHasLogin(dir) {
    try {
      if (!dir) return false;
      return fs.readdirSync(path.join(dir, 'config'))
        .some((f) => /^onebot_\d+\.json$/.test(f) && f !== 'onebot_0.json');
    } catch {
      return false;
    }
  }

  // ── 多实例发现（界面上的「账号标签页」用）──
  // 每个实例自己描述自己，别的实例主动来问；不依赖任何中心注册表。
  function instanceName() {
    const custom = String(getConfig().server?.instanceName || '').trim();
    if (custom) return custom;
    return PROFILE_ID ? `账号 ${PROFILE_ID}` : '主账号';
  }

  /** 本程序版本（给"账号标签页"用：切过去之前能看出对面是不是同一个版本）。 */
const APP_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))?.version || '');
  } catch {
    return '';
  }
})();

/**
 * 本机还有哪些"活着的"实例——单条描述。
 *
 * ⚠️ 2026-09-22（用户反馈「账号标签点过去就黑屏」）：
 *   顶栏那个"账号标签"是扫 3210-3239 端口 + /api/instance-info 找出来的。以前只要对面
 *   回一个 `qqAgentInstance:true` 就认为"这是我们自己的实例"，于是**别的盘上的旧副本**、
 *   或者界面文件不全的副本也会出现在标签里 —— 点过去就是一片白/黑（那个副本的 /app.js
 *   根本取不到）。现在多带 `app` 与 `version` 两个字段，前端点之前会再探一次并核对，
 *   对不上就不跳、把这个标签去掉。
 */
function selfDescriptor() {
    return {
      qqAgentInstance: true,
      self: true,               // 这条就是"我"；扫描到的别人会被标成 false
      app: 'qq-agent',
      version: APP_VERSION,
      profile: PROFILE_ID || '',
      name: instanceName(),
      port: listeningPort,
      dataDir: DATA_DIR,
      url: `http://127.0.0.1:${listeningPort}/`,
      onebot: {
        connected: onebot.connected,
        self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null,
        error: onebot.lastConnectError,
        warning: onebotWarning
      },
      snowluma: { dir: snowlumaDir(), wsUrl: String(getConfig().snowluma?.wsUrl || '') }
    };
  }

  /** 找到本机上还活着的其它实例（并行探测，结果缓存 8 秒）。 */
  async function discoverInstances() {
    const now = Date.now();
    // 只找到"我自己"时缓存短一点（2 秒），好让刚启动的另一个账号尽快出现在标签页上；
    // 找到多个时用 8 秒，避免界面轮询反复扫端口。
    const ttl = instancesCache.list.length > 1 ? 8000 : 2000;
    if (instancesCache.list.length && now - instancesCache.at < ttl) return instancesCache.list;

    const candidates = new Set();
    for (let p = 3210; p <= 3239; p++) candidates.add(p);
    candidates.add(Number(getConfig().server?.port) || 3210);
    for (const raw of String(process.env.QQ_AGENT_PEER_PORTS || '').split(/[,\s]+/)) {
      const n = Number(raw);
      if (n) candidates.add(n);
    }
    candidates.delete(listeningPort);

    const probes = await Promise.all([...candidates].map(async (p) => ({ p, open: await isPortOpen('127.0.0.1', p, 250) })));
    const answers = await Promise.all(probes.filter((x) => x.open).map(async ({ p }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/instance-info`, { signal: AbortSignal.timeout(1200) });
        if (!res.ok) return null;
        const info = await res.json();
        return info?.qqAgentInstance ? info : null;
      } catch {
        return null;   // 端口上是别的东西（比如 SnowLuma），忽略
      }
    }));

    const list = [selfDescriptor(), ...answers.filter(Boolean).map((x) => ({ ...x, self: false }))]
      .sort((a, b) => Number(a.port) - Number(b.port));
    instancesCache = { at: now, list };
    return list;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    // 多账号时一份 SnowLuma 会开好几个 OneBot 端口：某个 OneBot 端口没开，不代表它没在跑。
    // 用网页端口判定更可靠，否则第二个实例会从同一个目录再拉起一个 SnowLuma 进程，两边互相抢。
    const webuiPort = snowlumaWebuiPort();
    if (webuiPort && await isPortOpen('127.0.0.1', webuiPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（网页端口 ${webuiPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留 SnowLuma 自己的控制台窗口
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
    return { ok: true, launched: true, embedded: false };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const stickerAnnotate = { running: false, done: 0, failed: 0, total: 0 };   // 表情批量补备注的运行状态
  // 第二个参数 = 落盘热段条数（内存始终全量，只在落盘上分层；见 store.js 头注释）
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0, cfg.store?.hotMessagesPerChat ?? DEFAULT_HOT_PER_CHAT);
  const memory = new MemoryStore();
  const conversationMemory = getConversationMemory();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });

  /**
   * 扩展激活上下文（0.4 那套插件契约要用）。
   *
   * 为什么要有：插件在 `activate(ctx)` 里拿"外部世界"—— 最典型的是**定时发消息**类插件
   * （`ctx.sender`）和**主动找人聊天**类插件（`ctx.orchestrator` / `ctx.config.patch`）。
   * 0.4 的宿主只传 `{}`，那类插件装上去能加载、能显示，但一到真要发消息就
   * `Cannot read properties of null (reading 'sendTextBatch')`（实测）。
   * 这里把核心实例递进去，插件不用改一行就能跑。
   */
  function extensionContext() {
    return {
      sender,
      onebot,
      store,
      memory,
      orchestrator,
      sessions,
      stickers,
      emit,
      log,
      config: {
        get: () => getConfig(),
        patch: (patch) => updateConfig(patch),
        dataDir: DATA_DIR
      }
    };
  }

  // 扩展底座：扫 skills/ + plugins/（0.3.1 同款），不改核心架构
  initExtensions({ log, context: extensionContext }).then(() => {
    if (getConfig().extensions?.hotReload !== false) {
      startExtensionWatch({ log });
    }
    log('[skill] 扩展已加载：', listExtensionStatus().filter((s) => s.loaded).map((s) => s.id).join(', ') || '（空）');
  }).catch((e) => log('[skill] 扩展初始化失败:', e?.message ?? e));

  // 每周四 7/13/19 点直发疯狂星期四（不走 LLM/人设）
  startCrazyThursday({ sender, log });

  // 本地 Jev 旁路：包内 0.8B + llama-server（失败不影响主链路）。
  // secondary 备用模型已下线；modelPath 为空时 ensure 是空操作。
  //
  // 默认「打开软件就拉起来」（localJev.startOnLaunch）——不然每次开机都要去设置页
  // 点一次「重启本地模型」，而且忘了点就整套 Jev 判定静默不生效（很难发现）。
  // 关掉它 = 懒启动：等第一次真的要用它才起进程（省内存，第一问多等几百毫秒）。
  {
    const j = getConfig().localJev || {};
    if (j.enabled !== true) {
      log('[localJev] 未启用（设置 → 本地 Jev → 勾「启用本地 Jev」；勾上后每次开软件会自动拉起）');
    } else if (j.startOnLaunch === false) {
      log('[localJev] 懒启动：第一次判定时才拉起本地模型');
    } else {
      ensureLocalJev({ log }).catch((e) => log('[localJev] 启动异常:', e?.message ?? e));
    }
  }
  if (secondaryJevEnabled()) {
    ensureLocalJev({ log, key: 'secondary' }).catch((e) => log('[localJev/备用] 启动异常:', e?.message ?? e));
  }

  // 远程价格表：启动即初始化（内部幂等；URL 为空则完全不动）
  initPriceFeed(cfg.api?.priceRemoteUrl || '');

  // 免费 API 情报：每天凌晨 4 点自动刷新（服务器内定时）
  import('./api-news.js')
    .then(({ startApiNewsScheduler }) => startApiNewsScheduler())
    .catch(() => { /* 定时器起不来不影响主流程 */ });

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 登录后会在 snowluma/config/onebot_<uin>.json 里写入随机 accessToken。
  // 该文件只在 SnowLuma「已登录」时存在；没有它就用空令牌（onebot_0.json）。
  // 脱敏发布/全新副本中 qq-agent 的 token 为空，若不自动同步会一直 401。这里在
  // OneBot 未连接时读取 SnowLuma 配置，把 HTTP/WS 令牌补进我们的配置。
  let lastSyncTokenSig = '';

  /** 本实例配置里 OneBot 的 ws / http 端口（用于在多账号 SnowLuma 里认领"自己那个号"）。 */
  function ownSnowlumaPorts() {
    const portOf = (raw) => {
      try { return Number(new URL(String(raw || '')).port) || 0; } catch { return 0; }
    };
    const cur = getConfig().snowluma || {};
    return { ws: portOf(cur.wsUrl), http: portOf(cur.httpUrl) };
  }

  function readSnowlumaOnebotConfig() {
    try {
      const dir = snowlumaDir();
      if (!dir) return null;
      const cfgDir = path.join(dir, 'config');
      const readAt = (name) => {
        try { return JSON.parse(fs.readFileSync(path.join(cfgDir, name), 'utf8')); } catch { return null; }
      };
      let files = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      // 多账号：一份 SnowLuma 可以同时挂多个 QQ 号，每个号一份 onebot_<uin>.json。
      // 不能只拿"第一个文件"——要挑 OneBot 端口和本实例配置对得上的那个账号，
      // 否则两个实例会互相拿到对方的令牌。
      const want = ownSnowlumaPorts();
      if (want.ws) {
        for (const name of files) {
          const cand = readAt(name);
          if ((cand?.networks?.wsServers || []).some((s) => Number(s.port) === want.ws)) return cand;
        }
      }
      if (files[0]) {
        const first = readAt(files[0]);
        if (first) return first;
      }
      // 没有登录态配置时，回退到 onebot_0.json（空令牌模板）——它一定存在，
      // 能让"0 令牌"这个合法状态被正确同步，而不是因 file 为空返回 false。
      return readAt('onebot_0.json');
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
      return null;
    }
  }

  function syncSnowlumaTokens() {
    try {
      const data = readSnowlumaOnebotConfig();
      if (!data) return false;
      const want = ownSnowlumaPorts();
      const http = (data?.networks?.httpServers || []).find((s) => (want.http && Number(s.port) === want.http) || s.name === 'http-default') || (data?.networks?.httpServers || [])[0];
      const ws = (data?.networks?.wsServers || []).find((s) => (want.ws && Number(s.port) === want.ws) || s.name === 'ws-default') || (data?.networks?.wsServers || [])[0];
      const wsToken = String(ws?.accessToken ?? '');
      const httpToken = String(http?.accessToken ?? '');
      const sig = `${wsToken}|${httpToken}`;
      if (sig === lastSyncTokenSig) return false;
      const cur = getConfig();
      const changed = cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== httpToken;
      if (changed) {
        updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken } });
        log(`[onebot] 已从 SnowLuma 配置同步 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
      }
      lastSyncTokenSig = sig;
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时自动同步一次令牌并重连
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    if (syncSnowlumaTokens()) {
      const cur = getConfig();
      onebot.wsUrl = String(cur.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(cur.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(cur.snowluma?.accessToken || '');
      onebot.httpToken = String(cur.snowluma?.httpAccessToken || cur.snowluma?.accessToken || '');
      onebot.reconnect();
    }
  }
  onebot.onStatus((status) => {
    if (!status.connected && String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 解析"谁引用了哪条"。除了发送者+正文，还要给出被引用那条的**短编号**：
   * 群里常见的形态是「B 引用了 A 的话、再补一句」，模型真正想接的是 A 的原话，
   * 但以前引用块里没有编号 → 模型只拿得到 B 那条的编号 → 只能引到 B，看起来就是"引用错"。
   * 有了这个编号，模型可以直接用 replyToMessageId 指向 A 的原话。
   */
  async function resolveReply(messageId, chatKey = '') {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      // 被引用的那条多半就在我们自己的消息库里（允许的会话全都记）→ 换成短编号给模型用
      let ref = '';
      try {
        const known = chatKey ? store.findByRef(chatKey, messageId) : null;
        if (known) ref = msgRef(known);
      } catch { /* 查不到就不给编号，退回原来的 sender：text */ }
      return { sender: String(senderName), text: String(text).slice(0, 120), ref };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const selfId = onebot.selfId;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    // 自己发的消息绝不当入站触发（发送时 sender 已 appendSelf）。
    // 不能用 event.self_id 过滤——OneBot 里 self_id 恒为机器人自己。
    if (selfId && senderId === selfId) return;
    if (event.post_type === 'message_sent') return;

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid, `${kind}:${id}`),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        // 语音转文字（speech-to-text 插件的能力，没装就退回 [语音]）
        onebot
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 实测结论（2026-09-05，SnowLuma/NapCat）：get_forward_msg 只认 message_id；
    // res_id（转发卡片里那个 id）会过期，报 "payload is empty"。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息')) && event.message_id != null) {
      try {
        const r = await onebot.call('get_forward_msg', { message_id: Number(event.message_id) });
        const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;

    // ── [[command-gateway:dispatch]] 「指令前置」插件自动维护，不要手改这一段 ──
    // ── 指令前置：在存档与会话创建之前，给「指令前置」插件一次认领机会 ──
    // 约定（见 plugins/command-gateway/README.md）：
    //   · dispatch 必须**同步**返回 { handled }；认领后要做的异步工作放进 run()，
    //     这样消息热路径不等待网络/模型调用；
    //   · handled = true → 不存档、不触发会话，彻底不诞生这条会话；
    //   · run() 还可以再返回 { passthrough } 表达「指令执行完后放行」：
    //       true         → 按消息原文放行（存档 + 触发会话，和没认领过一样）；
    //       非空字符串   → 用这段文本替代原文放行（修改后再进会话）；
    //       false / 缺省 → 不放行，消息到此为止。
    //     放行走的是下面的 releaseClaimed()：**不重新过拦截链**（防止链上插件
    //     二次认领造成循环），原消息的媒体段原样保留。
    //   · 未认领、插件没装、插件抛错 → 一律原样放行，行为与没装插件完全一致。
    //
    // ⚠️ 块与核心之间是**软引用**（术语见项目 CONTEXT.md 的「会话前缝」）：
    //    核心句柄一律从 pluginHost 里取，取不到就是 undefined，调用处一律 ?.（有就调用、
    //    没有就跳过）。这样"上游删掉了某个函数"的表现是"少一项功能"，而不是"整块每次
    //    执行都抛 ReferenceError、被自己的 catch 吞掉，用户只看到指令毫无反应"。
    //    真正缺了干不了活的符号（store / orchestrator / emit / log / skillManager）写在
    //    补丁表的 needs 里，打补丁之前就会被拦下来并说清缺了谁。
    let pluginHost = null;
    /**
     * 拼核心句柄。`typeof` 对**不存在的名字**也是安全的（不会抛 ReferenceError），
     * 所以同一份块既能在京玉版上跑（没有 reminders / 指令禁言 / 链接转发），
     * 也能在老核心（0.4）上跑（有这些）。
     * 只在真的要分发时拼一次 —— 插件没装/没启用时，热路径上只多一次能力查询。
     */
    const makePluginHost = () => ({
      // 必需项：直接引用。缺了宁可炸得看得见（而且 needs 会在安装前就拦住）
      store,
      orchestrator,
      emit,
      log,
      // 可选项：有就给，没有就是 undefined
      sessions: typeof sessions === 'undefined' ? undefined : sessions,
      stickers: typeof stickers === 'undefined' ? undefined : stickers,
      sender: typeof sender === 'undefined' ? undefined : sender,
      onebot: typeof onebot === 'undefined' ? undefined : onebot,
      memory: typeof memory === 'undefined' ? undefined : memory,
      dataDir: typeof DATA_DIR === 'undefined' ? undefined : DATA_DIR,
      getConfig: typeof getConfig === 'undefined' ? undefined : getConfig,
      updateConfig: typeof updateConfig === 'undefined' ? undefined : updateConfig,
      // 老核心（0.4）有这两个函数；京玉版已经把「指令禁言」和「链接媒体转发」删掉了，
      // 这里自然为 undefined —— 调用处是 ?.，所以是"跳过"，不是"报错"。
      maybeTriggerCommandMute: typeof maybeTriggerCommandMute === 'undefined' ? undefined : maybeTriggerCommandMute,
      forwardLinkedMedia: typeof forwardLinkedMedia === 'undefined' ? undefined : forwardLinkedMedia
    });
    try {
      const dispatch = skillManager.getCapabilityProviders('command.dispatch')[0]?.fn;
      if (dispatch) {
        pluginHost = makePluginHost();
        const chatKey = `${kind}:${id}`;
        // 指令目录：只取「声明了 command 的插件」的清单元信息，不做可用性计算
        //（用 registry.list() 而不是 skillManager.list()，避免每条消息都跑一遍
        //  isActive 依赖链）。插件自己会用 api.hasCapability 判断能力是否可用。
        const catalog = skillManager.registry.list()
          .map((s) => ({
            id: s?.manifest?.id,
            name: s?.manifest?.name,
            commands: Array.isArray(s?.manifest?.commands) ? s.manifest.commands : [],
            // 消息入口拦截声明：{ capability, order }（见 manifest.js 的 normalizeIntercept）
            intercept: s?.manifest?.intercept || null
          }))
          .filter((s) => s.id && (s.commands.length || s.intercept));
        const decision = dispatch({
          text,
          segments,
          rawMessage: String(event.raw_message ?? (typeof event.message === 'string' ? event.message : '') ?? ''),
          messageId: event.message_id != null ? String(event.message_id) : '',
          kind,
          chatId: String(id),
          chatKey,
          senderId,
          senderName,
          catalog,
          ctx: {
            kind, chatId: String(id), chatKey,
            // 核心句柄：给「指令前置」把它包装成对外服务能力（ai.ask / search.web / history.read…）。
            // 插件不该自己 import src/，所以由核心在这一处把实例交出去。
            // chat 单独再给一份：链上的拦截者（比如隐私模式）要"用核心的模型链路问一次 AI"。
            onebot: pluginHost.onebot,
            sender: pluginHost.sender,
            store: pluginHost.store,
            memory: pluginHost.memory,
            log: pluginHost.log,
            emit: pluginHost.emit,
            host: pluginHost,
            chat: (messages, options = {}) => import('./llm.js').then((m) => m.chatCompletionWithRetry({
              messages,
              temperature: options.temperature ?? null,
              maxTokens: Number(options.maxTokens) || 0
            }))
          }
        });
        if (decision && decision.handled === true) {
          if (typeof decision.run === 'function') {
            Promise.resolve()
              .then(() => decision.run())
              .then((r) => releaseClaimed(kind, id, text, media, event, senderId, senderName, r))
              .catch((error) => pluginHost.log(`[指令前置] 执行失败：${error?.message ?? error}`));
          }
          return;
        }
      }
    } catch (error) {
      // 这条路径上"上游把符号删了"会让**每条消息**都进来一次 —— 只报第一次，
      // 之后静默按普通消息放行，别用同一行把日志淹掉（事故里的表现就是这样）。
      const once = (globalThis.__cgDispatchErrorLogged ||= { at: 0 });
      if (!once.at) {
        once.at = Date.now();
        log(`[指令前置] 分发失败，已按普通消息放行：${error?.message ?? error}`);
      }
    }

    /**
     * 「执行完后放行」：把已认领的消息按插件的要求放回正常聊天流程。
     * 独立成函数声明，是为了让上面那条 Promise 链在 try 块结束之后仍能调到它。
     * 顺序说明：指令的回复此刻多半已经发出并入档（appendSelf），这里补存的是
     * 用户那条原始消息 —— 存档时间用消息本来的时间，不用现在，避免历史错序。
     */
    function releaseClaimed(kind, id, text, media, event, senderId, senderName, result) {
      const pass = result ? result.passthrough : undefined;
      if (pass === undefined || pass === null || pass === false) return;
      let body;
      if (pass === true) {
        body = String(text ?? '');
      } else {
        body = String(pass).trim();
        if (!body) {
          log('[指令前置] 放行文本为空，已忽略本次放行');
          return;
        }
      }
      if (!pluginHost) pluginHost = makePluginHost();
      const chatKey = `${kind}:${id}`;
      // 指令禁言（0.4 的核心有；京玉版没有 → 跳过）
      if (kind === 'group') pluginHost.maybeTriggerCommandMute?.(id, body, event);
      pluginHost.store.appendIncoming(chatKey, {
        mid: event?.message_id,
        ts: event?.time ? Math.round(Number(event.time) * 1000) : Date.now(),
        senderId,
        senderName,
        text: body || '[图片]',
        media
      });
      pluginHost.emit('chat-update', chatKey);
      pluginHost.orchestrator.onIncoming(chatKey);
      // 链接媒体转发（0.4 的核心有；京玉版没有 → 跳过）
      pluginHost.forwardLinkedMedia?.(kind, id, body)?.catch?.(
        (e) => pluginHost.log(`[media] 链接转发失败：${e?.message ?? e}`)
      );
    }
    // ── [[/command-gateway:dispatch]] ──

    const incoming = store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    // 疑似重复（只报告、不丢消息）：同人同文 8 秒内、但 QQ 消息 id 不同 ——
    // 说明上游（SnowLuma/QQ）可能把同一条推了两遍，留个凭据以后好定位。
    if (incoming?.dupSuspect) {
      log(`[ingest] 疑似重复：${kind}:${id} ${senderName}「${String(text || '[图片]').slice(0, 40)}」`
        + ` 距上一条 ${incoming.dupGapMs}ms（mid ${incoming.dupPrevMid} → ${event.message_id}）`
        + `${incoming.dupMediaDiff ? '；两张的图片地址不同（可能是连发两张）' : ''}`);
    }
    // （2026-09-21 删掉"感知层进工作缓存"这一步：那份缓存只写不读，长时记忆本来就靠后台巩固）
    // 表层记忆：他说"我好累/在改插件/等外卖"这类近况，随手记一条（纯正则、零模型调用）。
    // 存进他自己的档案，随时间半衰；注入时带"几分钟前"，所以它不会变成永久设定。
    // 失败绝不影响收消息。
    if (!incoming?.self) {
      try {
        memory.captureSurface({
          userId: senderId,
          name: senderName,
          text: text || '',
          now: incoming?.ts || Date.now(),
          chatKey: `${kind}:${id}`
        });
      } catch { /* ignore */ }
    }
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 我们刚主动戳过对方时，OneBot/NapCat 可能把回显做成「对方拍了自己」或「对方戳我」。
    // 私聊尤其明显：戳完约 2 秒会出现「XX 拍了拍自己」。一律当回显丢掉。
    if (sender.recentlyPoked(`${isGroup ? 'group' : 'private'}:${id}`, 8000)) return;
    const selfId = onebot.selfId;
    // 私聊：部分实现不带 target_id。若我们刚主动拍过，直接丢，避免写成「拍了拍自己」。
    let targetId = String(event.target_id ?? '').trim();
    if (!isGroup) {
      if (!targetId) {
        // 无 target：默认成对端（通常是机器人）；再配合 recentlyPoked 过滤回显
        targetId = String(onebot.selfId || event.user_id || '');
      }
    } else if (!targetId) {
      targetId = String(event.user_id ?? '');
    }
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      // 拍的是机器人。私聊禁止写成「你拍了拍你」——模型会理解成自己拍自己。
      text = isGroup
        ? `[拍一拍] 你被${operatorName}拍了拍`
        : `[拍一拍] ${operatorName}拍了拍你（机器人）`;
    } else if (operatorId === targetId) {
      // 私聊「自己拍自己」在 OneBot 上经常是机器人主动戳的回显；上面 recentlyPoked 已挡大部分。
      // 若仍进来且是私聊，宁可不写也不写「自己拍自己」误导模型。
      if (!isGroup) return;
      text = `[拍一拍] ${operatorName}拍了拍${operatorName}自己`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = `[拍一拍] ${operatorName}拍了拍${targetName}`;
    }
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    // 自己发出的消息（回显）一律忽略：发送时已 appendSelf 留档，再走入站会形成
    // "看见自己上一条又触发一轮"的死循环/自我搭话。
    //
    // ⚠️ OneBot 的 self_id **恒等于机器人自己**，不是发送者，绝不能拿它当发送者过滤！
    // 发送者只看 user_id / sender.user_id。
    if (event.post_type === 'message_sent') return;
    if (event.post_type === 'message') {
      const senderUid = String(event.sender?.user_id ?? event.user_id ?? '');
      if (onebot.selfId && senderUid === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req, maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`请求体过大（>${Math.round(maxBytes / 1024 / 1024)}MB）`);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出），放行
    if (req.headers['x-console-token']) return true;

    const host = String(req.headers.host ?? '');
    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
    if (!isLoopbackHost) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        // 成本估算：命中官方价走官方价，否则用手填单价
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            warning: onebotWarning,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            warning: snowlumaWarning,
            whitelist: (getConfig().snowluma?.accountWhitelist || []).map(String),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          // 缓存保温链的实况：发了几棒、中了几棒、哪个会话还在接力。
          // 之前这个统计只存在内存里，UI 完全看不到，"保温到底跑没跑"只能靠猜。
          cacheKeepAlive: orchestrator.cacheKeepAliveStats(),
          // 插话闸门实况：最近一小时实际插了几次、各会话冷却/上限/热度。
          replyGate: orchestrator.replyGateStats(),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          localJev: localJevStatus(),
          botState: (() => {
            try { return botStateView(); } catch { return null; }
          })()
        });
      }

      // 本体状态：完整视图 / 手动改 / 重置
      if (pathname === '/api/bot-state' && method === 'GET') {
        return json(res, 200, botStateView());
      }
      if (pathname === '/api/bot-state' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        return json(res, 200, setBotState(body || {}));
      }
      // 生活系统只读快照（后台/排障用）：走能力查取，插件没开就是 available:false，不报错。
      // 世界观与日历（v0.4：没有作息状态了，只报今天是什么日子 + 当前世界观）
      if (pathname === '/api/life' && method === 'GET') {
        const grab = (name) => {
          for (const p of skillManager.getCapabilityProviders(name, {})) {
            try { return p.fn(); } catch { return undefined; }
          }
          return null;
        };
        const today = grab('life.today');
        if (today === null && grab('life.worldbook') === null) {
          return json(res, 200, { ok: true, available: false, error: '生活系统未开启' });
        }
        return json(res, 200, {
          ok: true,
          available: true,
          today,
          worldbook: grab('life.worldbook') ?? '',
          facts: grab('life.facts') ?? [],
          calendarFile: calendarFileMeta(),
          eventPoolEnabled: (() => {
            try {
              return skillManager.settingsOf?.('life-system')?.eventPoolEnabled === true;
            } catch { return false; }
          })()
        });
      }
      // 近况账本的调试操作：立刻按当前世界抽一条 / 清掉某个分组
      if (pathname === '/api/life' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const action = String(body?.action || '');
        const call = (name, args) => {
          for (const p of skillManager.getCapabilityProviders(name, {})) {
            try { return p.fn(args); } catch { return null; }
          }
          return null;
        };
        if (action === 'roll') {
          const r = call('life.roll', {});
          return json(res, 200, r ? { ok: true, ...r } : { ok: false, error: '世界与事件系统没开' });
        }
        if (action === 'clear') {
          const r = call('life.clear', { group: body?.group });
          return json(res, 200, r ? { ok: true, ...r } : { ok: false, error: '世界与事件系统没开' });
        }
        return json(res, 400, { ok: false, error: `未知 action: ${action}` });
      }
      // 情绪性格档：列表 + 切换（分享给群友只报 id）
      if (pathname === '/api/emotion-personalities' && method === 'GET') {
        return json(res, 200, {
          list: listEmotionProfiles(),
          current: getEmotionProfile().id
        });
      }
      if (pathname === '/api/emotion-personalities' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const { normalizeId } = await import('./emotion-personality.js');
        const id = normalizeId(String(body?.id || '').trim());
        if (!EMOTION_PROFILES[id]) {
          return json(res, 400, { error: `未知性格档 ${id}`, list: listEmotionProfiles() });
        }
        setPersonaEmotionProfile(id);
        return json(res, 200, { ok: true, current: getEmotionProfile().id });
      }

      // ── 多实例：我是谁 / 本机还有哪些实例（界面账号标签页用）──
      // ── 技能/插件：一键打开放置目录 ──
      if (pathname === '/api/skills/paths' && method === 'GET') {
        return json(res, 200, {
          root: ROOT,
          plugins: SKILL_DIRS.plugins,
          skills: SKILL_DIRS.skills
        });
      }
      if (pathname === '/api/skills/open-folder' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const kind = String(body?.kind || '').trim().toLowerCase();
        const id = String(body?.id || '').trim();
        const rootResolved = path.resolve(ROOT);
        let dir = '';

        if (id) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
            return json(res, 400, { ok: false, error: 'id 不合法' });
          }
          const st = listExtensionStatus().find((s) => s.id === id);
          const rel = String(st?.dir || '').replace(/\\/g, '/');
          if (rel === 'plugins' || rel.startsWith('plugins/') || rel === 'skills' || rel.startsWith('skills/')) {
            dir = path.resolve(rootResolved, rel);
          } else {
            for (const base of [SKILL_DIRS.plugins, SKILL_DIRS.skills]) {
              const p = path.join(base, id);
              if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { dir = p; break; }
            }
          }
        } else if (kind === 'plugins' || kind === 'skills') {
          dir = SKILL_DIRS[kind];
        } else if (kind === 'themes') {
          dir = path.join(rootResolved, 'themes');
        } else if (kind === 'root' || kind === 'app') {
          dir = rootResolved;
        } else {
          return json(res, 400, { ok: false, error: 'kind 需为 plugins / skills，或用 id 指定扩展' });
        }

        const resolved = path.resolve(dir || '');
        if (!resolved || (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep))) {
          return json(res, 400, { ok: false, error: '路径不在程序目录内' });
        }
        if (!fs.existsSync(resolved)) {
          try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) {
            return json(res, 500, { ok: false, error: `无法创建目录：${e?.message ?? e}` });
          }
        }
        try {
          if (process.platform === 'win32') {
            spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
          } else if (process.platform === 'darwin') {
            spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref();
          }
          return json(res, 200, { ok: true, path: resolved });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error), path: resolved });
        }
      }
      if (pathname === '/api/skills' && method === 'GET') {
        // hasPanel：插件目录里有没有 panel.html —— 界面据此决定要不要给"打开面板"按钮
        // （0.4/newer 那类插件自带面板；我们只负责把它显示出来）
        const skills = listExtensionStatus().map((s) => {
          let hasPanel = false;
          try { hasPanel = !!s.dir && fs.existsSync(path.join(ROOT, s.dir, 'panel.html')); } catch { /* ignore */ }
          return { ...s, hasPanel };
        });
        return json(res, 200, { skills });
      }
      // ── 插件自带面板（0.4/newer 那套插件会带 panel.html + injectApi）──
      // 我们不做 injectApi（那要改插件运行时），但**能把面板本身显示出来**：
      //   GET /api/plugin/<id>/panel          → 插件目录里的 panel.html
      //   GET /api/plugin/<id>/panel/<file>   → 面板用的静态资源（同目录，禁目录穿越）
      // 安全：只认注册表里已加载的扩展；解析后必须仍在该扩展目录内（realpath 双重校验）。
      const panelMatch = /^\/api\/plugin\/([a-z0-9._-]+)\/panel(?:\/([^/]*))?$/i.exec(pathname);
      if (panelMatch && method === 'GET') {
        const extId = panelMatch[1];
        const rel = panelMatch[2] ? decodeURIComponent(panelMatch[2]) : 'panel.html';
        const rec = skillManager.registry.get(extId);
        if (!rec?.dir) return json(res, 404, { ok: false, error: `没有这个扩展：${extId}` });
        if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.startsWith('.')) {
          return json(res, 400, { ok: false, error: '文件名不合法' });
        }
        try {
          const root = fs.realpathSync(rec.dir);
          const full = path.resolve(root, rel);
          if (full !== root && !full.startsWith(root + path.sep)) {
            return json(res, 400, { ok: false, error: '路径越界' });
          }
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            return json(res, 404, { ok: false, error: rel === 'panel.html' ? '这个插件没有自带面板（panel.html）' : `找不到 ${rel}` });
          }
          const ext = path.extname(full).toLowerCase();
          const type = ext === '.html' ? 'text/html; charset=utf-8'
            : ext === '.js' ? 'text/javascript; charset=utf-8'
              : ext === '.css' ? 'text/css; charset=utf-8'
                : ext === '.json' ? 'application/json; charset=utf-8'
                  : ext === '.png' ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                      : ext === '.svg' ? 'image/svg+xml'
                        : 'application/octet-stream';
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(fs.readFileSync(full));
          return true;
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/skills' && method === 'POST') {
        const body = await readBody(req);
        const id = String(body?.id || '').trim();
        if (!id) return json(res, 400, { error: '缺少 id' });
        const st = setExtensionEnabled(id, body?.enabled !== false, extensionContext());
        return json(res, 200, { skill: st });
      }
      // 保存技能参数（生活页用）：只认该技能 configSchema 声明过的键，防往配置塞任意字段；
      // secret 字段收到脱敏占位/空串视为"不修改"。写入即时生效（插件每轮 cfg() 实时读，无需热重载）。
      if (pathname === '/api/skills/settings' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body?.id || '').trim();
        if (!id) return json(res, 400, { error: '缺少 id' });
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 400, { error: `Skill 不存在：${id}` });
        const schema = (skill.manifest?.configSchema && typeof skill.manifest.configSchema === 'object')
          ? skill.manifest.configSchema : {};
        const incoming = (body?.settings && typeof body.settings === 'object') ? body.settings : {};
        const patch = {};
        for (const [k, v] of Object.entries(incoming)) {
          if (!(k in schema)) continue;
          if (schema[k]?.secret === true && (v === '******' || v === '')) continue;
          patch[k] = v;
        }
        setSkillConfig(id, patch);
        return json(res, 200, { ok: true, id, settings: skillManager.settingsView(id) });
      }
      if (pathname === '/api/instance-info' && method === 'GET') {
        return json(res, 200, selfDescriptor());
      }

      if (pathname === '/api/instances' && method === 'GET') {
        const list = await discoverInstances();
        return json(res, 200, { list });
      }

      // ── 成本看板：按天 / 按会话 / 按模型统计 ──
      // range: 'today'=今天0点起 | '24h'=最近24小时 | '3'|'7'|'14'|'30'=最近N天
      if (pathname === '/api/usage/stats' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 调试：一键清零用量/缓存统计（不删会话文件，只清台账+今日聚合+冷藏前缀）
      if (pathname === '/api/usage/reset' && method === 'POST') {
        try {
          const ledger = getUsageLedger();
          const r = ledger.resetForDebug();
          try {
            const todayFile = path.join(DATA_DIR, 'usage-today.json');
            fs.writeFileSync(todayFile, JSON.stringify({ dayKey: todayKey(), promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0, resetAt: Date.now() }), 'utf8');
          } catch { /* ignore */ }
          try {
            const coldDir = path.join(DATA_DIR, 'history-cold');
            if (fs.existsSync(coldDir)) {
              for (const f of fs.readdirSync(coldDir)) {
                if (f.endsWith('.json')) fs.unlinkSync(path.join(coldDir, f));
              }
            }
          } catch { /* ignore */ }
          try { sessions?.clearDailyUsage?.(); } catch { /* ignore */ }
          log('[usage] 调试清零：台账 + 今日聚合 + 历史冷藏');
          return json(res, 200, { ok: true, ...r, note: '统计已清零；历史冷藏已删，下一轮会重建。会话文件未删除。' });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 某个维度下的明细（点表格行时弹窗用）
      // dim: 'chat' | 'model' | 'day'  key: 对应值  by: 'day' | 'model' | 'chat'
      if (pathname === '/api/usage/breakdown' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/model-prices' && method === 'GET') {
        const model = String(url.searchParams.get('model') || getConfig().api?.model || '');
        return json(res, 200, {
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(model),
          remote: priceFeedStatus()   // 远程价格表状态（设置页展示：来源/时间/条目数/错误）
        });
      }

      // 手动触发一次远程价格表拉取（设置页「立即拉取」按钮）
      if (pathname === '/api/model-prices/refresh' && method === 'POST') {
        const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
        return json(res, 200, {
          ok: st.ok,
          remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/check-accounts' && method === 'POST') {
        // 立即跑一次"桥上账号白名单"检查（设置页那个按钮用它）
        const scan = await checkBridgeAccounts();
        const live = await scanBridgeAccounts();
        return json(res, 200, { ok: true, warning: snowlumaWarning, whitelist: live.whitelist, live: live.live, strangers: live.strangers });
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 自定义主题：内置预设 + themes/ 目录（规范见 themes/THEME_FORMAT.txt）──
      if (pathname === '/api/themes' && method === 'GET') {
        const { listThemes } = await import('./themes.js');
        return json(res, 200, {
          ok: true,
          dir: 'themes',
          current: getConfig().ui?.customThemeId || '',
          formatDoc: 'themes/THEME_FORMAT.txt',
          themes: listThemes()
        });
      }
      if (pathname === '/api/themes/import' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const { importTheme } = await import('./themes.js');
        try {
          const th = importTheme(String(body?.content || ''), { filename: String(body?.filename || '') });
          // 导入即应用：写 ui 配色 + custom 主题 + 主题 id
          updateConfig({
            ui: {
              ...(getConfig().ui || {}),
              theme: 'custom',
              customThemeId: th.id,
              customBg: th.colors.bg || '',
              customBg2: th.colors.bg2 || '',
              customAccent: th.colors.accent || '',
              customText: th.colors.text || '',
              customToolAccent: th.colors.toolAccent || th.colors.accent || ''
            }
          });
          return json(res, 200, { ok: true, theme: th });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) });
        }
      }
      if (pathname === '/api/themes/apply' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const { getThemeById } = await import('./themes.js');
        const id = String(body?.id || '').trim();
        const th = getThemeById(id);
        if (!th) return json(res, 404, { ok: false, error: '找不到主题：' + id });
        updateConfig({
          ui: {
            ...(getConfig().ui || {}),
            theme: 'custom',
            customThemeId: th.id,
            customBg: th.colors.bg || '',
            customBg2: th.colors.bg2 || '',
            customAccent: th.colors.accent || '',
            customText: th.colors.text || '',
            customToolAccent: th.colors.toolAccent || th.colors.accent || ''
          }
        });
        return json(res, 200, { ok: true, theme: th });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 显示目录提供商的真实 Key（本地 UI 点击“显示”用）
      // 明文密钥端点：仅放行本机控制台请求，挡住外部网页冒用（见 keyEndpointAllowed）。
      if (pathname === '/api/providers/key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }

      // 显示顶层 api.apiKey（手动模式、未选目录提供商时用）
      if (pathname === '/api/api-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }

      // 显示某个搜索服务的真实 Key（本地 UI 点击“显示”用）。
      // /api/config 里的搜索 Key 是脱敏的，所以“显示”必须走这里。
      if (pathname === '/api/search-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || '');
        // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
        // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        if (!allowed.includes(field)) {
          return json(res, 400, { error: `未知搜索服务：${field}` });
        }
        return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求。
      // apiKey 可省略：省略时由服务端自己解析真实 Key 使用（不外发给客户端），
      // 这样未配置 server.token 时"测试连通性"依然可用。
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const submitted = String(body.apiKey ?? '').trim();
          // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey,
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running });
      }

      // ── 表情包批量补备注（没备注的表情在提示词里没法被判断，等于永远用不上）──
      if (pathname === '/api/stickers/annotate' && method === 'GET') {
        const missing = stickers.unlabeled().length;
        return json(res, 200, { ...stickerAnnotate, missing, total: stickers.entries.length });
      }

      if (pathname === '/api/stickers/annotate' && method === 'POST') {
        if (stickerAnnotate.running) return json(res, 409, { ok: false, error: '已有一次补备注正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const limit = Math.max(1, Math.min(200, Number(body?.limit) || 60));
        const missing = stickers.unlabeled().length;
        if (!missing) return json(res, 200, { ok: true, started: false, note: '所有表情都有备注了，不用补。' });
        stickerAnnotate.running = true;
        stickerAnnotate.done = 0;
        stickerAnnotate.failed = 0;
        stickerAnnotate.total = Math.min(limit, missing);
        emit('sticker-annotate', { phase: 'start', total: stickerAnnotate.total });
        stickers.annotateMissing({
          limit,
          emit,
          onProgress: (n) => { stickerAnnotate.done = n; }
        })
          .then(({ done, failed }) => {
            stickerAnnotate.done = done.length;
            stickerAnnotate.failed = failed.length;
            emit('sticker-annotate', { phase: 'done', done: done.length, failed: failed.length });
            if (done.length) emit('chat-update', '');
          })
          .catch((error) => emit('sticker-annotate', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { stickerAnnotate.running = false; });
        return json(res, 202, { ok: true, started: true, total: stickerAnnotate.total });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      // ── 自定义搜索提供商（可添加多个，交互沿用模型提供商那套）──
      if (pathname === '/api/search-providers' && method === 'GET') {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          model: p.model,
          count: p.count,
          timeoutMs: p.timeoutMs,
          hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文
        }));
        return json(res, 200, { providers: list });
      }

      // 新增/更新：同 baseUrl + type 视为同一项，覆盖其配置
      if (pathname === '/api/search-providers' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // 掩码/空 = 保持原 Key 不变
            const submitted = String(body.apiKey ?? '').trim();
            if (submitted && submitted !== '******') existing.apiKey = submitted;
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type,
              baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, {
            ok: true,
            provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) }
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除一个自定义搜索提供商
      if (pathname === '/api/search-providers' && method === 'DELETE') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          // 若当前正选中被删的那项，回落 bing，避免搜索直接报错
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) {
            updateConfig({ webSearch: { provider: 'bing' } });
          }
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试某个自定义搜索提供商是否可用
      if (pathname === '/api/search-providers/test' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const body = await readBody(req).catch(() => ({}));
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, {
            ok: true,
            result: {
              ok: true,
              count: r.results.length,
              sample: r.results[0]?.title || '',
              latencyMs: Date.now() - startedAt
            }
          });
        } catch (error) {
          return json(res, 200, {
            ok: true,
            result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt }
          });
        }
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      // 本地 Jev：起停 / 试判（换模型或改角色后要 restart，否则 llama-server 还挂着旧 gguf）
      if (pathname === '/api/local-jev' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const action = String(body?.action || 'status');
        try {
          if (action === 'status') return json(res, 200, { ok: true, status: localJevStatus() });
          if (action === 'restart') {
            await stopLocalJev();
            const r = await ensureLocalJev({ log });
            return json(res, 200, { ok: !!r?.ok, reason: r?.reason || '', status: localJevStatus() });
          }
          // 一键拉起（顶栏「小模型」胶囊点的就是这个）：没启用就先启用 —— 点一下就该能用，
          // 不该让人先去设置页翻开关。已在跑则直接复用（ensure 本身是幂等的）。
          if (action === 'start') {
            let enabledIt = false;
            if (getConfig().localJev?.enabled !== true) {
              updateConfig({ localJev: { enabled: true } });
              enabledIt = true;
            }
            const r = await ensureLocalJev({ log });
            return json(res, 200, {
              ok: !!r?.ok,
              reason: r?.reason || '',
              enabled: true,
              enabledNow: enabledIt,
              status: localJevStatus()
            });
          }
          if (action === 'stop') {
            await stopLocalJev();
            return json(res, 200, { ok: true, status: localJevStatus() });
          }
          if (action === 'reset-stats') {
            resetLocalJevStats();
            return json(res, 200, { ok: true, status: localJevStatus() });
          }
          if (action === 'test') {
            const samples = Array.isArray(body?.samples) && body.samples.length
              ? body.samples.slice(0, 6)
              : [
                '来个灵梦图片',
                '你还记得我上次说要去日本吗',
                '发个表情包',
                '明天下雨记得带伞'
              ];
            const role = String(body?.role || 'imageWantsGate');
            const out = [];
            for (const s of samples) {
              const t0 = Date.now();
              const r = await jevGate(role, String(s).slice(0, 300), { timeoutMs: 6000 });
              out.push({ input: String(s).slice(0, 60), ...r, ms: Date.now() - t0 });
            }
            return json(res, 200, { ok: true, role, results: out, status: localJevStatus() });
          }
          return json(res, 400, { ok: false, error: `未知 action: ${action}` });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
        // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
        // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
        return json(res, 200, sanitizeConfig(cfgNow));
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        // 工具白名单变了 → 同步角色卡「可用工具」区（开的加、关的删）
        try {
          const { syncRoleToolsFromConfig } = await import('./tool-role-sync.js');
          const sync = syncRoleToolsFromConfig(patch);
          if (sync.changed && sync.roleText) {
            patch.persona = { ...(patch.persona || {}), roleText: sync.roleText };
          }
        } catch (error) {
          console.warn('[config] 同步角色卡工具区失败:', error?.message ?? error);
        }
        // 换角色卡时别把「## 自我印象」区顶掉 —— 那块是鱼自己的印象，存在 roleText 正文里，
        // 切一张卡等于整份替换，原来的印象就没了
        if (typeof patch.persona?.roleText === 'string') {
          try {
            const { carryOverSelfImpressions } = await import('./self-impressions.js');
            patch.persona = {
              ...patch.persona,
              roleText: carryOverSelfImpressions(cfgNow?.persona?.roleText || '', patch.persona.roleText)
            };
          } catch (error) {
            console.warn('[config] 保留自我印象失败:', error?.message ?? error);
          }
        }
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        store.setHotPerChat(next.store?.hotMessagesPerChat ?? DEFAULT_HOT_PER_CHAT);
        const p = next.proactive || {};
        if (p.enabled || p.privateIdleEnabled || p.privateScheduleEnabled) orchestrator.startProactiveLoop();
        else orchestrator.stopProactiveLoop();
        initPriceFeed(next.api?.priceRemoteUrl || '');   // 远程价格表 URL 可能改了（内部幂等）
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/hype-mode' && method === 'GET') {
        const { hypeStatus } = await import('./hype-mode.js');
        return json(res, 200, hypeStatus());
      }
      // 亢奋模式：只能手动切，不自动触发。切过去会换模型/协议/人设，情绪全部拉满
      if (pathname === '/api/hype-mode' && method === 'POST') {
        const body = await readBody(req);
        const on = body?.enabled === true || body?.on === true;
        const { setHypeMode, hypeStatus } = await import('./hype-mode.js');
        const r = await setHypeMode(on);
        // 亢奋开关顺带切 QQ 头像（失败不影响开关本身）
        let avatar = { switched: false };
        try {
          avatar = await switchHypeAvatar(onebot, on);
        } catch (error) {
          avatar = { switched: false, error: String(error?.message ?? error) };
        }
        emit('status', { configUpdated: true, hypeMode: r.enabled ?? on });
        return json(res, 200, { ...r, avatar, status: hypeStatus() });
      }

      // 切自己的 QQ 头像（NapCat / Lagrange 都叫 _set_qq_avatar，参数 file 支持 base64://）
      if (pathname === '/api/self-avatar' && method === 'POST') {
        const body = await readBody(req);
        let file = String(body?.file || '').trim();
        if (!file) return json(res, 400, { ok: false, error: '缺少 file：base64://… 或本地路径' });
        try {
          // 本地绝对/相对路径 → file://（SnowLuma loadBinarySource 认这个）
          if (!/^(https?:|base64:|data:|file:)/i.test(file)) {
            file = avatarFileArg(file);
          }
          let r = null;
          let used = '';
          for (const action of ['set_qq_avatar', '_set_qq_avatar']) {
            try {
              r = await onebot.call(action, { file }, 20000);
              used = action;
              break;
            } catch { /* try next */ }
          }
          if (!used) throw new Error('set_qq_avatar 失败');
          return json(res, 200, { ok: true, action: used, result: r ?? null });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        // 上限 2^20（Kondius 钦定 1048576）：约等于不限，但拦得住真正的失控请求。
        // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      /**
       * 一键清洗消息记录（人设区那个按钮）。
       *
       * 为什么需要（2026-09-22 用户反馈）：换人设之后，它还会被自己**旧人设时期的聊天记录**
       * 影响 —— 群里的上下文里全是老自称、老语气；而手动去删 data/messages、data/sessions 里的
       * 文件又删不干净（进程内存里那份还在，列表照样显示）。所以给一个"一句话清干净"的入口：
       *   ① 消息记录：data/messages/<会话>.json + data/messages-cold/<会话>.*.json
       *   ② 会话存档：data/sessions/<会话>.json（含用量台账里对应的行）
       * 正在运行的会话不动（避免把它半路的上下文抽掉）。
       */
      if (pathname === '/api/purge-records' && method === 'POST') {
        const body = await readBody(req);
        const all = body?.all === true || body?.scope === 'all';
        const chatKey = all ? null : String(body?.chatKey || '').trim();
        if (!all && !/^(group|private):\d+$/.test(chatKey)) {
          return json(res, 400, { ok: false, error: '需要合法的会话（group:群号 / private:QQ号），或 all=true' });
        }
        const wantMessages = body?.messages !== false;
        const wantSessions = body?.sessions !== false;
        const out = { ok: true, scope: all ? 'all' : chatKey };
        if (wantMessages) {
          out.messages = all ? store.purgeAll() : store.purgeChat(chatKey);
        }
        if (wantSessions) {
          out.sessions = sessions.purge({ chatKey, all });
        }
        console.log(`[purge] 清洗消息记录 scope=${out.scope} 消息=${JSON.stringify(out.messages || null)} 存档=${JSON.stringify(out.sessions || null)}`);
        emit('status', { purged: true });
        return json(res, 200, out);
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        // 附带群名，让 UI 能显示"群名（群号）"。
        // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
        // 拿不到的 chatName 为空，UI 自动退回只显示群号。
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))   // 3s 超时保护
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }

      // 记忆页：全局「人」列表（跨群印象）
      if (pathname === '/api/memory-files' && method === 'GET') {
        // 兼容旧前端：仍返回 files，但内容是全局人的摘要
        const people = memory.allMembers().map((m) => ({
          chatKey: `people:${m.userId || m.name}`,
          userId: m.userId,
          name: m.name,
          impressionCount: m.impressions.length,
          memberCount: 1,
          updatedAt: Number(m.updatedAt) || 0,
          consolidating: false
        }));
        return json(res, 200, {
          files: people,
          people,
          consolidating: [...orchestrator.consolidating],
          global: true
        });
      }

      // 本体「本鲸」自我印象：读写角色卡标记区（与工具区同机制）
      if (pathname === '/api/self-impressions' && method === 'GET') {
        const { getSelfImpressions } = await import('./self-impressions.js');
        return json(res, 200, {
          items: getSelfImpressions(),
          botName: getConfig().persona?.botName || '小鲸鱼'
        });
      }
      if (pathname === '/api/self-impressions' && method === 'POST') {
        try {
          const body = await readBody(req);
          const { addSelfImpression, removeSelfImpression, setSelfImpressions } = await import('./self-impressions.js');
          let r;
          if (Array.isArray(body.items)) {
            r = setSelfImpressions(body.items);
          } else if (body.remove != null) {
            r = removeSelfImpression(String(body.remove));
          } else if (body.add != null) {
            r = addSelfImpression(String(body.add));
          } else {
            return json(res, 400, { ok: false, error: '需要 items / add / remove' });
          }
          if (!r.ok) return json(res, 400, r);
          emit('status', { configUpdated: true });
          return json(res, 200, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/self-impressions' && method === 'DELETE') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const { removeSelfImpression } = await import('./self-impressions.js');
          const r = removeSelfImpression(String(body.text ?? body.remove ?? ''));
          if (!r.ok) return json(res, 400, r);
          emit('status', { configUpdated: true });
          return json(res, 200, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 全局人列表（新记忆页）
      if (pathname === '/api/memory-people' && method === 'GET') {
        const now = Date.now();
        const people = memory.allMembers().map((m) => ({
          userId: m.userId,
          name: m.name,
          impressions: m.impressions,
          // 表层记忆：还活着的近况（半衰后自动消失，所以这里只列活着的）
          surface: memory.liveSurface(m.userId, now),
          chats: (m.chats || []).map(String),
          favor: Number(m.favor ?? 50),
          attitude: m.attitude || '',
          updatedAt: m.updatedAt,
          lastConsolidatedAt: m.lastConsolidatedAt,
          ageDays: m.ageDays,
          stale: m.stale
        }));
        return json(res, 200, {
          people,
          total: people.length,
          impressions: people.reduce((n, p) => n + p.impressions.length, 0)
        });
      }

      // 记忆变更日志
      if (pathname === '/api/memory-audit' && method === 'GET') {
        const uid = url.searchParams.get('userId') || '';
        const limit = Number(url.searchParams.get('limit')) || 50;
        const { readAuditLog } = await import('./memory-audit.js');
        return json(res, 200, { rows: readAuditLog({ userId: uid, limit }) });
      }

      // 知识库：分类 + 条目（含原梗）
      if (pathname === '/api/knowledge' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const category = url.searchParams.get('category') || '';
        const { listKnowledge, expireStaleKnowledge } = await import('./memes.js');
        expireStaleKnowledge();
        return json(res, 200, listKnowledge({ q, category, limit: 200 }));
      }

      // ── 图库（与表情包分开；管理 UI 在知识库页）──
      if (pathname === '/api/images-lib' || pathname === '/api/images-lib/preview') {
        const {
          addImageLib, removeImageLib, listImageLib, imageLibCount,
          resolveImagePath, saveImageFromDataUrl, resolveLocalPreview
        } = await import('./image-lib.js');

        const imagePreviewUrl = (img) => {
          const src = String(img?.url || img?.localFile || '');
          if (/^https?:\/\//i.test(src)) return src;
          if (/^https?:\/\//i.test(resolveImagePath(img) || '')) return resolveImagePath(img);
          return `/api/images-lib/preview?id=${encodeURIComponent(img.id)}`;
        };

        if (pathname === '/api/images-lib' && method === 'GET') {
          const category = url.searchParams.get('category') || '';
          const limit = Number(url.searchParams.get('limit')) || 80;
          const images = listImageLib({ category, limit }).map((img) => ({
            ...img,
            preview: imagePreviewUrl(img),
            local: !/^https?:\/\//i.test(String(img.url || ''))
          }));
          return json(res, 200, { images, total: imageLibCount() });
        }

        if (pathname === '/api/images-lib' && method === 'POST') {
          try {
            // 10MB 图 base64 后约 13.7MB，上限放到 16MB
            const body = await readBody(req, 16 * 1024 * 1024);
            const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，]/))
              .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
            const note = String(body.note || '').slice(0, 160);
            const category = String(body.category || 'other');
            let urlOrPath = String(body.url || body.localPath || body.localFile || '').trim();
            if (!urlOrPath && body.dataUrl) {
              const saved = saveImageFromDataUrl(String(body.dataUrl));
              if (!saved.ok) return json(res, 400, { ok: false, error: saved.error });
              urlOrPath = saved.localFile;
            }
            if (!urlOrPath) return json(res, 400, { ok: false, error: '需要 图片文件 / 公网 URL / 本地路径' });
            const r = addImageLib({
              id: body.id || '',
              url: urlOrPath,
              localFile: body.dataUrl || !/^https?:\/\//i.test(urlOrPath) ? urlOrPath : String(body.localFile || ''),
              tags,
              note,
              category
            });
            if (!r.ok) return json(res, 400, { ok: false, error: r.error || '导入失败' });
            return json(res, 200, { ok: true, image: { ...r.image, preview: imagePreviewUrl(r.image) } });
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
        }

        if (pathname === '/api/images-lib' && method === 'DELETE') {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id || url.searchParams.get('id') || '');
          const ok = removeImageLib(id);
          return json(res, ok ? 200 : 404, { ok });
        }

        if (pathname === '/api/images-lib/preview' && method === 'GET') {
          const id = url.searchParams.get('id') || '';
          const fp = resolveLocalPreview(id);
          if (!fp) return json(res, 404, { ok: false, error: '本地图不存在' });
          const mimeOf = (p) => {
            const e = path.extname(p).toLowerCase();
            return e === '.png' ? 'image/png'
              : e === '.gif' ? 'image/gif'
                : e === '.webp' ? 'image/webp'
                  : 'image/jpeg';
          };
          try {
            const data = fs.readFileSync(fp);
            res.writeHead(200, {
              'content-type': mimeOf(fp),
              'cache-control': 'private, max-age=300',
              'content-length': data.length
            });
            res.end(data);
          } catch (error) {
            return json(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
      }

      // 成本护栏状态
      // API 情报：免费额度 / 降价 / 开放类资讯（按天缓存，可手动刷新）
      if (pathname === '/api/api-news' && method === 'GET') {
        try {
          const { getApiNews, apiNewsStatus } = await import('./api-news.js');
          const force = url.searchParams.get('force') === '1';
          const data = await getApiNews({ force });
          return json(res, 200, { ...data, status: apiNewsStatus() });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), items: [] });
        }
      }
      if (pathname === '/api/api-news' && method === 'POST') {
        try {
          const { refreshApiNews, apiNewsStatus } = await import('./api-news.js');
          const data = await refreshApiNews();
          return json(res, data.ok === false ? 500 : 200, { ...data, status: apiNewsStatus() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error), items: [] });
        }
      }

      if (pathname === '/api/cost-guard' && method === 'GET') {
        return json(res, 200, {
          ...costGuardStats(),
          enabled: getConfig().api?.costGuard?.enabled !== false,
          dayPromptMax: getConfig().api?.costGuard?.dayPromptMax ?? 800000,
          chatPromptMax: getConfig().api?.costGuard?.chatPromptMax ?? 200000,
          todos: activeTodos({ limit: 20 }).map((t) => ({
            text: t.text,
            userId: t.userId,
            leftMin: t.leftMin
          }))
        });
      }

      // 轻清理：合并同名 + 垃圾人 + 近重复印象（本地模型能做的两步也在里面，但不调云端）
      if (pathname === '/api/memory-people/cleanup' && method === 'POST') {
        try {
          const r = await memory.cleanupAll();
          emit('memory-update', { chatKey: '*', phase: 'cleanup', ...r });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 兼容旧梗库路由
      if (pathname === '/api/memes' && method === 'GET') {
        const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q') || '';
        const memes = listAllMemes({ q, limit: 120 });
        return json(res, 200, { memes, total: memeCount() });
      }
      if (pathname === '/api/memes' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const r = saveMeme({
          text: body.text,
          tags: body.tags,
          note: body.note,
          kind: body.kind
        });
        if (!r.ok) return json(res, 400, { ok: false, error: r.error || '保存失败' });
        return json(res, 200, { ok: true, meme: r.meme });
      }
      if (pathname === '/api/memes' && method === 'DELETE') {
        const body = await readBody(req).catch(() => ({}));
        const ok = removeMeme(String(body.text ?? ''));
        return json(res, ok ? 200 : 404, { ok });
      }
      // 知识库：钉住后不再被 30 天过期清理
      if (pathname === '/api/memes/pin' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const { setMemePinned } = await import('./memes.js');
        const r = setMemePinned(String(body.text ?? ''), body.pinned !== false);
        if (!r.ok) return json(res, 400, { ok: false, error: r.error || '失败' });
        return json(res, 200, r);
      }

      /**
       * 知识库导出：写进 data/ 下的文件并回路径。
       *
       * 为什么不让前端 <a download>：Electron 里那个不一定弹保存框（也可能静默失败），
       * 用户看到的又是"导出没反应"。写盘 + 回路径最实在，路径还能直接贴回去再导入。
       */
      if (pathname === '/api/memes/export' && method === 'POST') {
        try {
          const rows = listAllMemes({ q: '', limit: 5000 }) || [];
          const stamp = new Date().toISOString().slice(0, 10);
          const dir = path.join(DATA_DIR, 'knowledge-import');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `知识库导出-${stamp}.json`);
          const payload = rows.map((m) => ({
            text: m.text, kind: m.kind || 'meme', tags: m.tags || [], note: m.note || '',
            ...(m.pinned ? { pinned: true } : {})
          }));
          fs.writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8');
          return json(res, 200, { ok: true, file, count: payload.length });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      /**
       * 「读取目录里的文件」：把 data/knowledge-import/ 里所有 .txt/.json 拼成一段文本返回，
       * 前端照常预览 + 导入。给不喜欢点文件选择框的人一条路（也是用户明确要的"txt 放哪儿"）。
       */
      if (pathname === '/api/knowledge-import/read' && method === 'POST') {
        try {
          const dir = path.join(DATA_DIR, 'knowledge-import');
          fs.mkdirSync(dir, { recursive: true });
          const files = fs.readdirSync(dir).filter((f) => /\.(txt|json|md)$/i.test(f)).sort();
          const parts = [];
          for (const f of files) {
            try {
              let text = fs.readFileSync(path.join(dir, f), 'utf8');
              if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 记事本写的 BOM
              if (text.trim()) parts.push(text.trim());
            } catch { /* 单个文件读不了就跳过 */ }
          }
          return json(res, 200, { ok: true, dir, files, text: parts.join('\n') });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
      // 知识库页：测一下默认 wiki 源通不通
      if (pathname === '/api/external-lookup-test' && method === 'POST') {
        try {
          const { wikiLookup } = await import('./wiki.js');
          const body = await readBody(req).catch(() => ({}));
          const q = String(body.q || '东方Project').slice(0, 40) || '测试';
          const r = await wikiLookup(q, { limit: 1 });
          return json(res, 200, {
            ok: !!r.ok,
            label: r.label,
            hits: (r.results || []).length,
            error: r.error || null,
            first: (r.results || [])[0]?.title || null
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 一键整理：先合并同名/清垃圾，再逐会话强制整理
      if (pathname === '/api/memory-people/consolidate-all' && method === 'POST') {
        try {
          const merged = memory.mergeNameOnlyIntoUserIds();
          const purged = memory.purgeBadPeople();
          const chats = new Set(memory.listChats());
          for (const m of memory.allMembers()) {
            for (const c of m.chats || []) if (c) chats.add(c);
          }
          // 补上白名单会话，便于从聊天里新建印象
          for (const gid of getConfig().allow?.groups || []) chats.add(`group:${gid}`);
          for (const uid of getConfig().allow?.private || []) chats.add(`private:${uid}`);

          const list = [...chats].filter((c) => /^(group|private):\d+$/.test(c));
          emit('memory-update', { chatKey: '*', phase: 'consolidate-start', total: list.length });
          // 串行整理，避免同时打爆模型
          const okList = [];
          const failList = [];
          for (const chatKey of list) {
            if (orchestrator.consolidating.has(chatKey)) continue;
            orchestrator.consolidating.add(chatKey);
            try {
              emit('memory-update', { chatKey, phase: 'consolidate-start' });
              const r = await orchestrator.consolidateMemoryForChat(chatKey, { force: true });
              okList.push({ chatKey, changed: r?.changed ?? 0, note: r?.note || '' });
              emit('memory-update', { chatKey, phase: 'consolidate-done', ...(r || {}) });
            } catch (error) {
              failList.push({ chatKey, error: String(error?.message ?? error) });
              emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
            } finally {
              orchestrator.consolidating.delete(chatKey);
            }
          }
          emit('memory-update', { chatKey: '*', phase: 'consolidate-done', merged, purged, chats: list.length });
          return json(res, 200, {
            ok: true,
            merged,
            purged,
            chats: list.length,
            okList,
            failList
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 全局人：编辑 / 删除
      if (pathname === '/api/memory-people/all' && method === 'DELETE') {
        // 不提供一键清空，防误删；请用单人删除
        return json(res, 400, { ok: false, error: '请逐个删除成员' });
      }
      // 删除「只有名字、没有 QQ 号」的壳记录：管理页里数字路由删不掉的那些。
      // name 走 query 参数，避免中文/emoji 塞进路径的编码问题。
      if (pathname === '/api/memory-people/name-only' && method === 'DELETE') {
        const name = String(url.searchParams.get('name') || '').trim();
        if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
        const removed = memory.removeNameOnlyMember(name);
        emit('memory-update', { chatKey: '*', name });
        return json(res, 200, { ok: true, removed });
      }
      const personMatch = /^\/api\/memory-people\/(\d+)$/.exec(pathname);
      if (personMatch && method === 'PUT') {
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression('', {
            userId: personMatch[1],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? [],
            favor: body.favor,
            attitude: body.attitude
          });
          emit('memory-update', { chatKey: '*', userId: personMatch[1] });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (personMatch && method === 'DELETE') {
        memory.removeMember('', personMatch[1]);
        emit('memory-update', { chatKey: '*', userId: personMatch[1] });
        return json(res, 200, { ok: true });
      }
      // 表层记忆（近况）：手动清掉某人的（kind 省略 = 全清）。它本来就会自己半衰掉，
      // 这个入口是给"记错了/不想要"用的。
      const surfaceMatch = /^\/api\/memory-people\/(\d+)\/surface$/.exec(pathname);
      if (surfaceMatch && method === 'DELETE') {
        const removed = memory.clearSurface(surfaceMatch[1], url.searchParams.get('kind') || '');
        emit('memory-update', { chatKey: '*', userId: surfaceMatch[1] });
        return json(res, 200, { ok: true, removed });
      }

      const memoryFileMatch = /^\/api\/memory-files\/(group|private)_(\d+)$/.exec(pathname);
      if (memoryFileMatch && method === 'GET') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey)
        });
      }

      // 手动编辑某个群友的印象（PUT 编辑：QQ号必填，备注可同步保存 / DELETE 删除成员文件）
      const memoryMemberMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/.exec(pathname);
      if (memoryMemberMatch && method === 'PUT') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: memoryMemberMatch[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? [],
            attitude: body.attitude
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryMemberMatch && method === 'DELETE') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        memory.removeMember(chatKey, memoryMemberMatch[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }

      // 手动整理某个群的记忆：遍历聊天记录中出现的成员，逐人整理直到收敛
      if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

          // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
          // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
          const force = body.force !== false;

          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => {
              emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
            })
            .catch((error) => {
              emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
            })
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        // 单群消息上限 2^20（Kondius 钦定）：约等于不限，存档一口气全给
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply,
          // media 必须带：金句上传要靠它把图片 URL 传给服务器转存
          // （曾经漏了这个字段，前端收到的 media 永远是 undefined → 图片全丢）
          media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }

      // ── 金句上传取图：把存档消息里的图片转成 dataURL ──
      // 背景：存档只存图片 URL，而 QQ 图床的 rkey 会过期（失效后全网 400 invalid url，
      // 服务器转存必败、原图也救不回）。NapCat/SnowLuma 收到图时有本地缓存，
      // 走 OneBot get_image 拿缓存文件读出来，彻底不依赖 URL 时效。
      // POST { items: [{ file, url }] } → { results: [{ dataUrl } | null, ...] }
      const mediaDataMatch = pathname === '/api/media-data';
      if (mediaDataMatch && method === 'POST') {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);   // 不存在直接抛
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            // 路径 1：OneBot get_image → NapCat 本地缓存文件
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              // 有的实现返回的是可下载的 url
              if (!dataUrl && ret?.url) {
                const r = await fetch(String(ret.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
                  }
                }
              }
            } catch { /* 缓存没有就走下一条 */ }
            // 路径 2：直接拉存档里的 URL（新消息 URL 还没过期时有效）
            if (!dataUrl && it?.url) {
              try {
                const r = await fetch(String(it.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type')};base64,${buf.toString('base64')}`;
                  }
                }
              } catch { /* 过期就放弃，返回 null 让前端保留原 URL */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }

      // 群成员列表（OneBot get_group_member_list），用于备注与记忆页成员展示
      const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname);
      if (groupMembersMatch && method === 'GET') {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(groupMembersMatch[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 工具清单（给白名单开关页）+ 扩展（插件/技能）状态
      if (pathname === '/api/tools-list' && method === 'GET') {
        const { buildToolDefs } = await import('./tools.js');
        const { listTools } = await import('./tool-registry.js');
        const tools = buildToolDefs().map((d) => ({
          name: d.name,
          description: String(d.description || '').slice(0, 160),
          skillId: d.skillId || null
        }));
        const extensions = listExtensionStatus()
        .filter((s) => {
          const d = String(s.dir || '');
          // 只管理本仓库 plugins/、skills/ 目录下的扩展
          return !d || d === 'plugins' || d === 'skills' || d.startsWith('plugins/') || d.startsWith('skills/');
        })
        .map((s) => {
          const skillTools = [];
          try {
            for (const t of (listTools() || [])) {
              if (t && t.skillId === s.id) skillTools.push(t.id || t.name);
            }
          } catch { /* ignore */ }
          return {
            id: s.id,
            name: s.name,
            kind: s.kind || (String(s.dir || '').startsWith('plugins') ? 'plugin' : 'skill'),
            dir: s.dir || '',
            category: s.category || '',
            description: String(s.description || '').slice(0, 200),
            enabled: !!s.enabled,
            loaded: !!s.loaded,
            active: !!s.active,
            loadError: s.loadError || '',
            reason: s.reason || '',
            lastError: s.lastError || '',
            tools: skillTools,
            hasSettings: !!s.hasSettings,
            version: s.version || '',
            capabilities: Array.isArray(s.capabilities) ? s.capabilities : [],
            implementedCapabilities: Array.isArray(s.implementedCapabilities) ? s.implementedCapabilities : [],
            hooks: Array.isArray(s.hooks) ? s.hooks : [],
            settings: (s.settings && typeof s.settings === 'object') ? s.settings : {},
            configSchema: (s.configSchema && typeof s.configSchema === 'object') ? s.configSchema : {}
          };
        });
        return json(res, 200, {
          tools,
          enabled: getConfig().api?.tools || [],
          allEnabled: !Array.isArray(getConfig().api?.tools) || !getConfig().api.tools.length,
          extensions,
          docs: {
            pluginDir: 'plugins/<id>/',
            skillDir: 'skills/<id>/',
            rule: '规则能写死 → 插件（providers/hooks）；要模型理解人话 → 技能（registerTool）'
          }
        });
      }

      // 热重载：重读磁盘配置 + 重建工具 + 按需重连 OneBot（不关 Electron 窗口）
      if (pathname === '/api/hot-reload' && method === 'POST') {
        const body = await readBody(req);
        try {
          const result = await hotReload({ reconnectOneBot: body.reconnectOneBot !== false });
          return json(res, 200, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI


    // ── [[command-gateway:plugin-assets]] 「指令前置」插件自动维护，不要手改这一段 ──
    // 插件自带的静态资源：/plugin-assets/<插件id>/<文件>
    //
    // 用途：插件把自己的设置页模块（settings-ui.js）放在插件目录里，由控制台动态加载。
    // 安全约束与下面 UI 目录同一套，只是根目录换成「那个插件自己的目录」：
    //   1. 插件 id 必须对应一个**已注册**的插件（不存在的 id 直接 404，不猜路径）；
    //   2. 文件路径逐段校验，拒绝 ..、控制字符，拼好后再用 path.relative 二次确认没跳出目录；
    //   3. no-cache：插件文件是开发期会频繁改的东西，不能吃浏览器缓存。
    if (req.method === 'GET' && pathname.startsWith('/plugin-assets/')) {
      const rest = pathname.slice('/plugin-assets/'.length);
      const cut = rest.indexOf('/');
      let id = '';
      let file = '';
      try {
        id = decodeURIComponent(cut >= 0 ? rest.slice(0, cut) : '');
        file = decodeURIComponent(cut >= 0 ? rest.slice(cut + 1) : '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      const entry = id ? skillManager.registry.get(id) : null;
      const dir = entry?.dir ? path.resolve(ROOT, entry.dir) : '';
      const segs = file.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
      const bad = !entry || !dir || !segs.length
        || segs.some((s) => s === '..' || /[\x00-\x1f]/.test(s));
      const fullPath = bad ? '' : path.join(dir, ...segs);
      const relCheck = fullPath ? path.relative(dir, fullPath) : '..';
      if (bad || relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const assetTypes = {
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png'
        };
        res.writeHead(200, {
          'content-type': assetTypes[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache'
        });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    // ── [[/command-gateway:plugin-assets]] ──

    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 清掉历史崩溃留下的 *.tmp（实例锁在 server.js / electron 里已先拿到，
    // 所以这里不会误删并发实例正在写的文件）。实测一次能回收 1.5GB。
    try {
      const swept = sweepStaleTmp(DATA_DIR);
      if (swept.removed) log(`[启动] 清理遗留临时文件 ${swept.removed} 个（${(swept.bytes / 1048576).toFixed(0)}MB）`);
    } catch { /* 清扫失败不影响启动 */ }
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');
    listeningPort = port;

    // 后台对账用量台账：把历史会话补进小文件，之后用量页只读内存台账，零扫盘。
    setTimeout(() => {
      getUsageLedger().kickReconcile().catch(() => { /* 对账失败不影响启动 */ });
    }, 1500);

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    const wsPort = snowlumaWsPort();
    const portAlreadyOpen = await isPortOpen('127.0.0.1', wsPort);
    if (getConfig().snowluma?.autoLaunch && !portAlreadyOpen) {
      try {
        const r = await launchSnowluma();
        if (r.ok && r.launched) {
          for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }

    // ── SnowLuma 归属检查：别把"别人的" SnowLuma 当成自己的 ──
    // 端口上已经有 SnowLuma、却不是本实例拉起来的，而本实例的 SnowLuma 目录又还没登录过任何账号
    // → 基本可以断定那是另一份副本/另一个实例的 SnowLuma（例如机器上还跑着 qq-agent-v0.2）。
    // 连上去的后果是两个实例共用同一个 QQ 号、同一条消息被回复两遍。
    onebotWarning = '';
    if (portAlreadyOpen && !snowlumaProc && !snowlumaHasLogin(snowlumaDir())) {
      onebotWarning = `端口 ${wsPort} 上的 SnowLuma 不是本实例的（本实例的 SnowLuma 目录 ${snowlumaDir() || '（未找到）'} 还没登录过账号）。`
        + '如果那是另一份副本或另一个实例的 SnowLuma，两个实例会共用同一个 QQ 号、消息被回复两遍——'
        + '请在本实例的设置里换成自己的 SnowLuma 目录与端口（README「同时跑两个机器人」）。';
      log(`[snowluma] ⚠ ${onebotWarning}`);
    }

    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(c.snowluma?.accessToken || '');
      onebot.httpToken = String(c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '');
    }
    await onebot.connect();
    // 角色卡「可用工具」区跟当前工具表对账。
    // ⚠️ 2026-09-21：这份同步原来只在**改白名单**时跑（见 /api/config 的处理），于是
    //    tools.js / tool-role-sync.js 里更新了工具说明，跑着的实例还照旧把老文案念给模型。
    //    实测 38 行里 4 行过期（memory_query 的"按话题查"、memory_search 的"命中词"都在里面
    //    —— 那两处改动一直没进模型的眼睛）。现在启动对一次账，**只有真变了才写配置**。
    try {
      const { syncRoleToolsFromConfig, toolGuideDrift } = await import('./tool-role-sync.js');
      const cur = getConfig();
      const drift = toolGuideDrift(cur.persona?.roleText || '', cur.api?.tools ?? []);
      if (drift.length) {
        const sync = syncRoleToolsFromConfig({ api: { tools: cur.api?.tools ?? [] } });
        if (sync.changed && sync.roleText) {
          updateConfig({ persona: { roleText: sync.roleText } });
          log(`[tools] 角色卡「可用工具」区已按当前工具表刷新 ${drift.length} 行：`
            + drift.map((d) => `${d.name}(${d.kind === 'missing' ? '缺' : '过期'})`).join('、'));
        }
      }
    } catch (error) {
      log('[tools] 工具区对账失败（不影响运行）:', error?.message ?? error);
    }
    const pro = getConfig().proactive || {};
    if (pro.enabled || pro.privateIdleEnabled || pro.privateScheduleEnabled) orchestrator.startProactiveLoop();
    startBridgeAccountWatch();   // 定时检查桥上有没有挂着白名单外的号
    // 长期会话记忆：启动巩固一次 + 每 10 分钟增量（本地索引，不调模型）
    startConversationMemoryMaintenance({
      log,
      intervalMs: 10 * 60 * 1000,
      // 顺手清理人物表层记忆（半衰淡透的近况 + 只剩空壳的档案）
      onPruneSurface: () => memory.pruneSurface()
    });
    // 实例锁心跳：让别的进程能分辨"这个实例真的还在跑"还是"残留的锁"。
    // （2026-09-22：没有心跳时，被 taskkill 掉的 pid 会把新实例挡在门外，实测号B 连挂 5 次）
    try {
      const { startInstanceHeartbeat } = await import('./instance-lock.js');
      startInstanceHeartbeat(() => listeningPort || port);
    } catch { /* 心跳拿不到不影响运行 */ }
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    const jev = localJevStatus();
    if (jev.enabled) {
      log(`本地 Jev: ${jev.ready || jev.running ? '启动中/已就绪' : '未就绪'} @ ${jev.baseUrl} roles=${(jev.roles || []).join(',')}`);
    }
    return port;
  }

  /**
   * 热重载（软）：从磁盘重读 config，重建工具定义，按配置同步 OneBot 端点。
   * 不关 HTTP、不杀 Electron；适合改白名单/人设/模型后立刻生效。
   */
  async function hotReload({ reconnectOneBot = true } = {}) {
    const before = getConfig().api?.tools?.slice?.() ?? [];
    const cfg = reloadConfig();
    const toolInfo = orchestrator.refreshAfterConfigChange();
    const model = cfg.api?.model || '';
    const modelOk = !!model;

    let onebotReconnected = false;
    if (reconnectOneBot) {
      const wsUrl = String(cfg.snowluma?.wsUrl || onebot.wsUrl);
      const httpUrl = String(cfg.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      const accessToken = String(cfg.snowluma?.accessToken || '');
      const httpToken = String(cfg.snowluma?.httpAccessToken || accessToken);
      const urlChanged = wsUrl !== onebot.wsUrl || httpUrl !== onebot.httpUrl
        || accessToken !== onebot.accessToken || httpToken !== onebot.httpToken;
      onebot.wsUrl = wsUrl;
      onebot.httpUrl = httpUrl;
      onebot.accessToken = accessToken;
      onebot.httpToken = httpToken;
      try {
        if (urlChanged || reconnectOneBot === true) {
          await onebot.reconnect();
          onebotReconnected = true;
        }
      } catch (error) {
        log('[hot-reload] OneBot 重连失败:', error?.message ?? error);
      }
    }

    try {
      initPriceFeed(cfg.api?.priceRemoteUrl || '');
    } catch { /* 价格源失败不影响热重载 */ }

    // 表情库：配置里的开关/数量变了就丢掉同步缓存，下次列表再拉
    try {
      stickers.syncedAt = 0;
    } catch { /* ignore */ }

    log(`[hot-reload] 已重载配置：模型=${model || '未设置'} 工具=${toolInfo.toolCount} 白名单工具=${cfg.api?.tools?.length || '全开'}`);
    emit('hot-reload', { at: Date.now(), tools: toolInfo.toolCount, modelOk });
    emit('chat-update', '*');

    return {
      ok: true,
      at: Date.now(),
      model,
      modelOk,
      tools: toolInfo.tools,
      toolCount: toolInfo.toolCount,
      toolsWhitelist: Array.isArray(cfg.api?.tools) ? cfg.api.tools : null,
      conversationMemory: cfg.api?.conversationMemory?.enabled !== false,
      onebotReconnected
    };
  }

  async function stop() {
    stopConversationMemoryMaintenance();
    await orchestrator.abortAll();
    try { onebot.close(); } catch { /* ignore */ }
    // Node 18+：close() 只停 accept，keep-alive 连接会拖着进程不退。
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
    try { stopCrazyThursday(); } catch { /* ignore */ }
    try { stopApiNewsScheduler(); } catch { /* ignore */ }
    try { await stopLocalJev(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, conversationMemory, stickers, sender, sessions, orchestrator, start, stop, hotReload, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, checkBridgeAccounts, scanBridgeAccounts, get port() { return listeningPort; } };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/usage-ledger.ndjson（会话落盘时增量写入的台账），
 * 查询只读内存 Map —— 不再扫 data/sessions/*.json。
 * 历史缺口由后台 reconcile 补齐，不阻塞 API。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 路径：内存台账过滤 + 懒触发后台对账；请求本身从不等扫盘。
 */
async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  const ledger = getUsageLedger();
  // 首次访问若还没对账过，后台补历史；本请求立刻返回已有数据（可能还在 building）
  ledger.kickReconcile().catch(() => {});
  const { rows, searchCount, toolCounts, building, progress } = ledger.query(win);
  return { rows, win, searchCount, toolCounts, building, progress };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/**
 * 单次统计请求内的价格缓存。
 * resolveOfficialPrice 会对整张价表做前缀扫描；8000+ 行 × 4 遍分组合计
 * 会到几万次解析 —— 单价其实只有几十种模型，按 (vendor, model) 记一次就够。
 */
function createPriceCache() {
  const cache = new Map();
  return function cachedPriceOf(model, vendor) {
    const key = String(vendor || '') + ' ' + String(model || '');
    if (cache.has(key)) return cache.get(key);
    const p = priceOf(model, vendor);
    cache.set(key, p);
    return p;
  };
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows, getPrice = priceOf) {
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, creationTokens = 0, exactCalls = 0, hasPeakModel = false;
  const sessionIds = new Set();
  for (const r of rows) {
    const p = getPrice(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, created: p.created, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    // 显式缓存创建量已含在 prompt 里；优先用模型单列创建价，否则回退输入价×1.25。
    const creation = Math.min(Number(r.cacheCreationTokens) || 0, Math.max(0, prompt - cached));
    const fresh = Math.max(0, prompt - cached - creation);
    const creationPrice = Number(tier.created ?? (tier.in * 1.25)) || 0;
    const c = (fresh / 1_000_000) * tier.in
      + (creation / 1_000_000) * creationPrice
      + (cached / 1_000_000) * tier.cached
      + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    creationTokens += creation;
    if (r.exact) exactCalls += 1;
    if (r.sessionId) sessionIds.add(String(r.sessionId));
  }
  const sessions = sessionIds.size || (rows.length ? rows.length : 0);
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens, cacheCreationTokens: creationTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length, sessions,
    callsPerSession: sessions ? rows.length / sessions : 0,
    promptPerSession: sessions ? promptTokens / sessions : 0
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0, getPrice = priceOf) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list, getPrice) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
async function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts, building, progress } = await collectUsageRows({ range });
  const getPrice = createPriceCache();
  const totals = costOfRows(rows, getPrice);
  // 按天分桶需要 dayKey 字段（必须先补齐再 groupBy）
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  const byDay = win.mode === 'days'
    ? groupBy(rows, 'dayKey', 0, getPrice).map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0, getPrice);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0, getPrice).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    // 次数类统计：只看数量，不参与成本计算
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models,
    // 后台还在补历史台账时告诉前端（显示轻量提示，不挡数字）
    building: !!building,
    progress: progress || { done: 0, total: 0 }
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  const getPrice = createPriceCache();
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0, getPrice);
  const sum = costOfRows(subset, getPrice);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
