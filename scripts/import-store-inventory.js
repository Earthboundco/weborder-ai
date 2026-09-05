// Imports the weekly on-hand + in-transit qty export (e.g. assets/Stores_Qtys_and_MinMax.xlsx)
// into StoreItemInventory. Unlike import-item-replenishment.js / import-ecommerce-allocation.js,
// this uses a bulk insert (via mssql's Table/bulk API) instead of one INSERT per row - the source
// file is ~114k rows (item x store), and row-by-row inserts at that scale would take far too long.
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-store-inventory.js <path-to-xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(file));
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error('No worksheet found in workbook');
    process.exit(1);
  }

  let storeCol = null, itemCol = null, onHandCol = null, inTransitCol = null, minCol = null, maxCol = null;
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (!storeCol) {
      // header row - title is row 1, so don't lock in until we've actually found the headers
      row.eachCell((cell, colNumber) => {
        if (cell.value === 'Store_Code') storeCol = colNumber;
        if (cell.value === 'Item_number') itemCol = colNumber;
        if (cell.value === 'On-Hand_qty') onHandCol = colNumber;
        if (cell.value === 'In-Transit_qty') inTransitCol = colNumber;
        if (cell.value === 'Min_qty') minCol = colNumber;
        if (cell.value === 'Max_qty') maxCol = colNumber;
      });
      return;
    }
    const storeCode = row.getCell(storeCol).value;
    const itemNo = row.getCell(itemCol).value;
    const onHand = row.getCell(onHandCol).value;
    const inTransit = row.getCell(inTransitCol).value;
    const minQ = minCol ? row.getCell(minCol).value : null;
    const maxQ = maxCol ? row.getCell(maxCol).value : null;

    if ((typeof storeCode === 'string' || typeof storeCode === 'number') && typeof itemNo === 'number') {
      rows.push({
        itemCode: String(itemNo),
        storeCode: String(storeCode),
        onHandQty: typeof onHand === 'number' ? onHand : 0,
        inTransitQty: typeof inTransit === 'number' ? inTransit : 0,
        minQty: typeof minQ === 'number' ? minQ : null,
        maxQty: typeof maxQ === 'number' ? maxQ : null,
      });
    }
  });

  if (!storeCol || !itemCol || !onHandCol || !inTransitCol) {
    console.error('Could not find required header row (Store_Code / Item_number / On-Hand_qty / In-Transit_qty).');
    process.exit(1);
  }
  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query('TRUNCATE TABLE StoreItemInventory');

  const table = new sql.Table('StoreItemInventory');
  table.create = false;
  table.columns.add('ItemCode', sql.NVarChar(8), { nullable: false });
  table.columns.add('StoreCode', sql.VarChar(50), { nullable: false });
  table.columns.add('OnHandQty', sql.Int, { nullable: false });
  table.columns.add('InTransitQty', sql.Int, { nullable: false });
  table.columns.add('MinQty', sql.Int, { nullable: true });
  table.columns.add('MaxQty', sql.Int, { nullable: true });
  for (const r of rows) {
    table.rows.add(r.itemCode, r.storeCode, r.onHandQty, r.inTransitQty, r.minQty, r.maxQty);
  }

  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows into StoreItemInventory from ${file}`);

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
