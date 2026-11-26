param([string]$Url = "")

# Spicetify 확장 업데이트 (jihoon-updater:// 로 실행됨)
$Owner = "jbag81611"
$Repo = "spicetify-extension"
$Branch = "main"
$Raw = "https://raw.githubusercontent.com/$Owner/$Repo/$Branch"
$Api = "https://api.github.com/repos/$Owner/$Repo/contents"
$Home2 = Join-Path $env:LOCALAPPDATA "JihoonSpicetify"

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { $Host.UI.RawUI.WindowTitle = "Spicetify 확장 업데이트" } catch {}

function Step($t) { Write-Host ""; Write-Host "▶ $t" -ForegroundColor Cyan }
function Cmd($t) { Write-Host "PS> $t" -ForegroundColor DarkGray }
function Ok($t) { Write-Host "  ✔ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }

# GitHub API로 받기 (raw 캐시 때문에 방금 올린 파일이 늦게 보이는 것 방지), 실패하면 raw
function Get-RepoFile([string]$Path, [string]$OutFile) {
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$Api/$($Path)?ref=$Branch&t=$ts" -Headers @{ Accept = "application/vnd.github.raw+json" } -UserAgent "jihoon-updater" -OutFile $OutFile
    } catch {
        Invoke-WebRequest -UseBasicParsing -Uri "$Raw/$($Path)?t=$ts" -OutFile $OutFile
    }
}

function Find-Spicetify {
    $c = Get-Command spicetify -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:LOCALAPPDATA\spicetify\spicetify.exe", "$env:USERPROFILE\spicetify-cli\spicetify.exe", "$env:USERPROFILE\.spicetify\spicetify.exe")) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    throw "spicetify를 찾지 못했어요. Spicetify가 설치돼 있는지 확인해 주세요."
}

# spicetify 출력 받기 (stdout/stderr 둘 다)
function Spice-Output([string[]]$Arguments) {
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { return @(& $script:Spice @Arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $old }
}
function Spice-Run([string[]]$Arguments) {
    Cmd ("spicetify " + ($Arguments -join " "))
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & $script:Spice @Arguments 2>&1 | ForEach-Object { Write-Host "  $_" } } finally { $ErrorActionPreference = $old }
}

function Get-FileVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [IO.File]::ReadAllText($Path)
    $m = [regex]::Match($text, '(?m)^\s*//\s*VERSION:\s*v?(\d+(?:\.\d+)*)')
    if (-not $m.Success) { $m = [regex]::Match($text, 'VERSION\s*=\s*["'']v?(\d+(?:\.\d+)*)') }
    if ($m.Success) { return $m.Groups[1].Value }
    return "0"
}
function Compare-Ver([string]$a, [string]$b) {
    $x = $a.Split("."); $y = $b.Split(".")
    for ($i = 0; $i -lt [Math]::Max($x.Length, $y.Length); $i++) {
        $p = 0; $q = 0
        if ($i -lt $x.Length) { $p = [int]$x[$i] }
        if ($i -lt $y.Length) { $q = [int]$y[$i] }
        if ($p -ne $q) { if ($p -gt $q) { return 1 } else { return -1 } }
    }
    return 0
}

