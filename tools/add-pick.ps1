# Appends one new prediction to the log, timestamped now and chained to the previous entry.
# Example (spread):
#   powershell -File tools/add-pick.ps1 -League NFL -Game "MIA @ BUF" -EventId 401873070 -Start 2026-11-22T18:00Z `
#     -Kind spread -Team BUF -Line -16.5 -Odds -107 -Label "BUF -16.5" -Tier Solid -Why "..."
# Totals use -Side Over/Under; props use -Kind prop -Player "Full Name" -Stat "Points" -Side Over.
# -Odds is the price available when the pick is made. Leave it out only if it truly wasn't recorded.
# -Prob is accepted only with -Source validated (a model with a published backtest).
#
# DATA CHECK: every manual pick is first checked against real numbers from games played before it
# (tools/check-pick.ps1). If the numbers don't support the pick, it is NOT logged. To post it anyway,
# add -Force -ForceReason "why the numbers miss something". The check result, and any reason, are
# saved in the pick's locked note, so members can see exactly what was checked.
# -CheckOnly runs the check and logs nothing.
param(
  [Parameter(Mandatory)][ValidateSet("NFL", "CFB", "NBA", "CBB", "NHL")][string]$League,
  [Parameter(Mandatory)][string]$Game,
  [Parameter(Mandatory)][string]$EventId,
  [Parameter(Mandatory)][string]$Start,
  [Parameter(Mandatory)][ValidateSet("spread", "total", "prop", "ml")][string]$Kind,
  [Parameter(Mandatory)][string]$Label,
  [Nullable[double]]$Line, [Nullable[int]]$Odds,
  [string]$Team, [ValidateSet("", "Over", "Under")][string]$Side = "", [string]$Player, [string]$Stat,
  [ValidateSet("manual", "experimental", "validated")][string]$Source = "manual",
  [ValidateSet("", "Strong", "Solid", "Lean")][string]$Tier = "",
  [string]$Why, [Nullable[double]]$Prob,
  [switch]$Force, [string]$ForceReason = "", [switch]$CheckOnly,
  [string]$Path = ""
)
$ErrorActionPreference = "Stop"
if (-not $Path) { $Path = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\data\record.json" }
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "log-lib.ps1")
if ($null -ne $Prob -and $Source -ne "validated") { throw "A probability can only be logged for a validated model." }
$doc = Read-Log $Path
$entries = @($doc.entries)
$p = @(Test-Chain $entries); if ($p.Count) { throw "Log failed its integrity check; fix that first." }
$now = (Get-Date).ToUniversalTime()
$startT = [DateTime]::Parse($Start).ToUniversalTime()

# ---- data check (manual picks; model picks are validated through QC instead) ----
if ($Source -eq "manual") {
  if (-not $Why) { throw "Write the case for this pick with -Why (what you see that the numbers support)." }
  if ($Kind -in @("spread", "total", "prop") -and $null -eq $Line) { throw "-Line is required for $Kind picks." }
  . (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "check-pick.ps1")
  $case = Get-PickCase -League $League -EventId $EventId -Kind $Kind -Team $Team -Side $Side -Player $Player -Stat $Stat -Line ([double]$Line) -Start $startT
  Write-Host "Data check: $(if($case.Pass){'SUPPORTS this pick'}else{'does NOT support this pick'})"
  Write-Host "  $($case.Summary)"
  if ($CheckOnly) { return }
  if (-not $case.Pass) {
    if (-not $Force) { throw "Not logged: the numbers don't support this pick. Re-run with -Force -ForceReason `"...`" only if you have a real reason the numbers miss." }
    if ($ForceReason.Trim().Length -lt 15) { throw "-ForceReason must explain why (at least a sentence)." }
  }
  $Why = "$Why | Data check: $($case.Summary)$(if(-not $case.Pass){" | Posted against the numbers because: $($ForceReason.Trim())"})"
}
# id prefix by source: M = manual (person-approved), E = experimental engine, V = validated model
$prefix = @{ manual = "M"; experimental = "E"; validated = "V" }[$Source]
$n = 1 + @($entries | Where-Object { $_.id -like "$prefix*" }).Count
$e = [pscustomobject][ordered]@{
  id = "$prefix{0:d4}" -f $n; logged = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); pickTime = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); source = $Source
  lg = $League; game = $Game; eventId = $EventId; date = $startT.ToString("yyyy-MM-ddTHH:mmZ")
  kind = $Kind; label = $Label; team = $(if ($Team) { $Team } else { $null }); side = $(if ($Side) { $Side } else { $null })
  player = $(if ($Player) { $Player } else { $null }); stat = $(if ($Stat) { $Stat } else { $null })
  line = $Line; odds = $Odds; prob = $Prob; tier = $(if ($Tier) { $Tier } else { $null }); why = $(if ($Why) { $Why } else { $null })
  loggedAfterStart = ($now -ge $startT); hash = ""
  status = "pending"; final = $null; actual = $null; diff = $null; units = $null; close = $null; clv = $null; note = $null; gradedAt = $null
}
$e.hash = Get-EntryHash $e $(if ($entries.Count) { $entries[-1].hash } else { "" })
$doc.entries = @($entries) + @($e)
$doc.updatedAt = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
Write-Log $doc (Resolve-Path $Path).Path
Write-Host "Logged $($e.id): $Label ($Game)$(if($e.loggedAfterStart){' - WARNING: game already started; it will be left out of verified stats'})"
