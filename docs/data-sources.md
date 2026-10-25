# Data sources

## Connection

Credentials live in `.env` (gitignored) and are loaded via `db.js` (`getPool()`). Server is
SQL Server 2008 R2 - **no `TRY_CAST`, no modern T-SQL functions**. `requestTimeout` is set to
120s in `db.js` because some joins against `EBT` views are slow (see gotchas below).

We have `db_datareader`-level access (at least) to `EBT`, `EBTGOOGLE`, and full control of
`EBTAI`. No access to `EBTIMP`, `EBTLEASE`, `EBTPASS`, `PIMS`, or the helpspot databases.

### SAP HANA + the sales/inventory project's sources (added 2026-10-20, per Wesley)

Wesley asked for this project to have the same data access as `../Sales_Inventory_analysis`.
SQL Server was already identical (same server, database and login in both `.env` files), so
everything it reads in `EBT` is readable here too. What was missing was **SAP HANA**:

- `.env` now also holds `HANA_HOST`, `HANA_PORT`, `HANA_DATABASE`, `HANA_USERNAME`,
  `HANA_PASSWORD`, `HANA_SCHEMA` (copied from the sibling project's `.env`; default schema
  `REPORTUSER`). Driver: `hdb` (npm).
- `hana.js` - `getHana()`, `hanaQuery(sql, params)`, `closeHana()` (copied from the sibling).
- `item-info.js` - `loadItemInfo()`: live SAP item master (`REPORTUSER.SAP_Item_Information`) in
  the old manual-export column names/format. Available here but **not wired into the pipeline**;
  weborder-ai still reads item info from `assets/Item_Information_Complete_for_Replenishment`.
- `scripts/hana-query.js <file.sql> [--csv out.csv]` - HANA counterpart of `scripts/query.js`.
- `scripts/list-hana-objects.js [SCHEMA]` - lists a schema's tables/views/columns to
  `Claude_results/`.

Verified 2026-10-20 from this repo: `REPORTUSER` (e.g. `SAP_BP_MASTER_DATA`) and `EARTHBOUND`
(e.g. `OITW`) both readable; `EBT` `salesfact`, `INVN_SBS_QTY_V`, `[Store Directory]`,
`Monthly_inv`, `INVOICE` all readable.

