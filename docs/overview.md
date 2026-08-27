# Overview

Earthbound Trading Co. wants an AI agent to help with product replenishment planning across
its retail stores (~144 active stores).

Today, Wesley does this manually every Sunday: he looks at inventory levels per store
(on-hand + in-transit), decides how much of each item to send to each store, and builds a
spreadsheet that gets handed off to allocation/shipping. The goal is to automate this process,
starting by faithfully reproducing what Wesley does today, then later suggesting improvements
(target: ~70% automation once the baseline process is solid).

## The process, as it works today

1. Wesley runs an inventory report out of SAP and filters it down to the items actually in
   scope for replenishment this week (excludes non-retail, loose incense, on-hold, holiday
   items buyers have flagged, etc). This is currently a manual filter - usually under 1,000
   items out of ~96k total SKUs. This filtered list + each item's DC-available quantity is
   the starting point (`ItemReplenishment` table - see `data-sources.md`).
2. Each item has a **DCS code** (department/class/subclass, e.g. `AC BA`) which maps to a
   **DCS Pattern** (`Pattern 01`-`11`).
3. Each store is assigned a **Store Group** (`A1, A2, A3, B, C, D, E`) - but *per pattern*, not
   fixed per store. The same store can be group A1 for one pattern's items and group C for
   another pattern's items, reflecting different velocity/sizing needs by category.
4. A base allocation qty is looked up for the item's DPS Code (DCS + Price bucket + Size) or,
   if a more specific override exists, the exact Item Code - at that store's group level.
5. **Exclusion rules** (12 of them, formerly in an Access database, now in `EBTAI`) zero out
   specific item/store combinations - closed stores, non-EBT items, markdown restrictions,
   Prop 65 fails, Fashion-Focus-only categories, etc. See `business-rules.md`.
6. The base qty is netted against on-hand + in-transit inventory at that store.
7. The result is rounded **up** to the nearest full case - cases are never broken to ship a
   partial amount (e.g. need 5, case qty is 2 -> send 6).
8. Per-item totals across all stores are compared against the item's DC-available quantity.
   When demand exceeds supply, something has to give - **exactly how Wesley prioritizes which
   stores get cut is still an open question** (see `open-questions.md`). This turns out to be
   common: in a test run, 390 of 788 items (~50%) had total desired qty exceeding DC supply.

## What's built so far

See `data-sources.md` for the full inventory. In short: exclusion rules are fully implemented
and validated against real data; the allocation draft (steps 2-7 above) is implemented and
producing plausible numbers; DC-qty capping/proration (step 8) is NOT implemented yet; in-transit
quantity is a placeholder (hardcoded 0) pending the real SAP ASN source.

## Where the app itself is headed

Not decided yet. Netto's initial thought: maybe a chat interface Wesley can interact with -
feed data, run reports, ask questions, make adjustments. Nothing has been built on that front;
right now this is all SQL views/tables plus one-off Node scripts run from the CLI.
