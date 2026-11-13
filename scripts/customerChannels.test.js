#!/usr/bin/env node
/**
 * Checks for customer projects, phase 2 (server/services/customerChannels.js and its
 * routes in routes/customerProjects.js): the panel's bot makes a log and a backup
 * channel in the Kho categories, private like their category, with a webhook each, and
 * writes the URLs to the project's .env under its own key names. The URL is kept nowhere
 * else. A key that already has a value is not overwritten unless asked (ENV_TAKEN says
 * where it posts); a full category moves on to the next; missing permissions, a .env that
 * cannot be written or a channel that came out public leave nothing behind. Existing
 * channels can be linked from the .env (only in Kho, never one another project has), and
 * the daily sync renames them after the project, flags deleted channels / webhooks and
 * never waits on Discord's rename rate limit. Discord, the agent and the db are fakes.
 * Run:  node scripts/customerChannels.test.js
 */

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const express = require("express");
const { ChannelType, PermissionFlagsBits, OverwriteType } = require("discord.js");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
let nextId = 1;
const db = {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    create: async (m, d) => {
        d._id = `id${nextId++}`;
        store.set(m, [...(store.get(m) || []), clone(d)]);
        return clone(d);
    },
    find: async (m, q = {}) => clone((store.get(m) || []).filter((e) => match(e, q))),
    findOne: async (m, q) => clone((store.get(m) || []).find((e) => match(e, q))),
    findOneAndUpdate: async (m, q, d) => {
        const arr = store.get(m) || [];
        const i = arr.findIndex((e) => match(e, q));
        if (i === -1) return null;
        arr[i] = { ...arr[i], ...clone(d) };
        return clone(arr[i]);
    },
};
stub("db", db);

// ── A small fake of the Discord the panel's bot sees ─────────────────────────
let snow = 1300000000000000000n;
const sid = () => String(++snow);
const discordError = (code, message) => Object.assign(new Error(message), { code });
const P = (...names) => new Set(names.map((n) => PermissionFlagsBits[n]));
const perms = (set) => ({ has: (flag) => set.has(flag) });

const fake = { down: false, failCreateWithOverwrites: false, comesOutPublic: false, lockFails: false, editHangs: false };
const ME = { id: "me" };
const EVERYONE = { id: "everyone" };
const channels = new Map(); // id → channel or category
const webhooks = new Map(); // id → { id, token, channelId, guildId }
const deleted = [];

const guild = {
    id: "1183033659838697542",
    name: "Kho",
    members: { me: ME },
    roles: { everyone: EVERYONE },
    channels: {
        cache: { get size() { return channels.size; } },
        create: async (opts) => {
            if (opts.permissionOverwrites && fake.failCreateWithOverwrites) throw discordError(50013, "Missing Permissions");
            const parent = channels.get(opts.parent);
            const ch = textChannel({ name: opts.name, topic: opts.topic, parent, synced: !!opts.permissionOverwrites && !fake.comesOutPublic });
            return ch;
        },
    },
};
const otherGuild = { ...guild, id: "999999999999999999", name: "Elsewhere" };

const category = ({ name, open = false, me = P("ViewChannel", "ManageChannels", "ManageWebhooks"), size = 0, g = guild }) => {
    const cat = {
        id: sid(),
        name,
        type: ChannelType.GuildCategory,
        guild: g,
        size,
        children: { cache: { get size() { return cat.size; } } },
        permissionOverwrites: { cache: [{ id: EVERYONE.id, type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }] },
        permissionsFor: (who) => (who === EVERYONE ? perms(open ? P("ViewChannel") : P()) : perms(me)),
    };
    channels.set(cat.id, cat);
    return cat;
};

