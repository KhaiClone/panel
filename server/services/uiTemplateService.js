const db = require("../db");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const T = require("../../bot-lib/uiTemplate");

// ─────────────────────────────────────────────────────────────────────────────
//  Message templates — the Embeds page.
//
//  Every bot that uses bot-lib/MessageTemplates.js uploads its CATALOG on start
//  (each message it can send: key, group, variables, default) and polls for
//  OVERRIDES — only what the admin changed lives here. The panel also keeps the
//  admin's own variables ({custom.*}, given to every template) and the list of
//  panels each bot posted, so the page can ask the bot (Discord bus, "ui.refresh"
//  / "ui.adopt") to re-render them.
//
//  Storage: data/shared.sqlite (travels with a panel move, in the hourly backup).
//  Every change bumps one version number; a bot's poll answers "unchanged"
//  until it moves.
// ─────────────────────────────────────────────────────────────────────────────

const httpError = (status, message) => Object.assign(new Error(message), { status });
const KEY_RE = /^[a-z0-9][a-z0-9_.-]{2,79}$/i;
const CUSTOM_RE = /^[A-Za-z_]\w{0,40}$/;

let ready = false;
const raw = () => {
    const c = sharedStore.raw();
    if (!ready) {
        c.exec(`
            CREATE TABLE IF NOT EXISTS ui_catalog (
                bot_id TEXT PRIMARY KEY,
                hash TEXT,
                catalog TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ui_overrides (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ui_posted (
                bot_id TEXT PRIMARY KEY,
                posted TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        ready = true;
    }
    return c;
};

const kvGet = (name, fallback) => {
    const r = raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : fallback;
};
const kvSet = (name, value) => raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const version = () => kvGet("__ui.version", 0);
const bump = () => {
    const v = version() + 1;
    kvSet("__ui.version", v);
    return v;
};
const custom = () => kvGet("__ui.custom", {});

const catalogs = () =>
    raw()
        .prepare("SELECT * FROM ui_catalog")
        .all()
        .map((r) => ({ botId: r.bot_id, hash: r.hash, updatedAt: r.updated_at, ...JSON.parse(r.catalog) }));
const catalogOf = (botId) => catalogs().find((c) => c.botId === botId) || null;

/** The catalog entry of a key → { botId, def, types } or null. */
const findKey = (key) => {
    for (const c of catalogs()) if (c.templates?.[key]) return { botId: c.botId, def: c.templates[key], types: c.types || {}, globals: c.globals || {} };
    return null;
};

const overrides = () => {
    const out = {};
    for (const r of raw().prepare("SELECT key, value, updated_at FROM ui_overrides").all()) out[r.key] = { value: JSON.parse(r.value), updatedAt: r.updated_at };
    return out;
};

// ── Bots ─────────────────────────────────────────────────────────────────────

/** A bot announces every template it has. Keys are global: a key another bot owns is refused. */
const saveCatalog = (botId, body = {}) => {
    const templates = body.templates;
    if (!templates || typeof templates !== "object" || Array.isArray(templates)) throw httpError(400, "templates is required");
    const others = new Map();
    for (const c of catalogs()) if (c.botId !== botId) for (const k of Object.keys(c.templates || {})) others.set(k, c.botId);
    for (const [key, def] of Object.entries(templates)) {
        if (!KEY_RE.test(key)) throw httpError(400, `Invalid template key "${key}"`);
        if (others.has(key)) throw httpError(409, `Template "${key}" already belongs to another project`);
        if (!["message", "card"].includes(def?.kind)) throw httpError(400, `"${key}": kind must be message or card`);
    }
    const catalog = { types: body.types || {}, globals: body.globals || {}, templates };
    raw()
        .prepare("INSERT OR REPLACE INTO ui_catalog (bot_id, hash, catalog, updated_at) VALUES (?, ?, ?, ?)")
        .run(botId, String(body.hash || ""), JSON.stringify(catalog), Date.now());
    return { version: version(), count: Object.keys(templates).length };
};

/** A bot's poll: its overrides + the custom variables, or "unchanged". */
const forBot = (botId, { version: theirs, hash } = {}) => {
    const cat = catalogOf(botId);
    const needCatalog = !cat || (hash && cat.hash !== hash);
    const v = version();
    if (!needCatalog && Number(theirs) === v) return { version: v, unchanged: true };
    const all = overrides();
    const mine = {};
    for (const key of Object.keys(cat?.templates || {})) if (all[key]) mine[key] = all[key].value;
    return { version: v, needCatalog, overrides: mine, custom: custom() };
};

const savePosted = (botId, posted) => {
    if (!Array.isArray(posted)) throw httpError(400, "posted must be an array");
    const clean = posted
        .filter((p) => p && p.key && p.channelId && p.messageId)
        .slice(0, 500)
        .map((p) => ({ key: String(p.key), guildId: p.guildId ? String(p.guildId) : null, channelId: String(p.channelId), messageId: String(p.messageId), at: p.at || null }));
    raw()
        .prepare("INSERT OR REPLACE INTO ui_posted (bot_id, posted, updated_at) VALUES (?, ?, ?)")
        .run(botId, JSON.stringify(clean), Date.now());
    return { saved: clean.length };
};

// ── The Embeds page ──────────────────────────────────────────────────────────

const overview = async () => {
    const bots = (await db.get("bots")) || [];
    const names = new Map(bots.map((b) => [b._id, b.name]));
    const posted = {};
    for (const r of raw().prepare("SELECT * FROM ui_posted").all()) posted[r.bot_id] = JSON.parse(r.posted);
    return {
        version: version(),
        projects: catalogs().map((c) => ({
            botId: c.botId,
            name: names.get(c.botId) || c.botId,
            updatedAt: c.updatedAt,
            canRefresh: discordBus.canHandle(c.botId, "ui.refresh"),
            types: c.types || {},
            globals: c.globals || {},
            templates: c.templates || {},
        })),
        overrides: overrides(),
        custom: custom(),
        posted,
    };
};

/** Problems that block saving (does not parse) + warnings (the preview data breaks a limit). */
const checkValue = (found, value) => {
    const { def, types, globals } = found;
    if (def.kind === "card") return { errors: T.checkCard(value), warnings: [] };
    const errors = T.checkMessage(value);
    if (errors.length) return { errors, warnings: [] };
    const present = {};
    for (const slot of Object.keys(def.slots || {})) present[slot] = { customId: `preview:${slot}` };
    let warnings = [];
    try {
        const msg = T.renderMessage(value, T.buildSample(def, types, custom(), globals), { slots: def.slots || {}, present });
        warnings = T.validateMessage(msg, { allowEmpty: !!def.allowEmpty });
    } catch (e) {
        return { errors: [e.message], warnings: [] };
    }
    return { errors: [], warnings };
};

const setOverride = (key, value) => {
    const found = findKey(key);
    if (!found) throw httpError(404, `No template "${key}" — is its bot running the template library?`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "value must be an object");
    const { errors, warnings } = checkValue(found, value);
    if (errors.length) throw Object.assign(httpError(400, errors[0]), { errors });
    if (found.def.kind === "message" && warnings.some((w) => w.startsWith("Tin nhắn trống"))) {
        throw Object.assign(httpError(400, warnings[0]), { errors: warnings });
    }
    raw().prepare("INSERT OR REPLACE INTO ui_overrides (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), Date.now());
    return { version: bump(), warnings };
};

const resetOverride = (key) => {
    raw().prepare("DELETE FROM ui_overrides WHERE key = ?").run(key);
    return { version: bump() };
};

/** Check without saving (the editor shows errors and warnings as you type). */
const check = (key, value) => {
    const found = findKey(key);
    if (!found) throw httpError(404, `No template "${key}"`);
    return checkValue(found, value);
};

const setCustom = (vars) => {
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw httpError(400, "vars must be an object");
    const clean = {};
    for (const [k, v] of Object.entries(vars)) {
        if (!CUSTOM_RE.test(k)) throw httpError(400, `Invalid variable name "${k}" (letters, digits, _)`);
        const s = String(v ?? "");
        if (s.length > 2000) throw httpError(400, `"${k}" is longer than 2000 characters`);
        clean[k] = s;
    }
    kvSet("__ui.custom", clean);
    return { version: bump(), custom: clean };
};

// ── Posted panels ────────────────────────────────────────────────────────────

/** Ask each bot (or one) to re-render its posted panels — all, or those of `keys`. */
const refreshPosted = async ({ botId, keys } = {}) => {
    const targets = botId ? [botId] : raw().prepare("SELECT bot_id FROM ui_posted").all().map((r) => r.bot_id);
    const results = [];
    for (const id of targets) {
        if (!discordBus.canHandle(id, "ui.refresh")) {
            results.push({ botId: id, error: "This bot has not announced ui.refresh on the Discord bus" });
            continue;
        }
        try {
            results.push({ botId: id, ...(await discordBus.request(id, "ui.refresh", { keys: keys || null }, { timeoutMs: 90_000 })) });
        } catch (e) {
            results.push({ botId: id, error: e.message });
        }
    }
    return { results };
};

const LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

/** Track a panel posted before the template library existed, by its message link. */
const adopt = async ({ key, link } = {}) => {
    const found = findKey(String(key || ""));
    if (!found) throw httpError(404, `No template "${key}"`);
    if (!found.def.refreshable) throw httpError(400, "This template is not a posted panel");
    const m = LINK.exec(String(link || ""));
    if (!m) throw httpError(400, "Paste a message link (Copy Message Link)");
    if (!discordBus.canHandle(found.botId, "ui.adopt")) throw httpError(503, "This bot has not announced ui.adopt on the Discord bus");
    return discordBus.request(found.botId, "ui.adopt", { key, guildId: m[1], channelId: m[2], messageId: m[3] }, { timeoutMs: 45_000 });
};

module.exports = {
    saveCatalog,
    forBot,
    savePosted,
    overview,
    setOverride,
    resetOverride,
    check,
    setCustom,
    refreshPosted,
    adopt,
    version,
};
