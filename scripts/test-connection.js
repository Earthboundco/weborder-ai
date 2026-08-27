const { sql, getPool } = require('../db');

async function main() {
  const pool = await getPool();

  const version = await pool.request().query('SELECT @@VERSION AS version');
  console.log('Connected. SQL Server version:');
  console.log(version.recordset[0].version);

  const currentDb = await pool.request().query('SELECT DB_NAME() AS db');
  console.log('\nCurrent database:', currentDb.recordset[0].db);

  const schemas = await pool.request().query(`
    SELECT DISTINCT TABLE_SCHEMA
    FROM INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_SCHEMA
  `);
  console.log('\nVisible schemas:');
  schemas.recordset.forEach(r => console.log(' -', r.TABLE_SCHEMA));

  const ownTables = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'EBTAI'
    ORDER BY TABLE_NAME
  `);
  console.log('\nTables/views in EBTAI schema:');
  ownTables.recordset.forEach(r => console.log(' -', r.TABLE_NAME, `(${r.TABLE_TYPE})`));

  const procs = await pool.request().query(`
    SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE
    FROM INFORMATION_SCHEMA.ROUTINES
    WHERE ROUTINE_SCHEMA = 'EBTAI'
    ORDER BY ROUTINE_NAME
  `);
  console.log('\nRoutines (procs/functions) in EBTAI schema:');
  procs.recordset.forEach(r => console.log(' -', r.ROUTINE_NAME, `(${r.ROUTINE_TYPE})`));

  await sql.close();
}

main().catch(err => {
  console.error('Connection test failed:', err.message);
  process.exit(1);
});
