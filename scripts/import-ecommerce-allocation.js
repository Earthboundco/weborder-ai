// Imports the weekly store-470 (Ecommerce) allocation request. As of 2026-09-05, source is a
// simplified 3-column file (Store/Item/Qty, header row 1) instead of Wesley's full buyer-review
// workbook - Store is expected to always be 470 (this table has no store column; it's implicitly
// always 470 downstream, see sql/009), checked here as a sanity guard, not stored.
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-ecommerce-allocation.js <path-to-xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(file));
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error('No worksheet found in workbook');
    process.exit(1);
  }

  const header = sheet.getRow(1);
  let storeCol = null, itemCol = null, qtyCol = null;
  header.eachCell((cell, colNumber) => {
    if (cell.value === 'Store') storeCol = colNumber;
    if (cell.value === 'Item') itemCol = colNumber;
    if (cell.value === 'Qty') qtyCol = colNumber;
  });
  if (!storeCol || !itemCol || !qtyCol) {
    console.error('Could not find "Store" / "Item" / "Qty" header row in sheet.');
    process.exit(1);
  }

  const rows = [];
  let badStoreRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const store = row.getCell(storeCol).value;
    const itemCode = row.getCell(itemCol).value;
    const qty = row.getCell(qtyCol).value;
    if (typeof itemCode !== 'number' || typeof qty !== 'number' || qty <= 0) return;
    if (String(store) !== '470') { badStoreRows++; return; }
    rows.push({ itemCode: String(itemCode), qty });
  });

  if (badStoreRows) {
    console.error(`Found ${badStoreRows} row(s) with Store <> 470 - this file should only contain store 470 (Ecommerce) requests. Aborting without touching the table.`);
    process.exit(1);
  }

  if (!rows.length) {
    console.error('No item rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query('TRUNCATE TABLE EcommerceAllocationRequest');
    for (const r of rows) {
      await new sql.Request(tx)
        .input('itemCode', sql.NVarChar(8), r.itemCode)
        .input('qty', sql.Int, r.qty)
        .query('INSERT INTO EcommerceAllocationRequest (ItemCode, RequestedQty) VALUES (@itemCode, @qty)');
    }
    await tx.commit();
    console.log(`Imported ${rows.length} items into EcommerceAllocationRequest from ${file}`);
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
