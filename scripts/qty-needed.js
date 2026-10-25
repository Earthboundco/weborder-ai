// Calculates each item's reorder qty ("Qty Needed") between its Period ETA and Period LTD, from a
// week-by-week company stock projection. Rules: docs/business-rules.md, sections "ETA / LTD" and
// "Weekly qty projection" (Wesley, 2026-10-25).
//
// Usage: node scripts/qty-needed.js [<input.xlsx>] [--out <file.xlsx>] [--today YYYY-MM-DD]
//                                   [--pg-dir <folder>]
// Reads <Desktop>/Qty_Needed_Input.xlsx unless a path is given; writes
// <Desktop>/<MM-DD-YY>-Qty_Needed.xlsx unless --out is given. --today overrides today's date
// (to reproduce an earlier run).
//
// Input: header row found by the "Item" cell; columns "Item", "1% Average", "Company Qty",
// "Open Stores" (the three values Wesley supplies per item for now).
//
// Sources:
//   - Item: HANA REPORTUSER.SAP_Item_Information (DEPTCODE, DCS_CODE, ISTATUS, MDQ, VendorSource).
//     Product source = VendorSource D/I (not OITM U_V33_Origin, per Wesley).
//   - Lead time: EARTHBOUND.OCRD "U_V33_BP_LEADTIME" of the item's vendor (OITM "CardCode").
//   - Arrivals: open PO lines, EARTHBOUND.POR1 "OpenQty" in the week of the line's "ShipDate".
//     Overdue lines count in the current week.
//   - Product group + week %: ../1pct-average-calc/assets/Product_Groups.xlsx and
//     Product_Group_Week_Percentage.xlsx (the "_Sales" column), or --pg-dir.
//
// Before calculating, stops and lists any item that needs a lead time and has none (statuses and
// departments below), or that isn't in SAP / has no product group.
//
// Weeks are Excel WEEKNUM(date, 1): Sunday-start, week 1 contains Jan 1. Week 54 (a one-day week
// in leap years starting on a Saturday) is ignored: its dates count as week 53.
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { hanaQuery, closeHana } = require('../hana');

const DESKTOP = path.join(os.homedir(), 'OneDrive - Earthbound Trading Company', 'Desktop');
const DEFAULT_PG_DIR = path.join(__dirname, '..', '..', '1pct-average-calc', 'assets');
const DAY = 864e5;

const LEAD_TIME_STATUSES = ['Staple', 'Reorder', 'SpringSummer', 'FallWinter', 'Online', 'SelectedStores',
  'FashionFocusStore', 'StapleSS', 'StapleFW'];
const LEAD_TIME_DEPTS = ['Accessory', 'Aroma and Spa', 'Clothing', 'HomeDecor', 'Impulse', 'Jewelry'];
const SPRING_SUMMER = ['SpringSummer', 'StapleSS'];
const FALL_WINTER = ['FallWinter', 'StapleFW'];
const COVERAGE_DAYS = { Staple: 112 }; // 16 weeks; every other non-seasonal status: 84 (12 weeks)
const OTHER_COVERAGE_DAYS = 84;
const REORDER_SIGNAL_DAYS = 42; // seasonal "Order" window opens 6 weeks before the required ETA

function parseArgs(argv) {
  let input = path.join(DESKTOP, 'Qty_Needed_Input.xlsx'), out = null, today = null, pgDir = DEFAULT_PG_DIR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--today') today = argv[++i];
    else if (a === '--pg-dir') pgDir = argv[++i];
    else if (!a.startsWith('--')) input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return { input, out, today, pgDir };
}

const text = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map(t => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
};
const num = v => { const s = text(v).replace(/,/g, '').trim(); return s === '' ? null : Number(s); };

