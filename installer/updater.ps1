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

function Find-Python {
    foreach ($c in @(@("py", "-3"), @("python"))) {
        $cmd = Get-Command $c[0] -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $a = @($c | Select-Object -Skip 1)
        $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        try { $v = & $cmd.Source @a -c "import sys; print(sys.version_info >= (3, 11))" 2>$null } finally { $ErrorActionPreference = $old }
        if ("$v".Trim() -eq "True") { return ,(@($cmd.Source) + $a) }
    }
    return $null
}
function Run-Py([string[]]$Py, [string[]]$Arguments) {
    Cmd ("python " + ($Arguments -join " "))
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try {
        $exe = $Py[0]; $pre = @($Py | Select-Object -Skip 1)
        & $exe @pre @Arguments 2>&1 | ForEach-Object { Write-Host "  $_" }
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
}

# 패키지 (예: C:\LocalCast 보조 프로그램): 받기 → 확인 → 실행 중인 것 끄기 → 폴더 전부 지우고 새로 → 라이브러리·방화벽·자동 실행
function Install-Package($p, [string]$TmpDir) {
    $dest = Join-Path $env:SystemDrive $p.install_dir
    $stage = Join-Path $TmpDir ("pkg-" + $p.id)
    Step "$($p.name) 받기 ($($p.files.Count)개 파일)"
    foreach ($f in $p.files) {
        $out = Join-Path $stage ($f.path -replace "/", "\")
        New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
        Get-RepoFile "packages/$($p.id)/$($f.path)" $out
        $hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
        if ($hash -ne $f.sha256.ToUpper()) { throw "$($f.path) 파일이 GitHub에 올라간 것과 달라요 (확인값 불일치). 잠시 후 다시 시도해 주세요." }
    }
    Ok "파일 확인 완료"

    $py = Find-Python
    if (-not $py) { throw "Python 3.11 이상을 찾지 못했어요. python.org 에서 설치(Add python.exe to PATH 체크) 후 다시 업데이트해 주세요." }

    Step "실행 중인 $($p.name) 끄기"
    Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $PID) -and (($_.CommandLine -like '*localcast_helper.py*') -or ($_.Name -eq 'lc_airplay.exe')) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Ok "끔"

    Step "$dest 새로 설치 (기존 파일 전부 지움)"
    if (Test-Path -LiteralPath $dest) { Get-ChildItem -LiteralPath $dest -Force | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $stage "*") -Destination $dest -Recurse -Force
    Ok "$dest"

    Step "라이브러리 확인"
    $code = Run-Py $py @("-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", (Join-Path $dest "requirements.txt"))
    if ($code -ne 0) { Warn "라이브러리 설치에 문제가 있었어요 (인터넷 연결 확인)" } else { Ok "완료" }

    $fw = Join-Path $dest "bin\firewall_allow.bat"
    if (Test-Path -LiteralPath $fw) {
        Step "Windows 방화벽 확인 (막혀 있을 때만 관리자 확인 창 → 예)"
        $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        try {
            $pyDir = & $py[0] @($py | Select-Object -Skip 1) -c "import sys,os;print(os.path.dirname(sys.executable))" 2>$null
            $env:LC_PYDIR = "$pyDir".Trim()
            & cmd.exe /c "`"$fw`"" | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "방화벽 OK" } else { Warn "방화벽을 고치지 못했어요 (관리자 확인 창에서 예를 눌러야 해요)" }
        } catch { Warn "방화벽 확인은 건너뜀: $($_.Exception.Message)" } finally { $ErrorActionPreference = $old }
    }

    Step "$($p.name) 다시 켜기 (PC 켤 때 자동 실행 포함)"
    Push-Location $dest
    try { $code = Run-Py $py @("autostart.py", "on") } finally { Pop-Location }
    if ($code -eq 0) { Ok "$($p.name) $($p.version) 실행 중" } else { Warn "다시 켜지 못했어요: $dest\2_restart_helper.bat 을 실행해 주세요" }
}

$exitCode = 0
try {
    Write-Host ""
    Write-Host "  Spicetify 확장 업데이트  ($Owner/$Repo)" -ForegroundColor White
    Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray

    # 업데이트 프로그램이 GitHub 것과 다르면 먼저 최신으로 바꾸고 그걸로 다시 실행 (새 기능이 바로 적용되게)
    if (-not $env:JIHOON_UPDATER_FRESH -and $PSCommandPath) {
        try {
            $fresh = Join-Path ([IO.Path]::GetTempPath()) ("jihoon-updater-self-" + [Guid]::NewGuid().ToString("N") + ".ps1")
            Get-RepoFile "installer/updater.ps1" $fresh
            if ((Get-FileHash -LiteralPath $fresh).Hash -ne (Get-FileHash -LiteralPath $PSCommandPath).Hash) {
                New-Item -ItemType Directory -Force -Path $Home2 | Out-Null
                $mine = Join-Path $Home2 "updater.ps1"
                Copy-Item -LiteralPath $fresh -Destination $mine -Force
                Remove-Item -LiteralPath $fresh -Force -ErrorAction SilentlyContinue
                Ok "업데이트 프로그램을 최신으로 바꿨어요"
                $env:JIHOON_UPDATER_FRESH = "1"
                & $mine -Url $Url
                exit $LASTEXITCODE
            }
            Remove-Item -LiteralPath $fresh -Force -ErrorAction SilentlyContinue
        } catch { Warn "업데이트 프로그램 확인은 건너뜀: $($_.Exception.Message)" }
    }

    # jihoon-updater://update?only=a.js,b.js → 그 파일만
    $only = @()
    if ($Url -match 'only=([A-Za-z0-9._%,-]+)') {
        $only = @([Uri]::UnescapeDataString($Matches[1]).Split(",") | Where-Object { $_ -match '^[A-Za-z0-9._-]+\.(m?js|pkg)$' })
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

    # 패키지: 설치돼 있으면 버전 비교. 없으면 그 짝 확장(localcast.js)을 쓰는 중이거나 직접 고른 경우에만 새로 설치
    $pkgTodo = @()
    foreach ($p in @($manifest.packages)) {
        if (-not $p -or -not $p.id) { continue }
        $pairJs = "$($p.id).js"
        if ($only.Count -gt 0 -and ($only -notcontains $p.file) -and ($only -notcontains $pairJs)) { continue }
        $dest = Join-Path $env:SystemDrive $p.install_dir
        $cur = Get-FileVersion (Join-Path $dest "localcast_helper.py")
        if ($null -eq $cur) {
            $wanted = ($only -contains $p.file) -or ($enabled -contains $pairJs) -or (@($todo | Where-Object { $_.Entry.file -eq $pairJs }).Count -gt 0)
            if ($wanted) { $pkgTodo += [pscustomobject]@{ Entry = $p; From = $null } }
        } elseif ((Compare-Ver $p.version $cur) -gt 0) {
            $pkgTodo += [pscustomobject]@{ Entry = $p; From = $cur }
        }
    }
    foreach ($t in $pkgTodo) {
        if ($t.From) { $v = "$($t.From) → $($t.Entry.version)" } else { $v = "새로 설치 $($t.Entry.version)" }
        Write-Host ("  • {0} ({1})  {2}" -f $t.Entry.name, $t.Entry.file, $v)
    }

    if ($todo.Count -eq 0 -and $pkgTodo.Count -eq 0) {
        Ok "이미 모두 최신 버전이에요"
    } elseif ($todo.Count -eq 0) {
        foreach ($t in $pkgTodo) { Install-Package $t.Entry $tmp }
        Ok "업데이트 완료"
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

        foreach ($t in $pkgTodo) { Install-Package $t.Entry $tmp }

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