**The full catalogue with gotchas lives in `../Sales_Inventory_analysis/docs/data-sources.md`** -
read it before using any of these (not duplicated here). Main objects: `EBT.dbo.salesfact`
(sales), `INVN_SBS_QTY_V` (live store on-hand/min/max), `[Store Directory]`, `Monthly_inv`
(monthly on-hand history), `INVOICE`/`INV_ITEM` (POS receipts); HANA `REPORTUSER.SAP_Item_Information`
(live item master), `ORDERS_DETAILED_SUM_W_CM` (POs - rows repeat, don't sum blindly),
`SAP_BP_MASTER_DATA` (vendors), `DCSCODE_INFO`; `EARTHBOUND.OCRD."U_V33_BP_LEADTIME"` (vendor lead time in days, filled for only ~132 vendors - 2026-10-25); `EARTHBOUND.OITW` (live DC on-hand, `WhsCode='HDQ'`),
`OINM` (inventory ledger, history from 2022-02-10), `ORDR`/`RDR1`/`ODLN`/`DLN1` (sales orders and
deliveries). HANA mixed-case column names must be double-quoted exactly (`"OnHand"`, `"WhsCode"`).

## Objects we own, in `EBTAI`

All DDL lives in `sql/`, applied in numeric order via `node scripts/run-sql.js sql/00X_*.sql`.

| Object | Type | Purpose |
|---|---|---|
| `DCS_Pattern` | table | DCS Code -> DCS Pattern (47 rows, loaded from Wesley's mock file). Update cadence: eventually/never - see "Update cadence & ownership" below. |
| `Pattern_Store_Group` | table | (DCS Pattern, Store Code) -> Store Group, plus `Rank` (1,529 rows = 11 patterns x 139 stores). `Rank` added 2026-09-05 - Wesley's explicit per-(Pattern, Store) priority (1-139, unique per pattern) for the DC-qty waterfall cut order (see `business-rules.md`); fully replaces Store Group for that purpose, though Store Group is still used for the base allocation qty lookup. Unique index on (`DCS pattern`, `Store code`). Refreshes every 6-8 weeks via `scripts/import-pattern-store-group.js` (truncate/reload, same pattern as the weekly inputs). |
| `Item_Code_allocation_table` | table | (Item Code, Store Group) -> base allocation qty, item-specific override. **Weekly input as of 2026-09-05** (was a one-time load from Wesley's original mock file before this). Source: `assets/Item_Code_allocation_table.xlsx` - "wide" layout (one row per Item Code, one column per store group: A1/A2/A3/B/C/D/E), unpivoted into this long shape by `scripts/import-allocation-table.js item <file>`. |
| `DPS_Code_allocation_table` | table | (DPS Code, Store Group) -> base allocation qty, the general case. **Weekly input as of 2026-09-05** (was a one-time load before this). Source: `assets/DPS_Code_allocation_table.xlsx`, same wide layout, unpivoted by `scripts/import-allocation-table.js dps <file>`. |
| `ItemReplenishment` | table | **Weekly input.** (ItemCode, DC_Qty) - the subset of items Wesley curates from SAP this week, and how much the DC has available. Populated by `scripts/import-item-replenishment.js` from `assets/Items_for_Replenishment.xlsx` (renamed 2026-09-05, twice: first from `Inventory in Warehouse.xlsx` to `ItemReplenishment.xlsx`, then to this - also stripped a leading title row and blank column A. Same "Items" sheet/`Item #`/`DC Supply` columns throughout, no functional format change - the import script finds the header by cell value, not fixed position). |
| `EcommerceAllocationRequest` | table | **Weekly input, store 470 only.** (ItemCode, RequestedQty) - Wesley's finalized per-item qty for store 470 (Ecommerce), after Dawn's ask and Wesley's DC-availability adjustment. Populated by `scripts/import-ecommerce-allocation.js` from `assets/Ecommerce_Allocation_Request.xlsx` (`Store`/`Item`/`Qty`, header row 1 - simplified 2026-09-05 from Wesley's original full buyer-review workbook, see `business-rules.md`). See `business-rules.md` for how this feeds store 470's allocation. |
| `StoreItemInventory` | table | **Weekly input.** (ItemCode, StoreCode, OnHandQty, InTransitQty, MinQty, MaxQty) - resolves 2026-09-05, replaces `INV_SBS_QTY_V_EXT` (on-hand) and the hardcoded-0 in-transit placeholder. Keyed on the business Store Code. Populated by `scripts/import-store-inventory.js` (bulk insert - ~114k rows) from `assets/Stores_Qtys_and_MinMax.xlsx`. `OnHandQty`/`InTransitQty` feed `vw_AllocationDraft`'s netting (see `business-rules.md` for the floor-at-0 rule); `MinQty`/`MaxQty` feed the Exc13 "Blocking RP 999" exclusion rule (added 2026-09-05, see `business-rules.md`) - Min=Max=999 is how Retail Pro marks an item blocked from a store. |
| `ItemInformation` | view | Item attributes needed downstream, straight from `EBT.dbo.Inventory_V_AUX`: DCS_CODE, ITEM_NO, DESCRIPTION1, LNCHCODE, IStatus, PRICE1/2, QTY_PER_CASE, MDQ, EBT_STR, EBTMKD, PROP65FAIL, ONLINE_STR, SIZ. This view **pre-existed** our work (built by someone else before we started). |
| `Item_Information_Complete_for_Replenishment` | table | **Item attributes incl. DPS Code - the only item-info source as of 2026-10-11 (per Wesley).** One row per replenishment item: DCS, description, launch code, IStatus, sale price, case qty, MDQ, EBT/Online store flags, EBT mark-down, Prop 65, DPS Code. Weekly input from `assets/Item_Information_Complete_for_Replenishment.xlsx`, loaded by `scripts/import-item-information.js` (truncate/reload; normalizes Y/N -> Yes/No, mark-down Y -> Yes_MD else No_MK, blank Prop 65 -> NULL so exclusion rules are unchanged; warns if a replenishment item is missing or its DPS code has no base-qty row). `vw_AllocationBase` and `vw_ExclusionEvaluation` join to it (sql/017). Load it any time before running the allocation, normally with the other Tier D files. |
| ~~`ItemInformationComplete`~~ | view | **No longer used by the pipeline (2026-10-11).** Old EBT-derived view; its size normalization left combined sizes like `S/M`/`L/XL` unmapped, giving DPS codes with no allocation row (items 81351/81352 got base qty 0 on 10-11). Left in place, unreferenced. Still read from EBT: `INVENTORY` (vendor code, Exc12) and `Store Directory`. |
| `ExclusionRules` | table | Metadata for the 14 exclusion rules - name, description, `IsActive` toggle. |
| `Temporary_Blocking` | table | (Store, Item, Status) - feeds the Exc14 "Temporary Blocking" exclusion rule (added 2026-09-05/06, see `business-rules.md`): while an item is being tested at selected locations only, every other store gets a `Status='Block'` row here. Business Store Code + plain item code. Refreshes weekly via `scripts/import-temporary-blocking.js` (truncate/reload), any day Monday-Friday - see "Update cadence & ownership" below. |
| `vw_ExclusionEvaluation` | view | Per (item in `ItemReplenishment`) x (active real store), evaluates all 12 rules as Y/N columns. |
| `vw_ItemStoreAllowSend` | view | Adds `AllowSend` roll-up (Y only if all 12 rules pass) on top of `vw_ExclusionEvaluation`. |
| `vw_AllocationBase` | view | Per item x store: DCS Pattern, Store Group, and `BaseAllocationQty` (Item-specific override falling back to DPS-code level). |
| `vw_AllocationDraft` | view | Full draft: base qty, `AllowSend`, on-hand qty, in-transit qty (placeholder), and pre-cap `AllocationQty` after exclusions + case-qty rounding. Does not cap to DC_Qty - that's the next stage. |
| `AllocationDraft` | table | Materialized snapshot of `vw_AllocationDraft`, written by `usp_RunAllocation`. Exists purely for performance (see `business-rules.md` implementation note). |
| `AllocationResults` | table | **Final output.** Same columns as `AllocationDraft` plus `GroupRank`, `RunningTotal`, `FinalAllocationQty` (the real "what to ship" number, after the Final Shortage Adjustment - see `business-rules.md`), and (added 2026-09-06) `LeftoverQty`/`DCQtyNotCaseMultiple` (per-item leftover DC supply and a flag for items where `DC_Qty` isn't a whole case multiple). Written by `usp_RunAllocation`. |
| `usp_RunAllocation` | procedure | Runs the full pipeline: materializes `vw_AllocationDraft` into `AllocationDraft`, runs the Initial Shortage Adjustment (for items with shortage > 30 pcs), then the Final Shortage Adjustment (case-aligned partial-fill waterfall by `Pattern_Store_Group.Rank`) into `AllocationResults`. Call after importing a new weekly item list (or any other input) or after any reference-data/rule change. ~40s over 960 items x 144 stores as of 2026-09-06. |

## Update cadence & ownership (per Wesley, 2026-09-09)

When each `assets/` source file gets updated, why, and (for the weekend files) in what order.
Four tiers, from rarest to most frequent:

**A) Update eventually or never**

| File / table | Update when |
|---|---|
| `DCS_Pattern` (DCS Code -> DCS Pattern link, feeds `Pattern_Store_Group`) | Only if a new DCS Code or a new DCS Pattern is introduced. |

**B) Update every ~8 weeks**

| File / table | Update when |
|---|---|
| `Pattern_Store_Group` (group + rank per store, per DCS Pattern) | Once per launch/season period - e.g. Spring Break, Summer 1, Back-to-School, Holidays. |

**C) Update weekly, any day Monday-Friday**

