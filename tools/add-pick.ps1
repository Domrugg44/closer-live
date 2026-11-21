# Appends one new prediction to the log, timestamped now and chained to the previous entry.
# Example (spread):
#   powershell -File tools/add-pick.ps1 -League NFL -Game "MIA @ BUF" -EventId 401873070 -Start 2026-11-22T18:00Z `
#     -Kind spread -Team BUF -Line -16.5 -Odds -107 -Label "BUF -16.5" -Tier Solid -Why "..."
# Totals use -Side Over/Under; props use -Kind prop -Player "Full Name" -Stat "Points" -Side Over.
# -Odds is the price available when the pick is made. Leave it out only if it truly wasn't recorded.
# -Prob is accepted only with -Source validated (a model with a published backtest).
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
$n = 1 + @($entries | Where-Object { $_.id -like "M*" }).Count
$e = [pscustomobject][ordered]@{
  id = "M{0:d4}" -f $n; logged = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); pickTime = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); source = $Source
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
