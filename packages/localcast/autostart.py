# -*- coding: utf-8 -*-
"""보조 프로그램을 창 없이 실행/재시작/종료하고, PC 켤 때 자동 실행을 등록/해제합니다.
사용: python autostart.py on | off | restart | stop
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
HELPER = HERE / "localcast_helper.py"
STARTUP = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
VBS = STARTUP / "LocalCast.vbs"
PYTHONW = Path(sys.executable).with_name("pythonw.exe")
if not PYTHONW.exists():
    PYTHONW = Path(sys.executable)


def port():
    try:
        return int(json.loads((HERE / "config.json").read_text(encoding="utf-8-sig")).get("control_port", 8765))
    except Exception:
        return 8765


def running():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port()}/config", timeout=1.5)
        return True
    except Exception:
        return False


def stop():
    if not running():
        return
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port()}/shutdown", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass
    for _ in range(20):
        if not running():
            break
        time.sleep(0.25)
    print("보조 프로그램 종료")


def kill_leftovers():
    """예전 버전 보조 프로그램이 남아 있으면 강제 종료 (다른 폴더에서 실행된 것 포함)"""
    ps = (
        "Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and ("
        "($_.CommandLine -like '*localcast_helper.py*') -or ($_.Name -eq 'lc_airplay.exe')) } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                       creationflags=0x08000000)
    except Exception:
        pass


def start():
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    # 작업 폴더를 홈으로 둬서 LocalCast 폴더가 "사용 중"으로 잠기지 않게
    subprocess.Popen([str(PYTHONW), str(HELPER), "--supervise"], cwd=str(Path.home()), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if running():
            print("보조 프로그램을 백그라운드에서 실행했습니다 (창 없음)")
            return
        time.sleep(0.25)
    print("⚠ 보조 프로그램이 시작되지 않았습니다. 3_debug_console.bat 으로 오류를 확인하세요.")


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "LocalCast"


def register():
    # 시작프로그램 폴더의 .vbs 는 백신이 막거나 Windows가 꺼 버리는 일이 있어서
    # 레지스트리 자동 실행(HKCU Run, 관리자 권한 필요 없음)으로 등록
    import winreg
    cmd = f'"{PYTHONW}" "{HELPER}" --supervise --boot'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, cmd)
    if VBS.exists():
        try:
            VBS.unlink()
        except Exception:
            pass
    print("PC 켤 때 자동 실행 등록 (레지스트리):", cmd)


def unregister():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, RUN_NAME)
    except Exception:
        pass
    if VBS.exists():
        VBS.unlink()


cmd = sys.argv[1] if len(sys.argv) > 1 else "restart"
if cmd == "on":
    register()
    stop()
    kill_leftovers()
    start()
elif cmd == "off":
    unregister()
    print("자동 실행 해제")
    stop()
    kill_leftovers()
elif cmd == "stop":
    stop()
    kill_leftovers()
else:  # restart
    stop()
    kill_leftovers()
    start()
