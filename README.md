# IwaraTimeSaver

iwara 视频批量下载工具：自动点赞 → 解析 Source 原片 → 分段并发下载 → 合并校验。

## 特性

- **Cloudflare 绕过**：通过 Edge CDP 通道发起 API 请求，无需手动过验证
- **登录态持久化**：令牌落盘并在启动时恢复，打开面板即“已登录”，无需每次点重新登录
- **分段并发下载**：8 段并发，聚合吞吐可达单连接的 7 倍
- **断点续传**：中断后从 `.part` 续传，不丢进度
- **直链自愈**：签名过期自动重新获取
- **断线自愈**：Edge 窗口被关/CDP 超时后自动重连
- **卡死防护**：单实例锁 + 进程树回收 + 僵死检测；已删源（404）秒级失败而不是空转 12 小时
- **任务栏隐藏**：Edge 窗口自动从任务栏摘掉，不干扰桌面
- **拖拽 / 粘贴入队**：把 iwara 视频卡片拖进面板，或复制链接后 Ctrl+V，直接加入下载
- **自动交接压缩**：下载完成自动交给 video_compressor 压缩（压缩器没开会自动拉起）；压小则删源、没压动则把原片搬进存储目录
- **本地面板**：`http://127.0.0.1:8811/`，零 npm 依赖

## 快速开始

1. 克隆仓库
2. 复制 `config.local.json.example` → `config.local.json`，填入 iwara 账号密码
3. 双击 `start.vbs`（无窗口后台启动）或 `start.cmd`（调试模式，会出命令行窗口）
4. 浏览器自动打开 `http://127.0.0.1:8811/`，把 iwara 视频卡片拖进页面（或复制链接后 `Ctrl+V`）

## 工作流

```
iwara 卡片/链接 ──拖拽/Ctrl+V──▶ ITS 8811：点赞 → 解析 → 8 段下载
                                      │ 下载完成（done）
                                      ▼
                          video_compressor 8765：排队 → 压缩
                                      │
                     ┌────────────────┴────────────────┐
                压小了                              没压动/出错
        产物进存储目录、源删进回收站         产物丢弃、源原样搬进存储目录（出错则保留待重试）
                                      │
                                      ▼
                        ITS 面板显示 待压/压缩中/已归档/失败
```

- 压缩器没启动时 ITS 会自动拉起（`run_web.py --no-browser`），不需要先打开 8765；
- `iwara-out` 在流程结束后只剩“下载中”或“压缩失败”的文件；
- 压缩参数在 video_compressor 的面板里改，ITS 只读展示；
- 不想自动压缩就把 `config.local.json` 的 `autoHandoff` 设为 `false`。

## 技术栈

- **Node.js**（v20+，零 npm 依赖）：面板服务 + Edge CDP 通道
- **PowerShell 5.1** + **.NET**：CDN 分段下载（走系统代理）
- **Microsoft Edge**：过 Cloudflare 挑战
- **video_compressor**（可选，独立仓库）：接收交接并压缩，契约式对接不共用代码

## 项目结构

```
IwaraTimeSaver/
├─ start.vbs              ★双击入口（无窗口后台启动）
├─ start.cmd              调试入口（会出命令行窗口）
├─ config.local.json      参数与凭据（不入库）
├─ server/                面板服务
├─ engine/                下载引擎（browser.mjs + task.ps1 + segment.ps1）
├─ state/                 运行时状态（不入库）
└─ logs/                  日志（不入库）
```

## 注意事项

- API 的 `file.size` 可能比 CDN 实际字节大，下载器以 CDN 的 `Content-Range` 为准
- 点赞有切换语义，已赞视频会自动跳过
- 输出目录：`E:\administrator\iwara-out\`（视频直接存放根目录，不按作者分文件夹）
- 日志：`logs\panel.log`（满 `logMaxMb` 自动轮转）、`logs\seg\<id>.seg<n>.log`（失败现场，保留 7 天）
- 所有状态、日志、Edge profile 都在项目目录（E 盘），不写 C 盘；`.part` 分片只在任务未完成时存在于输出目录，成功后自动删除

## License

MIT
