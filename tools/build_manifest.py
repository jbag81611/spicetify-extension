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
manifest = {
    "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "extensions": exts,
}
(root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for e in exts:
    print(f"{e['file']:32} {e['version']:>10}  {e['name']}")
