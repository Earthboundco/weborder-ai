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
   **Caveat: store 470 has zero rows in `Pattern_Store_Group` for every pattern, so its
   `BaseAllocationQty` is always 0 under the current calculation - the rank-0 priority is
   implemented and confirmed correct, but has nothing to act on yet. See `open-questions.md`.** Walk stores in that order keeping a running
   total of case-qty-rounded allocation; a store gets its full allocation only if the running
   total (including that store) is still <= `DC_Qty`. The moment a store can't be fully
   covered, that store AND every lower-priority store after it gets 0 - no partial fill, no
   skipping ahead. Validated: in the 788-item test set, 390 items needed capping, and after
   capping 0 items exceed their `DC_Qty` (average DC-supply utilization among capped items:
   ~78% - the remainder is always less than one more store's full case-rounded need).

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

## Known placeholders (not final)

- **In-transit qty is hardcoded to 0** in `vw_AllocationDraft`. Real source is SAP ASN vouchers,
  replicated into SQL Server - Netto is locating the actual table/column names.
- **On-hand qty source (`INV_SBS_QTY_V_EXT.QTY`) has not been confirmed as authoritative.**
