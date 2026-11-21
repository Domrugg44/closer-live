# CEO tool: list open settlement reviews, or settle one (win / loss / push / void) with a reason.
# Uses YOUR Cloudflare login (npx wrangler), which the model pipeline and QC don't have.
# The database refuses a manual settlement unless it cites a review of that same prediction,
# and a win/loss must match the stored final score.
#   powershell -File tools/resolve-review.ps1                       # list open reviews
#   powershell -File tools/resolve-review.ps1 -ReviewId 3 -Result void -Reason "official result never published"
param([int]$ReviewId = 0, [ValidateSet("", "win", "loss", "push", "void")][string]$Result = "", [string]$Reason = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\backend")
$env:Path = "C:\Program Files\nodejs;" + $env:Path
function Q($sql) { (npx wrangler d1 execute closer-data --remote --json --command $sql 2>$null | ConvertFrom-Json)[0].results }
if (-not $ReviewId) {
  $rows = Q "SELECT r.id AS review_id, r.prediction_id, r.issue, r.opened_at, p.side, p.probability, g.start_time FROM settlement_reviews r JOIN predictions p ON p.id = r.prediction_id JOIN games g ON g.id = p.game_id LEFT JOIN prediction_settlements s ON s.prediction_id = r.prediction_id WHERE s.prediction_id IS NULL ORDER BY r.id"
  if (-not $rows) { "No open reviews." } else { $rows | Format-Table -AutoSize }
  return
}
if (-not $Result -or -not $Reason) { throw "Give -Result and -Reason to settle a review." }
$r = Q "SELECT prediction_id FROM settlement_reviews WHERE id = $ReviewId"
if (-not $r) { throw "Review $ReviewId not found." }
$pid_ = $r[0].prediction_id; $safe = $Reason.Replace("'", "''"); $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$out = npx wrangler d1 execute closer-data --remote --command "INSERT INTO prediction_settlements (prediction_id, result, reason, home_score, away_score, settled_by, review_id, settled_at) SELECT $pid_, '$Result', '$safe', r.home_score, r.away_score, 'ceo', $ReviewId, '$now' FROM (SELECT 1) LEFT JOIN predictions p ON p.id = $pid_ LEFT JOIN game_results r ON r.game_id = p.game_id" 2>&1 | Out-String
if ($out -match "ERROR") { "Refused: " + (($out -split "`n" | Select-String "must|permanent|cite|match") -join " ") } else { "Prediction $pid_ settled as $Result (review $ReviewId)." }
