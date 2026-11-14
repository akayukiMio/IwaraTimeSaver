# =============================================================================
#  segment.ps1 —— 下载一个字节区间 [From,To] 到 .part 文件（可反复重启续传）
#
#  退出码约定（task.ps1 / server.mjs 依赖它做决策，别改）：
#    0 完成
#    1 重试耗尽（网络类，可重来）
#    3 直链失效(401/403，需要重新签名)
#    4 服务端不支持 Range（分段下载不可用）
#    6 资源不存在(404/410)：重试无意义，视频文件在 CDN 上已经没了
#
#  ⚠️ 实测坑 1：API 的 file.size 可能比 CDN 实际字节数**大**（288318914 vs 288302958，
#     也见过差 27%）。以 API 大小为准会让最后一段永远凑不满 → 无限重试、卡住合并。
#     完成判定一律以 CDN 的 Content-Range 总量为准；提前到 EOF 也算完成。
#  ⚠️ 实测坑 2：HttpWebResponse **没有** ContentRange 属性（老代码 `$resp.ContentRange`
#     恒为 $null → serverTotal 永远是 -1，上面那条规则其实从没生效过）。必须自己解析
#     Headers['Content-Range']。
#  ⚠️ 实测坑 3：404 曾被当成“可重试”，于是 8 段各重试 50 次、task.ps1 再无限重启，
#     一个已删源的视频能耗满 12 小时。404/410 必须立刻终止。
# =============================================================================
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Part,
    [Parameter(Mandatory = $true)][long]$From,
    [Parameter(Mandatory = $true)][long]$To,
    [int]$StallSec = 20,
    [int]$MaxTries = 50,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Set-DlNets

$want = if ($To -lt 0) { -1 } else { $To - $From + 1 }     # -1 = 长度未知，取到 EOF
$progPath = "$Part.prog"
$tries = 0
$startedAt = Get-Date
$serverTotal = -1                                          # CDN 报的真实总长

function Say([string]$Text) {
    $line = ('[{0}] seg[{1}] {2}' -f (Now-Utc), $From, $Text)
    Write-Host $line
    if ($LogFile) { Append-Log $LogFile $line }
}

function Write-Prog([long]$Done, [double]$Speed, [bool]$Complete, [string]$Note) {
    Write-JsonFile $progPath ([ordered]@{
        done = $Done; from = $From; to = $To; speed = [Math]::Round($Speed, 2)
        tries = $tries; complete = $Complete; serverTotal = $serverTotal
        lastError = $Note; pid = $PID; at = (Now-Utc)
    })
}

