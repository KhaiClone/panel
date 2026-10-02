const crypto = require("crypto");
const db = require("../db");
const agentCrypto = require("./agentCrypto");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  Per-project API keys for /api/external/*.
//
//  The shared PANEL_API_KEY says nothing about WHO is calling, so a callback
//  URL such as http://localhost:1942/api/quest-event could only be read as
//  "the panel's own machine" — wrong the moment the panel and that project
//  sit on different nodes. A project key names its project: the panel records
//  it as the owner of every callback registered with it, works out the address
//  from where that project runs at send time (callbackService), and signs the
//  callback with the same key, since the caller checks x-api-key against the
//  one value it holds.
//
//  Stored per key: sha256 for lookup, and the key itself AES-GCM-encrypted
//  with JWT_SECRET — needed to sign callbacks, and a leaked panel.sqlite alone
//  does not reveal it. (The hourly Discord backup carries .env too, so its
//  channel does — keep that channel private.)
//  Last use lives under its own DB key so a usage stamp can never overwrite a
//  concurrent revoke (quick.db rewrites a whole value per write).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "api_keys";
const USAGE_KEY = "api_key_usage";
const TOUCH_EVERY = 15 * 60 * 1000;

const hash = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
const secret = () => {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set — API keys cannot be stored");
    return process.env.JWT_SECRET;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

const all = async () => (await db.get(KEY)) || [];

const publicKey = (k, botNames, usage) => ({
    _id: k._id,
    botId: k.botId,
    botName: botNames.get(k.botId) || null,
    label: k.label,
    prefix: k.prefix,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt || null,
    lastUsedAt: usage[k._id] || null,
});

/** Every key (never the secret itself), newest first. */
const list = async () => {
    const bots = (await db.get("bots")) || [];
    const botNames = new Map(bots.map((b) => [b._id, b.name]));
    const usage = (await db.get(USAGE_KEY)) || {};
    return (await all())
        .map((k) => publicKey(k, botNames, usage))
        .sort((a, b) => b.createdAt - a.createdAt);
};

/** A new key for a project. The plaintext is returned ONCE, here. */
const create = async ({ botId, label } = {}) => {
    const bot = botId ? await db.findOne("bots", { _id: botId }) : null;
    if (!bot) throw httpError(404, "Project not found");
    const key = `pk_${crypto.randomBytes(24).toString("base64url")}`;
    const rec = {
        _id: crypto.randomBytes(12).toString("hex"),
        botId: bot._id,
        label: String(label || "").trim().slice(0, 60) || bot.name,
        prefix: key.slice(0, 9),
        hash: hash(key),
        enc: agentCrypto.encrypt(key, secret()),
        createdAt: Date.now(),
        revokedAt: null,
    };
    await db.set(KEY, [...(await all()), rec]);
    return { key, record: publicKey(rec, new Map([[bot._id, bot.name]]), {}) };
};

/** Revoke (kept for the record, never accepted again). */
const revoke = async (id) => {
    const keys = await all();
    const rec = keys.find((k) => k._id === id);
    if (!rec) throw httpError(404, "Key not found");
    if (!rec.revokedAt) {
        await db.set(KEY, keys.map((k) => (k._id === id ? { ...k, revokedAt: Date.now() } : k)));
    }
};

/** The active key record matching `key`, or null. */
const verify = async (key) => {
    if (typeof key !== "string" || !key.startsWith("pk_")) return null;
    const h = hash(key);
    return (await all()).find((k) => k.hash === h && !k.revokedAt) || null;
};

const lastTouch = new Map();
/** Stamp last use — at most every 15 minutes per key, and never while not active. */
const touch = (rec) => {
    const now = Date.now();
    if (!lifecycle.isActive() || now - (lastTouch.get(rec._id) || 0) < TOUCH_EVERY) return;
    lastTouch.set(rec._id, now);
    (async () => {
        const usage = (await db.get(USAGE_KEY)) || {};
        await db.set(USAGE_KEY, { ...usage, [rec._id]: now });
    })().catch(() => {});
};

/**
 * The key a callback to `botId` is signed with: its newest active key, or null
 * when it has none (the caller then gets the shared PANEL_API_KEY, as before).
 */
const keyFor = async (botId) => {
    if (!botId) return null;
    const rec = (await all())
        .filter((k) => k.botId === botId && !k.revokedAt)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!rec) return null;
    try {
        return agentCrypto.decrypt(rec.enc, secret());
    } catch (err) {
        console.error(`[ApiKeys] Key ${rec.prefix}… cannot be decrypted (JWT_SECRET changed?): ${err.message}`);
        return null;
    }
};

module.exports = { list, create, revoke, verify, touch, keyFor };
