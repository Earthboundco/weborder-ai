// Exports Final_Allocation_Results.csv - the actual weekly output for allocation/shipping.
// Long format: StoreCode, ItemCode, Qty (= FinalAllocationQty). Only rows with a nonzero
// shipment are included - a store/item combo with nothing to ship isn't actionable output.
//
// Usage: node scripts/export-final-allocation-results.js [output.csv]
// Defaults to Claude_results/<MM-DD-YY>-Final_Allocation_Results.csv (Wesley's naming
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
  const outFile = process.argv[2] || path.join(outDir, `${todayDateStr()}-Final_Allocation_Results.csv`);

  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT StoreCode, ItemCode, FinalAllocationQty AS Qty
    FROM AllocationResults
    WHERE FinalAllocationQty > 0
    ORDER BY StoreCode, ItemCode
  `);
  const rows = result.recordset;

  const headers = ['StoreCode', 'ItemCode', 'Qty'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => row[h]).join(','));
  }

  fs.writeFileSync(path.resolve(outFile), lines.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length} row(s) to ${outFile}`);

  await sql.close();
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
