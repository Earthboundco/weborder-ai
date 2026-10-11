// Imports assets/Item_Information_Complete_for_Replenishment.xlsx into
// Item_Information_Complete_for_Replenishment (truncate + reload). As of 2026-10-11 this file is the
// ONLY source of item attributes (DCS, description, case qty, flags, DPS Code) - the EBT-derived
// ItemInformationComplete view is no longer used (see sql/017).
//
// The file's flag vocabulary differs from what the exclusion rules test for, so values are normalized
// here (same normalization the old ItemInformationComplete data had):
//   EBT Store / Online Store : Y -> 'Yes', N -> 'No'
//   EBT Mark down            : Y -> 'Yes_MD', N or '(blank)' -> 'No_MK'
//   Prop 65 Fail             : '(blank)' -> NULL; 'Null' / 'Pass' / 'Fail' kept as-is
// Any value outside those sets aborts the import without touching the table.
const path = require('path');
const ExcelJS = require('exceljs');
const { sql, getPool } = require('../db');

const HEADERS = {
  item: 'Item', dcs: 'DCS', desc: 'Description', launch: 'Launch code', istatus: 'Istatus',
  price: 'Sale Price', caseQty: 'Case qty', mdq: 'MDQ', ebt: 'EBT Store', online: 'Online Store',
  md: 'EBT Mark down', p65: 'Prop 65 Fail', dps: 'DPS Code',
};

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('') : v).trim();
  return s.length ? s : null;
}

function yesNo(v, label, row) {
  if (v === 'Y') return 'Yes';
  if (v === 'N') return 'No';
  throw new Error(`Row ${row}: ${label} must be Y or N, got "${v}"`);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-item-information.js <path-to-xlsx>');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(file));
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error('No worksheet found in workbook');
    process.exit(1);
  }

  const col = {};
  sheet.getRow(1).eachCell((cell, n) => {
    for (const [k, h] of Object.entries(HEADERS)) if (text(cell.value) === h) col[k] = n;
  });
  const missing = Object.keys(HEADERS).filter(k => !col[k]);
  if (missing.length) {
    console.error(`Missing header(s) in row 1: ${missing.map(k => HEADERS[k]).join(', ')}`);
    process.exit(1);
  }

  const rows = [];
  const seen = new Set();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = k => row.getCell(col[k]).value;
    const item = get('item');
    if (typeof item !== 'number') return; // blank / non-data row
    if (seen.has(item)) throw new Error(`Row ${rowNumber}: duplicate item ${item}`);
    seen.add(item);

    const dcs = text(get('dcs'));
    const dps = text(get('dps'));
    const caseQty = Number(get('caseQty'));
    if (!dcs || !dps) throw new Error(`Row ${rowNumber}: item ${item} has blank DCS or DPS Code`);
    if (!Number.isFinite(caseQty) || caseQty <= 0) throw new Error(`Row ${rowNumber}: item ${item} has invalid Case qty`);

    const md = text(get('md'));
    let ebtmkd;
    if (md === 'Y') ebtmkd = 'Yes_MD';
    else if (md === 'N' || md === '(blank)' || md === null) ebtmkd = 'No_MK';
    else throw new Error(`Row ${rowNumber}: EBT Mark down must be Y, N or (blank), got "${md}"`);

    const p65raw = text(get('p65'));
    if (p65raw !== null && !['(blank)', 'Null', 'Pass', 'Fail'].includes(p65raw)) {
      throw new Error(`Row ${rowNumber}: Prop 65 Fail must be (blank)/Null/Pass/Fail, got "${p65raw}"`);
    }

    rows.push({
      item, dcs, desc: text(get('desc')), launch: text(get('launch')), istatus: text(get('istatus')),
      price: get('price') === null ? null : Number(get('price')), caseQty, mdq: text(get('mdq')),
      ebt: yesNo(text(get('ebt')), 'EBT Store', rowNumber),
      online: yesNo(text(get('online')), 'Online Store', rowNumber),
      ebtmkd, p65: p65raw === '(blank)' ? null : p65raw, dps,
    });
  });

  if (!rows.length) {
    console.error('No rows parsed from sheet - aborting without touching the table.');
    process.exit(1);
  }

  const pool = await getPool();
  await pool.request().query('TRUNCATE TABLE Item_Information_Complete_for_Replenishment');

  const table = new sql.Table('Item_Information_Complete_for_Replenishment');
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
  console.log(`Imported ${rows.length} rows into Item_Information_Complete_for_Replenishment from ${file}`);

  // Sanity checks against the other weekly inputs (informational - import order is flexible).
  const noInfo = await pool.request().query(`
    SELECT ir.ItemCode FROM ItemReplenishment ir
    WHERE NOT EXISTS (SELECT 1 FROM Item_Information_Complete_for_Replenishment ii WHERE ii.ITEM_NO = CAST(ir.ItemCode AS decimal))`);
  if (noInfo.recordset.length) {
    console.warn(`WARNING: ${noInfo.recordset.length} item(s) in ItemReplenishment have no row in this file and will be silently skipped: ${noInfo.recordset.map(r => r.ItemCode).join(', ')}`);
  }
  const noBase = await pool.request().query(`
    SELECT ii.ITEM_NO, ii.DPS_Code FROM Item_Information_Complete_for_Replenishment ii
    WHERE NOT EXISTS (SELECT 1 FROM DPS_Code_allocation_table d WHERE d.DPS_Code = ii.DPS_Code)
      AND NOT EXISTS (SELECT 1 FROM Item_Code_allocation_table i WHERE i.ItemCode = ii.ITEM_NO)`);
  if (noBase.recordset.length) {
    console.warn(`WARNING: ${noBase.recordset.length} item(s) have a DPS Code with no DPS_Code_allocation_table row and no Item_Code override (base qty will be 0): ` +
      noBase.recordset.map(r => `${r.ITEM_NO} (${r.DPS_Code})`).join(', '));
  }

  await sql.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
