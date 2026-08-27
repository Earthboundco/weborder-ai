-- Draft per-store allocation quantity: base qty (from vw_AllocationBase), zeroed out by
-- exclusions, netted against on-hand, then rounded UP to the nearest full case (we never
-- break a case to ship a partial amount).
--
-- PLACEHOLDERS - not final yet:
--   - InTransitQty is hardcoded to 0. Real source is SAP ASN vouchers, replicated to SQL
--     Server per Netto - wire this in once that table is confirmed.
--   - OnHandQty comes from EBT.dbo.INV_SBS_QTY_V_EXT.QTY, matched on the store's internal
--     StoreNo (Store Directory.[ID #]). This was the best-covered on-hand source found during
--     exploration (StoreInvFinal only covered 730 of 788*store rows - looks like a legacy/
--     narrower table) but has NOT been confirmed as the authoritative source with Wesley.
--     Store 470 (Ecommerce) has 2 rows per item in that table (one live-qty row, one
--     min/max-planning row with qty 0) - summed here to avoid double-counting/fan-out.
--   - This view does NOT cap the sum of allocations to an item's DC_Qty, and does not implement
--     any proration when total desired qty exceeds DC_Qty - that rule (how Wesley prioritizes
--     stores when supply is short) still needs to be defined.
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
    WHEN (b.BaseAllocationQty - ISNULL(oh.QTY, 0) - 0) <= 0 THEN 0
    ELSE CEILING((b.BaseAllocationQty - ISNULL(oh.QTY, 0) - 0) * 1.0 / NULLIF(b.QTY_PER_CASE, 0)) * b.QTY_PER_CASE
  END AS AllocationQty
FROM vw_AllocationBase b
JOIN vw_ItemStoreAllowSend a ON a.ItemCode = b.ItemCode AND a.StoreCode = b.StoreCode
LEFT JOIN (
  SELECT ITEM_NO, STORE_NO, SUM(QTY) AS QTY
  FROM EBT.dbo.INV_SBS_QTY_V_EXT
  WHERE ITEM_NO IN (SELECT CAST(ItemCode AS decimal) FROM ItemReplenishment)
  GROUP BY ITEM_NO, STORE_NO
) oh ON oh.ITEM_NO = b.ITEM_NO AND oh.STORE_NO = b.StoreNo;
GO
