const crypto = require("crypto");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const panelLog = require("./panelLog");

// ─────────────────────────────────────────────────────────────────────────────
//  Messages — compose a message Discohook-style on the panel, pick a channel,
//  and ArnTo-assistant posts it as itself.
//
//    message.targets   the servers, text channels and roles the bot can see,
//                      with what it may do in each channel (send, embeds,
//                      @everyone) — the page's channel picker and role list
//    message.send      post { content, embeds, link buttons } in a channel
//    message.edit      change a message the bot sent (here or anywhere)
//    message.delete    delete one
//    message.fetch     read a message by its link, to edit it or copy it
//
//  Staff (not the owner) post only in the staff server — the one set under
//  Panel Settings → Staff, ArnTo Shop by default — and only in the channels
//  their OWN Discord account can see AND post in there (View Channel + Send
//  Messages — a read-only channel does not count). The bot works that out from the
//  member's permissions (message.targets with `viewer`), the panel refuses any
//  other channel, and the bot checks it again, live, on every send / edit /
//  delete / read that carries `viewer`. Their Sent list shows those channels only.
//
//  Pings: the page says per message whether @everyone / @here, roles and
//  members may ping (allowedMentions on the bot's side — the assistant's own
//  client default leaves roles out). A role that is not mentionable, and
//  @everyone, also need Mention Everyone in that channel; the bot reports when
//  a ping could not happen.
//
//  A send carries `notAfter`: a bot that sees the command later than that (it
//  was down, the bus was slow) refuses it instead of posting an announcement
//  hours late. A send whose answer has not come back yet stays "pending" in
//  Sent and settles from the bus outbox when it does.
//
//  The panel checks every message against Discord's limits before anything
//  goes on the bus, so a mistake is reported at once, not after a round trip.
//  Storage: data/shared.sqlite — bot_messages (what was sent, last 500) and
//  message_drafts (saved messages).
// ─────────────────────────────────────────────────────────────────────────────

