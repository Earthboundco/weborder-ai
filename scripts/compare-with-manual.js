// Compares a Final_Allocation_Results-shaped CSV (StoreCode, ItemCode, Qty) against Wesley's
// manual weborder output, key-by-key (StoreCode+ItemCode), and writes a discrepancy report.
// Formalized 2026-09-19 - this comparison has been run by hand each week since the first
// Claude-vs-Wesley comparison (2026-09-10); this is the first time it's a checked-in script
// instead of a one-off in the working scratchpad.
//
// Usage: node scripts/compare-with-manual.js <claude-file.csv> <wesley-file.csv> [output.csv]
// Defaults output to Claude_results/<MM-DD-YY>-Discrepancies_Check.csv (Wesley's naming
// convention - date prefix, Claude_results/ is where all delivered files live).
const fs = require('fs');
const path = require('path');

function todayDateStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}-${dd}-${yy}`;
}

function loadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [store, item, qty] = lines[i].split(',');
    map.set(`${store}|${item}`, { store, item, qty: Number(qty) });
  }
  return map;
}

function main() {
  const claudePath = process.argv[2];
  const wesPath = process.argv[3];
  if (!claudePath || !wesPath) {
    console.error('Usage: node scripts/compare-with-manual.js <claude-file.csv> <wesley-file.csv> [output.csv]');
    process.exit(1);
  }

  const outDir = path.resolve('Claude_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = process.argv[4] || path.join(outDir, `${todayDateStr()}-Discrepancies_Check.csv`);

  const claude = loadCsv(claudePath);
  const wes = loadCsv(wesPath);

  const allKeys = new Set([...claude.keys(), ...wes.keys()]);
  const rows = [];

  for (const key of allKeys) {
    const c = claude.get(key);
    const w = wes.get(key);
    if (c && !w) {
      rows.push({ StoreCode: c.store, ItemCode: c.item, ClaudeQty: c.qty, WesQty: '', Difference: c.qty, DiscrepancyType: 'Only in Claude' });
    } else if (!c && w) {
      rows.push({ StoreCode: w.store, ItemCode: w.item, ClaudeQty: '', WesQty: w.qty, Difference: -w.qty, DiscrepancyType: 'Only in Wes' });
    } else if (c.qty !== w.qty) {
      rows.push({ StoreCode: c.store, ItemCode: c.item, ClaudeQty: c.qty, WesQty: w.qty, Difference: c.qty - w.qty, DiscrepancyType: 'Qty mismatch' });
    }
  }

  rows.sort((a, b) => {
    if (a.StoreCode !== b.StoreCode) return Number(a.StoreCode) - Number(b.StoreCode);
    return Number(a.ItemCode) - Number(b.ItemCode);
  });

  const headers = ['StoreCode', 'ItemCode', 'ClaudeQty', 'WesQty', 'Difference', 'DiscrepancyType'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => r[h]).join(','));
  }

  fs.writeFileSync(path.resolve(outPath), lines.join('\n'), 'utf8');
  console.log(`Wrote ${rows.length} discrepancy row(s) to ${outPath}`);
  console.log(`(Claude rows: ${claude.size}, Wes rows: ${wes.size})`);
}

main();
