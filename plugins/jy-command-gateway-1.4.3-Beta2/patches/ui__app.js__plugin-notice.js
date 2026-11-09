  // ── [[command-gateway:plugin-notice]] 「指令前置」插件自动维护，不要手改这一段 ──
  // 插件用 ui.notify 能力推来的通知（浮在右下角，8 秒后自己消失）。
  es.addEventListener('plugin-notice', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data) || {}; } catch { d = {}; }
    const text = String(d.text || '').trim();
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'upload-toast plugin-toast';
    el.innerHTML = `
      <div class="ut-head">
        <span class="ut-title">${esc(d.pluginId ? `${d.pluginId} · 通知` : '插件通知')}</span>
        <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="ut-link" style="cursor:default">${esc(text)}</div>`;
    document.body.appendChild(el);
    el.querySelector('.ut-close')?.addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), 8000);
  });
  // ── [[/command-gateway:plugin-notice]] ──