function textChannel({ name, topic, parent, synced, g = guild }) {
    const ch = {
        id: sid(),
        name,
        topic: topic || null,
        type: ChannelType.GuildText,
        parentId: parent?.id || null,
        guild: parent?.guild || g,
        synced,
        edits: 0,
        permissionsFor: (who) => (who === EVERYONE ? perms(ch.synced && !parent?.permissionsFor(EVERYONE).has(PermissionFlagsBits.ViewChannel) ? P() : P("ViewChannel")) : perms(P("ViewChannel"))),
        lockPermissions: async () => {
            if (fake.lockFails) throw discordError(50013, "Missing Permissions");
            ch.synced = true;
            return ch;
        },
        createWebhook: async ({ name: hookName }) => {
            const w = { id: sid(), name: hookName, token: crypto.randomBytes(24).toString("base64url"), channelId: ch.id, guildId: ch.guild.id };
            w.url = ["https://discord.com", "api", "webhooks", w.id, w.token].join("/");
            webhooks.set(w.id, w);
            return w;
        },
        edit: (opts) => {
            if (fake.editHangs) return new Promise(() => {});
            ch.edits++;
            Object.assign(ch, opts.name ? { name: opts.name } : {}, opts.topic !== undefined ? { topic: opts.topic } : {});
            return Promise.resolve(ch);
        },
        delete: async () => {
            channels.delete(ch.id);
            deleted.push(ch.id);
        },
    };
    channels.set(ch.id, ch);
    if (parent) parent.size++;
    return ch;
}

// Like discord.js: without `force` the bot's cache answers. A category made
// private by hand without the bot in it stops sending the bot updates, so the
// cache keeps its old copy (c.cached) while Discord itself says Missing Access.
const fetchCalls = [];
const client = {
    channels: {
        fetch: async (id, opts = {}) => {
            fetchCalls.push({ id, force: !!opts.force });
            const c = channels.get(id);
            if (!c) throw discordError(10003, "Unknown Channel");
            if (!opts.force && c.cached) return c.cached;
            if (opts.force && c.botHidden) throw discordError(50001, "Missing Access");
            return c;
        },
    },
    fetchWebhook: async (id, token) => {
        const w = webhooks.get(id);
        if (!w || (token && token !== w.token)) throw discordError(10015, "Unknown Webhook");
        return { id: w.id, channelId: w.channelId, guildId: w.guildId };
    },
};

const BOT = "1480411893448573009";
const BUYER = "427399742906040333";
const users = {
    [BOT]: { id: BOT, username: "lofimusic", globalName: "Lofi Music", bot: true },
    [BUYER]: { id: BUYER, username: "khach.a", globalName: "Customer A", bot: false },
};
stub("services/discordBus", {
    fetchUser: async (id) => {
        if (fake.down) return undefined;
        if (!users[id]) throw discordError(10013, "Unknown User");
        return { ...users[id] };
    },
    status: () => ({ ready: !fake.down }),
    discordClient: () => (fake.down ? null : client),
});

const envFiles = {};
const agent = { writeFails: false };
stub("services/executor", {
    fsRead: async (bot) => {
        if (envFiles[bot._id] === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
        return { content: envFiles[bot._id] };
    },
    fsWrite: async (bot, sub, content) => {
        assert.strictEqual(sub, ".env");
        if (agent.writeFails) throw Object.assign(new Error("agent unreachable"), { status: 502 });
        envFiles[bot._id] = content;
    },
});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn });

const LOG1 = category({ name: "logs" });
const LOG2 = category({ name: "logs 2" });
const BACKUP = category({ name: "backups" });

