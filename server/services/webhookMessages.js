const crypto = require("crypto");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const panelLog = require("./panelLog");
const lifecycle = require("./lifecycle");
const agentCrypto = require("./agentCrypto");
const messages = require("./botMessages");

// ─────────────────────────────────────────────────────────────────────────────
//  Webhooks — Discohook on the panel, without pasting webhook URLs.
//
//  The shop's server (Panel Settings → Staff, ArnTo Shop by default) is the
//  only one used. Its webhooks come from ArnTo-assistant, which can read every
//  webhook's token (Administrator), over the bus:
//
//    webhook.list    every webhook of the server, its channels (with their
//                    permission overwrites) and roles — loaded once a day, or
//                    with Reload (once every 10 minutes for everyone), the same
//                    rule as the Messages page's server map
//    webhook.fetch   read a message by its link → which webhook sent it, so a
//                    pasted link is all it takes to edit one
//    webhook.create  a new webhook made by ArnTo-selfbot (a member's webhook, not
//                    the bot's: it shows under Integrations like one made by hand).
//                    The selfbot is not in the bus server, so ArnTo-assistant asks
//                    it with a `$wh` command in that very channel and deletes the
//                    command as soon as the webhook is there — no trace is left
//
//  Tokens travel sealed (PanelBus.seal → discordBus.request opens them) and are
//  kept AES-GCM-encrypted with JWT_SECRET; the browser never gets one. Posting,
//  editing, deleting and reading a message once its webhook is known are plain
//  calls to Discord's webhook API from the panel — no bot in between.
//
//  A webhook made by another app (another bot, Discohook's bot…) is listed but
//  cannot be used: Discord does not give its token to the bot.
//
//  Staff follow the Messages page's rule: only the channels their own Discord
//  account can see and post in (Discord's formula over the list's overwrites
//  and their roles); the bot checks it again, live, when it reads a link.
//
//  Storage: data/shared.sqlite — kv "__webhooks.scan" (the list), the
//  webhook_messages table (Sent, kept 3 days) and webhook_drafts (Saved).
// ─────────────────────────────────────────────────────────────────────────────

const CMD = { list: "webhook.list", fetch: "webhook.fetch", create: "webhook.create" };
const API = "https://discord.com/api/v10";
const { SNOWFLAKE } = messages;
const SCAN = "__webhooks.scan"; // kv: { at, bot, guild, channels, webhooks (tokens encrypted) }
const SCAN_TRIED = "__webhooks.scanTried"; // kv: when the bot was last asked (daily or Reload)
const SCAN_EVERY_MS = 24 * 60 * 60_000;
const RELOAD_EVERY_MS = 10 * 60_000;
const CHECK_MS = 10 * 60_000;
const RETRY_MS = 60 * 60_000; // a failed daily load, while an older list still serves
const SENT_KEEP_MS = 3 * 86_400_000;
const SENT_LIST_MAX = 500;
const MAX_DRAFTS = 200;
const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_MESSAGES = 10; // messages in one draft
const FILES_MAX = 10; // Discord's limit per message
const FILES_BYTES = 25 * 1024 * 1024; // all files of one message (Discord itself takes 10 MB on a server without boosts)
const NAME_MAX = 80;
const CREATE_WINDOW_MS = 2 * 60_000; // a bot seeing webhook.create later than this makes nothing
const THREAD_NAME_MAX = 100;
const FLAG = { suppressEmbeds: 1 << 2, silent: 1 << 12 };
const POSTS = new Set(["forum", "media"]); // a webhook there always opens or answers a post

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const bad = (message) => httpError(400, message);

