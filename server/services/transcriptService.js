const crypto = require("crypto");
const { once } = require("events");
const db = require("../db");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const orderService = require("./orderService");

// ─────────────────────────────────────────────────────────────────────────────
//  Transcripts page — the shop's closed tickets, searchable, opened right in the
//  panel (user, 2026-11-02).
//
//  The files stay where they are: the shop bot saves every ticket in its
//  transcript channel (ArnTo-Shop functions/ticketArchive.js — the HTML gzipped
//  and cut into ≤18 MiB parts, or one .html for old tickets). The panel keeps
//  only the LIST — ticket, owner, reason, opened/closed, size; never the chat.
//  The bot sends it (POST /api/external/transcripts) when it starts, after each
//  ticket it saves and every 30 minutes, from just after the newest message the
//  panel already has (GET /state), so a list lost in a panel move fills itself
//  again.
//
//  Opening one goes over the Discord bus — the user's choice (2026-11-02) over
//  adding the panel's bot to the shop's server: "transcript.get" → that
//  message's attachment links, signed afresh (Discord's signature lives 24 h)
//  and SEALED, since everyone in the bus server can read the bus channel and the
//  links open a customer's chat. The panel streams the parts in order to the
//  browser as one gzip body (Content-Encoding: gzip): nothing is unpacked or
//  kept here, so a 100 MB transcript costs the panel no memory or disk.
//
//  The browser shows it in a sandbox: the page runs scripts (Discord's look,
//  from a CDN) and holds whatever customers typed, so it must never run as the
//  panel's origin, where it could read the login token. A frame cannot send the
//  login header either, so its URL carries a short-lived view ticket good for
//  that one transcript — never the login token, which the page could read from
//  its own address.
//
//  Storage: table `transcripts` in data/shared.sqlite, a copy of the channel the
//  bot rebuilds whenever it is missing. Owner = the first project to call the
//  external routes (like Forms); any other project is refused.
// ─────────────────────────────────────────────────────────────────────────────

const CMD = "transcript.get";
const OWNER = "__transcripts.owner";
const CHECKED = "__transcripts.checkedAt";
const SNOWFLAKE = /^\d{17,20}$/;
const NAME = /^[\w.-]{1,64}$/;
const KIND = /^([a-z]{1,16})-(\d{1,9})$/i; // "ticket-7149", "ctv-12"
const MAX_BATCH = 200;
const MAX_PARTS = 10; // a Discord message carries at most 10 files
const VIEW_TTL_MS = 15 * 60 * 1000;
const LINK_MARGIN_MS = 60 * 60 * 1000; // ask the bot again an hour before Discord's signature ends
const BUS_TIMEOUT_MS = 30_000;
// Discord's own attachment links only: the panel fetches these itself.
const CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d{17,20}\/\d{17,20}\/[^/?#]+(\?[^#]*)?$/;
// Scripts may run (Discord's look) but as no origin at all: no panel token, no panel API.
const SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Storage ──────────────────────────────────────────────────────────────────

const conn = () => {
    const c = sharedStore.raw();
    c.exec(`
        CREATE TABLE IF NOT EXISTS transcripts (
            message_id TEXT PRIMARY KEY,   -- the message in the bot's transcript channel
            name TEXT NOT NULL,            -- ticket-7149
            number INTEGER,
            kind TEXT NOT NULL,            -- ticket | ctv | …
            owner_id TEXT,
            owner_tag TEXT,
            channel_id TEXT,               -- the ticket's channel (gone now)
            ticket_ref TEXT,               -- the bot's ticket _id = orders.ticketId
            reason TEXT,
            created_at INTEGER,
            closed_at INTEGER NOT NULL,
            parts INTEGER NOT NULL,
            size INTEGER NOT NULL,
            legacy INTEGER NOT NULL,       -- one .html, not gzip parts
            missing INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS transcripts_by_closed ON transcripts(closed_at);
    `);
    return c;
};

const kvGet = (name) => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

// ── From the bot ─────────────────────────────────────────────────────────────

const ownerOf = () => kvGet(OWNER);

/** The first project to call claims the transcripts; then only it may. */
const claim = (botId) => {
    const owner = ownerOf();
    if (owner && owner !== botId) throw httpError(403, "The transcripts belong to another project");
    if (!owner) kvSet(OWNER, botId);
    kvSet(CHECKED, Date.now());
};

/** GET /state → where the bot starts reading: just after the newest message listed here. */
const state = (botId) => {
    claim(botId);
    const c = conn();
    const newest = c.prepare("SELECT message_id FROM transcripts ORDER BY length(message_id) DESC, message_id DESC LIMIT 1").get();
    return { newestId: newest?.message_id || null, count: c.prepare("SELECT COUNT(*) n FROM transcripts").get().n };
};

const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const count = (v, min = 0) => (Number.isInteger(v) && v >= min ? v : null);
const time = (v) => (Number.isFinite(v) && v > 1.4e12 && v < 4.1e12 ? Math.floor(v) : null);
const snowflake = (v) => (SNOWFLAKE.test(String(v ?? "")) ? String(v) : null);

/** One entry as the bot sends it → a row, or null when it is not one. */
const toRow = (e) => {
    if (!e || typeof e !== "object") return null;
    const id = snowflake(e.messageId);
    const name = text(e.name, 64);
    const closedAt = time(e.closedAt);
    if (!id || !name || !NAME.test(name) || !closedAt) return null;
    const k = KIND.exec(name);
    return {
        message_id: id,
        name,
        number: k ? Number(k[2]) : null,
        kind: k ? k[1].toLowerCase() : "other",
        owner_id: snowflake(e.ownerId),
        owner_tag: text(e.ownerTag, 64),
        channel_id: snowflake(e.channelId),
        ticket_ref: text(e.ticketRef, 64),
        reason: text(e.reason, 1000),
        created_at: time(e.createdAt),
        closed_at: closedAt,
        parts: Math.min(count(e.parts, 1) ?? 1, MAX_PARTS),
        size: count(e.size) ?? 0,
        legacy: e.legacy ? 1 : 0,
    };
};

/** POST / { entries } — new or changed transcripts. A bad entry is skipped, not fatal. */
const ingest = (botId, body = {}) => {
    claim(botId);
    const entries = body?.entries;
    if (!Array.isArray(entries)) throw httpError(400, "entries must be a list");
    if (entries.length > MAX_BATCH) throw httpError(400, `At most ${MAX_BATCH} transcripts per call`);
    const rows = entries.map(toRow).filter(Boolean);
    const c = conn();
    const put = c.prepare(
        `INSERT OR REPLACE INTO transcripts
            (message_id, name, number, kind, owner_id, owner_tag, channel_id, ticket_ref, reason, created_at, closed_at, parts, size, legacy, missing, updated_at)
         VALUES
            (@message_id, @name, @number, @kind, @owner_id, @owner_tag, @channel_id, @ticket_ref, @reason, @created_at, @closed_at, @parts, @size, @legacy, 0, @updated_at)`,
    );
    const now = Date.now();
    c.transaction(() => {
        for (const r of rows) put.run({ ...r, updated_at: now });
    })();
    for (const r of rows) links.delete(r.message_id);
    return { saved: rows.length, skipped: entries.length - rows.length };
};

// ── The page ─────────────────────────────────────────────────────────────────

/** ticket _id → its orders (orders.ticketId), for the list and the search. */
const ordersByTicket = () => {
    const m = new Map();
    if (!orderService.onPanel()) return m;
    for (const o of sharedStore.run("orders", "get")) {
        if (!o?.ticketId) continue;
        const k = String(o.ticketId);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ orderId: o.orderId, name: o.name || null, status: o.status || null });
    }
    return m;
};

