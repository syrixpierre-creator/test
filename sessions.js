// ============================================================
//  QUEEN AKUMA V4 — MULTI-SESSION ORCHESTRATOR (single deployment)
// ============================================================
//  This is now the ONE thing you deploy — the Procfile and `npm start`
//  point here, not at index.js. It hosts several independent WhatsApp
//  numbers from a single process/port, the same way as inconnu xd: no
//  SESSION_ID, no separate pairing site, nothing to paste into an env
//  var. Open the deployment's URL, enter a phone number, get a pairing
//  code, done — exactly like the web UI in public/index.html.
//
//  Each session is a completely separate `index.js` child process (its
//  own connection, its own owner, its own prefix/settings/moderation
//  state) — nothing in the existing single-session codebase had to
//  change to make that safe; it works because every data file Queen
//  Akuma reads/writes is a relative path, and each session's process
//  gets its own working directory:
//
//      ./sessions/<id>/session/          Baileys creds
//      ./sessions/<id>/owner.json        that session's own owner
//      ./sessions/<id>/data/...          its own settings, AFK, warns, etc.
//
//  The one exception is "default": if this deployment is an upgrade from
//  an old single-session install (a ./session/creds.json already exists
//  at the repo root, or SESSION_ID is still set), that account keeps
//  using the repo root itself as its working directory — nothing moves,
//  nothing needs re-pairing. A brand-new deployment has no "default": it
//  just serves the pairing page below and waits for the first session to
//  be paired.
//
//  New sessions are added three ways:
//    1) The pairing page this file serves at / (POST /api/pair) — the
//       normal way to add the very first session, and any session after
//       it, on any host (Pterodactyl, Render, Railway, ...).
//    2) From WhatsApp itself: the bot owner of ANY running session sends
//       ".linkme <phone>" — that command asks this orchestrator (over IPC)
//       to spin up a new session and DMs back the pairing code.
//    3) By restarting: every session that has ever successfully connected
//       is remembered in ./sessions/registry.json and auto-resumed on the
//       next boot.
// ============================================================

import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mongoStore from './lib/mongoStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const INDEX_JS = path.join(ROOT_DIR, 'index.js');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const REGISTRY_FILE = path.join(SESSIONS_DIR, 'registry.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// How many sessions are allowed to start/reconnect at the same instant.
// Req #25/#26/#27 — never let 100 sessions hammer WhatsApp/Mongo at once
// on boot or after a mass-reconnect event.
const SESSION_START_CONCURRENCY = Math.max(1, Number(process.env.SESSION_START_CONCURRENCY) || 3);

// Simple FIFO queue that only ever lets SESSION_START_CONCURRENCY session
// starts run concurrently — used for both initial boot and any bulk resume.
const startQueue = [];
let startQueueActive = 0;
function enqueueStart(fn) {
    startQueue.push(fn);
    pumpStartQueue();
}
function pumpStartQueue() {
    while (startQueueActive < SESSION_START_CONCURRENCY && startQueue.length) {
        const fn = startQueue.shift();
        startQueueActive++;
        Promise.resolve().then(fn).finally(() => {
            startQueueActive--;
            pumpStartQueue();
        });
    }
}

function loadRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch { return { sessions: {} }; }
}
function saveRegistry(reg) {
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2)); } catch (e) { console.error('[sessions] failed to save registry:', e.message); }
}

function sanitizeId(phone) {
    return String(phone).replace(/[^0-9]/g, '');
}

// True if this deployment already has an existing single-session account
// at the repo root (pre-orchestrator install, or SESSION_ID still set) —
// used by boot() to decide whether "default" auto-starts or the deployment
// starts empty and waits for the pairing page.
function hasExistingDefaultSession() {
    if (process.env.SESSION_ID) return true;
    try {
        if (fs.existsSync('./session_id.txt') && fs.readFileSync('./session_id.txt', 'utf8').trim()) return true;
    } catch {}
    try {
        return fs.existsSync(path.join(ROOT_DIR, 'session', 'creds.json'));
    } catch { return false; }
}

