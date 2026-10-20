// Lists the tables, views and synonyms in a SAP HANA schema with their columns.
//
// Usage: node scripts/list-hana-objects.js [SCHEMA]    (defaults to HANA_SCHEMA from .env, i.e. REPORTUSER)
// Writes Claude_results/<MM-DD-YY>-HANA_<SCHEMA>_Objects.csv (one row per column) and prints a
// summary, plus the schemas this user can see.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { hanaQuery, closeHana } = require('../hana');

const csvLine = vals => vals.map(v => { if (v === null || v === undefined) return ''; const s = String(v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; }).join(',');

async function main() {
  const schema = (process.argv[2] || process.env.HANA_SCHEMA || '').toUpperCase();
  if (!schema) throw new Error('No schema - pass one or set HANA_SCHEMA in .env');

  const [{ CURRENT_USER: user, CURRENT_SCHEMA: cur, DATABASE_NAME: db, VERSION: ver }] =
    await hanaQuery(`SELECT CURRENT_USER, CURRENT_SCHEMA, (SELECT DATABASE_NAME FROM SYS.M_DATABASE) AS DATABASE_NAME, (SELECT VERSION FROM SYS.M_DATABASE) AS VERSION FROM DUMMY`);
  console.log(`Connected: database ${db}, HANA ${ver}, current schema ${cur}${user === schema ? ' (same name as the login user)' : ''}`);

  const schemas = await hanaQuery(`SELECT SCHEMA_NAME, SCHEMA_OWNER FROM SYS.SCHEMAS ORDER BY SCHEMA_NAME`);
  const visible = schemas.filter(s => !/^(_SYS|SYS$|SYSTEM$|SAP_|UIS$|HANA_XS_BASE$|XSSQLCC_)/.test(s.SCHEMA_NAME));
  console.log(`Visible schemas (${schemas.length} total, ${visible.length} non-system): ${visible.map(s => s.SCHEMA_NAME).join(', ')}`);

  const tables = await hanaQuery(`SELECT TABLE_NAME AS NAME, TABLE_TYPE, CREATE_TIME, COMMENTS FROM SYS.TABLES WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME`, [schema]);
  const views = await hanaQuery(`SELECT VIEW_NAME AS NAME, VIEW_TYPE, CREATE_TIME, COMMENTS FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME`, [schema]);
  const synonyms = await hanaQuery(`SELECT SYNONYM_NAME AS NAME, OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE FROM SYS.SYNONYMS WHERE SCHEMA_NAME = ? ORDER BY SYNONYM_NAME`, [schema]);
  const tcols = await hanaQuery(`SELECT TABLE_NAME AS OBJ, POSITION, COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, COMMENTS FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME, POSITION`, [schema]);
  const vcols = await hanaQuery(`SELECT VIEW_NAME AS OBJ, POSITION, COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, COMMENTS FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME, POSITION`, [schema]);

  // Row counts for tables (best effort - needs privileges on M_TABLES).
  const counts = new Map();
  try {
    for (const r of await hanaQuery(`SELECT TABLE_NAME, SUM(RECORD_COUNT) AS N FROM SYS.M_TABLES WHERE SCHEMA_NAME = ? GROUP BY TABLE_NAME`, [schema])) counts.set(r.TABLE_NAME, Number(r.N));
  } catch (e) { console.log(`(row counts unavailable: ${e.message})`); }

  const type = (dt, len, sc) => (/CHAR|BINARY/.test(dt) ? `${dt}(${len})` : /DECIMAL/.test(dt) && len ? `${dt}(${len},${sc})` : dt);
  const out = [];
  const colsBy = (cols, name) => cols.filter(c => c.OBJ === name);
  console.log(`\nSchema ${schema}: ${tables.length} tables, ${views.length} views, ${synonyms.length} synonyms`);
  for (const t of tables) {
    const cs = colsBy(tcols, t.NAME);
    console.log(`\nTABLE ${t.NAME} (${t.TABLE_TYPE}${counts.has(t.NAME) ? `, ${counts.get(t.NAME).toLocaleString()} rows` : ''}, ${cs.length} columns)`);
    for (const c of cs) {
      console.log(`   ${c.COLUMN_NAME} : ${type(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE)}${c.IS_NULLABLE === 'FALSE' ? ' NOT NULL' : ''}`);
      out.push([schema, 'TABLE', t.NAME, counts.get(t.NAME) ?? '', c.POSITION, c.COLUMN_NAME, type(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE), c.IS_NULLABLE, c.COMMENTS || t.COMMENTS || '']);
    }
  }
  for (const v of views) {
    const cs = colsBy(vcols, v.NAME);
    console.log(`\nVIEW ${v.NAME} (${v.VIEW_TYPE}, ${cs.length} columns)`);
    for (const c of cs) {
      console.log(`   ${c.COLUMN_NAME} : ${type(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE)}${c.IS_NULLABLE === 'FALSE' ? ' NOT NULL' : ''}`);
      out.push([schema, 'VIEW', v.NAME, '', c.POSITION, c.COLUMN_NAME, type(c.DATA_TYPE_NAME, c.LENGTH, c.SCALE), c.IS_NULLABLE, c.COMMENTS || v.COMMENTS || '']);
    }
  }
  for (const s of synonyms) {
    console.log(`\nSYNONYM ${s.NAME} -> ${s.OBJECT_SCHEMA}.${s.OBJECT_NAME} (${s.OBJECT_TYPE})`);
    out.push([schema, 'SYNONYM', s.NAME, '', '', '', `-> ${s.OBJECT_SCHEMA}.${s.OBJECT_NAME} (${s.OBJECT_TYPE})`, '', '']);
  }

  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getFullYear()).slice(-2)}`;
  const dir = path.join(ROOT, 'Claude_results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-HANA_${schema}_Objects.csv`);
  fs.writeFileSync(file, [csvLine(['Schema', 'ObjectType', 'ObjectName', 'TableRows', 'Position', 'Column', 'DataType', 'Nullable', 'Comment']), ...out.map(csvLine)].join('\n'));
  console.log(`\nWrote ${file} (${out.length} rows)`);
}

main()
  .catch(err => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(closeHana);
