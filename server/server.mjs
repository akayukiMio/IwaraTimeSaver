// =============================================================================
//  server.mjs —— iwaraMachine 面板服务（零 npm 依赖，只用 Node 内置模块）
//
//  职责边界（照这套分工的原因见 README 的实测表）：
//    · 本进程：队列/调度/进度/SSE/UI 静态资源 + 所有 iwara API 调用（经 browser.mjs 过 Cloudflare）
//    · engine/task.ps1 + segment.ps1：只干一件事 —— 把 CDN 字节按段拉下来（.NET 走系统代理）
//  两边只通过 state/tasks/<id>.json 这个文件通信：段边界由 (size, 段数) 唯一决定，
//  所以任何一层重启都能从磁盘接着干，不记内存账。
//
//  ⚠️ 进程管理铁律：kill() 只杀 powershell.exe 本身，Start-Process 出来的 segment.ps1
//     会变孤儿继续写 .part。所有“停止/移除/重试/退出”都必须 killTree()（taskkill /T /F）。
//
//  只监听 127.0.0.1；端口固定不顺延（顺延会开出多个各自持锁的实例 → 并发下载互相拖慢）。
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
const TOKENS = path.join(STATE, 'tokens.json');
const STOPFLAG = path.join(STATE, 'stop.flag');
const LOGFILE = path.join(ROOT, 'logs', 'panel.log');
const SEGLOGDIR = path.join(ROOT, 'logs', 'seg');
const HOST = '127.0.0.1';

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
const PORT = Number(process.env.IWARA_WEB_PORT || CFG.webPort || 8811);
const APP_ID = 'iwara-machine';
const FLUSH_MS = 60;
const OPEN_BROWSER = process.argv.includes('--open');
const EXTRA_HOSTS = String(process.env.IWARA_WEB_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const STALE_SEC = Math.max(30, Number(CFG.staleProgressSec) || 180);   // 进度文件多久没更新算僵死
const LOG_MAX = Math.max(1, Number(CFG.logMaxMb) || 8) * 1024 * 1024; // 单个日志文件上限
const COMPRESSOR_URL = String(CFG.compressorUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const COMPRESSOR_DIR = String(CFG.compressorDir || path.resolve(ROOT, '..', 'video_compressor'));
const AUTO_HANDOFF = CFG.autoHandoff !== false;
const AUTO_START_COMPRESSOR = CFG.autoStartCompressor !== false;

fs.mkdirSync(TASKDIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(SEGLOGDIR, { recursive: true });
try { fs.rmSync(STOPFLAG, { force: true }); } catch { /* 忽略 */ }

// ---------------------------------------------------------------- 任务表
const tasks = new Map();          // id -> task
let browser = null;
let browserStarting = null;
let token = null;
let loginPromise = null;
let LISTEN_PORT = PORT;
const listeners = new Set();
const outbox = [];
let outboxTimer = null;
const auth = { phase: 'idle', detail: '', since: Date.now() };
let pipelineOnline = false;
let pipelineFail = 0;
let compressorLaunch = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setAuth(phase, detail) {
  auth.phase = phase;
  auth.detail = detail || '';
  auth.since = Date.now();
  pushState();
}

function saveQueue() {
  const keep = [...tasks.values()].map((t) => ({
    id: t.id, link: t.link, title: t.title, author: t.author, outFile: t.outFile,
    size: t.size, status: t.status, liked: t.liked, percent: t.percent, done: t.done,
    speed: t.speed, addedAt: t.addedAt, error: t.error, tries: t.tries, compress: t.compress,
  }));
  try { fs.writeFileSync(QUEUE, JSON.stringify(keep, null, 1), 'utf8'); } catch { /* 只影响重启后恢复 */ }
}
function loadQueue() {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch { return; }
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];   // 手改/半截 json 时别让整个服务起不来
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

// ---------------------------------------------------------------- 日志（落盘 + 轮转）
let logBytes = 0;
try { logBytes = fs.statSync(LOGFILE).size; } catch { logBytes = 0; }
function rotateLog() {
  if (logBytes <= LOG_MAX) return;
  try {
    try { fs.rmSync(`${LOGFILE}.1`, { force: true }); } catch { /* 忽略 */ }
    fs.renameSync(LOGFILE, `${LOGFILE}.1`);
  } catch { /* 轮转失败就继续追加 */ }
  logBytes = 0;
}
function log(id, text) {
  emit('log', { id, text, at: Date.now() });
  // 面板日志必须落盘：服务是从隐藏窗口起的，不落盘就只能靠猜
  try {
    const line = `${new Date().toISOString().slice(11, 19)} [${id}] ${text}\n`;
    rotateLog();
    fs.appendFileSync(LOGFILE, line, 'utf8');
    logBytes += Buffer.byteLength(line);
  } catch { /* 写不进去不阻断任务 */ }
}

// 清掉过期的段日志（失败任务的现场保留 7 天）
function sweepSegLogs(days = 7) {
  const cutoff = Date.now() - days * 86400 * 1000;
  let n = 0;
  try {
    for (const f of fs.readdirSync(SEGLOGDIR)) {
      const p = path.join(SEGLOGDIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); n++; } } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return n;
}

// ---------------------------------------------------------------- 进程树
function killTree(pid) {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch { /* 已退出 */ }
}

// 上次异常退出留下的 task.ps1（持锁）必须在调度前清掉，否则新任务会和旧孤儿抢 .part。
// 杀之前先确认 pid 真的还是 powershell.exe：pid 可能已被无关进程复用。
function procName(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const s = String(r.stdout || '').trim();
    if (!s || /No tasks/i.test(s)) return '';
    const m = /^"([^"]+)"/.exec(s);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}
function sweepOrphans() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(TASKDIR)) {
      if (!f.endsWith('.json.lock')) continue;
      const p = path.join(TASKDIR, f);
      let pid = 0;
      try { pid = Number(String(fs.readFileSync(p, 'utf8')).trim()); } catch { /* 忽略 */ }
      if (pid > 0) {
        const name = procName(pid);
        if (name === 'powershell.exe') { killTree(pid); n++; log('system', `清理上次残留的下载进程树 pid=${pid}`); }
        else if (name) log('system', `锁文件 pid=${pid} 已被 ${name} 复用，只删锁不杀进程`);
      }
      try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
    }
  } catch { /* 目录还不存在 */ }
  return n;
}