const shopGuildId = () => String(require("./staffService").getSettings().guildId || "");

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS webhook_messages (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,              -- sent | deleted
            guild_id TEXT,
            channel_id TEXT NOT NULL,          -- the webhook's channel
            channel_name TEXT,
            thread_id TEXT,                    -- a thread or forum post in it
            thread_name TEXT,
            webhook_id TEXT NOT NULL,
            webhook_name TEXT,
            message_id TEXT NOT NULL,
            payload TEXT NOT NULL,             -- { message, username, avatarUrl, attachments } as last sent / edited
            options TEXT,                      -- { mentions, silent, suppressEmbeds }
            sent_by TEXT,                      -- { kind, id, tag } — null: sent outside the panel
            sent_at INTEGER NOT NULL,
            edited_by TEXT,
            edited_at INTEGER,
            deleted_by TEXT,
            deleted_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS webhook_messages_by_message ON webhook_messages(message_id);
        CREATE INDEX IF NOT EXISTS webhook_messages_by_time ON webhook_messages(sent_at);
        CREATE TABLE IF NOT EXISTS webhook_drafts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,             -- { messages, target, options } as the page saved it
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

const kvGet = (name) => {
    const r = conn().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => conn().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const linkOf = (guildId, channelId, messageId) => (guildId && channelId && messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null);

const rowToSent = (r) =>
    r && {
        id: r.id,
        status: r.status,
        guildId: r.guild_id,
        channelId: r.channel_id,
        channelName: r.channel_name,
        threadId: r.thread_id,
        threadName: r.thread_name,
        webhookId: r.webhook_id,
        webhookName: r.webhook_name,
        messageId: r.message_id,
        url: linkOf(r.guild_id, r.thread_id || r.channel_id, r.message_id),
        ...(parse(r.payload) || {}),
        options: parse(r.options) || {},
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
        ...(parse(r.payload) || {}),
        createdBy: parse(r.created_by),
        createdAt: r.created_at,
        updatedBy: parse(r.updated_by),
        updatedAt: r.updated_at,
    };

// ── Tokens ───────────────────────────────────────────────────────────────────

const secret = () => {
    if (!process.env.JWT_SECRET) throw httpError(500, "JWT_SECRET is not set — webhook tokens cannot be kept");
    return process.env.JWT_SECRET;
};
const lock = (token) => (token ? agentCrypto.encrypt(String(token), secret()) : null);
const unlock = (enc) => {
    try {
        return agentCrypto.decrypt(enc, secret());
    } catch {
        return null;
    }
};

// ── The bots ─────────────────────────────────────────────────────────────────

const SETUP = {
    [CMD.list]: "update ArnTo-assistant (Pull & Update) and restart it",
    [CMD.fetch]: "update ArnTo-assistant (Pull & Update) and restart it",
    [CMD.create]: "update ArnTo-assistant (Pull & Update) and restart it",
};

const handler = (cmd) => {
    const bot = discordBus.handlerOf(cmd);
    if (!bot) throw httpError(503, `No bot has announced "${cmd}" — ${SETUP[cmd]}`);
    if (!discordBus.status().ready) throw httpError(503, "The panel's Discord bus is not ready — try again in a moment");
    return bot;
};

const botName = async (id) => {
    if (!id) return null;
    try {
        return (await require("../db").findOne("bots", { _id: id }))?.name || null;
    } catch {
        return null; // the name is cosmetic
    }
};

const status = async (auth) => {
    const scanBot = discordBus.handlerOf(CMD.list);
    const createBot = discordBus.handlerOf(CMD.create);
    return {
        busReady: !!discordBus.status().ready,
        guildId: shopGuildId(),
        bots: { scan: scanBot ? { id: scanBot, name: await botName(scanBot) } : null, create: createBot ? { id: createBot, name: await botName(createBot) } : null },
        can: Object.fromEntries(Object.entries(CMD).map(([k, cmd]) => [k, !!discordBus.handlerOf(cmd)])),
        limits: { ...messages.LIMIT, files: FILES_MAX, fileBytes: FILES_BYTES, name: NAME_MAX, threadName: THREAD_NAME_MAX, messages: MAX_MESSAGES },
        scope: messages.viewerOf(auth) ? "staff" : "all",
    };
};

// ── The list ─────────────────────────────────────────────────────────────────

/** A webhook as the panel keeps it (its token locked). */
const keep = (w, source, now = Date.now()) => ({
    id: String(w.id),
    name: String(w.name || "Webhook").slice(0, NAME_MAX),
    avatar: w.avatar || null,
    channelId: String(w.channelId),
    applicationId: w.applicationId || null,
    creator: w.creator?.id ? { id: String(w.creator.id), tag: w.creator.tag || null } : null,
    createdAt: Number(w.createdAt) || null,
    token: lock(w.token),
    source, // scan | link | created
    seenAt: now,
});

const why = (w) => (w.token ? null : w.applicationId ? "Made by another app — Discord does not give its token to the bot, so it cannot be used here" : "Discord did not give its token to the bot");

/** What the page gets of a webhook: never the token. */
const publicWebhook = (w) => ({
    id: w.id,
    name: w.name,
    avatar: w.avatar,
    channelId: w.channelId,
    creator: w.creator,
    createdAt: w.createdAt,
    usable: !!w.token,
    why: why(w),
    source: w.source,
});

const getScan = () => kvGet(SCAN);
/** The list, if it is the shop server's (the server can be changed under Panel Settings → Staff). */
const currentScan = () => {
    const scan = getScan();
    return scan?.guild?.id && scan.guild.id === shopGuildId() ? scan : null;
};
const reloadAt = () => (kvGet(SCAN_TRIED) || 0) + RELOAD_EVERY_MS;

const WHY = {
    no_scan: "The webhook list has not been loaded yet — press Reload",
    no_roles: "The panel has not read your Discord roles yet — sign out and in again, or wait a few minutes",
};

const requireScan = () => {
    const scan = currentScan();
    if (!scan) throw httpError(503, WHY.no_scan);
    return scan;
};

const str = (v) => (v == null ? "0" : String(v));

/** The bot's answer → the list. */
const scanOf = (data, bot, now = Date.now()) => {
    const g = data?.guild;
    if (!g?.id || !SNOWFLAKE.test(String(g.id))) throw httpError(502, "The bot sent no server");
    return {
        at: now,
        bot,
        guild: {
            id: String(g.id),
            name: g.name || null,
            icon: g.icon || null,
            ownerId: g.ownerId || null,
            everyone: str(g.everyone),
            roles: (g.roles || []).map((r) => ({ id: String(r.id), name: r.name, color: r.color || 0, mentionable: !!r.mentionable, managed: !!r.managed, permissions: str(r.permissions) })),
        },
        channels: (data.channels || [])
            .filter((c) => SNOWFLAKE.test(String(c.id)))
            .map((c) => ({ id: String(c.id), name: c.name, type: c.type || "text", parentId: c.parentId || null, parent: c.parent || null, overwrites: c.overwrites || [] })),
        webhooks: (data.webhooks || []).filter((w) => SNOWFLAKE.test(String(w.id)) && SNOWFLAKE.test(String(w.channelId))).map((w) => keep(w, "scan", now)),
    };
};

let loading = null;

/** Ask the bot for the list. `manual` (Reload) waits 10 minutes after the last time it was asked. */
const loadScan = async ({ manual = false } = {}) => {
    if (loading) return loading;
    if (manual && Date.now() < reloadAt()) {
        const min = Math.ceil((reloadAt() - Date.now()) / 60_000);
        throw httpError(429, `The webhook list was just loaded — it can be reloaded again in ${min} minute${min === 1 ? "" : "s"}`);
    }
    const guildId = shopGuildId();
    if (!SNOWFLAKE.test(guildId)) throw httpError(503, "No shop server is set (Panel Settings → Staff)");
    const bot = handler(CMD.list);
    kvSet(SCAN_TRIED, Date.now());
    loading = discordBus
        .request(bot, CMD.list, { guildId }, { timeoutMs: 25_000 })
        .then((data) => {
            const scan = scanOf(data, bot);
            kvSet(SCAN, scan);
            return scan;
        })
        .finally(() => {
            loading = null;
        });
    return loading;
};

/** Once a day (and on the first start, when there is no list yet). A failed try waits before the next. */
const dailyTick = async () => {
    if (!discordBus.handlerOf(CMD.list) || !discordBus.status().ready) return;
    const scan = currentScan();
    if (scan && Date.now() - scan.at < SCAN_EVERY_MS) return;
    const tried = kvGet(SCAN_TRIED) || 0;
    if (tried > (scan?.at || 0) && Date.now() - tried < (scan ? RETRY_MS : RELOAD_EVERY_MS)) return;
    try {
        await loadScan();
        console.log("[Webhooks] Webhook list loaded from the bot");
    } catch (err) {
        console.warn(`[Webhooks] Webhook list not loaded: ${err.message}`);
    }
};

/** One webhook learnt between two loads (a link, a new one): into the list. */
const remember = (w, source) => {
    const scan = requireScan();
    const k = keep(w, source);
    scan.webhooks = [...scan.webhooks.filter((x) => x.id !== k.id), k];
    kvSet(SCAN, scan);
    return k;
};

/** Discord says the webhook is gone: out of the list. */
const dropWebhook = (id) => {
    const scan = getScan();
    if (!scan) return;
    scan.webhooks = scan.webhooks.filter((x) => x.id !== String(id));
    kvSet(SCAN, scan);
};

// ── Staff ────────────────────────────────────────────────────────────────────

/** Staff: the ids of the channels they may use (a Set); the owner: null (all). */
const allowedFor = (auth) => {
    const viewer = messages.viewerOf(auth);
    if (!viewer) return null;
    const scan = requireScan();
    if (scan.guild.id !== viewer.guildId) throw httpError(403, "Staff can only use the shop's server");
    const r = require("./staffService").rolesOf(viewer.userId);
    if (!r) throw httpError(403, WHY.no_roles);
    return new Set(scan.channels.filter((c) => messages.canPost(messages.permissionsIn(scan.guild, c, viewer.userId, r.roles || []))).map((c) => c.id));
};

/** Refuse a channel staff cannot post in; → the viewer to hand the bot (null for the owner). */
const checkChannel = (auth, channelId) => {
    const allowed = allowedFor(auth);
    if (allowed && !allowed.has(String(channelId))) {
        throw httpError(403, "You can only use the webhooks of channels you can see and post in yourself in the shop's server on Discord");
    }
    return messages.viewerOf(auth);
};

/**
 * The page's list: the server (its roles, for mentions), and its channels with
 * their webhooks — for staff only the channels they may use.
 */
const targets = ({ auth } = {}) => {
    const scan = currentScan();
    const meta = { loadedAt: scan?.at || null, reloadAt: reloadAt(), loading: !!loading, guildId: shopGuildId() };
    const viewer = messages.viewerOf(auth);
    if (!scan) return { ...meta, guild: null, channels: [], ...(viewer ? { viewer: { ...viewer, found: false, why: WHY.no_scan } } : {}) };
    const guild = { id: scan.guild.id, name: scan.guild.name, icon: scan.guild.icon, roles: scan.guild.roles.map(({ permissions, ...r }) => r) };
    let allowed = null;
    if (viewer) {
        try {
            allowed = allowedFor(auth);
        } catch (err) {
            return { ...meta, guild, channels: [], viewer: { ...viewer, guildName: scan.guild.name, found: false, why: err.message } };
        }
    }
    const channels = scan.channels
        .filter((c) => !allowed || allowed.has(c.id))
        .map(({ overwrites, ...c }) => ({
            ...c,
            webhooks: scan.webhooks
                .filter((w) => w.channelId === c.id)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(publicWebhook),
        }));
    return { ...meta, guild, channels, ...(viewer ? { viewer: { ...viewer, guildName: scan.guild.name, found: true } } : {}) };
};

/** Reload (the page's button): ask the bot now, unless it was asked less than 10 minutes ago. */
const reload = async (auth) => {
    await loadScan({ manual: true });
    return targets({ auth });
};

/** A webhook of the list with its channel; refuses one staff may not use. */
const webhookFor = (auth, id) => {
    const scan = requireScan();
    const w = scan.webhooks.find((x) => x.id === String(id || ""));
    if (!w) throw httpError(404, "That webhook is not in the list — press Reload, or open one of its messages by link");
    const viewer = checkChannel(auth, w.channelId);
    return { w, scan, viewer, channel: scan.channels.find((c) => c.id === w.channelId) || { id: w.channelId, name: null, type: "text" } };
};

const tokenOf = (w) => {
    if (!w.token) throw bad(`${w.name}: ${why(w)}`);
    const t = unlock(w.token);
    if (!t) throw httpError(500, "The webhook's token cannot be read (JWT_SECRET changed?) — press Reload");
    return t;
};

// ── Discord's webhook API ────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Discord's "Invalid Form Body" → "embeds.0.image.url: Not a well formed URL." */
const formErrors = (errors, path = []) => {
    if (!errors || typeof errors !== "object") return [];
    if (Array.isArray(errors._errors)) return errors._errors.map((e) => `${path.join(".") || "message"}: ${e.message}`);
    return Object.entries(errors).flatMap(([k, v]) => formErrors(v, [...path, k]));
};

const discordError = (status, data) => {
    const code = data?.code;
    if (code === 10015) return httpError(410, "This webhook was deleted on Discord", { gone: true });
    if (code === 10008) return httpError(404, "That message does not exist any more", { missing: true });
    if (code === 10003) return httpError(404, "That thread or channel does not exist any more");
    if (code === 40005 || status === 413) return httpError(413, "The files are too big for this server on Discord (10 MB without boosts)");
    const detail = code === 50035 ? formErrors(data.errors).slice(0, 3).join("; ") : "";
    const text = `Discord: ${data?.message || `HTTP ${status}`}${detail ? ` — ${detail}` : ""}`;
    return httpError(status >= 400 && status < 500 ? 400 : 502, text, { code });
};

/**
 * One call to a webhook: JSON, or multipart when there are files (payload_json
 * + files[n]). A 429 waits as Discord asks (twice at most, 10 s each).
 */
const discord = async (method, path, { query = {}, body, files = [], timeoutMs = 30_000 } = {}) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== false && v !== "").map(([k, v]) => [k, String(v)])).toString();
    const signal = AbortSignal.timeout(timeoutMs);
    for (let attempt = 0; ; attempt++) {
        const init = { method, headers: { "user-agent": "ArnTo-panel (webhooks)" }, signal };
        if (files.length) {
            const form = new FormData();
            form.append("payload_json", JSON.stringify(body || {}));
            files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buffer], { type: f.type || "application/octet-stream" }), f.name));
            init.body = form;
        } else if (body !== undefined) {
            init.headers["content-type"] = "application/json";
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, init);
        } catch (err) {
            throw httpError(502, err.name === "TimeoutError" ? "Discord did not answer in time" : `Discord cannot be reached: ${err.message}`);
        }
        if (res.status === 429 && attempt < 2) {
            const data = await res.json().catch(() => ({}));
            await sleep(Math.min(Math.max(Number(data.retry_after) || 1, 0.5), 10) * 1000);
            continue;
        }
        if (res.status === 204) return null;
        const data = await res.json().catch(() => null);
        if (!res.ok) throw discordError(res.status, data);
        return data;
    }
};

