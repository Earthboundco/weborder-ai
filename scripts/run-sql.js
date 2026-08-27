const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/run-sql.js <path-to-sql-file>');
    process.exit(1);
  }
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  const batches = text.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);

  const pool = await getPool();
  for (const batch of batches) {
    await pool.request().query(batch);
  }
  console.log(`Executed ${batches.length} batch(es) from ${file}`);
  await sql.close();
}

main().catch(err => {
  console.error('SQL execution failed:', err.message);
  process.exit(1);
});
