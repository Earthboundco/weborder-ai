# DPS group allocation - business rules (per Wesley, 2026-11-07/08)

Source of truth for the rules. Wesley's original brief: `original-brief.txt`. Script: `../scripts/build-dps-table.js`.

## Purpose
Define how many units of an item a store should have on-hand when we allocate to it in the
weekly replenishment process (initial allocation of new items with no sales history, and/or
replenishment). Stores with higher expected sales get more units. Which stores rank highest
depends on the period of the year and the type of item.

1. Rank the stores and group them.
2. For each store group, find the average units sold of items by the item's DCS, current sale
   price (price point) and size (when applicable).

## Step 1 - Ranking the stores

### Step 1a - Periods of the year
Week numbers are our fiscal YearWeek (e.g. 202706 = fiscal 2027, week 06).
Boundary weeks count in BOTH adjacent periods (each period is ranked on its own).

| # | Period         | Fiscal weeks (inclusive)      |
|---|----------------|-------------------------------|
| 1 | Pre-Spring     | 1-7                           |
| 2 | Spring Break   | 7-14                          |
| 3 | Summer 1       | 14-21                         |
| 4 | Summer 2       | 21-28                         |
| 5 | Back-to-school | 28-34                         |
| 6 | Fall 1         | 34-40                         |
| 7 | Fall 2         | 40-46                         |
| 8 | Holidays       | 46 - last week of the fiscal year (52, 53 or 54, whichever applies) |

### Step 1b - DCS groups
Stores are ranked per (period x DCS group), not per individual DCS. A DCS code listed with
fewer than 3 parts (e.g. `AS CA`, `HD KB`) means every DCS under it.

| #  | DCS group                       | Description                           | DCSs |
|----|---------------------------------|---------------------------------------|------|
| 01 | AC RB                           | reusable bags - all DCSs              | AC RB (all) |
| 02 | AC BA/AC HA/AC MI/AC WO         | other accessories                     | AC BA, AC HA, AC MI, AC WO HR, AC WO SC, AC WO SU |
| 03 | AS BT/AS CA/AS SS               | all aroma & spa                       | AS BT MI, AS CA, AS SS, AS IB, AS IN MI, AS IN SC, AS OB, AS OI |
| 04 | AS IB/AS IN                     | incense and burners                   | AS IB, AS IN MI, AS IN SC |
| 05 | AS OB/AS OI                     | oil burners and oils                  | AS OB, AS OI |
| 06 | CL ME/CL WO                     | all clothing                          | CL ME OW, CL ME PA, CL ME SH, CL ME SO, CL ME TS, CL WO DR, CL WO OW, CL WO PA, CL WO SH, CL WO SK, CL WO SO, CL WO TS |
| 07 | HD DO/HD KB/HD MW/HD RM         | most home decor                       | HD DO CD, HD DO DA, HD DO SB, HD KB, HD MW, HD RM |
| 08 | HD TP/HD TX                     | curtains, tapestries & textiles       | HD TP, HD TX |
| 09 | HD WD                           | wall decor accessories & butterflies  | HD WD AC, HD WD BF |
| 10 | IM BK/IM GF                     | all impulse                           | IM BK, IM GF |
| 11 | JE ME/JE WO                     | all jewelry                           | JE ME BR, JE ME NK, JE ME RI, JE WO AK, JE WO BR, JE WO EA, JE WO NK, JE WO RI |

**Scope (Wesley 2026-11-07):** only 6 departments - Accessory (AC), Aroma & Spa (AS), Clothing (CL),
Home Decor (HD), Impulse (IM), Jewelry (JE). Everything else (DC MI, CO FO, NR, blank, X) is out.

**"Group to use" per DCS** - source: Wesley's `DCS and group.xlsx` (Desktop, 47 DCS rows). Each DCS
follows exactly one group's ranking. Note the "DCSs" column above is the sales that FEED a group's
ranking; the mapping below is which ranking an ITEM follows. They differ only for group 03:
its ranking uses all aroma & spa sales, but only AS BT MI / AS CA / AS SS items use it
(AS IB, AS IN -> group 04; AS OB, AS OI -> group 05).