/** A call that loses the webhook (deleted on Discord) also takes it out of the list. */
const call = async (w, method, path, opts) => {
    try {
        return await discord(method, `/webhooks/${w.id}/${tokenOf(w)}${path}`, opts);
    } catch (err) {
        if (err.gone) {
            dropWebhook(w.id);
            throw httpError(410, `${w.name} was deleted on Discord — it is out of the list now`);
        }
        throw err;
    }
};

// ── A message ────────────────────────────────────────────────────────────────

const httpUrl = (v, what) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    let u;
    try {
        u = new URL(s);
    } catch {
        throw bad(`${what} is not a link: "${s.slice(0, 80)}"`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw bad(`${what} must start with https://`);
    if (s.length > 2048) throw bad(`${what} is too long`);
    return s;
};

/** The name and picture a message is posted with (empty: the webhook's own). */
const profileOf = (input = {}) => {
    const username = String(input.username ?? "").trim();
    if (username.length > NAME_MAX) throw bad(`The name is ${username.length} characters — Discord allows ${NAME_MAX}`);
    if (/clyde|discord/i.test(username)) throw bad('Discord does not allow "discord" or "clyde" in a webhook\'s name');
    return { username: username || undefined, avatarUrl: httpUrl(input.avatarUrl, "The avatar") };
};

const snowflakeOr = (v, what) => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (!SNOWFLAKE.test(s)) throw bad(what);
    return s;
};

