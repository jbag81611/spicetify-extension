@echo off
rem LocalCast: Windows Firewall check/fix (admin prompt only when something must be fixed)
set "LC_EXE=%~dp0lc_airplay.exe"
set "LC_FW=%~dp0firewall_fix.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%LC_FW%" -Exe "%LC_EXE%" -PyDir "%LC_PYDIR%" >nul 2>&1
if not errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $q=[char]34; $a='-NoProfile -ExecutionPolicy Bypass -File '+$q+$env:LC_FW+$q+' -Exe '+$q+$env:LC_EXE+$q+' -PyDir '+$q+$env:LC_PYDIR+$q+' -Apply'; Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList $a } catch { }"
powershell -NoProfile -ExecutionPolicy Bypass -File "%LC_FW%" -Exe "%LC_EXE%" -PyDir "%LC_PYDIR%" >nul 2>&1
exit /b %errorlevel%
