// SAP HANA connection (SAP's `hdb` driver), the HANA counterpart of db.js. Settings come from
// .env: HANA_HOST, HANA_PORT, HANA_USERNAME, HANA_PASSWORD, optional HANA_DATABASE (tenant name,
// for multi-tenant systems) and HANA_SCHEMA (default schema for unqualified names - REPORTUSER).
require('dotenv').config({ quiet: true });
const hdb = require('hdb');

let client;

function getHana() {
  if (client) return Promise.resolve(client);
  const config = {
    host: process.env.HANA_HOST,
    port: Number(process.env.HANA_PORT),
    user: process.env.HANA_USERNAME,
    password: process.env.HANA_PASSWORD,
  };
  if (process.env.HANA_DATABASE) config.databaseName = process.env.HANA_DATABASE;
  const c = hdb.createClient(config);
  c.on('error', err => console.error('HANA connection error:', err.message));
  return new Promise((resolve, reject) => {
    c.connect(err => {
      if (err) return reject(err);
      const schema = process.env.HANA_SCHEMA;
      if (!schema) { client = c; return resolve(c); }
      c.exec(`SET SCHEMA "${schema.replace(/"/g, '""')}"`, e => {
        if (e) return reject(e);
        client = c;
        resolve(c);
      });
    });
  });
}

// Runs a query and resolves to an array of row objects. Use ? placeholders with params.
async function hanaQuery(sqlText, params = []) {
  const c = await getHana();
  if (!params.length) {
    return new Promise((resolve, reject) => c.exec(sqlText, (err, rows) => (err ? reject(err) : resolve(rows))));
  }
  return new Promise((resolve, reject) => {
    c.prepare(sqlText, (err, stmt) => {
      if (err) return reject(err);
      stmt.exec(params, (e, rows) => { stmt.drop(() => {}); return e ? reject(e) : resolve(rows); });
    });
  });
}

function closeHana() {
  if (client) { client.end(); client = undefined; }
}

module.exports = { getHana, hanaQuery, closeHana };
