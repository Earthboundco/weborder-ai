# Open questions

Things we don't have answers for yet. Don't guess at these - ask Netto/Wesley.

- ~~DC-qty capping/proration~~ **RESOLVED 2026-08-27** by Netto: fill stores in store-group
  priority order (A1, A2, A3, B, C, D, E); the moment a store can't be fully covered, allocation
  stops entirely (no partial-fill, no skipping ahead). Implemented in `usp_RunAllocation`. Two
  smaller things from implementing this are still open:
  - ~~Tie-break within the same group.~~ **RESOLVED 2026-09-05** by Wesley: rather than just a
    tie-break within Store Group, he provided a full explicit per-(Pattern, Store) Rank
    (1-139) that **replaces Store Group entirely** for waterfall ordering purposes - a
    low-priority A1 store can rank below a high-priority B store. Store Group itself is
    unchanged and still used for the base allocation qty lookup. Added as a new `Rank` column
    on `Pattern_Store_Group`, loaded via `scripts/import-pattern-store-group.js`, refreshed
    every 6-8 weeks. See `business-rules.md` for the full mechanics. **This question is now
    fully closed.**
  - **5 stores have no Pattern_Store_Group entry for some patterns** (435, 512, 535, 542, plus
    470/Ecommerce - though 470 no longer matters here, see below, it bypasses
    `Pattern_Store_Group` entirely now). **RESOLVED 2026-09-03** by Wesley: 435, 512, 535, 542
    are closed or closing - they should not receive any allocation. Confirmed their
    `Store Directory.WStoreType` is currently blank for all 4, so the existing Exc1 ("store
    closed") rule already zeroes them out via `AllowSend` - no code change needed, and no data
    fix needed either since WStoreType is already correctly blank. Their missing
    `Pattern_Store_Group` rows are now moot (they'd be excluded before that lookup matters), so
    this doesn't need to be filled in for these 4. This question is now fully closed.
- ~~Store 470 (Ecommerce) priority~~ **RESOLVED 2026-08-31/2026-09-01** by Netto: option (a) -
  470's counts are a wholly separate weekly input, not derived from `Pattern_Store_Group`/DPS
  calc at all. Netto dropped an example file in `assets/Completed Normal Buyer Review-
  08-31-26 Dawn.xlsx` (`Review` sheet). Confirmed layout: header row 3, data from row 4;
  column **C** = `Item` (item code), column **P** = `Ecommerce final allocation` (the qty to
  actually ship to 470) - these are the only two columns Wesley uses. Other Ecom-related
  columns on that sheet (`Ecommerce Min`/`Max`/`suggested` in M/N/O, `Blocked for Ecom?` in L)
  appeared present but **unused for this purpose** - e.g. `Ecommerce suggested` (O) was 0 on
  every row we sampled, including rows with a nonzero final allocation in P, so it is not a
  reliable "Dawn's original ask" field to read instead of P.
  - Netto: Wesley only *lowers* Dawn's ask when DC supply is short (e.g. Dawn asks 25, DC has
    only 20 -> Wesley enters 20 in P) - so P already reflects Wesley's judgment call, not a raw
    unvetted request. **Caveat found while inspecting the sample file:** 3 of 57 nonzero rows
    have P > `DC Supply` (F) in that same file (items 97528: P=16/DC=8; 97352: P=6/DC=2; 97360:
    P=6/DC=4) - contradicts a strict "never exceed DC supply" reading. **Update 2026-09-01,
    after building and running the pipeline against real data:** 2 of those 3 (97352, 97360)
    got correctly zeroed out for store 470 anyway, because this week's real
    `ItemReplenishment.DC_Qty` for both is 4 (not the sample workbook's stale-looking DC Supply
    column) and the existing rank-0/no-partial-fill waterfall cap applied as designed. Not a
    bug - but suggests the buyer-review workbook's "DC Supply" column can lag the real current
    DC qty. Worth confirming with Wesley if this recurs often, not blocking.
  - Netto also confirmed (2026-09-01): the 12 exclusion rules **do still apply** to 470 -
    Wesley's list curation filters out dead/blocked items before Dawn sees the list, but the
    exclusion check stays on as a safety net rather than being skipped for 470.
  - **Built and validated 2026-09-01:** `EcommerceAllocationRequest` table +
    `scripts/import-ecommerce-allocation.js` + `sql/009_add_ecommerce_allocation_override.sql`
    (redefines `vw_AllocationBase`/`vw_AllocationDraft` for store 470). Ran against the real
    sample file: 57 requested, 44 got a nonzero final allocation (424 units), 0 blocked by
    exclusions, 13 zeroed out (11 not in this week's `ItemReplenishment`, 2 the DC-supply
    anomaly above). Full writeup in `business-rules.md`. **This question is now fully closed.**
  - **Update 2026-09-05:** the source file itself was cleaned up/renamed - the full buyer-review
    workbook is no longer needed as an asset; `assets/EcommerceAllocationRequest.xlsx` (3
    columns: `Store`/`Item`/`Qty`) is now the actual weekly input. The two-column mapping worked
    out above (`Item`/`Ecommerce final allocation`) is still the reasoning behind which two
    numbers matter - it's just delivered in a simpler shape now. See `business-rules.md`.
- ~~In-transit source~~ **RESOLVED (interim) 2026-09-03**, **format delivered and built
  2026-09-05** by Wesley: `INV_SBS_QTY_V_EXT` was never actually wired up for in-transit (it was
  hardcoded 0) and Netto's SAP ASN source is still TBD - Wesley now provides in-transit qty as
  part of a combined weekly manual export, `assets/Stores_Qtys_and_MinMax.xlsx` (`Store_Code` /
  `Item_number` / `On-Hand_qty` / `In-Transit_qty` / `Min_qty` / `Max_qty`, keyed on the business
  Store Code). Imported via `scripts/import-store-inventory.js` into the new
  `StoreItemInventory` table; `vw_AllocationDraft` now sources `InTransitQty` from it instead of
  the hardcoded 0 (see `sql/011_add_store_item_inventory_table.sql`). He'll still grant direct
  access to a real SAP ASN-backed table later - swap the manual input for that once it exists.
  **This question is now fully closed** (format/cadence sub-question resolved - cadence is
  weekly, same as `ItemReplenishment`).
- ~~On-hand source confirmation~~ **RESOLVED 2026-09-03**, **format delivered and built
  2026-09-05** by Wesley: `EBT.dbo.INV_SBS_QTY_V_EXT.QTY` is **not workable right now** (also
  observed to return volatile/negative values live between two queries minutes apart during
  testing - see `progress-log.md`). On-hand qty now comes from the same
  `assets/Stores_Qtys_and_MinMax.xlsx` weekly export as in-transit above, into the same
  `StoreItemInventory` table. **This question is now fully closed.**
- **On-hand/in-transit floor rule (found and fixed 2026-09-05):** while simulating item 96443's
  replenishment, found that negative on-hand values (a real, recurring data quirk - 436 of
  114,260 rows in the 2026-09-05 export are negative) were making `NetNeed` come out *larger*
  than intended instead of being treated as "no usable stock." Per Wesley: floor
  `OnHandQty + InTransitQty` at 0 before netting against `BaseAllocationQty`. Fixed in
  `vw_AllocationDraft` (`sql/010_floor_onhand_plus_intransit.sql`, carried forward into `011`).
  Not really an open question anymore, logged here for traceability.
- **The app itself.** No decision yet on what "the app" looks like for Wesley to use day to day
  (chat interface? something else?). Don't build UI/product surface without checking first.
- **`ItemReplenishment` import cadence/ownership.** Confirmed: Wesley will keep manually
  building the SAP-filtered item list for now; we just import it (`scripts/import-item-
  replenishment.js`). Automating *that* filtering step is explicitly a "later" item, not now.
