const { sql, getPool } = require('../db');

async function main() {
  const pool = await getPool();

  const queries = {
    'WebordernewXLS (top 3)': `SELECT TOP 3 D_NAME, DCS_NAME, itemno, ALU, DESCRIPTION1, QTY_PER_CASE, HdqQty, [Total Order] FROM EBT.dbo.WebordernewXLS`,
    'WebOrder_reviewed (top 5, most recent)': `SELECT TOP 5 * FROM EBT.dbo.WebOrder_reviewed ORDER BY Current_date DESC`,
    'WebOrder_reviewed date range': `SELECT MIN(Current_date) AS min_date, MAX(Current_date) AS max_date, COUNT(*) AS cnt FROM EBT.dbo.WebOrder_reviewed`,
    'StoreInvFinal (top 3)': `SELECT TOP 3 * FROM EBT.dbo.StoreInvFinal`,
    'DC_QTY (top 3)': `SELECT TOP 3 * FROM EBT.dbo.DC_QTY`,
    'MONTHLY_INV_INTRANSIT_TEMP (top 3, latest)': `SELECT TOP 3 * FROM EBT.dbo.MONTHLY_INV_INTRANSIT_TEMP ORDER BY Year DESC, Month DESC`,
    'Store Directory (top 3)': `SELECT TOP 3 [Code #], [STORE NAME], STATE, WStoreType, WStoreSize, [E-ACTIVE], TempClosed FROM EBT.dbo.[Store Directory]`,
    'Store Directory active count': `SELECT COUNT(*) AS cnt FROM EBT.dbo.[Store Directory] WHERE [E-ACTIVE] = 1`,
    'INVENTORY active count': `SELECT COUNT(*) AS cnt FROM EBT.dbo.INVENTORY WHERE ACTIVE = 1`,
    'INVENTORY sample DCS_CODE': `SELECT TOP 5 ITEM_SID, ITEM_NO, DCS_CODE, ACTIVE, QTY_PER_CASE, DESCRIPTION1 FROM EBT.dbo.INVENTORY WHERE ACTIVE = 1`,
  };

  for (const [label, q] of Object.entries(queries)) {
    try {
      const res = await pool.request().query(q);
      console.log(`\n=== ${label} ===`);
      console.log(JSON.stringify(res.recordset, null, 1));
    } catch (err) {
      console.log(`\n=== ${label} ===`);
      console.log('ERROR:', err.message);
    }
  }

  await sql.close();
}

main().catch(err => {
  console.error('Query failed:', err.message);
  process.exit(1);
});
