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
| `scripts/build-dps-table.js` | Builds the ranking + allocation row for one DPS code and one period. |
| `Claude_results/` | Generated workbooks (git-ignored). |

## How it works (short)
1. **Rank the stores** for the period and the DCS group the item's DCS follows: gross sales, best
   of the last 3 fiscal years, with tie, matching, 479 Brandon and no-sales rules. Cut into
   A1 1 / A2 5 / A3 6 / B 45 / C rest / D 20 / E 5.
2. **Allocation qty** per group: daily units per store x item pair (7-day minimum), keep the top
   30% of pairs, x 7 = weekly, x 3, round up, minimum 1.

## Run
From the `weborder-ai` folder (it holds `.env`, `db.js`, `hana.js`):
```
node "DPS group allocation project/scripts/build-dps-table.js" "DPS group allocation project/Claude_results/<MM-DD-YY>-<name>.xlsx" --dps "JE WO NK/10-13/No" --period "Holidays"
```
Periods: Pre-Spring, Spring Break, Summer 1, Summer 2, Back-to-school, Fall 1, Fall 2, Holidays.
Optional `--today YYYY-MM-DD` to run as of a past date. Needs EBT SQL Server and SAP HANA.

## Status (2026-11-12)
- Built and settled for one DPS code: `JE WO NK/10-13/No`, Holidays (9/9/8/8/7/6/5) and Summer 1
  (10/8/8/7/6/5/5, rerun from SAP 2026-11-12).
- Next: rule for DPS codes with no sales history (higher price -> fewer units); then all DPS
  codes and all periods.
