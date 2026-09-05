# Business rules

## Exclusion rules (12 rules, `ExclusionRules` + `vw_ExclusionEvaluation`)

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

`AllowSend` (in `vw_ItemStoreAllowSend`) = Y only if all 12 rules return Y.

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
7. **DC-qty cap, waterfall by store group priority** (per Netto, 2026-08-27): if summed
   allocation across stores for an item exceeds `DC_Qty`, fill stores in priority order
   **470 (Ecommerce, rank 0) first, then A1, A2, A3, B, C, D, E** (rank 1-7; any store with no
   `Pattern_Store_Group` entry for that pattern ranks last, 99 - see `open-questions.md`).
   470 is filled by a separate person who sends her own counts, which take priority over every
   other store regardless of store group. Within a group, ties are broken by StoreCode
   ascending (assumption, not confirmed).
   Walk stores in that order keeping a running
   total of case-qty-rounded allocation; a store gets its full allocation only if the running
   total (including that store) is still <= `DC_Qty`. The moment a store can't be fully
   covered, that store AND every lower-priority store after it gets 0 - no partial fill, no
   skipping ahead. Validated: in the 788-item test set, 390 items needed capping, and after
   capping 0 items exceed their `DC_Qty` (average DC-supply utilization among capped items:
   ~78% - the remainder is always less than one more store's full case-rounded need).

## Store 470 (Ecommerce) - separate weekly input, not the DCS/store-group calc

**Resolved 2026-09-01** (was open since 2026-08-27): store 470 does not go through steps 1-3
above at all. Wesley sends his SAP-curated item list to Dawn, she proposes a qty per item,
and Wesley finalizes it - lowering it only when DC supply is short (e.g. she asks 25, DC has
20, he enters 20). That final number is the only input for 470.

- **Source**: weekly buyer-review workbook (e.g. `assets/Completed Normal Buyer Review-
  08-31-26 Dawn.xlsx`), `Review` sheet, header row 3. Only two columns matter: `Item` (item
  code) and `Ecommerce final allocation` (qty to ship). Other Ecom-looking columns on that
  sheet (`Ecommerce Min`/`Max`/`suggested`, `Blocked for Ecom?`) are present but **not** used -
  `Ecommerce suggested` was 0 on every sampled row, including ones with a nonzero final
  allocation, so it isn't a usable substitute for Wesley's actual number.
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
  stays as a safety net. 470 keeps its rank-0 priority in the waterfall (step 7), so its
  requested qty is still subject to the same all-or-nothing DC-qty cap as every other store.
- **Validated** against the real files (2026-09-01): 57 items requested for 470; 44 got a
  nonzero final allocation (424 units total); 0 blocked by exclusions. Of the 13 that got zero:
  11 simply weren't in that week's `ItemReplenishment` set (different snapshot dates between
  the two source files - expected); 2 (items 97352, 97360) were the exact "requested qty >
  sample-file DC Supply" anomaly flagged in `open-questions.md` when the sample was first
  inspected - confirmed here as **not a bug**: this week's real `ItemReplenishment.DC_Qty` for
  both is 4, requested qty was 6, so the existing waterfall cap (rank 0, no partial fill)
  correctly zeroes 470 out for those two rather than over-shipping. This suggests the
  "DC Supply" column in the buyer-review workbook can be a stale snapshot relative to the
  current week's real DC quantity - worth confirming with Wesley if it becomes a recurring
  pattern, but not blocking.

## Implementation note: views vs. tables

Steps 1-6 are still pure views (`vw_AllocationBase`, `vw_AllocationDraft`) - cheap to query,
recompute automatically as source data changes. Step 7 (the waterfall) needs a running total
ordered by priority, which requires either a windowed `SUM() OVER (ORDER BY ...)` (not
available - SQL Server 2008 R2, that's a 2012+ feature) or a correlated subquery per row. A
correlated subquery against the *view* stack was fine for one item but timed out as a full
788-item batch (SQL Server 2008 R2's optimizer doesn't push the per-item filter down through
several stacked views efficiently). So the waterfall is implemented as a stored procedure,
`usp_RunAllocation`, which:
1. Materializes `vw_AllocationDraft` into a real table, `AllocationDraft` (clustered index on
   ItemCode+StoreCode - makes the per-item correlated subquery cheap).
2. Computes the waterfall against that table, writing final results to `AllocationResults`.

Run it with `EXEC usp_RunAllocation` after importing a new weekly item list, or whenever
exclusion rules / reference tables change. Takes about a minute over 788 items x 144 stores.
`AllocationResults.FinalAllocationQty` is the actual "what to ship" number; `AllocationQty` on
that same table is the pre-cap desired amount (kept for visibility/debugging).

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
