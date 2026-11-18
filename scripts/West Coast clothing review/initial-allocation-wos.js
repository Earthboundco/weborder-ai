// Initial allocation weeks-of-supply check for one launch code / department at a set of stores
// (built 2026-11-18 for Will Ables' West Coast clothing question).
//
// Per item/store combo:
//  - First received date + initial qty = the store's first DC shipment of the item (EARTHBOUND.OINM,
//    TransType 67 with Ref2 'ITR' or 'HDQ' into the store's warehouse; all postings on that first
//    date are summed). Store-to-store transfers (Ref2 = a store code) are not DC shipments.
//  - Sales in the 4 weeks starting on the first received date (days 0-27, EBT.dbo.salesfact,
//    netted returns), split into weeks 1-4.
//  - Avg weekly sales = 4-week sales / 4; weeks of supply = initial qty / avg weekly sales.
//    Combos with under 4 full weeks of sales history so far use the full weeks available.
//  - Extra DC units = DC shipments after the first received date within the 8-week launch window
//    (days 1-55).
// Combos under 4 weeks of supply are highlighted.
//
// Usage: node "scripts/West Coast clothing review/initial-allocation-wos.js"

const path = require('path');
const ExcelJS = require('exceljs');
const { getPool } = require('../../db');
const { hanaQuery, closeHana } = require('../../hana');

const LAUNCH_CODE = '26 Fall Fashion';
const DEPARTMENT = 'Clothing';
const STORES = ['420', '438', '442', '444', '445', '447', '450', '454', '495', '526', '531', '545'];
const WOS_TARGET = 4;
const OUT_DIR = 'C:\\Users\\wesley\\OneDrive - Earthbound Trading Company\\Desktop\\Claude files';

