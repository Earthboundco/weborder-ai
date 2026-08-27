-- Evaluates all 12 exclusion rules for every (item in this week's ItemReplenishment) x (active store)
-- combination. AllowSend = 'Y' only when every active rule passes.
--
-- Rule IsActive flags are pulled once via the `ra` cross join instead of a correlated subquery
-- per rule per row - on the ~114k item x store rows this runs against, 12 correlated subqueries
-- per row took 11+ seconds; this form is effectively instant.
--
-- VEND_CODE (needed only for Exc12) is pulled from EBT.dbo.INVENTORY (a base table) rather than
-- EBT.dbo.Inventory_V_AUX (a view) - joining Inventory_V_AUX for just 788 items took ~12s on its
-- own on this server, vs <50ms against INVENTORY. Same ITEM_NO -> VEND_CODE data, much cheaper.
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
            ) THEN 'N' ELSE 'Y' END AS Exc12

FROM ItemReplenishment ir
JOIN ItemInformationComplete ii ON ii.ITEM_NO = CAST(ir.ItemCode AS decimal)
LEFT JOIN EBT.dbo.INVENTORY iv ON iv.ITEM_NO = ii.ITEM_NO
CROSS JOIN EBT.dbo.[Store Directory] sd
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
    MAX(CASE WHEN RuleCode = 'Exc12' THEN CAST(IsActive AS int) END) AS Exc12
  FROM ExclusionRules
) ra
WHERE sd.[E-ACTIVE] = 1 AND sd.[Code #] <> '000'; -- '000' is the Dallas DC itself, not a ship-to store
GO
