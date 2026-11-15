// iwaraMachine 面板前端：只做「渲染服务端给的状态 + 发指令」。
// 攒批渲染（rAF）与 SSE 批量下发是另一个项目踩过的坑：逐行插 DOM + 每行读 scrollHeight
// 会强制同步布局，任务一多页面就卡成幻灯片，这里从第一版就避开。
const $ = (s) => document.querySelector(s);
const MB = (n) => (n / 1048576).toFixed(1);
const STATUS_CN = {
  queued: '排队中', resolving: '解析中', downloading: '下载中',
  done: '已完成', failed: '失败', stopped: '已停止', needurl: '重新签名',
};

let meta = {};
let rows = [];
let filter = '';
const logBuf = [];
let logRaf = 0;
let stateRaf = 0;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}

// ------------------------------------------------------------------ 状态渲染
const AUTH_CN = {
  idle: '未登录', starting: '启动浏览器通道', cf: '过 Cloudflare', token: '刷新令牌',
  login: '登录中', ok: '已登录', error: '登录失败',
};
function authBusy() {
  const ph = meta.auth?.phase || 'idle';
  return ph === 'starting' || ph === 'cf' || ph === 'token' || ph === 'login';
}
// 下载 → 压缩流水线的状态文案（与 compressor 的 state 一一对应）
function compressText(c) {
  if (!c || !c.state) return '';
  switch (c.state) {
    case 'pending': return '待交付压缩器';
    case 'queued': return c.position ? `待压缩（队列 #${c.position}）` : '待压缩';
    case 'compressing': return '压缩中';
    case 'done': return c.action === 'moved' ? '原片已归档（没压动）' : `已压缩${c.saved ? `，省 ${MB(c.saved)} MB` : ''}`;
    case 'failed': return `压缩失败${c.note ? '：' + c.note : ''}`;
    case 'canceled': return '压缩已取消';
    default: return c.state;
  }
}
function compressClass(c) {
  if (!c || !c.state) return '';
  if (c.state === 'failed') return 'err';
  if (c.state === 'done') return 'ok';
  if (c.state === 'compressing') return 'active';
  return 'dim';
}

