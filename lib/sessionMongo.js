// ============================================================
//  QUEEN AKUMA V4 — MongoDB persistence for a SINGLE session process.
//
//  This is deliberately separate from lib/mongoStore.js (the
//  orchestrator's own connection): sessions.js forks one OS process per
//  WhatsApp session, and each of those processes needs its own MongoDB
//  handle to persist Baileys credentials/keys, settings and owner data —
//  there is no way to share a JS object across process boundaries, so
//  "one shared pool for everything" means one pool per orchestrator
//  process (mongoStore.js) AND one small pool per session process
//  (this file), never one connection per *sub-session within* a process.
//
//  Fully optional: if MONGODB_URI is not set, isEnabled() is false and
//  every caller (mongoAuthState.js, settingsStore.js, index.js's owner
//  handling) falls back to the local filesystem exactly like before.
//  On Heroku's ephemeral disk this is what makes credentials, settings
//  and the owner survive a dyno restart/redeploy instead of forcing a
//  re-pair every few hours.
// ============================================================

import { resolveMongoUri, resolveMongoDbName } from './mongoConfig.js';

const MONGODB_URI = resolveMongoUri();
const MONGODB_DB = resolveMongoDbName();

export const isEnabled = () => Boolean(MONGODB_URI);

let dbPromise = null;

function log(...args) { console.log('[mongo:session]', ...args); }

export async function getDb() {
    if (!isEnabled()) return null;
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
        try {
            const { MongoClient } = await import('mongodb');
            const client = new MongoClient(MONGODB_URI, {
                maxPoolSize: Number(process.env.MONGODB_SESSION_POOL || 5),
                minPoolSize: 1,
                serverSelectionTimeoutMS: 8000,
            });
            await client.connect();
            const db = client.db(MONGODB_DB);
            await ensureIndexes(db);
            log('connected');
            return db;
        } catch (e) {
            log('connection failed:', e.message);
            dbPromise = null; // allow a fresh attempt on the next call instead of caching the failure forever
            return null;
        }
    })();
    return dbPromise;
}

async function ensureIndexes(db) {
    try {
        await Promise.all([
            db.collection('auth_creds').createIndex({ sessionId: 1 }, { unique: true }),
            db.collection('auth_keys').createIndex({ sessionId: 1, type: 1, id: 1 }, { unique: true }),
            db.collection('session_owner').createIndex({ sessionId: 1 }, { unique: true }),
            db.collection('session_settings').createIndex({ sessionId: 1, kind: 1 }, { unique: true }),
        ]);
    } catch (e) { log('index creation warning:', e.message); }
}
