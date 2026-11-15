// Pushes the DC quantity left over after the weborder allocation for markdown items
// (EBT Mark down = Y, i.e. EBTMKD = 'Yes_MD') out to the stores. Requested by Wesley 2026-11-15.
// READ-ONLY: writes only a CSV, never AllocationResults.
//
// It works like Step 1 (target level minus what the store already has, rounded to cases) but with a
// base target that is raised gradually, round by round, until the leftover is used up.
//
// Rules (final version, Wesley 2026-11-15):
//  - Items: EBTMKD = 'Yes_MD' with LeftoverQty >= one case. A leftover smaller than a case stays in
//    the DC (e.g. 97653: 2 left, case 3 - Wesley: fine).
//  - Stores: only AllowSend = 'Y' (all 14 exclusion rules still apply, so markdown blocks etc. stay)
//    and ONLY store groups A1, A2, A3, B, C - groups D and E are skipped. Store 470 (Ecommerce) is
//    excluded - it has its own request file.
//  - Start: each store's target is its normal base allocation (vw_AllocationBase: Item_Code override,
//    else DPS_Code, by store group) - the level Step 1 already topped it up to.
//  - Each round k (1..MAX_ROUNDS = 200) raises the target by STEP_UNITS per round: target = base +
//    k * step, with steps A1 +2, A2 +2, A3 +2, B +2, C +1 units (changed from +3/+3/+3/+2/+1 on 2026-11-15).
//  - In each round, walking A1 -> A2 -> A3 -> B -> C and best Pattern_Store_Group rank first within a
//    group (GroupRank as used by the run), a store receives
//        need = target - (on-hand + in-transit [floored at 0] + Step 1 shipped + already pushed)
//    rounded UP to whole cases (like Step 1); if the leftover can't cover it, the store gets a partial
//    amount in whole cases. need <= 0 -> nothing this round.
//  - Stops when less than one case is left or after MAX_ROUNDS; any quantity still unplaced stays in
//    the DC and is reported.
//  - Output is the ADDITIONAL quantity (StoreCode, ItemCode, Qty) on top of the normal allocation.
//
// Usage: node scripts/push-markdown-leftover.js [output.csv]   (default Claude_results/<MM-DD-YY>-Markdown_Leftover_Push.csv)
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db');

// Units added to the target per round, by store group. Groups not listed (D, E) are skipped.
const STEP_UNITS = { A1: 2, A2: 2, A3: 2, B: 2, C: 1 };
const GROUP_ORDER = ['A1', 'A2', 'A3', 'B', 'C'];
const MAX_ROUNDS = 200;

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
    SELECT a.ItemCode, a.StoreCode, a.StoreGroup, a.GroupRank, a.QTY_PER_CASE cs, a.DC_Qty dc,
           a.FinalAllocationQty ship, a.OnHandQty oh, a.InTransitQty it, b.BaseAllocationQty base
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
    if (leftover < cs) { summary.push({ item, leftover, pushed: 0, rounds: 0, note: 'leftover < 1 case - stays in DC' }); continue; }
    const stores = rows.filter(r => STEP_UNITS[r.StoreGroup])
      .sort((a, b) => GROUP_ORDER.indexOf(a.StoreGroup) - GROUP_ORDER.indexOf(b.StoreGroup) || Number(a.GroupRank) - Number(b.GroupRank));
    if (!stores.length) { summary.push({ item, leftover, pushed: 0, rounds: 0, note: 'no eligible store in A1-C' }); continue; }

    // units each store already holds or is getting: on-hand + in-transit (floored at 0) + Step 1 shipment
    const held = new Map(stores.map(r => [r.StoreCode, Math.max(Number(r.oh) + Number(r.it), 0) + Number(r.ship)]));
    const give = new Map();
    let remaining = Math.floor(leftover / cs) * cs;
    let round = 0;
    while (remaining >= cs && round < MAX_ROUNDS) {
      round++;
      for (const st of stores) {
        if (remaining < cs) break;
        const target = Number(st.base) + round * STEP_UNITS[st.StoreGroup];
        const need = target - held.get(st.StoreCode);
        if (need <= 0) continue;
        let qty = Math.ceil(need / cs) * cs;                       // round UP to whole cases, as in Step 1
        if (qty > remaining) qty = Math.floor(remaining / cs) * cs; // partial amount, whole cases
        if (qty <= 0) continue;
        give.set(st.StoreCode, (give.get(st.StoreCode) || 0) + qty);
        held.set(st.StoreCode, held.get(st.StoreCode) + qty);
        remaining -= qty;
      }
    }
    for (const [store, q] of [...give].sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push(`${store},${item},${q}`);
    summary.push({
      item, leftover, pushed: leftover - remaining, rounds: round, stores: give.size,
      note: remaining >= cs ? `${remaining} unplaced after ${MAX_ROUNDS} rounds` : (remaining ? `${remaining} left (less than a case)` : ''),
    });
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.table(summary);
  console.log(`Wrote ${lines.length - 1} row(s) to ${outPath}`);
  await sql.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
