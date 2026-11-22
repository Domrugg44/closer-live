# Pre-post data check for a new pick, using only games played BEFORE the pick's game.
# Dot-sourced by add-pick.ps1. Get-PickCase returns @{ Pass; Summary; Details }.
#
# Rules (the same ones used to review the 2026-11 starter picks):
#   prop   : the player cleared the line (in the pick's direction) in at least half of his last 10 games
#   total  : at least half of the two teams' last 5 games each went the pick's way
#   spread : on each team's average margin over its last 5 games, the picked team would cover
#            (rough: it doesn't adjust for who those games were against, so a forced pick with a reason
#             is reasonable when, say, a big favorite's recent opponents were strong)
# Data: ESPN's public game data (the same source the website displays).

$script:EspnBase = @{ NFL = "football/nfl"; CFB = "football/college-football"; NBA = "basketball/nba"; CBB = "basketball/mens-college-basketball"; NHL = "hockey/nhl" }
$script:StatNames = @{
  "Rush yards" = @(, @("rushingYards")); "Rec yards" = @(, @("receivingYards")); "Receptions" = @(, @("receptions")); "Pass yards" = @(, @("passingYards"))
  "Points" = @(, @("points")); "Rebounds" = @(, @("totalRebounds", "rebounds")); "Assists" = @(, @("assists"))
  "Pts + Reb" = @(@("points"), @("totalRebounds", "rebounds")); "Pts + Ast" = @(@("points"), @("assists"))
  "Pts + Reb + Ast" = @(@("points"), @("totalRebounds", "rebounds"), @("assists"))
}

function Get-EspnJson([string]$url) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-RestMethod -Uri $url -TimeoutSec 30
}
function Get-SeasonFor([string]$league, [DateTime]$d) {
  if (@("NBA", "CBB", "NHL") -contains $league) { if ($d.Month -ge 8) { $d.Year + 1 } else { $d.Year } } else { if ($d.Month -ge 3) { $d.Year } else { $d.Year - 1 } }
}
function Get-Score($v) { if ($null -eq $v) { return $null }; if ($v -is [string] -or $v -is [ValueType]) { return [double]$v }; if ($null -ne $v.value) { return [double]$v.value }; return [double]$v.displayValue }

# a team's completed games before $before, newest first
function Get-LastGames([string]$league, [string]$teamId, [DateTime]$before, [int]$n = 5) {
  $s = Get-EspnJson "https://site.api.espn.com/apis/site/v2/sports/$($script:EspnBase[$league])/teams/$teamId/schedule?season=$(Get-SeasonFor $league $before)"
  $games = foreach ($e in @($s.events)) {
    $t = [DateTime]::Parse($e.date).ToUniversalTime(); if ($t -ge $before) { continue }
    $c = @($e.competitions)[0]; if (-not $c.status.type.completed) { continue }
    $me = @($c.competitors) | Where-Object { [string]$_.team.id -eq $teamId } | Select-Object -First 1
    $op = @($c.competitors) | Where-Object { [string]$_.team.id -ne $teamId } | Select-Object -First 1
    if (-not $me -or -not $op) { continue }
    [pscustomobject]@{ date = $t; us = (Get-Score $me.score); them = (Get-Score $op.score) }
  }
  @($games | Sort-Object date -Descending | Select-Object -First $n)
}

