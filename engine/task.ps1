# =============================================================================
#  task.ps1 —— 一个视频的分段下载编排（由 server.mjs 每个任务起一个子进程）
#
#  输入：-TaskFile 指向 state/tasks/<id>.json，里面必须有 url / size / outFile。
#  退出码：0 完成 / 2 参数或校验失败 / 3 直链失效 / 5 被停止
#          6 资源不存在（CDN 404，重试无意义）
#          7 分段反复停滞（看门狗预算耗尽）
#          9 同一任务已有实例在跑（单实例锁）
#
#  三件事保证"总时长尽可能短且不白干"：
#    1) 分段并发：实测 CDN 按连接限速，8 段近乎线性加速（README 有数据）
#    2) 断点续传：段边界只由 (size, 段数) 决定，.part 落盘长度就是进度，重跑即续
#    3) 父级看门狗：某段 .prog 长时间不前进 → 杀掉那个子进程重开（它自己会从磁盘接着下）
#
#  ⚠️ 实测坑：同一个 TaskFile 被起两个实例时，两边会同时 Create/Append 同一批 .part，
#     谁也下不完，且进度文件互相覆盖 → 界面永远 0%。所以进来先抢锁（state/tasks/<id>.json.lock）。
# =============================================================================
param(
    [Parameter(Mandatory = $true)][string]$TaskFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
Set-DlNets

# ---------------------------------------------------------------- 单实例锁
$lockFile = "$TaskFile.lock"
if ([System.IO.File]::Exists($lockFile)) {
    $oldPid = 0
    [void][int]::TryParse(([System.IO.File]::ReadAllText($lockFile)).Trim(), [ref]$oldPid)
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host ("[task] 已有实例 pid={0} 在处理同一任务，本次退出（防止重复写分片）" -f $oldPid)
        exit 9
    }
    Write-Host ("[task] 清理残留锁（pid={0} 已不存在）" -f $oldPid)
}
[System.IO.File]::WriteAllText($lockFile, "$PID")

