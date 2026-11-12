# DPS group allocation - progress log

## 2026-11-07
- Wesley gave the project step by step: Step 1a periods (8 fiscal-week periods, boundary weeks in
  both), 1b DCS groups (11 groups; scope = AC, AS, CL, HD, IM, JE; ungrouped DCSs excluded),
  1c store ranking (best of last 3 years, ties by size then store code, 479 below 462 until end of
  May 2027, matching for stores without a complete year, no-sales stores at rank 57), 2a DPS codes
  (price buckets, CL size mapping; price = SAP `CurrentPrice`), 2b allocation table. All in
  `business-rules.md`.
- Data checks: Store Directory has open date, size, tourist flag, lat/long for all open stores;
  139 open stores excl. 470 = 1+5+6+45+57+20+5; every CL size in SAP is covered by the mapping;
  `salesfact` is one row per store/item/day, Sunday-Saturday weeks, week 53 partial.
- First run, JE WO NK/10-13/No Holidays, original method (units / 8 weeks, all pairs, x 3):
  3/2/2/2/1/1/1. Matched 545 -> 450, 546 -> 317; 547 at rank 57.

## 2026-11-08
- Wesley tried variants on A1 then all groups: daily method (first to last qualifying sale),
  7-day minimum, bottom 10% dropped, top 50%, top 20%, x 4. Workbooks in `Claude_results/`.
- **Settled for now: daily method, 7-day minimum, keep top 30% of pairs, x 3.** Results:
  Holidays 9/9/8/8/7/6/5; Summer 1 10/8/8/7/6/5/5.
- Summer 1 run used EBT `INVENTORY_V` for DCS because SAP was down for an update - that run only,
  per Wesley. Rerun from SAP.
- `scripts/build-dps-table.js` rewritten to the settled method; takes `--dps` and `--period`, knows
  all 11 DCS groups, years and matching weeks follow the run date. Verified (with an INVENTORY_V
  test copy, SAP still down) that it reproduces both settled results.
- Project saved to `weborder-ai/DPS group allocation project` (per Wesley).

## 2026-11-12
- Summer 1 rerun from SAP (as of 2026-11-08): 10/8/8/7/6/5/5, same as the provisional INVENTORY_V
  run - Summer 1 is no longer provisional. Workbook
  `Claude_results/11-12-26-DPS_Allocation_JE_WO_NK_10-13_No_Summer1_SAP.xlsx`.
- Fix in `build-dps-table.js`: recent-week sales before a store's open date are ignored. 547 Grand
  Junction (opens 2026-11-14) had 2 pre-opening rows (Nov 4-5, $3.88) and was being matched on $0
  jewelry sales instead of going to rank 57. Holidays rechecked: unchanged.
- Only ranking change vs the provisional run: 544 Deptford matched to 322 instead of 436 (C either way).
