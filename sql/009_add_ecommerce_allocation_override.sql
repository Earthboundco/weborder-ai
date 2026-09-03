-- Store 470 (Ecommerce) does NOT go through the DCS-pattern/store-group calculation like
-- every other store - per Netto (2026-09-01), it's a wholly separate weekly input: Wesley
-- sends his SAP-curated item list to Dawn, she comes back with a requested qty per item
-- (adjusted down by Wesley when DC supply is short), and that final number is what ships.
-- Source file example: assets/Completed Normal Buyer Review- 08-31-26 Dawn.xlsx, "Review"
-- sheet - column C (Item) and column P (Ecommerce final allocation) are the only two columns
-- that matter. See docs/open-questions.md for caveats (a few sample rows had P > DC Supply,
-- unexplained) and docs/business-rules.md for the full rule writeup.
--
-- This file redefines vw_AllocationBase (originally 004) and vw_AllocationDraft (originally
-- 005) to special-case store 470: BaseAllocationQty comes from this table instead of
-- Pattern_Store_Group/allocation tables, and AllocationQty skips on-hand netting and case-qty
-- rounding (Wesley's number is already final and case-aligned - confirmed: all 57 nonzero
-- rows in the sample file were exact multiples of CASE_QTY). Exclusion rules (AllowSend) still
-- apply, per Netto: Wesley's list curation mostly filters dead/blocked items before Dawn ever
-- sees them, but the 12-rule check should still run as a safety net.

CREATE TABLE EcommerceAllocationRequest (
  ItemCode      nvarchar(8) NOT NULL PRIMARY KEY,
  RequestedQty  int         NOT NULL,
  ImportedDate  datetime    NOT NULL DEFAULT GETDATE()
);
GO

DROP VIEW vw_AllocationBase;
GO

CREATE VIEW vw_AllocationBase AS
SELECT
  ir.ItemCode,
  ii.ITEM_NO,
  ii.DCS_CODE,
  ii.DPS_Code,
  ii.QTY_PER_CASE,
  ir.DC_Qty,
  sd.[Code #]  AS StoreCode,
  sd.[ID #]    AS StoreNo,
  dp.[DCS pattern]   AS DCSPattern,
  psg.[Store group]  AS StoreGroup,
  CASE
    WHEN sd.[Code #] = '470' THEN ISNULL(eco.RequestedQty, 0)
    ELSE COALESCE(ica.AllocationQty, dpa.AllocationQty, 0)
  END AS BaseAllocationQty
FROM ItemReplenishment ir
JOIN ItemInformationComplete ii ON ii.ITEM_NO = CAST(ir.ItemCode AS decimal)
JOIN DCS_Pattern dp ON dp.[DCS Code] = ii.DCS_CODE
CROSS JOIN EBT.dbo.[Store Directory] sd
LEFT JOIN Pattern_Store_Group psg
  ON psg.[DCS pattern] = dp.[DCS pattern] AND psg.[Store code] = sd.[Code #]
LEFT JOIN Item_Code_allocation_table ica
  ON ica.ItemCode = ii.ITEM_NO AND ica.StoreGroup = psg.[Store group]
LEFT JOIN DPS_Code_allocation_table dpa
  ON dpa.DPS_Code = ii.DPS_Code AND dpa.StoreGroup = psg.[Store group]
LEFT JOIN EcommerceAllocationRequest eco
  ON eco.ItemCode = ir.ItemCode AND sd.[Code #] = '470'
WHERE sd.[E-ACTIVE] = 1 AND sd.[Code #] <> '000'; -- '000' is the Dallas DC itself, not a ship-to store
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
  ISNULL(oh.QTY, 0) AS OnHandQty,
  0 AS InTransitQty,
  CASE
    WHEN a.AllowSend = 'N' THEN 0
    WHEN b.StoreCode = '470' THEN b.BaseAllocationQty
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
