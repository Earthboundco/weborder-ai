// Fills the "<date>-CL_OnOrder_and_Rcvd.xlsx" workbook from the onorderandrcvdmonth.csv export
// (Wesley, 2026-11-16).
//
//   CSV: Product (item), Month (M10Y26 = Oct 2026, arrival month), Measure, Value (qty)
//     "On Order Inventory Units" -> on-order section (rows 5-11, heading "On-order dollar amount")
//     "Received Inventory Units" -> received section  (rows 15-21, heading "Received dollar amount")
//   $ = qty x landed cost. Row = item's SAP DCS Code matched to column B; column = month matched
//   to the row 4/14 header ("Oct - 2026").
//
// Landed cost (Wesley's "Landed cost estimate rule.txt", 2026-11-16):
//   1. SAP REPORTUSER.SAP_Item_Information.LCO if > 0.
//   2. Else estimate from ItemCost by the vendor of the item's most recent non-cancelled PO
//      (EARTHBOUND.OPOR/POR1, CANCELED = 'N'; latest DocDate, then DocEntry), VendorType from
//      REPORTUSER.SAP_BP_MASTER_DATA on SAP_VendorCode = OPOR.CardCode:
//        'D' -> ItemCost x 1.05        'I' -> ItemCost x (1 + PER_DCS)
//      PER_DCS from Open-to-buy/assets/EST_ DCS_Landed_Percentage.xlsx (A = DCS_Code, B = fraction).
//   3. Vendor type unknown, no PO, no ItemCost, or DCS missing from the PER_DCS file -> item left
//      out and listed (no guessing).
//   Totals are reported split into real SAP LCO vs estimated, since estimates change once SAP has LCO.
//
// Anything that can't be placed (DCS not in the sheet, month outside the sheet's columns, item
// missing from SAP, no landed cost) is listed, not silently dropped.
//
// Usage: node "scripts/OnOrder and Rcvd/fill-onorder-rcvd.js" <csv> <xlsx> [--dry-run] [--detail "<DCS>|<Mon - YYYY>|<On|Received>"]
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadItemInfo } = require('../../item-info');
const { hanaQuery, closeHana } = require('../../hana');

const PER_DCS_FILE = path.resolve(__dirname, '../../../Open-to-buy/assets/EST_ DCS_Landed_Percentage.xlsx');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SECTIONS = {
  'On Order Inventory Units': { short: 'On', header: 4, first: 5, last: 11 },
  'Received Inventory Units': { short: 'Received', header: 14, first: 15, last: 21 },
};

async function loadPerDcs() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(PER_DCS_FILE);
  const m = new Map();
  wb.worksheets[0].eachRow((r, i) => {
    if (i === 1) return;
    const dcs = String(r.getCell(1).value ?? '').trim(); const p = Number(r.getCell(2).value);
    if (dcs && Number.isFinite(p)) m.set(dcs, p);
  });
  return m;
}

// item -> { po, vendor, type } for the item's most recent non-cancelled PO.
async function loadLatestPoVendor(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const rows = await hanaQuery(`
      SELECT x."ItemCode", x."DocNum", x."CardCode", b."VendorType", b."SAP_VendorName"
      FROM (SELECT l."ItemCode", p."DocNum", p."CardCode",
                   ROW_NUMBER() OVER (PARTITION BY l."ItemCode" ORDER BY p."DocDate" DESC, p."DocEntry" DESC) AS rn
            FROM "EARTHBOUND"."OPOR" p JOIN "EARTHBOUND"."POR1" l ON l."DocEntry" = p."DocEntry"
            WHERE p."CANCELED" = 'N' AND l."ItemCode" IN (${chunk.map(() => '?').join(', ')})) x
      LEFT JOIN "REPORTUSER"."SAP_BP_MASTER_DATA" b ON b."SAP_VendorCode" = x."CardCode"
      WHERE x.rn = 1`, chunk);
    for (const r of rows) out.set(String(r.ItemCode).trim(),
      { po: r.DocNum, vendor: r.SAP_VendorName || r.CardCode, type: r.VendorType || null });
  }
  return out;
}

