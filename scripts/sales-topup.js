// Step 3 of the agreed weborder workflow (Wesley, 2026-11-15): sales-based top-up of the DC leftover.
// READ-ONLY on the database; writes only CSV files. Run AFTER usp_RunAllocation (Step 1) and, if it was
// requested, after scripts/push-markdown-leftover.js.
//
// Rules:
//  - SuggestedBase per item/store combo = plain units sold in the last 3 weeks (21 days ending
//    yesterday; EBT.dbo.salesfact, STORE_NO = Store Directory [ID #] mapped to the business Store
//    Code; returns netted, floored at 0), no case rounding. It only counts where it is HIGHER than the
//    combo's current base (vw_AllocationBase).
//  - Leftover per item = DC_Qty - Step 1 shipped - markdown push qty (if the push file exists).
//  - Stores: AllowSend = 'Y' only (all 14 exclusion rules stay), store 470 excluded, ALL store groups.
//  - Walk the stores best Pattern_Store_Group rank (GroupRank as used by the run) to lowest. Each store
//    is topped up to its SuggestedBase:
//        qty = SuggestedBase - (on-hand + in-transit [floored at 0] + Step 1 shipped + markdown push)
//    rounded UP to whole cases (like Step 1); if the leftover can't cover it the store gets a partial
//    amount in whole cases. Stops when less than one case is left.
//  - Outputs (Claude_results/): <date>-Sales_Topup.csv (extra qty only) and
//    <date>-Final_Allocation_Results_Combined.csv (Step 1 + markdown push + top-up, same format as
//    Final_Allocation_Results).
//
// Usage: node scripts/sales-topup.js
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

const WEEKS = 3;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const readCsv = f => fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(','));

async function main() {
  const today = new Date();
  const start = new Date(today); start.setDate(start.getDate() - WEEKS * 7);
  const stamp = `${pad(today.getMonth() + 1)}-${pad(today.getDate())}-${String(today.getFullYear()).slice(-2)}`;
  const dir = path.resolve('Claude_results');
  const step1File = path.join(dir, `${stamp}-Final_Allocation_Results.csv`);
  const pushFile = path.join(dir, `${stamp}-Markdown_Leftover_Push.csv`);
  const topupFile = path.join(dir, `${stamp}-Sales_Topup.csv`);
  const combinedFile = path.join(dir, `${stamp}-Final_Allocation_Results_Combined.csv`);
  if (!fs.existsSync(step1File)) throw new Error(`Missing ${step1File} - run the allocation and export first.`);

  // markdown push qty per store/item (only if the push was requested for this run)
  const push = {};
  const pushRows = fs.existsSync(pushFile) ? readCsv(pushFile) : [];
  pushRows.forEach(([s, i, q]) => { push[`${s}|${i}`] = (push[`${s}|${i}`] || 0) + Number(q); });

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

  const rows = (await pool.request().query(`
    SELECT a.ItemCode, a.StoreCode, a.GroupRank, a.QTY_PER_CASE cs, a.DC_Qty dc, a.FinalAllocationQty ship,
           a.OnHandQty oh, a.InTransitQty it, b.BaseAllocationQty base
    FROM AllocationResults a
    JOIN vw_AllocationBase b ON b.ItemCode = a.ItemCode AND b.StoreCode = a.StoreCode
    WHERE a.AllowSend = 'Y' AND a.StoreCode <> '470'`)).recordset;

  const byItem = new Map();
  for (const r of rows) (byItem.get(r.ItemCode) || byItem.set(r.ItemCode, []).get(r.ItemCode)).push(r);

  const topup = [];
  const summary = { itemsWithLeftover: 0, itemsToppedUp: 0, combosFlagged: 0, combosFilled: 0, unitsAdded: 0, itemsLeftoverUsedUp: 0 };
  for (const [item, rs] of byItem) {
    const cs = Number(rs[0].cs);
    const step1 = rs.reduce((s, r) => s + Number(r.ship), 0);
    const pushed = rs.reduce((s, r) => s + (push[`${r.StoreCode}|${item}`] || 0), 0);
    let rem = Number(rs[0].dc) - step1 - pushed;
    if (rem < cs) continue;
    summary.itemsWithLeftover++;
    const cands = rs.filter(r => (sold[`${r.StoreCode}|${item}`] || 0) > Number(r.base))
      .sort((a, b) => Number(a.GroupRank) - Number(b.GroupRank));
    summary.combosFlagged += cands.length;
    let added = 0;
    for (const st of cands) {
      if (rem < cs) break;
      const suggested = sold[`${st.StoreCode}|${item}`];
      const held = Math.max(Number(st.oh) + Number(st.it), 0) + Number(st.ship) + (push[`${st.StoreCode}|${item}`] || 0);
      const need = suggested - held;
      if (need <= 0) continue;
      let q = Math.ceil(need / cs) * cs;
      if (q > rem) q = Math.floor(rem / cs) * cs;
      if (q <= 0) continue;
      topup.push([st.StoreCode, item, q]);
      rem -= q; added += q;
      summary.combosFilled++;
    }
    if (added) { summary.itemsToppedUp++; summary.unitsAdded += added; if (rem < cs) summary.itemsLeftoverUsedUp++; }
  }
  topup.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  fs.writeFileSync(topupFile, ['StoreCode,ItemCode,Qty', ...topup.map(r => r.join(','))].join('\n'), 'utf8');

  // combined = Step 1 + markdown push + top-up
  const comb = new Map();
  const add = (s, i, q) => comb.set(`${s}|${i}`, (comb.get(`${s}|${i}`) || 0) + Number(q));
  readCsv(step1File).forEach(([s, i, q]) => add(s, i, q));
  pushRows.forEach(([s, i, q]) => add(s, i, q));
  topup.forEach(([s, i, q]) => add(s, i, q));
  const out = [...comb].map(([k, q]) => [...k.split('|'), q])
    .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  fs.writeFileSync(combinedFile, ['StoreCode,ItemCode,Qty', ...out.map(r => r.join(','))].join('\n'), 'utf8');

  console.log(`Sales window ${ymd(start)} to ${ymd(today)} (exclusive), ${WEEKS} weeks.`);
  console.log(`Markdown push included: ${pushRows.length ? pushRows.reduce((s, r) => s + Number(r[2]), 0) + ' units' : 'no (file not found)'}`);
  console.log(summary);
  console.log(`Wrote ${topup.length} top-up rows (${summary.unitsAdded} units) to ${topupFile}`);
  console.log(`Wrote ${out.length} combined rows to ${combinedFile}`);
  await sql.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