// ---------------------------------------------------------------- 令牌
function readTokens() { return readJson(TOKENS); }
function jwtExpMs(tok) {
  try {
    const payload = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000 || 0;
  } catch { return 0; }
}
function writeTokens(accessToken, refreshToken, via) {
  try {
    fs.writeFileSync(TOKENS, JSON.stringify({ accessToken, refreshToken, via, savedAt: Date.now() }, null, 2), 'utf8');
  } catch { /* 令牌缓存写失败不影响本次 */ }
}
// 启动即恢复本地令牌：没必要每次开面板都重新走一遍浏览器登录
function restoreToken() {
  const j = readTokens();
  if (j?.accessToken && jwtExpMs(j.accessToken) > Date.now() + 120000) {
    token = j.accessToken;
    auth.phase = 'ok'; auth.detail = '已恢复本地令牌'; auth.since = Date.now();
    return true;
  }
  if (j?.refreshToken) {
    auth.phase = 'idle'; auth.detail = '有刷新令牌，首次调用时换取 access'; auth.since = Date.now();
  }
  return false;
}

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

async function applyLogin(r) {
  token = r.accessToken;
  writeTokens(r.accessToken, r.refreshToken, r.via);
  setAuth('ok', `已登录 via=${r.via}`);
  log('system', `登录完成 via=${r.via}`);
  return token;
}

