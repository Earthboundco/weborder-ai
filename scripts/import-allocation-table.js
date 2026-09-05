// Imports the weekly Item_Code_allocation_table / DPS_Code_allocation_table exports.
// Source files are "wide" (one row per key, one column per store group: A1/A2/A3/B/C/D/E) -
// this unpivots them into the "long" shape the actual DB tables use (key, StoreGroup,
// AllocationQty), same as the existing tables were originally loaded in.
//
// Usage:
//   node scripts/import-allocation-table.js item "assets/Item_Code_allocation_table.xlsx"
//   node scripts/import-allocation-table.js dps  "assets/DPS_Code_allocation_table.xlsx"
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

const GROUP_COLUMNS = ['A1', 'A2', 'A3', 'B', 'C', 'D', 'E'];

const CONFIGS = {
  item: {
    table: 'Item_Code_allocation_table',
    keyHeader: 'Item_Code',
    keyColumn: 'ItemCode',
    keySqlType: sql.Int,
    parseKey: (v) => (typeof v === 'number' ? v : null),
  },
  dps: {
    table: 'DPS_Code_allocation_table',
    keyHeader: 'DPS_Code',
    keyColumn: 'DPS_Code',
    keySqlType: sql.NVarChar(50),
    parseKey: (v) => (typeof v === 'string' && v.length ? v : null),
  },
};

async function main() {
  const kind = process.argv[2];
  const file = process.argv[3];
  const config = CONFIGS[kind];
  if (!config || !file) {
    console.error('Usage: node scripts/import-allocation-table.js <item|dps> <path-to-xlsx>');
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
  if (header.getCell(1).value !== config.keyHeader) {
    console.error(`Expected header cell A1 to be "${config.keyHeader}", got ${JSON.stringify(header.getCell(1).value)}`);
    process.exit(1);
  }
  const groupColIndex = {};
  header.eachCell((cell, colNumber) => {
    if (GROUP_COLUMNS.includes(cell.value)) groupColIndex[cell.value] = colNumber;
  });
  const missing = GROUP_COLUMNS.filter(g => !groupColIndex[g]);
  if (missing.length) {
    console.error(`Missing store-group column(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const key = config.parseKey(row.getCell(1).value);
    if (key === null) return;
    for (const group of GROUP_COLUMNS) {
      const qty = row.getCell(groupColIndex[group]).value;
      if (typeof qty === 'number') {
        rows.push({ key, group, qty });
      }
    }
  });

  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query(`TRUNCATE TABLE ${config.table}`);

  const table = new sql.Table(config.table);
  table.create = false;
  table.columns.add(config.keyColumn, config.keySqlType, { nullable: false });
  table.columns.add('StoreGroup', sql.NVarChar(5), { nullable: false });
  table.columns.add('AllocationQty', sql.Int, { nullable: true });
  for (const r of rows) {
    table.rows.add(r.key, r.group, r.qty);
  }

  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows (unpivoted) into ${config.table} from ${file}`);

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
