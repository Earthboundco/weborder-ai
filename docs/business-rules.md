# Business rules

## Exclusion rules (14 rules, `ExclusionRules` + `vw_ExclusionEvaluation`)

Migrated from an Access database (no longer the source of truth - SQL Server is now). Each
rule can be toggled off via `ExclusionRules.IsActive` without touching the view logic.

| Rule | Name | Logic |
|---|---|---|
| Exc1 | Store closed | Block if `Store Directory.WStoreType` is empty/null. (Confirmed by Netto - empty WStoreType = closed. No separate close-date field exists.) |
| Exc2 | EBT store = N | Block stores other than 470 from items not flagged as EBT (retail) store items. |
| Exc3 | Online store = N | Block store 470 (Ecommerce) from items not flagged as online-store items. |
| Exc4 | MarkdownFlag = Y | Block markdown items from IttyBitty/XSm stores, Fashion Focus stores, store 479, and stores open <60 days. |
| Exc5 | Prop 65 = Fail | Block CA stores and store 470 from items that failed Prop 65. |
| Exc6 | Canvas wall art | Block IttyBitty/XSm stores from HD WD canvas items. |
| Exc7 | Curtains | Block IttyBitty stores and stores 420/485 from HD WD AC curtain items. |
| Exc8 | Large statue | Block IttyBitty stores from items 0 and 10731. |
| Exc9 | Sunglasses | Block CA stores and store 470 from AC WO SU items. |
| Exc10 | Fashion Focus Store status | Items with `IStatus = FashionFocusStore` only ship to Fashion Focus stores or stores 376/470. |
| Exc11 | Fashion Focus block entire DCS | Block Fashion Focus stores + store 479 entirely from DCS codes: AS IB, AS OB, AS OI, AS SS, HD DO CD, HD TP, IM BK. |
| Exc12 | Fashion Focus block DCS with exceptions | Same stores, but per-DCS item/vendor/description exceptions (AS IN MI except item 16472, AS IN SC except vendor V01072, HD DO DA except item 34299, HD RM except a 16-item list, HD TX except item 28063, HD WD AC except "WALL BANNER" items). |
| Exc13 | Blocking RP 999 | **Added 2026-09-05.** Block item/store combos where Retail Pro (the internal POS system) has set both Min level and Max level to 999 for that item at that store - this is how RP marks an item as blocked from a store. Sourced from `StoreItemInventory.MinQty`/`MaxQty` (see `sql/012_add_blocking_rp999_exclusion_rule.sql`). If there's no `StoreItemInventory` row at all for that item/store, this rule passes (no data ≠ blocked). Validated 2026-09-05 against the current 788-item set: 11,999 of 113,472 item/store rows have Min=Max=999, all correctly blocked; 3,268 of those had previously passed all 12 other rules (i.e. this rule newly blocks 3,268 combos that would otherwise have shipped). |
| Exc14 | Temporary Blocking | **Added 2026-09-05/06.** Block item/store combos flagged `Status = 'Block'` in `Temporary_Blocking` (Store, Item, Status - business Store Code + plain item code). Used while an item is being tested at selected locations only: the item stays in DC stock, but every store *not* part of the test gets temporarily blocked; once the test concludes, the blocking rows for that item are removed and it opens up normally. Refreshes weekly or every other week (`scripts/import-temporary-blocking.js`, truncate/reload). No row for a pair means no block (same convention as Exc13). Validated 2026-09-05 against the initial 493-row file (7 items, 119 stores, all `Status='Block'`): all 493 combos correctly blocked, but **0 of those had previously passed** all other rules - every one was already blocked by Exc13 (RP999) or Exc12, so this rule currently has zero net effect on shipped results. Expected to matter going forward as test items move through their lifecycle. |

`AllowSend` (in `vw_ItemStoreAllowSend`) = Y only if all 14 rules return Y.

**Validated 2026-08-27** against the real 788-item weekly set x 144 active stores (113,472
combos): 9,149 blocked overall. Per-rule block counts: Exc10 blocked the most (7,506), then
Exc4 (900), Exc12 (435), Exc7 (105), Exc11 (135), Exc3 (73), Exc9 (42), Exc5 (12). Exc1, Exc2,
Exc6, Exc8 blocked 0 for this particular item set (plausible - e.g. items 0/10731 for Exc8
simply weren't in this week's set).