// --- Dates and weeks (all dates are UTC midnights) ---
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const yearOf = t => new Date(t).getUTCFullYear();
const iso = t => new Date(t).toISOString().slice(0, 10);
const weekNum = t => {
  const j1 = utc(yearOf(t), 1, 1);
  return Math.min(Math.floor(((t - j1) / DAY + new Date(j1).getUTCDay()) / 7) + 1, 53);
};
const yrwk = t => yearOf(t) * 100 + weekNum(t);
const nextYrwk = w => (w % 100 >= 53 ? (Math.floor(w / 100) + 1) * 100 + 1 : w + 1);
const weekStart = (y, w) => { const j1 = utc(y, 1, 1); return j1 + ((w - 1) * 7 - new Date(j1).getUTCDay()) * DAY; };
const weekEnd = (y, w) => (w >= 53 ? utc(y, 12, 31) : weekStart(y, w) + 6 * DAY);
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// Period ETA / LTD - Natalie's ETA/LTD workbook with Wesley's 2026-10-25 changes.
function etaLtd(it, today) {
  const src = String(it.VendorSource || '').trim().toUpperCase();
  const domestic = ['D', 'DOM', 'DOMESTIC'].includes(src);
  const start = today + (domestic ? 14 : 28) * DAY;          // production start (deposit date)
  const initialEta = start + it.leadTime * DAY;
  const r = { start, initialEta, signal: '' };
  const seasonal = SPRING_SUMMER.includes(it.ISTATUS) ? 'SS' : FALL_WINTER.includes(it.ISTATUS) ? 'FW' : null;
  if (!seasonal) {
    r.eta = initialEta;
    r.ltd = initialEta + (COVERAGE_DAYS[it.ISTATUS] || OTHER_COVERAGE_DAYS) * DAY;
    return r;
  }
  const clothing = String(it.DCS_CODE || '').startsWith('CL') || it.DEPTCODE === 'Clothing';
  const etaWk = seasonal === 'SS' ? (clothing ? 5 : 10) : 36;
  const ltdWk = seasonal === 'SS' ? 30 : 53;
  // SpringSummer rolls to next year's season once the initial ETA is past the LTD week; FallWinter never rolls.
  const year = seasonal === 'SS' && weekNum(initialEta) > ltdWk ? yearOf(initialEta) + 1 : yearOf(initialEta);
  const reqEta = weekStart(year, etaWk), reqLtd = weekEnd(year, ltdWk);
  r.signal = initialEta >= reqEta - REORDER_SIGNAL_DAYS * DAY && initialEta < reqLtd ? 'Order' : 'Do not order';
  if (r.signal === 'Order') { r.eta = Math.max(initialEta, reqEta); r.ltd = reqLtd; }
  return r; // "Do not order": blank Period ETA / LTD
}

async function readInput(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  let headerRow = null, cols = {};
  ws.eachRow((row, r) => {
    if (headerRow) return;
    row.eachCell(cell => { if (text(cell.value).trim() === 'Item') headerRow = r; });
    if (headerRow) row.eachCell((cell, c) => { cols[text(cell.value).trim()] = c; });
  });
  if (!headerRow) throw new Error(`No "Item" header found in ${file}`);
  for (const h of ['Item', '1% Average', 'Company Qty', 'Open Stores']) if (!cols[h]) throw new Error(`Input is missing the "${h}" column`);
  const items = [];
  ws.eachRow((row, r) => {
    if (r <= headerRow) return;
    const item = text(row.getCell(cols.Item).value).trim();
    if (!item) return;
    items.push({ item, onePct: num(row.getCell(cols['1% Average']).value), companyQty: num(row.getCell(cols['Company Qty']).value),
      stores: num(row.getCell(cols['Open Stores']).value) });
  });
  return items;
}

async function readProductGroups(dir) {
  const byHeader = async (file, sheetFn) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, file));
    const ws = wb.worksheets[0], cols = {};
    ws.getRow(1).eachCell((cell, c) => { cols[text(cell.value).trim()] = c; });
    ws.eachRow((row, r) => { if (r > 1) sheetFn(row, cols); });
  };
  const groups = new Map(), weekPct = new Map();
  await byHeader('Product_Groups.xlsx', (row, c) => groups.set(text(row.getCell(c['DCS Code']).value).trim(), text(row.getCell(c.Product_Group).value).trim()));
  await byHeader('Product_Group_Week_Percentage.xlsx', (row, c) =>
    weekPct.set(text(row.getCell(c['ProductGroup-WkNum']).value).trim(), num(row.getCell(c.Product_Group_Week_Percentage_Sales).value)));
  return { groups, weekPct };
}

