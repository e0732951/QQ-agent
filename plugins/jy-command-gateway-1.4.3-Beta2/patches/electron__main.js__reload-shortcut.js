  // ── [[command-gateway:reload-shortcut]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 菜单被去掉了，Ctrl+R / F5 默认不会重载页面 —— 换掉 ui/ 下的文件后，
  // 用户在软件里就没法让界面吃到新版（只能关掉软件重开）。这里补上快捷键。
  // 前端资源是 no-cache，所以重载一定能拿到最新的 app.js / style.css。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const reloadKey = key === 'f5' || (input.control && key === 'r') || (input.meta && key === 'r');
    if (!reloadKey) return;
    event.preventDefault();
    mainWindow?.webContents.reload();
  });
  // ── [[/command-gateway:reload-shortcut]] ──