const CMD = {
    targets: "message.targets",
    send: "message.send",
    edit: "message.edit",
    remove: "message.delete",
    fetch: "message.fetch",
};
const SNOWFLAKE = /^\d{17,20}$/;
const LIMIT = {
    content: 2000,
    embeds: 10,
    embedTotal: 6000,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    author: 256,
    rows: 5,
    buttons: 5,
    label: 80,
    url: 2048,
};
const SEND_WINDOW_MS = 10 * 60_000; // a bot seeing a command later than this refuses it
const TARGETS_TTL_MS = 60_000;
const HISTORY_KEEP = 500;
const MAX_DRAFTS = 200;
const MAX_DRAFT_BYTES = 64 * 1024;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const bad = (message) => httpError(400, message);

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS bot_messages (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,              -- pending | sent | failed | deleted
            guild_id TEXT,
            guild_name TEXT,
            channel_id TEXT NOT NULL,
            channel_name TEXT,
            message_id TEXT,                   -- null until the bot answers
            payload TEXT NOT NULL,             -- the message as last sent / edited (Discord API shape)
            options TEXT,                      -- { mentions, silent, publish }
            bus_id TEXT,                       -- the send command, for one whose answer is late
            error TEXT,
            sent_by TEXT,                      -- { kind, id, tag } — null: sent outside the panel
            sent_at INTEGER NOT NULL,
            edited_by TEXT,
            edited_at INTEGER,
            deleted_by TEXT,
            deleted_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS bot_messages_by_message ON bot_messages(message_id);
        CREATE INDEX IF NOT EXISTS bot_messages_by_time ON bot_messages(sent_at);
        CREATE TABLE IF NOT EXISTS message_drafts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,             -- the editor's message, as it was saved
            options TEXT,                      -- { guildId, channelId, mentions, silent, publish }
            created_by TEXT,
            created_at INTEGER NOT NULL,
            updated_by TEXT,
            updated_at INTEGER NOT NULL
        );
    `);
    made = c;
    return c;
};

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => {
    if (s == null) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
};

const rowToSent = (r) =>
    r && {
        id: r.id,
        status: r.status,
        guildId: r.guild_id,
        guildName: r.guild_name,
        channelId: r.channel_id,
        channelName: r.channel_name,
        messageId: r.message_id,
        url: r.message_id && r.guild_id ? `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}` : null,
        message: parse(r.payload),
        options: parse(r.options) || {},
        error: r.error,
        sentBy: parse(r.sent_by),
        sentAt: r.sent_at,
        editedBy: parse(r.edited_by),
        editedAt: r.edited_at,
        deletedBy: parse(r.deleted_by),
        deletedAt: r.deleted_at,
    };

const rowToDraft = (r) =>
    r && {
        id: r.id,
        name: r.name,
        message: parse(r.payload),
        options: parse(r.options) || {},
        createdBy: parse(r.created_by),
        createdAt: r.created_at,
        updatedBy: parse(r.updated_by),
        updatedAt: r.updated_at,
    };

// ── Who did it ───────────────────────────────────────────────────────────────

/** req.auth (middleware/auth.js) → { kind, id, tag } for the history and the panel log. */
const actorOf = (auth) =>
    auth?.kind === "staff"
        ? { kind: "staff", id: auth.staff.userId, tag: auth.staff.userTag || null }
        : { kind: "owner", id: null, tag: auth?.username || "owner" };

const actorText = (a) => (a?.kind === "staff" ? `**${a.tag || a.id}**` : "Owner");

/**
 * Whose eyes the bot checks a channel with: staff → { userId, guildId } (the
 * staff server from Panel Settings → Staff), the owner → null (anywhere).
 */
const viewerOf = (auth) => {
    if (auth?.kind !== "staff") return null;
    return { userId: String(auth.staff.userId), guildId: String(require("./staffService").getSettings().guildId) };
};

// ── Checking a message ───────────────────────────────────────────────────────

const has = (v) => typeof v === "string" && v.trim().length > 0;

const text = (v, max, what) => {
    if (v == null || v === "") return undefined;
    const s = String(v);
    if (!s.trim()) return undefined;
    if (s.length > max) throw bad(`${what} is ${s.length} characters — Discord allows ${max}`);
    return s;
};

const url = (v, what, { schemes = ["http", "https"] } = {}) => {
    if (v == null || String(v).trim() === "") return undefined;
    const s = String(v).trim();
    if (s.length > LIMIT.url) throw bad(`${what} is too long`);
    let u;
    try {
        u = new URL(s);
    } catch {
        throw bad(`${what} is not a link: "${s.slice(0, 80)}"`);
    }
    if (!schemes.includes(u.protocol.replace(/:$/, ""))) throw bad(`${what} must start with ${schemes.map((x) => `${x}://`).join(" or ")}`);
    return s;
};

/** #rrggbb, rrggbb or a number → 0…0xffffff, or undefined. */
const color = (v, what) => {
    if (v == null || v === "") return undefined;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return v;
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
    if (!m) throw bad(`${what}: "${v}" is not a colour (use #rrggbb)`);
    return parseInt(m[1], 16);
};

const timestamp = (v, what) => {
    if (v == null || v === "" || v === false) return undefined;
    const d = new Date(typeof v === "number" ? v : String(v));
    if (Number.isNaN(d.getTime())) throw bad(`${what}: "${v}" is not a date`);
    return d.toISOString();
};

/** "😀", "<:name:id>", "<a:name:id>", "name:id", an id, or { id, name, animated } → Discord's emoji object. */
const emoji = (v, what) => {
    if (v == null || v === "") return undefined;
    if (typeof v === "object") {
        if (v.id && SNOWFLAKE.test(String(v.id))) return { id: String(v.id), name: v.name || undefined, animated: !!v.animated || undefined };
        if (has(v.name)) return { name: v.name.trim() };
        return undefined;
    }
    const s = String(v).trim();
    if (!s) return undefined;
    const custom = /^<(a?):([\w~]{1,32}):(\d{17,20})>$/.exec(s) || /^()([\w~]{1,32}):(\d{17,20})$/.exec(s);
    if (custom) return { id: custom[3], name: custom[2], animated: custom[1] ? true : undefined };
    if (SNOWFLAKE.test(s)) return { id: s };
    if (s.length > 32) throw bad(`${what}: "${s.slice(0, 20)}…" is not an emoji`);
    return { name: s };
};

