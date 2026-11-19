// =============================================================================
//  browser.mjs —— 常驻 Edge 会话（CDP），本项目唯一的「能过 Cloudflare 的 API 通道」
//
//  为什么必须有它（实测结论，别再试纯 HTTP 客户端）：
//    api.iwara.tv 全站挂在 Cloudflare 后面，.NET/Node 直接请求一律 403 + "Just a moment..."；
//    --headless=new 也过不去（停在"请稍候…"）；只有有头浏览器 + 持久 profile 能拿到 clearance。
//
//  用法：
//    const b = await Browser.start({ profileDir })
//    const r = await b.api('GET', '/video/xxxx')            // 自动带 X-Version / Authorization
//    await b.login('mail@x.com', 'pw')                      // 页面内 fetch，失败回退到表单自动化
//    await b.stop()
//
//  零 npm 依赖：Node 24 自带全局 WebSocket，直接说 CDP。
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XSECRET = 'mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  return CANDIDATES.find((c) => fs.existsSync(c)) || '';
}

/** X-Version 与 iwara 前端一致：SHA1("{路径末段}_{expires}_{密钥}")；无 expires 时该位为空串 */
async function xVersion(urlString) {
  const u = new URL(urlString);
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  const expires = u.searchParams.get('expires') ?? '';
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${last}_${expires}_${XSECRET}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function say_login_fail(r) {
  console.log('[login] 直连失败 HTTP ' + r.status + ' body=' + String(r.text || '').slice(0, 200));
}

export class Browser {
  static async start(opts = {}) {
    const exe = opts.exe || findBrowser();
    if (!exe) throw new Error('没找到 Edge/Chrome，装一个再来');
    const profile = opts.profileDir || path.join(ROOT, 'state', 'edgeprofile');
    const port = opts.port || 9333;
    fs.mkdirSync(profile, { recursive: true });

    // 已有实例在跑就直接接管（端口被占说明上次没退干净或面板正在用）
    let reused = false;
    const child = await (async () => {
      if (await Browser.ping(port)) { reused = true; return null; }
      const c = spawn(exe, [
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        '--window-position=-32000,-32000', '--window-size=1280,900',
        // 后台页面不降频/不因隐藏而挂起：窗口会被 SW_HIDE 完全藏起来
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        // 站点通知会点亮/闪烁任务栏图标，自动化用不到
        '--disable-notifications',
        'about:blank',
      ], { detached: true, stdio: 'ignore' });
      c.unref();
      for (let i = 0; i < 60; i++) { await sleep(500); if (await Browser.ping(port)) return c; }
      throw new Error('Edge 起来了但 CDP 端口没就绪');
    })();

    const b = new Browser();
    b.exe = exe; b.port = port; b.child = child; b.reused = reused;
    await b._connect(opts.startUrl || 'https://www.iwara.tv/');
    // 刚建就藏：任务栏按钮一出来就清掉（hide 是异步不阻塞）
    try { await b.hideTaskbar(); } catch { /* 已经藏了或窗口类不对也算 OK */ }
    return b;
  }

  static async ping(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch { return false; }
  }

  /** 按 CDP 端口反查我们那个常驻浏览器的主进程，连进程树一起杀掉，逼下次 start() 起一个干净的。
   *  为什么需要：reused=true 时本会话没有 child 句柄（进程不是我们 spawn 的），软重连只是换个 WS
   *  重新贴到同一个「网络栈已死但端口还能 ping 通」的病态实例上，永远恢复不了。
   *  taskkill /T /F 只杀这个 --user-data-dir 实例的进程树，不碰用户自己开的其它 Edge 窗口。
   *  ⚠ 用异步 spawn，绝不用 spawnSync：同步调用会卡住整个 Node 事件循环 → 面板/SSE 假死。 */
  static killInstance(port) {
    return new Promise((resolve) => {
      let out = ''; let done = false; let killer = null;
      const finish = (v) => { if (done) return; done = true; if (killer) clearTimeout(killer); resolve(v); };
      let p;
      try { p = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }); }
      catch { return finish(0); }
      killer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } finish(0); }, 8000);
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => finish(0));
      p.on('close', () => {
        if (done) return;
        const m = out.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
        const pid = m ? Number(m[1]) : 0;
        if (pid <= 0) return finish(0);
        try {
          const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          k.on('error', () => finish(pid));
          k.on('close', () => finish(pid));
        } catch { finish(pid); }
      });
    });
  }

  async _connect(startUrl) {
    // 先摘掉旧 WS 的处理器再关：否则旧连接的迟到消息会和新一轮的 id 撞车
    if (this.ws) {
      try { this.ws.onmessage = null; this.ws.onerror = null; this.ws.close(); } catch { /* 忽略 */ }
      this.ws = null;
    }
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    let page = list.find((t) => t.type === 'page' && /iwara\.tv/.test(t.url || '')) || list.find((t) => t.type === 'page');
    if (!page) {
      page = await (await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(startUrl)}`, { method: 'PUT', signal: AbortSignal.timeout(8000) })).json();
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this._pending = new Map();
    this._id = 0;
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); res(); };
      this.ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')); };
    });
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this._pending?.has(m.id)) {
        const p = this._pending.get(m.id); this._pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        return;
      }
      // 页面弹 alert/confirm 会让隐藏窗口“请求注意”，任务栏图标一直闪红：自动接受掉
      if (m.method === 'Page.javascriptDialogOpening') {
        try { this._send('Page.handleJavaScriptDialog', { accept: true }, 5000).catch(() => {}); } catch { /* 忽略 */ }
      }
    };
    await this._send('Runtime.enable', {}, 10000);
    await this._send('Page.enable', {}, 10000);
    // 如果重连前页面就已经弹着 alert/confirm，事件不会再补发；主动关一次，否则每次 evaluate 都会卡死
    try { await this._send('Page.handleJavaScriptDialog', { accept: true }, 3000); } catch { /* 没有弹窗 */ }
    if (!/iwara\.tv/.test(page.url || '')) {
      await this._send('Page.navigate', { url: startUrl }, 15000);
    }
    await this._waitCfPass(30000);
  }

  _send(method, params, timeoutMs = 90000) {
    return new Promise((res, rej) => {
      const id = ++this._id;
      this._pending.set(id, { res, rej });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this._pending.delete(id); return rej(e); }
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); rej(new Error(`CDP 超时: ${method}`)); } }, timeoutMs);
    });
  }

  async evalJs(expression, { awaitPromise = true, timeoutMs = 90000 } = {}) {
    let r;
    try {
      r = await this._send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs);
    } catch (e) {
      // 页面里可能有 alert/confirm 阻塞了 JS：先关掉弹窗再重试一次
      try { await this._send('Page.handleJavaScriptDialog', { accept: true }, 3000); } catch { /* 没有弹窗 */ }
      r = await this._send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs);
    }
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  /** 等 Cloudflare 挑战页过去（标题不再是"请稍候/Just a moment"） */
  async _waitCfPass(maxMs = 90000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      let title = '';
      try { title = String(await this.evalJs('document.title', { awaitPromise: false, timeoutMs: 5000 }) ?? ''); } catch { /* 导航中 */ }
      if (!/请稍候|Just a moment|moment|Attention Required|检查/i.test(title) && title) return true;
      await sleep(2500);
    }
    return false;
  }

  /** 在页面里发 API 请求：自动补 X-Version / X-Site / Authorization；返回 {status, json, text}
   *  _probe() 活体检测：WebSocket/CDP 断了就自动重开 */
  async apiFetch(method, urlOrPath, { body, token, timeoutMs = 30000 } = {}) {
    // 每次调前探一下 CDP（API 请求间隔大，探针开销可忽略）
    if (await this._probe()) {
      await this._connect('about:blank');
      try { await this.hideTaskbar(); } catch { /* 已经藏了就不管 */ }
      console.log('[browser] 通道重开了');
    }
    const full = /^https?:/i.test(urlOrPath) ? urlOrPath : `https://api.iwara.tv${urlOrPath}`;
    const xv = await xVersion(full);
    const payload = JSON.stringify({ method, url: full, xv, body: body ?? null, token: token ?? '', tmo: timeoutMs });
    // 页面内 fetch 自带硬超时：请求挂起会在 tmo 毫秒内 abort 返回 status:0，
    // 不再让 Runtime.evaluate(awaitPromise) 干等到 90s CDP 超时——这是历史「任务卡在 resolving」的根因
    const expr = `(async () => {
      const o = ${payload};
      const h = { Accept: 'application/json', 'X-Site': 'www.iwara.tv', 'X-Version': o.xv };
      if (o.token) h.Authorization = 'Bearer ' + o.token;
      if (o.body != null) h['Content-Type'] = 'application/json';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.tmo);
      try {
        const r = await fetch(o.url, { method: o.method, headers: h, body: o.body != null ? JSON.stringify(o.body) : undefined, credentials: 'include', signal: ctrl.signal });
        const t = await r.text();
        return JSON.stringify({ status: r.status, text: t.slice(0, 400000) });
      } catch (e) { return JSON.stringify({ status: 0, text: '', error: (e && e.name === 'AbortError') ? ('timeout>' + o.tmo + 'ms') : String(e) }); }
      finally { clearTimeout(timer); }
    })()`;
    const raw = await this.evalJs(expr, { timeoutMs: timeoutMs + 5000 });
    const out = JSON.parse(raw || '{"status":0,"text":""}');
    try { out.json = JSON.parse(out.text); } catch { out.json = null; }
    return out;
  }

  /** 登录：实测 POST /user/login 返回 {token:<refresh JWT>}（有 30 天 exp），
   *  再用它调 POST /user/token 换 accessToken。页面内 fetch 能直接过 Cloudflare，
   *  不需要 Turnstile。
   *
   *  ⚠️ 表单回退默认关闭（formFallback=false）：它会 Page.navigate 到 /login，
   *  把**共享页面**上的其它并发 apiFetch 一起打断，还要等 90s CF，是“重新登录很慢”的
   *  主要来源之一。确实需要时再开（config.local.json: formLoginFallback=true）。 */
  async login(email, password, { formFallback = false } = {}) {
    const direct = await this.apiFetch('POST', '/user/login', { body: { email, password } });
    const rt = String(direct.json?.token || direct.json?.refreshToken || '');
    if (direct.status === 200 && rt && rt.split('.').length === 3) {
      const t = await this.apiFetch('POST', '/user/token', { token: rt });
      const at = String(t.json?.accessToken || t.json?.access_token || t.json?.token || '');
      if (at) return { accessToken: at, refreshToken: rt, via: 'fetch' };
      throw new Error(`拿到 refresh token，但 /user/token 没给 accessToken（HTTP ${t.status} ${String(t.text).slice(0, 120)}）`);
    }
    say_login_fail(direct);
    if (direct.status === 0) {
      throw new Error('页面内请求失败（HTTP 0）：多半是本机代理没开或端口变了（预期 127.0.0.1:7897），检查代理后再点「重新登录」');
    }
    if (!formFallback) {
      throw new Error(`页面内直连登录失败（HTTP ${direct.status} ${String(direct.text || '').slice(0, 120)}）；` +
        '表单回退默认关闭（它会导航共享页面、打断并发任务），确需启用请把 config.local.json 的 formLoginFallback 设为 true');
    }
    // 回退：驱动登录表单（会占用共享页面，只在没有并发任务时才值得用）
    await this._send('Page.navigate', { url: 'https://www.iwara.tv/login' });
    await sleep(3500);
    await this._waitCfPass();
    const fill = await this.evalJs(`(async () => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let email = null, pw = null;
      for (let i = 0; i < 30 && !(email && pw); i++) {
        email = email || document.querySelector('input[type=email], input[name=email], input#email');
        pw = pw || document.querySelector('input[type=password]');
        if (!(email && pw)) await sleep(500);
      }
      if (!email || !pw) return 'inputs-not-found';
      set(email, ${JSON.stringify(email)});
      set(pw, ${JSON.stringify(password)});
      await sleep(300);
      const btn = [...document.querySelectorAll('button')].find(b => /log\\s?in|登录|sign in/i.test(b.innerText)) || document.querySelector('button[type=submit]');
      if (!btn) return 'button-not-found';
      btn.click();
      return 'clicked';
    })()`);
    if (fill !== 'clicked') throw new Error('表单自动化失败: ' + fill);
    // 等跳转 + 从 localStorage 取官方前端存的 token
    const lsKey = process.env.IWARA_TOKEN_KEY || 'IWARA_TOKEN';
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const got = await this.evalJs(`(async () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          if (v.split('.').length === 3 && v.split('.')[1]?.length > 20) out[k] = v;
        }
        return JSON.stringify(out);
      })()`);
      const map = JSON.parse(got || '{}');
      const keys = Object.keys(map);
      if (keys.length) {
        const refreshToken = map[keys[0]];
        // 有 refresh token 就能换 access token
        const t = await this.apiFetch('POST', '/user/token', { token: refreshToken });
        const accessToken = t.json?.accessToken || '';
        if (accessToken) return { accessToken, refreshToken, via: 'form+localstorage', lsKey: keys[0] };
      }
      const err = await this.evalJs(`(document.querySelector('[class*=error],[role=alert]')||{}).innerText || ''`);
      if (err) throw new Error('登录被拒: ' + err);
    }
    throw new Error('登录后没拿到 token（可能卡在 Turnstile/验证码，需要你看一眼那个 Edge 窗口）');
  }

  /** 把 CDP 的 Edge 窗口从任务栏摘掉（WS_EX_TOOLWINDOW + SetParent 强制刷新）
   *  ⚠️ 绝不能用 spawnSync：那是同步调用，会把整个 Node 事件循环堵死到 PowerShell 跑完为止（上限 10s）。
   *  机器一忙（压缩+下载打满 CPU）就表现为「面板/SSE 整个假死」。改成异步 spawn，fire-and-forget。 */
  async hideTaskbar() {
    try {
      const script = path.join(ROOT, 'engine', 'hide_window.ps1');
      const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(this.port), '-Action', 'hide'], { windowsHide: true });
      let out = ''; let err = ''; let failed = false;
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => { failed = true; });
      const killer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, 10000);
      p.on('close', (code) => {
        clearTimeout(killer);
        if (failed || !out.includes('window(s)')) console.warn(`[hide] 失败了 exit=${code} out="${out.trim()}" err="${err.trim()}"`);
      });
    } catch { /* 忽略 */ }
  }

  /** 活体探测：CDP WebSocket/JSON 全部超时就说明断了，返回 true。
   *  必须整体有界（默认 5 秒）：以前 evalJs 走 90 秒超时，页面一卡就让“解析中”挂两分钟。 */
  async _probe(maxMs = 5000) {
    const race = (async () => {
      const a = fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(maxMs) }).catch(() => null);
      // 注意：evalJs 已经解包，返回的是原始值（1+1 直接得 2），不是 {result:{value:2}}
      const b = this.evalJs('1+1', { awaitPromise: false, timeoutMs: maxMs }).catch(() => null);
      const [ra, rb] = await Promise.all([a, b]);
      return !(ra && rb === 2);
    })();
    const timeout = new Promise((r) => setTimeout(() => r(true), maxMs + 500));
    try { return await Promise.race([race, timeout]); } catch { return true; }
  }

  async stop() {
    try { this.ws?.close(); } catch { /* 忽略 */ }
    if (this.child && !this.reused) { try { this.child.kill(); } catch { /* 忽略 */ } }
  }
}