## Allocation math (`vw_AllocationBase` + `vw_AllocationDraft`)

1. Item's `DCS_CODE` -> `DCS_Pattern` -> item's Pattern.
2. (Pattern, Store Code) -> `Pattern_Store_Group` -> Store Group.
3. Base allocation qty = `Item_Code_allocation_table` override if one exists for
   (ItemCode, StoreGroup), else `DPS_Code_allocation_table` for (DPS_Code, StoreGroup), else 0.
4. If `AllowSend = N` (any exclusion rule failed), allocation is 0 - full stop.
5. Otherwise: `NetNeed = BaseAllocationQty - OnHandQty - InTransitQty` (floored at 0).
6. **Case-qty rounding: always round UP to the next full case.** We never break a case to ship
   a partial amount - e.g. need 5, case qty 2 -> send 6, not 4 or 5. Implemented as
   `CEILING(NetNeed / QTY_PER_CASE) * QTY_PER_CASE`.
7. **If demand exceeds supply, adjust/cap.** "Demand" here means `SUM(AllocationQty)` across
   all `AllowSend='Y'` stores for the item (470 included); "shortage" = demand - `DC_Qty`. Two
   stages, run in this order (renamed 2026-09-06 per Wesley - see the dedicated section below
   for full mechanics and a worked example):
   - **Initial Shortage Adjustment** (new 2026-09-06): only runs if shortage > 30 pcs. Softens
     large shortages by proportionally trimming lower-priority groups' *base* allocation qty
     (before re-netting/case-rounding) before the final cap runs, so a big shortage doesn't
     necessarily mean dozens of low-priority stores get zeroed outright.
   - **Final Shortage Adjustment** (renamed from "the waterfall cap"; **mechanism corrected
     2026-09-06** - see below): store-priority order is **470 (Ecommerce) always first**, then
     every other store in ascending order of `Pattern_Store_Group.Rank` for that item's DCS
     Pattern (replaced Store Group order + StoreCode tie-break entirely, 2026-09-05 - see
     `data-sources.md`). Any store missing from `Pattern_Store_Group` for that pattern falls
     back to rank 999 (shouldn't occur today).

## Initial Shortage Adjustment (added 2026-09-06)

Per Wesley: when an item's shortage (demand - `DC_Qty`, see step 7 above) is 30 pcs or less, go
straight to the Final Shortage Adjustment (the waterfall) as before - no change. When shortage
exceeds 30 pcs, soften it first by trimming lower-priority groups' *base* allocation qty (i.e.
`BaseAllocationQty`, before on-hand netting/case-rounding - **not** the final case-rounded
`AllocationQty`) so the waterfall doesn't have to zero out as many stores outright.