function renderChips() {
  const c = [];
  const a = meta.auth || {};
  const busy = authBusy();
  const authText = busy
    ? `${AUTH_CN[a.phase] || a.phase}… ${a.elapsed ?? 0}s`
    : (meta.loggedIn ? '已登录' : (AUTH_CN[a.phase] || a.phase || '未登录'));
  const pl = meta.pipeline || {};
  const pipeText = `${pl.online ? '在线' : '离线'} · 待压 ${(pl.queued || 0) + (pl.pending || 0)} · 压缩中 ${pl.compressing || 0} · 已归档 ${(pl.archived || 0) + (pl.moved || 0)}${pl.failed ? ` · 失败 ${pl.failed}` : ''}`;
  c.push(`<span class="chip">档位 <b>${meta.quality || '-'}</b></span>`);
  c.push(`<span class="chip">并发 <b>${meta.maxTasks || '-'} 文件 × ${meta.segments || '-'} 段</b></span>`);
  c.push(`<span class="chip">聚合速度 <b>${(meta.speed || 0).toFixed(2)} MB/s</b></span>`);
  c.push(`<span class="chip">在跑 <b>${meta.running || 0}</b> / 队列 <b>${meta.tasks || 0}</b></span>`);
  c.push(`<span class="chip${meta.loggedIn ? '' : ' warn'}" title="${esc(a.detail || '')}">登录 <b>${esc(authText)}</b></span>`);
  const browserText = meta.browserUp ? '在线' : (meta.loggedIn ? '按需启动' : '未启动');
  c.push(`<span class="chip${meta.browserUp ? '' : ' warn'}">浏览器通道 <b>${browserText}</b></span>`);
  c.push(`<span class="chip${pl.online ? '' : ' warn'}" title="${esc(meta.compressorUrl || '')}">压缩器 <b>${esc(pipeText)}</b></span>`);
  $('#chips').innerHTML = c.join('');
  $('#btnRelogin').disabled = busy;
  if (meta.segments) $('#segTip').textContent = meta.segments;
}
function renderRows() {
  const list = $('#list');
  const shown = filter ? rows.filter((r) => r.id === filter) : rows;
  if (!shown.length) {
    list.innerHTML = `<div class="empty">${filter ? '该任务暂无记录' : '队列是空的，把链接粘到上面开始。'}</div>`;
    return;
  }
  list.innerHTML = shown.map((r) => {
    const active = r.status === 'downloading' || r.status === 'resolving';
    const pct = Math.max(0, Math.min(100, r.percent || 0));
    const meta2 = [
      r.author ? `作者 ${r.author}` : '',
      r.total ? `${MB(r.done || 0)}/${MB(r.total)} MB` : '',
      active && r.speed != null ? `${r.speed.toFixed ? r.speed.toFixed(2) : r.speed} MB/s` : '',
      active && r.segAlive ? `在跑段 ${r.segAlive}` : '',
      compressText(r.compress),
      r.compress && r.compress.output ? `→ ${r.compress.output}` : '',
      r.error ? `⚠ ${r.error}` : '',
      r.outFile ? `→ ${r.outFile}` : '',
    ].filter(Boolean).join('   ·   ');
    return `<div class="row ${active ? 'active' : ''} ${r.status}">
      <div class="r-title">${esc(r.title || r.id)}</div>
      <div class="r-right">
        ${r.liked ? '<span class="badge liked">已赞</span>' : ''}
        ${r.compress && r.compress.state ? `<span class="badge ${compressClass(r.compress)}">${esc(compressText(r.compress))}</span>` : ''}
        <span class="badge ${r.status}">${STATUS_CN[r.status] || r.status}</span>
        <span class="pct">${r.total ? pct.toFixed(1) + '%' : (r.done ? MB(r.done) + 'MB' : '-')}</span>
        <button class="ghost" data-retry="${r.id}">重试</button>
        <button class="ghost" data-del="${r.id}">移除</button>
      </div>
      <div class="r-meta">${esc(meta2 || r.id)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('移除该任务？（会终止它的下载进程；已下载的分片会保留，可续传）')) return;
    try { await api('/api/remove', { id: b.dataset.del }); } catch (e) { toast(e.message, 'err'); }
  }));
  list.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/retry', { id: b.dataset.retry }); toast('已重新排队'); } catch (e) { toast(e.message, 'err'); }
  }));
}
function renderOverall() {
  const pct = meta.percent || 0;
  $('#ovBar').style.width = pct + '%';
  $('#ovText').textContent = `${(meta.doneMb || 0).toFixed(1)} / ${(meta.totalMb || 0).toFixed(1)} MB · ${pct.toFixed(1)}%`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function scheduleState() { if (stateRaf) return; stateRaf = requestAnimationFrame(() => { stateRaf = 0; renderChips(); renderRows(); renderOverall(); syncFilter(); }); }
function syncFilter() {
  const sel = $('#logFilter');
  const have = new Set([...sel.options].map((o) => o.value));
  for (const r of rows) {
    if (r.id && !have.has(r.id)) {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = (r.title || r.id).slice(0, 28);
      sel.appendChild(o);
    }
  }
}

// -------------------------------------------------------------------- 日志
function classify(t) {
  if (/❌|失败|错误|异常|放弃|停滞/.test(t)) return 'err';
  if (/✅|完成|成功|点赞 201/.test(t)) return 'ok';
  if (/^\[task\]|启动 \d+ 段|解析完成/.test(t)) return 'sect';
  if (/跳过|续传|已赞/.test(t)) return 'dim';
  return '';
}
function pushLogs(items) {
  for (const it of items) logBuf.push(it);
  if (logRaf) return;
  logRaf = requestAnimationFrame(() => {
    logRaf = 0;
    const log = $('#log');
    const ph = log.querySelector('.ph');
    if (ph) ph.remove();
    const frag = document.createDocumentFragment();
    for (const it of logBuf) {
      if (filter && it.id !== filter) continue;
      const s = document.createElement('span');
      s.className = `l ${classify(it.text)}`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = String(it.id).slice(0, 6);
      const body = document.createElement('span');
      body.textContent = it.text;
      s.append(tag, body);
      frag.appendChild(s);
    }
    logBuf.length = 0;
    if (frag.childElementCount) {
      log.appendChild(frag);
      let over = log.childElementCount - 1200;
      while (over-- > 0) log.removeChild(log.firstElementChild);
      log.scrollTop = log.scrollHeight;
    }
  });
}

// --------------------------------------------------------------------- SSE
let es = null;
let fails = 0;
function connect() {
  es = new EventSource('/api/events');
  es.addEventListener('batch', (ev) => {
    fails = 0;
    for (const m of JSON.parse(ev.data)) {
      if (m.ev === 'state') { rows = m.data.tasks; meta = m.data.meta; scheduleState(); }
      else if (m.ev === 'log') pushLogs([m.data]);
    }
  });
  es.onerror = () => { if (++fails > 4) { es.close(); setTimeout(connect, 4000); fails = 0; } };
}
connect();

// ------------------------------------------------------------------- 交互
$('#btnEnqueue').addEventListener('click', async () => {
  const text = $('#links').value;
  const links = text.split(/[\s,;]+/).filter(Boolean);
  if (!links.length) return toast('先粘贴至少一个链接', 'err');
  try {
    const r = await api('/api/enqueue', { links });
    $('#links').value = '';
    toast(r.added ? `已加入 ${r.added} 个任务` : '没有新任务（可能都已完成或已存在）', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
$('#btnStart').addEventListener('click', () => api('/api/start').then(() => toast('已继续队列', 'ok')).catch((e) => toast(e.message, 'err')));
$('#btnStop').addEventListener('click', () => api('/api/stop', {}).then(() => toast('已请求停止（在跑的分段进程会被终止，进度保留可续）', 'ok')).catch((e) => toast(e.message, 'err')));
$('#btnRelogin').addEventListener('click', async () => {
  try {
    await api('/api/relogin', {});
    toast('已开始重新登录，进度看顶部「登录」芯片');
  } catch (e) { toast(e.message, 'err'); }
});
$('#btnOut').addEventListener('click', () => api('/api/local', { what: 'outdir' }).catch((e) => toast(e.message, 'err')));
$('#btnRetryFailed').addEventListener('click', () => api('/api/retry', {}).then((r) => toast(`已重排 ${r.retried} 个`, 'ok')).catch((e) => toast(e.message, 'err')));
$('#btnClearDone').addEventListener('click', async () => {
  for (const r of rows.filter((x) => x.status === 'done')) { try { await api('/api/remove', { id: r.id }); } catch { /* 忽略 */ } }
  toast('已清除完成任务');
});
$('#dockToggle').addEventListener('click', () => $('#dock').classList.toggle('collapsed'));
$('#logClear').addEventListener('click', () => { $('#log').innerHTML = ''; });
$('#logFilter').addEventListener('change', (e) => { filter = e.target.value; renderRows(); });
$('#btnTheme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('iw-theme', next);
});
if (localStorage.getItem('iw-theme')) document.documentElement.dataset.theme = localStorage.getItem('iw-theme');
$('#links').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#btnEnqueue').click();
});
$('#btnCompressor').addEventListener('click', () => {
  window.open(meta.compressorUrl || 'http://127.0.0.1:8765', '_blank');
});

// ------------------------------------------------------------ 拖拽 / 粘贴入队
// 从 iwara 拖视频卡片或地址栏链接进来，DataTransfer 里通常是 text/uri-list + text/html；
// 只拖缩略图可能只有图片地址，所以这里三种格式都解析，解析不出就给明确提示。
function idsFromText(text) {
  const ids = [];
  for (const line of String(text || '').split(/[\r\n]+/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = /\/video\/([A-Za-z0-9]{6,24})/.exec(s);
    if (m) ids.push(m[1]);
    else if (/^[A-Za-z0-9]{6,24}$/.test(s)) ids.push(s);
  }
  return ids;
}
function idsFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    for (const a of doc.querySelectorAll('a[href]')) out.push(...idsFromText(a.getAttribute('href')));
    return out;
  } catch { return []; }
}
function extractDropped(dt) {
  const ids = new Set();
  for (const id of idsFromText(dt.getData('text/uri-list'))) ids.add(id);
  for (const id of idsFromText(dt.getData('text/plain'))) ids.add(id);
  const html = dt.getData('text/html');
  if (html) for (const id of idsFromHtml(html)) ids.add(id);
  return [...ids];
}
window.__itsExtract = extractDropped;   // 便于在控制台/自动化里验证解析
window.__itsIds = idsFromText;

async function enqueueIds(ids) {
  const links = ids.map((id) => `https://www.iwara.tv/video/${id}`);
  const r = await api('/api/enqueue', { links });
  toast(r.added ? `已加入 ${r.added} 个任务` : '没有新任务（可能都已完成或已存在）', 'ok');
}

let dragDepth = 0;
const dropMask = $('#dropMask');
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer) return;
  const types = Array.from(e.dataTransfer.types || []);
  if (!types.some((t) => ['text/uri-list', 'text/plain', 'text/html', 'Files'].includes(t))) return;
  dragDepth++;
  dropMask.classList.add('show');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropMask.classList.remove('show'); }
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0; dropMask.classList.remove('show');
  const ids = extractDropped(e.dataTransfer);
  if (!ids.length) { toast('没识别到 iwara 视频链接：请拖视频卡片/标题，别只拖缩略图', 'err'); return; }
  try { await enqueueIds(ids); } catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('paste', async (e) => {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return; // 输入框里保留默认粘贴
  const ids = idsFromText(e.clipboardData?.getData('text') || '');
  if (!ids.length) return;
  e.preventDefault();
  try { await enqueueIds(ids); } catch (err) { toast(err.message, 'err'); }
});
