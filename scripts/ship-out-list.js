// Builds the ShipOutList (one row per item, grouped by PO) from Wesley's "Source" PO list.
//
// Usage: node scripts/ship-out-list.js [<Source.xlsx>] [--template <file.xlsx>] [--out <file.xlsx>]
// Reads <Desktop>/Source.xlsx unless a path is given; writes <Desktop>/<MM-DD-YY>-ShipOutList.xlsx
// (today's date) unless --out is given.
//
// Source: header row found by the "PO#" cell. Seq = the column just before PO#; "Item #s" holds one
// item per line; "Vendor Name" feeds the PO label.
//
// Format (header, column widths, data-row styles, conditional formatting, frozen header, zoom) comes
// from the template - by default Wesley_tools/ShipOutList_Template.xlsx (Wesley's example
// ShipOutList, 2026-10-23). Data rows copy the template's row-3 styles. Rules from that example:
//   - Items within a PO sorted by DCS Code, then Item No; one empty row between POs.
//   - Col AA on a PO's last row: "PO# " & PO & " " & Vendor Name (vendor cut to 20 characters).
//   - Missing values are written as the text "(blank)" (the template's CF shows it in white);
//     Stores w/ Qty OH and Stores Blocked are "(blank)" when 0.
//   - Values only, no Excel formulas.
//
// Sources (see docs/data-sources.md):
//   - Item attributes: HANA REPORTUSER.SAP_Item_Information. Price = Sale Price ("CurrentPrice",
//     per Wesley 2026-10-23), Cost = "ItemCost" (not LCO).
//   - DC OH Qty: HANA EARTHBOUND.OITW "OnHand" at HDQ (raw on-hand, not net of committed - matches
//     Wesley's example).
//   - Order Qty / Rcvd Qty: EARTHBOUND.POR1 "Quantity" / "Quantity" - "OpenQty", summed over the
//     item's lines on that PO (POs can split an item over several lines, e.g. 8294).
//   - Stores OH Qty / Stores w/ Qty OH / Stores Blocked: EBT.dbo.INVN_SBS_QTY_V, every store except
//     the DC (STORE_NO 0). Store 470 (Ecommerce) on-hand comes from OITW warehouse 470 instead -
//     INVN_SBS_QTY_V shows it as 0. Blocked = MIN_QTY 999, 470 counts (per Wesley 2026-10-23).
//   - Size Status: "Check" if Department = Clothing and Size is blank, else "Ok".
//   - Ave Qty OH per Store: Stores OH Qty / Stores w/ Qty OH, rounded to a whole unit, 0 if none.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const sql = require('mssql');
const { hanaQuery, closeHana } = require('../hana');
const { getPool } = require('../db');

const DESKTOP = path.join(os.homedir(), 'OneDrive - Earthbound Trading Company', 'Desktop');
// Wesley_tools/ is gitignored (personal files), so the template exists only on Wesley's machine.
const DEFAULT_TEMPLATE = path.join(__dirname, '..', 'Wesley_tools', 'ShipOutList_Template.xlsx');
const VENDOR_MAX = 20;
const NCOLS = 27; // A..AA
const BLANK = '(blank)';

function parseArgs(argv) {
  let source = path.join(DESKTOP, 'Source.xlsx'), out = null, template = DEFAULT_TEMPLATE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--template') template = argv[++i];
    else if (!a.startsWith('--')) source = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return { source, out, template };
}

const text = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map(t => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
};
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const orBlank = v => (v === null || v === undefined || String(v).trim() === '' ? BLANK : v);

async function readSource(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  let headerRow = null, cols = {};
  ws.eachRow((row, r) => {
    if (headerRow) return;
    row.eachCell((cell, c) => { if (text(cell.value).trim() === 'PO#') headerRow = r; });
    if (headerRow) row.eachCell((cell, c) => { cols[text(cell.value).trim()] = c; });
  });
  if (!headerRow) throw new Error(`No "PO#" header found in ${file}`);
  for (const h of ['PO#', 'Vendor Name', 'Item #s']) if (!cols[h]) throw new Error(`Source is missing the "${h}" column`);
  const seqCol = cols['PO#'] - 1;

  const pos = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const po = num(text(row.getCell(cols['PO#']).value).trim());
    if (!po) continue;
    const items = [...new Set(text(row.getCell(cols['Item #s']).value).split(/[^0-9]+/).filter(Boolean))];
    pos.push({
      seq: num(text(row.getCell(seqCol).value).trim()),
      po,
      vendor: text(row.getCell(cols['Vendor Name']).value).trim(),
      items,
      expected: num(text(row.getCell(cols['Number of items'] || 0).value).trim()),
    });
  }
  return pos;
}