const embedOf = (e, n) => {
    if (!e || typeof e !== "object") throw bad(`Embed ${n} is not an embed`);
    const what = (x) => `Embed ${n} · ${x}`;
    const out = {
        title: text(e.title, LIMIT.title, what("title")),
        description: text(e.description, LIMIT.description, what("description")),
        url: url(e.url, what("title link")),
        color: color(e.color, what("colour")),
        timestamp: timestamp(e.timestamp, what("time")),
    };
    const authorName = text(e.author?.name, LIMIT.author, what("author"));
    if (authorName) out.author = { name: authorName, url: url(e.author.url, what("author link")), icon_url: url(e.author.icon_url, what("author icon")) };
    else if (has(e.author?.url) || has(e.author?.icon_url)) throw bad(`${what("author")}: a link or icon needs the author's name too`);
    const footerText = text(e.footer?.text, LIMIT.footer, what("footer"));
    if (footerText) out.footer = { text: footerText, icon_url: url(e.footer.icon_url, what("footer icon")) };
    else if (has(e.footer?.icon_url)) throw bad(`${what("footer")}: an icon needs footer text too`);
    const image = url(e.image?.url ?? (typeof e.image === "string" ? e.image : undefined), what("image"));
    if (image) out.image = { url: image };
    const thumb = url(e.thumbnail?.url ?? (typeof e.thumbnail === "string" ? e.thumbnail : undefined), what("thumbnail"));
    if (thumb) out.thumbnail = { url: thumb };

    const fields = Array.isArray(e.fields) ? e.fields : [];
    if (fields.length > LIMIT.fields) throw bad(`Embed ${n} has ${fields.length} fields — Discord allows ${LIMIT.fields}`);
    const list = [];
    fields.forEach((f, i) => {
        const name = text(f?.name, LIMIT.fieldName, what(`field ${i + 1} name`));
        const value = text(f?.value, LIMIT.fieldValue, what(`field ${i + 1} value`));
        if (!name && !value) return; // a row left empty in the editor
        if (!name || !value) throw bad(`${what(`field ${i + 1}`)} needs both a name and a value`);
        list.push({ name, value, inline: !!f.inline });
    });
    if (list.length) out.fields = list;

    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    for (const k of ["author", "footer"]) if (out[k]) for (const kk of Object.keys(out[k])) if (out[k][kk] === undefined) delete out[k][kk];
    const visible = out.title || out.description || out.author || out.footer || out.image || out.thumbnail || out.fields;
    if (!visible) throw bad(`Embed ${n} is empty — give it a title, a description, a field or an image, or remove it`);
    return out;
};

const embedChars = (e) =>
    (e.title?.length || 0) +
    (e.description?.length || 0) +
    (e.author?.name?.length || 0) +
    (e.footer?.text?.length || 0) +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** Rows of link buttons: [{ type: 1, components: [...] }] or plain arrays of buttons. */
const componentsOf = (rows) => {
    if (!Array.isArray(rows)) throw bad("Buttons must be a list of rows");
    const out = [];
    rows.forEach((row, r) => {
        const items = Array.isArray(row) ? row : Array.isArray(row?.components) ? row.components : null;
        if (!items) throw bad(`Button row ${r + 1} is not a row`);
        if (!items.length) return;
        if (items.length > LIMIT.buttons) throw bad(`Button row ${r + 1} has ${items.length} buttons — Discord allows ${LIMIT.buttons}`);
        const buttons = items.map((b, k) => {
            const what = `Button ${k + 1} in row ${r + 1}`;
            if (b?.type != null && b.type !== 2) throw bad(`${what}: only link buttons can be sent from the panel`);
            if (b?.style != null && b.style !== 5 && b.style !== "link" && b.style !== "Link") throw bad(`${what}: only link buttons can be sent from the panel`);
            if (b?.custom_id) throw bad(`${what}: only link buttons can be sent from the panel`);
            const target = url(b?.url, `${what} link`, { schemes: ["http", "https", "discord"] });
            if (!target) throw bad(`${what} needs a link`);
            const label = text(b.label, LIMIT.label, `${what} label`);
            const em = emoji(b.emoji, `${what} emoji`);
            if (!label && !em) throw bad(`${what} needs a label or an emoji`);
            const btn = { type: 2, style: 5, url: target };
            if (label) btn.label = label;
            if (em) btn.emoji = Object.fromEntries(Object.entries(em).filter(([, v]) => v !== undefined));
            if (b.disabled) btn.disabled = true;
            return btn;
        });
        out.push({ type: 1, components: buttons });
    });
    if (out.length > LIMIT.rows) throw bad(`${out.length} button rows — Discord allows ${LIMIT.rows}`);
    return out;
};

