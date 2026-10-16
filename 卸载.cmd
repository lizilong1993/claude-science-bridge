@echo off
chcp 65001 >nul
node "%~dp0lib\shortcut.mjs" uninstall
pause
