# =============================================================================
#  lib.ps1 —— .NET 侧下载工具集（被 segment.ps1 / task.ps1 dot-source）
#
#  ⚠️ 这里**不放任何 iwara API 调用**。实测 api.iwara.tv 全站挂在 Cloudflare 后面，
#     .NET/Node 直连一律 403 挑战页，只有常驻 Edge 的页面上下文能过 —— 所以 API 全部
#     在 engine/browser.mjs 里做，PowerShell 只负责拉 CDN 字节。别再把 HTTP 调用加回来。
# =============================================================================

$script:DlRoot = Split-Path -Parent $PSScriptRoot
$script:DlUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function Set-DlNets {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    [Net.ServicePointManager]::DefaultConnectionLimit = 64
    [Net.ServicePointManager]::Expect100Continue = $false
}

# 原子写：先写同目录 .tmp，再 Replace/Move。直接 WriteAllText 会被并发读方读到半截
# JSON（服务端 readJson 拿到 null → 进度当 0 → 看门狗误杀），实锤过。
function Write-JsonFile([string]$Path, $Object) {
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    $text = $Object | ConvertTo-Json -Depth 8 -Compress
    $tmp = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText($tmp, $text, $enc)
    try {
        if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($tmp, $Path, $null) }
        else { [System.IO.File]::Move($tmp, $Path) }
    } catch {
        # 目标被占用/Move 竞态：退化为覆盖写，但至少不留下半截 tmp
        try { [System.IO.File]::Copy($tmp, $Path, $true) } catch { }
        try { [System.IO.File]::Delete($tmp) } catch { }
    }
}
function Read-JsonFile([string]$Path) {
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    try { return ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)) } catch { return $null }
}
function Now-Utc { return [DateTime]::UtcNow.ToString('HH:mm:ss') }

# PowerShell 5.1 没有原生日志；段进程的 stdout 走隐藏窗口，看不见 → 必须落盘
function Append-Log([string]$Path, [string]$Text) {
    if (-not $Path) { return }
    try {
        $dir = [System.IO.Path]::GetDirectoryName($Path)
        if ($dir -and -not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
        [System.IO.File]::AppendAllText($Path, $Text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# 杀整棵进程树：Stop-Process 只杀 powershell.exe 本身，Start-Process 出来的
# segment.ps1 会变成孤儿继续写 .part —— 这正是“删了重建还是卡”的元凶。
function Stop-ProcessTree([int]$ProcessId) {
    if (-not $ProcessId -or $ProcessId -le 0) { return }
    try { & taskkill.exe /PID $ProcessId /T /F *> $null } catch { }
}

# Windows 文件名清洗：非法字符 -> _，并压掉首尾空白与点
function Get-SafeName([string]$Text) {
    $t = ($Text -replace '[\\/:*?"<>|]', '_').Trim()
    $t = ($t -replace '\s+', ' ').TrimEnd('.')
    if (-not $t) { $t = 'untitled' }
    if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }
    return $t
}

# 把一个大文件按段切开；返回 @{index; from; to} 数组。边界只由 (size, segCount) 决定，
# 所以中断后重算得到的是同一套边界 —— 断点续传的前提。
function Split-Range([long]$Size, [int]$Count) {
    if ($Count -lt 1) { $Count = 1 }
    if ($Size -le 0) { return @(@{ index = 0; from = 0; to = -1 }) }   # 未知长度：整文件单段
    if ($Count -gt $Size) { $Count = [int]$Size }
    $each = [Math]::Floor($Size / $Count)
    $segs = @()
    for ($i = 0; $i -lt $Count; $i++) {
        $from = [long]($i * $each)
        $to = if ($i -eq $Count - 1) { $Size - 1 } else { [long](($i + 1) * $each - 1) }
        $segs += [ordered]@{ index = $i; from = $from; to = $to }
    }
    return $segs
}
