# Closer Engine (Experimental): finds the strongest spread and total spots in upcoming games and logs them.
#
#   powershell -File tools/engine.ps1 -DryRun      # show every game it scored and what it would post
#   powershell -File tools/engine.ps1              # log the picks (source "experimental", ids E0001...)
#
# Rules (fixed in advance; use only information available before each game):
#   Games   : NFL, CFB, NBA, CBB, NHL starting between 30 min and 36 h from now, with a posted spread and total.
#   Signals : 1. Recent form   - last 5 games (average margin for spreads; how often games went over/under for totals)
#             2. Season form   - season average margins (plus a standard home edge) / season scoring averages
#             3. Market        - which way the line has moved since it opened (half a point or more)
#   Post    : only when ALL 3 signals agree on a side. One pick per game.
#   Skip    : teams with fewer than 8 earlier games this season (early-season averages are mostly noise),
#             and spreads bigger than 20 points (blowout lines are too unpredictable).
#   Volume  : every game that passes is posted (no per-sport limit; CEO decision 2026-11-22). A safety limit of
#             15 a game day (US Eastern) only guards against a bug posting dozens by mistake. Strongest first.
# These are simple rules, not a validated model: picks are labeled Experimental and tracked separately.
# Data: ESPN's public feed (unlicensed; CEO accepted the risk, see docs/DATA.md).
param([switch]$DryRun, [string]$Path = "", [int]$HorizonHours = 36, [int]$DailyCap = 15, [int]$LeagueCap = 15, [int]$MinLeadMinutes = 30, [int]$MinGames = 8, [double]$MaxSpread = 20)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Path) { $Path = Join-Path $here "..\data\record.json" }
. (Join-Path $here "log-lib.ps1")
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Inv = [Globalization.CultureInfo]::InvariantCulture

$BaseUrl = "https://site.api.espn.com/apis/site/v2/sports"
$Leagues = [ordered]@{ NFL = "football/nfl"; CFB = "football/college-football"; NBA = "basketball/nba"; CBB = "basketball/mens-college-basketball"; NHL = "hockey/nhl" }
$Extra = @{ CFB = "&groups=80&limit=300"; CBB = "&groups=50&limit=400" }
$HomeEdge = @{ NFL = 1.5; CFB = 2.5; NBA = 2.0; CBB = 3.0; NHL = 0.15 }     # points (goals for NHL) for playing at home
$SdSpread = @{ NFL = 13.5; CFB = 16; NBA = 12; CBB = 11; NHL = 2.4 }       # typical game-to-game spread of margins (for ranking only)
$SdTotal = @{ NFL = 10; CFB = 14; NBA = 18; CBB = 16; NHL = 2.3 }
$Et = [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")

function Get-Json([string]$url) { Start-Sleep -Milliseconds 60; Invoke-RestMethod -Uri $url -TimeoutSec 30 }
function Get-Num($v) { if ($null -eq $v) { return $null }; $s = ([string]$v) -replace '^[ouOU]', ''; $x = 0.0; if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, $Inv, [ref]$x)) { return $x }; return $null }
function Get-ScoreVal($v) { if ($null -eq $v) { return $null }; if ($v -is [string] -or $v -is [ValueType]) { return Get-Num $v }; if ($null -ne $v.value) { return [double]$v.value }; return Get-Num $v.displayValue }
function Get-Season([string]$lg, [DateTime]$d) { if (@("NBA", "CBB", "NHL") -contains $lg) { if ($d.Month -ge 8) { $d.Year + 1 } else { $d.Year } } else { if ($d.Month -ge 3) { $d.Year } else { $d.Year - 1 } } }
function Get-EtDay([DateTime]$utc) { [TimeZoneInfo]::ConvertTimeFromUtc($utc, $Et).ToString("yyyy-MM-dd") }
function Fmt([double]$v) { $r = [Math]::Round($v, 1); if ($r -gt 0) { "+" + $r.ToString($Inv) } else { $r.ToString($Inv) } }

