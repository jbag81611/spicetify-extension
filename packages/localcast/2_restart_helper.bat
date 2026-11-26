@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo [오류] Python을 찾지 못했습니다. python.org 에서 Python 3.12 이상을 설치하세요.
  echo        설치 첫 화면에서 "Add python.exe to PATH" 체크 필수!
  pause
  exit /b 1
)
echo config.json 을 바꾼 뒤에는 이걸 실행하세요.
%PY% autostart.py restart
timeout /t 3 >nul
