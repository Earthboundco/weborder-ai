-- Resolves the last standing open question: the DC-qty waterfall tie-break order (2026-09-05,
-- per Wesley). Previously, stores were ordered by Store Group (A1->A2->A3->B->C->D->E) with
-- StoreCode-ascending as an unconfirmed placeholder tie-break within a group. Wesley now
-- provides an explicit per-(Pattern, Store) Rank (1-139) that FULLY REPLACES Store Group for
-- waterfall ordering purposes - a low-priority A1 store can rank below a high-priority B store.
-- Store Group itself is untouched and still used for the BaseAllocationQty lookup
-- (Item_Code_allocation_table/DPS_Code_allocation_table are keyed by Store Group, not by
-- individual store) - this only changes the order stores get cut when DC supply is short.
--
-- Confirmed with the real file (2026-09-05): all 11 patterns have exactly 139 stores, ranks
-- 1-139 with zero duplicates and zero gaps per pattern - matches 144 active stores minus 470
-- (separate input, always rank 0, not in this table at all) minus the 4 closed stores (already
-- excluded via Exc1). Refreshes every 6-8 weeks (Wesley) via
-- scripts/import-pattern-store-group.js.

ALTER TABLE Pattern_Store_Group ADD [Rank] int NULL;
GO

-- No indexes previously existed on this table (heap). Add one now since Rank/Store lookups
-- happen per-row in the waterfall calc below; table is tiny (1,529 rows) but this keeps the
-- per-item correlated subquery cheap, consistent with why AllocationDraft itself is indexed.
CREATE UNIQUE NONCLUSTERED INDEX IX_Pattern_Store_Group_Pattern_Store
  ON Pattern_Store_Group ([DCS pattern], [Store code]);
GO

DROP PROCEDURE usp_RunAllocation;
GO

CREATE PROCEDURE usp_RunAllocation
AS
BEGIN
  SET NOCOUNT ON;

  TRUNCATE TABLE AllocationDraft;
  INSERT INTO AllocationDraft
    (ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty)
  SELECT
     ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty
  FROM vw_AllocationDraft;

  TRUNCATE TABLE AllocationResults;
  INSERT INTO AllocationResults
    (ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty,
     GroupRank, RunningTotal, FinalAllocationQty)
  SELECT
    d.ItemCode, d.ITEM_NO, d.DCS_CODE, d.DPS_Code, d.QTY_PER_CASE, d.DC_Qty, d.StoreCode, d.StoreNo,
    d.DCSPattern, d.StoreGroup, d.BaseAllocationQty, d.AllowSend, d.OnHandQty, d.InTransitQty, d.AllocationQty,
    g.GroupRank,
    r.RunningTotal,
    CASE WHEN r.RunningTotal <= d.DC_Qty THEN d.AllocationQty ELSE 0 END
  FROM AllocationDraft d
  LEFT JOIN Pattern_Store_Group psg
    ON psg.[DCS pattern] = d.DCSPattern AND psg.[Store code] = d.StoreCode
  CROSS APPLY (
    -- Store 470 (Ecommerce) is always first, per Netto - it doesn't appear in
    -- Pattern_Store_Group at all. Every other store's priority is now Wesley's explicit
    -- per-pattern Rank (1-139), replacing the old Store-Group-based ordering entirely.
    -- ISNULL fallback (999) only matters if a store is somehow missing from
    -- Pattern_Store_Group for a pattern - shouldn't happen given the current file's coverage.
    SELECT CASE WHEN d.StoreCode = '470' THEN 0 ELSE ISNULL(psg.[Rank], 999) END AS GroupRank
  ) g
  CROSS APPLY (
    SELECT SUM(d2.AllocationQty) AS RunningTotal
    FROM AllocationDraft d2
    LEFT JOIN Pattern_Store_Group psg2
      ON psg2.[DCS pattern] = d2.DCSPattern AND psg2.[Store code] = d2.StoreCode
    WHERE d2.ItemCode = d.ItemCode
      AND (
        CASE WHEN d2.StoreCode = '470' THEN 0 ELSE ISNULL(psg2.[Rank], 999) END < g.GroupRank
        OR (
          CASE WHEN d2.StoreCode = '470' THEN 0 ELSE ISNULL(psg2.[Rank], 999) END = g.GroupRank
          AND d2.StoreCode <= d.StoreCode -- now just includes the current row itself: ranks are
                                          -- unique per pattern, so equal rank means same store
        )
      )
  ) r;
END
GO