$schedCache = @{}
# completed games for a team before $before: newest first, each { us; them }
function Get-TeamGames([string]$lg, [string]$teamId, [DateTime]$before) {
  $k = "$lg|$teamId"
  if (-not $schedCache.ContainsKey($k)) {
    try { $schedCache[$k] = Get-Json "$BaseUrl/$($Leagues[$lg])/teams/$teamId/schedule?season=$(Get-Season $lg $before)" } catch { $schedCache[$k] = $null }
  }
  $s = $schedCache[$k]; if (-not $s) { return @() }
  $out = foreach ($ev in @($s.events)) {
    $t = [DateTime]::Parse($ev.date, $Inv).ToUniversalTime(); if ($t -ge $before) { continue }
    $c = @($ev.competitions)[0]; if (-not $c -or -not $c.status.type.completed) { continue }
    $me = @($c.competitors) | Where-Object { [string]$_.team.id -eq $teamId } | Select-Object -First 1
    $op = @($c.competitors) | Where-Object { [string]$_.team.id -ne $teamId } | Select-Object -First 1
    if (-not $me -or -not $op) { continue }
    $us = Get-ScoreVal $me.score; $them = Get-ScoreVal $op.score
    if ($null -eq $us -or $null -eq $them) { continue }
    [pscustomobject]@{ date = $t; us = $us; them = $them }
  }
  @($out | Sort-Object date -Descending)
}
function Avg($xs) { if (-not @($xs).Count) { return $null }; (@($xs) | Measure-Object -Average).Average }

# ---------------- gather upcoming games with posted lines ----------------
$now = (Get-Date).ToUniversalTime()
$days = @($now, $now.AddHours(24)) | ForEach-Object { [TimeZoneInfo]::ConvertTimeFromUtc($_, $Et).ToString("yyyyMMdd") } | Select-Object -Unique
$games = @()
foreach ($lg in $Leagues.Keys) {
  foreach ($d in $days) {
    try { $sb = Get-Json "$BaseUrl/$($Leagues[$lg])/scoreboard?dates=$d$($Extra[$lg])" } catch { Write-Host "  ($lg $d scoreboard unavailable)"; continue }
    foreach ($ev in @($sb.events)) {
      $c = @($ev.competitions)[0]; if (-not $c) { continue }
      if ($c.status.type.state -ne "pre") { continue }
      $start = [DateTime]::Parse($ev.date, $Inv).ToUniversalTime()
      if ($start -lt $now.AddMinutes($MinLeadMinutes) -or $start -gt $now.AddHours($HorizonHours)) { continue }
      $o = @($c.odds)[0]; if (-not $o -or -not $o.pointSpread -or -not $o.total) { continue }
      $hm = @($c.competitors) | Where-Object { $_.homeAway -eq "home" } | Select-Object -First 1
      $aw = @($c.competitors) | Where-Object { $_.homeAway -eq "away" } | Select-Object -First 1
      $spH = Get-Num $o.pointSpread.home.close.line; $spHo = Get-Num $o.pointSpread.home.open.line
      $tot = Get-Num $o.total.over.close.line; $totO = Get-Num $o.total.over.open.line
      if ($null -eq $spH -or $null -eq $tot) { continue }
      $games += [pscustomobject]@{
        lg = $lg; id = [string]$ev.id; start = $start; neutral = [bool]$c.neutralSite
        hId = [string]$hm.team.id; hAb = $hm.team.abbreviation; aId = [string]$aw.team.id; aAb = $aw.team.abbreviation
        spH = $spH; spHo = $spHo; spHOdds = [int](Get-Num $o.pointSpread.home.close.odds); spAOdds = [int](Get-Num $o.pointSpread.away.close.odds)
        tot = $tot; totO = $totO; ovOdds = [int](Get-Num $o.total.over.close.odds); unOdds = [int](Get-Num $o.total.under.close.odds)
      }
    }
  }
}
$games = @($games | Sort-Object id -Unique)
Write-Host "Engine: $($games.Count) upcoming games with posted lines in the next $HorizonHours h"

