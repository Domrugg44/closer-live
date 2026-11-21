# Builds the Closer app's game feed: one compact JSON document per league.
# Usage: powershell -File closer-feed.ps1 -Out <folder>
param([string]$Out = ".\feed")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null

$leagues = @(
  @{ k = "NFL"; p = "football/nfl";                    q = "";                       sum = $true },
  @{ k = "CFB"; p = "football/college-football";       q = "?groups=80&limit=200";   sum = "live" },
  @{ k = "NBA"; p = "basketball/nba";                  q = "";                       sum = $true },
  @{ k = "CBB"; p = "basketball/mens-college-basketball"; q = "?groups=50&limit=300"; sum = "live" },
  @{ k = "NHL"; p = "hockey/nhl";                      q = "";                       sum = $true }
)
$base = "https://site.api.espn.com/apis/site/v2/sports"

function Get-J($url) { try { Invoke-RestMethod $url -TimeoutSec 20 } catch { $null } }
function Pick-Side($o, $side) {
  if (-not $o) { return $null }
  [ordered]@{ open = $o.$side.open.line; openOdds = $o.$side.open.odds; now = $o.$side.close.line; nowOdds = $o.$side.close.odds }
}

foreach ($L in $leagues) {
  $sb = Get-J "$base/$($L.p)/scoreboard$($L.q)"
  if (-not $sb) { Write-Host "$($L.k): fetch failed"; continue }
  $games = @()
  foreach ($e in $sb.events) {
    $c = $e.competitions[0]
    $st = $e.status
    $teams = @{}
    foreach ($t in $c.competitors) {
      $stats = [ordered]@{}
      foreach ($s in @($t.statistics)) { if ($s -and $s.abbreviation) { $stats[$s.abbreviation] = $s.displayValue } }
      $leaders = @()
      foreach ($ld in @($t.leaders)) {
        $x = @($ld.leaders)[0]
        if ($x) { $leaders += [ordered]@{ cat = $ld.shortDisplayName; who = $x.athlete.shortName; val = $x.displayValue } }
      }
      $teams[$t.homeAway] = [ordered]@{
        id = $t.team.id; abbr = $t.team.abbreviation; name = $t.team.shortDisplayName; full = $t.team.displayName
        color = $t.team.color; alt = $t.team.alternateColor
        score = $t.score; rec = (@($t.records)[0]).summary
        rank = $(if ($t.curatedRank -and $t.curatedRank.current -lt 99) { $t.curatedRank.current } else { $null })
        stats = $stats; leaders = $leaders
      }
    }
    $o = @($c.odds)[0]
    $lines = $null
    if ($o) {
      $lines = [ordered]@{
        book = $o.provider.name; details = $o.details; total = $o.overUnder
        spreadHome = Pick-Side $o.pointSpread "home"; spreadAway = Pick-Side $o.pointSpread "away"
        over = Pick-Side $o.total "over"; under = Pick-Side $o.total "under"
        mlHome = Pick-Side $o.moneyline "home"; mlAway = Pick-Side $o.moneyline "away"
      }
    }
    $sit = $null
    if ($c.situation -and $st.type.state -eq "in") {
      $sit = [ordered]@{ down = $c.situation.downDistanceText; poss = $c.situation.possession; red = $c.situation.isRedZone; last = $c.situation.lastPlay.text }
    }
    $g = [ordered]@{
      id = $e.id; lg = $L.k; date = $e.date; name = $e.shortName
      state = $st.type.state; detail = $st.type.shortDetail; clock = $st.displayClock; period = $st.period
      tv = (@($c.broadcasts) | ForEach-Object { $_.names } | Select-Object -First 2) -join " / "
      venue = $c.venue.fullName; neutral = [bool]$c.neutralSite
      away = $teams["away"]; home = $teams["home"]; lines = $lines; sit = $sit
      box = $null; inj = $null
    }
    $wantSum = ($L.sum -eq $true) -or ($L.sum -eq "live" -and $g.state -ne "pre")
    if ($wantSum) {
      $s = Get-J "$base/$($L.p)/summary?event=$($e.id)"
      if ($s) {
        $box = @()
        foreach ($bt in @($s.boxscore.teams)) {
          $rows = @(@($bt.statistics) | Where-Object { $_.label } | Select-Object -First 14 | ForEach-Object { [ordered]@{ l = $_.label; v = $_.displayValue } })
          if ($rows.Count) { $box += [ordered]@{ abbr = $bt.team.abbreviation; rows = $rows } }
        }
        if ($box.Count) { $g.box = $box }
        $inj = @()
        foreach ($ti in @($s.injuries)) {
          foreach ($i in @($ti.injuries) | Where-Object { $_.status -match "Out|Doubtful|Questionable|Day-To-Day" } | Select-Object -First 5) {
            $inj += [ordered]@{ abbr = $ti.team.abbreviation; who = $i.athlete.displayName; pos = $i.athlete.position.abbreviation; st = $i.status }
          }
        }
        if ($inj.Count) { $g.inj = $inj }
      }
    }
    $games += $g
  }
  $doc = [ordered]@{ league = $L.k; updatedAt = (Get-Date).ToUniversalTime().ToString("o"); games = $games }
  $json = $doc | ConvertTo-Json -Depth 12 -Compress
  [IO.File]::WriteAllText((Join-Path $Out "$($L.k).json"), $json, (New-Object Text.UTF8Encoding $false))
  Write-Host ("{0}: {1} games, {2:N0} bytes" -f $L.k, $games.Count, $json.Length)
}
