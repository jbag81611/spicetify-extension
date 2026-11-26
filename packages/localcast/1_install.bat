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
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 (
  echo [오류] Python 3.11 이상이 필요합니다.
  pause
  exit /b 1
)
echo.
echo [1/5] 필요한 라이브러리 설치 중...
%PY% -m pip install --upgrade -r requirements.txt
if errorlevel 1 (
  echo [오류] 라이브러리 설치 실패. 인터넷 연결을 확인하세요.
  pause
  exit /b 1
)
echo.
echo [2/5] Spicetify 확장 복사 중...
if not exist "%APPDATA%\spicetify\Extensions" mkdir "%APPDATA%\spicetify\Extensions"
copy /Y "localcast.js" "%APPDATA%\spicetify\Extensions\localcast.js" >nul
echo.
echo [3/5] Spicetify에 적용 중... (Spotify가 다시 켜집니다)
call spicetify config extensions localcast.js
call spicetify apply
echo.
echo [4/5] Windows 방화벽 확인·수정 (막혀 있을 때만 관리자 확인 창 → "예")
for /f "delims=" %%i in ('%PY% -c "import sys,os;print(os.path.dirname(sys.executable))"') do set "LC_PYDIR=%%i"
call "bin\firewall_allow.bat"
if errorlevel 1 echo    ※ 허용하지 못했습니다. 나중에 5_airplay_test.bat 을 실행해 "예"를 눌러주세요.
echo.
echo [5/5] 보조 프로그램을 창 없이 실행하고, PC 켤 때 자동 실행 등록...
%PY% autostart.py on
echo.
echo Spotify 다시 켜는 중... (새 확장 적용)
taskkill /IM Spotify.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
if exist "%APPDATA%\Spotify\Spotify.exe" (
  start "" "%APPDATA%\Spotify\Spotify.exe"
) else (
  start "" "spotify:"
)
echo.
echo ===== 설치 완료 =====
echo 설치 위치: %~dp0
echo 이제 따로 켤 창은 없습니다. 이 창은 3초 뒤 자동으로 닫힙니다.
timeout /t 3 /nobreak >nul
exit
