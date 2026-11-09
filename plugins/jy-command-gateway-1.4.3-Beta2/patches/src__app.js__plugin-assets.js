

    // ── [[command-gateway:plugin-assets]] 「指令前置」插件自动维护，不要手改这一段 ──
    // 插件自带的静态资源：/plugin-assets/<插件id>/<文件>
    //
    // 用途：插件把自己的设置页模块（settings-ui.js）放在插件目录里，由控制台动态加载。
    // 安全约束与下面 UI 目录同一套，只是根目录换成「那个插件自己的目录」：
    //   1. 插件 id 必须对应一个**已注册**的插件（不存在的 id 直接 404，不猜路径）；
    //   2. 文件路径逐段校验，拒绝 ..、控制字符，拼好后再用 path.relative 二次确认没跳出目录；
    //   3. no-cache：插件文件是开发期会频繁改的东西，不能吃浏览器缓存。
    if (req.method === 'GET' && pathname.startsWith('/plugin-assets/')) {
      const rest = pathname.slice('/plugin-assets/'.length);
      const cut = rest.indexOf('/');
      let id = '';
      let file = '';
      try {
        id = decodeURIComponent(cut >= 0 ? rest.slice(0, cut) : '');
        file = decodeURIComponent(cut >= 0 ? rest.slice(cut + 1) : '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      const entry = id ? skillManager.registry.get(id) : null;
      const dir = entry?.dir ? path.resolve(ROOT, entry.dir) : '';
      const segs = file.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
      const bad = !entry || !dir || !segs.length
        || segs.some((s) => s === '..' || /[\x00-\x1f]/.test(s));
      const fullPath = bad ? '' : path.join(dir, ...segs);
      const relCheck = fullPath ? path.relative(dir, fullPath) : '..';
      if (bad || relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const assetTypes = {
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png'
        };
        res.writeHead(200, {
          'content-type': assetTypes[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache'
        });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    // ── [[/command-gateway:plugin-assets]] ──

