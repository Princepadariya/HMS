// Vercel function: vercel.json rewrites every /api/* request here as /api?__path=<rest>, and it goes through
// the same handler as the local server. The database is Turso; its address and token come from Vercel's environment variables.
import { createHandler } from '../server/index.js';
import { openDb } from '../server/db.js';

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token } = process.env;
// connection problems are reported in plain words, never with the token in them
const explain = e => {
  const msg = String(e?.message || e).split(token || '\u0000').join('***');
  return Object.assign(new Error(`Cannot reach the database: ${msg}. Check TURSO_DATABASE_URL (must start with libsql:// and end with .turso.io) and TURSO_AUTH_TOKEN in Vercel, then redeploy.`), { status: 503 });
};

let db; // reused while this function instance stays warm
function getDb() {
  if (!url || !token) throw Object.assign(new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are not set in Vercel. Add them, then redeploy.'), { status: 503 });
  if (process.env.VERCEL && !/^(libsql|https):\/\/[^/]+\.turso\.io\/?$/.test(url.trim()))
    throw Object.assign(new Error('TURSO_DATABASE_URL looks wrong: it must be the database URL like libsql://hms-yourname.region.turso.io, not the dashboard link.'), { status: 503 });
  db ||= openDb({ url: url.trim(), authToken: token.trim() }).catch(e => { db = null; throw explain(e); });
  return db;
}

const handler = createHandler(getDb, { serveFiles: false });

export default async function vercel(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const rest = u.searchParams.get('__path');
  if (rest !== null) { u.searchParams.delete('__path'); req.url = `/api/${rest}${u.search}`; }
  if (req.url.split('?')[0] === '/api/health') {
    let body;
    try { const d = await getDb(); await d.prepare('SELECT COUNT(*) n FROM users').get(); body = { ok: true, database: 'connected' }; }
    catch (e) { body = { ok: false, error: e.message }; }
    res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }
  return handler(req, res);
}
