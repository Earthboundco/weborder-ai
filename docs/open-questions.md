# Open questions

Things we don't have answers for yet. Don't guess at these - ask Netto/Wesley.

- ~~DC-qty capping/proration~~ **RESOLVED 2026-08-27** by Netto: fill stores in store-group
  priority order (A1, A2, A3, B, C, D, E); the moment a store can't be fully covered, allocation
  stops entirely (no partial-fill, no skipping ahead). Implemented in `usp_RunAllocation`. Two
  smaller things from implementing this are still open:
  - **Tie-break within the same group.** Netto didn't specify ordering among stores that share
    a group letter (e.g. several stores are all "A2"). We used StoreCode ascending as a
    deterministic default - not confirmed as the right one.
  - **5 stores have no Pattern_Store_Group entry for some patterns** (435, 512, 535, 542, plus
    470/Ecommerce - though 470 no longer matters here, see below, it bypasses
    `Pattern_Store_Group` entirely now). We rank these last (after E) so they only get stock if
    everything properly grouped is satisfied first. Still not confirmed for the remaining 4 -
    probably means `Pattern_Store_Group` needs a data update regardless of what we do in code.
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
- **In-transit source.** Netto is getting us access to the real SAP ASN data (replicated to
  SQL Server). Table/column names TBD - update `data-sources.md` and swap the placeholder in
  `vw_AllocationDraft` once known.
- **On-hand source confirmation.** We're using `EBT.dbo.INV_SBS_QTY_V_EXT.QTY`. Never explicitly
  confirmed with Wesley as the right/authoritative source - it was just the best-covered
  candidate found during exploration.
- **The app itself.** No decision yet on what "the app" looks like for Wesley to use day to day
  (chat interface? something else?). Don't build UI/product surface without checking first.
- **`ItemReplenishment` import cadence/ownership.** Confirmed: Wesley will keep manually
  building the SAP-filtered item list for now; we just import it (`scripts/import-item-
  replenishment.js`). Automating *that* filtering step is explicitly a "later" item, not now.