/**
 * The editor's message → exactly what Discord takes: { content?, embeds, components }.
 * Throws 400 with the first thing Discord would refuse. `components: null` (an
 * edit only) means "leave the message's buttons as they are" — used for a
 * message whose buttons run the bot's own features.
 */
const normalizeMessage = (input, { edit = false } = {}) => {
    if (!input || typeof input !== "object") throw bad("No message");
    const content = text(input.content, LIMIT.content, "The content");
    const embedsIn = input.embeds == null ? [] : input.embeds;
    if (!Array.isArray(embedsIn)) throw bad("Embeds must be a list");
    if (embedsIn.length > LIMIT.embeds) throw bad(`${embedsIn.length} embeds — Discord allows ${LIMIT.embeds}`);
    const embeds = embedsIn.map((e, i) => embedOf(e, i + 1));
    const total = embeds.reduce((n, e) => n + embedChars(e), 0);
    if (total > LIMIT.embedTotal) throw bad(`The embeds hold ${total} characters together — Discord allows ${LIMIT.embedTotal}`);
    const keep = edit && input.components === null;
    const components = keep ? null : componentsOf(input.components == null ? [] : input.components);
    if (!content && !embeds.length) throw bad("The message is empty — write some content or add an embed");
    return { ...(content ? { content } : {}), embeds, components };
};

const bool = (v, dflt) => (v == null ? dflt : v === true || v === "true" || v === 1);

/** Who may be pinged, and how the message goes out. Pings are allowed unless switched off. */
const normalizeOptions = (o = {}) => ({
    mentions: {
        everyone: bool(o.mentions?.everyone, true),
        roles: bool(o.mentions?.roles, true),
        users: bool(o.mentions?.users, true),
    },
    silent: bool(o.silent, false),
    publish: bool(o.publish, false),
});

/** What the message pings, read from its content (embeds never ping). */
const pingsOf = (content = "") => ({
    everyone: /@everyone/.test(content),
    here: /@here/.test(content),
    roles: [...new Set([...String(content).matchAll(/<@&(\d{17,20})>/g)].map((m) => m[1]))],
    users: [...new Set([...String(content).matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]))],
});

// ── The bot ──────────────────────────────────────────────────────────────────

const handler = (cmd) => {
    const bot = discordBus.handlerOf(cmd);
    if (!bot) throw httpError(503, `No bot has announced "${cmd}" — update ArnTo-assistant (Pull & Update) and restart it`);
    if (!discordBus.status().ready) throw httpError(503, "The panel's Discord bus is not ready — try again in a moment");
    return bot;
};

const status = async (auth) => {
    const bot = discordBus.handlerOf(CMD.send);
    let botName = null;
    if (bot) {
        try {
            botName = (await require("../db").findOne("bots", { _id: bot }))?.name || null;
        } catch {
            /* the name is cosmetic */
        }
    }
    return {
        busReady: !!discordBus.status().ready,
        bot,
        botName,
        can: Object.fromEntries(Object.entries(CMD).map(([k, cmd]) => [k, !!bot && discordBus.canHandle(bot, cmd)])),
        limits: LIMIT,
        scope: viewerOf(auth) ? "staff" : "all",
    };
};

const targetsCache = new Map(); // "owner" | "staff:<userId>:<guildId>" → { at, bot, data }
const targetsInFlight = new Map();

const shown = (e) => ({ ...e.data, cachedAt: e.at });