/** 用本地 refresh token 换 access；失败再走账号密码（单次） */
async function loginWith(b) {
  const saved = readTokens();
  if (saved?.refreshToken) {
    setAuth('token', '用本地 refresh token 换 access');
    try {
      const t = await b.apiFetch('POST', '/user/token', { token: saved.refreshToken });
      const at = String(t.json?.accessToken || t.json?.access_token || t.json?.token || '');
      if (at) return applyLogin({ accessToken: at, refreshToken: saved.refreshToken, via: 'refresh' });
      log('system', `refresh token 已失效（HTTP ${t.status}），改用账号密码`);
    } catch (e) {
      log('system', `refresh token 请求失败：${e.message}`);
    }
  }
  setAuth('login', '账号密码登录');
  const r = await b.login(CFG.email, CFG.password, { formFallback: CFG.formLoginFallback === true });
  return applyLogin(r);
}

async function doLogin() {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      setAuth('starting', attempt ? `重启浏览器通道（第 ${attempt + 1} 次）` : '启动浏览器通道');
      const b = await getBrowser();
      return await loginWith(b);
    } catch (e) {
      lastErr = e;
      log('system', `登录失败（第 ${attempt + 1}/2）：${e.message}`);
      const dead = browser;
      browser = null;
      if (dead && !dead.reused) { try { await dead.stop(); } catch { /* 忽略 */ } }
      if (attempt === 0) await sleep(1500);
    }
  }
  setAuth('error', lastErr?.message || '登录失败');
  throw lastErr || new Error('登录失败');
}

// 单飞：两个任务同时入队时只登录一次，避免抢同一个共享页面
function ensureLogin() {
  if (token) return Promise.resolve(token);
  if (!loginPromise) loginPromise = doLogin().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function apiFetch(method, urlOrPath, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const b = await getBrowser();
      const t = await ensureLogin();
      const r = await b.apiFetch(method, urlOrPath, { ...opts, token: t });
      if (r.status === 401 && attempt === 0) {
        // 令牌被吊销/过期：清掉重登一次（403 多数是 CF 挑战，重登没用）
        log('system', '令牌被拒（401），重新获取后重试');
        token = null;
        setAuth('token', '令牌被拒，重新获取');
        continue;
      }
      return r;
    } catch (e) {
      // CDP 通道卡死/断线：丢掉句柄重连一次（Edge 还在的话 Browser.start 会复用）
      lastErr = e;
      log('system', `API 通道异常（第 ${attempt + 1} 次）：${e.message}`);
      browser = null;
      await sleep(800);
    }
  }
  throw lastErr || new Error('API 通道不可用');
}

