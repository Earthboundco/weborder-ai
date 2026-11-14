// DPS group allocation - builds the full allocation table (every DPS code x store group) for one period.
// Rules: ../docs/business-rules.md. Per DCS group: rank the stores (Step 1c), then per DPS code and store
// group the settled Step 2b method (daily units per store x item pair = best 7-day window, top 50%, x 7, x 3,
// round up, min 1). Then Step 2c, the benchmark method: per DCS/size the price bucket with the most pairs is
// the benchmark; the other buckets = benchmark x price slope from Wesley's ladder table (../assets), then the
// order rules of each price tier.
//
// Run from the weborder-ai folder (for .env):
//   node "DPS group allocation project/scripts/build-all-dps.js" "DPS group allocation project/Claude_results/<name>.xlsx" --period "Holidays" [--today YYYY-MM-DD] [--ladder <xlsx>]
const path = require('path');
const L = require('./lib');
const { W, KEEP_TOP, MULT, MIN_DAYS, MIN_PAIRS, GROUP_NAMES, DCS_GROUPS, matchesAny, followOf, groupForDcs, BUCKET_ORDER,
  priceCaseSql, SIZE_ORDER, sizeAdjusted, iso, loadContext, recentSalesSql, itemsTableSql, rankStores, groupAverage } = L;
const { sql, getPool } = require(W + '/db');
const { hanaQuery, closeHana } = require(W + '/hana');
const ExcelJS = require(W + '/node_modules/exceljs');

const DEFAULT_LADDER = path.resolve(__dirname, '../assets/DPS code and group allocation - Holidays ladder (2026-11-12).xlsx');
const STANDARD_LADDER = 'JE WO NK/No';   // the ladder 30 of the 41 DCSs share
const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const T0 = Date.now(); const log = m => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', m);
const bIdx = b => BUCKET_ORDER.indexOf(b);
const sIdx = s => (SIZE_ORDER.indexOf(s) + 1) || 99;

// ---------- Wesley's ladder table: "DCS/size" -> { bucket: [A1..E] } ----------
async function loadLadders(file) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const ladders = new Map(), table = [];
  wb.worksheets[0].eachRow((r, i) => {
    if (i === 1) return;
    const v = r.values.slice(1).map(x => (x && x.result !== undefined ? x.result : x));
    const [dcs, b, size] = String(v[0]).split('/');
    const q = v.slice(1, 8).map(Number);
    table.push({ code: String(v[0]), dcs, b, size, q });
    if (size !== 'No' && !dcs.startsWith('CL')) return;   // size only applies to CL (Step 2a)
    const k = `${dcs}/${size}`;
    if (!ladders.has(k)) ladders.set(k, {});
    ladders.get(k)[b] = q;
  });
  return { ladders, table };
}
function ladderFor(ladders, dcs, size) {
  if (ladders.has(`${dcs}/${size}`)) return { key: `${dcs}/${size}`, l: ladders.get(`${dcs}/${size}`) };
  if (dcs.startsWith('CL ME')) {   // men's clothing isn't in the table: use the matching women's DCS ladder
    const k = `${dcs.replace('CL ME', 'CL WO')}/${size}`;
    if (ladders.has(k)) return { key: k, l: ladders.get(k) };
  }
  return { key: STANDARD_LADDER, l: ladders.get(STANDARD_LADDER) };
}

