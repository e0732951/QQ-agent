// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 上部分显卡驱动会导致渲染进程黑屏，所以这里历史上默认关掉了硬件加速。
//
// ⚠️ 2026-09-22（用户反馈"deepseek 主题毛玻璃不开太丑，但要开就别卡"）：
//   软件渲染是所有"主题卡顿"的总放大器 —— deepseek 主题有一百多处 backdrop-filter、
//   机甲主题把 box-shadow 拿来做无限动画，全在 CPU 上算，一屏能明显掉帧。
//   上一版我的做法是"把毛玻璃关掉换性能"，用户否了（太丑）。
//   现在改成**默认开硬件加速**（这才是根因），软件渲染只作为黑屏时的兜底开关：
//       set QQ_AGENT_GPU=0        → 回到软件渲染（老显卡黑屏/花屏时用这个）
//       不设 / 设 1               → 走硬件加速（默认，毛玻璃与机甲特效都能留住）
//   UI 侧只保留"动画改成可合成属性"这类**看不出差别**的优化，不再删视觉效果。
const FORCE_SOFT = String(process.env.QQ_AGENT_GPU || '').trim() === '0';
if (FORCE_SOFT) {
  app.disableHardwareAcceleration();
  // 再补一层：部分环境即使用软渲仍黑屏
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HighTouchLatency');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const ICON_PATH = path.join(APP_ROOT, 'assets', 'icon.png');

// ── 多实例：QQ_AGENT_PROFILE=2（或 --qq-agent-profile=2）时，本实例与主实例完全隔离 ──
// 两种写法都支持：启动器 .bat 里设环境变量；开机自启走命令行参数（注册表项带不了环境变量）。
// 隔离的是：Electron 配置目录、数据目录（人设/白名单/存档/记忆）、控制台端口、OneBot 指向。
function resolveProfile() {
  const fromEnv = String(process.env.QQ_AGENT_PROFILE || '').trim();
  if (fromEnv) return fromEnv;
  const flag = process.argv.find((arg) => arg.startsWith('--qq-agent-profile'));
  if (!flag) return '';
  const inline = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : '';
  return String(inline || process.argv[process.argv.indexOf(flag) + 1] || '').trim();
}

const PROFILE = resolveProfile();
if (PROFILE) process.env.QQ_AGENT_PROFILE = PROFILE;
const INSTANCE_LABEL = PROFILE ? `QQ Agent ${PROFILE}` : 'QQ Agent';

// 每个实例一份 Electron 配置目录：避免两份共用 %APPDATA%\qq-agent 互相踩缓存，
// 单实例锁也跟着按实例分开——同一个实例依旧只能开一个（否则会双份连 OneBot 重复回复）。
// 没设 profile 时按"程序目录指纹"取名：同一台机器上解压出来的多份副本（qq-agent、qq-agent-v0.2…）
// 各自一份配置目录，互不抢锁，才能真正同时跑起来。
function instanceUserDataDir() {
  const base = app.getPath('appData');
  if (PROFILE) return path.join(base, `qq-agent-${PROFILE}`);
  const fingerprint = crypto.createHash('sha1').update(APP_ROOT.toLowerCase()).digest('hex').slice(0, 6);
  return path.join(base, `qq-agent-${fingerprint}`);
}

const USER_DATA_DIR = instanceUserDataDir();
app.setPath('userData', USER_DATA_DIR);

// ── 崩溃兜底 ──────────────────────────────────────────────────────────
// 核心服务器跑在**主进程**里（只有号B 是 src/server.js 子进程，那条路径本来就有兜底）。
// 主进程此前没挂任何异常处理，于是一次未捕获异常或未处理 rejection（OneBot 推送、
// 定时器、HTTP 回调里的 Promise 都算）就会把整个应用带走 —— 表现就是"开着开着自己闪退"，
// 而且不留现场：.bat 启动时 stdout 没人看。这里补两层：
//   1) 出什么事都往 crash.log 追加一行带堆栈的记录（含实例与 pid），事后可查；
//   2) 记完继续跑，不退出 —— 机器人"少处理一条消息"远好过"整个不见了"。
const CRASH_LOG = path.join(USER_DATA_DIR, 'crash.log');
const crashTimes = [];

function crashLog(kind, detail) {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    const stack = detail instanceof Error ? (detail.stack || detail.message) : String(detail ?? '');
    // 单文件封顶 512KB：掐掉较旧的一半，别把盘写满
    try {
      if (fs.statSync(CRASH_LOG).size > 512 * 1024) {
        // 按**字符数**取后一半：statSync().size 是字节数，而日志正文多为中文（3 字节/字），
        // 拿字节数去 slice 字符串会切错位置，保留量对不上。
        const text = fs.readFileSync(CRASH_LOG, 'utf8');
        const keep = text.slice(Math.floor(text.length / 2));
        fs.writeFileSync(CRASH_LOG, '…（更早的记录已截断）\n' + keep, 'utf8');
      }
    } catch { /* 还没有日志文件 */ }
    const msg = String(stack).replace(/\s+$/, '').slice(0, 4000) || '(无信息)';
    fs.appendFileSync(
      CRASH_LOG,
      `[${new Date().toISOString()}] ${INSTANCE_LABEL} pid=${process.pid} ${kind}\n${msg}\n\n`,
      'utf8'
    );
  } catch { /* 记录本身绝不能反过来弄崩应用 */ }
  try { console.error(`[${kind}]`, detail?.message ?? detail); } catch { /* ignore */ }
}

