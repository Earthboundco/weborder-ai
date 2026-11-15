// Computes each item's DPS Code from live SAP item data using dps-code.js (Wesley's DAX formula)
// and compares it with the DPS Code in assets/Item_Information_Complete_for_Replenishment.xlsx.
// Read-only: touches no database tables, writes only the CSV.
//
// Usage: node scripts/compare-dps-code.js [xlsx] [output.csv]
// Defaults: the assets file above; Claude_results/<MM-DD-YY>-DPS_Code_Check.csv (all items, with a
// Match column, so Wesley can filter the differences).
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadItemInfo } = require('../item-info');
const { dpsCode } = require('../dps-code');
const { closeHana } = require('../hana');

function todayDateStr() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`;
}

const csv = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const xlsx = path.resolve(process.argv[2] || 'assets/Item_Information_Complete_for_Replenishment.xlsx');
  const outDir = path.resolve('Claude_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(process.argv[3] || path.join(outDir, `${todayDateStr()}-DPS_Code_Check.csv`));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);
  const sheet = wb.worksheets[0];
  const col = {};
  sheet.getRow(1).eachCell((c, n) => { col[String(c.value).trim()] = n; });
  for (const h of ['Item', 'DCS', 'Sale Price', 'DPS Code']) {
    if (!col[h]) throw new Error(`Header "${h}" not found in ${xlsx}`);
  }
  const fileRows = [];
  sheet.eachRow((row, i) => {
    if (i === 1 || typeof row.getCell(col['Item']).value !== 'number') return;
    fileRows.push({
      item: String(row.getCell(col['Item']).value),
      dcs: String(row.getCell(col['DCS']).value).trim(),
      price: row.getCell(col['Sale Price']).value,
      dps: String(row.getCell(col['DPS Code']).value).trim(),
    });
  });

  const sap = await loadItemInfo();
  const header = ['Item', 'FileDPSCode', 'SAPComputedDPSCode', 'Match', 'SAP_DCS', 'SAP_SalePrice', 'SAP_RetailPrice', 'SAP_Size', 'File_DCS', 'File_SalePrice', 'Note'];
  const lines = [header.join(',')];
  let match = 0, mismatch = 0, missing = 0;
  for (const r of fileRows) {
    const s = sap.items.get(r.item);
    if (!s) {
      missing++;
      lines.push([r.item, r.dps, '', 'N', '', '', '', '', r.dcs, r.price, 'item not found in SAP'].map(csv).join(','));
      continue;
    }
    const computed = dpsCode(s['DCS Code'], s['Sale Price'], s['Size']);
    const ok = computed === r.dps;
    ok ? match++ : mismatch++;
    const notes = [];
    if (!ok && s['DCS Code'] !== r.dcs) notes.push('DCS differs');
    if (!ok && Number(s['Sale Price']) !== Number(r.price)) notes.push('sale price differs');
    lines.push([r.item, r.dps, computed, ok ? 'Y' : 'N', s['DCS Code'], s['Sale Price'], s['Retail Price'], s['Size'], r.dcs, r.price, notes.join('; ')].map(csv).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Items: ${fileRows.length}  match: ${match}  mismatch: ${mismatch}  not in SAP: ${missing}`);
  console.log(`Wrote ${outPath}`);
  await closeHana();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