// id -> { child, status: 'starting'|'pairing'|'connected'|'stopped', phone, pairingCode, ownerJid, isDefault, pluginCount }
const runtime = new Map();

function sessionDir(id) {
    return id === 'default' ? ROOT_DIR : path.join(SESSIONS_DIR, id);
}

function log(...args) {
    console.log(`[orchestrator]`, ...args);
}

function startChildProcess(id, { pairPhone } = {}) {
    const cwd = sessionDir(id);
    if (id !== 'default' && !fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    // This orchestrator owns the one HTTP port (pairing page + /health);
    // no child ever runs its own web server, "default" included.
    const env = { ...process.env, SESSION_LABEL: id, NO_WEB_SERVER: 'true' };
    if (pairPhone) env.PAIR_PHONE = pairPhone;

    const child = fork(INDEX_JS, [], { cwd, env, stdio: 'inherit' });
    const entry = runtime.get(id) || {};
    entry.child = child;
    entry.status = 'starting';
    entry.state = 'STARTING';
    entry.isDefault = id === 'default';
    if (pairPhone) entry.phone = pairPhone;
    runtime.set(id, entry);

    child.on('message', (msg) => handleChildMessage(id, msg));
    child.on('exit', (code, signal) => {
        log(`[SESSION:${id}] exited (code=${code} signal=${signal})`);
        const e = runtime.get(id);
        if (!e || e.status === 'removing') { runtime.delete(id); return; }
        e.status = 'stopped';
        e.state = 'RECONNECTING';
        // Auto-restart crashed/killed sessions (transient host issues,
        // OOM, etc.) — same resilience the single-session bot already had
        // via its own internal reconnect loop, one layer up. Exponential
        // backoff + jitter (req #15/#27) so a session that keeps crashing
        // doesn't hammer the host or WhatsApp every 5s forever, and mass
        // crashes (e.g. a bad deploy) don't all retry in the same instant.
        e.restartAttempts = (e.restartAttempts || 0) + 1;
        const base = Math.min(5000 * Math.pow(2, e.restartAttempts - 1), 120000);
        const jitter = Math.floor(Math.random() * 1000);
        setTimeout(() => {
            if (runtime.get(id)?.status === 'stopped') {
                log(`[SESSION:${id}] restarting (attempt ${e.restartAttempts})...`);
                enqueueStart(() => startChildProcess(id));
            }
        }, base + jitter);
    });

    return child;
}

function handleChildMessage(id, msg) {
    if (!msg || !msg.type) return;
    const entry = runtime.get(id);

    switch (msg.type) {
        case 'session-pairing-code': {
            if (entry) { entry.status = 'pairing'; entry.pairingCode = msg.pairingCode; entry.phone = msg.phone; }
            log(`session "${id}" pairing code: ${msg.pairingCode}`);
            resolvePendingPair(id, { ok: true, sessionId: id, pairingCode: msg.pairingCode, phone: msg.phone });
            resolveHttpPair(id, { pairingCode: msg.pairingCode, sessionId: id, phone: msg.phone });
            break;
        }
        case 'session-connected': {
            if (entry) {
                entry.status = 'connected';
                entry.ownerJid = msg.ownerJid;
                entry.ownerNumber = msg.ownerNumber;
                entry.pluginCount = msg.pluginCount || 0;
                entry.restartAttempts = 0; // healthy connection — reset backoff (req: don't punish a session forever for one bad stretch)
            }
            const reg = loadRegistry();
            reg.sessions[id] = { phone: entry?.phone || msg.ownerNumber, ownerJid: msg.ownerJid, requestedBy: entry?.requestedBy || null, connectedAt: new Date().toISOString() };
            saveRegistry(reg);
            mongoStore.upsertSession(id, {
                phone: entry?.phone || msg.ownerNumber,
                ownerId: msg.ownerJid,
                requestedBy: entry?.requestedBy || null,
                status: 'READY',
                lastConnectedAt: new Date(),
            }).catch(() => {});
            log(`[SESSION:${id}] connected as +${msg.ownerNumber}`);
            resolveHttpPair(id, { alreadyLinked: true, sessionId: id });
            break;
        }
        case 'session-logged-out': {
            log(`[SESSION:${id}] logged out — removing.`);
            removeSession(id, { keepDefault: true });
            break;
        }
        // Req #20 — session reports its own progress past the pre-restart
        // backlog so the checkpoint survives this process too.
        case 'checkpoint': {
            mongoStore.saveCheckpoint(id, {
                lastProcessedMessageId: msg.lastProcessedMessageId,
                lastProcessedMessageTimestamp: msg.lastProcessedMessageTimestamp,
            }).catch(() => {});
            break;
        }
        // Explicit session state machine (req #5): SYNCING while the
        // post-connect backlog-protection grace window is active, READY
        // once it's over and live messages are actually being dispatched.
        case 'session-syncing': {
            if (entry) entry.state = 'SYNCING';
            break;
        }
        case 'session-ready': {
            if (entry) entry.state = 'READY';
            break;
        }
        // Requests FROM a running session's ".pair" / ".sessions" /
        // ".delsession" commands, relayed here over that session's own
        // IPC channel (see index.js requestOrchestrator()).
        case 'pair': {
            handlePairRequest(id, msg);
            break;
        }
        case 'sessions-list': {
            const list = Array.from(runtime.entries()).map(([sid, e]) => ({
                id: sid, status: e.status, phone: e.phone || null, ownerNumber: e.ownerNumber || null, isDefault: !!e.isDefault, requestedBy: e.requestedBy || null
            }));
            entry?.child?.send({ reqId: msg.reqId, ok: true, sessions: list });
            break;
        }
        case 'delsession': {
            const targetId = msg.sessionId;
            if (!targetId || targetId === 'default') {
                entry?.child?.send({ reqId: msg.reqId, ok: false, error: 'Cannot remove the default session this way.' });
                break;
            }
            if (!runtime.has(targetId)) {
                entry?.child?.send({ reqId: msg.reqId, ok: false, error: `No session "${targetId}".` });
                break;
            }
            removeSession(targetId);
            entry?.child?.send({ reqId: msg.reqId, ok: true, removed: targetId });
            break;
        }
    }
}

// requester session id -> { reqId, requesterId }, keyed by the NEW session's id
const pendingPairs = new Map();

function resolvePendingPair(newSessionId, result) {
    const pending = pendingPairs.get(newSessionId);
    if (!pending) return;
    pendingPairs.delete(newSessionId);
    const requester = runtime.get(pending.requesterId);
    requester?.child?.send({ reqId: pending.reqId, ...result });
}

const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) > 0 ? Number(process.env.MAX_SESSIONS) : 25;

