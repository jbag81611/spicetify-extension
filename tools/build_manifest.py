#!/usr/bin/env python3
"""extensions/*.js 의 VERSION 과 SHA256 을 읽어 manifest.json 을 만듭니다.
사용: python3 tools/build_manifest.py   (저장소 맨 위 폴더에서)
설명(name/notes)은 tools/meta.json 에서 가져옵니다. 새 확장은 meta.json 에 한 줄 추가하세요."""
import hashlib, json, re, sys, datetime, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
meta = json.loads((root / "tools" / "meta.json").read_text(encoding="utf-8"))
exts = []
for f in sorted((root / "extensions").glob("*.js")):
    text = f.read_text(encoding="utf-8")
    m = re.search(r"^\s*//\s*VERSION:\s*v?(\d+(?:\.\d+)*)", text, re.M) or re.search(r"VERSION\s*=\s*[\"']v?(\d+(?:\.\d+)*)", text)
    if not m:
        sys.exit(f"{f.name}: VERSION 없음")
    info = meta.get(f.name, {})
    exts.append({
        "file": f.name,
        "name": info.get("name", f.stem),
        "version": m.group(1),
        "notes": info.get("notes", ""),
        "sha256": hashlib.sha256(f.read_bytes()).hexdigest().upper(),
    })
# 패키지 (확장 js 말고 PC에 따로 설치되는 프로그램, 예: C:\LocalCast 보조 프로그램)
# packages/<id>/ 폴더의 모든 파일 + 버전(VERSION_FILE 안의 VERSION) + SHA256
PKG_VERSION_FILE = {"localcast": "localcast_helper.py"}
PKG_SYNC_JS = {"localcast": "localcast.js"}   # extensions/의 js를 패키지 안에도 똑같이 둠 (수동 설치용 1_install.bat)
pkgs = []
pmeta = meta.get("packages", {})
for d in sorted((root / "packages").glob("*")) if (root / "packages").exists() else []:
    if not d.is_dir():
        continue
    pid = d.name
    if pid in PKG_SYNC_JS:
        (d / PKG_SYNC_JS[pid]).write_bytes((root / "extensions" / PKG_SYNC_JS[pid]).read_bytes())
    vf = d / PKG_VERSION_FILE.get(pid, "VERSION")
    m = re.search(r"VERSION\s*=\s*[\"']v?(\d+(?:\.\d+)*)", vf.read_text(encoding="utf-8")) if vf.exists() else None
    if not m:
        sys.exit(f"packages/{pid}: VERSION 없음")
    files = []
    for f in sorted(p for p in d.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"):
        files.append({"path": f.relative_to(d).as_posix(), "sha256": hashlib.sha256(f.read_bytes()).hexdigest().upper(), "size": f.stat().st_size})
    info = pmeta.get(pid, {})
    pkgs.append({
        "id": pid,
        "file": f"{pid}.pkg",
        "name": info.get("name", pid),
        "version": m.group(1),
        "notes": info.get("notes", ""),
        "install_dir": info.get("install_dir", pid),
        "files": files,
    })
manifest = {
    "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "extensions": exts,
    "packages": pkgs,
}
(root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for e in exts:
    print(f"{e['file']:32} {e['version']:>10}  {e['name']}")
for p in pkgs:
    print(f"{p['file']:32} {p['version']:>10}  {p['name']} ({len(p['files'])} files)")