while ($true) {
    $tries++
    $done = 0
    if ([System.IO.File]::Exists($Part)) { $done = (New-Object System.IO.FileInfo $Part).Length }
    $fs = $null
    $resp = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = 'GET'
        $req.UserAgent = $script:DlUa
        $req.Referer = 'https://www.iwara.tv/'
        $req.Timeout = 30000
        $req.ReadWriteTimeout = ($StallSec * 1000)
        if ($want -gt 0) { $req.AddRange($From + $done, $To) }
        elseif ($done -gt 0) { $req.AddRange($done, $To) }

        try {
            $resp = $req.GetResponse()
        } catch [System.Net.WebException] {
            $resp = $_.Exception.Response
            if (-not $resp) { throw }
        }
        $code = [int]$resp.StatusCode

        # ---- 终止类状态：不要重试，立刻带码退给 task.ps1 ----
        if ($code -eq 416) {
            # 请求范围超出 CDN 实际字节数：API size 比实到大，本段已到实尾
            $resp.Close(); Say 'HTTP 416，本段已到 CDN 实尾'
            Write-Prog $done 0 $true 'HTTP 416 范围已满足'
            exit 0
        }
        if ($code -eq 404 -or $code -eq 410) {
            $resp.Close()
            Say ("HTTP {0} 资源不存在：该视频在 CDN 上已无文件（Source/转码可能已被删除）" -f $code)
            Write-Prog $done 0 $false ("HTTP {0} 资源不存在" -f $code)
            exit 6
        }
        if ($code -eq 401 -or $code -eq 403) {
            $resp.Close()
            Say ("HTTP {0} 直链失效，交回上层重新签名" -f $code)
            Write-Prog $done 0 $false ("HTTP {0} 直链失效" -f $code)
            exit 3
        }
        if ($code -eq 429 -or $code -ge 500) {
            $resp.Close()
            Say ("HTTP {0} 服务端临时错误，退避后重试" -f $code)
            Write-Prog $done 0 $false ("HTTP {0} 服务端临时错误" -f $code)
            Start-Sleep -Seconds ([Math]::Min(30, 3 + $tries))
            continue
        }

        # ---- 真实总长：必须自己解析响应头（HttpWebResponse 没有 ContentRange 属性）----
        $cr = $resp.Headers['Content-Range']
        if ($cr) {
            $m = [regex]::Match([string]$cr, '/(\d+)\s*$')
            if ($m.Success) { $serverTotal = [long]$m.Groups[1].Value }
        } elseif ($code -eq 200 -and $resp.ContentLength -ge 0) {
            $serverTotal = [long]$resp.ContentLength
        }

        if ($want -gt 0 -and $code -eq 200) {
            # 要了 Range 却给 200 = 不支持分段；单段整取会把 8 段全下成同一个文件，必须拒绝
            $resp.Close()
            Say 'CDN 不支持 Range（返回 200），分段下载不可用'
            Write-Prog $done 0 $false 'HTTP 200 不支持 Range'
            exit 4
        }

        $fs = [System.IO.File]::Open($Part, $(if ($done -gt 0) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }))
        $st = $resp.GetResponseStream()
        $buf = New-Object byte[] 262144
        $lastBeat = Get-Date; $lastDone = $done; $eof = $false
        while ($true) {
            $n = $st.Read($buf, 0, $buf.Length)
            if ($n -le 0) { $eof = $true; break }
            $fs.Write($buf, 0, $n)
            $done += $n
            if (((Get-Date) - $lastBeat).TotalMilliseconds -ge 800) {
                $fs.Flush($true)
                $secs = ((Get-Date) - $lastBeat).TotalSeconds
                Write-Prog $done $(if ($secs -gt 0) { ($done - $lastDone) / 1MB / $secs } else { 0 }) $false ''
                $lastBeat = Get-Date; $lastDone = $done
            }
            if ($want -gt 0 -and $done -ge $want) { break }
        }
        $fs.Flush($true); $fs.Close(); $st.Close(); $resp.Close()
        $fs = $null; $resp = $null

        if ($want -gt 0 -and $done -ge $want) { Write-Prog $done 0 $true ''; exit 0 }
        # CDN 真实总长比 API 声称的小：读到 EOF 就是读完了（现在这条真的会生效）
        if ($eof -and $serverTotal -gt 0 -and ($From + $done) -ge $serverTotal) {
            Say ("CDN 实际总长 {0} < 预期 {1}，本段按完成处理" -f $serverTotal, ($To + 1))
            Write-Prog $done 0 $true ''
            exit 0
        }
        if ($want -lt 0 -and $eof -and $done -gt 0) { Write-Prog $done 0 $true ''; exit 0 }
        throw "流提前结束（done=$done want=$want eof=$eof serverTotal=$serverTotal）"
    } catch {
        try { if ($fs) { $fs.Close() } } catch { }
        try { if ($resp) { $resp.Close() } } catch { }
        $msg = $_.Exception.Message
        Say ("第 {0} 次中断：{1}" -f $tries, $msg)
        Write-Prog $done 0 $false $msg
        if ($tries -ge $MaxTries) { Say ("重试耗尽（{0} 次），放弃本段" -f $MaxTries); exit 1 }
        if (((Get-Date) - $startedAt) -gt (New-TimeSpan -Hours 6)) { Say '超过 6 小时，放弃本段'; exit 1 }
        Start-Sleep -Seconds ([Math]::Min(15, 2 + $tries % 10))
    }
}