/** 10 秒内最多记 20 条：一个坏定时器反复抛错时，不至于把日志刷爆、CPU 全耗在写盘上。 */
function crashLimited() {
  const now = Date.now();
  while (crashTimes.length && now - crashTimes[0] > 10000) crashTimes.shift();
  crashTimes.push(now);
  return crashTimes.length > 20;
}

process.on('unhandledRejection', (reason) => {
  if (crashLimited()) return;
  crashLog('unhandledRejection（已忽略，继续运行）', reason);
});
process.on('uncaughtException', (error) => {
  if (crashLimited()) return;
  crashLog('uncaughtException（已捕获，继续运行）', error);
});
// 只记最后一行，用来区分"用户主动关的"（上面会有 requestQuit 记录）和"自己没的"
process.on('exit', (code) => {
  crashLog(`进程退出 code=${code}`, new Error('exit'));
});
app.on('child-process-gone', (_e, details) => {
  crashLog(`子进程消失 ${details?.type ?? ''} reason=${details?.reason ?? ''} code=${details?.exitCode ?? ''}`,
    JSON.stringify(details || {}));
});

// 桌面端偏好两号共享文件：号B 改了开机自启也要反映到系统登录项
const DESKTOP_PREFS_FILE = path.join(APP_ROOT, 'desktop-prefs.json');
let lastAutoStartPref = null;
let prefsWatched = false;   // applyAutoStart 会被托盘复选框反复调用，监听器只挂一次
function readSharedAutoStart() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DESKTOP_PREFS_FILE, 'utf8'));
    return parsed?.server?.autoStart === true;
  } catch {
    return null;
  }
}
function watchDesktopPrefs() {
  if (prefsWatched) return;
  try {
    if (!fs.existsSync(DESKTOP_PREFS_FILE)) return;
    prefsWatched = true;
    fs.watchFile(DESKTOP_PREFS_FILE, { interval: 1000 }, () => {
      const next = readSharedAutoStart();
      if (next !== null && next !== lastAutoStartPref) {
        lastAutoStartPref = next;
        try {
          const args = app.isPackaged ? [] : [app.getAppPath()];
          if (PROFILE) args.push(`--qq-agent-profile=${PROFILE}`);
          app.setLoginItemSettings({ openAtLogin: next, path: process.execPath, args });
          console.log('[desktop-prefs] 开机自启已同步:', next);
        } catch (e) {
          console.error('[desktop-prefs] 同步自启失败:', e?.message ?? e);
        }
      }
    });
  } catch { /* ignore */ }
}

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

