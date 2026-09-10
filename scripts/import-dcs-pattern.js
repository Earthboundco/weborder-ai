// Imports DCS_Pattern (DCS Code -> DCS Pattern). Per docs/data-sources.md "Update cadence &
// ownership", this updates eventually/never - only when a new DCS Code or Pattern is
// introduced. Truncate/reload, same pattern as the other reference tables.
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-dcs-pattern.js <path-to-xlsx>');
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
  let codeCol = null, patternCol = null;
  header.eachCell((cell, colNumber) => {
    if (cell.value === 'DCS Code') codeCol = colNumber;
    if (cell.value === 'DCS pattern') patternCol = colNumber;
  });
  if (!codeCol || !patternCol) {
    console.error('Could not find "DCS Code" / "DCS pattern" header row in sheet.');
    process.exit(1);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = row.getCell(codeCol).value;
    const pattern = row.getCell(patternCol).value;
    if (typeof code === 'string' && typeof pattern === 'string') {
      rows.push({ code, pattern });
    }
  });

  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query('TRUNCATE TABLE DCS_Pattern');

  const table = new sql.Table('DCS_Pattern');
  table.create = false;
  table.columns.add('DCS Code', sql.VarChar(50), { nullable: true });
  table.columns.add('DCS pattern', sql.VarChar(50), { nullable: true });
  for (const r of rows) {
    table.rows.add(r.code, r.pattern);
  }

  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows into DCS_Pattern from ${file}`);

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