/**
 * The servers, channels and roles the bot sees — for staff only the staff
 * server's channels their own account can see and post in. Cached a minute per viewer
 * unless `refresh`.
 */
const targets = async ({ refresh = false, auth } = {}) => {
    const bot = handler(CMD.targets);
    const viewer = viewerOf(auth);
    const key = viewer ? `staff:${viewer.userId}:${viewer.guildId}` : "owner";
    const hit = targetsCache.get(key);
    if (!refresh && hit?.bot === bot && Date.now() - hit.at < TARGETS_TTL_MS) return shown(hit);
    if (!targetsInFlight.has(key)) {
        targetsInFlight.set(
            key,
            discordBus
                .request(bot, CMD.targets, viewer ? { viewer } : {}, { timeoutMs: 25_000 })
                .then((data) => {
                    // An assistant from before this check ignores `viewer` and lists everything.
                    if (viewer && data?.viewer?.userId !== viewer.userId) {
                        throw httpError(503, "ArnTo-assistant does not check which channels staff can see yet — update it (Pull & Update) and restart it");
                    }
                    const entry = { at: Date.now(), bot, data: { bot: data?.bot || null, guilds: Array.isArray(data?.guilds) ? data.guilds : [], viewer: data?.viewer || null } };
                    targetsCache.set(key, entry);
                    return entry;
                })
                .finally(() => targetsInFlight.delete(key)),
        );
    }
    return shown(await targetsInFlight.get(key));
};

/** Staff: the ids of the channels they may use (a Set); the owner: null (all). */
const allowedFor = async (auth) => {
    const viewer = viewerOf(auth);
    if (!viewer) return null;
    const t = await targets({ auth });
    if (!t.viewer?.found) throw httpError(403, "Your Discord account is not in the shop's server, so you cannot post from here");
    return new Set(t.guilds.filter((g) => g.id === viewer.guildId).flatMap((g) => (g.channels || []).map((c) => c.id)));
};

/** Refuse a channel staff cannot see; → the viewer to hand the bot (null for the owner). */
const checkChannel = async (auth, channelId) => {
    const allowed = await allowedFor(auth);
    if (allowed && !allowed.has(String(channelId))) {
        throw httpError(403, "You can only use the channels you can see and post in yourself in the shop's server on Discord");
    }
    return viewerOf(auth);
};

/** Channel name / server name from the cached targets, when the bot's answer has none. */
const placeOf = (channelId) => {
    for (const { data } of targetsCache.values()) {
        for (const g of data.guilds || []) {
            const c = (g.channels || []).find((x) => x.id === channelId);
            if (c) return { guildId: g.id, guildName: g.name, channelName: c.name };
        }
    }
    return {};
};

// ── History ──────────────────────────────────────────────────────────────────

const getRow = (id) => conn().prepare("SELECT * FROM bot_messages WHERE id = ?").get(String(id));
const byMessage = (messageId) => conn().prepare("SELECT * FROM bot_messages WHERE message_id = ?").get(String(messageId));

const prune = () =>
    conn()
        .prepare("DELETE FROM bot_messages WHERE id NOT IN (SELECT id FROM bot_messages ORDER BY sent_at DESC LIMIT ?)")
        .run(HISTORY_KEEP);

/** A send that was still waiting for the bot: take its answer from the bus outbox once there is one. */
const settle = (r) => {
    if (r.status !== "pending" || !r.bus_id) return r;
    const b = discordBus.get(r.bus_id);
    if (!b || (b.status !== "done" && b.status !== "failed")) return r;
    if (b.status === "failed") {
        conn().prepare("UPDATE bot_messages SET status = 'failed', error = ? WHERE id = ?").run(String(b.error || "failed").slice(0, 500), r.id);
    } else {
        const res = b.result || {};
        try {
            conn()
                .prepare("UPDATE bot_messages SET status = 'sent', message_id = ?, guild_id = COALESCE(?, guild_id), guild_name = COALESCE(?, guild_name), channel_name = COALESCE(?, channel_name) WHERE id = ?")
                .run(res.messageId || null, res.guildId || null, res.guildName || null, res.channelName || null, r.id);
        } catch (err) {
            // The same Discord message is already listed (it was adopted by an edit meanwhile).
            conn().prepare("UPDATE bot_messages SET status = 'sent', error = ? WHERE id = ?").run(err.message.slice(0, 200), r.id);
        }
    }
    return getRow(r.id);
};

