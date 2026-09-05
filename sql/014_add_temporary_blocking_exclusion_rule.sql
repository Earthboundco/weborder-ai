-- New exclusion rule (2026-09-05/06, per Wesley): "Temporary Blocking". Used while testing an
-- item at selected locations only - the item is kept in DC stock but temporarily blocked from
-- every store NOT part of the test. Once the test concludes, the blocks for that item are
-- removed (rows deleted from the source file) and it opens up to all stores normally.
--
-- Table: Temporary_Blocking (Store, Item, Status) - business Store Code + plain item code, per
-- Wesley. Rule: if Status = 'Block' for a (Store, Item) pair, block allocation entirely. No row
-- for a pair means no block (consistent with Exc13's "no data does not mean blocked"
-- convention). Refreshes weekly or every other week via scripts/import-temporary-blocking.js
-- (truncate/reload) - Wesley confirmed all 493 rows in the initial file are Status='Block'
-- (no other status value currently in use), covering 7 items across 119 stores.
--
-- Adds as Exc14, following the existing 13-rule pattern exactly: metadata row in
-- ExclusionRules, a column in vw_ExclusionEvaluation, rolled into vw_ItemStoreAllowSend's
-- AllowSend check.

CREATE TABLE Temporary_Blocking (
  Store        varchar(50) NOT NULL,
  Item         nvarchar(8) NOT NULL,
  Status       varchar(20) NOT NULL,
  ImportedDate datetime    NOT NULL DEFAULT GETDATE(),
  CONSTRAINT PK_Temporary_Blocking PRIMARY KEY CLUSTERED (Store, Item)
);
GO

INSERT INTO ExclusionRules (RuleCode, RuleName, Description) VALUES
('Exc14', 'Temporary Blocking', 'Block item/store combinations flagged Status = Block in Temporary_Blocking - used while an item is being tested at selected locations only.');
GO

DROP VIEW vw_ItemStoreAllowSend;
GO

DROP VIEW vw_ExclusionEvaluation;
GO

