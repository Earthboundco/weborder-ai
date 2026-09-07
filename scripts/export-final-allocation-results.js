// Exports Final_Allocation_Results.csv - the actual weekly output for allocation/shipping.
// Long format: StoreCode, ItemCode, Qty (= FinalAllocationQty). Only rows with a nonzero
// shipment are included - a store/item combo with nothing to ship isn't actionable output.
//
// Usage: node scripts/export-final-allocation-results.js [output.csv]
// Defaults to Final_Allocation_Results.csv in the current directory.
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

async function main() {
  const outFile = process.argv[2] || 'Final_Allocation_Results.csv';

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
