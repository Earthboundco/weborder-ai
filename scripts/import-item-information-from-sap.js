// Builds Item_Information_Complete_for_Replenishment from live SAP data (truncate + reload) for the
// items currently in ItemReplenishment - replaces supplying
// assets/Item_Information_Complete_for_Replenishment.xlsx every week (Wesley, 2026-11-15).
//
//   SAP HANA REPORTUSER.SAP_Item_Information (via item-info.js) -> item attributes
//   dps-code.js (Wesley's DAX formula)                          -> DPS Code, from SAP DCS / current Sale Price / Size
//
// Run AFTER scripts/import-item-replenishment.js (it reads the item list from the ItemReplenishment
// table). Verified 2026-11-15: for 997 test items this reproduces
// Wesley's Excel file in all 13 columns (100%); his "Sale Price" is SAP's current sale price, so the DPS
// price bucket follows markdowns.
//
// SAP's flag vocabulary is normalized to what the exclusion rules test for (same as the Excel import):
//   EBT Store / Online Store : Y -> 'Yes', N -> 'No'
//   EBT Markdown             : Y -> 'Yes_MD', N or blank -> 'No_MK'
//   Prop 65 Fail             : blank -> NULL; 'Null' / 'Pass' / 'Fail' kept as-is
//   Launch code              : blank -> '(blank)' (matches the Excel file; not used by any rule)
// An unexpected value aborts the import without touching the table.
//
// Usage: node scripts/import-item-information-from-sap.js [--dry-run]
//   --dry-run  builds everything and compares to the table's current contents, writes nothing.
// The Excel-based scripts/import-item-information.js stays as a manual fallback.
const { sql, getPool } = require('../db');
const { hanaQuery, closeHana } = require('../hana');
const { loadItemInfo } = require('../item-info');
const { dpsCode } = require('../dps-code');

const TABLE = 'Item_Information_Complete_for_Replenishment';

function yesNo(v, label, item) {
  if (v === 'Y') return 'Yes';
  if (v === 'N') return 'No';
  throw new Error(`Item ${item}: SAP ${label} must be Y or N, got "${v}"`);
}