async function loadSap(codes) {
  const list = codes.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const items = await hanaQuery(`SELECT s."ITEMNUMBER", s."ITEMDESCRIPTION", s."DEPTCODE", s."DCS_CODE", s."ISTATUS", s."MDQ",
      s."VendorSource", i."CardCode", c."CardName", c."U_V33_BP_LEADTIME"
    FROM "REPORTUSER"."SAP_Item_Information" s
    JOIN "EARTHBOUND"."OITM" i ON i."ItemCode" = s."ITEMNUMBER"
    LEFT JOIN "EARTHBOUND"."OCRD" c ON c."CardCode" = i."CardCode"
    WHERE s."ITEMNUMBER" IN (${list})`);
  const lines = await hanaQuery(`SELECT l."ItemCode", h."DocNum", l."LineNum", l."OpenQty", TO_VARCHAR(l."ShipDate", 'YYYY-MM-DD') AS "ShipDate"
    FROM "EARTHBOUND"."POR1" l JOIN "EARTHBOUND"."OPOR" h ON h."DocEntry" = l."DocEntry"
    WHERE l."ItemCode" IN (${list}) AND l."LineStatus" = 'O' AND h."CANCELED" = 'N' AND l."OpenQty" > 0`);
  return { items: new Map(items.map(r => [String(r.ITEMNUMBER).trim(), r])), lines };
}

