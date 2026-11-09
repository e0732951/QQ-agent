// ── [[command-gateway:plugin-storage]] 「指令前置」插件自动维护，不要手改这一段 ──
/**
 * 插件自己的数据目录（CRUD 用）：`<数据根>/command_data/<插件 id>/`。
 *
 * 为什么放在数据根下而不是仓库根目录：数据根会跟着 QQ_AGENT_DATA_DIR / 多实例 profile 走，
 * 测试隔离、备份、重置都能盖住它，打包时也被 `!data/**` 排除；放仓库根目录会三样都丢。
 *
 * 所有路径都锁死在这个子目录里（拒绝 `..`、绝对路径、盘符），
 * 插件只能动自己的那份，互相看不见。
 */
export function createPluginStorage(skillId) {
  const root = path.join(DATA_DIR, 'command_data', String(skillId).replace(/[^a-z0-9._-]/gi, '_'));
  const MAX_BYTES = 8 * 1024 * 1024;      // 单文件 8MB：够用，又不至于让插件把盘写满

  /** 把外部给的相对路径收进 root 里；越界直接抛错（不静默改写路径）。 */
  const resolve = (rel) => {
    const raw = String(rel ?? '');
    // 看起来是绝对路径的一律拒绝，不"好心"地当成相对路径 —— 免得插件作者以为写到了别处
    if (/^[/\\]/.test(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('storage：请用相对路径（不允许绝对路径或盘符）');
    const segs = raw.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
    if (!segs.length) throw new Error('storage：路径不能为空');
    if (segs.some((s) => s === '..' || /[\x00-\x1f]/.test(s))) throw new Error('storage：路径不允许包含 .. 或控制字符');
    const full = path.join(root, ...segs);
    const check = path.relative(root, full);
    if (check.startsWith('..') || path.isAbsolute(check)) throw new Error('storage：路径越界');
    return full;
  };
  const ensureDir = (full) => fs.mkdirSync(path.dirname(full), { recursive: true });

  return {
    /** 这个插件的数据目录（绝对路径）。想用别的库直接读写文件时用它。 */
    get dir() {
      fs.mkdirSync(root, { recursive: true });
      return root;
    },
    exists: (rel) => fs.existsSync(resolve(rel)),
    /** 读文本或 JSON；读不到返回 fallback（不抛错，插件日志里更干净）。 */
    read: (rel, fallback = null) => {
      try { return fs.readFileSync(resolve(rel), 'utf8'); } catch { return fallback; }
    },
    readJson: (rel, fallback = null) => {
      try { return JSON.parse(fs.readFileSync(resolve(rel), 'utf8')); } catch { return fallback; }
    },
    write: (rel, data) => {
      const text = typeof data === 'string' ? data : String(data ?? '');
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('storage：单文件超过 8MB 上限');
      const full = resolve(rel);
      ensureDir(full);
      // 原子写：同目录临时文件 + rename，半路失败不会留下半截文件
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, full);
      return full;
    },
    writeJson: (rel, value) => {
      const text = JSON.stringify(value, null, 2);
      const full = resolve(rel);
      ensureDir(full);
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, `${text}\n`, 'utf8');
      fs.renameSync(tmp, full);
      return full;
    },
    append: (rel, data) => {
      const full = resolve(rel);
      ensureDir(full);
      fs.appendFileSync(full, String(data ?? ''), 'utf8');
      return full;
    },
    /** 列目录：{ name, dir, size, mtime } */
    list: (rel = '') => {
      const full = rel ? resolve(rel) : root;
      let entries = [];
      try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return []; }
      return entries.map((e) => {
        const p = path.join(full, e.name);
        let size = 0;
        let mtime = 0;
        try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch { /* 竞态：列完就被删了 */ }
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      });
    },
    /** 删文件或目录（目录递归删，但只在插件自己的目录里）。 */
    remove: (rel) => {
      const full = resolve(rel);
      if (!fs.existsSync(full)) return false;
      fs.rmSync(full, { recursive: true, force: true });
      return true;
    }
  };
}
// ── [[/command-gateway:plugin-storage]] ──

