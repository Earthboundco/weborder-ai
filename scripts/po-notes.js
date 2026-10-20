// Builds the PO Notes log entry sheet (18 columns, one row per PO) for the given PO numbers.
//
// Usage: node scripts/po-notes.js <PO#> [<PO#> ...] [--product <PO#>="summary"]
//                                 [--template <file.xlsx>] [--out <file.xlsx>]
//   e.g. node scripts/po-notes.js 8325 8322 8340 --product 8325="Fragrance oils"
// Writes <Desktop>/<MM-DD-YY>-for-PO-Notes.xlsx (today's date) unless --out is given.
//
// Format (column widths, header, cell styles) comes from the template - by default
// Wesley_tools/PO_Notes_Template.xlsx (Wesley's Sample.xlsx, 2026-10-20); data rows copy the
// template's row-2 styles, row height 50. Opens at 80% zoom with the header row frozen.
//
// Sources (all SAP HANA, see docs/data-sources.md):
//   - PO lines + PO vendor + vendor type: REPORTUSER.ORDERS_DETAILED_SUM_W_CM (PO_VENDCODESAP,
//     PO_VENDTYPE I/D; rows repeat per line/container, so items are de-duplicated)
//   - Vendor name (and type fallback): REPORTUSER.SAP_BP_MASTER_DATA
//   - Launch Code, Weborder (Y/N), Web View (Active/Inactive): REPORTUSER.SAP_Item_Information
//   - PO Remarks (SAP PO screen "Remarks"): EARTHBOUND.OPOR."Comments"
//
// Columns filled: PO#, Vendor Name, Product (<=40 chars), Item #s (one per line), Number of items,
// Launch Code (unique, one per line), Shipment instruction and/or PO Note (= PO Remarks, per
// Wesley 2026-10-20), PO source (Domestic/International), LCO done? = "No", Items' status. Every
// other column is left blank, per Wesley.
//
// Product: pass --product for each PO (a human summary reads best). Without it, a fallback is
// built from the most common item-description words (before the first '-').
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { hanaQuery, closeHana } = require('../hana');

const DESKTOP = path.join(os.homedir(), 'OneDrive - Earthbound Trading Company', 'Desktop');
// Wesley_tools/ is gitignored (personal files), so the template exists only on Wesley's machine.
const DEFAULT_TEMPLATE = path.join(__dirname, '..', 'Wesley_tools', 'PO_Notes_Template.xlsx');
const PRODUCT_MAX = 40;

function parseArgs(argv) {
  const pos = [], products = new Map();
  let out = null, template = DEFAULT_TEMPLATE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--template') template = argv[++i];
    else if (a === '--product') {
      const m = String(argv[++i] || '').match(/^(\d+)=(.*)$/);
      if (!m) throw new Error(`--product expects <PO#>="summary", got: ${argv[i]}`);
      products.set(Number(m[1]), m[2].trim());
    } else if (/^\d+$/.test(a)) pos.push(Number(a));
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!pos.length) throw new Error('Usage: node scripts/po-notes.js <PO#> [<PO#> ...] [--product <PO#>="summary"] [--out <file.xlsx>]');
  return { pos: [...new Set(pos)], products, out, template };
}

function itemsStatus(items) {
  const keys = new Set(items.map(i => `${i.WEBORDER ?? ''}/${i.WEBVIEW ?? ''}`));
  if (keys.size > 1) return 'Mixed';
  const k = [...keys][0];
  if (k === 'Y/Active') return 'Yes/Active';
  if (k === 'N/Inactive') return 'No/Inactive';
  if (k === 'N/Active') return 'No/Active';
  return 'N/A';
}