# ---------------- score every game ----------------
$cands = @()
foreach ($g in $games) {
  $fh = Get-TeamGames $g.lg $g.hId $g.start; $fa = Get-TeamGames $g.lg $g.aId $g.start
  if ($fh.Count -lt $MinGames -or $fa.Count -lt $MinGames) { continue }
  $h5 = @($fh | Select-Object -First 5); $a5 = @($fa | Select-Object -First 5)
  $he = if ($g.neutral) { 0 } else { $HomeEdge[$g.lg] }

  # ---- spread (from the home side's view; positive = home covers) ----
  $recent = (Avg ($h5 | ForEach-Object { $_.us - $_.them })) - (Avg ($a5 | ForEach-Object { $_.us - $_.them }))
  $season = (Avg ($fh | ForEach-Object { $_.us - $_.them })) - (Avg ($fa | ForEach-Object { $_.us - $_.them }))
  # Team A's margin minus team B's margin is the expected margin between them (A beats the average team by 6,
  # B loses to it by 4, so A beats B by about 10). An earlier version halved this, which shrank every favorite and
  # tilted spread picks toward underdogs; corrected 2026-11-23.
  $p1 = $recent; $p2 = $season + $he
  $c1 = $p1 + $g.spH; $c2 = $p2 + $g.spH
  $sig = @([Math]::Sign([Math]::Round($c1, 2)), [Math]::Sign([Math]::Round($c2, 2)))
  $mv = $null; if ($null -ne $g.spHo) { $mv = $g.spH - $g.spHo }   # negative = home became more favored
  $sig += $(if ($null -ne $mv -and [Math]::Abs($mv) -ge 0.5) { - [Math]::Sign($mv) } else { 0 })
  $pos = @($sig | Where-Object { $_ -gt 0 }).Count; $neg = @($sig | Where-Object { $_ -lt 0 }).Count
  if (($pos -eq 3 -or $neg -eq 3) -and [Math]::Abs($g.spH) -le $MaxSpread) {
    $homeSide = ($pos -ge 2); $agree = [Math]::Max($pos, $neg)
    $team = if ($homeSide) { $g.hAb } else { $g.aAb }; $opp = if ($homeSide) { $g.aAb } else { $g.hAb }
    $line = if ($homeSide) { $g.spH } else { - $g.spH }; $odds = if ($homeSide) { $g.spHOdds } else { $g.spAOdds }
    $edge = ([Math]::Abs($c1) + [Math]::Abs($c2)) / 2
    $why = "Closer Engine (experimental): $agree of 3 signals on $team $(Fmt $line). " +
      "Recent form (last 5): projects $team by $(Fmt $(if($homeSide){$p1}else{-$p1})). " +
      "Season form: projects $team by $(Fmt $(if($homeSide){$p2}else{-$p2}))$(if($he){" after $($g.hAb)'s home edge"}). " +
      "Market: $(if($null -eq $mv -or [Math]::Abs($mv) -lt 0.5){'line unchanged since open'}else{"opened $team $(Fmt $(if($homeSide){$g.spHo}else{-$g.spHo})), now $(Fmt $line)"})."
    $cands += [pscustomobject]@{ g = $g; kind = "spread"; team = $team; side = ""; line = $line; odds = $odds; label = "$team $(Fmt $line)"
      agree = $agree; score = $agree * 10 + $edge / $SdSpread[$g.lg] * 10; why = $why }
  }

  # ---- total ----
  $T = $g.tot; $last10 = @($h5) + @($a5)
  $share = @($last10 | Where-Object { ($_.us + $_.them) -gt $T }).Count / $last10.Count
  $t1 = if ($share -ge 0.6) { 1 } elseif ($share -le 0.4) { -1 } else { 0 }
  $proj = ((Avg ($fh | ForEach-Object { $_.us })) + (Avg ($fa | ForEach-Object { $_.them })) + (Avg ($fa | ForEach-Object { $_.us })) + (Avg ($fh | ForEach-Object { $_.them }))) / 2
  $diff = $proj - $T
  $t2 = if ([Math]::Abs($diff) / $T -ge 0.02) { [Math]::Sign($diff) } else { 0 }
  $tm = $null; if ($null -ne $g.totO) { $tm = $T - $g.totO }
  $t3 = if ($null -ne $tm -and [Math]::Abs($tm) -ge 0.5) { [Math]::Sign($tm) } else { 0 }
  $ts = @($t1, $t2, $t3); $pos = @($ts | Where-Object { $_ -gt 0 }).Count; $neg = @($ts | Where-Object { $_ -lt 0 }).Count
  if ($pos -eq 3 -or $neg -eq 3) {
    $over = ($pos -ge 2); $agree = [Math]::Max($pos, $neg); $sideTxt = if ($over) { "Over" } else { "Under" }
    $k = @($last10 | Where-Object { if ($over) { ($_.us + $_.them) -gt $T } else { ($_.us + $_.them) -lt $T } }).Count
    $why = "Closer Engine (experimental): $agree of 3 signals on the $sideTxt $T. " +
      "Recent form: $k of the teams' last $($last10.Count) games went $($sideTxt.ToLower()) $T. " +
      "Season form: scoring averages project $([Math]::Round($proj,1)). " +
      "Market: $(if($null -eq $tm -or [Math]::Abs($tm) -lt 0.5){'total unchanged since open'}else{"opened $($g.totO), now $T"})."
    $cands += [pscustomobject]@{ g = $g; kind = "total"; team = ""; side = $sideTxt; line = $T; odds = $(if ($over) { $g.ovOdds } else { $g.unOdds }); label = "$sideTxt $T"
      agree = $agree; score = $agree * 10 + [Math]::Abs($diff) / $SdTotal[$g.lg] * 10; why = $why }
  }
}
Write-Host "Engine: $($cands.Count) spots where the signals agree"

