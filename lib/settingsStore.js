import fs from 'fs';
import path from 'path';
import { currentDataDir } from './sessionContext.js';
import { getDb, isEnabled } from './sessionMongo.js';

// This process's session id (set by sessions.js when it forks a session's
// child process; 'default' for the single-session/standalone install).
// Used only as the MongoDB document key below — local file paths are
// still resolved the existing way, via currentDataDir()/sessionContext.js.
const sessionId = () => process.env.SESSION_LABEL || 'default';

// Resolved per call (not once at module load) so each session — sharing
// this one process — reads/writes its own data dir. See sessionContext.js.
function dataDir() { return currentDataDir(); }
function globalFile() { return path.join(dataDir(), 'settings.json'); }
function groupFile() { return path.join(dataDir(), 'group_settings.json'); }

function ensureDataDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  mirrorToMongo(file, data);
}

// Req: survive Heroku's ephemeral disk — mode/prefix/antilink/welcome/
// admins/AI settings etc. are mirrored to MongoDB on every write, keyed by
// this session's id + which file it came from ('global' or 'group'), and
// fire-and-forget so no command has to wait on a network round trip just
// to flip a setting.
function mirrorToMongo(file, data) {
  if (!isEnabled()) return;
  const kind = file === globalFile() ? 'global' : file === groupFile() ? 'group' : null;
  if (!kind) return;
  getDb().then((db) => {
    if (!db) return;
    return db.collection('session_settings').updateOne(
      { sessionId: sessionId(), kind },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
  }).catch((e) => console.error(`[mongo:settings] mirror(${kind}) failed:`, e.message));
}

// Called once, very early at process start — repopulates local
// settings.json/group_settings.json from MongoDB when the local disk is
// fresh (Heroku dyno restart/redeploy) so a previously-configured mode,
// prefix, antilink rules, admins etc. don't silently reset to defaults.
// Never overwrites a local file that already exists.
export async function hydrateSettingsFromMongo() {
  if (!isEnabled()) return;
  try {
    const db = await getDb();
    if (!db) return;
    const docs = await db.collection('session_settings').find({ sessionId: sessionId() }).toArray();
    for (const doc of docs) {
      const file = doc.kind === 'global' ? globalFile() : doc.kind === 'group' ? groupFile() : null;
      if (file && !fs.existsSync(file) && doc.data) writeJson(file, doc.data);
    }
  } catch (e) { console.error('[mongo:settings] hydrate failed:', e.message); }
}

const GLOBAL_DEFAULTS = {
  alwaysOnline: false,
  autoRead: false,
  autoTyping: false,
  autoRecording: false,
  antidelete: false,
  autobio: false,
  botMode: 'public',
  language: 'en',
  timezone: 'UTC',
  menuStyle: 1,
  menuFooter: 'ǫᴜᴇᴇɴ ᴀᴋᴜᴍᴀ ᴠ4',
  ownerName: 'INCONNU BOY SENSEI',
  vvEmoji: '👀',
  ghostArchive: false,
  replyFont: 'off',
  anticall: false,
  autoViewStatus: false,
  antivv: false,
  welcomeImage: false,
  mutedGroups: [],
  globalBlacklist: [],
  chatbotEnabled: false,
  autoReact: false
};

export function getGlobalSettings() {
  return { ...GLOBAL_DEFAULTS, ...readJson(globalFile(), {}) };
}

export function setGlobalSetting(key, value) {
  const current = getGlobalSettings();
  current[key] = value;
  writeJson(globalFile(), current);
  return current;
}

const DEFAULT_BADWORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'nigger', 'nigga', 'cunt', 'whore', 'slut', 'faggot', 'retard'];

