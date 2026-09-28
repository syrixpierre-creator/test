// ============================================================
//  QUEEN AKUMA V4 — MongoDB persistence layer (ORCHESTRATOR ONLY)
// ============================================================
//  This module lives entirely in the orchestrator process (sessions.js).
//  Individual session child processes never import it and never open
//  their own MongoDB connection — that would mean one connection per
//  WhatsApp session, which does not scale. There is exactly ONE
//  MongoClient, with connection pooling, shared by every session's
//  registry/state/checkpoint writes.
//
//  Fully optional: if MONGODB_URI is not set, every export below is a
//  safe no-op and the orchestrator keeps working off sessions/registry.json
//  exactly like before (see requirement #55 — don't rip out the JSON
//  registry, MongoDB becomes the source of truth *when configured*).
//
//  If MongoDB is configured but temporarily unreachable, calls are
//  retried with backoff in the background; nothing here ever calls
//  process.exit() or throws in a way that could take a session down.
// ============================================================

import fs from 'fs';
import path from 'path';

import { resolveMongoUri, resolveMongoDbName } from './mongoConfig.js';

const MONGODB_URI = resolveMongoUri();
const MONGODB_DB = resolveMongoDbName();

export const isEnabled = () => Boolean(MONGODB_URI);

let clientPromise = null; // single shared connection/pool for the whole process
let db = null;
let connecting = false;
let lastConnectError = null;
let reconnectTimer = null;

function log(...args) {
    console.log('[mongo]', ...args);
}

// Lazy dynamic import so a deployment without MONGODB_URI never needs the
// `mongodb` package to actually be resolvable at runtime for anything to
// work — sessions.js/index.js don't break if it's missing and unused.
async function loadDriver() {
    try {
        return await import('mongodb');
    } catch (e) {
        lastConnectError = `mongodb driver not installed (${e.message})`;
        return null;
    }
}

async function connect() {
    if (!isEnabled()) return null;
    if (db) return db;
    if (connecting) return clientPromise;
    connecting = true;

    const mongo = await loadDriver();
    if (!mongo) { connecting = false; scheduleReconnect(); return null; }

    clientPromise = (async () => {
        try {
            const client = new mongo.MongoClient(MONGODB_URI, {
                // A single shared pool for every session this process manages —
                // never one client per session (see file header + req #9).
                maxPoolSize: Number(process.env.MONGODB_MAX_POOL || 20),
                minPoolSize: 1,
                serverSelectionTimeoutMS: 8000,
            });
            await client.connect();
            db = client.db(MONGODB_DB);
            await ensureIndexes(db);
            log(`connected (db="${MONGODB_DB}")`);
            connecting = false;
            return db;
        } catch (e) {
            lastConnectError = e.message;
            log('connection failed:', e.message, '— will retry.');
            db = null;
            connecting = false;
            scheduleReconnect();
            return null;
        }
    })();

    return clientPromise;
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect().catch(() => {});
    }, 15000);
}

// Requirement #10 — index sessionId/ownerId/status/updatedAt/checkpoint fields
// so status/list queries never fall back to a full collection scan.
async function ensureIndexes(database) {
    try {
        const sessions = database.collection('sessions');
        await Promise.all([
            sessions.createIndex({ sessionId: 1 }, { unique: true }),
            sessions.createIndex({ ownerId: 1 }),
            sessions.createIndex({ status: 1 }),
            sessions.createIndex({ updatedAt: 1 }),
            sessions.createIndex({ 'checkpoint.lastProcessedMessageTimestamp': 1 }),
        ]);
    } catch (e) {
        log('index creation warning:', e.message);
    }
}