| DCS | Group to use |
|-----|--------------|
| AC RB | 01 |
| AC BA, AC HA, AC MI, AC WO HR, AC WO SC, AC WO SU | 02 |
| AS BT MI, AS CA, AS SS | 03 |
| AS IB, AS IN MI, AS IN SC | 04 |
| AS OB, AS OI | 05 |
| CL ME OW/PA/SH/SO/TS, CL WO DR/OW/PA/SH/SK/SO/TS | 06 |
| HD DO CD, HD DO DA, HD DO SB, HD KB, HD MW, HD RM | 07 |
| HD TP, HD TX | 08 |
| HD WD AC, HD WD BF | 09 |
| IM BK, IM GF | 10 |
| Any JE ME (incl. JE ME WT, per Wesley), JE WO AK/BR/EA/NK/RI | 11 |

Confirmed by Wesley 2026-11-07:
- Group 03 reading above is right (ranking from all AS sales; applied to BT/CA/SS items only).
- DCSs in the 6 departments that have no group are EXCLUDED ("we do not work with them"): AC VM,
  AC WO GL, HD DO with no 3rd part, HD FO, HD LI, IM GC, IM MU, IM PE. Only the DCSs in the
  table above (plus any JE ME) are in the project.

### Step 1c - Ranking the stores (per period x DCS group)
1. Eligible store = currently open. For each, sum gross sales (salesfact `EXT_PRICE`, positive rows
   only) of the DCS group's ranking DCSs for the period's fiscal weeks, in each of the last 3 full
   fiscal years (running in Nov 2026 -> 2023, 2024, 2025).
