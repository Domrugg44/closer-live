# Shared helpers for the prediction log (data/record.json).
# Each entry's "locked" fields are hashed together with the previous entry's hash (a hash chain),
# so changing or reordering any past prediction breaks every hash after it.
# The website recomputes the same chain in the browser (see verifyChain in index.html).

$script:LockedFields = @("id", "logged", "pickTime", "source", "lg", "game", "eventId", "date", "kind", "label", "team", "side", "player", "stat", "line", "odds", "prob", "tier", "why", "loggedAfterStart")
$script:ResultFields = @("status", "final", "actual", "diff", "units", "close", "clv", "note", "gradedAt")
$script:Sep = [string][char]0x1f
$script:Inv = [Globalization.CultureInfo]::InvariantCulture

function ConvertTo-CanonValue($v) {
  if ($null -eq $v) { return "" }
  if ($v -is [bool]) { if ($v) { return "true" } else { return "false" } }
  if ($v -is [double] -or $v -is [single] -or $v -is [decimal]) { return ([double]$v).ToString("R", $script:Inv) }
  if ($v -is [int] -or $v -is [long]) { return ([long]$v).ToString($script:Inv) }
  return [string]$v
}

function Get-EntryCanon($e) {
  ($script:LockedFields | ForEach-Object { ConvertTo-CanonValue $e.$_ }) -join $script:Sep
}

function Get-Sha256Hex([string]$s) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString("x2") }) } finally { $sha.Dispose() }
}

function Get-EntryHash($e, [string]$prevHash) {
  Get-Sha256Hex ($prevHash + $script:Sep + (Get-EntryCanon $e))
}

# Outputs one line per problem; no output means the chain is intact. Call as @(Test-Chain $entries).
function Test-Chain($entries) {
  $prev = ""
  foreach ($e in $entries) {
    $h = Get-EntryHash $e $prev
    if ($e.hash -ne $h) { "Entry $($e.id): hash does not match its contents or position" }
    $prev = $e.hash
  }
}

function Read-Log([string]$path) { Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json }

function Write-Log($doc, [string]$path) {
  $json = $doc | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($path, $json + "`n", (New-Object Text.UTF8Encoding $false))
}