// ============================================================
//  HTTP pairing (the web page below talks to this, not WhatsApp) — the
//  single-deployment replacement for the old separate session-generator
//  site. sessionId -> { resolve, reject }
// ============================================================
const httpPairWaiters = new Map();

function resolveHttpPair(sessionId, result) {
    const waiter = httpPairWaiters.get(sessionId);
    if (!waiter) return;
    httpPairWaiters.delete(sessionId);
    waiter.resolve(result);
}

function pairFromHttp(phoneRaw) {
    if (shuttingDown) return Promise.reject(new Error('Server is shutting down — try again in a moment.'));
    const phone = sanitizeId(phoneRaw || '');
    if (!phone || phone.length < 7) return Promise.reject(new Error('Enter a valid phone number with country code, digits only.'));

    const existing = runtime.get(phone);
    if (existing && existing.status === 'connected') return Promise.resolve({ alreadyLinked: true, sessionId: phone });
    if (existing && existing.status === 'pairing' && existing.pairingCode) return Promise.resolve({ pairingCode: existing.pairingCode, sessionId: phone });

    const activeCount = Array.from(runtime.values()).filter((e) => e.status !== 'stopped').length;
    if (!existing && activeCount >= MAX_SESSIONS) return Promise.reject(new Error(`Session limit reached (${MAX_SESSIONS}). Try again later.`));

    return new Promise((resolve, reject) => {
        httpPairWaiters.set(phone, { resolve, reject });
        startChildProcess(phone, { pairPhone: phone });
        setTimeout(() => {
            if (httpPairWaiters.has(phone)) {
                httpPairWaiters.delete(phone);
                reject(new Error('Timed out waiting for a pairing code — try again.'));
            }
        }, 30000);
    });
}

