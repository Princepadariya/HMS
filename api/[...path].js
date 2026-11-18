// Vercel function: every /api/* request lands here and goes through the same handler as the local server.
// The database is Turso; its address and token come from the project's environment variables in Vercel.
import { createHandler } from '../server/index.js';
import { openDb } from '../server/db.js';

let db; // reused while this function instance stays warm
function getDb() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)
    throw Object.assign(new Error('Server is missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN'), { status: 503 });
  db ||= openDb({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }).catch(e => { db = null; throw e; });
  return db;
}

export default createHandler(getDb, { serveFiles: false });
