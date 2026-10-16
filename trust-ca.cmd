@echo off
chcp 65001 >nul
node "%~dp0lib\trust-ca.mjs" add
pause
