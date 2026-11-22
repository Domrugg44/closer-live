# Checks that the prediction log hasn't been tampered with.
#   powershell -File tools/verify-log.ps1                 # check the hash chain
#   powershell -File tools/verify-log.ps1 -BaseRef HEAD~1  # also compare with an earlier commit
# Exits 1 (and GitHub marks the check failed) if anything is wrong.
param([string]$Path = (Join-Path $PSScriptRoot "..\data\record.json"), [string]$BaseRef = "")
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "log-lib.ps1")

$doc = Read-Log $Path
$cur = @($doc.entries)
$problems = @(Test-Chain $cur)
$finalStates = @("W", "L", "P", "void")

$ids = @{}
foreach ($e in $cur) {
  if ($ids.ContainsKey($e.id)) { $problems += "Duplicate id $($e.id)" } else { $ids[$e.id] = $true }
  if ($e.date -and $e.logged) {
    $late = [DateTime]::Parse($e.logged).ToUniversalTime() -ge [DateTime]::Parse($e.date).ToUniversalTime()
    if ($late -and -not $e.loggedAfterStart) { $problems += "Entry $($e.id) was logged after its game started but isn't flagged loggedAfterStart" }
  }
  if ($e.source -ne "validated" -and $null -ne $e.prob) { $problems += "Entry $($e.id) has a probability but its source ($($e.source)) is not a validated model" }
}

$compared = $false
if ($BaseRef) {
  $raw = $null
  try { $raw = (& git show "$($BaseRef):data/record.json" 2>$null) -join "`n" } catch {}
  if (-not $raw) { Write-Host "No earlier log at $BaseRef; chain check only." }
  else {
    $base = $raw | ConvertFrom-Json
    if ($base.schema -ne 2) { Write-Host "Earlier log at $BaseRef predates schema 2; chain check only." }
    else {
      $old = @($base.entries); $compared = $true
      # A documented reset (CEO decision) may clear the log once: only when the new log's "reset" block names an
      # archive file whose hash chain is intact and matches, entry for entry, the log being replaced.
      $isReset = $false
      if ($doc.reset -and $old.Count -gt 0 -and $old.Count -eq [int]$doc.reset.previousEntries -and $old[-1].hash -eq $doc.reset.previousLastHash) {
        $arcPath = Join-Path (Split-Path -Parent $PSScriptRoot) $doc.reset.archive
        if (Test-Path $arcPath) {
          $arc = @((Read-Log $arcPath).entries)
          if (-not @(Test-Chain $arc).Count -and $arc.Count -eq $old.Count -and $arc[-1].hash -eq $old[-1].hash) { $isReset = $true }
        }
        if (-not $isReset) { $problems += "The log was reset, but its archive ($($doc.reset.archive)) is missing or doesn't match the replaced log" }
      }
      if ($isReset) { Write-Host "Documented reset: $($old.Count) entries moved to $($doc.reset.archive) ($($doc.reset.reason))"; $old = @() }
      elseif ($cur.Count -lt $old.Count) { $problems += "Entries were removed ($($old.Count) before, $($cur.Count) now)" }
      for ($i = 0; $i -lt [Math]::Min($old.Count, $cur.Count); $i++) {
        $a = $old[$i]; $b = $cur[$i]
        if ($a.id -ne $b.id -or $a.hash -ne $b.hash) { $problems += "Entry $($a.id) was changed, moved or replaced"; continue }
        if ($finalStates -contains $a.status) {
          $ra = ($ResultFields | ForEach-Object { ConvertTo-CanonValue ($a.$_ | ConvertTo-Json -Compress -Depth 5) }) -join $Sep
          $rb = ($ResultFields | ForEach-Object { ConvertTo-CanonValue ($b.$_ | ConvertTo-Json -Compress -Depth 5) }) -join $Sep
          if ($ra -ne $rb) { $problems += "Entry $($a.id) already had a final result ($($a.status)) that was changed" }
        }
      }
      $lastLogged = if ($old.Count) { [DateTime]::Parse($old[-1].logged).ToUniversalTime() } else { [DateTime]::MinValue }
      for ($i = $old.Count; $i -lt $cur.Count; $i++) {
        $t = [DateTime]::Parse($cur[$i].logged).ToUniversalTime()
        if ($t -lt $lastLogged) { $problems += "New entry $($cur[$i].id) is timestamped before entries already in the log" }
        if ($t -gt (Get-Date).ToUniversalTime().AddMinutes(15)) { $problems += "New entry $($cur[$i].id) is timestamped in the future" }
      }
    }
  }
}

if ($problems.Count) { $problems | ForEach-Object { Write-Host "PROBLEM: $_" }; exit 1 }
Write-Host "Log verified: $($cur.Count) entries, hash chain intact$(if($compared){", no past entries or final results changed since $BaseRef"})."