const customers = require("../server/services/customerProjects");
const customerChannels = require("../server/services/customerChannels");
const routes = require("../server/routes/customerProjects");

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err.stack.split("\n").slice(0, 3).join("\n      ")}`);
    }
};

const app = express();
app.use(express.json());
app.use("/api/customer-projects", routes);
let base;
const call = (method, url, body) =>
    new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            `${base}${url}`,
            { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
            (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
            },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });

const record = async (id) => db.findOne("bots", { _id: id });
let n = 0;
const customerProject = async (env = "TOKEN=x\nPORT=3000\n") => {
    const p = await db.create("bots", { buyerID: BUYER, botID: `p${++n}`, name: "Old", projectType: "discord" });
    envFiles[p._id] = env;
    await customers.enable(p._id, { botUserId: BOT });
    return record(p._id);
};
const envOf = (id, key) => (envFiles[id].split("\n").find((l) => l.startsWith(`${key}=`)) || "").slice(key.length + 1);

// ── Tests ────────────────────────────────────────────────────────────────────

(async () => {
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    await db.set("customer_channels_settings", { log: [LOG1.id, LOG2.id], backup: [BACKUP.id] });

    console.log("settings");
    await check("the categories with what the bot can do, how full, public or not", async () => {
        const res = await call("GET", "/api/customer-projects/channel-settings");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.busReady, true);
        assert.deepStrictEqual(res.body.log.map((c) => [c.name, c.ok, c.public, c.count]), [["logs", true, false, 0], ["logs 2", true, false, 0]]);
        assert.strictEqual(res.body.backup[0].guildName, "Kho");
    });
    await check("categories are read from Discord, not the bot's stale cache (made private by hand)", async () => {
        // The bot's cache still has the old, public copy…
        const priv = category({ name: "was public", open: false });
        priv.cached = { ...priv, permissionsFor: (who) => (who === EVERYONE ? perms(P("ViewChannel")) : perms(P("ViewChannel", "ManageChannels", "ManageWebhooks"))) };
        // …but the owner made it private without the bot in it.
        priv.botHidden = true;
        await db.set("customer_channels_settings", { log: [priv.id], backup: [BACKUP.id] });
        let res = await call("GET", "/api/customer-projects/channel-settings");
        assert.strictEqual(res.body.log[0].public, undefined);
        assert.strictEqual(res.body.log[0].ok, false);
        assert.match(res.body.log[0].error, /cannot see this category/);
        assert.ok(fetchCalls.filter((f) => f.id === priv.id).every((f) => f.force), "always forced");
        // The owner adds the bot → Ready, private.
        priv.botHidden = false;
        res = await call("GET", "/api/customer-projects/channel-settings");
        assert.deepStrictEqual([res.body.log[0].ok, res.body.log[0].public], [true, false]);
        // Setting up uses the fresh copy too: the category the bot cannot see is not used.
        priv.botHidden = true;
        const q = await customerProject();
        res = await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["log"] });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /cannot see this category/);
        channels.delete(priv.id);
        await db.set("customer_channels_settings", { log: [LOG1.id, LOG2.id], backup: [BACKUP.id] });
    });
    await check("saving checks every id is a category the bot can see", async () => {
        const text = textChannel({ name: "general", parent: null });
        let res = await call("PUT", "/api/customer-projects/channel-settings", { log: [text.id] });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /Not a category/);
        res = await call("PUT", "/api/customer-projects/channel-settings", { log: ["123"] });
        assert.strictEqual(res.status, 400);
        res = await call("PUT", "/api/customer-projects/channel-settings", { log: `${LOG1.id}, ${LOG2.id}` });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual((await db.get("customer_channels_settings")).log, [LOG1.id, LOG2.id]);
        channels.delete(text.id);
    });

    console.log("set up");
    let p;
    await check("both channels made in their categories, private, named after the project, URLs only in the .env", async () => {
        p = await customerProject();
        logLines.length = 0;
        const res = await call("POST", `/api/customer-projects/${p._id}/channels`, {});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.created, ["log", "backup"]);
        assert.strictEqual(res.body.restartNeeded, true);
        const r = await record(p._id);
        const { log, backup } = r.customer.channels;
        const logCh = channels.get(log.channelId);
        assert.strictEqual(logCh.parentId, LOG1.id);
        assert.strictEqual(channels.get(backup.channelId).parentId, BACKUP.id);
        assert.strictEqual(logCh.name, `khach-a-lofi-music-${BOT}`);
        assert.ok(logCh.topic.includes(BUYER) && logCh.topic.includes(BOT) && logCh.topic.includes(p._id));
        assert.strictEqual(logCh.permissionsFor(EVERYONE).has(PermissionFlagsBits.ViewChannel), false);
        assert.strictEqual(webhooks.get(log.webhookId).name, "Log");
        assert.strictEqual(webhooks.get(backup.webhookId).name, "Backup");
        assert.strictEqual(envOf(p._id, "WEBHOOK_LOG"), webhooks.get(log.webhookId).url);
        assert.strictEqual(envOf(p._id, "WEBHOOK_BACKUP"), webhooks.get(backup.webhookId).url);
        assert.ok(envFiles[p._id].startsWith("TOKEN=x\nPORT=3000\n"), "other .env lines kept");
        for (const w of [log, backup].map((c) => webhooks.get(c.webhookId))) {
            assert.ok(!JSON.stringify(r).includes(w.token), "the webhook token is not in the record");
            assert.ok(!JSON.stringify(res.body).includes(w.token), "nor in the answer");
            assert.ok(!logLines.join("\n").includes(w.token), "nor in the panel log");
        }
        assert.ok(logLines.some((l) => l.includes("log + backup channels")));
    });
    await check("set up again → 409, nothing new", async () => {
        const before = channels.size;
        const res = await call("POST", `/api/customer-projects/${p._id}/channels`, {});
        assert.strictEqual(res.status, 409);
        assert.strictEqual(channels.size, before);
    });
    await check("a .env key that already has a webhook → ENV_TAKEN says where it posts; replace overwrites", async () => {
        const kept = textChannel({ name: "old-log", parent: LOG1 });
        const hook = await kept.createWebhook({ name: "Old" });
        const q = await customerProject(`WEBHOOK_LOG=${hook.url}\n`);
        const before = channels.size;
        let res = await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, "ENV_TAKEN");
        assert.deepStrictEqual(res.body.taken.map((t) => [t.key, t.channelName, t.guildName]), [["WEBHOOK_LOG", "old-log", "Kho"]]);
        assert.ok(!JSON.stringify(res.body).includes(hook.token));
        assert.strictEqual(channels.size, before, "nothing created");
        res = await call("POST", `/api/customer-projects/${q._id}/channels`, { replace: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.notStrictEqual(envOf(q._id, "WEBHOOK_LOG"), hook.url);
        assert.ok(channels.has(kept.id), "the old channel is left alone");
    });
    await check("a full category → the next one; all full → 409 naming them, nothing made", async () => {
        LOG1.size = 50;
        const q = await customerProject();
        let res = await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["log"] });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(channels.get((await record(q._id)).customer.channels.log.channelId).parentId, LOG2.id);
        LOG2.size = 50;
        const r2 = await customerProject();
        const before = channels.size;
        res = await call("POST", `/api/customer-projects/${r2._id}/channels`, { kinds: ["log"] });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /"logs" is full; "logs 2" is full/);
        assert.strictEqual(channels.size, before);
        LOG1.size = 3;
        LOG2.size = 3;
    });
    await check("missing permissions → 409 naming them, nothing made", async () => {
        const weak = category({ name: "weak", me: P("ViewChannel") });
        await db.set("customer_channels_settings", { log: [weak.id], backup: [BACKUP.id] });
        const q = await customerProject();
        const before = channels.size;
        const res = await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /missing ManageChannels, ManageWebhooks/);
        assert.strictEqual(channels.size, before);
        await db.set("customer_channels_settings", { log: [LOG1.id, LOG2.id], backup: [BACKUP.id] });
    });
    await check("the .env cannot be written → both new channels deleted again, .env unchanged", async () => {
        const q = await customerProject();
        const before = channels.size;
        const env = envFiles[q._id];
        agent.writeFails = true;
        const res = await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        agent.writeFails = false;
        assert.strictEqual(res.status, 502);
        assert.strictEqual(channels.size, before);
        assert.strictEqual(envFiles[q._id], env);
        assert.strictEqual((await record(q._id)).customer.channels, undefined);
    });
    await check("copying the category's permissions refused → made bare, then synced private", async () => {
        fake.failCreateWithOverwrites = true;
        const q = await customerProject();
        const res = await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["backup"] });
        fake.failCreateWithOverwrites = false;
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const ch = channels.get((await record(q._id)).customer.channels.backup.channelId);
        assert.strictEqual(ch.permissionsFor(EVERYONE).has(PermissionFlagsBits.ViewChannel), false);
    });
    await check("a channel that stays public under a private category is deleted, nothing kept", async () => {
        fake.failCreateWithOverwrites = true;
        fake.lockFails = true;
        const q = await customerProject();
        const before = channels.size;
        const res = await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["backup"] });
        fake.failCreateWithOverwrites = false;
        fake.lockFails = false;
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /visible to everyone/);
        assert.strictEqual(channels.size, before);
    });
    await check("own .env key names are used; not a customer project / bus down → refused", async () => {
        const q = await customerProject();
        let res = await call("PUT", `/api/customer-projects/${q._id}`, { logKey: "LOG_HOOK", backupKey: "BACKUP_HOOK" });
        assert.strictEqual(res.status, 200);
        res = await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(envOf(q._id, "LOG_HOOK").includes("/webhooks/"));
        assert.ok(envOf(q._id, "BACKUP_HOOK").includes("/webhooks/"));
        assert.strictEqual(envOf(q._id, "WEBHOOK_LOG"), "");
        const plain = await db.create("bots", { buyerID: BUYER, botID: "plain", name: "Plain" });
        assert.strictEqual((await call("POST", `/api/customer-projects/${plain._id}/channels`, {})).status, 409);
        fake.down = true;
        const r2 = await customerProject();
        res = await call("POST", `/api/customer-projects/${r2._id}/channels`, {});
        fake.down = false;
        assert.strictEqual(res.status, 503);
    });

    console.log("link");
    await check("channels from the .env are adopted only in Kho and only if nobody has them; renamed right away", async () => {
        const mine = textChannel({ name: "lofi-logs", parent: LOG1 });
        const mineHook = await mine.createWebhook({ name: "x" });
        const away = textChannel({ name: "far", parent: null, g: otherGuild });
        const awayHook = await away.createWebhook({ name: "x" });
        const q = await customerProject(`WEBHOOK_LOG=${mineHook.url}\nWEBHOOK_BACKUP=${awayHook.url}\n`);
        const res = await call("POST", `/api/customer-projects/${q._id}/channels/link`, {});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.results.map((r) => [r.kind, r.status]), [["log", "linked"], ["backup", "skipped"]]);
        assert.match(res.body.results[1].reason, /outside the server/);
        const r = await record(q._id);
        assert.strictEqual(r.customer.channels.log.channelId, mine.id);
        assert.strictEqual(r.customer.channels.backup, undefined);
        assert.strictEqual(mine.name, `khach-a-lofi-music-${BOT}`, "renamed after the project");
        // The same channel for a second project → stays with the first.
        const other = await customerProject(`WEBHOOK_LOG=${mineHook.url}\n`);
        const res2 = await call("POST", `/api/customer-projects/${other._id}/channels/link`, { kinds: ["log"] });
        assert.strictEqual(res2.body.results[0].status, "skipped");
        assert.match(res2.body.results[0].reason, /already belongs to/);
        const res3 = await call("POST", `/api/customer-projects/${other._id}/channels/link`, { kinds: ["backup"] });
        assert.match(res3.body.results[0].reason, /There is no WEBHOOK_BACKUP/);
    });
    await check("unlink forgets the channel; Discord and the .env stay", async () => {
        const q = await customerProject();
        await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        const before = await record(q._id);
        const env = envFiles[q._id];
        const res = await call("DELETE", `/api/customer-projects/${q._id}/channels/log`);
        assert.strictEqual(res.status, 200);
        const r = await record(q._id);
        assert.strictEqual(r.customer.channels.log, undefined);
        assert.ok(r.customer.channels.backup);
        assert.ok(channels.has(before.customer.channels.log.channelId));
        assert.strictEqual(envFiles[q._id], env);
        assert.strictEqual((await call("DELETE", `/api/customer-projects/${q._id}/channels/nope`)).status, 400);
    });

    console.log("daily sync");
    await check("the bot renamed → its channels renamed and re-topicked; unchanged → no edit", async () => {
        const q = await customerProject();
        await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        const ids = (await record(q._id)).customer.channels;
        const logCh = channels.get(ids.log.channelId);
        await customers.syncOne(await record(q._id));
        await customers.syncOne(await record(q._id));
        assert.strictEqual(logCh.edits, 0, "name and topic already right → no edit (no rename budget spent)");
        users[BOT].globalName = "Lofi Radio";
        await customers.syncOne(await record(q._id));
        users[BOT].globalName = "Lofi Music";
        assert.strictEqual(logCh.name, `khach-a-lofi-radio-${BOT}`);
        assert.strictEqual(channels.get(ids.backup.channelId).name, `khach-a-lofi-radio-${BOT}`);
        assert.ok(logCh.topic.includes("Lofi Radio"));
        assert.strictEqual((await record(q._id)).customer.channels.log.name, `khach-a-lofi-radio-${BOT}`);
    });
    await check("a channel / webhook deleted on Discord is flagged; set up makes the missing one again", async () => {
        const q = await customerProject();
        await call("POST", `/api/customer-projects/${q._id}/channels`, {});
        const ids = (await record(q._id)).customer.channels;
        channels.delete(ids.log.channelId);
        webhooks.delete(ids.backup.webhookId);
        await customers.syncOne(await record(q._id));
        let r = await record(q._id);
        assert.strictEqual(r.customer.channels.log.missing, true);
        assert.strictEqual(r.customer.channels.backup.webhookMissing, true);
        assert.match(r.customer.lastError, /log channel was deleted/);
        assert.match(r.customer.lastError, /webhook was deleted/);
        const res = await call("POST", `/api/customer-projects/${q._id}/channels`, { replace: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.created, ["log"]);
        r = await record(q._id);
        assert.ok(channels.has(r.customer.channels.log.channelId));
        assert.notStrictEqual(r.customer.channels.log.channelId, ids.log.channelId);
    });
    await check("a rename held back by Discord's rate limit does not hold up the sync", async () => {
        const q = await customerProject();
        await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["log"] });
        fake.editHangs = true;
        const t = Date.now();
        const out = await customerChannels.sync(await record(q._id), { baseName: "new-name", projectName: "X", editWaitMs: 50 });
        fake.editHangs = false;
        assert.ok(Date.now() - t < 2000);
        assert.deepStrictEqual(out.problems, []);
        assert.notStrictEqual(out.channels.log.name, "new-name", "not recorded as renamed yet");
    });
    await check("bus down → the channels are left as they are", async () => {
        const q = await customerProject();
        await call("POST", `/api/customer-projects/${q._id}/channels`, { kinds: ["log"] });
        fake.down = true;
        const out = await customerChannels.sync(await record(q._id), { baseName: "zzz" });
        fake.down = false;
        assert.deepStrictEqual(out, { skipped: true });
    });
    await check("webhook URLs are recognised in their usual shapes only", () => {
        const id = "1300000000000000001";
        const tok = crypto.randomBytes(8).toString("hex");
        for (const host of ["https://discord.com", "https://discordapp.com", "https://ptb.discord.com", "https://canary.discord.com"]) {
            assert.deepStrictEqual(customerChannels.parseWebhookUrl([host, "api", "webhooks", id, tok].join("/")), { id, token: tok });
        }
        assert.deepStrictEqual(customerChannels.parseWebhookUrl(["https://discord.com", "api", "v10", "webhooks", id, tok].join("/")), { id, token: tok });
        assert.strictEqual(customerChannels.parseWebhookUrl(["https://evil.example", "api", "webhooks", id, tok].join("/")), null);
        assert.strictEqual(customerChannels.parseWebhookUrl("nope"), null);
    });

    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
