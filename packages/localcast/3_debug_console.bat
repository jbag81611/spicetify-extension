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
echo 문제 확인용: 보조 프로그램을 창에 띄워 실행합니다. (창을 닫으면 꺼짐)
echo 확인이 끝나면 창을 닫고 2_restart_helper.bat 을 실행하세요.
%PY% autostart.py stop
title LocalCast 보조 프로그램 (문제 확인용)
%PY% localcast_helper.py
pause