// 数据目录运行标记：连数据目录都一样时（例如桌面端和 npm run server 撞在一起）挡住第二份，
// 免得同一个 QQ 号被两个进程同时接管、消息被回复两遍。多实例各用各的目录，互不影响。
const { acquireInstanceLock, releaseInstanceLock } = await import('../src/instance-lock.js');
const instanceLock = await acquireInstanceLock();
if (!instanceLock.ok) {
  console.error(`[instance] ${instanceLock.profile} 已在运行（pid=${instanceLock.pid}），本进程退出，避免同一 QQ 号被双份接管。`);
  console.error(`[instance] 确认没有其它实例在跑时，删掉这个文件再启动：${instanceLock.lockFile}`);
  app.exit(0);
}
if (instanceLock.tookOver) {
  console.error(`[instance] 接管了残留锁：pid=${instanceLock.tookOver.pid} 还在但不响应控制台（${instanceLock.tookOver.reason}）`);
}

let mainWindow = null;
let core = null;
let peerCore = null;     // 第二个账号的实例（QQ_AGENT_PROFILE=2），由本应用一起拉起/关闭
let tray = null;
let quitting = false;
let quitForceTimer = null;
let coreRestarting = false;
let navigatingAccount = false;   // 托盘主动切号：放行 will-prevent-unload，避免「离开此页面?」把 loadURL 卡住

/**
 * 退出应用：先走优雅退出，3 秒内没退成就强制结束。
 * 以前只调 app.quit()，若渲染进程 beforeunload（设置未保存）或
 * HTTP keep-alive 连接把退出流程卡住，托盘点「退出」会毫无反应。
 */
function requestQuit(reason = 'tray') {
  if (quitting) {
    // 已经在退出流程里再点一次 → 直接强杀，避免二次点击也无效
    try { app.exit(0); } catch { /* ignore */ }
    return;
  }
  quitting = true;
  console.log(`[quit] 开始退出（${reason}）…`);
  crashLog(`主动退出（${reason}）`, new Error('requestQuit'));

  // 1) 告诉渲染进程：别用 beforeunload 拦关窗（否则托盘退出会卡死）
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents
        .executeJavaScript('window.__APP_QUITTING__=true; try{state.settingsDirty=false;}catch(e){}', true)
        .catch(() => {});
    }
  } catch { /* ignore */ }

  // 2) 先拆托盘，避免退出过程中残留死图标
  try { tray?.destroy(); } catch { /* ignore */ }
  tray = null;

  // 3) 兜底强退
  if (quitForceTimer) clearTimeout(quitForceTimer);
  quitForceTimer = setTimeout(() => {
    console.warn('[quit] 优雅退出超时，强制结束进程');
    try { app.exit(0); } catch { /* ignore */ }
  }, 3000);
  try { quitForceTimer.unref?.(); } catch { /* ignore */ }

  app.quit();
}

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  // 优先读两号共享的 desktop-prefs（号B 里改的也生效）
  const shared = readSharedAutoStart();
  const open = shared !== null ? shared : !!cfg.server?.autoStart;
  lastAutoStartPref = open;
  // 桌面端是从程序目录直接跑的（未打包）：自启项要带上程序目录，多实例再带上自己的 profile，
  // 否则开机后只会拉起一个默认实例。
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (PROFILE) args.push(`--qq-agent-profile=${PROFILE}`);
  app.setLoginItemSettings({
    openAtLogin: open,
    path: process.execPath,
    args
  });
  watchDesktopPrefs();
}

/**
 * 如果存在第二个账号的数据目录（data-2/），就用同一份代码把它作为独立核心拉起来，
 * 于是"一个应用 = 两个账号"：两个核心各连各的 QQ 号，界面顶部用账号标签页切换。
 * 只在主实例（没有 QQ_AGENT_PROFILE）里做这件事，避免实例2 再拉起实例3。
 */
