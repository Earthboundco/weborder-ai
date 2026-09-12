# Progress log

Append new entries at the bottom, dated. Don't rewrite earlier entries - if something changed,
say so in a new entry.

## 2026-08-27

- Explored the assets Wesley/Netto dropped in (`DCS_Pattern.xlsx`, `Pattern_Store_Group.xlsx`,
  `Weborder summary.xlsx`) to understand the manual process. Documented in `overview.md`.
- Got SQL Server access (`192.168.1.231`, database `EBTAI`). Found we also have read access to
  `EBT` (the real operational DB) and `EBTGOOGLE`. Set up `.env` + `db.js` for connection reuse.
- Discovered `EBTAI` already had real reference data loaded (not just the mock files):
  `DCS_Pattern`, `Pattern_Store_Group`, `Item_Code_allocation_table`, `DPS_Code_allocation_table`,
  plus two pre-built views `ItemInformation`/`ItemInformationComplete` that already compute the
  DPS Code (DCS + price bucket + size bucket) matching the spreadsheet's format exactly.
- Got the 12 exclusion rules (previously in an Access database) and built them out in SQL:
  `ExclusionRules` (metadata/toggle table), `vw_ExclusionEvaluation` (per-rule Y/N),
  `vw_ItemStoreAllowSend` (rolled-up AllowSend flag). Fixed the "store closed" rule per Netto's
  guidance (empty `WStoreType` = closed) after initially guessing wrong (used `TempClosed`/
  `E-ACTIVE` as a proxy).
