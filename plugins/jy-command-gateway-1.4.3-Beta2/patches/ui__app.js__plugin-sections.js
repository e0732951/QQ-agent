
// ── [[command-gateway:plugin-sections]] 「指令前置」插件自动维护，不要手改这一段 ──
/* ══════════════════════════════════════════════════════════════════════
   插件自带的设置页分区

   插件在清单里声明 settingsUi（{ id, label, file }）之后，设置页会多一个入口，
   分区键是 plugin:<插件id>:<分区id>。内容不是核心代码，而是插件目录里的一个
   ES 模块，用 /plugin-assets/ 这个只读路由取回来。

   模块契约（三个可选导出，见 plugins/command-gateway/README.md）：
     render(ctx) -> string         返回这块分区的 HTML
     bind(root, ctx) -> cleanup?   绑定事件；可返回一个卸载函数
     read(ctx) -> object|null      把界面上的输入读成"要保存的补丁"（核心的自动保存会调它）

   ctx 提供：esc / api / skills() / config() / pluginConfig() / save() / setEnabled() /
            reload() / rerender() / modal / closeModal / noticeModal / entrySeq。
   保存走插件自己的命名空间（服务端还会按清单声明再过滤一次键），
   插件界面从原理上写不到别人的设置。
   ══════════════════════════════════════════════════════════════════════ */

/** 当前挂载中的插件设置页。unmount 时给模块机会清掉它挂的全局监听。 */
let pluginSection = null;
/** 最近一次挂载的完成信号：插件调 ctx.reload() 后要等它，才能读写到新 DOM。 */
let pluginSectionMount = Promise.resolve();

/** 当前可用的插件设置页分区（清单里声明了 settingsUi，且插件已启用、加载成功）。 */
function pluginSections() {
  return (state.skills || [])
    // 只看"装了、能加载"：插件被关掉之后它的设置页仍然要能打开 ——
    // 否则用户在里面关掉开关，页面自己就先消失了，连再打开的地方都没有。
    .filter((s) => s?.settingsUi && s.loaded !== false)
    .map((s) => ({
      key: `plugin:${s.id}:${s.settingsUi.id}`,
      label: s.settingsUi.label || s.name || s.id,
      pluginId: s.id,
      sectionId: s.settingsUi.id,
      file: s.settingsUi.file
    }));
}

/**
 * ⚠️ 为什么需要这个（2026-09-23 真事故）：
 * 0.4 的界面有四处会给 `state.skills` 赋值（进设置页、拉记忆设置、工具页…），
 * 而**京玉版的设置页根本不拉 /api/skills** —— 于是 `state.skills` 一直是空的，
 * 插件分区列表永远为空、侧栏里也就永远看不到「指令前置」的配置页。
 * 这里自己补一次：拉回来 → 存进 state.skills → 重画侧栏与当前分区。
 * 30 秒内只试一次（避免每次重画设置页都发请求）；拿到数据后永久短路。
 */
let pluginSkillsLastTry = 0;
let pluginSkillsLoading = false;
function pluginSkillsReady() {
  return (state.skills || []).some((s) => s?.settingsUi);
}
async function ensurePluginSkills({ rerender = false } = {}) {
  if (pluginSkillsReady() || pluginSkillsLoading) return;
  if (Date.now() - pluginSkillsLastTry < 30000) return;
  pluginSkillsLastTry = Date.now();
  pluginSkillsLoading = true;
  try {
    const r = await api('/api/skills').catch(() => null);
    if (r?.skills) state.skills = r.skills;
    if (pluginSkillsReady() && rerender) {
      renderSettingsSidebar();   // 把「插件」分组补进侧栏
      renderSettings();          // 当前分区（比如正停在插件页）
    }
  } catch { /* 拉不到就算了：设置页其余部分照常用 */ }
  finally { pluginSkillsLoading = false; }
}

/** 卸载当前插件设置页（切分区/重绘前调用）。 */
function unmountPluginSection() {
  if (!pluginSection) return;
  try { pluginSection.cleanup?.(); } catch (error) { console.error('插件设置页卸载失败:', error); }
  pluginSection = null;
}