/**
 * A number finds that ticket, or the buyer / channel / message with that id;
 * anything else is looked for in the ticket's name, the buyer's name and the
 * reason, or is one of its order ids (arnto_123).
 */
const matches = (r, q, orders) => {
    if (!q) return true;
    const n = q.replace(/^#/, "");
    if (/^\d+$/.test(n)) return String(r.number) === n || r.owner_id === n || r.channel_id === n || r.message_id === n;
    if ([r.name, r.owner_tag, r.reason].some((v) => v && v.toLowerCase().includes(n))) return true;
    return (orders.get(r.ticket_ref) || []).some((o) => String(o.orderId).toLowerCase() === n);
};

const shape = (r, orders) => ({
    id: r.message_id,
    name: r.name,
    number: r.number,
    kind: r.kind,
    ownerId: r.owner_id,
    ownerTag: r.owner_tag || (r.owner_id ? orderService.buyerTag(r.owner_id) : null),
    reason: r.reason,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    parts: r.parts,
    size: r.size,
    legacy: !!r.legacy,
    missing: !!r.missing,
    orders: orders.get(r.ticket_ref) || [],
});

/** Who sends the list, and whether it can open transcripts yet. */
const source = async () => {
    const owner = ownerOf();
    const bot = owner ? await db.findOne("bots", { _id: owner }).catch(() => null) : null;
    return { owner, ownerName: bot?.name || null, canOpen: !!owner && discordBus.canHandle(owner, CMD), checkedAt: kvGet(CHECKED) };
};

/**
 * GET /api/transcripts?q=&kind=ticket|ctv|all&period=all|2026|2026-10|2026-10-05_2026-10-20&page=&pageSize=
 * Newest closed first. A period cuts by the day the ticket was CLOSED (Vietnam time).
 */
const list = async ({ q, kind, period, page, pageSize } = {}) => {
    const p = orderService.periodOf(period);
    const rows = conn().prepare("SELECT * FROM transcripts").all();
    const orders = ordersByTicket();
    const k = String(kind || "all");
    const needle = String(q || "").trim().toLowerCase().slice(0, 100);
    const kinds = {};
    for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    const hits = rows.filter((r) => (k === "all" || r.kind === k) && p.has({ orderDate: r.closed_at }) && matches(r, needle, orders));
    hits.sort((a, b) => b.closed_at - a.closed_at);
    const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 10), 200);
    const pages = Math.max(1, Math.ceil(hits.length / size));
    const at = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
    return {
        total: rows.length,
        matched: hits.length,
        page: at,
        pages,
        pageSize: size,
        period: p.key,
        kinds,
        months: orderService.monthsSince(rows.map((r) => ({ orderDate: r.closed_at }))),
        items: hits.slice((at - 1) * size, at * size).map((r) => shape(r, orders)),
        source: await source(),
    };
};