/**
 * Newest first. Staff see the channels they can post in — or, when that cannot be
 * worked out right now (bus down), only what they sent themselves.
 */
const listSent = async ({ limit = 100, auth } = {}) => {
    const n = Math.min(Math.max(parseInt(limit) || 100, 1), HISTORY_KEEP);
    let rows = conn().prepare("SELECT * FROM bot_messages ORDER BY sent_at DESC").all();
    const viewer = viewerOf(auth);
    if (viewer) {
        let allowed = null;
        try {
            allowed = await allowedFor(auth);
        } catch {
            /* fall back to their own sends */
        }
        rows = rows.filter((r) => (allowed ? allowed.has(r.channel_id) : parse(r.sent_by)?.id === viewer.userId));
    }
    return rows.slice(0, n).map((r) => rowToSent(settle(r)));
};

const forget = async (id, auth) => {
    const r = getRow(id);
    if (!r) throw httpError(404, "Not in the list");
    await checkChannel(auth, r.channel_id);
    conn().prepare("DELETE FROM bot_messages WHERE id = ?").run(r.id);
    return { forgotten: r.id };
};

// ── Sending, editing, deleting ───────────────────────────────────────────────

const pingText = (msg, opts) => {
    const p = pingsOf(msg.content);
    const out = [];
    if (opts.mentions.everyone && p.everyone) out.push("@everyone");
    if (opts.mentions.everyone && p.here) out.push("@here");
    if (opts.mentions.roles && p.roles.length) out.push(`${p.roles.length} role${p.roles.length === 1 ? "" : "s"}`);
    return out.length ? ` · mentions ${out.join(", ")}` : "";
};

const logLine = (actor, verb, where, link, extra = "") =>
    panelLog.add(actor.kind === "staff" ? "staff" : "owner", `📨 ${actorText(actor)} ${verb} a message in **#${where.channelName || where.channelId}**${where.guildName ? ` (${where.guildName})` : ""}${extra}${link ? ` — ${link}` : ""}`);

/**
 * Post a message. → the Sent row, plus the bot's `warnings` (a ping that could
 * not happen, a publish that failed). On a slow bot: 504 and the row stays
 * pending — it settles from the bus when the answer comes.
 */
