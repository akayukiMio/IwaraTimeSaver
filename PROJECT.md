# IwaraTimeSaver — 项目文档（面向接手的 AI/开发者）

> 读本文件即可上手，无需通读源码。所有实测结论都标了「实测」，是踩过之后固化下来的，别重复验证。
> 本项目**实验性**、与同机 `beidewu` 画廊搬运工具链**完全解耦**：不共用代码、配置、状态、git 仓库。

## 0. 接手必读（30 秒）

1. 改动 `E:\administrator\1!5!\script\IwaraTimeSaver` 下任何文件前，先读本文件 **§0 + §6**。本文件是唯一真值源。
2. **参数只改 `config.local.json`**（不入库）。`engine/lib.ps1` 里不放业务参数。
3. **API 调用只能在 Node 侧经 `engine/browser.mjs` 发出**；PowerShell 只负责拉 CDN 字节。原因见 §6 坑 1（Cloudflare）。**不要试图用 .NET/Node 直连 api.iwara.tv。**
4. 两层只通过 `state/tasks/<id>.json` 一个文件通信：Node 写输入（url/size/outFile/段数），`task.ps1` 回写进度。任何一方重启都不丢进度。
5. 改完任何 `.ps1` 必须补 BOM 并做语法检查（本项目没有 beidewu 那套工具，用 §7 的一行命令）。PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码 → 中文乱码甚至假语法错。
6. 运行环境是 **Windows PowerShell 5.1**：语句分隔用 `;`；路径含 `[...]`（视频标题里就有）必须 `-LiteralPath`；不要用 `[System.IO.Path]::Exists`（5.1 没有这个方法）。
7. **凭据边界**：`config.local.json`（邮箱/密码）、`state/tokens.json`、`state/edgeprofile/`、`logs/`、下载产物 全部 `.gitignore` 排除。
8. 数据红线：输出目录 `E:\administrator\iwara-out` 里的文件是用户资产，任何流程不得静默删除/覆盖已完成文件（重名靠 `[id]` 后缀天然去重）。

## 1. 目的

给一批 iwara 视频链接，自动：**以用户账号点赞** → 解析 **Source 原片**直链 → **分段并发下载**（带断点续传、看门狗、直链过期自愈）→ 合并校验。
交互形态：本地浏览器面板（`http://127.0.0.1:8811/`），零 npm 依赖。

## 2. 目录

```
IwaraTimeSaver/
├─ start.vbs                    ★双击入口（无窗口后台启动）
├─ start.cmd                    调试入口（会出命令行窗口）
├─ config.local.json            ★参数与凭据（不入库）
├─ .gitignore                   防手滑
├─ server/
│  ├─ server.mjs                面板服务：队列/调度/SSE/静态资源/单实例锁
│  └─ public/                   index.html + app.js + theme.css（无 CDN，攒批渲染）
├─ engine/
│  ├─ browser.mjs               ★Edge + CDP 会话：唯一能过 Cloudflare 的 API 通道
│  ├─ hide_window.ps1           把 Edge 窗口从任务栏摘掉（WS_EX_TOOLWINDOW）
│  ├─ task.ps1                  单视频编排：分段并发 + 父级看门狗 + 合并校验
│  ├─ segment.ps1               单段下载：Range 续传 + 卡死超时重试 + 完成判定
│  └─ lib.ps1                   .NET 下载工具集（网络基线/JSON 读写/文件名清洗/分段切分）
├─ state/
│  ├─ tokens.json               access/refresh token（不入库）
│  ├─ queue.json                任务队列持久化（重启自动重新排队）
│  ├─ tasks/<id>.json           单任务：输入 + 进度（两层通信载体）
│  ├─ edgeprofile/              Edge 持久 profile（Cloudflare clearance 存在这里）
│  └─ stop.flag                 存在即请求所有下载进程停止
─ logs/                        panel.log（面板日志，必须落盘）+ 探针记录
└─ README.md                    面向人的说明 + 实测事实表
```

## 3. 标准工作流

```powershell
# 日常：双击 start.vbs（无窗口后台启动），浏览器里粘贴链接 → 加入队列并开始
# 调试：双击 start.cmd（会出命令行窗口）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8811/api/enqueue `
  -ContentType 'application/json' -Body '{"links":["https://www.iwara.tv/video/<id>/x"]}'