function startPeerCore() {
  if (PROFILE) return;
  if (!core) return;
  // ⚠️ 2026-09-22（用户反馈"双号脚本拉起第三个账号"）：
  //   双号脚本原来自己起两份 Electron —— 而主实例看到 data-2/config.json 存在时**也会**
  //   再拉一个账号2，于是同一个 data-2 上跑着两个进程（抢实例锁、抢端口），界面上看着
  //   像"多出来第三个账号"。现在双号脚本改成只起主实例，由这里把账号2 作为独立核心拉起：
  //   **一个窗口、两个账号标签页**，不会重复。
  //   QQ_AGENT_FORCE_PEER=1 是启动脚本显式要求"我就是要两个号"时用的（覆盖配置里
  //   server.autoStartPeer=false）；QQ_AGENT_NO_PEER=1 则相反，明确不要账号2。
  if (String(process.env.QQ_AGENT_NO_PEER || '').trim() === '1') return;
  const forcePeer = String(process.env.QQ_AGENT_FORCE_PEER || '').trim() === '1';
  if (!forcePeer && core.getConfig().server?.autoStartPeer === false) return;
  const peerDataDir = path.join(APP_ROOT, 'data-2');
  if (!fs.existsSync(path.join(peerDataDir, 'config.json'))) return;   // 没有第二个账号就不启
  if (peerCore) return;
  try {
    // ELECTRON_RUN_AS_NODE=1：让 electron.exe 以纯 Node 身份跑 headless 核心，
    // 不占额外窗口、也复用同一份 node_modules。
    peerCore = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'server.js')], {
      cwd: APP_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QQ_AGENT_PROFILE: '2', QQ_AGENT_DATA_DIR: peerDataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const prefix = '[账号2] ';
    const pipe = (stream) => stream.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(prefix + line);
    });
    pipe(peerCore.stdout);
    pipe(peerCore.stderr);
    peerCore.on('exit', (code, signal) => {
      console.log(`${prefix}核心已退出（code=${code ?? ''} signal=${signal ?? ''}）`);
      peerCore = null;
    });
    peerCore.on('error', (error) => {
      console.error(`${prefix}启动失败：${error?.message ?? error}`);
      peerCore = null;
    });
    console.log(`${prefix}已启动（pid=${peerCore.pid}，数据目录 ${peerDataDir}）`);
  } catch (error) {
    console.error('[账号2] 启动失败：', error?.message ?? error);
    peerCore = null;
  }
}

function stopPeerCore() {
  const proc = peerCore;
  peerCore = null;
  if (!proc) return;
  try { proc.kill(); } catch { /* ignore */ }
}

/**
 * 热重启核心：停掉 createApp 实例再原地拉起，窗口不关、Electron 不退。
 * 适合改了 JS 源码后要生效；改配置优先用 /api/hot-reload（软重载）。
 */
async function hotRestartCore(reason = 'tray') {
  if (coreRestarting) return;
  coreRestarting = true;
  try {
    console.log(`[hot-restart] 开始重启核心（${reason}）…`);
    if (core) {
      try { await core.stop(); } catch (error) {
        console.error('[hot-restart] stop 失败:', error?.message ?? error);
      }
    }
    // ⚠️ Node ESM 按完整 URL 缓存：`?t=` 只刷新 app.js 本身，
    // llm.js / tools.js 等稳定路径依赖仍可能是旧代码。
    // 改到这些文件后请**完全退出 Electron 再启动**，不要只靠热重启。
    const { createApp } = await import(`../src/app.js?t=${Date.now()}`);
    core = createApp({ log: (...args) => console.log(...args) });
    const port = await core.start();
    core.lastPort = port;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch(() => {});
    }
    createTray();
    console.log(`[hot-restart] 核心已重启，端口 ${port}`);
    console.log('[hot-restart] 提示：若刚改过 llm.js/tools.js，请完全退出 Electron 再启动（ESM 依赖缓存）');
  } catch (error) {
    console.error('[hot-restart] 失败:', error);
  } finally {
    coreRestarting = false;
  }
}