| File / table | What it is | Update when |
|---|---|---|
| `Item_Code_allocation_table` | Best sellers, store-specific items, and recently-distributed items, with specific (usually higher-than-`DPS_Code_allocation_table`) group allocation qtys. | As best sellers are identified, as more store-specific items come up, as new items get distributed, or as a distributed item rolls back to normal DPS-level qty. |
| `DPS_Code_allocation_table` | The general-case group allocation qty for every DCS/Price/Size (DPS) code. | As adjustments are found necessary for any DPS code (qty per group increased or decreased). |
| `Temporary_Blocking` | Store/item combos temporarily held back from allocation (e.g. an item being tested at selected locations only - every other store gets blocked). | As new store/item combos need to be added, or dropped once a test concludes. |

**D) Update weekly, in this order: Friday after 4pm, Saturday, or Sunday**

The DC's weekly SAP shipment cutoff is **Friday 4pm** - these three files depend on that
cutoff and on each other, so they're built in this sequence:

1. **`Items_for_Replenishment`** - items available in the DC and their qty, built once the DC
   team has received all weekly shipments into SAP (right after the Friday 4pm cutoff).
2. **`Ecommerce_Allocation_Request`** - what Ecommerce (Dawn) needs more of from DC stock,
   returned Friday night, Saturday, or Sunday.
