@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo [오류] Python을 찾지 못했습니다.
  pause
  exit /b 1
)
title LocalCast AirPlay 테스트
echo [1/2] Windows 방화벽에 AirPlay 허용 (관리자 확인 창이 뜨면 "예")
for /f "delims=" %%i in ('%PY% -c "import sys,os;print(os.path.dirname(sys.executable))"') do set "LC_PYDIR=%%i"
call "bin\firewall_allow.bat"
if errorlevel 1 (
  echo    ※ 허용하지 못했습니다. 관리자 확인 창에서 "예"를 눌러야 합니다.
) else (
  echo    완료
)
echo.
echo [2/2] AirPlay 테스트 — 스피커에서 볼륨 15%%로 10초간 소리가 나야 합니다
echo.
%PY% localcast_helper.py --selftest
echo.
pause
