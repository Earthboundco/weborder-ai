// Total quantity and total value (qty x item's CURRENT sale price) of one or more allocation CSVs
// (StoreCode,ItemCode,Qty). Wesley asked on 2026-11-15 to be told these two numbers every time the
// weborder is run. The price is Item_Information_Complete_for_Replenishment.SalePrice, i.e. SAP's
// current sale price as loaded by the last import.
//
// Usage: node scripts/allocation-totals.js <file.csv> [more.csv ...]
const fs = require('fs');
const { sql, getPool } = require('../db');

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node scripts/allocation-totals.js <file.csv> [more.csv ...]');
    process.exit(1);
  }
  const pool = await getPool();
  const price = {};
  (await pool.request().query('SELECT ITEM_NO, SalePrice FROM Item_Information_Complete_for_Replenishment'))
    .recordset.forEach(r => { price[String(r.ITEM_NO)] = Number(r.SalePrice); });

  for (const f of files) {
    const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(','));
    let qty = 0, value = 0;
    const noPrice = new Set();
    for (const [, item, q] of rows) {
      const p = price[item];
      if (p === undefined || !Number.isFinite(p)) { noPrice.add(item); continue; }
      qty += Number(q);
      value += Number(q) * p;
    }
    console.log(`${f}\n  lines ${rows.length}  total qty ${qty}  total value $${value.toFixed(2)}` +
      (noPrice.size ? `  (WARNING ${noPrice.size} item(s) without a price: ${[...noPrice].join(', ')})` : ''));
  }
  await sql.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
