const crypto = require("crypto");
const { EventEmitter } = require("events");
const db = require("../db");
const sharedStore = require("./sharedStore");
const apiKeys = require("./apiKeyService");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  Discord bus — how the panel tells a bot to do something.
//
//  The panel never calls a bot over the network (it would have to know where
//  the bot runs). Instead its own Discord bot (PANEL_DISCORD_TOKEN) posts the
//  command in one private channel (PANEL_BUS_CHANNEL_ID), mentioning the target
//  bot; the bot acts and replies to that message, mentioning the panel. Mentions
//  are what let both sides read the text without the privileged Message
//  Content intent.
//
//  Every envelope is HMAC-signed with the TARGET project's own API key (both
//  sides hold it: the panel encrypted in apiKeyService, the bot in its .env as
//  PANEL_API_KEY), so nobody else who can post in the channel can forge a
//  command or a reply. The bot library (bot-lib/PanelBus.js) re-reads the
//  channel on start and every few minutes, so a bot that was down still gets
//  everything, and it never runs the same id twice.
//
//  The outbox lives in data/shared.sqlite: queued commands survive a restart
//  or a panel move, and the Panel page can show what was delivered.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = 1;
const SEND_EVERY_MS = 1200; // one message per 1.2 s — Discord allows ~5 per 5 s per channel
const INLINE_MAX = 1700; // bigger envelopes travel as an attached JSON file
const TAG = "panel-bus";

const events = new EventEmitter();
let client = null;
let ready = false;
let lastError = null;
let worker = null;
let replyWorker = null;

const configured = () => !!(process.env.PANEL_DISCORD_TOKEN && process.env.PANEL_BUS_CHANNEL_ID);
const channelId = () => process.env.PANEL_BUS_CHANNEL_ID || null;

// ── Outbox ───────────────────────────────────────────────────────────────────

const table = () => {
    const c = sharedStore.raw();
    c.exec(`
        CREATE TABLE IF NOT EXISTS bus (
            id TEXT PRIMARY KEY,
            target TEXT NOT NULL,          -- project (bot record) _id
            cmd TEXT NOT NULL,
            payload TEXT,
            status TEXT NOT NULL,          -- queued | sent | done | failed
            message_id TEXT,
            result TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS bus_by_status ON bus(status, created_at);
    `);
    return c;
};

const rowToPublic = (r) =>
    r && {
        id: r.id,
        target: r.target,
        cmd: r.cmd,
        status: r.status,
        messageId: r.message_id,
        result: r.result ? JSON.parse(r.result) : null,
        error: r.error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };

