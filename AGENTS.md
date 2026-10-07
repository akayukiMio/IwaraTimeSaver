# 接手本项目的 AI：先读这里

无论你是新会话还是零上下文接手，**动手前先读** [`PROJECT.md`](./PROJECT.md) 的 **§0 接手必读** 与 **§6 必须知道的坑**（13 条，全部实测踩过）。
`PROJECT.md` 是唯一真值源；参数只改 `config.local.json`。不要通读源码自行推断设计。

## 本项目最容易反复踩的四条（务必先看）

1. **不要直连 `api.iwara.tv`**。整站挂在 Cloudflare 后面，.NET/Node 直连一律 403 挑战页，headless 也过不去。API 只能在 `engine/browser.mjs` 的页面上下文里发。
2. **不要用 API 的 `file.size` 判定下载完成**。它可能比 CDN 实际字节大（实测差 15956 字节，也有差 27% 的极端案例），会让末段无限重试卡死合并。以 CDN 的 `Content-Range` 总量为准；合并时跳过不存在的 `.part`。
3. **点赞有切换语义**：先读 `liked`，已赞就跳过，否则会把赞点掉。
4. **改完 `.ps1` 必补 UTF-8 BOM 并做语法检查**（PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码）。命令见 `PROJECT.md` §7。

## 与其他项目的关系

`E:\administrator\1!5!\script\beidewu`（画廊搬运工具链）是**另一个独立项目**：不共用代码、配置、状态或 git。本项目只借鉴它三条经验——.NET 走系统代理、状态以磁盘为准、SSE/DOM 攒批。

## 凭据与边界

`config.local.json`（账号密码）、`state/`（令牌、Edge profile、任务）、`logs/`、输出目录全部不入库；`.gitignore` 已排除。绝不把凭据写进代码、文档或提交记录。

## GitHub

仓库：`https://github.com/akayukiMio/IwaraTimeSaver.git`
提交身份：直接用本机全局 git 配置（user.name=akayukiMio，user.email=1981797716@qq.com）。
