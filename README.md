# IwaraTimeSaver

iwara 视频批量下载工具：自动点赞 → 解析 Source 原片 → 分段并发下载 → 合并校验。

## 特性

- **Cloudflare 绕过**：通过 Edge CDP 通道发起 API 请求，无需手动过验证
- **分段并发下载**：8 段并发，聚合吞吐可达单连接的 7 倍
- **断点续传**：中断后从 `.part` 续传，不丢进度
- **直链自愈**：签名过期自动重新获取
- **断线自愈**：Edge 窗口被关/CDP 超时后自动重连
- **任务栏隐藏**：Edge 窗口自动从任务栏摘掉，不干扰桌面
- **本地面板**：`http://127.0.0.1:8811/`，零 npm 依赖

## 快速开始

1. 克隆仓库
2. 复制 `config.local.json.example` → `config.local.json`，填入 iwara 账号密码
3. 双击 `start.cmd`
4. 浏览器打开 `http://127.0.0.1:8811/`，粘贴视频链接 → 加入队列

## 技术栈

- **Node.js**（v20+，零 npm 依赖）：面板服务 + Edge CDP 通道
- **PowerShell 5.1** + **.NET**：CDN 分段下载（走系统代理）
- **Microsoft Edge**：过 Cloudflare 挑战

## 项目结构

```
IwaraTimeSaver/
├─ start.cmd              双击入口
├─ config.local.json      参数与凭据（不入库）
├─ server/                面板服务
├─ engine/                下载引擎（browser.mjs + task.ps1 + segment.ps1）
├─ state/                 运行时状态（不入库）
└─ logs/                  日志（不入库）
```

## 注意事项

- API 的 `file.size` 可能比 CDN 实际字节大，下载器以 CDN 的 `Content-Range` 为准
- 点赞有切换语义，已赞视频会自动跳过
- 输出目录：`E:\administrator\iwara-out\`

## License

MIT
