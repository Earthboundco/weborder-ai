// DPS group allocation - builds the store ranking and the allocation row for one DPS code and one period.
// Rules: ../docs/business-rules.md (Steps 1a-1c, 2a-2b, per Wesley
// 2026-11-07/08). Settled method 2026-11-08: daily units per store x item pair (best 7-day window since 2026-11-13; was first-to-last sale, 7-day minimum),
// keep the top 50% of pairs per store group (30% until 2026-11-13), x 7 = weekly, x 3, round up, minimum 1.
//
// Run from the weborder-ai folder (for .env):
//   node "DPS group allocation project/scripts/build-dps-table.js" "DPS group allocation project/Claude_results/<name>.xlsx" --dps "JE WO NK/10-13/No" --period "Holidays" [--today 2026-11-07]
const L = require('./lib');
const { W, MULT, MIN_DAYS, MATCH_MAX_WEEKS, MATCH_MILES, NO_SALES_RANK, DCS_GROUPS, matchesAny, followOf,
  priceAdjusted, sizeAdjusted, iso, loadContext, recentSalesSql, itemsTableSql, rankStores } = L;
const { sql, getPool } = require(W + '/db');
const { hanaQuery, closeHana } = require(W + '/hana');
const ExcelJS = require(W + '/node_modules/exceljs');

const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const KEEP_TOP = arg('--keep') ? Number(arg('--keep')) / 100 : L.KEEP_TOP;   // --keep 50 = top 50% (test option; settled rule is lib KEEP_TOP)
const T0 = Date.now(); const log = m => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', m);

