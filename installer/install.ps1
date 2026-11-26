# Spicetify 확장 업데이트 설치 (처음 한 번)
# 사용: iwr -useb https://raw.githubusercontent.com/jbag81611/spicetify-extension/main/installer/install.ps1 | iex
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Owner = "jbag81611"
$Repo = "spicetify-extension"
$Raw = "https://raw.githubusercontent.com/$Owner/$Repo/main"
$Dir = Join-Path $env:LOCALAPPDATA "JihoonSpicetify"
$Target = Join-Path $Dir "updater.ps1"
$Protocol = "jihoon-updater"

Write-Host ""
Write-Host "  Spicetify 확장 업데이트 설치" -ForegroundColor White
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Write-Host "PS> 다운로드 installer/updater.ps1" -ForegroundColor DarkGray
Invoke-WebRequest -UseBasicParsing -Uri "$Raw/installer/updater.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $Target

# jihoon-updater:// 주소를 열면 updater.ps1 실행 (이 PC 사용자에게만 등록)
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$root = "HKCU:\Software\Classes\$Protocol"
New-Item -Path $root -Force | Out-Null
Set-Item -Path $root -Value "URL:Jihoon Spicetify Updater"
Set-ItemProperty -Path $root -Name "URL Protocol" -Value ""
New-Item -Path "$root\DefaultIcon" -Force | Out-Null
Set-Item -Path "$root\DefaultIcon" -Value "`"$ps`",0"
New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-Item -Path "$root\shell\open\command" -Value "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$Target`" `"%1`""
Write-Host "  ✔ ${Protocol}:// 등록 완료" -ForegroundColor Green

# 바로 한 번 실행해서 확장 업데이트 프로그램과 최신 확장 설치
& $ps -NoProfile -ExecutionPolicy Bypass -File $Target "jihoon-updater://install"