/** 组装给插件模块的上下文。 */
function makePluginSectionCtx(info) {
  const pluginId = info.pluginId;
  return {
    pluginId,
    sectionId: info.sectionId,
    entrySeq: state.settingsEntrySeq || 0,
    esc,
    api,
    skills: () => state.skills || [],
    config: () => state.config,
    pluginConfig: () => ((state.config?.skills || {})[pluginId] || {}),
    /** 只写这个插件自己的配置段。 */
    save: async (patch) => {
      const r = await api(`/api/skills/${encodeURIComponent(pluginId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings: patch || {} })
      });
      if (r?.config) state.config = r.config;
      return r;
    },
    /** 开关这个插件（要跑生命周期回调，不能只写配置）。 */
    setEnabled: async (enabled) => {
      const r = await api(`/api/skills/${encodeURIComponent(pluginId)}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !!enabled })
      });
      if (r?.config) state.config = r.config;
      if (r?.skill) {
        const idx = (state.skills || []).findIndex((s) => s.id === pluginId);
        if (idx >= 0) state.skills[idx] = r.skill;
      } else {
        await loadSkillsStatus();
      }
      return r;
    },
    /** 重新拉配置与插件状态，重绘本分区，并等新内容挂好。 */
    reload: async () => {
      const [cfg, skills] = await Promise.all([
        api('/api/config'),
        api('/api/skills').catch(() => null)
      ]);
      state.config = cfg;
      if (skills?.skills) state.skills = skills.skills;
      renderSettings();
      await pluginSectionMount;
    },
    /** 配置已经在内存里改过时用：只重绘本分区。 */
    rerender: async () => {
      renderSettings();
      await pluginSectionMount;
    },
    modal: modelModalShell,
    closeModal: closeModelModal,
    noticeModal: showNoticeModal
  };
}

/** 挂载当前分区对应的插件设置页；不是插件分区就只做卸载。 */
async function mountPluginSection() {
  const sec = String(state.settingsSection || '');
  const list = pluginSections();
  // 2026-09-24 核心自带原生入口，分区键是 `plugin:<插件id>`（没有 `:<分区id>` 后缀）：
  // 设置页侧栏的「插件设置」分组，以及扩展详情里那颗「打开设置」按钮
  // （ui/app.js 里 `state.settingsSection = `plugin:${full.id}`;`）。
  // 核心自己那份 mountPluginSection 用的是精简 ctx（没有 esc / pluginConfig / entrySeq…），
  // 插件模块在它下面跑不起来；而本函数同名且声明在后，在 classic script 里会覆盖核心那份
  // （ui/app.js 是 <script src>，不是 module，重复函数声明合法、后者生效）。
  // 所以这里把两种键都认到同一个插件的第一块分区上：从哪个入口进来都用完整 ctx 挂载。
  const info = list.find((p) => p.key === sec)
    || (/^plugin:[^:]+$/.test(sec)
      ? list.find((p) => p.pluginId === sec.slice('plugin:'.length))
      : null);
  if (!info) { unmountPluginSection(); return; }
  unmountPluginSection();
  const root = $('#plugin-section-root');
  if (!root) return;
  const token = { key: sec };
  pluginSection = { key: sec, pluginId: info.pluginId, module: null, ctx: null, cleanup: null, token };
  try {
    const mod = await import(`/plugin-assets/${encodeURIComponent(info.pluginId)}/${info.file}`);
    if (pluginSection?.token !== token) return;    // 加载过程中用户切走了
    const ctx = makePluginSectionCtx(info);
    const html = typeof mod.render === 'function' ? await mod.render(ctx) : '';
    if (pluginSection?.token !== token) return;
    root.innerHTML = String(html ?? '');
    pluginSection.module = mod;
    pluginSection.ctx = ctx;
    const cleanup = typeof mod.bind === 'function' ? await mod.bind(root, ctx) : null;
    if (pluginSection?.token !== token) {
      try { cleanup?.(); } catch { /* 已经切走，卸载失败无所谓 */ }
      return;
    }
    pluginSection.cleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (error) {
    console.error(`插件设置页加载失败（${info.pluginId}）:`, error);
    if (pluginSection?.token === token) {
      // 单个插件设置页坏掉不能拖垮整个设置页：只在这块里显示原因
      root.innerHTML = `<div class="hint" style="color:var(--orange)">插件设置页加载失败：${esc(error?.message ?? error)}</div>`;
    }
  }
}

// ── [[/command-gateway:plugin-sections]] ──