async function main() {
  const [csvPath, xlsxPath] = process.argv.slice(2);
  const dry = process.argv.includes('--dry-run');
  const di = process.argv.indexOf('--detail');
  const detail = di !== -1 ? process.argv[di + 1].split('|') : null;

  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split(',');
  const ix = n => hdr.indexOf(n);
  const recs = lines.slice(1).map(l => {
    const f = l.split(',').map(s => s.replace(/^\|/, '').replace(/\|$/, '').trim());
    const m = /^M(\d\d)Y(\d\d)$/.exec(f[ix('Month')]);
    return { item: f[ix('Product')], month: m ? `${MON[+m[1] - 1]} - 20${m[2]}` : f[ix('Month')],
      measure: f[ix('Measure')], qty: Number(f[ix('Value')]) };
  });

  const sap = await loadItemInfo();
  const perDcs = await loadPerDcs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.worksheets[0];

  for (const s of Object.values(SECTIONS)) {
    s.rows = {}; s.cols = {};
    for (let r = s.first; r <= s.last; r++) s.rows[String(ws.getCell(r, 2).value).trim()] = r;
    ws.getRow(s.header).eachCell((c, col) => { if (col >= 3) s.cols[String(c.value).trim()] = col; });
  }
  const sheetDcs = new Set(Object.values(SECTIONS).flatMap(s => Object.keys(s.rows)));

  // Vendor lookup only for sheet items that need an estimate.
  const needEst = [...new Set(recs.map(r => r.item).filter(i => {
    const it = sap.items.get(i); return it && sheetDcs.has(it['DCS Code']) && !(Number(it['LCost']) > 0);
  }))];
  const poVendor = await loadLatestPoVendor(needEst);

  const costCache = new Map();
  function landed(item, it) {
    if (costCache.has(item)) return costCache.get(item);
    let res;
    const lco = Number(it['LCost']);
    if (lco > 0) res = { cost: lco, kind: 'SAP' };
    else {
      const ic = Number(it['Cost']); const v = poVendor.get(item); const dcs = it['DCS Code'];
      if (!(ic > 0)) res = { why: 'no LCO and no ItemCost' };
      else if (!v) res = { why: 'no LCO and no non-cancelled PO found' };
      else if (v.type === 'D') res = { cost: ic * 1.05, kind: 'EST', basis: `D ${ic} x 1.05`, v };
      else if (v.type === 'I') {
        if (!perDcs.has(dcs)) res = { why: `international, DCS ${dcs} not in PER_DCS file`, v };
        else res = { cost: ic * (1 + perDcs.get(dcs)), kind: 'EST', basis: `I ${ic} x ${1 + perDcs.get(dcs)}`, v };
      } else res = { why: `vendor type unknown (PO ${v.po}, ${v.vendor})`, v };
    }
    costCache.set(item, res); return res;
  }

  const sums = {}; const split = {}; const left = new Map(); const detailRows = [];
  const issues = { noSap: new Map(), dcs: new Map(), month: new Map(), measure: new Map() };
  const bump = (m, k, q) => m.set(k, (m.get(k) || 0) + q);
  for (const r of recs) {
    const s = SECTIONS[r.measure];
    if (!s) { bump(issues.measure, r.measure, r.qty); continue; }
    const it = sap.items.get(r.item);
    if (!it) { bump(issues.noSap, r.item, r.qty); continue; }
    const row = s.rows[it['DCS Code']]; const col = s.cols[r.month];
    if (!row) { bump(issues.dcs, `${s.short} | ${it['DCS Code']}`, r.qty); continue; }
    if (!col) { bump(issues.month, `${s.short} | ${it['DCS Code']} | ${r.month}`, r.qty); continue; }
    const lc = landed(r.item, it);
    if (detail && it['DCS Code'] === detail[0] && r.month === detail[1] && s.short === detail[2])
      detailRows.push({ item: r.item, desc: it['Description'], qty: r.qty, ...lc });
    if (lc.cost === undefined) {
      const k = `${r.item}`; const e = left.get(k) || { item: r.item, desc: it['Description'], dcs: it['DCS Code'], why: lc.why, cells: [], qty: 0 };
      e.cells.push(`${s.short} ${r.month} ${r.qty}`); e.qty += r.qty; left.set(k, e); continue;
    }
    const key = `${row},${col}`; const val = r.qty * lc.cost;
    sums[key] = (sums[key] || 0) + val;
    const sp = split[s.short] ||= {}; const d = sp[it['DCS Code']] ||= { SAP: 0, EST: 0, qSAP: 0, qEST: 0 };
    d[lc.kind] += val; d['q' + lc.kind] += r.qty;
  }
  for (const s of Object.values(SECTIONS))
    for (let r = s.first; r <= s.last; r++)
      for (const col of Object.values(s.cols)) ws.getCell(r, col).value = Math.round((sums[`${r},${col}`] || 0) * 100) / 100;

  const f2 = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const s of Object.values(SECTIONS)) {
    console.log(`\n${s.short} - DCS | total $ | SAP LCO $ (units) | estimated $ (units)`);
    const g = { SAP: 0, EST: 0, qSAP: 0, qEST: 0 };
    for (let r = s.first; r <= s.last; r++) {
      const dcs = String(ws.getCell(r, 2).value).trim(); const d = split[s.short]?.[dcs] || { SAP: 0, EST: 0, qSAP: 0, qEST: 0 };
      for (const k in g) g[k] += d[k];
      console.log(`  ${dcs} | ${f2(d.SAP + d.EST)} | ${f2(d.SAP)} (${d.qSAP}) | ${f2(d.EST)} (${d.qEST})`);
    }
    console.log(`  TOTAL | ${f2(g.SAP + g.EST)} | ${f2(g.SAP)} (${g.qSAP}) | ${f2(g.EST)} (${g.qEST})`);
  }
  if (left.size) {
    console.log(`\nLeft out - no landed cost could be set (${left.size} items):`);
    for (const e of [...left.values()].sort((a, b) => a.item - b.item))
      console.log(`  ${e.item} | ${e.desc} | ${e.dcs} | ${e.why} | ${e.cells.join('; ')}`);
  }
  for (const k of ['noSap', 'month', 'measure']) if (issues[k].size) {
    console.log(`\nNot placed - ${k} (${issues[k].size}):`);
    for (const [kk, v] of [...issues[k]].sort()) console.log(`  ${kk}: ${v}`);
  }
  console.log(`\n(${issues.dcs.size} DCS/section combos not on this sheet skipped - other departments)`);
  if (detail) {
    console.log(`\nDETAIL ${detail.join(' | ')}: item | desc | qty | landed cost | $ | source`);
    for (const d of detailRows.sort((a, b) => a.item - b.item))
      console.log(`  ${d.item}\t${d.desc}\t${d.qty}\t${d.cost === undefined ? '-' : d.cost.toFixed(4)}\t${d.cost === undefined ? '-' : (d.qty * d.cost).toFixed(2)}\t${d.kind === 'SAP' ? 'SAP LCO' : d.kind === 'EST' ? `est ${d.basis} (PO ${d.v.po}, ${d.v.vendor})` : 'LEFT OUT: ' + d.why}`);
  }
  if (!dry) { await wb.xlsx.writeFile(xlsxPath); console.log(`\nWrote ${xlsxPath}`); }
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => closeHana());
