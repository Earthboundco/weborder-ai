// DPS group allocation - shared rules and store ranking (used by build-dps-table.js and build-all-dps.js).
// Rules: ../docs/business-rules.md (Steps 1a-1c, 2a-2c, per Wesley 2026-11-07/08/12).
const path = require('path');
const W = path.resolve(__dirname, '../..');   // weborder-ai root (db.js, hana.js, node_modules)

// ---------- settings ----------
const KEEP_TOP = 0.50;          // keep the top 50% of pairs per group (count rounded up) - rule per Wesley 2026-11-13 (was 30%)
const MULT = 3;                 // weeks of supply
const MIN_DAYS = 7;             // minimum days per pair
const MIN_PAIRS = 10;           // full table: a cell counts as calculated only with >= 10 store x item pairs (per Wesley 2026-11-12)
const MATCH_MAX_WEEKS = 12;
const MATCH_MILES = 500;
const BRANDON_RULE_END = new Date('2027-05-31');
const STORE_GROUPS = [['A1', 1], ['A2', 5], ['A3', 6], ['B', 45], ['C', null], ['D', 20], ['E', 5]];
const GROUP_NAMES = STORE_GROUPS.map(([g]) => g);
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
const followOf = dg => dg.follow || dg.rank;
const groupForDcs = dcs => DCS_GROUPS.find(g => matchesAny(dcs, followOf(g)));

// Step 2a - DPS code parts. Price: strictly greater than the lower bound, upper bound included.
const PRICE_BUCKETS = [[500, '>=500'], [400, '400-500'], [350, '350-400'], [300, '300-350'], [250, '250-300'], [200, '200-250'],
  [150, '150-200'], [101, '101-150'], [91, '91-101'], [81, '81-91'], [76, '76-81'], [71, '71-76'], [66, '66-71'],
  [61, '61-66'], [56, '56-61'], [51, '51-56'], [46, '46-51'], [41, '41-46'], [36, '36-41'], [31, '31-36'],
  [26, '26-31'], [21, '21-26'], [17, '17-21'], [13, '13-17'], [10, '10-13'], [7, '7-10'], [5, '5-7'], [3, '3-5'], [1, '1-3']];
const BUCKET_ORDER = ['0-1', ...PRICE_BUCKETS.map(([, l]) => l).reverse()];   // cheapest first
function priceAdjusted(p) {
  for (const [lo, label] of PRICE_BUCKETS) if (p > lo) return label;
  return '0-1';
}
// Same buckets as a SQL CASE over a float price expression (keeps JS and SQL identical).
const priceCaseSql = expr => `CASE ${PRICE_BUCKETS.map(([lo, l]) => `WHEN ${expr} > ${lo} THEN '${l}'`).join(' ')} ELSE '0-1' END`;
const SIZE_ORDER = ['No', 'XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X'];
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
const iso = d => d.toISOString().slice(0, 10);
const qtyFromDaily = daily => { const xm = daily * 7 * MULT; return { weekly: daily * 7, xm, qty: Math.max(1, Math.ceil(Number(xm.toFixed(6)))) }; };

// ---------- stores + calendar for a period ----------
async function loadContext(pool, periodName, TODAY) {
  if (!PERIODS[periodName]) throw new Error(`Unknown period "${periodName}". Use one of: ${Object.keys(PERIODS).join(', ')}`);
  const [pFrom, pTo] = PERIODS[periodName];
  const YEARS = [1, 2, 3].map(k => TODAY.getFullYear() - k).reverse();   // last 3 full fiscal years
  const stores = (await pool.request().query(`
    SELECT [Code #] code, [ID #] id, [STORE NAME] name, STATE state, WStoreSize size, Tourist_location tourist,
           Latitude lat, Longitude lon, [OPEN] opened
    FROM EBT.dbo.[Store Directory] WHERE ISNULL(WStoreType,'') <> '' AND [Code #] <> '470'`)).recordset
    .map(s => ({ ...s, code: s.code.trim(), lat: Number(s.lat), lon: Number(s.lon) }));
  const cal = (await pool.request().query(`
    SELECT YEAR y, MIN(DATE) d0, MAX(DATE) d1 FROM EBT.dbo.salesfact
    WHERE YEAR IN (${YEARS.join(',')}) AND WEEK BETWEEN ${pFrom} AND ${pTo} GROUP BY YEAR`)).recordset;
  const periodStart = new Map(cal.map(r => [r.y, r.d0]));
  const periodEnd = new Map(cal.map(r => [r.y, r.d1]));   // last day of the period per year (best 7-day window cannot pass it)
  const weekStart = new Date(TODAY); weekStart.setUTCDate(TODAY.getUTCDate() - TODAY.getUTCDay());   // Sunday of this week
  const recentCal = (await pool.request().query(`
    SELECT YEAR * 100 + WEEK yw, MAX(DATE) d1 FROM EBT.dbo.salesfact
    WHERE DATE >= '${iso(new Date(weekStart - 120 * 864e5))}' AND DATE < '${iso(weekStart)}'
    GROUP BY YEAR * 100 + WEEK`)).recordset.sort((a, b) => a.yw - b.yw).slice(-MATCH_MAX_WEEKS);
  return { periodName, pFrom, pTo, TODAY, YEARS, stores, periodStart, periodEnd,
    recentWks: recentCal.map(r => r.yw), weekEnd: new Map(recentCal.map(r => [r.yw, r.d1])) };
}

