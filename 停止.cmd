@echo off
chcp 65001 >nul
node "%~dp0lib\stop.mjs" %*
pause