Invoke-RestMethod http://127.0.0.1:8811/api/state        # 看队列与进度
Invoke-RestMethod -Method Post http://127.0.0.1:8811/api/stop   # 停止（进度保留，可续）
```
更省事的两种入队方式（面板前端）：

- 从 iwara 把**视频卡片/标题**拖到面板任意位置，松手即入队（多选一起拖也行）；
- 复制视频链接后，在页面任意位置 `Ctrl+V` 直接入队。

下载完成后会自动交给 video_compressor 压缩，见 §3.1。
首次启动会在第一个任务时拉起一个**离屏 Edge 窗口**（`--window-position=-32000,-32000`）用于过 Cloudflare，之后一直复用；那个窗口不要手动关，关了会自动重开。面板启动会自动预热登录（`warmBrowserOnStart`），并优先复用 `state/tokens.json` 里的令牌——正常情况下打开面板就是“已登录”，不需要再点「重新登录」。

### 3.1 下载 → 压缩 → 归档（自动交接）

```
iwara 卡片/链接
   │ 拖拽 / Ctrl+V
   ▼
ITS 8811     解析 → 点赞 → 8 段下载
   │ 任务 done
   ▼ POST http://127.0.0.1:8765/api/handoff
compressor 8765   持久队列 → 串行压缩
   ├─ 压小：产物进 F:\\fumofumo_4，源进回收站
   ├─ 没压动：产物丢弃，源搬到 F:\\fumofumo_4（平铺）
   └─ 出错：源留在 iwara-out，标 failed 等重试
   ▼
ITS 每 5s 拉 /api/handoff，任务行显示 待压/压缩中/已归档/失败
```

- `iwara-out` 在流程结束后只应剩下“正在下载”或“压缩失败”的文件；
- 压缩器没开时 ITS 自动用 `video_compressor\web\run_web.py --no-browser` 拉起（不抢浏览器焦点）；
- 交接幂等键 = 视频 ID，重复投递返回 409，不会压两遍；
- 压缩状态以压缩器队列为唯一真值源，ITS 只负责投递与展示；
- ITS 重启时会把“已下载但没交付”的任务补投一次。

配置项：`compressorUrl` / `compressorDir` / `autoHandoff` / `autoStartCompressor`。

## 4. 模块职责与关键参数

### `config.local.json`
`email` `password` `apiBase` `outDir` `quality`(Source) `maxTasks`(文件级并发) `segmentsPerFile`(段数) `segmentStallSec`(卡死阈值) `webPort` `cdpPort` `likeBeforeDownload`
`warmBrowserOnStart`(启动预热登录，默认 true) `formLoginFallback`(表单登录回退，默认 false) `staleProgressSec`(进度多久没更新算僵死，默认 180) `apiFetchTimeoutMs`(页面内 fetch 硬超时，默认 30000) `logMaxMb`(单日志上限，默认 8)
`compressorUrl`(压缩器地址，默认 http://127.0.0.1:8765) `compressorDir`(video_compressor 绝对路径) `autoHandoff`(下载完成自动交付压缩，默认 true) `autoStartCompressor`(压缩器没开就代拉起，默认 true)

### `engine/browser.mjs`
- `Browser.start({profileDir,port})`：找不到可调试实例就起一个；等 CDP 端口就绪；导航到 iwara 并轮询标题直到过 CF
- `apiFetch(method, path|url, {body,token})`：在页面上下文里 `fetch`，自动补 `X-Version`/`X-Site`/`Referer`/`Authorization`；**内置 `_probe()` 活体探测**，CDP 断了自动重连
- `login(email,pw)`：`POST /user/login` → `{token:<refresh JWT>}` → `POST /user/token` → `accessToken`；失败才退到表单自动化
- `hideTaskbar()`：调 `hide_window.ps1` 把 Edge 窗口从任务栏摘掉
- `X-Version = SHA1("{路径末段}_{expires}_{密钥}")`，无 `expires` 时该位置是**空串**

### `server/server.mjs`
- 队列：`state/queue.json`；重启时把 `downloading/resolving` 一律改回 `queued`（分片还在磁盘，续传）
- 调度：`maxTasks` 个文件级并发；每个任务 `spawn powershell -File engine/task.ps1 -TaskFile ...`
- 进度：每秒回读 `state/tasks/<id>.json` → 合并进内存 → 3s 一次 SSE 广播（**批量下发，不逐行**）
- 直链自愈：`task.ps1` 退出码 3 → 重新解析拿新签名 URL → 重跑（最多 3 次）
- **断线自愈**：`ensureLogin()` 内置 `_probe()` 前置探测 + 两次重试；`apiFetch` 页面内 `fetch` 带 `apiFetchTimeoutMs` 硬超时，超时/CDP 异常一律 `hardRestartBrowser()`——按 CDP 端口 `taskkill /T /F` 杀掉整个浏览器进程树再重拉（复用只 ping 端口会卡在同一个病态实例上，见 §6 坑 22）
- 接口：`/api/state` `/api/events`(SSE) `/api/enqueue` `/api/start` `/api/stop` `/api/retry` `/api/remove` `/api/relogin` `/api/local` `/api/shutdown` `/api/whoami`
- **压缩流水线**：任务 `done` → `POST {compressorUrl}/api/handoff`（幂等键=视频ID）→ 每 5s 拉 `/api/handoff` 合并状态；压缩器离线时置 `pending` 并每 30s 补投；`autoStartCompressor` 时用 `video_compressor/web/run_web.py --no-browser` 代拉起
- 单一真值源：压缩状态以压缩器队列为准，ITS 只展示；结果写回任务的 `compress` 字段（`pending/queued/compressing/done/failed` + `action=deleted|moved`）
- 只绑 `127.0.0.1`，端口固定不顺延 + `state/web_<port>.lock` + whoami 探活复用

### `engine/task.ps1` / `engine/segment.ps1`
- 段边界只由 `(size, 段数)` 决定 → 重跑即续传；每段独立 `.part` + `.part.prog`
- `segment.ps1` 退出码：`0 完成 / 1 重试耗尽 / 3 直链失效 / 4 不支持 Range / 6 资源不存在(404/410)`
- `task.ps1` 退出码：`0 完成 / 2 失败 / 3 需重签 / 5 停止 / 6 资源不存在 / 7 反复停滞 / 9 锁冲突`
- 单实例锁：`state/tasks/<id>.json.lock` 存 task.ps1 的 pid；同一任务第二个实例直接 exit 9
- 段日志：`logs/seg/<id>.seg<n>.log`（失败保留、成功删除），404/超时原因写进 `.prog` 的 `lastError`
- 完成判定以 **CDN 的 `Content-Range` 总量**为准（见 §6 坑 2），`.prog.complete` 是 task.ps1 唯一的完成信号
- **CDN size 不匹配处理**：API 的 `file.size` 可能比 CDN 实际字节大，合并时跳过不存在的 `.part`，按实到为准

## 5. 命名与数据约定

产物：`<outDir>\<标题>[<视频ID>].mp4`；标题里的 `\ / : * ? " < > |` 换成 `_`，超 120 字截断。视频直接存放 outDir 根目录，不按作者分文件夹。
状态取值：`queued → resolving → downloading → done | failed | stopped`。