# ---------------- choose: one per game, daily and league caps, strongest first ----------------
$doc = Read-Log $Path; $entries = @($doc.entries)
if (@(Test-Chain $entries).Count) { throw "Log failed its integrity check; not adding picks." }
$taken = @{}; foreach ($e in $entries) { $taken[[string]$e.eventId] = $true }
$perDay = @{}; $perLg = @{}
foreach ($e in @($entries | Where-Object { $_.source -eq "experimental" })) {
  $dk = Get-EtDay ([DateTime]::Parse($e.date, $Inv).ToUniversalTime()); $perDay[$dk] = 1 + [int]$perDay[$dk]; $perLg["$dk|$($e.lg)"] = 1 + [int]$perLg["$dk|$($e.lg)"]
}
$chosen = @()
foreach ($c in @($cands | Sort-Object score -Descending)) {
  if ($taken.ContainsKey($c.g.id)) { continue }
  $dk = Get-EtDay $c.g.start
  if ([int]$perDay[$dk] -ge $DailyCap -or [int]$perLg["$dk|$($c.g.lg)"] -ge $LeagueCap) { continue }
  $chosen += $c; $taken[$c.g.id] = $true; $perDay[$dk] = 1 + [int]$perDay[$dk]; $perLg["$dk|$($c.g.lg)"] = 1 + [int]$perLg["$dk|$($c.g.lg)"]
}

foreach ($c in @($cands | Sort-Object score -Descending | Select-Object -First 15)) {
  $mark = if ($chosen -contains $c) { "POST" } else { "    " }
  Write-Host ("  {0} {1,-4} {2,-14} {3,-16} {4}/3  score {5,5:N1}  {6}" -f $mark, $c.g.lg, "$($c.g.aAb)@$($c.g.hAb)", $c.label, $c.agree, $c.score, $c.g.start.ToString("MM-dd HH:mm'Z'"))
}
if ($DryRun) { Write-Host "Dry run: $($chosen.Count) picks would be logged."; return }

foreach ($c in $chosen) {
  $args2 = @{ League = $c.g.lg; Game = "$($c.g.aAb) @ $($c.g.hAb)"; EventId = $c.g.id; Start = $c.g.start.ToString("yyyy-MM-ddTHH:mmZ"); Kind = $c.kind
    Line = $c.line; Label = $c.label; Source = "experimental"; Tier = ""; Why = $c.why; Path = $Path }
  if ($c.odds) { $args2.Odds = $c.odds }
  if ($c.kind -eq "spread") { $args2.Team = $c.team } else { $args2.Side = $c.side }
  & (Join-Path $here "add-pick.ps1") @args2
}
Write-Host "Engine: logged $($chosen.Count) picks."