function showWindow() {  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  // 热重启会再次调用：必须先销毁旧托盘，否则 Windows 上留下
  // 一个没有菜单/点不动的僵尸图标，右键「退出」就像没反应。
  try { tray?.destroy(); } catch { /* ignore */ }
  tray = null;

  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(INSTANCE_LABEL);

  let autoStartOn = null;
  try { autoStartOn = readSharedAutoStart(); } catch { /* ignore */ }
  if (autoStartOn === null) {
    try { autoStartOn = !!core?.getConfig()?.server?.autoStart; } catch { autoStartOn = false; }
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示主界面（${INSTANCE_LABEL}）`, click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => {
      try { core?.orchestrator?.setPaused(!core.orchestrator.paused); } catch (e) { console.error('[tray] 暂停失败:', e?.message ?? e); }
    } },
    {
      label: '热重启核心（不关窗口）',
      click: () => { hotRestartCore('tray'); }
    },
    {
      label: '重载配置（软）',
      click: async () => {
        try {
          const port = core?.lastPort || core?.port || 3210;
          const r = await fetch(`http://127.0.0.1:${port}/api/hot-reload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reconnectOneBot: true })
          });
          console.log('[hot-reload] ', await r.text());
        } catch (error) {
          console.error('[hot-reload] 失败:', error?.message ?? error);
        }
      }
    },
    {
      label: '切换到号B控制台',
      click: async () => {
        try {
          const res = await fetch('http://127.0.0.1:3221/api/instance-info', { signal: AbortSignal.timeout(1500) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showWindow();
          // 切号前放行导航守卫：否则设置页有未保存改动时，loadURL 会撞上
          // 「离开此页面?」模态框被卡住，表现为「点了切不过去」。
          navigatingAccount = true;
          try {
            mainWindow?.webContents
              .executeJavaScript('window.__APP_NAVIGATING__=true; try{state.settingsDirty=false;}catch(e){}', true)
              .catch(() => {});
          } catch { /* ignore */ }
          mainWindow?.loadURL('http://127.0.0.1:3221/').catch((e) => { console.error('切号B失败:', e?.message ?? e); navigatingAccount = false; });
        } catch (error) {
          navigatingAccount = false;
          console.error('号B未在 3221 响应:', error?.message ?? error);
        }
      }
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoStartOn,
      click: (item) => {
        try {
          core?.updateConfig?.({ server: { autoStart: item.checked } });
          applyAutoStart();
        } catch (e) { console.error('[tray] 自启设置失败:', e?.message ?? e); }
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit('tray-menu') }
  ]));
  tray.on('double-click', () => showWindow());
}

let biliLoginWin = null;
let biliLoginBusy = false;

/** 从 .bilibili.com 会话里拼 Cookie 串（解析视频用 SESSDATA 等）。 */
async function collectBiliCookieString() {
  const cookies = await session.fromPartition('persist:bili-login').cookies.get({ domain: '.bilibili.com' });
  const need = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const map = new Map();
  for (const c of cookies) map.set(c.name, c.value);
  if (!map.get('SESSDATA')) return { cookie: '', hasSessdata: false };
  const parts = need.filter((k) => map.has(k)).map((k) => `${k}=${map.get(k)}`);
  // 顺带带上其它 bilibili 域 cookie，官方接口有时要一串
  for (const c of cookies) {
    if (need.includes(c.name)) continue;
    if (c.name === 'buvid3' || c.name === 'buvid4' || c.name === 'b_nut') {
      parts.push(`${c.name}=${c.value}`);
    }
  }
  return { cookie: parts.join('; '), hasSessdata: true, count: cookies.length };
}

function sendBiliStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bili:login-status', status);
  }
}

/**
 * 打开 B 站登录窗：登录成功后抓 SESSDATA 写入 config.webSearch.bilibiliCookie。
 * 不需要用户再从浏览器拷 Cookie。
 */
