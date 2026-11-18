// Copies the local database (data/hotel.db, or HOTEL_DB) into an empty Turso database, table by table.
// Run once before the first Vercel deploy:   npm run upload
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, e.g. in a .env.turso file (see .env.example).
import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../server/db.js';

const src = path.resolve(process.env.HOTEL_DB || 'data/hotel.db');
const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env;
if (!url || !authToken) { console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first (see .env.example).'); process.exit(1); }
if (!fs.existsSync(src)) { console.error(`No local database at ${src}. Run "npm start" once to create it.`); process.exit(1); }

const local = createClient({ url: `file:${src}` });
const remoteDb = await openDb({ url, authToken }); // creates the tables if they are missing
remoteDb.close();
const remote = createClient({ url, authToken });

const existing = (await remote.execute('SELECT COUNT(*) n FROM users')).rows[0].n;
if (existing > 0) { console.error(`Turso already has ${existing} users. Refusing to copy over existing data.`); process.exit(1); }

// tables in the order they were created, so every row's parent exists before it
const tables = (await local.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)).rows
  .map(r => r.name).filter(t => t !== 'sessions');
const BATCH = 300;
let total = 0;
for (const t of tables) {
  const rs = await local.execute(`SELECT * FROM ${t}`);
  if (!rs.rows.length) continue;
  const cols = rs.columns, sql = `INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < rs.rows.length; i += BATCH) {
    await remote.batch(rs.rows.slice(i, i + BATCH).map(r => ({ sql, args: cols.map(c => r[c]) })), 'write');
  }
  total += rs.rows.length;
  console.log(`${t.padEnd(16)} ${rs.rows.length} rows`);
}
console.log(`Done: ${total} rows copied to Turso.`);
local.close();
remote.close();
