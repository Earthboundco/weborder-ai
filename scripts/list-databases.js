const { sql, getPool } = require('../db');

async function main() {
  const pool = await getPool();

  const dbs = await pool.request().query(`
    SELECT name, state_desc, has_access = HAS_DBACCESS(name)
    FROM sys.databases
    ORDER BY name
  `);
  console.log('Databases on server (and access):');
  dbs.recordset.forEach(r => console.log(' -', r.name, `[${r.state_desc}]`, r.has_access ? 'ACCESS' : 'no access'));

  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
