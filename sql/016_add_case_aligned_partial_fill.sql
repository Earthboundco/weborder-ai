-- Redefines the Final Shortage Adjustment (2026-09-06, per Wesley). Corrects a misunderstanding
-- from the original waterfall design: "no partial fill" does NOT mean a store gets its full
-- need or nothing - it means a store can receive a PARTIAL fill, as long as the amount shipped
-- is always a whole multiple of the item's case qty. Cases can never be broken; that is a
-- separate, still-true rule from "does a store get some vs none."
--
-- Mechanics, per item, walking stores in the same priority order as before (470 always first,
-- then ascending Pattern_Store_Group.Rank): keep a running "remaining supply" counter, starting
-- at DC_Qty. At each store's turn, ship as many FULL CASES as remaining supply allows, up to
-- that store's own need:
--   ShipQty = FLOOR(MIN(need, remaining) / QTY_PER_CASE) * QTY_PER_CASE
-- then subtract that from remaining supply and move on to the NEXT store - even a store that
-- couldn't be fully covered doesn't block lower-priority stores from getting whatever's left.
-- A lower-priority store can still receive a full or partial amount if enough remains once it's
-- their turn - case-size granularity, not overall priority, decides who benefits from a leftover
-- sliver. (Confirmed with Wesley: applies to every store, not just 470; the waterfall keeps
-- walking after a partial fill rather than zeroing everyone remaining.)
--
-- New columns on AllocationResults:
--   LeftoverQty          - DC_Qty minus everything actually shipped for that item. 0 if fully
--                          consumed in whole cases; a genuine surplus if demand < DC_Qty; or a
--                          "stuck" sub-case fragment that structurally can't be shipped to
--                          anyone, if DCQtyNotCaseMultiple = 'Y' and demand was large enough to
--                          exhaust full cases.
--   DCQtyNotCaseMultiple - 'Y' if DC_Qty itself isn't a whole multiple of QTY_PER_CASE for that
--                          item - flags a real data-quality condition worth a look, since it
--                          means some DC inventory can never be shipped to any store no matter
--                          how demand plays out.
--
-- Implementation note: this needs genuine sequential processing - each store's shipped amount
-- depends on the cumulative ACTUAL (case-floored) amount already shipped to every higher-
-- priority store for that item, which can't be expressed as a single set-based aggregate
-- because of the non-linear FLOOR() applied at every step. Uses ONE forward-only cursor over
-- all items/stores at once (ordered by ItemCode, GroupRank, StoreCode), resetting the running
-- counter whenever ItemCode changes - a single pass over ~138k rows, not a cursor per item.

IF COL_LENGTH('AllocationResults', 'LeftoverQty') IS NULL
  ALTER TABLE AllocationResults ADD LeftoverQty int NULL;
GO
IF COL_LENGTH('AllocationResults', 'DCQtyNotCaseMultiple') IS NULL
  ALTER TABLE AllocationResults ADD DCQtyNotCaseMultiple char(1) NULL;
