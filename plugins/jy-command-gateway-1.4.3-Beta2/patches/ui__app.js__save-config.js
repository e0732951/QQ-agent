
  // ── [[command-gateway:save-config]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件自带的设置页：核心不认识它的字段，所以"把界面读成补丁"这件事交给插件模块的
  // read(ctx)，核心只负责写进它自己的命名空间（服务端还会按清单再过滤一次键）。
  if (String(sec).startsWith('plugin:')) {
    const pluginPatch = (typeof pluginSection?.module?.read === 'function')
      ? pluginSection.module.read(pluginSection.ctx)
      : null;
    if (!pluginPatch || typeof pluginPatch !== 'object') return { config: state.config };
    if (!Object.keys(pluginPatch).length) return { config: state.config };
    const r = await api(`/api/skills/${encodeURIComponent(pluginSection.pluginId)}`, {
      method: 'POST',
      body: JSON.stringify({ settings: pluginPatch })
    });
    if (r?.config) state.config = r.config;
    if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
    return r;
  }
  // ── [[/command-gateway:save-config]] ──

