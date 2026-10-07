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
function renderChips() {
  const c = [];
  c.push(`<span class="chip">档位 <b>${meta.quality || '-'}</b></span>`);
  c.push(`<span class="chip">并发 <b>${meta.maxTasks || '-'} 文件 × ${meta.segments || '-'} 段</b></span>`);
  c.push(`<span class="chip">聚合速度 <b>${(meta.speed || 0).toFixed(2)} MB/s</b></span>`);
  c.push(`<span class="chip">在跑 <b>${meta.running || 0}</b> / 队列 <b>${meta.tasks || 0}</b></span>`);
  c.push(`<span class="chip${meta.loggedIn ? '' : ' warn'}">登录 <b>${meta.loggedIn ? '已登录' : '未登录'}</b></span>`);
  c.push(`<span class="chip${meta.browserUp ? '' : ' warn'}">浏览器通道 <b>${meta.browserUp ? '在线' : '未启动'}</b></span>`);
  $('#chips').innerHTML = c.join('');
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
      r.error ? `⚠ ${r.error}` : '',
      r.outFile ? `→ ${r.outFile}` : '',
    ].filter(Boolean).join('   ·   ');
    return `<div class="row ${active ? 'active' : ''} ${r.status}">
      <div class="r-title">${esc(r.title || r.id)}</div>
      <div class="r-right">
        ${r.liked ? '<span class="badge liked">已赞</span>' : ''}
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
  toast('正在通过浏览器通道重新登录…');
  try { await api('/api/relogin', {}); toast('登录完成', 'ok'); } catch (e) { toast(e.message, 'err'); }
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
