// =============================================================================
//  server.mjs —— iwaraMachine 面板服务（零 npm 依赖，只用 Node 内置模块）
//
//  职责边界（照这套分工的原因见 README 的实测表）：
//    · 本进程：队列/调度/进度/SSE/UI 静态资源 + 所有 iwara API 调用（经 browser.mjs 过 Cloudflare）
//    · engine/task.ps1 + segment.ps1：只干一件事 —— 把 CDN 字节按段拉下来（.NET 走系统代理）
//  两边只通过 state/tasks/<id>.json 这个文件通信：段边界由 (size, 段数) 唯一决定，
//  所以任何一层重启都能从磁盘接着干，不记内存账。
//
//  只监听 127.0.0.1；端口固定不顺延（顺年会开出多个各自持锁的实例 → 并发下载互相拖慢）。
// =============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Browser } from '../engine/browser.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const PUBLIC = path.join(__dir, 'public');
const TASK_PS = path.join(ROOT, 'engine', 'task.ps1');
const STATE = path.join(ROOT, 'state');
const TASKDIR = path.join(STATE, 'tasks');
const QUEUE = path.join(STATE, 'queue.json');
const STOPFLAG = path.join(STATE, 'stop.flag');
const LOGFILE = path.join(ROOT, 'logs', 'panel.log');
const HOST = '127.0.0.1';

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
const PORT = Number(process.env.IWARA_WEB_PORT || CFG.webPort || 8811);
const APP_ID = 'iwara-machine';
const FLUSH_MS = 60;
const OPEN_BROWSER = process.argv.includes('--open');
const EXTRA_HOSTS = String(process.env.IWARA_WEB_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(TASKDIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
try { fs.rmSync(STOPFLAG, { force: true }); } catch { /* 忽略 */ }

// ---------------------------------------------------------------- 任务表
const tasks = new Map();          // id -> task
let browser = null;
let browserStarting = null;
let token = null;
let LISTEN_PORT = PORT;
const listeners = new Set();
const outbox = [];
let outboxTimer = null;

function saveQueue() {
  const keep = [...tasks.values()].map((t) => ({
    id: t.id, link: t.link, title: t.title, author: t.author, outFile: t.outFile,
    size: t.size, status: t.status, liked: t.liked, percent: t.percent, done: t.done,
    speed: t.speed, addedAt: t.addedAt, error: t.error, tries: t.tries,
  }));
  try { fs.writeFileSync(QUEUE, JSON.stringify(keep, null, 1), 'utf8'); } catch { /* 只影响重启后恢复 */ }
}
function loadQueue() {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch { return; }
  for (const r of arr || []) {
    if (!r || !r.id) continue;
    // 服务重启后子进程已经没了：重新排队。分段进度在磁盘 .part 里，task.ps1 会从断点接着下。
    if (r.status === 'downloading' || r.status === 'resolving' || r.status === 'needurl') r.status = 'queued';
    tasks.set(r.id, { ...r, child: null, clients: 0 });
  }
}
loadQueue();

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
// task.ps1 把进度写进 state/tasks/<id>.json；服务端每秒回读一次再广播给页面。
// 两层只靠这个文件通信，所以任何一方重启都不丢进度。
function pollProgress() {
  for (const t of tasks.values()) {
    // downloading 时持续同步进度；done 时再回读一次 total（task.ps1 会把 CDN 实到写回 total）
    if (t.status !== 'downloading' && t.status !== 'done') continue;
    const j = readJson(path.join(TASKDIR, `${t.id}.json`));
    if (!j) continue;
    if (typeof j.done === 'number') t.done = j.done;
    if (typeof j.total === 'number' && j.total) t.total = j.total;
    if (typeof j.percent === 'number') t.percent = j.percent;
    if (typeof j.speed === 'number') t.speed = j.speed;
    if (typeof j.segAlive === 'number') t.segAlive = j.segAlive;
  }
}

function emit(ev, data) {
  outbox.push({ ev, data });
  if (!outboxTimer) outboxTimer = setTimeout(flushOutbox, FLUSH_MS);
}
function flushOutbox() {
  outboxTimer = null;
  if (!outbox.length || !listeners.size) { outbox.length = 0; return; }
  const batch = outbox.splice(0, outbox.length);
  for (const res of listeners) {
    try { res.write(`event: batch\ndata: ${JSON.stringify(batch)}\n\n`); } catch { /* 客户端断开 */ }
  }
}
function log(id, text) {
  emit('log', { id, text, at: Date.now() });
  // 面板日志必须落盘：服务是从隐藏窗口起的，不落盘就只能靠猜
  try { fs.appendFileSync(LOGFILE, `${new Date().toISOString().slice(11, 19)} [${id}] ${text}\n`); } catch { /* 写不进去不阻断任务 */ }
}

function summary() {
  let done = 0, total = 0, speed = 0, running = 0;
  for (const t of tasks.values()) {
    if (t.total) { done += t.done || 0; total += t.total; }
    if (t.status === 'downloading' || t.status === 'resolving') { running++; speed += t.speed || 0; }
  }
  return {
    tasks: tasks.size, running, speed: Math.round(speed * 100) / 100,
    doneMb: Math.round(done / 1048576 * 10) / 10, totalMb: Math.round(total / 1048576 * 10) / 10,
    percent: total ? Math.round(done * 1000 / total) / 10 : 0,
    loggedIn: !!token, browserUp: !!browser, maxTasks: CFG.maxTasks || 2, segments: CFG.segmentsPerFile || 8,
    outDir: CFG.outDir, quality: CFG.quality || 'Source',
  };
}
function snapshot() {
  return {
    at: Date.now(), meta: summary(),
    tasks: [...tasks.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map((t) => ({
      id: t.id, link: t.link, title: t.title, author: t.author, status: t.status, liked: t.liked,
      percent: t.percent || 0, done: t.done || 0, total: t.total || t.size || 0, speed: t.speed || 0,
      outFile: t.outFile, error: t.error, segAlive: t.segAlive || 0, tries: t.tries || 0, addedAt: t.addedAt,
    })),
  };
}
function pushState() { emit('state', snapshot()); }

// ---------------------------------------------------------------- 浏览器通道
async function getBrowser() {
  if (browser) return browser;
  if (!browserStarting) {
    browserStarting = Browser.start({ profileDir: path.join(STATE, 'edgeprofile'), port: CFG.cdpPort || 9333 })
      .then((b) => { browser = b; browserStarting = null; return b; })
      .catch((e) => { browserStarting = null; throw e; });
  }
  return browserStarting;
}
async function ensureLogin() {
  if (token) return token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const b = await getBrowser();
    // 先用 _probe() 探测 CDP 是否真的活着；如果从 stale 连接恢复，不要直接调 evalJs()
    // （Runtime.evaluate 可能永久挂住）
    try {
      if (await b._probe()) { throw new Error('browser dead, restarting'); }
    } catch (e) {
      console.error('[ensureLogin] _probe failed:', e.message);
      // 杀了断掉的浏览器
      if (browser && !browser.reused) { try { await browser.stop(); } catch { } }
      browser = null;
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw e;
    }
    // login 前必须保证浏览器已过 Cloudflare；如果 WebSocket 是从死连接恢复的，\_waitCfPass 会先导航到 blank 页面
    try { await b._waitCfPass(5000); } catch { /* 不要阻塞 */ }
    try {
      const r = await b.login(CFG.email, CFG.password);
      token = r.accessToken;
      browser = null; // 强制下次任务入队时重启浏览器（CF clearance 干净）
      try {
        fs.writeFileSync(path.join(STATE, 'tokens.json'), JSON.stringify({
          accessToken: r.accessToken, refreshToken: r.refreshToken, via: r.via, savedAt: Date.now(),
        }, null, 2), 'utf8');
      } catch { /* 令牌缓存写失败不影响本次 */ }
      log('system', `登录完成 via=${r.via}`);
      return token;
    } catch (e) {
      console.error(`[ensureLogin] attempt ${attempt} failed:`, e.message);
      // 杀了这断掉的浏览器，下次循环 getBrowser 会拉起新的
      if (browser && !browser.reused) { try { await browser.stop(); } catch { } }
      browser = null;
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      throw e; // 两次都失败 -> 交给上层处理
    }
  }
  throw new Error('登录失败（2次重试均失败）');
}
async function apiFetch(method, urlOrPath, opts = {}) {
  const b = await getBrowser();
  const t = await ensureLogin();
  const r = await b.apiFetch(method, urlOrPath, { ...opts, token: t });
  if (r.status === 401 || r.status === 403) {
    // 令牌可能被吊销/过期：强制重登一次
    token = null;
    const t2 = await ensureLogin();
    return b.apiFetch(method, urlOrPath, { ...opts, token: t2 });
  }
  return r;
}

// ---------------------------------------------------------------- 解析与执行
const ID_RE = /\/video\/([A-Za-z0-9]+)/;
function parseId(link) {
  const s = String(link || '').trim();
  const m = ID_RE.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9]{6,24}$/.test(s) ? s : '';
}
function extOf(name, mime) {
  const m = /\.([A-Za-z0-9]{2,4})$/.exec(String(name || ''));
  if (m) return '.' + m[1].toLowerCase();
  if (/mp4/i.test(String(mime || ''))) return '.mp4';
  if (/webm/i.test(String(mime || ''))) return '.webm';
  if (/mkv/i.test(String(mime || ''))) return '.mkv';
  return '.mp4';
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled';
}

async function resolveTask(t) {
  t.status = 'resolving'; t.error = ''; pushState();
  const v1 = await apiFetch('GET', `/video/${t.id}`);
  if (v1.status !== 200 || !v1.json) throw new Error(`取视频信息失败 HTTP ${v1.status}`);
  const v = v1.json;
  t.title = v.title || t.id;
  t.author = v.user?.username || 'unknown';
  t.size = Number(v.file?.size || 0);
  t.total = t.size;
  if (!v.fileUrl) throw new Error('该视频没有 fileUrl（可能是外链视频）');

  // 点赞：只在明确未赞时点（like 端点疑似切换语义，重复点会把赞点掉）
  if (CFG.likeBeforeDownload === false) {
    log(t.id, '配置关闭了自动点赞，跳过');
  } else if (t.like !== false) {
    if (v.liked === true) { t.liked = true; log(t.id, '已经赞过了，跳过（避免取消赞）'); }
    else {
      const lk = await apiFetch('POST', `/video/${t.id}/like`);
      t.liked = lk.status >= 200 && lk.status < 300;
      log(t.id, `点赞 ${lk.status} -> ${t.liked ? '成功' : '失败 ' + String(lk.text).slice(0, 80)}`);
    }
  }

  const fu = /^https?:/i.test(v.fileUrl) ? v.fileUrl : `https:${v.fileUrl}`;
  const sl = await apiFetch('GET', fu);
  const list = Array.isArray(sl.json) ? sl.json : [];
  if (!list.length) throw new Error(`源列表为空 HTTP ${sl.status}`);
  const want = CFG.quality || 'Source';
  const src = list.find((s) => s.name === want) || list.find((s) => s.name === 'Source') || list[0];
  if (!src?.src?.download) throw new Error('没有可用的 download 直链');
  t.url = decodeURIComponent(`https:${src.src.download}`);
  t.quality = src.name;
  const dir = CFG.outDir;
  fs.mkdirSync(dir, { recursive: true });
  t.outFile = path.join(dir, `${safeName(t.title)}[${t.id}]${extOf(v.file?.name, src.mime)}`);
  t.expires = (() => { const m = /[?&]expires=(\d+)/.exec(t.url); return m ? Number(m[1]) : 0; })();
  log(t.id, `解析完成 ${t.quality} ${(t.size / 1048576).toFixed(1)}MB -> ${path.basename(t.outFile)}`);
  writeTaskFile(t);
}

function writeTaskFile(t) {
  const p = path.join(TASKDIR, `${t.id}.json`);
  fs.writeFileSync(p, JSON.stringify({
    id: t.id, url: t.url, size: t.size, outFile: t.outFile, title: t.title, author: t.author,
    segments: CFG.segmentsPerFile || 8, stallSec: CFG.segmentStallSec || 20, status: t.status,
    startedAt: t.startedAt,
  }, null, 1), 'utf8');
  return p;
}

function runTask(t) {
  t.status = 'downloading'; t.childProc = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TASK_PS, '-TaskFile', t.taskFile],
    { cwd: ROOT, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (stream, kind) => {
    let rest = '';
    const dec = new TextDecoder('utf-8', { fatal: false });
    stream.on('data', (chunk) => {
      rest += dec.decode(chunk, { stream: true });
      const parts = rest.split(/\r?\n/); rest = parts.pop();
      for (const p of parts) if (p.trim()) log(t.id, p.trim());
    });
    stream.on('end', () => { rest += dec.decode(); if (rest.trim()) log(t.id, rest.trim()); });
  };
  onData(t.childProc.stdout, 'out');
  onData(t.childProc.stderr, 'err');
  // 用 exit 判完成（close 要等继承句柄，会被子进程拖住）
  t.childProc.on('exit', (code) => onTaskExit(t, code));
  t.childProc.on('error', (e) => { t.error = e.message; t.status = 'failed'; log(t.id, '启动下载进程失败: ' + e.message); pushState(); saveQueue(); });
}

async function onTaskExit(t, code) {
  t.childProc = null;
  if (code === 0) {
    t.status = 'done'; t.percent = 100; t.speed = 0;
    if (!t.done && t.total) t.done = t.total;      // 不补这一步，已完成行会显示 0 / 275 MB
    log(t.id, '✅ 下载完成');
    pushState(); saveQueue(); return;
  }
  if (t.status === 'stopped' || code === 5) { t.status = 'stopped'; log(t.id, '已停止'); pushState(); saveQueue(); return; }
  if (code === 3) {
    t.tries = (t.tries || 0) + 1;
    if (t.tries > 3) { t.status = 'failed'; t.error = '直链反复失效'; log(t.id, '❌ 直链反复失效，放弃'); pushState(); saveQueue(); return; }
    log(t.id, `直链过期，重新签名（第 ${t.tries} 次）…`);
    try {
      await resolveTask(t);
      t.status = 'resolving'; pushState();
      setTimeout(() => { if (!stopped) runTask(t); }, 1500);
    } catch (e) { t.status = 'failed'; t.error = e.message; log(t.id, '重签名失败: ' + e.message); pushState(); saveQueue(); }
    return;
  }
  t.status = 'failed'; t.error = `下载进程退出码 ${code}`;
  log(t.id, `❌ ${t.error}`);
  pushState(); saveQueue();
}

// ---------------------------------------------------------------- 调度器
let stopped = false;
let schedTimer = null;
function schedule() {
  const max = Math.max(1, Number(CFG.maxTasks) || 2);
  let running = 0;
  for (const t of tasks.values()) if (t.status === 'downloading' || t.status === 'resolving') running++;
  if (stopped || running >= max) return;
  const next = [...tasks.values()].find((t) => t.status === 'queued' || t.status === 'failed' && (t.tries || 0) === 0 && t.retryOnce);
  if (!next) return;
  startTask(next).catch((e) => { next.status = 'failed'; next.error = e.message; log(next.id, '失败: ' + e.message); pushState(); saveQueue(); });
  setTimeout(schedule, 800);
}
async function startTask(t) {
  await resolveTask(t);
  t.taskFile = path.join(TASKDIR, `${t.id}.json`);
  t.status = 'resolving'; pushState();
  runTask(t);
}

// ---------------------------------------------------------------- 队列操作
function enqueue(links) {
  let added = 0;
  for (const raw of links) {
    const id = parseId(raw);
    if (!id) continue;
    if (tasks.has(id)) { const old = tasks.get(id); if (old.status === 'done') continue; }
    tasks.set(id, {
      id, link: String(raw).trim(), status: 'queued', percent: 0, done: 0, total: 0, speed: 0,
      addedAt: Date.now(), tries: 0, liked: null, childProc: null,
    });
    added++;
  }
  if (added) { saveQueue(); pushState(); }
  return added;
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
const json = (res, code, o) => send(res, code, JSON.stringify(o), { 'Content-Type': 'application/json; charset=utf-8' });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const cs = [];
    req.on('data', (c) => { n += c.length; if (n > 262144) { reject(new Error('请求体过大')); req.destroy(); return; } cs.push(c); });
    req.on('end', () => { if (!cs.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))); } catch { reject(new Error('请求体不是 JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(hostname) && !EXTRA_HOSTS.includes(hostname)) {
    return json(res, 403, { error: `只接受本机访问（Host: ${req.headers.host}）` });
  }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/api/whoami') return json(res, 200, { app: APP_ID, pid: process.pid, port: LISTEN_PORT });

    if (p === '/api/state') return json(res, 200, snapshot());

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write(': open\n\n');
      res.write(`event: batch\ndata: ${JSON.stringify([{ ev: 'state', data: snapshot() }])}\n\n`);
      listeners.add(res);
      const bye = () => listeners.delete(res);
      req.on('close', bye); res.on('error', bye);
      return;
    }

    if (req.method === 'POST' && p === '/api/enqueue') {
      const b = await readBody(req);
      const links = Array.isArray(b.links) ? b.links : String(b.links || b.text || '').split(/[\s,;]+/);
      const added = enqueue(links.filter(Boolean));
      stopped = false;
      setTimeout(schedule, 200);
      return json(res, 200, { added, total: tasks.size });
    }
    if (req.method === 'POST' && p === '/api/start') {
      stopped = false;
      try { fs.rmSync(STOPFLAG, { force: true }); } catch { /* 忽略 */ }
      for (const t of tasks.values()) if (t.status === 'stopped') t.status = 'queued';
      pushState(); schedule();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/stop') {
      stopped = true;
      try { fs.writeFileSync(STOPFLAG, String(Date.now())); } catch { /* 忽略 */ }
      for (const t of tasks.values()) {
        if (t.childProc) { try { t.childProc.kill(); } catch { /* 忽略 */ } }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/remove') {
      const b = await readBody(req);
      const id = String(b.id || '');
      const t = tasks.get(id);
      if (t?.childProc) { try { t.childProc.kill(); } catch { /* 忽略 */ } }
      tasks.delete(id); saveQueue(); pushState();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/retry') {
      const b = await readBody(req);
      let n = 0;
      for (const t of tasks.values()) {
        if (b.id && t.id !== b.id) continue;
        if (t.status === 'done') continue;
        t.status = 'queued'; t.error = ''; t.tries = 0; n++;
      }
      saveQueue(); pushState(); stopped = false;
      try { fs.rmSync(STOPFLAG, { force: true }); } catch { /* 忽略 */ }
      setTimeout(schedule, 200);
      return json(res, 200, { retried: n });
    }
    if (req.method === 'POST' && p === '/api/relogin') { token = null; try { await ensureLogin(); } catch (e) { return json(res, 500, { error: e.message }); } pushState(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/local') {
      const b = await readBody(req);
      const map = { outdir: CFG.outDir, logdir: path.join(ROOT, 'logs'), project: ROOT };
      const target = map[String(b.what || '')];
      if (!target) return json(res, 400, { error: '未知操作' });
      if (!fs.existsSync(target)) return json(res, 404, { error: '路径不存在: ' + target });
      const r = spawnSync('explorer.exe', [target], { windowsVerbatimArguments: false, timeout: 8000 });
      if (r.error) return json(res, 500, { error: 'explorer.exe 调用失败: ' + r.error.message });
      return json(res, 200, { ok: true, target });
    }
    if (req.method === 'POST' && p === '/api/shutdown') {
      stopped = true;
      for (const t of tasks.values()) if (t.childProc) { try { t.childProc.kill(); } catch { /* 忽略 */ } }
      try { browser?.stop(); } catch { /* 忽略 */ }
      setTimeout(() => process.exit(0), 300);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.replace(/^\/+/, ''));
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
      try { return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); }
      catch { return send(res, 404, 'not found'); }
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
});
setInterval(() => { for (const res of listeners) { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } } }, 15000).unref();
setInterval(pollProgress, 1000).unref();
setInterval(pushState, 3000).unref();
schedTimer = setInterval(schedule, 2500);

