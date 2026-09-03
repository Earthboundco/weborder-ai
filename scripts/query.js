require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/query.js <path-to-sql-file> [--csv <output.csv>]');
    process.exit(1);
  }
  const csvIdx = process.argv.indexOf('--csv');
  const csvOut = csvIdx !== -1 ? process.argv[csvIdx + 1] : null;

  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const pool = await getPool();
  const result = await pool.request().query(text);
  const rows = result.recordset || [];

  console.log(`${rows.length} row(s):`);
  console.table(rows);

  if (csvOut) {
    if (rows.length) {
      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        csvLines.push(headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const s = String(val).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        }).join(','));
      }
      fs.writeFileSync(path.resolve(csvOut), csvLines.join('\n'), 'utf8');
      console.log(`Wrote ${rows.length} row(s) to ${csvOut}`);
    } else {
      console.log('No rows returned - nothing written to CSV.');
    }
  }

  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
