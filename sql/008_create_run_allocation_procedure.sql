-- Runs the full allocation calculation for whatever is currently in ItemReplenishment and
-- writes results to AllocationResults. Call this after importing a new weekly item list
-- (scripts/import-item-replenishment.js) and whenever exclusion rules or reference tables change.
--
-- Priority order for the DC-qty waterfall: store 470 (Ecommerce) is ALWAYS rank 0, ahead of
-- even A1 - per Netto, it's filled by a separate person who sends her own counts, and those
-- counts take priority over every other store regardless of store group. Then A1, A2, A3, B,
-- C, D, E as before.
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
  CROSS APPLY (
    SELECT
      CASE
        WHEN d.StoreCode = '470' THEN 0 -- Ecommerce: filled by a separate person, always first
        ELSE CASE d.StoreGroup
          WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'A3' THEN 3
          WHEN 'B'  THEN 4 WHEN 'C'  THEN 5 WHEN 'D'  THEN 6 WHEN 'E' THEN 7
          ELSE 99
        END
      END AS GroupRank
  ) g
  CROSS APPLY (
    SELECT SUM(d2.AllocationQty) AS RunningTotal
    FROM AllocationDraft d2
    WHERE d2.ItemCode = d.ItemCode
      AND (
        CASE
          WHEN d2.StoreCode = '470' THEN 0
          ELSE CASE d2.StoreGroup
            WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'A3' THEN 3
            WHEN 'B'  THEN 4 WHEN 'C'  THEN 5 WHEN 'D'  THEN 6 WHEN 'E' THEN 7
            ELSE 99
          END
        END < g.GroupRank
        OR (
          CASE
            WHEN d2.StoreCode = '470' THEN 0
            ELSE CASE d2.StoreGroup
              WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'A3' THEN 3
              WHEN 'B'  THEN 4 WHEN 'C'  THEN 5 WHEN 'D'  THEN 6 WHEN 'E' THEN 7
              ELSE 99
            END
          END = g.GroupRank
          AND d2.StoreCode <= d.StoreCode
        )
      )
  ) r;
END
GO
