-- Rolls the 12 individual rule results from vw_ExclusionEvaluation into a single
-- AllowSend flag: 'Y' only if every rule passed for that item/store combination.
CREATE VIEW vw_ItemStoreAllowSend AS
SELECT
  e.*,
  CASE WHEN 'N' IN (e.Exc1, e.Exc2, e.Exc3, e.Exc4, e.Exc5, e.Exc6, e.Exc7, e.Exc8, e.Exc9, e.Exc10, e.Exc11, e.Exc12)
       THEN 'N' ELSE 'Y' END AS AllowSend
FROM vw_ExclusionEvaluation e;
GO