async function main() {
  const { source, out, template } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
  if (!fs.existsSync(template)) throw new Error(`Template not found: ${template} (pass --template <file.xlsx>)`);

  const pos = await readSource(source);
  const warnings = [];
  for (const p of pos) {
    if (!p.items.length) warnings.push(`PO ${p.po}: no item numbers in "Item #s"`);
    if (p.expected && p.expected !== p.items.length) warnings.push(`PO ${p.po}: "Number of items" says ${p.expected}, "Item #s" lists ${p.items.length}`);
  }
  const allItems = [...new Set(pos.flatMap(p => p.items))];
  const ph = allItems.map(() => '?').join(', ');

  const info = new Map((await hanaQuery(`
    SELECT "ITEMNUMBER", "DEPTCODE", "DCS_CODE", "LAUNCH_CODE", "ITEMDESCRIPTION", "ISTATUS",
           "CurrentPrice", "RP_CASEQTY", "MDQ", "ItemCost", "COLLECTIONCODE", "WEBORDER", "WEBVIEW",
           "SIZE", "EBT_STR", "ONLINE_STR"
    FROM "REPORTUSER"."SAP_Item_Information" WHERE "ITEMNUMBER" IN (${ph})`, allItems))
    .map(r => [String(r.ITEMNUMBER).trim(), r]));

  const whs = await hanaQuery(`
    SELECT "ItemCode", "WhsCode", "OnHand" FROM "EARTHBOUND"."OITW"
    WHERE "WhsCode" IN ('HDQ', '470') AND "ItemCode" IN (${ph})`, allItems);
  const dcOH = new Map(), ecomOH = new Map();
  for (const w of whs) (w.WhsCode === 'HDQ' ? dcOH : ecomOH).set(String(w.ItemCode).trim(), Math.round(Number(w.OnHand)));

  const poNos = [...new Set(pos.map(p => p.po))];
  const poLines = await hanaQuery(`
    SELECT p."DocNum", p."DocEntry", l."ItemCode", l."Quantity", l."OpenQty"
    FROM "EARTHBOUND"."OPOR" p JOIN "EARTHBOUND"."POR1" l ON l."DocEntry" = p."DocEntry"
    WHERE p."DocNum" IN (${poNos.map(() => '?').join(', ')})`, poNos);

  // Store-level qty: sum on-hand per store and take MAX of min (store 470 has a live row and a
  // min/max row), round fractional on-hand to the nearest unit (see docs/data-sources.md).
  const pool = await getPool();
  const req = pool.request();
  allItems.forEach((it, i) => req.input(`i${i}`, sql.VarChar(20), it));
  const storeRows = (await req.query(`
    SELECT v.ITEM_NO, v.STORE_NO, SUM(v.QTY) AS QTY, MAX(v.MIN_QTY) AS MIN_QTY, MAX(d.[Code #]) AS CODE
    FROM EBT.dbo.INVN_SBS_QTY_V v
    LEFT JOIN EBT.dbo.[Store Directory] d ON d.[ID #] = v.STORE_NO
    WHERE v.STORE_NO <> 0 AND v.ITEM_NO IN (${allItems.map((_, i) => `@i${i}`).join(', ')})
    GROUP BY v.ITEM_NO, v.STORE_NO`)).recordset;
  await pool.close();
  const stores = new Map(); // item -> { oh, withOH, blocked }
  for (const it of allItems) {
    const e = ecomOH.get(it) || 0;
    stores.set(it, { oh: Math.max(e, 0), withOH: e > 0 ? 1 : 0, blocked: 0 });
  }
  for (const r of storeRows) {
    const s = stores.get(String(r.ITEM_NO).trim());
    if (!s) continue;
    if (Number(r.MIN_QTY) === 999) s.blocked++;
    if (String(r.CODE).trim() === '470') continue; // 470's on-hand comes from OITW above
    const q = Math.round(Number(r.QTY) || 0);
    s.oh += q;
    if (q > 0) s.withOH++;
  }

  const tpl = new ExcelJS.Workbook();
  await tpl.xlsx.readFile(template);
  const ws = tpl.worksheets[0];
  const styles = [];
  for (let c = 1; c <= NCOLS; c++) styles.push(JSON.parse(JSON.stringify(ws.getRow(3).getCell(c).style || {})));
  const templateRows = ws.rowCount;
  for (let r = 3; r <= templateRows; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= NCOLS; c++) { const cell = row.getCell(c); cell.value = null; cell.style = {}; }
  }

  let r = 3;
  for (const p of pos) {
    const missing = p.items.filter(it => !info.has(it));
    if (missing.length) warnings.push(`PO ${p.po}: no SAP_Item_Information row for item(s) ${missing.join(', ')}`);
    const lines = poLines.filter(l => Number(l.DocNum) === p.po);
    if (!lines.length) warnings.push(`PO ${p.po}: no POR1 lines found - Order/Rcvd Qty left blank`);
    // DocNum isn't unique across numbering series - keep the document(s) that carry these items.
    const docs = new Set(lines.filter(l => p.items.includes(String(l.ItemCode).trim())).map(l => l.DocEntry));
    if (docs.size > 1) warnings.push(`PO ${p.po}: ${docs.size} SAP POs share this number and these items - Order/Rcvd Qty summed over all`);

    const items = [...p.items].sort((a, b) => {
      const da = info.get(a)?.DCS_CODE || '', db = info.get(b)?.DCS_CODE || '';
      return da.localeCompare(db) || Number(a) - Number(b);
    });
    items.forEach((it, idx) => {
      const i = info.get(it) || {};
      const itLines = lines.filter(l => String(l.ItemCode).trim() === it && docs.has(l.DocEntry));
      if (lines.length && !itLines.length) warnings.push(`PO ${p.po}: item ${it} is not on the SAP PO`);
      const ordered = itLines.length ? itLines.reduce((s, l) => s + Number(l.Quantity), 0) : null;
      const rcvd = itLines.length ? itLines.reduce((s, l) => s + Number(l.Quantity) - Number(l.OpenQty), 0) : null;
      const s = stores.get(it);
      const size = String(i.SIZE || '').trim();

      const values = new Array(NCOLS).fill(null);
      values[1] = p.seq;                                                    // B Seq
      values[2] = orBlank(i.DCS_CODE);                                      // C DCS Code
      values[3] = Number(it);                                               // D Item No
      values[4] = orBlank(i.LAUNCH_CODE);                                   // E Launch Code
      values[5] = orBlank(i.ITEMDESCRIPTION);                               // F Description
      values[6] = orBlank(i.ISTATUS);                                       // G IStatus
      values[7] = dcOH.get(it) ?? 0;                                        // H DC OH Qty
      values[8] = orBlank(num(i.CurrentPrice));                             // I Price (Sale Price)
      values[9] = orBlank(num(i.RP_CASEQTY));                               // J Case Qty
      values[10] = orBlank(num(i.MDQ));                                     // K MDQ
      values[11] = orBlank(num(i.ItemCost));                                // L Cost
      values[12] = orBlank(i.COLLECTIONCODE);                               // M Collection Code
      values[13] = orBlank(i.WEBORDER);                                     // N Web Re Order
      values[14] = orBlank(i.WEBVIEW);                                      // O Web View
      values[15] = orBlank(size);                                           // P Size
      values[16] = i.DEPTCODE === 'Clothing' && !size ? 'Check' : 'Ok';     // Q Size Status
      values[17] = orBlank(i.EBT_STR);                                      // R EBT Store
      values[18] = orBlank(i.ONLINE_STR);                                   // S Online Store
      values[19] = s.oh;                                                    // T Stores OH Qty
      values[20] = s.withOH || BLANK;                                       // U Stores w/ Qty OH
      values[21] = s.withOH ? Math.round(s.oh / s.withOH) : 0;              // V Ave Qty OH per Store
      values[22] = s.blocked || BLANK;                                      // W Stores Blocked
      values[23] = orBlank(ordered);                                        // X Order Qty
      values[24] = orBlank(rcvd);                                           // Y Rcvd Qty
      values[25] = p.po;                                                    // Z PO#
      if (idx === items.length - 1) values[26] = `PO# ${p.po} ${p.vendor.slice(0, VENDOR_MAX)}`; // AA

      const row = ws.getRow(r++);
      for (let c = 1; c <= NCOLS; c++) {
        const cell = row.getCell(c);
        cell.style = JSON.parse(JSON.stringify(styles[c - 1]));
        cell.value = values[c - 1];
      }
      row.commit();
    });
    console.log(`Seq ${p.seq} | PO ${p.po} | ${p.vendor} | ${items.length} item(s)`);
    r++; // empty row between POs
  }

  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getFullYear()).slice(-2)}`;
  const file = out ? path.resolve(out) : path.join(DESKTOP, `${stamp}-ShipOutList.xlsx`);
  await tpl.xlsx.writeFile(file);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  console.log(`Wrote ${file} (${pos.length} POs, ${allItems.length} items)`);
}

main()
  .catch(err => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(closeHana);
