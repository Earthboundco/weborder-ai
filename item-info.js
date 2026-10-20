// Item information from the live SAP item master: SAP HANA view REPORTUSER.SAP_Item_Information
// (per Wesley, 2026-10-15 - replaces the manual SAP item export that used to sit in assets/).
//
// Returns the same column names and value formats the manual export had, so the business rules
// (Department, DCS Code, Vendor Code, Retail/Sale Price, EBT Markdwn, LCost, MDQ, ...) and the
// report columns are unchanged. Verified 2026-10-15 against the 10-11 export: all 97,030 items
// present, every column 99.8-100% identical (differences = SAP changes since 10-11).
//
// loadItemInfo() -> { source, loadedAt, columns: [names], items: Map(itemCode -> { column: value }) }
// Values are strings ('' for NULL); prices/costs are plain numbers as strings (e.g. '12.95').
const { hanaQuery } = require('./hana');

// Export column name -> view column (order = the export's column order).
const COLUMNS = [
  ['Description', 'ITEMDESCRIPTION'],
  ['Department', 'DEPTCODE'],
  ['DCS Code', 'DCS_CODE'],
  ['Case Qty', 'RP_CASEQTY'],
  ['Vendor Code', 'VENDORCODE_SAP'],
  ['IStatus', 'ISTATUS'],
  ['Collection Code', 'COLLECTIONCODE'],
  ['Retail Price', 'OriginalPrice'],
  ['Sale Price', 'CurrentPrice'],
  ['Cost', 'ItemCost'],
  ['LCost', 'LCO'],
  ['MDQ', 'MDQ'],
  ['Launch Code', 'LAUNCH_CODE'],
  ['Web View', 'WEBVIEW'],
  ['Web ReOrder', 'WEBORDER'],
  ['Vendor Source', 'VendorSource'],
  ['EBT Store', 'EBT_STR'],
  ['EBT Markdwn', 'EBTMARKDOWNFLAG'],
  ['Online Store', 'ONLINE_STR'],
  ['Prop65 Fail', 'PROP65FAIL'],
  ['Size', 'SIZE'],
];
const NUMERIC = new Set(['OriginalPrice', 'CurrentPrice', 'ItemCost', 'LCO']);

const clean = (v, col) => {
  if (v === null || v === undefined) return '';
  if (NUMERIC.has(col)) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : ''; }
  return String(v).trim();
};

async function loadItemInfo() {
  const sel = COLUMNS.map(([, c]) => `"${c}"`).join(', ');
  const rows = await hanaQuery(`SELECT "ITEMNUMBER", ${sel} FROM "REPORTUSER"."SAP_Item_Information"`);
  const items = new Map();
  for (const r of rows) {
    const rec = {};
    for (const [name, col] of COLUMNS) rec[name] = clean(r[col], col);
    items.set(String(r.ITEMNUMBER).trim(), rec);
  }
  return {
    source: 'SAP HANA REPORTUSER.SAP_Item_Information (live)',
    loadedAt: new Date(),
    columns: COLUMNS.map(([name]) => name),
    items,
  };
}

module.exports = { loadItemInfo, ITEM_INFO_COLUMNS: COLUMNS.map(([name]) => name) };
