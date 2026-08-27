-- For every (item in ItemReplenishment) x (active store), resolves:
--   - which DCS Pattern the item belongs to
--   - which Store Group that store falls into for that pattern
--   - the base allocation qty for that group (item-specific override, falling back to DPS-code level)
-- NOTE: EBT.dbo.[Store Directory].[ID #] is the internal store number used by inventory tables
-- (INV_SBS_QTY_V_EXT.STORE_NO, DC_QTY.STORE_NO, etc). [Code #] is the human-facing store code used
-- in Pattern_Store_Group and everywhere else in this schema. Don't confuse the two.
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
  COALESCE(ica.AllocationQty, dpa.AllocationQty, 0) AS BaseAllocationQty
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
WHERE sd.[E-ACTIVE] = 1 AND sd.[Code #] <> '000'; -- '000' is the Dallas DC itself, not a ship-to store
GO
