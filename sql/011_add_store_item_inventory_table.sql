-- Resolves the two remaining "Known placeholders" from business-rules.md / open-questions.md:
-- on-hand qty source and in-transit qty source. Per Wesley (2026-09-05), both now come from a
-- weekly manual export, assets/Stores_Qtys_and_MinMax.xlsx (Store_Code/Item_number/On-Hand_qty/
-- In-Transit_qty/Min_qty/Max_qty), keyed on the business Store Code (same numbering as
-- Pattern_Store_Group/ItemReplenishment - NOT the internal Store Directory [ID #]).
--
-- This retires EBT.dbo.INV_SBS_QTY_V_EXT as the on-hand source (Wesley confirmed 2026-09-03 it
-- "is not workable right now" - also observed to return volatile/negative values live, see
-- progress-log.md) and the hardcoded InTransitQty = 0 placeholder. Min_qty/Max_qty aren't used
-- by the allocation calc today but are kept for reference/future use.
--
-- Redefines vw_AllocationDraft again (originally 005; redefined for store 470 in 009; the
-- on-hand+in-transit floor-at-0 fix from 010 is preserved here, now applied to a real
-- InTransitQty instead of an always-0 placeholder).

CREATE TABLE StoreItemInventory (
  ItemCode      nvarchar(8)  NOT NULL,
  StoreCode     varchar(50)  NOT NULL,
  OnHandQty     int          NOT NULL,
  InTransitQty  int          NOT NULL,
  MinQty        int          NULL,
  MaxQty        int          NULL,
  ImportedDate  datetime     NOT NULL DEFAULT GETDATE(),
  CONSTRAINT PK_StoreItemInventory PRIMARY KEY CLUSTERED (ItemCode, StoreCode)
);
GO

DROP VIEW vw_AllocationDraft;
GO

CREATE VIEW vw_AllocationDraft AS
SELECT
  b.ItemCode,
  b.ITEM_NO,
  b.DCS_CODE,
  b.DPS_Code,
  b.QTY_PER_CASE,
  b.DC_Qty,
  b.StoreCode,
  b.StoreNo,
  b.DCSPattern,
  b.StoreGroup,
  b.BaseAllocationQty,
  a.AllowSend,
  ISNULL(si.OnHandQty, 0) AS OnHandQty,
  ISNULL(si.InTransitQty, 0) AS InTransitQty,
  CASE
    WHEN a.AllowSend = 'N' THEN 0
    WHEN b.StoreCode = '470' THEN b.BaseAllocationQty
    WHEN (b.BaseAllocationQty - net.OnHandPlusInTransit) <= 0 THEN 0
    ELSE CEILING((b.BaseAllocationQty - net.OnHandPlusInTransit) * 1.0 / NULLIF(b.QTY_PER_CASE, 0)) * b.QTY_PER_CASE
  END AS AllocationQty
FROM vw_AllocationBase b
JOIN vw_ItemStoreAllowSend a ON a.ItemCode = b.ItemCode AND a.StoreCode = b.StoreCode
LEFT JOIN StoreItemInventory si ON si.ItemCode = b.ItemCode AND si.StoreCode = b.StoreCode
CROSS APPLY (
  -- On-hand + in-transit, floored at 0 (per Wesley, 2026-09-05 - see sql/010 for the original fix)
  SELECT CASE
    WHEN (ISNULL(si.OnHandQty, 0) + ISNULL(si.InTransitQty, 0)) < 0 THEN 0
    ELSE (ISNULL(si.OnHandQty, 0) + ISNULL(si.InTransitQty, 0))
  END AS OnHandPlusInTransit
) net;
GO
