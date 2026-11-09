      // ── [[command-gateway:manifest-fields]] 「指令前置」插件自动维护，不要手改这一段 ──
      commands,
      // 兼容旧写法：只认第一条（新代码请用 commands）
      command: commands[0] || null,
      // ⚠️ 2026-09-24 核心更新：`intercept` 与 `settingsUi` 已由核心在下面自己归一化
      // （见 normalizeManifest 的 settingsUi / intercept 两行）。这里再写一遍会在
      // 同一个对象字面量里出现重复键，且本块插得更靠前 → 反而被核心的覆盖掉，纯属噪音，故删。
      // 对外公开的能力（给别的插件当 API 用）：0.3.1 的核心自带这一行，0.4.0 的核心没有，
      // 用展开补上 —— 审计据此区分"公开能力"与孤儿能力（见 README §7.1b）。
      ...(Array.isArray(raw.exposes)
        ? { exposes: asArray(raw.exposes).map((x) => String(x).trim()).filter((x) => x && capabilities.includes(x)) }
        : {}),
      // ── [[/command-gateway:manifest-fields]] ──
