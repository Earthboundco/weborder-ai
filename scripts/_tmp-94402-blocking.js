const { sql, getPool } = require('../db');
const { hanaQuery, closeHana } = require('../hana');

const ITEM = '94402';
const STORES = ['201', '373', '399', '472', '479', '547'];

async function main() {
  const pool = await getPool();

  // Item attributes
  const itemRows = await hanaQuery(`
    SELECT "ITEMNUMBER", "ITEMDESCRIPTION", "DCS_CODE", "VENDORCODE_SAP", "ISTATUS",
           "EBT_STR", "ONLINE_STR", "EBTMARKDOWNFLAG", "PROP65FAIL"
    FROM "REPORTUSER"."SAP_Item_Information" WHERE "ITEMNUMBER" = '${ITEM}'
  `);
  console.log('Item 94402:', itemRows[0]);

  // Store attributes
  const storeInfo = (await pool.request().query(`
    SELECT [Code #] AS code, [STORE NAME] AS name, WStoreSize, WStoreType, STATE, [OPEN]
    FROM EBT.dbo.[Store Directory]
    WHERE [Code #] IN ('${STORES.join("','")}')
  `)).recordset;
  console.log('\nStore info:', storeInfo);

  // RP Min/Max 999 (Exc13) - StoreItemInventory
  const rp999 = (await pool.request().query(`
    SELECT StoreCode, ItemCode, MinQty, MaxQty
    FROM StoreItemInventory
    WHERE ItemCode = '${ITEM}' AND StoreCode IN ('${STORES.join("','")}')
  `)).recordset;
  console.log('\nStoreItemInventory rows (RP Min/Max) for 94402 at these stores:', rp999);

  // Temporary Blocking (Exc14)
  const tempBlock = (await pool.request().query(`
    SELECT Store, Item, Status
    FROM Temporary_Blocking
    WHERE Item = '${ITEM}' AND Store IN ('${STORES.join("','")}')
  `)).recordset;
  console.log('\nTemporary_Blocking rows for 94402 at these stores:', tempBlock);

  // Any temp blocking at all for this item (any store)?
  const tempBlockAny = (await pool.request().query(`
    SELECT Store, Item, Status FROM Temporary_Blocking WHERE Item = '${ITEM}'
  `)).recordset;
  console.log(`\nTemporary_Blocking rows for 94402, ANY store: ${tempBlockAny.length}`, tempBlockAny.slice(0, 10));

  await sql.close();
  closeHana();
}

main().catch(err => { console.error(err.message); process.exit(1); });