const setStatus = (id, patch) => {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    table().prepare(`UPDATE bus SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
};

// ── Signing ──────────────────────────────────────────────────────────────────

const canonical = (e) => [e.v, e.id, e.ts, e.kind, e.cmd || "", JSON.stringify(e.body ?? null)].join("\n");
const sign = (key, e) => crypto.createHmac("sha256", key).update(canonical(e)).digest("hex");
const verify = (key, e) => {
    if (!key || typeof e?.sig !== "string") return false;
    const want = Buffer.from(sign(key, e), "hex");
    const got = Buffer.from(e.sig, "hex");
    return want.length === got.length && crypto.timingSafeEqual(want, got);
};

/** Envelope ↔ message: a code block when small, an attached JSON file otherwise. */
const toMessage = (mentionId, label, envelope) => {
    const json = JSON.stringify(envelope);
    const head = `<@${mentionId}> \`${TAG}\` ${label}`;
    if (json.length <= INLINE_MAX) return { content: `${head}\n\`\`\`json\n${json}\n\`\`\``, allowedMentions: { users: [mentionId] } };
    return {
        content: head,
        files: [{ attachment: Buffer.from(json), name: `${TAG}-${envelope.id}.json` }],
        allowedMentions: { users: [mentionId] },
    };
};

const fromMessage = async (msg) => {
    const block = /```json\n([\s\S]+?)\n```/.exec(msg.content || "");
    try {
        if (block) return JSON.parse(block[1]);
        const file = [...(msg.attachments?.values?.() || [])].find((a) => a.name?.startsWith(TAG));
        if (!file) return null;
        const res = await fetch(file.url);
        return res.ok ? JSON.parse(await res.text()) : null;
    } catch {
        return null;
    }
};

// ── Targets ──────────────────────────────────────────────────────────────────

/** A project that can receive commands: its Discord bot id and its own key. */
const targetOf = async (botId) => {
    const bot = await db.findOne("bots", { _id: botId });
    if (!bot) throw Object.assign(new Error("Project not found"), { status: 404 });
    if (!/^\d{17,20}$/.test(String(bot.botID || ""))) {
        throw Object.assign(new Error(`${bot.name} has no Discord bot id`), { status: 400 });
    }
    const key = await apiKeys.keyFor(bot._id);
    if (!key) throw Object.assign(new Error(`${bot.name} has no API key — create one under Panel Settings → API Keys`), { status: 400 });
    return { bot, discordId: String(bot.botID), key };
};

// ── Sending ──────────────────────────────────────────────────────────────────

/** Queue a command. → the outbox row. Delivery happens in the worker. */
const enqueue = async (botId, cmd, payload = null) => {
    await targetOf(botId); // fail fast on a project that cannot receive
    const id = crypto.randomUUID();
    const now = Date.now();
    table()
        .prepare("INSERT INTO bus (id, target, cmd, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
        .run(id, botId, cmd, JSON.stringify(payload ?? null), now, now);
    kick();
    return rowToPublic(table().prepare("SELECT * FROM bus WHERE id = ?").get(id));
};

/** Fire and forget (the reply is still recorded). */
const notify = (botId, cmd, payload) => enqueue(botId, cmd, payload);

/** Send and wait for the bot's reply → its result; throws its error or on timeout. */
const request = async (botId, cmd, payload, { timeoutMs = 30_000 } = {}) => {
    const row = await enqueue(botId, cmd, payload);
    return new Promise((resolve, reject) => {
        const onDone = (r) => {
            if (r.id !== row.id) return;
            clearTimeout(timer);
            events.off("done", onDone);
            if (r.status === "done") resolve(r.result);
            else reject(Object.assign(new Error(r.error || "The bot reported a failure"), { status: 502 }));
        };
        const timer = setTimeout(() => {
            events.off("done", onDone);
            reject(
                Object.assign(new Error(`No answer from the bot within ${Math.round(timeoutMs / 1000)}s — it will still run the command when it sees it`), {
                    status: 504,
                }),
            );
        }, timeoutMs);
        events.on("done", onDone);
    });
};

const sendOne = async (r) => {
    const { discordId, key } = await targetOf(r.target);
    const channel = await client.channels.fetch(channelId());
    const envelope = { v: VERSION, id: r.id, ts: Date.now(), kind: "cmd", cmd: r.cmd, body: JSON.parse(r.payload) };
    envelope.sig = sign(key, envelope);
    const msg = await channel.send(toMessage(discordId, `${r.cmd} · ${r.id}`, envelope));
    setStatus(r.id, { status: "sent", message_id: msg.id });
};

let pumping = false;
const pump = async () => {
    // One message at a time: a slow send must never let a second tick post the same row.
    if (pumping || !ready || !lifecycle.isActive()) return;
    const r = table().prepare("SELECT * FROM bus WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
    if (!r) return;
    pumping = true;
    try {
        await sendOne(r);
    } catch (err) {
        // A project that cannot receive never will — fail it; anything else retries.
        if (err.status === 400 || err.status === 404) {
            setStatus(r.id, { status: "failed", error: err.message });
            events.emit("done", rowToPublic(table().prepare("SELECT * FROM bus WHERE id = ?").get(r.id)));
        } else {
            lastError = err.message;
            console.warn(`[Bus] Could not post ${r.cmd} (${r.id}): ${err.message} — will retry`);
        }
    } finally {
        pumping = false;
    }
};

let kickTimer = null;
const kick = () => {
    if (kickTimer) return;
    kickTimer = setTimeout(() => {
        kickTimer = null;
        pump().catch(() => {});
    }, 0);
};

// ── Receiving replies ────────────────────────────────────────────────────────

const onMessage = async (msg) => {
    if (msg.channelId !== channelId() || msg.author?.id === client.user.id) return;
    if (!msg.mentions?.users?.has(client.user.id) && !String(msg.content || "").includes(`<@${client.user.id}>`)) return;
    const env = await fromMessage(msg);
    if (!env || env.kind !== "reply" || typeof env.id !== "string") return;
    const r = table().prepare("SELECT * FROM bus WHERE id = ?").get(env.id);
    if (!r || r.status === "done" || r.status === "failed") return;
    let target;
    try {
        target = await targetOf(r.target);
    } catch {
        return;
    }
    if (msg.author.id !== target.discordId || !verify(target.key, env)) {
        console.warn(`[Bus] Ignored an unsigned or foreign reply for ${env.id} from ${msg.author?.tag}`);
        return;
    }
    const ok = env.body?.ok === true;
    setStatus(r.id, {
        status: ok ? "done" : "failed",
        result: ok ? JSON.stringify(env.body.result ?? null) : null,
        error: ok ? null : String(env.body?.error || "failed").slice(0, 500),
    });
    events.emit("done", rowToPublic(table().prepare("SELECT * FROM bus WHERE id = ?").get(r.id)));
};

/**
 * Replies posted while this panel was restarting (or moving) are read back
 * from the channel — the last 3 days, as far as the bots themselves look.
 * A command still unanswered after that is marked failed rather than left
 * "sent" forever.
 */
const CATCH_UP_MS = 3 * 86_400_000;
let catchingUp = false;
const catchUpReplies = async () => {
    if (catchingUp || !ready || !client || !lifecycle.isActive()) return;
    catchingUp = true;
    try {
        const cutoff = Date.now() - CATCH_UP_MS;
        const open = table().prepare("SELECT COUNT(*) AS c FROM bus WHERE status = 'sent'").get().c;
        if (open) {
            const channel = await client.channels.fetch(channelId());
            let before;
            for (let page = 0; page < 5; page++) {
                const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                if (!batch.size) break;
                for (const m of batch.values()) await onMessage(m).catch(() => {});
                const oldest = batch.last();
                before = oldest.id;
                if (oldest.createdTimestamp < cutoff) break;
            }
        }
        table()
            .prepare("UPDATE bus SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('sent', 'queued') AND created_at < ?")
            .run("No answer within 3 days — the bot never ran it", Date.now(), cutoff);
    } catch (err) {
        lastError = err.message;
    } finally {
        catchingUp = false;
    }
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

const start = async () => {
    if (!configured()) {
        console.log("[Bus] PANEL_DISCORD_TOKEN / PANEL_BUS_CHANNEL_ID not set — the Discord bus is off");
        return;
    }
    table();
    const { Client, GatewayIntentBits, Events } = require("discord.js");
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
    client.on("messageCreate", (m) => onMessage(m).catch((e) => console.warn("[Bus] reply handling:", e.message)));
    client.once(Events.ClientReady, async () => {
        try {
            const ch = await client.channels.fetch(channelId());
            if (!ch?.isTextBased?.()) throw new Error("PANEL_BUS_CHANNEL_ID is not a text channel");
            ready = true;
            lastError = null;
            // Where the bots find the panel's identity (bot-lib reads it from the manifest).
            kvSet("__bus.panelBotId", client.user.id);
            console.log(`[Bus] ${client.user.tag} on #${ch.name} — the Discord bus is up`);
            kick();
            catchUpReplies().catch(() => {});
        } catch (err) {
            lastError = err.message;
            console.error(`[Bus] ${err.message}`);
        }
    });
    client.on("error", (e) => {
        lastError = e.message;
    });
    worker = setInterval(() => pump().catch(() => {}), SEND_EVERY_MS);
    replyWorker = setInterval(() => catchUpReplies().catch(() => {}), 5 * 60 * 1000);
    await client.login(process.env.PANEL_DISCORD_TOKEN).catch((err) => {
        lastError = err.message;
        console.error(`[Bus] Discord login failed: ${err.message}`);
    });
};

/** A replaced panel must not keep talking on the bus. */
const stop = async () => {
    ready = false;
    if (worker) clearInterval(worker);
    if (replyWorker) clearInterval(replyWorker);
    worker = null;
    replyWorker = null;
    if (client) await client.destroy().catch(() => {});
    client = null;
};

const kvGet = (name) => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const panelBotId = () => kvGet("__bus.panelBotId");

// ── What each bot can do ─────────────────────────────────────────────────────
// A bot running the bus library says which commands it handles when it starts
// (POST /api/external/data { op: "hello" }). The panel only puts a command on
// the bus for a bot that announced it — an older bot keeps being reached the
// old way, so a notice is never posted where nobody listens.

const CAPS = "__bus.caps";

const recordHello = (botId, commands) => {
    const caps = kvGet(CAPS) || {};
    caps[botId] = { commands: [...new Set((commands || []).map(String))].slice(0, 100), at: Date.now() };
    kvSet(CAPS, caps);
    return caps[botId];
};

/** Can this project take `cmd` on the bus right now? */
const canHandle = (botId, cmd) => configured() && !!botId && !!(kvGet(CAPS) || {})[botId]?.commands?.includes(cmd);

/** The project that announced `cmd` most recently (e.g. who delivers DMs), or null. */
const handlerOf = (cmd) => {
    if (!configured()) return null;
    const hit = Object.entries(kvGet(CAPS) || {})
        .filter(([, c]) => c.commands?.includes(cmd))
        .sort((a, b) => b[1].at - a[1].at)[0];
    return hit ? hit[0] : null;
};

const capabilities = () => kvGet(CAPS) || {};

const status = () => {
    const counts = configured()
        ? Object.fromEntries(table().prepare("SELECT status, COUNT(*) n FROM bus GROUP BY status").all().map((r) => [r.status, r.n]))
        : {};
    return {
        configured: configured(),
        ready,
        botTag: client?.user?.tag || null,
        botId: client?.user?.id || panelBotId(),
        channelId: channelId(),
        error: lastError,
        counts,
    };
};

/** A Discord user's tag through the panel's bot (any user id), or null when the bus is down. */
const userTag = async (id) => {
    if (!ready || !client) return undefined;
    const u = await client.users.fetch(String(id));
    return u?.tag || u?.username || null;
};

const recent = (limit = 30) =>
    configured() ? table().prepare("SELECT * FROM bus ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToPublic) : [];

module.exports = {
    configured,
    start,
    stop,
    notify,
    request,
    status,
    recent,
    panelBotId,
    channelId,
    recordHello,
    canHandle,
    handlerOf,
    capabilities,
    userTag,
    sign,
    verify,
    canonical,
    VERSION,
    TAG,
};
