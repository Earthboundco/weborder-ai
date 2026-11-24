// Clothing clearance penetration, inventory availability and 26 Fall Fashion sell-through for a set
// of stores, compared with the company (built 2026-11-18 for Will Ables' West Coast clothing question).
//
// Definitions (Sales_Inventory_analysis/docs/business-rules.md):
//  - Clearance (discounted) item: |Retail - Sale| / Retail > 5% AND EBT Markdwn = Y (live SAP item master).
//  - Inventory value = on-hand qty x LCost. Store on-hand = EBT.dbo.INVN_SBS_QTY_V (live, rounded).
//  - Clothing = SAP Department "Clothing".
// Sales = EBT.dbo.salesfact over the last 4 complete Sun-Sat weeks. Clearance sales share uses each
// item's CURRENT clearance status (SAP has no status history).
// Company = every open store (non-blank WStoreType) except 470 Ecommerce and the DC, with clothing
// sales in the 4 weeks. Company % = company totals; company units/$ = average per store.
// 26 Fall Fashion sell-through: same method as initial-allocation-wos.js (first DC receipt from
// EARTHBOUND.OINM, sales in the 4 weeks from that date), run for every store.
//
// Usage: node "scripts/West Coast clothing review/clearance-company-comparison.js"

const path = require('path');
const ExcelJS = require('exceljs');
const { getPool } = require('../../db');
const { hanaQuery, closeHana } = require('../../hana');
const { loadItemInfo } = require('../../item-info');

const STORES = ['420', '438', '442', '444', '445', '447', '450', '454', '495', '526', '531', '545'];
const LAUNCH_CODE = '26 Fall Fashion';
const OUT_DIR = 'C:\\Users\\wesley\\OneDrive - Earthbound Trading Company\\Desktop\\Claude files';

