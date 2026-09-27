// ============================================================
//  QUEEN AKUMA V4 — owner.json <-> MongoDB mirror.
//
//  owner.json is small and changes rarely (new owner link, auto-join
//  marker), so unlike credentials it doesn't need a full custom Baileys
//  adapter — a simple "hydrate the local file from Mongo once at boot if
//  it's missing, then mirror every write back to Mongo" is enough and
//  keeps every existing fs.readFileSync/writeFileSync call in index.js
//  working completely unchanged.
// ============================================================

import fs from 'fs';
import { getDb, isEnabled } from './sessionMongo.js';

// Called once, very early at process start (before anything reads
// OWNER_FILE) — repopulates the local file from Mongo when the local
// disk is fresh (Heroku dyno restart/redeploy) so isFirstConnection
// detection and owner lookup both see the real, previously-linked owner
// instead of treating this as a brand new pairing.
export async function hydrateOwnerFromMongo(sessionId, ownerFilePath) {
    if (!isEnabled()) return;
    if (fs.existsSync(ownerFilePath)) return; // local copy already there — don't clobber it with a possibly-older Mongo snapshot
    try {
        const db = await getDb();
        if (!db) return;
        const doc = await db.collection('session_owner').findOne({ sessionId });
        if (doc?.data) fs.writeFileSync(ownerFilePath, JSON.stringify(doc.data, null, 2));
    } catch (e) { console.error('[mongo:owner] hydrate failed:', e.message); }
}

// Fire-and-forget mirror, called right after every local owner.json write.
export async function mirrorOwnerToMongo(sessionId, ownerFilePath) {
    if (!isEnabled()) return;
    try {
        const db = await getDb();
        if (!db) return;
        const data = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8'));
        await db.collection('session_owner').updateOne(
            { sessionId },
            { $set: { data, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) { console.error('[mongo:owner] mirror failed:', e.message); }
}
