// ============================================================
//  QUEEN AKUMA V4 — Baileys auth state backed by MongoDB.
//
//  Drop-in replacement for Baileys' own useMultiFileAuthState(), same
//  { state, saveCreds } shape, except creds and signal keys live in
//  MongoDB instead of local files. This is the piece that actually
//  survives Heroku's ephemeral disk: without it, a dyno restart wipes
//  ./session/*.json and the account has to be paired again from
//  scratch, no matter what else is persisted.
//
//  Not used at all when MONGODB_URI is unset — index.js falls back to
//  the original useMultiFileAuthState(SESSION_DIR) in that case.
// ============================================================

import { getDb } from './sessionMongo.js';

export async function useMongoAuthState(sessionId) {
    const db = await getDb();
    if (!db) return null; // caller falls back to local files

    const { initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys');
    const credsCol = db.collection('auth_creds');
    const keysCol = db.collection('auth_keys');

    const serialize = (data) => JSON.stringify(data, BufferJSON.replacer);
    const deserialize = (text) => JSON.parse(text, BufferJSON.reviver);

    const existing = await credsCol.findOne({ sessionId });
    const creds = existing ? deserialize(existing.data) : initAuthCreds();

    const saveCreds = async () => {
        try {
            await credsCol.updateOne(
                { sessionId },
                { $set: { data: serialize(creds), updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (e) { console.error('[mongo:auth] saveCreds failed:', e.message); }
    };

    const keys = {
        get: async (type, ids) => {
            const data = {};
            try {
                const docs = await keysCol.find({ sessionId, type, id: { $in: ids } }).toArray();
                const byId = new Map(docs.map((d) => [d.id, d.data]));
                for (const id of ids) {
                    if (!byId.has(id)) continue;
                    let value = deserialize(byId.get(id));
                    if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    data[id] = value;
                }
            } catch (e) { console.error(`[mongo:auth] keys.get(${type}) failed:`, e.message); }
            return data;
        },
        set: async (data) => {
            const ops = [];
            for (const type of Object.keys(data)) {
                for (const id of Object.keys(data[type])) {
                    const value = data[type][id];
                    ops.push(value
                        ? { updateOne: { filter: { sessionId, type, id }, update: { $set: { data: serialize(value), updatedAt: new Date() } }, upsert: true } }
                        : { deleteOne: { filter: { sessionId, type, id } } });
                }
            }
            if (!ops.length) return;
            try { await keysCol.bulkWrite(ops, { ordered: false }); }
            catch (e) { console.error('[mongo:auth] keys.set failed:', e.message); }
        },
    };

    return { state: { creds, keys }, saveCreds };
}

// Real logout / manual re-pair — wipe this session's credentials and keys
// from MongoDB too, not just the local ./session folder (see index.js
// cleanSession()). Settings and owner data are deliberately NOT touched
// here — a credential reset isn't the same as forgetting the bot's config.
export async function purgeAuthState(sessionId) {
    const db = await getDb();
    if (!db) return;
    try {
        await Promise.all([
            db.collection('auth_creds').deleteOne({ sessionId }),
            db.collection('auth_keys').deleteMany({ sessionId }),
        ]);
    } catch (e) { console.error('[mongo:auth] purge failed:', e.message); }
}
