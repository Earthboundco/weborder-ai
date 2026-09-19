// Exports the DC_Qty_Less_than_Case_Qty report - items with a genuinely stuck DC backstock
// fragment after this week's allocation (2026-09-06, replaces the earlier
// DC_ItemsCheck_NotCaseMultiple export, per Wesley). Long format: ItemCode, DCLeftOverQty,
// DCQtyLessThanCaseQty.
//
// DCLeftOverQty is the item's DC backstock remaining after allocation (LeftoverQty in
// AllocationResults). DCQtyLessThanCaseQty = 'Y' only when 0 < DCLeftOverQty < case qty - a
// genuine stuck fragment too small to ever ship as a full case. LeftoverQty = 0 (nothing left
// over, perfect utilization) is NOT flagged - per Wesley, only a real nonzero fragment counts.
//
// Usage: node scripts/export-dc-qty-less-than-case-qty.js [output.csv]
// Defaults to Claude_results/<MM-DD-YY>-DC_Qty_Less_than_Case_Qty.csv (Wesley's naming
// convention, 2026-09-19 - date prefix, Claude_results/ is where all delivered files live).
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

function todayDateStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}-${dd}-${yy}`;
}

async function main() {
  const outDir = path.resolve('Claude_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = process.argv[2] || path.join(outDir, `${todayDateStr()}-DC_Qty_Less_than_Case_Qty.csv`);

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
