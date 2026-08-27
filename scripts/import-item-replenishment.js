const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-item-replenishment.js <path-to-xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(file));
  const sheet = workbook.getWorksheet('Items');
  if (!sheet) {
    console.error('No "Items" sheet found in workbook');
    process.exit(1);
  }

  let itemCol = null;
  let dcQtyCol = null;
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (!itemCol) {
      row.eachCell((cell, colNumber) => {
        if (cell.value === 'Item #') itemCol = colNumber;
        if (cell.value === 'DC Supply') dcQtyCol = colNumber;
      });
      return;
    }
    const itemCode = row.getCell(itemCol).value;
    const dcQty = row.getCell(dcQtyCol).value;
    if (typeof itemCode === 'number' && typeof dcQty === 'number') {
      rows.push({ itemCode: String(itemCode), dcQty });
    }
  });

  if (!itemCol || !dcQtyCol) {
    console.error('Could not find "Item #" / "DC Supply" header row in sheet.');
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
    await new sql.Request(tx).query('TRUNCATE TABLE ItemReplenishment');
    for (const r of rows) {
      await new sql.Request(tx)
        .input('itemCode', sql.NVarChar(8), r.itemCode)
        .input('dcQty', sql.Int, r.dcQty)
        .query('INSERT INTO ItemReplenishment (ItemCode, DC_Qty) VALUES (@itemCode, @dcQty)');
    }
    await tx.commit();
    console.log(`Imported ${rows.length} items into ItemReplenishment from ${file}`);
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