async function main() {
  const out = process.argv[2];
  const dps = arg('--dps'), periodName = arg('--period') || 'Holidays';
  const TODAY = arg('--today') ? new Date(arg('--today')) : new Date(iso(new Date()));
  if (!out || out.startsWith('--') || !dps) throw new Error('Usage: node build-dps-table.js <output.xlsx> --dps "JE WO NK/10-13/No" --period "Holidays" [--today YYYY-MM-DD] [--keep 30]');
  const [tDcs, tPrice, tSize] = dps.split('/');
  if (!tDcs || !tPrice || !tSize) throw new Error(`DPS code must be DCS/Price/Size, got "${dps}"`);
  const dg = DCS_GROUPS.find(g => matchesAny(tDcs, followOf(g)));
  if (!dg) throw new Error(`DCS ${tDcs} is not in any DCS group (out of scope)`);

  const pool = await getPool();
  const ctx = await loadContext(pool, periodName, TODAY);
  const { pFrom, pTo, YEARS, recentWks } = ctx;
  log(`calendar loaded: years ${YEARS.join('/')}, match weeks ${recentWks[0]}-${recentWks[recentWks.length - 1]}`);

  // ---------- items: current SAP attributes ----------
  const items = (await hanaQuery(`SELECT "ITEMNUMBER","DCS_CODE","SIZE" FROM "SAP_Item_Information" WHERE "DCS_CODE" LIKE '${dg.rank[0].slice(0, 2)}%'`))
    .filter(r => r.DCS_CODE && matchesAny(r.DCS_CODE, dg.rank) && /^\d+$/.test(r.ITEMNUMBER))
    .map(r => ({ item: Number(r.ITEMNUMBER), dcs: r.DCS_CODE, size: sizeAdjusted(r.DCS_CODE, r.SIZE) }));
  const itemInfo = new Map(items.map(i => [i.item, i]));
  log(`items loaded: ${items.length} in DCS group ${dg.id}`);

  // ---------- sales (one batch: the temp table must live in the same batch) ----------
  const batch = itemsTableSql([...itemInfo.keys()]) + `
    SELECT s.STORE_NO st, s.ITEM_NO item, s.YEAR y, s.DATE d, s.SOLD_QTY q, s.EXT_PRICE p
    FROM EBT.dbo.salesfact s JOIN #items i ON i.ITEM_NO = s.ITEM_NO
    WHERE s.YEAR IN (${YEARS.join(',')}) AND s.WEEK BETWEEN ${pFrom} AND ${pTo} AND (s.EXT_PRICE > 0 OR s.SOLD_QTY > 0);` +
    recentSalesSql(ctx) + `
    DROP TABLE #items;`;
  const req = pool.request(); req.timeout = 1800000;
  const [rows, recent] = (await req.batch(batch)).recordsets;
  log(`sales loaded: ${rows.length} period rows`);

  // ---------- Step 1c: ranking ----------
  const yearSales = new Map();
  for (const r of rows) {
    if (!(r.p > 0)) continue;
    const m = yearSales.get(r.st) || {}; m[r.y] = (m[r.y] || 0) + r.p; yearSales.set(r.st, m);
  }
  const { rank, byId, sizes, toMatch, noSales } = rankStores(ctx, yearSales, recent);

  // ---------- Step 2b: pairs -> daily units (best 7-day window) -> top 30% -> weekly x 3 ----------
  // Daily units per pair (per Wesley 2026-11-13, "Daily units sold test.xlsx"): for each qualifying sale date,
  // window = that date to date + 6, never past the period's last day in that year (from salesfact); units = the
  // qualifying (in-bucket) sales inside the window; rate = units / max(window days, 7). The pair's daily units =
  // the best (highest) window rate. With the 7-day minimum every window is divided by 7.
  const pm = new Map();
  for (const r of rows) {
    const s = byId.get(r.st);
    if (!s || !s.ownHistory || r.y !== s.bestYear || !(r.q > 0)) continue;
    const it = itemInfo.get(r.item);
    if (!it || it.dcs !== tDcs || it.size !== tSize || priceAdjusted(r.p / r.q) !== tPrice) continue;
    const k = `${r.st}|${r.item}`;
    const p = pm.get(k) || { s, item: r.item, units: 0, first: r.d, last: r.d, sales: [] };
    p.units += r.q; if (r.d < p.first) p.first = r.d; if (r.d > p.last) p.last = r.d;
    p.sales.push({ d: r.d, q: r.q });
    pm.set(k, p);
  }
  for (const p of pm.values()) {
    const end = ctx.periodEnd.get(p.s.bestYear);
    p.daily = -1;
    for (const { d: start } of p.sales) {
      const wEnd = new Date(Math.min(+end, +start + 6 * 864e5));
      const units = p.sales.reduce((a, x) => a + (x.d >= start && x.d <= wEnd ? x.q : 0), 0);
      const days = Math.round((wEnd - start) / 864e5) + 1;
      const rate = units / Math.max(MIN_DAYS, days);
      if (rate > p.daily || (rate === p.daily && start < p.wStart)) Object.assign(p, { daily: rate, wStart: start, wEnd, wUnits: units, wDays: days });
    }
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
    'Best window start', 'Best window end', 'Window days', 'Units in best window', `Daily units (window units / max(days, ${MIN_DAYS}))`, `Kept (top ${pct})`]);
  for (const x of groupStats) for (const q of x.ps)
    p.addRow([x.g, q.s.rank, q.s.code, q.s.name, q.s.bestYear, q.item, q.units, q.first, q.last, q.wStart, q.wEnd, q.wDays, q.wUnits, +q.daily.toFixed(4), q.kept ? 'Yes' : '']);
  head(p); [8, 9, 10, 11].forEach(c => (p.getColumn(c).numFmt = 'yyyy-mm-dd'));

  const n = wb.addWorksheet('Notes');
  [
    `DPS group allocation - ${dps}, ${periodName} (fiscal weeks ${pFrom}-${pTo === 54 ? 'end of year' : pTo}), built ${iso(new Date())} as of ${iso(TODAY)}.`,
    `Ranking: DCS group ${dg.id} ${dg.name} (${dg.rank.join(', ')}), gross sales (EXT_PRICE > 0), best of ${YEARS.join('/')}, open stores excl. 470.`,
    'Only years in which the store was open for the whole period count toward its best year.',
    'Ties: larger store first, then lower store code. 479 Brandon placed 1 below 462 Countryside (until end of May 2027).',
    `Matched stores (no complete year): closest DCS-group sales over the same recent weeks (up to ${MATCH_MAX_WEEKS}, fiscal ${recentWks[0]}-${recentWks[recentWks.length - 1]}), same tourist/mall type, within ${MATCH_MILES} miles or same state; placed 1 rank after the match.`,
    `Stores with no sales yet placed at rank ${NO_SALES_RANK} (last B).`,
    'DCS and size from SAP_Item_Information today; price = EXT_PRICE / SOLD_QTY per salesfact row (one row per store/item/day). Stores without own history (matched, no-sales, 479) are left out of the average.',
    `Per pair: best 7-day window - for each qualifying sale date, window = that date to date + 6 (not past the period's last day in that year, from salesfact); units = qualifying sales in the window; rate = units / max(window days, ${MIN_DAYS}); daily = the highest window rate.`,
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
