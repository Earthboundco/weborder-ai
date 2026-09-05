// Imports Temporary_Blocking (Store, Item, Status) - the Exc14 "Temporary Blocking" exclusion
// rule's source. Refreshes weekly or every other week per Wesley, truncate/reload like the
// other exclusion-feeding table (StoreItemInventory for Exc13).
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-temporary-blocking.js <path-to-xlsx>');
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
  let storeCol = null, itemCol = null, statusCol = null;
  header.eachCell((cell, colNumber) => {
    if (cell.value === 'Store') storeCol = colNumber;
    if (cell.value === 'Item') itemCol = colNumber;
    if (cell.value === 'Status') statusCol = colNumber;
  });
  if (!storeCol || !itemCol || !statusCol) {
    console.error('Could not find "Store" / "Item" / "Status" header row in sheet.');
    process.exit(1);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const store = row.getCell(storeCol).value;
    const item = row.getCell(itemCol).value;
    const status = row.getCell(statusCol).value;
    if ((typeof store === 'string' || typeof store === 'number') && typeof item === 'number' && typeof status === 'string') {
      rows.push({ store: String(store), item: String(item), status });
    }
  });

  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query('TRUNCATE TABLE Temporary_Blocking');

  const table = new sql.Table('Temporary_Blocking');
  table.create = false;
  table.columns.add('Store', sql.VarChar(50), { nullable: false });
  table.columns.add('Item', sql.NVarChar(8), { nullable: false });
  table.columns.add('Status', sql.VarChar(20), { nullable: false });
  for (const r of rows) {
    table.rows.add(r.store, r.item, r.status);
  }

  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows into Temporary_Blocking from ${file}`);

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
