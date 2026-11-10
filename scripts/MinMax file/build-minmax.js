// Builds Wesley's MinMax upload file (.xls) from his master, the way he asked on 2026-11-10:
// copy P:\PlanAllocation\MinMax_Files\Information\Master file for Claude.xls, load per item the DC row
// (CODE 000 / ID 0) then every store, in stores.csv order, delete unused rows, the "end" row and
// columns M:N, and point the names draftdata / Replinishment at A1:K<last row>. The Excel part runs in
// fill-master.ps1 (Excel COM), which also reopens the saved file and verifies it.
// Before that, checks stores.csv against EBT.dbo.[Store Directory] (reports any E-ACTIVE store missing
// from the list or any ID mismatch; inactive listed stores are kept - Wesley, 2026-11-02) and checks the
// item numbers exist in SAP.
//
// Usage: node "scripts/MinMax file/build-minmax.js" [--out <file.xls>] <item>:<dcMin>/<dcMax>:<storeMin>/<storeMax> ...
//    or: node "scripts/MinMax file/build-minmax.js" [--out <file.xls>] --json <instructions.json>
//        instructions.json = [{ item, dcMin, dcMax, storeMin, storeMax }, ...]
// Default output: Desktop\Claude files\MinMax_YYYY-MM-DD.xls (never overwritten).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sql, getPool } = require('../../db');
const { hanaQuery, closeHana } = require('../../hana');

const MASTER = 'P:\\PlanAllocation\\MinMax_Files\\Information\\Master file for Claude.xls';
const OUT_DIR = path.join(os.homedir(), 'OneDrive - Earthbound Trading Company', 'Desktop', 'Claude files');
const STORES_CSV = path.join(__dirname, 'stores.csv');

function usage() {
  console.error('Usage: node "scripts/MinMax file/build-minmax.js" [--out <file.xls>] <item>:<dcMin>/<dcMax>:<storeMin>/<storeMax> ... | --json <file>');
  process.exit(1);
}

function parseArgs(argv) {
  let out = null;
  const outIdx = argv.indexOf('--out');
  if (outIdx !== -1) {
    out = path.resolve(argv[outIdx + 1]);
    argv = argv.filter((_, i) => i !== outIdx && i !== outIdx + 1);
  }
  if (!argv.length) usage();
  let items;
  if (argv[0] === '--json') {
    items = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'));
  } else {
    items = argv.map(spec => {
      const m = spec.match(/^(\d+):(\d+)\/(\d+):(\d+)\/(\d+)$/);
      if (!m) throw new Error(`bad item spec "${spec}" (expected item:dcMin/dcMax:storeMin/storeMax)`);
      return { item: +m[1], dcMin: +m[2], dcMax: +m[3], storeMin: +m[4], storeMax: +m[5] };
    });
  }
  if (!items.length) throw new Error('no items given');
  for (const it of items) {
    const nums = [it.item, it.dcMin, it.dcMax, it.storeMin, it.storeMax];
    if (!nums.every(Number.isInteger)) throw new Error(`non-integer value for item ${it.item}`);
    if (it.dcMin > it.dcMax || it.storeMin > it.storeMax) throw new Error(`min > max for item ${it.item}`);
  }
  if (new Set(items.map(i => i.item)).size !== items.length) throw new Error('duplicate item numbers');
  const today = new Date().toLocaleDateString('en-CA');
  return { out: out || path.join(OUT_DIR, `MinMax_${today}.xls`), items };
}

function readStores() {
  const lines = fs.readFileSync(STORES_CSV, 'utf8').trim().split(/\r?\n/).slice(1);
  const stores = lines.map(l => { const [code, id] = l.split(','); return { code, id }; });
  if (stores.length !== 160 || stores[0].code !== '000') throw new Error(`unexpected stores.csv: ${stores.length} rows, first ${stores[0].code}`);
  return stores;
}

async function checkStoreDirectory(stores) {
  const pool = await getPool();
  const dir = (await pool.request().query('SELECT [Code #] code, [ID #] id, [E-ACTIVE] act FROM EBT.dbo.[Store Directory]')).recordset;
  const listed = new Map(stores.map(s => [s.code, s.id]));
  const missing = dir.filter(d => d.act && !listed.has(String(d.code).trim()));
  const mismatch = dir.filter(d => listed.has(String(d.code).trim()) && listed.get(String(d.code).trim()) !== String(d.id));
  console.log('Active stores missing from list:', missing.map(d => `${String(d.code).trim()}/${d.id}`).join(', ') || 'none');
  console.log('ID mismatches:', mismatch.map(d => `${String(d.code).trim()} list ${listed.get(String(d.code).trim())} dir ${d.id}`).join(', ') || 'none');
}

async function checkItems(items) {
  const codes = items.map(i => `'${i.item}'`).join(',');
  const rows = await hanaQuery(`SELECT "ItemCode" FROM "EARTHBOUND"."OITM" WHERE "ItemCode" IN (${codes})`);
  const found = new Set(rows.map(r => String(r.ItemCode)));
  const missing = items.filter(i => !found.has(String(i.item))).map(i => i.item);
  console.log('Items not in SAP:', missing.join(', ') || 'none');
}

async function main() {
  const { out, items } = parseArgs(process.argv.slice(2));
  if (fs.existsSync(out)) throw new Error(`${out} already exists - not overwriting`);
  const stores = readStores();
  try {
    await checkStoreDirectory(stores);
  } finally {
    await sql.close();
  }
  try {
    await checkItems(items);
  } finally {
    await closeHana();
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = path.join(os.tmpdir(), `minmax-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(items));
  try {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fill-master.ps1'),
      '-Master', MASTER, '-Instructions', tmp, '-Out', out, '-StoresCsv', STORES_CSV], { encoding: 'utf8' });
    process.stdout.write(ps.stdout);
    if (ps.status !== 0) throw new Error(`fill-master.ps1 failed:\n${ps.stderr}`);
  } finally {
    fs.unlinkSync(tmp);
  }
  console.log(`Wrote ${out}`);
}

main().catch(err => {
  console.error('MinMax build failed:', err.message);
  process.exit(1);
});
