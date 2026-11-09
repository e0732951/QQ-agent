    // ── [[command-gateway:status-fields]] 「指令前置」插件自动维护，不要手改这一段 ──
    // 对外公开的能力（给别的插件当 API 用）：审计据此区分"公开能力"与"孤儿能力"（README §7.1b）。
    // 0.3.1 的核心自带这一行、0.4.0 的核心没有 —— 用展开补上，避免对象字面量里出现重复键。
    ...(Array.isArray(m.exposes) ? { exposes: [...m.exposes] } : {}),
    // 指令插件声明（供「指令前置」的设置页与运行时目录使用）。
      // 普通插件没有这个字段时为 null，UI 据此判断"这个插件能不能作为指令接入"。
      // commands 是数组（一个插件可以声明多条指令）；command 是兼容字段 = 第一条。
      commands: Array.isArray(m.commands) ? m.commands : [],
      command: m.command || null,
      // 消息入口拦截声明：{ capability, order } —— 见 manifest.js 的 normalizeIntercept
      intercept: m.intercept || null,
      // 自带设置页声明（{ id, label, file }）：控制台据此在设置页侧栏多挂一个分区，
      // 分区内容由插件目录里的那个模块渲染。没有这个字段 = 这个插件没有自己的设置页。
      settingsUi: m.settingsUi || null,
      // ── [[/command-gateway:status-fields]] ──