**Mechanics**, per item:
1. Walk groups in this order: **E -> D -> C -> B -> A3 -> A2 -> A1** (470 is never a target - it
   has no Store Group, so it's naturally skipped; its qty still counts toward demand, per
   Wesley, since it's real consumption of the same DC supply).
2. At each group step: cut every store in that group's `BaseAllocationQty` by 5%, **floored to
   the nearest whole number**, compounding off whatever the value *currently* is (not the
   original) - so a second pass over a group cuts another 5% off the already-reduced number, not
   10% off the original. Then re-net against On-Hand+In-Transit (floored at 0, per the existing
   rule above) and re-apply case-qty rounding exactly as normal - **the case rule is never
   broken**; only the pre-netting base number is smaller going in. The qty allocated to a group
   at this stage can be any positive value; only the *final* allocation (after netting) must be
   a case multiple.
3. Recompute demand and shortage after every single group step. The moment shortage <= 30,
   **stop immediately** (even mid-sequence) and move to the Final Shortage Adjustment using
   whatever `AllocationQty` values currently stand.
4. If a full E->A1 pass finishes and shortage is still > 30, loop back to E and keep compounding.
   A step that lands on a group with nothing left to reduce (e.g. every store's on-hand already
   covers its base qty) is a legitimate no-op - progress comes from whichever step in the
   sequence actually has room to cut.

Implemented in `usp_RunAllocation` (`sql/015_add_initial_shortage_adjustment.sql`) as a cursor
over items with shortage > 30, with a nested loop over the 7-group sequence and a safety cap of
200 full cycles (1,400 steps) to prevent a true infinite loop in a pathological case - not
expected to matter in practice.

**Worked/validated example, item 96800** (DC_Qty=22): demand started at 53 (shortage 31, just
over the threshold). Step 1 (group E) was a genuine no-op - every E store's on-hand already
covered its tiny base qty (1), so cutting base 1 -> 0 changed nothing. Step 2 (group D) cut
base 2 -> 1 for all 20 D stores; after re-netting, all but one dropped to 0 (one store, with
zero on-hand, went from 2 to 1), demand fell to 42, shortage to 20 (<=30) - **stopped after just
2 of the 7 possible steps**, C/B/A3/A2/A1 untouched. The Final Shortage Adjustment then capped
the resulting 42 down to exactly 22 (=`DC_Qty`) by rank order as usual. Also validated:
0 of the 788 items still had shortage > 30 after this step ran (universal convergence, no item
hit the safety cap); an item that started at shortage <= 30 (96144) had its `BaseAllocationQty`
completely unchanged, confirming untouched items are truly left alone.

## Final Shortage Adjustment (mechanism corrected 2026-09-06)

**Correction to how this was originally described:** "no partial fill" does **not** mean a store
gets its full need or nothing. It means a store *can* receive a partial fill, as long as the
amount shipped is always a whole multiple of the item's case qty - cases can never be broken,
but that's a separate rule from "does a store get some vs none."

**Mechanics**, per item, walking stores in the same priority order as always (470 first, then
ascending `Pattern_Store_Group.Rank`): keep a running "remaining supply" counter starting at
`DC_Qty`. At each store's turn, ship as many full cases as remaining supply allows, up to that
store's own need:

```
ShipQty = FLOOR(MIN(need, remaining) / QTY_PER_CASE) * QTY_PER_CASE
```

then subtract `ShipQty` from remaining supply and move on to the **next** store - even a store
that couldn't be fully covered doesn't block lower-priority stores from getting whatever's left.
Confirmed with Wesley: this applies to **every** store (not just 470), and the waterfall keeps
walking after a partial fill rather than zeroing everyone remaining. In practice, since
`QTY_PER_CASE` is an item-level property (the same for every store of that item), there's at
most one "transition" store per item where a partial fill happens - every store after it
necessarily gets 0 too, because remaining supply drops below one case at that point. The
difference from the old (wrong) behavior is that the transition store itself gets its
case-aligned partial share instead of a hard zero.

**New columns on `AllocationResults`:**
- **`LeftoverQty`** - `DC_Qty` minus everything actually shipped for the item. `0` if fully
  consumed in whole cases; a genuine surplus if demand < `DC_Qty`; or a "stuck" sub-case
  fragment that structurally can never be shipped to anyone, when `DCQtyNotCaseMultiple = 'Y'`
  and demand was large enough to exhaust every full case.
- **`DCQtyNotCaseMultiple`** - `'Y'` if `DC_Qty` itself isn't a whole multiple of `QTY_PER_CASE`
  for that item. This is a real data-quality flag worth a look - it means some DC inventory can
  never be shipped to any store no matter how demand plays out, independent of whether a
  shortage even occurs this week.

**Validated against real data (2026-09-06):**
- **Item `3786`** (the exact example that surfaced this correction): store 470 requested 54,
  `DC_Qty` = 18, case qty = 18. Old (wrong) behavior shipped 0. Corrected behavior ships **18**
  (one full case) - matches Wesley's worked example A exactly, using real production data.
- **Item `80680`**: store 470 needed 12 (2 cases), only 6 available (case qty 6) - ships 6 (the
  transition/partial store). Every other store for this item then correctly gets 0, since
  remaining supply is exactly 0 afterward.
- **Item `98219`**: `DC_Qty` = 214, case qty = 6 (214 = 35 full cases + 4 left over). Correctly
  flagged `DCQtyNotCaseMultiple = 'Y'` with `LeftoverQty` = 4 - a genuine stuck fragment, not a
  bug.
- Across the full 960-item run: 21 items flagged `DCQtyNotCaseMultiple = 'Y'`; 54 item/store rows
  received a genuine partial (nonzero but less-than-full) fill; total units shipped rose from
  87,466 to 87,597 (+131) compared to the old all-or-nothing rule, since partial-fill cases that
  used to ship 0 now correctly ship whatever full cases fit.

Implemented in `usp_RunAllocation` (`sql/016_add_case_aligned_partial_fill.sql`). This needs
genuine sequential processing - each store's shipped amount depends on the cumulative *actual*
(case-floored) amount already shipped to every higher-priority store for that item, which can't
be expressed as a single set-based aggregate because of the non-linear `FLOOR()` applied at
every step. Uses one forward-only cursor over all items/stores at once (ordered by ItemCode,
GroupRank, StoreCode), resetting the running counter whenever ItemCode changes - a single pass,
not a cursor per item.

## Store 470 (Ecommerce) - separate weekly input, not the DCS/store-group calc

**Resolved 2026-09-01** (was open since 2026-08-27): store 470 does not go through steps 1-3
above at all. Wesley sends his SAP-curated item list to Dawn, she proposes a qty per item,
and Wesley finalizes it - lowering it only when DC supply is short (e.g. she asks 25, DC has
20, he enters 20). That final number is the only input for 470.

- **Source**: `assets/Ecommerce_Allocation_Request.xlsx` - simplified 3-column format (`Store`,
  `Item`, `Qty`, header row 1) as of 2026-09-05, cleaned up from the original weekly
  buyer-review workbook (e.g. the original was `Completed Normal Buyer Review-
  08-31-26 Dawn.xlsx`, `Review` sheet, header row 3 - see `open-questions.md` for how the
  original two-column mapping - `Item`/`Ecommerce final allocation` - was worked out, including
  why the other Ecom-looking columns on that sheet weren't usable). `Store` is expected to
  always be `470` - the import script errors out if it finds any other value, rather than
  silently accepting it, since this table has no store column of its own (always store 470
  downstream).
- **Import**: `scripts/import-ecommerce-allocation.js <file>` loads nonzero rows into
  `EcommerceAllocationRequest` (ItemCode, RequestedQty). Run it alongside
  `import-item-replenishment.js` each week, before `usp_RunAllocation`.
- **Pipeline change** (`sql/009_add_ecommerce_allocation_override.sql`, redefining
  `vw_AllocationBase`/`vw_AllocationDraft`): for `StoreCode = '470'`,
  `BaseAllocationQty` = `EcommerceAllocationRequest.RequestedQty` (0 if the item isn't in the
  request file) instead of the `Pattern_Store_Group`/allocation-table lookup. `AllocationQty`
  skips on-hand netting and case-qty rounding for 470 - Wesley's number is already final and
  case-aligned (confirmed: all 57 nonzero rows in the sample file were exact multiples of
  `CASE_QTY`). The 12 exclusion rules (`AllowSend`) **still apply** to 470 - per Netto, Wesley's
  list curation mostly filters dead/blocked items before Dawn sees them, but the rule check
  stays as a safety net. 470 keeps its rank-0 priority in the Final Shortage Adjustment, so its
  requested qty is still subject to the same case-aligned cap as every other store (see the
  corrected mechanics below - this was written before the 2026-09-06 correction).
- **Validated** against the real files (2026-09-01, under the rules in effect *at the time* -
  the old, since-corrected all-or-nothing rule): 57 items requested for 470; 44 got a nonzero
  final allocation (424 units total); 0 blocked by exclusions. Of the 13 that got zero: 11 simply
  weren't in that week's `ItemReplenishment` set (different snapshot dates between the two
  source files - expected); 2 (items 97352, 97360) were the exact "requested qty > sample-file
  DC Supply" anomaly flagged in `open-questions.md` when the sample was first inspected -
  confirmed at the time as **not a bug**: that week's real `ItemReplenishment.DC_Qty` for both
  was 4, requested qty was 6. Under today's corrected Final Shortage Adjustment, a case
  matching those quantities could now ship a case-aligned partial amount instead of a hard
  zero - see the dedicated section below. This suggests the "DC Supply" column in the buyer-
  review workbook can be a stale snapshot relative to the current week's real DC quantity -
  worth confirming with Wesley if it becomes a recurring pattern, but not blocking.

## Implementation note: views vs. tables

Steps 1-6 are still pure views (`vw_AllocationBase`, `vw_AllocationDraft`) - cheap to query,
recompute automatically as source data changes. Step 7 (the Final Shortage Adjustment) needs a
running total ordered by priority, which requires either a windowed `SUM() OVER (ORDER BY ...)`
(not available - SQL Server 2008 R2, that's a 2012+ feature) or genuinely sequential processing
(each store's shipped amount depends on the cumulative *actual*, case-floored amount already
shipped to every higher-priority store - not expressible as a single set-based aggregate). So
both shortage-adjustment stages are implemented in a stored procedure, `usp_RunAllocation`,
which:
1. Materializes `vw_AllocationDraft` into a real table, `AllocationDraft` (clustered index on
   ItemCode+StoreCode - makes the per-item correlated subquery in stage 2 cheap).
2. Runs the Initial Shortage Adjustment (a cursor over items with shortage > 30, see above),
   mutating `AllocationDraft.BaseAllocationQty`/`AllocationQty` in place where needed.
3. Runs the Final Shortage Adjustment: builds a working table (`#Plan`) of every eligible
   item/store row with its priority rank, then walks it with a single forward-only cursor
   (ordered by ItemCode, GroupRank, StoreCode), resetting a running "remaining supply" counter
   whenever ItemCode changes - one pass over ~138k rows, not a cursor per item. Writes results
   to `AllocationResults`, including the new `LeftoverQty`/`DCQtyNotCaseMultiple` columns.

Run it with `EXEC usp_RunAllocation` after importing a new weekly item list, or whenever
exclusion rules / reference tables change. Takes roughly 40s over 960 items x 144 stores as of
2026-09-06 (both the Initial Shortage Adjustment cursor and the Final Shortage Adjustment's
single-pass cursor included - the latter turned out cheap since it's one flat pass rather than
a cursor per item).
`AllocationResults.FinalAllocationQty` is the actual "what to ship" number; `AllocationQty` on
that same table is the pre-cap desired amount (kept for visibility/debugging) - post-Initial-
Shortage-Adjustment where that ran, i.e. it may already be lower than the "natural" unadjusted
need for an item that had a large shortage.

## On-hand and in-transit qty (resolved 2026-09-05 - previously a placeholder)

Both are now a combined manual weekly input from Wesley: `assets/Stores_Qtys_and_MinMax.xlsx`
(`Store_Code`/`Item_number`/`On-Hand_qty`/`In-Transit_qty`/`Min_qty`/`Max_qty`, keyed on the
business Store Code - same numbering as `Pattern_Store_Group`/`ItemReplenishment`). Imported via
`scripts/import-store-inventory.js` (bulk insert - the file is ~114k rows, too many for the
row-by-row pattern the other two import scripts use) into `StoreItemInventory`. This retires
`EBT.dbo.INV_SBS_QTY_V_EXT` as the on-hand source (confirmed not workable by Wesley 2026-09-03)
and the hardcoded `InTransitQty = 0`. `Min_qty`/`Max_qty` are imported but not used by the
allocation calc today - kept for reference/future use. Wesley will still grant access to a real
SAP ASN-backed in-transit table later; swap this manual input for that once it exists.

**Netting rule, including a fix found while testing:** `NetNeed = BaseAllocationQty -
(OnHandQty + InTransitQty)`, but `OnHandQty + InTransitQty` is **floored at 0 before netting** -
found this matters because on-hand values are sometimes negative in practice (a real data quirk,
436 of 114,260 rows in the 2026-09-05 export), which without the floor made `NetNeed` come out
*larger* than intended (e.g. Base 8 - OnHand -1 = 9) instead of treating negative on-hand as "no
usable stock." `NetNeed` itself is still separately floored at 0 as before. Implemented in
`sql/010_floor_onhand_plus_intransit.sql`, carried forward in `sql/011_add_store_item_inventory_table.sql`.
Store 470 (Ecommerce) is unaffected either way - it already skips on-hand/in-transit netting
entirely (see below).
