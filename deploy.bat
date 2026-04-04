@echo off
cd /d %~dp0
git add -A
git commit -m "update"
git push
echo.
echo Push complete!
pause
