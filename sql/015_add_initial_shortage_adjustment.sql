-- Adds the "Initial Shortage Adjustment" step, and renames the existing waterfall cap to
-- "Final Shortage Adjustment" (per Wesley, 2026-09-06).
--
-- Previously, when demand (SUM of AllocationQty across AllowSend='Y' stores) exceeded DC_Qty,
-- the waterfall alone decided who got cut, in full - a store either shipped its full
-- case-rounded need or got zero, with no middle ground. Wesley wants small shortages (<=30 pcs)
-- to go straight to that waterfall as before, but LARGER shortages (>30 pcs) to first be
-- softened by proportionally trimming lower-priority groups' base allocation - so a shortage of
-- (say) 200 pcs doesn't necessarily mean dozens of low-priority stores get zeroed outright; some
-- of the pain is spread as smaller quantities across more stores first.
--
-- Mechanics (per item):
--   1. demand = SUM(AllocationQty) for AllowSend='Y' rows (470 included - its qty still
--      consumes real DC supply, it's just never itself a target for cuts below).
--   2. shortage = demand - DC_Qty.
--   3. If shortage <= 30, skip straight to the Final Shortage Adjustment (unchanged waterfall).
--   4. Else, walk groups E -> D -> C -> B -> A3 -> A2 -> A1 (470 excluded - it has no Store
--      Group, so it's naturally skipped). At each step: cut every store in that group's
--      BaseAllocationQty by 5% (floor to whole number, compounding off the CURRENT value - not
--      the original), then re-net against On-Hand+In-Transit (floored at 0) and re-apply case
--      rounding exactly as vw_AllocationDraft normally does - the case-quantity rule is never
--      broken, only the pre-netting base number is reduced. Recompute demand/shortage after
--      every single group step; the moment shortage <= 30, stop and move to the Final
--      Shortage Adjustment using whatever AllocationQty values currently stand.
--   5. If a full E->A1 pass finishes and shortage is still > 30, loop back to E and keep
--      compounding. A safety cap (200 cycles = 1,400 group-steps) prevents a true infinite loop
--      in a pathological case; ordinary items resolve in 1-2 steps (see progress-log.md for the
--      validation example, item 96800).
--
-- The Final Shortage Adjustment itself (store-priority waterfall by Pattern_Store_Group.Rank,
-- 470 always first) is UNCHANGED logic - only its name/section label changed, per Wesley.

DROP PROCEDURE usp_RunAllocation;
GO

CREATE PROCEDURE usp_RunAllocation
AS
BEGIN
  SET NOCOUNT ON;

  ----------------------------------------------------------------------------------------------
  -- Materialize the draft (unchanged)
  ----------------------------------------------------------------------------------------------
  TRUNCATE TABLE AllocationDraft;
  INSERT INTO AllocationDraft
    (ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty)
  SELECT
     ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty
  FROM vw_AllocationDraft;

  ----------------------------------------------------------------------------------------------
  -- INITIAL SHORTAGE ADJUSTMENT (new, 2026-09-06)
  -- Only touches items whose shortage (demand - DC_Qty) exceeds 30 pcs. Mutates
  -- AllocationDraft.BaseAllocationQty/AllocationQty in place, group by group, item by item.
  ----------------------------------------------------------------------------------------------
  DECLARE @ShortageThreshold int = 30;
  DECLARE @CutRate decimal(4,2) = 0.95; -- i.e. a 5% cut
  DECLARE @MaxCycles int = 200;         -- safety cap: 200 full E->A1 passes (1,400 steps)

  DECLARE @groupSeq TABLE (Seq int IDENTITY(1,1) PRIMARY KEY, GroupCode varchar(5));
  INSERT INTO @groupSeq (GroupCode) VALUES ('E'), ('D'), ('C'), ('B'), ('A3'), ('A2'), ('A1');
  DECLARE @groupCount int = (SELECT COUNT(*) FROM @groupSeq);

  DECLARE @itemCode nvarchar(8), @dcQty int, @demand int, @shortage int,
          @cycle int, @groupIdx int, @groupCode varchar(5);

  DECLARE item_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT ItemCode
    FROM (
      SELECT ItemCode, MAX(DC_Qty) AS DC_Qty,
             SUM(CASE WHEN AllowSend = 'Y' THEN AllocationQty ELSE 0 END) AS Demand
      FROM AllocationDraft
      GROUP BY ItemCode
    ) x
    WHERE Demand - DC_Qty > @ShortageThreshold;

  OPEN item_cursor;
  FETCH NEXT FROM item_cursor INTO @itemCode;

  WHILE @@FETCH_STATUS = 0
  BEGIN
    SELECT @dcQty = MAX(DC_Qty),
           @demand = SUM(CASE WHEN AllowSend = 'Y' THEN AllocationQty ELSE 0 END)
    FROM AllocationDraft WHERE ItemCode = @itemCode;
    SET @shortage = @demand - @dcQty;

    SET @cycle = 0;
    WHILE @shortage > @ShortageThreshold AND @cycle < @MaxCycles
    BEGIN
      SET @groupIdx = 1;
      WHILE @groupIdx <= @groupCount AND @shortage > @ShortageThreshold
      BEGIN
        SELECT @groupCode = GroupCode FROM @groupSeq WHERE Seq = @groupIdx;

        UPDATE AllocationDraft
        SET BaseAllocationQty = FLOOR(BaseAllocationQty * @CutRate),
            AllocationQty =
              CASE
                WHEN AllowSend = 'N' THEN 0
                WHEN (FLOOR(BaseAllocationQty * @CutRate)
                      - (CASE WHEN (OnHandQty + InTransitQty) < 0 THEN 0 ELSE (OnHandQty + InTransitQty) END)) <= 0
                  THEN 0
                ELSE CEILING((FLOOR(BaseAllocationQty * @CutRate)
                      - (CASE WHEN (OnHandQty + InTransitQty) < 0 THEN 0 ELSE (OnHandQty + InTransitQty) END))
                      * 1.0 / NULLIF(QTY_PER_CASE, 0)) * QTY_PER_CASE
              END
        WHERE ItemCode = @itemCode AND StoreGroup = @groupCode;

        SELECT @demand = SUM(CASE WHEN AllowSend = 'Y' THEN AllocationQty ELSE 0 END)
        FROM AllocationDraft WHERE ItemCode = @itemCode;
        SET @shortage = @demand - @dcQty;

        SET @groupIdx = @groupIdx + 1;
      END
      SET @cycle = @cycle + 1;
    END

    FETCH NEXT FROM item_cursor INTO @itemCode;
  END

  CLOSE item_cursor;
  DEALLOCATE item_cursor;

  ----------------------------------------------------------------------------------------------
  -- FINAL SHORTAGE ADJUSTMENT (renamed from "the waterfall cap" - logic unchanged from sql/013)
  -- Store-priority order: 470 always first, then every other store by Pattern_Store_Group.Rank
  -- for that item's DCS Pattern (ascending - rank 1 before rank 2, etc). Walks that order
  -- keeping a running total of AllocationQty; a store ships in full only if the running total
  -- through that store is still <= DC_Qty - no partial fill, no skipping ahead.
  ----------------------------------------------------------------------------------------------
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
          AND d2.StoreCode <= d.StoreCode
        )
      )
  ) r;
END
GO
