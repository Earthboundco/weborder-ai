// DPS group allocation - builds the store ranking and the allocation row for one DPS code and one period.
// Rules: ../docs/business-rules.md (Steps 1a-1c, 2a-2b, per Wesley
// 2026-11-07/08). Settled method 2026-11-08: daily units per store x item pair (7-day minimum),
// keep the top 30% of pairs per store group, x 7 = weekly, x 3, round up, minimum 1.
//
// Run from the weborder-ai folder (for .env):
//   node "DPS group allocation project/scripts/build-dps-table.js" "DPS group allocation project/Claude_results/<name>.xlsx" --dps "JE WO NK/10-13/No" --period "Holidays" [--today 2026-11-07]
const W = require('path').resolve(__dirname, '../..');   // weborder-ai root (db.js, hana.js, node_modules)
const { sql, getPool } = require(W + '/db');
const { hanaQuery, closeHana } = require(W + '/hana');
const ExcelJS = require(W + '/node_modules/exceljs');

// ---------- settings ----------
const KEEP_TOP = 0.30;          // keep the top 30% of pairs per group (count rounded up)
const MULT = 3;                 // weeks of supply
const MIN_DAYS = 7;             // minimum days per pair
const MATCH_MAX_WEEKS = 12;
const MATCH_MILES = 500;
const BRANDON_RULE_END = new Date('2027-05-31');
const STORE_GROUPS = [['A1', 1], ['A2', 5], ['A3', 6], ['B', 45], ['C', null], ['D', 20], ['E', 5]];
const NO_SALES_RANK = 57;       // last B position

// Step 1a - periods (fiscal weeks; boundary weeks count in both; Holidays runs to the last week of the year)
const PERIODS = {
  'Pre-Spring': [1, 7], 'Spring Break': [7, 14], 'Summer 1': [14, 21], 'Summer 2': [21, 28],
  'Back-to-school': [28, 34], 'Fall 1': [34, 40], 'Fall 2': [40, 46], 'Holidays': [46, 54],
};

// Step 1b - DCS groups. rank = DCSs whose sales feed the ranking; follow = DCSs whose items use it.
// A code matches itself and every DCS under it (e.g. 'JE ME' matches 'JE ME WT').
const CL = ['CL ME OW', 'CL ME PA', 'CL ME SH', 'CL ME SO', 'CL ME TS', 'CL WO DR', 'CL WO OW', 'CL WO PA', 'CL WO SH', 'CL WO SK', 'CL WO SO', 'CL WO TS'];
const DCS_GROUPS = [
  { id: '01', name: 'AC RB (reusable bags - all DCSs)', rank: ['AC RB'] },
  { id: '02', name: 'AC BA/AC HA/AC MI/AC WO (other accessories)', rank: ['AC BA', 'AC HA', 'AC MI', 'AC WO HR', 'AC WO SC', 'AC WO SU'] },
  { id: '03', name: 'AS BT/AS CA/AS SS (all aroma & spa)', rank: ['AS BT MI', 'AS CA', 'AS SS', 'AS IB', 'AS IN MI', 'AS IN SC', 'AS OB', 'AS OI'], follow: ['AS BT MI', 'AS CA', 'AS SS'] },
  { id: '04', name: 'AS IB/AS IN (incense and burners)', rank: ['AS IB', 'AS IN MI', 'AS IN SC'] },
  { id: '05', name: 'AS OB/AS OI (oil burners and oils)', rank: ['AS OB', 'AS OI'] },
  { id: '06', name: 'CL ME/CL WO (all clothing)', rank: CL },
  { id: '07', name: 'HD DO/HD KB/HD MW/HD RM (most home decor)', rank: ['HD DO CD', 'HD DO DA', 'HD DO SB', 'HD KB', 'HD MW', 'HD RM'] },
  { id: '08', name: 'HD TP/HD TX (curtains tapestries & textiles)', rank: ['HD TP', 'HD TX'] },
  { id: '09', name: 'HD WD (wall decor accessories & butterflies)', rank: ['HD WD AC', 'HD WD BF'] },
  { id: '10', name: 'IM BK/IM GF (all impulse)', rank: ['IM BK', 'IM GF'] },
  { id: '11', name: 'JE ME/JE WO (all jewelry)', rank: ['JE ME', 'JE WO AK', 'JE WO BR', 'JE WO EA', 'JE WO NK', 'JE WO RI'] },
];
const matchesAny = (dcs, codes) => codes.some(c => dcs === c || dcs.startsWith(c + ' '));