const GROUP_DEFAULTS = {
  menuStyle: null, // null = no per-group override, falls back to the global .menustyle setting
  antilink: false,
  antilinkMode: 'invite', // 'invite' = only WhatsApp group invite links, 'all' = any link
  antibadword: false,
  badwords: DEFAULT_BADWORDS,
  antitag: false,
  antimention: false,
  antiforward: false,
  antisticker: false,
  antiimage: false,
  antivideo: false,
  antiaudio: false,
  lastActive: {},
  antidemote: false,
  antidemoteAction: 'demote', // 'demote' = warn + eventually kick actor, 'remove' = kick actor immediately
  antipromote: false,
  antipromoteAction: 'demote', // 'demote' = warn + eventually kick actor, 'remove' = kick actor + promoted user immediately
  antispam: false,
  antifake: false,
  autosavevcf: false,
  chatbotFullReply: false,
  groupEmoji: '',
  allowedCountryCodes: [],
  welcome: true,
  goodbye: true,
  welcomeText: '',
  goodbyeText: '',
  rules: '',
  warnings: {},
  actionWarnings: {}
};

function allGroupSettings() {
  return readJson(groupFile(), {});
}

export function getGroupSettings(groupJid) {
  const all = allGroupSettings();
  return { ...GROUP_DEFAULTS, ...(all[groupJid] || {}) };
}

export function setGroupSetting(groupJid, key, value) {
  const all = allGroupSettings();
  const current = { ...GROUP_DEFAULTS, ...(all[groupJid] || {}) };
  current[key] = value;
  all[groupJid] = current;
  writeJson(groupFile(), all);
  return current;
}

// Lightweight per-group last-seen tracker, written on every group text
// message. Deliberately cheap (one timestamp per user) — used by
// .inactivelist / .kickinactive to distinguish "genuinely inactive" from
// "we just don't have data yet" (the latter should never be treated as
// inactive, or a fresh bot install would consider everyone inactive).
export function recordActivity(groupJid, userJid) {
  const all = allGroupSettings();
  const current = { ...GROUP_DEFAULTS, ...(all[groupJid] || {}) };
  current.lastActive = { ...(current.lastActive || {}), [userJid]: Date.now() };
  all[groupJid] = current;
  writeJson(groupFile(), all);
}

export function addWarning(groupJid, userJid) {
  const settings = getGroupSettings(groupJid);
  const count = (settings.warnings[userJid] || 0) + 1;
  settings.warnings[userJid] = count;
  const all = allGroupSettings();
  all[groupJid] = settings;
  writeJson(groupFile(), all);
  return count;
}

export function resetWarning(groupJid, userJid) {
  const settings = getGroupSettings(groupJid);
  delete settings.warnings[userJid];
  const all = allGroupSettings();
  all[groupJid] = settings;
  writeJson(groupFile(), all);
}

export function addBadWord(groupJid, word) {
  const settings = getGroupSettings(groupJid);
  const w = word.toLowerCase().trim();
  if (!settings.badwords.includes(w)) settings.badwords.push(w);
  return setGroupSetting(groupJid, 'badwords', settings.badwords);
}

export function removeBadWord(groupJid, word) {
  const settings = getGroupSettings(groupJid);
  const w = word.toLowerCase().trim();
  const updated = settings.badwords.filter((x) => x !== w);
  return setGroupSetting(groupJid, 'badwords', updated);
}

// Separate warning track for automated anti-* protections (antidemote,
// antipromote, antispam) so they don't share a counter with manual .warn.
export function addActionWarning(groupJid, userJid, type) {
  const settings = getGroupSettings(groupJid);
  const key = `${type}:${userJid}`;
  const count = (settings.actionWarnings[key] || 0) + 1;
  settings.actionWarnings[key] = count;
  const all = allGroupSettings();
  all[groupJid] = settings;
  writeJson(groupFile(), all);
  return count;
}

export function resetActionWarning(groupJid, userJid, type) {
  const settings = getGroupSettings(groupJid);
  delete settings.actionWarnings[`${type}:${userJid}`];
  const all = allGroupSettings();
  all[groupJid] = settings;
  writeJson(groupFile(), all);
}
