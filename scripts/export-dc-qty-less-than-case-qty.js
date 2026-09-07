// Exports DCQty_Less_than_CaseQty.csv - items with a genuinely stuck DC backstock fragment
// after this week's allocation (2026-09-06, replaces the earlier DC_ItemsCheck_NotCaseMultiple
// export, per Wesley). Long format: ItemCode, DCLeftOverQty, DCQtyLessThanCaseQty.
//
// DCLeftOverQty is the item's DC backstock remaining after allocation (LeftoverQty in
// AllocationResults). DCQtyLessThanCaseQty = 'Y' only when 0 < DCLeftOverQty < case qty - a
// genuine stuck fragment too small to ever ship as a full case. LeftoverQty = 0 (nothing left
// over, perfect utilization) is NOT flagged - per Wesley, only a real nonzero fragment counts.
//
// Usage: node scripts/export-dc-qty-less-than-case-qty.js [output.csv]
// Defaults to DCQty_Less_than_CaseQty.csv in the current directory.
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

async function main() {
  const outFile = process.argv[2] || 'DCQty_Less_than_CaseQty.csv';

  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT ItemCode, MAX(LeftoverQty) AS DCLeftOverQty
    FROM AllocationResults
    GROUP BY ItemCode
    HAVING MAX(LeftoverQty) > 0 AND MAX(LeftoverQty) < MAX(QTY_PER_CASE)
    ORDER BY ItemCode
  `);
  const rows = result.recordset;

  const headers = ['ItemCode', 'DCLeftOverQty', 'DCQtyLessThanCaseQty'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push([row.ItemCode, row.DCLeftOverQty, 'Y'].join(','));
  }

  fs.writeFileSync(path.resolve(outFile), lines.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length} row(s) to ${outFile}`);

  await sql.close();
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
