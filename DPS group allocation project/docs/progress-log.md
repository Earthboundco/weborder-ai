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

- Wesley shared his temporary Holidays table (`DPS code and group allocation.xlsx`, 2,924 DPS codes),
  copied to `assets/`. Analysis: 112 distinct qty rows; one standard price ladder for 30 of 41 DCSs,
  a CL ladder scaled by size, own ladders for AC RB, AS IN MI, AS IN SC, AS OI.
- **No-history rule settled (Step 2c):** anchor on the nearest calculated price bucket in the same
  DCS/size (lower-priced first), scale by the ladder's price slope only (A1 column), not its A1-to-E
  spread; round up, min 1, never above the lower-priced anchor; ladder row as-is if the DCS has no
  calculated bucket at all. Not built yet.
- Built `scripts/build-all-dps.js` (full table for a period: ranking per DCS group, Step 2b per DPS code
  with SQL doing the store x item x price-bucket totals, Step 2c fill-in) and moved the shared rules and
  ranking into `scripts/lib.js` (`build-dps-table.js` now uses it; Holidays JE WO NK/10-13 still 9/9/8/8/7/6/5).
- First full Holidays run: 4,290 DPS codes in ~2.5 min. Thin-data issue found (calculated cells from 1-2
  pairs; group order and price order often broken) - see business-rules.md run notes. Waiting on Wesley.
- Step 2d added per Wesley (min 10 pairs per cell, order caps down the store groups incl. strict A2 > B
  and B > D, and up the price buckets). Rerun: the price cap lowers too much (one low cheap bucket caps
  every pricier bucket; e.g. AC RB B 42/64 -> 5). Options put to Wesley.

## 2026-11-13
- Order rules switched to raising (per Wesley). Rerun: one high pricier cell now lifts every cheaper
  bucket (JE WO NK A2 = 13 from 0-1 to 21-26, because 21-26 A2 = 13). Totals 33-51% above Wesley's table
  for A2-E. Proposed averaging the conflicting cells instead (weighted by pairs).
- Order rules switched to pairs-weighted averaging (per Wesley), strict A2 > B / B > D still by raising.
  Rerun: JE WO NK/10-13 back to 9/9/8/8/7/6/5, outlier diluted (21-26 A2 13 -> 8). Totals vs Wesley's
  table: A1 -2%, A2-E +24-39%. Most of the A1-B gap comes from the strict rule (half of Wesley's own rows
  break it). Asked Wesley whether to keep, limit or drop it.
- Pair daily units switched to the best 7-day window (Wesley's test sheet) in `build-dps-table.js`;
  `lib.js` loadContext now returns the period end per year. JE WO NK/10-13 Holidays 9/9/8/8/7/6/5 ->
  16/14/12/11/9/8/6. `build-all-dps.js` not switched yet.
- `build-dps-table.js` takes `--keep <pct>` for testing the top-% cut. JE WO NK/10-13 Holidays, best 7-day
  window, top 50%: 13/11/10/9/7/6/5.
- JE WO NK/10-13 Summer 2, best 7-day window: top 50% 13/11/9/7/6/5/5, top 30% 17/14/10/8/7/6/6.
- **Rule now (per Wesley): best 7-day window + top 50%.** `lib.js` KEEP_TOP = 0.50; `build-all-dps.js`
  switched to the best 7-day window (SQL: per sale date, in-bucket units date..date+6, max per pair).
  Full Holidays rerun: JE WO NK/10-13 calculated 13/11/10/9/7/6/5, 12/10/9/8/7/6/5 after the order step.
- Benchmark idea (per Wesley): the JE WO NK price range with the most pairs (10-13, 19,166 pairs,
  calculated 13/11/10/9/7/6/5 - meets the order rules) is the benchmark; other ranges derived from it with
  per-group ratios from Wesley's Holidays ladder (range / 10-13, same group), round up. Result breaks the
  group order in 0-1, 1-3, 7-10 and from 81 up, and A2 > B / B > D from 51 up (his ladder's small whole
  numbers give uneven ratios). Put to Wesley.
- Benchmark derivation, per Wesley's pick: one slope per price range = average of his ladder ratios
  (range / 10-13) for A1-B, applied to every group of the 10-13 benchmark, round up. Group and price
  order hold everywhere; strict A2 > B / B > D breaks from 51 up (values 1-5). Workbook:
  `Claude_results/11-13-26-JE_WO_NK_Holidays_benchmark_slope.xlsx` (with a strict-raised variant).
- Tiered order rules (per Wesley) applied to the benchmark-slope table: up to 46-51 A2 > B, B > D;
  51-61 to 91-101 A3 > C, B > D; 101-150 to 250-300 A3 > C, B > C; 300+ A3 > B; decrease the lower groups
  where possible, else increase B (A3 for 300+). Benchmark and 0-1 to 76-81 unchanged; 81-101 B and A3
  raised to 3 (3/3/3/3/2/2/1); 101-300 C and D lowered to 1 (3/3/2/2/1/1/1); 300+ B and C lowered to 1
  (2/2/2/1/1/1/1). Price order holds. Workbook updated.
- **Benchmark method made permanent (per Wesley)** in `build-all-dps.js`: per DCS/size the bucket with the
  most pairs is the benchmark (group order + tier rules first), other buckets = ROUNDUP(benchmark x A1-B
  average ladder slope), then the tier order rules. Old anchored rule and Step 2d removed. Placeholders:
  benchmark groups with < 10 pairs filled from the ladder; A2 raised when "increase B" can't fix A2 > B;
  price order reported, not forced (44 breaks at tier boundaries). Full Holidays rerun: JE WO NK matches
  the test table; totals +39% to +60% vs Wesley's table.
- Price order now forced (per Wesley): pricier bucket lowered to the cheaper one, after the tier rules.
  Holidays rerun: 113 codes lowered, JE WO NK unchanged; 29 CL codes at 51-56 to 76-81 end with A3 = C
  (breaks tier 2 A3 > C) - put to Wesley.
- After the price order, a broken tier strict rule now decreases the lower group (per Wesley: "decrease C
  there"). Holidays rerun: 13 CL codes at 51-56 C -1; all rules hold; the build stops if group or price
  order breaks.
