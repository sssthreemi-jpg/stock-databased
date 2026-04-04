@echo off
cd /d %~dp0
echo Starting auto-deploy watcher...
powershell -ExecutionPolicy Bypass -File "%~dp0watch.ps1"
pause