// ---------------------------------------------------------------- 压缩流水线（ITS → compressor）
async function compressorHealth() {
  try {
    const r = await fetch(`${COMPRESSOR_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// 压缩器没开就替用户拉起（run_web.py --no-browser，不抢浏览器焦点）
async function ensureCompressor() {
  if (await compressorHealth()) return true;
  if (!AUTO_START_COMPRESSOR) return false;
  if (!compressorLaunch) {
    compressorLaunch = (async () => {
      log('system', '压缩器未运行，正在自动启动…');
      const runner = path.join(COMPRESSOR_DIR, 'web', 'run_web.py');
      if (!fs.existsSync(runner)) throw new Error(`找不到压缩器启动脚本：${runner}`);
      const venvPy = path.join(COMPRESSOR_DIR, 'web', 'backend', '.venv', 'Scripts', 'python.exe');
      const exe = fs.existsSync(venvPy) ? venvPy : 'python';
      const child = spawn(exe, [runner, '--no-browser'], { cwd: COMPRESSOR_DIR, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      for (let i = 0; i < 80; i++) { await sleep(500); if (await compressorHealth()) { log('system', '压缩器已启动'); return true; } }
      throw new Error('压缩器启动超时（看 video_compressor/web/.run/backend.log）');
    })().finally(() => { compressorLaunch = null; });
  }
  try { return await compressorLaunch; } catch (e) { log('system', e.message); return false; }
}

// 把一个已下载完成的任务交给压缩器；失败落 pending，由 retryHandoffs 定时补投
async function handoffTask(t) {
  if (!AUTO_HANDOFF || !t.outFile) return;
  if (t.compress && t.compress.state && !['pending', 'failed'].includes(t.compress.state)) return;
  const payload = {
    job_id: t.id, paths: [t.outFile], source_dir: CFG.outDir,
    size: t.done || t.total || t.size || 0,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!(await ensureCompressor())) throw new Error('压缩器未启动，且自动拉起失败');
      const r = await fetch(`${COMPRESSOR_URL}/api/handoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(12000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 202 || r.status === 409) {
        t.compress = { state: j.state || 'queued', position: j.position || 0 };
        log(t.id, r.status === 202 ? `已交给压缩器（队列 #${j.position || '?'}）` : '压缩器已持有该任务（重复投递，忽略）');
        pushState(); saveQueue();
        return;
      }
      throw new Error(j.reason || j.error || `HTTP ${r.status}`);
    } catch (e) {
      log('system', `交付压缩器失败（${attempt + 1}/3）：${e.message}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  t.compress = { state: 'pending', position: 0 };
  log(t.id, '⚠ 压缩器不可用，已记为待交付，稍后自动重试');
  pushState(); saveQueue();
}

// 每 5 秒同步压缩队列状态（单一真值源在压缩器那边）
async function syncPipeline() {
  if (!AUTO_HANDOFF) return;
  try {
    const r = await fetch(`${COMPRESSOR_URL}/api/handoff`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!pipelineOnline) log('system', '压缩器通道已连接');
    pipelineOnline = true; pipelineFail = 0;
    const byId = new Map((j.jobs || []).map((x) => [x.job_id, x]));
    let changed = false;
    for (const t of tasks.values()) {
      const x = byId.get(t.id);
      if (!x) continue;
      const first = Array.isArray(x.result) && x.result[0] ? x.result[0] : null;
      const next = {
        state: x.state === 'running' ? 'compressing' : x.state,
        position: x.position || 0,
        output: first ? (first.archive_path || first.output_path || '') : '',
        saved: first && first.status === 'done' ? Math.max(0, (first.size || 0) - (first.output_size || 0)) : 0,
        action: first ? (first.source_action || '') : '',
        note: x.error || (first ? (first.error_msg || '') : ''),
      };
      if (JSON.stringify(t.compress) !== JSON.stringify(next)) {
        t.compress = next; changed = true;
        if (next.state === 'done') log(t.id, `压缩流程结束（${next.action === 'deleted' ? '已删源' : next.action === 'moved' ? '原片已归档' : '完成'}）`);
        if (next.state === 'failed') log(t.id, `压缩失败：${next.note || '未知'}`);
      }
    }
    if (changed) { pushState(); saveQueue(); }
  } catch (e) {
    pipelineOnline = false;
    if (++pipelineFail === 1) log('system', `压缩器离线（${COMPRESSOR_URL}）：${e.message}`);
    for (const t of tasks.values()) {
      if (t.compress && (t.compress.state === 'queued' || t.compress.state === 'compressing')) t.compress.state = 'pending';
    }
  }
}

// 压缩器离线/重启期间没投递成功的任务，定时补投
function retryHandoffs() {
  if (!AUTO_HANDOFF) return;
  for (const t of tasks.values()) {
    if (t.status === 'done' && t.compress?.state === 'pending') handoffTask(t).catch(() => {});
  }
}

// ---------------------------------------------------------------- 状态快照
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
function summary() {
  let done = 0, total = 0, speed = 0, running = 0;
  for (const t of tasks.values()) {
    if (t.total) { done += t.done || 0; total += t.total; }
    if (t.status === 'downloading' || t.status === 'resolving') { running++; speed += t.speed || 0; }
  }
  const pipe = { online: pipelineOnline, queued: 0, compressing: 0, archived: 0, moved: 0, failed: 0, pending: 0 };
  for (const t of tasks.values()) {
    const s = t.compress?.state;
    if (s === 'queued') pipe.queued++;
    else if (s === 'compressing') pipe.compressing++;
    else if (s === 'pending') pipe.pending++;
    else if (s === 'failed') pipe.failed++;
    else if (s === 'done') { if (t.compress?.action === 'moved') pipe.moved++; else pipe.archived++; }
  }
  return {
    tasks: tasks.size, running, speed: Math.round(speed * 100) / 100,
    doneMb: Math.round(done / 1048576 * 10) / 10, totalMb: Math.round(total / 1048576 * 10) / 10,
    percent: total ? Math.round(done * 1000 / total) / 10 : 0,
    loggedIn: !!token, browserUp: !!browser || !!browserStarting,
    auth: { phase: auth.phase, detail: auth.detail, since: auth.since, elapsed: Math.round((Date.now() - auth.since) / 1000) },
    pipeline: pipe, compressorUrl: COMPRESSOR_URL, autoHandoff: AUTO_HANDOFF,
    maxTasks: CFG.maxTasks || 2, segments: CFG.segmentsPerFile || 8,
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
      compress: t.compress || null,
    })),
  };
}
function pushState() { emit('state', snapshot()); }

// ---------------------------------------------------------------- 进度回读 + 僵死检测
function pollProgress() {
  const now = Date.now();
  for (const t of tasks.values()) {
    if (t.status !== 'downloading' && t.status !== 'done') continue;
    const p = path.join(TASKDIR, `${t.id}.json`);
    let j = null;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (typeof j.done === 'number') t.done = j.done;
    if (typeof j.total === 'number' && j.total) t.total = j.total;
    if (typeof j.percent === 'number') t.percent = j.percent;
    if (typeof j.speed === 'number') t.speed = j.speed;
    if (typeof j.segAlive === 'number') t.segAlive = j.segAlive;
    if (j.error && t.status === 'downloading') t.error = String(j.error).slice(0, 300);
    if (t.status !== 'downloading') continue;
    if (j.updatedAt !== t.progressAt) { t.progressAt = j.updatedAt || ''; t.progressTs = now; continue; }
    if (!t.childProc) continue;
    // task.ps1 每 700ms 写一次 updatedAt；这么久没动静说明进程卡死或已变成孤儿
    const idle = now - (t.progressTs || t.startedTs || now);
    if (idle > STALE_SEC * 1000) {
      killTree(t.childProc.pid);
      t.childProc = null;
      t.status = 'failed';
      t.error = `进度 ${Math.round(idle / 1000)}s 未更新（进程无响应），已回收`;
      log(t.id, '❌ ' + t.error);
      saveQueue();
      pushState();
    }
  }
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
  // 注意：这里的 decodeURIComponent 会把 path=2026%2F10%2F21 解成 2026/10/21，
  // 实测 CDN 两种写法都能过（不参与 hash 校验），保留以兼容旧行为。
  t.url = decodeURIComponent(`https:${src.src.download}`);
  t.quality = src.name;
  const dir = CFG.outDir;
  fs.mkdirSync(dir, { recursive: true });
  t.outFile = path.join(dir, `${safeName(t.title)}[${t.id}]${extOf(v.file?.name, src.mime)}`);
  t.expires = (() => { const m = /[?&]expires=(\d+)/.exec(t.url); return m ? Number(m[1]) : 0; })();
  t.taskFile = path.join(TASKDIR, `${t.id}.json`);
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
  if (t.childProc) return;
  t.status = 'downloading';
  t.startedTs = Date.now();
  t.progressTs = Date.now();
  t.progressAt = '';
  const proc = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TASK_PS, '-TaskFile', t.taskFile],
    { cwd: ROOT, windowsVerbatimArguments: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.childProc = proc;
  const onData = (stream) => {
    let rest = '';
    const dec = new TextDecoder('utf-8', { fatal: false });
    stream.on('data', (chunk) => {
      rest += dec.decode(chunk, { stream: true });
      const parts = rest.split(/\r?\n/); rest = parts.pop();
      for (const p of parts) if (p.trim()) log(t.id, p.trim());
    });
    stream.on('end', () => { rest += dec.decode(); if (rest.trim()) log(t.id, rest.trim()); });
  };
  onData(proc.stdout);
  onData(proc.stderr);
  // 用 exit 判完成（close 要等继承句柄，会被子进程拖住）
  proc.on('exit', (code) => { if (t.childProc === proc) onTaskExit(t, code); });
  proc.on('error', (e) => {
    t.childProc = null;
    t.error = e.message; t.status = 'failed';
    log(t.id, '启动下载进程失败: ' + e.message);
    pushState(); saveQueue();
  });
}

async function onTaskExit(t, code) {
  t.childProc = null;
  // 主动杀树后等 exit 事件再重排（避免新旧两个 task.ps1 抢 .part）
  if (t.afterKill === 'requeue') {
    t.afterKill = null;
    t.status = 'queued'; t.error = ''; t.tries = 0;
    log(t.id, '已回收旧下载进程，重新排队');
    pushState(); saveQueue();
    setTimeout(schedule, 300);
    return;
  }
  if (code === 0) {
    t.status = 'done'; t.percent = 100; t.speed = 0; t.error = '';
    if (!t.done && t.total) t.done = t.total;      // 不补这一步，已完成行会显示 0 / 275 MB
    log(t.id, '✅ 下载完成');
    pushState(); saveQueue();
    if (AUTO_HANDOFF) handoffTask(t).catch((e) => log(t.id, '交付压缩器异常: ' + e.message));
    return;
  }
  if (t.status === 'stopped' || code === 5) { t.status = 'stopped'; log(t.id, '已停止'); pushState(); saveQueue(); return; }
  if (code === 6) {
    t.status = 'failed';
    t.error = '源文件在 CDN 不存在（HTTP 404），Source/转码文件可能已被删除，重试无意义';
    log(t.id, '❌ ' + t.error);
    pushState(); saveQueue(); return;
  }
  if (code === 9) {
    t.status = 'failed';
    t.error = '同一任务已有下载实例在运行（单实例锁冲突），已退出';
    log(t.id, '❌ ' + t.error);
    pushState(); saveQueue(); return;
  }
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
  t.status = 'failed';
  t.error = code === 7 ? '分段反复停滞，已放弃（疑似 CDN 节点异常）' : `下载进程退出码 ${code}`;
  log(t.id, `❌ ${t.error}`);
  pushState(); saveQueue();
}

// ---------------------------------------------------------------- 调度器
let stopped = false;
let schedTimer = null;
function schedule() {
  const max = Math.max(1, Number(CFG.maxTasks) || 2);
  let running = 0;
  for (const t of tasks.values()) {
    if (t.starting || t.status === 'downloading' || t.status === 'resolving') running++;
  }
  if (stopped || running >= max) return;
  // 状态是唯一真值还不够：必须确认没有活着的子进程，否则会起第二个 task.ps1
  const next = [...tasks.values()].find((t) => t.status === 'queued' && !t.childProc && !t.starting);
  if (!next) return;
  startTask(next).catch((e) => {
    next.status = 'failed'; next.error = e.message;
    log(next.id, '失败: ' + e.message);
    pushState(); saveQueue();
  });
  setTimeout(schedule, 800);
}
function startTask(t) {
  if (t.starting || t.childProc) return Promise.resolve();
  t.starting = true;
  return (async () => {
    try { await resolveTask(t); runTask(t); }
    finally { t.starting = false; }
  })();
}

// ---------------------------------------------------------------- 队列操作
function enqueue(links) {
  let added = 0;
  for (const raw of links) {
    const id = parseId(raw);
    if (!id) continue;
    const old = tasks.get(id);
    if (old) {
      if (old.status === 'done') continue;
      old.link = String(raw).trim() || old.link;
      old.error = ''; old.tries = 0;
      if (old.childProc) { old.afterKill = 'requeue'; killTree(old.childProc.pid); }
      else old.status = 'queued';
      added++;
      continue;
    }
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
      let n = 0;
      for (const t of tasks.values()) {
        if (t.childProc) { killTree(t.childProc.pid); n++; }
      }
      log('system', `已停止：回收 ${n} 个下载进程树`);
      return json(res, 200, { ok: true, killed: n });
    }
    if (req.method === 'POST' && p === '/api/remove') {
      const b = await readBody(req);
      const id = String(b.id || '');
      const t = tasks.get(id);
      if (t?.childProc) killTree(t.childProc.pid);
      tasks.delete(id);
      try { fs.rmSync(path.join(TASKDIR, `${id}.json.lock`), { force: true }); } catch { /* 忽略 */ }
      saveQueue(); pushState();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/retry') {
      const b = await readBody(req);
      let n = 0;
      for (const t of tasks.values()) {
        if (b.id && t.id !== b.id) continue;
        if (t.status === 'done' || t.status === 'queued' || t.status === 'resolving') continue;
        if (t.childProc) {
          // 批量“重试失败项”绝不能碰正在下载的任务；单任务重试才允许先杀树再重排
          if (!b.id) continue;
          t.afterKill = 'requeue';
          killTree(t.childProc.pid);
          n++; continue;
        }
        t.status = 'queued'; t.error = ''; t.tries = 0; n++;
      }
      saveQueue(); pushState(); stopped = false;
      try { fs.rmSync(STOPFLAG, { force: true }); } catch { /* 忽略 */ }
      setTimeout(schedule, 200);
      return json(res, 200, { retried: n });
    }
    if (req.method === 'POST' && p === '/api/relogin') {
      // 立刻返回 202，进度通过 auth 状态推送；不再让浏览器干等 1-2 分钟
      token = null;
      setAuth('starting', '手动重新登录');
      ensureLogin().catch((e) => { log('system', '重新登录失败：' + e.message); setAuth('error', e.message); });
      return json(res, 202, { ok: true, accepted: true });
    }
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
      for (const t of tasks.values()) if (t.childProc) killTree(t.childProc.pid);
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
if (AUTO_HANDOFF) {
  setTimeout(syncPipeline, 1200);
  setInterval(syncPipeline, 5000).unref();
  setInterval(retryHandoffs, 30000).unref();
}
// 定时重新隐藏：用户点任务栏把窗口叫回来、或 Edge 新开窗口时，2 分钟内收回去并清掉“请求注意”闪烁
setInterval(() => {
  if (!browser) return;
  try { browser.hideTaskbar().catch(() => {}); } catch { /* 忽略 */ }
}, 120000).unref();

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

// 启动预热：打开面板时浏览器/登录已经在后台准备，而不是等你点“重新登录”才开始计时
function warmUp() {
  if (stopped) return;
  ensureLogin()
    .then(() => log('system', '浏览器通道预热完成'))
    .catch((e) => log('system', '预热登录失败：' + e.message));
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
    // 先清上次残留的下载进程树，再决定要不要开始调度
    const killed = sweepOrphans();
    const pruned = sweepSegLogs(7);
    const restored = restoreToken();
    // 重启恢复：下载已完成但还没交给压缩器的任务，补投一次
    if (AUTO_HANDOFF) {
      for (const t of tasks.values()) {
        if (t.status === 'done' && t.outFile && (!t.compress || !t.compress.state)) {
          t.compress = { state: 'pending', position: 0 };
          handoffTask(t).catch(() => {});
        }
      }
    }
    console.log('');
    console.log('  iwaraMachine · 面板已启动');
    console.log(`  地址      http://${HOST}:${PORT}/   (pid ${process.pid})`);
    console.log(`  输出目录  ${CFG.outDir}`);
    console.log(`  并发      文件 ${CFG.maxTasks} × 段 ${CFG.segmentsPerFile}，档位 ${CFG.quality}`);
    console.log(`  登录      ${restored ? '已恢复本地令牌' : '需要登录（启动预热中）'}`);
    if (killed) console.log(`  清理      ${killed} 个上次残留的下载进程树`);
    if (pruned) console.log(`  日志      ${pruned} 个过期段日志已清理`);
    console.log('  提示      API 通道会在需要时拉起 Edge（离屏窗口）；关掉本窗口即停服务');
    console.log('');
    if (OPEN_BROWSER) openBrowser(PORT);
    if (CFG.warmBrowserOnStart !== false) setTimeout(warmUp, 600);
  });
  process.on('exit', () => { try { const l = JSON.parse(fs.readFileSync(lockPath(LISTEN_PORT), 'utf8')); if (l.pid === process.pid) fs.rmSync(lockPath(LISTEN_PORT), { force: true }); } catch { /* 忽略 */ } });
  process.on('SIGINT', () => process.exit(0));
}
main().catch((e) => { console.error('[web] ' + e.message); process.exit(1); });
