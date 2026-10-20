// SAP HANA counterpart of scripts/query.js: runs a read-only SQL file against HANA (hana.js) and
// prints the rows, optionally writing them to CSV. Default schema is HANA_SCHEMA (REPORTUSER);
// qualify other schemas explicitly, e.g. "EARTHBOUND"."OITW".
//
// Usage: node scripts/hana-query.js <path-to-sql-file> [--csv <output.csv>]
const fs = require('fs');
const path = require('path');
const { hanaQuery, closeHana } = require('../hana');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/hana-query.js <path-to-sql-file> [--csv <output.csv>]');
    process.exit(1);
  }
  const csvIdx = process.argv.indexOf('--csv');
  const csvOut = csvIdx !== -1 ? process.argv[csvIdx + 1] : null;

  const text = fs.readFileSync(path.resolve(file), 'utf8').trim().replace(/;\s*$/, '');
  const rows = await hanaQuery(text);

  console.log(`${rows.length} row(s):`);
  console.table(rows.slice(0, 200));
  if (rows.length > 200) console.log(`(showing first 200 of ${rows.length})`);

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
}

main()
  .catch(err => { console.error('Query failed:', err.message); process.exitCode = 1; })
  .finally(closeHana);