try {
    $T = Read-JsonFile $TaskFile
    if (-not $T) { Write-Host "[task] 读不到任务文件 $TaskFile"; exit 2 }
    $segsWanted = [int]$T.segments; if ($segsWanted -lt 1) { $segsWanted = 8 }
    $stall = [int]$T.stallSec; if ($stall -lt 5) { $stall = 20 }
    $size = [long]$T.size
    $outFile = [string]$T.outFile
    $segPs = Join-Path $PSScriptRoot 'segment.ps1'
    $taskId = if ($T.id) { [string]$T.id } else { [System.IO.Path]::GetFileNameWithoutExtension($TaskFile) }
    $segLogDir = Join-Path (Join-Path $PSScriptRoot '..\logs') 'seg'

    function Set-Status($obj) {
        $obj | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Now-Utc) -Force
        Write-JsonFile $TaskFile $obj
    }

    $T | Add-Member -NotePropertyName status -NotePropertyValue 'downloading' -Force
    $T | Add-Member -NotePropertyName error -NotePropertyValue '' -Force
    $T | Add-Member -NotePropertyName startedAt -NotePropertyValue $(if ($T.startedAt) { $T.startedAt } else { (Now-Utc) }) -Force
    Set-Status $T

    function Build-Segs([long]$sz, [int]$n) {
        if ($sz -le 0) { return @([ordered]@{ index = 0; from = 0; to = -1 }) }   # 长度未知：单段取到 EOF
        return @(Split-Range $sz $n)
    }

    $segs = Build-Segs $size $segsWanted
    $total = if ($size -gt 0) { $size } else { 0 }
    $dir = [System.IO.Path]::GetDirectoryName($outFile)
    if (-not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    if (-not [System.IO.Directory]::Exists($segLogDir)) { [System.IO.Directory]::CreateDirectory($segLogDir) | Out-Null }

    # 本任务的段日志占位清理（持锁期间只有我一个写者）
    try { Get-ChildItem -LiteralPath $segLogDir -Filter "$taskId.seg*.log" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }

    $running = @()
    function Stop-Running {
        foreach ($q in $running) { Stop-ProcessTree $q.proc.Id }
    }
    function Fail([int]$Code, [string]$Status, [string]$ErrorText) {
        Stop-Running
        if ($ErrorText) { $T | Add-Member -NotePropertyName error -NotePropertyValue $ErrorText -Force }
        $T | Add-Member -NotePropertyName status -NotePropertyValue $Status -Force
        Set-Status $T
        # 404/410 是终止态：分片永远凑不齐，留着只会堆一堆 0 字节 .part/.prog
        if ($Code -eq 6 -and $outFile) {
            foreach ($s in $segs) {
                foreach ($ext in '', '.prog') {
                    $f = "$outFile.part$($s.index)$ext"
                    if ([System.IO.File]::Exists($f)) { try { [System.IO.File]::Delete($f) } catch { } }
                }
            }
            Write-Host '[task] 已清理该任务的无用分片与进度文件（资源不存在，无法续传）'
        }
        try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } catch { }
        Write-Host ("[task] 结束 status={0} exit={1} {2}" -f $Status, $Code, $ErrorText)
        exit $Code
    }

    function Start-Seg($s) {
        $part = "$outFile.part$($s.index)"
        $segLog = Join-Path $segLogDir ("{0}.seg{1}.log" -f $taskId, $s.index)
        # URL 里有 & 与 = ，交给 Start-Process 必须自己包引号，否则子进程参数会被拆坏
        # （变量名不能用 $args：那是 PowerShell 的自动变量）
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $segPs,
            '-Url', ('"' + $T.url + '"'), '-Part', ('"' + $part + '"'),
            '-From', $s.from, '-To', $s.to, '-StallSec', $stall,
            '-LogFile', ('"' + $segLog + '"'))
        $p = Start-Process powershell.exe -ArgumentList $argList -PassThru -WindowStyle Hidden
        return [pscustomobject]@{ seg = $s; part = $part; proc = $p; lastDone = -1; lastChange = Get-Date; tries = 0 }
    }

    foreach ($s in $segs) { $running += (Start-Seg $s) }
    Write-Host ("[{0}] [task] {1} 启动 {2} 段并发，目标 {3} MB" -f (Now-Utc), $taskId, $running.Count, [Math]::Round($total / 1MB, 1))

    $prevDone = 0; $prevAt = Get-Date; $speed = 0.0
    $committed = 0        # 已结算的分段字节：段完成后会从 $running 里移除，不累加就会把进度条"跳回去"
    $deadline = (Get-Date).AddHours(12)
    $stopped = $false
    $stallRestarts = 0    # 看门狗累计重启次数（跨段累计，必须有上限）
    $segFailures = 0      # 段进程非零退出累计次数

    while ($running.Count -gt 0) {
        Start-Sleep -Milliseconds 700
        if ($T.stopRequested -or [System.IO.File]::Exists((Join-Path $PSScriptRoot '..\state\stop.flag'))) { $stopped = $true }
        if ($stopped) {
            Write-Host ("[task] 收到停止请求，终止 {0} 个分段进程" -f $running.Count)
            Fail 5 'stopped' ''
        }

        $alive = @()
        $liveDone = 0
        foreach ($r in $running) {
            $prog = Read-JsonFile "$($r.part).prog"
            $d = if ($prog) { [long]$prog.done } else { 0 }
            $want = if ($r.seg.to -lt 0) { 0 } else { $r.seg.to - $r.seg.from + 1 }
            # complete 由 segment.ps1 判定：CDN 实际总长可能小于 API 声称的 size，
            # 只看 d -ge want 会让末段永远凑不满 → 无限重试卡住合并
            $progDone = if ($prog) { [bool]$prog.complete } else { $false }
            $finished = $progDone -or ($want -gt 0 -and $d -ge $want) -or ($r.seg.to -lt 0 -and $d -gt 0 -and -not $r.proc.HasExited)

            if ($finished) {
                $committed += $d
                Stop-ProcessTree $r.proc.Id
                continue
            }
            if ($r.proc.HasExited) {
                $r.proc.Refresh()
                $code = try { $r.proc.ExitCode } catch { $null }
                if ($code -eq 6) {
                    Fail 6 'failed' '源文件在 CDN 不存在（HTTP 404/410），Source/转码文件可能已被删除'
                }
                if ($code -eq 3) {
                    Fail 3 'needurl' '直链失效，需要重新签名'
                }
                if ($code -eq 4) {
                    Fail 2 'failed' 'CDN 不支持 Range，分段下载不可用'
                }
                $segFailures++
                if ($segFailures -gt 16) {
                    Fail 7 'failed' ("分段进程累计失败 {0} 次（最近退出码 {1}），放弃" -f $segFailures, $code)
                }
                if ($r.tries -gt 8) {
                    Fail 7 'failed' ("段 {0} 连续失败 {1} 次，放弃" -f $r.seg.index, $r.tries)
                }
                Write-Host ("[task] 段 {0} 退出码 {1}，第 {2} 次重启（从磁盘 {3} 字节续）" -f $r.seg.index, $code, ($r.tries + 1), $d)
                $r = Start-Seg $r.seg
            }
            # 父级看门狗：子进程还活着但进度停滞太久（例如 TCP 半死连接），杀掉重来
            if ($d -ne $r.lastDone) { $r.lastDone = $d; $r.lastChange = Get-Date }
            elseif (((Get-Date) - $r.lastChange).TotalSeconds -gt ($stall * 2)) {
                $stallRestarts++
                if ($stallRestarts -gt 6) {
                    Fail 7 'failed' ("看门狗累计重启 {0} 次仍无进展（疑似 CDN 节点异常或直链不可用）" -f $stallRestarts)
                }
                Write-Host ("[task] 段 {0} 停滞 {1}s 无进展，重启（累计 {2} 次）" -f $r.seg.index, [int]((Get-Date) - $r.lastChange).TotalSeconds, $stallRestarts)
                Stop-ProcessTree $r.proc.Id
                $r = Start-Seg $r.seg
            }
            $liveDone += $d
            $alive += $r
        }
        $running = @($alive)
        $done = $committed + $liveDone

        $now = Get-Date
        $dt = ($now - $prevAt).TotalSeconds
        if ($dt -ge 1) {
            if ($done -ge $prevDone) { $speed = ($done - $prevDone) / 1MB / $dt } else { $speed = 0 }
            $prevDone = $done; $prevAt = $now
        }
        $T | Add-Member -NotePropertyName done -NotePropertyValue $done -Force
        $T | Add-Member -NotePropertyName total -NotePropertyValue $total -Force
        $T | Add-Member -NotePropertyName percent -NotePropertyValue $(if ($total -gt 0) { [Math]::Round($done * 100 / $total, 1) } else { 0 }) -Force
        $T | Add-Member -NotePropertyName speed -NotePropertyValue ([Math]::Round($speed, 2)) -Force
        $T | Add-Member -NotePropertyName segAlive -NotePropertyValue $running.Count -Force
        Set-Status $T
        if ($total -gt 0) {
            Write-Host ("[{0}] {1:N1}%  {2:N1}/{3:N1} MB  {4:N2} MB/s  在跑段 {5}" -f (Now-Utc), $T.percent, ($done / 1MB), ($total / 1MB), $speed, $running.Count)
        } else {
            Write-Host ("[{0}] 已下 {1:N1} MB  {2:N2} MB/s  在跑段 {3}" -f (Now-Utc), ($done / 1MB), $speed, $running.Count)
        }
        if ((Get-Date) -gt $deadline) { Fail 7 'failed' '超过 12 小时仍未完成，放弃' }
    }

    # ---- 合并分片并校验（以分片实际字节为准，API 声称的 size 只做参考）----
    $expect = 0
    foreach ($s in $segs) {
        $p = "$outFile.part$($s.index)"
        if ([System.IO.File]::Exists($p)) { $expect += (New-Object System.IO.FileInfo $p).Length }
    }
    if ($size -gt 0 -and [Math]::Abs($expect - $size) -gt 1048576) {
        Write-Host ("[task] ⚠ 实到 {0} 字节与 API 声称 {1} 相差超 1MB（CDN 与 API 元数据不一致是已知现象），按实到合并" -f $expect, $size)
    }
    $total = $expect
    Write-Host '[task] 全部分段完成，开始合并'
    try {
        $outFs = [System.IO.File]::Create($outFile)
        for ($i = 0; $i -lt $segs.Count; $i++) {
            $part = "$outFile.part$($segs[$i].index)"
            # segment 在 HTTP 416 时会把 From >= serverTotal 的段标记为 complete(done=0,part不存在)
            # → 合并时跳过这些段，按实到为准
            if (-not [System.IO.File]::Exists($part)) {
                Write-Host ("[task] 跳过分片 $part（未命中，属于正常情况）")
                continue
            }
            $inFs = [System.IO.File]::OpenRead($part)
            $inFs.CopyTo($outFs, 1048576)
            $inFs.Close()
            $inFs.Dispose()
        }
        $outFs.Close()
    } catch {
        Fail 2 'failed' ("合并失败: " + $_.Exception.Message)
    }

    $finalLen = (New-Object System.IO.FileInfo $outFile).Length
    if ($expect -gt 0 -and $finalLen -ne $expect) {
        Fail 2 'failed' ("合并后大小不符：分片合计 {0} 实得 {1}，保留分片以便重跑" -f $expect, $finalLen)
    }
    if ($finalLen -le 0) { Fail 2 'failed' '合并结果为空文件（0 字节）' }

    foreach ($s in $segs) {
        foreach ($ext in '', '.prog') {
            $f = "$outFile.part$($s.index)$ext"
            if ([System.IO.File]::Exists($f)) { try { [System.IO.File]::Delete($f) } catch { } }
        }
    }
    # 成功才清段日志；失败保留现场
    try { Get-ChildItem -LiteralPath $segLogDir -Filter "$taskId.seg*.log" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }

    $T | Add-Member -NotePropertyName status -NotePropertyValue 'done' -Force
    $T | Add-Member -NotePropertyName done -NotePropertyValue $finalLen -Force
    $T | Add-Member -NotePropertyName total -NotePropertyValue $finalLen -Force
    $T | Add-Member -NotePropertyName percent -NotePropertyValue 100 -Force
    $T | Add-Member -NotePropertyName speed -NotePropertyValue 0 -Force
    $T | Add-Member -NotePropertyName segAlive -NotePropertyValue 0 -Force
    Set-Status $T
    Write-Host ("[task] 完成 -> {0}（{1:N1} MB）" -f $outFile, ($finalLen / 1MB))
    exit 0
} catch {
    Write-Host ("[task] 未捕获异常: " + $_.Exception.Message)
    try { if ($T) { $T | Add-Member -NotePropertyName status -NotePropertyValue 'failed' -Force; $T | Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message -Force; Set-Status $T } } catch { }
    exit 2
} finally {
    try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } catch { }
}