function buildRow(item, s) {
  const dcs = s['DCS Code'];
  const price = Number(s['Sale Price']);
  const caseQty = Number(s['Case Qty']);
  if (!dcs) throw new Error(`Item ${item}: SAP DCS Code is blank`);
  if (!Number.isFinite(price)) throw new Error(`Item ${item}: SAP Sale Price is blank/invalid`);
  if (!Number.isFinite(caseQty) || caseQty <= 0) throw new Error(`Item ${item}: SAP Case Qty is invalid ("${s['Case Qty']}")`);

  const md = s['EBT Markdwn'];
  if (!['Y', 'N', ''].includes(md)) throw new Error(`Item ${item}: SAP EBT Markdown must be Y/N/blank, got "${md}"`);
  const p65 = s['Prop65 Fail'];
  if (!['', 'Null', 'Pass', 'Fail'].includes(p65)) throw new Error(`Item ${item}: SAP Prop65 Fail must be blank/Null/Pass/Fail, got "${p65}"`);

  return {
    item: Number(item),
    dcs,
    desc: s['Description'] || null,
    launch: s['Launch Code'] || '(blank)',
    istatus: s['IStatus'] || null,
    price,
    caseQty,
    mdq: s['MDQ'] || null,
    ebt: yesNo(s['EBT Store'], 'EBT Store', item),
    online: yesNo(s['Online Store'], 'Online Store', item),
    ebtmkd: md === 'Y' ? 'Yes_MD' : 'No_MK',
    p65: p65 === '' ? null : p65,
    dps: dpsCode(dcs, price, s['Size']),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = await getPool();

  const list = await pool.request().query('SELECT ItemCode FROM ItemReplenishment ORDER BY ItemCode');
  const itemCodes = list.recordset.map(r => String(r.ItemCode).trim());
  if (!itemCodes.length) {
    console.error('ItemReplenishment is empty - import Items_for_Replenishment first. Aborting without touching the table.');
    process.exit(1);
  }

  const sap = await loadItemInfo();
  const notInSap = itemCodes.filter(i => !sap.items.has(i));
  const rows = itemCodes.filter(i => sap.items.has(i)).map(i => buildRow(i, sap.items.get(i)));

  if (notInSap.length) {
    console.warn(`WARNING: ${notInSap.length} item(s) in ItemReplenishment were not found in SAP and will be skipped by the allocation: ${notInSap.join(', ')}`);
  }
  if (!rows.length) {
    console.error('No items could be built from SAP - aborting without touching the table.');
    process.exit(1);
  }

  if (dryRun) {
    const cur = await pool.request().query(`SELECT * FROM ${TABLE}`);
    const byItem = new Map(cur.recordset.map(r => [String(r.ITEM_NO), r]));
    const fields = [['dcs', 'DCS_CODE'], ['desc', 'DESCRIPTION1'], ['launch', 'LaunchCode'], ['istatus', 'IStatus'], ['price', 'SalePrice'],
      ['caseQty', 'QTY_PER_CASE'], ['mdq', 'MDQ'], ['ebt', 'EBT_STR'], ['online', 'ONLINE_STR'], ['ebtmkd', 'EBTMKD'], ['p65', 'PROP65FAIL'], ['dps', 'DPS_Code']];
    let same = 0, notInTable = 0;
    const diffCount = {};
    for (const r of rows) {
      const t = byItem.get(String(r.item));
      if (!t) { notInTable++; continue; }
      let ok = true;
      for (const [k, c] of fields) {
        const a = r[k], b = t[c];
        const eq = typeof a === 'number' ? Number(b) === a : String(a ?? '').trim() === String(b ?? '').trim();
        if (!eq) { ok = false; diffCount[c] = (diffCount[c] || 0) + 1; }
      }
      if (ok) same++;
    }
    console.log(`DRY RUN: built ${rows.length} item(s) from SAP; identical to current ${TABLE} rows: ${same}; not in table: ${notInTable}`);
    console.log('Column differences vs current table:', JSON.stringify(diffCount));
    await closeHana(); await sql.close();
    return;
  }

  await pool.request().query(`TRUNCATE TABLE ${TABLE}`);
  const table = new sql.Table(TABLE);
  table.create = false;
  table.columns.add('ITEM_NO', sql.Decimal(18, 0), { nullable: false });
  table.columns.add('DCS_CODE', sql.VarChar(18), { nullable: false });
  table.columns.add('DESCRIPTION1', sql.VarChar(100), { nullable: true });
  table.columns.add('LaunchCode', sql.VarChar(50), { nullable: true });
  table.columns.add('IStatus', sql.VarChar(30), { nullable: true });
  table.columns.add('SalePrice', sql.Decimal(10, 2), { nullable: true });
  table.columns.add('QTY_PER_CASE', sql.Decimal(18, 0), { nullable: false });
  table.columns.add('MDQ', sql.VarChar(10), { nullable: true });
  table.columns.add('EBT_STR', sql.VarChar(10), { nullable: true });
  table.columns.add('ONLINE_STR', sql.VarChar(10), { nullable: true });
  table.columns.add('EBTMKD', sql.VarChar(10), { nullable: true });
  table.columns.add('PROP65FAIL', sql.VarChar(10), { nullable: true });
  table.columns.add('DPS_Code', sql.VarChar(43), { nullable: false });
  for (const r of rows) {
    table.rows.add(r.item, r.dcs, r.desc, r.launch, r.istatus, r.price, r.caseQty, r.mdq, r.ebt, r.online, r.ebtmkd, r.p65, r.dps);
  }
  await pool.request().bulk(table);
  console.log(`Imported ${rows.length} rows into ${TABLE} from SAP (${sap.source}).`);

  // Sanity checks (informational) - same ones as the Excel import, plus DCS Pattern coverage.
  const noBase = await pool.request().query(`
    SELECT ii.ITEM_NO, ii.DPS_Code FROM ${TABLE} ii
    WHERE NOT EXISTS (SELECT 1 FROM DPS_Code_allocation_table d WHERE d.DPS_Code = ii.DPS_Code)
      AND NOT EXISTS (SELECT 1 FROM Item_Code_allocation_table i WHERE i.ItemCode = ii.ITEM_NO)`);
  if (noBase.recordset.length) {
    console.warn(`WARNING: ${noBase.recordset.length} item(s) have a DPS Code with no DPS_Code_allocation_table row and no Item_Code override (base qty will be 0): ` +
      noBase.recordset.map(r => `${r.ITEM_NO} (${r.DPS_Code})`).join(', '));
  }
  const noPattern = await pool.request().query(`
    SELECT ii.ITEM_NO, ii.DCS_CODE FROM ${TABLE} ii
    WHERE NOT EXISTS (SELECT 1 FROM DCS_Pattern p WHERE p.[DCS Code] = ii.DCS_CODE)`);
  if (noPattern.recordset.length) {
    console.warn(`WARNING: ${noPattern.recordset.length} item(s) have a DCS Code with no DCS_Pattern row and will be skipped by the allocation: ` +
      noPattern.recordset.map(r => `${r.ITEM_NO} (${r.DCS_CODE})`).join(', '));
  }

  await closeHana();
  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
