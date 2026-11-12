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
4. Per (store x item) pair - **daily method, settled 2026-11-08 "for now" (per Wesley)**:
   - Days = first to last qualifying sale date in the period, both ends included; **minimum 7 days**
     (so a single 1-unit sale = 1/7 per day = 1.0 per week).
   - Daily units = pair's qualifying units / days.
5. Per group: rank pairs by daily units, **keep only the top 30%** (count rounded up), average them,
   x 7 = weekly units average.
6. Stores with no own history - matched stores, rank-57 no-sales stores, and 479 Brandon (until end of
   May 2027) - stay in their group but are left out of the average.
7. Qty = ROUNDUP(weekly units average x 3), minimum 1.

   Superseded (2026-11-07 first run): weekly = units / all weeks in the period, average over ALL pairs.
   Also tried 2026-11-08: bottom 10% dropped, top 50%, top 20%, x 4 - see the comparison workbooks.
8. Output layout like `DPS_Code_allocation_table`: one row per DPS code, a column per group
   (A1, A2, A3, B, C, D, E).

First run: Holidays only, DPS code `JE WO NK/10-13/No` only.
Later: DPS codes with no sales history get values from a rule still to define (higher price ->
fewer units).

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
