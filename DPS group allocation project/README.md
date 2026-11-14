# DPS group allocation project

Defines how many units of an item each store group (A1, A2, A3, B, C, D, E) should have on hand
when we allocate in the weekly replenishment process - for new items (no sales history) and for
replenishment. The output has the same layout as weborder-ai's `DPS_Code_allocation_table`:
one row per DPS code (DCS / price bucket / size), one column per store group.

Business rules come from Wesley, step by step (started 2026-11-07).

## Layout
| Path | What |
|------|------|
| `docs/business-rules.md` | **Source of truth** for every rule (periods, DCS groups, store ranking, DPS codes, allocation math) and run notes. |
| `docs/original-brief.txt` | Wesley's original project brief. |
| `docs/progress-log.md` | Dated log of what was built or decided. Append, don't rewrite. |
| `assets/` | Reference inputs from Wesley (Holidays ladder table used for the no-history price slope). |
| `scripts/build-all-dps.js` | Builds the full allocation table (all DPS codes, Steps 2b + 2c benchmark method) for one period. |
| `scripts/build-dps-table.js` | Builds the ranking + allocation row for one DPS code and one period, with pair-level detail. |
| `scripts/lib.js` | Shared rules (periods, DCS groups, DPS code parts) and the store ranking. |
| `Claude_results/` | Generated workbooks (git-ignored). |

## How it works (short)
1. **Rank the stores** for the period and the DCS group the item's DCS follows: gross sales, best
   of the last 3 fiscal years, with tie, matching, 479 Brandon and no-sales rules. Cut into
   A1 1 / A2 5 / A3 6 / B 45 / C rest / D 20 / E 5.
2. **Allocation qty** per group: daily units per store x item pair (best 7-day window), keep the top
   50% of pairs, x 7 = weekly, x 3, round up, minimum 1.

## Run
From the `weborder-ai` folder (it holds `.env`, `db.js`, `hana.js`):
```
node "DPS group allocation project/scripts/build-dps-table.js" "DPS group allocation project/Claude_results/<MM-DD-YY>-<name>.xlsx" --dps "JE WO NK/10-13/No" --period "Holidays"
```
Full table for a period:
```
node "DPS group allocation project/scripts/build-all-dps.js" "DPS group allocation project/Claude_results/<MM-DD-YY>-DPS_Allocation_All_<period>.xlsx" --period "Holidays"
```
Periods: Pre-Spring, Spring Break, Summer 1, Summer 2, Back-to-school, Fall 1, Fall 2, Holidays.
Optional `--today YYYY-MM-DD` to run as of a past date. Needs EBT SQL Server and SAP HANA.

## Status (2026-11-13)
- Rule (permanent, per Wesley 2026-11-13): pair daily units = best 7-day window, top 50% of pairs,
  x 7 x 3; per DCS/size the bucket with the most pairs is the benchmark, other buckets = benchmark x the
  price slope from the Holidays ladder table, then the order rules of each price tier
  (`docs/business-rules.md` Steps 2b-2c).
- Full Holidays table built with it (`Claude_results/11-13-26-DPS_Allocation_All_Holidays_benchmark.xlsx`).
  Open: placeholders in Step 2c (filled benchmark groups, price-order breaks at tier boundaries) and the
  totals vs Wesley's table (+39% to +60%).
- Next: settle the open points, then all periods.