2. Keep each store's SINGLE BEST year of the three (not average, not total).
3. Rank highest best-year sales first (#1 = best).
4. Ties at a selection cutoff: larger store ranks higher (5-XLg > 4-Avg > 3-Sml > 2-XSm > 1-IttyBitty).
5. Special: 479 Brandon (moved to a much smaller location in the same mall in 2026) goes ONE position
   below 462 Countryside; everyone below shifts down one.
6. A store not open for the complete period (all its weeks) in at least 1 of the 3 years is matched
   with a similar store by sales over the last weeks before this week (max 12 weeks). The match must
   be within 500 miles (straight line) OR in the same state, AND the same type (tourist / mall).

Store groups (top to bottom of the rank):
| Group | Stores |
|-------|--------|
| A1 | 1 |
| A2 | 5 |
| A3 | 6 |
| B  | 45 |
| C  | the rest (varies; 57 when 139 stores) |
| D  | 20 |
| E  | 5 (bottom 5) |
A1, A2, A3, B, D, E sizes are fixed; C absorbs any change in store count.

Confirmed by Wesley 2026-11-07:
- 470 Ecommerce is left out of the ranking.
- Matching is per period: a store uses its own best COMPLETE year when it has one; it is matched only
  for periods with no complete year (e.g. 544 Deptford, opened May 2025: own sales for Holidays,
  matched for Pre-Spring).
- Similarity = sales of the DCS group being ranked (same last <=12 weeks). The matched store is placed
  1 rank after its match.
- A store with no sales yet (e.g. 547 Grand Junction) is placed at the last B position (rank 57).
  Sales in weeks that end before the store's open date don't count (547 had 2 pre-opening rows on
  2026-11-04/05, $3.88 - setup/test transactions).
- 479 Brandon goes directly below 462 in EVERY ranking (all periods and DCS groups), even if its own
  sales would put it lower. Applies until end of May 2027 (then it has a full year in the new location).
- Size tie-break applies to any tie, not only at group cutoffs; same size -> lower store code first.

Working assumptions (flag to Wesley if they matter):
- "Similar" = smallest absolute difference in total gross sales (EXT_PRICE > 0) of the DCS group over
  the same weeks; candidates are only stores that have a complete year for that period (not
  themselves matched/placed).
- Order of special placements: rank everyone with own sales, then insert matched stores, then 479,
  then no-sales stores at rank 57.

Note: `salesfact.STORE_NO` is the Store Directory `[ID #]`, not `[Code #]` - join through
`[Store Directory]`.

## Step 2 - Average units sold by DCS, price point and size

### Step 2a - DPS codes
DPS code = `DCS_Code & "/" & Price_Adjusted & "/" & Size_Adjusted`
(e.g. `AC BA/10-13/No`, `AC RB/7-10/No`, `CL WO DR/46-51/M`, `JE WO NK/10-13/No`).

Price_Adjusted - first bucket whose lower bound the sale price is strictly ABOVE (upper bound
inclusive, e.g. 13.00 -> "10-13", 13.01 -> "13-17"):
| Sale price > | Label    |
|--------------|----------|
| 500 | >=500 |
| 400 | 400-500 |
| 350 | 350-400 |
| 300 | 300-350 |
| 250 | 250-300 |
| 200 | 200-250 |
| 150 | 150-200 |
| 101 | 101-150 |
| 91 | 91-101 |
| 81 | 81-91 |
| 76 | 76-81 |
| 71 | 71-76 |
| 66 | 66-71 |
| 61 | 61-66 |
| 56 | 56-61 |
| 51 | 51-56 |
| 46 | 46-51 |
| 41 | 41-46 |
| 36 | 36-41 |
| 31 | 31-36 |
| 26 | 26-31 |
| 21 | 21-26 |
| 17 | 17-21 |
| 13 | 13-17 |
| 10 | 10-13 |
| 7 | 7-10 |
| 5 | 5-7 |
| 3 | 3-5 |
| 1 | 1-3 |
| (else) | 0-1 |
Exactly 500.00 -> "400-500" (formula is `>500`, label says ">=500"); kept as the formula says.

Size_Adjusted - only for DCS starting `CL`; every other DCS -> "No".
| Size value(s) | Size_Adjusted |
|---------------|---------------|
| XS, XSM | XS |
| S, SM, XS/S | S |
| M, MD, 25-31, REG, S/M/L, S/M, M/L | M |
| L, LG, 32-42, 70 IN, L/XL | L |
| XL, XLG | XL |
| XXL, 2XL, 2X, XL/XXL, 2XL/XXL, XL/2X | 2X |
| 3X, 3XL | 3X |
| 4X, 4XL | 4X |
| blank, "(blank)", O/S, OS | No |
| anything else | the size as-is |
Checked 2026-11-07: every CL size in `SAP_Item_Information.SIZE` falls in the mapping above
(no pass-through values today).

Sources (confirmed by Wesley 2026-11-07): sale price = `SAP_Item_Information."CurrentPrice"`;
size = `SAP_Item_Information."SIZE"`.

### Step 2b - Allocation table (confirmed by Wesley 2026-11-07)
Per (period, DPS code), using the ranking for that period x the DCS group the DPS code's DCS follows:
1. Each store uses ONLY its best year from the ranking (highest DCS-group sales in the period).
2. Sales lines: `salesfact` rows with `SOLD_QTY > 0`, in that store's best year, period weeks
   (`salesfact.YEAR`/`WEEK` = fiscal YearWeek, per Wesley). Line price = `EXT_PRICE / SOLD_QTY`
   (after coupons/promos) decides the price bucket; DCS and size are the item's CURRENT values in
   SAP. One item can land in several DPS codes if it sold at different prices.
3. A store "carried" an item if it sold >= 1 unit of it (in that DPS code) in its best year's period
   weeks. Under-counts stores that had it but sold none - accepted.
4. Per (store x item) pair - **best 7-day window (per Wesley 2026-11-13, his "Daily units sold
   test.xlsx")**:
   - For each qualifying sale date: window = that date to date + 6, never past the period's last day
     in that store's best year (looked up from salesfact; Holidays ends 12/31 in 2023-2025).
   - Units in the window = only the qualifying sales (same DPS code: $10 < price <= $13 for 10-13).
   - Window rate = units / max(window days, 7) - the 7-day minimum, so every window is divided by 7.
   - Daily units = the highest window rate (ties: earliest window).
   - Test case: 376 Stonebriar x 91665, 2025 -> best window Dec 21-27, 7 units / 7 = 1.0 (matches
     Wesley's sheet; the old method gave 11 / 15 = 0.733).
   - Superseded (2026-11-08 to 2026-11-13): days = first to last qualifying sale, min 7; daily =
     all qualifying units / days. Both scripts use the best window since 2026-11-13.
5. Per group: rank pairs by daily units, **keep only the top 50%** (count rounded up; rule per Wesley
   2026-11-13 - was top 30% from 2026-11-08), average them,
   x 7 = weekly units average.
6. Stores with no own history - matched stores, rank-57 no-sales stores, and 479 Brandon (until end of
   May 2027) - stay in their group but are left out of the average.
7. Qty = ROUNDUP(weekly units average x 3), minimum 1.

   Superseded (2026-11-07 first run): weekly = units / all weeks in the period, average over ALL pairs.
   Also tried 2026-11-08: bottom 10% dropped, top 50%, top 20%, x 4 - see the comparison workbooks.
8. Output layout like `DPS_Code_allocation_table`: one row per DPS code, a column per group
   (A1, A2, A3, B, C, D, E).

First run: Holidays only, DPS code `JE WO NK/10-13/No` only.

### Step 2c - Benchmark method (per Wesley 2026-11-13, permanent)
Replaces the anchored rule and Step 2d below. Full table (`build-all-dps.js`), per DCS/size:
1. **Benchmark** = the price bucket with the most store x item pairs (all groups together), among
   buckets where at least one group has >= 10 pairs. Its group values are the calculated ones (Step 2b).
   Example: JE WO NK -> 10-13 (19,166 pairs), 13/11/10/9/7/6/5.
2. **Benchmark order:** E <= D <= C <= B <= A3 <= A2 <= A1 (pairs-weighted average where broken, round
   up), then the order rules of its price tier (below; tier 1 = Wesley's benchmark rule A2 > B, B > D).
   Adjusted before anything is derived from it.
3. **Other buckets:** qty = ROUNDUP(benchmark group qty x slope), minimum 1. Slope = average of the
   ladder ratios (bucket / benchmark bucket) for A1, A2, A3 and B, from Wesley's Holidays table
   `assets/DPS code and group allocation - Holidays ladder (2026-11-12).xlsx` - one slope per bucket for
   all groups, so the benchmark's group spread is kept at every price.
4. **Order rules by price tier** - always E <= D <= C <= B <= A3 <= A2 <= A1, plus:

   | Price buckets | Strict | Fix |
   |---|---|---|
   | up to 46-51 (incl. benchmark rule) | A2 > B, B > D | decrease D and E if possible, else increase B |
   | 51-56 to 91-101 | A3 > C, B > D | decrease D and E if possible, else increase B |
   | 101-150 to 250-300 | A3 > C, B > C | decrease C, D and E if possible, else increase B |
   | 300-350 and up | A3 > B | decrease B, C, D and E if possible, else increase A3 |

   Decrease = lower group set to (higher group - 1), minimum 1, and the groups below it lowered to keep
   the order. Increase = named group raised (and the groups above it, to keep the order).
5. **No benchmark** (no bucket with >= 10 pairs in any group for that DCS/size): ladder values as-is,
   then the tier rules.
6. Ladder used: the DCS/size's own ladder; CL ME uses the matching CL WO ladder; others not in the
   table use the standard ladder (`JE WO NK/No`). Sized rows outside CL are ignored.

**Open questions / placeholders (flag to Wesley):**
- A benchmark group with < 10 pairs is filled: ladder benchmark value x the pairs-weighted ratio
  (calculated / ladder) of the benchmark's other groups. 189 such cells in the first Holidays run
  (mostly CL sizes).
- When "increase B" can't fix a pair because B is the lower one (A2 > B in tier 1 with B not
  decreasable), A2 is raised instead (first hit: a benchmark at 13/7/7/7/5/5/5).
- The benchmark uses the rules of its own price tier (a benchmark above 51 would not get A2 > B / B > D).
- **Price order** (per Wesley 2026-11-13, "lower pricier bucket"): after the tier rules, going from the
  cheapest bucket up, a cell above the same group in the next cheaper bucket is lowered to it. First
  Holidays run: 113 DPS codes lowered. If the lowering breaks a tier strict rule (A3 = C at 51-56 when the
  cheaper 46-51 has A3 = C), the lower group is decreased to (higher - 1), min 1, with the groups below it
  (per Wesley 2026-11-13, "decrease C there"; tier 2 otherwise doesn't decrease C). 13 CL codes at 51-56
  (C down by 1), e.g. CL WO DR/51-56/2X 13/6/4/4/4/3/3 -> 13/6/4/4/3/3/3; the pricier buckets follow.
  The build now stops if the group order or the price order is broken anywhere.
- The ladder table is Holidays-only; other periods use the same slopes until Wesley says otherwise.

### Superseded 2026-11-13: anchored rule (old Step 2c) and Step 2d
- Anchored rule (2026-11-12): a group with no calculated value used the nearest calculated bucket x the
  ladder's A1 slope; DCS/sizes with nothing calculated used the ladder as-is.
- Step 2d (2026-11-12/13): minimum 10 pairs per cell, then order by lowering caps, then raising, then
  pairs-weighted averaging + strict raise. Dropped because single cells (thin or outlier) kept moving
  their neighbours; the benchmark method uses one well-supported bucket per DCS/size instead.

Data found 2026-11-07 (`EBT.dbo.[Store Directory]`, open = non-blank `WStoreType`): 140 open incl.
470 Ecommerce (no size) -> 139 retail = 1+5+6+45+57+20+5. Has `OPEN` date, `WStoreSize`,
`Tourist_location` (bit), `Latitude`/`Longitude` (filled for all open stores), `STATE`.
19 open stores opened 2023-01-03 or later; 545 Arrowhead and 546 Flatiron opened May 2026;
547 Grand Junction opens 2026-11-14 (no sales yet).

## Run notes
- 2026-11-08 Summer 1 run (JE WO NK/10-13/No): SAP was down for an update, so item DCS came from
  EBT `INVENTORY_V` for that run ONLY (per Wesley). The rule stays SAP `SAP_Item_Information`;
  rerun Summer 1 from SAP once it is back.
- 2026-11-08 settled method (top 30%, x 3) results for JE WO NK/10-13/No (A1/A2/A3/B/C/D/E):
  Holidays 9/9/8/8/7/6/5; Summer 1 10/8/8/7/6/5/5 (Summer 1 provisional - INVENTORY_V DCS).
- 2026-11-12 Summer 1 rerun from SAP (as of 2026-11-08): same result, 10/8/8/7/6/5/5 - no longer
  provisional. Only ranking change: 544 Deptford matched to 322 Myrtle Beach II instead of 436 Great
  Northern (C either way; matched stores are not in the average). Holidays rerun with the pre-opening
  fix: unchanged, 9/9/8/8/7/6/5.
- 2026-11-12 first full Holidays build (`scripts/build-all-dps.js`, all DPS codes):
  `Claude_results/11-12-26-DPS_Allocation_All_Holidays.xlsx`. 4,290 DPS codes (Wesley's 41 DCSs
  minus non-CL sized rows, plus CL ME x 5 and AS BT MI). Cells: 7,328 calculated, 12,142 anchored,
  10,560 ladder as-is. JE WO NK/10-13/No = 9/9/8/8/7/6/5 (same as the single-code build).
  **Open issue - thin data:** 876 calculated cells come from 1 store x item pair, 567 from 2. A single
  1-unit sale gives qty 3, a single strong pair can give 174 (AC RB/1-3 A1). Result: in 2,091 of 4,290
  rows a lower store group gets more than the group above, and 2,006 cells rise with price (1,913 of
  them between two calculated cells). Compared with Wesley's table (same DPS codes), A1 is ~0.6x,
  A2/A3 ~1x, B ~1.3x, C-E ~1.5x on the median. Needs a decision before this table is used.
- 2026-11-12 Holidays with Step 2d (min 10 pairs + order caps):
  `Claude_results/11-12-26-DPS_Allocation_All_Holidays_min10_order.xlsx`. Cells: 3,991 calculated,
  10,769 anchored (3,337 had sales but < 10 pairs), 15,270 ladder as-is (mostly CL sizes; A1 3,000 and
  E 2,940 because A1 is one store and E five). Caps lowered 8,739 of 30,030 cells (2,743 by half or more);
  2,731 cells sit at 1 above a strict cap. JE WO NK/10-13/No 9/9/8/8/7/6/5 -> 7/7/7/6/6/5/5 (A1 capped by
  its 7-10 bucket = 7). **Side effect of the price cap:** one low cheaper bucket caps every pricier bucket
  above it - AC RB/0-1 B = 5 (15 pairs) pulls AC RB B to 5 at every price (1-3 was 42, 3-5 was 64), and
  the group caps then pull C-E down too. The 0-1 bucket is mostly items sold at clearance/promo prices
  (bucket = actual sale price). Waiting on Wesley.
- 2026-11-13 Holidays with Step 2d, order by raising:
  `Claude_results/11-13-26-DPS_Allocation_All_Holidays_min10_raise.xlsx`. 12,440 of 30,030 cells raised
  (3,063 doubled or more). JE WO NK/10-13/No = 13/13/9/9/9/7/6. **Same problem mirrored:** one high
  pricier cell lifts every cheaper bucket - JE WO NK/21-26 A2 = 13 (35 pairs; neighbors 7-9) sets A2 = 13
  for every bucket from 0-1 to 21-26. Totals vs Wesley's table (his DPS codes): A1 +4%, A2 +41%, A3 +36%,
  B +51%, C +41%, D +51%, E +33%. Waiting on Wesley.
- 2026-11-13 Holidays with Step 2d, order by pairs-weighted averaging:
  `Claude_results/11-13-26-DPS_Allocation_All_Holidays_min10_avg.xlsx`. 6,027 cells changed by the
  averaging (4,162 up, 1,865 down; 54 fit passes), then 8,628 raised by the strict A2 > B / B > D rule.
  JE WO NK/10-13/No back to 9/9/8/8/7/6/5; JE WO NK/21-26 A2 13 -> 8. Totals vs Wesley's table: A1 -2%,
  A2 +30%, A3 +24%, B +39%, C +29%, D +39%, E +28%. **Open - strict rule:** 1,448 of Wesley's 2,910
  rows break his own A2 > B / B > D (e.g. his 101+ ladder 2/2/2/2/1/1/1), so with D >= 1 the rule forces
  B >= 2 and A2/A1 >= 3 everywhere. Those raises add A1 +1,653, A2 +2,834, A3 +1,102, B +1,538 units
  (most of the A1-B gap; 3,659 on anchored and 2,979 on ladder cells, 489 on calculated). Waiting on
  Wesley: keep the strict rule, apply it only where values are large enough, or drop it.
- 2026-11-13 JE WO NK/10-13/No Holidays with the best 7-day window (`build-dps-table.js`):
  `Claude_results/11-13-26-DPS_Allocation_JE_WO_NK_10-13_No_Holidays_best7day.xlsx`.
  9/9/8/8/7/6/5 -> **16/14/12/11/9/8/6** (A1 0.407 -> 0.744/day, B 0.348 -> 0.496, C 0.305 -> 0.396).
  Same pairs (B 6,648, C 7,784). Because every window is divided by 7, a pair's daily = best-week units
  / 7, so values are steps of 1/7: in B 49% of pairs sold 1 unit in their best week and 28% sold 2;
  the top-30% cut falls inside the 2-unit tie (483 of 1,872 kept, by store rank then item number).
  In C the cut is also at 2 units (1,212 of 2,023 kept).
- 2026-11-13 same, top 50% instead of 30% (test, `--keep 50`):
  `Claude_results/11-13-26-DPS_Allocation_JE_WO_NK_10-13_No_Holidays_best7day_top50.xlsx`.
  **13/11/10/9/7/6/5** (top 30% gave 16/14/12/11/9/8/6). B cut still inside the 2-unit tier (no 1-unit
  pairs kept); C keeps all 3,147 pairs with 2+ units plus 745 of its 4,637 1-unit pairs.
- 2026-11-13 JE WO NK/10-13/No Summer 2 (fiscal weeks 21-28; 2023 5/21-7/15, 2024 5/19-7/13,
  2025 5/18-7/12), best 7-day window: top 50% **13/11/9/7/6/5/5**, top 30% **17/14/10/8/7/6/6**.
  `Claude_results/11-13-26-DPS_Allocation_JE_WO_NK_10-13_No_Summer2_best7day_top50.xlsx` / `_top30.xlsx`.
- 2026-11-13 **full Holidays table with the current rule** (best 7-day window + top 50%, Step 2c, Step 2d
  min 10 pairs + pairs-weighted averaging + strict raise):
  `Claude_results/11-13-26-DPS_Allocation_All_Holidays_best7day_top50.xlsx`. Calculated JE WO NK/10-13 =
  13/11/10/9/7/6/5 (same as the single-code run); after Step 2d **12/10/9/8/7/6/5**, because the cheaper
  5-7 bucket comes out lower (9/7/7/6/6/5/5, B 1,935 pairs) and a cheaper bucket can't be below a pricier
  one, so 5-7 to 10-13 are averaged. JE WO NK/21-26 A2 = 16 (only 6 A1 pairs, outlier) averaged down to 8.
  5,287 cells averaged (3,717 up, 1,570 down), 8,331 raised by the strict A2 > B / B > D rule. Totals vs
  Wesley's table: A1 +8%, A2 +39%, A3 +33%, B +47%, C +34%, D +40%, E +28%.
- 2026-11-13 **full Holidays table, permanent rule** (best 7-day window + top 50%, benchmark method + tier
  order rules): `Claude_results/11-13-26-DPS_Allocation_All_Holidays_benchmark.xlsx`. 143 DCS/size: 95 with a
  benchmark (Benchmarks tab), 48 ladder only (CL sizes). JE WO NK = the test table (10-13 13/11/10/9/7/6/5,
  0-1 29/24/22/20/16/14/11, 81-91 3/3/3/3/2/2/1, 101-150 3/3/2/2/1/1/1, >=500 2/2/2/1/1/1/1). 1,832 DPS codes
  adjusted by tier rules; 44 price-order breaks at tier boundaries (reported). Totals vs Wesley's table:
  A1 +39%, A2 +51%, A3 +50%, B +60%, C +51%, D +50%, E +55%.
- 2026-11-13 rerun with price order forced by lowering the pricier bucket (same file): 113 DPS codes
  lowered, JE WO NK unchanged; 29 CL codes (51-56 to 76-81) end with A3 = C (tier 2 rule A3 > C broken).
- 2026-11-13 rerun with "decrease C" after the price order (same file): 13 CL codes at 51-56 had C lowered
  by 1; no tier rule, group order or price order broken anywhere. JE WO NK unchanged.