// Poll target for the page above: current state of one session, by phone/id.
function statusFor(sessionId) {
    const e = runtime.get(sessionId);
    if (!e) return { status: 'none' };
    return { status: e.status, phone: e.phone || null, pluginCount: e.pluginCount || 0 };
}

// Aggregate counts only — no phone numbers or session ids, safe for the public pairing page.
function getStats() {
    const all = Array.from(runtime.values());
    return { total: all.length, active: all.filter((e) => e.status === 'connected').length };
}

// Req #86 (production quality) — this function was called from /health and
// /api/sessions but never defined in the original file, so both endpoints
// threw a ReferenceError on every request. redact=true (used by the public
// /health endpoint) strips phone numbers/owner ids; the gated /api/sessions
// endpoint gets the full list.
function listSessions({ redact = false } = {}) {
    return Array.from(runtime.entries()).map(([id, e]) => {
        const base = { id, status: e.status, state: e.state || null, isDefault: !!e.isDefault };
        return redact ? base : { ...base, phone: e.phone || null, ownerNumber: e.ownerNumber || null, requestedBy: e.requestedBy || null };
    });
}

function handlePairRequest(requesterId, msg) {
    const requester = runtime.get(requesterId);
    const reply = (payload) => requester?.child?.send({ reqId: msg.reqId, ...payload });
    if (shuttingDown) { reply({ ok: false, error: 'Server is shutting down.' }); return; }

    const phone = sanitizeId(msg.phone || '');
    if (!phone || phone.length < 10) { reply({ ok: false, error: 'Invalid phone number.' }); return; }

    const newId = phone;
    if (runtime.has(newId) && runtime.get(newId).status !== 'stopped') {
        reply({ ok: false, error: `A session for +${phone} already exists (status: ${runtime.get(newId).status}).` });
        return;
    }
    const activeCount = Array.from(runtime.values()).filter((e) => e.status !== 'stopped').length;
    if (activeCount >= MAX_SESSIONS) { reply({ ok: false, error: `Session limit reached (${MAX_SESSIONS}).` }); return; }

    const entry = runtime.get(newId) || {};
    entry.requestedBy = msg.requestedBy || null;
    entry.requestedFromSession = requesterId;
    runtime.set(newId, entry);

    pendingPairs.set(newId, { reqId: msg.reqId, requesterId });
    startChildProcess(newId, { pairPhone: phone });

    // Safety timeout in case the pairing code never arrives (bad number, WA rate-limit, etc).
    setTimeout(() => {
        if (pendingPairs.has(newId)) {
            pendingPairs.delete(newId);
            reply({ ok: false, error: 'Timed out waiting for a pairing code — try again.' });
        }
    }, 30000);
}

function removeSession(id, { keepDefault = false } = {}) {
    if (id === 'default' && keepDefault) return; // default just reconnects itself, never deleted
    const entry = runtime.get(id);
    if (entry) {
        entry.status = 'removing';
        try { entry.child?.kill(); } catch {}
    }
    runtime.delete(id);
    if (id !== 'default') {
        try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch {}
    }
    const reg = loadRegistry();
    delete reg.sessions[id];
    saveRegistry(reg);
    mongoStore.deleteSession(id).catch(() => {});
}