// SQL (inside a batch that already created #items) for the recent-weeks DCS-group sales per store/week.
const recentSalesSql = ctx => `
    SELECT s.STORE_NO st, s.YEAR * 100 + s.WEEK yw, SUM(CASE WHEN i.ITEM_NO IS NOT NULL AND s.EXT_PRICE > 0 THEN s.EXT_PRICE ELSE 0 END) p
    FROM EBT.dbo.salesfact s LEFT JOIN #items i ON i.ITEM_NO = s.ITEM_NO
    WHERE s.YEAR * 100 + s.WEEK IN (${ctx.recentWks.join(',')})
    GROUP BY s.STORE_NO, s.YEAR * 100 + s.WEEK;`;
const itemsTableSql = (ids, extraCol) => {
  let b = `SET NOCOUNT ON; CREATE TABLE #items (ITEM_NO int PRIMARY KEY${extraCol ? ', ' + extraCol + ' bit' : ''});\n`;
  for (let k = 0; k < ids.length; k += 1000)
    b += `INSERT INTO #items VALUES ${ids.slice(k, k + 1000).map(x => Array.isArray(x) ? `(${Number(x[0])},${x[1] ? 1 : 0})` : `(${Number(x)})`).join(',')};\n`;
  return b;
};

// ---------- Step 1c: ranking ----------
// yearSales: Map(store id -> {year: gross DCS-group sales}); recent: rows {st, yw, p}.
// Returns fresh store objects (the context's stores are not modified).
function rankStores(ctx, yearSales, recent) {
  const stores = ctx.stores.map(s => ({ ...s }));
  const byId = new Map(stores.map(s => [s.id, s]));
  const recentBy = new Map();
  for (const r of recent) {
    // Ignore weeks that end before the store's open date (pre-opening setup/test rows, e.g. 547 on 2026-11-04/05).
    if (byId.has(r.st) && byId.get(r.st).opened && ctx.weekEnd.get(r.yw) < byId.get(r.st).opened) continue;
    const m = recentBy.get(r.st) || {}; m[r.yw] = r.p; recentBy.set(r.st, m);
  }
  for (const s of stores) {
    s.sales = yearSales.get(s.id) || {};
    s.completeYears = ctx.YEARS.filter(y => ctx.periodStart.has(y) && s.opened <= ctx.periodStart.get(y));
    s.bestYear = null; s.best = null;
    for (const y of s.completeYears) if ((s.sales[y] || 0) > (s.best ?? -1)) { s.best = s.sales[y] || 0; s.bestYear = y; }
    s.recentByWeek = recentBy.get(s.id) || {};
    s.recentWeeks = Object.keys(s.recentByWeek).map(Number);         // weeks with any sales (since opening)
    s.brandon = s.code === '479' && ctx.TODAY <= BRANDON_RULE_END;
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
  return { rank, byId, sizes, toMatch, noSales };
}

// Top 30% of pairs (by daily units) -> average -> weekly x 3.
function groupAverage(dailies) {
  const ds = [...dailies].sort((a, b) => b - a);
  const keep = Math.ceil(ds.length * KEEP_TOP);
  const daily = keep ? ds.slice(0, keep).reduce((a, x) => a + x, 0) / keep : 0;
  return { pairs: ds.length, keep, lowestKept: keep ? ds[keep - 1] : 0, daily, ...qtyFromDaily(daily) };
}

module.exports = {
  W, KEEP_TOP, MULT, MIN_DAYS, MIN_PAIRS, MATCH_MAX_WEEKS, MATCH_MILES, NO_SALES_RANK, STORE_GROUPS, GROUP_NAMES, PERIODS,
  DCS_GROUPS, matchesAny, followOf, groupForDcs, PRICE_BUCKETS, BUCKET_ORDER, priceAdjusted, priceCaseSql,
  SIZE_ORDER, sizeAdjusted, sizeRank, miles, iso, qtyFromDaily, loadContext, recentSalesSql, itemsTableSql,
  rankStores, groupAverage,
};