- Built the weekly import step: `scripts/import-item-replenishment.js`, reads Wesley's SAP-
  filtered "Items" sheet (Item #, DC Supply) into `ItemReplenishment`. Ran it once against
  `Inventory in Warehouse.xlsx` - imported 788 items.
- Built the allocation draft: `vw_AllocationBase` (DCS Pattern -> Store Group -> base qty) and
  `vw_AllocationDraft` (nets on-hand, applies exclusions, rounds up to full cases per Netto's
  case-qty rule). Validated against the real 788-item set - numbers look plausible, case
  rounding confirmed correct on spot checks.
- Hit and fixed several data gotchas along the way (now documented in `data-sources.md`):
  `Store Directory.[ID #]` vs `[Code #]` are different numbering systems; joining
  `Inventory_V_AUX` directly is ~200x slower than the equivalent join against `INVENTORY`;
  store code `000` is the DC itself and needed excluding; store 470 (Ecommerce) has duplicate
  rows in the on-hand table that needed summing to avoid fan-out.
- Confirmed DC-qty capping/proration is NOT implemented yet - flagged as the biggest open gap
  (about half of items exceed DC supply once you sum desired qty across all stores).
- Created this `docs/` folder per Netto's request, so context survives across sessions.

## 2026-08-27 (cont.)

- Got the DC-qty cap rule from Netto: waterfall by store-group priority (A1, A2, A3, B, C, D,
  E) - fill in that order, stop entirely the moment a store can't be fully covered.
- First implementation (`vw_AllocationCapped`, a view with a correlated CROSS APPLY for the
  running total) worked correctly per-item but timed out as a full 788-item batch - SQL Server
  2008 R2 doesn't push per-item filters down through stacked views well. Replaced it with:
  `AllocationDraft` + `AllocationResults` tables and `usp_RunAllocation`, which materializes
  the draft first, then computes the waterfall against that flat table. Runs in ~1 minute for
  the full batch. Dropped `vw_AllocationCapped` in favor of this.
- Ran `usp_RunAllocation` against the real 788-item set: 390 items needed capping, 0 items
  exceed `DC_Qty` after capping, ~78% average DC-supply utilization among capped items (the
  remainder is smaller than one more store's case-rounded need, so it's left on the shelf -
  expected, given cases can't be broken).
- Two smaller opens surfaced while building this (see `open-questions.md`): tie-break order
  within a store group, and 5 stores missing from `Pattern_Store_Group` for some patterns.
- The core allocation pipeline (exclusions -> base qty -> on-hand net -> case rounding -> DC-qty
  waterfall) is now end-to-end complete, except in-transit is still a placeholder (0) pending
  the real ASN source from Netto.

## 2026-08-27 (cont. 2)

- Netto: store 470 (Ecommerce) is filled by a separate person who sends her own counts, and
  those counts take priority over every other store - rank 0, ahead of even A1. Updated
  `usp_RunAllocation`'s GroupRank logic accordingly and re-ran; confirmed store 470 = GroupRank
  0, every other store starts at 1+.
- Found while verifying: store 470 has **zero rows in `Pattern_Store_Group` for any pattern**,
  so its `BaseAllocationQty` is always 0 under the current calculation regardless of priority -
  the rank-0 change is correctly implemented but functionally inert until we know how "her
  counts" actually enters the pipeline (separate import overriding the calc for 470? or does
  `Pattern_Store_Group` just need 470 added?). Flagged as a new open question - did not guess.
- **Session paused here by Netto.** Next session should start by reading `open-questions.md` -
  in particular the store-470 question above is a hard blocker on that rule doing anything
  useful, so lead with that one. Other standing opens at this point: in-transit source (still
  a placeholder), on-hand source confirmation, the group tie-break assumption, and the 5
  stores missing from `Pattern_Store_Group`.

## 2026-09-01

- Netto answered the store-470 open question: it's option (a) - a wholly separate weekly input,
  not derived from `Pattern_Store_Group`. Dropped an example file, `assets/Completed Normal
  Buyer Review- 08-31-26 Dawn.xlsx` (`Review` sheet), showing the real process: Dawn (a
  different person) proposes item/qty asks, Wesley reviews and finalizes, lowering the qty
  only when DC supply is short. Confirmed the two columns that matter: `Item` (C) and
  `Ecommerce final allocation` (P). Full detail and a caveat (3 sample rows where P > DC
  Supply, unexplained) logged in `open-questions.md`.
- Not yet built: the import script/table for this input, or the `usp_RunAllocation` change to
  source 470 from it at rank 0. Next session/step: confirm approach with Netto, then build.
- Netto confirmed: exclusion rules still apply to 470 (safety net, even though Wesley's own
  list curation already filters most dead/blocked items before Dawn sees it); build now rather
  than waiting on the P > DC Supply anomaly.
- Built it: `sql/009_add_ecommerce_allocation_override.sql` (new table
  `EcommerceAllocationRequest`, redefines `vw_AllocationBase`/`vw_AllocationDraft` so store 470
  sources its base qty from this table instead of `Pattern_Store_Group`, skipping on-hand
  netting/case rounding but still subject to `AllowSend`), `scripts/import-ecommerce-
  allocation.js`. Applied to the live `EBTAI` schema, imported the real sample file (57 items),
  re-ran `usp_RunAllocation`. Results: 44/57 items got a nonzero final allocation for 470 (424
  units total), 0 blocked by exclusions. Of the 13 zeroed: 11 weren't in this week's
  `ItemReplenishment` (expected - different snapshot dates between the two source files); 2
  (97352, 97360) were the exact P > DC Supply anomaly flagged earlier, confirmed here as
  correct waterfall-cap behavior, not a bug (this week's real `DC_Qty` for both is 4, requested
  was 6). Store-470 open question is now fully closed - see `business-rules.md` and
  `open-questions.md` for the full writeup.
- Standing opens, unchanged: in-transit source (placeholder), on-hand source confirmation, the
  group tie-break assumption, and 4 of the 5 stores (435, 512, 535, 542) still missing from
  `Pattern_Store_Group` for some patterns.

## 2026-09-03

Session with Wesley to work through the standing open questions from `open-questions.md`.
Resolutions:

- **On-hand source**: `EBT.dbo.INV_SBS_QTY_V_EXT.QTY` is confirmed **not workable** right now.
  On-hand qty will be a manual weekly input from Wesley instead. File format/cadence TBD -
  waiting on a sample file from him (same pattern as `ItemReplenishment`).
- **In-transit source**: also becomes a manual weekly input from Wesley for now (previously
  hardcoded 0). He'll grant direct access to a real SAP-backed table later, at which point we
  swap the manual input for the real source. File format/cadence also TBD.
- **Store-group tie-break**: Wesley will provide an explicit store rank/priority list to replace
  the StoreCode-ascending placeholder. Approach confirmed, list not yet delivered.
- **Stores 435, 512, 535, 542**: confirmed closed/closing - should get no allocation. Wesley
  confirmed `Store Directory.WStoreType` is currently blank for all 4, so the existing Exc1
  ("store closed") exclusion rule already handles this correctly with no code or data change
  needed. Their missing `Pattern_Store_Group` rows no longer matter (they're excluded upstream
  of that lookup). This closes out both parts of the old "5 stores missing from
  Pattern_Store_Group" open item for these 4 (470/Ecommerce was already resolved separately).

**Not yet built**: the manual-input tables/import scripts for on-hand and in-transit (need
sample files from Wesley first - same approach used for the store-470 Ecommerce input), and the
`vw_AllocationDraft` change to source `OnHandQty`/`InTransitQty` from them. Also still waiting on
Wesley's store-rank file for the tie-break. See `open-questions.md` for the live list of what's
still pending from him.

Next session should follow up with Wesley on: (1) sample file / format for manual on-hand input,
(2) sample file / format for manual in-transit input, (3) the store rank list for tie-breaks.

## 2026-09-05

Started interactive simulation/testing of the pipeline with Wesley, one item code at a time,
rather than editing the real 788-item `ItemReplenishment` input down to one row (unnecessary -
just query the existing loaded set/`AllocationResults` filtered to one item).

- **Traced item 96443** ("Chime - Wood Top Mini Asst", Pattern 07, DC_Qty=60) end-to-end: DCS
  Pattern -> store groups -> base qty -> 31/144 stores excluded (30 by Exc4 Markdown, 1 by Exc3
  Online-store for store 470) -> on-hand netting/case rounding -> DC-qty waterfall cap. Final
  result at the time: 60/60 units shipped to 5 stores (400, 306, 469, 301, 418), matching the
  "no partial fill" rule exactly (running total hit exactly 60 after store 418).
- **Found and fixed a real bug** surfaced by this trace: store 516 had on-hand qty of -1 (later
  observed as -2 minutes later from the same live view - see below), and `vw_AllocationDraft`
  was netting `BaseAllocationQty - OnHandQty - InTransitQty` without flooring on-hand at 0 first,
  so a negative on-hand value made `NetNeed` *larger* than intended instead of being treated as
  "no usable stock." Fixed per Wesley's rule (floor `OnHandQty + InTransitQty` at 0 before
  netting) in `sql/010_floor_onhand_plus_intransit.sql`. Confirmed via `AllocationDraft` that
  316 of the 788-item set's item/store rows had negative on-hand at the time - a real, broad
  data-quality issue, not a one-off.
