# Data sources

## Connection

Credentials live in `.env` (gitignored) and are loaded via `db.js` (`getPool()`). Server is
SQL Server 2008 R2 - **no `TRY_CAST`, no modern T-SQL functions**. `requestTimeout` is set to
120s in `db.js` because some joins against `EBT` views are slow (see gotchas below).

We have `db_datareader`-level access (at least) to `EBT`, `EBTGOOGLE`, and full control of
`EBTAI`. No access to `EBTIMP`, `EBTLEASE`, `EBTPASS`, `PIMS`, or the helpspot databases.

## Objects we own, in `EBTAI`

All DDL lives in `sql/`, applied in numeric order via `node scripts/run-sql.js sql/00X_*.sql`.

| Object | Type | Purpose |
|---|---|---|
| `DCS_Pattern` | table | DCS Code -> DCS Pattern (47 rows, loaded from Wesley's mock file) |
| `Pattern_Store_Group` | table | (DCS Pattern, Store Code) -> Store Group (1,529 rows) |
| `Item_Code_allocation_table` | table | (Item Code, Store Group) -> base allocation qty, item-specific override (4,018 rows) |
| `DPS_Code_allocation_table` | table | (DPS Code, Store Group) -> base allocation qty, the general case (14,623 rows) |
| `ItemReplenishment` | table | **Weekly input.** (ItemCode, DC_Qty) - the subset of items Wesley curates from SAP this week, and how much the DC has available. Populated by `scripts/import-item-replenishment.js`. |
| `EcommerceAllocationRequest` | table | **Weekly input, store 470 only.** (ItemCode, RequestedQty) - Wesley's finalized per-item qty for store 470 (Ecommerce), after Dawn's ask and Wesley's DC-availability adjustment. Populated by `scripts/import-ecommerce-allocation.js` from the "Review" sheet (columns `Item`/`Ecommerce final allocation`) of Wesley's buyer-review workbook, e.g. `assets/Completed Normal Buyer Review- 08-31-26 Dawn.xlsx`. See `business-rules.md` for how this feeds store 470's allocation. |
| `ItemInformation` | view | Item attributes needed downstream, straight from `EBT.dbo.Inventory_V_AUX`: DCS_CODE, ITEM_NO, DESCRIPTION1, LNCHCODE, IStatus, PRICE1/2, QTY_PER_CASE, MDQ, EBT_STR, EBTMKD, PROP65FAIL, ONLINE_STR, SIZ. This view **pre-existed** our work (built by someone else before we started). |
| `ItemInformationComplete` | view | Builds on `ItemInformation`, adds the computed **DPS Code** (`DCS_CODE + '/' + PriceBucket + '/' + SizeBucket`) using hardcoded price-bucket and clothing-size-normalization logic. Also pre-existed. |
| `ExclusionRules` | table | Metadata for the 12 exclusion rules - name, description, `IsActive` toggle. |
| `vw_ExclusionEvaluation` | view | Per (item in `ItemReplenishment`) x (active real store), evaluates all 12 rules as Y/N columns. |
| `vw_ItemStoreAllowSend` | view | Adds `AllowSend` roll-up (Y only if all 12 rules pass) on top of `vw_ExclusionEvaluation`. |
| `vw_AllocationBase` | view | Per item x store: DCS Pattern, Store Group, and `BaseAllocationQty` (Item-specific override falling back to DPS-code level). |
| `vw_AllocationDraft` | view | Full draft: base qty, `AllowSend`, on-hand qty, in-transit qty (placeholder), and pre-cap `AllocationQty` after exclusions + case-qty rounding. Does not cap to DC_Qty - that's the next stage. |
| `AllocationDraft` | table | Materialized snapshot of `vw_AllocationDraft`, written by `usp_RunAllocation`. Exists purely for performance (see `business-rules.md` implementation note). |
| `AllocationResults` | table | **Final output.** Same columns as `AllocationDraft` plus `GroupRank`, `RunningTotal`, and `FinalAllocationQty` (the real "what to ship" number, after the DC-qty waterfall cap). Written by `usp_RunAllocation`. |
| `usp_RunAllocation` | procedure | Runs the full pipeline: materializes `vw_AllocationDraft` into `AllocationDraft`, then computes the store-group-priority waterfall cap into `AllocationResults`. Call after importing a new weekly item list (or the Ecommerce request) or after any reference-data/rule change. ~1 minute over 788 items x 144 stores. |

## Key tables in `EBT` we depend on

| Table/view | Type | What we use it for |
|---|---|---|
| `[Store Directory]` | table | Store master. `[Code #]` = business store code (matches `Pattern_Store_Group`, `ItemReplenishment` context). `[ID #]` = **internal store number** used by inventory tables (`INV_SBS_QTY_V_EXT.STORE_NO`, `DC_QTY.STORE_NO`, etc) - **these are two different numbering systems, don't join them to each other.** Also has `WStoreType` (Fashion Focus/Standard - empty means the store is closed, per Netto), `WStoreSize`, `STATE`, `[OPEN]` (open date), `[E-ACTIVE]`, `TempClosed`. Store `000` / ID `0` is the Dallas DC itself, not a ship-to store - excluded from our store universe. |
| `Inventory_V_AUX` | view | Source for `ItemInformation`. **Avoid joining this directly for ad-hoc lookups** - a join against it for just 788 items took ~12s; the equivalent join against `INVENTORY` (base table) took <50ms for the same data. |
| `INVENTORY` | table | Item master base table. Has `ITEM_NO`, `VEND_CODE`, `DCS_CODE`, etc. Prefer this over `Inventory_V_AUX` for anything not already covered by `ItemInformationComplete`. |
| `INV_SBS_QTY_V_EXT` | view | On-hand qty by item/store (`QTY`), plus `MIN_QTY`/`MAX_QTY`/`TRANSFER_IN_QTY`/`TRANSFER_OUT_QTY`. **RESOLVED 2026-09-03 (not usable):** Wesley confirmed this is not workable as the on-hand source right now. On-hand qty is moving to a manual weekly input from Wesley instead (see `business-rules.md` "Known placeholders" and `open-questions.md`) - format/table TBD once he sends a sample file. Store 470 (Ecommerce) has 2 rows per item here (one live-qty row, one min/max-planning row with qty 0) - noted here in case this view is ever revisited. |
| `DC_QTY` | view | Item-level DC available qty (`STORE_NO` is always 0 here - it's not store-specific). We're using `ItemReplenishment.DC_Qty` (from Wesley's weekly file) instead, which is more current. |
| `MONTHLY_INV_INTRANSIT_TEMP` | table | The only "in-transit" table we found by searching - **stale, last data from July 2023.** Not usable. Real in-transit source is ASN vouchers from SAP, replicated to SQL Server - Netto is locating the actual table. |
| `StoreInvFinal` | view | Looked promising (on-hand, MIN_QTY/MAX_QTY, DCQTY) but only covered 730 of ~114k possible item x store rows for our item set - looks like a legacy/narrower system, not used. |
| `WebordernewXLS` | view | A pre-existing pivoted "weborder" report (columns per store name). **Currently broken** - references a dead linked-server OLE DB provider. Not usable, possibly a legacy predecessor. |
| `WebOrder_reviewed` | table | Logs (store, item, order qty, status, date) - possibly historical record of finalized orders. Not yet explored in depth. |

## Performance notes

- SQL Server 2008 R2 has no `TRY_CAST` - use `CAST` directly (our item codes are always numeric
  strings, so this is safe) or `ISNUMERIC` guards if that ever changes.
- Correlated scalar subqueries per output row are slow at ~114k-row scale (12 of them added 11+
  seconds to `vw_ExclusionEvaluation`). Pre-aggregate into a single cross-joined row instead
  (see the `ra` derived table in `vw_ExclusionEvaluation`).
- `MAX()` doesn't work directly on a `bit` column pre-2012 - cast to `int` first.
