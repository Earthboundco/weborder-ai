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
