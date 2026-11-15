// Compares each item/store combo's BASE allocation with the combo's actual sales over the last 3
// weeks (changed to 3 weeks by Wesley 2026-11-15) and lists combos that should probably have a higher base.
// READ-ONLY (no DB writes); run after usp_RunAllocation.
//
// Logic:
//  - Base = vw_AllocationBase.BaseAllocationQty (Item_Code override, else DPS_Code) - the pre-Initial-
//    Shortage-Adjustment value. In the pipeline need = base - (on-hand + in-transit), so base is the
//    stock target a store is topped up to.
//  - Sales = EBT.dbo.salesfact SOLD_QTY for the 21 days ending yesterday (STORE_NO is the Store
//    Directory [ID #], mapped to the business Store Code), negatives from returns netted, floored at 0.
//  - Flag: Sold3Wks > base, i.e. the store sells more than its whole target in 3 weeks (weeks of cover
//    = base / (sold/3) < 3). Only combos with AllowSend = 'Y' (blocked combos can't receive stock) and
//    not store 470 (its qty is a request, not a base).
//  - SuggestedBase = the plain 3-week sales (hold 3 weeks of current velocity; Wesley 2026-11-15: no
//    case rounding - the pipeline already rounds the NEED up to whole cases when it ships);
//    Raise = SuggestedBase - base. A starting point, not a rule: promo/markdown spikes and DC
//    availability are NOT considered yet.
//
// Usage: node scripts/base-allocation-review.js [output.csv]   (default Claude_results/<MM-DD-YY>-Base_Allocation_Review.csv)
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - 21);
  const outPath = path.resolve(process.argv[2] || path.join('Claude_results', `${pad(today.getMonth() + 1)}-${pad(today.getDate())}-${String(today.getFullYear()).slice(-2)}-Base_Allocation_Review.csv`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const pool = await getPool();
  pool.config.requestTimeout = 600000;

  const idToCode = {};
  (await pool.request().query('SELECT [Code #] code, [ID #] id FROM EBT.dbo.[Store Directory]'))
    .recordset.forEach(r => { idToCode[r.id] = String(r.code).trim(); });

  const sold = {};
  (await pool.request().query(`
    SELECT STORE_NO s, ITEM_NO i, SUM(SOLD_QTY) q FROM EBT.dbo.salesfact
    WHERE [DATE] >= '${ymd(start)}' AND [DATE] < '${ymd(today)}'
      AND ITEM_NO IN (SELECT CAST(ItemCode AS decimal) FROM ItemReplenishment)
    GROUP BY STORE_NO, ITEM_NO`)).recordset.forEach(r => {
      const c = idToCode[r.s];
      if (c) sold[`${c}|${r.i}`] = (sold[`${c}|${r.i}`] || 0) + r.q;
    });

  const overrides = new Set((await pool.request().query('SELECT ItemCode, StoreGroup FROM Item_Code_allocation_table'))
    .recordset.map(r => `${r.ItemCode}|${r.StoreGroup}`));
  const rows = (await pool.request().query(`
    SELECT a.ItemCode, ii.DESCRIPTION1 descr, a.StoreCode, a.StoreGroup, a.DPS_Code, a.OnHandQty oh, a.InTransitQty it,
           a.QTY_PER_CASE cs, b.BaseAllocationQty base, ii.IStatus, ii.EBTMKD
    FROM AllocationResults a
    JOIN vw_AllocationBase b ON b.ItemCode = a.ItemCode AND b.StoreCode = a.StoreCode
    JOIN Item_Information_Complete_for_Replenishment ii ON ii.ITEM_NO = a.ITEM_NO
    WHERE a.AllowSend = 'Y' AND a.StoreCode <> '470'`)).recordset;

  const out = [];
  for (const x of rows) {
    const s = Math.max(sold[`${x.StoreCode}|${x.ItemCode}`] || 0, 0);
    if (s <= x.base) continue;
    const cs = Number(x.cs);
    const suggested = s;
    out.push({
      Item: x.ItemCode, Description: x.descr || '', Store: x.StoreCode, StoreGroup: x.StoreGroup, DPS_Code: x.DPS_Code,
      BaseSource: overrides.has(`${x.ItemCode}|${x.StoreGroup}`) ? 'Item_Code override' : 'DPS_Code',
      CurrentBase: x.base, Sold3Wks: s, WeeklyVelocity: +(s / 3).toFixed(2), WeeksOfCover: +(x.base / (s / 3)).toFixed(1),
      OnHand: x.oh, InTransit: x.it, Stock: Math.max(x.oh + x.it, 0) === 0 ? 'Out of stock' : 'In stock',
      SuggestedBase: suggested, Raise: suggested - x.base, CaseQty: cs, ItemStatus: x.IStatus, Markdown: x.EBTMKD === 'Yes_MD' ? 'Y' : '',
    });
  }
  out.sort((a, b) => (a.Stock === b.Stock ? 0 : a.Stock === 'Out of stock' ? -1 : 1) || b.Raise - a.Raise
    || a.Item.localeCompare(b.Item) || Number(a.Store) - Number(b.Store));

  const H = out.length ? Object.keys(out[0]) : [];
  fs.writeFileSync(outPath, [H.join(','), ...out.map(o => H.map(h => csv(o[h])).join(','))].join('\n'), 'utf8');
  console.log(`Window ${ymd(start)} to ${ymd(today)} (exclusive). Flagged ${out.length} of ${rows.length} allowed combos; ` +
    `${out.filter(o => o.Stock === 'Out of stock').length} out of stock; ${new Set(out.map(o => o.Item)).size} items; ` +
    `${new Set(out.map(o => o.Store)).size} stores; suggested raise ${out.reduce((a, o) => a + o.Raise, 0)} units.`);
  console.log(`Wrote ${outPath}`);
  await sql.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
