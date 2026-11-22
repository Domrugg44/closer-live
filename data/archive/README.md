# Archived picks

`starter-picks-2026-11-20.json` holds the 55 picks written as starter content during the original app build on 2026-11-20 and bulk-imported into the log on 2026-11-21. Nobody checked them against real data, and their notes have no recorded source.

On 2026-11-21, before the site was public, the CEO removed them from the record and started a fresh one at 0–0. They're kept here unchanged, with their hash chain intact, so the removal is part of the record:

    powershell -File tools/verify-log.ps1 -Path data/archive/starter-picks-2026-11-20.json

`data/record.json` documents the reset in its `reset` block (archive path, number of entries, last hash), and `tools/verify-log.ps1` accepts the removal only when that block matches this archive exactly.