// Requirement #7/#8 — MongoDB as source of truth for session state.
// Upsert is idempotent: calling it twice with the same sessionId never
// creates a duplicate document (unique index above + $set semantics).
export async function upsertSession(sessionId, patch) {
    const database = await connect();
    if (!database) return false;
    try {
        await database.collection('sessions').updateOne(
            { sessionId },
            { $set: { ...patch, sessionId, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        return true;
    } catch (e) {
        log(`upsertSession(${sessionId}) failed:`, e.message);
        return false;
    }
}

// Requirement #20 — per-session watermark/checkpoint so a restart can tell
// historical (pre-restart) traffic apart from genuinely new messages.
export async function saveCheckpoint(sessionId, { lastProcessedMessageId, lastProcessedMessageTimestamp }) {
    const database = await connect();
    if (!database) return false;
    try {
        await database.collection('sessions').updateOne(
            { sessionId },
            { $set: {
                'checkpoint.lastProcessedMessageId': lastProcessedMessageId,
                'checkpoint.lastProcessedMessageTimestamp': lastProcessedMessageTimestamp,
                updatedAt: new Date(),
            } },
            { upsert: true }
        );
        return true;
    } catch (e) {
        log(`saveCheckpoint(${sessionId}) failed:`, e.message);
        return false;
    }
}

export async function getCheckpoint(sessionId) {
    const database = await connect();
    if (!database) return null;
    try {
        const doc = await database.collection('sessions').findOne(
            { sessionId },
            { projection: { checkpoint: 1 } }
        );
        return doc?.checkpoint || null;
    } catch (e) {
        log(`getCheckpoint(${sessionId}) failed:`, e.message);
        return null;
    }
}

export async function deleteSession(sessionId) {
    const database = await connect();
    if (!database) return false;
    try {
        // Also wipe everything the session process itself persists via
        // lib/sessionMongo.js (creds, signal keys, owner, settings) — this
        // runs from the orchestrator, which is the only side guaranteed to
        // execute on both a real logout AND an explicit .delsession/kill,
        // since the child process may be terminated before it gets a
        // chance to clean up its own Mongo data itself.
        await Promise.all([
            database.collection('sessions').deleteOne({ sessionId }),
            database.collection('auth_creds').deleteOne({ sessionId }),
            database.collection('auth_keys').deleteMany({ sessionId }),
            database.collection('session_owner').deleteOne({ sessionId }),
            database.collection('session_settings').deleteMany({ sessionId }),
        ]);
        return true;
    } catch (e) {
        log(`deleteSession(${sessionId}) failed:`, e.message);
        return false;
    }
}

// Requirement #77 — unique index on sessionId already enforces no duplicate
// IDs at the storage layer; this just surfaces a friendly check for callers.
export async function sessionExists(sessionId) {
    const database = await connect();
    if (!database) return null; // unknown — caller should fall back to JSON registry
    try {
        const doc = await database.collection('sessions').findOne({ sessionId }, { projection: { _id: 1 } });
        return Boolean(doc);
    } catch (e) {
        log(`sessionExists(${sessionId}) failed:`, e.message);
        return null;
    }
}

// Only status/list style projection — never pulls credentials in bulk.
export async function listSessions() {
    const database = await connect();
    if (!database) return null;
    try {
        return await database.collection('sessions')
            .find({}, { projection: { credentials: 0 } })
            .toArray();
    } catch (e) {
        log('listSessions failed:', e.message);
        return null;
    }
}

// Session ids to resume after a restart/redeploy. On Heroku's ephemeral
// disk sessions/registry.json is gone, so MongoDB is the source of truth;
// only sessions that actually finished linking (status READY) are resumed,
// never half-paired leftovers.
export async function listResumableSessionIds() {
    const database = await connect();
    if (!database) return null;
    try {
        const docs = await database.collection('sessions')
            .find({ status: 'READY' }, { projection: { sessionId: 1 } })
            .toArray();
        return docs.map((d) => d.sessionId).filter(Boolean);
    } catch (e) {
        log('listResumableSessionIds failed:', e.message);
        return null;
    }
}

export function health() {
    return { enabled: isEnabled(), connected: Boolean(db), lastError: lastConnectError };
}

// ------------------------------------------------------------------
// One-time, idempotent JSON -> MongoDB migration (requirement #11/#55).
// Safe to call on every boot: upsert is a no-op for docs that already
// match, and it never deletes the JSON file — the JSON registry stays
// as a fallback/cache, MongoDB just becomes the primary read path once
// this has run.
// ------------------------------------------------------------------
export async function migrateJsonRegistry(registryFile) {
    if (!isEnabled()) return { migrated: 0, skipped: true };
    if (!fs.existsSync(registryFile)) return { migrated: 0, skipped: true };
    let reg;
    try { reg = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { return { migrated: 0, skipped: true }; }
    const entries = Object.entries(reg.sessions || {});
    let migrated = 0;
    for (const [sessionId, data] of entries) {
        const ok = await upsertSession(sessionId, {
            phone: data.phone || null,
            ownerId: data.ownerJid || null,
            requestedBy: data.requestedBy || null,
            connectedAt: data.connectedAt ? new Date(data.connectedAt) : undefined,
            status: 'READY', // last known state before this boot; orchestrator corrects it on actual reconnect
            source: 'json-migration',
        });
        if (ok) migrated++;
    }
    if (migrated) log(`migrated ${migrated}/${entries.length} session(s) from ${path.basename(registryFile)} into MongoDB`);
    return { migrated, total: entries.length, skipped: false };
}
