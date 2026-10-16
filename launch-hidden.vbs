Option Explicit
' 无窗口启动 bridge（安装.cmd 会把开始菜单快捷方式指到这里）
Dim sh, fso, root, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
cmd = "node """ & root & "\lib\start.mjs"""
sh.Run cmd, 0, False