$exitCode = 0
try {
    Write-Host ""
    Write-Host "  Spicetify 확장 업데이트  ($Owner/$Repo)" -ForegroundColor White
    Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray

    # jihoon-updater://update?only=a.js,b.js → 그 파일만
    $only = @()
    if ($Url -match 'only=([A-Za-z0-9._%,-]+)') {
        $only = @([Uri]::UnescapeDataString($Matches[1]).Split(",") | Where-Object { $_ -match '^[A-Za-z0-9._-]+\.m?js$' })
    }

    Step "Spicetify 찾는 중"
    $script:Spice = Find-Spicetify
    Ok $script:Spice

    $userData = (Spice-Output @("path", "userdata") | Where-Object { $_ -and (Test-Path -LiteralPath $_.Trim()) } | Select-Object -First 1)
    if ($userData) { $extDir = Join-Path $userData.Trim() "Extensions" } else { $extDir = Join-Path $env:APPDATA "spicetify\Extensions" }
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    Ok "확장 폴더: $extDir"

    Step "새 버전 확인"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("jihoon-updater-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $manifestPath = Join-Path $tmp "manifest.json"
    Cmd "다운로드 manifest.json"
    Get-RepoFile "manifest.json" $manifestPath
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json

    $enabled = @(Spice-Output @("config", "extensions") | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.m?js$' })

    $todo = @()
    foreach ($e in $manifest.extensions) {
        if ($only.Count -gt 0 -and ($only -notcontains $e.file)) { continue }
        $local = Join-Path $extDir $e.file
        $cur = Get-FileVersion $local
        $isOn = $enabled -contains $e.file
        if ($null -eq $cur -or -not $isOn) {
            $todo += [pscustomobject]@{ Entry = $e; From = $cur; New = (-not $isOn) }
        } elseif ((Compare-Ver $e.version $cur) -gt 0) {
            $todo += [pscustomobject]@{ Entry = $e; From = $cur; New = $false }
        }
    }

    if ($todo.Count -eq 0) {
        Ok "이미 모두 최신 버전이에요"
    } else {
        foreach ($t in $todo) {
            if ($t.From) { $v = "$($t.From) → $($t.Entry.version)" } else { $v = "새로 설치 $($t.Entry.version)" }
            Write-Host ("  • {0} ({1})  {2}" -f $t.Entry.name, $t.Entry.file, $v)
        }

        Step "파일 받기"
        foreach ($t in $todo) {
            $f = $t.Entry.file
            $out = Join-Path $tmp $f
            Cmd "다운로드 extensions/$f"
            Get-RepoFile "extensions/$f" $out
            $hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
            if ($t.Entry.sha256 -and $hash -ne $t.Entry.sha256.ToUpper()) {
                throw "$f 파일이 GitHub에 올라간 것과 달라요 (확인값 불일치). 잠시 후 다시 시도해 주세요."
            }
            Ok "$f 확인 완료"
        }

        Step "지금 파일 백업"
        $bk = Join-Path $extDir ("_backup\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
        foreach ($t in $todo) {
            $local = Join-Path $extDir $t.Entry.file
            if (Test-Path -LiteralPath $local) {
                New-Item -ItemType Directory -Force -Path $bk | Out-Null
                Copy-Item -LiteralPath $local -Destination $bk -Force
                Ok "$($t.Entry.file) → $bk"
            }
        }

        Step "새 파일로 바꾸기"
        foreach ($t in $todo) {
            Cmd "Copy-Item $($t.Entry.file) `"$extDir`""
            Copy-Item -LiteralPath (Join-Path $tmp $t.Entry.file) -Destination (Join-Path $extDir $t.Entry.file) -Force
        }
        foreach ($t in @($todo | Where-Object { $_.New })) {
            Spice-Run @("config", "extensions", $t.Entry.file)
        }

        Step "Spotify에 적용"
        Spice-Run @("apply")
        Ok "업데이트 완료"
    }

    # 업데이트 프로그램 자신도 최신으로
    try {
        $self = Join-Path $tmp "updater.ps1"
        Get-RepoFile "installer/updater.ps1" $self
        New-Item -ItemType Directory -Force -Path $Home2 | Out-Null
        Copy-Item -LiteralPath $self -Destination (Join-Path $Home2 "updater.ps1") -Force
    } catch { Warn "업데이트 프로그램 갱신은 건너뜀: $($_.Exception.Message)" }

    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    $exitCode = 1
    Write-Host ""
    Write-Host "  ✖ 업데이트 실패: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "  5초 뒤 창이 닫혀요." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
} else {
    Read-Host "  Enter를 누르면 창이 닫혀요"
}
exit $exitCode