3. **`Stores_Qtys_and_MinMax`** - DC item qty plus each store's on-hand/in-transit/min/max.
   **Built last**, only once the other files are ready - it's the final input before running
   the replenishment process (`EXEC usp_RunAllocation`).

## Weekly output (deliverables)

Run these after `usp_RunAllocation` to produce the actual weekly deliverables (2026-09-06, per
Wesley - see `business-rules.md` for the exact column definitions). All three default to writing
into **`Claude_results/`** (created if it doesn't exist), with Wesley's date-prefixed naming
convention (2026-09-19): `<MM-DD-YY>-<Name>.csv`, using today's date.

| Script | Default output | Shape |
|---|---|---|
| `scripts/export-final-allocation-results.js [file.csv]` | `Claude_results/<date>-Final_Allocation_Results.csv` | Long format, nonzero shipments only: `StoreCode`, `ItemCode`, `Qty` (= `FinalAllocationQty`). |
| `scripts/export-dc-qty-less-than-case-qty.js [file.csv]` | `Claude_results/<date>-DC_Qty_Less_than_Case_Qty.csv` | Long format, one row per item where `0 < LeftoverQty < QTY_PER_CASE` only (a genuine stuck fragment - `LeftoverQty = 0` not flagged): `ItemCode`, `DCLeftOverQty` (= `LeftoverQty`), `DCQtyLessThanCaseQty` (always `'Y'` for listed rows). Replaces the earlier, broader `DC_ItemsCheck_NotCaseMultiple.csv` (2026-09-06). |
| `scripts/compare-with-manual.js <claude.csv> <wesley.csv> [out.csv]` | `Claude_results/<date>-Discrepancies_Check.csv` | Compares a Final_Allocation_Results-shaped file against Wesley's manual weborder output key-by-key (`StoreCode`+`ItemCode`): `StoreCode`, `ItemCode`, `ClaudeQty`, `WesQty`, `Difference`, `DiscrepancyType` (`Only in Claude` / `Only in Wes` / `Qty mismatch`). Formalized 2026-09-19 from a one-off comparison script used since the first Claude-vs-Wesley comparison (2026-09-10) - see `progress-log.md`. |
| `scripts/qty-needed.js [input.xlsx] [--today YYYY-MM-DD]` | `<Desktop>/<MM-DD-YY>-Qty_Needed.xlsx` | Reorder qty between Period ETA and LTD per item (input `<Desktop>/Qty_Needed_Input.xlsx`: Item, 1% Average, Company Qty, Open Stores). Sheets `Qty Needed` (one row per item) and `Projection` (week by week). Not part of the allocation run - see `business-rules.md` "ETA / LTD" and "Weekly qty projection". Added 2026-10-25. |

`Claude_results/` is gitignored in full (regenerated/delivered output, not source data) - same
treatment the three files already had individually before the folder existed. There's also a
broader diagnostic export, `scripts/export-allocation-results.js` (adds item description, DCS
code, `DC_Qty`; supports `--all` to include zero-qty rows) - useful for debugging, not one of the
three deliverables above.

## Key tables in `EBT` we depend on

| Table/view | Type | What we use it for |
|---|---|---|
| `[Store Directory]` | table | Fully qualified `EBT.dbo.[Store Directory]` - confirmed as the store-directory source by Wesley 2026-09-21. Store master. `[Code #]` = business store code (matches `Pattern_Store_Group`, `ItemReplenishment` context). `[ID #]` = **internal store number** used by inventory tables (`INV_SBS_QTY_V_EXT.STORE_NO`, `DC_QTY.STORE_NO`, etc) - **these are two different numbering systems, don't join them to each other.** Also has `WStoreType` (Fashion Focus/Standard - empty means the store is closed, per Netto), `WStoreSize`, `STATE`, `[OPEN]` (open date), `[E-ACTIVE]`, `TempClosed`. Store `000` / ID `0` is the Dallas DC itself, not a ship-to store - excluded from our store universe. |
| `INVENTORY_V` | view | **Item master - use this for inventory data, per Wesley 2026-09-21.** Columns include `ITEM_NO`, `VEND_CODE`, `DCS_CODE`, `DESCRIPTION1-4`, `ACTIVE`, `QTY_PER_CASE`, `FST_PRICE`/`MARKDOWN_PRICE`, cost fields, received/sold/discontinued dates, etc. No store-level qty columns (`SBS_NO` present but constant `1` in sampled rows) - this is item-attribute data, not on-hand/in-transit (that's still the manual `StoreItemInventory` weekly input, see below). Not yet wired into `ItemInformation`/`ItemInformationComplete` - those views still read from `Inventory_V_AUX`/`INVENTORY` below; flagged as a follow-up to confirm with Wesley whether those views should be repointed. |
| `Inventory_V_AUX` | view | Source for `ItemInformation` (**still current as of this writing** - see `INVENTORY_V` note above for a possible future replacement). **Avoid joining this directly for ad-hoc lookups** - a join against it for just 788 items took ~12s; the equivalent join against `INVENTORY` (base table) took <50ms for the same data. |
| `INVENTORY` | table | Item master base table. Has `ITEM_NO`, `VEND_CODE`, `DCS_CODE`, etc. Prefer this over `Inventory_V_AUX` for anything not already covered by `ItemInformationComplete`. |
| `INV_SBS_QTY_V_EXT` | view | On-hand qty by item/store (`QTY`), plus `MIN_QTY`/`MAX_QTY`/`TRANSFER_IN_QTY`/`TRANSFER_OUT_QTY`. **RETIRED 2026-09-05** - Wesley confirmed 2026-09-03 this is not workable as the on-hand source, and testing (2026-09-05) also caught it returning volatile/negative values live between two queries minutes apart. Fully replaced by the `StoreItemInventory` manual weekly input above - no longer referenced by `vw_AllocationDraft`. Left here for historical context; store 470 (Ecommerce) had 2 rows per item here (one live-qty row, one min/max-planning row with qty 0), in case this view is ever revisited. |
| `DC_QTY` | view | Item-level DC available qty (`STORE_NO` is always 0 here - it's not store-specific). We're using `ItemReplenishment.DC_Qty` (from Wesley's weekly file) instead, which is more current. |
| `MONTHLY_INV_INTRANSIT_TEMP` | table | The only "in-transit" table we found by searching - **stale, last data from July 2023.** Not usable. Real in-transit source is ASN vouchers from SAP, replicated to SQL Server - Netto is locating the actual table. |
| `StoreInvFinal` | view | Looked promising (on-hand, MIN_QTY/MAX_QTY, DCQTY) but only covered 730 of ~114k possible item x store rows for our item set - looks like a legacy/narrower system, not used. |
| `WebordernewXLS` | view | A pre-existing pivoted "weborder" report (columns per store name). **Currently broken** - references a dead linked-server OLE DB provider. Not usable, possibly a legacy predecessor. |
| `WebOrder_reviewed` | table | Logs (store, item, order qty, status, date) - possibly historical record of finalized orders. Not yet explored in depth. |
| `salesfact` | table | Historical sales fact table - `STORE_NO`, `ITEM_NO`, `DATE`, `WEEK`/`MONTH`/`YEAR`, `SOLD_QTY`, `EXT_PRICE`, `EXT_COST`, `EXT_LCO`, `LCO_PROBLEMS`. Confirmed 2026-09-21 as containing all sales history (per Wesley), going back to at least 2004. `STORE_NO` here is the **internal store number** (see `[Store Directory]` note above), not the business Store Code. Not yet used by the pipeline - potential future source for demand-based allocation logic, not wired into any view/table yet. |

## Performance notes

- SQL Server 2008 R2 has no `TRY_CAST` - use `CAST` directly (our item codes are always numeric
  strings, so this is safe) or `ISNUMERIC` guards if that ever changes.
- Correlated scalar subqueries per output row are slow at ~114k-row scale (12 of them added 11+
  seconds to `vw_ExclusionEvaluation`). Pre-aggregate into a single cross-joined row instead
  (see the `ra` derived table in `vw_ExclusionEvaluation`).
- `MAX()` doesn't work directly on a `bit` column pre-2012 - cast to `int` first.