GO

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
  -- INITIAL SHORTAGE ADJUSTMENT (unchanged from sql/015)
  ----------------------------------------------------------------------------------------------
  DECLARE @ShortageThreshold int = 30;
  DECLARE @CutRate decimal(4,2) = 0.95;
  DECLARE @MaxCycles int = 200;

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
  -- FINAL SHORTAGE ADJUSTMENT (redefined 2026-09-06 - case-aligned partial fill, see header)
  ----------------------------------------------------------------------------------------------
  IF OBJECT_ID('tempdb..#Plan') IS NOT NULL DROP TABLE #Plan;
  CREATE TABLE #Plan (
    PlanId int IDENTITY(1,1) PRIMARY KEY NONCLUSTERED,
    ItemCode nvarchar(8) NOT NULL, StoreCode varchar(50) NOT NULL, GroupRank int NOT NULL,
    AllocationQty int NOT NULL, QTY_PER_CASE decimal NULL, DC_Qty int NULL,
    FinalAllocationQty int NULL, RunningTotal int NULL
  );

  INSERT INTO #Plan (ItemCode, StoreCode, GroupRank, AllocationQty, QTY_PER_CASE, DC_Qty)
  SELECT
    d.ItemCode, d.StoreCode,
    CASE WHEN d.StoreCode = '470' THEN 0 ELSE ISNULL(psg.[Rank], 999) END,
    d.AllocationQty, d.QTY_PER_CASE, d.DC_Qty
  FROM AllocationDraft d
  LEFT JOIN Pattern_Store_Group psg
    ON psg.[DCS pattern] = d.DCSPattern AND psg.[Store code] = d.StoreCode
  WHERE d.AllowSend = 'Y';

  CREATE UNIQUE CLUSTERED INDEX IX_Plan_Order ON #Plan (ItemCode, GroupRank, StoreCode, PlanId);

  DECLARE @planId int, @pItemCode nvarchar(8), @pAllocQty int, @pCaseQty decimal, @pDcQty int;
  DECLARE @prevItem nvarchar(8) = NULL;
  DECLARE @remaining int = 0;
  DECLARE @shipQty int;
  DECLARE @caseQty int;

  DECLARE plan_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT PlanId, ItemCode, AllocationQty, QTY_PER_CASE, DC_Qty
    FROM #Plan
    ORDER BY ItemCode, GroupRank, StoreCode;

  OPEN plan_cursor;
  FETCH NEXT FROM plan_cursor INTO @planId, @pItemCode, @pAllocQty, @pCaseQty, @pDcQty;

  WHILE @@FETCH_STATUS = 0
  BEGIN
    IF @prevItem IS NULL OR @pItemCode <> @prevItem
    BEGIN
      SET @remaining = ISNULL(@pDcQty, 0);
      SET @prevItem = @pItemCode;
    END

    SET @caseQty = CASE WHEN ISNULL(@pCaseQty, 0) <= 0 THEN 1 ELSE CAST(@pCaseQty AS int) END;
    SET @shipQty = FLOOR((CASE WHEN @pAllocQty < @remaining THEN @pAllocQty ELSE @remaining END) * 1.0 / @caseQty) * @caseQty;
    IF @shipQty IS NULL OR @shipQty < 0 SET @shipQty = 0;

    UPDATE #Plan
    SET FinalAllocationQty = @shipQty,
        RunningTotal = (ISNULL(@pDcQty, 0) - @remaining) + @shipQty
    WHERE PlanId = @planId;

    SET @remaining = @remaining - @shipQty;

    FETCH NEXT FROM plan_cursor INTO @planId, @pItemCode, @pAllocQty, @pCaseQty, @pDcQty;
  END

  CLOSE plan_cursor;
  DEALLOCATE plan_cursor;

  -- Per-item leftover: DC_Qty minus everything actually shipped (0 rows in #Plan for an item -
  -- e.g. every store blocked by exclusions - correctly leaves the full DC_Qty as leftover).
  IF OBJECT_ID('tempdb..#ItemLeftover') IS NOT NULL DROP TABLE #ItemLeftover;
  CREATE TABLE #ItemLeftover (ItemCode nvarchar(8) PRIMARY KEY, LeftoverQty int);
  INSERT INTO #ItemLeftover (ItemCode, LeftoverQty)
  SELECT d.ItemCode, MAX(d.DC_Qty) - ISNULL(SUM(p.FinalAllocationQty), 0)
  FROM AllocationDraft d
  LEFT JOIN #Plan p ON p.ItemCode = d.ItemCode AND p.StoreCode = d.StoreCode
  GROUP BY d.ItemCode;

  TRUNCATE TABLE AllocationResults;
  INSERT INTO AllocationResults
    (ItemCode, ITEM_NO, DCS_CODE, DPS_Code, QTY_PER_CASE, DC_Qty, StoreCode, StoreNo,
     DCSPattern, StoreGroup, BaseAllocationQty, AllowSend, OnHandQty, InTransitQty, AllocationQty,
     GroupRank, RunningTotal, FinalAllocationQty, LeftoverQty, DCQtyNotCaseMultiple)
  SELECT
    d.ItemCode, d.ITEM_NO, d.DCS_CODE, d.DPS_Code, d.QTY_PER_CASE, d.DC_Qty, d.StoreCode, d.StoreNo,
    d.DCSPattern, d.StoreGroup, d.BaseAllocationQty, d.AllowSend, d.OnHandQty, d.InTransitQty, d.AllocationQty,
    CASE WHEN d.StoreCode = '470' THEN 0 ELSE ISNULL(psg.[Rank], 999) END,
    ISNULL(p.RunningTotal, 0),
    CASE WHEN d.AllowSend = 'N' THEN 0 ELSE ISNULL(p.FinalAllocationQty, 0) END,
    il.LeftoverQty,
    CASE WHEN CAST(d.DC_Qty AS int) % NULLIF(CAST(d.QTY_PER_CASE AS int), 0) <> 0 THEN 'Y' ELSE 'N' END
  FROM AllocationDraft d
  LEFT JOIN Pattern_Store_Group psg
    ON psg.[DCS pattern] = d.DCSPattern AND psg.[Store code] = d.StoreCode
  LEFT JOIN #Plan p ON p.ItemCode = d.ItemCode AND p.StoreCode = d.StoreCode
  LEFT JOIN #ItemLeftover il ON il.ItemCode = d.ItemCode;

  DROP TABLE #Plan;
  DROP TABLE #ItemLeftover;
END
GO
