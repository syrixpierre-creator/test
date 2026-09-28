// One place that decides which MongoDB connection string to use, shared by
// the orchestrator (mongoStore.js) and every session process
// (sessionMongo.js). Tolerant on purpose: Heroku config vars are often typed
// with a different name, pasted with quotes, or with stray spaces.
const NAMES = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGODB_ATLAS_URI', 'DATABASE_URL'];

export function resolveMongoUri(env = process.env) {
    for (const name of NAMES) {
        const v = String(env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim();
        if (/^mongodb(\+srv)?:\/\//i.test(v)) return v;
    }
    return '';
}

export function resolveMongoDbName(env = process.env) {
    return String(env.MONGODB_DB || env.MONGO_DB || 'queen_akuma').trim() || 'queen_akuma';
}

// Human-readable reason when persistence is off, for the boot log.
export function explainMissingMongo(env = process.env) {
    const raw = NAMES.map((n) => [n, String(env[n] || '').trim()]).find(([, v]) => v);
    if (!raw) return 'no MONGODB_URI config var found';
    if (/<password>|<db_password>/i.test(raw[1])) return `${raw[0]} still contains the "<password>" placeholder`;
    return `${raw[0]} is set but does not start with mongodb:// or mongodb+srv://`;
}
