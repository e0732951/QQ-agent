  // ── [[command-gateway:render-settings]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件设置页的内容是异步加载的（动态 import 插件目录里的模块），
  // 所以同步把壳放好之后在这里启动挂载；不是插件分区时它会顺手卸载上一个。
  pluginSectionMount = mountPluginSection();
  // 京玉版的设置页不拉 /api/skills（0.4 会），插件分区列表会是空的 ——
  // 这里补一次数据；拿到之后它会自己把侧栏的「插件」分组与当前分区重画出来。
  ensurePluginSkills({ rerender: true });
  // ── [[/command-gateway:render-settings]] ──