// ============================================================
//  HTTP server — pairing page + status API. The only port this
//  deployment opens; every child session's own web server is disabled
//  (see startChildProcess above).
// ============================================================
async function startHttpServer() {
    const { default: express } = await import('express');
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(express.json());
    app.use(express.static(path.join(ROOT_DIR, 'public')));

    app.get('/health', (_req, res) => {
        const mem = process.memoryUsage();
        const all = Array.from(runtime.values());
        res.json({
            status: 'ok',
            bot: 'QUEEN AKUMA V4',
            uptime: process.uptime(),
            ...getStats(),
            sessionsByStatus: {
                connected: all.filter((e) => e.status === 'connected').length,
                starting: all.filter((e) => e.status === 'starting').length,
                pairing: all.filter((e) => e.status === 'pairing').length,
                stopped: all.filter((e) => e.status === 'stopped').length,
            },
            memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
            mongo: mongoStore.health(),
            sessions: listSessions({ redact: true }),
        });
    });
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

    app.get('/api/stats', (_req, res) => res.json(getStats()));

    // Request (or resume polling for) a pairing code for a phone number.
    app.post('/api/pair', async (req, res) => {
        try {
            const result = await pairFromHttp(req.body?.phone);
            res.json({ ok: true, ...result });
        } catch (err) {
            res.status(err.message?.startsWith('Session limit') ? 429 : 400).json({ ok: false, error: err.message });
        }
    });

    app.get('/api/status/:id', (req, res) => res.json(statusFor(sanitizeId(req.params.id))));

    // Admin: full session list (phone numbers included) — gate it behind
    // ADMIN_KEY if the deployer set one; open by default like the rest of
    // this file's IPC endpoints when they didn't.
    app.get('/api/sessions', (req, res) => {
        if (process.env.ADMIN_KEY && req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        res.json(listSessions());
    });

    app.listen(PORT, '0.0.0.0', () => log(`Pairing page listening on port ${PORT}`));
}

async function boot() {
    startHttpServer().catch((e) => log('HTTP server failed to start:', e.message));

    if (mongoStore.isEnabled()) {
        log(`MongoDB persistence enabled (SESSION_START_CONCURRENCY=${SESSION_START_CONCURRENCY}).`);
        // Idempotent — safe to run on every boot; never deletes the JSON
        // registry, just mirrors it into Mongo (req #11/#55).
        mongoStore.migrateJsonRegistry(REGISTRY_FILE).catch((e) => log('migration skipped:', e.message));
    }

    // Only auto-start "default" for an existing install (upgrade path) —
    // a brand-new deployment has nothing to auto-start and no SESSION_ID
    // to wait on; it just serves the pairing page above and waits for a
    // phone number.
    if (hasExistingDefaultSession()) {
        log('Existing session found at repo root — starting "default"...');
        enqueueStart(() => startChildProcess('default'));
    } else {
        log('No existing session and no SESSION_ID set — open this deployment\'s URL to pair the first number.');
    }

    const reg = loadRegistry();
    const extraIds = Object.keys(reg.sessions || {});
    if (extraIds.length) {
        log(`Resuming ${extraIds.length} saved session(s) — ${SESSION_START_CONCURRENCY} at a time: ${extraIds.join(', ')}`);
        // Req #25/#26 — bounded concurrency instead of a fixed serial
        // stagger, so this scales sanely whether it's 3 sessions or 100.
        extraIds.forEach((id) => enqueueStart(() => startChildProcess(id)));
    }
}

let shuttingDown = false;
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true; // req #24/#52 — stop accepting new pairing requests first
    log('Shutting down — no new sessions accepted, giving children time to close sockets/save creds...');
    for (const entry of runtime.values()) { try { entry.status = 'removing'; entry.child?.kill('SIGTERM'); } catch {} }
    setTimeout(() => process.exit(0), 5000);
}

boot();