## 6. 必须知道的坑（都是实测踩过的）

1. **Cloudflare 挡的是整个 `api.iwara.tv`**：.NET/Node 直连一律 `403 + "Just a moment..."`；`--headless=new` 也过不去。只有**有头浏览器 + 持久 profile** 能过，所以 API 必须在页面上下文里发。顺带：`POST /user/login` 在页面里能直接过，**不需要 Turnstile**。
2. **API 的 `file.size` 比 CDN 实际字节大**（实测 288318914 vs 288302958，差 15956；也有差 27% 的极端案例）。以 API 大小判定"下完了"会让**最后一段永远凑不满 → 无限重试 → 卡住合并**。一律以 CDN 的 `Content-Range` 总量为准；提前到 EOF 或收到 416 都算完成。合并时跳过不存在的 `.part`。
3. **`POST /video/{id}/like` 疑似切换语义**：必须先读 `liked`，为 `true` 就跳过，否则会把已有的赞点掉。
4. **登录响应字段是 `token` 不是 `accessToken`**：`{token:<refresh>}` → 再 `POST /user/token`（`Authorization: Bearer <refresh>`）换 access。误判字段名会让人以为登录失败。
5. **Node 的 `fetch` 不读 Windows 系统代理**：所以字节层交给 .NET（默认走系统代理，实测 127.0.0.1:7897 生效）。别为了"统一技术栈"把下载搬进 Node。
6. **CDN 按连接限速**（实测单连接 0.12–0.24 MB/s；8 段并发 2.2–2.74 MB/s）。所以"分段"不是优化项而是必需项；但**文件级并发要压低**（默认 2），否则只会互相挤 + 增加中断面。
7. **`task.ps1` 的进度必须被服务端回读**：只让子进程写文件、服务端不读，界面就会永远停在 0%（真踩过）。
8. **服务重启后不要直接重跑成两个 `task.ps1`**：`loadQueue()` 会把 `downloading` 改回 `queued`，但前提是**旧子进程已经杀掉**（`taskkill /T`）。两个进程写同一批 `.part` 会写坏文件。
9. **PowerShell 里不要用 `$args` 当变量名**（自动变量）；函数返回 `byte[]` 要 `return , $bytes` 否则被输出流展开成 `Object[]`。
10. **面板服务必须把日志写文件**（`logs/panel.log`）：它是从隐藏窗口起的，不落盘就只能靠猜。
11. **用 `exit` 而不是 `close` 判子进程结束**：子进程还会继承 stdout 管道，`close` 要等所有继承句柄释放，表现为"早就完事了但状态还挂着"。
12. **Edge 窗口任务栏占位**：`--window-position=-32000,-32000` 只是把窗口挪到屏幕外，任务栏按钮还在。用 `hide_window.ps1`（Win32 API：WS_EX_TOOLWINDOW + SetParent）摘掉。
13. **`_probe()` 判定 bug**：`evalJs()` 返回的是解包后的原始值（`1+1` 直接得 `2`），不是 `{result:{value:2}}`。判定必须写 `rb === 2`，不能写 `rb?.result?.value === 2`（恒 false → 永远误报 dead）。
14. **CDN 直链 404 ≠ 直链过期**：某视频 Source/360/540 同时 404 而 preview 仍 206，说明文件已从 CDN 删除（API 元数据还在）。`segment.ps1` 必须 exit 6、`task.ps1` 直接 failed；当成可重试会 8 段×50 次 + 看门狗无限重启，能空转到 12 小时。修好后实测 2.6 秒失败。
15. **`HttpWebResponse` 没有 `ContentRange` 属性**：老代码 `$resp.ContentRange` 恒为 `$null`，`.prog` 里 `serverTotal` 永远是 -1，“以 CDN 实长判定完成”那条规则其实从没生效，全靠末段撞 416 兜底。必须解析 `$resp.Headers['Content-Range']`。
16. **`kill()` 不杀进程树**：`t.childProc.kill()` 只终止 `powershell.exe`，`Start-Process` 出来的 `segment.ps1` 变孤儿继续写同一批 `.part`。实测一次“删除重建”留下 4 个 task.ps1 + 32 个 segment.ps1，8 个 `.part` 全 0 字节、进度永远 0%。规则：停止/移除/重试/退出一律 `taskkill /PID <pid> /T /F`；`task.ps1` 必须持单实例锁。
17. **ESM 里没有 `require`**：`browser.mjs` 的 `hideTaskbar()` 曾写 `require('child_process')`，每次抛 ReferenceError 又被 `try{}catch{}` 吞掉 → 窗口其实从没藏住。用文件顶部 `import { spawnSync }`。
18. **`tokens.json` 只写不读 = 每次重启都要重登**：access token 只有 1 小时。启动时恢复 access、过期用 refresh token 换，才能“打开面板就能用”；`/api/relogin` 只应该是兜底。
19. **CDP 调用必须整体有界**：`_send` 默认 90 秒、`_probe` 又等 `evalJs`，页面一卡就让“解析中”挂两分钟。探测必须在 5 秒内给出结论并重连；`_connect` 要先摘掉旧 WS 的 `onmessage` 再 close，否则旧连接的迟到消息会和新一轮 id 撞车。
20. **404 是终止态，分片没有续传价值**：`task.ps1` 在 exit 6 时会顺手删掉本任务的 `.part`/`.prog`，避免输出目录里堆一堆 0 字节文件。需要保留现场时看 `logs/seg/<id>.seg<n>.log`。
21. **Win11 任务栏闪红**：只给窗口加 `WS_EX_TOOLWINDOW` 不够——离屏窗口仍可能被算进 Edge 分组，网页弹 alert/通知时任务栏图标会一直闪“请求注意”，点它（窗口在屏幕外）也消不掉。`hide_window.ps1` 现在同时做：`ShowWindow(SW_HIDE)` 整窗隐藏 + `ITaskbarList::DeleteTab` 删任务栏按钮 + `FlashWindow(FALSE)` 停闪；Edge 启动参数加 `--disable-notifications` 并关掉后台节流；CDP 侧自动 `Page.handleJavaScriptDialog` 接收弹窗；`server.mjs` 每 2 分钟重新隐藏一次（用户点任务栏把窗口叫回来也能收回去）。隐藏后 `document.visibilityState=hidden`，但 CDP 求值和定时器实测正常（1s 定时器 ~1.0s 触发）。
22. **常驻浏览器“进程活但网络死”会让任务永久卡在 resolving**（实测）：Edge 页面偶尔会进入“同步 JS 正常（`1+1`/`document.title` 秒回）、但页面内任何 `fetch` 全部挂起不返回”的状态（连 example.com 都挂，而同机 .NET 走同一代理秒回，说明是那个标签页自己的网络栈卡死）。ITS 所有 API 调用都是页面内 `fetch`，`Runtime.evaluate(awaitPromise:true)` 会一直等到 90s CDP 超时 → `CDP 超时: Runtime.evaluate`。旧的自愈逻辑有两个叠加缺陷使其永不恢复：① `_probe()` 只跑同步 `1+1`，探不到网络死；② 失败只 `browser=null`，`Browser.start` 一 ping 通 9333 端口就 `reused` 回同一个病态进程（`reused=true` 也不会被杀）。**根治**：页面内 `fetch` 加 `AbortController` 硬超时（`apiFetchTimeoutMs`，默认 30s，挂起即返回 `status:0`）；`apiFetch`/`doLogin` 一旦 `status:0` 或 CDP 异常就 `hardRestartBrowser()`——按 CDP 端口 `netstat` 反查主进程 PID 再 `taskkill /T /F` 杀整个进程树（只杀我们这个 `--user-data-dir` 实例，不碰用户其它 Edge 窗口），下次 `getBrowser` 自然起干净实例。重启后靠 profile 里的 CF clearance 快速过盾。若新实例仍全部 fetch 挂 → 是代理（127.0.0.1:7897）对浏览器流量黑洞，切换/重启代理节点即可。
23. **同步 `spawnSync` 会冻结整个 Node 事件循环 → 面板/SSE 假死**（实测）：`browser.mjs` 的 `hideTaskbar()`（每 2 分钟 re-hide + 每次重连都调）和 `killInstance()` 原先都用 `spawnSync` 跑 PowerShell/netstat。`spawnSync` 是同步的，会把 ITS 整个事件循环堵死到子进程返回（上限 10s）；机器一忙（ffmpeg 压缩 + 8 段下载打满 CPU/磁盘）PowerShell 冷启动能被拖好几秒，期间 `/api/state`、SSE 全不响应 → “前端整个卡住”。**根治**：这两处改成异步 `spawn`（fire-and-forget），`killInstance` 返回 Promise、`hardRestartBrowser` 里 `await`；re-hide 定时器在“有任务在跑/正在重启通道”时跳过；`pollProgress`（每秒）里的僵死回收 `killTree` 也换成非阻塞 `killTreeAsync`（用户主动的停止/移除/重试/退出仍用同步 `killTree`，保证退出前确实杀干净）。（压缩器侧也有同型 bug，见其仓库：`/api/handoff` 的 `enqueue`/`snapshot` 直接在事件循环里做持锁的同步磁盘写 `_save`，磁盘饱和时冻死 FastAPI；ITS→压缩器的调用全是带硬超时的异步 fetch，所以压缩器卡死不会直接死锁 ITS 事件循环，只会让 ITS 显示“压缩器离线/pending”。）