function Get-PickCase {
  param([string]$League, [string]$EventId, [string]$Kind, [string]$Team, [string]$Side, [string]$Player, [string]$Stat, [double]$Line, [DateTime]$Start)
  $base = $script:EspnBase[$League]
  $sum = Get-EspnJson "https://site.api.espn.com/apis/site/v2/sports/$base/summary?event=$EventId"
  $comps = @(@($sum.header.competitions)[0].competitors)
  if (-not $comps.Count) { return @{ Pass = $false; Summary = "No game data found for event $EventId" } }
  $over = ($Side -eq "Over")

  if ($Kind -eq "prop") {
    if (-not $script:StatNames.ContainsKey($Stat)) { return @{ Pass = $false; Summary = "No data check is set up for the stat '$Stat'" } }
    $ath = $null
    foreach ($c in $comps) {
      $ro = Get-EspnJson "https://site.api.espn.com/apis/site/v2/sports/$base/teams/$($c.team.id)/roster"
      $list = @($ro.athletes); if ($list.Count -and $list[0].items) { $list = @($list | ForEach-Object { $_.items }) }
      $ath = $list | Where-Object { $_.displayName -eq $Player } | Select-Object -First 1
      if ($ath) { break }
    }
    if (-not $ath) { return @{ Pass = $false; Summary = "Couldn't find $Player on either roster (check the spelling)" } }
    $gl = Get-EspnJson "https://site.web.api.espn.com/apis/common/v3/sports/$base/athletes/$($ath.id)/gamelog?season=$(Get-SeasonFor $League $Start)"
    $names = @($gl.names)
    $idx = foreach ($alts in $script:StatNames[$Stat]) { $i = ($alts | ForEach-Object { [array]::IndexOf($names, $_) } | Where-Object { $_ -ge 0 } | Select-Object -First 1); if ($null -eq $i) { return @{ Pass = $false; Summary = "ESPN's game log has no '$Stat' column" } }; $i }
    $rows = foreach ($t in @($gl.seasonTypes)) { if ($t.displayName -match "Preseason") { continue }; foreach ($cat in @($t.categories)) { @($cat.events) } }
    $games = foreach ($r in $rows) {
      $meta = $gl.events.($r.eventId); if (-not $meta) { continue }
      $d = [DateTime]::Parse($meta.gameDate).ToUniversalTime(); if ($d -ge $Start) { continue }
      $v = 0.0; foreach ($i in $idx) { $x = 0.0; [void][double]::TryParse([string]$r.stats[$i], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$x); $v += $x }
      [pscustomobject]@{ date = $d; v = $v }
    }
    $games = @($games | Sort-Object date -Descending | Select-Object -First 10)
    if ($games.Count -lt 3) { return @{ Pass = $false; Summary = "Only $($games.Count) earlier games this season; not enough to check" } }
    $hits = @($games | Where-Object { if ($over) { $_.v -gt $Line } else { $_.v -lt $Line } }).Count
    $avg = [Math]::Round((($games | Measure-Object v -Average).Average), 1)
    $vals = ($games | ForEach-Object { $_.v }) -join ", "
    return @{ Pass = ($hits / $games.Count -ge 0.5); Summary = "$(if($over){'Over'}else{'Under'}) $Line hit in $hits of last $($games.Count) ($vals; avg $avg)" }
  }

  $awayC = $comps | Where-Object { $_.homeAway -eq "away" } | Select-Object -First 1
  $homeC = $comps | Where-Object { $_.homeAway -eq "home" } | Select-Object -First 1
  $fa = @(Get-LastGames $League ([string]$awayC.team.id) $Start)
  $fh = @(Get-LastGames $League ([string]$homeC.team.id) $Start)
  if ($fa.Count -lt 3 -or $fh.Count -lt 3) { return @{ Pass = $false; Summary = "Not enough earlier games to check ($($fa.Count) and $($fh.Count))" } }

  if ($Kind -eq "total") {
    $all = @($fa) + @($fh)
    $k = @($all | Where-Object { $t = $_.us + $_.them; if ($over) { $t -gt $Line } else { $t -lt $Line } }).Count
    $avg = [Math]::Round((($all | ForEach-Object { $_.us + $_.them } | Measure-Object -Average).Average), 1)
    return @{ Pass = ($k / $all.Count -ge 0.5); Summary = "$k of the teams' last $($all.Count) games went $(if($over){'over'}else{'under'}) $Line (avg total $avg)" }
  }
  if ($Kind -eq "spread") {
    $pickHome = ($homeC.team.abbreviation -eq $Team)
    if (-not $pickHome -and $awayC.team.abbreviation -ne $Team) { return @{ Pass = $false; Summary = "Team '$Team' isn't in this game ($($awayC.team.abbreviation) @ $($homeC.team.abbreviation))" } }
    $avgM = { param($f) ($f | ForEach-Object { $_.us - $_.them } | Measure-Object -Average).Average }
    $mt = & $avgM $(if ($pickHome) { $fh } else { $fa }); $mo = & $avgM $(if ($pickHome) { $fa } else { $fh })
    $proj = ($mt - $mo) / 2
    return @{ Pass = ($proj + $Line -gt 0); Summary = "Last-5 average margins: $Team $([Math]::Round($mt,1)), opponent $([Math]::Round($mo,1)); projected $Team by $([Math]::Round($proj,1)) vs line $Line" }
  }
  return @{ Pass = $false; Summary = "No data check is set up for '$Kind' picks" }
}
