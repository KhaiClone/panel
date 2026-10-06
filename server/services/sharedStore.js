const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");

// ─────────────────────────────────────────────────────────────────────────────
//  Shared data — collections that a project (bot) and the panel both use, kept
//  HERE so the bot calls the panel and the panel never has to call the bot.
//
//  A bot keeps its QuickDB API (find / create / findOneAndUpdate …): its
//  extensions/QuickDB.js routes the names listed in PANEL_SHARED to
//  /api/external/data, everything else stays in its own json.sqlite.
//
//  Each name is declared by the admin for ONE project ("pending"), then adopted
//  by that project the first time it starts with the shared-data library: it
//  uploads its local copy once and the name becomes "active". Only the owner's
//  key (and the panel itself) can read or write it.
//
//  Storage: data/shared.sqlite, one row per record (never the whole array
//  rewritten per write, unlike quick.db), plus key/value rows for plain values
//  such as the shop's nextOrderId counter. The same file holds the Discord bus
//  outbox (services/discordBus.js). It travels with a panel move.
// ─────────────────────────────────────────────────────────────────────────────

const DB_PATH = () => process.env.SHARED_DB_PATH || path.join(__dirname, "../../data/shared.sqlite");

const events = new EventEmitter(); // "change" (name) after every write

let conn = null;
const raw = () => {
    if (conn) return conn;
    fs.mkdirSync(path.dirname(DB_PATH()), { recursive: true });
    conn = new Database(DB_PATH());
    conn.pragma("journal_mode = WAL");
    conn.exec(`
        CREATE TABLE IF NOT EXISTS names (
            name TEXT PRIMARY KEY,
            kind TEXT NOT NULL,            -- "collection" | "value"
            owner TEXT NOT NULL,           -- project (bot record) _id
            state TEXT NOT NULL,           -- "pending" | "active"
            created_at INTEGER NOT NULL,
            adopted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS docs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            doc TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS docs_by_name ON docs(name, seq);
        CREATE TABLE IF NOT EXISTS kv (
            name TEXT PRIMARY KEY,
            value TEXT
        );

        -- Left by the message-template system (Embeds page), removed 2026-10-06.
        -- Nothing creates them any more; this also clears a copy restored from
        -- an older backup or brought by a panel move.
        DROP TABLE IF EXISTS ui_catalog;
        DROP TABLE IF EXISTS ui_overrides;
        DROP TABLE IF EXISTS ui_posted;
        DELETE FROM kv WHERE name IN ('__ui.version', '__ui.custom');
    `);
    return conn;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Names ────────────────────────────────────────────────────────────────────

const nameRow = (name) => raw().prepare("SELECT * FROM names WHERE name = ?").get(name) || null;
const listNames = () => raw().prepare("SELECT * FROM names ORDER BY name").all();
const namesOf = (owner) => raw().prepare("SELECT * FROM names WHERE owner = ? ORDER BY name").all(owner);

const VALID_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Admin: reserve `name` for project `owner` until it adopts it. */
const declare = (name, kind, owner) => {
    if (!VALID_NAME.test(String(name))) throw httpError(400, `Invalid name "${name}"`);
    if (!["collection", "value"].includes(kind)) throw httpError(400, 'kind must be "collection" or "value"');
    const row = nameRow(name);
    if (row?.state === "active" && row.owner !== owner) throw httpError(409, `"${name}" already belongs to another project`);
    if (row?.state === "active") return row;
    raw()
        .prepare(
            "INSERT INTO names (name, kind, owner, state, created_at) VALUES (?, ?, ?, 'pending', ?) " +
                "ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, owner = excluded.owner",
        )
        .run(name, kind, owner, Date.now());
    return nameRow(name);
};

/**
 * The owner uploads its local copy once. Refused for anyone but the declared
 * owner; a second adopt (the bot restarting) is a no-op.
 * → { adopted: bool, count }
 */
const adopt = (name, owner, value) => {
    const row = nameRow(name);
    if (!row || row.owner !== owner) throw httpError(403, `"${name}" is not declared for this project`);
    if (row.state === "active") return { adopted: false, count: null };
    const db = raw();
    db.transaction(() => {
        if (row.kind === "collection") {
            if (value != null && !Array.isArray(value)) throw httpError(400, `"${name}" is a collection — send an array`);
            db.prepare("DELETE FROM docs WHERE name = ?").run(name);
            const ins = db.prepare("INSERT INTO docs (name, doc) VALUES (?, ?)");
            for (const item of value || []) ins.run(name, JSON.stringify(item));
        } else {
            db.prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value ?? null));
        }
        db.prepare("UPDATE names SET state = 'active', adopted_at = ? WHERE name = ?").run(Date.now(), name);
    })();
    events.emit("change", name);
    return { adopted: true, count: row.kind === "collection" ? (value || []).length : null };
};

/** The name, active, owned by `owner` (null owner = the panel itself, always allowed). */
const assertAccess = (name, owner) => {
    const row = nameRow(name);
    if (!row) throw httpError(404, `"${name}" is not shared data`);
    if (owner != null && row.owner !== owner) throw httpError(403, `"${name}" belongs to another project`);
    if (row.state !== "active") throw httpError(409, `"${name}" has not been adopted by its project yet`);
    return row;
};

// ── Collections (same semantics as QuickDBExtension) ─────────────────────────

