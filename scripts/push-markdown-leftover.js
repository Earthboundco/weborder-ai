// Pushes the DC quantity left over after the weborder allocation for markdown items
// (EBT Mark down = Y, i.e. EBTMKD = 'Yes_MD') out to the stores, in store-rank order.
// Requested by Wesley 2026-11-15. READ-ONLY: writes only a CSV, never AllocationResults.
//
// Rules:
//  - Items: EBTMKD = 'Yes_MD' with LeftoverQty >= one case. A leftover smaller than a case stays in
//    the DC (e.g. 97653: 2 left, case 3 - Wesley: fine).
//  - Stores: only where AllowSend = 'Y' (all 14 exclusion rules still apply, so markdown blocks etc.
//    stay in place); store 470 (Ecommerce) is excluded - it has its own request file.
//  - Order: the same Pattern_Store_Group rank the weborder run used (GroupRank in AllocationResults).
//  - Amount: repeated passes down the rank list; each pass gives a store up to its base allocation
//    qty (the vw_AllocationBase group/item base), rounded down to whole cases, until the leftover is
//    gone. Top-ranked stores therefore get the most. Stores whose base is 0 get nothing.
//  - Output is the ADDITIONAL quantity (StoreCode, ItemCode, Qty) on top of the normal allocation.
//
// Usage: node scripts/push-markdown-leftover.js [output.csv]   (default Claude_results/<MM-DD-YY>-Markdown_Leftover_Push.csv)
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

function todayDateStr() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`;
}

async function main() {
  const outDir = path.resolve('Claude_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(process.argv[2] || path.join(outDir, `${todayDateStr()}-Markdown_Leftover_Push.csv`));

  const pool = await getPool();
  const res = await pool.request().query(`
    SELECT a.ItemCode, a.StoreCode, a.GroupRank, a.QTY_PER_CASE cs, a.DC_Qty dc, a.FinalAllocationQty ship,
           b.BaseAllocationQty base
    FROM AllocationResults a
    JOIN Item_Information_Complete_for_Replenishment ii ON ii.ITEM_NO = a.ITEM_NO AND ii.EBTMKD = 'Yes_MD'
    JOIN vw_AllocationBase b ON b.ItemCode = a.ItemCode AND b.StoreCode = a.StoreCode
    WHERE a.AllowSend = 'Y' AND a.StoreCode <> '470'`);

  const byItem = new Map();
  for (const r of res.recordset) (byItem.get(r.ItemCode) || byItem.set(r.ItemCode, []).get(r.ItemCode)).push(r);

  const lines = ['StoreCode,ItemCode,Qty'];
  const summary = [];
  for (const [item, rows] of [...byItem].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cs = Number(rows[0].cs);
    const leftover = Number(rows[0].dc) - rows.reduce((s, r) => s + Number(r.ship), 0);
    if (leftover < cs) { summary.push({ item, leftover, pushed: 0, note: 'leftover < 1 case - stays in DC' }); continue; }
    const stores = rows.filter(r => Math.floor(Number(r.base) / cs) * cs > 0).sort((a, b) => Number(a.GroupRank) - Number(b.GroupRank));
    if (!stores.length) { summary.push({ item, leftover, pushed: 0, note: 'no eligible store with a base qty' }); continue; }
    const give = new Map();
    let remaining = Math.floor(leftover / cs) * cs;
    while (remaining > 0) {
      for (const s of stores) {
        if (remaining <= 0) break;
        const q = Math.min(Math.floor(Number(s.base) / cs) * cs, remaining);
        give.set(s.StoreCode, (give.get(s.StoreCode) || 0) + q);
        remaining -= q;
      }
    }
    for (const [store, q] of [...give].sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push(`${store},${item},${q}`);
    summary.push({ item, leftover, pushed: leftover - remaining, stores: give.size, note: remaining ? `${remaining} left (case remainder)` : '' });
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.table(summary);
  console.log(`Wrote ${lines.length - 1} row(s) to ${outPath}`);
  await sql.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