const DAY = 86400000;
const toUtc = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(toUtc(s) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const lastSalesDay = addDays(today, -1); // salesfact is loaded through yesterday

  // Items
  const items = await hanaQuery(
    `SELECT "ITEMNUMBER", "ITEMDESCRIPTION", "DCS_CODE", "SIZE", "OriginalPrice", "CurrentPrice"
     FROM REPORTUSER."SAP_Item_Information" WHERE "LAUNCH_CODE" = ? AND "DEPTCODE" = ?`,
    [LAUNCH_CODE, DEPARTMENT]);
  const itemInfo = {};
  items.forEach(i => { itemInfo[String(i.ITEMNUMBER).trim()] = i; });
  const itemList = Object.keys(itemInfo);
  const itemSql = itemList.map(i => `'${i}'`).join(',');
  const storeSql = STORES.map(s => `'${s}'`).join(',');

  // DC shipments into the stores
  const receipts = await hanaQuery(
    `SELECT "ItemCode" item, "Warehouse" store, TO_VARCHAR("DocDate", 'YYYY-MM-DD') d, SUM("InQty") q
     FROM EARTHBOUND.OINM
     WHERE "TransType" = 67 AND "Ref2" IN ('ITR', 'HDQ') AND "InQty" > 0
       AND "Warehouse" IN (${storeSql}) AND "ItemCode" IN (${itemSql})
     GROUP BY "ItemCode", "Warehouse", TO_VARCHAR("DocDate", 'YYYY-MM-DD')`);
  await closeHana();

  const combos = {};
  receipts.forEach(r => {
    const k = `${String(r.STORE).trim()}|${String(r.ITEM).trim()}`;
    (combos[k] = combos[k] || []).push({ d: r.D, q: Math.round(+r.Q) });
  });

  // Stores + sales
  const pool = await getPool();
  pool.config.requestTimeout = 600000;
  const dir = (await pool.request().query(
    `SELECT RTRIM([Code #]) code, [ID #] id, [STORE NAME] name, STATE st, WStoreSize sz
     FROM EBT.dbo.[Store Directory] WHERE RTRIM([Code #]) IN (${storeSql})`)).recordset;
  const store = {}; const idToCode = {};
  dir.forEach(s => { store[s.code] = s; idToCode[s.id] = s.code; });

  const firstDate = receipts.reduce((m, r) => (r.D < m ? r.D : m), '9999-12-31');
  const sales = {};
  (await pool.request().query(
    `SELECT STORE_NO s, CAST(ITEM_NO AS bigint) i, CONVERT(char(10), [DATE], 120) d, SUM(SOLD_QTY) q
     FROM EBT.dbo.salesfact
     WHERE [DATE] >= '${firstDate}' AND STORE_NO IN (${dir.map(s => s.id).join(',')})
       AND ITEM_NO IN (${itemList.join(',')})
     GROUP BY STORE_NO, ITEM_NO, CONVERT(char(10), [DATE], 120)`)).recordset.forEach(r => {
    const k = `${idToCode[r.s]}|${r.i}`;
    (sales[k] = sales[k] || []).push({ d: r.d, q: r.q });
  });
  await pool.close();

  // Per combo
  const rows = [];
  for (const [k, recs] of Object.entries(combos)) {
    const [code, item] = k.split('|');
    recs.sort((a, b) => a.d.localeCompare(b.d));
    const first = recs[0].d;
    const initial = recs.filter(r => r.d === first).reduce((s, r) => s + r.q, 0);
    const extra = recs.filter(r => { const n = dayDiff(first, r.d); return n >= 1 && n <= 55; });
    const extraQty = extra.reduce((s, r) => s + r.q, 0);

    const weeksSince = Math.max(0, Math.floor((dayDiff(first, lastSalesDay) + 1) / 7));
    const fullWeeks = Math.min(4, weeksSince);
    const wk = [0, 0, 0, 0];
    (sales[k] || []).forEach(s => {
      const n = dayDiff(first, s.d);
      if (n >= 0 && n < 28) wk[Math.floor(n / 7)] += s.q;
    });
    const sold = wk.slice(0, fullWeeks).reduce((a, b) => a + b, 0);
    const avg = fullWeeks ? sold / fullWeeks : null;
    const wos = avg > 0 ? initial / avg : null;
    const it = itemInfo[item];
    const s = store[code];
    rows.push({
      store: `${code} ${s ? s.name.trim() : ''}`, code, state: s ? s.st : '', item: +item,
      desc: it.ITEMDESCRIPTION, dcs: it.DCS_CODE, size: it.SIZE || '', price: +it.OriginalPrice,
      first, initial, wk, fullWeeks, weeksSince, sold, avg, st: initial ? sold / initial : null, wos,
      under: wos !== null && wos < WOS_TARGET, extraQty, extraCount: extra.length,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code) || a.item - b.item);

  // Workbook
  const wb = new ExcelJS.Workbook();
  const red = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
  const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  const styleHeader = ws => {
    ws.getRow(1).eachCell(c => { c.font = { bold: true }; c.fill = head; c.alignment = { wrapText: true, vertical: 'middle' }; });
    ws.getRow(1).height = 45;
    ws.views = [{ state: 'frozen', ySplit: 1, zoomScale: 80 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  };

  // Summary by store
  const sum = wb.addWorksheet('Summary by store');
  sum.columns = [
    { header: 'Store', key: 'store', width: 22 }, { header: 'State', key: 'state', width: 7 },
    { header: 'Store size', key: 'sz', width: 12 },
    { header: 'Item/store combos', key: 'n', width: 10 }, { header: 'Initial qty', key: 'init', width: 10 },
    { header: '4-wk sales', key: 'sold', width: 10 }, { header: '4-wk sell-through', key: 'st', width: 11 },
    { header: 'Avg weekly sales', key: 'avg', width: 10 },
    { header: 'Weeks of supply (initial)', key: 'wos', width: 11 },
    { header: `Combos under ${WOS_TARGET} wks`, key: 'under', width: 10 },
    { header: `% combos under ${WOS_TARGET} wks`, key: 'underPct', width: 10 },
    { header: 'Combos with no sales in 4 wks', key: 'zero', width: 11 },
    { header: 'Under-4 combos that got more DC units in 8 wks', key: 'underExtra', width: 14 },
    { header: 'Extra DC units in 8 wks (all combos)', key: 'extra', width: 12 },
  ];
  for (const code of STORES) {
    const r = rows.filter(x => x.code === code && x.fullWeeks === 4);
    if (!r.length) continue;
    const init = r.reduce((a, x) => a + x.initial, 0);
    const sold = r.reduce((a, x) => a + x.sold, 0);
    const under = r.filter(x => x.under);
    sum.addRow({
      store: r[0].store, state: r[0].state, sz: store[code] ? store[code].sz : '', n: r.length, init, sold,
      st: init ? sold / init : null, avg: sold / 4, wos: sold ? init / (sold / 4) : null,
      under: under.length, underPct: under.length / r.length,
      zero: r.filter(x => x.sold <= 0).length,
      underExtra: under.filter(x => x.extraQty > 0).length,
      extra: r.reduce((a, x) => a + x.extraQty, 0),
    });
  }
  ['st', 'underPct'].forEach(k => { sum.getColumn(k).numFmt = '0%'; });
  ['avg', 'wos'].forEach(k => { sum.getColumn(k).numFmt = '0.0'; });
  styleHeader(sum);

  // 8-week summary: items with at least 8 full weeks since first receipt, split at 3 weeks of supply
  const s8 = wb.addWorksheet('8-week summary');
  s8.columns = [
    { header: 'Store', key: 'store', width: 22 }, { header: 'State', key: 'state', width: 7 },
    { header: 'Items with 8+ weeks of sales history', key: 'n', width: 14 },
    { header: 'Of those: weeks of supply (initial) 3 or more', key: 'ge3', width: 16 },
    { header: 'Of those: weeks of supply (initial) under 3', key: 'lt3', width: 16 },
    { header: 'Under 3 that received replenishment in the 8 weeks', key: 'lt3Rep', width: 18 },
    { header: 'Under 3 with no replenishment in the 8 weeks', key: 'lt3NoRep', width: 18 },
  ];
  const tot = { store: 'Total', n: 0, ge3: 0, lt3: 0, lt3Rep: 0, lt3NoRep: 0 };
  for (const code of STORES) {
    const r = rows.filter(x => x.code === code && x.weeksSince >= 8);
    if (!r.length) continue;
    const lt3 = r.filter(x => x.wos !== null && x.wos < 3);
    const v = {
      store: r[0].store, state: r[0].state, n: r.length, ge3: r.length - lt3.length, lt3: lt3.length,
      lt3Rep: lt3.filter(x => x.extraQty > 0).length, lt3NoRep: lt3.filter(x => x.extraQty <= 0).length,
    };
    ['n', 'ge3', 'lt3', 'lt3Rep', 'lt3NoRep'].forEach(k => { tot[k] += v[k]; });
    s8.addRow(v);
  }
  s8.addRow(tot).font = { bold: true };
  styleHeader(s8);

  // Detail
  const det = wb.addWorksheet('Detail by item-store');
  det.columns = [
    { header: 'Store', key: 'store', width: 22 }, { header: 'State', key: 'state', width: 7 },
    { header: 'Item', key: 'item', width: 9 }, { header: 'Description', key: 'desc', width: 40 },
    { header: 'DCS', key: 'dcs', width: 11 }, { header: 'Size', key: 'size', width: 7 },
    { header: 'Retail price', key: 'price', width: 9 },
    { header: 'First received date', key: 'first', width: 12 },
    { header: 'Initial qty', key: 'initial', width: 9 },
    { header: 'Wk 1 sales', key: 'w1', width: 8 }, { header: 'Wk 2 sales', key: 'w2', width: 8 },
    { header: 'Wk 3 sales', key: 'w3', width: 8 }, { header: 'Wk 4 sales', key: 'w4', width: 8 },
    { header: 'Full weeks of sales data', key: 'fw', width: 9 },
    { header: '4-wk sales', key: 'sold', width: 8 }, { header: '4-wk sell-through', key: 'st', width: 10 },
    { header: 'Avg weekly sales', key: 'avg', width: 9 },
    { header: 'Weeks of supply (initial)', key: 'wos', width: 10 },
    { header: `Under ${WOS_TARGET} wks?`, key: 'under', width: 8 },
    { header: 'Extra DC units in 8 wks', key: 'extra', width: 10 },
    { header: 'Extra DC shipments in 8 wks', key: 'extraN', width: 10 },
  ];
  rows.forEach(x => {
    const row = det.addRow({
      store: x.store, state: x.state, item: x.item, desc: x.desc, dcs: x.dcs, size: x.size, price: x.price,
      first: x.first, initial: x.initial, w1: x.wk[0], w2: x.wk[1], w3: x.wk[2], w4: x.wk[3], fw: x.fullWeeks,
      sold: x.sold, st: x.st, avg: x.avg,
      wos: x.wos === null ? (x.fullWeeks ? 'No sales' : 'n/a') : x.wos,
      under: x.under ? 'Yes' : '', extra: x.extraQty, extraN: x.extraCount,
    });
    if (x.under) row.eachCell(c => { c.fill = red; });
    // Blank out sales weeks not yet complete
    for (let w = x.fullWeeks; w < 4; w++) row.getCell(10 + w).value = null;
  });
  det.getColumn('price').numFmt = '$0.00';
  det.getColumn('st').numFmt = '0%';
  ['avg', 'wos'].forEach(k => { det.getColumn(k).numFmt = '0.0'; });
  styleHeader(det);

  // Notes
  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 120;
  [
    `Launch code: ${LAUNCH_CODE}. Department: ${DEPARTMENT}. Stores: ${STORES.join(', ')}. Generated ${today}; sales through ${lastSalesDay}.`,
    'Initial qty / first received date: the store\'s first DC shipment of the item in the SAP inventory ledger (OINM, DC transfer into the store). All DC postings on that first date are added together.',
    'Sales: EBT salesfact, net of returns, in the 4 weeks (28 days) starting on the first received date.',
    'Avg weekly sales = 4-week sales / 4. Weeks of supply = initial qty / avg weekly sales. "No sales" = nothing sold in 4 weeks (supply can\'t be measured).',
    'Combos with fewer than 4 full weeks since first receipt use only the full weeks available ("Full weeks of sales data" column) and are left out of the store summary.',
    `Highlighted rows: initial qty covered under ${WOS_TARGET} weeks of sales.`,
    'Extra DC units in 8 wks: DC shipments of the same item to the same store from the day after the first received date through day 55 (8-week launch window). Store-to-store transfers are not included.',
    'Sell-through = 4-week sales / initial qty.',
    '8-week summary: items whose first received date is at least 8 full weeks before the last sales day. "3 or more" includes items with no sales in their first 4 weeks (initial qty never ran short). Replenishment = any extra DC units in days 1-55 after the first received date.',
  ].forEach(t => { notes.addRow([t]).getCell(1).alignment = { wrapText: true }; });

  const file = path.join(OUT_DIR, `West_Coast_Clothing_${LAUNCH_CODE.replace(/ /g, '_')}_Initial_WOS_${today}.xlsx`);
  await wb.xlsx.writeFile(file);

  const complete = rows.filter(x => x.fullWeeks === 4);
  console.log(`Items in launch: ${itemList.length}; combos received: ${rows.length}; with 4 full weeks: ${complete.length}`);
  console.log(`Under ${WOS_TARGET} wks: ${complete.filter(x => x.under).length}; no sales: ${complete.filter(x => x.sold <= 0).length}`);
  console.log(`Saved ${file}`);
})().catch(e => { console.error(e); process.exit(1); });
