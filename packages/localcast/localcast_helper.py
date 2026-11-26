# -*- coding: utf-8 -*-
"""
LocalCast 보조 프로그램
- Spotify 로컬파일을 찾아서 AirPlay 2로 스피커에 보냅니다 (bin\lc_airplay.exe).
- 캐스트하는 동안 PC의 Spotify 소리만 음소거합니다.
- Spicetify 확장(localcast.js)이 이 프로그램에 명령을 보냅니다.

실행: python localcast_helper.py   (창 없이: pythonw localcast_helper.py)
설정: 같은 폴더의 config.json
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_plus, urlparse, parse_qs

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

VERSION = "v52.6-airplay"
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
INDEX_PATH = BASE_DIR / "file_index.json"
LOG_PATH = BASE_DIR / "localcast.log"
AIRPLAY_LOG_PATH = BASE_DIR / "airplay_debug.log"

DEFAULT_CONFIG = {
    "speaker_name": "Aura Studio 5",   # 스피커 이름(일부만 적어도 됨, 대소문자 무시)
    "music_folders": [],               # 로컬파일 폴더. 비워두면 음악/다운로드 폴더 + Spotify 설정에서 자동 탐색
    "pc_device_name": "",              # Spotify에 보이는 이 PC 이름. 비워두면 컴퓨터 이름 사용
    "control_port": 8765,              # Spicetify 확장과 통신 (PC 내부 전용)
    "switch_lead_ms": 800,             # 곡 끝나기 몇 ms 전에 로컬파일로 넘어갈지 (스피커가 다음 곡으로 넘어가기 직전)
    "resync_threshold_s": 3.0,         # 재생 위치가 이만큼 어긋나면 스피커 쪽을 맞춤
    "airplay_ip": "",                  # AirPlay 스피커를 못 찾을 때만 IP 입력
    "airplay_port": 7000,
    "max_speaker_volume": 50,          # 오라스튜디오 최대 볼륨(%) — Connect/AirPlay 모두 이 이상 못 올림
    "airplay_latency_ms": 1500,
    "speaker_ip_hint": "",             # 스피커를 못 찾을 때 먼저 시도할 주소 (찾으면 자동으로 기억한 주소가 우선)        # AirPlay 버퍼(ms). 클수록 끊김에 강하고, 작을수록 탐색 반응이 빠름
    "airplay_sync_latency_ms": 0,      # 스피커에 알려주는 재생 지연(ms). 0 = airplay_latency_ms 와 같게
    "airplay_audio_delay_ms": 0,       # 스피커에서 실제로 소리가 나기까지 걸리는 시간(ms). 가사 싱크용. 0 = 자동(재생 지연+200)
}

def sync_latency_ms():
    v = int(CFG.get("airplay_sync_latency_ms") or 0)
    return v if v > 0 else int(CFG.get("airplay_latency_ms", 1500) or 1500)


def audio_delay_ms():
    """스피커에서 소리가 실제로 나오는 지연 (Spotify 화면·가사를 여기에 맞춤)"""
    v = int(CFG.get("airplay_audio_delay_ms") or 0)
    return v if v > 0 else sync_latency_ms() + 200


AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".wav", ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif"}

_log_lock = threading.Lock()


def log(*args):
    msg = time.strftime("%H:%M:%S ") + " ".join(str(a) for a in args)
    with _log_lock:
        try:
            print(msg, flush=True)
        except Exception:
            pass
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            pass


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg.update(json.load(f))
        except Exception as e:
            log("config.json 읽기 실패, 기본값 사용:", e)
    else:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
    return cfg


CFG = load_config()


# ─────────────────────────────── 로컬파일 찾기 ───────────────────────────────

def norm(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", str(s)).casefold()
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def loose(s):
    """괄호/기호를 뺀 느슨한 비교용 문자열"""
    s = norm(s)
    s = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", s)
    s = re.sub(r"[^\w]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def spotify_prefs_folders():
    """Spotify prefs 파일에서 로컬파일 폴더로 보이는 경로를 추출 (추정)"""
    found = []
    candidates = []
    appdata = os.environ.get("APPDATA")
    localappdata = os.environ.get("LOCALAPPDATA")
    if appdata:
        candidates.append(Path(appdata) / "Spotify" / "prefs")
    if localappdata:
        pk = Path(localappdata) / "Packages"
        if pk.exists():
            for d in pk.glob("SpotifyAB.SpotifyMusic_*"):
                candidates.append(d / "LocalState" / "Spotify" / "prefs")
    for p in candidates:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for line in text.splitlines():
            if "local" not in line.lower():
                continue
            for m in re.findall(r"[A-Za-z]:(?:\\\\|\\|/)[^\"|,;]+", line):
                path = m.replace("\\\\", "\\").strip()
                low = path.lower()
                if "appdata\\local\\spotify" in low or "appdata\\roaming\\spotify" in low or "spotifyab.spotifymusic" in low:
                    continue  # Spotify 자체 캐시 폴더는 제외
                if os.path.isdir(path):
                    found.append(path)
    return found


def music_folders():
    folders = [f for f in CFG.get("music_folders") or [] if f]
    if not folders:
        home = Path.home()
        for sub in ("Music", "Downloads", "음악", "다운로드"):
            p = home / sub
            if p.is_dir():
                folders.append(str(p))
        folders += spotify_prefs_folders()
    out, seen = [], set()
    for f in folders:
        f = os.path.expandvars(os.path.expanduser(f))
        key = os.path.normcase(os.path.abspath(f))
        if key not in seen and os.path.isdir(f):
            seen.add(key)
            out.append(f)
    return out


def read_tags(path):
    info = {"title": "", "artist": "", "album": "", "duration": 0.0}
    try:
        import mutagen
        f = mutagen.File(path, easy=True)
        if f is not None:
            tags = f.tags or {}

            def first(k):
                v = tags.get(k)
                if isinstance(v, list):
                    return str(v[0]) if v else ""
                return str(v) if v else ""
            info["title"] = first("title")
            info["artist"] = first("artist") or first("albumartist")
            info["album"] = first("album")
            if getattr(f, "info", None) is not None and getattr(f.info, "length", None):
                info["duration"] = float(f.info.length)
    except Exception:
        pass
    return info


class FileIndex:
    def __init__(self):
        self.lock = threading.Lock()
        self.entries = {}   # path -> {mtime,size,title,artist,album,duration,stem}
        self.last_scan = 0.0
        try:
            if INDEX_PATH.exists():
                self.entries = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except Exception:
            self.entries = {}

    def scan(self):
        with self.lock:
            t0 = time.time()
            folders = music_folders()
            fresh = {}
            count_new = 0
            for folder in folders:
                for root, _dirs, files in os.walk(folder):
                    for name in files:
                        ext = os.path.splitext(name)[1].lower()
                        if ext not in AUDIO_EXTS:
                            continue
                        path = os.path.join(root, name)
                        try:
                            st = os.stat(path)
                        except OSError:
                            continue
                        old = self.entries.get(path)
                        if old and old.get("mtime") == st.st_mtime and old.get("size") == st.st_size:
                            fresh[path] = old
                            continue
                        tags = read_tags(path)
                        tags.update({"mtime": st.st_mtime, "size": st.st_size, "stem": os.path.splitext(name)[0]})
                        fresh[path] = tags
                        count_new += 1
            self.entries = fresh
            self.last_scan = time.time()
            try:
                INDEX_PATH.write_text(json.dumps(fresh, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
            log(f"음악 폴더 스캔 완료: {len(fresh)}곡 (새로 읽음 {count_new}) / {time.time()-t0:.1f}초 / 폴더: {folders}")

    def _find(self, title, artist, album, duration):
        t_n, t_l = norm(title), loose(title)
        a_n, al_n = norm(artist), norm(album)
        best, best_score = None, -1
        for path, e in self.entries.items():
            score = 0
            et, es = norm(e.get("title")), norm(e.get("stem"))
            if t_n and (et == t_n):
                score += 100
            elif t_n and es == t_n:
                score += 90
            elif t_l and (loose(e.get("title")) == t_l or loose(e.get("stem")) == t_l):
                score += 70
            elif t_l and len(t_l) >= 4 and (t_l in loose(e.get("stem")) or t_l in loose(e.get("title"))):
                score += 40
            else:
                continue
            ea = norm(e.get("artist"))
            if a_n and ea:
                if ea == a_n:
                    score += 30
                elif a_n in ea or ea in a_n:
                    score += 15
                else:
                    score -= 20
            if al_n and norm(e.get("album")) == al_n:
                score += 10
            if duration and e.get("duration"):
                diff = abs(float(e["duration"]) - float(duration))
                if diff <= 2:
                    score += 25
                elif diff <= 5:
                    score += 5
                else:
                    score -= 30
            if score > best_score:
                best, best_score = path, score
        return best if best_score >= 60 else None

    def find(self, title, artist, album, duration):
        path = self._find(title, artist, album, duration)
        if path and os.path.exists(path):
            return path
        # 못 찾으면 다시 스캔 (최근 10초 안에 했으면 생략)
        if time.time() - self.last_scan > 10:
            self.scan()
            path = self._find(title, artist, album, duration)
            if path and os.path.exists(path):
                return path
        return None


def norm_uri(u):
    """로컬파일 주소 표기(+, %20, 대소문자) 차이를 무시하고 비교"""
    try:
        return unicodedata.normalize("NFC", unquote_plus(str(u or ""))).casefold()
    except Exception:
        return str(u or "").casefold()


def parse_local_uri(uri):
    """spotify:local:artist:album:title:seconds"""
    if not uri or not uri.startswith("spotify:local:"):
        return {}
    parts = uri[len("spotify:local:"):].split(":")
    while len(parts) < 4:
        parts.append("")
    artist, album, title, dur = (unquote_plus(p) for p in parts[:4])
    try:
        d = float(dur)
    except ValueError:
        d = 0.0
    return {"artist": artist, "album": album, "title": title, "duration": d}


INDEX = FileIndex()

_art_cache = {}


def cover_art(path):
    """음악 파일에 들어 있는 앨범 사진 (bytes, mime) 또는 None"""
    if path in _art_cache:
        return _art_cache[path]
    res = None
    try:
        from mutagen import File as MFile
        f = MFile(path)
        tags = getattr(f, "tags", None)
        if hasattr(f, "pictures") and f.pictures:            # FLAC
            p = f.pictures[0]
            res = (p.data, p.mime or "image/jpeg")
        elif tags is not None and hasattr(tags, "getall"):    # MP3 (ID3)
            pics = tags.getall("APIC")
            if pics:
                res = (pics[0].data, pics[0].mime or "image/jpeg")
        elif tags is not None and "covr" in tags:             # M4A
            c = tags["covr"][0]
            res = (bytes(c), "image/png" if getattr(c, "imageformat", 13) == 14 else "image/jpeg")
    except Exception:
        res = None
    if len(_art_cache) > 300:
        _art_cache.clear()
    _art_cache[path] = res
    return res


# ─────────────────────────────── Spotify 음소거 ───────────────────────────────

class SpotifyMuter:
    """Windows 볼륨 믹서에서 Spotify만 음소거/해제"""

    def __init__(self):
        self.want_mute = False
        self.we_muted = False
        self.pending_unmute = True   # 이전 실행에서 남은 음소거를 Spotify 소리가 생기는 대로 해제
        self.available = sys.platform == "win32"
        self.lock = threading.Lock()
        if self.available:
            threading.Thread(target=self._loop, daemon=True).start()

    def _sessions(self):
        from pycaw.pycaw import AudioUtilities
        for s in AudioUtilities.GetAllSessions():
            try:
                if s.Process and s.Process.name().lower() == "spotify.exe":
                    yield s
            except Exception:
                continue

    def _apply(self, mute):
        changed = False
        for s in self._sessions():
            try:
                vol = s.SimpleAudioVolume
                if bool(vol.GetMute()) != mute:
                    vol.SetMute(1 if mute else 0, None)
                    changed = True
            except Exception:
                continue
        return changed

    def set(self, mute):
        with self.lock:
            self.want_mute = bool(mute)
            if not mute:
                self.pending_unmute = True
        if self.available:
            time.sleep(0.25)  # 백그라운드 루프가 적용할 시간

    def force_unmute(self):
        """종료할 때 바로 음소거 해제 (Windows가 음소거 상태를 기억하므로)"""
        with self.lock:
            self.want_mute = False
        if not self.available:
            return
        try:
            import comtypes
            comtypes.CoInitialize()
            self._apply(False)
            self.we_muted = False
        except Exception as e:
            log("음소거 해제 실패:", e)

    def _loop(self):
        try:
            import comtypes
            comtypes.CoInitialize()
        except Exception as e:
            log("pycaw/comtypes를 불러오지 못해 음소거 기능을 끕니다:", e)
            self.available = False
            return
        # 시작할 때 이전에 남은 음소거가 있으면 해제
        try:
            self._apply(False)
        except Exception:
            pass
        while True:
            try:
                with self.lock:
                    want = self.want_mute
                if want:
                    # Spotify가 새 오디오 세션을 만들 수 있으므로 계속 확인
                    self._apply(True)
                    self.we_muted = True
                elif self.we_muted or self.pending_unmute:
                    sessions = list(self._sessions())
                    if sessions:
                        if self._apply(False):
                            log("🔊 Spotify 음소거 풀림 (남아 있던 음소거 해제)")
                        self.pending_unmute = False
                    self.we_muted = False
            except Exception:
                pass
            time.sleep(0.1 if want else 0.3)


MUTER = SpotifyMuter()


# ─────────────────────────────── AirPlay 2 (bin\lc_airplay.exe) ───────────────────────────────

AIRPLAY_EXE = BASE_DIR / "bin" / ("lc_airplay.exe" if sys.platform == "win32" else "lc_airplay")
AIRPLAY_UNSUPPORTED = {".wma"}


class AirPlayer:
    """AirPlay 2로 파일을 보냄. 일시정지/탐색은 멈췄다가 그 위치부터 다시 보내는 방식."""

    def __init__(self):
        self.lock = threading.RLock()
        self.target = None          # (name, ip, port)
        self.proc = None
        self.state = "IDLE"         # IDLE | STARTING | PLAYING | PAUSED
        self.pos = 0.0
        self.pos_t = 0.0
        self.started_at = 0.0
        self.current = None         # {"path","uri"}
        self.volume_pct = 20.0
        self.discovering = False
        self.gen = 0                # stop() 할 때마다 증가 → 진행 중인 시작 작업 취소
        self.step = ""
        self.last_error = None
        self.fail_until = 0.0
        self.paused_at = 0.0
        self.drift_hits = 0
        self.duration = 0.0
        self.ended_at = 0.0
        self.reconnects = 0
        self.load_evt = threading.Event()
        self.load_ok = False

    # 호환용 (상태 표시)
    @property
    def cast(self):
        return self

    @property
    def name(self):
        return self.target[0] if self.target else None

    # ── 마지막으로 연결됐던 스피커 주소 기억 (검색이 실패해도 바로 연결) ──
    CACHE = BASE_DIR / "speaker_cache.json"

    @staticmethod
    def _reachable(ip, port, timeout=1.5):
        try:
            with socket.create_connection((ip, int(port)), timeout=timeout):
                return True
        except Exception:
            return False

    def _load_cache(self):
        try:
            c = json.loads(self.CACHE.read_text(encoding="utf-8"))
            if c.get("ip"):
                return (c.get("name") or CFG.get("speaker_name"), c["ip"], int(c.get("port") or 7000))
        except Exception:
            pass
        try:  # 처음엔 로그에서 마지막으로 연결됐던 주소를 찾음
            with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                last = None
                for line in f:
                    m = re.search(r"AirPlay 스피커 연결: (.+?) \((\d+\.\d+\.\d+\.\d+):(\d+)\)", line)
                    if m:
                        last = (m.group(1), m.group(2), int(m.group(3)))
                if last:
                    return last
        except Exception:
            pass
        hint = CFG.get("speaker_ip_hint")   # 설치 파일에 넣어 둔 마지막 주소 (설치 때 로그가 지워져도 사용)
        return (CFG.get("speaker_name"), hint, int(CFG.get("airplay_port") or 7000)) if hint else None

    def _save_cache(self, t):
        try:
            self.CACHE.write_text(json.dumps({"name": t[0], "ip": t[1], "port": t[2]}, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def discover(self):
        if self.discovering:
            for _ in range(60):
                if not self.discovering:
                    return
                time.sleep(0.2)
            return
        self.discovering = True
        try:
            self._discover()
            if self.target and not CFG.get("airplay_ip"):
                self._save_cache(self.target)
        finally:
            self.discovering = False

    def _discover(self):
        cached = None if CFG.get("airplay_ip") else self._load_cache()
        if cached and self._reachable(cached[1], cached[2]):
            self.target = cached
            log(f"✅ AirPlay 스피커 연결: {cached[0]} ({cached[1]}:{cached[2]}) [기억한 주소]")
            return
        self._discover_mdns()
        if not self.target and cached:
            log(f"   검색 실패 → 기억해 둔 주소로 시도: {cached[1]}:{cached[2]}")
            self.target = cached

    def _discover_mdns(self):
        try:
            if CFG.get("airplay_ip"):
                self.target = (CFG.get("speaker_name"), CFG["airplay_ip"], int(CFG.get("airplay_port") or 7000))
                log(f"✅ AirPlay 스피커(설정값): {self.target[1]}:{self.target[2]}")
                return
            from zeroconf import ServiceBrowser, ServiceStateChange, Zeroconf
            want = norm(CFG.get("speaker_name"))
            stype = "_airplay._tcp.local."
            zc = Zeroconf()
            names = set()

            def on_change(zeroconf, service_type, name, state_change):
                if state_change is ServiceStateChange.Added:
                    names.add(name)

            browser = ServiceBrowser(zc, stype, handlers=[on_change])
            log("AirPlay 스피커 찾는 중...", CFG.get("speaker_name"))
            end = time.time() + 10
            found = None
            try:
                while time.time() < end and not found:
                    for n in list(names):
                        if want and want in norm(n):
                            info = zc.get_service_info(stype, n, 3000)
                            if info:
                                addrs = [a for a in info.parsed_addresses() if ":" not in a]
                                if addrs:
                                    found = (n.split("._airplay")[0], addrs[0], int(info.port or 7000))
                                    break
                    time.sleep(0.2)
            finally:
                try:
                    browser.cancel()
                except Exception:
                    pass
                zc.close()
            if found:
                self.target = found
                log(f"✅ AirPlay 스피커 연결: {found[0]} ({found[1]}:{found[2]})")
            else:
                log("⚠ AirPlay 스피커를 못 찾았습니다:", sorted(names))
        except Exception as e:
            log("AirPlay 스피커 찾기 실패:", e)

    def rediscover(self):
        """스피커 주소가 바뀌었을 수 있으니 다시 찾기 (설정에 IP를 직접 넣은 경우 제외)"""
        if CFG.get("airplay_ip"):
            return
        old = self.target
        self.target = None
        self.discover()
        if not self.target:
            self.target = old
        elif old and old[1] != self.target[1]:
            log(f"스피커 주소 변경: {old[1]} → {self.target[1]}")

    def ensure(self):
        if not self.target:
            self.discover()
        if not self.target:
            raise RuntimeError("AirPlay 스피커를 찾지 못했습니다")
        return self.target

    def _reader(self, proc, ready):
        # 락 없이 갱신 (_spawn이 락을 잡고 기다리는 중이라도 막히지 않게)
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                mine = proc is self.proc
                if line.startswith("POS "):
                    try:
                        if mine:
                            self.pos = float(line[4:])
                            self.pos_t = time.time()
                    except ValueError:
                        pass
                    continue
                if line.startswith("STEP "):
                    if mine:
                        self.step = line[5:]
                    continue
                if line.startswith("SEEKED "):
                    if mine:
                        try:
                            self.pos, self.pos_t = float(line[7:]), time.time()
                        except ValueError:
                            pass
                    continue
                if line.startswith(("ERROR seek", "ERROR pause", "ERROR resume", "ERROR stalled")):
                    # 연결 안에서 탐색/일시정지가 안 되면 → 이 전송은 끝내고 다음 동기화 때 새로 연결
                    log("AirPlay:", line, "→ 다시 연결로 처리")
                    if mine:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                        self.proc = None
                        self.state = "PAUSED" if self.state == "PAUSED" else "IDLE"
                    continue
                if line == "LOADED" or line.startswith("ERROR load"):
                    if mine:
                        self.load_ok = line == "LOADED"
                        self.load_evt.set()
                    if line != "LOADED":
                        log("AirPlay:", line)
                    continue
                if line.startswith("RETRY"):
                    log("AirPlay: 연결 거부/실패 → 잠시 뒤 다시 시도 (" + line[6:] + ")")
                    continue
                if line == "PLAYING":
                    if mine:
                        self.state = "PLAYING"
                    ready.set()
                elif line in ("ENDED", "STOPPED"):
                    if mine and self.state == "PLAYING":
                        self.state = "IDLE"
                if line.startswith("ERROR"):
                    log("AirPlay:", line, f"(단계: {self.step})" if mine else "")
                    if mine:
                        self.last_error = line
                elif line == "ENDED":
                    log("AirPlay: 곡 끝")
                    if mine:
                        self.ended_at = time.time()
                if line.startswith("INFO duration") and mine:
                    try:
                        self.duration = float(line.split()[-1])
                    except ValueError:
                        pass
        except Exception:
            pass
        finally:
            ready.set()
            # 우리가 끄지 않았는데 전송 프로그램이 끝남(연결 끊김 등) → 다음 동기화 때 그 위치에서 자동으로 다시 연결
            if proc is self.proc and self.state in ("PLAYING", "STARTING"):
                log("⚠ AirPlay 연결이 끊겼어요 → 곧 다시 연결합니다")
                self.proc = None
                self.state = "IDLE"
                self.reconnects += 1
                if self.reconnects % 3 == 0:
                    threading.Thread(target=self.rediscover, daemon=True).start()

    def _cmd(self, line):
        p = self.proc
        if not p or p.poll() is not None:
            return False
        try:
            p.stdin.write(line + "\n")
            p.stdin.flush()
            return True
        except Exception:
            return False

    def _kill(self):
        p = self.proc
        self.proc = None
        if not p or p.poll() is not None:
            return
        try:
            p.stdin.write("quit\n")
            p.stdin.flush()
        except Exception:
            pass
        try:
            p.wait(timeout=3)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def _spawn(self, path, start):
        name, ip, port = self.ensure()
        if not AIRPLAY_EXE.exists():
            log(f"❌ {AIRPLAY_EXE} 파일이 없습니다 — 백신(Avast 등)이 격리했을 수 있어요. 격리함에서 복원하고 LocalCast 폴더를 예외로 추가하세요")
            raise RuntimeError("lc_airplay.exe 없음 (백신 격리 확인)")
        mygen = self.gen
        self._kill()
        args = [str(AIRPLAY_EXE), ip, str(port), path, "--start", f"{max(0.0, start):.3f}",
                "--volume", f"{self.volume_pct:.1f}", "--latency-ms", str(int(CFG.get("airplay_latency_ms", 1500) or 1500)),
                "--sync-latency-ms", str(sync_latency_ms())]
        # CREATE_NO_WINDOW | HIGH_PRIORITY_CLASS (PC가 바빠도 소리 전송이 밀리지 않게)
        flags = (0x08000000 | 0x00000080) if sys.platform == "win32" else 0
        dbg = open_airplay_debug_log(f"{Path(path).name} @ {start:.1f}s → {ip}:{port}")
        env = dict(os.environ, LC_DEBUG="1")
        try:
            p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=dbg or subprocess.DEVNULL,
                                 text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags, env=env)
        finally:
            if dbg:
                dbg.close()
        self.proc = p
        self.state = "STARTING"
        self.step, self.last_error = "시작", None
        self.pos, self.pos_t, self.started_at = start, time.time(), time.time()
        ready = threading.Event()
        threading.Thread(target=self._reader, args=(p, ready), daemon=True).start()
        ready.wait(26)
        if self.gen != mygen:
            # 기다리는 사이 stop()이 호출됨 → 방금 시작한 전송도 끝냄 (스포티파이로 돌아간 뒤 AirPlay가 끼어들지 않게)
            try:
                p.stdin.write("quit\n"); p.stdin.flush(); p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
            if self.proc is p:
                self.proc = None
            raise RuntimeError("취소됨")
        if self.state == "PLAYING" and p.poll() is None:
            return
        failed_step = self.step
        if p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass
            if self.proc is p:
                self.proc = None
        self.state = "IDLE"
        self.fail_until = time.time() + 8   # 실패 직후 자동 재시도 폭주 방지
        explain_airplay_failure(failed_step, self.last_error)
        if self.last_error:
            raise RuntimeError(f"AirPlay 전송 실패 ({self.last_error[6:]})")
        raise RuntimeError("AirPlay 전송 시작 시간 초과")

    def play_file(self, path, meta, position_s=0.0, paused=False, volume=None):
        with self.lock:
            if volume is not None:
                self.volume_pct = max(0.0, min(max_vol(), float(volume) * 100.0))
            self.current = {"path": path, "uri": meta.get("uri"), "ctx": meta.get("ctx")}
            log(f"▶ AirPlay: {Path(path).name} @ {position_s:.1f}s (볼륨 {self.volume_pct:.0f}%)")
            t0 = time.time()
            # 이미 스피커와 연결돼 있으면 연결을 끊지 않고 같은 연결에서 다음 곡으로 (끊고 다시 붙으면 스피커가 몇 초간 거부함)
            if self._load(path, position_s):
                log(f"   같은 연결로 바로 전환 ({time.time()-t0:.1f}초)")
                if paused and self._cmd("pause"):
                    self.state, self.paused_at = "PAUSED", time.time()
                return
            if paused:
                self._kill()
                self.state, self.pos = "PAUSED", position_s
                return
            self._spawn(path, position_s)
            log(f"   재생 시작까지 {time.time()-t0:.1f}초")

    def _load(self, path, position_s):
        p = self.proc
        if not p or p.poll() is not None or self.state == "STARTING":
            return False
        self.load_evt.clear()
        self.load_ok = False
        if not self._cmd(f"load {max(0.0, position_s):.3f} {path}"):
            return False
        self.load_evt.wait(6)
        if not self.load_ok or self.proc is not p or p.poll() is not None:
            log("   같은 연결 전환 실패 → 새로 연결")
            return False
        self.state = "PLAYING"
        self.pos, self.pos_t, self.started_at = position_s, time.time(), time.time()
        self.ended_at, self.drift_hits = 0.0, 0
        return True

    def status(self):
        if True:  # 락 없이 (연결 중에도 바로 답함)
            cur = self.current
            pos = self.pos + (time.time() - self.pos_t if self.state == "PLAYING" and self.pos_t else 0.0)
            alive = bool(self.proc and self.proc.poll() is None)
            return {"state": self.state, "position": pos, "file": Path(cur["path"]).name if cur else None,
                    "uri": cur.get("uri") if cur else None, "ctx": cur.get("ctx") if cur else None, "alive": alive,
                    "speaker": self.name, "volume": self.volume_pct}

    def sync(self, position_s, paused, uri=None, seek=False):
        # 시작(연결) 중이면 기다리지 않고 바로 답함 (확장 쪽 요청이 끊기지 않게)
        if not self.lock.acquire(timeout=0.3):
            return {"ok": True, "action": "busy"}
        try:
            return self._sync(position_s, paused, uri, seek)
        finally:
            self.lock.release()

    def _sync(self, position_s, paused, uri=None, seek=False):
        if True:
            if not self.current:
                return {"ok": False, "reason": "not_casting"}
            if uri and self.current.get("uri") and norm_uri(uri) != norm_uri(self.current["uri"]):
                return {"ok": False, "reason": "different_track"}
            # 감시: 전송 프로그램이 살아는 있는데 5초 넘게 응답(위치 보고)이 없음 → 멈춘 것으로 보고 새로 연결
            p = self.proc
            if (self.state == "PLAYING" and p and p.poll() is None and self.pos_t
                    and time.time() - self.pos_t > 5 and time.time() - self.started_at > 5):
                log("⚠ AirPlay 전송이 멈췄어요 → 그 위치에서 다시 연결합니다")
                self.proc = None
                try:
                    p.kill()
                except Exception:
                    pass
                self.state = "IDLE"
            if paused and self.state == "PLAYING" and self._cmd("pause"):
                # 연결은 유지한 채 일시정지 (다시 재생할 때 바로 이어짐)
                self.state, self.pos, self.pos_t, self.paused_at = "PAUSED", position_s, time.time(), time.time()
                return {"ok": True, "action": "pause"}
            if paused and self.state in ("PLAYING", "STARTING"):
                self._kill()
                self.state = "PAUSED"
                return {"ok": True, "action": "pause"}
            if paused and self.state == "PAUSED" and self.proc and time.time() - self.paused_at > 120:
                self._kill()   # 오래 멈춰 있으면 스피커를 놓아줌
                return {"ok": True, "action": None}
            if seek and not paused and self.state == "PLAYING":
                est = self.pos + (time.time() - self.pos_t)
                if abs(est - position_s) < 1.5:
                    return {"ok": True, "action": None}   # 이미 그 위치 (잘못 감지된 탐색) → 소리를 끊지 않음
                # Spotify에서 탐색(뒤로/앞으로 감기) → 연결을 끊지 않고 바로 그 위치로
                log(f"⏩ 탐색: {est:.1f}s → {position_s:.1f}s")
                if self._cmd(f"seek {position_s:.3f}"):
                    self.pos, self.pos_t, self.started_at = position_s, time.time(), time.time()
                else:
                    try:
                        self._spawn(self.current["path"], position_s)
                    except Exception as e:
                        log("탐색 실패:", e)
                return {"ok": True, "action": "seek"}
            live = bool(self.proc and self.proc.poll() is None)
            if not paused and self.state == "IDLE" and live and not (
                    self.duration and position_s >= self.duration - 4 and time.time() - self.ended_at < 10):
                # 곡이 끝난 뒤(연결은 살아 있음) 다시 재생 → 같은 연결에서 그 위치로
                if self._cmd(f"seek {position_s:.3f}"):
                    self.state, self.pos, self.pos_t, self.started_at = "PLAYING", position_s, time.time(), time.time()
                    return {"ok": True, "action": "resume"}
            if not paused and self.state == "PAUSED" and self._cmd(f"seek {position_s:.3f}"):
                # 연결 유지 중이던 일시정지 → 그 위치에서 바로 재개
                self.state, self.pos, self.pos_t, self.started_at = "PLAYING", position_s, time.time(), time.time()
                return {"ok": True, "action": "resume"}
            if not paused and self.state in ("PAUSED", "IDLE"):
                if time.time() < self.fail_until:
                    return {"ok": True, "action": "wait"}
                if self.duration and position_s >= self.duration - 4 and time.time() - self.ended_at < 10:
                    return {"ok": True, "action": None}   # 방금 곡이 끝남 → 다시 틀지 않음
                try:
                    self._spawn(self.current["path"], position_s)
                except Exception as e:
                    log("재개 실패:", e)
                return {"ok": True, "action": "resume"}
            if self.state == "PLAYING" and time.time() - self.started_at > 6:
                est = self.pos + (time.time() - self.pos_t)
                thr = max(4.0, float(CFG.get("resync_threshold_s", 3.0)))
                if abs(est - position_s) > thr:
                    self.drift_hits += 1
                else:
                    self.drift_hits = 0
                if self.drift_hits >= 3:   # 3초 연속 어긋날 때만 (잠깐 튀는 값에 소리를 끊지 않게)
                    self.drift_hits = 0
                    log(f"↔ 위치 맞춤: 스피커 {est:.1f}s → {position_s:.1f}s")
                    if self._cmd(f"seek {position_s:.3f}"):
                        self.pos, self.pos_t, self.started_at = position_s, time.time(), time.time()
                    else:
                        try:
                            self._spawn(self.current["path"], position_s)
                        except Exception as e:
                            log("위치 맞춤 실패:", e)
                    return {"ok": True, "action": "seek"}
            return {"ok": True, "action": None}

    def wait_idle(self, timeout):
        return True

    def stop(self):
        # 락 없이 먼저 끊음: 시작 중인 전송이 락을 잡고 있어도 바로 멈추게
        self.gen += 1
        if self.proc:
            log("■ AirPlay 종료")
        self._kill()
        with self.lock:
            self._kill()
            self.current = None
            self.state = "IDLE"

    def set_volume(self, level):
        # 락 없이: 연결 중이어도 바로 반영 (다음 연결은 이 값으로 시작)
        new = max(0.0, min(max_vol(), float(level) * 100.0))
        # 안전장치: 시작 직후 3초 안에 크게 올리라는 요청은 무시 (갑자기 커지는 것 방지)
        if new > self.volume_pct + 10 and time.time() - self.started_at < 3.0:
            log(f"⚠ 시작 직후 볼륨 급상승 요청 무시: {self.volume_pct:.0f}% → {new:.0f}%")
            return
        if abs(new - self.volume_pct) >= 1:
            log(f"🔈 AirPlay 볼륨 {self.volume_pct:.0f}% → {new:.0f}%")
        self.volume_pct = new
        p = self.proc
        if p and p.poll() is None and self.state == "PLAYING":
            try:
                p.stdin.write(f"vol {self.volume_pct:.1f}\n")
                p.stdin.flush()
            except Exception:
                pass


CASTER = AirPlayer()


def max_vol():
    try:
        return max(5.0, min(100.0, float(CFG.get("max_speaker_volume", 50))))
    except Exception:
        return 50.0


def open_airplay_debug_log(title):
    """lc_airplay.exe 의 자세한 기록 파일 (문제 확인용). 너무 커지면 새로 씀."""
    try:
        mode = "a"
        if AIRPLAY_LOG_PATH.exists() and AIRPLAY_LOG_PATH.stat().st_size > 3_000_000:
            mode = "w"
        f = open(AIRPLAY_LOG_PATH, mode, encoding="utf-8", errors="replace")
        f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} {title} =====\n")
        f.flush()
        return f
    except Exception:
        return None


def airplay_debug_tail(n=12):
    try:
        with open(AIRPLAY_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()[-20000:]
        block = text.split("\n===== ")[-1].splitlines()[1:]
        keep = [l for l in block if l.strip()]
        return keep[-n:]
    except Exception:
        return []


def explain_airplay_failure(step, err):
    log(f"❌ AirPlay 실패 — 단계: {step or '?'} / {err or '응답 없음'}")
    # 연결 자체가 안 되면 스피커 주소가 바뀌었을 수 있으니 다시 찾아둠
    if err and re.search(r"refused|timed out|unreachable|No route", err, re.I):
        threading.Thread(target=CASTER.rediscover, daemon=True).start()
    for l in airplay_debug_tail():
        log("   │", l[:300])
    if err and "timed out" in err.lower():
        log("   → 스피커가 응답하지 않았습니다. 가장 흔한 원인은 Windows 방화벽이 lc_airplay.exe 를 막는 것입니다.")
        log("     5_airplay_test.bat 을 실행해 방화벽 허용 + 테스트를 해보세요. 그래도 안 되면 스피커 전원을 껐다 켜보세요.")


# ─────────────────────────────── 제어 서버 (Spicetify용) ───────────────────────────────

class ControlHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 확장 쪽이 먼저 끊음 (시간 초과) — 무시

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/config":
                return self._json({
                    "ok": True,
                    "speaker_name": CFG.get("speaker_name"),
                    "pc_device_name": CFG.get("pc_device_name") or socket.gethostname(),
                    "switch_lead_ms": CFG.get("switch_lead_ms", 800),
                    "audio_delay_ms": audio_delay_ms(),
                    "max_speaker_volume": max_vol(),
                    "version": VERSION,
                })
            if u.path == "/art":
                meta = parse_local_uri((q.get("uri") or [""])[0])
                path = INDEX.find(meta.get("title"), meta.get("artist"), meta.get("album"), meta.get("duration")) if meta else None
                art = cover_art(path) if path else None
                if not art:
                    return self._json({"ok": False}, 404)
                data, mime = art
                try:
                    self.send_response(200)
                    self._cors()
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "max-age=3600")
                    self.end_headers()
                    self.wfile.write(data)
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                    pass
                return
            if u.path == "/status":
                return self._json({"ok": True, "cast": CASTER.status(), "output": "airplay", "version": VERSION,
                                   "speaker": CASTER.cast.name if CASTER.cast else None,
                                   "muted": MUTER.want_mute, "files": len(INDEX.entries), "peers": PEERS.active()})
            if u.path == "/wait_idle":
                t = float(q.get("timeout", ["4"])[0])
                return self._json({"ok": True, "idle": CASTER.wait_idle(min(t, 10))})
            return self._json({"ok": False, "error": "unknown"}, 404)
        except Exception as e:
            log("오류:", u.path, e)
            return self._json({"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        b = self._body()
        try:
            if u.path == "/mute":
                MUTER.set(bool(b.get("mute")))
                log("🔇 Spotify PC 소리 음소거" if b.get("mute") else "🔊 Spotify PC 소리 음소거 해제")
                return self._json({"ok": True})
            if u.path == "/cast":
                meta = parse_local_uri(b.get("uri", ""))
                # 확장이 보낸 정보가 있으면 우선 사용
                for k in ("title", "artist", "album"):
                    if b.get(k):
                        meta[k] = b[k]
                if b.get("duration_ms"):
                    meta["duration"] = float(b["duration_ms"]) / 1000.0
                meta["uri"] = b.get("uri")
                meta["ctx"] = b.get("ctx")
                path = INDEX.find(meta.get("title"), meta.get("artist"), meta.get("album"), meta.get("duration"))
                if not path:
                    log("⚠ 파일을 찾지 못함:", meta)
                    return self._json({"ok": False, "error": "not_found", "meta": meta})
                ext = os.path.splitext(path)[1].lower()
                if ext in AIRPLAY_UNSUPPORTED:
                    log("⚠ 지원하지 않는 파일 형식:", path)
                    return self._json({"ok": False, "error": "unsupported_format", "path": path})
                pos = float(b.get("position_ms") or 0) / 1000.0
                vol = b.get("volume")
                try:
                    CASTER.play_file(path, meta, pos, bool(b.get("paused")),
                                     volume=float(vol) if isinstance(vol, (int, float)) else None)
                except RuntimeError as e:
                    if "취소" in str(e):
                        log("AirPlay 시작 취소됨 (스포티파이 곡으로 돌아감)")
                        return self._json({"ok": False, "error": "취소됨"})
                    log("오류: /cast", e)
                    return self._json({"ok": False, "error": str(e)})
                return self._json({"ok": True, "path": path})
            if u.path == "/sync":
                r = CASTER.sync(float(b.get("position_ms") or 0) / 1000.0, bool(b.get("paused")), b.get("uri"), bool(b.get("seek")))
                return self._json(r)
            if u.path == "/stop":
                CASTER.stop()
                return self._json({"ok": True})
            if u.path == "/volume":
                CASTER.set_volume(float(b.get("level", 0.5)))
                return self._json({"ok": True})
            if u.path == "/rescan":
                INDEX.scan()
                return self._json({"ok": True, "files": len(INDEX.entries)})
            if u.path == "/shutdown":
                try:
                    CASTER.stop()
                except Exception:
                    pass
                MUTER.force_unmute()
                log("종료 요청 받음")
                threading.Timer(0.5, lambda: os._exit(0)).start()
                return self._json({"ok": True})
            if u.path == "/log":
                log("[확장]", b.get("msg", ""))
                return self._json({"ok": True})
            return self._json({"ok": False, "error": "unknown"}, 404)
        except Exception as e:
            log("오류:", u.path, e)
            log(traceback.format_exc())
            return self._json({"ok": False, "error": str(e)}, 500)


# ───────── 다른 PC의 LocalCast와 서로 알리기 (데스크탑이 AirPlay 중이면 노트북에도 그렇게 표시) ─────────
PEER_PORT = 8767


class PeerBeacon:
    """같은 와이파이의 다른 LocalCast에게 '지금 오라스튜디오로 AirPlay 중'을 2초마다 알리고, 다른 PC의 알림을 받아 둠"""

    def __init__(self):
        self.host = socket.gethostname()
        self.peers = {}   # host -> (data, received_time)

    @staticmethod
    def _broadcast_addrs():
        out = set()
        try:
            import ipaddress
            import ifaddr
            for a in ifaddr.get_adapters():
                for ip in a.ips:
                    if not isinstance(ip.ip, str) or ip.ip.startswith(("127.", "169.254.")):
                        continue
                    try:
                        net = ipaddress.IPv4Network(f"{ip.ip}/{ip.network_prefix}", strict=False)
                        if net.prefixlen < 31:
                            out.add(str(net.broadcast_address))
                    except Exception:
                        pass
        except Exception:
            pass
        return out or {"255.255.255.255"}

    def _send_loop(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        addrs, addrs_t = set(), 0.0
        while True:
            try:
                st = CASTER.status()
                if st.get("alive") and st.get("state") in ("PLAYING", "PAUSED", "STARTING") and st.get("uri"):
                    if time.time() - addrs_t > 30:
                        new = self._broadcast_addrs()
                        if new != addrs:
                            log("다른 PC에 AirPlay 상태 알림 →", ", ".join(sorted(new)), f"(UDP {PEER_PORT})")
                        addrs, addrs_t = new, time.time()
                    msg = json.dumps({"lc": 1, "host": self.host, "speaker": st.get("speaker"), "state": st.get("state"),
                                      "uri": st.get("uri"), "position": st.get("position")}).encode("utf-8")
                    for a in addrs:
                        try:
                            s.sendto(msg, (a, PEER_PORT))
                        except Exception:
                            pass
            except Exception:
                pass
            time.sleep(2)

    def _recv_loop(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("0.0.0.0", PEER_PORT))
        except Exception as e:
            log("다른 PC 알림 받기 준비 실패:", e)
            return
        log(f"다른 PC 알림 받는 중 (UDP {PEER_PORT})")
        while True:
            try:
                data, _ = s.recvfrom(4096)
                d = json.loads(data.decode("utf-8"))
                if d.get("lc") == 1 and d.get("host") and d["host"] != self.host:
                    if d["host"] not in self.peers:
                        log(f"다른 PC의 LocalCast 발견: {d['host']} (AirPlay 중: {d.get('speaker')})")
                    self.peers[d["host"]] = (d, time.time())
            except Exception:
                time.sleep(0.2)

    def active(self):
        now = time.time()
        return [d for d, t in self.peers.values() if now - t < 6]

    def start(self):
        threading.Thread(target=self._send_loop, daemon=True).start()
        threading.Thread(target=self._recv_loop, daemon=True).start()


PEERS = PeerBeacon()


def main():
    log(f"===== LocalCast 보조 프로그램 시작 ({VERSION}) =====")
    try:
        control = ThreadingHTTPServer(("127.0.0.1", int(CFG["control_port"])), ControlHandler)
    except OSError as e:
        log("포트를 열 수 없습니다(이미 실행 중일 수 있음):", e)
        return
    control.daemon_threads = True
    threading.Thread(target=INDEX.scan, daemon=True).start()
    threading.Thread(target=CASTER.discover, daemon=True).start()
    PEERS.start()
    log(f"대기 중 ({VERSION}, AirPlay 전용): 제어 127.0.0.1:{CFG['control_port']}")
    if not AIRPLAY_EXE.exists():
        log(f"❌ {AIRPLAY_EXE} 파일이 없습니다 — 백신(Avast 등)이 격리했을 수 있어요")
    try:
        control.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            CASTER.stop()
        except Exception:
            pass
        MUTER.force_unmute()
        log("종료")


def selftest():
    """5_airplay_test.bat 용: 창에서 직접 AirPlay 10초 테스트 (볼륨 15%)."""
    print(f"LocalCast AirPlay 테스트 ({VERSION})")
    print("1) 스피커 찾는 중...")
    CASTER.discover()
    if not CASTER.target:
        print("❌ 스피커를 못 찾았습니다. config.json 의 airplay_ip 에 스피커 IP를 넣어보세요.")
        return 1
    name, ip, port = CASTER.target
    print(f"   → {name} ({ip}:{port})")
    if not INDEX.entries:
        INDEX.scan()
    files = [p for p in INDEX.entries if os.path.splitext(p)[1].lower() not in AIRPLAY_UNSUPPORTED and os.path.exists(p)]
    if not files:
        print("❌ 음악 폴더에서 파일을 못 찾았습니다 (config.json 의 music_folders 확인).")
        return 1
    path = sorted(files)[0]
    print(f"2) 테스트 곡: {Path(path).name}")
    print("   (Windows 방화벽 창이 뜨면 '허용'을 누르세요)")
    dbg = open_airplay_debug_log("TEST " + Path(path).name)
    env = dict(os.environ, LC_DEBUG="1")
    p = subprocess.Popen([str(AIRPLAY_EXE), ip, str(port), path, "--start", "0", "--volume", "15"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=dbg or subprocess.DEVNULL,
                         text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
    if dbg:
        dbg.close()
    ok = False
    t0 = time.time()
    err = None
    step = "시작"
    for line in p.stdout:
        line = line.strip()
        if line.startswith("POS "):
            if ok and time.time() - t_play > 10:
                p.stdin.write("quit\n"); p.stdin.flush()
            continue
        if line.startswith("STEP "):
            step = line[5:]
            print(f"   · {step} ({time.time()-t0:.1f}초)")
            continue
        if line == "PLAYING":
            ok = True
            t_play = time.time()
            print(f"3) ✅ 재생 시작 ({time.time()-t0:.1f}초) — 스피커에서 10초간 소리가 나야 합니다")
            continue
        if line.startswith("ERROR"):
            err = line
            print("   ", line)
        if line == "STOPPED":
            break
    p.wait()
    print()
    if ok:
        print("✅ 테스트 성공. AirPlay가 정상입니다.")
    else:
        print(f"❌ 테스트 실패 (단계: {step}) {err or ''}")
        for l in airplay_debug_tail(15):
            print("   │", l[:200])
        print()
        print("  - 방화벽 허용이 됐는지 확인하고 한 번 더 실행해보세요.")
        print("  - 그래도 안 되면 스피커 전원을 껐다 켠 뒤 다시 실행해보세요.")
        print("  - 이 창의 내용과 airplay_debug.log 를 보내주세요.")
    return 0 if ok else 1


def supervise():
    """보조 프로그램이 오류로 꺼지면 자동으로 다시 켬 (정상 종료 요청이면 그대로 끝)"""
    flags = 0x08000000 if sys.platform == "win32" else 0
    fails = []
    if "--boot" in sys.argv:
        # PC가 막 켜짐: 소리 장치·네트워크가 준비될 때까지 잠깐 기다렸다가 시작
        time.sleep(15)
    while True:
        try:
            p = subprocess.Popen([sys.executable, str(Path(__file__).resolve())], cwd=str(Path.home()), creationflags=flags,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            code = p.wait()
        except Exception as e:
            log("감시: 실행 오류", e)
            code = 1
        if code == 0:
            return
        now = time.time()
        fails = [t for t in fails if now - t < 300] + [now]
        # 절대 포기하지 않음: 자주 꺼지면 간격만 늘림 (2초 → 최대 60초)
        wait = min(60, 2 * len(fails))
        log(f"⚠ 보조 프로그램이 예기치 않게 꺼짐(코드 {code}) → {wait}초 뒤 다시 켭니다")
        time.sleep(wait)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if "--supervise" in sys.argv:
        log(f"감시 프로그램 시작 ({VERSION}{', PC 시작 후 15초 대기' if '--boot' in sys.argv else ''})")
        supervise()
        sys.exit(0)
    try:
        main()
    except Exception:
        log("❌ 보조 프로그램 오류로 종료:", traceback.format_exc())
        sys.exit(1)
