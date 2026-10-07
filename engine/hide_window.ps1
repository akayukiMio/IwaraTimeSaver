# =============================================================================
#  hide_window.ps1 —— 把 CDP 通道的 Edge 窗口从任务栏摘掉（或放回来）
#
#  为什么需要：--window-position=-32000,-32000 只是把窗口挪到屏幕外，任务栏上那个按钮
#  还在，等于一直占一格。Windows 的正规做法是给窗口加 WS_EX_TOOLWINDOW 扩展样式
#  （工具窗口按设计不进任务栏），并且**必须再 SetParent 一次**才会刷新已画出来的任务栏按钮。
#
#  用法：
#    powershell -File engine\hide_window.ps1 -Port 9333 -Action hide
#    powershell -File engine\hide_window.ps1 -Port 9333 -Action show
#
#  端口 → 进程 → 窗口：CDP 监听端口就是那个 Edge 主进程持有的，所以不用猜标题。
#  注意参数名不能叫 $Pid（PowerShell 自动变量）。
# =============================================================================
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [ValidateSet('hide', 'show')][string]$Action = 'hide'
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32Taskbar {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int v);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x0080;
    public const int WS_EX_APPWINDOW = 0x00040000;
}
'@

# ---- 1) 端口 → 拥有它的进程（Edge 主进程）----
$owner = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess)
if ($owner.Count -eq 0) { Write-Output 'no-listener'; exit 0 }
$pids = @($owner | ForEach-Object { [uint32]$_ })

# ---- 2) 枚举该进程的顶层窗口，改扩展样式 ----
$hits = New-Object System.Collections.Generic.List[IntPtr]
$cb = [Win32Taskbar+EnumProc] {
    param($h, $l)
    $p = [uint32]0
    [void][Win32Taskbar]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -notcontains $p) { return $true }
    $cls = New-Object System.Text.StringBuilder 256
    [void][Win32Taskbar]::GetClassName($h, $cls, 256)
    # Chromium 系主框架窗口类名固定是 Chrome_WidgetWin_1；只处理有标题的那个
    if ($cls.ToString() -eq 'Chrome_WidgetWin_1' -and [Win32Taskbar]::GetWindowTextLength($h) -gt 0) {
        $hits.Add($h) | Out-Null
    }
    return $true
}
[void][Win32Taskbar]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($h in $hits) {
    $ex = [Win32Taskbar]::GetWindowLong($h, [Win32Taskbar]::GWL_EXSTYLE)
    if ($Action -eq 'hide') {
        $new = ($ex -bor [Win32Taskbar]::WS_EX_TOOLWINDOW) -band (-bnot [Win32Taskbar]::WS_EX_APPWINDOW)
    } else {
        $new = ($ex -bor [Win32Taskbar]::WS_EX_APPWINDOW) -band (-bnot [Win32Taskbar]::WS_EX_TOOLWINDOW)
    }
    if ($new -ne $ex) { [void][Win32Taskbar]::SetWindowLong($h, [Win32Taskbar]::GWL_EXSTYLE, $new) }
    # 关键一步：不改父窗口也得改一次，否则任务栏上已经画出来的按钮不会消失
    [void][Win32Taskbar]::SetParent($h, [IntPtr]::Zero)
}
Write-Output ("{0} {1} window(s)" -f $Action, $hits.Count)
