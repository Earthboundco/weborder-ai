# Open questions

Things we don't have answers for yet. Don't guess at these - ask Netto/Wesley.

- ~~DC-qty capping/proration~~ **RESOLVED 2026-08-27** by Netto: fill stores in store-group
  priority order (A1, A2, A3, B, C, D, E); the moment a store can't be fully covered, allocation
  stops entirely (no partial-fill, no skipping ahead). Implemented in `usp_RunAllocation`. Two
  smaller things from implementing this are still open:
  - **Tie-break within the same group.** Netto didn't specify ordering among stores that share
    a group letter (e.g. several stores are all "A2"). We used StoreCode ascending as a
    deterministic default - not confirmed as the right one.
  - **5 stores have no Pattern_Store_Group entry for some patterns** (470/Ecommerce, 435, 512,
    535, 542 - 55 pattern+store combos total). We rank these last (after E) so they only get
    stock if everything properly grouped is satisfied first. Also not confirmed - and probably
    means `Pattern_Store_Group` needs a data update regardless of what we do in code.
- **Store 470 (Ecommerce) priority - NEW 2026-08-27, needs a decision before it does anything
  useful.** Netto: 470 is filled by a separate person who sends her own counts, and those counts
  take priority over every other store (rank 0, ahead of A1). We implemented the priority rank
  (confirmed: 470 = rank 0 in `AllocationResults`), but store 470 **has zero rows in
  `Pattern_Store_Group` for every single pattern** - so under the current pipeline its
  `BaseAllocationQty` is always 0 and it never actually receives any quantity, regardless of
  priority. Two real possibilities, need Netto to say which: (a) "her counts" is a wholly
  separate input (like `ItemReplenishment` but for store 470's desired quantities) that should
  be imported and slotted in at rank 0, bypassing the DCS-pattern/store-group calculation
  entirely for that store; or (b) `Pattern_Store_Group` just needs 470 added like any other
  store and the existing calculation should apply to it too. Don't guess - the "priority"
  change is inert either way until this is resolved.
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
