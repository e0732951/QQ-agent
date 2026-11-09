  // ── [[command-gateway:render-section]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件自带的设置页（清单里的 settingsUi）不在这里列：它们由 mountPluginSection() 填充，
  // 因为内容来自插件目录里的模块，而不是核心代码。
  if (pluginSections().some((p) => p.key === sec)) {
    return '<div id="plugin-section-root"><div class="hint">正在加载插件设置页…</div></div>';
  }
  // ── [[/command-gateway:render-section]] ──
