const { sql, getPool } = require('../db');

const targets = [
  'INV_ITEM',
  'INVENTORY',
  'INVENTORY_V',
  'MONTHLY_INV_INTRANSIT_TEMP',
  'Store Directory',
  'WebOrder_reviewed',
  'WebordernewXLS',
  'Replenishment_index_Str',
  'StoreInvDC',
  'StoreInvFinal',
  'INV_SBS_QTY_V_EXT',
  'INVN_INFO',
  'DC_QTY',
];

async function main() {
  const pool = await getPool();

  for (const t of targets) {
    const res = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM EBT.INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = '${t.replace(/'/g, "''")}'
      ORDER BY ORDINAL_POSITION
    `);
    console.log(`\n=== ${t} (${res.recordset.length} cols) ===`);
    res.recordset.forEach(r => console.log(` - ${r.COLUMN_NAME} : ${r.DATA_TYPE}${r.CHARACTER_MAXIMUM_LENGTH ? '(' + r.CHARACTER_MAXIMUM_LENGTH + ')' : ''}`));
  }

  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
