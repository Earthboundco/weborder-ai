// Imports Pattern_Store_Group (DCS pattern, Store code, Store group, Rank). Refreshes every
// 6-8 weeks per Wesley, not weekly like the other five inputs, but same truncate+reload pattern.
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

const EXPECTED_HEADER = ['DCS pattern', 'Store code', 'Store group', 'Rank'];

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-pattern-store-group.js <path-to-xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(file));
  const sheet = workbook.getWorksheet('Pattern_Store_Group') || workbook.worksheets[0];
  if (!sheet) {
    console.error('No worksheet found in workbook');
    process.exit(1);
  }

  const header = sheet.getRow(1);
  const actualHeader = EXPECTED_HEADER.map((_, i) => header.getCell(i + 1).value);
  if (JSON.stringify(actualHeader) !== JSON.stringify(EXPECTED_HEADER)) {
    console.error(`Expected header row ${JSON.stringify(EXPECTED_HEADER)}, got ${JSON.stringify(actualHeader)}`);
    process.exit(1);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const pattern = row.getCell(1).value;
    const store = row.getCell(2).value;
    const group = row.getCell(3).value;
    const rank = row.getCell(4).value;
    if (typeof pattern === 'string' && (typeof store === 'string' || typeof store === 'number') && typeof group === 'string') {
      rows.push({
        pattern,
        store: String(store),
        group,
        rank: typeof rank === 'number' ? rank : null,
      });
    }
  });

  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query('TRUNCATE TABLE Pattern_Store_Group');

  const table = new sql.Table('Pattern_Store_Group');
  table.create = false;
  table.columns.add('DCS pattern', sql.VarChar(50), { nullable: true });
  table.columns.add('Store code', sql.VarChar(50), { nullable: true });
  table.columns.add('Store group', sql.VarChar(50), { nullable: true });
  table.columns.add('Rank', sql.Int, { nullable: true });
  for (const r of rows) {
    table.rows.add(r.pattern, r.store, r.group, r.rank);
  }

  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows into Pattern_Store_Group from ${file}`);

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
