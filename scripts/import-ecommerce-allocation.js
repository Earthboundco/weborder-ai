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
  const sheet = workbook.getWorksheet('Review');
  if (!sheet) {
    console.error('No "Review" sheet found in workbook');
    process.exit(1);
  }

  let itemCol = null;
  let finalQtyCol = null;
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (!itemCol) {
      row.eachCell((cell, colNumber) => {
        if (cell.value === 'Item') itemCol = colNumber;
        if (cell.value === 'Ecommerce final allocation') finalQtyCol = colNumber;
      });
      return;
    }
    const itemCode = row.getCell(itemCol).value;
    const qty = row.getCell(finalQtyCol).value;
    if (typeof itemCode === 'number' && typeof qty === 'number' && qty > 0) {
      rows.push({ itemCode: String(itemCode), qty });
    }
  });

  if (!itemCol || !finalQtyCol) {
    console.error('Could not find "Item" / "Ecommerce final allocation" header row in sheet.');
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
