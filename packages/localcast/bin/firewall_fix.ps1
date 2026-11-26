# LocalCast firewall check/fix (ASCII only)
#  - allow lc_airplay.exe in/out on every network profile (Private and Public)
#  - remove Windows "Block" rules for lc_airplay.exe / python (created when the Windows popup was dismissed)
#  - allow python inbound so the speaker can be found on the network (mDNS)
#  - allow UDP 8767 inbound (LocalCast on another PC tells this PC it is playing via AirPlay)
# exit 0 = OK, 1 = needs fixing (run with -Apply as admin)
param([string]$Exe, [string]$PyDir = "", [switch]$Apply)
$ErrorActionPreference = 'SilentlyContinue'
$progs = @($Exe)
if ($PyDir) { foreach ($n in 'python.exe','pythonw.exe') { $p = Join-Path $PyDir $n; if (Test-Path -LiteralPath $p) { $progs += $p } } }
function RulesFor($prog) { Get-NetFirewallApplicationFilter -Program $prog | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' } }
function Problems {
  $bad = @()
  foreach ($p in $progs) { if (RulesFor $p | Where-Object { $_.Action -eq 'Block' }) { $bad += "block:$p" } }
  if (-not (RulesFor $Exe | Where-Object { $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' })) { $bad += "noallow:$Exe" }
  foreach ($p in $progs | Select-Object -Skip 1) {
    if (-not (RulesFor $p | Where-Object { $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' })) { $bad += "noallow:$p" }
  }
  if (-not (Get-NetFirewallRule -DisplayName 'LocalCast Peers' | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' })) { $bad += "nopeers" }
  return $bad
}
if (-not $Apply) { if ((Problems).Count -eq 0) { exit 0 } else { exit 1 } }
foreach ($p in $progs) { RulesFor $p | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule }
Get-NetFirewallRule -DisplayName 'LocalCast AirPlay' | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'LocalCast Python' | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'LocalCast Peers' | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'LocalCast Peers' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8767 -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'LocalCast AirPlay' -Direction Inbound -Action Allow -Program $Exe -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'LocalCast AirPlay' -Direction Outbound -Action Allow -Program $Exe -Profile Any | Out-Null
foreach ($p in $progs | Select-Object -Skip 1) {
  New-NetFirewallRule -DisplayName 'LocalCast Python' -Direction Inbound -Action Allow -Program $p -Profile Any | Out-Null
}
if ((Problems).Count -eq 0) { exit 0 } else { exit 1 }