function fallbackProduct(items) {
  const counts = new Map();
  for (const i of items) {
    const head = String(i.ITEMDESCRIPTION || '').split('-')[0].trim().toLowerCase();
    if (head) counts.set(head, (counts.get(head) || 0) + 1);
  }
  const heads = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  let s = '';
  for (const h of heads) {
    const next = s ? `${s}, ${h}` : h;
    if (next.length > PRODUCT_MAX) break;
    s = next;
  }
  s = s || (heads[0] || '').slice(0, PRODUCT_MAX);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function main() {
  const { pos, products, out, template } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(template)) throw new Error(`Template not found: ${template} (pass --template <file.xlsx>)`);

  const rows = await hanaQuery(`
    SELECT DISTINCT o."PO_NO", o."PO_VENDCODESAP", o."PO_VENDTYPE", o."PO_ITEMCODE",
           b."SAP_VendorName", b."VendorType",
           i."ITEMDESCRIPTION", i."LAUNCH_CODE", i."WEBORDER", i."WEBVIEW"
    FROM "REPORTUSER"."ORDERS_DETAILED_SUM_W_CM" o
    LEFT JOIN "REPORTUSER"."SAP_BP_MASTER_DATA" b ON b."SAP_VendorCode" = o."PO_VENDCODESAP"
    LEFT JOIN "REPORTUSER"."SAP_Item_Information" i ON i."ITEMNUMBER" = o."PO_ITEMCODE"
    WHERE o."PO_NO" IN (${pos.map(() => '?').join(', ')})`, pos);

  // PO Remarks (SAP PO screen "Remarks" = OPOR."Comments"). DocNum isn't unique across numbering
  // series (16 of 6,936 POs on 2026-10-20), so the PO's vendor picks the right document.
  const remarkRows = await hanaQuery(`
    SELECT "DocNum", "CardCode", "Comments" FROM "EARTHBOUND"."OPOR"
    WHERE "DocNum" IN (${pos.map(() => '?').join(', ')})`, pos);

  const tpl = new ExcelJS.Workbook();
  await tpl.xlsx.readFile(template);
  const ws = tpl.worksheets[0];
  const styles = [];
  for (let c = 1; c <= 18; c++) styles.push(JSON.parse(JSON.stringify(ws.getRow(2).getCell(c).style || {})));
  // Clear the template's sample rows (spliceRows left them in place when fewer POs than sample
  // rows were written - found 2026-10-20 with a single-PO run).
  const templateRows = ws.rowCount;
  for (let r = 2; r <= templateRows; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) { const cell = row.getCell(c); cell.value = null; cell.style = {}; }
    row.height = undefined;
  }
  // Per Wesley (2026-10-20): open at 80% zoom with the header row frozen.
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', activeCell: 'A2', zoomScale: 80, zoomScaleNormal: 80 }];

  const warnings = [];
  pos.forEach((po, idx) => {
    const lines = rows.filter(r => Number(r.PO_NO) === po);
    if (!lines.length) { warnings.push(`PO ${po}: not found in ORDERS_DETAILED_SUM_W_CM - row left with PO# only`); }
    const byItem = new Map();
    for (const l of lines) if (!byItem.has(String(l.PO_ITEMCODE))) byItem.set(String(l.PO_ITEMCODE), l);
    const items = [...byItem.values()].sort((a, b) => String(a.PO_ITEMCODE).localeCompare(String(b.PO_ITEMCODE), undefined, { numeric: true }));
    const vendors = [...new Set(lines.map(l => l.SAP_VendorName || l.PO_VENDCODESAP).filter(Boolean))];
    if (vendors.length > 1) warnings.push(`PO ${po}: more than one vendor (${vendors.join(', ')})`);
    const type = lines.map(l => l.PO_VENDTYPE || l.VendorType).find(Boolean);
    const source = type === 'I' ? 'International' : type === 'D' ? 'Domestic' : null;
    if (lines.length && !source) warnings.push(`PO ${po}: vendor type not set in SAP - PO source left blank`);
    const missing = items.filter(i => i.WEBORDER == null && i.WEBVIEW == null && i.LAUNCH_CODE == null).map(i => i.PO_ITEMCODE);
    if (missing.length) warnings.push(`PO ${po}: no SAP_Item_Information row for item(s) ${missing.join(', ')}`);
    const launch = [...new Set(items.map(i => (i.LAUNCH_CODE || '').trim()).filter(Boolean))];
    let product = products.get(po) ?? (items.length ? fallbackProduct(items) : null);
    if (product && product.length > PRODUCT_MAX) { warnings.push(`PO ${po}: Product cut to ${PRODUCT_MAX} characters`); product = product.slice(0, PRODUCT_MAX); }
    const itemNos = items.map(i => String(i.PO_ITEMCODE));
    const vendCodes = new Set(lines.map(l => l.PO_VENDCODESAP).filter(Boolean));
    let docs = remarkRows.filter(d => Number(d.DocNum) === po);
    if (docs.length > 1 && vendCodes.size) docs = docs.filter(d => vendCodes.has(d.CardCode));
    if (docs.length > 1) warnings.push(`PO ${po}: ${docs.length} SAP POs share this number - Remarks from all of them`);
    const remarks = [...new Set(docs.map(d => String(d.Comments || '').trim()).filter(Boolean))].join('\n');

    const values = new Array(18).fill(null);
    values[0] = po;                                                        // PO#
    values[2] = vendors[0] || null;                                        // Vendor Name
    values[4] = product;                                                   // Product
    values[5] = itemNos.length === 1 && /^\d+$/.test(itemNos[0]) ? Number(itemNos[0]) : (itemNos.join('\n') || null); // Item #s
    values[6] = items.length || null;                                      // Number of items
    values[7] = launch.join('\n') || null;                                 // Launch Code
    values[10] = remarks || null;                                          // Shipment instruction and/or PO Note
    values[13] = source;                                                   // PO source (Int'l/Dom)
    values[14] = 'No';                                                     // LCO done?
    values[17] = items.length ? itemsStatus(items) : null;                 // Items' status

    const row = ws.getRow(idx + 2);
    row.height = 50;
    for (let c = 1; c <= 18; c++) {
      const cell = row.getCell(c);
      cell.style = JSON.parse(JSON.stringify(styles[c - 1]));
      cell.value = values[c - 1];
    }
    row.commit();
    console.log(`PO ${po}: ${vendors[0] || '?'} | ${items.length} item(s) | ${source || '?'} | ${values[17] || '?'} | "${product || ''}"`);
  });

  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getFullYear()).slice(-2)}`;
  const file = out ? path.resolve(out) : path.join(DESKTOP, `${stamp}-for-PO-Notes.xlsx`);
  await tpl.xlsx.writeFile(file);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  console.log(`Wrote ${file}`);
}

main()
  .catch(err => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(closeHana);