function project(it, t, NOW, weekPct) {
  // Open PO lines ranked by line ETA (ties by PO#, line) - the rank is the "nth" in the Advance flag.
  const pos = it.lines.map(l => {
    const [y, m, d] = l.ShipDate.split('-').map(Number);
    return { po: Number(l.DocNum), line: Number(l.LineNum), qty: Number(l.OpenQty), shipDate: l.ShipDate, week: Math.max(yrwk(utc(y, m, d)), NOW) };
  }).sort((a, b) => a.shipDate.localeCompare(b.shipDate) || a.po - b.po || a.line - b.line);
  pos.forEach((p, i) => { p.rank = i + 1; });
  const arrivals = new Map();
  for (const p of pos) arrivals.set(p.week, (arrivals.get(p.week) || 0) + p.qty);

  const ETA = yrwk(t.eta), LTD = yrwk(t.ltd);
  const weeks = [];
  let qty = it.companyQty;
  for (let w = NOW; w <= Math.max(LTD, NOW); w = nextYrwk(w)) {
    const key = `CMPY${it.productGroup}-${String(w % 100).padStart(2, '0')}`;
    const pct = weekPct.get(key);
    if (pct === undefined || pct === null) throw new Error(`Item ${it.item}: no week % for ${key}`);
    const begin = qty, sold = it.onePct * pct * 100, arriving = arrivals.get(w) || 0;
    qty = Math.max(begin - sold, 0) + arriving;
    weeks.push({ week: w, key, pct, begin, sold, arriving, end: qty,
      phase: w < ETA ? 'Before ETA' : w === ETA ? 'ETA' : w === LTD ? 'LTD' : 'ETA to LTD' });
  }
  const inWindow = weeks.filter(x => x.week >= ETA && x.week <= LTD);
  const etaRow = weeks.find(x => x.week === ETA);
  const stockAtEta = etaRow ? etaRow.begin : null;
  const sales = inWindow.reduce((s, x) => s + x.sold, 0);
  const arriving = inWindow.reduce((s, x) => s + x.arriving, 0);
  const flags = [];
  if (weeks.some(x => x.week < ETA && x.end < it.extMdq)) flags.push('Company qty drops below Ext MDQ before next PO arrives');
  if (etaRow && etaRow.end < it.extMdq) for (const p of pos.filter(x => x.week > ETA)) flags.push(`Advance ${ordinal(p.rank)} PO# ${p.po}`);
  return { weeks, pos, ETA, LTD, stockAtEta, sales, arriving, flags,
    // Rounded up to a whole unit (placeholder - see docs/open-questions.md).
    qtyNeeded: etaRow ? Math.max(0, Math.ceil(sales + it.extMdq - stockAtEta - arriving - 1e-9)) : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const [ty, tm, td] = args.today ? args.today.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const today = utc(ty, tm, td), NOW = yrwk(today);

  const input = await readInput(args.input);
  if (!input.length) throw new Error(`No items in ${args.input}`);
  const { groups, weekPct } = await readProductGroups(args.pgDir);
  const sap = await loadSap([...new Set(input.map(i => i.item))]);

  // Check everything before calculating anything.
  const problems = [], missingLeadTime = [];
  const items = input.map(row => {
    const s = sap.items.get(row.item);
    if (!s) { problems.push(`Item ${row.item}: not found in SAP`); return null; }
    for (const [k, v] of [['1% Average', row.onePct], ['Company Qty', row.companyQty], ['Open Stores', row.stores]])
      if (v === null || !Number.isFinite(v)) problems.push(`Item ${row.item}: "${k}" is blank or not a number`);
    const it = { ...row, ...s, leadTime: Number(s.U_V33_BP_LEADTIME) || null, productGroup: groups.get(s.DCS_CODE) || null,
      lines: sap.lines.filter(l => String(l.ItemCode).trim() === row.item) };
    it.extMdq = (Number(it.MDQ) || 0) * (row.stores || 0);
    if (!it.leadTime) {
      if (LEAD_TIME_STATUSES.includes(it.ISTATUS) && LEAD_TIME_DEPTS.includes(it.DEPTCODE))
        missingLeadTime.push(`Item ${row.item} (${it.ISTATUS}, ${it.DEPTCODE}) - vendor ${it.CardCode || '(none)'} ${it.CardName || ''}`.trim());
      else problems.push(`Item ${row.item} (${it.ISTATUS || 'no IStatus'}, ${it.DEPTCODE || 'no department'}): no vendor lead time, so no ETA can be calculated`);
    }
    if (!it.productGroup) problems.push(`Item ${row.item}: DCS ${it.DCS_CODE || '(blank)'} has no product group in Product_Groups.xlsx`);
    return it;
  });
  if (missingLeadTime.length || problems.length) {
    if (missingLeadTime.length) console.error(`Missing vendor lead time (required for these items):\n  ${missingLeadTime.join('\n  ')}`);
    if (problems.length) console.error(`Other problems:\n  ${problems.join('\n  ')}`);
    throw new Error('Nothing calculated - fix the items above (or remove them from the input) and run again');
  }

  const results = items.map(it => {
    const t = etaLtd(it, today);
    const p = t.eta === undefined ? null : project(it, t, NOW, weekPct);
    return { it, t, p };
  });

  // --- Output ---
  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet('Qty Needed', { views: [{ state: 'frozen', ySplit: 1, zoomScale: 80 }] });
  sum.columns = [
    ['Item', 9], ['Description', 32], ['Department', 13], ['DCS', 10], ['IStatus', 14], ['Product Group', 9],
    ['1% Average', 9], ['Company Qty (today)', 11], ['Open Stores', 8], ['MDQ', 6], ['Ext MDQ', 8],
    ['Vendor', 9], ['Vendor Name', 26], ['Lead Time (days)', 9], ['Product Source', 10],
    ['Production Start', 11, 'date'], ['Initial ETA', 11, 'date'], ['Seasonal Signal', 12],
    ['Period ETA', 11, 'date'], ['Period ETA YRWK', 10], ['Period LTD', 11, 'date'], ['Period LTD YRWK', 10],
    ['Number of Weeks', 8], ['Period LTD Flag', 8], ['Qty at Start of ETA Week', 11], ['Sales ETA to LTD', 11],
    ['PO Arrivals ETA to LTD', 11], ['Qty Needed', 10], ['Flags', 60], ['Open POs (PO# week qty)', 45],
  ].map(([header, width, kind]) => ({ header, width, style: kind === 'date' ? { numFmt: 'mm/dd/yy' } : {} }));
  for (const { it, t, p } of results) {
    const d = x => (x === undefined ? null : new Date(x));
    const nonSeasonal = !t.signal;
    sum.addRow([
      Number(it.item), it.ITEMDESCRIPTION, it.DEPTCODE, it.DCS_CODE, it.ISTATUS, it.productGroup,
      it.onePct, it.companyQty, it.stores, Number(it.MDQ) || 0, it.extMdq,
      it.CardCode, it.CardName, it.leadTime, String(it.VendorSource || '').toUpperCase() === 'D' ? 'Domestic' : 'International',
      d(t.start), d(t.initialEta), t.signal || null,
      d(t.eta), p ? p.ETA : null, d(t.ltd), p ? p.LTD : null,
      p ? Math.round((t.ltd - t.eta) / (7 * DAY)) : null,
      // Natalie's workbook flag: a non-seasonal LTD in week 48+ runs into the holidays.
      p ? (nonSeasonal && p.LTD % 100 >= 48 ? 'Flag' : 'OK') : null,
      p ? Math.round(p.stockAtEta * 10) / 10 : null, p ? Math.round(p.sales * 10) / 10 : null, p ? p.arriving : null,
      p ? p.qtyNeeded : null,
      p ? p.flags.join('; ') || null : 'Seasonal "Do not order" - no ETA/LTD',
      (p ? p.pos : it.lines).map(x => (p ? `${x.po} ${x.week} ${x.qty}` : `${x.DocNum} ${x.ShipDate} ${Number(x.OpenQty)}`)).join('; ') || null,
    ]);
  }
  const proj = wb.addWorksheet('Projection', { views: [{ state: 'frozen', ySplit: 1, zoomScale: 80 }] });
  proj.columns = [['Item', 9], ['YearWeek', 9], ['ProductGroup-WkNum', 14], ['Week % Sales', 9], ['Qty at Start of Week', 11],
    ['Est. Qty Sold', 10], ['Arriving Qty (end of week)', 11], ['Qty at End of Week', 11], ['Below Ext MDQ', 8], ['Period', 11]]
    .map(([header, width]) => ({ header, width }));
  for (const { it, p } of results) {
    if (!p) continue;
    for (const x of p.weeks) {
      proj.addRow([Number(it.item), x.week, x.key, x.pct, Math.round(x.begin * 10) / 10, Math.round(x.sold * 10) / 10,
        x.arriving, Math.round(x.end * 10) / 10, x.end < it.extMdq ? 'Yes' : null, x.phase]);
    }
  }
  for (const ws of [sum, proj]) {
    const h = ws.getRow(1);
    h.font = { bold: true };
    h.alignment = { wrapText: true, vertical: 'top' };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  }
  proj.getColumn(4).numFmt = '0.0%';

  const stamp = `${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}-${String(ty).slice(-2)}`;
  const file = args.out ? path.resolve(args.out) : path.join(DESKTOP, `${stamp}-Qty_Needed.xlsx`);
  await wb.xlsx.writeFile(file);
  for (const { it, t, p } of results)
    console.log(`${it.item} | ${it.ISTATUS} | ETA ${p ? p.ETA : '-'} LTD ${p ? p.LTD : '-'} | Qty Needed ${p ? p.qtyNeeded : '-'}${t.signal === 'Do not order' ? ' (Do not order)' : ''}${p && p.flags.length ? ' | ' + p.flags.join('; ') : ''}`);
  console.log(`Wrote ${file} (${results.length} items, today = ${iso(today)}, week ${NOW})`);
}

main()
  .catch(err => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(closeHana);
