# Grades every pending pick in data/record.json against ESPN final results.
# Runs on GitHub every 30 minutes (.github/workflows/grade.yml) and can be run by hand:
#   pwsh tools/grade.ps1
param([string]$Record = (Join-Path $PSScriptRoot "..\data\record.json"))
$ErrorActionPreference = "Stop"

$base = @{ NFL = "football/nfl"; CFB = "football/college-football"; NBA = "basketball/nba"; CBB = "basketball/mens-college-basketball"; NHL = "hockey/nhl" }
$api = "https://site.api.espn.com/apis/site/v2/sports"
# prop stat name -> list of ESPN box score keys to add up (and the stat group for football)
$propKeys = @{
  "Points" = @("points"); "Rebounds" = @("rebounds"); "Assists" = @("assists"); "Pts + Reb" = @("points", "rebounds")
  "Rec yards" = @("receiving:receivingYards"); "Rush yards" = @("rushing:rushingYards"); "Pass yards" = @("passing:passingYards")
}

$doc = Get-Content $Record -Raw | ConvertFrom-Json
$changed = $false
$sumCache = @{}
function Get-Summary($lg, $id) {
  $k = "$lg/$id"
  if (-not $sumCache.ContainsKey($k)) {
    try { $sumCache[$k] = Invoke-RestMethod "$api/$($base[$lg])/summary?event=$id" -TimeoutSec 25 } catch { $sumCache[$k] = $null }
  }
  $sumCache[$k]
}
function Get-Stat($sum, $player, $stat) {
  $want = $propKeys[$stat]; if (-not $want) { return $null }
  $total = 0; $found = $false
  foreach ($w in $want) {
    $grp = $null; $key = $w
    if ($w -like "*:*") { $grp, $key = $w -split ":" }
    foreach ($tp in @($sum.boxscore.players)) {
      foreach ($sg in @($tp.statistics)) {
        if ($grp -and $sg.name -ne $grp) { continue }
        $i = [array]::IndexOf(@($sg.keys), $key); if ($i -lt 0) { continue }
        foreach ($a in @($sg.athletes)) {
          if ($a.athlete.displayName -eq $player) {
            $v = 0.0; if ([double]::TryParse(("" + @($a.stats)[$i]), [ref]$v)) { $total += $v; $found = $true }
          }
        }
      }
    }
  }
  if ($found) { $total } else { $null }
}

foreach ($e in $doc.entries) {
  if ($e.status -ne "pending" -or -not $e.eventId) { continue }
  $s = Get-Summary $e.lg $e.eventId
  if (-not $s) { continue }
  $c = @($s.header.competitions)[0]
  $st = $c.status.type
  $pc = @($s.pickcenter)[0]
  # keep the latest pre-game line as the closing line
  if ($pc -and $st.state -eq "pre") {
    $close = [ordered]@{ spread = $pc.spread; total = $pc.overUnder; details = $pc.details }
    if (($e.close | ConvertTo-Json -Compress) -ne ($close | ConvertTo-Json -Compress)) { $e.close = $close; $changed = $true }
  }
  if (-not $st.completed) { continue }

  $hm = @($c.competitors) | Where-Object homeAway -eq "home"
  $aw = @($c.competitors) | Where-Object homeAway -eq "away"
  $hs = [double]$hm.score; $as = [double]$aw.score
  $e.final = [ordered]@{ away = $aw.team.abbreviation; as = $as; home = $hm.team.abbreviation; hs = $hs }
  if (-not $e.close -and $pc) { $e.close = [ordered]@{ spread = $pc.spread; total = $pc.overUnder; details = $pc.details } }

  $diff = $null; $actual = $null; $clv = $null
  switch ($e.kind) {
    "total" {
      $actual = $as + $hs
      $diff = if ($e.side -eq "Over") { $actual - $e.line } else { $e.line - $actual }
      if ($e.close -and $e.close.total -ne $null) { $clv = if ($e.side -eq "Over") { $e.close.total - $e.line } else { $e.line - $e.close.total } }
    }
    "spread" {
      $isHome = ($e.team -eq $hm.team.abbreviation)
      $actual = if ($isHome) { $hs - $as } else { $as - $hs }
      $diff = $actual + $e.line
      if ($e.close -and $e.close.spread -ne $null) { $cl = if ($isHome) { $e.close.spread } else { - $e.close.spread }; $clv = $e.line - $cl }
    }
    "prop" {
      $actual = Get-Stat $s $e.player $e.stat
      if ($actual -ne $null) { $diff = if ($e.side -eq "Over") { $actual - $e.line } else { $e.line - $actual } }
    }
  }
  if ($e.kind -eq "prop" -and $actual -eq $null) {
    $e.status = "void"; $e.units = 0; $e.note = "Player did not record a stat line; no action."
  } else {
    $e.actual = $actual
    $e.diff = [math]::Round($diff, 1)
    $e.status = if ($diff -gt 0) { "W" } elseif ($diff -lt 0) { "L" } else { "P" }
    $o = if ($e.odds) { [double]$e.odds } else { -110 }
    $win = if ($o -gt 0) { $o / 100 } else { 100 / - $o }
    $e.units = [math]::Round($(if ($e.status -eq "W") { $win } elseif ($e.status -eq "L") { -1 } else { 0 }), 2)
    if ($clv -ne $null) { $e.clv = [math]::Round($clv, 1) }
  }
  $e.gradedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $changed = $true
  Write-Host ("Graded {0} {1}: {2}" -f $e.game, $e.label, $e.status)
}

if ($changed) {
  $doc.updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $json = $doc | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Resolve-Path $Record), $json + "`n", (New-Object Text.UTF8Encoding $false))
  Write-Host "record.json updated"
} else { Write-Host "No changes" }