// Step 2a - DPS code parts
function priceAdjusted(p) {
  const b = [[500, '>=500'], [400, '400-500'], [350, '350-400'], [300, '300-350'], [250, '250-300'], [200, '200-250'],
    [150, '150-200'], [101, '101-150'], [91, '91-101'], [81, '81-91'], [76, '76-81'], [71, '71-76'], [66, '66-71'],
    [61, '61-66'], [56, '56-61'], [51, '51-56'], [46, '46-51'], [41, '41-46'], [36, '36-41'], [31, '31-36'],
    [26, '26-31'], [21, '21-26'], [17, '17-21'], [13, '13-17'], [10, '10-13'], [7, '7-10'], [5, '5-7'], [3, '3-5'], [1, '1-3']];
  for (const [lo, label] of b) if (p > lo) return label;
  return '0-1';
}
function sizeAdjusted(dcs, size) {
  if (!dcs.startsWith('CL')) return 'No';
  const s = (size || '').trim();
  const m = [[['XS', 'XSM'], 'XS'], [['S', 'SM', 'XS/S'], 'S'],
    [['M', 'MD', '25', '26', '27', '28', '29', '30', '31', 'REG', 'S/M/L', 'S/M', 'M/L'], 'M'],
    [['L', 'LG', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '70 IN', 'L/XL'], 'L'],
    [['XL', 'XLG'], 'XL'], [['XXL', '2XL', '2X', 'XL/XXL', '2XL/XXL', 'XL/2X'], '2X'], [['3X', '3XL'], '3X'],
    [['4X', '4XL'], '4X'], [['', '(blank)', 'O/S', 'OS'], 'No']];
  for (const [vals, out] of m) if (vals.includes(s)) return out;
  return s;
}
const sizeRank = s => Number(String(s || '0').charAt(0)) || 0;
function miles(a, b) {
  const R = 3958.8, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const iso = d => d.toISOString().slice(0, 10);
const T0 = Date.now(); const log = m => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', m);

async function main() {
  const out = process.argv[2];
  const dps = arg('--dps'), periodName = arg('--period') || 'Holidays';
  const TODAY = arg('--today') ? new Date(arg('--today')) : new Date(iso(new Date()));
  if (!out || out.startsWith('--') || !dps) throw new Error('Usage: node build-dps-table.js <output.xlsx> --dps "JE WO NK/10-13/No" --period "Holidays" [--today YYYY-MM-DD]');
  if (!PERIODS[periodName]) throw new Error(`Unknown period "${periodName}". Use one of: ${Object.keys(PERIODS).join(', ')}`);
  const [pFrom, pTo] = PERIODS[periodName];
  const [tDcs, tPrice, tSize] = dps.split('/');
  if (!tDcs || !tPrice || !tSize) throw new Error(`DPS code must be DCS/Price/Size, got "${dps}"`);
  const dg = DCS_GROUPS.find(g => matchesAny(tDcs, g.follow || g.rank));
  if (!dg) throw new Error(`DCS ${tDcs} is not in any DCS group (out of scope)`);
  // last 3 full fiscal years before the current one
  const YEARS = [1, 2, 3].map(k => TODAY.getFullYear() - k).reverse();

  const pool = await getPool();
  // ---------- stores ----------
  const stores = (await pool.request().query(`
    SELECT [Code #] code, [ID #] id, [STORE NAME] name, STATE state, WStoreSize size, Tourist_location tourist,
           Latitude lat, Longitude lon, [OPEN] opened
    FROM EBT.dbo.[Store Directory] WHERE ISNULL(WStoreType,'') <> '' AND [Code #] <> '470'`)).recordset
    .map(s => ({ ...s, code: s.code.trim(), lat: Number(s.lat), lon: Number(s.lon) }));
  const byId = new Map(stores.map(s => [s.id, s]));

  // ---------- calendar: period start per year; the last 12 complete weeks before this week ----------
  const cal = (await pool.request().query(`
    SELECT YEAR y, MIN(DATE) d0, MAX(DATE) d1 FROM EBT.dbo.salesfact
    WHERE YEAR IN (${YEARS.join(',')}) AND WEEK BETWEEN ${pFrom} AND ${pTo} GROUP BY YEAR`)).recordset;
  const periodStart = new Map(cal.map(r => [r.y, r.d0]));
  const weekStart = new Date(TODAY); weekStart.setUTCDate(TODAY.getUTCDate() - TODAY.getUTCDay());   // Sunday of this week
  const recentCal = (await pool.request().query(`
    SELECT YEAR * 100 + WEEK yw, MAX(DATE) d1 FROM EBT.dbo.salesfact
    WHERE DATE >= '${iso(new Date(weekStart - 120 * 864e5))}' AND DATE < '${iso(weekStart)}'
    GROUP BY YEAR * 100 + WEEK`)).recordset.sort((a, b) => a.yw - b.yw).slice(-MATCH_MAX_WEEKS);
  const recentWks = recentCal.map(r => r.yw);
  const weekEnd = new Map(recentCal.map(r => [r.yw, r.d1]));
  log(`calendar loaded: years ${YEARS.join('/')}, match weeks ${recentWks[0]}-${recentWks[recentWks.length - 1]}`);

  // ---------- items: current SAP attributes ----------
  const items = (await hanaQuery(`SELECT "ITEMNUMBER","DCS_CODE","SIZE" FROM "SAP_Item_Information" WHERE "DCS_CODE" LIKE '${dg.rank[0].slice(0, 2)}%'`))
    .filter(r => r.DCS_CODE && matchesAny(r.DCS_CODE, dg.rank) && /^\d+$/.test(r.ITEMNUMBER))
    .map(r => ({ item: Number(r.ITEMNUMBER), dcs: r.DCS_CODE, size: sizeAdjusted(r.DCS_CODE, r.SIZE) }));
  const itemInfo = new Map(items.map(i => [i.item, i]));
  log(`items loaded: ${items.length} in DCS group ${dg.id}`);

  // ---------- sales (one batch: the temp table must live in the same batch) ----------
  const ids = [...itemInfo.keys()];
  let batch = 'SET NOCOUNT ON; CREATE TABLE #items (ITEM_NO int PRIMARY KEY);\n';
  for (let k = 0; k < ids.length; k += 1000)
    batch += `INSERT INTO #items (ITEM_NO) VALUES ${ids.slice(k, k + 1000).map(x => `(${Number(x)})`).join(',')};\n`;
  batch += `
    SELECT s.STORE_NO st, s.ITEM_NO item, s.YEAR y, s.DATE d, s.SOLD_QTY q, s.EXT_PRICE p
    FROM EBT.dbo.salesfact s JOIN #items i ON i.ITEM_NO = s.ITEM_NO
    WHERE s.YEAR IN (${YEARS.join(',')}) AND s.WEEK BETWEEN ${pFrom} AND ${pTo} AND (s.EXT_PRICE > 0 OR s.SOLD_QTY > 0);
    SELECT s.STORE_NO st, s.YEAR * 100 + s.WEEK yw, SUM(CASE WHEN i.ITEM_NO IS NOT NULL AND s.EXT_PRICE > 0 THEN s.EXT_PRICE ELSE 0 END) p
    FROM EBT.dbo.salesfact s LEFT JOIN #items i ON i.ITEM_NO = s.ITEM_NO
    WHERE s.YEAR * 100 + s.WEEK IN (${recentWks.join(',')})
    GROUP BY s.STORE_NO, s.YEAR * 100 + s.WEEK;
    DROP TABLE #items;`;
  const req = pool.request(); req.timeout = 1800000;
  const [rows, recent] = (await req.batch(batch)).recordsets;
  log(`sales loaded: ${rows.length} period rows`);

  // ---------- Step 1c: ranking ----------
  const yearSales = new Map(), recentBy = new Map();
  for (const r of rows) {
    if (!(r.p > 0) || !byId.has(r.st)) continue;
    const m = yearSales.get(r.st) || {}; m[r.y] = (m[r.y] || 0) + r.p; yearSales.set(r.st, m);
  }
  for (const r of recent) {
    // Ignore weeks that end before the store's open date (pre-opening setup/test rows, e.g. 547 on 2026-11-04/05).
    if (byId.has(r.st) && byId.get(r.st).opened && weekEnd.get(r.yw) < byId.get(r.st).opened) continue;
    const m = recentBy.get(r.st) || {}; m[r.yw] = r.p; recentBy.set(r.st, m);
  }
  for (const s of stores) {
    s.sales = yearSales.get(s.id) || {};
    s.completeYears = YEARS.filter(y => periodStart.has(y) && s.opened <= periodStart.get(y));
    s.bestYear = null; s.best = null;
    for (const y of s.completeYears) if ((s.sales[y] || 0) > (s.best ?? -1)) { s.best = s.sales[y] || 0; s.bestYear = y; }
    s.recentByWeek = recentBy.get(s.id) || {};
    s.recentWeeks = Object.keys(s.recentByWeek).map(Number);         // weeks with any sales (since opening)
    s.brandon = s.code === '479' && TODAY <= BRANDON_RULE_END;
    s.note = '';
  }
  const cmp = (a, b) => (b.best - a.best) || (sizeRank(b.size) - sizeRank(a.size)) || (Number(a.code) - Number(b.code));
  const own = stores.filter(s => s.bestYear !== null && !s.brandon).sort(cmp);
  const toMatch = stores.filter(s => s.bestYear === null && s.recentWeeks.length);
  const noSales = stores.filter(s => s.bestYear === null && !s.recentWeeks.length);
  const rank = [...own];

  // matched stores: same tourist/mall type, within 500 mi or same state, closest DCS-group sales over the same weeks
  const sumWeeks = (st, wks) => wks.reduce((a, w) => a + (st.recentByWeek[w] || 0), 0);
  for (const s of toMatch) {
    const wks = s.recentWeeks, mine = sumWeeks(s, wks);
    let best = null;
    for (const c of own.filter(c => c.tourist === s.tourist && (c.state === s.state || miles(s, c) <= MATCH_MILES))) {
      const diff = Math.abs(sumWeeks(c, wks) - mine);
      if (!best || diff < best.diff) best = { c, diff };
    }
    if (!best) throw new Error(`No match candidate for store ${s.code}`);
    s.matchedTo = best.c;
    s.note = `Matched to ${best.c.code} ${best.c.name} (last ${wks.length} wks group sales $${mine.toFixed(0)} vs $${sumWeeks(best.c, wks).toFixed(0)}, ${miles(s, best.c).toFixed(0)} mi)`;
  }
  for (const s of [...toMatch].sort((a, b) => (sizeRank(b.size) - sizeRank(a.size)) || (Number(b.code) - Number(a.code))))
    rank.splice(rank.indexOf(s.matchedTo) + 1, 0, s);
  for (const s of stores.filter(x => x.brandon)) {
    rank.splice(rank.indexOf(rank.find(x => x.code === '462')) + 1, 0, s);
    s.note = 'Placed 1 below 462 Countryside (moved to smaller location; rule until end of May 2027)';
  }
  for (const s of noSales) { rank.splice(NO_SALES_RANK - 1, 0, s); s.note = 'No sales yet - placed at last B position'; }

  const fixed = STORE_GROUPS.reduce((a, [, n]) => a + (n || 0), 0);
  const sizes = STORE_GROUPS.map(([g, n]) => [g, n ?? rank.length - fixed]);
  let i = 0;
  for (const [g, n] of sizes) for (let k = 0; k < n; k++, i++) { rank[i].rank = i + 1; rank[i].group = g; }
  for (const s of rank) s.ownHistory = s.bestYear !== null && !s.brandon;

  // ---------- Step 2b: pairs -> daily units (7-day minimum) -> top 30% -> weekly x 3 ----------
  const pm = new Map();
  for (const r of rows) {
    const s = byId.get(r.st);
    if (!s || !s.ownHistory || r.y !== s.bestYear || !(r.q > 0)) continue;
    const it = itemInfo.get(r.item);
    if (!it || it.dcs !== tDcs || it.size !== tSize || priceAdjusted(r.p / r.q) !== tPrice) continue;
    const k = `${r.st}|${r.item}`;
    const p = pm.get(k) || { s, item: r.item, units: 0, first: r.d, last: r.d };
    p.units += r.q; if (r.d < p.first) p.first = r.d; if (r.d > p.last) p.last = r.d;
    pm.set(k, p);
  }
  for (const p of pm.values()) {
    p.days = Math.round((p.last - p.first) / 864e5) + 1;
    p.daysUsed = Math.max(MIN_DAYS, p.days);
    p.daily = p.units / p.daysUsed;
  }
  const groupStats = sizes.map(([g]) => {
    const members = rank.filter(s => s.group === g);
    const ps = [...pm.values()].filter(p => p.s.group === g)
      .sort((a, b) => b.daily - a.daily || a.s.rank - b.s.rank || a.item - b.item);
    const keep = Math.ceil(ps.length * KEEP_TOP);
    ps.forEach((p, k) => (p.kept = k < keep));
    const kept = ps.slice(0, keep);
    const daily = kept.length ? kept.reduce((a, p) => a + p.daily, 0) / kept.length : 0;
    const weekly = daily * 7, xm = weekly * MULT;
    return { g, stores: members.length, histStores: members.filter(s => s.ownHistory).length,
      sellingStores: new Set(ps.map(p => p.s.id)).size, items: new Set(ps.map(p => p.item)).size,
      pairs: ps.length, keep, units: ps.reduce((a, p) => a + p.units, 0), lowestKept: kept.length ? kept[kept.length - 1].daily : 0,
      daily, weekly, xm, qty: Math.max(1, Math.ceil(Number(xm.toFixed(6)))), ps };
  });

  // ---------- workbook ----------
  const wb = new ExcelJS.Workbook();
  const head = ws => { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
  const pct = `${Math.round(KEEP_TOP * 100)}%`;

  const a = wb.addWorksheet('Allocation');
  a.addRow(['DPS_Code', ...sizes.map(([g]) => g)]);
  a.addRow([dps, ...groupStats.map(x => x.qty)]);
  head(a); a.getColumn(1).width = 24;

  const d = wb.addWorksheet('Group detail');
  d.addRow(['Store group', 'Stores in group', 'Stores with own history', 'Stores that sold the DPS code', 'Items sold',
    'Store x item pairs', 'Units', `Pairs kept (top ${pct}, rounded up)`, 'Lowest kept daily', 'Daily units average',
    'Weekly units average (x7)', `x ${MULT}`, 'Qty (round up, min 1)']);
  for (const x of groupStats) d.addRow([x.g, x.stores, x.histStores, x.sellingStores, x.items, x.pairs, x.units, x.keep,
    +x.lowestKept.toFixed(4), +x.daily.toFixed(4), +x.weekly.toFixed(4), +x.xm.toFixed(4), x.qty]);
  head(d); d.columns.forEach(c => (c.width = 16));

  const r = wb.addWorksheet('Ranking');
  r.addRow(['Rank', 'Group', 'Store', 'Name', 'State', 'Size', 'Tourist', 'Opened', ...YEARS.map(y => `${periodName} ${y} sales`),
    'Best year', 'Best-year sales', 'Used in average', 'Note']);
  for (const s of rank) r.addRow([s.rank, s.group, s.code, s.name, s.state, s.size, s.tourist ? 'Tourist' : 'Mall',
    s.opened, ...YEARS.map(y => s.completeYears.includes(y) ? +(s.sales[y] || 0).toFixed(2) : 'not open full period'),
    s.bestYear ?? '', s.best === null ? '' : +s.best.toFixed(2), s.ownHistory ? 'Yes' : 'No', s.note]);
  head(r); r.getColumn(4).width = 24; r.getColumn(15).width = 70; r.getColumn(8).numFmt = 'yyyy-mm-dd';

  const p = wb.addWorksheet('Pairs');
  p.addRow(['Group', 'Rank', 'Store', 'Name', 'Best year', 'Item', `Units (price ${tPrice})`, 'First sale', 'Last sale',
    'Days (inclusive)', `Days used (min ${MIN_DAYS})`, 'Daily units', `Kept (top ${pct})`]);
  for (const x of groupStats) for (const q of x.ps)
    p.addRow([x.g, q.s.rank, q.s.code, q.s.name, q.s.bestYear, q.item, q.units, q.first, q.last, q.days, q.daysUsed, +q.daily.toFixed(4), q.kept ? 'Yes' : '']);
  head(p); [8, 9].forEach(c => (p.getColumn(c).numFmt = 'yyyy-mm-dd'));

  const n = wb.addWorksheet('Notes');
  [
    `DPS group allocation - ${dps}, ${periodName} (fiscal weeks ${pFrom}-${pTo === 54 ? 'end of year' : pTo}), built ${iso(new Date())} as of ${iso(TODAY)}.`,
    `Ranking: DCS group ${dg.id} ${dg.name} (${dg.rank.join(', ')}), gross sales (EXT_PRICE > 0), best of ${YEARS.join('/')}, open stores excl. 470.`,
    'Only years in which the store was open for the whole period count toward its best year.',
    'Ties: larger store first, then lower store code. 479 Brandon placed 1 below 462 Countryside (until end of May 2027).',
    `Matched stores (no complete year): closest DCS-group sales over the same recent weeks (up to ${MATCH_MAX_WEEKS}, fiscal ${recentWks[0]}-${recentWks[recentWks.length - 1]}), same tourist/mall type, within ${MATCH_MILES} miles or same state; placed 1 rank after the match.`,
    `Stores with no sales yet placed at rank ${NO_SALES_RANK} (last B).`,
    'DCS and size from SAP_Item_Information today; price = EXT_PRICE / SOLD_QTY per salesfact row (one row per store/item/day). Stores without own history (matched, no-sales, 479) are left out of the average.',
    `Per pair: days = first to last qualifying sale (inclusive, minimum ${MIN_DAYS}); daily = units / days.`,
    `Per group: keep the top ${pct} of pairs by daily units (rounded up), average, x 7 = weekly, x ${MULT}, round up, minimum 1.`,
  ].forEach(line => n.addRow([line]));
  n.getColumn(1).width = 160;

  await wb.xlsx.writeFile(out);
  console.log('Allocation:', dps, periodName, groupStats.map(x => `${x.g}=${x.qty}`).join(' '));
  console.table(groupStats.map(({ ps, ...x }) => ({ ...x, lowestKept: +x.lowestKept.toFixed(4), daily: +x.daily.toFixed(4), weekly: +x.weekly.toFixed(4), xm: +x.xm.toFixed(3) })));
  console.log('Matched:', toMatch.map(s => `${s.code}->${s.matchedTo.code}`).join(', ') || 'none',
    '| No sales:', noSales.map(s => s.code).join(', ') || 'none', '| stores ranked:', rank.length);
  console.log('Wrote', out);
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { closeHana(); sql.close(); });