const send = async ({ channelId, message, ...rest } = {}, auth) => {
    const ch = String(channelId || "");
    if (!SNOWFLAKE.test(ch)) throw bad("Pick a channel");
    const msg = normalizeMessage(message);
    const opts = normalizeOptions(rest);
    const bot = handler(CMD.send);
    const viewer = await checkChannel(auth, ch);
    const actor = actorOf(auth);
    const id = crypto.randomUUID();
    const place = placeOf(ch);
    const now = Date.now();
    conn()
        .prepare(
            "INSERT INTO bot_messages (id, status, guild_id, guild_name, channel_id, channel_name, payload, options, sent_by, sent_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, place.guildId || null, place.guildName || null, ch, place.channelName || null, json(msg), json(opts), json(actor), now);
    prune();

    let res;
    try {
        res = await discordBus.request(
            bot,
            CMD.send,
            { channelId: ch, message: msg, ...opts, ...(viewer ? { viewer } : {}), notAfter: now + SEND_WINDOW_MS },
            { timeoutMs: 30_000, onQueued: (busId) => conn().prepare("UPDATE bot_messages SET bus_id = ? WHERE id = ?").run(busId, id) },
        );
    } catch (err) {
        if (err.status === 504) {
            throw httpError(504, "ArnTo-assistant has not answered yet. The message is listed under Sent as waiting; the bot still posts it if it sees the command within 10 minutes.", { id });
        }
        conn().prepare("UPDATE bot_messages SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 500), id);
        throw err;
    }
    conn()
        .prepare(
            "UPDATE bot_messages SET status = 'sent', message_id = ?, guild_id = ?, guild_name = ?, channel_name = ?, error = NULL WHERE id = ?",
        )
        .run(res?.messageId || null, res?.guildId || place.guildId || null, res?.guildName || place.guildName || null, res?.channelName || place.channelName || null, id);
    const row = rowToSent(getRow(id));
    const warned = (res?.warnings || []).length ? ` · ⚠️ ${res.warnings.join("; ")}` : "";
    logLine(actor, "sent", row, row.url, pingText(msg, opts) + (opts.silent ? " · silent" : "") + (res?.published ? " · published" : "") + warned);
    return { ...row, warnings: res?.warnings || [], published: !!res?.published };
};

const refOf = ({ channelId, messageId } = {}) => {
    const ch = String(channelId || "");
    const msgId = String(messageId || "");
    if (!SNOWFLAKE.test(ch) || !SNOWFLAKE.test(msgId)) throw bad("Which message? (channelId and messageId)");
    return { channelId: ch, messageId: msgId };
};

/**
 * Change a message the bot sent. A message that is not in Sent yet (opened by
 * its link) is added to it. Editing never pings again — Discord only notifies
 * when a message is first posted.
 */
const edit = async ({ channelId, messageId, message, ...rest } = {}, auth) => {
    const ref = refOf({ channelId, messageId });
    const msg = normalizeMessage(message, { edit: true });
    const opts = normalizeOptions(rest);
    const bot = handler(CMD.edit);
    const viewer = await checkChannel(auth, ref.channelId);
    const actor = actorOf(auth);
    const res = await discordBus.request(
        bot,
        CMD.edit,
        { ...ref, message: msg, mentions: opts.mentions, ...(viewer ? { viewer } : {}), notAfter: Date.now() + SEND_WINDOW_MS },
        { timeoutMs: 30_000 },
    );
    const now = Date.now();
    // What Discord now holds: the buttons left alone come back from the bot.
    const stored = msg.components === null ? { ...msg, components: res?.components || [] } : msg;
    const cur = byMessage(ref.messageId);
    if (cur) {
        conn()
            .prepare(
                "UPDATE bot_messages SET status = 'sent', payload = ?, options = ?, edited_by = ?, edited_at = ?, guild_id = COALESCE(?, guild_id), guild_name = COALESCE(?, guild_name), channel_name = COALESCE(?, channel_name), error = NULL WHERE id = ?",
            )
            .run(json(stored), json(opts), json(actor), now, res?.guildId || null, res?.guildName || null, res?.channelName || null, cur.id);
    } else {
        conn()
            .prepare(
                "INSERT INTO bot_messages (id, status, guild_id, guild_name, channel_id, channel_name, message_id, payload, options, sent_by, sent_at, edited_by, edited_at) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
            )
            .run(crypto.randomUUID(), res?.guildId || null, res?.guildName || null, ref.channelId, res?.channelName || null, ref.messageId, json(stored), json(opts), res?.createdAt || now, json(actor), now);
        prune();
    }
    const row = rowToSent(byMessage(ref.messageId));
    logLine(actor, "edited", row, row.url);
    return { ...row, warnings: res?.warnings || [] };
};

/** Delete a message the bot sent. One that is already gone counts as deleted. */
const remove = async (input = {}, auth) => {
    const ref = refOf(input);
    const bot = handler(CMD.remove);
    const viewer = await checkChannel(auth, ref.channelId);
    const actor = actorOf(auth);
    const res = await discordBus.request(bot, CMD.remove, { ...ref, ...(viewer ? { viewer } : {}), notAfter: Date.now() + SEND_WINDOW_MS }, { timeoutMs: 30_000 });
    const cur = byMessage(ref.messageId);
    if (cur) conn().prepare("UPDATE bot_messages SET status = 'deleted', deleted_by = ?, deleted_at = ? WHERE id = ?").run(json(actor), Date.now(), cur.id);
    const row = cur ? rowToSent(getRow(cur.id)) : { ...ref, ...placeOf(ref.channelId) };
    logLine(actor, "deleted", row, null, res?.missing ? " (it was already gone)" : "");
    return { deleted: true, missing: !!res?.missing, row: cur ? row : null };
};

/** "https://discord.com/channels/<guild>/<channel>/<message>" (or just "<channel>/<message>") → ids. */
const parseLink = (link) => {
    const s = String(link || "").trim();
    const m = /channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/.exec(s) || /^(?:(\d{17,20})[/-])?(\d{17,20})[/-](\d{17,20})$/.exec(s);
    if (!m) throw bad("Paste a message link (right-click the message → Copy Message Link)");
    return { guildId: m[1] && m[1] !== "@me" ? m[1] : null, channelId: m[2], messageId: m[3] };
};

/**
 * Read a message by its link: → { message (the editor's shape), own, editable,
 * keepsComponents, place…, sent (its Sent row, if any) }.
 */
const fetchByLink = async (link, auth) => {
    const ref = parseLink(link);
    const bot = handler(CMD.fetch);
    const viewer = await checkChannel(auth, ref.channelId);
    const res = await discordBus.request(bot, CMD.fetch, { channelId: ref.channelId, messageId: ref.messageId, ...(viewer ? { viewer } : {}) }, { timeoutMs: 25_000 });
    const sent = byMessage(ref.messageId);
    return { ...res, sent: sent ? rowToSent(settle(sent)) : null };
};

// ── Saved messages ───────────────────────────────────────────────────────────

const draftInput = (input = {}, { partial = false } = {}) => {
    const out = {};
    if (!partial || input.name !== undefined) {
        const name = String(input.name ?? "").trim().slice(0, 100);
        if (!name) throw bad("Give the saved message a name");
        out.name = name;
    }
    if (!partial || input.message !== undefined) {
        if (!input.message || typeof input.message !== "object" || Array.isArray(input.message)) throw bad("No message to save");
        const s = JSON.stringify(input.message);
        if (Buffer.byteLength(s) > MAX_DRAFT_BYTES) throw bad("The message is too big to save");
        out.payload = s;
    }
    if (!partial || input.options !== undefined) {
        const o = input.options || {};
        out.options = json({
            guildId: SNOWFLAKE.test(String(o.guildId || "")) ? String(o.guildId) : null,
            channelId: SNOWFLAKE.test(String(o.channelId || "")) ? String(o.channelId) : null,
            ...normalizeOptions(o),
        });
    }
    return out;
};

const listDrafts = () => conn().prepare("SELECT * FROM message_drafts ORDER BY updated_at DESC").all().map(rowToDraft);

const createDraft = (input, auth) => {
    const d = draftInput(input);
    if (conn().prepare("SELECT COUNT(*) n FROM message_drafts").get().n >= MAX_DRAFTS) throw bad(`At most ${MAX_DRAFTS} saved messages — delete some first`);
    const id = crypto.randomUUID();
    const now = Date.now();
    const who = json(actorOf(auth));
    conn()
        .prepare("INSERT INTO message_drafts (id, name, payload, options, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, d.name, d.payload, d.options, who, now, who, now);
    return rowToDraft(conn().prepare("SELECT * FROM message_drafts WHERE id = ?").get(id));
};

const updateDraft = (id, input, auth) => {
    const cur = conn().prepare("SELECT * FROM message_drafts WHERE id = ?").get(String(id));
    if (!cur) throw httpError(404, "Saved message not found");
    const d = draftInput(input, { partial: true });
    conn()
        .prepare("UPDATE message_drafts SET name = ?, payload = ?, options = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(d.name ?? cur.name, d.payload ?? cur.payload, d.options ?? cur.options, json(actorOf(auth)), Date.now(), cur.id);
    return rowToDraft(conn().prepare("SELECT * FROM message_drafts WHERE id = ?").get(cur.id));
};

const deleteDraft = (id) => {
    const res = conn().prepare("DELETE FROM message_drafts WHERE id = ?").run(String(id));
    if (!res.changes) throw httpError(404, "Saved message not found");
    return { deleted: String(id) };
};

module.exports = {
    CMD,
    LIMIT,
    status,
    targets,
    send,
    edit,
    remove,
    fetchByLink,
    listSent,
    forget,
    listDrafts,
    createDraft,
    updateDraft,
    deleteDraft,
    // for tests
    normalizeMessage,
    normalizeOptions,
    pingsOf,
    parseLink,
    emoji,
};