// ---------------------------------------------------------------- 单实例
function lockPath(port) { return path.join(STATE, `web_${port}.lock`); }
async function probe(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/whoami`, { signal: AbortSignal.timeout(1200) });
    const j = await res.json();
    return j?.app === APP_ID ? j : null;
  } catch { return null; }
}
function openBrowser(port) {
  spawn('explorer.exe', [`http://${HOST}:${port}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  const other = await probe(PORT);
  if (other) {
    console.log(`[web] 已有实例在跑 http://${HOST}:${PORT}/ (pid ${other.pid})，本次退出`);
    if (OPEN_BROWSER) openBrowser(PORT);
    process.exit(0);
  }
  server.on('error', (e) => { console.error('[web] 启动失败:', e.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    LISTEN_PORT = PORT;
    try { fs.writeFileSync(lockPath(PORT), JSON.stringify({ app: APP_ID, pid: process.pid, port: PORT })); } catch { /* 忽略 */ }
    console.log('');
    console.log('  iwaraMachine · 面板已启动');
    console.log(`  地址      http://${HOST}:${PORT}/   (pid ${process.pid})`);
    console.log(`  输出目录  ${CFG.outDir}`);
    console.log(`  并发      文件 ${CFG.maxTasks} × 段 ${CFG.segmentsPerFile}，档位 ${CFG.quality}`);
    console.log('  提示      API 通道会在首个任务时拉起 Edge（离屏窗口）；关掉本窗口即停服务');
    console.log('');
    if (OPEN_BROWSER) openBrowser(PORT);
  });
  process.on('exit', () => { try { const l = JSON.parse(fs.readFileSync(lockPath(LISTEN_PORT), 'utf8')); if (l.pid === process.pid) fs.rmSync(lockPath(LISTEN_PORT), { force: true }); } catch { /* 忽略 */ } });
  process.on('SIGINT', () => process.exit(0));
}
main().catch((e) => { console.error('[web] ' + e.message); process.exit(1); });
