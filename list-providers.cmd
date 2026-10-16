@echo off
chcp 65001 >nul
node "%~dp0lib\list-providers.mjs" %*
pause
