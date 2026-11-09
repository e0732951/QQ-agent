      // ── [[command-gateway:sidebar-click]] 「指令前置」插件自动维护，不要手改这一段 ──
      // 每次进入都算"新的一次打开"：插件设置页据此决定要不要自动重拉数据
      // （比如「指令前置」的调用记录是插件运行时写回配置的，旧快照看不到）。
      state.settingsEntrySeq = (state.settingsEntrySeq || 0) + 1;
      // ── [[/command-gateway:sidebar-click]] ──