- **Closed both remaining "Known placeholder" open questions** (on-hand source, in-transit
  source): Wesley provided `assets/Stores_Qtys_and_MinMax.xlsx`, a weekly export
  (`Store_Code`/`Item_number`/`On-Hand_qty`/`In-Transit_qty`/`Min_qty`/`Max_qty`, ~114k rows,
  788 items x 145 store codes including `HDQ`/closed stores, keyed on the business Store Code
  per Wesley's confirmation). Built `StoreItemInventory` table + `scripts/import-store-
  inventory.js` (bulk insert - row-by-row like the other two import scripts would be far too
  slow at this scale) + `sql/011_add_store_item_inventory_table.sql` (redefines
  `vw_AllocationDraft` again to source `OnHandQty`/`InTransitQty` from this table instead of
  `INV_SBS_QTY_V_EXT`/hardcoded 0, keeping the floor-at-0 fix). Imported and re-ran
  `usp_RunAllocation` against the real file - `AllocationResults` now reflects the new source
  (confirmed item 96443's on-hand values changed accordingly, e.g. store 469 now nets to 0
  need instead of shipping 12, since its real on-hand of 18 already covers the base qty of 16).
- Noted while testing: `INV_SBS_QTY_V_EXT` (now retired) returned different on-hand values for
  the same store/item just minutes apart with no import in between - live volatility, further
  confirming Wesley's call that it wasn't a workable source.
- **Standing opens now down to just:** the store-group tie-break rank list (still waiting on
  Wesley's list; StoreCode-ascending remains the placeholder), and "the app itself" (no UI
  decided yet).

## 2026-09-05 (cont.)

- **`Item_Code_allocation_table` and `DPS_Code_allocation_table` become weekly inputs**, per
  Wesley - previously a one-time load from his original mock file at project start, now
  refreshed weekly like `ItemReplenishment`/`StoreItemInventory`/`EcommerceAllocationRequest`.
  Wesley will send two separate files each week (`assets/Item_Code_allocation_table.xlsx`,
  `assets/DPS_Code_allocation_table.xlsx`), "wide" layout (one row per Item Code or DPS Code,
  one column per store group A1/A2/A3/B/C/D/E) - same shape as the sheets in the original
  `Weborder summary.xlsx` mockup, just header row 1 instead of row 3 and no title row.
- Built `scripts/import-allocation-table.js <item|dps> <file>` - one shared script that
  unpivots either file into the long `(key, StoreGroup, AllocationQty)` shape both DB tables
  actually use, then truncates/reloads. Confirmed both files clean (no duplicate keys, no
  blank cells) before running.
- Ran it against the real files: `Item_Code_allocation_table` -> 574 items x 7 groups = 4,018
  rows (same item count as before - no real change); `DPS_Code_allocation_table` -> 2,924 DPS
  codes x 7 groups = 20,468 rows (up from 2,089 DPS codes/14,623 rows before - more coverage,
  not less). Re-ran `usp_RunAllocation` afterward so `AllocationResults` reflects the new data.
  No schema/view changes needed - `vw_AllocationBase` already read from these two tables by
  name, only their contents changed.

## 2026-09-05 (cont. 3)

- **Added a 13th exclusion rule, "Blocking RP 999"**, per Wesley: Retail Pro (internal POS)
  blocks an item from a store by setting that store's Min AND Max level to 999 for that item -
  those values are exactly `StoreItemInventory.MinQty`/`MaxQty` (imported from
  `Stores_Qtys_and_MinMax.xlsx`, previously unused). Added as `Exc13` following the existing
  12-rule pattern exactly: metadata row in `ExclusionRules`, a column in
  `vw_ExclusionEvaluation` (new `LEFT JOIN StoreItemInventory`), rolled into
  `vw_ItemStoreAllowSend`'s `AllowSend` check. See `sql/012_add_blocking_rp999_exclusion_rule.sql`.
- Checked impact before and after applying: 11,999 of 113,472 item/store rows in the current
  788-item set have Min=Max=999; 3,268 of those had previously passed all 12 other rules (i.e.
  would otherwise have shipped) - confirmed all 11,999 are now correctly blocked after the
  change. Re-ran `usp_RunAllocation` so `AllocationResults` reflects it.

## 2026-09-05 (cont. 4)

- **Resolved the last standing open question: the DC-qty waterfall tie-break order.** Wesley
  provided `assets/Pattern_Store_Group.xlsx` with a new `Rank` column - not just a tie-break
  within Store Group as originally scoped, but an explicit full priority order (1-139, unique
  per pattern) that **replaces Store Group entirely** for waterfall ordering (Store Group is
  unchanged for the base allocation qty lookup). Confirmed the file itself is clean: all 11
  patterns have exactly 139 stores, ranks 1-139 with zero duplicates/gaps per pattern - matches
  144 active stores minus 470 (separate input) minus the 4 closed stores.
- Built `scripts/import-pattern-store-group.js` (truncate/reload, refreshes every 6-8 weeks per
  Wesley - not weekly like the other five inputs, but same pattern) and
  `sql/013_add_rank_to_pattern_store_group.sql`: adds the `Rank` column + a unique index on
  (`DCS pattern`, `Store code`) since it's now joined per-row in the waterfall calc, and
  rewrites `usp_RunAllocation`'s `GroupRank` logic to pull `Pattern_Store_Group.Rank` directly
  instead of the old Store-Group CASE expression (store 470 keeps its hardcoded always-first
  position). Loaded the real file (1,529 rows) and re-ran `usp_RunAllocation`.
- Verified on item 96443: same total shipped (60 units, since `DC_Qty`/case size happened to
  work out the same either way) but a genuinely *different* set of 5 stores served than under
  the old Store-Group ordering (e.g. store 442, A3, now ships ahead of some A2 stores because
  its explicit rank is lower) - confirms the reordering actually took effect, not a no-op.
- **All standing opens from `open-questions.md` are now closed except "the app itself"** (no UI
  decided yet).

## 2026-09-05 (cont. 5)

- **Cleaned up two asset file names/formats**, per Wesley:
  - `assets/Inventory in Warehouse.xlsx` renamed to `assets/ItemReplenishment.xlsx` (matches
    the table it feeds, same convention as the other recently-added files) - same sheet/columns,
    no format or script change needed (`scripts/import-item-replenishment.js` takes the file
    path as an argument).
  - `assets/Completed Normal Buyer Review- 08-31-26 Dawn.xlsx` (the original 82-column,
    972-row buyer-review workbook) replaced with `assets/EcommerceAllocationRequest.xlsx` - a
    simplified 3-column format (`Store`, `Item`, `Qty`, header row 1), keeping only the 57 rows
    that actually had a nonzero final allocation (the rest were never imported anyway). Updated
    `scripts/import-ecommerce-allocation.js` to parse the new shape, plus a sanity check that
    every row's `Store` is `470` (this table has no store column of its own). Re-ran the import
    against the new file - same 57 rows loaded as before, confirming the new parser reproduces
    the original data exactly.
  - Old buyer-review workbook removed from the repo (still recoverable from git history if ever
    needed); the reasoning behind which two columns of the original mattered is preserved in
    `open-questions.md` for context.

## 2026-09-05 (cont. 6)

- **Further asset cleanup**, per Wesley:
  - `assets/ItemReplenishment.xlsx` renamed to `assets/Items_for_Replenishment.xlsx`, and
    stripped a leading title/formula row (`"Total weborder items: " & COUNTA(...)`) and a
    blank column A - header (`Item #`/`DC Supply`) now sits at row 1, columns A/B. No script
    change needed - `scripts/import-item-replenishment.js` finds the header by cell value, not
    fixed position. Verified: re-ran the import against the new file, same 788 items loaded.
  - `assets/EcommerceAllocationRequest.xlsx` renamed to `assets/Ecommerce_Allocation_Request.xlsx`
    (pure rename, no content change).

## 2026-09-05/06 (cont. 7)

- **Added a 14th exclusion rule, "Temporary Blocking"**, per Wesley: used while an item is being
  tested at selected locations only - the item stays in DC stock, but every store *not* part of
  the test gets a `Status='Block'` row in a new `Temporary_Blocking` table (Store, Item, Status
  - business Store Code + plain item code, per Wesley). Once a test concludes, the blocking rows
  for that item are removed and it opens up to all stores normally. Added as `Exc14` following
  the existing 13-rule pattern exactly (metadata row, `vw_ExclusionEvaluation` column, rolled
  into `vw_ItemStoreAllowSend`). See `sql/014_add_temporary_blocking_exclusion_rule.sql` and
  `scripts/import-temporary-blocking.js` (truncate/reload, refreshes weekly or every other week).
- Checked the real file (493 rows, all `Status='Block'`, 7 items across 119 stores, no
  duplicates): all 493 combos are now correctly blocked, but **0 of those had previously passed**
  all 13 other rules - every one was already blocked by Exc13 (RP999) or Exc12. So this rule
  currently has zero net effect on shipped results for the current item set, but is correctly
  wired in for when it does matter (e.g. an item mid-test where RP hasn't also set 999). Re-ran
  `usp_RunAllocation`.

## 2026-09-06 (cont.)

- **Added "Initial Shortage Adjustment"** and renamed the existing waterfall cap to **"Final
  Shortage Adjustment"**, per Wesley. When an item's shortage (demand - `DC_Qty`) is <=30 pcs,
  behavior is unchanged (straight to the Final Shortage Adjustment). When shortage exceeds 30,
  a new step now softens it first: walk groups E->D->C->B->A3->A2->A1 (470 never a target,
  though its qty still counts as demand), cutting each group's `BaseAllocationQty` by 5%
  (floored, compounding off the current value) and re-netting/case-rounding as normal after
  each cut - the case-quantity rule is never broken, only the pre-netting base number shrinks.
  Recomputes shortage after every single group step and stops the instant it's <=30 - doesn't
  necessarily walk the full sequence. Loops back to E if a full pass isn't enough, with a
  200-cycle safety cap.
- Implemented as a cursor-based loop in `usp_RunAllocation` (`sql/015_add_initial_shortage_
  adjustment.sql`) - this genuinely needs iteration (each step's outcome depends on the
  cumulative effect of prior steps), which can't be expressed as a single set-based query.
  Added ~30s to the full run (now ~1:30 total over 788 items).
- Hand-verified against item 96800 (DC_Qty=22, demand 53, shortage 31) before building, then
  confirmed the actual run matched exactly: group E was a genuine no-op (on-hand already
  covered its tiny base qty), group D's cut dropped demand to 42 (shortage 20), stopping after
  just 2 of the 7 possible steps. The Final Shortage Adjustment then correctly capped the
  result to exactly 22. Also confirmed: 0 of 788 items still had shortage >30 after the step ran
  (universal convergence, safety cap never triggered); an item that started <=30 (96144) had its
  BaseAllocationQty completely unchanged, confirming untouched items are genuinely left alone.
- Docs updated: business-rules.md (new dedicated section + renamed references throughout),
  progress-log.md.

## 2026-09-06 (cont. 2)

- **Full weekly data refresh**, per Wesley: new versions of `Items_for_Replenishment` (960
  records), `Item_Code_allocation_table` (806 records), `Stores_Qtys_and_MinMax` (139,200
  records), and `Ecommerce_Allocation_Request` (30 records). Validated each file (no
  duplicates, no bad values, row counts matching what Wesley stated) before importing; all four
  imports matched exactly. Re-ran `usp_RunAllocation` (38.2s): 960 items, 138,240 result rows,
  9,227 rows blocked by exclusions, 87,466 units shipped, 288 items needed shortage adjustment.
- Investigated the one item (`3786`) that still showed shortage > 30 after the Initial Shortage
  Adjustment ran, rather than assume it was a bug: its entire demand (54 units) was store 470's
  own Ecommerce request, `DC_Qty` this week only 18 - since 470 is deliberately excluded from
  the Initial Shortage Adjustment and no other group had any demand to trim, this item
  legitimately skips that step and falls straight to the Final Shortage Adjustment, which (under
  the *then-current* all-or-nothing rule) shipped 0. This investigation is what surfaced the
  "no partial fill" misunderstanding - see below.

## 2026-09-06 (cont. 3)

- **Corrected a misunderstanding in the Final Shortage Adjustment**, per Wesley: "no partial
  fill" does not mean a store gets its full need or nothing - a store can receive a partial
  fill, as long as the amount shipped is a whole multiple of the case qty. Redefined the
  waterfall to walk stores in the same priority order as before, but now ship
  `FLOOR(MIN(need, remaining supply) / QTY_PER_CASE) * QTY_PER_CASE` per store and keep walking
  to the next store with whatever supply remains, rather than zeroing every store once one
  can't be fully covered. Confirmed with Wesley this applies to every store (not just 470) and
  that the waterfall should keep walking after a partial fill.
  - Added `LeftoverQty` and `DCQtyNotCaseMultiple` columns to `AllocationResults` - the latter
    flags items where `DC_Qty` isn't a whole multiple of `QTY_PER_CASE`, meaning some DC
    inventory can structurally never be shipped to anyone.
  - Implemented in `sql/016_add_case_aligned_partial_fill.sql`: a single forward-only cursor
    over a working table of all eligible item/store rows (ordered by ItemCode, GroupRank,
    StoreCode), resetting a running "remaining supply" counter whenever ItemCode changes - one
    pass over ~138k rows, not a cursor per item. Added negligible time to the run (~40s total,
    same order as before).
  - **Validated against real data**: item `3786` (store 470 requests 54, `DC_Qty`=18, case
    qty=18) now ships 18 instead of 0 - matches Wesley's worked example A exactly, using a real
    production item. Item `80680` confirmed the "keep walking" behavior (470 gets a partial 6 of
    its 12 need; every other store correctly gets 0 since nothing remains). Item `98219`
    (`DC_Qty`=214, case qty=6, structurally 4 pcs always left over) correctly flagged
    `DCQtyNotCaseMultiple='Y'` with `LeftoverQty`=4. Across the full 960-item run: 21 items
    flagged, 54 rows got a genuine partial fill, total units shipped rose from 87,466 to 87,597.
  - Docs updated: business-rules.md (corrected the original wrong description, added a
    dedicated section with worked examples), data-sources.md, progress-log.md.

## 2026-09-06 (cont. 4)

- **Defined the weekly deliverable format**, per Wesley - the first concrete answer to the
  long-standing "app itself" open question (how Wesley actually runs the process day to day is
  still CLI scripts, unchanged). Two CSV exports:
  - `Final_Allocation_Results.csv` (`scripts/export-final-allocation-results.js`):
    `StoreCode`/`ItemCode`/`Qty`, nonzero shipments only.
  - `DC_ItemsCheck_NotCaseMultiple.csv` (`scripts/export-dc-items-not-case-multiple.js`):
    `ItemCode`/`DCLeftOverQty`/`DCQtyNotCaseMultiple`, only items flagged `Y`. Verified against
    item 98219 (Wesley's own worked example): `DCLeftOverQty`=4, `DCQtyNotCaseMultiple`='Y' -
    matches exactly.
  - Ran both against the current 960-item data: 17,674 nonzero shipment rows, 21 items flagged
    for the case-multiple check. Both output files added to `.gitignore` (generated, not source
    data). Also kept the earlier broader diagnostic export
    (`scripts/export-allocation-results.js`) as a separate debugging tool, not one of the two
    official deliverables.
  - Docs updated: business-rules.md, data-sources.md (new "Weekly output" sections),
    open-questions.md (partially resolves "the app itself"), progress-log.md.

## 2026-09-06 (cont. 5)

- **Replaced `DC_ItemsCheck_NotCaseMultiple.csv` with `DCQty_Less_than_CaseQty.csv`**, per
  Wesley - a stricter, more useful definition. The old flag (`DCQtyNotCaseMultiple`) fired
  whenever `DC_Qty` itself wasn't a case multiple, even if the actual leftover after allocation
  ended up large (a genuine surplus, not a problem). The new flag
  (`DCQtyLessThanCaseQty` = `'Y'`) only fires when `0 < LeftoverQty < QTY_PER_CASE` - a real,
  small, stuck fragment. Confirmed with Wesley that `LeftoverQty = 0` (perfect utilization)
  should NOT be flagged, even though it technically satisfies "less than case qty" literally.
  - Deleted `scripts/export-dc-items-not-case-multiple.js`; added
    `scripts/export-dc-qty-less-than-case-qty.js`.
  - Ran against current data: **7 items** flagged (down from 21 under the old definition).
    Verified item 98219 (Wesley's own example) still correctly shows `DCLeftOverQty`=4,
    `DCQtyLessThanCaseQty`='Y'.
  - `.gitignore` updated (old output filename removed, new one added).
  - Docs updated: business-rules.md, data-sources.md, open-questions.md, progress-log.md.

## 2026-09-09

- **Documented the update cadence and ownership for every `assets/` source file**, per Wesley -
  four tiers, from rarest to most frequent:
  - **Eventually/never**: `DCS_Pattern` (only on a new DCS Code or Pattern).
  - **Every ~8 weeks**: `Pattern_Store_Group` (once per launch/season period - Spring Break,
    Summer 1, Back-to-School, Holidays, etc).
  - **Weekly, any day Mon-Fri**: `Item_Code_allocation_table`, `DPS_Code_allocation_table`,
    `Temporary_Blocking`.
  - **Weekly, in order, Friday 4pm+/Saturday/Sunday**: `Items_for_Replenishment` (built right
    after the DC's Friday 4pm SAP shipment-receiving cutoff) -> `Ecommerce_Allocation_Request`
    (Dawn's ask, returned Fri night/Sat/Sun) -> `Stores_Qtys_and_MinMax` (built last, only once
    the other files are ready - the final input before `usp_RunAllocation`).
  - New section in `data-sources.md` ("Update cadence & ownership") is now the authoritative
    reference for this; a couple of existing table rows there were cross-referenced to it.

## 2026-09-10

- **Full weekly data refresh**, per Wesley - all 8 `assets/` source files updated at once,
  including `DCS_Pattern` and `Pattern_Store_Group` (normally "eventually/never" and "every ~8
  weeks" tier - unusual to see both change alongside the weekly files, flagged to Wesley,
  confirmed intentional). Validated every file first (row counts, no duplicates, no bad values,
  `Pattern_Store_Group` still 139 unique ranks 1-139 per pattern with no gaps) before importing.
  `DCS_Pattern` never had an import script before (only ever loaded once at project start) -
  built `scripts/import-dcs-pattern.js` to handle it, same truncate/reload pattern as the rest.
- All 8 imports matched exactly: `DCS_Pattern` 47, `Pattern_Store_Group` 1,529,
  `Item_Code_allocation_table` 806 items (5,642 unpivoted), `DPS_Code_allocation_table` 2,924
  codes (20,468 unpivoted), `Temporary_Blocking` 493, `ItemReplenishment` 963 items,
  `EcommerceAllocationRequest` 141 items (up sharply from 30 the prior week - flagged, not
  investigated further), `StoreItemInventory` 139,635 rows.
- Re-ran `usp_RunAllocation` (38.9s): 963 items, 138,672 result rows, 13,863 rows blocked by
  exclusions, 111,375 units shipped. Generated both weekly deliverables:
  `Final_Allocation_Results.csv` (22,848 nonzero shipment rows) and
  `DCQty_Less_than_CaseQty.csv` (11 items flagged).

## 2026-09-10/12 - First full-week comparison against Wesley's manual process

- Wesley ran his own manual weborder process in parallel for the same week and provided both
  outputs (`Claude_WO_09-10-26.csv`, `Wes_WO_09-10-26.csv`) for comparison - the first real
  validation of the automated pipeline against the real process it's meant to replace.
- Built a rigorous key-by-key (StoreCode+ItemCode) comparison rather than eyeballing: 22,848 vs
  22,832 rows, 70 discrepancies out of ~22,850 (~0.3%), total units within ~0.4%. Delivered as
  `WO_Discrepancies_09-10-26.csv` (StoreCode/ItemCode/ClaudeQty/WesQty/Difference/
  DiscrepancyType).
- **Found and fixed a real data issue**: store 319 was assigned Store Group C in
  `Pattern_Store_Group` for Pattern 01, but tracing 8 of the 70 discrepancies back to their
  base-allocation-qty lookup showed they all matched exactly if store 319 were Group D instead -
  confirmed against 3 different items with exact numeric matches before concluding it was a
  data issue, not a coincidence. Wesley updated `Pattern_Store_Group.xlsx` (along with
  `DCS_Pattern.xlsx` and `Item_Code_allocation_table.xlsx` - see next entry); re-running
  resolved all 8 of those rows exactly.
- **Traced the remaining discrepancies item by item** (97631, 38326, 97529 at two different
  stores, 91101, 97536, 98408, 68651, 96897, 97654, 98577, 98225, plus all 5 store-470 rows)
  and found a single consistent mechanism behind nearly all of them: at a DC-supply boundary in
  the Final Shortage Adjustment, Wesley's manual number is the raw/unrounded leftover quantity,
  while the pipeline correctly floors to the nearest full case (0 if less than one case). Store
  470 initially looked like a pipeline bug (case-flooring applied where the base-calc stage
  skips case-rounding) but **Wesley confirmed 2026-09-12 this is correct as-built** - the
  Final Shortage Adjustment floors every store uniformly, 470 included, no exceptions. See the
  new note in `business-rules.md`.
- **Conclusion, confirmed by Wesley**: keep flooring to a case, uniformly, at every boundary -
  do not change the pipeline to match the raw-leftover behavior. This is now documented as a
  settled decision, not an open question.
- Re-ran the comparison after the store 319 fix: 70 -> 16 discrepancies
  (`WO_Discrepancies_09-12-26.csv`), all 8 store-319 rows resolved. All 16 remaining are
  explained by the boundary-flooring mechanism above (confirmed correct, not a bug) - none are
  unexplained.