const row = (messageId) => {
    const id = String(messageId || "");
    return SNOWFLAKE.test(id) ? conn().prepare("SELECT * FROM transcripts WHERE message_id = ?").get(id) || null : null;
};

// ── Opening one ──────────────────────────────────────────────────────────────

const links = new Map(); // message id → { legacy, files, until } — the bot's last answer, while signed
const views = new Map(); // view ticket → { id, legacy, files, until }

const sweep = () => {
    const now = Date.now();
    for (const [k, v] of links) if (v.until <= now) links.delete(k);
    for (const [k, v] of views) if (v.until <= now) views.delete(k);
};

/** Discord's signature ends at `ex` (hex unix seconds) in each link. */
const signedUntil = (files) => {
    const ends = files.map((f) => parseInt(new URL(f.url).searchParams.get("ex") || "", 16) * 1000).filter(Number.isFinite);
    return ends.length ? Math.min(...ends) : Date.now() + 2 * LINK_MARGIN_MS;
};

/** The files as the bot sent them — Discord attachment links only, the parts in order. */
const checkFiles = (files) => {
    if (!Array.isArray(files) || !files.length || files.length > MAX_PARTS) throw httpError(502, "The bot sent no transcript files");
    for (const f of files) {
        if (typeof f?.url !== "string" || !CDN.test(f.url) || typeof f.name !== "string") {
            throw httpError(502, "The bot sent a link that is not a Discord attachment");
        }
    }
    return files.map((f) => ({ name: f.name, url: f.url, size: Number(f.size) || 0 }));
};

const filesOf = async (r) => {
    const hit = links.get(r.message_id);
    if (hit && hit.until > Date.now()) return hit;
    const owner = ownerOf();
    if (!owner || !discordBus.canHandle(owner, CMD)) {
        throw httpError(503, `The bot that sends the transcripts cannot open them yet — update it and restart it (it must announce ${CMD})`);
    }
    const res = await discordBus.request(owner, CMD, { messageId: r.message_id }, { timeoutMs: BUS_TIMEOUT_MS });
    if (res?.missing) {
        conn().prepare("UPDATE transcripts SET missing = 1 WHERE message_id = ?").run(r.message_id);
        throw httpError(410, "This transcript is no longer on Discord — its message was deleted");
    }
    const files = checkFiles(res?.files);
    const got = { legacy: !!res.legacy, files, until: signedUntil(files) - LINK_MARGIN_MS };
    links.set(r.message_id, got);
    if (r.missing) conn().prepare("UPDATE transcripts SET missing = 0 WHERE message_id = ?").run(r.message_id);
    return got;
};

/** GET /api/transcripts/:id/open → a view ticket for the frame (VIEW_TTL_MS, that transcript only). */
const open = async (messageId) => {
    const r = row(messageId);
    if (!r) throw httpError(404, "Transcript not found");
    const got = await filesOf(r);
    sweep();
    const ticket = crypto.randomBytes(24).toString("base64url");
    const until = Math.min(Date.now() + VIEW_TTL_MS, got.until + LINK_MARGIN_MS);
    views.set(ticket, { id: r.message_id, legacy: got.legacy, files: got.files, until });
    return { ticket, name: r.name, expiresAt: until };
};

/**
 * GET /api/transcripts/view/:ticket — the transcript, streamed from Discord's
 * CDN part after part. Errors before the first byte are thrown (the route
 * answers them); after it, the response is cut.
 */
const view = async (ticket, res) => {
    const v = views.get(String(ticket || ""));
    if (!v || v.until <= Date.now()) throw httpError(410, "This link has expired — open the transcript again from the Transcripts page.");
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let started = false;
    try {
        for (const f of v.files) {
            const r = await fetch(f.url, { signal: abort.signal });
            if (!r.ok || !r.body) throw httpError(502, `Discord answered HTTP ${r.status} for ${f.name}`);
            if (!started) {
                res.status(200).set({
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": SANDBOX,
                    // The parts are one gzip file cut in pieces: the browser unpacks it.
                    ...(v.legacy ? {} : { "Content-Encoding": "gzip" }),
                });
                started = true;
            }
            for await (const chunk of r.body) {
                if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
            }
        }
        res.end();
    } catch (err) {
        if (!started) throw err;
        res.destroy(err);
    }
};

module.exports = { state, ingest, list, row, open, view, source, CMD, SANDBOX };
