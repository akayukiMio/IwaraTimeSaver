# =============================================================================
#  hide_window.ps1 —— 把 CDP 通道的 Edge 窗口从任务栏彻底摘掉（或放回来）
#
#  为什么需要：--window-position=-32000,-32000 只是把窗口挪到屏幕外，任务栏上那个按钮
#  还在；而已有的按钮光加 WS_EX_TOOLWINDOW 在 Win11 上不一定消失（实测会留一个
#  “1 个运行窗口”分组，网页请求注意时还会闪）。所以这里三件事一起做：
#    1) WS_EX_TOOLWINDOW + SetWindowPos(SWP_FRAMECHANGED) 刷新扩展样式
#    2) ITaskbarList::DeleteTab 直接删掉任务栏按钮（最可靠）
#    3) FlashWindow(hwnd, FALSE) 停掉任何“请求注意”的闪烁
#
#  用法：
#    powershell -File engine\hide_window.ps1 -Port 9333 -Action hide
#    powershell -File engine\hide_window.ps1 -Port 9333 -Action show
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
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr h, bool invert);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x0080;
    public const int WS_EX_APPWINDOW = 0x00040000;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;

    [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ITaskbarList {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
    }

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
    public class CTaskbarList { }
}
'@

# ---- 1) 端口 → 拥有它的进程（Edge 主进程）----
$owner = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess)
if ($owner.Count -eq 0) { Write-Output 'no-listener'; exit 0 }
$pids = @($owner | ForEach-Object { [uint32]$_ })

# ---- 2) 枚举该进程的顶层窗口（Chrome_WidgetWin_*，含无标题的弹窗）----
$hits = New-Object System.Collections.Generic.List[IntPtr]
$cb = [Win32Taskbar+EnumProc] {
    param($h, $l)
    $p = [uint32]0
    [void][Win32Taskbar]::GetWindowThreadProcessId($h, [ref]$p)
    if ($pids -notcontains $p) { return $true }
    $cls = New-Object System.Text.StringBuilder 256
    [void][Win32Taskbar]::GetClassName($h, $cls, 256)
    if ($cls.ToString() -like 'Chrome_WidgetWin*') { $hits.Add($h) | Out-Null }
    return $true
}
[void][Win32Taskbar]::EnumWindows($cb, [IntPtr]::Zero)

$taskbar = $null
try {
    $taskbar = New-Object Win32Taskbar+CTaskbarList
    $taskbar.HrInit()
} catch { $taskbar = $null }

$changed = 0
foreach ($h in $hits) {
    $ex = [Win32Taskbar]::GetWindowLong($h, [Win32Taskbar]::GWL_EXSTYLE)
    if ($Action -eq 'hide') {
        $new = ($ex -bor [Win32Taskbar]::WS_EX_TOOLWINDOW) -band (-bnot [Win32Taskbar]::WS_EX_APPWINDOW)
    } else {
        $new = ($ex -bor [Win32Taskbar]::WS_EX_APPWINDOW) -band (-bnot [Win32Taskbar]::WS_EX_TOOLWINDOW)
    }
    if ($new -ne $ex) {
        [void][Win32Taskbar]::SetWindowLong($h, [Win32Taskbar]::GWL_EXSTYLE, $new)
        $changed++
    }
    # 刷新窗口框架，让样式立即生效
    [void][Win32Taskbar]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0,
        ([Win32Taskbar]::SWP_NOMOVE -bor [Win32Taskbar]::SWP_NOSIZE -bor [Win32Taskbar]::SWP_NOZORDER -bor [Win32Taskbar]::SWP_NOACTIVATE -bor [Win32Taskbar]::SWP_FRAMECHANGED))
    # 停掉“请求注意”的闪烁（网页弹窗/通知最容易让它一直闪）
    [void][Win32Taskbar]::FlashWindow($h, $false)
    # 整窗隐藏：只剩工具窗样式不够，Win11 仍可能留分组/闪红
    [void][Win32Taskbar]::ShowWindow($h, $(if ($Action -eq 'hide') { 0 } else { 5 }))
    if ($taskbar) {
        try {
            if ($Action -eq 'hide') { $taskbar.DeleteTab($h) } else { $taskbar.AddTab($h) }
        } catch { }
    }
    # 关键一步：不改父窗口也得改一次，否则任务栏上已经画出来的按钮不会消失
    [void][Win32Taskbar]::SetParent($h, [IntPtr]::Zero)
}
Write-Output ("{0} {1} window(s)" -f $Action, $hits.Count)
