# packages/localcast → 처음 설치용 파일 하나(LocalCast_Setup.bat). 사용: python3 tools/make_localcast_setup.py [출력경로]
# (C:\LocalCast 를 전부 지우고 새로 설치 + 1_install.bat 실행. 이후 업데이트는 "확장 업데이트"가 함)
import base64, io, os, sys, zipfile
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "packages", "localcast")
OUT = sys.argv[1] if len(sys.argv) > 1 else "LocalCast_Setup.bat"
SKIP = {"localcast.log", "airplay_debug.log", "file_index.json", "speaker_cache.json"}
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in sorted(files):
            if f in SKIP or f.endswith(".pyc"):
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, SRC).replace(os.sep, "/"))
b64 = base64.b64encode(buf.getvalue()).decode()
ver = "?"
for line in open(os.path.join(SRC, "localcast.js"), encoding="utf-8"):
    if "const VERSION" in line:
        ver = line.split('"')[1]; break
PS_KILL = ("Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and (($_.CommandLine -like '*localcast_helper.py*') -or ($_.Name -eq 'lc_airplay.exe')) } | "
           "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
PS_EXTRACT = ("$ErrorActionPreference='Stop'; "
              "$t=[IO.File]::ReadAllText($env:LC_SELF); $m='::LC'+'PAYLOAD::'; $i=$t.LastIndexOf($m,[StringComparison]::Ordinal); "
              "if($i -lt 0){ throw 'no payload' }; "
              "$s=$t.Substring($i+$m.Length) -replace '[^A-Za-z0-9+/=]',''; $b=[Convert]::FromBase64String($s); "
              "$tmp=Join-Path $env:TEMP ('LocalCast_'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null; "
              "$zp=Join-Path $tmp 'p.zip'; [IO.File]::WriteAllBytes($zp,$b); $x=Join-Path $tmp 'x'; "
              "Expand-Archive -LiteralPath $zp -DestinationPath $x -Force; "
              "$d=$env:LC_DEST; $o=$env:LC_OLD; "
              "if($o -and ($o -ne $d) -and (Test-Path -LiteralPath $o)){ Remove-Item -LiteralPath $o -Recurse -Force }; "
              "if(Test-Path -LiteralPath $d){ Get-ChildItem -LiteralPath $d -Force | Remove-Item -Recurse -Force }; "
              "New-Item -ItemType Directory -Force -Path $d | Out-Null; "
              "Copy-Item -Path (Join-Path $x '*') -Destination $d -Recurse -Force; "
              "Remove-Item -LiteralPath $tmp -Recurse -Force")
head = f"""@echo off
chcp 65001 >nul
setlocal
title LocalCast 설치 ({ver})
set "LC_SELF=%~f0"
set "LC_DEST=%SystemDrive%\\LocalCast"
set "LC_OLD=%USERPROFILE%\\LocalCast"
echo ===== LocalCast 설치 ({ver}) =====
echo 설치 위치: %LC_DEST%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "{PS_KILL}" >nul 2>&1
timeout /t 1 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "{PS_KILL}" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "{PS_EXTRACT}" >nul 2>"%TEMP%\\LocalCast_setup_error.txt"
if errorlevel 1 goto fail
if not exist "%LC_DEST%\\1_install.bat" goto fail
chcp 65001 >nul
echo [준비] 기존 LocalCast 파일을 전부 지우고 새로 설치했어요
call "%LC_DEST%\\1_install.bat"
exit /b 0
:fail
chcp 65001 >nul
echo.
echo [오류] 파일을 풀지 못했습니다. 백신(Avast 등)이 막았거나 LocalCast 폴더가 다른 프로그램에서 열려 있으면 닫고 다시 실행하세요.
type "%TEMP%\\LocalCast_setup_error.txt" 2>nul
pause
exit /b 1
"""
lines = head.split("\n")[:-1] + ["::LCPAYLOAD::"] + [b64[i:i+76] for i in range(0, len(b64), 76)]
with open(OUT, "w", encoding="utf-8", newline="") as f:
    f.write("\r\n".join(lines) + "\r\n")
print(OUT, os.path.getsize(OUT), "bytes, version", ver)