## 7. 常见任务配方

| 需求 | 做法 |
|---|---|
| 改并发/段数 | 改 `config.local.json` 的 `maxTasks` / `segmentsPerFile`，重启面板 |
| 换档位（不要 Source） | 改 `quality`（`Source`/`540`/`360`） |
| 只下载不点赞 | 改 `config.local.json` 的 `likeBeforeDownload=false`（重启面板生效，日志会打"配置关闭了自动点赞，跳过"） |
| 补跑中断的任务 | 直接重启面板：队列自动重新排队，`.part` 从断点续 |
| 令牌失效/被登出 | 面板点「重新登录」，或 `POST /api/relogin`（立即 202，进度看顶部芯片） |
| 日志占空间 | `logs\panel.log` 超过 `logMaxMb`(默认 8MB) 自动轮转为 `panel.log.1`；`logs\seg\` 只保留 7 天，成功任务的段日志即时删除 |
| 清掉某个任务的残留分片 | 删 `E:\administrator\iwara-out\*<视频ID>*.part*`（先确保该任务没在跑） |
| 关掉自动压缩 | `autoHandoff=false` 后重启面板；下载完只留在 `iwara-out`，不再投递 |
| 压缩器离线/没启动 | 正常会自动拉起；仍失败看 `video_compressor\web\.run\backend.log`，或手动 `python web\run_web.py --no-browser` |
| 查看/取消压缩队列 | `GET http://127.0.0.1:8765/api/handoff`；`POST http://127.0.0.1:8765/api/handoff/<job_id>/cancel` |
| 手动补交一个已完成文件 | `POST http://127.0.0.1:8765/api/handoff`，body `{"job_id":"<视频ID>","paths":["<mp4>"],"source_dir":"E:\\administrator\\iwara-out"}` |
| CF 一直过不去 | 删 `state/edgeprofile/` 后重启，第一次手动在弹出的 Edge 窗口里过一次 |
| 改完 .ps1 的校验 | `Get-ChildItem -Recurse -Filter *.ps1 \| % { [IO.File]::WriteAllText($_.FullName, [IO.File]::ReadAllText($_.FullName, (New-Object Text.UTF8Encoding $false)), (New-Object Text.UTF8Encoding $true)) }` 补 BOM，再用 `Parser::ParseFile` 查语法 |
| 单视频手工验证 | `powershell -File engine\task.ps1 -TaskFile state\tasks\<id>.json` |

