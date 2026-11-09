// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}   // chatKey -> { note, at, failed? }
};

// 「手动添加提供商」的模型行：模块级保存。
// openModelAddModal（获取列表勾选）与 bindSettingsEvents（确认添加）都要用；
// loadSettings 会整段重渲染设置页，若只存在闭包里会被清空，
// 导致勾选完模型后点「确认添加」仍提示"请至少添加一个模型"。
let addProviderModelRows = [{ id: '', name: '' }];

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_image:        { name: '发网图',     cat: '发言',   icon: '🏞️' },
  image_lib_send:    { name: '发图库图',   cat: '发言',   icon: '🏞️' },
  send_music:        { name: '发音乐卡',   cat: '发言',   icon: '🎵' },
  send_bilibili:     { name: '转发B站',   cat: '发言',   icon: '📺' },
  send_forward:      { name: '发合并转发', cat: '发言',   icon: '📤' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看消息图',   cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  read_forward:        { name: '展开转发',   cat: '查看', icon: '↩️' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 图片
  search_images:     { name: '搜网图',     cat: '图片',   icon: '🔎' },
  image_lib_search:  { name: '搜图库',     cat: '图片',   icon: '🖼️' },
  identify_image:    { name: '识图认人',   cat: '图片',   icon: '🕵️' },
  // 记忆
  memory_append:     { name: '记印象',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查印象',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删印象',     cat: '记忆',   icon: '🧹' },
  memory_favor:      { name: '好感度',     cat: '记忆',   icon: '💗' },
  memory_search:     { name: '搜旧聊天',   cat: '记忆',   icon: '🕰' },
  memory_archive:    { name: '聊天归档',   cat: '记忆',   icon: '📦' },
  memory_meme_save:  { name: '存梗',       cat: '记忆',   icon: '😂' },
  memory_meme_search:{ name: '搜梗',       cat: '记忆',   icon: '😂' },
  memory_todo_save:  { name: '记待办',     cat: '记忆',   icon: '📌' },
  memory_todo_done:  { name: '完成待办',   cat: '记忆',   icon: '☑️' },
  external_lookup:   { name: '查百科设定', cat: '联网',   icon: '📖' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  parse_video:       { name: '解析B站',   cat: '联网',   icon: '📺' },
  search_bilibili:   { name: '搜B站',     cat: '联网',   icon: '🔎' },
  list_bili_fav:     { name: '看B站收藏夹', cat: '记忆', icon: '⭐' },
  search_music:      { name: '搜歌候选',   cat: '其他',   icon: '🔎' },
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '图片', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（暗/亮/系统/？）+ 独立的「自定义」开关
   dark/light 固定为经典 macOS 配色。
   自定义不再进主循环，也不进设置页主题格子 —— 顶栏单独一个 🎨 按钮开/关。
   ══════════════════════════════════════════════════════════════ */
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', custom: '🎨', '?': '❓' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', custom: '自定义', '?': '？' };
/** 主题按钮循环顺序：不含 custom */
const THEME_CYCLE = ['dark', 'light', 'system', '?'];
/** 合法存储值（含 custom，供读取校验） */
const THEME_VALUES = [...THEME_CYCLE, 'custom'];
/** 暗色 / 亮色的 macOS 默认色（自定义模式的回填默认值） */
const MACOS_DARK = { bg: '#1c1c1e', bg2: '#2c2c2e', accent: '#0a84ff', text: '#f5f5f7', toolAccent: '#ff9f0a' };
const MACOS_LIGHT = { bg: '#e4e4e8', bg2: '#f0f0f3', accent: '#007aff', text: '#1d1d1f', toolAccent: '#c93400' };
/**
 * 首次开启自定义时的起点色。
 * 不能直接用 MACOS_DARK —— 和暗色主题一模一样，用户点开会觉得「没反应」。
 * 这里故意拉开色相，一眼能看出自定义已生效，再去设置里改自己的色。
 */
const CUSTOM_START = {
  bg: '#0c0c0e',
  bg2: '#151517',
  bg3: '#222224',
  accent: '#f5a623',
  text: '#f4f4f5',
  toolAccent: '#ff7a00'
};

/**
 * 主题 / 自定义色：localStorage（本端口即时生效）+ 后端 ui 字段（两号互通的权威来源）。
 * 以前还写 127.0.0.1 跨端口 Cookie，会把号A/号B 的偏好搅在一起；
 * 现在统一走 config.js 的 desktop-prefs.json，两号设一次都生效，但不再用 Cookie 旁路。
 */
function clearColorCookies() {
  ['qqa-bg', 'qqa-bg2', 'qqa-accent', 'qqa-text', 'qqa-tool-accent', 'qqa-theme'].forEach((n) => {
    try {
      document.cookie = `${n}=; path=/; max-age=0`;
      document.cookie = `${n}=; path=/; max-age=0; domain=127.0.0.1`;
    } catch { /* ignore */ }
  });
}

/** 读出保存的自定义色（不自动应用到页面）。后端 ui 字段优先，其次本端口 localStorage。 */
function readCustomColors(cfg) {
  let bg = '', bg2 = '', accent = '', text = '', toolAccent = '';
  if (cfg?.ui) {
    bg = String(cfg.ui.customBg || '');
    bg2 = String(cfg.ui.customBg2 || '');
    accent = String(cfg.ui.customAccent || '');
    text = String(cfg.ui.customText || '');
    toolAccent = String(cfg.ui.customToolAccent || '');
  }
  try {
    if (!bg) bg = localStorage.getItem('qqa-bg') || '';
    if (!bg2) bg2 = localStorage.getItem('qqa-bg2') || '';
    if (!accent) accent = localStorage.getItem('qqa-accent') || '';
    if (!text) text = localStorage.getItem('qqa-text') || '';
    if (!toolAccent) toolAccent = localStorage.getItem('qqa-tool-accent') || '';
  } catch { /* ignore */ }
  return { bg, bg2, accent, text, toolAccent };
}

function loadCustomColors(cfg) {
  const cur = readCustomColors(cfg);
  // 只有自定义主题才盖 CSS 变量；暗/亮/系统完全交给经典 macOS token
  if (getThemePref() === 'custom') applyCustomColors(cur);
  else applyCustomColors({ bg: '', bg2: '', accent: '', text: '', toolAccent: '' });
  return cur;
}

function applyCustomColors({ bg = '', bg2 = '', accent = '', text = '', toolAccent = '' } = {}) {
  const root = document.documentElement;
  // 液态玻璃（maid）/ 像素（pixel）：token 锁死主题色，忽略被改坏的 customText
  const themeId = String(state?.config?.ui?.customThemeId || '').toLowerCase();
  const maidOn = root.getAttribute('data-ui-style') === 'maid'
    || (getThemePref() === 'custom' && MAID_UI_IDS.has(themeId));
  const pixelOn = root.getAttribute('data-ui-style') === 'pixel'
    || (getThemePref() === 'custom' && PIXEL_UI_IDS.has(themeId));
  const mechOn = root.getAttribute('data-ui-style') === 'mech'
    || (getThemePref() === 'custom' && MECH_UI_IDS.has(themeId));
  if (maidOn) {
    const m = THEME_PRESET_MAID.colors;
    bg = m.bg; bg2 = m.bg2; accent = m.accent; text = m.text; toolAccent = m.toolAccent;
  } else if (pixelOn) {
    const p = THEME_PRESET_PIXEL.colors;
    bg = p.bg; bg2 = p.bg2; accent = p.accent; text = p.text; toolAccent = p.toolAccent;
  } else if (mechOn) {
    const c = THEME_PRESET_MECH.colors;
    bg = c.bg; bg2 = c.bg2; accent = c.accent; text = c.text; toolAccent = c.toolAccent;
  }
  const set = (name, val) => {
    if (val) root.style.setProperty(name, val);
    else root.style.removeProperty(name);
  };
  set('--bg', bg);
  set('--bg-2', bg2);
  set('--bg-3', bg ? `color-mix(in srgb, ${bg} 88%, #ffffff)` : '');
  set('--accent', accent);
  set('--text', text);
  set('--tool-accent', toolAccent || accent || '');
  if (text) {
    root.style.setProperty('--muted', `color-mix(in srgb, ${text} 62%, transparent)`);
    root.style.setProperty('--faint', `color-mix(in srgb, ${text} 42%, transparent)`);
  } else {
    root.style.removeProperty('--muted');
    root.style.removeProperty('--faint');
  }
  if (accent) {
    root.style.setProperty('--hover', `color-mix(in srgb, ${accent} 10%, transparent)`);
    root.style.setProperty('--active', `color-mix(in srgb, ${accent} 16%, transparent)`);
  } else {
    root.style.removeProperty('--hover');
    root.style.removeProperty('--active');
  }
  // 底色变了就按当前亮度重算（只动 --bg*，不碰 accent/text）
  themeBaseBg = null;
  if (typeof applyBrightness === 'function') applyBrightness(getBrightnessPref());
}

/** 读取当前主题设置：localStorage 立即生效，后端 ui.theme（两号互通）在 boot 时覆盖。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

function saveCustomColorsToStorage(v) {
  const pairs = [
    ['qqa-bg', v.bg],
    ['qqa-bg2', v.bg2],
    ['qqa-accent', v.accent],
    ['qqa-text', v.text],
    ['qqa-tool-accent', v.toolAccent]
  ];
  for (const [k, val] of pairs) {
    try { localStorage.setItem(k, val || ''); } catch { /* ignore */ }
  }
}

/** 界面亮度：70~130，100=默认。
 * 不用 filter:brightness() —— 那会让整页每帧 GPU 重合成，Electron 里明显卡顿。
 * 改为只缩放 --bg / --bg-2 / --bg-3（往黑/往白插值），开销接近 0。 */
function clampBrightness(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.min(130, Math.max(70, Math.round(v)));
}
function getBrightnessPref() {
  try {
    const v = Number(localStorage.getItem('qqa-brightness'));
    if (Number.isFinite(v) && v >= 70 && v <= 130) return Math.round(v);
  } catch { /* ignore */ }
  const cfg = Number(state?.config?.ui?.brightness);
  return clampBrightness(cfg || 100);
}

/** 界面缩放 %：80~200，100=默认。
 * Electron 用 webContents.setZoomFactor 整页等比（含写死 px 的卡牌）；
 * 非 Electron 预览回落 CSS zoom + --ui-scale。 */
function clampUiScale(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.min(200, Math.max(80, Math.round(v / 5) * 5));
}
function getUiScalePref() {
  try {
    const v = Number(localStorage.getItem('qqa-uiscale'));
    if (Number.isFinite(v) && v >= 80 && v <= 200) return clampUiScale(v);
  } catch { /* ignore */ }
  return clampUiScale(state?.config?.ui?.uiScale ?? 100);
}
function applyUiScale(pct) {
  const p = clampUiScale(pct);
  const factor = p / 100;
  try { localStorage.setItem('qqa-uiscale', String(p)); } catch { /* ignore */ }
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(factor));
  // Electron：整页 zoom，卡牌/按钮/间距一起放大
  if (window.qqAgent?.setZoomFactor) {
    window.qqAgent.setZoomFactor(factor);
  } else {
    // 预览/浏览器：CSS zoom 兜底（布局也会等比）
    try { root.style.zoom = String(factor); } catch { /* ignore */ }
  }
  const hint = $('#cfg-uiscale-val');
  if (hint) hint.textContent = p + '%';
  return p;
}
function parseCssColor(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}
function scaleLumaRgb(rgb, factor) {
  const [r, g, b] = rgb;
  if (factor <= 1) {
    return [r * factor, g * factor, b * factor];
  }
  const t = Math.min(0.35, factor - 1);
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
}
function rgbToCss([r, g, b]) {
  return `rgb(${Math.round(Math.min(255, Math.max(0, r)))}, ${Math.round(Math.min(255, Math.max(0, g)))}, ${Math.round(Math.min(255, Math.max(0, b)))})`;
}
/** 把 #hex / rgb() 转成 electron titleBarOverlay 能吃的 #rrggbb；转不了返回 null。 */
function cssColorToHex(input) {
  const rgb = parseCssColor(input);
  if (!rgb) return null;
  const h = (n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
/** 右上角最小化/最大化/关闭：底色跟 --bg-2（含亮度缩放）走，否则那排按钮会「不吃亮度」。
    maid 液态玻璃：顶栏是藏青渐变，overlay 必须锁同一色，否则系统按钮区会发灰割裂。 */
function syncTitleBarFromTheme() {
  try {
    if (!window.qqAgent?.setTitleBarOverlay) return;
    const root = document.documentElement;
    if (root.getAttribute('data-ui-style') === 'maid') {
      window.qqAgent.setTitleBarOverlay({
        theme: 'dark',
        color: '#0c1830',
        symbolColor: '#eef4fb'
      });
      return;
    }
    if (root.getAttribute('data-ui-style') === 'pixel') {
      // 像素顶栏实心夜蓝 + 琥珀底线；overlay 若仍启用则同色，避免按钮区发灰
      window.qqAgent.setTitleBarOverlay({
        theme: 'dark',
        color: '#1a2438',
        symbolColor: '#f0ebe2'
      });
      return;
    }
    if (root.getAttribute('data-ui-style') === 'mech') {
      window.qqAgent.setTitleBarOverlay({
        theme: 'dark',
        color: '#0c0c0e',
        symbolColor: '#f4f4f5'
      });
      return;
    }
    const actual = resolveTheme(getThemePref());
    const themeName = actual === 'light' ? 'light' : 'dark';
    const cs = getComputedStyle(document.documentElement);
    const bg2 = (cs.getPropertyValue('--bg-2') || '').trim();
    const text = (cs.getPropertyValue('--text') || '').trim();
    window.qqAgent.setTitleBarOverlay({
      theme: themeName,
      symbolColor: cssColorToHex(text) || undefined,
      color: cssColorToHex(bg2) || undefined
    });
  } catch { /* 非 Electron 或失败时忽略 */ }
}
/** 当前主题未叠加亮度时的底色（在 applyTheme / 自定义配色后刷新）。 */
let themeBaseBg = null;
function captureThemeBaseBg() {
  const root = document.documentElement;
  const keys = ['--bg', '--bg-2', '--bg-3'];
  const inline = {};
  for (const k of keys) {
    inline[k] = root.style.getPropertyValue(k);
    root.style.removeProperty(k);
  }
  const cs = getComputedStyle(root);
  const fromCss = {};
  for (const k of keys) fromCss[k] = cs.getPropertyValue(k).trim();
  // 自定义主题：未缩放的基准 = 用户配色（不是 stylesheet 兜底）
  if (getThemePref() === 'custom') {
    const cur = readCustomColors(state?.config);
    const start = (cur.bg || cur.bg2 || cur.accent || cur.text) ? cur : CUSTOM_START;
    if (start.bg) fromCss['--bg'] = start.bg;
    if (start.bg2) fromCss['--bg-2'] = start.bg2;
    if (!start.bg2 && start.bg) {
      // 没有卡片色时用背景混一点白/黑作 bg2/bg3，与 applyCustomColors 接近
      const rgb = parseCssColor(start.bg);
      if (rgb) {
        fromCss['--bg-2'] = rgbToCss([
          rgb[0] * 0.88 + 255 * 0.12,
          rgb[1] * 0.88 + 255 * 0.12,
          rgb[2] * 0.88 + 255 * 0.12
        ]);
        fromCss['--bg-3'] = rgbToCss([
          rgb[0] * 0.75 + 255 * 0.25,
          rgb[1] * 0.75 + 255 * 0.25,
          rgb[2] * 0.75 + 255 * 0.25
        ]);
      }
    }
  }
  themeBaseBg = fromCss;
  // inline 里若有未缩放的自定义底色，保留给 applyBrightness 以外的路径；亮度会再盖一层
  for (const k of keys) {
    if (inline[k] && getThemePref() === 'custom' && k === '--bg' && inline[k] && !themeBaseBg[k]) {
      themeBaseBg[k] = inline[k];
    }
  }
  return themeBaseBg;
}
function applyBrightness(n) {
  const b = clampBrightness(n);
  try { localStorage.setItem('qqa-brightness', String(b)); } catch { /* ignore */ }
  const root = document.documentElement;
  // 永远清掉 filter（旧版本留下的），避免合成层卡顿
  root.style.removeProperty('filter');
  if (!themeBaseBg) captureThemeBaseBg();
  const factor = b / 100;
  const keys = ['--bg', '--bg-2', '--bg-3'];
  if (b === 100) {
    if (getThemePref() === 'custom') {
      const cur = readCustomColors(state?.config);
      const start = (cur.bg || cur.bg2 || cur.accent || cur.text) ? cur : CUSTOM_START;
      if (start.bg) root.style.setProperty('--bg', start.bg);
      else root.style.removeProperty('--bg');
      if (start.bg2) root.style.setProperty('--bg-2', start.bg2);
      else if (start.bg) {
        const rgb = parseCssColor(start.bg);
        if (rgb) {
          root.style.setProperty('--bg-2', rgbToCss([
            rgb[0] * 0.88 + 255 * 0.12,
            rgb[1] * 0.88 + 255 * 0.12,
            rgb[2] * 0.88 + 255 * 0.12
          ]));
        } else root.style.removeProperty('--bg-2');
      } else root.style.removeProperty('--bg-2');
    } else {
      for (const k of keys) root.style.removeProperty(k);
    }
  } else {
    for (const k of keys) {
      const rgb = parseCssColor((themeBaseBg || {})[k] || '');
      if (rgb) root.style.setProperty(k, rgbToCss(scaleLumaRgb(rgb, factor)));
    }
  }
  const hint = $('#cfg-brightness-val');
  if (hint) hint.textContent = b + '%';
  // 右上角窗口按钮（最小化/最大化/关闭）也吃亮度：叠层颜色跟当前 --bg-2
  syncTitleBarFromTheme();
  return b;
}

/** 走整套机甲 UI 形态的主题 id（不只是换色）。 */
const MECH_UI_IDS = new Set(['mech-orange', 'mech', 'mech-black-orange']);
const MAID_UI_IDS = new Set(['deepseek-maid', 'ds-maid', 'maid-deepseek', 'deepseek']);
/** 像素风「白京玉 · 像素夜」：硬边框 + 暖琥珀灯火，不走液态玻璃。 */
const PIXEL_UI_IDS = new Set(['bijingyu-pixel', 'bijingyu', 'pixel-jade', 'baijingyu-pixel', 'pixel-bijingyu']);

const THEME_PRESET_MECH = {
  id: 'mech-orange',
  name: '机甲 · 黑橙',
  colors: {
    bg: '#0c0c0e',
    bg2: '#151517',
    bg3: '#222224',
    accent: '#f5a623',
    toolAccent: '#ff7a00',
    text: '#f4f4f5',
    muted: '#a8a8ad',
    faint: '#6e6e73'
  }
};
const THEME_PRESET_MAID = {
  id: 'deepseek-maid',
  name: 'DeepSeek 娘',
  description: '深蓝 + 鎏金 + 宫廷壁纸',
  colors: {
    bg: '#101c2e',
    bg2: '#16243a',
    bg3: '#1e3048',
    accent: '#4d8fc9',
    toolAccent: '#d4b56a',
    text: '#e8eef6',
    muted: '#9aafc4',
    faint: '#6d8199'
  }
};
const THEME_PRESET_PIXEL = {
  id: 'bijingyu-pixel',
  name: '白京玉 · 像素夜',
  description: '精致像素雨夜咖啡馆：暖夜蓝 + 灯火琥珀 + 奶油字',
  colors: {
    bg: '#1a2438',
    bg2: '#24344f',
    bg3: '#2e4260',
    accent: '#e0a85c',
    toolAccent: '#9bb8d4',
    text: '#f0ebe2',
    muted: '#a8b4c4',
    faint: '#6e7c90'
  }
};

function syncUiStyle(themeId, themePref) {
  const root = document.documentElement;
  // themePref 优先：applyTheme 切走 custom 时 localStorage 可能还没写完，
  // 若仍读 getThemePref() 会把机甲形态/字体一直卡住。
  const pref = themePref != null ? themePref : getThemePref();
  const id = String(
    themeId !== undefined && themeId !== null
      ? themeId
      : (state?.config?.ui?.customThemeId || '')
  ).toLowerCase();
  const mech = pref === 'custom' && MECH_UI_IDS.has(id);
  const maid = pref === 'custom' && MAID_UI_IDS.has(id);
  const pixel = pref === 'custom' && PIXEL_UI_IDS.has(id);
  if (mech) {
    root.setAttribute('data-ui-style', 'mech');
    const fx = state?.config?.ui?.mechFx;
    const on = fx === undefined || fx === null ? true : fx !== false;
    root.setAttribute('data-mech-fx', on ? 'on' : 'off');
    // 浅色 token：customText 若被改成深色会盖掉机甲白字
    const mc = THEME_PRESET_MECH.colors;
    root.style.setProperty('--text', mc.text);
    root.style.setProperty('--muted', mc.muted);
    root.style.setProperty('--faint', mc.faint);
    root.style.setProperty('--bg', mc.bg);
    root.style.setProperty('--bg-2', mc.bg2);
    root.style.setProperty('--bg-3', mc.bg3);
    root.style.setProperty('--accent', mc.accent);
    root.style.setProperty('--tool-accent', mc.toolAccent);
    syncTitleBarFromTheme();
  } else if (maid) {
    root.setAttribute('data-ui-style', 'maid');
    root.removeAttribute('data-mech-fx');
    // 立刻注入浅色 token，避免 applyCustomColors 用旧的深色 customText 覆盖
    const m = THEME_PRESET_MAID.colors;
    root.style.setProperty('--text', m.text);
    root.style.setProperty('--muted', m.muted);
    root.style.setProperty('--faint', m.faint);
    root.style.setProperty('--bg', m.bg);
    root.style.setProperty('--bg-2', m.bg2);
    root.style.setProperty('--bg-3', m.bg3);
    syncTitleBarFromTheme();
  } else if (pixel) {
    root.setAttribute('data-ui-style', 'pixel');
    root.removeAttribute('data-mech-fx');
    // 同款教训：customText 若是深色会盖掉主题浅字 → 启动/切换时锁 token
    const p = THEME_PRESET_PIXEL.colors;
    root.style.setProperty('--text', p.text);
    root.style.setProperty('--muted', p.muted);
    root.style.setProperty('--faint', p.faint);
    root.style.setProperty('--bg', p.bg);
    root.style.setProperty('--bg-2', p.bg2);
    root.style.setProperty('--bg-3', p.bg3);
    root.style.setProperty('--accent', p.accent);
    root.style.setProperty('--tool-accent', p.toolAccent);
    syncTitleBarFromTheme();
  } else {
    root.removeAttribute('data-ui-style');
    root.removeAttribute('data-mech-fx');
  }
}

/** 应用主题到 <html>，并同步顶栏两颗按钮（主题循环 + 自定义开关）。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  // 先写 localStorage，再算 UI 形态，避免 syncUiStyle 读到旧的 custom
  try { localStorage.setItem('qqa-theme', pref); } catch { /* ignore */ }
  document.documentElement.setAttribute('data-theme', actual);
  if (actual !== 'custom') {
    syncUiStyle('', actual);
  } else {
    syncUiStyle(state?.config?.ui?.customThemeId, 'custom');
  }
  syncChaosLayers(actual === '?');
  // 自定义色只在 custom 主题下盖变量；其它主题清掉 inline style，回到经典 macOS
  if (actual === 'custom') {
    const cur = readCustomColors(state?.config);
    // 没存过自定义色时，用明显区别于暗色的起点，避免「开了没变化」
    applyCustomColors(
      (cur.bg || cur.bg2 || cur.accent || cur.text)
        ? cur
        : { ...CUSTOM_START }
    );
  } else {
    applyCustomColors({ bg: '', bg2: '', accent: '', text: '', toolAccent: '' });
  }
  // 主题/自定义色变了 → 重取未缩放底色，再按当前亮度盖一层（不用 filter）
  themeBaseBg = null;
  captureThemeBaseBg();
  applyBrightness(getBrightnessPref());
  const btn = $('#theme-btn');
  if (btn) {
    const show = THEME_ICON[pref] || THEME_ICON.dark;
    btn.textContent = show;
    btn.title = pref === 'custom'
      ? '主题：自定义中（设置 → 桌面端可关闭）'
      : `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  // 顶栏只保留一颗主题按钮；清理历史残留的第二颗
  document.querySelectorAll('#custom-theme-btn').forEach((el) => el.remove());
  // 设置页主题格子：只标循环里的四项；custom 不在格子里
  const picker = $('#theme-picker');
  if (picker) {
    picker.querySelectorAll('[data-theme-opt]').forEach((x) => {
      x.classList.toggle('on', pref !== 'custom' && x.dataset.themeOpt === pref);
    });
  }
  const customBtn = $('#cfg-custom-toggle');
  if (customBtn) {
    const on = pref === 'custom';
    customBtn.classList.toggle('is-on', on);
    customBtn.classList.toggle('btn-primary', on);
    customBtn.textContent = on ? '自定义主题：开' : '自定义主题';
    customBtn.title = on ? '点击关闭自定义，回到暗色' : '点击启用自定义主题';
  }
  try {
    localStorage.setItem('qqa-theme', pref);
  } catch { /* 忽略 */ }

  // Windows 系统窗口按钮（— □ ×）图标色/底色跟主题 + 亮度走
  syncTitleBarFromTheme();
}

/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}, { passive: true });

/** 点击主题按钮：暗 → 亮 → 跟随系统 → ？ → 暗。自定义不在循环里。 */
function cycleTheme() {
  const cur = getThemePref();
  // 自定义/机甲：点主题键 = 退出自定义，回暗色，并立刻清掉机甲字体与形态
  if (cur === 'custom') {
    applyTheme('dark');
    if (state?.config?.ui) state.config.ui.theme = 'dark';
    syncUiStyle('');
    api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: 'dark' } }) })
      .catch(() => { /* 本地已生效 */ });
    return;
  }
  const order = ['dark', 'light', 'system', '?'];
  const i = order.indexOf(cur);
  const next = order[(i + 1) % order.length] || 'dark';
  if (next === '?' && !confirm('进入「？」混乱主题？')) return;
  applyTheme(next);
  if (state?.config?.ui) state.config.ui.theme = next;
  syncUiStyle(next === 'custom' ? state?.config?.ui?.customThemeId : '');
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* localStorage 已生效 */ });
}

/**
 * 设置页独立「自定义主题」开关：点一下立刻换肤，不依赖「保存设置」。
 * 颜色优先读设置里的色板（用户可能已改未保存），否则读配置/localStorage。
 */
function readColorsFromEditor() {
  const bg = $('#cfg-custom-bg')?.value;
  const bg2 = $('#cfg-custom-bg2')?.value;
  const ac = $('#cfg-custom-accent')?.value;
  const tx = $('#cfg-custom-text')?.value;
  const ta = $('#cfg-custom-tool-accent')?.value;
  // 色板没挂载或还是出厂默认空态时不算「用户改过」
  if (!bg && !ac && !tx) return null;
  return {
    bg: bg || '',
    bg2: bg2 || '',
    accent: ac || '',
    text: tx || '',
    toolAccent: ta || ''
  };
}

function collectCustomColorsForApply() {
  const edited = readColorsFromEditor();
  if (edited && (edited.bg || edited.accent || edited.text)) return edited;
  const stored = readCustomColors(state?.config);
  if (stored.bg || stored.accent || stored.text) return stored;
  return { ...CUSTOM_START };
}

function toggleCustomTheme() {
  const on = getThemePref() === 'custom';
  if (on) {
    // 关闭自定义：立刻回默认暗色，并清掉机甲形态 + inline 配色
    try { localStorage.setItem('qqa-theme', 'dark'); } catch { /* ignore */ }
    if (state?.config?.ui) state.config.ui.theme = 'dark';
    document.documentElement.setAttribute('data-theme', 'dark');
    syncUiStyle('', 'dark');
    syncChaosLayers(false);
    applyCustomColors({ bg: '', bg2: '', accent: '', text: '', toolAccent: '' });
    themeBaseBg = null;
    captureThemeBaseBg();
    applyBrightness(getBrightnessPref());
    const btn = $('#theme-btn');
    if (btn) {
      btn.textContent = THEME_ICON.dark || THEME_ICON.dark;
      btn.title = '主题：暗色（点击切换）';
    }
    const customBtn = $('#cfg-custom-toggle');
    if (customBtn) {
      customBtn.classList.remove('is-on', 'btn-primary');
      customBtn.textContent = '自定义主题';
      customBtn.title = '点击启用自定义主题';
    }
    const picker = $('#theme-picker');
    if (picker) {
      picker.querySelectorAll('[data-theme-opt]').forEach((x) => {
        x.classList.toggle('on', x.dataset.themeOpt === 'dark');
      });
    }
    try { loadThemePresets(); } catch { /* 面板未挂载时忽略 */ }
    api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: 'dark' } }) })
      .catch(() => {});
    return;
  }
  // 开启自定义：用当前色板 / 预设色
  const cur = collectCustomColorsForApply();
  saveCustomColorsToStorage(cur);
  if (state?.config?.ui) {
    state.config.ui.theme = 'custom';
    state.config.ui.customBg = cur.bg;
    state.config.ui.customBg2 = cur.bg2;
    state.config.ui.customAccent = cur.accent;
    state.config.ui.customText = cur.text;
    state.config.ui.customToolAccent = cur.toolAccent;
    if (!state.config.ui.customThemeId && (
      (cur.bg || '').toLowerCase() === CUSTOM_START.bg.toLowerCase()
      || (cur.accent || '').toLowerCase() === (CUSTOM_START.accent || '').toLowerCase()
    )) {
      state.config.ui.customThemeId = THEME_PRESET_MECH.id;
    }
  }
  applyTheme('custom');
  try { loadThemePresets(); } catch { /* ignore */ }
  api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      ui: {
        theme: 'custom',
        customBg: cur.bg,
        customBg2: cur.bg2,
        customAccent: cur.accent,
        customText: cur.text,
        customToolAccent: cur.toolAccent,
        customThemeId: state?.config?.ui?.customThemeId || ''
      }
    })
  }).catch(() => {});
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER,
      ...(options.headers || {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 请到 QQ 连接页签启动', fix: obOk ? null : 'snowluma-tab' });
  return { ready: urlOk && modelOk && allowOk && obOk, checks };
}

/** 内容没变就不写 innerHTML，避免定时/SSE 反复整页重绘。返回是否真的写入。 */
function setHtmlIfChanged(el, html) {
  if (!el) return false;
  if (el.dataset.sig === html) return false;
  el.innerHTML = html;
  el.dataset.sig = html;
  return true;
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s?.onebot?.warning) {
    // 例如：连上的其实是另一份副本/另一个实例的 SnowLuma（同一个 QQ 号会被两个实例抢着回）
    show = true;
    html = `⚠ ${esc(s.onebot.warning)}`;
  } else if (s?.snowluma?.warning) {
    // 桥上挂了白名单之外的号（典型：SnowLuma 自动注入把管理员自己的号也挂上了）
    show = true;
    html = `⚠ ${esc(s.snowluma.warning)}`;
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (!show) {
    banner.dataset.sig = '';
    return;
  }
  if (state.paused) {
    html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
      <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
  }
  if (!setHtmlIfChanged(banner, html)) return;
  const link = $('#banner-goto-settings');
  if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
  const resumeBtn = $('#banner-resume-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
  const resumeReadBtn = $('#banner-resume-read-btn');
  if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

/**
 * 按配置显隐「免费API」页签。
 * 隐藏规则：ui.hideApiNews === true，或后台抓取被关掉（apiNews.enabled === false）。
 * 隐藏时若正停在该页，自动切回会话页，避免停在看不见的视图上。
 */
function applyApiNewsVisibility(cfg = state.config) {
  const ui = cfg?.ui || {};
  const apiCfg = cfg?.webSearch?.apiNews || {};
  const hide = ui.hideApiNews === true || apiCfg.enabled === false;
  const tab = $$('.tab').find((t) => t.dataset.tab === 'apinews');
  if (tab) {
    tab.hidden = hide;
    tab.style.display = hide ? 'none' : '';
  }
  if (hide && state.tab === 'apinews') switchTab('sessions');
  return hide;
}

// ── 顶部工具栏自定义（导航页签 + 顶栏状态条）────────────────────────────
// 出厂顺序写死在这里；配置里 navOrder/topOrder 只存用户改过的 id 列表。
const NAV_TOOLBAR_DEFAULT = [
  ['sessions', '会话'],
  ['chats', '存档'],
  ['memory', '记忆'],
  ['memes', '知识库'],
  ['emotions', '情绪'],
  ['life', '世界'],
  ['tools', '工具'],
  ['usage', '用量'],
  ['snowluma', 'QQ 连接'],
  ['settings', '设置'],
  ['apinews', '免费API']
];

const TOP_TOOLBAR_DEFAULT = [
  ['brand', '品牌标题', '#tb-brand'],
  ['accounts', '账号标签', '#accounts'],
  ['chip-onebot', '连接状态胶囊', '#tb-chip-onebot'],
  ['chip-model', '模型胶囊', '#tb-chip-model'],
  ['chip-usage', '今日用量胶囊', '#tb-chip-usage'],
  ['chip-jev', '小模型胶囊', '#tb-chip-jev'],
  ['chip-search', '搜索次数胶囊', '#tb-chip-search'],
  ['chip-state', '本体状态胶囊', '#bot-state-chip'],
  ['nav-state', '页签右侧状态条', '#bot-state-bar-more'],
  ['theme', '主题按钮', '#theme-btn'],
  ['more', '更多菜单', '#more-menu'],
  ['pause', '暂停按钮', '#pause-btn']
];

function normalizeIdList(list, defaults) {
  const known = new Set(defaults.map(([id]) => id));
  const arr = Array.isArray(list) ? list.map(String).filter((id) => known.has(id)) : [];
  const seen = new Set(arr);
  for (const [id] of defaults) if (!seen.has(id)) arr.push(id);
  return arr;
}

function resolveOrderIds(saved, defaults) {
  const known = new Set(defaults.map(([id]) => id));
  const arr = Array.isArray(saved) && saved.length
    ? saved.map(String).filter((id) => known.has(id))
    : defaults.map(([id]) => id);
  const seen = new Set(arr);
  for (const [id] of defaults) if (!seen.has(id)) arr.push(id);
  return arr;
}

function resolveHiddenIds(saved, legacyHideApinews = false) {
  const set = new Set(Array.isArray(saved) ? saved.map(String) : []);
  if (legacyHideApinews) set.add('apinews');
  return set;
}

/** 把导航页签按 ui.navOrder 重排，按 ui.navHidden（及 hideApiNews）隐藏。 */
function applyNavToolbarLayout(cfg = state.config) {
  const ui = cfg?.ui || {};
  const nav = $('#tabs');
  if (!nav) return;
  const tabs = $$('.tab', nav);
  if (!tabs.length) return;
  const byId = new Map(tabs.map((t) => [t.dataset.tab, t]));
  const order = resolveOrderIds(ui.navOrder, NAV_TOOLBAR_DEFAULT)
    .filter((id) => byId.has(id));
  // 页面上多出来的 tab（以后加的）补到末尾
  for (const t of tabs) if (!order.includes(t.dataset.tab)) order.push(t.dataset.tab);
  const hidden = resolveHiddenIds(ui.navHidden, ui.hideApiNews === true);

  // 分隔线在自定义顺序下没有意义，整段去掉；右侧状态区不动
  nav.querySelectorAll('.tab-divider').forEach((el) => el.remove());
  const spacer = nav.querySelector('.nav-spacer');
  tabs.forEach((t) => t.remove());
  const frag = document.createDocumentFragment();
  for (const id of order) {
    const el = byId.get(id);
    if (!el) continue;
    const off = hidden.has(id);
    el.hidden = off;
    el.style.display = off ? 'none' : '';
    frag.appendChild(el);
  }
  if (spacer) nav.insertBefore(frag, spacer);
  else nav.appendChild(frag);

  if (hidden.has(state.tab) && state.tab !== 'sessions' && !hidden.has('sessions')) {
    switchTab('sessions');
  } else if (hidden.has(state.tab) && hidden.has('sessions')) {
    // 连会话都藏了：落到第一个可见页
    const first = order.find((id) => !hidden.has(id) && byId.has(id));
    if (first) switchTab(first);
  }
}

/** 顶栏：按 ui.topOrder 重排、按 ui.topHidden 隐藏（品牌/账号/状态胶囊/操作钮/页签状态条）。 */
function applyTopToolbarLayout(cfg = state.config) {
  const ui = cfg?.ui || {};
  const order = resolveOrderIds(ui.topOrder, TOP_TOOLBAR_DEFAULT);
  const hidden = resolveHiddenIds(ui.topHidden, false);
  const bar = $('#topbar');
  if (!bar) return;

  const q = (sel) => bar.querySelector(sel) || document.querySelector(sel);
  const nodes = new Map([
    ['brand', q('#tb-brand')],
    ['accounts', q('#accounts')],
    ['chip-onebot', q('#tb-chip-onebot')],
    ['chip-model', q('#tb-chip-model')],
    ['chip-usage', q('#tb-chip-usage')],
    ['chip-jev', q('#tb-chip-jev')],
    ['chip-search', q('#tb-chip-search')],
    ['chip-state', q('#bot-state-chip')],
    ['nav-state', q('#bot-state-bar-more')],
    ['theme', q('#theme-btn')],
    ['more', q('#more-menu')],
    ['pause', q('#pause-btn')]
  ]);

  const setVisible = (el, on) => {
    if (!el) return;
    el.hidden = !on;
    // 胶囊默认 inline-flex；其它用空串回落到样式表
    if (!on) el.style.display = 'none';
    else if (el.classList?.contains('status-chip')) el.style.display = 'inline-flex';
    else el.style.display = '';
  };

  for (const id of order) {
    const el = nodes.get(id);
    // nav-state 在 #tabs 里，也要吃隐藏配置
    setVisible(el, !hidden.has(id));
  }
  // 自绘窗口控制始终显示，不进 topHidden
  const winCtl = q('#win-controls');
  if (winCtl) { winCtl.hidden = false; winCtl.style.display = ''; }
  // 默认列表里没扫到的（例如旧配置）也兜底
  for (const [id, el] of nodes) {
    if (!el) continue;
    if (order.includes(id)) continue;
    setVisible(el, !hidden.has(id));
  }

  // 状态胶囊：只在 #tb-chips 内按含 chip-* 的顺序重排
  const chipsBox = bar.querySelector('#tb-chips');
  if (chipsBox) {
    const chipOrder = order.filter((id) => id.startsWith('chip-'));
    for (const id of chipOrder) {
      const el = nodes.get(id);
      if (el) chipsBox.appendChild(el);
    }
  }

  // 操作区：theme / more / pause + 自绘窗口控制，窗口按钮固定在最右
  const actionsBox = bar.querySelector('#tb-actions');
  if (actionsBox) {
    const win = actionsBox.querySelector('#win-controls') || actionsBox.querySelector('.win-spacer');
    for (const id of order) {
      if (!['theme', 'more', 'pause'].includes(id)) continue;
      const el = nodes.get(id);
      if (!el) continue;
      if (win) actionsBox.insertBefore(el, win);
      else actionsBox.appendChild(el);
    }
    // 自定义钮已从顶栏移除：若旧配置还留着 id，从 DOM 清掉，避免「两颗主题按钮」
    actionsBox.querySelector('#custom-theme-btn')?.remove();
  }

  // 顶栏最左：brand → accounts → top-status
  const status = bar.querySelector('.top-status');
  const leftOrder = order.filter((id) => id === 'brand' || id === 'accounts');
  for (const id of ['brand', 'accounts']) if (!leftOrder.includes(id)) leftOrder.push(id);
  for (const id of [...leftOrder].reverse()) {
    const el = nodes.get(id);
    if (el) bar.insertBefore(el, bar.firstChild);
  }
  if (status) {
    status.hidden = false;
    status.style.display = '';
    const lastLeft = nodes.get(leftOrder[leftOrder.length - 1]);
    if (lastLeft && lastLeft.parentNode === bar) bar.insertBefore(status, lastLeft.nextSibling);
    else bar.insertBefore(status, bar.firstChild);
  }
}

function applyToolbarLayout(cfg = state.config) {
  applyNavToolbarLayout(cfg);
  applyTopToolbarLayout(cfg);
  applyApiNewsVisibility(cfg);
}

/** 设置页：把 id 列表渲染成可拖/可上下移/可显隐的列表。 */
function renderToolbarCfgList(listId, defaults, orderIds, hiddenIds) {
  const box = $(listId);
  if (!box) return;
  const labelOf = new Map(defaults);
  box.innerHTML = orderIds.map((id, i) => {
    const label = labelOf.get(id) || id;
    const off = hiddenIds.has(id);
    return `
      <li draggable="true" data-tb-id="${esc(id)}">
        <span class="tb-drag" title="拖动排序">⋮⋮</span>
        <input type="checkbox" class="tb-show" ${off ? '' : 'checked'} title="是否显示" />
        <span class="tb-label${off ? ' off' : ''}">${esc(label)}</span>
        <span class="tb-id">${esc(id)}</span>
        <span class="tb-ops">
          <button type="button" class="tb-up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="tb-down" title="下移" ${i === orderIds.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
      </li>`;
  }).join('');

  const readState = () => {
    const order = $$('.tb-cfg-list > li', box).map((li) => li.dataset.tbId);
    const hidden = new Set(
      $$('.tb-cfg-list > li', box)
        .filter((li) => !li.querySelector('.tb-show')?.checked)
        .map((li) => li.dataset.tbId)
    );
    return { order, hidden };
  };

  const refreshLocal = () => {
    const { order, hidden } = readState();
    renderToolbarCfgList(listId, defaults, order, hidden);
    // 立即预览到真实工具栏（未保存前也可看到效果）
    const patch = { ui: { ...(state.config?.ui || {}) } };
    if (listId === '#tb-nav-list') {
      patch.ui.navOrder = order;
      patch.ui.navHidden = [...hidden];
      patch.ui.hideApiNews = hidden.has('apinews');
    } else {
      patch.ui.topOrder = order;
      patch.ui.topHidden = [...hidden];
    }
    state.config = { ...(state.config || {}), ui: { ...(state.config?.ui || {}), ...patch.ui } };
    applyToolbarLayout(state.config);
  };

  box.querySelectorAll('.tb-up').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const prev = li?.previousElementSibling;
      if (!li || !prev) return;
      li.parentNode.insertBefore(li, prev);
      refreshLocal();
    });
  });
  box.querySelectorAll('.tb-down').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const next = li?.nextElementSibling;
      if (!li || !next) return;
      li.parentNode.insertBefore(next, li);
      refreshLocal();
    });
  });
  box.querySelectorAll('.tb-show').forEach((cb) => {
    cb.addEventListener('change', refreshLocal);
  });

  // HTML5 拖拽排序
  let dragEl = null;
  box.querySelectorAll('li').forEach((li) => {
    li.addEventListener('dragstart', () => {
      dragEl = li;
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      box.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
      dragEl = null;
      refreshLocal();
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === li) return;
      li.classList.add('drag-over');
      const rect = li.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      if (after) li.parentNode.insertBefore(dragEl, li.nextSibling);
      else li.parentNode.insertBefore(dragEl, li);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => e.preventDefault());
  });
}

function bindToolbarCfgSection() {
  const ui = state.config?.ui || {};
  const navOrder = resolveOrderIds(ui.navOrder, NAV_TOOLBAR_DEFAULT);
  const navHidden = resolveHiddenIds(ui.navHidden, ui.hideApiNews === true);
  const topOrder = resolveOrderIds(ui.topOrder, TOP_TOOLBAR_DEFAULT);
  const topHidden = resolveHiddenIds(ui.topHidden, false);
  renderToolbarCfgList('#tb-nav-list', NAV_TOOLBAR_DEFAULT, navOrder, navHidden);
  renderToolbarCfgList('#tb-top-list', TOP_TOOLBAR_DEFAULT, topOrder, topHidden);

  $('#tb-toolbar-reset')?.addEventListener('click', () => {
    if (!confirm('恢复顶部工具栏默认顺序与全部显示？')) return;
    const ui0 = state.config?.ui || {};
    state.config = {
      ...(state.config || {}),
      ui: {
        ...ui0,
        navOrder: [],
        navHidden: [],
        topOrder: [],
        topHidden: [],
        hideApiNews: false
      }
    };
    renderToolbarCfgList('#tb-nav-list', NAV_TOOLBAR_DEFAULT, NAV_TOOLBAR_DEFAULT.map(([id]) => id), new Set());
    renderToolbarCfgList('#tb-top-list', TOP_TOOLBAR_DEFAULT, TOP_TOOLBAR_DEFAULT.map(([id]) => id), new Set());
    applyToolbarLayout(state.config);
  });
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  updateNewContentButton();
  if (state.quoteMode && name !== 'chats') exitQuoteMode();   // 离开存档页自动退出金句勾选
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'memory') loadMemoryView();
  if (name === 'memes') loadMemesView();
  if (name === 'apinews') loadApiNewsView();
  if (name === 'emotions') loadEmotionsView();
  if (name === 'life') loadLifeView();
  if (name === 'tools') loadToolsPage();
  if (name === 'usage') {
    // 有上次数据先立刻画出来，避免空白；再后台刷新
    if (usageLastData && usageLastData.range === usageRange) {
      state.usageStats = usageLastData.stats;
      if (!$('#usage-page .usage-wrap')) {
        renderUsagePage(usageLastData.stats, usageLastData.st, usageLastData.prices);
      } else {
        updateUsagePage(usageLastData.stats, usageLastData.st, usageLastData.prices);
      }
    }
    loadUsageView({ force: true });
  }
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'settings' && !state.settingsDirty) loadSettings();
}

// ── 状态栏 ──
let statusRefreshBusy = false;
let statusRefreshAgain = false;
// ── 顶栏「小模型」胶囊：任何页面都能看到本地模型起没起；没起就能一键拉起 ──
// 为什么放在顶栏而不是设置页：本地模型没起来时，所有本地判定（插嘴、情绪、挑表情…）
// 都会静默走回词表/云端 —— 从界面上完全看不出来。放在顶栏是让这件事任何页面都可见。
let jevStartingAt = 0;      // 点过"拉起"的时刻（服务端没有"启动中"这个状态，只能前端记）
let jevPokeTimer = null;    // 启动期间加快轮询，起来/失败都尽快反映到界面上

function renderJevChip(s) {
  const chip = $('#tb-chip-jev');
  const label = $('#jev-label');
  if (!chip || !label) return;
  const jv = (s && s.localJev) || {};
  const ready = jv.ready === true;
  const starting = !ready && jevStartingAt > 0 && Date.now() - jevStartingAt < 90000;
  let text = '';
  let title = '';
  let canStart = false;
  if (!jv.available) {
    text = '缺文件';
    title = `本地模型或 llama-server 不存在，拉不起来：\n${jv.model || '(未配置模型路径)'}\n${jv.exe || '(未配置 exe 路径)'}\n去「设置 → 本地 Jev」里改路径`;
  } else if (jv.enabled !== true) {
    text = '未启用';
    title = '本地小模型（Jev）现在是关着的：所有本地判定都退回词表/云端。\n点一下 = 启用并立刻拉起来（约几秒）';
    canStart = true;
  } else if (ready) {
    text = '就绪';
    title = `本地小模型已就绪：${jv.baseUrl || ''}${jv.pid ? `\npid ${jv.pid}` : ''}\n点一下打开「设置 → 本地 Jev」（试判 / 统计 / 换模型）`;
  } else if (starting || jv.running) {
    text = '启动中…';
    title = '正在拉起本地模型（首次加载 GGUF 要几秒）。点一下可重新拉起。';
    canStart = true;
  } else {
    text = '未启动';
    title = `本地模型进程没在跑${jv.lastError ? `：\n${jv.lastError}` : ''}\n点一下立刻拉起`;
    canStart = true;
  }
  label.textContent = text;
  chip.title = title;
  chip.classList.toggle('can-start', canStart);
  chip.dataset.ready = ready ? '1' : '0';
  if (starting && !jevPokeTimer) {
    jevPokeTimer = setInterval(() => {
      if (Date.now() - jevStartingAt > 90000) { clearInterval(jevPokeTimer); jevPokeTimer = null; return; }
      refreshStatus();
    }, 2500);
  }
  if (ready && jevPokeTimer) { clearInterval(jevPokeTimer); jevPokeTimer = null; }
}

async function onJevChipClick() {
  const chip = $('#tb-chip-jev');
  if (!chip || chip.dataset.busy === '1') return;
  const jv = state.status?.localJev || {};
  if (jv.ready === true && jv.available) {
    // 已经好了：点一下去看详情（试判 / 统计 / 换模型），顺手把没保存的改动落盘
    try { await flushSettingsSave(); } catch { /* 已在状态位提示 */ }
    state.settingsSection = 'jev';
    if (state.tab !== 'settings') switchTab('settings');
    else { renderSettingsSidebar(); renderSettings(); }
    return;
  }
  chip.dataset.busy = '1';
  jevStartingAt = Date.now();
  renderJevChip(state.status);   // 立刻切成"启动中…"，别等下一次轮询
  try {
    // start = 没启用就先启用（点一下就该能用），再起进程；已在跑则直接复用
    const r = await api('/api/local-jev', { method: 'POST', body: JSON.stringify({ action: 'start' }) });
    if (r && r.ok === false) {
      jevStartingAt = 0;
      alert(`拉起本地模型失败：${r.reason || '未知原因'}`);
    }
    if (r?.enabled) { try { state.config = await api('/api/config'); } catch { /* ignore */ } }
  } catch (e) {
    jevStartingAt = 0;
    alert(`拉起本地模型失败：${e?.message || e}`);
  } finally {
    delete chip.dataset.busy;
    refreshStatus();
  }
}

async function refreshStatus() {
  // SSE / 定时器 / 各页轮询会叠着调；在途时只排队补一次，避免并发打爆重绘
  if (statusRefreshBusy) {
    statusRefreshAgain = true;
    return;
  }
  statusRefreshBusy = true;
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    label.textContent = s.onebot.connected
      ? (s.onebot.self?.nickname ? s.onebot.self.nickname : '已连接')
      : '未连接';
    const model = s.orchestrator.model || '-';
    $('#model-label').textContent = model.length > 18 ? model.slice(0, 16) + '…' : model;
    const u = s.usage;
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` ${Math.round(rate * 100)}%` : '';
    // 保温链实况：只在中过至少一棒之后才显示，免得平时挂个 0/0 噪音
    const ka = s.cacheKeepAlive;
    const kaTxt = ka && ka.calls > 0 ? ` · 保温${ka.hits}/${ka.calls}` : '';
    $('#usage-label').textContent = `${u.runs}次 ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}${kaTxt}`;
    const usageChip = $('#tb-chip-usage');
    if (usageChip) {
      const kaLine = ka && ka.calls > 0
        ? `\n保温链：发 ${ka.calls} 棒 / 命中 ${ka.hits} 棒（${ka.chatTimers} 个会话还在接力）`
        : '\n保温链：今天还没发过保温请求';
      const chatLine = ka?.chats?.length
        ? `\n正在保温：${ka.chats.slice(0, 4).map((c) => `${c.chatKey}(第${c.fired}棒${c.timer ? '' : '·已停'})`).join('、')}`
        : '';
      // 「为什么没保温 / 为什么停」：以前这些只存在内存里（重启就没了），现在同时落台账
      // （data/cache-keepalive.ndjson）。这里只摊开前三个原因，够判断"是到上限了还是群安静了"。
      const stopTop = ka?.stopReasons
        ? Object.entries(ka.stopReasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
        : [];
      const stopLine = stopTop.length
        ? `\n停链原因：${stopTop.map(([why, n]) => `${why}×${n}`).join('、')}`
        : '';
      usageChip.title = `今日用量 / 缓存命中${kaLine}${chatLine}${stopLine}`;
    }
    $('#search-count-label').textContent = String(s.webSearchCount ?? u.webSearchCount ?? 0);
    if (s.botState) {
      const bs = s.botState;
      const short = `${bs.energyLabel} · ${bs.moodLabel}${bs.socialLabel ? ` · ${bs.socialLabel}` : ''}`;
      const el = $('#bot-state-label');
      if (el) el.textContent = short;
      const chip = $('#bot-state-chip');
      if (chip) {
        const tip = [
          `精力 ${bs.energy}（${bs.energyLabel}）`,
          `心情 ${bs.mood}（${bs.moodLabel}）`,
          `社交 ${bs.social}（${bs.socialLabel}）`,
          Array.isArray(bs.emotionPhrases) && bs.emotionPhrases.length ? `情绪：${bs.emotionPhrases.join('、')}` : '',
          bs.lastEvent && !bs.lastEvent.faded ? `最近：${bs.lastEvent.type} ${bs.lastEvent.text || ''}` : ''
        ].filter(Boolean).join('\n');
        chip.title = tip;
      }
      // 页签右侧状态点（融入 #tabs）
      const barText = $('#bot-state-bar-text');
      const barDot = $('#bsb-dot');
      const navState = $('#bot-state-bar-more');
      if (barText) {
        const emo = Array.isArray(bs.emotionPhrases) && bs.emotionPhrases.length ? ` · ${bs.emotionPhrases.join('、')}` : '';
        barText.textContent = `${bs.moodLabel || ''}${emo}`;
        if (navState) {
          const ed = bs.energyDetail || {};
          navState.title = [
            `心情 ${bs.moodRaw ?? bs.mood}（${bs.moodLabel}）`,
            `精力 身${ed.physical ?? '-'} 认${ed.cognitive ?? '-'} 情${ed.emotional ?? '-'} 志${ed.will ?? '-'}`,
            bs.intent ? `倾向：${bs.intent}` : '',
            `急压 ${bs.acuteStress ?? 0} · 慢压 ${bs.chronicStress ?? 0}`,
            '点开看完整面板'
          ].filter(Boolean).join('\n');
        }
      }
      if (barDot) {
        // 心情主色；急压高时偏红
        const acute = Number(bs.acuteStress) || 0;
        const moodRaw = Number(bs.moodRaw ?? 50);
        let c = 'var(--accent)';
        if (acute >= 60) c = 'var(--red)';
        else if (moodRaw >= 58) c = 'var(--green)';
        else if (moodRaw <= 42) c = 'var(--orange)';
        barDot.style.background = c;
        barDot.style.boxShadow = `0 0 0 2px color-mix(in srgb, ${c} 22%, transparent)`;
      }
    }
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderJevChip(s);
    renderBanner();
    refreshInstances();
  } catch (e) { /* 忽略瞬时错误 */ }
  finally {
    statusRefreshBusy = false;
    if (statusRefreshAgain) {
      statusRefreshAgain = false;
      setTimeout(() => { refreshStatus(); }, 0);
    }
  }
}

// ── 账号标签页：**默认关闭**（2026-09-22 用户要求"根治"）──────────────────
//
// 它原来是"本机还有别的实例（另一个 QQ 号）时，顶栏出一排按钮，点一下切过去"。
// 问题（用户实测）：
//   · 它靠**扫端口**发现实例（3210-3239），于是别的盘上那份副本、甚至运行中的残留进程
//     都会被列成"主账号"按钮 —— 用户把那个文件夹删了按钮还在（进程没退，端口还开着）；
//   · 点过去是 `location.assign` 跳转；对面界面文件不全 / 已经不是本程序 → 一片黑；
//   · 上一版加"跳转前先探一次"，跨源 fetch 被浏览器挡掉，**切号B 反而报错**。
// 结论：这个功能本身不值得留（切号体验远不如"一个窗口两个号"那种账号标签）。
// 现在：默认**不显示、不轮询、不跳转**；只有用户在
// 「设置 → 桌面端 → 显示账号标签（本机多实例切换）」里主动打开，才会有那排按钮。
function instanceTabsEnabled() {
  // ⚠️ 用"隐藏"语义的新键 hideInstanceTabs（默认不隐藏 = 显示）。
  //    老键 ui.instanceTabs 一律无视 —— 它是上一版"默认关"时被写进用户配置的 false，
  //    只要还认它，用户那边就永远"合并不了"（2026-09-22 实测踩到）。
  try { return state?.config?.ui?.hideInstanceTabs !== true; } catch { return true; }
}

function renderAccounts() {
  const box = $('#accounts');
  if (!box) return;
  // 未开启：永远空着、也不占位置（老配置里就算有实例列表也不显示）
  if (!instanceTabsEnabled()) {
    if (box.dataset.sig !== 'off') {
      box.innerHTML = '';
      box.dataset.sig = 'off';
    }
    box.classList.add('hidden');
    return;
  }
  const list = (state.instances || []).filter((it) => {
    // ⚠️ 只列"同一个版本"的实例（2026-09-22 用户反馈过"莫名多出个主账号按钮、点过去黑屏"）：
    //    那个按钮来自别的盘上那份旧副本 —— 它同样会回 instance-info。现在要求版本号一致；
    //    对面没回 version（更老的版本 / 别的程序）也一律不显示。
    const mine = (state.instances || []).find((x) => x.self)?.version || '';
    if (it.self) return true;
    return !!(it.version && mine && String(it.version) === String(mine));
  });
  if (list.length <= 1) {          // 只有一个实例时不占地方
    box.innerHTML = '';
    box.dataset.sig = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const html = list.map((it) => {
    const active = !!it.self;      // 后端在"我"那条上标了 self:true
    const on = !!it.onebot?.connected;
    const nick = it.onebot?.self?.nickname || '';
    const tip = [`${it.name}（端口 ${it.port}）`,
      nick ? `已连 ${nick}（${it.onebot.self.userId}）` : (on ? '已连 OneBot' : '未连上 OneBot'),
      it.onebot?.warning ? `⚠ ${it.onebot.warning}` : '',
      '点击切换到该实例',
      it.dataDir || ''].filter(Boolean).join('\n');
    return `<button type="button" class="acct${active ? ' active' : ''}" data-url="${esc(it.url)}" title="${esc(tip)}"`
      + `${active ? ' aria-current="page"' : ''}>`
      + `<span class="dot ${on ? 'dot-on' : 'dot-off'}"></span>`
      + `<span class="acct-name">${esc(it.name)}</span>`
      + (nick ? `<span class="acct-nick">${esc(nick)}</span>` : '')
      + '</button>';
  }).join('');
  if (!setHtmlIfChanged(box, html)) return;
  for (const btn of box.querySelectorAll('.acct')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('active')) return;
      const url = String(btn.dataset.url || '').trim();
      // 必须是本机控制台，避免被塞奇怪地址
      if (!/^http:\/\/127\.0\.0\.1:32\d{2}\/?$/.test(url.replace(/\?.*$/, ''))) return;
      btn.classList.add('is-going');
      // 主动切号：先放行 beforeunload 守卫，否则设置页有未保存改动时
      // 会被 Electron「离开此页面?」模态框拦死 → 点了没反应、切不过去（表现为卡死）。
      window.__APP_NAVIGATING__ = true;
      state.settingsDirty = false;
      // assign 比 location.href 在 Electron 里更不容易被中间层吞掉
      location.assign(url);
    });
  }
}

async function refreshInstances() {
  // 没开这个功能就一次端口扫描都不做 —— 省事，也避免"莫名冒出一个按钮"
  if (!instanceTabsEnabled()) {
    state.instances = [];
    renderAccounts();
    return;
  }
  try {
    const data = await api('/api/instances');
    state.instances = data.list || [];
  } catch { /* 忽略瞬时错误 */ }
  renderAccounts();
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#bot-state-bar-more')?.addEventListener('click', () => {
  switchTab('emotions');
});
$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    loadSessions();
    refreshStatus();
    // 自动跟随新会话（等待中/运行中）
    if (state.autoFollowRunning) {
      loadSessions({ quiet: true }).then(() => {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) selectSession(active.id);
      });
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
    // 会话结束 = 本体状态刚写过 → 若正看着情绪页就刷新
    if (state.tab === 'emotions') loadEmotionsView();
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  });
  es.addEventListener('status', () => {
    refreshStatus();
    if (state.tab === 'emotions') loadEmotionsView();
  });
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 表情批量补备注的进度（只在设置页显示）
  es.addEventListener('sticker-annotate', (ev) => {
    const d = JSON.parse(ev.data || '{}');
    const hint = document.getElementById('sticker-annotate-hint');
    if (!hint) return;
    if (d.phase === 'start') hint.textContent = `开始补备注：0/${d.total}`;
    else if (d.phase === 'progress') hint.textContent = `补备注中：${d.done}/${d.total}${d.failed ? `（失败 ${d.failed}）` : ''}`;
    else if (d.phase === 'done') hint.textContent = `补完了：成功 ${d.done} 张${d.failed ? `，失败 ${d.failed} 张` : ''}`;
    else if (d.phase === 'error') hint.textContent = `补备注出错：${d.error}`;
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId && !state.sessionQuery && !state.sessionChatFilter && (!state.sessionFilter || state.sessionFilter === 'all')) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  return Number.isFinite(n) && n >= 1000 ? n : 4000;
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = filterSessions(state.sessions || []);
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'life') refreshLifeStatus();   // 只刷状态卡片，不碰参数表单（防打断编辑）
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}
startListPoller();

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const source = state.sessions || [];
  const groupSelect = $('#session-chat-filter');
  const groups = [...new Set(source.map(s => s.chatKey))].filter(Boolean);
  const groupOptions = '<option value="">全部群聊与私聊</option>' + groups.map(key => '<option value="'+esc(key)+'">'+esc(formatChatTitle(key, chatNameOf(key)))+'</option>').join('');
  if (groupSelect && groupSelect.innerHTML !== groupOptions) { groupSelect.innerHTML = groupOptions; groupSelect.value = state.sessionChatFilter || ''; }
  const all = filterSessions(source);
  if (!state.currentSessionId) renderSessionWelcome();

  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  const listHtml = !all.length
    ? '<div class="list-empty">'+(source.length ? '没有匹配的会话，请调整搜索或筛选。' : '暂无会话，新的运行记录会显示在这里。')+'</div>'
    : shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}${Number(s.activityAt)
          ? `<span class="session-elapsed" data-at="${Number(s.activityAt)}"> ${fmtElapsed(Date.now() - Number(s.activityAt))}</span>`
          : ''}</span>`
      : '';
    const searchHtml = Number(s.webSearchCount) > 0
      ? `<span class="muted">搜 ${s.webSearchCount}</span>`
      : '';
    const isNew = !state.seenSessionIds.has(s.id);
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}" role="button" tabindex="0" aria-label="${esc(chatName)} · ${esc(STATUS_LABEL[s.status] || s.status)}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span><span>${s.rounds || 0} 轮</span>${searchHtml}` : ''}
        </div>
      </div>`;
    }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${all.length} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = `共 ${all.length} 条${all.length !== source.length ? ` · 全部 ${source.length} 条` : ''}`;
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  // 内容没变就跳过整表重建（SSE / 轮询高频来时不再反复 innerHTML + 重绑事件）
  if (!setHtmlIfChanged(box, listHtml)) return;
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(el.dataset.id); } });
  });
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
  // 运行中会话的"已等 N 秒"：接口偶发慢（实测有过 72 秒一次）时，
  // 光看"正在思考…"分不出是慢还是死 —— 秒数一跳长就一眼看出来了。
  if ($$('.session-elapsed[data-at]', box).length) startElapsedTicker();
}

/** 把毫秒数格式化成人看的：45s / 2分10s。 */
function fmtElapsed(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}s`;
}

let elapsedTicker = null;
function startElapsedTicker() {
  if (elapsedTicker) return;
  elapsedTicker = setInterval(() => {
    const els = $$('.session-elapsed[data-at]');
    if (!els.length) {
      clearInterval(elapsedTicker);
      elapsedTicker = null;
      return;
    }
    for (const el of els) {
      const ms = Date.now() - Number(el.dataset.at);
      el.textContent = ` ${fmtElapsed(ms)}`;
      el.classList.toggle('slow', ms >= 30000);   // ≥30 秒标黄：可能真是接口慢
    }
  }, 1000);
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      if (remain > 0) el.textContent = `等待中 · ${(remain / 1000).toFixed(1)}s`;
      else if (remain > -20000) el.textContent = '等待中 · 启动…';
      else el.textContent = '等待中 · 卡住了（可点唤醒）';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.unreadContent = 0;
  state.detailContentCount = 0;
  $('#session-new-content')?.classList.add('hidden');
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

/** 异常会话复盘：给管理员看「哪里歪了」的一句话诊断。 */
function buildSessionReview(s) {
  const tools = (s.messages || []).filter((m) => m.toolCall).map((m) => m.toolCall.name);
  const hasSend = tools.includes('send_message');
  const hasSticker = tools.includes('send_sticker') || tools.includes('send_image');
  const bodyOnly = !tools.length && typeof s.userPrompt === 'string' && (s.messages || []).some(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 8
  );
  const totalTok = Number(s.usage?.totalTokens || 0);
  const runningStuck = s.status === 'running' && totalTok === 0 && (s.rounds || 0) === 0;

  if (s.status === 'error') {
    return {
      level: '异常',
      tag: 'error',
      points: ['会话以 error 结束', s.error ? String(s.error).slice(0, 80) : '无错误详情'],
      hint: '看下方工具调用与错误字段；可能是 API/工具/网络失败。',
      fix: '必要时换模型或放宽超时；检查 API Key / 网络。'
    };
  }
  if (runningStuck) {
    return {
      level: '疑似卡住',
      tag: 'stuck',
      points: ['状态仍是运行中', '0 token / 0 轮工具'],
      hint: '重启前没走完收尾；磁盘上的旧 running 会在下次启动标成异常。',
      fix: '若列表仍显示运行中，等轮询刷新或热重启核心。'
    };
  }
  if (s.status === 'noreply' && !hasSend && !hasSticker) {
    return {
      level: '未回复',
      tag: 'noreply',
      points: ['没有 send_message / 表情', bodyOnly ? '正文里有话但没调工具' : '可能主动选择沉默'],
      hint: bodyOnly ? '协议问题：想说的话写进了正文' : '值得开口的场景模型却 finish 了',
      fix: bodyOnly ? '看发送协议纠偏是否触发；弱模型可考虑加强 hardProtocol' : '检查触发内容是否 @/点名；必要时调参与度'
    };
  }
  if (s.status === 'aborted') {
    return {
      level: '已中止',
      tag: 'aborted',
      points: ['会话被中止'],
      hint: '暂停/重启/冲突时常见，一般不用管。',
      fix: ''
    };
  }
  return null;
}

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}

      </h2>
      <details class="collapsible runtime-details"><summary>运行详情 · 模型、用量与调试</summary><button class="btn btn-small" id="json-mode-btn" type="button">${state.sessionJsonMode === s.id ? '返回对话视图' : '查看 JSON'}</button><div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div></details>
    </div>`);

  // 异常复盘卡：error / noreply 无工具 / 卡在 running 0 token
  const review = buildSessionReview(s);
  if (review) {
    html.push(`
      <div class="kb-cat-block session-review" style="margin-bottom:12px;border-color:color-mix(in srgb, var(--orange) 40%, var(--border));background:color-mix(in srgb, var(--orange) 8%, var(--bg-2))">
        <div class="kb-cat-head">
          <span class="kb-cat-title" style="color:var(--orange)">复盘 · ${esc(review.level)}</span>
          <span class="kb-cat-count">${esc(review.tag)}</span>
        </div>
        <div style="font-size:12.5px;line-height:1.7;color:var(--text);padding:2px 4px 4px">
          <div><b>问题：</b>${review.points.map(esc).join('；')}</div>
          ${review.hint ? `<div class="muted" style="margin-top:4px"><b>可能原因：</b>${esc(review.hint)}</div>` : ''}
          ${review.fix ? `<div style="margin-top:6px"><b>建议：</b>${esc(review.fix)}</div>` : ''}
        </div>
      </div>`);
  }

  // 回放摘要
  const toolNames = (s.messages || []).filter((m) => m.toolCall).map((m) => m.toolCall.name);
  const sentLines = (s.sent || []).map((x) => x.text).filter(Boolean);
  if (toolNames.length || sentLines.length || s.status === 'error') {
    html.push(`
      <details class="collapsible" open>
        <summary>回复概览</summary>
        <div class="coll-body reply-overview">
          <div><b>触发：</b>${esc(String(s.triggerSummary || s.triggerText || s.trigger || '主动/手动').slice(0, 100))}</div>
          <div class="muted"><b>工具：</b>${toolNames.length ? esc([...new Set(toolNames)].map(n => TOOL_META[n]?.name || n).join(' → ')) : '未使用工具'}</div>
          <div><b>已回复：</b>${sentLines.length ? sentLines.map((t) => `「${esc(String(t).slice(0, 40))}」`).join(' ') : '本次未发送回复'}</div>
          ${s.error ? `<div style="color:#f66"><b>错误：</b>${esc(s.error)}</div>` : ''}
        </div>
      </details>`);
  }

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible" open>
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card">
            <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">思考（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) {
      html.push(`
        <div class="sent-badge">
          <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
          ${esc(sent.text)}
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  const contentCount = (s.messages || []).length + (s.sent || []).length;
  if (!firstRender && !wasAtBottom) state.unreadContent = (state.unreadContent || 0) + Math.max(0, contentCount - (state.detailContentCount || 0));
  state.detailContentCount = contentCount;
  if (firstRender || wasAtBottom) state.unreadContent = 0;
  updateNewContentButton();
  if (firstRender || wasAtBottom) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}

// ── SnowLuma 独立页签 ──
/**
 * 只刷新 SnowLuma 的日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 如果这里重建整页，
 * 用户正在看的日志会被反复重绘，滚动位置也保不住。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const pre = box.querySelector('.snowluma-logs-view');
  if (!pre) return;                       // 页面还没渲染过，等下次整页刷新
  try {
    const logs = await api('/api/snowluma/logs');
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    pre.textContent = logText;
    // 有滚动就贴着底部，让最新日志可见
    const wrap = pre.parentElement;
    if (wrap && wrap.scrollHeight > wrap.clientHeight) wrap.scrollTop = wrap.scrollHeight;
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    // 静默刷新（日志轮询）不跑 check-accounts，避免频繁触发自动卸载
    const [status, logs, cfg, bridge] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs'),
      api('/api/config').catch(() => ({ snowluma: {} })),
      quiet
        ? Promise.resolve(null)
        : api('/api/snowluma/check-accounts', { method: 'POST', body: '{}' }).catch(() => null)
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const slCfg = cfg.snowluma || {};
    const uins = (slCfg.accountWhitelist || []).map(String).filter(Boolean);
    const autoUnhook = slCfg.autoUnhookStrangers !== false;
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    const live = bridge?.live || [];
    const strangers = bridge?.strangers || [];
    const bridgeWarn = bridge?.warning || (s.snowluma?.warning || '');
    const statusHtml = !uins.length
      ? '<div class="bridge-status">白名单为空 —— 当前<b>不检查</b>桥上账号（任何人被注入都不会拦）。填上机器人 QQ 号后才会生效。</div>'
      : `<div class="bridge-status${strangers.length || bridgeWarn ? ' has-warn' : ''}">
          <div><b>白名单</b>：${uins.map(esc).join('、')}</div>
          <div><b>此刻在桥上</b>：${bridge ? (live.length ? live.map(esc).join('、') : '（无）') : '（进页面时已查过一次；点「立即检查」刷新）'}</div>
          ${strangers.length ? `<div>⚠ 白名单外：${strangers.map((x) => esc(String(x.uin))).join('、')}</div>` : ''}
          ${bridgeWarn ? `<div>${esc(bridgeWarn)}</div>` : (bridge && uins.length && !strangers.length ? '<div>✓ 当前没有白名单外的账号</div>' : '')}
        </div>`;

    const pageHtml = `
      <div class="snowluma-page-card">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-state-row">
          <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
          <span>SnowLuma：<strong>${running ? '运行中' : '未运行'}</strong></span>
          ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
          <span class="muted">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : '')}</span>
        </div>
        <div class="snowluma-state-row">
          <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
          <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${esc(s.onebot.self.nickname)}）` : ''}` : '未连接'}</strong></span>
          <span class="muted">WS ${s.onebot?.error ? `：${esc(s.onebot.error)}` : ''}</span>
        </div>
        <div class="snowluma-state-row muted">
          <span>目录：${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
        </div>
        <div class="snowluma-state-row">
          <span>WebUI：</span>
          ${webuiUrl
            ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
            : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
        </div>
        <div class="snowluma-actions">
          <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
          <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
          <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
          <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
          <span id="sl-hint" class="muted" style="font-size:12px"></span>
        </div>
        <div>
          <div class="hint" style="margin-bottom:6px">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view">${esc(logText)}</pre>
        </div>
      </div>

      <div class="bridge-wl-card" style="margin-top:16px">
        <h3>桥上账号白名单 <span class="sub">一键拉起后只允许这些号被注入</span></h3>
        <div class="bridge-hint">
          SnowLuma「自动注入」会发现一个 QQ 进程就挂一个，容易把管理员自己的号也挂上桥。
          在这里维护<b>允许挂在桥上的机器人 QQ 号</b>；每分钟自动检查一次，白名单外的号会报警（可自动卸载）。留空 = 不检查。
        </div>
        <div class="bridge-wl-row">
          <div class="bridge-uins" id="sl-uin-chips" aria-label="白名单 QQ 号">
            ${uins.length
              ? uins.map((u) => `<span class="bridge-uin-chip" data-uin="${esc(u)}">${esc(u)}<button type="button" data-remove="${esc(u)}" title="移除">×</button></span>`).join('')
              : '<span class="bridge-wl-empty">还没有白名单号 —— 下面输入 QQ 号后点添加</span>'}
          </div>
        </div>
        <div class="bridge-wl-row">
          <input type="text" id="sl-uin-input" placeholder="输入机器人 QQ 号，例如 10000001" inputmode="numeric" autocomplete="off" />
          <button type="button" class="btn btn-small" id="sl-uin-add-btn">添加</button>
          <button type="button" class="btn btn-primary" id="sl-wl-save-btn">保存白名单</button>
          <button type="button" class="btn btn-small" id="sl-wl-check-btn">立即检查桥上账号</button>
        </div>
        <div class="bridge-wl-row">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);flex:1;min-width:200px">
            <input type="checkbox" id="sl-auto-unhook" ${autoUnhook ? 'checked' : ''} />
            发现白名单外的号时自动卸载（关掉则只报警）
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);flex:2;min-width:220px">
            <span style="white-space:nowrap">SnowLuma 网页密码</span>
            <input type="password" id="sl-webui-pw" value="${esc(slCfg.webuiPassword || '')}" placeholder="自动卸载要用" style="flex:1" />
          </label>
          <button type="button" class="btn btn-small" id="sl-pw-save-btn" title="保存自动卸载开关与网页密码">保存密码</button>
        </div>
        ${statusHtml}
        <div id="sl-wl-hint" class="bridge-hint" style="min-height:1.2em"></div>
      </div>`;

    // 日志/状态没变时跳过整页重建（quiet 轮询高频来时不再打断输入）
    if (!setHtmlIfChanged(box, pageHtml)) return;

    // ── 状态卡 ──
    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });

    // ── 白名单卡片 ──
    let currentUins = [...uins];
    const renderChips = () => {
      const wrap = $('#sl-uin-chips');
      if (!wrap) return;
      wrap.innerHTML = currentUins.length
        ? currentUins.map((u) => `<span class="bridge-uin-chip" data-uin="${esc(u)}">${esc(u)}<button type="button" data-remove="${esc(u)}" title="移除">×</button></span>`).join('')
        : '<span class="bridge-wl-empty">还没有白名单号 —— 下面输入 QQ 号后点添加</span>';
      wrap.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const uin = btn.getAttribute('data-remove');
          currentUins = currentUins.filter((x) => x !== uin);
          renderChips();
        });
      });
    };
    renderChips();

    const addUin = () => {
      const input = $('#sl-uin-input');
      const raw = String(input?.value || '').trim().replace(/\D/g, '');
      if (!raw) return;
      if (!/^\d{5,12}$/.test(raw)) {
        const hint = $('#sl-wl-hint');
        if (hint) hint.textContent = 'QQ 号应是 5~12 位数字。';
        return;
      }
      if (!currentUins.includes(raw)) currentUins.push(raw);
      if (input) input.value = '';
      renderChips();
      const hint = $('#sl-wl-hint');
      if (hint) hint.textContent = `已添加 ${raw}，记得点「保存白名单」。`;
    };
    $('#sl-uin-add-btn')?.addEventListener('click', addUin);
    $('#sl-uin-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addUin(); }
    });

    const persistBridge = async () => {
      const patch = {
        snowluma: {
          ...(state.config?.snowluma || slCfg),
          accountWhitelist: [...currentUins],
          autoUnhookStrangers: !!$('#sl-auto-unhook')?.checked,
          webuiPassword: String($('#sl-webui-pw')?.value || '').trim()
        }
      };
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      if (data?.snowluma) {
        state.config = { ...(state.config || cfg), snowluma: data.snowluma };
      }
      return patch.snowluma;
    };

    $('#sl-wl-save-btn')?.addEventListener('click', async () => {
      const hint = $('#sl-wl-hint');
      if (hint) hint.textContent = '保存中…';
      try {
        await persistBridge();
        if (hint) hint.textContent = '白名单已保存 ✓';
        await loadSnowlumaPage({ quiet: true });
      } catch (e) {
        if (hint) hint.textContent = `保存失败：${e.message}`;
      }
    });

    // 密码/自动卸载独立保存：按钮就在密码行旁边，不用再去找「保存白名单」
    $('#sl-pw-save-btn')?.addEventListener('click', async () => {
      const hint = $('#sl-wl-hint');
      if (hint) hint.textContent = '保存密码中…';
      try {
        await persistBridge();
        if (hint) hint.textContent = '自动卸载设置与网页密码已保存 ✓';
      } catch (e) {
        if (hint) hint.textContent = `保存失败：${e.message}`;
      }
    });

    $('#sl-wl-check-btn')?.addEventListener('click', async () => {
      const hint = $('#sl-wl-hint');
      if (hint) hint.textContent = '检查中…';
      try {
        await persistBridge();
        await api('/api/snowluma/check-accounts', { method: 'POST', body: '{}' });
        await loadSnowlumaPage({ quiet: true });
        const h = $('#sl-wl-hint');
        if (h) h.textContent = '检查完成，状态已刷新。';
      } catch (e) {
        if (hint) hint.textContent = `检查失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  const html = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  if (!setHtmlIfChanged(box, html)) return;
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}" data-midrow="${m.id}">${q}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  const row = '<div class="sk-row"></div>';
  // 五张卡一行（与正式页面一致），加载完成时布局不跳
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days"><span class="sk-line" style="width:180px"></span></div>
      </div>
      <div class="usage-cards">${card.repeat(5)}</div>
      <div class="sk-block">${row.repeat(5)}</div>
      <div class="sk-block">${row.repeat(4)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days">
          ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn" title="立即刷新">刷新</button>
          <button class="btn btn-small" id="usage-reset-btn" title="清空用量台账与今日聚合，便于观察新的缓存命中率；不删除会话文件">调试清零</button>
        </div>
      </div>

      <!-- 估算成本放第一张：它是这张页的主指标（accent 描边/底色突出）。
           五张卡固定一行（曾经第一张跨两列、整体占两行，已按需求改单行）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar" style="width:0%"></div></div>
          <div class="uc-sub" data-field="rate-sub">-</div>
        </div>
      </div>

      <div data-block="days">
        <h3 class="usage-h3">按天</h3>
        <table class="usage-table clickable" data-table="days">
          <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="chats">
        <h3 class="usage-h3">按会话
          <button class="btn btn-small ub-expand" id="chats-expand" style="display:none">展开全部</button>
        </h3>
        <table class="usage-table clickable" data-table="chats">
          <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="models">
        <h3 class="usage-h3">按模型
          <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
        </h3>
        <table class="usage-table clickable" data-table="models">
          <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));
  $('#usage-reset-btn')?.addEventListener('click', async () => {
    if (!confirm('清空用量统计与缓存命中率台账？\n（只清统计，不删聊天会话；历史冷藏也会删，下一轮重建）')) return;
    const btn = $('#usage-reset-btn');
    if (btn) { btn.disabled = true; btn.textContent = '清零中…'; }
    try {
      const r = await api('/api/usage/reset', { method: 'POST' });
      usageLastData = null;
      if (r?.ok) {
        await loadUsageView({ force: true });
        const hint = $('#usage-page [data-field="rate-sub"]');
        if (hint) hint.textContent = r.note || '已清零，继续聊天会重新累计';
      } else {
        alert(r?.error || '清零失败');
      }
    } catch (e) {
      alert(String(e?.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '调试清零'; }
    }
  });
  $('#chats-expand')?.addEventListener('click', () => {
    const tbody = box.querySelector('[data-table="chats"] tbody');
    if (!tbody) return;
    tbody.dataset.expanded = tbody.dataset.expanded === '1' ? '0' : '1';
    updateUsagePage(state.usageStats || {}, state.status || {}, state.modelPrices || {});
  });

  // 模型展开按钮（骨架重建后重新绑定）
  $('#models-expand')?.addEventListener('click', () => {
    const tbody = box.querySelector('[data-table="models"] tbody');
    if (!tbody) return;
    tbody.dataset.expanded = tbody.dataset.expanded === '1' ? '0' : '1';
    updateUsagePage(state.usageStats || {}, state.status || {}, state.modelPrices || {});
  });

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  updateUsagePage(stats, st, prices);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  set('runs', t.runs || 0);
  set('runs-sub', `${fmtTok(t.sessions || 0)} 次会话 · 平均 ${(t.callsPerSession || 0).toFixed(2)} 次调用/会话`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  set('search-sub', searches
    ? (Number(stats?.toolCounts?.web_search) || 0) + (Number(stats?.toolCounts?.web_fetch) || 0) === searches
      ? '联网搜索 + 抓网页'
      : '联网搜索 + 抓网页'
    : '本区间没有联网');
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `每次会话输入 ${fmtTok(t.promptPerSession || 0)} · 输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  const createPct = t.promptTokens
    ? ((Number(t.cacheCreationTokens) || 0) / t.promptTokens * 100)
    : 0;
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)} · 新建 ${createPct.toFixed(1)}%`);
  set('cost', fmtYuan(t.cost));
  set('cost-sub', stats?.building
    ? `后台汇总历史用量 ${stats.progress?.total ? Math.round((stats.progress.done / stats.progress.total) * 100) : 0}% · ${stats?.rangeLabel || ''}`
    : (stats?.rangeLabel || ''));
  const bar = box.querySelector('[data-field="rate-bar"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (t.cacheHitRate || 0) * 100)).toFixed(1)}%`;

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

  // 行数很多时默认只显示前 N 行，点"展开全部"再看全部。
  // 后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  // 会话/模型都可能几十上百行，一次拼超长 innerHTML 也会卡。
  const COLLAPSE_AT = 20;
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = list || [];
    const collapsible = opts.collapsible !== false;
    const collapsed = collapsible && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">无</td></tr>';
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${((d.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`, { collapsible: false });

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${((c.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#chats-expand' });

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${((m.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });
}

/** 峰谷拆分条（弹窗外部上方展示；没用到分时段计价的模型则不显示）。 */
/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    try {
      const [stats, st] = await Promise.all([
        api(`/api/usage/stats?range=${usageRange}`),
        api('/api/status')
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;
  const hasDom = !!box.querySelector('.usage-wrap');
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;

  // ★ 先保证页面可见（0ms），再后台拉新数据：
  //   - DOM 已在且 range 没变（switchTab 刚画过 / 上次还在）→ 不再整页重建
  //   - 有同 range 旧数据但没 DOM → 立刻画旧数据
  //   - 都没有 → 骨架
  // 以前每次 force 都无脑 renderUsagePage，切页会连画两遍整页表格，特别卡。
  if (cached && hasDom) {
    state.usageStats = cached.stats;
  } else if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(`/api/usage/stats?range=${range}`),
      api('/api/status')
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    // 骨架屏也带 .usage-wrap，不能只看它就决定「只更新数值」——
    // 骨架里没有卡片标题/表格结构，必须先整页 renderUsagePage 换成正式 DOM，
    // 之后轮询才走 updateUsagePage 保滚动。
    const stillSkeleton = !!box.querySelector('.usage-card.skeleton');
    if (box.querySelector('.usage-wrap') && !stillSkeleton) {
      updateUsagePage(stats, st, prices);
    } else {
      // renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、绑定事件、
      // 并调用 updateUsagePage 填数值。
      renderUsagePage(stats, st, prices);
    }
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (!box.querySelector('.usage-wrap')) {
      box.innerHTML = `<div class="empty-hint">用量加载失败：${esc(e?.message || e)}</div>`;
    }
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${esc(key)}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`);
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${((x.cacheHitRate || 0) * 100).toFixed(0)}%</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}

// ── 记忆视图（全局按人，跨群）──
async function loadMemoryView() {
  try {
    const [cfg, data, selfImp] = await Promise.all([
      api('/api/config'),
      api('/api/memory-people'),
      api('/api/self-impressions').catch(() => ({ items: [], botName: '本鲸' }))
    ]);
    state.config = cfg;
    state.memoryFiles = data.people || [];
    state.memoryCost = await api('/api/cost-guard').catch(() => null);
    state.selfImpressions = selfImp.items || [];
    state.selfImpName = selfImp.botName || '本鲸';
    renderMemoryList();
    // 搜索框：只过滤列表，不整页刷新
    const searchEl = $('#memory-search');
    if (searchEl && !searchEl.dataset.bound) {
      searchEl.dataset.bound = '1';
      searchEl.addEventListener('input', () => {
        state.memoryQuery = String(searchEl.value || '').trim().toLowerCase();
        renderMemoryList();
      });
    }
    // 默认选中有 QQ 号的第一人
    if (!state.currentMemoryChatKey) {
      const first = (state.memoryFiles || []).find((f) => String(f.userId || '').trim())
        || (state.memoryFiles || [])[0];
      if (first) {
        const qq = String(first.userId || '').trim();
        state.currentMemoryChatKey = qq ? `people:${qq}` : `people:${first.name || '0'}`;
      }
    }
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个列表（否则整理期间每秒整页重绘一次）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
  }, 1000);
}

/** 印象类型 → 存档表里的短标签 */
const IMP_TYPE_LABEL = {
  identity: '身份',
  preference: '喜好',
  edge: '雷点',
  style: '风格',
  event: '事件'
};

function favorLabel(favor) {
  const v = Math.min(100, Math.max(0, Math.round(Number(favor) || 50)));
  if (v <= 13) return `敌意 ${v}`;
  if (v <= 27) return `冷淡 ${v}`;
  if (v <= 41) return `疏远 ${v}`;
  if (v <= 57) return `中性 ${v}`;
  if (v <= 71) return `友好 ${v}`;
  if (v <= 85) return `亲近 ${v}`;
  return `护短 ${v}`;
}

function favorColor(favor) {
  const v = Number(favor) || 50;
  if (v <= 27) return 'var(--red)';
  if (v <= 41) return 'var(--orange)';
  if (v <= 57) return 'var(--accent)';
  return 'var(--green)';
}

function renderMemoryList() {
  const box = $('#memory-items');
  if (!box) return;
  const files = state.memoryFiles || [];
  const notes = (state.config || {}).memberNotes || {};
  const searchEl = $('#memory-search');
  const q = String(searchEl?.value || state.memoryQuery || '').trim().toLowerCase();
  state.memoryQuery = q;
  // 锁 QQ：有号的按号排序置顶；搜 QQ/备注名/昵称
  const sorted = [...files].sort((a, b) => {
    const qa = String(a.userId || '');
    const qb = String(b.userId || '');
    if (qa && !qb) return -1;
    if (!qa && qb) return 1;
    if (qa && qb) return qa.localeCompare(qb, 'en', { numeric: true });
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  });
  const filtered = q
    ? sorted.filter((f) => {
      const who = String(notes[String(f.userId)] || f.name || '');
      const qq = String(f.userId || '');
      return qq.includes(q) || who.toLowerCase().includes(q) || String(f.name || '').toLowerCase().includes(q);
    })
    : sorted;
  const selfName = state.selfImpName || '本鲸';
  const selfItems = state.selfImpressions || [];
  const selfLast = selfItems.length ? selfItems[selfItems.length - 1] : '（点开写自我印象，会进角色卡）';
  const showSelf = !q
    || '本鲸'.includes(q) || '自己'.includes(q) || 'self'.includes(q)
    || String(selfName).toLowerCase().includes(q);
  const cost = state.memoryCost;
  const toolbar = `
    <div class="chat-toolbar" style="padding:6px 8px 2px;margin:0">
      <button class="btn btn-small" id="mem-consolidate-all-btn" type="button">一键整理</button>
      <button class="btn btn-small" id="mem-cleanup-btn" type="button" title="同QQ合并 + 同名合并 + 删垃圾 + 去重">轻清理</button>
      <button class="btn btn-small" id="mem-audit-btn" type="button">变更日志</button>
    </div>
    <div id="mem-consolidate-all-status" class="muted" style="padding:0 10px 6px;font-size:12px;min-height:14px"></div>
    <div class="session-meta" style="padding:0 14px 6px;margin:0">
      <span>${cost ? `今日 prompt ${fmtTok(cost.totalPrompt || 0)}` : ''}</span>
      <span>${filtered.length}/${files.length} 人</span>
      <span>本鲸 ${selfItems.length} 条</span>
    </div>`;
  const selfHtml = showSelf ? `
      <div class="chat-item ${state.currentMemoryChatKey === 'self' ? 'selected' : ''}" data-key="self" data-qq="">
        <div class="chat-item-title">
          <span class="session-chat">${esc(selfName)} · 自己</span>
          <span class="unread-pill" style="background:color-mix(in srgb,var(--accent) 80%,#fff)">人设卡</span>
        </div>
        <div class="chat-item-sub">${esc(selfLast)}</div>
        <div class="session-meta">
          <span>自我印象</span>
          <span>${selfItems.length} 条</span>
          <span>写进角色卡</span>
        </div>
      </div>` : '';
  const peopleHtml = !filtered.length
    ? (q ? '<div class="list-head muted">搜索无结果（试 QQ 号或备注名）</div>' : '')
    : filtered.map((f) => {
      const qq = String(f.userId || '').trim();
      const key = qq ? `people:${qq}` : `people:${f.name || '0'}`;
      const who = notes[String(f.userId)] || f.name || '（无备注）';
      const imps = f.impressions || [];
      const lastImp = imps.length ? String(imps[imps.length - 1].content || '') : '（空）';
      return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}" data-qq="${esc(qq)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(who)}</span>
          ${f.stale ? '<span class="unread-pill">旧</span>' : ''}
        </div>
        <div class="chat-item-sub">${esc(lastImp)}</div>
        <div class="session-meta">
          <span>QQ ${esc(qq || '—')}</span>
          <span>${imps.length} 条印象</span>
          <span>${favorLabel(f.favor ?? 50)}</span>
          <span>${fmtTime(f.updatedAt || 0)}</span>
        </div>
      </div>`;
    }).join('');
  const listHtml = selfHtml + peopleHtml || '<div class="list-head muted">还没有全局印象（模型 memory_append 或手动添加）</div>';
  if (!setHtmlIfChanged(box, toolbar + listHtml)) return;
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
  const allBtn = box.querySelector('#mem-consolidate-all-btn');
  allBtn?.addEventListener('click', async () => {
    if (allBtn.disabled) return;
    const st = box.querySelector('#mem-consolidate-all-status');
    allBtn.disabled = true;
    allBtn.textContent = '整理中…';
    if (st) st.textContent = '正在合并同名并逐会话整理…';
    try {
      const r = await api('/api/memory-people/consolidate-all', { method: 'POST', body: '{}' });
      if (st) {
        st.textContent = r?.ok
          ? `完成：合并${r.merged ?? 0} · 清垃圾${r.purged ?? 0} · ${r.chats ?? 0}会话`
          : (r?.error || '失败');
      }
      await loadMemoryView();
    } catch (e) {
      if (st) st.textContent = `失败：${e.message}`;
    } finally {
      setTimeout(() => {
        allBtn.disabled = false;
        allBtn.textContent = '一键整理';
      }, 2000);
    }
  });
  const cleanBtn = box.querySelector('#mem-cleanup-btn');
  cleanBtn?.addEventListener('click', async () => {
    if (cleanBtn.disabled) return;
    const st = box.querySelector('#mem-consolidate-all-status');
    cleanBtn.disabled = true;
    cleanBtn.textContent = '清理中…';
    if (st) st.textContent = '合并同名 / 删垃圾 / 去重印象…';
    try {
      const r = await api('/api/memory-people/cleanup', { method: 'POST', body: '{}' });
      if (st) {
        st.textContent = r?.ok
          ? `轻清理：同QQ${r.mergedQq ?? 0} · 合并${r.merged ?? 0} · 垃圾${r.purged ?? 0} · 去重${r.deduped ?? 0}`
          : (r?.error || '失败');
      }
      await loadMemoryView();
    } catch (e) {
      if (st) st.textContent = `失败：${e.message}`;
    } finally {
      setTimeout(() => {
        cleanBtn.disabled = false;
        cleanBtn.textContent = '轻清理';
      }, 1500);
    }
  });
  const auditBtn = box.querySelector('#mem-audit-btn');
  auditBtn?.addEventListener('click', async () => {
    try {
      const r = await api('/api/memory-audit?limit=40');
      const rows = r.rows || [];
      const body = rows.length
        ? `<table class="archive-table"><tbody>${rows.map((x) => {
          const t = new Date(x.ts || 0).toLocaleString('zh-CN', { hour12: false });
          const who = x.type === 'favor' ? `好感 ${x.from}→${x.to}` : (x.type || x.source || '');
          return `<tr>
            <td class="t">${esc(t)}</td>
            <td class="w">${esc(String(x.userId || ''))}</td>
            <td class="text">${esc(who)}${x.reason ? ` · ${esc(x.reason)}` : ''}${x.impressions != null ? ` · ${x.impressions}条` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>`
        : '<div class="empty-hint">还没有变更记录</div>';
      modelModalShell({
        head: '记忆变更日志',
        body,
        foot: '<button class="btn" type="button">关闭</button>'
      });
      const ov = document.querySelector('.model-modal-overlay:last-of-type');
      ov?.querySelector('.model-modal-foot .btn')?.addEventListener('click', () => closeModelModal(ov));
    } catch (e) {
      alert(e.message);
    }
  });
}

// ── 离散情绪总览页 ──
// 结构：
//   头 → 九型条 → 状态盘（核心 + 精力）→ 情绪（方向 → 正/负）→ 注入 → 事件
const EMO_DIR_META = [
  { key: 'out', title: '向外', tip: '会外显，来得快去得也快' },
  { key: 'in', title: '向内', tip: '闷在心里，衰减慢' },
  { key: 'neu', title: '中性', tip: '机动，看触发' }
];
const EMO_SIGN_META = [
  { key: 'neg', title: '负面', color: 'var(--red)' },
  { key: 'pos', title: '正面', color: 'var(--green)' },
  { key: 'neu', title: '中性', color: 'var(--accent)' }
];
const EMO_ENERGY_ROWS = [
  { key: 'physical', label: '身体', color: 'var(--green)' },
  { key: 'cognitive', label: '认知', color: 'var(--accent)' },
  { key: 'emotional', label: '情绪', color: 'var(--orange)' },
  { key: 'will', label: '意志', color: 'var(--muted)' }
];
const EMO_TYPE_LABEL = {
  roast: '被怼', praise: '被夸', tease: '玩闹',
  busy: '刷屏', ignore: '被冷落', toolFail: '工具挂',
  error: '出错', curiosity: '好奇', shame: '出丑',
  chat: '闲聊', mention: '被点名', memeOk: '接梗',
  help: '求助', sadness: '悲伤', boredom: '无聊',
  gratitude: '感激'
};
const EMO_NAME = {
  joy: '喜悦', cheer: '开心', pride: '自豪', smug: '得意', gratitude: '感激',
  curiosity: '好奇',
  anger: '愤怒', irk: '烦躁', anxiety: '焦虑', sadness: '悲伤',
  shame: '羞耻', loneliness: '孤独', down: '低落',
  boredom: '无聊'
};

function emoMeterHtml({ label, value, display, color, center = false }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const fill = center
    ? `left:${Math.round(v)}%;background:${color}`
    : `width:${v}%;background:${color};opacity:${v < 30 ? 0.55 : 1}`;
  return `
    <div class="bs-meter">
      <div class="bs-meter-head">
        <span class="bs-meter-label">${label}</span>
        <span class="bs-meter-val"${color ? ` style="color:${color}"` : ''}>${display ?? v}</span>
      </div>
      <div class="bs-track${center ? ' bs-track-center' : ''}" title="0~100${center ? '，50 在中间' : ''}">
        ${center ? '<div class="bs-mid"></div>' : ''}
        <div class="bs-fill${center ? ' bs-fill-mood' : ''}" style="${fill}"></div>
      </div>
      ${center ? '<div class="bs-ticks" aria-hidden="true"><span>闷</span><span>平</span><span>嗨</span></div>' : ''}
    </div>`;
}

/** 激活：带条的卡；未激活：芯片（只显示名字+强度），避免 21 张满卡糊成一片。 */
function emoItemHtml(e) {
  const sc = e.sign === 'neg' ? 'var(--red)' : e.sign === 'pos' ? 'var(--green)' : 'var(--accent)';
  if (!e.active) {
    return `
      <div class="emo-chip" style="--emo-c:${sc}"
        title="${esc(e.label)} · ${esc(e.signLabel)} · 半衰 ${e.halfLifeMin} 分">
        <span class="emo-chip-name">${esc(e.label)}</span>
        <span class="emo-chip-val">${e.value}</span>
      </div>`;
  }
  return `
    <div class="bs-emo-card is-hot" style="--emo-c:${sc}" title="${esc(e.signLabel)} · 半衰 ${e.halfLifeMin} 分">
      <div class="bs-emo-card-head">
        <span class="bs-emo-card-name">${esc(e.label)}</span>
        <span class="bs-emo-card-val">${e.value}</span>
      </div>
      <div class="bs-track bs-track-sm" style="margin-top:4px">
        <div class="bs-fill" style="width:${e.value}%;background:${sc}"></div>
      </div>
    </div>`;
}

/** 按 方向 → 正/负（中性方向里也再拆正/中） 分组；空组不渲染。 */
function buildEmotionSections(cat) {
  const byDirSign = {};
  for (const e of cat) {
    const dir = e.cat || 'neu';
    const sign = e.sign === 'pos' ? 'pos' : e.sign === 'neg' ? 'neg' : 'neu';
    const key = `${dir}::${sign}`;
    (byDirSign[key] ||= []).push(e);
  }
  for (const list of Object.values(byDirSign)) {
    list.sort((a, b) => (Number(b.active) - Number(a.active)) || (b.value - a.value));
  }
  return EMO_DIR_META.map((dir) => {
    const subs = EMO_SIGN_META
      .map((sign) => {
        const list = byDirSign[`${dir.key}::${sign.key}`] || [];
        if (!list.length) return null;
        const hotN = list.filter((x) => x.active).length;
        return { ...sign, list, hotN };
      })
      .filter(Boolean);
    if (!subs.length) return null;
    const all = subs.flatMap((s) => s.list);
    const hotAll = all.filter((x) => x.active).length;
    return { ...dir, subs, count: all.length, hotAll };
  }).filter(Boolean);
}

async function loadEmotionsView() {
  const box = $('#emotions-page');
  if (!box) return;
  try {
    const [bs, hype, emoProfiles, cfgNow] = await Promise.all([
      api('/api/bot-state'),
      api('/api/hype-mode').catch(() => ({ enabled: false })),
      api('/api/emotion-personalities').catch(() => ({ list: [], current: '' })),
      api('/api/config').catch(() => ({}))
    ]);
    const emoOn = cfgNow?.emotion?.enabled !== false;
    const cat = Array.isArray(bs.emotionCatalog) ? bs.emotionCatalog : [];
    const log = (bs.eventLog || []).slice(0, 8);
    const ed = bs.energyDetail || { physical: 50, cognitive: 50, emotional: 50, will: 50 };
    const moodRaw = Math.max(0, Math.min(100, Number(bs.moodRaw ?? 50)));
    const arousal = Math.max(0, Math.min(100, Number(bs.arousal) || 50));
    const acute = Math.max(0, Math.min(100, Number(bs.acuteStress) || 0));
    const chronic = Math.max(0, Math.min(100, Number(bs.chronicStress) || 0));
    const profileList = Array.isArray(emoProfiles?.list) ? emoProfiles.list : [];
    const profileCurrent = String(emoProfiles?.current || '');
    const profileNow = profileList.find((p) => p.id === profileCurrent) || null;
    const sections = buildEmotionSections(cat);
    const activeCount = cat.filter((x) => x.active).length;
    const moodColor = moodRaw >= 58 ? 'var(--green)' : moodRaw <= 42 ? 'var(--red)' : 'var(--accent)';
    const stressColor = (v) => v >= 60 ? 'var(--red)' : v >= 30 ? 'var(--orange)' : 'var(--faint)';
    const moodWord = bs.moodLabel || (moodRaw >= 58 ? '不错' : moodRaw <= 42 ? '低落' : '平稳');
    const arousalWord = arousal >= 70 ? '激动' : arousal >= 40 ? '正常' : '平静';

    const pageHtml = `
      <div class="emo-head">
        <div class="emo-head-titles">
          <h2>本体状态 · 情绪</h2>
          <div class="sub muted">跨群共享 · 事件半衰衰减 · 注入只挑最强 1~2 条</div>
        </div>
        <div class="emo-actions">
          <button id="emo-onoff-btn" class="btn btn-small${emoOn ? '' : ' is-off'}" type="button"
            title="只控制情绪/心情。精力仍按钟点与聊天消耗运转；世界系统开启时还会按日历/账本修正精力目标">${emoOn ? '情绪系统：开' : '情绪系统：已关'}</button>
          <button id="hype-mode-btn" class="btn btn-small${hype?.enabled ? ' is-hot' : ''}" type="button"
            title="手动切换。开启后情绪拉满、协议放开">${hype?.enabled ? '退出亢奋' : '进入亢奋'}</button>
          <button class="btn btn-small" id="emo-refresh" type="button">刷新</button>
          <button class="btn btn-small" id="emo-help" type="button">说明</button>
          <button class="btn btn-small" id="emo-reset" type="button">重置</button>
        </div>
      </div>

      ${emoOn ? '' : `<div class="hint block-note" style="margin-bottom:10px">
        <b>情绪系统已停用</b>：心情/离散情绪不再因群友发言变动，提示词里也只报精力。
        <b>精力仍在运转</b>（钟点目标 + 聊天消耗）；若「世界」页已开启且勾了「修正精力目标」，日历与账本仍会改精力。
        低精力会略抑制随机插嘴。点上方按钮可随时切回。</div>`}

      ${profileList.length && profileNow ? `
      <div id="emo-enneagram" class="ennea-card is-compact" data-current="${esc(profileCurrent)}">
        <div class="ennea-top">
          <div class="ennea-badge" aria-hidden="true">${profileNow.number ?? '?'}</div>
          <div class="ennea-meta">
            <div class="ennea-kicker">九型 · 情绪档</div>
            <div class="ennea-title">${esc(profileNow.name)}<span class="en">${esc(profileNow.en || '')}</span></div>
            <div class="ennea-line">${esc(profileNow.mean || profileNow.desc || '')}${profileNow.tip ? ` · ${esc(profileNow.tip)}` : ''}</div>
          </div>
          <div class="ennea-nav">
            <button type="button" class="ennea-arrow" id="ennea-prev" title="上一型" aria-label="上一型">‹</button>
            <button type="button" class="ennea-arrow" id="ennea-next" title="下一型" aria-label="下一型">›</button>
          </div>
        </div>
        <div class="ennea-dots" role="tablist" aria-label="选择九型">
          ${profileList.map((p) => `
            <button type="button" class="ennea-dot${p.id === profileCurrent ? ' is-on' : ''}" data-id="${esc(p.id)}"
              title="${esc(p.name)}" aria-label="第${p.number}型 ${esc(p.name)}"${p.id === profileCurrent ? ' aria-current="true"' : ''}>${p.number}</button>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- 核心 4 + 精力 4，拆两行，避免 8 格挤成一坨 -->
      <section class="emo-panel">
        <div class="emo-panel-head">
          <span class="emo-panel-title">状态</span>
          <span class="emo-panel-meta">
            ${profileNow ? `型${profileNow.number} ${esc(profileNow.name)} · ` : ''}
            ${bs.intent ? esc(bs.intent) : '无特别倾向'}
            ${activeCount ? ` · 活跃 ${activeCount}` : ''}
          </span>
        </div>
        <div class="emo-grid">
          ${emoMeterHtml({ label: '心情', value: moodRaw, display: `${moodWord} ${moodRaw}`, color: moodColor, center: true })}
          ${emoMeterHtml({ label: '唤醒', value: arousal, display: `${arousalWord} ${arousal}`, color: 'var(--orange)' })}
          ${emoMeterHtml({ label: '急压', value: acute, display: String(acute), color: stressColor(acute) })}
          ${emoMeterHtml({ label: '慢压', value: chronic, display: String(chronic), color: stressColor(chronic) })}
        </div>
        <div class="emo-sub-label">精力</div>
        <div class="emo-grid">
          ${EMO_ENERGY_ROWS.map((r) => {
            const v = Math.max(0, Math.min(100, Number(ed[r.key]) || 0));
            return emoMeterHtml({ label: r.label, value: v, color: r.color });
          }).join('')}
        </div>
      </section>

      <!-- 方向 → 正/负 分层；激活=卡片，未激活=芯片 -->
      <section class="emo-panel">
        <div class="emo-panel-head">
          <span class="emo-panel-title">离散情绪</span>
          <span class="emo-panel-meta">${activeCount ? `激活 ${activeCount} · 共 ${cat.length}` : `全部未激活 · 共 ${cat.length}`}</span>
        </div>
        ${sections.map((g) => `
          <div class="emo-dir" style="--dir-c:${g.color || 'var(--accent)'}">
            <div class="emo-dir-head">
              <span class="emo-dir-title">${g.title}</span>
              <span class="emo-dir-tip">${g.tip}</span>
              <span class="emo-dir-count">${g.hotAll ? `激活 ${g.hotAll}/${g.count}` : g.count}</span>
            </div>
            ${g.subs.map((s) => `
              <div class="emo-subdir" style="--sign-c:${s.color}">
                <div class="emo-subdir-label">
                  <i class="emo-subdir-dot"></i>${s.title}
                  <span class="emo-subdir-n">${s.hotN ? `${s.hotN}/${s.list.length}` : s.list.length}</span>
                </div>
                <div class="emo-items">${s.list.map(emoItemHtml).join('')}</div>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </section>

      <section class="emo-panel">
        <div class="emo-panel-head">
          <span class="emo-panel-title">注入预览</span>
          <span class="emo-panel-meta">每轮最多 1~2 句</span>
        </div>
        <div class="emo-inject">${esc(bs.promptLine || '（空）')}</div>
      </section>

      ${log.length ? `
      <section class="emo-panel">
        <div class="emo-panel-head">
          <span class="emo-panel-title">最近事件</span>
          <span class="emo-panel-meta">含情绪增减</span>
        </div>
        <div class="bs-events">
          ${log.map((e) => {
            const d = e.delta && typeof e.delta === 'object' ? e.delta : {};
            const parts = Object.entries(d)
              .filter(([, v]) => Number(v) !== 0)
              .map(([k, v]) => `${EMO_NAME[k] || k}${v > 0 ? '+' : ''}${v}`);
            return `
            <div class="bs-event">
              <span class="bs-event-time">${esc(fmtTime(e.at))}</span>
              <span class="bs-event-type">${esc(EMO_TYPE_LABEL[e.type] || e.type)}</span>
              ${e.text ? `<span class="bs-event-text">${esc(e.text)}</span>` : ''}
              ${parts.length ? `<span class="bs-event-delta">${esc(parts.join(' · '))}</span>` : ''}
            </div>`;
          }).join('')}
        </div>
      </section>` : ''}
    `;

    // 数值没变就跳过整页重建（20s 轮询 / SSE status 不再反复闪一下）
    const pageChanged = setHtmlIfChanged(box, pageHtml);
    if (pageChanged) {
      box.querySelector('#emo-refresh')?.addEventListener('click', () => loadEmotionsView());

      const switchEnnea = async (id) => {
        if (!id || id === profileCurrent) return;
        const prev = box.querySelector('#ennea-prev');
        const nextBtn = box.querySelector('#ennea-next');
        if (prev) prev.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        box.querySelectorAll('.ennea-dot').forEach((d) => {
          d.classList.toggle('is-on', d.getAttribute('data-id') === id);
        });
        try {
          await api('/api/emotion-personalities', { method: 'POST', body: JSON.stringify({ id }) });
        } catch (e) {
          console.warn('切换九型情绪档失败', e);
          alert(`切换失败：${e.message || e}`);
        }
        await loadEmotionsView();
      };
      box.querySelector('#ennea-prev')?.addEventListener('click', () => {
        if (!profileList.length) return;
        const idx = Math.max(0, profileList.findIndex((p) => p.id === profileCurrent));
        const next = profileList[(idx - 1 + profileList.length) % profileList.length];
        switchEnnea(next?.id);
      });
      box.querySelector('#ennea-next')?.addEventListener('click', () => {
        if (!profileList.length) return;
        const idx = Math.max(0, profileList.findIndex((p) => p.id === profileCurrent));
        const next = profileList[(idx + 1) % profileList.length];
        switchEnnea(next?.id);
      });
      box.querySelectorAll('.ennea-dot').forEach((btn) => {
        btn.addEventListener('click', () => switchEnnea(String(btn.getAttribute('data-id') || '').trim()));
      });

      box.querySelector('#emo-help')?.addEventListener('click', () => {
        const catLine = cat.map((x) =>
          `${x.label}（${x.catLabel}/${x.signLabel}·半衰${x.halfLifeMin}分·当前${x.value}）`
        ).join('\n');
        modelModalShell({
          head: '本体状态怎么算',
          body: `
            <div style="font-size:13px;line-height:1.7;max-height:70vh;overflow:auto;padding:4px 8px">
              <p style="margin:0 0 8px"><b>心情</b> 0~100（50 中性）：由情绪正负池拉动，再受疲劳/慢压打压，约 12~16 分半衰回落。</p>
              <p style="margin:0 0 8px"><b>唤醒</b>：高=想说话，低=困；约 8 分半衰回 50。</p>
              <p style="margin:0 0 8px"><b>急压</b>：刚被怼/刷屏/出错会抬，约 8 分半衰。<b>慢压</b>：说话成功与持续压力累加，约 120 分半衰；≥40 会压心情。</p>
              <p style="margin:0 0 8px"><b>精力四池</b>：身体/认知跟钟点目标（~15 分半衰）；世界系统开启时会叠加日历/账本修正。情绪池向 55 回（~4 分），发言小幅消耗。低精力会略压随机插嘴概率。</p>
              <p style="margin:0 0 8px"><b>离散情绪</b>：事件激活后按半衰衰减（尖峰 3~10 分，底色 15~25）。事件里的 ±n 是这一轮真实变化。</p>
              <p style="margin:0 0 8px"><b>来源</b>：finish 的 mood、聊天词表、工具成败、被冷落/刷屏等；同 kind 约 1~2.5 分钟冷却。</p>
              <p style="margin:12px 0 4px"><b>当前 ${cat.length} 种</b>（半衰分钟）：</p>
              <pre style="white-space:pre-wrap;margin:0;font-family:inherit;font-size:12px;color:var(--muted)">${esc(catLine || '（加载中）')}</pre>
            </div>`
        });
      });

      box.querySelector('#emo-reset')?.addEventListener('click', async () => {
        if (!confirm('重置心情/精力/压力/全部离散情绪？')) return;
        await api('/api/bot-state', { method: 'POST', body: JSON.stringify({ reset: true }) });
        await loadEmotionsView();
      });

      box.querySelector('#emo-onoff-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const turnOn = !emoOn;
        btn.disabled = true;
        try {
          await api('/api/config', { method: 'POST', body: JSON.stringify({ emotion: { enabled: turnOn } }) });
        } catch (e) {
          console.warn('切换情绪系统失败', e);
        }
        await loadEmotionsView();
      });

      box.querySelector('#hype-mode-btn')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const turnOn = !hype?.enabled;
        if (turnOn && !confirm('进入亢奋模式？\n· 所有情绪拉满\n· 模型 / 协议 / 人设切到亢奋版\n· 行为约束全部放开（工具调用除外）\n· 只能手动切回')) return;
        btn.disabled = true;
        try {
          await api('/api/hype-mode', { method: 'POST', body: JSON.stringify({ enabled: turnOn }) });
        } catch (e) {
          console.warn('切换亢奋模式失败', e);
        }
        await loadEmotionsView();
      });
    }

    // 在情绪页时定时拉一次：衰减/会话写状态后不用手点刷新
    if (!loadEmotionsView._timer) {
      loadEmotionsView._timer = setInterval(() => {
        if (state.tab === 'emotions' && !document.hidden) {
          const ae = document.activeElement;
          if (ae && (ae.id === 'ennea-prev' || ae.id === 'ennea-next' || ae.classList?.contains('ennea-dot'))) return;
          loadEmotionsView();
        }
      }, 20000);
    }
  } catch (e) {
    box.dataset.sig = '';
    box.innerHTML = `<div class="muted" style="font-size:12px;padding:8px">情绪页加载失败：${esc(e.message)}</div>`;
  }
}

// ── 免费 API：新用户注册 / 限时活动 / 长期免费 ──
const API_CATS = [
  { key: '新用户注册', hint: '注册就能领，不用抢' },
  { key: '限时活动', hint: '有截止时间，尽快领' },
  { key: '长期免费', hint: '长期有效的免费层' }
];
let apiNewsCat = '全部';

async function loadApiNewsView() {
  const box = $('#apinews-page');
  if (!box) return;

  box.innerHTML = `
    <div class="api-head">
      <div class="api-head-main">
        <h2>免费 API</h2>
        <div class="api-head-sub">AI 接口的免费额度情报 · 每天凌晨 4 点自动更新 · 同一家只留一条</div>
      </div>
      <div class="api-head-actions">
        <button class="btn btn-small btn-primary" id="apinews-refresh" type="button">立即刷新</button>
      </div>
    </div>
    <div class="api-status" id="apinews-status">加载中…</div>
    <div class="api-cats" id="apinews-cats"></div>
    <div class="api-list" id="apinews-body"><div class="empty-hint">加载中…</div></div>`;

  const body = box.querySelector('#apinews-body');
  const status = box.querySelector('#apinews-status');
  const catsEl = box.querySelector('#apinews-cats');
  let items = [];

  const catMeta = (c) => API_CATS.find((x) => x.key === c) || { key: c, hint: '' };

  const renderCats = () => {
    const counts = {};
    for (const it of items) counts[it.category] = (counts[it.category] || 0) + 1;
    const chips = [{ key: '全部', hint: '全部条目' }, ...API_CATS];
    catsEl.innerHTML = chips.map((c) => {
      const n = c.key === '全部' ? items.length : (counts[c.key] || 0);
      const on = apiNewsCat === c.key;
      return `<button type="button" class="api-cat${on ? ' on' : ''}${n ? '' : ' is-empty'}"
        data-cat="${esc(c.key)}" title="${esc(c.hint)}">
        <span class="api-cat-name">${esc(c.key)}</span>
        <span class="api-cat-num">${n}</span>
      </button>`;
    }).join('');
    catsEl.querySelectorAll('.api-cat').forEach((btn) => {
      btn.addEventListener('click', () => {
        apiNewsCat = btn.dataset.cat;
        renderCats();
        renderList();
      });
    });
  };

  const renderList = () => {
    const shown = apiNewsCat === '全部' ? items : items.filter((x) => x.category === apiNewsCat);
    if (!shown.length) {
      body.innerHTML = `<div class="api-empty">${items.length ? '这个分类下暂时没有条目' : '还没有收录到免费 API。点「立即刷新」抓一次。'}</div>`;
      return;
    }
    body.innerHTML = shown.map((it) => {
      const meta = catMeta(it.category);
      const links = (it.links || [])
        .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer" class="api-link">${esc(l.label || '链接')}</a>`)
        .join('');
      const dl = it.deadline && it.deadline !== '未知'
        ? `<span class="api-deadline">截止 ${esc(it.deadline)}</span>` : '';
      return `
        <article class="api-card" data-cat="${esc(it.category)}">
          <div class="api-card-main">
            <div class="api-card-top">
              <span class="api-tag">${esc(it.category || '')}</span>
              <h3 class="api-card-title">${esc(it.title || '')}</h3>
              ${dl}
            </div>
            ${it.summary ? `<p class="api-card-sum">${esc(it.summary)}</p>` : ''}
            ${links ? `<div class="api-card-links">${links}</div>` : ''}
          </div>
          <div class="api-card-hint">${esc(meta.hint)}</div>
        </article>`;
    }).join('');
  };

  const render = (data) => {
    items = Array.isArray(data?.items) ? data.items : [];
    const when = data?.updatedAt ? fmtTime(data.updatedAt) : '—';
    status.textContent = [
      `更新于 ${when}`,
      `共 ${items.length} 条`,
      data?.cached ? '缓存' : '',
      data?.stale ? '后台更新中' : '',
      data?.error ? data.error : ''
    ].filter(Boolean).join(' · ');
    renderCats();
    renderList();
  };

  const load = async (f) => {
    status.textContent = f ? '正在抓取并整理（约 30~90 秒）…' : '加载中…';
    try {
      const data = await api(`/api/api-news${f ? '?force=1' : ''}`);
      render(data);
    } catch (e) {
      body.innerHTML = `<div class="api-empty">加载失败：${esc(e.message)}</div>`;
      status.textContent = '';
    }
  };

  box.querySelector('#apinews-refresh')?.addEventListener('click', () => {
    if (!confirm('重新抓取并整理？会调用一次模型。')) return;
    load(true);
  });
  await load(false);
}

// ── 知识库（含梗库，按分类浏览） ──
async function loadMemesView() {
  const box = $('#memes-page');
  if (!box) return;
  const KB_PAGE = 5;
  const KB_EXPAND = 10; // 展开后每页最多 10 条，剩余翻页
  let stateKb = {
    q: '', category: '全部', data: null,
    expanded: new Set(),
    page: new Map(), // cat -> page index（0-based）
    imageCategory: ''
  };

  box.innerHTML = `
    <div class="kb-page">
      <div class="kb-hero">
        <div class="kb-hero-copy">
          <div class="kb-hero-eyebrow">KNOWLEDGE BASE</div>
          <h2>知识库</h2>
          <div class="sub muted">内部条目 · 外部 wiki · 图库</div>
        </div>
        <div class="kb-hero-meta"><span id="meme-count" class="kb-count-pill">…</span></div>
      </div>
      <div class="kb-toolbar">
        <input id="meme-q" type="search" class="kb-search" placeholder="搜索内部知识…" autocomplete="off" />
        <button class="btn btn-small" id="meme-search-btn">搜索</button>
        <button class="btn btn-small btn-primary" id="meme-add-btn">＋ 添加</button>
        <button class="btn btn-small" id="meme-import-btn" title="一次粘贴多条（内容 / 分类 | 内容 / 分类 | 内容 | 备注，也吃导出的 JSON）">⚡ 批量导入</button>
        <button class="btn btn-small" id="meme-export-btn" title="导出成 JSON（备份 / 换机器用）">导出</button>
      </div>
      <div id="kb-cats" class="kb-cats"></div>
      <div id="meme-list" class="kb-section"></div>
      <div id="kb-external" class="kb-section"></div>
      <div id="kb-images" class="kb-section"></div>
    </div>
  `;

  const listEl = box.querySelector('#meme-list');
  const countEl = box.querySelector('#meme-count');
  const qEl = box.querySelector('#meme-q');
  const catsEl = box.querySelector('#kb-cats');

  function renderCats(cats) {
    catsEl.innerHTML = cats.map((c) => {
      const on = stateKb.category === c.name;
      return `<button type="button" class="kb-cat-chip${on ? ' is-on' : ''}" data-cat="${esc(c.name)}">${esc(c.name)}<span class="kb-cat-n">${c.count}</span></button>`;
    }).join('');
    catsEl.querySelectorAll('.kb-cat-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        stateKb.category = btn.dataset.cat;
        load();
      });
    });
  }

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (stateKb.q) qs.set('q', stateKb.q);
      if (stateKb.category && stateKb.category !== '全部') qs.set('category', stateKb.category);
      const data = await api(`/api/knowledge?${qs}`);
      stateKb.data = data;
      countEl.textContent = `共 ${data.total ?? 0} 条`;
      renderCats(data.categories || [{ name: '全部', count: data.total || 0 }]);
      const items = data.items || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="empty-hint">没有条目</div>';
        return;
      }
      // 按分类分组；每库默认只露 5 条，多的可展开
      const byCat = new Map();
      for (const m of items) {
        const cat = m.category || (m.kind === 'note' ? '笔记' : '其它');
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(m);
      }
      const renderItem = (m) => {
        const tags = (m.tags || []).filter((t) => t && t !== m.category).map(esc);
        const metaBits = [
          m.kind === 'note' ? '笔记' : '',
          ...tags,
          `用过 ${m.uses || 1}`,
          m.pinned ? '📌 已钉住' : '',
          m.aging ? `还剩 ${m.daysLeft ?? '?'} 天过期` : (m.ageDays != null ? `已闲置 ${m.ageDays} 天` : '')
        ].filter(Boolean).join(' · ');
        return `
        <details class="kb-item${m.aging ? ' kb-aging' : ''}${m.pinned ? ' kb-pinned' : ''}">
          <summary>
            <div class="kb-main">
              <div class="kb-text">${esc(m.text)}</div>
              ${metaBits ? `<div class="kb-meta">${metaBits}</div>` : ''}
            </div>
            <div class="kb-actions">
              <button type="button" class="btn btn-icon meme-pin" data-text="${esc(m.text)}" data-pinned="${m.pinned ? '1' : '0'}" title="${m.pinned ? '取消钉住' : '钉住（不过期）'}" aria-label="${m.pinned ? '取消钉住' : '钉住'}">${m.pinned ? '取消' : '钉住'}</button>
              <button type="button" class="btn btn-icon meme-del" data-text="${esc(m.text)}" title="删除" aria-label="删除">删</button>
            </div>
          </summary>
          <div class="kb-note">${esc(m.note || '（无备注）')}</div>
        </details>`;
      };
      // 分类块顺序固定：当前对话优先 → 条目多的优先 → 名称。
      // 不固定的话，某个分类里"最近被用过"的条目一变，整页卡片就整体换位（看着像乱飘）。
      const catEntries = [...byCat.entries()].sort((a, b) => {
        if (a[0] === '当前对话') return -1;
        if (b[0] === '当前对话') return 1;
        return b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]), 'zh');
      });
      listEl.innerHTML = `<div class="kb-grid">${catEntries.map(([cat, list]) => {
        const openAll = stateKb.expanded.has(cat);
        let shown;
        let pageNav = '';
        if (!openAll) {
          shown = list.slice(0, KB_PAGE);
          if (list.length > KB_PAGE) {
            pageNav = `<button type="button" class="btn btn-small kb-more" data-cat="${esc(cat)}" data-act="expand" style="width:100%;margin-top:4px">展开（共 ${list.length} 条，每页 ${KB_EXPAND}）</button>`;
          }
        } else {
          const pages = Math.ceil(list.length / KB_EXPAND);
          const pi = Math.min(stateKb.page.get(cat) || 0, pages - 1);
          const start = pi * KB_EXPAND;
          shown = list.slice(start, start + KB_EXPAND);
          const pager = pages > 1
            ? `<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:6px">
                <button type="button" class="btn btn-small kb-more" data-cat="${esc(cat)}" data-act="prev" ${pi <= 0 ? 'disabled' : ''}>上一页</button>
                <span class="muted" style="font-size:11px">${pi + 1} / ${pages}</span>
                <button type="button" class="btn btn-small kb-more" data-cat="${esc(cat)}" data-act="next" ${pi >= pages - 1 ? 'disabled' : ''}>下一页</button>
              </div>`
            : '';
          pageNav = `<button type="button" class="btn btn-small kb-more" data-cat="${esc(cat)}" data-act="collapse" style="width:100%;margin-top:4px">收起</button>${pager}`;
        }
        return `
        <div class="kb-cat-block${cat === '当前对话' ? ' is-hot-cat' : ''}">
          <div class="kb-cat-head">
            <span class="kb-cat-title">${esc(cat)}</span>
            <span class="kb-cat-count">${openAll || list.length <= KB_PAGE ? list.length : `${shown.length}/${list.length}`}</span>
          </div>
          ${shown.map(renderItem).join('')}
          ${pageNav}
        </div>`;
      }).join('')}</div>`;
      listEl.querySelectorAll('.kb-more').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cat = btn.dataset.cat;
          const act = btn.dataset.act;
          if (act === 'expand') stateKb.expanded.add(cat);
          else if (act === 'collapse') stateKb.expanded.delete(cat);
          else if (act === 'prev') stateKb.page.set(cat, Math.max(0, (stateKb.page.get(cat) || 0) - 1));
          else if (act === 'next') stateKb.page.set(cat, (stateKb.page.get(cat) || 0) + 1);
          load();
        });
      });
      listEl.querySelectorAll('.meme-pin').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const pinned = btn.dataset.pinned !== '1';
          await api('/api/memes/pin', { method: 'POST', body: JSON.stringify({ text: btn.dataset.text, pinned }) });
          await load();
        });
      });
      listEl.querySelectorAll('.meme-del').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 在 summary 内的按钮会触发 details 开合，强制拦掉
          e.stopImmediatePropagation();
          if (!confirm(`删除「${btn.dataset.text}」？`)) return;
          await api('/api/memes', { method: 'DELETE', body: JSON.stringify({ text: btn.dataset.text }) });
          await load();
        });
      });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    }
  }

  box.querySelector('#meme-search-btn')?.addEventListener('click', () => {
    stateKb.q = qEl.value.trim();
    load();
  });
  qEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      stateKb.q = qEl.value.trim();
      load();
    }
  });
  /**
   * 单条添加 / 批量导入 / 导出（2026-09-22 重做）。
   *
   * ⚠️ 为什么以前"＋ 添加"点了没反应：那版用的是 **`prompt()`**。
   *    Electron 里 `window.prompt` 是不支持的（Chromium 早就移除了），调用直接返回 null，
   *    于是处理函数第一行就 return —— 表现就是"按钮什么用都没有"。
   *    现在全部换成页面内的弹窗（modelModalShell），不再用 prompt/alert。
   */
  const KB_IMPORT_HELP = [
    '每行一条，三种写法都认（`|` 前后空格随意）：',
    '  内容',
    '  分类 | 内容',
    '  分类 | 内容 | 备注/用法',
    '也可以直接粘贴「导出」出来的 JSON；以 - 或 * 开头的列表行同样能认。'
  ].join('\n');

  /** 弹一个"批量导入"窗口：既能选文件（.txt/.json），也能直接粘贴。 */
  function openMemeImportModal() {
    const overlay = modelModalShell({
      head: '批量导入内部知识',
      body: `
        <div class="field">
          <label>① 选一个文本文件（.txt / .json）</label>
          <input type="file" id="kb-import-file" accept=".txt,.json,text/plain,application/json" />
          <div class="hint">也可以把这个文件直接放进 data/knowledge-import/ 目录，然后点下面的「读取目录里的文件」。</div>
        </div>
        <div class="field" style="margin-top:10px">
          <label>② 或者直接粘贴</label>
          <textarea id="kb-import-text" rows="8" style="width:100%;font-family:var(--mono);font-size:12.5px"
            placeholder="新三国 | 折棒吃华莱士&#10;折棒 | 这题我会&#10;就一句普通内容"></textarea>
        </div>
        <div class="hint" style="white-space:pre-wrap;margin-top:8px">${esc(KB_IMPORT_HELP)}</div>
        <div class="hint" id="kb-import-preview" style="margin-top:6px"></div>`,
      foot: `<button class="btn btn-small" id="kb-import-dir">读取目录里的文件</button>
             <button class="btn" id="kb-import-cancel">取消</button>
             <button class="btn btn-primary" id="kb-import-go">导入</button>`
    });
    const ta = overlay.querySelector('#kb-import-text');
    const fileEl = overlay.querySelector('#kb-import-file');
    const preview = overlay.querySelector('#kb-import-preview');
    let pending = null;   // 从文件读进来、等着导入的内容

    const showPreview = (text, from) => {
      const items = parseMemeImport(text);
      pending = items.length ? items : null;
      preview.textContent = items.length
        ? `${from ? `已读入${from}，` : ''}解析出 ${items.length} 条：\n` + items.slice(0, 5).map((m, i) => `  ${i + 1}. ${m.tags.length ? `[${m.tags.join('/')}] ` : ''}${m.text}`).join('\n') + (items.length > 5 ? `\n  … 还有 ${items.length - 5} 条` : '')
        : '没解析出内容 —— 至少要有一行"内容"。';
      return items;
    };

    ta?.addEventListener('input', () => showPreview(ta.value, ''));
    fileEl?.addEventListener('change', async () => {
      const f = fileEl.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        ta.value = text.slice(0, 200000);
        showPreview(ta.value, `文件 ${f.name}`);
      } catch (e) { preview.textContent = `读文件失败：${e?.message || e}`; }
    });
    overlay.querySelector('#kb-import-dir')?.addEventListener('click', async () => {
      try {
        const r = await api('/api/knowledge-import/read', { method: 'POST', body: '{}' });
        if (!r?.ok) { preview.textContent = r?.error || '读目录失败'; return; }
        if (!r.files?.length) { preview.textContent = `目录里没有文件：${r.dir}（把 .txt / .json 放进去再点这个按钮）`; return; }
        ta.value = r.text.slice(0, 200000);
        showPreview(ta.value, `${r.files.length} 个文件（${r.dir}）`);
      } catch (e) { preview.textContent = `读目录失败：${e?.message || e}`; }
    });
    overlay.querySelector('#kb-import-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#kb-import-go')?.addEventListener('click', async () => {
      const items = pending || parseMemeImport(ta?.value || '');
      if (!items.length) { preview.textContent = '没解析出可导入的条目。'; return; }
      const btn = overlay.querySelector('#kb-import-go');
      if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
      let ok = 0;
      const failed = [];
      for (const m of items) {
        try {
          const r = await api('/api/memes', { method: 'POST', body: JSON.stringify(m) });
          if (r?.ok) ok += 1; else failed.push(`${m.text.slice(0, 18)}（${r?.error || '被拒'}）`);
        } catch (e) { failed.push(`${m.text.slice(0, 18)}（${e?.message || e}）`); }
      }
      await load();
      closeModelModal(overlay);
      showUploadToast(`知识库导入完成：成功 ${ok} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`,
        failed.length ? `示例：${failed[0]}` : `共尝试 ${items.length} 条`);
    });
  }

  /** 单条添加弹窗（替代 prompt 三连）。 */
  function openMemeAddModal() {
    const overlay = modelModalShell({
      head: '添加一条内部知识',
      body: `
        <div class="field"><label>内容（≤120 字）</label>
          <textarea id="kb-add-text" rows="3" style="width:100%" placeholder="例如：折棒吃华莱士＝他每次开播必点"></textarea></div>
        <div class="field" style="margin-top:8px"><label>分类 / 标签（逗号分隔，可留空）</label>
          <input id="kb-add-tags" type="text" placeholder="新三国, 折棒" /></div>
        <div class="field" style="margin-top:8px"><label>备注 / 用法（可选）</label>
          <input id="kb-add-note" type="text" placeholder="被问到时怎么用" /></div>
        <div class="hint" id="kb-add-msg" style="margin-top:6px"></div>`,
      foot: `<button class="btn" id="kb-add-cancel">取消</button>
             <button class="btn btn-primary" id="kb-add-save">保存</button>`
    });
    const msg = overlay.querySelector('#kb-add-msg');
    overlay.querySelector('#kb-add-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#kb-add-save')?.addEventListener('click', async () => {
      const text = String(overlay.querySelector('#kb-add-text')?.value || '').trim();
      if (!text) { msg.textContent = '内容不能为空。'; return; }
      const tags = String(overlay.querySelector('#kb-add-tags')?.value || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      const note = String(overlay.querySelector('#kb-add-note')?.value || '').trim();
      try {
        const r = await api('/api/memes', { method: 'POST', body: JSON.stringify({ text: text.slice(0, 120), tags, note: note.slice(0, 120), kind: 'meme' }) });
        if (!r?.ok) { msg.textContent = r?.error || '保存失败'; return; }
        closeModelModal(overlay);
        await load();
        showUploadToast('已添加', text.slice(0, 40));
      } catch (e) { msg.textContent = `保存失败：${e?.message || e}`; }
    });
  }

  box.querySelector('#meme-add-btn')?.addEventListener('click', () => openMemeAddModal());
  box.querySelector('#meme-import-btn')?.addEventListener('click', () => openMemeImportModal());
  box.querySelector('#meme-export-btn')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/memes/export', { method: 'POST', body: '{}' });
      if (!r?.ok) { alert(`导出失败：${r?.error || '未知错误'}`); return; }
      // Electron 里 <a download> 不一定弹保存框，所以后端直接写进 data/ 并回路径
      showUploadToast(`已导出 ${r.count} 条`, r.file);
      alert(`已导出 ${r.count} 条到：\n${r.file}\n\n（这个文件也能直接放回 data/knowledge-import/ 再导入）`);
    } catch (e) { alert(`导出失败：${e?.message || e}`); }
  });

  /**
  /** 把"粘贴进来的文本"解析成待导入条目（三种行格式 + 导出的 JSON）。 */
  function parseMemeImport(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    // ① JSON（导出格式，或 [{text:...}]）
    if (/^[\[{]/.test(text)) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (Array.isArray(j?.memes) ? j.memes : []);
        return arr.map((m) => ({
          text: String(m?.text || m?.content || '').trim().slice(0, 120),
          kind: m?.kind === 'note' ? 'note' : 'meme',
          tags: Array.isArray(m?.tags) ? m.tags.map(String).map((s) => s.trim()).filter(Boolean)
            : String(m?.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          note: String(m?.note || '').trim().slice(0, 120)
        })).filter((m) => m.text);
      } catch { /* 落到按行解析 */ }
    }
    // ② 按行：内容 / 分类 | 内容 / 分类 | 内容 | 备注
    const out = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim().replace(/^[-*·]\s*/, '');
      if (!s) continue;
      const parts = s.split('|').map((x) => x.trim());
      let tags = [];
      let body = '';
      let note = '';
      if (parts.length === 1) body = parts[0];
      else if (parts.length === 2) { tags = [parts[0]]; body = parts[1]; }
      else { tags = parts[0].split(/[,，、]/).map((x) => x.trim()).filter(Boolean); body = parts[1]; note = parts.slice(2).join(' | '); }
      const t = body.slice(0, 120);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ text: t, kind: 'meme', tags, note: note.slice(0, 120) });
    }
    return out;
  }

  async function renderExternalWiki() {
    const host = box.querySelector('#kb-external');
    if (!host) return;
    let sources = [];
    let triggerWords = [];
    try {
      const cfg = await api('/api/config');
      sources = Array.isArray(cfg.webSearch?.wiki?.sources) ? cfg.webSearch.wiki.sources : [];
      triggerWords = Array.isArray(cfg.knowledge?.external?.triggerWords)
        ? cfg.knowledge.external.triggerWords
        : [];
    } catch { /* ignore */ }

    const sourceBlocks = sources.length
      ? sources.map((s, i) => `
        <details class="kb-item">
          <summary>
            <div class="kb-main">
              <div class="kb-text" title="${esc(s.label || s.id)}">${esc(s.label || s.id)}</div>
              <div class="kb-meta" title="${esc(s.id)} · ${esc(s.baseUrl)}">${esc(s.id)} · ${esc(s.baseUrl)}</div>
            </div>
          </summary>
          <div class="kb-note">${esc(s.baseUrl)}</div>
          <div class="kb-wiki-row-actions">
            <button class="btn btn-small" type="button" data-wiki-edit="${i}">编辑</button>
            <button class="btn btn-small btn-danger" type="button" data-wiki-del="${i}">删除</button>
          </div>
        </details>`).join('')
      : `<div class="empty-hint" style="padding:6px 4px">还没有外部源。点下面的「一键导入常用源」，或用下面的表单自己加一个。</div>`;

    const wordChips = triggerWords.length
      ? triggerWords.map((w) => `<span class="btn btn-small" style="cursor:default">${esc(w)}</span>`).join('')
      : '<span class="muted" style="font-size:12px">暂无触发词</span>';

    host.innerHTML = `
      <div class="kb-section-head"><span class="kb-section-title">外部</span><span class="kb-section-n">wiki 源与触发词</span></div>
      <div class="kb-grid">
        <div class="kb-cat-block">
          <div class="kb-cat-head">
            <span class="kb-cat-title">Wiki 源</span>
            <span class="kb-cat-count">${sources.length}</span>
          </div>
          ${sourceBlocks}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 6px">
            <button class="btn btn-small btn-primary" id="kb-wiki-import" type="button" title="把萌娘百科 / 中文维基 / Minecraft Wiki 这些常用源一次填好并保存">⚡ 一键导入常用源</button>
            <button class="btn btn-small" id="kb-wiki-test" type="button">测试源</button>
          </div>
          <div class="field" style="margin-top:4px">
            <label>手动加一个源</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input id="kb-wiki-new-label" type="text" placeholder="显示名，如 萌娘百科" style="flex:1;min-width:120px" />
              <input id="kb-wiki-new-url" type="text" placeholder="根地址，如 https://zh.moegirl.org.cn" style="flex:2;min-width:180px" />
              <button class="btn btn-small" id="kb-wiki-add" type="button">＋ 添加</button>
            </div>
          </div>
          <div class="field" style="margin-top:6px">
            <label>批量编辑（每行一条，三种写法都认）</label>
            <textarea id="kb-wiki-sources" rows="4" placeholder="mywiki | 我的百科 | https://example.com/wiki&#10;萌娘百科 | https://zh.moegirl.org.cn&#10;https://zh.wikipedia.org">${esc(wikiSourcesToText({ sources }))}</textarea>
            <div class="hint" style="font-size:11px">写法随意：<code>id | 名字 | 根地址</code>、<code>名字 | 根地址</code>、或者直接贴一个网址都行（贴文章链接会自动取站点根）。</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <button class="btn btn-small btn-primary" id="kb-wiki-save" type="button">保存批量编辑</button>
          </div>
          <div class="hint" id="kb-wiki-hint" style="font-size:11px"></div>
        </div>
        <div class="kb-cat-block">
          <div class="kb-cat-head">
            <span class="kb-cat-title">触发词</span>
            <span class="kb-cat-count">${triggerWords.length}</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px 8px">${wordChips}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <input id="kb-trig-word" type="text" placeholder="新触发词，如 萌娘设定" style="flex:1;min-width:100px" />
            <button class="btn btn-small" id="kb-trig-add" type="button">＋ 添加</button>
          </div>
          <div class="hint" style="font-size:11px;margin-top:4px">聊天里出现这些词 → 提示去 external_lookup 查外部百科。</div>
        </div>
      </div>`;

    /** 保存一份源列表（统一的写入口：导入 / 添加 / 删除 / 编辑 / 批量都走它）。 */
    const saveSources = async (next, okText) => {
      const hint = host.querySelector('#kb-wiki-hint');
      const list = (Array.isArray(next) ? next : []).filter((s) => s && s.baseUrl);
      if (!list.length) { if (hint) hint.textContent = '至少要有一个源（根地址必填）。'; return false; }
      try {
        await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ webSearch: { wiki: { enabled: true, default: list[0].id, wikiSearchSource: '', sources: list } } })
        });
        if (hint) hint.textContent = okText || `已保存 ${list.length} 个源。`;
        await renderExternalWiki();
        return true;
      } catch (e) {
        if (hint) hint.textContent = `保存失败：${e?.message || e}`;
        return false;
      }
    };

    /** 常用源一键导入：与已有源按 baseUrl 去重后合并保存，然后立刻测一次。 */
    host.querySelector('#kb-wiki-import')?.addEventListener('click', async () => {
      const hint = host.querySelector('#kb-wiki-hint');
      if (hint) hint.textContent = '导入中…';
      const have = new Set(sources.map((s) => String(s.baseUrl || '').replace(/\/+$/, '')));
      const add = wikiPresets().filter((p) => !have.has(p.baseUrl));
      const merged = [...sources, ...add];
      const ok = await saveSources(merged, `已导入 ${add.length} 个常用源（共 ${merged.length} 个）。正在测试…`);
      if (!ok) return;
      try {
        const r = await api('/api/external-lookup-test', { method: 'POST', body: JSON.stringify({ q: '测试' }) });
        const h2 = host.querySelector('#kb-wiki-hint');
        if (h2) h2.textContent = `已导入 ${add.length} 个常用源（共 ${merged.length} 个）。测试：` + (r.ok ? `OK（${r.label || ''}）` : (r.error || '失败'));
      } catch { /* 测试失败不影响导入结果 */ }
    });

    // 手动加一条
    host.querySelector('#kb-wiki-add')?.addEventListener('click', async () => {
      const label = String(host.querySelector('#kb-wiki-new-label')?.value || '').trim();
      const url = String(host.querySelector('#kb-wiki-new-url')?.value || '').trim();
      if (!url) { const h = host.querySelector('#kb-wiki-hint'); if (h) h.textContent = '根地址必填，例如 https://zh.moegirl.org.cn'; return; }
      const one = wikiSourcesFromText(label ? `${label} | ${url}` : url)[0];
      if (!one) { const h = host.querySelector('#kb-wiki-hint'); if (h) h.textContent = '这个地址看着不像 http(s) 网址。'; return; }
      await saveSources([...sources, one], `已添加「${one.label}」。`);
    });

    // 逐条：编辑 / 删除
    host.querySelectorAll('[data-wiki-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const s = sources[Number(btn.dataset.wikiEdit)];
      if (!s) return;
      const l = host.querySelector('#kb-wiki-new-label'); if (l) l.value = s.label || '';
      const u = host.querySelector('#kb-wiki-new-url'); if (u) u.value = s.baseUrl || '';
      const h = host.querySelector('#kb-wiki-hint');
      if (h) h.textContent = `已把「${s.label || s.id}」读进上面的表单：改完点「＋ 添加」会用新值存一份（旧的请点它的「删除」）。`;
    }));
    host.querySelectorAll('[data-wiki-del]').forEach((btn) => btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.wikiDel);
      const s = sources[i];
      if (!s) return;
      if (!confirm(`删掉 wiki 源「${s.label || s.id}」？\n${s.baseUrl}`)) return;
      await saveSources(sources.filter((_, k) => k !== i), `已删除「${s.label || s.id}」。`);
    }));

    host.querySelector('#kb-wiki-save')?.addEventListener('click', async () => {
      const ta = host.querySelector('#kb-wiki-sources');
      const next = wikiSourcesFromText(ta?.value || '');
      if (!next.length) {
        const h = host.querySelector('#kb-wiki-hint');
        if (h) h.textContent = '没解析出源：一行至少要有网址（例：https://zh.moegirl.org.cn，或「萌娘百科 | https://zh.moegirl.org.cn」）。';
        return;
      }
      await saveSources(next, `已保存 ${next.length} 个源。`);
    });
    host.querySelector('#kb-wiki-test')?.addEventListener('click', async () => {
      const hint = host.querySelector('#kb-wiki-hint');
      if (hint) hint.textContent = '测试中…';
      try {
        const r = await api('/api/external-lookup-test', { method: 'POST', body: JSON.stringify({ q: '测试' }) });
        if (hint) hint.textContent = r.ok ? `OK（${r.label || ''}，命中 ${r.hits ?? 0}）` : (r.error || '失败');
      } catch (e) {
        if (hint) hint.textContent = `失败：${e.message}`;
      }
    });
    const saveWords = async (words) => {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          knowledge: {
            external: { enabled: true, triggerWords: words }
          }
        })
      });
      await renderExternalWiki();
    };
    host.querySelector('#kb-trig-add')?.addEventListener('click', async () => {
      const inp = host.querySelector('#kb-trig-word');
      const w = (inp?.value || '').trim();
      if (!w) return;
      const next = [...new Set([...triggerWords, w])].slice(0, 40);
      await saveWords(next);
    });
    host.querySelector('#kb-trig-word')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        host.querySelector('#kb-trig-add')?.click();
      }
    });
    host.querySelectorAll('.kb-item').forEach((el, i) => {
      el.addEventListener('dblclick', async () => {
        // ⚠️ 原来用 prompt() 问要删哪个触发词 —— Electron 不支持，点了没反应。
        //    改成"双击 = 删掉本条目里的触发词"（条目上就写着是哪个词，不需要再问）。
        const word = String(el.querySelector('.kb-text')?.textContent || '').trim();
        if (!word) return;
        const next = triggerWords.filter((x) => x !== word);
        if (next.length === triggerWords.length) return;
        await saveWords(next);
      });
      void i;
    });
    // 单独删触发词：点 chip 时确认删除
    host.querySelectorAll('#kb-external .kb-cat-block .btn').forEach((chip) => {
      if (chip.id) return;
      const text = chip.textContent.trim();
      if (!text || triggerWords.indexOf(text) < 0) return;
      chip.style.cursor = 'pointer';
      chip.title = '点击删除';
      chip.addEventListener('click', async () => {
        if (!confirm(`删除触发词「${text}」？`)) return;
        await saveWords(triggerWords.filter((x) => x !== text));
      });
    });
  }

  async function renderImageLib() {
    const host = box.querySelector('#kb-images');
    if (!host) return;
    const cat = stateKb.imageCategory || '';
    const cats = [
      { name: '全部', key: '' },
      { name: '形象 self', key: 'self' },
      { name: '梗图', key: 'meme' },
      { name: '美术', key: 'art' },
      { name: '其它', key: 'other' }
    ];
    let data = { images: [], total: 0 };
    try {
      const qs = new URLSearchParams({ limit: '80' });
      if (cat) qs.set('category', cat);
      data = await api(`/api/images-lib?${qs}`);
    } catch (e) {
      host.innerHTML = `<div class="empty-hint">图库加载失败：${esc(e.message)}</div>`;
      return;
    }
    const images = data.images || [];
    const catBtns = cats.map((c) => {
      const active = (stateKb.imageCategory || '') === c.key;
      return `<button type="button" class="btn btn-small kb-img-cat${active ? ' btn-primary' : ''}" data-cat="${esc(c.key)}">${esc(c.name)}</button>`;
    }).join('');
    host.innerHTML = `
      <div class="kb-section-head"><span class="kb-section-title">图库</span><span class="kb-section-n">${images.length}/${data.total ?? images.length} 张</span></div>
      <div class="kb-cat-block">
        <div class="kb-cat-head">
          <span class="kb-cat-title">图片</span>
          <span class="kb-cat-count">与表情包分开</span>
        </div>
        <div class="kb-img-toolbar">
          <div class="kb-img-cats">${catBtns}</div>
        </div>
        <div class="kb-img-import" id="lib-drop">
          <div class="kb-img-drop" id="lib-dropzone">
            <div class="kb-img-drop-main">把图片拖到这里导入（可多张）</div>
            <div class="kb-img-drop-sub">或
              <label class="btn btn-small" style="cursor:pointer;margin:0 4px">
                选择文件
                <input type="file" id="lib-file" accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp" multiple hidden />
              </label>
              · 支持 png / jpg / gif / webp / bmp
            </div>
          </div>
          <div class="kb-img-import-row">
            <input type="text" id="lib-url" placeholder="也可以填公网 URL 或本地绝对路径" style="flex:2;min-width:160px" />
            <input type="text" id="lib-note" placeholder="备注（多张时作前缀）" style="flex:1.5" />
            <select id="lib-cat" style="flex:1">
              <option value="other">其它</option>
              <option value="self">形象 self</option>
              <option value="meme">梗图</option>
              <option value="art">美术</option>
            </select>
            <input type="text" id="lib-tags" placeholder="标签，逗号分隔" style="flex:1" />
            <button class="btn btn-small btn-primary" id="lib-import-btn" type="button">导入</button>
          </div>
          <div class="hint" id="lib-import-hint" style="font-size:11px">文件会存到 data/images-lib/files/；self = 机器人自己的形象图，问「你长什么样」时优先用。</div>
        </div>
        <div class="kb-img-grid">
          ${images.length ? images.map((img) => `
            <div class="kb-img-card" data-id="${esc(img.id)}">
              <div class="kb-img-thumb">
                <img src="${esc(img.preview || img.url || '')}" alt="${esc(img.note || img.id)}" loading="lazy" />
              </div>
              <div class="kb-img-meta">
                <div class="kb-img-note" title="${esc(img.note || '')}">${esc(img.note || img.id)}</div>
                <div class="kb-img-sub">
                  <span class="tag">${esc(img.category)}</span>
                  ${img.tags?.slice(0, 3).map((t) => `<span class="muted">${esc(t)}</span>`).join('') || ''}
                  <span class="muted">用 ${img.uses || 0}</span>
                </div>
                <div class="kb-img-acts">
                  <button type="button" class="btn btn-small lib-edit" data-id="${esc(img.id)}">编辑</button>
                  <button type="button" class="btn btn-small btn-danger lib-del" data-id="${esc(img.id)}">删</button>
                </div>
              </div>
            </div>`).join('')
        : `<div class="empty-hint" style="grid-column:1/-1">图库还是空的。导入形象图 / 梗图后，机器人可发图库里的图。</div>`}
        </div>
      </div>`;

    host.querySelectorAll('.kb-img-cat').forEach((btn) => {
      btn.addEventListener('click', () => {
        stateKb.imageCategory = btn.dataset.cat || '';
        void renderImageLib();
      });
    });
    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error(`读取「${file.name}」失败`));
        r.readAsDataURL(file);
      });
    }

    async function importOneFile(file, { note, category, tags }) {
      if (!file) throw new Error('没有文件');
      if (file.size > 10 * 1024 * 1024) throw new Error(`「${file.name}」超过 10MB`);
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('data:application/octet-stream')) {
        throw new Error(`「${file.name}」不是图片文件`);
      }
      const body = {
        dataUrl,
        note: (note ? `${note} ${file.name}` : file.name).slice(0, 160),
        category,
        tags
      };
      const r = await api('/api/images-lib', { method: 'POST', body: JSON.stringify(body) });
      if (!r?.ok) throw new Error(r?.error || `「${file.name}」导入失败`);
      return r;
    }

    async function importFiles(fileList, { url = '' } = {}) {
      const hint = host.querySelector('#lib-import-hint');
      const btn = host.querySelector('#lib-import-btn');
      const note = (host.querySelector('#lib-note')?.value || '').trim();
      const category = host.querySelector('#lib-cat')?.value || 'other';
      const tags = (host.querySelector('#lib-tags')?.value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const files = [...(fileList || [])].filter((f) => f && (f.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(f.name || '')));
      const remote = String(url || host.querySelector('#lib-url')?.value || '').trim();

      if (!files.length && !remote) {
        if (hint) hint.textContent = '请拖入/选择图片，或填 URL / 本地路径。';
        return;
      }
      if (btn) btn.disabled = true;
      const okNames = [];
      const errs = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (hint) hint.textContent = `导入中 ${i + 1}/${files.length}：${f.name}…`;
          try {
            await importOneFile(f, { note, category, tags });
            okNames.push(f.name);
          } catch (e) {
            errs.push(e.message);
          }
        }
        if (remote) {
          if (hint) hint.textContent = '导入 URL…';
          try {
            const r = await api('/api/images-lib', {
              method: 'POST',
              body: JSON.stringify({ url: remote, note, category, tags })
            });
            if (!r?.ok) throw new Error(r?.error || '导入失败');
            okNames.push(remote.slice(0, 40));
          } catch (e) {
            errs.push(e.message);
          }
        }
        if (okNames.length && !errs.length) {
          if (hint) hint.textContent = `已导入 ${okNames.length} 张`;
        } else if (okNames.length) {
          if (hint) hint.textContent = `成功 ${okNames.length} · 失败：${errs.join('；')}`;
        } else {
          if (hint) hint.textContent = `导入失败：${errs.join('；') || '未知错误'}`;
        }
        if (okNames.length) {
          // 清 URL 输入，避免误重复
          const urlEl = host.querySelector('#lib-url');
          if (urlEl && remote) urlEl.value = '';
          await renderImageLib();
        }
      } finally {
        // re-render 后 btn 可能已是新节点；disabled 在旧节点上无所谓
        if (btn) btn.disabled = false;
      }
    }

    host.querySelector('#lib-import-btn')?.addEventListener('click', () => {
      const fileInput = host.querySelector('#lib-file');
      void importFiles(fileInput?.files || []);
    });
    host.querySelector('#lib-file')?.addEventListener('change', (e) => {
      const list = e.target?.files;
      if (list?.length) void importFiles(list);
    });

    const dropzone = host.querySelector('#lib-dropzone');
    const dropRoot = host.querySelector('#lib-drop');
    const bindDrop = (el) => {
      if (!el) return;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('is-over');
      });
      el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('is-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('is-over');
        const dt = e.dataTransfer;
        const files = dt?.files || [];
        if (files.length) void importFiles(files);
      });
    };
    bindDrop(dropzone);
    bindDrop(dropRoot);
    // 整页拦一下默认打开文件，避免拖偏了就炸
    ['dragover', 'drop'].forEach((ev) => {
      host.addEventListener(ev, (e) => {
        if (ev === 'drop' && e.dataTransfer?.files?.length) e.preventDefault();
      });
    });
    host.querySelectorAll('.lib-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('从图库删除这张图？（不会删磁盘上的原文件）')) return;
        try {
          await api('/api/images-lib', { method: 'DELETE', body: JSON.stringify({ id: btn.dataset.id }) });
          await renderImageLib();
        } catch (e) {
          alert(e.message);
        }
      });
    });
    host.querySelectorAll('.lib-edit').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const img = images.find((x) => x.id === btn.dataset.id);
        if (!img) return;
        // ⚠️ 这里原来是三个 prompt()（备注/标签/分类）—— Electron 不支持 window.prompt，
        //    点了等于没反应。换成页面内弹窗（2026-09-22）。
        const overlay = modelModalShell({
          head: `编辑图片：${img.note || img.id}`,
          body: `
            <div class="field"><label>备注</label>
              <input id="lib-edit-note" type="text" value="${esc(img.note || '')}" placeholder="这张图是什么" /></div>
            <div class="field" style="margin-top:8px"><label>标签（逗号分隔）</label>
              <input id="lib-edit-tags" type="text" value="${esc((img.tags || []).join(','))}" placeholder="表情, 自拍, 蓝发" /></div>
            <div class="field" style="margin-top:8px"><label>分类</label>
              <select id="lib-edit-cat">
                ${['self', 'meme', 'art', 'other'].map((c) => `<option value="${c}" ${(img.category || 'other') === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select></div>
            <div class="hint" id="lib-edit-msg" style="margin-top:6px"></div>`,
          foot: '<button class="btn" id="lib-edit-cancel">取消</button><button class="btn btn-primary" id="lib-edit-save">保存</button>'
        });
        overlay.querySelector('#lib-edit-cancel')?.addEventListener('click', () => closeModelModal(overlay));
        overlay.querySelector('#lib-edit-save')?.addEventListener('click', async () => {
          const msg = overlay.querySelector('#lib-edit-msg');
          const note = String(overlay.querySelector('#lib-edit-note')?.value || '').trim();
          const tagsRaw = String(overlay.querySelector('#lib-edit-tags')?.value || '');
          const category = String(overlay.querySelector('#lib-edit-cat')?.value || 'other');
          try {
            await api('/api/images-lib', {
              method: 'POST',
              body: JSON.stringify({
                id: img.id,
                url: img.url,
                note: note.slice(0, 160),
                tags: tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                category: ['self', 'meme', 'art', 'other'].includes(category) ? category : 'other'
              })
            });
            closeModelModal(overlay);
            await renderImageLib();
          } catch (e) { if (msg) msg.textContent = `保存失败：${e?.message || e}`; }
        });
      });
    });
  }

  await load();
  await renderExternalWiki();
  await renderImageLib();
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';

  // 本体自我印象 → 同步角色卡
  if (String(chatKey) === 'self') {
    try {
      const data = await api('/api/self-impressions');
      state.selfImpressions = data.items || [];
      state.selfImpName = data.botName || '本鲸';
      const who = state.selfImpName || '本鲸';
      const imps = state.selfImpressions;
      const rows = imps.length
        ? imps.map((line, i) => `
          <tr>
            <td class="t">#${i + 1}</td>
            <td class="w">自我</td>
            <td class="text">
              <span class="self-imp-line">${esc(line)}</span>
              <button class="btn btn-small self-imp-del" data-line="${esc(line)}" style="margin-left:8px">删</button>
            </td>
          </tr>`).join('')
        : '<tr><td class="text muted" colspan="3">还没有自我印象。点下面「添加」，会直接写进角色卡。</td></tr>';
      detail.innerHTML = `
        <div class="detail-header">
          <h2>${esc(who)} · 自己</h2>
          <div class="sub">
            <span>自我印象</span>
            <span>${imps.length} 条</span>
            <span>写入 persona.roleText</span>
            <span>改完热重载生效</span>
          </div>
        </div>
        <div class="chat-toolbar">
          <input type="text" id="self-imp-input" placeholder="例如：喜欢古典/摇滚；被叫胖鲸必须嘟囔" style="flex:1" />
          <button class="btn btn-small btn-primary" id="self-imp-add" type="button">添加</button>
          <button class="btn btn-small" id="self-imp-edit-all" type="button">整表编辑</button>
        </div>
        <div class="hint" style="margin-bottom:8px">这一区会同步进角色卡「## 自我印象」标记之间；删除立刻从角色卡拿掉。保存后托盘「热重载」即可。</div>
        <table class="archive-table"><tbody>${rows}</tbody></table>
        <div class="list-more muted" style="padding-top:8px">和表情/群友印象分开 · 只影响「你是谁」这一层</div>
      `;
      const reloadSelf = async () => {
        await loadMemoryDetail('self');
        await loadMemoryView();
        if (state.currentMemoryChatKey === 'self') renderMemoryList();
      };
      detail.querySelector('#self-imp-add')?.addEventListener('click', async () => {
        const inp = detail.querySelector('#self-imp-input');
        const text = (inp?.value || '').trim();
        if (!text) return;
        try {
          await api('/api/self-impressions', { method: 'POST', body: JSON.stringify({ add: text }) });
          await reloadSelf();
        } catch (e) {
          alert(e.message);
        }
      });
      detail.querySelector('#self-imp-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          detail.querySelector('#self-imp-add')?.click();
        }
      });
      detail.querySelectorAll('.self-imp-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const line = btn.dataset.line || '';
          if (!confirm(`从角色卡删掉「${line}」？`)) return;
          try {
            await api('/api/self-impressions', { method: 'POST', body: JSON.stringify({ remove: line }) });
            await reloadSelf();
          } catch (e) {
            alert(e.message);
          }
        });
      });
      detail.querySelector('#self-imp-edit-all')?.addEventListener('click', () => {
        const overlay = modelModalShell({
          head: `编辑「${esc(who)}」自我印象`,
          body: `
            <div class="field">
              <label>一行一条（直接覆盖角色卡该区）</label>
              <textarea id="self-imp-all" style="min-height:180px">${esc(imps.join('\n'))}</textarea>
            </div>
            <div class="hint">保存后立即写入 persona.roleText 的「## 自我印象」区；删掉的行会从角色卡消失。</div>`,
          foot: `<button class="btn" id="self-imp-cancel">取消</button>
                 <button class="btn btn-primary" id="self-imp-save">保存到角色卡</button>`
        });
        overlay.querySelector('#self-imp-cancel')?.addEventListener('click', () => closeModelModal(overlay));
        overlay.querySelector('#self-imp-save')?.addEventListener('click', async () => {
          const items = (overlay.querySelector('#self-imp-all')?.value || '')
            .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          try {
            await api('/api/self-impressions', { method: 'POST', body: JSON.stringify({ items }) });
            closeModelModal(overlay);
            await reloadSelf();
          } catch (e) {
            alert(e.message);
          }
        });
      });
    } catch (e) {
      detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    }
    return;
  }

  try {
    const [data, cfg, cost] = await Promise.all([
      api('/api/memory-people'),
      api('/api/config'),
      api('/api/cost-guard').catch(() => null)
    ]);
    const notes = cfg.memberNotes || {};
    const people = data.people || [];
    const qq = String(chatKey || '').replace(/^people:/, '');
    // 优先精确 QQ 匹配；找不到再退回列表第一人（旧 name-only 键）
    const m = people.find((x) => String(x.userId || '') === qq)
      || people.find((x) => String(x.userId || '').trim() && qq.includes(String(x.userId)))
      || people[0];
    if (!m) {
      detail.innerHTML = '<div class="empty-hint">还没有全局印象</div>';
      return;
    }
    const who = notes[String(m.userId)] || m.name || m.userId || '某人';
    const favor = Number(m.favor ?? 50);
    const imps = (m.impressions || []).slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const costLine = cost
      ? ` · 今日 prompt ${fmtTok(cost.totalPrompt || 0)} · 待办 ${(cost.todos || []).length}`
      : '';
    const todosHtml = cost?.todos?.length
      ? `<details class="collapsible" style="margin:10px 0"><summary>未完待办（${cost.todos.length}）</summary><div class="coll-body">${cost.todos.map((t) => `- ${t.userId ? `@${t.userId} ` : ''}${esc(t.text)}（${t.leftMin}分）`).join('\n')}</div></details>`
      : '';
    // 存档同款表头结构：时间 | 类型 | 内容
    const rows = imps.length
      ? imps.map((e) => `
        <tr class="${e.pin ? 'unread' : ''}">
          <td class="t">${fmtTime(e.createdAt || e.lastSeen || 0)}</td>
          <td class="w">${e.pin ? '★ 钉住' : esc(IMP_TYPE_LABEL[e.type] || '事件')}</td>
          <td class="text">${esc(e.content)}</td>
        </tr>`).join('')
      : '<tr><td class="text muted" colspan="3">还没有印象。点上面「添加印象」。</td></tr>';
    // 表层记忆（近况）：只列还活着的；浓度越低越淡（半衰），淡完自己消失
    const surface = Array.isArray(m.surface) ? m.surface : [];
    const surfaceHtml = `
      <div class="mem-attitude-card mem-surface-card">
        <div class="mem-attitude-head">
          <span class="mem-attitude-label">近况</span>
          <span class="mem-attitude-sub">表层记忆 · 从他自己的话里抓的，随时间半衰、淡完自动消失</span>
        </div>
        <div class="mem-surface-body">${surface.length
          ? surface.map((s) => `
            <span class="mem-surface-chip" style="opacity:${(0.45 + 0.55 * Math.min(1, Number(s.weight) || 0)).toFixed(2)}" title="${esc(s.cn || s.kind)} · 浓度 ${Math.round((Number(s.weight) || 0) * 100)}%">
              <i>${esc(s.cn || s.kind)}</i>${esc(s.text)}<em>${esc(s.age || '')}</em>
              <button class="mem-surface-del" data-qq="${esc(m.userId)}" data-kind="${esc(s.kind)}" title="清掉这条近况">✕</button>
            </span>`).join('')
          : '<span class="mem-attitude-empty">暂无近况（他最近没说过"累了/在忙/在等"这类短句）</span>'}</div>
      </div>`;
    // 「整理此人印象」：后端 /api/memory-files/consolidate 早就支持 userIds（"唯一入口"里写明的
    // 第三种用法），但界面一直没有入口 —— 于是想给某个人重抽印象只能跑「一键整理」把所有群
    // 都过一遍（每个群一次模型调用）。这里按他出现过的会话挑一个（优先群聊）来整理。
    const memChat = (Array.isArray(m.chats) ? m.chats : []).find((k) => String(k).startsWith('group:'))
      || (Array.isArray(m.chats) ? m.chats[0] : '') || '';
    const busyNote = memChat && state.consolidating[memChat]
      ? `整理中…（已 ${Math.max(0, Math.round((Date.now() - (state.consolidating[memChat].startedAt || Date.now())) / 1000))}s）`
      : (memChat && state.consolidateResult[memChat]?.note ? state.consolidateResult[memChat].note : '');
    const reconsolidateBtn = m.userId
      ? `<button class="btn btn-small" id="mem-consolidate-btn" data-qq="${esc(m.userId)}" data-chat="${esc(memChat)}"
           ${memChat ? '' : 'disabled'} title="${memChat ? `从 ${esc(memChat)} 的聊天记录里重新整理这个人的印象（会调一次模型）` : '记忆里还没有他会出现的会话，先让他说句话'}">整理此人印象</button>
         <span class="muted" id="mem-consolidate-status" style="font-size:12px">${esc(busyNote)}</span>`
      : '';
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(who)}</h2>
        <div class="sub">
          <span>QQ ${esc(m.userId || '—')}</span>
          <span style="color:${favorColor(favor)}">${favorLabel(favor)}</span>
          <span>${imps.length} 条印象</span>
          <span>存储于 data/memory/people/</span>
          <span>${costLine.replace(/^ · /, '')}</span>
        </div>
      </div>
      <div class="mem-fav-hero" style="margin:0 0 12px">
        <div class="mem-fav-hero-head">
          <span>好感度</span>
          <span style="color:${favorColor(favor)};font-weight:600">${favorLabel(favor)}</span>
        </div>
        <div class="mem-fav-track">
          <div class="mem-fav-fill" style="width:${favor}%;background:${favorColor(favor)}"></div>
          <div class="mem-fav-mid"></div>
        </div>
        <div class="mem-fav-ticks">
          <span>敌意</span><span>冷淡</span><span>疏远</span><span>中性</span><span>友好</span><span>亲近</span><span>护短</span>
        </div>
        <div class="hint" style="font-size:11px;margin-top:4px">高好感会顺着说、帮腔护着；低好感少理。影响随机回话档，被 @ 仍会回。</div>
      </div>
      <div class="mem-attitude-card">
        <div class="mem-attitude-head">
          <span class="mem-attitude-label">态度</span>
          <span class="mem-attitude-sub">AI 对他该怎么说话</span>
        </div>
        <div class="mem-attitude-body">${m.attitude
          ? esc(m.attitude)
          : '<span class="mem-attitude-empty">未设置 · 留空则按好感度自动推</span>'}</div>
      </div>
      ${surfaceHtml}
      <div class="chat-toolbar">
        <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
        <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" data-favor="${favor}">编辑</button>
        ${reconsolidateBtn}
        ${m.userId ? '' : '<button class="btn btn-small btn-danger" id="mem-del-nameonly" title="删除这条没有 QQ 号的印象记录">删除此人</button>'}
      </div>
      ${todosHtml}
      <table class="archive-table"><tbody>${rows}</tbody></table>
      <div class="list-more muted" style="padding-top:8px">钉住的用黄色底标出 · 最新在上</div>
    `;
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMemberImpressModal('people', { ...m, favor: Number(el.dataset.favor || m.favor || 50) });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal('people', m.userId ? { ...m, favor } : null));
    // 整理此人印象：走 /api/memory-files/consolidate（userIds 只整理这一个人）。
    // 进度不在这里轮询 —— SSE 的 memory-update 会带 consolidate-start/done/error，
    // 状态记在 state.consolidating / state.consolidateResult，计时交给 startConsolidateTicker。
    $('#mem-consolidate-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const chat = String(btn.dataset.chat || '');
      const qq = String(btn.dataset.qq || '');
      if (!chat || !qq || btn.disabled) return;
      const st = $('#mem-consolidate-status');
      btn.disabled = true;
      if (st) st.textContent = '正在启动…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey: chat, userIds: [qq], force: true })
        });
        if (!r?.ok) throw new Error(r?.error || '启动失败');
        state.consolidating[chat] = { startedAt: Date.now() };
        delete state.consolidateResult[chat];
        if (st) st.textContent = '整理中…（已 0s）';
        startConsolidateTicker();
      } catch (err) {
        btn.disabled = false;
        if (st) st.textContent = `失败：${err.message}`;
      }
    });
    // 清掉某条近况（它本来会自己淡掉，这个按钮是给"记错了/不想要"用的）
    $$('.mem-surface-del', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await api(`/api/memory-people/${encodeURIComponent(el.dataset.qq)}/surface?kind=${encodeURIComponent(el.dataset.kind || '')}`, { method: 'DELETE', body: '{}' });
          await loadMemoryView();
        } catch (err) {
          alert(`清掉失败：${err.message}`);
        }
      });
    });
    $('#mem-del-nameonly')?.addEventListener('click', async () => {
      if (!confirm(`确定删除「${who}」这条没有 QQ 号的印象记录？`)) return;
      try {
        await api(`/api/memory-people/name-only?name=${encodeURIComponent(m.name || '')}`, { method: 'DELETE', body: '{}' });
        state.currentMemoryChatKey = null;
        await loadMemoryView();
      } catch (e) {
        alert(`删除失败：${e.message}`);
      }
    });
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友：${esc(note || name || userId)}` : '添加群友印象',
    body: `<div class="mi-form">
      <section class="settings-block mi-block">
        <div class="settings-sec-head"><h3>${isEdit ? '身份' : '新建'}</h3></div>
        ${isEdit ? `
        <div class="form-grid cols-2">
          <div class="form-field">
            <label for="mi-qq"><span class="ff-lab">QQ 号</span><span class="ff-unit">只读</span></label>
            <input type="text" id="mi-qq" value="${esc(userId)}" readonly />
          </div>
          <div class="form-field">
            <label for="mi-nickname"><span class="ff-lab">QQ 昵称</span><span class="ff-unit">原名片 · 只读</span></label>
            <input type="text" id="mi-nickname" value="${esc(name)}" readonly />
          </div>
          <div class="form-field">
            <label for="mi-name"><span class="ff-lab">记忆名字</span><span class="ff-unit">列表与注入用这个</span></label>
            <input type="text" id="mi-name" value="${esc(member?.name || name || userId)}" placeholder="例如：沫 / 鲸友老哥" />
          </div>
          <div class="form-field">
            <label for="mi-note"><span class="ff-lab">备注</span><span class="ff-unit">优先称呼 · 可选</span></label>
            <input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则用记忆名字/原名片" />
          </div>
        </div>` : `
        <div class="form-grid cols-2">
          <div class="form-field">
            <label for="mi-qq"><span class="ff-lab">QQ 号</span><span class="ff-unit">必填</span></label>
            <input type="text" id="mi-qq" value="${esc(userId)}" placeholder="例如 10000003" />
          </div>
          <div class="form-field">
            <label for="mi-name"><span class="ff-lab">名字</span><span class="ff-unit">备注名 / 群名片</span></label>
            <input type="text" id="mi-name" value="${esc(name)}" placeholder="老王" />
          </div>
        </div>`}
      </section>
      ${isEdit ? `
      <section class="settings-block mi-block mi-block-attitude">
        <div class="settings-sec-head"><h3>态度与好感</h3>
          <p class="hint">态度有字时优先；留空则按好感档位自动推语气。</p>
        </div>
        <div class="form-field mi-attitude-field">
          <label for="mi-attitude">
            <span class="ff-lab">态度</span>
            <span class="ff-unit">AI 对他该怎么说话 · ≤120 字</span>
          </label>
          <input type="text" id="mi-attitude" class="mi-input"
            value="${esc(member.attitude || '')}" maxlength="120"
            placeholder="例如：宠着点、少怼；被他阴阳也顺着回" autocomplete="off" />
          <div class="hint">注入格式：「对某某：你写的这段」。</div>
        </div>
        <div class="form-field mi-favor-field">
          <label for="mi-favor">
            <span class="ff-lab">好感度</span>
            <span class="ff-unit">敌意 → 护短</span>
          </label>
          <div class="mi-favor-row">
            <input type="range" id="mi-favor" class="mi-range" min="0" max="100" step="1"
              value="${esc(Number(member.favor ?? 50))}" />
            <span class="mi-favor-pill" id="mi-favor-val"
              data-favor="${esc(Number(member.favor ?? 50))}">${favorLabel(member.favor ?? 50)}</span>
          </div>
          <div class="mi-favor-scale" aria-hidden="true">
            <span>0</span><span>14</span><span>28</span><span>42</span><span>58</span><span>72</span><span>86</span><span>100</span>
          </div>
          <div class="hint">72+ 顺着说/帮腔 · 86+ 明显护短 · 被 @ 仍会回</div>
        </div>
      </section>` : ''}
      <section class="settings-block mi-block">
        <div class="settings-sec-head"><h3>印象</h3>
          <p class="hint">一行一条，**想加多少条都行**（不设上限，只保留 60 条安全阀）；留空并保存 = 删除该成员全部印象。</p>
        </div>
        <div class="form-field">
          <label for="mi-imps"><span class="ff-lab">印象内容</span><span class="ff-unit">一行一条</span></label>
          <textarea id="mi-imps" class="mi-input mi-textarea" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea>
        </div>
      </section>
    </div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  const favorEl = overlay.querySelector('#mi-favor');
  const favorVal = overlay.querySelector('#mi-favor-val');
  favorEl?.addEventListener('input', () => {
    if (favorVal) {
      const v = Number(favorEl.value) || 50;
      favorVal.textContent = favorLabel(v);
      favorVal.dataset.favor = String(v);
      favorVal.style.color = favorColor(v);
    }
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const favor = favorEl ? Number(favorEl.value) : Number(member.favor ?? 50);
    const attitude = ($('#mi-attitude')?.value || '').trim();
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-people/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines, favor, attitude })
      });
      closeModelModal(overlay);
      await loadMemoryView();
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除 ${note || name || userId} 的全部印象？`)) return;
    try {
      await api(`/api/memory-people/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      state.currentMemoryChatKey = null;
      await loadMemoryView();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${esc(oldNote || displayName || qq)}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData] = await Promise.all([
    // ⚠️ 2026-09-22：这一路原来没有 .catch()，而其它四路都有 ——
    //   只要 /api/config 偶发失败（重启中、超时），整个 Promise.all 立刻 reject，
    //   后面的状态赋值全不执行 → 界面停在旧数据上，还什么都不报。
    api('/api/config').catch(() => state.config || {}),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null }))
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '未配置远程价格表 —— 当前使用内置表。填上 URL 并保存后，启动时与每 24 小时自动拉取。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */
/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function matchPriceTable(modelId, table) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  const list = table || [];

  const exact = list.find((x) => String(x.id).toLowerCase() === id);
  if (exact) return exact;

  if (id.includes('/')) {
    const bare = id.split('/').pop();
    const hit = list.find((x) => String(x.id).toLowerCase() === bare);
    if (hit) return hit;
  }

  let best = null;
  for (const x of list) {
    const xid = String(x.id).toLowerCase();
    if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x;
  }
  return best;
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * ⚠️ 关键：所有输入都读**界面控件的实时值**，不读 state.config。
 *   否则没点「保存设置」之前，开关/模型名怎么改都是旧值，
 *   看起来就像"按了没反应" —— 这与"可编辑性只跟开关绑定"的意图直接冲突。
 *
 * 匹配判断在本地用 state.modelPrices.prices 算，不读 state.modelPrices.current
 * —— 后者是后端按「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    // 自定义价读已保存的配置（那才是用户存的），但模型身份用实时模型名去查
    const custom = (api.modelPrices || {})[model];
    if (custom && (Number(custom.in) || Number(custom.out))) {
      shown = {
        in: Number(custom.in) || 0,
        out: Number(custom.out) || 0,
        cached: custom.cached == null ? Number(custom.in) || 0 : Number(custom.cached) || 0
      };
      sourceTxt = '正在使用你为该模型设定的单价。';
    } else {
      shown = {
        in: Number(api.priceInputPerM) || 0,
        out: Number(api.priceOutputPerM) || 0,
        cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
      };
      sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
    }
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) card.classList.toggle('locked', locked);
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      $('#provider-action-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="form-field" style="margin-bottom:4px">
      <label for="cfg-persona-pick">
        <span class="ff-lab">选择人设</span>
        <span class="ff-unit">模板 · 可添加自定义</span>
      </label>
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="cursor:pointer" />
        <button class="btn btn-small" id="new-persona-btn" type="button">＋ 添加人设</button>
        <button class="btn btn-small btn-danger hidden" id="del-persona-btn" type="button">删除当前自定义人设</button>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

/**
 * 人设区下方的「消息记录清洗」块。
 *
 * 为什么放在这儿（2026-09-22 用户要求"加一个一键清洗消息记录的功能，在人设卡切换那块"）：
 *   换人设之后，它还会被自己**旧人设时期的聊天记录**拽着走 —— 上下文里全是老自称/老语气。
 *   而手动去删 data/messages、data/sessions 又删不干净（进程内存里那份还在）。
 *   所以放在人设旁边：换完卡顺手清一遍，它就真的从零开始用新卡说话。
 */
function renderPersonaPurgeBlock() {
  return `
    <div class="persona-purge">
      <div class="persona-purge-head">
        <b>清洗消息记录</b>
        <span class="muted">换完人设想让它"忘掉以前怎么说的"，清一遍即可</span>
      </div>
      <div class="persona-purge-row">
        <select id="purge-scope">
          <option value="chat">当前选中的会话</option>
          <option value="all">全部会话（所有群 + 私聊）</option>
        </select>
        <label class="persona-purge-check"><input type="checkbox" id="purge-messages" checked /> 消息记录</label>
        <label class="persona-purge-check"><input type="checkbox" id="purge-sessions" checked /> 会话存档</label>
        <button class="btn btn-small btn-danger" id="purge-run" type="button">一键清洗</button>
        <span id="purge-result" class="muted" style="font-size:12px"></span>
      </div>
      <div class="hint">
        消息记录 = <code>data/messages/</code>（含冷分片 <code>data/messages-cold/</code>）；
        会话存档 = <code>data/sessions/</code> 的运行留痕与用量。
        <b>正在运行的会话不会被删。</b>印象 / 语义卡不在这里清 —— 那些在「记忆」页逐条删。
      </div>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 QQ 连接页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  // 旧文案指向的"从 DSH 导入"功能早已移除，这里改成能实际操作的指引
  if (!provs.length) {
    return '<div class="muted" style="padding:10px;font-size:12px;line-height:1.7">'
      + '目录还是空的。先在右边「手动添加提供商」填上接口地址和 API Key，'
      + '点「获取列表」拉取模型，或直接手动填模型 id 后点「确认添加」。'
      + '不知道去哪弄？DeepSeek、智谱、Kimi、OpenAI 等官网的开放平台都能申请到 Key。'
      + '</div>';
  }
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  // 价格卡片直接读界面控件的值，这里只需要通知它刷新
  refreshModelPriceCard();
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey) {
    $('#cfg-apikey').value = '******';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('该提供商已保存密钥（显示为 ******，点「显示」查看明文，输入新 Key 可替换）');
  } else {
    $('#cfg-apikey').value = '';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型');
  const vr = (state.visionResults || {})[`${pid}|||${model}`];
  if (vr && (vr.verdict === 'vision' || vr.verdict === 'no-vision')) {
    notes.push(vr.verdict === 'vision' ? '✅ 该模型支持图片输入' : '🚫 该模型不支持图片输入');
  }
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  // 已删除独立「主动开场」分区；若还停在旧 id，回落到聊天设置
  if (state.settingsSection === 'proactive') state.settingsSection = 'chat';
  // 分组侧栏：连接 / 行为 / 界面 —— 比一长条平铺好扫
  const menuGroups = [
    ['连接', [
      ['api', '模型 API'],
      ['search', '搜索服务'],
      ['browse', '浏览锁定'],
      ['onebot', 'OneBot']
    ]],
    ['行为', [
      ['allow', '聊天白名单'],
      ['chat', '聊天与节奏'],
      ['memory', '记忆'],
      ['jev', '本地 Jev'],
      ['persona', '人设']
    ]],
    ['界面', [
      ['desktop', '桌面端']
    ]]
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
      <div class="rs-row" style="margin-top:8px;gap:6px;display:flex;flex-wrap:wrap">
        <button class="btn btn-small" id="rs-hot-reload" type="button">热重载配置</button>
        <span class="muted" style="font-size:11px">改人设/白名单/工具后点这里</span>
      </div>
    </div>
    <div class="settings-menu">
      ${menuGroups.map(([g, items]) => `
        <div class="settings-menu-group">${esc(g)}</div>
        ${items.map(([id, label]) =>
          `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`
        ).join('')}`
      ).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', async () => {
      // 先把这个分区没落盘的改动写完再换页 —— saveConfig() 只读「当前分区」的 DOM，
      // 换页后旧分区的字段已经不在文档里，只能靠这次 flush 兜住。
      await flushSettingsSave();
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
  sidebar.querySelector('#rs-hot-reload')?.addEventListener('click', async () => {
    const btn = sidebar.querySelector('#rs-hot-reload');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '重载中…';
    try {
      const r = await api('/api/hot-reload', { method: 'POST', body: JSON.stringify({ reconnectOneBot: true }) });
      btn.textContent = r?.ok ? '已重载' : '失败';
      if (r?.ok) {
        try { state.config = await api('/api/config'); } catch { /* ignore */ }
        try { await refreshStatus(); } catch { /* ignore */ }
        renderSettings();
      }
    } catch {
      btn.textContent = '失败';
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = '热重载配置'; }, 1500);
    }
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
}

function renderSettingsSection(c) {
  let sec = state.settingsSection || 'api';
  if (sec === 'proactive') sec = 'chat';   // 旧「主动开场」已并入聊天设置（且 UI 已删）
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    browse: () => renderBrowseSection(c),
    memory: () => renderMemorySettingsSection(c),
    jev: () => renderJevSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    <div class="page-head">
      <div class="page-head-copy">
        <h2>设置</h2>
        <div class="page-head-sub">改动<b>即时自动保存</b>，不用再点保存；改人设 / 白名单 / 扩展后，再点左下「热重载配置」让它生效。</div>
      </div>
      <div class="page-head-meta">
        <span id="cfg-save-result" class="muted" role="status">已同步</span>
      </div>
    </div>
    ${render()}`;
}

/** 分区卡片：标题 + 说明 + 内容，替代零散 h3/虚线。 */
function settingsBlock(title, desc, body, note = '', opts = {}) {
  const id = opts.id ? ` id="${opts.id}"` : '';
  const cls = opts.cls ? ` ${opts.cls}` : '';
  return `
    <section class="settings-block${cls}">
      <div class="settings-sec-head">
        <h3${id}>${title}</h3>
        ${desc ? `<p class="hint">${desc}</p>` : ''}
      </div>
      ${body}
      ${note ? `<div class="hint block-note">${note}</div>` : ''}
    </section>`;
}

/**
 * 统一表单字段：两行标签（主标签 + 单位/副说明）保证同行输入框顶对齐。
 * controlHtml 为 input/select/textarea 或 addon 包装。
 */
function ff(id, label, unit, controlHtml, hint = '') {
  return `
    <div class="form-field">
      <label for="${id}">
        <span class="ff-lab">${label}</span>
        <span class="ff-unit">${unit || '&nbsp;'}</span>
      </label>
      ${controlHtml}
      ${hint ? `<div class="hint">${hint}</div>` : ''}
    </div>`;
}

function ffNum(id, label, unit, value, attrs = '', hint = '') {
  return ff(id, label, unit, `<input type="number" id="${id}" ${attrs} value="${esc(value)}" />`, hint);
}

function ffText(id, label, unit, value, attrs = '', hint = '') {
  return ff(id, label, unit, `<input type="text" id="${id}" ${attrs} value="${esc(value)}" />`, hint);
}

function ffSelect(id, label, unit, optionsHtml, hint = '') {
  return ff(id, label, unit, `<select id="${id}">${optionsHtml}</select>`, hint);
}

/** 带侧边按钮的输入（获取列表 / 显示密码等）。 */
function ffAddon(id, label, unit, inputHtml, buttonsHtml, hint = '') {
  return ff(id, label, unit, `<div class="field-addon">${inputHtml}${buttonsHtml}</div>`, hint);
}

function grid(cols, fieldsHtml) {
  return `<div class="form-grid cols-${cols}">${fieldsHtml}</div>`;
}

function checkRow(id, label, checked, hint = '') {
  return `
    <div class="checkbox-row">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
      <label for="${id}">${label}</label>
      ${hint ? `<div class="hint">${hint}</div>` : ''}
    </div>`;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  const configuredCacheMode = String(c.api.cacheMode || '').toLowerCase();
  const cacheMode = ['adaptive', 'implicit', 'explicit', 'off'].includes(configuredCacheMode)
    ? configuredCacheMode
    : (c.api.explicitCache ? 'explicit' : 'off');

  const modelBlock = settingsBlock('模型 API', '选模型、调采样与思考/缓存行为。', `
    ${ffAddon('cfg-model-pick', '当前模型', currentProvider ? `${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选')}` : '尚未选择模型',
      `<input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="cursor:pointer" />`,
      `<button class="btn btn-small" id="test-provider-btn" type="button">测试连通性</button><span id="provider-test-result" class="muted" style="font-size:12px"></span>`,
      '')}
    <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
    <div class="hint" id="model-vision-hint" style="margin-top:4px"></div>
    <div style="margin:2px 0 12px">
      <button class="btn btn-small" id="vision-scan-btn" type="button">扫描图片能力</button>
      <span class="muted" id="vision-scan-status" style="font-size:12px;margin-left:8px">给每个模型发一张 32×32 纯色图问颜色，判断它到底能不能看图（结果会写进 config，用来门控看图工具）。</span>
    </div>
    <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
    <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    ${grid(2, [
      ffAddon('cfg-baseurl', 'Base URL', '只读 · 来自当前提供商',
        `<input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" />`,
        `<button class="btn btn-small" id="fetch-current-models-btn" type="button">获取列表</button>`),
      ffAddon('cfg-apikey', 'API Key', '留空保存则保持原 Key',
        `<input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换" autocomplete="new-password" />`,
        `<button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>`)
    ].join(''))}
    ${grid(2, [
      ffNum('cfg-temperature', '温度', '0–2 · 越高越发散', c.api.temperature, 'step="0.1" min="0" max="2"'),
      ffNum('cfg-maxrounds', '单次最大工具轮数', '轮 · 1–40', c.api.maxRounds, 'min="1" max="40"')
    ].join(''))}
    ${checkRow('cfg-autofinish', '自动收尾（省掉「只为调一次 finish」的那一轮）', c.api.autoFinish?.enabled === true,
      '一轮里话已发完、又没有待办（找图/搜索）时直接结束，不再多跑一轮。')}
    ${checkRow('cfg-autofinish-single', '　└ 单条回复也收尾（更省，但可能少补一句）', c.api.autoFinish?.multiOnly === false,
      '默认只在已发出 ≥2 条时自动收尾；勾上则单条也收尾。')}
    ${checkRow('cfg-vision', '图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）', c.api.vision !== false)}
    <span id="vision-switch-hint" class="muted" style="font-size:12px;display:block;margin:-6px 0 10px 28px"></span>
    ${checkRow('cfg-nothink', '关闭模型思考模式', c.api.disableThinking,
      '自动适配百炼 / 方舟 / 智谱 / Kimi / DeepSeek / 硅基流动等；不认参数会自动回退。')}
    ${ff('cfg-think-budget', '思考长度上限', '开思考时生效 · 0=不限制', `
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="range" id="cfg-think-budget-slider" min="0" max="512" step="16"
          value="${Math.min(512, Math.max(0, Number(c.api.thinkingBudget) || 0))}"
          style="flex:1;min-width:140px;height:34px" />
        <input type="number" id="cfg-think-budget" min="0" max="32768" step="16"
          value="${c.api.thinkingBudget ?? 0}" style="width:96px;flex:0 0 96px" />
        <span class="muted" id="think-budget-hint" style="font-size:12px"></span>
      </div>`,
      `按端点自动适配：百炼 thinking_budget · 方舟/智谱/Kimi budget_tokens · DeepSeek reasoning_effort。
       0=不限；32 很快；128 约 2 秒；数值越大越慢也越稳。保存后热重载生效。`)}
    ${ffSelect('cfg-cachemode', '上下文缓存模式', 'QQ 间歇聊天推荐自适应', `
      <option value="adaptive" ${cacheMode === 'adaptive' ? 'selected' : ''}>自适应 + 保温（推荐）</option>
      <option value="implicit" ${cacheMode === 'implicit' ? 'selected' : ''}>隐式缓存</option>
      <option value="explicit" ${cacheMode === 'explicit' ? 'selected' : ''}>显式缓存（只打标记，不保温）</option>
      <option value="off" ${cacheMode === 'off' ? 'selected' : ''}>关闭缓存布局</option>`,
      '自适应：保温开着就始终打显式标记，并用每 4 分钟一次的极小请求把 5 分钟 TTL 续住。'
      + '（实测：隐式创建的缓存块对显式请求不可见，两种模式混用只会白废缓存块 —— 所以不再"冷的时候不打标记"。）'
      + '保温关掉则退回纯隐式缓存。')}
    ${checkRow('cfg-cachewarm', '缓存保温（自适应/显式模式下生效）', c.api.cacheKeepAlive?.enabled !== false,
      '每 4 分钟发一次 1-token 的极小请求续上缓存 TTL；群安静 10 分钟后自动停。一次约 0.0001 元，换首调用命中。')}
  `);

  const costBlock = settingsBlock('成本护栏', '本地累计 prompt 上限；触顶后砍掉可选注入（不调模型、不打断主流程）。', `
    ${checkRow('cfg-costguard', '启用成本护栏', c.api.costGuard?.enabled !== false)}
    ${grid(2, [
      ffNum('cfg-costguard-day', '今日 prompt 上限', 'token · 0=不限', c.api.costGuard?.dayPromptMax ?? 800000, 'min="0" step="10000"'),
      ffNum('cfg-costguard-chat', '单群 prompt 上限', 'token · 0=不限', c.api.costGuard?.chatPromptMax ?? 200000, 'min="0" step="10000"')
    ].join(''))}
  `, '只砍可选注入块，核心人设与本次消息仍会发送。');

  const archBlock = settingsBlock('架构增强（本地短注入）', '跨轮工作记忆 / 语义卡片 / 短时跨群感知。token 成本被条数与字数封顶；关掉对应项立即少注入。', `
    ${checkRow('cfg-arch-working', '跨轮工作记忆', c.api.architecture?.crossTurnWorking !== false)}
    ${grid(2, [
      ffNum('cfg-arch-working-ttl', '工作记忆有效期', '分钟 · 5–1440', c.api.architecture?.workingTtlMin ?? 90, 'min="5" max="1440"'),
      ffNum('cfg-arch-working-decay', '静默淡忘间隔', '分钟 · 0=关 · 每空窗这么久丢最早一轮', c.api.architecture?.workingDecayMin ?? 30, 'min="0" max="1440"'),
      ffNum('cfg-arch-working-chars', '工作记忆最长字数', '字 · 40–2000', c.api.architecture?.workingMaxChars ?? 160, 'min="40" max="2000"')
    ].join(''))}
    ${checkRow('cfg-arch-cards', '语义卡片（把零散印象收成短卡）', c.api.architecture?.semanticCards !== false)}
    ${grid(1, [
      ffNum('cfg-arch-cards-topn', '每轮注入语义卡数', '张 · 0–8', c.api.architecture?.semanticTopN ?? 2, 'min="0" max="8"')
    ].join(''))}
    ${checkRow('cfg-arch-crosschat', '短时跨群感知', c.api.architecture?.crossChatAwareness !== false)}
    ${grid(3, [
      ffNum('cfg-arch-crosschat-min', '感知时间窗', '分钟 · 1–1440', c.api.architecture?.crossChatMinutes ?? 10, 'min="1" max="1440"'),
      ffNum('cfg-arch-crosschat-n', '最多看几个群', '个 · 0–12', c.api.architecture?.crossChatMaxChats ?? 2, 'min="0" max="12"'),
      ffNum('cfg-arch-crosschat-chars', '感知最长字数', '字 · 0–800', c.api.architecture?.crossChatMaxChars ?? 120, 'min="0" max="800"')
    ].join(''))}
    ${checkRow('cfg-arch-todos', '待办状态机（LLM 自定过期时间，到点不注入）', c.api.architecture?.pendingTodos !== false)}
  `);

  const priceBlock = settingsBlock('成本核算', '', `
    <div class="hint" id="cost-guard-hint" style="margin-bottom:10px">加载用量中…</div>
    ${checkRow('cfg-useofficialprice', '用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）', c.api.useOfficialPrice !== false)}
    ${ffAddon('cfg-price-remote-url', '远程价格表 URL', '可选 · 定时拉取',
      `<input type="text" id="cfg-price-remote-url" placeholder="例如 https://你的服务器/prices.json" value="${esc(c.api.priceRemoteUrl || '')}" />`,
      `<button class="btn btn-small" id="price-feed-refresh-btn" type="button" title="不等定时，立即拉一次">立即拉取</button>`,
      '')}
    <div class="hint" id="price-feed-status" style="margin:-4px 0 12px"></div>
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>
    <div class="settings-actions">
      <button class="btn btn-small" id="batch-price-btn" type="button">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px">为多个模型分别设定单价</span>
    </div>
  `);

  const addProvBlock = settingsBlock('手动添加提供商', '填 Base URL + Key，可「获取列表」勾选模型。', `
    ${ffAddon('new-baseurl', 'Base URL', '可填写',
      `<input type="text" id="new-baseurl" placeholder="例如 https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4" />`,
      `<button class="btn btn-small" id="fetch-models-btn" type="button">获取列表</button>`)}
    ${ffAddon('new-apikey', 'API Key', '手动添加时填写',
      `<input type="password" id="new-apikey" placeholder="sk-..." autocomplete="new-password" />`,
      `<button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>`)}
    ${ff('new-model-id', '模型 id', '左列 ID · 右列显示名 · 可多行', `
      <div id="model-rows"></div>
      <div class="field-addon" style="margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn" type="button">＋ 添加一行</button>
      </div>`,
      '「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。')}
    ${grid(2, `
      <div class="form-field">
        <label><span class="ff-lab">确认添加</span><span class="ff-unit">写入提供商目录</span></label>
        <button class="btn btn-primary" id="confirm-add-provider-btn" type="button">确认添加</button>
      </div>
      <div class="form-field">
        <label><span class="ff-lab">删除模型…</span><span class="ff-unit">从目录移除</span></label>
        <button class="btn btn-danger" id="delete-model-btn" type="button">删除模型…</button>
      </div>`)}
    <div class="hint" id="provider-action-hint"></div>
  `, '', { id: 'settings-api' });

  return modelBlock + costBlock + archBlock + priceBlock + addProvBlock;
}


function wikiSourcesToText(wiki) {
  const sources = Array.isArray(wiki?.sources) ? wiki.sources : [];
  return sources
    .filter((s) => s && s.baseUrl)
    .map((s) => [s.id || '', s.label || '', s.baseUrl || ''].join(' | '))
    .join('\n');
}

/**
 * 常用 wiki 源（「⚡ 一键导入常用源」用）。
 *
 * 全是 MediaWiki 站点（后端 wikiLookup 走 `<根地址>/api.php`，失败退回 `/index.php` 搜索页），
 * 所以**根地址**必须是不带 /wiki /api.php 的站点根。
 * 用函数返回（而不是顶层 const）：函数声明会挂到全局，测试与工具能直接看到这份清单。
 */
function wikiPresets() {
  return [
    { id: 'moegirl', label: '萌娘百科', baseUrl: 'https://zh.moegirl.org.cn' },
    { id: 'wikipedia', label: '中文维基百科', baseUrl: 'https://zh.wikipedia.org' },
    { id: 'minecraft', label: 'Minecraft Wiki', baseUrl: 'https://zh.minecraft.wiki' },
    { id: 'fandom', label: 'Fandom 中文社区', baseUrl: 'https://zh.community.fandom.com' }
  ];
}

/** 从任意网址里取站点根（去掉 /wiki/xxx、/index.php、查询串、末尾斜杠）。 */
function wikiRootOf(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  return `${u.protocol}//${u.host}`;
}

/**
 * 解析"批量编辑"里的文本。三种写法都认（2026-09-22 放宽）：
 *   ① id | 显示名 | 根地址      ② 显示名 | 根地址      ③ 直接贴一个网址（文章链接也行）
 * 为什么放宽：以前只认 ①（必须有 `|`），用户直接贴 `https://zh.moegirl.org.cn` 或
 * 贴一条萌娘条目链接时会被整行丢掉，界面只回一句"至少一行：id | 名字 | https://…"，
 * 看上去就是"导入不了"。现在网址必认，id/名字自动从域名生成。
 */
function wikiSourcesFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const idOf = (baseUrl) => {
    const host = String(baseUrl).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '');
    return host.split('.').filter((x) => x && !/^(com|cn|net|org|wiki|fandom|org\.cn)$/i.test(x)).pop() || host;
  };
  for (const line of lines) {
    const parts = line.split('|').map((s) => s.trim()).filter((s) => s !== '');
    // 从右往左找第一个像网址的部分，作为根地址
    let urlIdx = -1;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (/^(https?:\/\/|\/\/)/i.test(parts[i])) { urlIdx = i; break; }
    }
    // 整行就是一个网址（没有 | 的情况）
    if (!parts.length) continue;
    let baseUrl = '';
    let label = '';
    let id = '';
    if (urlIdx >= 0) {
      baseUrl = wikiRootOf(parts[urlIdx].startsWith('//') ? `https:${parts[urlIdx]}` : parts[urlIdx]);
      label = (parts[urlIdx - 1] || '').trim() || (parts[0] !== parts[urlIdx] ? parts[0] : '');
      id = (parts[0] && parts[0] !== label && !/^https?:\/\//i.test(parts[0])) ? parts[0] : '';
    } else if (parts.length === 1) {
      baseUrl = wikiRootOf(parts[0]);   // 只写了个裸域名（zh.moegirl.org.cn）
      if (!baseUrl && /^[\w.-]+\.[a-z]{2,}$/i.test(parts[0])) baseUrl = `https://${parts[0]}`;
    }
    if (!baseUrl) continue;
    if (!id) id = idOf(baseUrl);
    if (!label) label = id;
    // 命中常用源就用它的中文名（贴裸网址时也能显示"萌娘百科"而不是"moegirl"）
    const preset = wikiPresets().find((p) => p.baseUrl.toLowerCase() === baseUrl.toLowerCase());
    if (preset) { id = preset.id; label = preset.label; }
    const key = baseUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, label, baseUrl });
  }
  return out;
}

function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'native');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];

  const main = settingsBlock('搜索服务', '', `
    ${checkRow('cfg-websearch', '联网搜索：启用 web_search / web_fetch 工具', c.webSearch?.enabled !== false)}
    ${grid(2, [
      ffNum('cfg-fetchmaxchars', '抓网页正文上限', '字符 · 默认 8000', c.webSearch?.fetchMaxChars ?? 8000, 'min="1000" max="50000" step="1000"',
        'web_fetch 单次最多返回这么多字符。调大读得更全，但一次抓取可能更贵。'),
      ffSelect('cfg-searchprovider', '搜索提供方', '失败策略见下',
        `<option value="native" ${prov === 'native' ? 'selected' : ''}>模型原生联网（enable_search，推荐）</option>
         <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
         <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
         <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
         <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
         <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
         <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
         ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}`,
        '默认用当前聊天模型的原生联网；失败自动退回 Bing。')
    ].join(''))}
    <div class="form-field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'};margin-bottom:12px">
      <label><span class="ff-lab">自定义搜索服务操作</span><span class="ff-unit">仅当前选中的自定义源</span></label>
      <div class="field-addon" style="flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn" type="button">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn" type="button">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <div class="form-field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'};margin-bottom:12px">
      <label for="cfg-searchurl"><span class="ff-lab">搜索地址</span><span class="ff-unit">高级 · 兼容 Bing 结果格式</span></label>
      <input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" />
    </div>
    <div class="form-grid cols-2" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      ${ffAddon('cfg-ds-searchkey', 'DeepSeek 搜索 API Key', '留空用环境变量 DEEPSEEK_API_KEY',
        `<input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" />`,
        `<button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>`)}
      ${ffText('cfg-ds-searchmodel', '模型', 'DeepSeek 搜索', c.webSearch?.deepseek?.model || 'deepseek-chat')}
    </div>
    <div class="form-grid cols-2" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      ${ffAddon('cfg-zhipu-key', '智谱 API Key', '留空用环境变量 ZHIPU_API_KEY',
        `<input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" />`,
        `<button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>`)}
      ${ffSelect('cfg-zhipu-engine', '搜索引擎', '按次计费',
        `<option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
         <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
         <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
         <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>`)}
    </div>
    <div class="form-field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'};margin-bottom:12px">
      <label for="cfg-bocha-key"><span class="ff-lab">博查 API Key</span><span class="ff-unit">留空保持不变</span></label>
      <div class="field-addon">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换" autocomplete="new-password" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div>
    </div>
    <div class="form-field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'};margin-bottom:12px">
      <label for="cfg-baidu-key"><span class="ff-lab">百度千帆 API Key</span><span class="ff-unit">留空用环境变量 BAIDU_SEARCH_API_KEY</span></label>
      <div class="field-addon">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div>
    </div>
    <div class="form-field" style="margin-bottom:12px">
      <label for="cfg-bili-cookie">
        <span class="ff-lab">B 站 Cookie</span>
        <span class="ff-unit">官方 AI 总结 / AI 字幕 · 热评弹幕不需要</span>
      </label>
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="password" id="cfg-bili-cookie" value=""
          placeholder="${c.webSearch?.bilibiliCookie ? '已配置（输入新值可覆盖）' : '未配置 — 点右侧一键登录，或手动粘贴'}"
          autocomplete="off" />
        <button type="button" class="btn btn-small btn-primary" id="cfg-bili-login-btn">一键登录 B 站</button>
        <button type="button" class="btn btn-small" id="cfg-bili-clear-btn">清空</button>
      </div>
      <div class="hint" id="cfg-bili-hint">${c.webSearch?.bilibiliCookie ? '已有 Cookie。SESSDATA 过期后重登一次即可。' : '点「一键登录」会弹出 B 站页面，登录成功后自动写入，不用去浏览器拷。'}（需桌面端 Electron 壳）</div>
    </div>
    <div class="form-field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'};margin-bottom:4px">
      <label for="cfg-metaso-key"><span class="ff-lab">秘塔 API Key</span><span class="ff-unit">可选 · 留空用免费额度 / METASO_API_KEY</span></label>
      <div class="field-addon">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div>
    </div>
  `);

  const addBlock = settingsBlock('添加自定义搜索服务', '', `
    ${grid(2, [
      ffText('new-sp-name', '名称', '自己辨认用', '', 'placeholder="例如：自建 SearXNG"'),
      ffSelect('new-sp-type', '类型', '接口风格',
        `<option value="openai">JSON 搜索接口（POST）</option>
         <option value="bing">网页解析（Bing 结果格式）</option>`)
    ].join(''))}
    ${ffText('new-sp-baseurl', '接口地址 / 搜索页地址', 'JSON 或网页搜索地址', '',
      'placeholder="JSON：https://your-search.example.com/search；网页：https://your-searx.example.com/search"')}
    ${grid(2, [
      ff('new-sp-apikey', 'API Key', '可选 · 多数自建留空',
        `<input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" />`),
      ffText('new-sp-model', '模型名', '可选 · Responses API 才需要', '', 'placeholder="可选"')
    ].join(''))}
    <div class="settings-actions">
      <button class="btn btn-small" id="add-search-provider-btn" type="button">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `, '', { id: 'settings-search' });

  return main + addBlock;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return settingsBlock('记忆整理', '', `
    ${checkRow('cfg-mem-consolidate', '启用记忆自动整理', mem.consolidateEnabled !== false)}
    ${checkRow('cfg-mem-usechat', '使用与聊天机器人相同的模型', useChat)}
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''};margin-bottom:12px">
      ${ffText('cfg-mem-model-pick', '记忆整理模型', '点击选择 · 可换供应商',
        currentDisplay, 'readonly placeholder="点击选择模型" style="cursor:pointer"',
        selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型')}
      <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
      <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      <div class="hint" id="mem-model-hint"></div>
    </div>
    ${grid(1, [
      ffNum('cfg-mem-interval-h', '整理最小间隔', '小时 · 默认 168（7 天）',
        Math.max(1, Math.round((mem.consolidateMinIntervalMs ?? 7 * 24 * 60 * 60 * 1000) / 3600000)),
        'min="1" max="720" step="1"'),
      // ⚠️ 这个数是"超过多少条才触发自动整理"，不是"最多只能记多少条"。
      //    印象本身不设上限（只有 60 条安全阀），标清楚免得下次又误会成硬上限。
      ffNum('cfg-mem-maximp', '每人超过多少条才自动整理', '条 · 默认 12 · 不是上限',
        Number(mem.maxImpressionsPerMember) || 12,
        'min="4" max="60" step="1"')
    ].join(''))}
  `, '条数超阈值且距上次整理超过该间隔后，才在运行结束后自动整理。默认 7 天；一天一次容易删太多。', { id: 'settings-memory' });
}

function renderBrowseSection(c) {
  const lock = c.security?.browseLock || {};
  const domains = Array.isArray(lock.domains) ? lock.domains : [];
  const on = lock.enabled === true;
  const active = on && domains.length > 0;
  return settingsBlock(
    '浏览锁定',
    `把机器人的上网范围锁在指定站点：web_fetch / 网图只能访问这些域名，站外搜索结果会被滤掉。表情包和群聊图片不受影响。`,
    `
    ${checkRow('cfg-browselock', '启用浏览锁定', on)}
    <div class="form-field" style="margin-bottom:12px">
      <label for="cfg-browsedomains">
        <span class="ff-lab">允许的站点</span>
        <span class="ff-unit">每行一个 · 可不带 http://</span>
      </label>
      <textarea id="cfg-browsedomains" rows="5" placeholder="zh.wikipedia.org&#10;bilibili.com">${esc(domains.join('\n'))}</textarea>
      <div class="field-addon" style="margin-top:8px">
        <input type="text" id="cfg-browsepaste" placeholder="粘贴一个网址，自动提取站点" />
        <button class="btn btn-small" id="cfg-browseadd" type="button">加入</button>
      </div>
      <div class="hint" id="cfg-browsehint"></div>
    </div>
    ${checkRow('cfg-browsedomainsub', '连带子域名一起放行（bilibili.com 允许 www./m./api.）', lock.includeSubdomains !== false)}
    ${ffText('cfg-browsesearchurl', '站内搜索地址', '可选 · {query} 代表搜索词',
      lock.searchUrl || '', 'placeholder="https://zh.wikipedia.org/w/index.php?search={query}"')}
    <div class="hint" id="cfg-browsesearchhint" style="margin-bottom:8px"></div>
    <div class="hint hint-block">
      填了站内搜索后，机器人直接抓这个地址在锁定站点内搜，少一轮全网检索。留空则自动加 <code>site:你的站点</code>。
      JS 渲染的搜索页抓不到列表时，可改填站点 JSON 接口。
    </div>
    ${checkRow('cfg-browseprivate', '允许访问内网 / 本机地址（自建 wiki、局域网图床；会削弱 SSRF 防护）', c.security?.allowPrivateFetchHosts === true)}
    <div class="settings-status">
      当前状态：${active
        ? `🔒 已锁定在 <b>${esc(domains.join('、'))}</b>${lock.includeSubdomains !== false ? '（含子域）' : '（仅这些主机名）'}`
        : (on ? '⚠️ 已开启但站点列表是空的 —— 空列表等于不锁定，请至少填一个站点' : '🔓 未启用：可访问任意公网 http(s) 地址（内网始终拒绝）')}
    </div>`, '', { id: 'settings-browse' }
  );
}

/** 本地 Jev（结构化小决策旁路）：状态 + 角色开关 + 试判。 */
function renderJevSection(c) {
  const j = c.localJev || {};
  const st = state.status?.localJev || {};
  const on = j.enabled === true;
  const catalog = st.rolesCatalog || [];
  const active = new Set(st.roles || catalog.filter((r) => r.active).map((r) => r.id));
  const models = st.modelsFound || [];
  const stats = st.stats || {};
  const sec = st.secondary || {};
  const cloud = st.cloud || {};
  const rc = j.replyChance || {};
  const stateLine = !st.available
    ? '⚠️ 缺 llama-server 或模型文件（看下面的路径），现在所有判定都走原逻辑'
    : (on
      ? (st.ready || st.running ? `🟢 已就绪 · ${st.baseUrl}${st.pid ? ` · pid ${st.pid}` : ''}` : '🟡 已启用，还没起来（首次判定时会拉起）')
      : '⚪ 已关闭：所有判定回到词表/云端原逻辑，一分钱不省也不额外花时间');
  // 旧配置若仍启用了备用模型：保存时会强制清空，这里不再展示入口
  const secLine = (sec.enabled || sec.running || sec.ready)
    ? ' ⚠️ 旧备用模型配置将在保存时清空'
    : '';
  const cloudLine = cloud.enabled
    ? (cloud.available ? ` 🟢 云端通道 · ${esc(cloud.model)}` : ' ⚠️ 云端通道缺地址/模型名')
    : '';

  const modelOpts = (sel) => (models.length
    ? models.map((m) => `<option value="${esc(m.file)}" ${sel === m.file ? 'selected' : ''}>${esc(m.name)} (${(m.bytes / 1073741824).toFixed(2)} GB)</option>`).join('')
    : `<option value="${esc(sel || '')}">${esc(sel || 'models/ 下没有 .gguf')}</option>`);

  return settingsBlock('本地 Jev 决策旁路',
    `包内 llama-server + 小模型，只做窄域标签判定（要不要翻记忆 / 该不该发 / 挑哪张表情 / 要不要插嘴），<b>不写正文</b>。词表先判；没命中才问本地模型，概率或前二名间隔不够就弃权，走原逻辑。`,
    `
    <div class="settings-status">当前：${stateLine}${secLine}${cloudLine}${st.lastError ? `<br><span class="muted">最后一次报错：${esc(st.lastError)}</span>` : ''}</div>
    ${checkRow('cfg-jev-enabled', '启用本地 Jev', on)}
    ${checkRow('cfg-jev-autostart', '打开软件时自动拉起', j.startOnLaunch !== false)}
    <div class="hint">
      关掉「启用」= 立刻全部回退词表/云端，不用删任何配置。
      关掉「自动拉起」= 改成懒启动：等到第一次真要用它才起进程（省内存，第一问多等几百毫秒）。
    </div>
    ${grid(2, [
      ffSelect('cfg-jev-model', '本地模型文件', 'models/ 下的 .gguf', modelOpts(j.modelPath), '换完要点下面的「重启本地模型」才生效'),
      ffText('cfg-jev-modelid', '请求里的模型名', '一般留默认', j.modelId || 'qwen3.5-0.8b'),
      ffNum('cfg-jev-port', '端口', '127.0.0.1', j.port || 18080),
      ffNum('cfg-jev-ctx', '上下文长度', 'token', j.ctxSize || 4096),
      ffNum('cfg-jev-inflight', '并发请求数', '路', j.maxInflight || 2, 'min="1" max="4"'),
      ffNum('cfg-jev-inputmax', '待判文本截断', '字', j.inputMaxChars || 160, 'min="40" max="600"', '越短越省时间：本地模型最贵的是读题（但提示词前缀会被缓存，热起来就快了）'),
      ffNum('cfg-jev-minconf', '弃权阈值（概率）', '0-1', (j.minConfidence ?? 0.6), 'min="0" max="1" step="0.05"', '标签分布概率低于它就当作没判出来'),
      ffNum('cfg-jev-minmargin', '弃权阈值（前二名间隔）', '对数间隔', (j.minMargin ?? 1.0), 'min="0" max="6" step="0.1"', '第一名和第二名差得少 = 它自己也在犹豫。0 = 关掉这道闸'),
      ffNum('cfg-jev-budget', '每条消息的门控时间预算', '毫秒', j.gateBudgetMs || 1500, 'min="300" max="8000" step="100"', '到点就用已判出的结果，剩下的弃权（换大模型卡的时候调这个）')
    ].join(''))}
    ${checkRow('cfg-jev-grammar', '用 grammar 硬约束输出（推荐开）', j.useGrammar !== false)}
    <div class="hint">
      默认弃权：概率 ≥0.6 且前二名间隔 ≥1.0。更保守就往上调，想它多判就往下调。<br>
      ⚠️「概率」不是单一数字：它取「标签分布占比」与「模型吐这个标签有多果断」两者的<b>较小值</b>。
      grammar 约束下，多 token 的英文标签（praise / mention / sadness 这类）果断度天然偏低，
      所以这些角色更容易弃权 —— 实测「夸它」的句子标签占比能到 0.69，却被这道闸压到 0.35 直接弃权。<br>
      另外<b>单个角色可以自带阈值</b>：情绪判定用的就是 0.45（见它那条说明），改上面两个数不动它。
    </div>
    <h4 class="settings-subhead">随机档「该不该插一句」</h4>
    <div class="jev-reply-mode">
      ${grid(1, [
        ffSelect('cfg-jev-replymode', '判定方式', '谁来决定接不接', `
          <option value="jev" ${String(rc.mode || 'jev') === 'jev' ? 'selected' : ''}>Jev 读内容判定（默认，取代骰子）</option>
          <option value="probability" ${String(rc.mode) === 'probability' ? 'selected' : ''}>纯概率骰子（不看内容）</option>`)
      ].join(''))}
      ${grid(2, [
        ffNum('cfg-jev-rc-cooldown', '插嘴冷却', '秒 · 按群计', Math.round((Number(rc.cooldownMs ?? 90000)) / 1000), 'min="0" max="3600"', '同一个群里两次插话至少隔这么久'),
        ffNum('cfg-jev-rc-maxhour', '接话意愿 · 每小时上限', '次 · 全局共享', rc.maxPerHour ?? 8, 'min="0" max="100"', '所有群加起来一小时最多主动插话几次（0 = 不限）。注意这是**全部会话共享**的配额，不是每个群一份 —— 想让它更主动就同时把「接话意愿」调高（意愿会一起放松冷却与这个上限）'),
      ].join(''))}
      <div class="hint" style="margin:-4px 0 10px">上面两条对<b>两种判定方式都生效</b>：Jev 判 YES 的那次、概率骰子命中的那次，走的是同一份冷却与配额。</div>
      <div class="jev-mode-pane${String(rc.mode || 'jev') === 'jev' ? '' : ' is-off'}" data-reply-mode="jev">
        <div class="jev-mode-banner is-jev">
          <b>骰子已退场，改由 Jev 读一眼内容再决定。</b>档位 3 的普通消息不再掷骰子，
          直接交给本地 Jev 判「这轮值不值得接一句」（被 @ / 命中关键词照旧必回）。<br>
          <b>响应概率换个身份继续管用</b>：它现在是「插话意愿」，折算成 Jev 的判定门槛（概率与间隔一起收紧）——
          调低 = 更挑（只有明显接得上的才开口），调高 = 更宽松。
          <b>0% = 这个会话完全不主动插话。</b>
        </div>
        ${grid(1, [
          ffNum('cfg-jev-rc-minmargin', '插嘴专用间隔阈值', '对数间隔 · 仅 Jev 模式', rc.minMargin ?? 1.0, 'min="0" max="6" step="0.1"', '判 YES 是真要发话，这里可以比弃权阈值更严')
        ].join(''))}
        <div style="margin-top:10px">
          ${checkRow('cfg-jev-rc-adaptive', '按群活跃度自适应（热闹时少插嘴，冷清时多接话）', rc.adaptive?.enabled !== false)}
          <div class="hint hint-block">
            看最近 ${Number(rc.adaptive?.windowMinutes ?? 15)} 分钟内群里有多少条消息、几个不同的人在说，
            折算出一个「活跃度」，再在冷清↔热闹两端之间浮动上面那几条闸门。
            <b>它只在「插话意愿」附近的窄带里微调</b>（概率 ±0.08、间隔 ±0.4、
            每小时上限 0.7~1.3 倍、冷却 0.7~1.35 倍）——
            意愿是你设的下限，自适应**不会**把它压回去；热闹度还做了 h^1.6 折算，
            只有真刷屏才收紧，中等活跃仍按你的意愿走。关掉就固定用上面那组值。
          </div>
          ${grid(4, [
            ffNum('cfg-jev-rc-quiet-conf', '冷清端·概率阈值', '0-1', rc.adaptive?.quiet?.minConfidence ?? 0.55, 'min="0" max="1" step="0.05"', '群里安静时的门槛，越低越爱接话（会被夹进意愿±0.08 的带子里）'),
            ffNum('cfg-jev-rc-busy-conf', '热闹端·概率阈值', '0-1', rc.adaptive?.busy?.minConfidence ?? 0.88, 'min="0" max="1" step="0.05"', '群里刷屏时的门槛，越高越安静（同样受带子限制，不会把意愿吃掉）'),
            ffNum('cfg-jev-rc-quiet-max', '冷清端·每小时上限', '次', rc.adaptive?.quiet?.maxPerHour ?? 10, 'min="0" max="100"', '人少时允许更勤快地接（最终不会超过意愿的 1.3 倍）'),
            ffNum('cfg-jev-rc-busy-max', '热闹端·每小时上限', '次', rc.adaptive?.busy?.maxPerHour ?? 3, 'min="0" max="100"', '热闹时的建议上限（最终不会低于意愿的 0.7 倍）')
          ].join(''))}
          <div class="hint">中间活跃度按线性插值在这两端之间取值；间隔阈值（margin）、冷却秒数同理，改它们要编辑配置文件里的 <code>localJev.replyChance.adaptive</code>。</div>
        </div>
      </div>
      <div class="jev-mode-pane${String(rc.mode) === 'probability' ? '' : ' is-off'}" data-reply-mode="probability">
        <div class="jev-mode-banner is-prob">
          纯骰子：随机档按「聊天与节奏 → 响应档位」的概率决定接不接话，不看内容，Jev 一次都不问。<br>
          命中就接、没命中就安静 —— 「一句无关紧要的『哦』被掷中、一句正好能接的梗被漏掉」就是这种。
          命中的那次<b>同样要过上面的冷却与上限</b>（以前不受约束，这个漏洞已修）。
        </div>
      </div>
    </div>
    <h4 class="settings-subhead">云端 Jev 通道（可选）</h4>
    <div class="hint">本地弃权时，把这一题升级给云端小模型再判一次。默认关。
      <b>把上面的「启用本地 Jev」关掉、只留这里，就是纯云端模式</b>（本地模型完全不跑）。</div>
    ${checkRow('cfg-jev-cloud-enabled', '启用云端升级', cloud.enabled === true)}
    ${grid(2, [
      ffText('cfg-jev-cloud-url', '端点地址', '不含 /chat/completions', j.cloud?.baseUrl || ''),
      ffText('cfg-jev-cloud-key', 'API Key', j.cloud?.hasApiKey ? '已保存 · 留空保持不变' : '留空 = 不带鉴权', j.cloud?.hasApiKey ? '******' : ''),
      ffText('cfg-jev-cloud-model', '模型名', '填便宜的小模型', j.cloud?.model || ''),
      ffNum('cfg-jev-cloud-below', '本地低于多少才升级', '0-1', j.cloud?.upgradeBelow ?? 0.6, 'min="0" max="1" step="0.05"'),
      ffNum('cfg-jev-cloud-minconf', '云端自己的弃权阈值', '0-1', j.cloud?.minConfidence ?? 0.6, 'min="0" max="1" step="0.05"'),
      ffNum('cfg-jev-cloud-assumep', '端点不给概率时按这个置信采信', '0=弃权（默认）', j.cloud?.assumeP ?? 0, 'min="0" max="1" step="0.05"'),
      ffNum('cfg-jev-cloud-ppm', '单价（元/百万 token）', '只用于统计', j.cloud?.priceInPerM ?? 0, 'min="0" step="0.001"'),
      ffNum('cfg-jev-cloud-rate', '每分钟最多问几次', '次', j.cloud?.maxPerMinute ?? 60, 'min="0" max="600"')
    ].join(''))}
    ${cloud.usage && cloud.usage.calls
      ? `<div class="settings-status">云端已调用 ${cloud.usage.calls} 次 · 输入 ${cloud.usage.promptTokens} / 输出 ${cloud.usage.completionTokens} token · 估算 ¥${Number(cloud.usage.costYuan || 0).toFixed(4)}${cloud.usage.errors ? ` · 失败 ${cloud.usage.errors} 次` : ''}${cloud.usage.refused ? ` · 限流跳过 ${cloud.usage.refused} 次` : ''}</div>`
      : '<div class="settings-status">云端还没被调用过。若你已填好地址与模型却一直不调用，先看下面这行错误提示（以前这里只显示次数，看不出原因）。</div>'}
    ${cloud.usage?.lastError ? `<div class="hint" style="color:var(--red)">最后一次云端错误：${esc(String(cloud.usage.lastError).slice(0, 200))}</div>` : ''}
    <h4 class="settings-subhead">接管哪些判定</h4>
    <div class="hint" style="margin:-4px 0 8px">
      共 ${catalog.length} 个角色。另有「连发合并判『这句说完了没』」不在本表 —— 它挂在「设置 → 聊天 → 运行节奏」里单独开关，
      因为老配置的 roles 是写死的显式数组，把它挂进这张表只会多出一个「勾了也不生效」的假开关。
    </div>
    ${catalog.map((r) => checkRow(`cfg-jev-role-${r.id}`, `${r.cn}${active.has(r.id) ? '' : '（未接管）'}`, active.has(r.id),
      `${esc(r.desc)}<br><span class="muted">判错后果：${esc(r.risk)}${stats[r.id] ? ` · 已判 ${stats[r.id].n} 次，平均 ${stats[r.id].avgMs}ms，弃权 ${stats[r.id].abstain} 次，失败 ${stats[r.id].error} 次` : ''}</span>`
    )).join('')}
    <div class="settings-actions">
      <button class="btn btn-small" id="cfg-jev-restart" type="button">重启本地模型（换文件/改端口后必点）</button>
      <button class="btn btn-small" id="cfg-jev-stop" type="button">停掉它</button>
      <button class="btn btn-small" id="cfg-jev-clear" type="button">清空统计</button>
    </div>
    <div class="form-field jev-probe" style="margin-top:16px">
      <label for="cfg-jev-probe"><span class="ff-lab">试判</span><span class="ff-unit">选类型 → 输一句话 → 点「判一下」或按回车</span></label>
      <div class="jev-probe-role-row">
        <select id="cfg-jev-probe-role" aria-label="试判类型">${catalog.map((r) => `<option value="${r.id}" ${r.id === 'imageWantsGate' ? 'selected' : ''}>${esc(r.cn)}</option>`).join('')}</select>
      </div>
      <div class="jev-probe-input-row">
        <input type="text" id="cfg-jev-probe" placeholder="例如：来个灵梦图片" autocomplete="off" spellcheck="false" />
        <button class="btn btn-small" id="cfg-jev-test" type="button">判一下</button>
      </div>
      <div class="hint" id="cfg-jev-probe-out" style="white-space:pre-wrap"></div>
    </div>
    <div class="hint block-note">
      路径：<code>${esc(st.exe || '')}</code> ← <code>${esc(st.model || '')}</code><br>
      这些判定只影响「要不要多查 / 要不要开口」；正文永远由主聊天模型写。
    </div>`, '', { id: 'settings-jev' }
  );
}

function renderPersonaSection(c) {
  return settingsBlock('人设', '', `
    ${renderPersonaPicker(c)}
    ${grid(3, [
      ffText('cfg-botname', '机器人名字', '显示用', c.persona.botName),
      ffText('cfg-selfnick', '群内展示名', '可选 · 空=用昵称', c.persona.selfNickname || ''),
      ffSelect('cfg-participation', '参与度', '安静 / 普通 / 活跃',
        `<option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
         <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
         <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>`)
    ].join(''))}
    ${ff('cfg-roletext', '角色设定', '写进 system 的身份', `
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea>`)}
    ${ff('cfg-customrules', '管理员附加规则', '可选 · 追加到系统提示', `
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea>`)}
    ${checkRow('cfg-compactprompt', '极简系统提示（小模型 / 短上下文时建议开）', c.persona.compactSystemPrompt === true,
      '只保留最短的一套 system 规则，省 token；上下文够用就别开。')}
    ${ffSelect('cfg-system-mode', '系统提示风格', '只改 system 规则块',
      `<option value="full" ${(c.persona.systemMode || 'full') === 'full' ? 'selected' : ''}>完整（原版分节）</option>
       <option value="lean" ${c.persona.systemMode === 'lean' || c.persona.systemMode === 'cleaned' ? 'selected' : ''}>精简 · lean</option>`,
      '角色卡仍在「角色设定」。保存后热重载。')}
    ${renderPersonaSaveBar()}
    ${renderPersonaPurgeBlock()}`);
}

function renderAllowSection(c) {
  return settingsBlock('聊天白名单', '白名单为空时机器人不会在任何群聊/私聊内运行。', `
    <div class="form-field" style="margin-bottom:12px">
      <label><span class="ff-lab">从 QQ 账号直接勾选</span><span class="ff-unit">读取好友 / 群列表</span></label>
      <div class="field-addon" style="flex-wrap:wrap">
        <button class="btn btn-small" id="pick-groups-btn" type="button">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn" type="button">选择好友</button>
        <span id="pick-result" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    ${grid(2, [
      ffText('cfg-allowgroups', '允许的群号', '逗号分隔', (c.allow.groups || []).join(',')),
      ffText('cfg-allowprivate', '允许的 QQ', '逗号分隔', (c.allow.private || []).join(','))
    ].join(''))}
    ${checkRow('cfg-allowallwhenempty', '白名单留空时允许所有会话', c.allowAllWhenEmpty === true,
      '勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。')}
  `, '', { id: 'settings-allow' }) + settingsBlock(
    '疯狂星期四白名单',
    '每周四 07:00 / 13:00 / 19:00 向下列群直发玩梗文案（不走人设）。<b>留空 = 不向任何群发送</b>（不会跟着上面「允许的群号」走）。要发就把群号写全。',
    `
    ${ffText('cfg-crazythursday-groups', '发送群号', '逗号分隔 · 空=不发',
      ((c.crazyThursday && c.crazyThursday.groupIds) || []).join(','),
      'placeholder="留空则不发送；填群号才发，如 123456,789012"')}
  `, '', { id: 'settings-crazy-thursday' });
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/app.js 是普通 script（非 ES module），无法 import，只能镜像一份。
 */
const TIER_SLIDER_BANDS = { tier1End: 10, tier2End: 20, tier3End: 90 };

function sliderToTierUI(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const b = TIER_SLIDER_BANDS;
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  const pct = Math.min(100, Math.max(0, Number(st?.randomPercent) || 0));
  if (t === 1) return b.tier1End / 2;
  if (t === 2) return (b.tier1End + b.tier2End) / 2;
  if (t === 3) return b.tier2End + (pct / 100) * (b.tier3End - b.tier2End);
  return (b.tier3End + 100) / 2;
}

/** 滑条位置 → 一句话说明。带上档位编号，和下面的刻度带对得上。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '1 档：仅被 @ 时回应；其余静默。';
  if (tier === 2) return '2 档：被 @ 或命中关键词时回应。';
  if (tier === 3) return `3 档：被 @ / 关键词必回应；普通消息的接话意愿 ${randomPercent}% —— 越小越挑，同时决定「每小时最多主动插几次」：约 ${Math.max(1, Math.round(randomPercent / 10))} 次/时（实测：光抬判定阈值拦不住，频率得靠这条）。`;
  return '4 档：任何消息都回应。';
}

/** 刻度带四段在 0~100 轴上各占多宽，与 TIER_SLIDER_BANDS 的分界严格对齐。 */
const TIER_BAND_W = [10, 10, 70, 10];

/** 滑条下的分段刻度带：亮当前那一段，段名即档位名，悬停看完整说明。 */
function tierScaleHtml(curTier) {
  return `<div class="tier-scale">${[1, 2, 3, 4].map((n) =>
    `<div class="tier-seg seg${n}${n === curTier ? ' on' : ''}" style="--w:${TIER_BAND_W[n - 1]}" title="${esc(TIER_HINT[n])}">`
    + `<i></i><span>${esc(TIER_NAME[n])}</span></div>`).join('')}</div>`;
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应',
  2: '被 @ 或关键词时响应',
  3: '在 2 档基础上按「接话意愿」主动响应（Jev 判定会先读一眼内容）',
  4: '任何消息都响应'
};

/**
 * 极简响应档位面板：标题 + 滑条 + 四个历史条数 + 折叠更多。
 * id 约定不变：群聊 ''、私聊 '-p'、单群 '-pc-xxx'。
 */
function tierPanelHtml(scope, st, { hidden = false, seeded = false, sfx = null, label = null } = {}) {
  const S = sfx !== null ? sfx : (scope === 'private' ? '-p' : '');
  const L = label || (scope === 'private' ? '私聊' : '群聊');
  const s = st || {};
  const sliderPos = sliderToTierUI_tierToSlider(s);
  const { tier: curTier, randomPercent } = sliderToTierUI(sliderPos);
  const nowText = curTier === 3 ? `${TIER_NAME[curTier]} · ${randomPercent}%` : TIER_NAME[curTier];
  return `
    <div class="tier-panel" id="tier-panel-${scope}" data-seeded="${seeded ? '1' : ''}"${hidden ? ' style="display:none"' : ''}>
      <div class="tier-line">
        <span class="tier-label">${esc(L)}</span>
        <span class="tier-now" data-tier-now>${esc(nowText)}</span>
      </div>
      <input type="range" id="ctx-tier-slider${S}" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="${esc(L)}响应档位" />
      ${tierScaleHtml(curTier)}
      <div class="hint tier-note">${sliderDesc(sliderPos)}</div>
      <div class="tier-nums">
        <label class="tier-param tier-num${curTier === 1 ? '' : ' dim'}"><span>艾特</span>
          <input type="number" id="cfg-atcount${S}" min="0" max="500" value="${esc(s.atCount ?? 20)}" /></label>
        <label class="tier-param tier-num${curTier === 2 ? '' : ' dim'}"><span>关键词</span>
          <input type="number" id="cfg-kwcount${S}" min="0" max="500" value="${esc(s.keywordCount ?? 15)}" /></label>
        <label class="tier-param tier-num${curTier === 3 ? '' : ' dim'}"><span>随机</span>
          <input type="number" id="cfg-randcount${S}" min="0" max="500" value="${esc(s.randomCount ?? 8)}" /></label>
        <label class="tier-param tier-num${curTier === 4 ? '' : ' dim'}"><span>其余</span>
          <input type="number" id="cfg-allcount${S}" min="0" max="500" value="${esc(s.allCount ?? 80)}" /></label>
      </div>
      <details class="tier-more">
        <summary>更多设置</summary>
        <div class="tier-more-body">
          <div class="hint">关键词（每行一个，不区分大小写）</div>
          <textarea id="cfg-keywords${S}" rows="2" class="tier-keywords" placeholder="小鲸鱼&#10;bot">${esc((s.keywords || []).join('\n'))}</textarea>
          <div class="checkbox-row" style="margin-top:10px">
            <input type="checkbox" id="cfg-r24${S}" ${s.recent24hDigest?.enabled ? 'checked' : ''} />
            <label for="cfg-r24${S}">注入近 24h 本地摘要</label>
          </div>
          <div class="tier-nums tier-nums-sub">
            <label class="tier-num"><span>小时</span><input type="number" id="cfg-r24h${S}" min="1" max="168" value="${esc(s.recent24hDigest?.hours ?? 24)}" /></label>
            <label class="tier-num"><span>最长字数</span><input type="number" id="cfg-r24c${S}" min="80" max="600" value="${esc(s.recent24hDigest?.maxChars ?? 240)}" /></label>
            <label class="tier-num"><span>短句数</span><input type="number" id="cfg-r24n${S}" min="2" max="16" value="${esc(s.recent24hDigest?.maxItems ?? 8)}" /></label>
          </div>
        </div>
      </details>
    </div>`;
}

/**
 * 站内搜索地址的预览（与后端 web-search.js 的 buildSiteSearchUrl 同一套规则）。
 * 只在界面上给用户看一眼"搜「猫」时到底会抓哪个地址"，真正生效的拼接在后端。
 * 加这个预览的原因：有人把 {query} 手滑写成 {quert}，地址里带着字面量，
 * 站点永远返回空结果，模型只好到处乱翻——这种错必须当场看出来。
 */
const SEARCH_PLACEHOLDERS = ['{query}', '{q}', '{keyword}', '{kw}', '{word}', '{search}', '{text}', '{关键词}', '{搜索词}', '%s'];
function buildSiteSearchPreview(template, sample = '猫') {
  const raw = String(template ?? '').trim();
  if (!raw) return '';
  for (const p of SEARCH_PLACEHOLDERS) {
    if (raw.includes(p)) return raw.split(p).join(encodeURIComponent(sample));
  }
  try {
    const u = new URL(raw);
    let filled = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (!v || /^\{.*\}$/.test(v) || /^\$\{.*\}$/.test(v) || /^%[^%]+%$/.test(v)) {
        u.searchParams.set(k, sample);
        filled = true;
      }
    }
    if (filled) return u.toString();
    if (!u.search) { u.searchParams.set('s', sample); return u.toString(); }
    return u.toString();
  } catch { /* 不是完整 URL */ }
  return raw + encodeURIComponent(sample);
}

/** chatKey → 可安全放进 HTML id 的后缀（group:123 → group_123）。 */
function chatKeySlug(chatKey) {
  return String(chatKey || '').replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 网址 → 纯主机名（浏览锁定用）：去协议、去路径/查询、去端口、去通配符前缀、去 www.、小写。
 * 与后端 safe-fetch.js 的 normalizeDomain 保持一致 —— 前端只是帮用户少打字，
 * 真正生效的清洗在后端，两边不一致会出现"看着加了其实没加"。
 */
function normalizeDomain(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * 需要展示"单独设置"的会话列表：白名单 + 已配过覆盖的 + 已有存档的会话。
 * 去重后按 群聊 → 私聊 排序，便于阅读。
 */
function perChatKeys(c) {
  const keys = new Set();
  for (const g of c.allow?.groups || []) keys.add(`group:${g}`);
  for (const p of c.allow?.private || []) keys.add(`private:${p}`);
  for (const k of Object.keys(c.store?.perChat || {})) keys.add(k);
  for (const ch of state.chats || []) if (ch?.key) keys.add(ch.key);
  return [...keys].sort((a, b) => {
    const ga = a.startsWith('group:') ? 0 : 1;
    const gb = b.startsWith('group:') ? 0 : 1;
    return ga - gb || a.localeCompare(b);
  });
}

const TOOLS_PAGE_META = {
  send_message: { label: '发消息', icon: '💬', cat: '基础' },
  get_recent_messages: { label: '翻历史', icon: '📜', cat: '基础' },
  get_message_detail: { label: '消息详情', icon: '🔍', cat: '基础' },
  report_feedback: { label: '给管理员反馈', icon: '📮', cat: '基础' },
  send_sticker: { label: '发表情', icon: '😄', cat: '表情' },
  list_stickers: { label: '查表情库', icon: '🗂', cat: '表情' },
  get_sticker_image: { label: '看表情图', icon: '🖼', cat: '表情' },
  sticker_note: { label: '表情备注', icon: '📝', cat: '表情' },
  collect_sticker: { label: '收藏表情', icon: '⭐', cat: '表情' },
  send_image: { label: '发网图', icon: '📷', cat: '图片' },
  search_images: { label: '搜网图', icon: '🔎', cat: '图片' },
  get_message_images: { label: '看消息图', icon: '👀', cat: '图片' },
  image_lib_search: { label: '搜图库', icon: '🖼', cat: '图片' },
  image_lib_send: { label: '发图库图', icon: '🏞', cat: '图片' },
  identify_image: { label: '识图认人', icon: '🕵️', cat: '图片' },
  send_bilibili: { label: '转发B站', icon: '📺', cat: '联网' },
  search_bilibili: { label: '搜B站视频', icon: '🔎', cat: '联网' },
  list_bili_fav: { label: '看B站收藏夹', icon: '⭐', cat: '联网' },
  parse_video: { label: '解析B站视频', icon: '📺', cat: '联网' },
  web_search: { label: '联网搜索', icon: '🌐', cat: '联网' },
  web_fetch: { label: '抓网页', icon: '📄', cat: '联网' },
  external_lookup: { label: '查百科设定', icon: '📖', cat: '联网' },
  send_music: { label: '发音乐卡', icon: '🎵', cat: '其它' },
  search_music: { label: '搜歌候选', icon: '🔎', cat: '其它' },
  send_poke: { label: '拍一拍', icon: '👉', cat: '社交' },
  get_active_members: { label: '活跃成员', icon: '👥', cat: '社交' },
  read_forward: { label: '展开转发', icon: '↩️', cat: '社交' },
  send_forward: { label: '发合并转发', icon: '📤', cat: '社交' },
  memory_append: { label: '记印象', icon: '🧠', cat: '记忆' },
  memory_query: { label: '查印象', icon: '🧠', cat: '记忆' },
  memory_remove: { label: '删印象', icon: '🗑', cat: '记忆' },
  memory_favor: { label: '好感度', icon: '💗', cat: '记忆' },
  memory_search: { label: '搜旧聊天', icon: '🕰', cat: '记忆' },
  memory_archive: { label: '聊天归档', icon: '📦', cat: '记忆' },
  memory_meme_save: { label: '存梗', icon: '😂', cat: '记忆' },
  memory_meme_search: { label: '搜梗', icon: '😂', cat: '记忆' },
  memory_todo_save: { label: '记待办', icon: '📌', cat: '记忆' },
  memory_todo_done: { label: '完成待办', icon: '☑️', cat: '记忆' }
};
const TOOL_PRESETS = {
  basic: ['send_message', 'get_recent_messages', 'memory_append', 'memory_query', 'send_image', 'search_images', 'list_stickers', 'send_sticker'],
  whale: [
    'send_message', 'get_recent_messages', 'get_message_detail',
    'send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker',
    'send_image', 'search_images', 'get_message_images',
    'image_lib_search', 'image_lib_send', 'identify_image',
    'send_bilibili', 'parse_video', 'search_bilibili', 'list_bili_fav',
    'web_search', 'web_fetch', 'external_lookup',
    'send_music', 'search_music',
    'memory_append', 'memory_query', 'memory_remove', 'memory_favor',
    'memory_search', 'memory_archive', 'memory_meme_save', 'memory_meme_search',
    'memory_todo_save', 'memory_todo_done',
    'send_poke', 'get_active_members', 'send_forward', 'read_forward',
    'report_feedback'
  ]
};

function extKindLabel(s) {
  const k = s.kind === 'plugin' || String(s.dir || '').startsWith('plugins') ? 'plugin' : 'skill';
  return k === 'plugin'
    ? { k, title: '插件', tip: '确定性型：规则写死，核心必然执行（providers/hooks）', folder: 'plugins/<id>/' }
    : { k, title: '技能', tip: 'LLM 型：注册工具，模型自己决定何时调用', folder: 'skills/<id>/' };
}

function extBadge(s) {
  const cls = s.loadError ? 'err' : (!s.loaded ? '' : (s.active ? 'on' : (s.enabled ? 'warn' : '')));
  const text = s.loadError ? '加载失败' : (!s.loaded ? '未加载' : (s.active ? '生效中' : (s.enabled ? '已开未激活' : '已关闭')));
  return `<span class="tk-badge${cls ? ' ' + cls : ''}">${text}</span>`;
}

async function loadToolsPage() {
  const box = $('#tools-page');
  if (!box) return;
  box.innerHTML = `
    <div class="tl-wrap">
      <div class="page-head">
        <div class="page-head-copy">
          <h2>工具与扩展</h2>
          <div class="page-head-sub">
            <b>扩展</b>是机器人自带的能力，开关即生效；<b>模型工具</b>是模型能调用的动作，勾选后才交给它。
          </div>
        </div>
        <div class="page-head-meta">
          <span class="tl-stat" id="tl-stat-ext">扩展 <b>-</b></span>
          <span class="tl-stat" id="tl-stat-tool">模型工具 <b>-</b></span>
        </div>
      </div>

      <details class="tl-help">
        <summary>插件和技能怎么选？</summary>
        <div class="tl-help-body">
          <p><b>插件</b> <code>plugins/&lt;id&gt;/</code>：规则能写死时用。给的是一致性保障（比如被禁言就不发消息），必然执行，不经过模型判断。</p>
          <p><b>技能</b> <code>skills/&lt;id&gt;/</code>：要模型理解人话时用。它注册工具，由模型自己决定何时调用；注册出的工具会出现在下方白名单里，标「扩展」。</p>
          <p>两者都在上面同一栏「扩展」里（🧩 插件 / 🧠 技能，按 id 排序、多了翻页）。清单分别是 <code>plugin.json</code> / <code>skill.json</code>，放进目录后点开关或热重载即可。脚手架 <code>npm run new:skill &lt;id&gt;</code>，文档 <code>doc/extend_development/</code>。</p>
          <p>不会找路径？用扩展区右侧「打开 plugins / 打开 skills」；单个扩展点「详情」看说明与设置。</p>
        </div>
      </details>

      <section class="tl-section">
        <div class="tl-section-head">
          <span class="tl-section-title">扩展</span>
          <span class="tl-section-sub">🧩 插件：规则写死、必然执行 · 🧠 技能：给模型注册工具 · 点开关即生效</span>
          <span class="tl-section-actions">
            <button type="button" class="btn btn-small" id="tl-open-plugins" title="打开 plugins/ 文件夹（确定性插件放这里）">打开 plugins</button>
            <button type="button" class="btn btn-small" id="tl-open-skills" title="打开 skills/ 文件夹（LLM 技能放这里）">打开 skills</button>
            <span class="tl-pager" id="tl-ext-pager"></span>
          </span>
        </div>
        <div class="tl-section-body">
          <div id="tl-ext" class="tl-chip-row"></div>
        </div>
      </section>

      <section class="tl-section">
        <div class="tl-section-head">
          <span class="tl-section-title">模型工具白名单</span>
          <span class="tl-section-sub">勾选后才交给模型 · 全部勾上 = 不做限制</span>
        </div>
        <div class="tl-section-body">
          <div class="tl-toolbar">
            <input id="tl-search" class="tl-search" type="search" placeholder="搜工具名 / ID" autocomplete="off" />
            <span class="tl-spacer"></span>
            <button class="btn btn-small" id="t-all-on" type="button" title="勾选全部工具">全勾</button>
            <button class="btn btn-small" id="t-all-off" type="button" title="一个都不勾。白名单为空 = 不限制，等于全部工具都交给模型">都不勾</button>
            <span class="tl-sep" aria-hidden="true"></span>
            <button class="btn btn-small" id="t-preset-basic" type="button" title="只留聊天必需的那几个">基础</button>
            <button class="btn btn-small" id="t-preset-whale" type="button" title="日常全功能的一套">小鲸鱼全套</button>
            <span class="tl-sep" aria-hidden="true"></span>
            <button class="btn btn-primary" id="t-save" type="button">保存</button>
            <span id="t-save-msg" class="tl-hint"></span>
          </div>
          <div id="tl-groups" class="tl-groups"></div>
        </div>
      </section>
    </div>
  `;

  let listData = null;
  let query = '';
  const extBox = box.querySelector('#tl-ext');
  const extPagerBox = box.querySelector('#tl-ext-pager');
  const grid = box.querySelector('#tl-groups');
  const statExt = box.querySelector('#tl-stat-ext');
  const statTool = box.querySelector('#tl-stat-tool');
  const saveBtn = box.querySelector('#t-save');
  const saveMsg = box.querySelector('#t-save-msg');

  async function openExtFolder(payload, btn) {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '打开中…'; }
    try {
      const r = await api('/api/skills/open-folder', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!r?.ok) throw new Error(r?.error || '打开失败');
      setMsg(`已打开：${r.path || ''}`, 'ok');
    } catch (e) {
      setMsg(`打开文件夹失败：${e?.message || e}`, 'warn');
    } finally {
      if (btn) { btn.disabled = false; if (label) btn.textContent = label; }
    }
  }

  box.querySelector('#tl-open-plugins')?.addEventListener('click', (ev) => openExtFolder({ kind: 'plugins' }, ev.currentTarget));
  box.querySelector('#tl-open-skills')?.addEventListener('click', (ev) => openExtFolder({ kind: 'skills' }, ev.currentTarget));

  function setMsg(text, kind = '') {
    if (!saveMsg) return;
    saveMsg.textContent = text || '';
    saveMsg.className = 'tl-hint' + (kind ? ' is-' + kind : '');
  }

  function enabledSet() {
    if (!listData) return new Set();
    if (listData.allEnabled || !listData.enabled?.length) return null;
    return new Set(listData.enabled);
  }

  const allChecks = () => [...grid.querySelectorAll('input.tool-check')];

  function checkedNames() {
    return allChecks().filter((el) => el.checked).map((el) => el.dataset.name);
  }

  /** 存进配置的是「白名单」：全部勾上等价于不做限制，存空数组（与后端约定一致）。 */
  function currentTools() {
    const names = checkedNames();
    return names.length === listData.tools.length ? [] : names;
  }

  function paint(el) {
    el.closest('.tl-item')?.classList.toggle('on', el.checked);
  }

  function syncCounters() {
    const extAll = (listData.extensions || []).filter((s) => {
      const d = String(s.dir || '');
      return d === 'plugins' || d === 'skills' || d.startsWith('plugins/') || d.startsWith('skills/');
    });
    const extOn = extAll.filter((s) => s.enabled).length;
    const n = checkedNames().length;
    const total = listData.tools.length;
    if (statExt) statExt.innerHTML = `扩展 <b>${extOn}/${extAll.length}</b> 启用`;
    if (statTool) statTool.innerHTML = `模型工具 <b>${n}/${total}</b>${n === total ? ' · 不限制' : ' · 仅白名单'}`;
    for (const g of grid.querySelectorAll('.tl-group')) {
      const items = [...g.querySelectorAll('input.tool-check')];
      const on = items.filter((el) => el.checked).length;
      const c = g.querySelector('.tl-group-count');
      if (c) c.textContent = `${on}/${items.length}`;
    }
    refreshDirty();
  }

  /** 保存按钮高亮 + 状态行文案，只反映「有没有没存的改动」。 */
  function refreshDirty() {
    if (!listData) return;
    const saved = listData.allEnabled || !listData.enabled?.length ? [] : [...listData.enabled].sort();
    const now = [...currentTools()].sort();
    const dirty = saved.join('\n') !== now.join('\n');
    saveBtn?.classList.toggle('is-dirty', dirty);
    if (dirty) setMsg('有未保存的改动', 'warn');
    else if (saveMsg?.textContent === '有未保存的改动') setMsg('');
  }

  function applyPreset(names) {
    const set = new Set(names);
    for (const el of allChecks()) {
      el.checked = set.has(el.dataset.name);
      paint(el);
    }
    syncCounters();
  }

  function setAll(checked) {
    for (const el of allChecks()) {
      el.checked = checked;
      paint(el);
    }
    syncCounters();
  }

  // ── 扩展列表：插件 + 技能合成一条「扩展」区，翻页（不做横向滑条）──────────
  // 2026-09-22 用户两次反馈：
  //   ① "扩展那一栏太大了" → 先拆成两行；
  //   ② "不要做成滑条，做成翻页；技能能并进扩展就不用单独一栏了" → 现在就是这一版：
  //      插件与技能是同一类东西（都是 plugins/ 或 skills/ 下的扩展），
  //      只是 🧩 插件＝确定性规则、🧠 技能＝注册工具给模型，用图标区分即可，
  //      所以合成一栏、一页 12 个（折行排布，永远没有横向滚动条）、多了翻页。
  const EXT_PER_PAGE = 12;
  let extPage = 0;

  function extList() {
    // 只展示本仓库 plugins/ 与 skills/ 目录里真实存在的扩展（整合包外部条目不进列表）
    return (listData.extensions || []).filter((s) => {
      const d = String(s.dir || '');
      return d === 'plugins' || d === 'skills' || d.startsWith('plugins/') || d.startsWith('skills/');
    });
  }

  /** 紧凑卡片：图标 + 名字 + 状态徽标 + 开关 + 详情（详情里有完整说明与设置表单）。 */
  function extChipHtml(s) {
    const k = extKindLabel(s);
    const on = !!s.enabled;
    const err = s.loadError || s.lastError || '';
    const dir = esc(s.dir || k.folder);
    const title = [s.name || s.id, s.description || '', err ? `错误：${err}` : '', `${dir}${dir.endsWith('/') ? '' : '/'}${s.hasSettings ? ' · 可配置' : ''}`]
      .filter(Boolean).join('\n');
    return `
      <div class="tl-chip${on ? ' on' : ' is-off'}${err ? ' has-err' : ''}" data-ext-id="${esc(s.id)}" title="${esc(title)}">
        <label class="tl-chip-main">
          <input type="checkbox" class="ext-check" data-id="${esc(s.id)}" ${on ? 'checked' : ''} />
          <span class="tl-chip-ico">${k.k === 'plugin' ? '🧩' : '🧠'}</span>
          <span class="tl-chip-name">${esc(s.name || s.id)}</span>
          ${extBadge(s)}
        </label>
        <button type="button" class="tl-chip-more ext-detail" data-detail-id="${esc(s.id)}" title="说明与设置">${s.hasSettings ? '设置' : '详情'}</button>
      </div>`;
  }

  function wireExtCards(container) {
    container.querySelectorAll('button.ext-detail').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openExtDetail(btn.dataset.detailId);
      });
    });
    container.querySelectorAll('input.ext-check').forEach((el) => {
      const row = el.closest('.tl-chip');
      el.addEventListener('change', async () => {
        const id = el.dataset.id;
        el.disabled = true;
        try {
          await api('/api/skills', {
            method: 'POST',
            body: JSON.stringify({ id, enabled: el.checked })
          });
          try { await api('/api/hot-reload', { method: 'POST', body: JSON.stringify({ reconnectOneBot: false }) }); } catch { /* ignore */ }
          listData = await api('/api/tools-list');
          renderExtensions();
          renderTools();
          applyFilter();
          syncCounters();
        } catch (e) {
          setMsg(`开关失败：${e?.message || e}`, 'warn');
          el.checked = !el.checked;
        } finally {
          el.disabled = false;
          row?.classList.toggle('on', el.checked);
          row?.classList.toggle('is-off', !el.checked);
        }
      });
    });
  }

  function renderExtensions() {
    const list = extList();
    // 插件在前、技能在后（同类内按 id 排序）：一眼能看出"哪几个是必然执行的规则"
    const plugins = list.filter((s) => s.kind === 'plugin').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const skills = list.filter((s) => s.kind !== 'plugin').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const all = [...plugins, ...skills];

    const pages = Math.max(1, Math.ceil(all.length / EXT_PER_PAGE));
    if (extPage >= pages) extPage = pages - 1;
    if (extPage < 0) extPage = 0;
    const slice = all.slice(extPage * EXT_PER_PAGE, (extPage + 1) * EXT_PER_PAGE);
    extBox.innerHTML = all.length
      ? slice.map(extChipHtml).join('')
      : '<div class="tl-empty">plugins/ 与 skills/ 里还没有扩展。点右上「打开 plugins / 打开 skills」把文件夹丢进去，再热重载。</div>';
    extPagerBox.innerHTML = all.length > EXT_PER_PAGE
      ? `<button type="button" class="btn btn-small" data-page="prev" ${extPage === 0 ? 'disabled' : ''} title="上一页">‹</button>
         <span class="tl-pager-text">${extPage + 1}/${pages} · 共 ${all.length}（🧩${plugins.length} 🧠${skills.length}）</span>
         <button type="button" class="btn btn-small" data-page="next" ${extPage >= pages - 1 ? 'disabled' : ''} title="下一页">›</button>`
      : (all.length ? `<span class="tl-pager-text">共 ${all.length}（🧩${plugins.length} 🧠${skills.length}）</span>` : '');
    for (const btn of extPagerBox.querySelectorAll('button[data-page]')) {
      btn.addEventListener('click', () => {
        extPage += btn.dataset.page === 'next' ? 1 : -1;
        renderExtensions();
      });
    }
    wireExtCards(extBox);
  }

  /** 扩展二级页：说明 + 状态 + 有 configSchema 时给设置表单（不在这层开文件夹）。 */
  async function openExtDetail(id) {
    const local = (listData.extensions || []).find((x) => x.id === id);
    let full = local;
    try {
      const r = await api('/api/skills');
      const hit = (r.skills || []).find((x) => x.id === id);
      if (hit) full = { ...local, ...hit };
    } catch { /* 用本地列表数据 */ }
    if (!full) { setMsg('找不到该扩展', 'warn'); return; }
    const k = extKindLabel(full);
    const on = !!full.enabled;
    const schema = full.configSchema && typeof full.configSchema === 'object' ? full.configSchema : {};
    const settings = full.settings && typeof full.settings === 'object' ? full.settings : {};
    const keys = Object.keys(schema);
    const toolList = (full.tools || full.toolIds || []).map((t) => `<code>${esc(t)}</code>`).join(' ') || '—';
    const declaredCaps = (full.capabilities || []).map(String);
    const implCaps = (full.implementedCapabilities || []).map(String);
    const caps = declaredCaps.map((c) => `<code>${esc(c)}</code>`).join(' ') || '—';
    const hooks = (full.hooks || []).map((h) => `<code>${esc(h)}</code>`).join(' ') || '—';
    const err = full.loadError || full.lastError || '';
    const reason = full.active ? '' : (full.reason || '');
    // 声明了却没实现（或反过来）是很隐蔽的故障，界面上直接点名
    const capMismatch = declaredCaps.filter((c) => !implCaps.includes(c));
    const implOnly = implCaps.filter((c) => !declaredCaps.includes(c));

    // ── 设置表单：**完全按 configSchema 渲染**，不硬编码任何字段名 ──
    // 支持：boolean / number（min,max,step）/ enum（values 下拉）/ string
    //       （multiline → 多行文本框；secret → 密码框且"留空 = 不修改"）
    //       internal → 只读展示（这类值由插件自己的界面管，不在这里改）
    //       showIf  → 按另一个字段的当前值显隐（0.4 的插件包还专门为这个打了 UI 补丁）
    const fieldHtml = (key) => {
      const def = schema[key] || {};
      const val = settings[key];
      const type = def.type || 'string';
      const lab = esc(def.label || key);
      const hint = def.description ? `<div class="hint">${esc(def.description)}</div>` : '';
      const fid = `ext-cfg-${esc(key)}`;
      const dataAttrs = `data-ext-key="${esc(key)}" data-ext-type="${esc(type)}"`;
      let input = '';
      if (type === 'internal') {
        input = `<div class="hint" style="margin:0">这条设置不在这里改（由插件自己的界面维护）：<code>${esc(full.id)}.${esc(key)}</code></div>`;
      } else if (type === 'boolean') {
        input = `<input type="checkbox" id="${fid}" ${dataAttrs}${val === false ? '' : ' checked'} />`;
      } else if (type === 'number') {
        const min = def.min === undefined ? '' : ` min="${esc(def.min)}"`;
        const max = def.max === undefined ? '' : ` max="${esc(def.max)}"`;
        const step = def.step === undefined ? ' step="any"' : ` step="${esc(def.step)}"`;
        input = `<input type="number" id="${fid}" ${dataAttrs} value="${esc(val ?? '')}"${min}${max}${step} />`;
      } else if (type === 'enum' && Array.isArray(def.values)) {
        const opts = def.values.map((v) => `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('');
        input = `<select id="${fid}" ${dataAttrs}>${opts}</select>`;
      } else if (def.multiline === true || type === 'textarea') {
        input = `<textarea id="${fid}" ${dataAttrs} rows="${Math.min(12, Math.max(3, Number(def.rows) || 4))}" placeholder="${esc(def.placeholder || '')}">${esc(val == null ? '' : val)}</textarea>`;
      } else if (def.secret === true) {
        // 脱敏值不回填：留空 = 不修改（后端同一约定）
        input = `<input type="password" id="${fid}" ${dataAttrs} value="" placeholder="${val ? '已设置（留空 = 不修改）' : '未设置'}" autocomplete="new-password" />`;
      } else {
        input = `<input type="text" id="${fid}" ${dataAttrs} value="${esc(val == null ? '' : val)}" placeholder="${esc(def.placeholder || '')}" />`;
      }
      // showIf：{ field, value } 或 { field, notValue }
      const si = def.showIf && typeof def.showIf === 'object' ? def.showIf : null;
      const showAttr = si ? ` data-show-if="${esc(JSON.stringify(si))}"` : '';
      const hidden = si ? ' style="display:none"' : '';
      return `<div class="form-field"${showAttr}${hidden}><label for="${fid}"><span class="ff-lab">${lab}</span>${def.secret ? '<span class="ff-unit">🔒</span>' : ''}</label>${input}${hint}</div>`;
    };
    const settingsHtml = keys.length
      ? keys.map(fieldHtml).join('')
      : '<div class="hint">这个扩展没有可配置参数。</div>';

    modelModalShell({
      head: `${esc(full.name || full.id)} <span class="tk-kind">${k.title}</span> ${extBadge(full)}`,
      body: `
        <div class="ext-detail">
          <div class="ext-detail-meta">
            <div><b>ID</b> <code>${esc(full.id)}</code></div>
            <div><b>目录</b> <code>${esc(full.dir || k.folder)}</code></div>
            ${full.version ? `<div><b>版本</b> ${esc(full.version)}${full.apiVersion ? ` · API v${esc(full.apiVersion)}` : ''}</div>` : ''}
            <div><b>类型</b> ${esc(full.source === 'plugin' ? 'plugin.json（旧插件清单）' : 'skill.json')}${full.kind ? ` · ${esc(full.kind === 'plugin' ? '确定性型' : 'LLM 型')}` : ''}</div>
            <div><b>状态</b> ${on ? '已开启' : '已关闭'}${full.active ? ' · 生效中' : ''}${full.loaded ? '' : ' · 未加载'}</div>
          </div>
          ${full.description ? `<p class="ext-detail-desc">${esc(full.description)}</p>` : ''}
          ${err ? `<div class="tk-err" style="margin:8px 0">${esc(err)}</div>` : ''}
          ${!err && reason ? `<div class="hint" style="margin:6px 0">当前不可用：${esc(reason)}</div>` : ''}
          ${capMismatch.length ? `<div class="hint" style="margin:6px 0;color:var(--warn,#e0a800)">⚠️ 声明了但代码里没实现的能力：${capMismatch.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>` : ''}
          ${implOnly.length ? `<div class="hint" style="margin:6px 0">（代码里还实现了未在清单声明的能力：${implOnly.map((c) => `<code>${esc(c)}</code>`).join(' ')}）</div>` : ''}
          <div class="ext-detail-grid">
            <div><div class="ext-detail-label">${k.k === 'plugin' ? '能力 / 钩子' : '注册工具'}</div><div>${k.k === 'plugin' ? hooks + (caps !== '—' ? ' · ' + caps : '') : toolList}</div></div>
          </div>
          ${full.hasPanel ? `<div style="margin:8px 0"><button type="button" class="btn btn-small" id="ext-detail-panel">打开插件面板</button>
            <span class="hint" style="margin-left:8px">插件自带面板（panel.html）</span></div>` : ''}
          ${keys.length ? `<div class="ext-detail-settings"><div class="ext-detail-label">设置</div><div id="ext-detail-form">${settingsHtml}</div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-primary btn-small" id="ext-detail-save">保存设置</button>
              <span class="hint" id="ext-detail-msg"></span>
            </div></div>` : `<div class="hint" style="margin-top:8px">${k.tip}</div>`}
        </div>`,
      foot: `<button type="button" class="btn" id="ext-detail-close">关闭</button>`
    });

    const overlay = document.querySelector('.model-modal-overlay:last-of-type') || document.querySelector('.model-modal-overlay');
    overlay?.querySelector('#ext-detail-close')?.addEventListener('click', () => closeModelModal(overlay));
    // 插件面板：直接开一个新窗口指向后端代理的 panel.html（插件自带的 HTML 原样跑）
    overlay?.querySelector('#ext-detail-panel')?.addEventListener('click', () => {
      window.open(`/api/plugin/${encodeURIComponent(full.id)}/panel`, '_blank', 'width=880,height=720');
    });
    // showIf：按依赖字段的当前值显隐（改完立刻生效，不用重开弹窗）
    const applyShowIf = () => {
      if (!overlay) return;
      const valueOf = (key) => {
        const el = overlay.querySelector(`#ext-detail-form [data-ext-key="${key}"]`);
        if (!el) return undefined;
        return el.type === 'checkbox' ? !!el.checked : el.value;
      };
      overlay.querySelectorAll('#ext-detail-form [data-show-if]').forEach((box) => {
        let cond = null;
        try { cond = JSON.parse(box.dataset.showIf); } catch { cond = null; }
        if (!cond || !cond.field) { box.style.display = ''; return; }
        const dep = valueOf(cond.field);
        let show = true;
        if (dep === undefined) show = true;
        else if (cond.value !== undefined) show = String(dep) === String(cond.value);
        else if (cond.notValue !== undefined) show = String(dep) !== String(cond.notValue);
        box.style.display = show ? '' : 'none';
      });
    };
    applyShowIf();
    overlay?.querySelectorAll('#ext-detail-form [data-ext-key]').forEach((el) => {
      el.addEventListener('change', applyShowIf);
      // 文本类还监听输入：用户打字时依赖它的字段就该立刻出现
      if (el.tagName !== 'SELECT') el.addEventListener('input', applyShowIf);
    });
    overlay?.querySelector('#ext-detail-save')?.addEventListener('click', async () => {
      const msg = overlay.querySelector('#ext-detail-msg');
      const payload = {};
      overlay.querySelectorAll('#ext-detail-form [data-ext-key]').forEach((el) => {
        const key = el.dataset.extKey;
        const type = el.dataset.extType;
        const def = schema[key] || {};
        if (type === 'internal') return;
        if (type === 'boolean') payload[key] = !!el.checked;
        else if (type === 'number') {
          // 数字留空 = 不修改（避免把 0 或空串写进去）；有 min/max 就夹一下
          if (String(el.value).trim() === '') return;
          let n = Number(el.value);
          if (!Number.isFinite(n)) return;
          if (def.min !== undefined) n = Math.max(Number(def.min), n);
          if (def.max !== undefined) n = Math.min(Number(def.max), n);
          payload[key] = n;
        } else if (def.secret === true) {
          // 脱敏不回填 → 留空表示"不改"
          if (String(el.value).trim() !== '') payload[key] = el.value;
        } else payload[key] = el.value;
      });
      try {
        await api('/api/skills/settings', { method: 'POST', body: JSON.stringify({ id, settings: payload }) });
        if (msg) msg.textContent = '已保存 ✓';
        try { await api('/api/hot-reload', { method: 'POST', body: JSON.stringify({ reconnectOneBot: false }) }); } catch { /* ignore */ }
        listData = await api('/api/tools-list');
        renderExtensions();
      } catch (e) {
        if (msg) msg.textContent = '失败：' + (e?.message || e);
      }
    });
  }

  function renderTools() {
    const en = enabledSet();
    const allOpen = en == null;
    const cats = {};
    for (const t of listData.tools) {
      const meta = TOOLS_PAGE_META[t.name] || { label: t.name, icon: '🔧', cat: t.skillId ? '扩展' : '其它' };
      const cat = t.skillId ? '扩展' : meta.cat;
      if (!cats[cat]) cats[cat] = [];
      cats[cat].push({ ...t, ...meta, cat, skillId: t.skillId || null });
    }
    const order = ['基础', '表情', '图片', '联网', '社交', '记忆', '扩展', '其它'];
    grid.innerHTML = order.filter((c) => cats[c]).map((cat) => {
      const items = cats[cat];
      const onCount = allOpen ? items.length : items.filter((t) => en.has(t.name)).length;
      return `
        <div class="tl-group" data-cat="${esc(cat)}">
          <div class="tl-group-head">
            <span class="tl-group-title">${esc(cat)}</span>
            <span class="tl-group-count">${onCount}/${items.length}</span>
          </div>
          <div class="tl-items">
            ${items.map((t) => {
              const on = allOpen || en.has(t.name);
              return `
              <label class="tl-item${on ? ' on' : ''}" data-name="${esc(t.name)}" title="${esc(t.description)}">
                <input type="checkbox" class="tool-check" data-name="${esc(t.name)}" ${on ? 'checked' : ''} />
                <span class="tl-ico">${t.icon}</span>
                <span class="tl-body">
                  <span class="tl-label">${esc(t.label)}${t.skillId ? '<span class="tl-from" title="由扩展注册的工具">扩展</span>' : ''}</span>
                  <span class="tl-id">${esc(t.name)}</span>
                </span>
              </label>`;
            }).join('')}
          </div>
        </div>`;
    }).join('');
    grid.querySelectorAll('input.tool-check').forEach((el) => {
      el.addEventListener('change', () => {
        paint(el);
        syncCounters();
      });
    });
  }

  /** 搜索过滤：按 名称 / ID / 分类 命中；整组没有命中就把组一起藏掉。 */
  function applyFilter() {
    const q = query.trim().toLowerCase();
    let any = false;
    for (const g of grid.querySelectorAll('.tl-group')) {
      let shown = 0;
      for (const item of g.querySelectorAll('.tl-item')) {
        const hit = !q || (item.dataset.name + ' ' + item.textContent).toLowerCase().includes(q);
        item.hidden = !hit;
        if (hit) shown += 1;
      }
      g.hidden = shown === 0;
      if (shown) any = true;
    }
    const empty = box.querySelector('#tl-no-hit');
    if (q && !any) {
      if (!empty) {
        const d = document.createElement('div');
        d.id = 'tl-no-hit';
        d.className = 'tl-empty';
        d.textContent = `没有匹配「${query.trim()}」的工具`;
        grid.appendChild(d);
      } else {
        empty.textContent = `没有匹配「${query.trim()}」的工具`;
      }
    } else if (empty) {
      empty.remove();
    }
  }

  try {
    listData = await api('/api/tools-list');
    renderExtensions();
    renderTools();
    syncCounters();
  } catch (e) {
    box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    return;
  }

  box.querySelector('#tl-search')?.addEventListener('input', (e) => {
    query = e.target.value || '';
    applyFilter();
  });
  box.querySelector('#t-all-on')?.addEventListener('click', () => setAll(true));
  box.querySelector('#t-all-off')?.addEventListener('click', () => setAll(false));
  box.querySelector('#t-preset-basic')?.addEventListener('click', () => applyPreset(TOOL_PRESETS.basic));
  box.querySelector('#t-preset-whale')?.addEventListener('click', () => applyPreset(TOOL_PRESETS.whale));
  box.querySelector('#t-save')?.addEventListener('click', async () => {
    const btn = saveBtn;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const tools = currentTools();
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { ...(state.config?.api || {}), tools } })
      });
      try { state.config = await api('/api/config'); } catch { /* ignore */ }
      try {
        await api('/api/hot-reload', { method: 'POST', body: JSON.stringify({ reconnectOneBot: false }) });
        setMsg('已保存并热重载 ✓', 'ok');
      } catch {
        setMsg('已保存；请手动热重载', 'warn');
      }
      listData = await api('/api/tools-list');
      renderExtensions();
      renderTools();
      applyFilter();
      syncCounters();
      btn.classList.remove('is-dirty');
    } catch (e) {
      setMsg(`保存失败：${e.message}`, 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存';
    }
  });
}

// ── 生活页：世界观与日历 ─────────────────────────────────────────────
// 这页只有四样东西：开关、今天是什么日子、世界观、事件池。
// 参数不再由 configSchema 铺成一整张表 —— 那就是"看着乱"的来源，
// 而且一堆数值参数（饱腹/困倦/精力下限/彩蛋冷却）本身已被判定为有害设计。
const LIFE_SKILL_IDS = ['life-system', 'life-tools'];

function lifeStatusBadge(s) {
  if (s.loadError) return '<span class="world-badge is-error">加载失败</span>';
  if (!s.loaded) return '<span class="world-badge">未加载</span>';
  if (s.active) return '<span class="world-badge is-on">生效中</span>';
  if (s.enabled) return '<span class="world-badge is-warn">已开启未激活</span>';
  return '<span class="world-badge">已关闭</span>';
}

function lifeSwitchHtml(s, opts = {}) {
  const { note = '', legacy = false } = opts;
  if (!s) {
    return '<div class="world-switch' + (legacy ? ' is-legacy' : '') + '"><div class="world-switch-title">未安装</div>' +
      '<div class="hint">未找到该技能（可能没落地到 skills/ 或 plugins/ 目录）</div></div>';
  }
  const errLine = s.loadError ? '<div class="world-switch-err">' + esc(s.loadError) + '</div>' : '';
  return '<label class="world-switch' + (legacy ? ' is-legacy' : '') + '" title="' + esc(s.description || '') + '">' +
    '<div class="world-switch-row">' +
      '<input type="checkbox" class="life-switch" data-id="' + esc(s.id) + '"' + (s.enabled ? ' checked' : '') + ' />' +
      '<div class="world-switch-copy">' +
        '<div class="world-switch-title">' + esc(s.name) + '</div>' +
        (note ? '<div class="world-switch-note">' + note + '</div>' : '') +
      '</div>' +
      lifeStatusBadge(s) +
    '</div>' +
    errLine +
    '<div class="life-switch-msg hint"></div></label>';
}

const LIFE_KIND_LABEL = { workday: '普通工作日', weekend: '周末', holiday: '节假日', makeup: '调休上班' };
// 分组中文名与插件里的 GROUP_TTL_MIN 一一对应；那边加组，这里也要加，否则界面会露出裸英文
const FACT_GROUP_CN = {
  sea: '海面天气', city: '城里', home: '住处', net: '网络',
  meal: '吃', rest: '睡', work: '正事', play: '玩', social: '出门', misc: '别的'
};
// 吃/睡 这类状态随时可以被问，常驻；其余是素材，播过一次就不再当新话题（与后端 STATE_GROUPS 对齐）
const LIFE_STATE_GROUPS = new Set(['meal', 'rest']);
const LIFE_WORLD_NOTE = '只写<b>世界</b>：城市、天气、行规、周围会发生什么。她是谁写在「设置 → 人设」。开启后还可按日历/账本轻调精力目标（见下方抽取节奏）。';

/** 事件池文本 → 按分组归堆（只做展示；抽取规则以后端 eventPool() 为准，写法保持一致）。 */
function lifeParsePool(text) {
  const byGroup = new Map();
  let ungrouped = 0;
  for (const raw of String(text || '').split('\n')) {
    const r = raw.trim();
    if (!r || r.startsWith('#')) continue;
    const m = /^([a-z]+)\s*[:：|]\s*(.+)$/i.exec(r);
    if (!m) ungrouped += 1;
    const g = m ? m[1].toLowerCase() : 'misc';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push((m ? m[2] : r).trim());
  }
  const total = [...byGroup.values()].reduce((a, b) => a + b.length, 0);
  return { byGroup, total, ungrouped };
}

function lifeMinsLeft(m) {
  const n = Number(m) || 0;
  if (n >= 120) return (n / 60).toFixed(1).replace(/\.0$/, '') + ' 小时';
  return n + ' 分钟';
}

/** 面板外壳：和情绪页共用 .emo-panel 那一套。 */
function lifePanel(title, meta, body, extraClass = '') {
  return '<section class="emo-panel' + (extraClass ? ' ' + extraClass : '') + '"><div class="emo-panel-head">' +
    '<span class="emo-panel-title">' + esc(title) + '</span>' +
    (meta ? '<span class="emo-panel-meta">' + meta + '</span>' : '') +
    '</div>' + body + '</section>';
}

function lifeDayBadge(kind) {
  const k = String(kind || '');
  const label = LIFE_KIND_LABEL[k] || k || '未知';
  return '<span class="world-kind k-' + esc(k || 'unknown') + '">' + esc(label) + '</span>';
}

/** 顶部两块：今天是什么日子 + 此刻记着的近况。 */
function lifeStatusHtml(life) {
  if (!life || !life.available) {
    return '<div class="world-empty">' +
      '<div class="world-empty-icon">◎</div>' +
      '<div class="world-empty-title">世界系统未开启</div>' +
      '<div class="hint">打开上方开关后，这里会显示今天是什么日子、以及账本里记着的近况。</div>' +
      '</div>';
  }
  const t = life.today;
  const cal = life.calendarFile || {};
  const dayKey = t?.dayKey || '';
  const dayParts = dayKey ? dayKey.split('-') : [];
  const dayNum = dayParts[2] || '';
  const dayYm = dayParts.length >= 2 ? `${dayParts[0]}.${dayParts[1]}` : '';
  const chips = [];
  if (t) {
    chips.push(lifeDayBadge(t.kind));
    if (t.weekLabel) chips.push('<span class="world-chip">' + esc(t.weekLabel) + '</span>');
    if (t.name) chips.push('<span class="world-chip is-accent">' + esc(t.name) + '</span>');
    if (t.note) chips.push('<span class="world-chip is-warn">' + esc(t.note) + ' → 会注入</span>');
    else chips.push('<span class="world-chip is-quiet">普通日子 · 日历不注入</span>');
  } else {
    chips.push('<div class="hint">日历已关闭，或读不到 data/life-calendar.json（只按周几判断）。</div>');
  }
  const dayMeta = [];
  if (cal.exists) {
    dayMeta.push(esc(cal.year || '?') + ' 年表 · 假期 ' + esc(cal.holidays || 0) + ' / 调休 ' + esc(cal.makeup || 0) +
      (cal.expired ? ' · <span class="is-warn-text">已过期</span>' : ''));
  }
  dayMeta.push('世界设定 ' + String(life.worldbook || '').length + ' 字 · 静态进 system');

  const facts = Array.isArray(life.facts) ? life.facts : [];
  const poolOn = life.eventPoolEnabled === true || life.poolEnabled === true;
  const actBar = poolOn
    ? '<div class="world-act">' +
      '<button class="btn btn-small" id="life-roll" type="button">从池子抽一条</button>' +
      (facts.length ? '<button class="btn btn-small" id="life-clear" type="button">清空账本</button>' : '') +
      '<span class="life-act-msg hint"></span></div>'
    : '<div class="world-act">' +
      (facts.length ? '<button class="btn btn-small" id="life-clear" type="button">清空账本</button>' : '') +
      '<span class="hint">事件池已关 · 账本靠正则记录她说过的话</span></div>';
  const factBody = facts.length
    ? '<div class="world-facts">' + facts.map((f) => {
      const isState = LIFE_STATE_GROUPS.has(f.group);
      return '<div class="world-fact' + (isState ? ' is-state' : '') + '">' +
        '<span class="world-fact-group">' + esc(FACT_GROUP_CN[f.group] || f.group) + '</span>' +
        '<div class="world-fact-main">' +
          '<span class="world-fact-t">' + esc(f.text) + '</span>' +
          '<span class="world-fact-meta">' + (isState ? '状态 · 常驻' : (f.shown ? '已播 ' + f.shown + ' 次' : '还没播')) +
            ' · ' + esc(lifeMinsLeft(f.minsLeft)) + '</span>' +
        '</div>' +
        '<button class="btn btn-small" data-life-clear="' + esc(f.group) + '" type="button">清</button>' +
        '</div>';
    }).join('') + '</div>' + actBar
      + '<div class="hint world-fact-foot">同分组只留最新。事件池关着时，主要来自她自己的话。</div>'
    : '<div class="world-empty is-inline"><div class="hint">' +
      (poolOn ? '账本还空着 —— 可从池子抽一条，或等她说话。' : '账本还空着 —— 事件池已关，等她说吃饭/在忙这类话就会记进来。') +
      '</div></div>' + actBar;

  return '<div class="world-status-grid">' +
    '<section class="emo-panel world-panel-day">' +
      '<div class="emo-panel-head"><span class="emo-panel-title">今天</span>' +
      (dayKey ? '<span class="emo-panel-meta">' + esc(dayKey) + '</span>' : '') + '</div>' +
      '<div class="world-day-card">' +
        '<div class="world-day-date">' +
          (dayNum ? '<div class="world-day-num">' + esc(dayNum) + '</div><div class="world-day-ym">' + esc(dayYm) + '</div>' : '<div class="world-day-num muted">--</div>') +
        '</div>' +
        '<div class="world-day-body">' +
          '<div class="world-day-line">' + chips.join('') + '</div>' +
          (dayMeta.length ? '<div class="world-meta">' + dayMeta.map((m) => '<div class="world-meta-item">' + m + '</div>').join('') + '</div>' : '') +
        '</div>' +
      '</div>' +
    '</section>' +
    '<section class="emo-panel world-panel-facts">' +
      '<div class="emo-panel-head"><span class="emo-panel-title">近况账本</span>' +
      '<span class="emo-panel-meta">注入时最多带 2 条</span></div>' +
      factBody +
    '</section>' +
    '</div>';
}

/** 表单：世界设定 / 事件池（开关）/ 抽取节奏 / 日历与精力。 */
function lifeFormHtml(s) {
  const schema = s && s.configSchema;
  if (!s || !schema) return '';
  const st = s.settings || {};
  const id = esc(s.id);
  const poolOn = st.eventPoolEnabled === true;
  const area = (key, rows) => {
    const def = schema[key] || {};
    return ff('life-f-' + key, def.label || key, '',
      '<textarea class="life-in world-area" id="life-f-' + key + '" data-key="' + esc(key) + '" data-type="textarea" rows="' + rows + '">' +
      esc(st[key] == null ? '' : st[key]) + '</textarea>',
      esc(def.description || '')) + (key === 'eventPool' ? '<div id="life-pool-count" class="hint"></div>' : '');
  };
  const nums = ['eventsPerDay', 'eventGapMin', 'eventRepeatH']
    .filter((k) => schema[k])
    .map((k) => ffNum('life-f-' + k, schema[k].label || k, '', st[k], 'class="life-in" data-key="' + k + '" data-type="number" step="any" min="0"'))
    .join('');
  const cal = schema.calendarEnabled
    ? '<div class="checkbox-row"><input type="checkbox" class="life-in" id="life-f-calendarEnabled" data-key="calendarEnabled" data-type="boolean"' +
      (st.calendarEnabled === false ? '' : ' checked') + ' />' +
      '<label for="life-f-calendarEnabled">' + esc(schema.calendarEnabled.label || '按日历感知节假日') + '</label>' +
      '<div class="hint">' + esc(schema.calendarEnabled.description || '') + '</div></div>'
    : '';
  const energy = schema.energyFromWorld
    ? '<div class="checkbox-row" style="margin-top:8px"><input type="checkbox" class="life-in" id="life-f-energyFromWorld" data-key="energyFromWorld" data-type="boolean"' +
      (st.energyFromWorld === false ? '' : ' checked') + ' />' +
      '<label for="life-f-energyFromWorld">' + esc(schema.energyFromWorld.label || '世界/账本修正精力目标') + '</label>' +
      '<div class="hint">' + esc(schema.energyFromWorld.description || '') + '</div></div>'
    : '';
  const poolSwitch = schema.eventPoolEnabled
    ? '<div class="checkbox-row world-pool-switch"><input type="checkbox" class="life-in" id="life-f-eventPoolEnabled" data-key="eventPoolEnabled" data-type="boolean"' +
      (poolOn ? ' checked' : '') + ' />' +
      '<label for="life-f-eventPoolEnabled">' + esc(schema.eventPoolEnabled.label || '启用事件池') + '</label>' +
      '<div class="hint">' + esc(schema.eventPoolEnabled.description || '') + '</div></div>'
    : '';
  return '<div class="world-form" data-form-id="' + id + '">' +
    settingsBlock('世界设定', LIFE_WORLD_NOTE, area('worldbook', 12)) +
    settingsBlock('事件池',
      '关：只靠<b>正则</b>把她自己说的话记进账本（吃饭 / 在忙 / 困了等）。开：才会从下面的池子随机抽。',
      poolSwitch +
      '<div class="world-pool-fields' + (poolOn ? '' : ' is-off') + '" id="life-pool-fields">' +
        area('eventPool', 12) +
        settingsBlock('抽取节奏', '池子开启时有效：每天最多几条、最短间隔、素材多久不重复。',
          '<div class="form-grid cols-3">' + nums + '</div>') +
      '</div>') +
    settingsBlock('日历与精力', '', (cal || '') + energy) +
    '<div class="world-save-bar">' +
      '<span class="life-form-msg hint"></span>' +
      (s.enabled ? '' : '<span class="hint">（当前已关闭，可先改，开启后生效）</span>') +
    '</div></div>';
}

/** 事件池分组计数（输入时实时刷）。 */
function lifeRefreshPoolCount(box) {
  const el = box && box.querySelector('#life-pool-count');
  const ta = box && box.querySelector('[data-key="eventPool"]');
  if (!el || !ta) return;
  const { byGroup, total, ungrouped } = lifeParsePool(ta.value);
  const parts = [...byGroup.entries()].map(([g, list]) =>
    esc(FACT_GROUP_CN[g] || g) + ' ' + list.length + (FACT_GROUP_CN[g] ? '' : '（未登记的分组）'));
  el.innerHTML = total
    ? '共 ' + total + ' 条 · ' + parts.join(' · ') +
      (ungrouped ? ' · <span style="color:#f59e0b">' + ungrouped + ' 行没写分组，会被当成 misc</span>' : '')
    : '<span style="color:#f59e0b">池子是空的 —— 开着也不会抽到随机事件。</span>';
}

/** 事件池开关 → 显隐池子与节奏表单。 */
function lifeSyncPoolUi(box) {
  const chk = box && box.querySelector('#life-f-eventPoolEnabled');
  const fields = box && box.querySelector('#life-pool-fields');
  if (!fields) return;
  const on = !!(chk && chk.checked);
  fields.classList.toggle('is-off', !on);
  // 打开时若每天条数还是 0，给一个可用默认，免得开了等于没开
  const perDay = box.querySelector('[data-key="eventsPerDay"]');
  if (on && perDay && !(Number(perDay.value) > 0)) perDay.value = '4';
}


function lifeCollectSettings(root) {
  const out = {};
  root.querySelectorAll('.life-in').forEach((el) => {
    const key = el.dataset.key;
    const type = el.dataset.type;
    if (type === 'boolean') out[key] = el.checked;
    else if (type === 'number') { const n = Number(el.value); out[key] = Number.isFinite(n) ? n : el.value; }
    else out[key] = el.value;
  });
  return out;
}

async function refreshLifeStatus() {
  const box = $('#life-status');
  if (!box) return;
  try {
    const life = await api('/api/life');
    box.innerHTML = lifeStatusHtml(life);
  } catch { /* 轮询失败保留上次显示 */ }
}

async function lifeSaveSettings(root, id, msgEl) {
  if (!root) return;
  // 上一次请求还没回来：记一笔"打完再补一次"，不能直接丢掉 ——
  // 自动保存下用户在保存途中继续打字是常态，丢掉的话最后一次输入就静默没了。
  if (msgEl && msgEl.dataset.busy) { msgEl.dataset.pending = '1'; return; }
  if (msgEl) { msgEl.dataset.busy = '1'; msgEl.textContent = '保存中…'; }
  try {
    await api('/api/skills/settings', { method: 'POST', body: JSON.stringify({ id, settings: lifeCollectSettings(root) }) });
    if (msgEl) msgEl.textContent = '已自动保存 ✓';
    refreshLifeStatus();
  } catch (e) {
    if (msgEl) msgEl.textContent = '失败：' + e.message;
  } finally {
    if (msgEl) {
      delete msgEl.dataset.busy;
      if (msgEl.dataset.pending) { delete msgEl.dataset.pending; lifeSaveSettings(root, id, msgEl); return; }
      setTimeout(() => { if (msgEl.textContent.indexOf('已自动保存') >= 0) msgEl.textContent = ''; }, 2500);
    }
  }
}

function renderLifePage(box, sys, _tools, life) {
  const head = '<div class="world-hero">' +
    '<div class="world-hero-copy">' +
      '<div class="world-hero-eyebrow">WORLD · 精力联动</div>' +
      '<h2>世界与事件</h2>' +
      '<div class="sub muted">管她的世界会发生什么；她是谁写在「设置 → 人设」</div>' +
    '</div>' +
    '<div class="emo-actions">' +
      '<button class="btn btn-small" id="life-goto-persona" type="button">去改人设</button>' +
    '</div></div>';
  const toggles = sys
    ? '<div class="world-toggles">' +
      lifeSwitchHtml(sys, { note: '主开关 · 世界设定 / 事件池 / 近况账本 / 日历 / 精力目标' }) +
      '</div>'
    : lifeSwitchHtml(null, {});
  box.innerHTML = '<div class="world-page">' + head + toggles +
    '<div class="world-status" id="life-status">' + lifeStatusHtml(life) + '</div>' +
    lifeFormHtml(sys) + '</div>';

  const lifePost = async (payload) => {
    try {
      return await api('/api/life', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  };
  box.querySelector('#life-goto-persona')?.addEventListener('click', () => {
    state.settingsSection = 'persona';
    switchTab('settings');
  });
  box.querySelector('#life-roll')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    const r = await lifePost({ action: 'roll' });
    const m = box.querySelector('.life-act-msg');
    if (m) {
      m.textContent = r?.ok
        ? (r.rolled ? '抽到一条 ✓' : (r.poolEnabled === false ? '事件池已关闭（当前用正则记账）' : '没抽：同组已有说法、播过、或被条数/间隔挡住'))
        : ('失败：' + (r?.error || ''));
    }
    refreshLifeStatus();
    if (ev.currentTarget.isConnected) ev.currentTarget.disabled = false;
  });
  box.querySelector('#life-clear')?.addEventListener('click', async () => {
    await lifePost({ action: 'clear' });
    refreshLifeStatus();
  });
  box.querySelectorAll('[data-life-clear]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await lifePost({ action: 'clear', group: btn.dataset.lifeClear });
      refreshLifeStatus();
    });
  });
  box.querySelectorAll('.life-switch').forEach((el) => {
    el.addEventListener('change', async () => {
      const label = el.closest('label');
      const msg = label && label.querySelector('.life-switch-msg');
      if (msg) msg.textContent = '切换中…';
      try {
        await api('/api/skills', { method: 'POST', body: JSON.stringify({ id: el.dataset.id, enabled: el.checked }) });
        loadLifeView();
      } catch (e) {
        el.checked = !el.checked;
        if (msg) msg.textContent = '切换失败：' + e.message;
      }
    });
  });
  // 世界条目同样改成「改动即存」：一张卡十来个字段（世界设定/事件池/节奏），
  // 改两处就得记得点一次保存，漏点就白改。防抖 600ms，输入停下来才发请求。
  box.querySelectorAll('[data-form-id]').forEach((root) => {
    const msgEl = root.querySelector('.life-form-msg');
    const id = root.dataset.formId;
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      if (msgEl && !msgEl.dataset.busy) msgEl.textContent = '正在保存…';
      timer = setTimeout(() => lifeSaveSettings(root, id, msgEl), 600);
    };
    root.addEventListener('input', (e) => { if (e.target.matches('.life-in')) schedule(); });
    root.addEventListener('change', (e) => { if (e.target.matches('.life-in')) schedule(); });
  });
  const poolTa = box.querySelector('[data-key="eventPool"]');
  if (poolTa) {
    poolTa.addEventListener('input', () => lifeRefreshPoolCount(box));
    lifeRefreshPoolCount(box);
  }
  const poolChk = box.querySelector('#life-f-eventPoolEnabled');
  if (poolChk) {
    poolChk.addEventListener('change', () => lifeSyncPoolUi(box));
    lifeSyncPoolUi(box);
  }
}

async function loadLifeView() {
  const box = $('#life-page');
  if (!box || state.tab !== 'life') return;   // 已切走就不必再画
  box.innerHTML = '<div class="muted">加载中…</div>';
  let skills = [];
  try {
    const r = await api('/api/skills');
    skills = (r.skills || []).filter((s) => LIFE_SKILL_IDS.indexOf(s.id) >= 0);
  } catch (e) {
    box.innerHTML = '<div class="empty-hint">读取技能列表失败：' + esc(e.message) + '</div>';
    return;
  }
  let life = null;
  try { life = await api('/api/life'); } catch (e) { life = { available: false, error: e.message }; }
  renderLifePage(
    box,
    skills.find((s) => s.id === 'life-system') || null,
    skills.find((s) => s.id === 'life-tools') || null,
    life
  );
}

function renderChatSection(c) {
  const st = c.store || {};
  const burstNote = `
    同一个人连发时，机器人会等到这一串<b>没人再说话</b>（默认 15 秒静默）再一起处理；
    被 @ 或命中关键词、以及隔了一阵子之后的第一条消息都不受影响，仍然按防抖窗口秒回。
    一串话最多等到「最长等」就开跑，避免刷屏把机器人憋住。<b>两个都填 0 = 关闭连发合并</b>。`;

  const rhythm = `
    ${grid(4, [
      ffNum('cfg-hypemin', '亢奋最低发言条数', '条 · 0=不限 · 仅亢奋', c.hypeMode?.minMessages ?? 5, 'min="0" max="20"'),
      ffNum('cfg-wakedelay', '防抖聚批窗口', '毫秒 · 聚成一批再开', c.wakeDelayMs, 'min="0"'),
      ffNum('cfg-burstsettle', '连发静默等待', '毫秒 · 最后一条之后', c.burstSettleMs ?? 15000, 'min="0"'),
      ffNum('cfg-burstmax', '连发最长等待', '毫秒 · 一串最多等到', c.burstMaxWaitMs ?? 30000, 'min="0"')
    ].join(''))}
    ${grid(2, [
      ffNum('cfg-draindelay', '批次间隔', '毫秒 · 上轮结束到下轮', c.drainDelayMs, 'min="0"'),
      ffNum('cfg-maxruns', '同时处理会话数', '个 · 并行上限 1–8', c.maxConcurrentRuns, 'min="1" max="8"')
    ].join(''))}
    ${checkRow('cfg-burst-adaptive', '连发窗口按「这个人爱不爱连发」自适应', c.burstAdaptive?.enabled !== false)}
    <div class="hint">
      同一个人连发时，等多久看<b>他自己</b>的习惯：说完就走的人少等（约 5 秒），
      爱一条条补的人多等（给满「连发静默等待」）。实测 15.4 万条真实消息：
      平均等待 9.40 秒 ≤ 老的 9.69 秒，而"回完他紧接着又补一句"的比例 11.7% &lt; 11.8%。
      关掉 = 回到老规则（首条短窗口、串内长窗口，人人都一样）。
    </div>
    ${checkRow('cfg-burst-jev', '连发合并交给本地 Jev 判（说完了就秒回）', c.localJev?.burstJudge?.enabled === true)}
    ${grid(2, [
      ffNum('cfg-burst-jev-conf', '判定门槛（概率）', '0-1 · 越大越保守', (c.localJev?.burstJudge?.minConfidence ?? 0.8), 'min="0" max="1" step="0.05"'),
      ffNum('cfg-burst-jev-margin', '判定门槛（前二名间隔）', '对数间隔', (c.localJev?.burstJudge?.minMargin ?? 1.0), 'min="0" max="6" step="0.1"')
    ].join(''))}
    <div class="hint">
      连发时（本来要干等「连发静默等待」那一下）先问一句本地小模型「他这句说完了没」：
      <b>说完了且够自信</b>就把等待缩回「防抖聚批窗口」，立刻回。<b>还在说</b>、判不准、超时、被 @ 都维持原计时不变
      —— 只做缩短，不做延长。需要在「本地 Jev」里启用本地模型。<br>
      门槛是拿真实消息回放量出来的：<code>0.80 / 1.0</code> ≈ 88% 的时候真说完了（保守）；
      <code>0.70 / 0.8</code> 覆盖翻三倍但准头掉到 75%（想更灵敏就往下调）。
    </div>`;

  const protect = `
    ${grid(3, [
      ffNum('cfg-mingap', '相邻消息最小间隔', '毫秒 · 防刷屏', c.send.minGapMs, 'min="200"'),
      ffNum('cfg-maxgap', '相邻消息最大间隔', '毫秒 · 超过则切段', c.send.maxGapMs, 'min="500"'),
      ffNum('cfg-maxpermin', '每分钟最多发送', '条 · 硬限流', c.send.maxPerMinute, 'min="1"')
    ].join(''))}
    ${grid(3, [
      ffNum('cfg-maxperhour', '每小时最多发送', '条 · 硬限流', c.send.maxPerHour ?? 500, 'min="1"'),
      ffNum('cfg-bylength', '按字数附加间隔', '毫秒/字 · 长文稍慢', c.send.byLengthMs ?? 20, 'min="0"'),
      ffNum('cfg-hardsplit', '硬切分长度', '字 · 0=不切', c.send.hardSplitAt ?? 4000, 'min="0"')
    ].join(''))}`;

  const stickers = `
    ${checkRow('cfg-sticker', '启用表情包（收藏表情同步 + 发送工具）', !!c.sticker.enabled)}
    ${grid(2, [
      ffSelect('cfg-sticker-encourage', '发表情积极程度', '引导 · 非强制',
        STICKER_LEVELS.map(([v, label]) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join(''),
        '模型仍会自行判断时机是否合适。'),
      ffNum('cfg-sticker-max', '提示词列几张表情', '张 · 2–30', c.sticker?.promptMaxStickers ?? 12, 'min="2" max="30"')
    ].join(''))}
    ${grid(1, [
      ffNum('cfg-sticker-rotate', '列表轮换周期', '分钟 · 优先没用过的', c.sticker?.rotatePeriodMin ?? 60, 'min="5" max="1440"')
    ].join(''))}
    <div class="hint hint-block">
      列表一半固定常用，一半按周期轮换（优先挑没用过的），避免「只按使用次数」越用越偏。
    </div>
    <div class="form-field" style="margin-bottom:4px">
      <label>
        <span class="ff-lab">给没备注的表情补描述</span>
        <span class="ff-unit">批量 · 约 ¥0.001/张</span>
      </label>
      <div class="field-addon">
        <button class="btn btn-small" id="sticker-annotate-btn" type="button">开始补备注</button>
        <span id="sticker-annotate-hint" class="muted" style="font-size:12px"></span>
      </div>
      <div class="hint">
        没备注的表情模型不知道何时该发，补一句描述后更容易出场。
      </div>
    </div>

    <div class="settings-divider"></div>
    <h4 class="settings-subhead">发网图（从网页下载后发送）</h4>
    ${checkRow('cfg-imagesend', '允许机器人发网图（send_image 工具）', c.security?.imageSend?.enabled !== false)}
    ${checkRow('cfg-imagepreview', '发送前必须先「看一眼」（视觉模型确认合适再发）', c.security?.imageSend?.requirePreview !== false)}
    ${checkRow('cfg-imageskippreview', '锁定站点里的图例外（不看不代表不安全，省视觉 token）', c.security?.imageSend?.skipPreviewForLockedHosts !== false)}
    ${grid(2, [
      ffNum('cfg-imagemax', '一次最多发几张', '张 · 1–10', c.security?.imageSend?.maxPerRun ?? 2, 'min="1" max="10"'),
      ffNum('cfg-imagemaxmb', '单张大小上限', 'MB · 超过不发', c.security?.imageSend?.maxBytesMB ?? 5, 'min="1" max="20"')
    ].join(''))}
    <div class="hint">
      只接受 http(s) 图片直链，内网地址拒绝。关掉「必须先看一眼」会省一轮调用，但发送前不再视觉确认。
    </div>`;

  const tiers = `
    ${checkRow('cfg-private-override', '私聊单独设置', !!st.privateOverride, '不勾 = 私聊沿用下面的群聊参数')}
    ${tierPanelHtml('group', st)}
    ${tierPanelHtml('private', st.private || {}, { hidden: !st.privateOverride, seeded: !!st.privateOverride, label: '私聊' })}

    <details class="perchat-block">
      <summary class="settings-subhead">单个会话单独设置</summary>
      <div class="hint" style="margin:6px 0 8px">默认跟随群聊参数；展开某个会话并勾选后可单独调。优先级：单独设置 &gt; 私聊 &gt; 群聊。</div>
      ${perChatKeys(c).map((key) => {
        const override = (st.perChat || {})[key];
        const on = Boolean(override);
        const slug = chatKeySlug(key);
        const name = formatChatTitle(key, chatNameOf(key));
        return `
        <details class="perchat-item"${on ? ' open' : ''}>
          <summary>${esc(name)}${on ? ' <span class="perchat-badge">单独</span>' : ''}</summary>
          <div class="checkbox-row" style="margin-top:8px">
            <input type="checkbox" id="perchat-on-${slug}" data-perchat="${esc(key)}" ${on ? 'checked' : ''} />
            <label for="perchat-on-${slug}">这个会话单独设置</label>
          </div>
          ${tierPanelHtml(`pc-${slug}`, override || st, { hidden: !on, seeded: on, sfx: `-pc-${slug}`, label: name })}
        </details>`;
      }).join('') || '<div class="hint">还没有可配置的会话（先在白名单里勾选）。</div>'}
    </details>`;

  return `
    ${settingsBlock('运行节奏', '何时开跑、连发怎么合并。', rhythm, burstNote)}
    ${settingsBlock('发送保护', '限制刷屏与硬切分。', protect)}
    ${settingsBlock('表情包与网图', '', stickers)}
    ${settingsBlock(
      '响应档位',
      '滑条决定<b>何时开口</b>；下方数字是开口时带入的<b>已读条数</b>。',
      tiers,
      '',
      { id: 'settings-tier' }
    )}`;
}

function renderDesktopSection(c) {
  const desktop = settingsBlock('桌面端', '', `
    ${checkRow('cfg-autostart', '开机自启', !!c.server?.autoStart)}
    ${checkRow('cfg-closetray', '点关闭时最小化到托盘', c.server?.closeToTray !== false)}
  `);

  const uiBlock = settingsBlock('界面', '', `
    ${ff('theme-picker', '主题', '暗色 / 亮色 / 跟随系统 / ？', `
      <div class="theme-picker" id="theme-picker">
        ${THEME_CYCLE.map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>`,
      '暗色 / 亮色 = 经典 macOS 配色。自定义主题不在这排格子里 —— 用下面这一颗独立开关，点一下立刻换肤。')}
    ${ff('cfg-brightness', '界面亮度', '拖动即时生效 · 保存后跨账号互通', `
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="range" id="cfg-brightness" min="70" max="130" step="1"
          value="${clampBrightness(c.ui?.brightness ?? 100)}"
          style="flex:1;min-width:160px;height:34px" />
        <span class="muted" id="cfg-brightness-val" style="font-size:12px;min-width:42px;text-align:right">${clampBrightness(c.ui?.brightness ?? 100)}%</span>
        <button class="btn btn-small" type="button" id="cfg-brightness-reset">100%</button>
      </div>`,
      '100 = 默认；往左更暗，往右更亮。暗色默认已比系统灰再压一档，觉得还亮就往左拖。')}
    ${ff('cfg-uiscale', '界面缩放', '整页等比放大（卡牌/字体/按钮一起变大）', `
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="range" id="cfg-uiscale" min="80" max="200" step="5"
          value="${clampUiScale(c.ui?.uiScale ?? 100)}"
          style="flex:1;min-width:160px;height:34px" />
        <span class="muted" id="cfg-uiscale-val" style="font-size:12px;min-width:42px;text-align:right">${clampUiScale(c.ui?.uiScale ?? 100)}%</span>
        <button class="btn btn-small" type="button" id="cfg-uiscale-reset">100%</button>
        <button class="btn btn-small" type="button" id="cfg-uiscale-125">125%</button>
      </div>`,
      '100 = 默认。觉得卡牌/字太小就往右拖；Electron 下整页 zoom，所有写死 px 的控件会一起放大。')}
    <div class="form-field" style="margin-bottom:12px">
      <label><span class="ff-lab">自定义主题</span><span class="ff-unit">预设 / 导入文件 · 点一下立即生效</span></label>
      <div class="settings-actions" style="margin-top:0">
        <button class="btn${getThemePref() === 'custom' ? ' btn-primary is-on' : ''}" type="button" id="cfg-custom-toggle">${getThemePref() === 'custom' ? '自定义主题：开' : '自定义主题 · 开启'}</button>
        <button class="btn btn-small" type="button" id="cfg-custom-edit">编辑配色…</button>
        <button class="btn btn-small" type="button" id="cfg-custom-reset">清除并回暗色</button>
      </div>
      <div class="theme-preset-row" id="theme-presets" style="margin-top:8px"></div>
      <div class="settings-actions" style="margin-top:8px">
        <button class="btn btn-small" type="button" id="cfg-theme-import-btn">导入主题文件…</button>
        <input type="file" id="cfg-theme-import-file" accept=".json,.txt,.theme.txt,application/json,text/plain" hidden />
        <button class="btn btn-small" type="button" id="cfg-theme-open-dir">打开 themes 文件夹</button>
      </div>
      <div class="hint">机甲预设为黑橙（参考 Armoury Crate）。自定义格式见 <code>themes/THEME_FORMAT.txt</code>；导入 .json / .theme.txt 会立刻应用并保存。</div>
    </div>
    <div class="form-field" id="custom-colors-field" style="margin-bottom:12px;display:none">
      <label><span class="ff-lab">配色</span><span class="ff-unit">仅自定义主题生效 · 改色即预览</span></label>
      <div class="settings-actions" style="margin-top:0;gap:14px">
        <label class="color-field">背景
          <input type="color" id="cfg-custom-bg" value="#0c0c0e" />
        </label>
        <label class="color-field">卡片
          <input type="color" id="cfg-custom-bg2" value="#151517" />
        </label>
        <label class="color-field">强调色
          <input type="color" id="cfg-custom-accent" value="#f5a623" />
        </label>
        <label class="color-field">文字
          <input type="color" id="cfg-custom-text" value="#f4f4f5" title="正文颜色，可选纯黑 #000000" />
        </label>
        <label class="color-field">工具色
          <input type="color" id="cfg-custom-tool-accent" value="#ff7a00" title="工具名/调用区强调色" />
        </label>
        <button class="btn btn-primary btn-small" type="button" id="cfg-custom-apply">应用配色</button>
      </div>
      <div class="hint">拖色板会即时预览；「应用配色」写入配置。文字纯黑选 #000000。</div>
    </div>
    ${checkRow('cfg-mech-fx', '机甲特效（发光 / 角标 / 轨道）', c.ui?.mechFx !== false,
      '仅机甲主题生效。关掉后仍是锐利机甲形态，但去掉高光与装饰。')}
    ${checkRow('cfg-showvision', '模型目录显示「支持图片输入 / 不支持图片输入」徽标', c.ui?.showVision !== false)}
    ${checkRow('cfg-hide-apinews', '隐藏顶部「免费API」页签', c.ui?.hideApiNews === true,
      '勾上后顶部不再显示该页签（后台仍会每天凌晨 4 点照常抓取，随时取消勾选即可再看）。也可在下面的工具栏列表里单独隐藏。')}
    ${checkRow('cfg-hide-instance-tabs', '隐藏账号标签（本机多实例切换）', c.ui?.hideInstanceTabs === true,
      '默认<b>不隐藏</b>：用「启动-双号.bat」起了两个号时，顶栏会出现账号标签，点一下就在两个号之间切（合并在一个窗口里用）。'
      + '只列<b>同版本</b>的实例 —— 别的盘上的旧副本不会被列进来。不想看就勾上这里（不影响两个号运行）。')}
    ${ffNum('cfg-refreshms', '界面刷新间隔', '毫秒 · ≥1000', c.ui?.refreshMs ?? 15000, 'min="1000" step="1000"')}
  `);

  const toolbar = settingsBlock('顶部工具栏自定义', '拖动或点 ↑↓ 调整顺序；取消勾选 = 隐藏。改动立刻预览，点上方「保存设置」写入配置（跨实例生效）。', `
    <div class="tb-cfg-block">
      <label>导航页签（会话 / 存档 / …）</label>
      <ul class="tb-cfg-list" id="tb-nav-list"></ul>
    </div>
    <div class="tb-cfg-block">
      <label>顶栏（品牌 / 状态胶囊 / 页签状态条 / 操作按钮）</label>
      <ul class="tb-cfg-list" id="tb-top-list"></ul>
      <div class="hint">
        取消勾选即可隐藏对应胶囊/按钮（连接、模型、今日、搜、状态、页签右侧状态条均可单独藏）。
        藏「更多」会失去热重载入口，慎关。
      </div>
    </div>
    <button type="button" class="btn btn-small" id="tb-toolbar-reset" style="margin-top:8px">恢复工具栏默认</button>
  `);

  const notes = settingsBlock('群成员备注', '模型在记忆与回复中会优先使用备注称呼。', `
    <div class="form-field" style="margin-bottom:8px">
      <label><span class="ff-lab">添加 / 更新备注</span><span class="ff-unit">QQ 号 + 备注名</span></label>
      <div class="field-addon" style="flex-wrap:wrap">
        <input type="text" id="cfg-note-qq" placeholder="QQ 号" style="width:140px;flex:0 0 140px" />
        <input type="text" id="cfg-note-name" placeholder="备注名（如 老王）" />
        <button class="btn btn-small" id="cfg-note-add-btn" type="button">添加/更新</button>
        <button class="btn btn-small btn-danger" id="cfg-note-del-btn" type="button">删除</button>
      </div>
      <div class="hint" id="cfg-note-hint"></div>
      <div class="hint">已有备注：<span id="cfg-note-list">（无）</span></div>
    </div>
  `);

  return desktop + uiBlock + toolbar + notes;
}

function renderOnebotSection(c) {
  return settingsBlock('OneBot（SnowLuma）', 'SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签；桥上账号白名单也在那边维护。此处只保留连接配置。', `
    ${ffAddon('cfg-snowlumadir', 'SnowLuma 程序目录', '留空 = 项目内 snowluma/',
      `<input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" />`,
      `<button class="btn btn-small" id="open-snowluma-btn" type="button">打开文件夹</button>`,
      '')}
    <div class="hint" id="snowluma-hint" style="margin:-4px 0 12px"></div>
    ${checkRow('cfg-snowlumalaunch', 'QQ Agent 启动时自动拉起 SnowLuma（未运行时）', !!c.snowluma.autoLaunch)}
    ${grid(2, [
      ffText('cfg-wsurl', 'WebSocket 地址', '收消息', c.snowluma.wsUrl),
      ffText('cfg-httpurl', 'HTTP 地址', '发消息', c.snowluma.httpUrl),
      ff('cfg-obtoken', 'WebSocket 令牌', 'OneBot access_token',
        `<input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" />`),
      ff('cfg-obhttptoken', 'HTTP 令牌', '与 WS 不同时填 · SnowLuma 默认分开',
        `<input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" />`)
    ].join(''))}
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>
  `, '', { id: 'settings-onebot' });
}

function bindSettingsEvents(c) {
  // 顶部工具栏自定义列表（桌面端 → 界面）
  if ($('#tb-nav-list') || $('#tb-top-list')) bindToolbarCfgSection();

  // B 站一键登录（Electron 壳）
  const biliBtn = $('#cfg-bili-login-btn');
  const biliHint = $('#cfg-bili-hint');
  const setBiliHint = (t) => { if (biliHint) biliHint.textContent = t; };
  if (biliBtn) {
    const api = window.qqAgent;
    if (!api?.biliLogin) {
      setBiliHint('当前不是桌面壳（或未加载 preload），无法一键登录。可手动粘贴 Cookie 后保存。');
      biliBtn.disabled = true;
    } else {
      api.onBiliLoginStatus?.((st) => {
        if (!st) return;
        if (st.phase === 'opening' || st.phase === 'opened') setBiliHint('请在弹出的 B 站窗口登录…');
        else if (st.phase === 'saved') {
          setBiliHint('已登录并写入 Cookie ✓ 建议点上方「保存」使全实例读到新值。');
          const cfgInput = $('#cfg-bili-cookie');
          if (cfgInput) cfgInput.placeholder = '已配置（输入新值可覆盖）';
        } else if (st.phase === 'error') setBiliHint(`登录失败：${st.error || '未知'}`);
        else if (st.phase === 'closed') setBiliHint('登录窗已关闭。');
      });
      biliBtn.addEventListener('click', async () => {
        setBiliHint('正在打开 B 站登录窗…');
        try {
          await api.biliLogin();
        } catch (e) {
          setBiliHint(`无法打开登录窗：${e.message || e}`);
        }
      });
    }
  }
  $('#cfg-bili-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('清空已保存的 B 站 Cookie？')) return;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ webSearch: { bilibiliCookie: '' } }) });
      setBiliHint('已清空 Cookie。');
      const inp = $('#cfg-bili-cookie');
      if (inp) inp.placeholder = '未配置 — 点右侧一键登录，或手动粘贴';
    } catch (e) {
      setBiliHint(`清空失败：${e.message}`);
    }
  });

  // 本地 Jev：起停 / 试判
  const jevOut = $('#cfg-jev-probe-out');
  const jevProbeInput = () => document.getElementById('cfg-jev-probe');
  const jevProbeRole = () => document.getElementById('cfg-jev-probe-role');
  const jevTestBtn = () => document.getElementById('cfg-jev-test');
  /** 整页重绘后把试判输入/结果补回去，避免点重启/清空把正在打的句子冲掉。 */
  const jevPreserveProbe = (fn) => {
    const text = jevProbeInput()?.value || '';
    const role = jevProbeRole()?.value || '';
    const out = jevOut?.textContent || '';
    fn();
    const inp = jevProbeInput();
    const sel = jevProbeRole();
    if (inp) inp.value = text;
    if (sel && role) sel.value = role;
    if (jevOut && out) jevOut.textContent = out;
  };
  const jevCall = async (payload) => {
    try {
      return await api('/api/local-jev', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
  const jevStatusHint = (r) => {
    const s = r?.status || {};
    return `${r?.ok ? '🟢 已就绪' : '🔴 没起来'}${r?.reason || r?.error ? ` · ${r.reason || r.error}` : ''}${s.modelFile ? ` · ${s.modelFile}` : ''}${s.pid ? ` · pid ${s.pid}` : ''}`;
  };
  $('#cfg-jev-restart')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    if (jevOut) jevOut.textContent = '正在拉起本地模型（首次加载几秒）…';
    const r = await jevCall({ action: 'restart' });
    if (jevOut) jevOut.textContent = jevStatusHint(r);
    try {
      await refreshStatus();
      jevPreserveProbe(() => renderSettings());
    } catch { /* ignore */ }
    if (e.target.isConnected) e.target.disabled = false;
  });
  $('#cfg-jev-stop')?.addEventListener('click', async () => {
    const r = await jevCall({ action: 'stop' });
    if (jevOut) jevOut.textContent = r?.ok ? '已停止（下次判定会自动再拉起）' : `停止失败：${r?.error || ''}`;
  });
  $('#cfg-jev-clear')?.addEventListener('click', async () => {
    await jevCall({ action: 'reset-stats' });
    try {
      await refreshStatus();
      jevPreserveProbe(() => renderSettings());
    } catch { /* ignore */ }
    if (jevOut) jevOut.textContent = '统计已清空';
  });
  const runJevProbe = async (btn) => {
    const text = String(jevProbeInput()?.value || '').trim();
    if (!text) {
      if (jevOut) jevOut.textContent = '先在输入框里写一句话，再点「判一下」';
      jevProbeInput()?.focus();
      return;
    }
    const role = String(jevProbeRole()?.value || 'imageWantsGate');
    if (btn) btn.disabled = true;
    if (jevOut) jevOut.textContent = '判定中…';
    const r = await jevCall({ action: 'test', role, samples: [text] });
    const one = (r?.results || [])[0];
    if (jevOut) {
      jevOut.textContent = r?.ok && one
        ? `结论：${one.error ? `失败（${one.error}）` : (one.abstain ? `弃权（概率 ${(one.p ?? 0).toFixed(2)} 太低）` : `采信 → ${one.label}（概率 ${(one.p ?? 0).toFixed(2)}）`)}\n原样输出：${JSON.stringify(one.raw ?? '')} · ${one.ms ?? r?.status?.stats?.[role]?.avgMs ?? '?'}ms${one.on === false && !one.abstain && !one.error ? '\n（这一项没被接管或判的是反方向 → 走原逻辑）' : ''}`
        : `失败：${r?.error || '没返回结果'}`;
    }
    if (btn && btn.isConnected) btn.disabled = false;
  };
  $('#cfg-jev-test')?.addEventListener('click', (e) => { runJevProbe(e.currentTarget); });
  // 回车直接试判，不用再去点按钮
  jevProbeInput()?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runJevProbe(jevTestBtn());
    }
  });

  // 通用「保存」按钮已下线（2026-09-20）：设置项改成「改动即自动保存」，
  // 调度逻辑见文件末尾的 scheduleSettingsSave / flushSettingsSave。
  // 人设、SL 桥、工具白名单、知识库源仍各自保留自己的保存按钮。

  // 成本护栏状态
  api('/api/cost-guard').then((cg) => {
    const el = $('#cost-guard-hint');
    if (!el || !cg) return;
    el.textContent = `今日 prompt ${fmtTok(cg.totalPrompt || 0)} / ${fmtTok(cg.dayPromptMax || 0)} · 待办 ${(cg.todos || []).length} 条${cg.enabled === false ? ' · 护栏已关' : ''}`;
  }).catch(() => {
    const el = $('#cost-guard-hint');
    if (el) el.textContent = '用量统计不可用';
  });

  // 思考预算：滑条 ↔ 数字框同步 + 提示文案
  const thinkBudgetSync = () => {
    const slider = $('#cfg-think-budget-slider');
    const num = $('#cfg-think-budget');
    const nothink = $('#cfg-nothink');
    const hint = $('#think-budget-hint');
    if (!slider || !num || !hint) return;
    const n = Math.max(0, Math.min(32768, Math.round(Number(num.value) || 0)));
    if (document.activeElement !== num) slider.value = String(Math.min(512, n));
    const off = !!nothink?.checked;
    const disabled = off || n === 0;
    slider.disabled = off;
    num.disabled = off;
    if (off) hint.textContent = '思考已关闭，预算不生效';
    else if (n === 0) hint.textContent = '不限制（可能 8~37 秒）';
    else if (n <= 32) hint.textContent = `约 ${n} token ≈ 0.5~1 秒`;
    else if (n <= 64) hint.textContent = `约 ${n} token ≈ 1~2 秒`;
    else if (n <= 128) hint.textContent = `约 ${n} token ≈ 2~3 秒`;
    else if (n <= 256) hint.textContent = `约 ${n} token ≈ 4~5 秒`;
    else hint.textContent = `约 ${n} token ≈ 更慢但可能更稳`;
  };
  $('#cfg-think-budget-slider')?.addEventListener('input', () => {
    const num = $('#cfg-think-budget');
    if (num) num.value = $('#cfg-think-budget-slider').value;
    thinkBudgetSync();
  });
  $('#cfg-think-budget')?.addEventListener('input', thinkBudgetSync);
  $('#cfg-nothink')?.addEventListener('change', thinkBudgetSync);
  thinkBudgetSync();

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      // 百科源与搜索提供方无关，始终显示；下面只映射各搜索渠道自己的密钥区
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    // native 无独立配置区，全部字段隐藏
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率 + 参数高亮）──
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  //
  // 群聊/私聊各一条滑条，除 id 后缀（-p）外行为完全一致，所以共用这一个绑定函数：
  // 所有查询都限定在自己的面板内（#tier-panel-xxx），否则两套控件的 .tier-param /
  // .tier-seg 会互相把对方的高亮改掉。
  // 面板通用绑定：所有 .tier-panel（群聊 / 私聊 / 各群单独）共用一套逻辑，
  // 查询一律限定在自己的面板内，避免多套控件互相改对方的高亮。
  const bindTierPanel = (panel) => {
    if (!panel) return;
    const tierSlider = panel.querySelector('.tier-slider');
    if (!tierSlider) return;
    const sync = () => {
      const pos = Number(tierSlider.value);
      const { tier: t, randomPercent } = sliderToTierUI(pos);
      const note = panel.querySelector('.tier-note');
      if (note) note.textContent = sliderDesc(pos);
      const now = panel.querySelector('[data-tier-now]');
      if (now) {
        now.textContent = t === 3 ? `${TIER_NAME[t] || ''} · ${randomPercent}%` : (TIER_NAME[t] || '');
      }
      // 刻度带与条数格同步：只亮当前那一段，亮哪段就亮哪个条数格
      panel.querySelectorAll('.tier-seg').forEach((el, i) => el.classList.toggle('on', i + 1 === t));
      panel.querySelectorAll('.tier-nums > .tier-param').forEach((el, i) => el.classList.toggle('dim', i + 1 !== t));
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();
  };
  document.querySelectorAll('.tier-panel').forEach(bindTierPanel);

  // Jev「响应方式」：切换时直接改下方字段区，不用保存后才变
  const replyModeSel = $('#cfg-jev-replymode');
  const syncReplyModeUI = () => {
    const v = String(replyModeSel?.value || 'jev');
    document.querySelectorAll('[data-reply-mode]').forEach((el) => {
      el.classList.toggle('is-off', el.dataset.replyMode !== v);
    });
  };
  replyModeSel?.addEventListener('change', syncReplyModeUI);
  syncReplyModeUI();

  const tierSfxFromPanel = (panel) => {
    const id = String(panel?.id || '');
    if (id === 'tier-panel-group') return '';
    if (id === 'tier-panel-private') return '-p';
    if (id.startsWith('tier-panel')) return id.replace('tier-panel', '');
    return '';
  };
  const seedPanelFromGroup = (panel) => {
    if (!panel || panel.dataset.seeded === '1') return;
    const group = $('#tier-panel-group');
    if (!group) return;
    const sfx = tierSfxFromPanel(panel);
    for (const id of ['cfg-atcount', 'cfg-kwcount', 'cfg-randcount', 'cfg-allcount', 'cfg-keywords']) {
      const from = $('#' + id);
      const to = panel.querySelector('#' + id + sfx);
      if (from && to) to.value = from.value;
    }
    const gs = group.querySelector('.tier-slider');
    const ps = panel.querySelector('.tier-slider');
    if (gs && ps) {
      ps.value = gs.value;
      ps.dispatchEvent(new Event('input'));
    }
    panel.dataset.seeded = '1';
  };

  // ── 私聊单独设置开关：勾选后展开私聊那一套控件 ──
  // 首次开启时以当前群聊设置为起点（面板 data-seeded 标记过来自已保存配置的开启状态，
  // 所以"改过私聊参数 → 关掉 → 再打开"不会把用户调好的值冲掉）。
  // ── 浏览锁定：粘贴网址 → 提取站点加入列表 ──
  const browseAddBtn = $('#cfg-browseadd');  if (browseAddBtn) {
    const addDomain = () => {
      const box = $('#cfg-browsedomains');
      const input = $('#cfg-browsepaste');
      const hint = $('#cfg-browsehint');
      const host = normalizeDomain(input?.value || '');
      if (!host) {
        if (hint) hint.textContent = '没识别出站点，检查一下网址（例：https://zh.wikipedia.org/wiki/猫）';
        return;
      }
      const lines = String(box?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.includes(host)) lines.push(host);
      if (box) box.value = lines.join('\n');
      if (input) input.value = '';
      if (hint) hint.textContent = `已加入 ${host}（记得点保存）`;
    };
    browseAddBtn.addEventListener('click', addDomain);
    $('#cfg-browsepaste')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addDomain(); }
    });
  }

  // ── 表情批量补备注 ──
  const annotateBtn = $('#sticker-annotate-btn');
  if (annotateBtn) {
    const hint = $('#sticker-annotate-hint');
    const refreshAnnotateState = async () => {
      try {
        const r = await api('/api/stickers/annotate');
        if (!hint) return;
        hint.textContent = r.running
          ? `正在补：${r.done}/${r.total}`
          : `共 ${r.total} 张表情，其中 ${r.missing} 张还没有备注`;
      } catch { /* 忽略：这个提示不是关键路径 */ }
    };
    annotateBtn.addEventListener('click', async () => {
      annotateBtn.disabled = true;
      try {
        const r = await api('/api/stickers/annotate', { method: 'POST', body: JSON.stringify({ limit: 200 }) });
        if (hint) hint.textContent = r.started ? `已开始，共 ${r.total} 张…` : (r.note || '无需补备注');
      } catch (e) {
        if (hint) hint.textContent = String(e?.message || e);
      } finally {
        annotateBtn.disabled = false;
        setTimeout(refreshAnnotateState, 2000);
      }
    });
    refreshAnnotateState();
  }

  // ── 站内搜索地址：实时显示"搜某个词时会抓哪个 URL" ──
  const siteSearchInput = $('#cfg-browsesearchurl');
  if (siteSearchInput) {
    const syncSearchHint = () => {
      const hint = $('#cfg-browsesearchhint');
      if (!hint) return;
      const tpl = String(siteSearchInput.value || '').trim();
      if (!tpl) {
        hint.textContent = '留空 = 自动给关键词加 site:你的站点 限定（Bing 支持）。';
        return;
      }
      const hasToken = SEARCH_PLACEHOLDERS.some((p) => tpl.includes(p));
      hint.innerHTML = `搜「猫」时会抓：<code>${esc(buildSiteSearchPreview(tpl, '猫'))}</code>`
        + (hasToken ? '' : '<br><b>⚠️ 没找到 {query} 这类占位符</b>——已自动把查询参数的值替换成关键词，但建议直接写 {query}，避免地址里带多余字符。');
    };
    siteSearchInput.addEventListener('input', syncSearchHint);
    syncSearchHint();
  }

  const privToggle = $('#cfg-private-override');
  if (privToggle) {
    const panel = $('#tier-panel-private');
    if (panel) panel.dataset.sfx = '-p';
    const apply = () => {
      const on = privToggle.checked;
      if (panel) panel.style.display = on ? '' : 'none';
      if (on) seedPanelFromGroup(panel);
    };
    privToggle.addEventListener('change', apply);
    apply();
  }

  // ── 各群/好友单独设置开关（每个会话一个 checkbox + 一套面板）──
  document.querySelectorAll('input[data-perchat]').forEach((box) => {
    const key = box.dataset.perchat;
    const panel = $('#tier-panel-pc-' + chatKeySlug(key));
    if (panel) panel.dataset.sfx = '-pc-' + chatKeySlug(key);
    const apply = () => {
      const on = box.checked;
      if (panel) panel.style.display = on ? '' : 'none';
      if (on) seedPanelFromGroup(panel);
      const details = box.closest('details');
      if (details) details.open = on || details.open;
    };
    box.addEventListener('change', apply);
    apply();
  });

  // ── 主题选择器（设置页「界面」区）：只有暗/亮/系统/？，无自定义格 ──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        // 主题立刻写后端（两号互通），不必等「保存设置」
        api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: getThemePref() } }) })
          .catch(() => { /* 离线仍保持本地主题 */ });
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 界面亮度：拖动即时预览；写 localStorage，保存设置时写入 ui.brightness ──
  const brightSlider = $('#cfg-brightness');
  if (brightSlider) {
    // rAF 合帧：拖动时最多每帧写一次 CSS 变量，避免连续 style 强制同步布局
    let brightRaf = 0;
    brightSlider.addEventListener('input', () => {
      if (brightRaf) return;
      brightRaf = requestAnimationFrame(() => {
        brightRaf = 0;
        applyBrightness(brightSlider.value);
      });
    });
  }
  $('#cfg-brightness-reset')?.addEventListener('click', () => {
    if (brightSlider) brightSlider.value = '100';
    applyBrightness(100);
    api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { brightness: 100 } }) })
      .catch(() => { /* 本地仍已生效 */ });
  });
  // ── 界面缩放：拖动即时生效；卡牌等 px 控件随 zoom 一起放大 ──
  const scaleSlider = $('#cfg-uiscale');
  if (scaleSlider) {
    let scaleRaf = 0;
    scaleSlider.addEventListener('input', () => {
      if (scaleRaf) return;
      scaleRaf = requestAnimationFrame(() => {
        scaleRaf = 0;
        applyUiScale(scaleSlider.value);
      });
    });
    scaleSlider.addEventListener('change', () => {
      applyUiScale(scaleSlider.value);
      api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ ui: { uiScale: clampUiScale(scaleSlider.value) } })
      }).catch(() => { /* 本地仍已生效 */ });
    });
  }
  const setScaleAndPersist = (p) => {
    if (scaleSlider) scaleSlider.value = String(p);
    applyUiScale(p);
    api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { uiScale: p } }) })
      .catch(() => { /* 本地仍已生效 */ });
  };
  $('#cfg-uiscale-reset')?.addEventListener('click', () => setScaleAndPersist(100));
  $('#cfg-uiscale-125')?.addEventListener('click', () => setScaleAndPersist(125));
  $('#cfg-mech-fx')?.addEventListener('change', (ev) => {
    const on = !!ev.target.checked;
    if (state?.config?.ui) state.config.ui.mechFx = on;
    syncUiStyle(state?.config?.ui?.customThemeId);
    api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { mechFx: on } }) })
      .catch(() => { /* 本地已生效 */ });
  });

  // ── 自定义主题：开关 + 机甲预设 / 导入 + 手动色板 ──
  $('#cfg-custom-toggle')?.addEventListener('click', () => toggleCustomTheme());
  $('#cfg-custom-edit')?.addEventListener('click', () => {
    const field = $('#custom-colors-field');
    if (!field) return;
    const hidden = field.style.display === 'none';
    field.style.display = hidden ? '' : 'none';
    if (hidden) field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  function applyThemeColorsFromObject(c, themeId) {
    if (!c) return;
    const v = {
      bg: c.bg || '',
      bg2: c.bg2 || '',
      accent: c.accent || '',
      text: c.text || '',
      toolAccent: c.toolAccent || c['tool-accent'] || c.toolaccent || c.accent || ''
    };
    // 先写 config，再 applyTheme：syncUiStyle 要读到新的 customThemeId
    if (state.config?.ui) {
      state.config.ui.theme = 'custom';
      if (themeId) state.config.ui.customThemeId = themeId;
      state.config.ui.customBg = v.bg;
      state.config.ui.customBg2 = v.bg2;
      state.config.ui.customAccent = v.accent;
      state.config.ui.customText = v.text;
      state.config.ui.customToolAccent = v.toolAccent;
    }
    saveCustomColorsToStorage(v);
    applyTheme('custom');
    applyCustomColors(v);
    themeBaseBg = null;
    applyBrightness(getBrightnessPref());
    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    setVal('cfg-custom-bg', v.bg);
    setVal('cfg-custom-bg2', v.bg2);
    setVal('cfg-custom-accent', v.accent);
    setVal('cfg-custom-text', v.text);
    setVal('cfg-custom-tool-accent', v.toolAccent);
    syncUiStyle(themeId || state?.config?.ui?.customThemeId);
    const tgl = $('#cfg-custom-toggle');
    if (tgl) {
      tgl.classList.add('is-on', 'btn-primary');
      tgl.textContent = '自定义主题：开';
    }
  }

  async function loadThemePresets() {
    const host = $('#theme-presets');
    if (!host) return;
    let list = [THEME_PRESET_MECH, THEME_PRESET_MAID, THEME_PRESET_PIXEL];
    let current = state.config?.ui?.customThemeId || '';
    try {
      const r = await api('/api/themes');
      if (Array.isArray(r?.themes) && r.themes.length) list = r.themes;
      if (r?.current) current = r.current;
    } catch { /* 离线只用内置 */ }
    host.innerHTML = list.map((t) => {
      const on = getThemePref() === 'custom' && current === t.id;
      const c = t.colors || {};
      return '<button type="button" class="theme-preset-chip' + (on ? ' is-on' : '') + '" data-theme-id="' + esc(t.id) + '" title="' + esc(t.description || t.name || t.id) + '">' +
        '<span class="tp-swatches">' +
        '<i style="background:' + esc(c.bg || '#000') + '"></i>' +
        '<i style="background:' + esc(c.bg2 || '#333') + '"></i>' +
        '<i style="background:' + esc(c.accent || '#f5a623') + '"></i>' +
        '</span><span>' + esc(t.name || t.id) + '</span></button>';
    }).join('');
    host.querySelectorAll('[data-theme-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.themeId;
        try {
          await api('/api/themes/apply', { method: 'POST', body: JSON.stringify({ id }) });
          const r = await api('/api/themes');
          const th = (r?.themes || []).find((x) => x.id === id)
            || (id === THEME_PRESET_MECH.id ? THEME_PRESET_MECH : null)
            || (MAID_UI_IDS.has(String(id).toLowerCase()) ? THEME_PRESET_MAID : null)
            || (PIXEL_UI_IDS.has(String(id).toLowerCase()) ? THEME_PRESET_PIXEL : null);
          if (!th?.colors) throw new Error('找不到主题 ' + id);
          applyThemeColorsFromObject(th.colors, th.id);
          loadThemePresets();
        } catch (e) {
          alert('应用主题失败：' + (e?.message || e));
        }
      });
    });
  }
  loadThemePresets();

  $('#cfg-theme-import-btn')?.addEventListener('click', () => $('#cfg-theme-import-file')?.click());
  $('#cfg-theme-import-file')?.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      const r = await api('/api/themes/import', {
        method: 'POST',
        body: JSON.stringify({ content, filename: file.name })
      });
      const th = r?.theme;
      if (!r?.ok || !th?.colors) throw new Error(r?.error || '导入失败');
      applyThemeColorsFromObject(th.colors, th.id);
      loadThemePresets();
      alert('已导入并应用：' + (th.name || th.id));
    } catch (e) {
      alert('导入失败：' + (e?.message || e));
    }
  });
  $('#cfg-theme-open-dir')?.addEventListener('click', async () => {
    try {
      await api('/api/skills/open-folder', { method: 'POST', body: JSON.stringify({ kind: 'themes' }) });
    } catch {
      try {
        await api('/api/skills/open-folder', { method: 'POST', body: JSON.stringify({ kind: 'root' }) });
      } catch (e2) {
        alert('打开失败：' + (e2?.message || e2));
      }
    }
  });

  const bgIn = $('#cfg-custom-bg');
  const bg2In = $('#cfg-custom-bg2');
  const acIn = $('#cfg-custom-accent');
  const txIn = $('#cfg-custom-text');
  const toolIn = $('#cfg-custom-tool-accent');
  if (bgIn && bg2In && acIn && txIn && toolIn) {
    const cur = readCustomColors(state.config);
    if (cur.bg) bgIn.value = cur.bg;
    if (cur.bg2) bg2In.value = cur.bg2;
    if (cur.accent) acIn.value = cur.accent;
    if (cur.text) txIn.value = cur.text;
    if (cur.toolAccent) toolIn.value = cur.toolAccent;

    const readInputs = () => ({
      bg: bgIn.value, bg2: bg2In.value, accent: acIn.value,
      text: txIn.value, toolAccent: toolIn.value
    });
    const persistColors = (v) => {
      saveCustomColorsToStorage(v);
      if (state?.config?.ui) {
        state.config.ui.customBg = v.bg;
        state.config.ui.customBg2 = v.bg2;
        state.config.ui.customAccent = v.accent;
        state.config.ui.customText = v.text;
        state.config.ui.customToolAccent = v.toolAccent;
      }
      api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          ui: {
            theme: getThemePref() === 'custom' ? 'custom' : 'custom',
            customBg: v.bg, customBg2: v.bg2, customAccent: v.accent,
            customText: v.text, customToolAccent: v.toolAccent
          }
        })
      }).then((data) => { if (data?.config) state.config = data.config; }).catch(() => {});
    };

    // 拖色板：立刻预览（不强制写盘，避免每次 drag 打爆接口；松手 change 再落）
    const livePreview = () => {
      const v = readInputs();
      saveCustomColorsToStorage(v);
      if (state?.config?.ui) {
        state.config.ui.customBg = v.bg;
        state.config.ui.customBg2 = v.bg2;
        state.config.ui.customAccent = v.accent;
        state.config.ui.customText = v.text;
        state.config.ui.customToolAccent = v.toolAccent;
      }
      applyTheme('custom');
    };
    [bgIn, bg2In, acIn, txIn, toolIn].forEach((inp) => {
      inp.addEventListener('input', livePreview);
      inp.addEventListener('change', () => { livePreview(); persistColors(readInputs()); });
    });

    const applyBtn = $('#cfg-custom-apply');
    if (applyBtn) applyBtn.onclick = () => {
      const v = readInputs();
      saveCustomColorsToStorage(v);
      if (state?.config?.ui) state.config.ui.theme = 'custom';
      applyTheme('custom');
      persistColors(v);
    };
    const resetBtn = $('#cfg-custom-reset');
    if (resetBtn) resetBtn.onclick = () => {
      applyCustomColors({ bg: '', bg2: '', accent: '', text: '', toolAccent: '' });
      bgIn.value = CUSTOM_START.bg;
      bg2In.value = CUSTOM_START.bg2;
      acIn.value = CUSTOM_START.accent;
      txIn.value = CUSTOM_START.text;
      toolIn.value = CUSTOM_START.toolAccent;
      saveCustomColorsToStorage({ bg: '', bg2: '', accent: '', text: '', toolAccent: '' });
      clearColorCookies();
      applyTheme('dark');
      api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          ui: {
            theme: 'dark',
            customBg: '', customBg2: '', customAccent: '', customText: '', customToolAccent: ''
          }
        })
      }).then((data) => { if (data?.config) state.config = data.config; }).catch(() => {});
    };
  }

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    // URL 改了还没保存就先拉会拉到旧地址 —— 先顺手保存配置再拉
    try { await saveConfig({ quiet: true }); } catch { /* 保存失败也继续尝试拉取 */ }
    if (statusEl) statusEl.textContent = '正在拉取…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === '******')) {
            input.value = '******';
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      // 首字延迟 = 模型多久开始回话（推理模型会晚很多）；总耗时 = 整次请求。
      // 两个数分开看，才能分清"地址慢"还是"模型慢"。
      const ms = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)))
        ? '—'
        : (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(2)}s` : `${Math.round(Number(n))}ms`);
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（首字 ${ms(res.firstTextMs ?? res.ttfbMs)} / 总计 ${ms(res.latencyMs)}${res.thinkingDisabled ? '，已跳过思考' : ''}）：${res.note || '请求成功'}`
        : `✗ 测试失败（耗时 ${ms(res.latencyMs)}）：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （绑的是 test-provider-btn，id 不匹配），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 同一个卡片里的「前往 QQ 连接页签」也曾漏绑：它只在 OneBot 未连接时出现，
  // 正好是新手唯一会被引导去点的那颗按钮，点了没反应最劝退。
  const gotoSnowlumaBtn = $('#hc-goto-snowluma');
  if (gotoSnowlumaBtn) gotoSnowlumaBtn.addEventListener('click', () => switchTab('snowluma'));

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名（共享状态，弹窗勾选后也能带进来）
  let modelRows = Array.isArray(addProviderModelRows) && addProviderModelRows.length
    ? addProviderModelRows.map((r) => ({ ...r }))
    : [{ id: '', name: '' }];
  function syncAddProviderRows() {
    addProviderModelRows = modelRows.map((r) => ({ id: r.id, name: r.name }));
  }
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; syncAddProviderRows(); });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; syncAddProviderRows(); });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        syncAddProviderRows();
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    syncAddProviderRows();
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    syncAddProviderRows();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) {
      $('#provider-action-hint').textContent = '请至少添加一个模型（点「获取列表」勾选后会自动填进下方表格，或手动填一行）';
      return;
    }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      // 新建成功 → 真正切到该提供商的第一个模型（否则上面那句「已自动切换」是假的）
      let switched = false;
      if (r.created && r.provider?.id) {
        const firstModel = String(r.provider.models?.[0] || models[0]?.id || '').trim();
        if (firstModel) {
          try {
            await api('/api/config', {
              method: 'POST',
              body: JSON.stringify({
                api: { provider: r.provider.id, model: firstModel, baseUrl: r.provider.baseURL || baseUrl }
              })
            });
            switched = true;
          } catch { /* 切换失败不阻断添加结果提示 */ }
        }
      }
      const msg = r.created
        ? (switched ? '已添加新提供商，并已切换为该提供商的第一个模型。' : '已添加新提供商（未能自动切换模型，请在「模型目录」里点选）。')
        : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      addProviderModelRows = modelRows;
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      // loadSettings 会整段重渲染，提示必须写在重渲染之后，否则会被冲掉
      await loadSettings();
      const hint = $('#provider-action-hint');
      if (hint) hint.textContent = msg;
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 「扫描图片能力」：原来后端有 POST /api/vision/scan（32×32 纯色图问颜色），
  // 但界面**从来没有触发它的入口** —— 结果是徽标、"此模型不支持图片输入"的自动禁选
  // 全靠 config.modelVision，而那份数据永远空着（只有内置资料表兜底）。
  // 这里补上按钮 + 轮询进度；扫描是 202 → 用 /api/vision/results 的 scanning 判完成。
  const scanBtn = $('#vision-scan-btn');
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      const st = $('#vision-scan-status');
      if (scanBtn.disabled) return;
      scanBtn.disabled = true;
      scanBtn.textContent = '扫描中…';
      if (st) st.textContent = '正在逐个模型发一张 32×32 纯色图问颜色…（每个模型一次请求）';
      let summary = '';
      try {
        const r = await api('/api/vision/scan', { method: 'POST', body: '{}' });
        if (!r?.ok) throw new Error(r?.error || '启动失败');
        // 轮询到扫描结束（后端没有专门的完成事件给这个入口，results.scanning 最省事）
        for (let i = 0; i < 60; i += 1) {
          await new Promise((res) => setTimeout(res, 3000));
          const data = await api('/api/vision/results').catch(() => null);
          if (!data) break;
          state.visionResults = data.results || {};
          state.visionScanning = !!data.scanning;
          const n = Object.values(state.visionResults).filter((x) => x && (x.verdict === 'vision' || x.verdict === 'no-vision')).length;
          if (st) st.textContent = `已判定 ${n} 个模型…`;
          if (!data.scanning) break;
        }
        const okN = Object.values(state.visionResults || {}).filter((x) => x?.verdict === 'vision').length;
        const noN = Object.values(state.visionResults || {}).filter((x) => x?.verdict === 'no-vision').length;
        summary = `完成：${okN} 个可看图 · ${noN} 个不可看图（徽标已刷新）`;
      } catch (e) {
        summary = `失败：${e.message}`;
      }
      // 重画设置页拿新徽标；重画会把状态行也换掉，所以之后再把结果写回去
      scanBtn.disabled = false;
      scanBtn.textContent = '扫描图片能力';
      renderSettings();
      const st2 = $('#vision-scan-status');
      if (st2) st2.textContent = summary;
    });
  }

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 一键清洗消息记录（人设区）──
  // 用户反馈两件事一起解决：① 换人设后还被旧聊天记录拽着走；② 手动删了
  // data/messages / data/sessions 里的文件，"记录还在"（进程内存里那份没跟着掉）。
  const purgeRunBtn = $('#purge-run');
  if (purgeRunBtn) purgeRunBtn.addEventListener('click', async () => {
    const scope = $('#purge-scope')?.value === 'all' ? 'all' : 'chat';
    const chatKey = state.currentChatKey || '';
    const doMessages = $('#purge-messages')?.checked !== false;
    const doSessions = $('#purge-sessions')?.checked !== false;
    if (!doMessages && !doSessions) { setPurgeResult('至少勾一项要清的东西', true); return; }
    if (scope === 'chat' && !chatKey) { setPurgeResult('还没有选中会话：先在左侧会话/聊天列表点一个，或把范围切成「全部会话」', true); return; }
    const what = [doMessages ? '消息记录' : '', doSessions ? '会话存档' : ''].filter(Boolean).join(' + ');
    const where = scope === 'all' ? '全部会话（所有群 + 私聊）' : `${chatKey}`;
    if (!confirm(`确定清空 ${where} 的${what}？\n\n· 这会真的删掉磁盘上的记录文件，不可撤销\n· 正在运行的会话会跳过\n· 好感/印象/语义卡不受影响（那些在「记忆」页删）`)) return;
    purgeRunBtn.disabled = true;
    setPurgeResult('清洗中…');
    try {
      const r = await api('/api/purge-records', {
        method: 'POST',
        body: JSON.stringify({ all: scope === 'all', chatKey, messages: doMessages, sessions: doSessions })
      });
      const m = r?.messages || {};
      const s = r?.sessions || {};
      const parts = [];
      if (doMessages) parts.push(`${m.chats ?? 1} 个会话 / ${m.removedFiles ?? 0} 个文件 / ${m.messages ?? 0} 条消息`);
      if (doSessions) parts.push(`${s.removedSessions ?? 0} 条存档` + (s.keptRunning ? `（跳过运行中 ${s.keptRunning} 条）` : ''));
      setPurgeResult(`已清洗：${parts.join('，')} ✓`);
      try { await refreshStatus(); } catch { /* ignore */ }
      try { renderRight(); } catch { /* ignore */ }
    } catch (e) {
      setPurgeResult(`清洗失败：${e?.message || e}`, true);
    } finally {
      purgeRunBtn.disabled = false;
      setTimeout(() => setPurgeResult(''), 8000);
    }
  });
  function setPurgeResult(text, isErr = false) {
    const el = $('#purge-result');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isErr ? 'var(--red)' : '';
  }

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 群成员备注（桌面端区块） ──
  function renderMemberNoteList() {
    const notes = state.config?.memberNotes || {};
    const el = $('#cfg-note-list');
    if (el) el.textContent = Object.entries(notes).map(([id, n]) => `${n}(${id})`).join('、') || '（无）';
  }
  const noteAddBtn = $('#cfg-note-add-btn');
  if (noteAddBtn) noteAddBtn.addEventListener('click', async () => {
    const qq = $('#cfg-note-qq')?.value.trim() || '';
    const name = $('#cfg-note-name')?.value.trim() || '';
    const hint = $('#cfg-note-hint');
    if (!/^\d{5,15}$/.test(qq)) { if (hint) hint.textContent = '请先填 QQ 号（5~15 位数字）'; return; }
    if (!name) { if (hint) hint.textContent = '请填备注名（如 老王）；删除请点右侧「删除」按钮'; return; }
    const notes = { ...(state.config?.memberNotes || {}) };
    notes[qq] = name;
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: notes }) });
      state.config = data.config;
      $('#cfg-note-qq').value = '';
      $('#cfg-note-name').value = '';
      if (hint) hint.textContent = `已给 ${qq} 备注为「${name}」`;
      renderMemberNoteList();
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e.message}`;
    }
  });
  const noteDelBtn = $('#cfg-note-del-btn');
  if (noteDelBtn) noteDelBtn.addEventListener('click', async () => {
    const qq = $('#cfg-note-qq')?.value.trim() || '';
    const hint = $('#cfg-note-hint');
    if (!/^\d{5,15}$/.test(qq)) { if (hint) hint.textContent = '删除：请先填 QQ 号'; return; }
    const notes = { ...(state.config?.memberNotes || {}) };
    delete notes[qq];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: notes }) });
      state.config = data.config;
      $('#cfg-note-qq').value = '';
      $('#cfg-note-name').value = '';
      if (hint) hint.textContent = `已删除 ${qq} 的备注`;
      renderMemberNoteList();
    } catch (e) {
      if (hint) hint.textContent = `删除失败：${e.message}`;
    }
  });
  renderMemberNoteList();

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

/**
 * 弹窗外壳。
 * 主体方向判定：body **以 `<div class="model-modal-left"` 开头**才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 曾经只要 body 里"包含" model-modal-left 就加 row —— 但复合结构的弹窗
 *    （顶部工具栏 + 中部双栏 + 底部提示，如批量价格编辑、模型添加）需要的是
 *    外层纵向、双栏在 .ma-body 内部横向。误判成 row 后，工具栏与提示文
 *    两个 flex 项把宽度吃光，.ma-body（flex:1, basis 0）被挤成 0 宽，
 *    整个内容区隐形（2026-09-05 批量价格弹窗"空白"事故）。
 */
function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 这东西对省钱没什么实际帮助 —— 但一张纯数字的成本表太无聊了，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span>${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        ${items.map((it) => `
          <div class="tb-row">
            <span class="tb-icon">${it.icon}</span>
            <span class="tb-name">${esc(it.name)}</span>
            <span class="tb-code">${esc(it.key)}</span>
            <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
            <span class="tb-n">${it.n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  const sticker = counts.send_sticker ? `、贴了 ${counts.send_sticker} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      if (tpl) {
        $('#cfg-roletext').value = tpl.text;
        // ⚠️ 2026-09-22（用户反馈"人设疑似没有改成功"）：以前这里只把文本填进输入框，
        //   **不保存** —— 而程序改 value 不会触发 input 事件（自动保存的防抖监听收不到），
        //   用户点完卡片看文本框变了，以为切好了，其实 config.json 里还是旧卡。
        //   现在：填完立刻保存一次（并给出明确回执），选卡 = 生效。
        //   附加规则只在模板自己带的时候覆盖，否则保留用户已经写好的那几条。
        if (tpl.customRules) $('#cfg-customrules').value = tpl.customRules;
        const input = $('#cfg-persona-pick');
        if (input) input.value = tpl.name;
      }
      closeModelModal(overlay);
      syncPersonaButtons();
      applyPickedPersona(tpl);
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 选完人设立刻落盘（选卡 = 生效），并明确告诉用户成功了没有。
 *
 * 为什么不让用户再点一次「保存人设修改」：那张卡的语义就是"切到这个人设"，
 * 少一次点击就少一次"我以为切好了"的误会（这个误会已经让用户以为功能坏了）。
 */
async function applyPickedPersona(tpl) {
  const out = $('#persona-save-result') || $('#persona-pick-hint');
  if (out) out.textContent = '正在应用…';
  try {
    await saveConfig();
    if (out) out.textContent = `已应用并保存：${tpl?.name || '该人设'} ✓`;
    setTimeout(() => { if (out) out.textContent = ''; }, 4000);
  } catch (e) {
    if (out) out.textContent = `应用失败（还是旧人设）：${e?.message || e}`;
  }
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          const data = await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL } })
          });
          // 立刻回写本地 state，避免 loadSettings 慢一拍时体检仍显示「未选模型」
          if (data?.config?.api) {
            state.config = { ...state.config, api: { ...state.config?.api, ...data.config.api } };
            const hidden = $('#cfg-model');
            if (hidden) hidden.value = model;
            const pick = $('#cfg-model-pick');
            if (pick) pick.value = (p.modelNames || {})[model] || model;
          }
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签添加提供商。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      // 先把勾选写进「手动添加」的模型行：即使下面 API 失败或 loadSettings
      // 重渲染清掉闭包状态，用户点「确认添加」也能带上刚勾的模型。
      const pickedRows = newModels.map((m) => ({ id: String(m), name: String(m) }));
      if (pickedRows.length) {
        // 同地址已有项：只补新模型；新地址：整表替换为勾选结果
        if (existingProvider) {
          const kept = addProviderModelRows.filter((r) => r.id && existingIds.has(r.id));
          addProviderModelRows = [...kept, ...pickedRows.filter((p) => !kept.some((k) => k.id === p.id))];
        } else {
          addProviderModelRows = pickedRows;
        }
      }

      const body = existingProvider
        ? { providerId: existingProvider.id, models: pickedRows }
        : { baseUrl, apiKey, models: pickedRows };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      const r = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      // 全新提供商：自动切到刚勾选的第一个模型，避免添加完还在用旧端点
      if (!existingProvider && r?.provider?.id && !state.config?.api?.model) {
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({
              api: { provider: r.provider.id, model: newModels[0], baseUrl: r.provider.baseURL || baseUrl }
            })
          });
        } catch { /* 非致命 */ }
      }
      closeModelModal(overlay);
      const joinedMsg = `已加入 ${newModels.length} 个模型。`;
      await loadSettings();
      const hint = $('#provider-action-hint');
      if (hint) {
        hint.textContent = existingProvider
          ? joinedMsg
          : `${joinedMsg}（已填入下方模型行；若未自动切换可再点「确认添加」保存 Base URL/Key）`;
      }
    } catch (e) {
      // 失败也保留勾选，方便改 Key/Base URL 后点「确认添加」重试
      closeModelModal(overlay);
      await loadSettings();
      const hint = $('#provider-action-hint');
      if (hint) {
        hint.textContent = `直接写入目录失败：${e.message}。勾选的模型已填入下方表格，补全 Base URL/API Key 后点「确认添加」。`;
      }
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          // ⚠️ 2026-09-22（用户反馈"删除模型没有自动刷新"）：
          //   这里原来只调 renderRight()（重画弹窗右栏，用的还是本函数开头缓存的 providers）
          //   + 未 await 的 loadSettings()（只重画设置表单，不碰顶栏）。
          //   顶栏的模型胶囊与 state.status 只由 refreshStatus() 更新 → 删完模型顶栏还显示旧模型。
          //   现在：重新拉配置 → 重画右栏 → 重画设置 → 刷新顶栏状态；删的若是当前模型再明确提示。
          const wasCurrent = state.config?.api?.model === model;
          await loadSettings();
          renderRight();
          await refreshStatus();
          if (wasCurrent) {
            alert(`已删除模型「${names[model] || model}」。注意：它正是**当前正在使用**的模型，请到「模型 API」里重新选一个。`);
          }
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    // 直接赋值不会触发 input 事件，得手动叫一次自动保存
    scheduleSettingsSave();
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，已自动保存`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Math.max(3600000, (Number(val('#cfg-mem-interval-h', 168)) || 168) * 3600000),
      // 超过多少条才触发自动整理（不是上限；印象本身不设限，只有 60 条安全阀）
      maxImpressionsPerMember: Math.min(60, Math.max(4, Number(val('#cfg-mem-maximp', c.memory?.maxImpressionsPerMember ?? 12)) || 12))
    };
  }

  if (sec === 'jev') {
    const j = c.localJev || {};
    // 角色复选框：一个都没渲染出来时（status 还没到）保持旧列表，别存成空数组
    const boxes = Array.from(document.querySelectorAll('[id^="cfg-jev-role-"]'));
    const keepRoles = boxes.length
      ? boxes.filter((b) => b.checked).map((b) => b.id.replace(/^cfg-jev-role-/, ''))
      : (Array.isArray(j.roles) ? j.roles : []);
    patch.localJev = {
      ...j,
      enabled: chk('#cfg-jev-enabled', j.enabled === true),
      startOnLaunch: chk('#cfg-jev-autostart', j.startOnLaunch !== false),
      modelPath: val('#cfg-jev-model', j.modelPath || '').trim(),
      modelId: val('#cfg-jev-modelid', j.modelId || 'qwen3.5-0.8b').trim(),
      port: Math.max(1, Number(val('#cfg-jev-port', j.port || 18080)) || 18080),
      ctxSize: Math.max(1024, Number(val('#cfg-jev-ctx', j.ctxSize || 4096)) || 4096),
      maxInflight: Math.min(4, Math.max(1, Number(val('#cfg-jev-inflight', j.maxInflight || 2)) || 2)),
      inputMaxChars: Math.min(600, Math.max(40, Number(val('#cfg-jev-inputmax', j.inputMaxChars || 160)) || 160)),
      minConfidence: Math.min(1, Math.max(0, Number(val('#cfg-jev-minconf', j.minConfidence ?? 0.6)) || 0)),
      minMargin: Math.min(6, Math.max(0, Number(val('#cfg-jev-minmargin', j.minMargin ?? 1.0)) || 0)),
      useGrammar: chk('#cfg-jev-grammar', j.useGrammar !== false),
      gateBudgetMs: Math.min(8000, Math.max(300, Number(val('#cfg-jev-budget', j.gateBudgetMs || 1500)) || 1500)),
      roles: keepRoles,
      replyChance: {
        ...(j.replyChance || {}),
        mode: val('#cfg-jev-replymode', j.replyChance?.mode || 'jev'),
        enabled: true,
        cooldownMs: Math.max(0, Number(val('#cfg-jev-rc-cooldown', 90)) || 0) * 1000,
        maxPerHour: Math.max(0, Number(val('#cfg-jev-rc-maxhour', 8)) || 0),
        minMargin: Math.min(6, Math.max(0, Number(val('#cfg-jev-rc-minmargin', j.replyChance?.minMargin ?? 1.0)) || 0)),
        // 活跃度自适应：界面上只暴露最直观的「概率阈值 + 每小时上限」，
        // 两端的 minMargin / cooldownMs 仍留在配置文件里（这里靠 ... 原样透传，不覆盖）。
        adaptive: {
          ...(j.replyChance?.adaptive || {}),
          enabled: chk('#cfg-jev-rc-adaptive', j.replyChance?.adaptive?.enabled !== false),
          quiet: {
            ...(j.replyChance?.adaptive?.quiet || {}),
            minConfidence: Math.min(1, Math.max(0, Number(val('#cfg-jev-rc-quiet-conf', j.replyChance?.adaptive?.quiet?.minConfidence ?? 0.55)) || 0)),
            maxPerHour: Math.max(0, Number(val('#cfg-jev-rc-quiet-max', j.replyChance?.adaptive?.quiet?.maxPerHour ?? 10)) || 0)
          },
          busy: {
            ...(j.replyChance?.adaptive?.busy || {}),
            minConfidence: Math.min(1, Math.max(0, Number(val('#cfg-jev-rc-busy-conf', j.replyChance?.adaptive?.busy?.minConfidence ?? 0.88)) || 0)),
            maxPerHour: Math.max(0, Number(val('#cfg-jev-rc-busy-max', j.replyChance?.adaptive?.busy?.maxPerHour ?? 3)) || 0)
          }
        }
      },
      secondary: {
        // 备用模型入口已下线，保存时强制关闭并清空路径
        enabled: false,
        modelPath: '',
        modelId: '',
        port: Math.max(1, Number(j.secondary?.port) || 18081),
        ctxSize: j.secondary?.ctxSize || 4096,
        gpuLayers: j.secondary?.gpuLayers || 0,
        roles: []
      },
      cloud: {
        ...(j.cloud || {}),
        enabled: chk('#cfg-jev-cloud-enabled', j.cloud?.enabled === true),
        baseUrl: val('#cfg-jev-cloud-url', j.cloud?.baseUrl || '').trim(),
        // ⚠️ 2026-09-22：留空 / ****** = 保持原来那把 Key（服务端只回 hasApiKey，不回明文；
        //   以前无条件回写空串 → 点一次保存就把云端 Key 抹掉，用户以为"云端通道坏了"）。
        ...(() => {
          const typed = val('#cfg-jev-cloud-key', '').trim();
          return (typed && typed !== '******') ? { apiKey: typed } : {};
        })(),
        model: val('#cfg-jev-cloud-model', j.cloud?.model || '').trim(),
        upgradeBelow: Math.min(1, Math.max(0, Number(val('#cfg-jev-cloud-below', j.cloud?.upgradeBelow ?? 0.6)) || 0)),
        minConfidence: Math.min(1, Math.max(0, Number(val('#cfg-jev-cloud-minconf', j.cloud?.minConfidence ?? 0.6)) || 0)),
        assumeP: Math.min(1, Math.max(0, Number(val('#cfg-jev-cloud-assumep', j.cloud?.assumeP ?? 0)) || 0)),
        priceInPerM: Math.max(0, Number(val('#cfg-jev-cloud-ppm', j.cloud?.priceInPerM ?? 0)) || 0),
        priceOutPerM: Math.max(0, Number(val('#cfg-jev-cloud-ppm', j.cloud?.priceOutPerM ?? j.cloud?.priceInPerM ?? 0)) || 0),
        maxPerMinute: Math.max(0, Number(val('#cfg-jev-cloud-rate', j.cloud?.maxPerMinute ?? 60)) || 0)
      },
      // 迁移标记：设置页存过一次之后就当用户已确认新默认值，别再自动改
      migrated: '2026-09-19'
    };
  }

  if (sec === 'api') {
    const cacheMode = ['adaptive', 'implicit', 'explicit', 'off'].includes(val('#cfg-cachemode', ''))
      ? val('#cfg-cachemode', '') : (c.api.explicitCache ? 'explicit' : 'off');
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      disableThinking: chk('#cfg-nothink', !!c.api.disableThinking),
      thinkingBudget: Math.max(0, Math.min(32768, Math.round(Number(val('#cfg-think-budget', c.api.thinkingBudget ?? 0)) || 0))),
      cacheMode,
      // 保温开关（沿用原有节奏参数，只改 enabled）
      cacheKeepAlive: { ...(c.api.cacheKeepAlive || {}), enabled: chk('#cfg-cachewarm', c.api.cacheKeepAlive?.enabled !== false) },
      // 与旧版本配置兼容；新代码以 cacheMode 为准。
      explicitCache: cacheMode === 'explicit',
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      // 通用自动收尾：一轮发完就结束，省掉"只为调一次 finish"的整轮输入。
      // multiOnly 取反：勾上「单条也收尾」= 不再要求 ≥2 条
      autoFinish: {
        enabled: chk('#cfg-autofinish', c.api.autoFinish?.enabled === true),
        multiOnly: !chk('#cfg-autofinish-single', c.api.autoFinish?.multiOnly === false)
      },
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      priceRemoteUrl: val('#cfg-price-remote-url', c.api.priceRemoteUrl || '').trim(),
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0,
      // 成本护栏
      costGuard: {
        ...(c.api.costGuard || {}),
        enabled: $('#cfg-costguard') ? $('#cfg-costguard').checked : (c.api.costGuard?.enabled !== false),
        dayPromptMax: Math.max(0, Number(val('#cfg-costguard-day', c.api.costGuard?.dayPromptMax ?? 800000)) || 0),
        chatPromptMax: Math.max(0, Number(val('#cfg-costguard-chat', c.api.costGuard?.chatPromptMax ?? 200000)) || 0)
      },
      // 架构增强开关（缺控件时回落旧值，避免误清）
      architecture: {
        ...(c.api.architecture || {}),
        crossTurnWorking: $('#cfg-arch-working') ? $('#cfg-arch-working').checked : (c.api.architecture?.crossTurnWorking !== false),
        workingTtlMin: Math.max(5, Number(val('#cfg-arch-working-ttl', c.api.architecture?.workingTtlMin ?? 90)) || 90),
        workingDecayMin: Math.max(0, Number(val('#cfg-arch-working-decay', c.api.architecture?.workingDecayMin ?? 30)) || 0),
        workingMaxChars: Math.max(40, Number(val('#cfg-arch-working-chars', c.api.architecture?.workingMaxChars ?? 160)) || 160),
        semanticCards: $('#cfg-arch-cards') ? $('#cfg-arch-cards').checked : (c.api.architecture?.semanticCards !== false),
        semanticTopN: Math.min(8, Math.max(0, Number(val('#cfg-arch-cards-topn', c.api.architecture?.semanticTopN ?? 2)) || 0)),
        crossChatAwareness: $('#cfg-arch-crosschat') ? $('#cfg-arch-crosschat').checked : (c.api.architecture?.crossChatAwareness !== false),
        crossChatMinutes: Math.max(1, Number(val('#cfg-arch-crosschat-min', c.api.architecture?.crossChatMinutes ?? 10)) || 10),
        crossChatMaxChats: Math.min(12, Math.max(0, Number(val('#cfg-arch-crosschat-n', c.api.architecture?.crossChatMaxChats ?? 2)) || 0)),
        crossChatMaxChars: Math.min(800, Math.max(0, Number(val('#cfg-arch-crosschat-chars', c.api.architecture?.crossChatMaxChars ?? 120)) || 0)),
        pendingTodos: $('#cfg-arch-todos') ? $('#cfg-arch-todos').checked : (c.api.architecture?.pendingTodos !== false)
      }
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入 —— 那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const ca = Number(val('#cfg-price-cached', 0)) || 0;
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca || i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'native'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      fetchMaxChars: clampInt(val('#cfg-fetchmaxchars', c.webSearch?.fetchMaxChars ?? 8000), 1000, 50000, 8000),
      // wiki 不在这里改：外部百科源由「知识库」页签管，这里靠上面的 ...c.webSearch 原样透传。
      // 曾经写成 enabled:false / sources:[] 无条件覆盖，导致每次保存搜索设置都把百科源清空，
      // external_lookup 随之失效（而提示词仍在叫模型去用它）。
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || [],
      // B 站 Cookie：输入新值才覆盖；空则保留一键登录写入的那份
      bilibiliCookie: (() => {
        const entered = ($('#cfg-bili-cookie')?.value || '').trim();
        if (entered && entered !== '******') return entered;
        return c.webSearch?.bilibiliCookie || '';
      })()
    };
  }

  if (sec === 'persona') {
    // ⚠️ 2026-09-22（用户报"人设切换不了"）：下面原来直接写 `c.persona.botName` ——
    //    一旦 state.config 里没有 persona（比如某次桩/旧缓存把它换成过局部对象），
    //    整段就抛 TypeError，saveConfig 直接失败，用户看到的就是"点了没反应/切换不了"。
    //    所有分段一律用 `(c.xxx || {})` 兜底，缺字段只影响这一项，不会让整次保存挂掉。
    const p = c.persona || {};
    patch.persona = {
      botName: val('#cfg-botname', p.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', p.selfNickname || '').trim(),
      participation: val('#cfg-participation', p.participation),
      roleText: val('#cfg-roletext', p.roleText || ''),
      customRules: val('#cfg-customrules', p.customRules || ''),
      compactSystemPrompt: $('#cfg-compactprompt') ? $('#cfg-compactprompt').checked : p.compactSystemPrompt === true,
      systemMode: $('#cfg-system-mode') ? $('#cfg-system-mode').value : (p.systemMode || 'full')
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    // 原先这里硬编码 false：只要点过保存就把该开关永久重置，
    // 而 UI 里根本没有输入控件 —— 只能手改 JSON，改完一保存就丢。改为读取复选框。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
    patch.crazyThursday = {
      ...(c.crazyThursday || { enabled: true, times: ['07:00', '13:00', '19:00'] }),
      groupIds: parseList(val('#cfg-crazythursday-groups', ((c.crazyThursday || {}).groupIds || []).join(',')))
    };
  }

  if (sec === 'chat') {
    patch.hypeMode = {
      ...(c.hypeMode || {}),
      minMessages: Math.max(0, Number(val('#cfg-hypemin', c.hypeMode?.minMessages ?? 5)) || 0)
    };
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    // 0 是合法值（= 关闭连发合并），所以不能像上面那样用 `|| 默认值` 兜底
    patch.burstSettleMs = Math.max(0, Number(val('#cfg-burstsettle', c.burstSettleMs ?? 15000)) || 0);
    patch.burstMaxWaitMs = Math.max(0, Number(val('#cfg-burstmax', c.burstMaxWaitMs ?? 30000)) || 0);
    patch.burstAdaptive = {
      ...(c.burstAdaptive || {}),
      enabled: chk('#cfg-burst-adaptive', c.burstAdaptive?.enabled !== false)
    };
    // 连发合并的判定权放在 localJev.burstJudge 下（和别的 Jev 配置住一起），
    // 但开关摆在「运行节奏」这一屏 —— 用户找防抖只会来这里。
    // ⚠️ 只写这一个子键：updateConfig 是深合并，localJev 下其它字段（模型路径/角色表）不受影响；
    //    整块替换 localJev 会把它们清掉，这才是要防的。
    patch.localJev = {
      ...(patch.localJev || {}),
      burstJudge: {
        ...(c.localJev?.burstJudge || {}),
        enabled: chk('#cfg-burst-jev', c.localJev?.burstJudge?.enabled === true),
        minConfidence: Math.min(1, Math.max(0, Number(val('#cfg-burst-jev-conf', c.localJev?.burstJudge?.minConfidence ?? 0.8)) || 0)),
        minMargin: Math.min(6, Math.max(0, Number(val('#cfg-burst-jev-margin', c.localJev?.burstJudge?.minMargin ?? 1.0)) || 0))
      }
    };
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    // 主动开场 UI 已移除：保存聊天分区时不再读写 proactive，
    // 避免控件不存在时用 fallback 把已有配置改回默认值。
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0)),
      promptMaxStickers: clampInt(val('#cfg-sticker-max', c.sticker?.promptMaxStickers ?? 12), 2, 30, 12),
      rotatePeriodMin: clampInt(val('#cfg-sticker-rotate', c.sticker?.rotatePeriodMin ?? 60), 5, 1440, 60)
    };
    // 发网图（send_image）：只改这几个字段，allowPrivateImageHosts 等其它安全例外原样保留
    patch.security = {
      ...(c.security || {}),
      imageSend: {
        ...(c.security?.imageSend || {}),
        enabled: chk('#cfg-imagesend', c.security?.imageSend?.enabled !== false),
        requirePreview: chk('#cfg-imagepreview', c.security?.imageSend?.requirePreview !== false),
        skipPreviewForLockedHosts: chk('#cfg-imageskippreview', c.security?.imageSend?.skipPreviewForLockedHosts !== false),
        maxPerRun: clampInt(val('#cfg-imagemax', c.security?.imageSend?.maxPerRun ?? 2), 1, 10, 2),
        maxBytesMB: clampInt(val('#cfg-imagemaxmb', c.security?.imageSend?.maxBytesMB ?? 5), 1, 20, 5)
      }
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    // 群聊/私聊各读一套：控件 id 只有 -p 后缀之差，读法完全一致。
    const readTierBlock = (sfx, fallback) => {
      const fb = fallback || {};
      // 档位 = 滑条位置换算（唯一真相是滑条的实时 value）。
      // 后端 updateConfig 还会用 tier-slider.js 再权威换算一次，双保险。
      const sl = $('#ctx-tier-slider' + sfx);
      const pos = sl ? Number(sl.value) : (fb.contextSliderPos ?? 100);
      const { tier, randomPercent } = sliderToTierUI(pos);
      return {
        contextSliderPos: pos,
        contextTier: tier,
        randomPercent,
        atCount: clampInt(val('#cfg-atcount' + sfx, fb.atCount), 1, 500, 20),
        keywordCount: clampInt(val('#cfg-kwcount' + sfx, fb.keywordCount), 1, 500, 15),
        keywords: String($('#cfg-keywords' + sfx)?.value || '')
          .split('\n').map((x) => x.trim()).filter(Boolean),
        randomCount: clampInt(val('#cfg-randcount' + sfx, fb.randomCount), 1, 500, 8),
        allCount: clampInt(val('#cfg-allcount' + sfx, fb.allCount), 1, 500, 80),
        // 近 24h 本地摘要（随档位面板；群/私聊/单群各自一份）
        recent24hDigest: {
          enabled: chk(`#cfg-r24${sfx}`, !!fb.recent24hDigest?.enabled),
          hours: clampInt(val(`#cfg-r24h${sfx}`, fb.recent24hDigest?.hours ?? 24), 1, 168, 24),
          maxChars: clampInt(val(`#cfg-r24c${sfx}`, fb.recent24hDigest?.maxChars ?? 240), 80, 600, 240),
          maxItems: clampInt(val(`#cfg-r24n${sfx}`, fb.recent24hDigest?.maxItems ?? 8), 2, 16, 8)
        }
      };
    };
    const groupTier = readTierBlock('', c.store);
    patch.store = {
      ...(c.store || {}),
      ...groupTier,
      // 私聊是否独立用一套参数（不勾选 = 跟随群聊，老行为）
      privateOverride: chk('#cfg-private-override', !!c.store?.privateOverride),
      private: readTierBlock('-p', c.store?.private)
    };
    // 单个会话的覆盖参数：只保留勾选了「单独设置」的会话（未勾选的等于跟随群聊，
    // 不写进配置，否则以后改群聊默认值会被这些"僵尸覆盖"挡住）。
    const perChat = {};
    document.querySelectorAll('input[data-perchat]').forEach((box) => {
      if (!box.checked) return;
      const key = box.dataset.perchat;
      const prev = (c.store?.perChat || {})[key];
      perChat[key] = readTierBlock('-pc-' + chatKeySlug(key), prev || c.store);
    });
    // __replace__：perChat 是映射型字段，取消勾选要能真的删掉旧键。
    // 直接传 {} 是删不掉的（deepMerge 会递归合并），所以走 config.js 约定的整体替换。
    patch.store.perChat = { __replace__: perChat };
    // 清掉已废弃的两个字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      theme: getThemePref(),
      brightness: clampBrightness(val('#cfg-brightness', getBrightnessPref())),
      uiScale: clampUiScale(val('#cfg-uiscale', getUiScalePref())),
      mechFx: chk('#cfg-mech-fx', c.ui?.mechFx !== false),
      customThemeId: c.ui?.customThemeId || '',
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      hideApiNews: chk('#cfg-hide-apinews', c.ui?.hideApiNews === true),
      hideInstanceTabs: chk('#cfg-hide-instance-tabs', c.ui?.hideInstanceTabs === true),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000,
      // 配色区默认收起：没展开就保留已存值，避免保存时冲成空
      ...(document.querySelector('#custom-colors-field')?.style?.display !== 'none' ? {
        customBg: ($('#cfg-custom-bg')?.value) || '',
        customBg2: ($('#cfg-custom-bg2')?.value) || '',
        customAccent: ($('#cfg-custom-accent')?.value) || '',
        customText: ($('#cfg-custom-text')?.value) || '',
        customToolAccent: ($('#cfg-custom-tool-accent')?.value) || ''
      } : {}),
      // 顶部工具栏：从列表 DOM 读当前顺序与显隐（预览时已写进 state，这里以 DOM 为准）
      navOrder: $$('#tb-nav-list > li').map((li) => li.dataset.tbId),
      navHidden: $$('#tb-nav-list > li')
        .filter((li) => !li.querySelector('.tb-show')?.checked)
        .map((li) => li.dataset.tbId),
      topOrder: $$('#tb-top-list > li').map((li) => li.dataset.tbId),
      topHidden: $$('#tb-top-list > li')
        .filter((li) => !li.querySelector('.tb-show')?.checked)
        .map((li) => li.dataset.tbId)
    };
    // 兼容旧开关：列表里勾掉免费API 时同步 hideApiNews
    if (Array.isArray(patch.ui.navHidden) && patch.ui.navHidden.includes('apinews')) {
      patch.ui.hideApiNews = true;
    } else if (chk('#cfg-hide-apinews', false)) {
      patch.ui.hideApiNews = true;
      if (!patch.ui.navHidden.includes('apinews')) patch.ui.navHidden.push('apinews');
    }
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    // 只覆盖本区还存在的连接项；白名单/网页密码/自动卸载已迁到「QQ 连接」页，
    // 这里 spread 旧值，避免保存时把那边的数据冲掉。
    patch.snowluma = {
      ...(c.snowluma || {}),
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  if (sec === 'browse') {
    // 域名清洗：允许用户直接粘贴完整网址，保存时统一成纯主机名
    const rawDomains = String(val('#cfg-browsedomains', '') || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    patch.security = {
      ...(c.security || {}),
      allowPrivateFetchHosts: chk('#cfg-browseprivate', c.security?.allowPrivateFetchHosts === true),
      browseLock: {
        ...(c.security?.browseLock || {}),
        enabled: chk('#cfg-browselock', c.security?.browseLock?.enabled === true),
        domains: [...new Set(rawDomains.map(normalizeDomain).filter(Boolean))],
        includeSubdomains: chk('#cfg-browsedomainsub', c.security?.browseLock?.includeSubdomains !== false),
        searchUrl: val('#cfg-browsesearchurl', c.security?.browseLock?.searchUrl || '').trim()
      }
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  state.settingsDirty = false;   // 写盘成功 = 没有待落盘的改动了
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  // 勾了「隐藏免费API页签」后立即生效，不用刷新页面
  applyApiNewsVisibility(state.config);
  // 工具栏顺序/显隐同样立刻生效
  applyToolbarLayout(state.config);
  return data;
}

/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → http://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'http://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: esc(title),
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => el.remove());
}

// ── 意见收集 ──
const FB_DRAFT_KEY = 'qqa-feedback-draft';

/** 读草稿（昵称/正文/图片 dataURL 列表）。 */
function fbLoadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(FB_DRAFT_KEY) || '{}');
    return {
      nickname: String(d.nickname || ''),
      text: String(d.text || ''),
      images: Array.isArray(d.images) ? d.images.slice(0, 9) : []
    };
  } catch { return { nickname: '', text: '', images: [] }; }
}

/** 图片压缩：最大边 1200px、JPEG 0.75 —— 够看清，又不会把 localStorage 塞爆。 */
function fbCompressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const max = 1200;
      let { width: w, height: h } = img;
      if (w > max || h > max) {
        const r = Math.min(max / w, max / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('图片读取失败')); };
    img.src = URL.createObjectURL(file);
  });
}

function openFeedbackModal() {
  const draft = fbLoadDraft();
  const state2 = { images: draft.images.slice() };   // 弹窗内的图片列表（dataURL）

  const overlay = modelModalShell({
    head: '意见收集',
    body: `
      <div id="fb-form">
        <div class="hint" style="flex-shrink:0">
          昵称和意见会上传到作者的服务器（kondius.cn/qq-agent/comments 公开展示）。
          内容实时保存在本机，误点弹窗外面也不会丢。
        </div>
        <div class="field"><label>昵称</label>
          <input type="text" id="fb-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(draft.nickname)}" /></div>
        <div class="field"><label>意见 / 建议</label>
          <textarea id="fb-text" rows="6" maxlength="5000" placeholder="哪里好用、哪里难用、想要什么功能…">${esc(draft.text)}</textarea></div>
        <div class="field"><label>附图（最多 9 张，自动压缩）</label>
          <!-- 原生 <input type=file> 的"选择文件"按钮是系统样式，与 UI 割裂：
               隐藏本体，用统一的 .btn 风格 label 触发 -->
          <input type="file" id="fb-file" accept="image/*" multiple style="display:none" />
          <label for="fb-file" class="btn btn-small" id="fb-file-btn" style="cursor:pointer">＋ 添加图片（<span id="fb-img-count">${state2.images.length}</span>/9）</label>
          <div class="fb-imgs" id="fb-imgs"></div>
        </div>
        <div id="fb-hint" class="muted" style="font-size:12px"></div>
      </div>
      <div id="fb-confirm" style="display:none">
        <div class="hint">请确认上传内容：</div>
        <div id="fb-summary" style="white-space:pre-wrap;font-size:13px;max-height:300px;overflow-y:auto"></div>
        <div id="fb-confirm-hint" class="muted" style="font-size:12px;margin-top:8px"></div>
      </div>`,
    foot: `
      <button class="btn" id="fb-cancel">取消</button>
      <button class="btn btn-primary" id="fb-next">下一步</button>
      <button class="btn hidden" id="fb-back">返回修改</button>
      <button class="btn btn-primary hidden" id="fb-submit">确认上传</button>`
  });

  const $q = (sel) => overlay.querySelector(sel);
  const formEl = $q('#fb-form'), confirmEl = $q('#fb-confirm');
  const nextBtn = $q('#fb-next'), backBtn = $q('#fb-back'), submitBtn = $q('#fb-submit');

  // ── 草稿实时保存（300ms 防抖）──
  let saveTimer = null;
  const saveDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
          nickname: $q('#fb-nickname').value,
          text: $q('#fb-text').value,
          images: state2.images
        }));
      } catch { /* 图片太多塞不下时至少保住文字 */ 
        try {
          localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
            nickname: $q('#fb-nickname').value, text: $q('#fb-text').value, images: []
          }));
        } catch { /* 放弃 */ }
      }
    }, 300);
  };
  $q('#fb-nickname').addEventListener('input', saveDraft);
  $q('#fb-text').addEventListener('input', saveDraft);

  // ── 图片九宫格 ──
  function renderImgs() {
    const cnt = $q('#fb-img-count');
    if (cnt) cnt.textContent = state2.images.length;
    $q('#fb-imgs').innerHTML = state2.images.map((d, i) => `
      <div class="fb-img"><img src="${d}" alt="附图${i + 1}" />
        <button class="fb-img-del" data-i="${i}" title="移除">×</button></div>`).join('');
    $q('#fb-imgs').querySelectorAll('.fb-img-del').forEach((el) => {
      el.addEventListener('click', () => {
        state2.images.splice(Number(el.dataset.i), 1);
        renderImgs();
        saveDraft();
      });
    });
  }
  renderImgs();

  $q('#fb-file').addEventListener('change', async (e) => {
    const hint = $q('#fb-hint');
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of files) {
      if (state2.images.length >= 9) { hint.textContent = '最多 9 张，超出的已忽略'; break; }
      try {
        state2.images.push(await fbCompressImage(f));
      } catch (err) { hint.textContent = String(err.message || err); }
    }
    renderImgs();
    saveDraft();
  });

  // ── 步骤切换 ──
  $q('#fb-cancel').addEventListener('click', () => closeModelModal(overlay));
  nextBtn.addEventListener('click', () => {
    const nickname = $q('#fb-nickname').value.trim();
    const text = $q('#fb-text').value.trim();
    if (!nickname) { $q('#fb-hint').textContent = '先填个昵称'; return; }
    if (!text) { $q('#fb-hint').textContent = '意见还没写'; return; }
    saveDraft();
    $q('#fb-summary').textContent =
      `昵称：${nickname}\n\n${text}\n\n附图：${state2.images.length} 张`;
    formEl.style.display = 'none';
    confirmEl.style.display = '';
    nextBtn.classList.add('hidden');
    backBtn.classList.remove('hidden');
    submitBtn.classList.remove('hidden');
  });
  backBtn.addEventListener('click', () => {
    formEl.style.display = '';
    confirmEl.style.display = 'none';
    nextBtn.classList.remove('hidden');
    backBtn.classList.add('hidden');
    submitBtn.classList.add('hidden');
  });

  // ── 上传 ──
  submitBtn.addEventListener('click', async () => {
    const hint = $q('#fb-confirm-hint');
    hint.textContent = '上传中…';
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${COMMUNITY_API}/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nickname: $q('#fb-nickname').value.trim(),
          text: $q('#fb-text').value.trim(),
          images: state2.images
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      localStorage.removeItem(FB_DRAFT_KEY);   // 上传成功才清草稿
      closeModelModal(overlay);
      showUploadToast('意见已上传，感谢反馈！', 'http://kondius.cn/qq-agent/comments');
    } catch (err) {
      hint.textContent = `上传失败：${err.message}（内容已保存在本机，可稍后再试）`;
      submitBtn.disabled = false;
    }
  });
}

// ── 金句上传 ──
state.quoteMode = false;
state.quoteSelected = new Set();   // 当前存档会话里勾选的消息 id（m.id）

/** 进入/退出勾选模式时切换顶栏按钮形态。 */
function syncQuoteButtons() {
  const qb = $('#quote-btn'), qc = $('#quote-confirm-btn');
  if (!qb || !qc) return;
  if (state.quoteMode) {
    qb.textContent = '取消';
    qc.classList.remove('hidden');
  } else {
    qb.textContent = '金句上传';
    qc.classList.add('hidden');
  }
}

function enterQuoteMode() {
  state.quoteMode = true;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  switchTab('chats');
  if (state.currentChatKey) renderChatMessages();   // 重建出勾选框
}

function exitQuoteMode() {
  if (!state.quoteMode) return;
  state.quoteMode = false;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  if (state.tab === 'chats' && state.currentChatKey) updateChatMessagesBody(true);
}

/** 勾选模式下的确认：二次确认框 + 昵称。 */
function openQuoteConfirmModal() {
  const all = state.chatMessages || [];
  const picked = all.filter((m) => state.quoteSelected.has(m.id))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));   // 按时间正序，读起来才是对话
  if (!picked.length) { showNoticeModal('金句上传', '还没有勾选任何消息。先在存档列表里勾几段对话吧。'); return; }
  const botCount = picked.filter((m) => m.self).length;
  if (!botCount) {
    showNoticeModal('金句上传', '勾选的消息里必须包含至少一条机器人发送的消息 —— 金句墙收的是机器人的发言。');
    return;
  }

  const key = state.currentChatKey || '';
  const chatName = formatChatTitle(key, chatNameOf(key));
  const lastNickname = localStorage.getItem('qqa-quote-nickname') || '';

  const overlay = modelModalShell({
    head: '确认上传金句',
    body: `
      <div class="hint">将上传 ${picked.length} 条消息（含机器人 ${botCount} 条），
        来自「${esc(chatName)}」，公开展示在 kondius.cn/qq-agent/holyshits。</div>
      <div class="field"><label>昵称（收录人）</label>
        <input type="text" id="q-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(lastNickname)}" /></div>
      <div style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12.5px">
        ${picked.map((m) => `<div style="margin-bottom:8px">
          <span class="muted">${esc(m.self ? '🤖 ' : '')}${esc(m.senderName || '?')}：</span>${esc(String(m.text || '').slice(0, 200))}
        </div>`).join('')}
      </div>
      <div id="q-hint" class="muted" style="font-size:12px"></div>`,
    foot: `<button class="btn" id="q-cancel">取消</button>
           <button class="btn btn-primary" id="q-submit">确认上传</button>`
  });

  overlay.querySelector('#q-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#q-submit').addEventListener('click', async () => {
    const nickname = overlay.querySelector('#q-nickname').value.trim();
    const hint = overlay.querySelector('#q-hint');
    if (!nickname) { hint.textContent = '先填个昵称'; return; }
    overlay.querySelector('#q-submit').disabled = true;
    try {
      // ── 先取图：QQ 图床 URL 会过期（老消息全网 400），
      //    让本地后端走 OneBot get_image 从 NapCat 缓存里把原图读出来转 dataURL，
      //      随消息一起上传 —— 服务器不再依赖 URL 时效。
      const mediaItems = [];
      const mediaOwners = [];   // 记录每个 item 属于哪条消息，方便回填
      for (const m of picked) {
        for (const x of (Array.isArray(m.media) ? m.media : [])) {
          if (x && (x.url || x.file)) {
            mediaItems.push({ file: x.file || '', url: x.url || '' });
            mediaOwners.push(m);
          }
        }
      }
      const dataUrls = new Map();   // message -> [dataUrl,...]
      if (mediaItems.length) {
        hint.textContent = `正在从本地缓存取图（${mediaItems.length} 张）…`;
        try {
          const r = await api('/api/media-data', {
            method: 'POST', body: JSON.stringify({ items: mediaItems })
          });
          (r.results || []).forEach((res, i) => {
            if (res?.dataUrl) {
              const m = mediaOwners[i];
              if (!dataUrls.has(m)) dataUrls.set(m, []);
              dataUrls.get(m).push(res.dataUrl);
            }
          });
          hint.textContent = `取到 ${[...dataUrls.values()].flat().length}/${mediaItems.length} 张图，上传中…`;
        } catch { hint.textContent = '取图失败（按无图上传），上传中…'; }
      } else {
        hint.textContent = '上传中…';
      }
      const res = await fetch(`${COMMUNITY_API}/holyshits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nickname,
          // 不传 chatKey / chatName：金句墙只展示时间和收录人，群信息不出本机
          messages: picked.map((m) => {
            const dus = dataUrls.get(m) || [];
            let di = 0;
            return {
              ts: m.ts, senderName: m.senderName, text: m.text,
              self: !!m.self,
              media: (Array.isArray(m.media) ? m.media : [])
                .filter((x) => x && (x.url || x.file))
                .map((x) => ({
                  kind: 'image',
                  url: x.url || '',
                  file: x.file || '',
                  // 取到就带上（服务器直接落盘）；取不到服务器再尝试 URL 下载
                  ...(dus[di] ? { dataUrl: dus[di++] } : {})
                }))
            };
          })
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      localStorage.setItem('qqa-quote-nickname', nickname);
      closeModelModal(overlay);
      exitQuoteMode();
      showUploadToast('金句已收录！', 'http://kondius.cn/qq-agent/holyshits');
    } catch (err) {
      hint.textContent = `上传失败：${err.message}`;
      overlay.querySelector('#q-submit').disabled = false;
    }
  });
}

// 顶栏按钮绑定
// 小模型胶囊：点一下 = 拉起（没启用会顺带启用）；已经就绪时点一下 = 跳去本地 Jev 面板
$('#tb-chip-jev')?.addEventListener('click', () => { onJevChipClick(); });
$('#hot-reload-btn')?.addEventListener('click', async () => {
  const btn = $('#hot-reload-btn');
  if (!btn || btn.disabled) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重载中…';
  try {
    const r = await api('/api/hot-reload', {
      method: 'POST',
      body: JSON.stringify({ reconnectOneBot: true })
    });
    btn.textContent = r?.ok ? '已重载' : '失败';
    if (r?.ok) {
      // 工具白名单/模型变了，状态栏和设置都要刷
      try { await refreshStatus(); } catch { /* ignore */ }
      try { state.config = await api('/api/config'); } catch { /* ignore */ }
      if (state.tab === 'settings') renderSettings();
    }
  } catch (error) {
    btn.textContent = '失败';
    console.error('[hot-reload]', error);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prev || '热重载';
    }, 1600);
  }
});
$('#feedback-btn')?.addEventListener('click', () => openFeedbackModal());
$('#quote-btn')?.addEventListener('click', () => {
  if (state.quoteMode) exitQuoteMode(); else enterQuoteMode();
});
$('#quote-confirm-btn')?.addEventListener('click', () => openQuoteConfirmModal());

// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 窗口缩放：等比缩放期间暂停动画，避免布局乱跳 ──
let resizeTimer = null;
window.addEventListener('resize', () => {
  document.body.classList.add('resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.body.classList.remove('resizing'), 120);
});

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  // 注意：applyTheme 内部会处理自定义色是否注入，这里不要再无条件 loadCustomColors。
  applyTheme(getThemePref());
  // 先按本地偏好恢复界面缩放，避免启动瞬间「小一圈」再跳大
  applyUiScale(getUiScalePref());
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);
  document.querySelectorAll('#custom-theme-btn').forEach((el) => el.remove());

  // 自绘窗口控制（最小化 / 最大化 / 关闭）；关闭仍走托盘 closeToTray
  try {
    const qa = window.qqAgent;
    $('#win-min')?.addEventListener('click', () => { qa?.winMinimize?.(); });
    $('#win-max')?.addEventListener('click', () => { qa?.winMaximize?.(); });
    $('#win-close')?.addEventListener('click', () => { qa?.winClose?.(); });
  } catch { /* 非 Electron 预览环境 */ }

  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();

  // 主题：以后端配置为准（跨设备同步）。
  // 必须先挂上 state.config，applyTheme 才能读到已存的 custom* 颜色。
  try {
    const cfg0 = await api('/api/config');
    state.config = cfg0;
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) applyTheme(t);
    loadCustomColors(cfg0);
    themeBaseBg = null;
    applyBrightness(cfg0?.ui?.brightness ?? getBrightnessPref());
    applyUiScale(cfg0?.ui?.uiScale ?? getUiScalePref());
    applyApiNewsVisibility(cfg0);
    applyToolbarLayout(cfg0);
  } catch { /* 接口不可用就用本地的 */ }

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
})();

// UI navigation, filtering and per-section drafts.
function filterSessions(sessions) {
  const query = (state.sessionQuery || '').trim().toLocaleLowerCase();
  const f = state.sessionFilter || 'all';
  return sessions.filter(s => {
    if (query && ![s.chatKey, chatNameOf(s.chatKey), s.trigger, s.triggerSummary].join(' ').toLocaleLowerCase().includes(query)) return false;
    if (state.sessionChatFilter && s.chatKey !== state.sessionChatFilter) return false;
    if (!f || f === 'all') return true;
    if (f === 'noreply') return s.status === 'noreply';
    if (f === 'error') return s.status === 'error';
    // 「运行中」把还在排队的 waiting 也算进来
    if (f === 'running') return s.status === 'running' || s.status === 'waiting';
    return s.status === f;
  });
}
function renderSessionWelcome() {
  const connected = state.status?.onebot?.connected;
  const any = state.sessions.length > 0;
  const title = any ? '查看机器人的每一次回复' : connected ? '已就绪，等待新消息' : '连接 QQ，开始第一段对话';
  const hint = any ? '从左侧选择会话，查看触发内容、回复结果和运行详情。' : connected ? '白名单中的聊天触发机器人后，这里会自动出现运行记录。' : '先完成 QQ 连接与模型配置，运行记录会自动汇集到这里。';
  $('#session-detail').innerHTML = '<div class="welcome-state"><div class="welcome-eyebrow">QQ AGENT · 会话</div><h2>'+title+'</h2><p>'+hint+'</p><div class="welcome-stats">'+state.sessions.length+' 条会话 · '+(state.paused ? '已暂停' : connected ? 'QQ 已连接' : 'QQ 未连接')+'</div><button class="btn" id="welcome-action">'+(connected ? '查看设置' : '连接 QQ')+'</button></div>';
  $('#welcome-action')?.addEventListener('click', () => switchTab(connected ? 'settings' : 'snowluma'));
}
function updateNewContentButton() {
  const btn = $('#session-new-content');
  if (!btn) return;
  btn.classList.toggle('hidden', state.tab !== 'sessions' || !state.unreadContent);
  btn.textContent = '有 '+(state.unreadContent || 0)+' 条新内容 ↓';
}
$('#session-search')?.addEventListener('input', e => { state.sessionQuery=e.target.value; state.sessionLimit=SESSION_PAGE; renderSessionList(); });
$('#session-chat-filter')?.addEventListener('change', e => { state.sessionChatFilter=e.target.value; state.sessionLimit=SESSION_PAGE; renderSessionList(); });
$$('[data-session-filter]').forEach(btn => btn.addEventListener('click', () => {
  state.sessionFilter=btn.dataset.sessionFilter; state.sessionLimit=SESSION_PAGE;
  $$('[data-session-filter]').forEach(el => { el.classList.toggle('active', el === btn); el.setAttribute('aria-pressed', String(el === btn)); }); renderSessionList();
}));
$('#session-new-content')?.addEventListener('click', () => { const detail=$('#session-detail'); detail.scrollTop=detail.scrollHeight; state.unreadContent=0; updateNewContentButton(); });
$('#session-detail')?.addEventListener('scroll', () => { const d=$('#session-detail'); if(d.scrollHeight-d.scrollTop-d.clientHeight<48) { state.unreadContent=0; updateNewContentButton(); } });
document.addEventListener('click', e => { const menu=$('#more-menu'); if(menu && (!menu.contains(e.target) || e.target.closest('button'))) menu.open=false; });
document.addEventListener('keydown', e => { if(e.key==='Escape') { const menu=$('#more-menu'); if(menu) menu.open=false; } });
/* ── 设置项：改动即自动保存 ──
   原先是「改完再点保存」，2026-09-20 起去掉那一步。防抖 600ms：打字过程中不发请求，
   停下来才写一次；切换分区 / 关窗口之前会先 flush，最后一次输入不会丢。
   ⚠️ saveConfig() 是按「当前分区」读 DOM 的，所以 flush 必须知道发起时是哪个分区 ——
   换页后再 flush 会去读新分区的字段，旧分区的改动就悄悄没了。 */
const AUTOSAVE_DELAY = 600;
/** 只有这几项变了才值得重启 llama-server：自动保存会把整卡字段都写一遍，
 *  无脑 restart 等于每改一个字就把模型进程拉起来一次。 */
const JEV_RESTART_KEYS = ['enabled', 'modelPath', 'modelId', 'port', 'ctxSize', 'threads', 'extraArgs'];
let autosaveTimer = null;
let autosaveInFlight = null;

function autosaveHint(text, kind) {
  const el = $('#cfg-save-result');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-err', kind === 'err');
  el.classList.remove('saved-flash');
  if (kind === 'ok') { void el.offsetWidth; el.classList.add('saved-flash'); }
}

function scheduleSettingsSave() {
  state.settingsDirty = true;
  autosaveHint('正在保存…');
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { flushSettingsSave(); }, AUTOSAVE_DELAY);
}

/** 立刻落盘（切换分区、离开设置页之前调用）。 */
async function flushSettingsSave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (!state.settingsDirty) return;
  if (autosaveInFlight) { try { await autosaveInFlight; } catch { /* doSettingsSave 内已提示 */ } }
  if (!state.settingsDirty) return;   // 上一次在飞的请求已经把它写完了
  autosaveInFlight = doSettingsSave(state.settingsSection);
  try { await autosaveInFlight; } catch { /* 同上 */ } finally { autosaveInFlight = null; }
}

/** 真正写盘：读当前分区字段 → POST /api/config → 处理副作用。 */
async function doSettingsSave(section) {
  const jevBefore = section === 'jev' ? { ...(state.config?.localJev || {}) } : null;
  try {
    await saveConfig({ quiet: true });
  } catch (e) {
    autosaveHint(`保存失败：${e.message}`, 'err');
    throw e;
  }
  state.settingsDirty = false;
  autosaveHint(['api', 'onebot'].includes(section)
    ? '已保存 ✓ · 连接及模型变更可在「更多」里重载'
    : section === 'desktop' ? '已保存 ✓ · 窗口选项下次启动生效'
    : '已保存 ✓', 'ok');
  if (section === 'jev') {
    const after = state.config?.localJev || {};
    if (JEV_RESTART_KEYS.some((k) => JSON.stringify(jevBefore?.[k]) !== JSON.stringify(after[k]))) {
      try { await api('/api/local-jev', { method: 'POST', body: JSON.stringify({ action: 'restart' }) }); } catch { /* ignore */ }
    }
  }
  refreshStatus();
  startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
}

function markSettingsDirty(e) {
  if (!e.target?.matches('input, textarea, select')) return;
  scheduleSettingsSave();
}
$('#settings-form')?.addEventListener('input', markSettingsDirty);
$('#settings-form')?.addEventListener('change', markSettingsDirty);
window.addEventListener('beforeunload', e => {
  // 托盘「退出」会先把 __APP_QUITTING__ 置 true 再关窗；
  // 点账号标签页切号会先把 __APP_NAVIGATING__ 置 true 再 assign；
  // 这两种情况若还 preventDefault，Electron 会弹「离开此页面?」把导航/关窗卡住。
  if (window.__APP_QUITTING__ || window.__APP_NAVIGATING__) return;
  if (state.settingsDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
