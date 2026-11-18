import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { routes, err, has } from './core.js';
import './api.js';
import { seed } from './seed.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function serveStatic(pathname, res) {
  const name = pathname === '/' ? 'index.html' : pathname === '/book' ? 'book.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC, name);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', ch => {
      size += ch.length;
      if (size > 1e6) { reject(err(413, 'Request too large')); req.destroy(); }
      else chunks.push(ch);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(err(400, 'Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

// One request handler for both the local server and the Vercel function. getDb returns the (lazily opened) database.
export function createHandler(getDb, { quiet = false, serveFiles = true } = {}) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (!serveFiles) throw err(404, 'Not found');
        if (req.method !== 'GET') throw err(405, 'Method not allowed');
        return serveStatic(url.pathname, res);
      }
      const db = await getDb();
      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw err(404, 'No such endpoint');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
      // behind Vercel's proxy the visitor's address is in x-forwarded-for; locally that header is ignored (it could be faked)
      const ip = (process.env.VERCEL && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress;
      const c = { db, params, query: Object.fromEntries(url.searchParams), body: req.method === 'GET' ? {} : await readBody(req), ip };
      if (r.perm) {
        c.token = (req.headers.authorization || '').replace(/^Bearer /, '');
        c.user = c.token && await db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1`).get(c.token, Date.now());
        if (!c.user) throw err(401, 'Please sign in');
        if (r.perm !== 'auth' && !has(c.user, r.perm)) throw err(403, 'Your role cannot do this');
      }
      send(res, 200, (await r.fn(c)) ?? { ok: true });
    } catch (e) {
      const status = e.status || (/constraint/i.test(e.message) ? 400 : 500);
      if (status === 500 && !quiet) console.error(e);
      send(res, status, { error: status === 500 ? 'Internal error' : /UNIQUE/i.test(e.message) ? 'That value is already in use' : e.message });
    }
  };
}

// Local server: a SQLite file, filled with the starter group and 30 days of history the first time.
export async function start({ dbPath = process.env.HOTEL_DB || 'data/hotel.db', port = Number(process.env.PORT) || 3000, quiet = false } = {}) {
  const db = await openDb(dbPath);
  if (!(await db.prepare('SELECT 1 FROM users LIMIT 1').get())) await seed(db);
  const server = http.createServer(createHandler(() => db, { quiet }));
  return new Promise(resolve => server.listen(port, () => resolve({ server, db, port: server.address().port })));
}
