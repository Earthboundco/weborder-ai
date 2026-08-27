const { sql, getPool } = require('../db');

const views = ['WebordernewXLS', 'StoreInvFinal', 'DC_QTY', 'INV_SBS_QTY_V_EXT'];

async function main() {
  const pool = await getPool();
  for (const v of views) {
    const res = await pool.request().query(`SELECT OBJECT_DEFINITION(OBJECT_ID('EBT.dbo.${v}')) AS def`);
    console.log(`\n=== ${v} ===`);
    console.log(res.recordset[0].def);
  }
  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