const matches = (e, query = {}) => {
    for (const key in query) if (e?.[key] !== query[key]) return false;
    return true;
};
const rows = (name) =>
    raw()
        .prepare("SELECT seq, doc FROM docs WHERE name = ? ORDER BY seq")
        .all(name)
        .map((r) => ({ seq: r.seq, doc: JSON.parse(r.doc) }));
const all = (name) => rows(name).map((r) => r.doc);

const insert = (name, items) => {
    const ins = raw().prepare("INSERT INTO docs (name, doc) VALUES (?, ?)");
    for (const item of items) ins.run(name, JSON.stringify(item));
};

const write = (name, fn) => {
    const out = raw().transaction(fn)();
    events.emit("change", name);
    return out;
};

const collectionOps = {
    get: (name) => all(name),
    find: (name, { query } = {}) => all(name).filter((e) => matches(e, query)),
    findOne: (name, { query } = {}) => all(name).find((e) => matches(e, query)) ?? null,
    create: (name, { data }) =>
        write(name, () => {
            const doc = { ...(data || {}), _id: nanoid(24) };
            insert(name, [doc]);
            return doc;
        }),
    createMany: (name, { items }) =>
        write(name, () => {
            const docs = (items || []).map((e) => ({ ...e, _id: nanoid(24) }));
            insert(name, docs);
            return docs;
        }),
    push: (name, { items }) =>
        write(name, () => {
            insert(name, items || []);
            return all(name);
        }),
    set: (name, { value }) =>
        write(name, () => {
            if (!Array.isArray(value)) throw httpError(400, `"${name}" is a collection — set it to an array`);
            raw().prepare("DELETE FROM docs WHERE name = ?").run(name);
            insert(name, value);
            return value;
        }),
    findOneAndUpdate: (name, { query, data }) =>
        write(name, () => {
            if (data?._id) throw httpError(400, "You can't change _id");
            const hit = rows(name).find((r) => matches(r.doc, query));
            if (!hit) return null;
            const next = { ...hit.doc, ...data };
            raw().prepare("UPDATE docs SET doc = ? WHERE seq = ?").run(JSON.stringify(next), hit.seq);
            return next;
        }),
    updateMany: (name, { query, data }) =>
        write(name, () => {
            if (data?._id) throw httpError(400, "You can't change _id");
            // Same as the panel's QuickDB.updateMany: an array value means "any of".
            const hit = (e) =>
                Object.keys(query || {}).every((k) => (Array.isArray(query[k]) ? query[k].includes(e?.[k]) : e?.[k] === query[k]));
            const upd = raw().prepare("UPDATE docs SET doc = ? WHERE seq = ?");
            const records = [];
            for (const r of rows(name)) {
                if (!hit(r.doc)) continue;
                const next = { ...r.doc, ...data };
                upd.run(JSON.stringify(next), r.seq);
                records.push(next);
            }
            return { count: records.length, records };
        }),
    findOneAndDelete: (name, { query }) =>
        write(name, () => {
            const hit = rows(name).find((r) => matches(r.doc, query));
            if (!hit) return null;
            raw().prepare("DELETE FROM docs WHERE seq = ?").run(hit.seq);
            return hit.doc;
        }),
    deleteMany: (name, { query }) =>
        write(name, () => {
            const del = raw().prepare("DELETE FROM docs WHERE seq = ?");
            const gone = [];
            for (const r of rows(name)) {
                if (!matches(r.doc, query)) continue;
                del.run(r.seq);
                gone.push(r.doc);
            }
            return gone;
        }),
};

// ── Plain values (counters, flags) ───────────────────────────────────────────

const readValue = (name) => {
    const r = raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const valueOps = {
    get: (name) => readValue(name),
    set: (name, { value }) =>
        write(name, () => {
            raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value ?? null));
            return value ?? null;
        }),
    add: (name, { by }) =>
        write(name, () => {
            const n = Number(by);
            if (!Number.isFinite(n)) throw httpError(400, "add needs a number");
            const next = (Number(readValue(name)) || 0) + n;
            raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(next));
            return next;
        }),
    delete: (name) =>
        write(name, () => {
            raw().prepare("DELETE FROM kv WHERE name = ?").run(name);
            return true;
        }),
};

const READ_OPS = new Set(["get", "find", "findOne"]);

/**
 * Run one operation. owner = the calling project's _id (null = the panel).
 * Reads and writes are split so the HTTP layer can map them to GET / POST.
 */
const run = (name, op, args = {}, owner = null) => {
    const row = assertAccess(name, owner);
    const ops = row.kind === "collection" ? collectionOps : valueOps;
    if (!Object.prototype.hasOwnProperty.call(ops, op)) throw httpError(400, `"${op}" is not an operation on a ${row.kind}`);
    return ops[op](name, args);
};

/** Every name with its size (records, or 1 for a set value). */
const overview = () =>
    listNames().map((n) => ({
        ...n,
        count:
            n.kind === "collection"
                ? raw().prepare("SELECT COUNT(*) AS c FROM docs WHERE name = ?").get(n.name).c
                : raw().prepare("SELECT COUNT(*) AS c FROM kv WHERE name = ?").get(n.name).c,
    }));

/** Consistent copy of the whole file (SQLite online backup — safe while open). */
const backupTo = (dest) => raw().backup(dest);

const close = () => {
    if (conn) conn.close();
    conn = null;
};

module.exports = {
    DB_PATH,
    events,
    raw,
    declare,
    adopt,
    listNames,
    overview,
    namesOf,
    nameRow,
    run,
    READ_OPS,
    backupTo,
    close,
};
