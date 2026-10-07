' start.vbs —— 以隐藏窗口启动 node 服务，不弹命令行窗口
' 桌面快捷方式指向本文件即可实现"无窗口"启动
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server\server.mjs --open", 0, False