const DAY = 86400000;
const toUtc = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(toUtc(s) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);
const div = (a, b) => (b ? a / b : null);

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const lastSalesDay = addDays(today, -1);
  // Last 4 complete Sun-Sat weeks
  const dow = new Date(toUtc(today)).getUTCDay();
  const wkEnd = addDays(today, -(dow + 1)); // last Saturday
  const wkStart = addDays(wkEnd, -27);

  // --- Items ---
  const info = await loadItemInfo();
  const item = new Map();
  for (const [code, r] of info.items) {
    const retail = +r['Retail Price'] || 0, sale = r['Sale Price'] === '' ? retail : +r['Sale Price'];
    const clr = !!retail && Math.abs(retail - sale) / retail > 0.05 && r['EBT Markdwn'] === 'Y';
    const lc = r['Launch Code'];
    const yr = /^\d{2}\s/.test(lc) ? +lc.slice(0, 2) : null;
    item.set(code, { cl: r.Department === 'Clothing', clr, lcost: +r.LCost || 0, launch: lc, yr });
  }
  const fallItems = [...item].filter(([, v]) => v.cl && v.launch === LAUNCH_CODE).map(([k]) => k);

  // --- 26 Fall Fashion first DC receipts, all stores ---
  const receipts = await hanaQuery(
    `SELECT "ItemCode" item, "Warehouse" store, TO_VARCHAR("DocDate", 'YYYY-MM-DD') d, SUM("InQty") q
     FROM EARTHBOUND.OINM
     WHERE "TransType" = 67 AND "Ref2" IN ('ITR', 'HDQ') AND "InQty" > 0
       AND "ItemCode" IN (${fallItems.map(i => `'${i}'`).join(',')})
     GROUP BY "ItemCode", "Warehouse", TO_VARCHAR("DocDate", 'YYYY-MM-DD')`);
  await closeHana();

  // --- Stores, on-hand, sales ---
  const pool = await getPool();
  pool.config.requestTimeout = 600000;
  const dir = (await pool.request().query(
    `SELECT RTRIM([Code #]) code, [ID #] id, [STORE NAME] name, STATE st, WStoreSize sz, WStoreType t
     FROM EBT.dbo.[Store Directory]`)).recordset;
  const idToCode = {}; const store = {};
  dir.forEach(s => { idToCode[s.id] = s.code; store[s.code] = s; });
  const open = new Set(dir.filter(s => (s.t || '').trim() && !['470', '0', '000'].includes(s.code)).map(s => s.code));

  const S = {}; // per-store metrics
  const get = c => (S[c] = S[c] || {
    invAll: 0, clrAll: 0, u: 0, inv: 0, cu: 0, cinv: 0, items: 0, fpItems: 0, fpU: 0,
    age: { y26: 0, y25: 0, old: 0, none: 0 }, sold: 0, salesD: 0, clrSalesD: 0, fpSold: 0,
  });

  (await pool.request().query(
    `SELECT STORE_NO s, CAST(ITEM_NO AS bigint) i, ROUND(SUM(QTY), 0) q FROM EBT.dbo.INVN_SBS_QTY_V WITH (NOLOCK)
     WHERE STORE_NO <> 0 GROUP BY STORE_NO, ITEM_NO HAVING ROUND(SUM(QTY), 0) > 0`)).recordset.forEach(r => {
    const c = idToCode[r.s]; const it = item.get(String(r.i));
    if (!c || !open.has(c) || !it) return;
    const s = get(c); const v = r.q * it.lcost;
    s.invAll += v; if (it.clr) s.clrAll += v;
    if (!it.cl) return;
    s.u += r.q; s.inv += v; s.items++;
    if (it.clr) {
      s.cu += r.q; s.cinv += v;
      const k = it.yr === 26 ? 'y26' : it.yr === 25 ? 'y25' : it.yr === null ? 'none' : 'old';
      s.age[k] += r.q;
    } else { s.fpItems++; s.fpU += r.q; }
  });

  (await pool.request().query(
    `SELECT STORE_NO s, CAST(ITEM_NO AS bigint) i, SUM(SOLD_QTY) q, SUM(EXT_PRICE) p FROM EBT.dbo.salesfact
     WHERE [DATE] >= '${wkStart}' AND [DATE] < '${addDays(wkEnd, 1)}' GROUP BY STORE_NO, ITEM_NO`)).recordset.forEach(r => {
    const c = idToCode[r.s]; const it = item.get(String(r.i));
    if (!c || !open.has(c) || !it || !it.cl) return;
    const s = get(c);
    s.sold += r.q; s.salesD += r.p;
    if (it.clr) s.clrSalesD += r.p; else s.fpSold += r.q;
  });

  const fallSales = {};
  const firstRec = receipts.reduce((m, r) => (r.D < m ? r.D : m), '9999-12-31');
  (await pool.request().query(
    `SELECT STORE_NO s, CAST(ITEM_NO AS bigint) i, CONVERT(char(10), [DATE], 120) d, SUM(SOLD_QTY) q
     FROM EBT.dbo.salesfact WHERE [DATE] >= '${firstRec}' AND ITEM_NO IN (${fallItems.join(',')})
     GROUP BY STORE_NO, ITEM_NO, CONVERT(char(10), [DATE], 120)`)).recordset.forEach(r => {
    const k = `${idToCode[r.s]}|${r.i}`;
    (fallSales[k] = fallSales[k] || []).push({ d: r.d, q: r.q });
  });
  await pool.close();

  // 26 Fall Fashion per combo -> per store
  const combos = {};
  receipts.forEach(r => {
    const k = `${String(r.STORE).trim()}|${String(r.ITEM).trim()}`;
    (combos[k] = combos[k] || []).push({ d: r.D, q: Math.round(+r.Q) });
  });
  for (const [k, recs] of Object.entries(combos)) {
    const [c] = k.split('|');
    if (!open.has(c)) continue;
    recs.sort((a, b) => a.d.localeCompare(b.d));
    const first = recs[0].d;
    const weeksSince = Math.floor((dayDiff(first, lastSalesDay) + 1) / 7);
    if (weeksSince < 4) continue;
    const initial = recs.filter(r => r.d === first).reduce((a, r) => a + r.q, 0);
    let sold = 0;
    (fallSales[k] || []).forEach(x => { const n = dayDiff(first, x.d); if (n >= 0 && n < 28) sold += x.q; });
    const s = get(c);
    s.fN = (s.fN || 0) + 1; s.fInit = (s.fInit || 0) + initial; s.fSold = (s.fSold || 0) + sold;
    if (weeksSince >= 8) {
      const wos = sold > 0 ? initial / (sold / 4) : null;
      s.f8 = (s.f8 || 0) + 1;
      if (wos !== null && wos < 3) s.f8lt3 = (s.f8lt3 || 0) + 1;
    }
  }

  // Company stores = open stores with clothing sales in the 4 weeks
  const company = Object.keys(S).filter(c => open.has(c) && S[c].sold > 0);
  const rank = [...company].sort((a, b) => S[b].salesD - S[a].salesD);
  rank.forEach((c, i) => { S[c].rank = i + 1; });

  // --- Rows ---
  const metrics = s => ({
    invAll: s.invAll, clrAllPct: div(s.clrAll, s.invAll),
    inv: s.inv, clPct: div(s.inv, s.invAll), u: s.u,
    cu: s.cu, cuPct: div(s.cu, s.u), cinvPct: div(s.cinv, s.inv), clrSalesPct: div(s.clrSalesD, s.salesD),
    y26: div(s.age.y26, s.cu), y25: div(s.age.y25, s.cu), old: div(s.age.old, s.cu), none: div(s.age.none, s.cu),
    items: s.items, fpItems: s.fpItems, fpU: s.fpU,
    sold: s.sold, wkU: s.sold / 4, wos: div(s.u, s.sold / 4), fpWkU: s.fpSold / 4, fpWos: div(s.fpU, s.fpSold / 4),
    salesD: s.salesD,
    fN: s.fN || 0, fInit: s.fInit || 0, fSold: s.fSold || 0, fST: div(s.fSold || 0, s.fInit || 0),
    fWos: div(s.fInit || 0, (s.fSold || 0) / 4), f8: s.f8 || 0, f8lt3Pct: div(s.f8lt3 || 0, s.f8 || 0),
  });
  const sumOf = codes => {
    const t = get('__tmp'); delete S.__tmp;
    const z = { invAll: 0, clrAll: 0, u: 0, inv: 0, cu: 0, cinv: 0, items: 0, fpItems: 0, fpU: 0, sold: 0, salesD: 0, clrSalesD: 0, fpSold: 0, fN: 0, fInit: 0, fSold: 0, f8: 0, f8lt3: 0 };
    const age = { y26: 0, y25: 0, old: 0, none: 0 };
    codes.forEach(c => { for (const k in z) z[k] += S[c][k] || 0; for (const k in age) age[k] += S[c].age[k]; });
    return { ...t, ...z, age };
  };
  const avgRow = (label, codes) => {
    const m = metrics(sumOf(codes)); const n = codes.length;
    // Units, $ and item counts as average per store; % and weeks of supply from totals
    ['invAll', 'inv', 'u', 'cu', 'items', 'fpItems', 'fpU', 'sold', 'wkU', 'fpWkU', 'salesD', 'fN', 'fInit', 'fSold', 'f8']
      .forEach(k => { m[k] = m[k] / n; });
    return { label: `${label} (${n} stores)`, state: '', sz: '', rank: '', avg: true, ...m };
  };

  const rows = STORES.filter(c => S[c]).map(c => ({
    label: `${c} ${store[c].name.trim()}`, state: store[c].st, sz: store[c].sz, rank: S[c].rank, ...metrics(S[c]),
  }));
  rows.push(avgRow('12 western stores, average', STORES.filter(c => S[c])));
  rows.push(avgRow('Company average', company));
  [...new Set(company.map(c => store[c].sz))].filter(Boolean).sort()
    .forEach(sz => rows.push(avgRow(`Company average, size ${sz}`, company.filter(c => store[c].sz === sz))));

  // --- Workbook ---
  const wb = new ExcelJS.Workbook();
  const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  const grey = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  const fmt = { pct: '0%', usd: '$#,##0', n0: '#,##0', n1: '0.0' };
  const sheet = (name, cols) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: 'Store', key: 'label', width: 34 }, { header: 'State', key: 'state', width: 6 },
      { header: 'Store size', key: 'sz', width: 11 },
      ...cols.map(([header, key, f, width]) => ({ header, key, width: width || 13, style: { numFmt: fmt[f] } })),
    ];
    rows.forEach(r => { const row = ws.addRow(r); if (r.avg) row.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.fill = grey; }); });
    ws.getRow(1).eachCell(c => { c.font = { bold: true }; c.fill = head; c.alignment = { wrapText: true, vertical: 'middle' }; });
    ws.getRow(1).height = 60;
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1, zoomScale: 80 }];
  };

  sheet('Clearance penetration', [
    ['Total store inventory $ (LCost)', 'invAll', 'usd'],
    ['Total store clearance % ($, all depts)', 'clrAllPct', 'pct'],
    ['Clothing inventory $ (LCost)', 'inv', 'usd'],
    ['Clothing % of store inventory $', 'clPct', 'pct'],
    ['Clothing clearance units on-hand', 'cu', 'n0'],
    ['Clothing clearance % (units)', 'cuPct', 'pct'],
    ['Clothing clearance % ($)', 'cinvPct', 'pct'],
    [`Clothing clearance % of clothing sales $ (${wkStart} to ${wkEnd})`, 'clrSalesPct', 'pct', 16],
    ['Clearance units from 2026 launches', 'y26', 'pct'],
    ['Clearance units from 2025 launches', 'y25', 'pct'],
    ['Clearance units from 2024 & older launches', 'old', 'pct'],
    ['Clearance units, no launch code', 'none', 'pct'],
  ]);
  sheet('Inventory availability', [
    [`Clothing sales rank (of ${company.length}, $ last 4 wks)`, 'rank', 'n0'],
    ['Clothing sales $ (last 4 wks)', 'salesD', 'usd'],
    ['Clothing on-hand units', 'u', 'n0'],
    ['Clothing items in stock', 'items', 'n0'],
    ['Full-price clothing items in stock', 'fpItems', 'n0'],
    ['Clothing units sold per week (last 4 wks)', 'wkU', 'n1'],
    ['Clothing weeks of supply', 'wos', 'n1'],
    ['Full-price clothing on-hand units', 'fpU', 'n0'],
    ['Full-price clothing units sold per week', 'fpWkU', 'n1'],
    ['Full-price clothing weeks of supply', 'fpWos', 'n1'],
  ]);
  sheet('26 Fall Fashion vs company', [
    ['Item/store combos (4+ wks since first receipt)', 'fN', 'n0'],
    ['Initial qty', 'fInit', 'n0'],
    ['Sales in first 4 wks', 'fSold', 'n0'],
    ['Full-price sell-through, first 4 wks', 'fST', 'pct'],
    ['Weeks of supply (initial)', 'fWos', 'n1'],
    ['Combos with 8+ wks of history', 'f8', 'n0'],
    ['% of 8+ wk combos under 3 wks of supply', 'f8lt3Pct', 'pct'],
  ]);
  // Remove the rank column value from average rows
  wb.getWorksheet('Inventory availability').eachRow((r, i) => { if (i > 1 && r.getCell(1).font && r.getCell(1).font.bold) r.getCell(4).value = null; });

  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 120;
  [
    `Generated ${today}. Inventory is live as of today. Sales period: last 4 complete weeks, ${wkStart} to ${wkEnd}.`,
    'Clothing = SAP Department "Clothing". Clearance item = sale price more than 5% below retail AND EBT Markdwn = Y (live SAP item master).',
    'Inventory $ = on-hand units x SAP landed cost (LCost). Store on-hand: Retail Pro (INVN_SBS_QTY_V).',
    '"Total store clearance %" covers all departments (including home). The clothing columns isolate clothing, so home clearance (e.g. from the Beverly Center closure) does not affect them.',
    'Clearance % of clothing sales uses each item\'s current clearance status; SAP does not keep a status history. 26 Fall Fashion items marked down on 10/19 count as clearance for the whole period.',
    'Clearance by launch: share of the store\'s clothing clearance units, by the year in the item\'s launch code (e.g. "26 Fall Fashion" = 2026).',
    'Weeks of supply = on-hand units / units sold per week (last 4 weeks average).',
    `Company = every open store except 470 Ecommerce and the DC, with clothing sales in the period (${company.length} stores). Company and size-tier rows: units, $ and item counts are averages per store; percentages and weeks of supply come from the totals.`,
    `26 Fall Fashion: same method as the West_Coast_Clothing_26_Fall_Fashion_Initial_WOS report (first DC receipt, sales in the 4 weeks from that date), run for every store. Only combos with 4+ full weeks since first receipt are counted. No markdowns occurred in anyone's first 4 weeks (first markdown 10/19), so this is full-price sell-through.`,
  ].forEach(t => { notes.addRow([t]).getCell(1).alignment = { wrapText: true }; });

  const file = path.join(OUT_DIR, `West_Coast_Clothing_Clearance_and_Company_Comparison_${today}.xlsx`);
  await wb.xlsx.writeFile(file);
  console.log(`Company stores: ${company.length}; sales ${wkStart} to ${wkEnd}`);
  rows.forEach(r => console.log([r.label, r.rank, Math.round(r.clrAllPct * 100) + '%', Math.round(r.cuPct * 100) + '%', Math.round(r.cinvPct * 100) + '%', Math.round(r.clrSalesPct * 100) + '%', r.wos && r.wos.toFixed(1), r.fpWos && r.fpWos.toFixed(1), Math.round(r.items), Math.round(r.fST * 100) + '%', r.fWos && r.fWos.toFixed(1), Math.round(r.f8lt3Pct * 100) + '%', Math.round(r.y26 * 100) + '/' + Math.round(r.y25 * 100) + '/' + Math.round(r.old * 100) + '/' + Math.round(r.none * 100)].join(' | ')));
  console.log(`Saved ${file}`);
})().catch(e => { console.error(e); process.exit(1); });
