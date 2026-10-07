# =============================================================================
#  segment.ps1 —— 下载一个字节区间 [From,To] 到 .part 文件（可反复重启续传）
#
#  退出码约定（task.ps1 依赖它做决策，别改）：
#    0 完成   1 重试耗尽   3 直链失效(403/410，需要重新签名)   4 服务端不支持 Range
#
#  ⚠️ 实测坑：API 的 file.size 可能比 CDN 实际字节数**大**（本次 288318914 vs 288302958，
#     差 15956 字节）。以 API 大小为准会让最后一段永远凑不满 → 无限重试、卡住合并。
#     所以本段是否"完成"一律以 CDN 给的 Content-Range 总量为准；提前到 EOF 也算完成。
#
#  看门狗做法：把 ReadWriteTimeout 当成"零字节多久算卡死"。.NET 在超时后让 Read 抛异常，
#  我们关掉请求、从当前已落盘长度重新发 Range —— 这就是浏览器做不到、需要手点"继续"的那件事。
# =============================================================================
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Part,
    [Parameter(Mandatory = $true)][long]$From,
    [Parameter(Mandatory = $true)][long]$To,
    [int]$StallSec = 20,
    [int]$MaxTries = 50
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Set-DlNets

$want = if ($To -lt 0) { -1 } else { $To - $From + 1 }     # -1 = 长度未知，取到 EOF
$progPath = "$Part.prog"
$tries = 0
$startedAt = Get-Date
$serverTotal = -1                                          # CDN 报的真实总长

function Write-Prog([long]$done, [double]$speed, [bool]$complete) {
    Write-JsonFile $progPath ([ordered]@{
        done = $done; from = $From; to = $To; speed = [Math]::Round($speed, 2)
        tries = $tries; complete = $complete; serverTotal = $serverTotal; at = (Now-Utc)
    })
}

while ($true) {
    $tries++
    $done = 0
    if ([System.IO.File]::Exists($Part)) { $done = (New-Object System.IO.FileInfo $Part).Length }
    $fs = $null
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
        if ($code -eq 416) {
            # HTTP 416: 请求范围超出 CDN 实际字节数
            # 这说明 API 声称的 size 比 CDN 给的实际多，本段 From 起点已经超过了真实文件尾
            # → 这段不用下，标记为完成（done=0, complete=true）
            $resp.Close(); Write-Prog $done 0 $true; exit 0
        }
        if ($code -eq 403 -or $code -eq 410) { 
            $resp.Close(); 
            Write-Prog $done 0 $false; 
            exit 3 
        }
        if ($resp.ContentRange -gt 0) { $serverTotal = [long]$resp.ContentRange }

        if ($want -gt 0 -and $code -eq 200) {
            # 要了 Range 却给 200 = 不支持分段；只有第 0 段能这么用
            $resp.Close()
            if ($From -eq 0) { Write-Prog $done 0 $false; exit 0 }
            Write-Prog $done 0 $false
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
                Write-Prog $done $(if ($secs -gt 0) { ($done - $lastDone) / 1MB / $secs } else { 0 }) $false
                $lastBeat = Get-Date; $lastDone = $done
            }
            if ($want -gt 0 -and $done -ge $want) { break }
        }
        $fs.Flush($true); $fs.Close(); $st.Close(); $resp.Close()
        $fs = $null

        if ($want -gt 0 -and $done -ge $want) { Write-Prog $done 0 $true; exit 0 }
        # CDN 真实总长比 API 声称的小：本段读到 EOF 就是读完了
        if ($eof -and $serverTotal -gt 0 -and ($From + $done) -ge $serverTotal) {
            Write-Host ("[{0}] seg{1} CDN 实际总长 {2} < 预期 {3}，本段按完成处理" -f (Now-Utc), $From, $serverTotal, ($To + 1))
            Write-Prog $done 0 $true; exit 0
        }
        if ($want -lt 0 -and $done -gt 0) { Write-Prog $done 0 $true; exit 0 }
        throw "流提前结束（done=$done want=$want eof=$eof serverTotal=$serverTotal）"
    } catch {
        try { if ($fs) { $fs.Close() } } catch { }
        Write-Host ("[{0}] seg{1} 第 {2} 次中断：{3}" -f (Now-Utc), $From, $tries, $_.Exception.Message)
        Write-Prog $done 0 $false
        if ($tries -ge $MaxTries) { exit 1 }
        if ((Get-Date) - $startedAt -gt (New-TimeSpan -Hours 6)) { exit 1 }
        Start-Sleep -Seconds ([Math]::Min(15, 2 + $tries % 10))
    }
}
