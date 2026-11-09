    // ── [[command-gateway:loader-api]] 「指令前置」插件自动维护，不要手改这一段 ──
    // 这个插件自己的 id：插件不该把 id 硬编码在代码里（清单里改一次、代码就跟不上），
    // 所以由加载器直接告诉它。
    id: skillId,
    // 插件自己的数据目录（CRUD）：只在自己那一份里读写，见 createPluginStorage
    storage: createPluginStorage(skillId),
    // ── [[/command-gateway:loader-api]] ──