async function openBiliLoginWindow() {
  if (biliLoginBusy) return { ok: false, error: '已有登录窗在打开' };
  biliLoginBusy = true;
  sendBiliStatus({ phase: 'opening' });
  try {
    if (biliLoginWin && !biliLoginWin.isDestroyed()) {
      biliLoginWin.focus();
      biliLoginBusy = false;
      return { ok: true, phase: 'already-open' };
    }
    const ses = session.fromPartition('persist:bili-login');
    biliLoginWin = new BrowserWindow({
      width: 920,
      height: 720,
      title: '登录 B 站',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });
    Menu.setApplicationMenu(null);

    let saved = false;
    const trySave = async (reason) => {
      if (saved) return;
      const { cookie, hasSessdata } = await collectBiliCookieString();
      if (!hasSessdata || !cookie) return;
      saved = true;
      try {
        if (core?.updateConfig) {
          core.updateConfig({ webSearch: { bilibiliCookie: cookie } });
        }
        console.log(`[bili-login] 已写入 cookie（${cookie.length} 字符，来源 ${reason}）`);
        sendBiliStatus({ phase: 'saved', reason, at: Date.now() });
        if (biliLoginWin && !biliLoginWin.isDestroyed()) {
          setTimeout(() => { try { biliLoginWin.close(); } catch { /* ignore */ } }, 600);
        }
      } catch (error) {
        console.error('[bili-login] 写入配置失败:', error?.message ?? error);
        sendBiliStatus({ phase: 'error', error: String(error?.message ?? error) });
      }
    };

    const onCookieChanged = (_e, cookie, cause, removed) => {
      if (removed) return;
      if (cookie?.name === 'SESSDATA' && cookie?.domain?.includes('bilibili.com')) {
        trySave('cookie-changed');
      }
    };
    ses.cookies.on('changed', onCookieChanged);

    biliLoginWin.on('closed', () => {
      ses.cookies.removeListener('changed', onCookieChanged);
      biliLoginWin = null;
      biliLoginBusy = false;
      sendBiliStatus({ phase: saved ? 'saved' : 'closed' });
    });

    biliLoginWin.webContents.on('did-navigate', () => trySave('navigate'));
    biliLoginWin.webContents.on('did-navigate-in-page', () => trySave('navigate-in-page'));
    biliLoginWin.webContents.on('did-finish-load', () => trySave('did-finish-load'));

    await biliLoginWin.loadURL('https://passport.bilibili.com/login');
    sendBiliStatus({ phase: 'opened' });
    return { ok: true, phase: 'opened' };
  } catch (error) {
    biliLoginBusy = false;
    sendBiliStatus({ phase: 'error', error: String(error?.message ?? error) });
    return { ok: false, error: String(error?.message ?? error) };
  }
}

ipcMain.handle('bili:login', async () => openBiliLoginWindow());

// 标题栏系统按钮（最小化/最大化/关闭）：底色/图标色跟界面主题 + 亮度走
const TITLEBAR_OVERLAY_HEIGHT = 42;
const TITLEBAR_PRESETS = {
  // 与 ui/style.css 暗色 token 对齐（比系统默认再压一档）
  dark: { color: '#1c1c1f', symbolColor: '#ececf1' },
  light: { color: '#f0f0f3', symbolColor: '#1d1d1f' },
  // maid 液态玻璃顶栏渐变端色，系统按钮区与 #topbar 融为一体
  maid: { color: '#0c1830', symbolColor: '#eef4fb' }
};
function normalizeHexColor(val) {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    return s.slice(0, 7).toLowerCase();
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) {
    const hex = (n) => Math.min(255, Math.max(0, Number(n) || 0)).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return null;
}
function applyTitleBarOverlay(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform !== 'win32') return false;
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const preset = TITLEBAR_PRESETS[theme] || TITLEBAR_PRESETS.dark;
  const color = normalizeHexColor(opts.color) || preset.color;
  const symbolColor = normalizeHexColor(opts.symbolColor) || preset.symbolColor;
  try {
    mainWindow.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLEBAR_OVERLAY_HEIGHT
    });
    return true;
  } catch (error) {
    console.error('[titlebar] setTitleBarOverlay 失败:', error?.message ?? error);
    return false;
  }
}
ipcMain.handle('ui:set-titlebar', async (_e, opts) => applyTitleBarOverlay(opts || {}));
// 自绘窗口控制：系统 titleBarOverlay 压在网页之上，画不了鎏金线、也难与顶栏渐变对齐
ipcMain.handle('win:minimize', () => { mainWindow?.minimize(); return true; });
ipcMain.handle('win:maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('win:close', () => {
  // 与标题栏关闭同一路径：closeToTray 时 hide，真正退出走托盘
  mainWindow?.close();
  return true;
});
// 界面缩放：整页 zoomFactor，解决「卡牌/控件全是 px、不跟缩放」
function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.8, n));
}
ipcMain.handle('ui:set-zoom', async (_e, z) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.setZoomFactor(clampZoom(z));
    return true;
  } catch (error) {
    console.error('[zoom] setZoomFactor 失败:', error?.message ?? error);
    return false;
  }
});
ipcMain.handle('ui:get-zoom', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  try { return mainWindow.webContents.getZoomFactor() || 1; } catch { return 1; }
});