/** Where in the channel: a thread / forum post (threadId), or a new forum post (threadName). */
const placeOf = (channel, input = {}) => {
    const threadId = snowflakeOr(input.threadId, "The thread must be a thread's link or id");
    const threadName = String(input.threadName ?? "").trim();
    if (threadName.length > THREAD_NAME_MAX) throw bad(`The post title is ${threadName.length} characters — Discord allows ${THREAD_NAME_MAX}`);
    const posts = POSTS.has(channel.type);
    if (posts && !threadId && !threadName) throw bad(`#${channel.name || channel.id} is a forum — give the new post a title, or pick a post to answer`);
    if (!posts && threadName && !threadId) throw bad("Only a forum's webhook can open a new post — in a text channel, pick a thread or leave it empty");
    return { threadId, threadName: threadId ? null : threadName || null };
};

/** Same rule on both sides (the page shows the result): ASCII letters, digits, _ - . — what attachment:// can name. */
const fileName = (name, i) => {
    const s = String(name || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(-100);
    return s || `file-${i + 1}`;
};

/** multer's files + the names the page gave them (multer reads names as latin1). */
const filesOf = (files = [], names = []) => {
    if (files.length > FILES_MAX) throw bad(`${files.length} files — Discord allows ${FILES_MAX} per message`);
    const total = files.reduce((n, f) => n + (f.size || f.buffer?.length || 0), 0);
    if (total > FILES_BYTES) throw bad(`The files are ${(total / 1048576).toFixed(1)} MB together — at most ${FILES_BYTES / 1048576} MB`);
    return files.map((f, i) => ({ name: fileName(names[i]?.name || names[i] || f.originalname, i), type: f.mimetype, buffer: f.buffer, size: f.size || f.buffer?.length || 0 }));
};

const allowedMentions = (m) => ({ parse: [...(m.users ? ["users"] : []), ...(m.roles ? ["roles"] : []), ...(m.everyone ? ["everyone"] : [])] });

const optionsOf = (input = {}) => {
    const o = messages.normalizeOptions(input);
    return { mentions: o.mentions, silent: o.silent, suppressEmbeds: input.suppressEmbeds === true || input.suppressEmbeds === "true" };
};

const attachmentOf = (a) => ({ id: a.id, filename: a.filename, url: a.url, size: a.size, contentType: a.content_type || null, width: a.width || null, height: a.height || null });

/** Discord's message → the editor's (content / rich embeds / components) + its files. */
const readMessage = (m = {}) => ({
    message: {
        content: m.content || "",
        embeds: (m.embeds || []).filter((e) => !e.type || e.type === "rich"),
        components: m.components || [],
    },
    attachments: (m.attachments || []).map(attachmentOf),
    v2: !!((m.flags || 0) & (1 << 15)),
});

const onlyLinks = (rows) => (rows || []).every((r) => (r.components || []).every((c) => c.type === 2 && c.style === 5 && c.url));

// ── History ──────────────────────────────────────────────────────────────────

const getRow = (id) => conn().prepare("SELECT * FROM webhook_messages WHERE id = ?").get(String(id));
const byMessage = (messageId) => conn().prepare("SELECT * FROM webhook_messages WHERE message_id = ?").get(String(messageId));

const prune = () =>
    conn()
        .prepare("DELETE FROM webhook_messages WHERE MAX(sent_at, COALESCE(edited_at, 0), COALESCE(deleted_at, 0)) < ?")
        .run(Date.now() - SENT_KEEP_MS);

const listSent = ({ limit = 100, auth } = {}) => {
    const n = Math.min(Math.max(parseInt(limit) || 100, 1), SENT_LIST_MAX);
    prune();
    let rows = conn().prepare("SELECT * FROM webhook_messages ORDER BY sent_at DESC").all();
    const viewer = messages.viewerOf(auth);
    if (viewer) {
        let allowed = null;
        try {
            allowed = allowedFor(auth);
        } catch {
            /* fall back to their own sends */
        }
        rows = rows.filter((r) => (allowed ? allowed.has(r.channel_id) : parse(r.sent_by)?.id === viewer.userId));
    }
    return rows.slice(0, n).map(rowToSent);
};

const forget = (id, auth) => {
    const r = getRow(id);
    if (!r) throw httpError(404, "Not in the list");
    checkChannel(auth, r.channel_id);
    conn().prepare("DELETE FROM webhook_messages WHERE id = ?").run(r.id);
    return { forgotten: r.id };
};

// ── Sending, editing, deleting ───────────────────────────────────────────────

const pingText = (msg, opts) => {
    const p = messages.pingsOf(msg.content);
    const out = [];
    if (opts.mentions.everyone && p.everyone) out.push("@everyone");
    if (opts.mentions.everyone && p.here) out.push("@here");
    if (opts.mentions.roles && p.roles.length) out.push(`${p.roles.length} role${p.roles.length === 1 ? "" : "s"}`);
    return out.length ? ` · mentions ${out.join(", ")}${opts.silent ? " (silent)" : ""}` : "";
};

const whereText = (channel, threadName) => `**#${channel.name || channel.id}**${threadName ? ` › ${threadName}` : ""}`;

const logLine = (actor, text) => panelLog.add(actor.kind === "staff" ? "staff" : "owner", `🪝 ${messages.actorText(actor)} ${text}`);

/**
 * Post one message through a webhook. input: { webhookId, threadId?, threadName?,
 * message, username?, avatarUrl?, mentions, silent, suppressEmbeds, files: [names] }.
 */
const send = async (input = {}, uploads = [], auth) => {
    const { w, scan, channel } = webhookFor(auth, input.webhookId);
    const files = filesOf(uploads, input.files);
    const msg = messages.normalizeMessage(input.message, { attachments: true, files: files.length });
    const opts = optionsOf(input);
    const profile = profileOf(input);
    const place = placeOf(channel, input);
    const actor = messages.actorOf(auth);
    const flags = (opts.silent ? FLAG.silent : 0) | (opts.suppressEmbeds ? FLAG.suppressEmbeds : 0);
    const body = {
        ...(msg.content ? { content: msg.content } : {}),
        embeds: msg.embeds,
        components: msg.components || [],
        ...(profile.username ? { username: profile.username } : {}),
        ...(profile.avatarUrl ? { avatar_url: profile.avatarUrl } : {}),
        allowed_mentions: allowedMentions(opts.mentions),
        ...(flags ? { flags } : {}),
        ...(place.threadName ? { thread_name: place.threadName } : {}),
        ...(files.length ? { attachments: files.map((f, i) => ({ id: i, filename: f.name })) } : {}),
    };
    const res = await call(w, "POST", "", { query: { wait: true, with_components: true, thread_id: place.threadId }, body, files });

    const threadId = res.channel_id && res.channel_id !== w.channelId ? String(res.channel_id) : null;
    const threadName = place.threadName || input.threadLabel || null;
    const payload = { message: msg, username: profile.username || null, avatarUrl: profile.avatarUrl || null, attachments: (res.attachments || []).map(attachmentOf) };
    const id = crypto.randomUUID();
    conn()
        .prepare(
            "INSERT INTO webhook_messages (id, status, guild_id, channel_id, channel_name, thread_id, thread_name, webhook_id, webhook_name, message_id, payload, options, sent_by, sent_at) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, scan.guild.id, w.channelId, channel.name || null, threadId, threadName ? String(threadName).slice(0, 100) : null, w.id, w.name, String(res.id), json(payload), json(opts), json(actor), Date.now());
    prune();
    const row = rowToSent(getRow(id));
    logLine(actor, `sent a message as **${profile.username || w.name}** in ${whereText(channel, threadName)}${pingText(msg, opts)}${files.length ? ` · ${files.length} file${files.length === 1 ? "" : "s"}` : ""} — ${row.url}`);
    return row;
};

const refOf = (input = {}) => {
    const messageId = snowflakeOr(input.messageId, "Which message?");
    if (!messageId) throw bad("Which message?");
    return { messageId, threadId: snowflakeOr(input.threadId, "The thread must be a thread's id") };
};

/**
 * Change a message its webhook sent. keepAttachments: the ids of its files to
 * keep (the rest go); new files are added. The name and picture cannot change
 * (Discord keeps the ones it was posted with), and an edit pings nobody.
 */
const edit = async (input = {}, uploads = [], auth) => {
    const { w, scan, channel } = webhookFor(auth, input.webhookId);
    const ref = refOf(input);
    const files = filesOf(uploads, input.files);
    const keepIds = [...new Set((Array.isArray(input.keepAttachments) ? input.keepAttachments : []).map(String).filter((x) => SNOWFLAKE.test(x)))];
    if (keepIds.length + files.length > FILES_MAX) throw bad(`${keepIds.length + files.length} files — Discord allows ${FILES_MAX} per message`);
    const msg = messages.normalizeMessage(input.message, { edit: true, attachments: true, files: keepIds.length + files.length });
    const opts = optionsOf(input);
    const actor = messages.actorOf(auth);
    const body = {
        content: msg.content || "",
        embeds: msg.embeds,
        ...(msg.components === null ? {} : { components: msg.components }),
        allowed_mentions: allowedMentions(opts.mentions),
        ...(typeof input.suppressEmbeds === "boolean" ? { flags: input.suppressEmbeds ? FLAG.suppressEmbeds : 0 } : {}),
        attachments: [...keepIds.map((id) => ({ id })), ...files.map((f, i) => ({ id: i, filename: f.name }))],
    };
    const res = await call(w, "PATCH", `/messages/${ref.messageId}`, { query: { with_components: true, thread_id: ref.threadId }, body, files });

    const now = Date.now();
    const read = readMessage(res);
    const cur = byMessage(ref.messageId);
    const payload = { ...(parse(cur?.payload) || {}), message: { ...msg, components: msg.components === null ? read.message.components : msg.components }, attachments: read.attachments };
    if (!payload.username && res.author?.username && res.author.username !== w.name) payload.username = res.author.username;
    if (cur) {
        conn().prepare("UPDATE webhook_messages SET status = 'sent', payload = ?, options = ?, edited_by = ?, edited_at = ? WHERE id = ?").run(json(payload), json(opts), json(actor), now, cur.id);
    } else {
        conn()
            .prepare(
                "INSERT INTO webhook_messages (id, status, guild_id, channel_id, channel_name, thread_id, thread_name, webhook_id, webhook_name, message_id, payload, options, sent_by, sent_at, edited_by, edited_at) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
            )
            .run(
                crypto.randomUUID(),
                scan.guild.id,
                w.channelId,
                channel.name || null,
                ref.threadId,
                input.threadLabel ? String(input.threadLabel).slice(0, 100) : null,
                w.id,
                w.name,
                ref.messageId,
                json(payload),
                json(opts),
                res.timestamp ? Date.parse(res.timestamp) || now : now,
                json(actor),
                now,
            );
        prune();
    }
    const row = rowToSent(byMessage(ref.messageId));
    logLine(actor, `edited a message of **${w.name}** in ${whereText(channel, row.threadName)} — ${row.url}`);
    return row;
};

/** Delete a message its webhook sent. One that is already gone counts as deleted. */
const remove = async (input = {}, auth) => {
    const { w, channel } = webhookFor(auth, input.webhookId);
    const ref = refOf(input);
    const actor = messages.actorOf(auth);
    let missing = false;
    try {
        await call(w, "DELETE", `/messages/${ref.messageId}`, { query: { thread_id: ref.threadId } });
    } catch (err) {
        if (!err.missing) throw err;
        missing = true;
    }
    const cur = byMessage(ref.messageId);
    if (cur) conn().prepare("UPDATE webhook_messages SET status = 'deleted', deleted_by = ?, deleted_at = ? WHERE id = ?").run(json(actor), Date.now(), cur.id);
    logLine(actor, `deleted a message of **${w.name}** in ${whereText(channel, cur?.thread_name)}${missing ? " (it was already gone)" : ""}`);
    return { deleted: true, missing, row: cur ? rowToSent(getRow(cur.id)) : null };
};

// ── Reading a message ────────────────────────────────────────────────────────

/** Can this message be edited here, and if not, why. */
const verdict = ({ kind, w, v2, detail }) => {
    if (kind === "interaction") return "It is a bot's answer to a command, not a webhook message — it can only be copied";
    if (kind === "bot") return "It was posted by a bot, not a webhook — a message of ArnTo-assistant is edited on the Messages page";
    if (kind === "user") return "It was posted by a member, not a webhook — it can only be copied";
    if (kind === "gone") return "Its webhook was deleted, so nobody can edit it any more — it can only be copied";
    if (kind === "hidden") return `The bot cannot read the webhook that sent it${detail ? ` (${detail})` : ""} — it can only be copied`;
    if (!w?.token) return why(w || {});
    if (v2) return "It uses Discord's newer layout (Components V2), which this editor cannot open";
    return null;
};

/** What the page gets for an opened message (by link, or a Sent row). */
const described = ({ scan, w, kind, place, read, author, createdAt, editedAt, detail }) => {
    const reason = verdict({ kind, w, v2: read.v2, detail });
    const channel = scan.channels.find((c) => c.id === place.channelId);
    const sent = byMessage(place.messageId);
    return {
        guildId: scan.guild.id,
        channelId: place.channelId,
        channelName: channel?.name || place.channelName || null,
        threadId: place.threadId || null,
        threadName: place.threadName || null,
        messageId: place.messageId,
        url: linkOf(scan.guild.id, place.threadId || place.channelId, place.messageId),
        createdAt: createdAt || null,
        editedAt: editedAt || null,
        author: author || null,
        kind,
        webhook: w ? publicWebhook(w) : null,
        editable: !reason,
        why: reason,
        keepsComponents: !reason && !onlyLinks(read.message.components),
        ...read,
        sent: sent ? rowToSent(sent) : null,
    };
};

/**
 * Read a message by its link: the bot reads it and says which webhook sent it
 * (with that webhook's token, sealed) — nothing to pick by hand.
 */
const fetchByLink = async (link, auth) => {
    const ref = messages.parseLink(link);
    const scan = requireScan();
    if (ref.guildId && ref.guildId !== scan.guild.id) throw bad(`That message is not in ${scan.guild.name || "the shop's server"} — this page only uses that server's webhooks`);
    const viewer = messages.viewerOf(auth);
    if (viewer) allowedFor(auth); // staff who cannot use the page at all stop here
    const bot = handler(CMD.fetch);
    const res = await discordBus.request(bot, CMD.fetch, { guildId: scan.guild.id, channelId: ref.channelId, messageId: ref.messageId, ...(viewer ? { viewer } : {}) }, { timeoutMs: 25_000 });
    const home = String(res.parentId || res.channelId || ref.channelId); // the channel a webhook belongs to
    checkChannel(auth, home);
    let w = null;
    if (res.webhook?.id) w = remember(res.webhook, "link");
    else if (res.webhookId) w = scan.webhooks.find((x) => x.id === String(res.webhookId)) || null;
    const kind = res.webhookId ? (res.interaction ? "interaction" : w ? "webhook" : res.webhookError ? "hidden" : "gone") : res.author?.bot ? "bot" : "user";
    return described({
        scan: currentScan(),
        w: kind === "webhook" ? w : null,
        kind,
        detail: res.webhookError,
        place: { channelId: home, channelName: res.parentName || res.channelName, threadId: res.parentId ? String(res.channelId) : null, threadName: res.parentId ? res.channelName : null, messageId: ref.messageId },
        read: readMessage(res.message || {}),
        author: res.author ? { username: res.author.username, avatar: res.author.avatar || null, bot: !!res.author.bot } : null,
        createdAt: res.createdAt,
        editedAt: res.editedAt,
    });
};

/** A message read through its own webhook (a Sent row) — no bot needed. */
const readThroughWebhook = async ({ webhookId, messageId, threadId } = {}, auth) => {
    const { w, scan } = webhookFor(auth, webhookId);
    const ref = refOf({ messageId, threadId });
    const m = await call(w, "GET", `/messages/${ref.messageId}`, { query: { thread_id: ref.threadId } });
    const sent = byMessage(ref.messageId);
    return described({
        scan,
        w,
        kind: "webhook",
        place: { channelId: w.channelId, threadId: ref.threadId, threadName: sent?.thread_name || null, messageId: ref.messageId },
        read: readMessage(m),
        author: m.author ? { username: m.author.username, avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=128` : null, bot: true } : null,
        createdAt: m.timestamp ? Date.parse(m.timestamp) : null,
        editedAt: m.edited_timestamp ? Date.parse(m.edited_timestamp) : null,
    });
};

// ── New webhooks ─────────────────────────────────────────────────────────────

/**
 * ArnTo-selfbot makes a webhook in a channel (ArnTo-assistant relays it with a
 * command in that channel, deleted right after) → it joins the list at once.
 */
const create = async ({ channelId, name, avatarUrl } = {}, auth) => {
    const scan = requireScan();
    const channel = scan.channels.find((c) => c.id === String(channelId || ""));
    if (!channel) throw bad("Pick a channel");
    const viewer = checkChannel(auth, channel.id);
    const n = String(name ?? "").trim();
    if (!n) throw bad("Give the webhook a name");
    if (n.length > NAME_MAX) throw bad(`The name is ${n.length} characters — Discord allows ${NAME_MAX}`);
    if (/clyde|discord/i.test(n)) throw bad('Discord does not allow "discord" or "clyde" in a webhook\'s name');
    const avatar = httpUrl(avatarUrl, "The avatar");
    const bot = handler(CMD.create);
    const actor = messages.actorOf(auth);
    // The assistant waits up to 20 s for the selfbot; a command it sees later than notAfter makes nothing.
    const res = await discordBus.request(
        bot,
        CMD.create,
        { guildId: scan.guild.id, channelId: channel.id, name: n, ...(avatar ? { avatar } : {}), ...(viewer ? { viewer } : {}), notAfter: Date.now() + CREATE_WINDOW_MS },
        { timeoutMs: 45_000 },
    );
    if (!res?.id || !res.token) throw httpError(502, "The selfbot made no usable webhook");
    const w = remember({ ...res, channelId: res.channelId || channel.id }, "created");
    logLine(actor, `made the webhook **${w.name}** in **#${channel.name}**`);
    return publicWebhook(w);
};

// ── Saved messages ───────────────────────────────────────────────────────────

const draftInput = (input = {}, { partial = false } = {}) => {
    const out = {};
    if (!partial || input.name !== undefined) {
        const name = String(input.name ?? "").trim().slice(0, 100);
        if (!name) throw bad("Give the saved message a name");
        out.name = name;
    }
    if (!partial || input.messages !== undefined) {
        if (!Array.isArray(input.messages) || !input.messages.length) throw bad("No message to save");
        if (input.messages.length > MAX_MESSAGES) throw bad(`At most ${MAX_MESSAGES} messages`);
        const target = input.target && typeof input.target === "object" ? input.target : {};
        const s = JSON.stringify({
            messages: input.messages,
            target: { webhookId: SNOWFLAKE.test(String(target.webhookId || "")) ? String(target.webhookId) : null, threadId: target.threadId ? String(target.threadId).slice(0, 200) : null, threadName: target.threadName ? String(target.threadName).slice(0, THREAD_NAME_MAX) : null },
            options: optionsOf(input.options || {}),
        });
        if (Buffer.byteLength(s) > MAX_DRAFT_BYTES) throw bad("The messages are too big to save");
        out.payload = s;
    }
    return out;
};

const listDrafts = () => conn().prepare("SELECT * FROM webhook_drafts ORDER BY updated_at DESC").all().map(rowToDraft);

const createDraft = (input, auth) => {
    const d = draftInput(input);
    if (conn().prepare("SELECT COUNT(*) n FROM webhook_drafts").get().n >= MAX_DRAFTS) throw bad(`At most ${MAX_DRAFTS} saved messages — delete some first`);
    const id = crypto.randomUUID();
    const now = Date.now();
    const who = json(messages.actorOf(auth));
    conn().prepare("INSERT INTO webhook_drafts (id, name, payload, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, d.name, d.payload, who, now, who, now);
    return rowToDraft(conn().prepare("SELECT * FROM webhook_drafts WHERE id = ?").get(id));
};

const updateDraft = (id, input, auth) => {
    const cur = conn().prepare("SELECT * FROM webhook_drafts WHERE id = ?").get(String(id));
    if (!cur) throw httpError(404, "Saved message not found");
    const d = draftInput(input, { partial: true });
    conn()
        .prepare("UPDATE webhook_drafts SET name = ?, payload = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(d.name ?? cur.name, d.payload ?? cur.payload, json(messages.actorOf(auth)), Date.now(), cur.id);
    return rowToDraft(conn().prepare("SELECT * FROM webhook_drafts WHERE id = ?").get(cur.id));
};

const deleteDraft = (id) => {
    const res = conn().prepare("DELETE FROM webhook_drafts WHERE id = ?").run(String(id));
    if (!res.changes) throw httpError(404, "Saved message not found");
    return { deleted: String(id) };
};

// ── Start ────────────────────────────────────────────────────────────────────

const tick = () => {
    try {
        prune();
    } catch (err) {
        console.warn(`[Webhooks] Old Sent rows not removed: ${err.message}`);
    }
    return dailyTick().catch(() => {});
};

const start = () => {
    conn();
    setTimeout(lifecycle.guard(tick), 75_000); // the bus needs a moment after a start
    setInterval(lifecycle.guard(tick), CHECK_MS);
};

module.exports = {
    CMD,
    FILES_MAX,
    FILES_BYTES,
    start,
    status,
    targets,
    reload,
    create,
    fetchByLink,
    readThroughWebhook,
    send,
    edit,
    remove,
    listSent,
    forget,
    listDrafts,
    createDraft,
    updateDraft,
    deleteDraft,
    // for tests
    dailyTick,
    prune,
    fileName,
    SENT_KEEP_MS,
};