CREATE VIEW vw_ExclusionEvaluation AS
SELECT
  ir.ItemCode,
  ii.ITEM_NO,
  ii.DCS_CODE,
  ii.DESCRIPTION1,
  sd.[Code #] AS StoreCode,

  CASE WHEN ra.Exc1 = 0 THEN 'Y'
       WHEN sd.WStoreType IS NULL OR RTRIM(sd.WStoreType) = '' THEN 'N' ELSE 'Y' END AS Exc1,

  CASE WHEN ra.Exc2 = 0 THEN 'Y'
       WHEN RTRIM(ii.EBT_STR) = 'No' AND sd.[Code #] <> '470' THEN 'N' ELSE 'Y' END AS Exc2,

  CASE WHEN ra.Exc3 = 0 THEN 'Y'
       WHEN RTRIM(ii.ONLINE_STR) = 'No' AND sd.[Code #] = '470' THEN 'N' ELSE 'Y' END AS Exc3,

  CASE WHEN ra.Exc4 = 0 THEN 'Y'
       WHEN RTRIM(ii.EBTMKD) = 'Yes_MD' AND (
              sd.WStoreSize IN ('1-IttyBitty', '2-XSm')
              OR sd.WStoreType = 'Fashion Focus'
              OR sd.[Code #] = '479'
              OR DATEDIFF(day, sd.[OPEN], GETDATE()) < 60
            ) THEN 'N' ELSE 'Y' END AS Exc4,

  CASE WHEN ra.Exc5 = 0 THEN 'Y'
       WHEN RTRIM(ii.PROP65FAIL) = 'Fail' AND (sd.STATE = 'CA' OR sd.[Code #] = '470') THEN 'N' ELSE 'Y' END AS Exc5,

  CASE WHEN ra.Exc6 = 0 THEN 'Y'
       WHEN ii.DCS_CODE LIKE '%HD WD%' AND ii.DESCRIPTION1 LIKE '%CANVAS%'
            AND sd.WStoreSize IN ('1-IttyBitty', '2-XSm') THEN 'N' ELSE 'Y' END AS Exc6,

  CASE WHEN ra.Exc7 = 0 THEN 'Y'
       WHEN ii.DCS_CODE = 'HD WD AC' AND ii.DESCRIPTION1 LIKE '%CURTAIN%'
            AND (sd.WStoreSize = '1-IttyBitty' OR sd.[Code #] IN ('420', '485')) THEN 'N' ELSE 'Y' END AS Exc7,

  CASE WHEN ra.Exc8 = 0 THEN 'Y'
       WHEN sd.WStoreSize = '1-IttyBitty' AND ii.ITEM_NO IN (0, 10731) THEN 'N' ELSE 'Y' END AS Exc8,

  CASE WHEN ra.Exc9 = 0 THEN 'Y'
       WHEN ii.DCS_CODE = 'AC WO SU' AND (sd.STATE = 'CA' OR sd.[Code #] = '470') THEN 'N' ELSE 'Y' END AS Exc9,

  CASE WHEN ra.Exc10 = 0 THEN 'Y'
       WHEN ii.IStatus IS NULL OR ii.IStatus <> 'FashionFocusStore' THEN 'Y'
       WHEN sd.WStoreType = 'Fashion Focus' OR sd.[Code #] IN ('376', '470') THEN 'Y'
       ELSE 'N' END AS Exc10,

  CASE WHEN ra.Exc11 = 0 THEN 'Y'
       WHEN (sd.WStoreType = 'Fashion Focus' OR sd.[Code #] = '479')
            AND ii.DCS_CODE IN ('AS IB', 'AS OB', 'AS OI', 'AS SS', 'HD DO CD', 'HD TP', 'IM BK') THEN 'N' ELSE 'Y' END AS Exc11,

  CASE WHEN ra.Exc12 = 0 THEN 'Y'
       WHEN (sd.WStoreType = 'Fashion Focus' OR sd.[Code #] = '479') AND (
              (ii.DCS_CODE = 'AS IN MI' AND ii.ITEM_NO <> 16472)
              OR (ii.DCS_CODE = 'AS IN SC' AND (iv.VEND_CODE IS NULL OR RTRIM(iv.VEND_CODE) <> 'V01072'))
              OR (ii.DCS_CODE = 'HD DO DA' AND ii.ITEM_NO <> 34299)
              OR (ii.DCS_CODE = 'HD RM' AND ii.ITEM_NO NOT IN (49926, 83231, 83232, 83233, 83234, 53406, 53407, 53408, 53410, 58609, 60971, 64252, 65818, 65819, 74166, 74167))
              OR (ii.DCS_CODE = 'HD TX' AND ii.ITEM_NO <> 28063)
              OR (ii.DCS_CODE = 'HD WD AC' AND ii.DESCRIPTION1 NOT LIKE '%WALL BANNER%')
            ) THEN 'N' ELSE 'Y' END AS Exc12,

  CASE WHEN ra.Exc13 = 0 THEN 'Y'
       WHEN si.MinQty = 999 AND si.MaxQty = 999 THEN 'N' ELSE 'Y' END AS Exc13,

  CASE WHEN ra.Exc14 = 0 THEN 'Y'
       WHEN tb.Status = 'Block' THEN 'N' ELSE 'Y' END AS Exc14

FROM ItemReplenishment ir
JOIN ItemInformationComplete ii ON ii.ITEM_NO = CAST(ir.ItemCode AS decimal)
LEFT JOIN EBT.dbo.INVENTORY iv ON iv.ITEM_NO = ii.ITEM_NO
CROSS JOIN EBT.dbo.[Store Directory] sd
LEFT JOIN StoreItemInventory si ON si.ItemCode = ir.ItemCode AND si.StoreCode = sd.[Code #]
LEFT JOIN Temporary_Blocking tb ON tb.Item = ir.ItemCode AND tb.Store = sd.[Code #]
CROSS JOIN (
  SELECT
    MAX(CASE WHEN RuleCode = 'Exc1'  THEN CAST(IsActive AS int) END) AS Exc1,
    MAX(CASE WHEN RuleCode = 'Exc2'  THEN CAST(IsActive AS int) END) AS Exc2,
    MAX(CASE WHEN RuleCode = 'Exc3'  THEN CAST(IsActive AS int) END) AS Exc3,
    MAX(CASE WHEN RuleCode = 'Exc4'  THEN CAST(IsActive AS int) END) AS Exc4,
    MAX(CASE WHEN RuleCode = 'Exc5'  THEN CAST(IsActive AS int) END) AS Exc5,
    MAX(CASE WHEN RuleCode = 'Exc6'  THEN CAST(IsActive AS int) END) AS Exc6,
    MAX(CASE WHEN RuleCode = 'Exc7'  THEN CAST(IsActive AS int) END) AS Exc7,
    MAX(CASE WHEN RuleCode = 'Exc8'  THEN CAST(IsActive AS int) END) AS Exc8,
    MAX(CASE WHEN RuleCode = 'Exc9'  THEN CAST(IsActive AS int) END) AS Exc9,
    MAX(CASE WHEN RuleCode = 'Exc10' THEN CAST(IsActive AS int) END) AS Exc10,
    MAX(CASE WHEN RuleCode = 'Exc11' THEN CAST(IsActive AS int) END) AS Exc11,
    MAX(CASE WHEN RuleCode = 'Exc12' THEN CAST(IsActive AS int) END) AS Exc12,
    MAX(CASE WHEN RuleCode = 'Exc13' THEN CAST(IsActive AS int) END) AS Exc13,
    MAX(CASE WHEN RuleCode = 'Exc14' THEN CAST(IsActive AS int) END) AS Exc14
  FROM ExclusionRules
) ra
WHERE sd.[E-ACTIVE] = 1 AND sd.[Code #] <> '000'; -- '000' is the Dallas DC itself, not a ship-to store
GO

CREATE VIEW vw_ItemStoreAllowSend AS
SELECT
  e.*,
  CASE WHEN 'N' IN (e.Exc1, e.Exc2, e.Exc3, e.Exc4, e.Exc5, e.Exc6, e.Exc7, e.Exc8, e.Exc9, e.Exc10, e.Exc11, e.Exc12, e.Exc13, e.Exc14)
       THEN 'N' ELSE 'Y' END AS AllowSend
FROM vw_ExclusionEvaluation e;
GO
