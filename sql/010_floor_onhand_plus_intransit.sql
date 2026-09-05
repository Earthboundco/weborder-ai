-- Fix (2026-09-05, per Wesley, found while simulating item 96443's replenishment):
-- vw_AllocationDraft netted BaseAllocationQty against OnHandQty + InTransitQty directly,
-- without flooring the combined on-hand+in-transit figure at 0 first. A negative on-hand
-- value (a real data quirk in EBT.dbo.INV_SBS_QTY_V_EXT - confirmed 316 item/store rows in
-- the current 788-item set have OnHandQty < 0) made NetNeed come out *larger* than it should
-- have (e.g. Base 8 - OnHand -1 = 9, instead of treating "no usable stock" as 0), the opposite
-- of the intended effect.
--
-- Wesley's rule: compute OnHandQty + InTransitQty first: if that combined figure is negative,
-- treat it as 0 before netting against BaseAllocationQty. This is on top of the existing floor
-- that keeps NetNeed itself from going negative (unchanged).
--
-- Store 470 (Ecommerce) is unaffected - it already skips on-hand netting entirely (its
-- BaseAllocationQty is used as-is, per sql/009).
--
-- Redefines vw_AllocationDraft again (originally 005, redefined for store 470 in 009).

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
  ISNULL(oh.QTY, 0) AS OnHandQty,
  0 AS InTransitQty,
  CASE
    WHEN a.AllowSend = 'N' THEN 0
    WHEN b.StoreCode = '470' THEN b.BaseAllocationQty
    WHEN (b.BaseAllocationQty - net.OnHandPlusInTransit) <= 0 THEN 0
    ELSE CEILING((b.BaseAllocationQty - net.OnHandPlusInTransit) * 1.0 / NULLIF(b.QTY_PER_CASE, 0)) * b.QTY_PER_CASE
  END AS AllocationQty
FROM vw_AllocationBase b
JOIN vw_ItemStoreAllowSend a ON a.ItemCode = b.ItemCode AND a.StoreCode = b.StoreCode
LEFT JOIN (
  SELECT ITEM_NO, STORE_NO, SUM(QTY) AS QTY
  FROM EBT.dbo.INV_SBS_QTY_V_EXT
  WHERE ITEM_NO IN (SELECT CAST(ItemCode AS decimal) FROM ItemReplenishment)
  GROUP BY ITEM_NO, STORE_NO
) oh ON oh.ITEM_NO = b.ITEM_NO AND oh.STORE_NO = b.StoreNo
CROSS APPLY (
  -- On-hand + in-transit, floored at 0 (InTransitQty is still hardcoded 0 - see open-questions.md)
  SELECT CASE WHEN (ISNULL(oh.QTY, 0) + 0) < 0 THEN 0 ELSE (ISNULL(oh.QTY, 0) + 0) END AS OnHandPlusInTransit
) net;
GO
