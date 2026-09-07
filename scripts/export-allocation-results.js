// Exports the final weekly allocation as a CSV: one row per item/store combo that actually
// ships something (FinalAllocationQty > 0). Pass --all to include every row (all 144 stores x
// every item, including zeros) instead.
//
// Usage:
//   node scripts/export-allocation-results.js <output.csv> [--all]
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

async function main() {
  const outFile = process.argv[2];
  const includeAll = process.argv.includes('--all');
  if (!outFile) {
    console.error('Usage: node scripts/export-allocation-results.js <output.csv> [--all]');
    process.exit(1);
  }

  const pool = await getPool();
  const query = `
    SELECT
      ar.ItemCode, ii.DESCRIPTION1 AS ItemDescription, ar.DCS_CODE,
      ar.StoreCode, ar.FinalAllocationQty, ar.DC_Qty, ar.LeftoverQty, ar.DCQtyNotCaseMultiple
    FROM AllocationResults ar
    LEFT JOIN ItemInformationComplete ii ON ii.ITEM_NO = ar.ITEM_NO
    ${includeAll ? '' : 'WHERE ar.FinalAllocationQty > 0'}
    ORDER BY ar.ItemCode, ar.StoreCode
  `;
  const result = await pool.request().query(query);
  const rows = result.recordset;

  const headers = ['ItemCode', 'ItemDescription', 'DCS_CODE', 'StoreCode', 'FinalAllocationQty', 'DC_Qty', 'LeftoverQty', 'DCQtyNotCaseMultiple'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return '';
      const s = String(val).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(','));
  }

  fs.writeFileSync(path.resolve(outFile), lines.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length} row(s) to ${outFile}${includeAll ? ' (all rows, including zeros)' : ' (nonzero shipments only)'}`);

  await sql.close();
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