function createWindow(port) {
  // 本实例首页；账号胶囊切到号B后，加载失败不要无脑拽回号A
  const homeUrl = `http://127.0.0.1:${port}/`;
  // 允许在 3210~3239 控制台之间跳（账号标签页切换）
  const allowedNavRe = /^http:\/\/127\.0\.0\.1:32\d{2}\/?(\?.*)?$/;
  mainWindow = new BrowserWindow({
    // 以最小尺寸打开：不拉满屏幕、不最大化，需要时用户自己拖大。
    width: 960,
    height: 640,
    minWidth: 960,
    minHeight: 640,
    maximizable: true,
    fullscreenable: true,
    title: INSTANCE_LABEL,
    backgroundColor: '#1a1722',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    // 无边框标题 + UI 自绘窗口按钮（可与顶栏鎏金线贯通、与藏青渐变同色）
    // 不用系统 titleBarOverlay：它叠在网页上，颜色/金线都管不住
    titleBarStyle: 'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  Menu.setApplicationMenu(null);
  // ready-to-show 可能永远不来 → 1s 强制亮相；窗口默认 show:true 也兜底
  let shown = false;
  const showOnce = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showOnce);
  setTimeout(showOnce, 1000);
  mainWindow.webContents.on('did-finish-load', () => {
    showOnce();
  });
  // 加载超时也把窗口叫出来，避免一直黑屏
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) showOnce();
  }, 3000);
  // 账号切换：只放行本机控制台端口；其它导航（外链等）拦下
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedNavRe.test(String(url || ''))) {
      console.warn('[window] 已拦截导航:', url);
      event.preventDefault();
    }
  });
  // 程序化切号 / 退出时，渲染进程的 beforeunload 若 preventDefault，
  // Electron 默认会弹「离开此页面?」把导航/关窗卡死。这里对这两种主动行为放行。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    // ⚠️ Electron 该事件没有 allowUnload() 方法（2026-09-21 修：旧代码是幻觉 API，
    // 每次托盘退出/切号都抛 TypeError 进 crash.log，且 unload 未被真正放行，
    // 只能靠 requestQuit 的 3 秒强退计时器兜底）。放行 = preventDefault()：
    // 阻止「beforeunload 的阻止行为」，导航/关窗即被允许。
    if (quitting || navigatingAccount) event.preventDefault();
  });
  mainWindow.webContents.on('did-navigate', () => { navigatingAccount = false; });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const failed = String(url || '');
    // 切到号B失败：提示一下，**不要**强行 loadURL 回号A（以前会“点了没反应/弹回来”）
    if (failed && failed !== homeUrl && allowedNavRe.test(failed)) {
      console.error(`[window] 实例页加载失败: ${failed} (${code} ${desc})。可在浏览器打开该地址。`);
      return;
    }
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(homeUrl).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // 渲染进程没了以前只 console.error —— 而 .bat 启动时没人看得见，表现就是窗口白屏"卡死"
    crashLog(`渲染进程消失 reason=${details?.reason ?? ''} code=${details?.exitCode ?? ''}`, JSON.stringify(details || {}));
    if (quitting) return;
    setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(homeUrl).catch(() => {}); } catch { /* ignore */ }
    }, 1000);
  });
  mainWindow.webContents.on('unresponsive', () => {
    crashLog('渲染进程无响应（可能 OOM 或主线程死循环）', new Error('unresponsive'));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(homeUrl).catch((error) => console.error('[window] loadURL 失败:', error));
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    console.log(`[instance] ${INSTANCE_LABEL} · 数据目录 ${instanceLock.dir} · Electron 配置目录 ${USER_DATA_DIR}`);
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    await createWindow(port);
    applyAutoStart();
    createTray();
    startPeerCore();      // 有第二个账号（data-2/）就一起拉起来
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    app.exit(1);
  }
});

// 窗口全部真正关掉了（closeToTray 路径会 hide、不会走到这里）→ 直接退出。
app.on('window-all-closed', () => {
  requestQuit('window-all-closed');
});

app.on('before-quit', () => {
  quitting = true;
  try { releaseInstanceLock(); } catch { /* ignore */ }
  try { stopPeerCore(); } catch { /* ignore */ }
  // stop() 是 async：这里不 await，避免卡住 Electron 的退出序列；
  // 卡住时由 requestQuit 设的强制超时兜底。
  try {
    const p = core?.stop?.();
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[quit] core.stop 失败:', e?.message ?? e));
  } catch (e) {
    console.error('[quit] core.stop 异常:', e?.message ?? e);
  }
});
