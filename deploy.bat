@echo off
cd /d %~dp0
git add -A
set /p msg=커밋 메시지 입력 (엔터시 "update"):
if "%msg%"=="" set msg=update
git commit -m "%msg%"
git push
echo.
echo 완료! 아무 키나 누르면 창이 닫힙니다.
pause > nul
