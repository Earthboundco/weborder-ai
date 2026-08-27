const { sql, getPool } = require('../db');

async function main() {
  const pool = await getPool();

  const tables = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM EBT.INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  tables.recordset.forEach(r => console.log(`${r.TABLE_SCHEMA}.${r.TABLE_NAME}\t(${r.TABLE_TYPE})`));

  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