async function main() {
  const out = process.argv[2];
  const periodName = arg('--period') || 'Holidays';
  const TODAY = arg('--today') ? new Date(arg('--today')) : new Date(iso(new Date()));
  const ladderFile = arg('--ladder') || DEFAULT_LADDER;
  if (!out || out.startsWith('--')) throw new Error('Usage: node build-all-dps.js <output.xlsx> --period "Holidays" [--today YYYY-MM-DD] [--ladder <xlsx>]');

  const { ladders, table } = await loadLadders(ladderFile);
  log(`ladder table loaded: ${table.length} rows, ${ladders.size} DCS/size ladders`);
  const pool = await getPool();
  const ctx = await loadContext(pool, periodName, TODAY);
  const { pFrom, pTo, YEARS, recentWks } = ctx;
  log(`calendar loaded: years ${YEARS.join('/')}, match weeks ${recentWks[0]}-${recentWks[recentWks.length - 1]}`);

  // ---------- items: current SAP attributes (all in-scope departments) ----------
  const allItems = (await hanaQuery(`SELECT "ITEMNUMBER","DCS_CODE","SIZE" FROM "SAP_Item_Information"
      WHERE SUBSTRING("DCS_CODE",1,2) IN ('AC','AS','CL','HD','IM','JE')`))
    .filter(r => r.DCS_CODE && /^\d+$/.test(r.ITEMNUMBER))
    .map(r => ({ item: Number(r.ITEMNUMBER), dcs: r.DCS_CODE.trim(), size: sizeAdjusted(r.DCS_CODE.trim(), r.SIZE) }));
  log(`SAP items loaded: ${allItems.length}`);

  // calc: "DPS code" -> { group: stats }
  const calc = new Map(), rankings = [];
  for (const dg of DCS_GROUPS) {
    const items = allItems.filter(i => matchesAny(i.dcs, dg.rank));
    const info = new Map(items.map(i => [i.item, i]));
    const follow = followOf(dg);
    const price = 'CAST(s.EXT_PRICE AS float) / CAST(s.SOLD_QTY AS float)';
    const batch = itemsTableSql(items.map(i => [i.item, matchesAny(i.dcs, follow)]), 'F') + `
    SELECT s.STORE_NO st, s.YEAR y, SUM(CASE WHEN s.EXT_PRICE > 0 THEN s.EXT_PRICE ELSE 0 END) p
    FROM EBT.dbo.salesfact s JOIN #items i ON i.ITEM_NO = s.ITEM_NO
    WHERE s.YEAR IN (${YEARS.join(',')}) AND s.WEEK BETWEEN ${pFrom} AND ${pTo}
    GROUP BY s.STORE_NO, s.YEAR;
    SELECT s.STORE_NO st, s.ITEM_NO item, s.YEAR y, s.DATE d, s.SOLD_QTY q, ${priceCaseSql(price)} b INTO #r
      FROM EBT.dbo.salesfact s JOIN #items i ON i.ITEM_NO = s.ITEM_NO AND i.F = 1
      WHERE s.YEAR IN (${YEARS.join(',')}) AND s.WEEK BETWEEN ${pFrom} AND ${pTo} AND s.SOLD_QTY > 0;
    CREATE CLUSTERED INDEX ix ON #r (st, item, y, b, d);
    -- best 7-day window per pair: for each sale date, in-bucket units from that date to date + 6 (rows only
    -- exist inside the period, so the window never passes the period end); keep the highest
    SELECT st, item, y, b, SUM(q) q, MAX(wq) wq FROM (
      SELECT a.st, a.item, a.y, a.b, a.d, a.q, (SELECT SUM(c.q) FROM #r c WHERE c.st = a.st AND c.item = a.item AND c.y = a.y
        AND c.b = a.b AND c.d >= a.d AND c.d <= DATEADD(day, 6, a.d)) wq
      FROM #r a) x
    GROUP BY st, item, y, b;
    DROP TABLE #r;` + recentSalesSql(ctx) + `
    DROP TABLE #items;`;
    const req = pool.request(); req.timeout = 3600000;
    const [yrows, prows, recent] = (await req.batch(batch)).recordsets;

    const yearSales = new Map();
    for (const r of yrows) { const m = yearSales.get(r.st) || {}; m[r.y] = (m[r.y] || 0) + Number(r.p); yearSales.set(r.st, m); }
    const { rank, byId, toMatch, noSales } = rankStores(ctx, yearSales, recent);
    for (const s of rank) rankings.push({ dg, s });

    // Step 2b: pairs in each store's best year -> daily units (best 7-day window), grouped by DPS code and store group
    const dailies = new Map();
    let used = 0;
    for (const r of prows) {
      const s = byId.get(r.st);
      if (!s || !s.ownHistory || r.y !== s.bestYear) continue;
      const it = info.get(r.item);
      const dps = `${it.dcs}/${r.b}/${it.size}`;
      if (!dailies.has(dps)) dailies.set(dps, {});
      const byG = dailies.get(dps);
      (byG[s.group] = byG[s.group] || []).push(r.wq / MIN_DAYS);   // window days <= 7, so max(days, 7) = 7
      used++;
    }
    for (const [dps, byG] of dailies) {
      const m = calc.get(dps) || {};
      for (const [g, ds] of Object.entries(byG)) m[g] = groupAverage(ds);
      calc.set(dps, m);
    }
    log(`DCS group ${dg.id} ${dg.name}: ${items.length} items, ${prows.length} store/item/year/price rows (${used} in best years), ` +
      `${dailies.size} DPS codes calculated | matched ${toMatch.map(s => `${s.code}->${s.matchedTo.code}`).join(', ') || 'none'} | no sales ${noSales.map(s => s.code).join(', ') || 'none'}`);
  }

  // ---------- universe of DPS codes: every DCS in the ladder table or calculated, x sizes x price buckets ----------
  const dcsSizes = new Map();   // dcs -> Set(size)
  const addDs = (dcs, size) => { if (!dcsSizes.has(dcs)) dcsSizes.set(dcs, new Set()); dcsSizes.get(dcs).add(size); };
  for (const k of ladders.keys()) { const [dcs, size] = k.split('/'); addDs(dcs, size); }
  for (const dps of calc.keys()) { const [dcs, , size] = dps.split('/'); addDs(dcs, size); }
  for (const [dcs, set] of dcsSizes) if (dcs.startsWith('CL')) SIZE_ORDER.forEach(s => set.add(s));
  const outOfScope = [...dcsSizes.keys()].filter(d => !groupForDcs(d));
  for (const d of outOfScope) dcsSizes.delete(d);

  // ---------- Step 2c - benchmark method (per Wesley 2026-11-13, permanent) ----------
  // Per DCS/size: the benchmark is the price bucket with the most store x item pairs (all groups together)
  // among buckets where at least one group has >= MIN_PAIRS pairs. Its group values are the calculated ones
  // (Step 2b); a group with < MIN_PAIRS pairs there is filled from the ladder's benchmark row scaled by the
  // pairs-weighted ratio calculated / ladder of the other groups (placeholder, see business-rules.md Step 2c open questions). The
  // benchmark is put in group order (pairs-weighted average where it breaks, round up) and given the order
  // rules of its price tier. Every other bucket = ROUNDUP(benchmark x slope), min 1, where slope = average of
  // the ladder ratios (bucket / benchmark bucket) for A1, A2, A3 and B; then the order rules of its tier.
  // No bucket with >= MIN_PAIRS pairs in any group: the ladder values as-is, then the tier rules.
  const G = GROUP_NAMES, gi = g => G.indexOf(g);
  const TIERS = [   // order rules by price bucket, per Wesley 2026-11-13; always E <= D <= C <= B <= A3 <= A2 <= A1
    { name: 'up to 46-51', to: '46-51', strict: [['A2', 'B'], ['B', 'D']], dec: ['D', 'E'], inc: 'B' },
    { name: '51-56 to 91-101', to: '91-101', strict: [['A3', 'C'], ['B', 'D']], dec: ['D', 'E'], inc: 'B' },
    { name: '101-150 to 250-300', to: '250-300', strict: [['A3', 'C'], ['B', 'C']], dec: ['C', 'D', 'E'], inc: 'B' },
    { name: '300-350 and up', to: BUCKET_ORDER[BUCKET_ORDER.length - 1], strict: [['A3', 'B']], dec: ['B', 'C', 'D', 'E'], inc: 'A3' },
  ];
  for (const t of TIERS) if (bIdx(t.to) < 0) throw new Error(`Tier bucket ${t.to} not in BUCKET_ORDER`);
  const tierOf = b => TIERS.find(t => bIdx(b) <= bIdx(t.to));
  const pava = (v, w) => {   // weighted least-squares fit that is non-increasing along v
    const st = [];
    v.forEach((x, i) => {
      st.push({ v: x, w: w[i], n: 1 });
      while (st.length > 1 && st[st.length - 2].v < st[st.length - 1].v - 1e-12) {
        const b = st.pop(), a = st.pop();
        st.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
      }
    });
    return st.flatMap(b => Array(b.n).fill(b.v));
  };
  const up = x => Math.max(1, Math.ceil(Number(x.toFixed(6))));
  // tier rules: for each strict pair [hi, lo] not met, decrease lo to hi - 1 (and the groups below it) when lo may
  // be decreased and hi - 1 >= 1; otherwise increase the tier's named group (and the groups above it)
  function applyTier(q0, t) {
    const q = [...q0], notes = [];
    for (let k = 1; k < G.length; k++) if (q[k] > q[k - 1]) throw new Error(`group order broken before tier rules: ${q.join('/')}`);
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const [h, l] of t.strict) {
        const hi = gi(h), lo = gi(l);
        if (q[hi] > q[lo]) continue;
        changed = true;
        if (t.dec.includes(l) && q[hi] - 1 >= 1) {
          notes.push(`${l} ${q[lo]} -> ${q[hi] - 1}`); q[lo] = q[hi] - 1;
          for (let k = lo + 1; k < G.length; k++) if (q[k] > q[k - 1]) { notes.push(`${G[k]} ${q[k]} -> ${q[k - 1]}`); q[k] = q[k - 1]; }
        } else {
          // increase the tier's named group; if that group IS the lower one (e.g. A2 > B with "increase B"),
          // raising it can't help, so raise the higher group instead (placeholder, see business-rules.md Step 2c open questions)
          const ii = gi(t.inc) >= lo ? hi : gi(t.inc), need = ii === hi ? q[lo] + 1 : q[ii] + 1;
          notes.push(`${G[ii]} ${q[ii]} -> ${need}`); q[ii] = need;
          for (let k = ii - 1; k >= 0; k--) if (q[k] < q[k + 1]) { notes.push(`${G[k]} ${q[k]} -> ${q[k + 1]}`); q[k] = q[k + 1]; }
        }
      }
      if (!changed) break;
    }
    const ok = q.every((x, k) => !k || x <= q[k - 1]) && t.strict.every(([h, l]) => q[gi(h)] > q[gi(l)]);
    if (!ok) throw new Error(`tier rules not met: ${q0.join('/')} -> ${q.join('/')} (${t.name})`);
    return { q, notes };
  }

  const rows = [], counts = { Benchmark: 0, Derived: 0, Ladder: 0, filledBench: 0, tierAdjusted: 0, dcsSizes: 0, noBench: 0 };
  const benches = [];
  for (const dcs of [...dcsSizes.keys()].sort()) {
    for (const size of [...dcsSizes.get(dcs)].sort((a, b) => sIdx(a) - sIdx(b) || a.localeCompare(b))) {
      counts.dcsSizes++;
      const { key: lKey, l: lad } = ladderFor(ladders, dcs, size);
      // benchmark bucket
      let bb = null, bTot = -1;
      for (const b of BUCKET_ORDER) {
        const m = calc.get(`${dcs}/${b}/${size}`); if (!m) continue;
        if (!G.some(g => m[g] && m[g].pairs >= MIN_PAIRS)) continue;
        const tot = G.reduce((a, g) => a + (m[g] ? m[g].pairs : 0), 0);
        if (tot > bTot) { bb = b; bTot = tot; }
      }
      let bench = null;
      if (bb) {
        const m = calc.get(`${dcs}/${bb}/${size}`);
        const okG = G.filter(g => m[g] && m[g].pairs >= MIN_PAIRS);
        const wSum = okG.reduce((a, g) => a + m[g].pairs, 0);
        const ratio = okG.reduce((a, g) => a + m[g].pairs * Math.max(1, m[g].xm) / lad[bb][gi(g)], 0) / wSum;
        const val = G.map((g, k) => (okG.includes(g) ? Math.max(1, m[g].xm) : lad[bb][k] * ratio));
        const w = G.map(g => (okG.includes(g) ? m[g].pairs : 1));
        const src0 = G.map(g => (okG.includes(g) ? `Benchmark ${bb} (calculated, ${m[g].pairs} pairs)` : `Benchmark ${bb} (filled: ladder x ${ratio.toFixed(3)}${m[g] ? `, only ${m[g].pairs} pairs` : ''})`));
        counts.filledBench += G.length - okG.length;
        const raw = G.map((g, k) => up(val[k]));
        const fit = pava(val, w).map(up);
        const notes0 = G.map((g, k) => (fit[k] !== raw[k] ? `group-order average ${raw[k]} -> ${fit[k]}` : ''));
        const t = tierOf(bb), f = applyTier(fit, t);
        bench = { b: bb, raw, q: f.q, src: src0, notes0, tierNotes: f.notes, pairs: bTot };
        benches.push({ dcs, size, b: bb, pairs: bTot, raw, q: f.q, filled: G.length - okG.length, ladderKey: lKey });
      } else counts.noBench++;
      for (const b of BUCKET_ORDER) {
        const code = `${dcs}/${b}/${size}`, m = calc.get(code) || {}, t = tierOf(b);
        const row = { code, dcs, size, b, ladderKey: lKey, calc: m, tier: t.name, isBench: !!(bench && b === bench.b) };
        let base, src;
        if (!bench) {
          base = pava(lad[b], G.map(() => 1)).map(up);
          src = G.map(() => `Ladder ${lKey}`);
        } else if (b === bench.b) {
          row.raw = bench.raw; row.qty = bench.q; row.notes = bench.tierNotes;
          row.src = G.map((g, k) => bench.src[k] + (bench.notes0[k] ? `; ${bench.notes0[k]}` : ''));
          G.forEach((g, k) => { const nt = bench.tierNotes.filter(x => x.startsWith(g + ' ')); if (nt.length) row.src[k] += `; ${t.name} rule: ${nt.join(', ')}`; });
          counts.Benchmark += G.length; if (bench.tierNotes.length) counts.tierAdjusted++;
          rows.push(row); continue;
        } else {
          const slope = [0, 1, 2, 3].reduce((a, k) => a + lad[b][k] / lad[bench.b][k], 0) / 4;
          row.slope = slope;
          base = bench.q.map(x => up(x * slope));
          src = G.map(() => `Derived from ${bench.b} (x ${slope.toFixed(3)})`);
        }
        const f = applyTier(base, t);
        row.raw = base; row.qty = f.q; row.notes = f.notes;
        row.src = src.map((s, k) => { const nt = f.notes.filter(x => x.startsWith(G[k] + ' ')); return nt.length ? `${s}; ${t.name} rule: ${nt.join(', ')}` : s; });
        counts[bench ? 'Derived' : 'Ladder'] += G.length; if (f.notes.length) counts.tierAdjusted++;
        rows.push(row);
      }
    }
  }
  // price order (per Wesley 2026-11-13, "lower pricier bucket"): going from the cheapest bucket up, a cell
  // higher than the same group in the next cheaper bucket is lowered to it. The group order is kept (the
  // minimum of two ordered rows is ordered). If that breaks a tier strict rule (e.g. A3 = C at 51-56 when
  // the cheaper 46-51 has A3 = C), the lower group is decreased to (higher - 1), min 1, and the groups below
  // it with it (per Wesley 2026-11-13, "decrease C there") - lowering never breaks the price order.
  const priceBreaks = [], priceFixes = [], tierConflicts = [];
  { let p = null; for (const r of rows) {
    if (p && p.dcs === r.dcs && p.size === r.size && r.qty.some((x, k) => x > p.qty[k])) {
      priceBreaks.push(r.code);
      G.forEach((g, k) => { if (r.qty[k] > p.qty[k]) { r.src[k] += `; price order: ${r.qty[k]} -> ${p.qty[k]} (= ${p.b})`; r.qty[k] = p.qty[k]; } });
      const t = tierOf(r.b);
      for (const [h, l] of t.strict) {
        const hi = gi(h), lo = gi(l);
        if (r.qty[hi] > r.qty[lo]) continue;
        if (r.qty[hi] - 1 < 1) continue;
        priceFixes.push(`${r.code} ${l} ${r.qty[lo]} -> ${r.qty[hi] - 1}`);
        r.src[lo] += `; after price order ${h} > ${l}: ${r.qty[lo]} -> ${r.qty[hi] - 1}`; r.qty[lo] = r.qty[hi] - 1;
        for (let k = lo + 1; k < G.length; k++) if (r.qty[k] > r.qty[k - 1]) { r.src[k] += `; after price order: ${r.qty[k]} -> ${r.qty[k - 1]}`; r.qty[k] = r.qty[k - 1]; }
      }
      if (!t.strict.every(([h, l]) => r.qty[gi(h)] > r.qty[gi(l)])) tierConflicts.push(`${r.code} ${r.qty.join('/')}`);
    }
    p = r; } }
  // final check: group order, tier rules (except where no lower value is possible) and price order
  { let p = null; for (const r of rows) {
    if (r.qty.some((x, k) => k && x > r.qty[k - 1])) throw new Error(`group order broken: ${r.code} ${r.qty.join('/')}`);
    if (p && p.dcs === r.dcs && p.size === r.size && r.qty.some((x, k) => x > p.qty[k])) throw new Error(`price order broken: ${r.code}`);
    p = r; } }

  // ---------- workbook ----------
  const wb = new ExcelJS.Workbook();
  const head = (ws, widths) => { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }]; (widths || []).forEach((w, i) => (ws.getColumn(i + 1).width = w)); };

  const a = wb.addWorksheet('Allocation');
  a.addRow(['DPS_Code', ...GROUP_NAMES]);
  for (const r of rows) a.addRow([r.code, ...r.qty]);
  head(a, [24]);

  const s = wb.addWorksheet('Source');
  s.addRow(['DPS_Code', ...GROUP_NAMES, 'Ladder used']);
  for (const r of rows) s.addRow([r.code, ...r.src, r.ladderKey]);
  head(s, [24, ...GROUP_NAMES.map(() => 26), 18]);
  const fill = { Benchmark: 'FFC6EFCE', Derived: 'FFFFEB9C', Ladder: 'FFFFC7CE' };
  s.eachRow((row, i) => { if (i > 1) for (let c = 2; c <= 8; c++) { const k = String(row.getCell(c).value).match(/^[A-Za-z]+/)[0]; row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill[k] } }; } });

  const bc = wb.addWorksheet('Before order rules');
  bc.addRow(['DPS_Code', ...GROUP_NAMES]);
  for (const r of rows) bc.addRow([r.code, ...r.raw]);
  head(bc, [24]);

  const c = wb.addWorksheet('Calculated detail');
  c.addRow(['DPS_Code', 'Store group', 'Store x item pairs', `Pairs kept (top ${Math.round(KEEP_TOP * 100)}%)`, 'Lowest kept daily',
    'Daily units average', 'Weekly units average (x7)', `x ${MULT}`, 'Qty (round up, min 1)', `Used (>= ${MIN_PAIRS} pairs)`]);
  for (const r of rows) for (const g of GROUP_NAMES) { const x = r.calc[g]; if (x) c.addRow([r.code, g, x.pairs, x.keep, +x.lowestKept.toFixed(4), +x.daily.toFixed(4), +x.weekly.toFixed(4), +x.xm.toFixed(4), x.qty, r.isBench ? (x.pairs >= MIN_PAIRS ? 'Benchmark' : `Benchmark - filled (< ${MIN_PAIRS} pairs)`) : 'No (derived from the benchmark)']); }
  head(c, [24, 10, 12, 12, 12, 12, 14, 10, 12]);

  const tMap = new Map(table.map(t => [t.code, t.q]));
  const v = wb.addWorksheet('Vs Wesley table');
  v.addRow(['DPS_Code', ...GROUP_NAMES.map(g => `Wesley ${g}`), ...GROUP_NAMES.map(g => `New ${g}`), 'New source (A1)']);
  for (const r of rows) v.addRow([r.code, ...(tMap.get(r.code) || GROUP_NAMES.map(() => '')), ...r.qty, r.src[0].match(/^[A-Za-z]+/)[0]]);
  head(v, [24]);

  const bt = wb.addWorksheet('Benchmarks');
  bt.addRow(['DCS', 'Size', 'Benchmark bucket', 'Pairs (all groups)', ...GROUP_NAMES.map(g => `Calculated ${g}`), ...GROUP_NAMES.map(g => `Benchmark ${g}`), 'Groups filled (< ' + MIN_PAIRS + ' pairs)', 'Ladder used']);
  for (const x of benches) bt.addRow([x.dcs, x.size, x.b, x.pairs, ...x.raw, ...x.q, x.filled, x.ladderKey]);
  head(bt, [10, 6, 10, 10]);

  const rk = wb.addWorksheet('Rankings');
  rk.addRow(['DCS group', 'DCS group name', 'Rank', 'Store group', 'Store', 'Name', 'Best year', `Best-year ${periodName} sales`, 'Used in average', 'Note']);
  for (const { dg, s: st } of rankings) rk.addRow([dg.id, dg.name, st.rank, st.group, st.code, st.name, st.bestYear ?? '', st.best === null ? '' : +st.best.toFixed(2), st.ownHistory ? 'Yes' : 'No', st.note]);
  head(rk, [9, 40, 6, 10, 7, 24, 9, 14, 10, 80]);

  const n = wb.addWorksheet('Notes');
  [
    `DPS group allocation - all DPS codes, ${periodName} (fiscal weeks ${pFrom}-${pTo === 54 ? 'end of year' : pTo}), built ${iso(new Date())} as of ${iso(TODAY)}.`,
    `Rows: ${rows.length} DPS codes (every DCS in Wesley's ladder table or with sales, x sizes (CL: ${SIZE_ORDER.join('/')}; others: No) x ${BUCKET_ORDER.length} price buckets).`,
    `DCS/size ladders: ${counts.dcsSizes}, ${benches.length} with a benchmark (Benchmarks tab), ${counts.noBench} without (ladder as-is). Cells: ${counts.Benchmark} benchmark (${counts.filledBench} of them filled from the ladder because the group had < ${MIN_PAIRS} pairs), ${counts.Derived} derived, ${counts.Ladder} ladder (Source tab: green / yellow / red). ${counts.tierAdjusted} DPS codes adjusted by the tier order rules.`,
    `Benchmark (Step 2c, per Wesley 2026-11-13): per DCS/size, the price bucket with the most store x item pairs (all groups) among buckets with >= ${MIN_PAIRS} pairs in at least one group. Groups with < ${MIN_PAIRS} pairs there: ladder benchmark value x the pairs-weighted calculated / ladder ratio of the other groups. Group order by pairs-weighted average where broken, round up, then its tier rules.`,
    `Ranking per DCS group (Step 1c): gross sales, best of ${YEARS.join('/')}, ties by size then store code, 479 below 462, matched / no-sales stores. Rankings tab.`,
    `Calculated (Step 2b): store x item pairs in each store's best year; daily units = best 7-day window (for each sale date: in-bucket units from that date to date + 6, not past the period end, / ${MIN_DAYS}; the highest); top ${Math.round(KEEP_TOP * 100)}% of pairs by daily units; x 7 x ${MULT}; round up, min 1. Price = EXT_PRICE / SOLD_QTY per salesfact row; DCS and size from SAP today.`,
    `Other buckets: ROUNDUP(benchmark group qty x slope), min 1; slope = average of the ladder ratios (bucket / benchmark bucket) for A1, A2, A3, B. Then the tier rules - always E <= D <= C <= B <= A3 <= A2 <= A1, plus: up to 46-51 A2 > B, B > D (decrease D, E, else increase B); 51-56 to 91-101 A3 > C, B > D (decrease D, E, else increase B); 101-150 to 250-300 A3 > C, B > C (decrease C, D, E, else increase B); 300-350 and up A3 > B (decrease B, C, D, E, else increase A3). Price order (bucket <= next cheaper, per Wesley: lower the pricier bucket): ${priceBreaks.length} DPS codes lowered${priceBreaks.length ? ' (' + priceBreaks.slice(0, 20).join(', ') + (priceBreaks.length > 20 ? ', ...' : '') + ')' : ''}; then ${priceFixes.length} lower groups decreased to keep the tier rule (${priceFixes.slice(0, 30).join(', ')}); tier rules still broken: ${tierConflicts.length ? tierConflicts.join(', ') : 'none'}.`,
    `Ladder: ${path.basename(ladderFile)}. DCS/size not in it: CL ME uses the matching CL WO ladder; others use the standard ladder (${STANDARD_LADDER}). Sized rows outside CL are ignored.`,
    outOfScope.length ? `Skipped (not in any DCS group): ${outOfScope.join(', ')}.` : 'All DCSs are in a DCS group.',
    
  ].forEach(line => n.addRow([line]));
  n.getColumn(1).width = 170;

  await wb.xlsx.writeFile(out);
  log(`rows ${rows.length} | DCS/size ${counts.dcsSizes}: ${benches.length} with benchmark, ${counts.noBench} ladder only | cells benchmark ${counts.Benchmark} (${counts.filledBench} filled), derived ${counts.Derived}, ladder ${counts.Ladder} | tier-adjusted codes ${counts.tierAdjusted} | price order lowered ${priceBreaks.length} codes, then ${priceFixes.length} tier decreases, conflicts left ${tierConflicts.length}`);
  if (tierConflicts.length) console.log('Tier conflicts after price order:', tierConflicts.join('; '));
  if (outOfScope.length) console.log('Skipped (not in a DCS group):', outOfScope.join(', '));
  for (const b of ['0-1', '5-7', '10-13', '21-26', '81-91', '101-150', '>=500']) console.log('Check JE WO NK/' + b + '/No:', rows.find(r => r.code === 'JE WO NK/' + b + '/No')?.qty.join('/'));
  console.log('Wrote', out);
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { closeHana(); sql.close(); });