## 8. 依赖

- Windows PowerShell 5.1（系统自带）
- Node v20+（实测 v24；只用内置模块 + 全局 WebSocket，**无 npm 依赖**）
- Microsoft Edge 或 Chrome（过 Cloudflare 用，路径自动探测）
- `ffmpeg`/`ffprobe`（可选，仅用于校验产物完整性）
- `video_compressor`（可选：自动压缩流水线；不装就把 `autoHandoff` 设为 false）

## 9. 当前状态基线（2026-11-15）

- 端到端已跑通 25 个视频，其中 12 个 CDN 实际字节数小于 API 声称 size（整体比例 80.5%），全部按实到合并成功
- 点赞已真实生效多次；后续任务对已赞视频会跳过（日志"已经赞过了，跳过"）
- 断点续传路径已被真实覆盖：服务被 kill 后重启，`.part` 从断点续
- 断线自愈已验证：Edge 窗口被关/CDP 超时后，`ensureLogin()` 自动杀浏览器重拉 + re-hide
- 任务栏隐藏已验证：Edge 窗口启动后自动从任务栏摘掉（`hide 1+ window(s)`）；2026-11-15 修掉了 ESM 里 `require` 未定义导致 hide 静默失效的问题
- 登录体验：启动恢复 `tokens.json` → 预热登录 → 面板直接显示“已登录”；`/api/relogin` 立即 202，进度在顶部芯片按阶段+秒数走
- 卡死防护：单实例锁、`taskkill /T` 回收进程树、`staleProgressSec` 僵死检测、看门狗总预算、404 直接失败（实测 2.6s）
- 磁盘：`logs\panel.log` 达 `logMaxMb` 自动轮转；`logs\seg\` 保留 7 天；状态/日志/Edge profile 全在项目目录（E 盘），不占 C 盘
- 工作流整合（2026-11-15）：拖拽/粘贴入队 → 下载完成自动交付 video_compressor（含代拉起）→ 压小则删源、没压动则把原片搬进存储目录，`iwara-out` 结束即空
- 交接实测：压缩器离线时 ITS 4 秒内拉起并投递；产物写 `F:\fumofumo_4`、源进回收站；重复投递返回 409 不重复压
- 进度条修复：`pollProgress()` 对 `status === 'done'` 的任务也回读 `total`，CDN 实到写回后进度条到 100%
- `config.local.json` 的全部字段均已接线；面板日志落盘 `logs\panel.log` 已验证
- 桌面快捷方式：`start.vbs`（无窗口后台启动）+ `iwaraMachine.ico`（多尺寸标准 ICO）

## 10. 版本管理与对外边界

- 与 `beidewu` 画廊工具链的关系：**只共享经验，不共享代码**。本项目复用了它的三条结论（.NET 走系统代理、状态以磁盘为准、SSE/DOM 攒批），但目录、配置、状态、进程完全独立。
- 与 `video_compressor` 的关系：**契约式对接**，不合并代码库。ITS 只在任务完成时 `POST /api/handoff`，并用 `GET /api/handoff` 同步状态；压缩器负责排队、压缩、删源/搬原片。两边各自独立仓库、独立进程。
- GitHub 仓库：`https://github.com/akayukiMio/IwaraTimeSaver.git`
