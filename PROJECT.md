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
├─ start.cmd                    ★双击入口（起面板 + 开浏览器）
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
# 日常：双击 start.cmd，浏览器里粘贴链接 → 加入队列并开始
# 命令行等价：
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8811/api/enqueue `
  -ContentType 'application/json' -Body '{"links":["https://www.iwara.tv/video/<id>/x"]}'
Invoke-RestMethod http://127.0.0.1:8811/api/state        # 看队列与进度
Invoke-RestMethod -Method Post http://127.0.0.1:8811/api/stop   # 停止（进度保留，可续）
```
首次启动会在第一个任务时拉起一个**离屏 Edge 窗口**（`--window-position=-32000,-32000`）用于过 Cloudflare，之后一直复用；那个窗口不要手动关，关了会自动重开。

## 4. 模块职责与关键参数

### `config.local.json`
`email` `password` `apiBase` `outDir` `quality`(Source) `maxTasks`(文件级并发) `segmentsPerFile`(段数) `segmentStallSec`(卡死阈值) `webPort` `cdpPort` `likeBeforeDownload`

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
- **断线自愈**：`ensureLogin()` 内置 `_probe()` 前置探测 + 两次重试，CDP 死了自动杀浏览器重拉
- 接口：`/api/state` `/api/events`(SSE) `/api/enqueue` `/api/start` `/api/stop` `/api/retry` `/api/remove` `/api/relogin` `/api/local` `/api/shutdown` `/api/whoami`
- 只绑 `127.0.0.1`，端口固定不顺延 + `state/web_<port>.lock` + whoami 探活复用

### `engine/task.ps1` / `engine/segment.ps1`
- 段边界只由 `(size, 段数)` 决定 → 重跑即续传；每段独立 `.part` + `.part.prog`
- `segment.ps1` 退出码：`0 完成 / 1 重试耗尽 / 3 直链失效 / 4 不支持 Range`
- 完成判定以 **CDN 的 `Content-Range` 总量**为准（见 §6 坑 2），`.prog.complete` 是 task.ps1 唯一的完成信号
- **CDN size 不匹配处理**：API 的 `file.size` 可能比 CDN 实际字节大，合并时跳过不存在的 `.part`，按实到为准

## 5. 命名与数据约定

产物：`<outDir>\<作者>\<标题>[<视频ID>].mp4`；标题里的 `\ / : * ? " < > |` 换成 `_`，超 120 字截断。
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

## 7. 常见任务配方

| 需求 | 做法 |
|---|---|
| 改并发/段数 | 改 `config.local.json` 的 `maxTasks` / `segmentsPerFile`，重启面板 |
| 换档位（不要 Source） | 改 `quality`（`Source`/`540`/`360`） |
| 只下载不点赞 | 改 `config.local.json` 的 `likeBeforeDownload=false`（重启面板生效，日志会打"配置关闭了自动点赞，跳过"） |
| 补跑中断的任务 | 直接重启面板：队列自动重新排队，`.part` 从断点续 |
| 令牌失效/被登出 | 面板点「重新登录」，或 `POST /api/relogin` |
| CF 一直过不去 | 删 `state/edgeprofile/` 后重启，第一次手动在弹出的 Edge 窗口里过一次 |
| 改完 .ps1 的校验 | `Get-ChildItem -Recurse -Filter *.ps1 \| % { [IO.File]::WriteAllText($_.FullName, [IO.File]::ReadAllText($_.FullName, (New-Object Text.UTF8Encoding $false)), (New-Object Text.UTF8Encoding $true)) }` 补 BOM，再用 `Parser::ParseFile` 查语法 |
| 单视频手工验证 | `powershell -File engine\task.ps1 -TaskFile state\tasks\<id>.json` |

## 8. 依赖

- Windows PowerShell 5.1（系统自带）
- Node v20+（实测 v24；只用内置模块 + 全局 WebSocket，**无 npm 依赖**）
- Microsoft Edge 或 Chrome（过 Cloudflare 用，路径自动探测）
- `ffmpeg`/`ffprobe`（可选，仅用于校验产物完整性）

## 9. 当前状态基线（2026-10-08）

- 端到端已跑通 25 个视频，其中 12 个 CDN 实际字节数小于 API 声称 size（整体比例 80.5%），全部按实到合并成功
- 点赞已真实生效多次；后续任务对已赞视频会跳过（日志"已经赞过了，跳过"）
- 断点续传路径已被真实覆盖：服务被 kill 后重启，`.part` 从断点续
- 断线自愈已验证：Edge 窗口被关/CDP 超时后，`ensureLogin()` 自动杀浏览器重拉 + re-hide
- 任务栏隐藏已验证：Edge 窗口启动后自动从任务栏摘掉（`hide 3 window(s)`）
- 进度条修复：`pollProgress()` 对 `status === 'done'` 的任务也回读 `total`，CDN 实到写回后进度条到 100%
- `config.local.json` 的全部字段均已接线；面板日志落盘 `logs\panel.log` 已验证
- 桌面快捷方式：`start.cmd` + `iwaraMachine.ico`（多尺寸标准 ICO）

## 10. 版本管理与对外边界

- 与 `beidewu` 画廊工具链的关系：**只共享经验，不共享代码**。本项目复用了它的三条结论（.NET 走系统代理、状态以磁盘为准、SSE/DOM 攒批），但目录、配置、状态、进程完全独立。
- GitHub 仓库：`https://github.com/akayukiMio/IwaraTimeSaver.git`
