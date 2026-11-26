# Spicetify 확장 모음 (지훈)

ivLyrics 보조 확장과 LocalCast, 그리고 이들을 자동으로 업데이트해 주는 **확장 업데이트**가 들어 있어요.

## 처음 설치 (한 번만)

`installer/설치.bat`을 받아서 실행하거나, PowerShell에 아래를 붙여넣으세요.

```powershell
iwr -useb https://raw.githubusercontent.com/jbag81611/spicetify-extension/main/installer/install.ps1 | iex
```

`jihoon-updater://` 주소가 등록되고, 빠진 확장과 새 버전이 설치된 뒤 `spicetify apply`까지 실행돼요.

## 업데이트

새 버전이 올라오면 Spotify에 안내 창이 뜨고, 프로필 아이콘에 파란 점이 생겨요.
프로필 메뉴 **내 업데이트** 칸이나 안내 창에서 [업데이트]를 누르면 브라우저 → PowerShell 순서로 자동 설치돼요.
바뀌기 전 파일은 `Extensions\_backup\날짜` 폴더에 남아요.

## 새 버전 올리는 법 (관리용)

1. `extensions/`의 파일을 고치고 맨 위 `// VERSION:`을 올립니다.
2. 새 확장이면 `tools/meta.json`에 이름과 설명을 추가합니다.
3. `python3 tools/build_manifest.py` 로 `manifest.json`을 다시 만들고 커밋·푸시합니다.

| 파일 | 설명 |
| --- | --- |
| `extensions/` | 확장 파일 |
| `manifest.json` | 버전·확인값 목록 (Spotify와 업데이트 프로그램이 읽음) |
| `installer/install.ps1` | 처음 설치 |
| `installer/updater.ps1` | 실제 업데이트 (jihoon-updater:// 로 실행) |
| `docs/index.html` | 브라우저 → jihoon-updater:// 로 넘겨주는 페이지 (GitHub Pages) |
