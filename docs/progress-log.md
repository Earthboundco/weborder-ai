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
