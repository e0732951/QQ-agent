
    // ── [[command-gateway:dispatch]] 「指令前置」插件自动维护，不要手改这一段 ──
    // ── 指令前置：在存档与会话创建之前，给「指令前置」插件一次认领机会 ──
    // 约定（见 plugins/command-gateway/README.md）：
    //   · dispatch 必须**同步**返回 { handled }；认领后要做的异步工作放进 run()，
    //     这样消息热路径不等待网络/模型调用；
    //   · handled = true → 不存档、不触发会话，彻底不诞生这条会话；
    //   · run() 还可以再返回 { passthrough } 表达「指令执行完后放行」：
    //       true         → 按消息原文放行（存档 + 触发会话，和没认领过一样）；
    //       非空字符串   → 用这段文本替代原文放行（修改后再进会话）；
    //       false / 缺省 → 不放行，消息到此为止。
    //     放行走的是下面的 releaseClaimed()：**不重新过拦截链**（防止链上插件
    //     二次认领造成循环），原消息的媒体段原样保留。
    //   · 未认领、插件没装、插件抛错 → 一律原样放行，行为与没装插件完全一致。
    //
    // ⚠️ 块与核心之间是**软引用**（术语见项目 CONTEXT.md 的「会话前缝」）：
    //    核心句柄一律从 pluginHost 里取，取不到就是 undefined，调用处一律 ?.（有就调用、
    //    没有就跳过）。这样"上游删掉了某个函数"的表现是"少一项功能"，而不是"整块每次
    //    执行都抛 ReferenceError、被自己的 catch 吞掉，用户只看到指令毫无反应"。
    //    真正缺了干不了活的符号（store / orchestrator / emit / log / skillManager）写在
    //    补丁表的 needs 里，打补丁之前就会被拦下来并说清缺了谁。
    let pluginHost = null;
    /**
     * 拼核心句柄。`typeof` 对**不存在的名字**也是安全的（不会抛 ReferenceError），
     * 所以同一份块既能在京玉版上跑（没有 reminders / 指令禁言 / 链接转发），
     * 也能在老核心（0.4）上跑（有这些）。
     * 只在真的要分发时拼一次 —— 插件没装/没启用时，热路径上只多一次能力查询。
     */
    const makePluginHost = () => ({
      // 必需项：直接引用。缺了宁可炸得看得见（而且 needs 会在安装前就拦住）
      store,
      orchestrator,
      emit,
      log,
      // 可选项：有就给，没有就是 undefined
      sessions: typeof sessions === 'undefined' ? undefined : sessions,
      stickers: typeof stickers === 'undefined' ? undefined : stickers,
      sender: typeof sender === 'undefined' ? undefined : sender,
      onebot: typeof onebot === 'undefined' ? undefined : onebot,
      memory: typeof memory === 'undefined' ? undefined : memory,
      dataDir: typeof DATA_DIR === 'undefined' ? undefined : DATA_DIR,
      getConfig: typeof getConfig === 'undefined' ? undefined : getConfig,
      updateConfig: typeof updateConfig === 'undefined' ? undefined : updateConfig,
      // 服务能力（ai.ask / search.web / search.images / persona.apply）要用的口子：
      //   ai.ask        → host.chat(messages, opts)
      //   search.web    → host.search(query)
      //   search.images → host.images(query, { limit })       ← 2026-09-23 加：百度/Bing 图搜
      //   persona.apply → host.personas() + host.updateConfig(...)
      // ⚠️ 2026-09-23 修：软引用改造那一版把这三个漏掉了，于是上面三条服务能力全挂
      //    （朋友实测反馈；原版 1.4.3 的 host 里是有的）。
      //    它们只在**被调用那一刻**才 import 核心模块，所以不影响消息热路径。
      chat: (messages, options = {}) => import('./llm.js').then((m) => m.chatCompletionWithRetry({
        messages,
        temperature: options.temperature ?? null,
        maxTokens: Number(options.maxTokens) || 0
      })),
      search: (query) => import('./web-search.js').then((m) => m.webSearch(query)),
      // 搜图：给「search.images」服务能力用。返回 { images, provider, cleanedQuery }，
      // images[].url 是能直接交给 ctx.sender 发出去的图片直链。
      // 与 host.search 同源（都在 web-search.js），所以图源/过滤规则与核心的 search_images 工具完全一致。
      // excludeUrls：本轮已发过的图剔掉，避免反复同一张。
      images: (query, options = {}) => import('./web-search.js').then((m) => m.searchImages(query, options)),
      personas: () => import('./personas.js').then((m) => m.PERSONAS),
      // 老核心（0.4）有这两个函数；京玉版已经把「指令禁言」和「链接媒体转发」删掉了，
      // 这里自然为 undefined —— 调用处是 ?.，所以是"跳过"，不是"报错"。
      maybeTriggerCommandMute: typeof maybeTriggerCommandMute === 'undefined' ? undefined : maybeTriggerCommandMute,
      forwardLinkedMedia: typeof forwardLinkedMedia === 'undefined' ? undefined : forwardLinkedMedia
    });
    try {
      const dispatch = skillManager.getCapabilityProviders('command.dispatch')[0]?.fn;
      if (dispatch) {
        pluginHost = makePluginHost();
        const chatKey = `${kind}:${id}`;
        // 指令目录：只取「声明了 command 的插件」的清单元信息，不做可用性计算
        //（用 registry.list() 而不是 skillManager.list()，避免每条消息都跑一遍
        //  isActive 依赖链）。插件自己会用 api.hasCapability 判断能力是否可用。
        const catalog = skillManager.registry.list()
          .map((s) => ({
            id: s?.manifest?.id,
            name: s?.manifest?.name,
            commands: Array.isArray(s?.manifest?.commands) ? s.manifest.commands : [],
            // 消息入口拦截声明：{ capability, order }（见 manifest.js 的 normalizeIntercept）
            intercept: s?.manifest?.intercept || null
          }))
          .filter((s) => s.id && (s.commands.length || s.intercept));
        const decision = dispatch({
          text,
          segments,
          rawMessage: String(event.raw_message ?? (typeof event.message === 'string' ? event.message : '') ?? ''),
          messageId: event.message_id != null ? String(event.message_id) : '',
          kind,
          chatId: String(id),
          chatKey,
          senderId,
          senderName,
          catalog,
          ctx: {
            kind, chatId: String(id), chatKey,
            // 核心句柄：给「指令前置」把它包装成对外服务能力（ai.ask / search.web / history.read…）。
            // 插件不该自己 import src/，所以由核心在这一处把实例交出去。
            // chat 单独再给一份：链上的拦截者（比如隐私模式）要"用核心的模型链路问一次 AI"。
            onebot: pluginHost.onebot,
            sender: pluginHost.sender,
            store: pluginHost.store,
            memory: pluginHost.memory,
            log: pluginHost.log,
            emit: pluginHost.emit,
            host: pluginHost,
            chat: (messages, options = {}) => import('./llm.js').then((m) => m.chatCompletionWithRetry({
              messages,
              temperature: options.temperature ?? null,
              maxTokens: Number(options.maxTokens) || 0
            }))
          }
        });
        if (decision && decision.handled === true) {
          if (typeof decision.run === 'function') {
            Promise.resolve()
              .then(() => decision.run())
              .then((r) => releaseClaimed(kind, id, text, media, event, senderId, senderName, r))
              .catch((error) => pluginHost.log(`[指令前置] 执行失败：${error?.message ?? error}`));
          }
          return;
        }
      }
    } catch (error) {
      // 这条路径上"上游把符号删了"会让**每条消息**都进来一次 —— 只报第一次，
      // 之后静默按普通消息放行，别用同一行把日志淹掉（事故里的表现就是这样）。
      const once = (globalThis.__cgDispatchErrorLogged ||= { at: 0 });
      if (!once.at) {
        once.at = Date.now();
        log(`[指令前置] 分发失败，已按普通消息放行：${error?.message ?? error}`);
      }
    }

    /**
     * 「执行完后放行」：把已认领的消息按插件的要求放回正常聊天流程。
     * 独立成函数声明，是为了让上面那条 Promise 链在 try 块结束之后仍能调到它。
     * 顺序说明：指令的回复此刻多半已经发出并入档（appendSelf），这里补存的是
     * 用户那条原始消息 —— 存档时间用消息本来的时间，不用现在，避免历史错序。
     */
    function releaseClaimed(kind, id, text, media, event, senderId, senderName, result) {
      const pass = result ? result.passthrough : undefined;
      if (pass === undefined || pass === null || pass === false) return;
      let body;
      if (pass === true) {
        body = String(text ?? '');
      } else {
        body = String(pass).trim();
        if (!body) {
          log('[指令前置] 放行文本为空，已忽略本次放行');
          return;
        }
      }
      if (!pluginHost) pluginHost = makePluginHost();
      const chatKey = `${kind}:${id}`;
      // 指令禁言（0.4 的核心有；京玉版没有 → 跳过）
      if (kind === 'group') pluginHost.maybeTriggerCommandMute?.(id, body, event);
      pluginHost.store.appendIncoming(chatKey, {
        mid: event?.message_id,
        ts: event?.time ? Math.round(Number(event.time) * 1000) : Date.now(),
        senderId,
        senderName,
        text: body || '[图片]',
        media
      });
      pluginHost.emit('chat-update', chatKey);
      pluginHost.orchestrator.onIncoming(chatKey);
      // 链接媒体转发（0.4 的核心有；京玉版没有 → 跳过）
      pluginHost.forwardLinkedMedia?.(kind, id, body)?.catch?.(
        (e) => pluginHost.log(`[media] 链接转发失败：${e?.message ?? e}`)
      );
    }
    // ── [[/command-gateway:dispatch]] ──
