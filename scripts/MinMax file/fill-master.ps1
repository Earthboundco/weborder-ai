# Excel COM half of build-minmax.js: copies Wesley's "Master file for Claude.xls", loads the items into
# its Draft table, trims it and resets the names his Access upload form reads. Called by
# build-minmax.js with a JSON file of [{ item, dcMin, dcMax, storeMin, storeMax }, ...].
#
# Master layout (2026-11-10): header row 1, columns A:K (A:C hidden), D CODE, E ID, G ITEM_NO, J MIN,
# K MAX; rows 2-8001 = 8000 data rows, rows 2-161 already hold the 160 CODE/ID pairs as text;
# row 8002 = "end"; M1:N1 = a note. CODE/ID are copied from the master's own cells because writing
# "000" through COM would turn it into the number 0.
param(
  [Parameter(Mandatory)] [string] $Master,
  [Parameter(Mandatory)] [string] $Instructions,
  [Parameter(Mandatory)] [string] $Out,
  [Parameter(Mandatory)] [string] $StoresCsv
)
$ErrorActionPreference = 'Stop'

$MASTER_ROWS = 8000
$STORE_ROWS = 160
# Windows PowerShell 5.1 emits a JSON array as one object; the ForEach unrolls it
$items = @(Get-Content $Instructions -Raw | ConvertFrom-Json | ForEach-Object { $_ })
$stores = @(Import-Csv $StoresCsv)
$n = $items.Count * $STORE_ROWS
$lastRow = $n + 1

if (Test-Path $Out) { throw "$Out already exists - not overwriting" }
Copy-Item $Master $Out

function New-Column($values) {
  $a = New-Object 'object[,]' $values.Count, 1
  for ($i = 0; $i -lt $values.Count; $i++) { $a[$i, 0] = $values[$i] }
  return , $a
}

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
$wb = $null
try {
  $wb = $xl.Workbooks.Open($Out)
  $ws = $wb.Worksheets.Item('Draft')
  if ($ws.Range('D8002').Formula -ne 'end') { throw "master layout changed: D8002 is '$($ws.Range('D8002').Formula)', not 'end'" }

  # the master's 160 CODE/ID pairs must match stores.csv
  $dv = $ws.Range('D2:E161').Value2
  for ($i = 0; $i -lt $STORE_ROWS; $i++) {
    if ("$($dv[($i + 1), 1])" -ne $stores[$i].CODE -or "$($dv[($i + 1), 2])" -ne $stores[$i].ID) {
      throw "master row $($i + 2) is $($dv[($i + 1), 1])/$($dv[($i + 1), 2]), stores.csv has $($stores[$i].CODE)/$($stores[$i].ID)"
    }
  }

  # size the table: insert rows above "end" when over 8000, delete the unused ones otherwise
  if ($n -gt $MASTER_ROWS) {
    $ws.Rows("$($MASTER_ROWS + 2):$($n + 1)").Insert() | Out-Null
  } elseif ($n -lt $MASTER_ROWS) {
    $ws.Rows("$($lastRow + 1):$($MASTER_ROWS + 1)").Delete() | Out-Null
  }
  if ($ws.Range("D$($lastRow + 1)").Formula -ne 'end') { throw "row $($lastRow + 1) is not the end row" }

  # CODE/ID block for every item after the first
  $block = $ws.Range('D2:E161')
  for ($k = 1; $k -lt $items.Count; $k++) { $block.Copy($ws.Range("D$(2 + $k * $STORE_ROWS)")) | Out-Null }

  $itemNo = @(); $min = @(); $max = @()
  foreach ($it in $items) {
    for ($i = 0; $i -lt $STORE_ROWS; $i++) {
      $itemNo += [double]$it.item
      if ($i -eq 0) { $min += [double]$it.dcMin; $max += [double]$it.dcMax }
      else { $min += [double]$it.storeMin; $max += [double]$it.storeMax }
    }
  }
  $ws.Range("G2:G$lastRow").Value2 = New-Column $itemNo
  $ws.Range("J2:J$lastRow").Value2 = New-Column $min
  $ws.Range("K2:K$lastRow").Value2 = New-Column $max
  foreach ($col in 'A', 'B', 'C', 'F', 'H', 'I') { $ws.Range("${col}2:$col$lastRow").ClearContents() | Out-Null }

  # drop the "end" row and the M:N note, then point the names at the loaded table
  $ws.Rows($lastRow + 1).Delete() | Out-Null
  $ws.Columns('M:N').Delete() | Out-Null
  $wb.Names.Item('draftdata').RefersTo = "=Draft!`$A`$1:`$K`$$lastRow"
  $ws.Names.Item('Replinishment').RefersTo = "=Draft!`$A`$1:`$K`$$lastRow"

  $xl.ScreenUpdating = $true
  $wb.Save()
  $wb.Close($false); $wb = $null

  # reopen read-only and check what was saved
  $wb = $xl.Workbooks.Open($Out, 0, $true)
  $ws = $wb.Worksheets.Item('Draft')
  $v = $ws.Range("A2:K$lastRow").Value2
  $err = 0
  for ($r = 1; $r -le $n; $r++) {
    $it = $items[[math]::Floor(($r - 1) / $STORE_ROWS)]; $s = $stores[($r - 1) % $STORE_ROWS]; $dc = ($s.CODE -eq '000')
    if ($v[$r, 4] -isnot [string] -or "$($v[$r, 4])" -ne $s.CODE -or "$($v[$r, 5])" -ne $s.ID -or $v[$r, 7] -ne $it.item -or
        $v[$r, 10] -ne $(if ($dc) { $it.dcMin } else { $it.storeMin }) -or $v[$r, 11] -ne $(if ($dc) { $it.dcMax } else { $it.storeMax })) { $err++ }
  }
  if ($err) { throw "verification failed: $err row(s) differ" }
  if ($xl.WorksheetFunction.CountA($ws.Rows($lastRow + 1)) -ne 0) { throw 'rows found after the table' }
  if ($xl.WorksheetFunction.CountA($ws.Range('L:N')) -ne 0) { throw 'cells found past column K' }
  foreach ($nm in $wb.Names) { if ($nm.Visible) { "Name $($nm.Name) -> $($nm.RefersTo)" } }
  "Verified $n rows ($($items.Count) item(s) x $STORE_ROWS), last row $lastRow"
  $wb.Close($false); $wb = $null
} catch {
  if ($wb) { $wb.Close($false) }
  if (Test-Path $Out) { Remove-Item $Out }
  throw
} finally {
  $xl.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
