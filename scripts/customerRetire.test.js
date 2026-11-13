#!/usr/bin/env node
/**
 * Checks for customer projects, phase 3 (server/services/customerRetire.js + its routes,
 * and the three ways a project record goes: DELETE /api/bots/:id, bulk remove, the expiry
 * removal). A customer project's resources are written down before its record goes; the
 * webhooks are deleted and its API keys revoked at once; channels and the repo wait for
 * the owner (the backup channel shows a 30-day "kept until"); an entry leaves the list
 * when every line is done or is dismissed. Personal projects are never listed. Parallel
 * bulk removes lose no entry and no revocation. The same bot back gets its old channels
 * offered: reused with a new webhook, renamed, and a failure never deletes the old channel.
 * Discord, the agent and the db are fakes; the API key service is the real one.
 * Run:  node scripts/customerRetire.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-customer-retire";

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
const tick = () => new Promise((r) => setImmediate(r)); // let parallel callers interleave, like the real db
const db = {
    get: async (k) => {
        await tick();
        return clone(store.get(k)) ?? null;
    },
    set: async (k, v) => {
        await tick();
        store.set(k, clone(v));
    },
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
    findOneAndDelete: async (m, q) => {
        const arr = store.get(m) || [];
        const i = arr.findIndex((e) => match(e, q));
        if (i === -1) return null;
        const [gone] = arr.splice(i, 1);
        return gone;
    },
};
stub("db", db);

// ── Fake Discord ─────────────────────────────────────────────────────────────
let snow = 1300000000000000000n;
const sid = () => String(++snow);
const discordError = (code, message) => Object.assign(new Error(message), { code });
const P = (...names) => new Set(names.map((n) => PermissionFlagsBits[n]));
const perms = (set) => ({ has: (flag) => set.has(flag) });
const fake = { down: false };
const ME = { id: "me" };
const EVERYONE = { id: "everyone" };
const channels = new Map();
const webhooks = new Map();
const guild = {
    id: "1183033659838697542",
    name: "Kho",
    members: { me: ME },
    roles: { everyone: EVERYONE },
    channels: {
        cache: { get size() { return channels.size; } },
        create: async (opts) => textChannel({ name: opts.name, topic: opts.topic, parent: channels.get(opts.parent) }),
    },
};
const category = (name) => {
    const cat = {
        id: sid(), name, type: ChannelType.GuildCategory, guild, size: 0,
        children: { cache: { get size() { return cat.size; } } },
        permissionOverwrites: { cache: [{ id: EVERYONE.id, type: OverwriteType.Role, allow: 0n, deny: PermissionFlagsBits.ViewChannel }] },
        permissionsFor: (who) => perms(who === EVERYONE ? P() : P("ViewChannel", "ManageChannels", "ManageWebhooks")),
    };
    channels.set(cat.id, cat);
    return cat;
};
function textChannel({ name, topic, parent }) {
    const ch = {
        id: sid(), name, topic: topic || null, type: ChannelType.GuildText, parentId: parent?.id || null, guild,
        permissionsFor: (who) => perms(who === EVERYONE ? P() : P("ViewChannel")),
        lockPermissions: async () => ch,
        createWebhook: async ({ name: hookName }) => {
            const w = { id: sid(), name: hookName, token: crypto.randomBytes(24).toString("base64url"), channelId: ch.id, guildId: guild.id };
            w.url = ["https://discord.com", "api", "webhooks", w.id, w.token].join("/");
            webhooks.set(w.id, w);
            return w;
        },
        edit: async (o) => Object.assign(ch, o.name ? { name: o.name } : {}, o.topic !== undefined ? { topic: o.topic } : {}),
        delete: async () => void channels.delete(ch.id),
    };
    channels.set(ch.id, ch);
    if (parent) parent.size++;
    return ch;
}
const client = {
    channels: {
        fetch: async (id) => {
            const c = channels.get(id);
            if (!c) throw discordError(10003, "Unknown Channel");
            return c;
        },
    },
    fetchWebhook: async (id, token) => {
        const w = webhooks.get(id);
        if (!w || (token && token !== w.token)) throw discordError(10015, "Unknown Webhook");
        return { id: w.id, channelId: w.channelId, guildId: w.guildId };
    },
    deleteWebhook: async (id) => {
        if (!webhooks.has(id)) throw discordError(10015, "Unknown Webhook");
        webhooks.delete(id);
    },
};
const LOG = category("logs");
const BACKUP = category("backups");

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
        if (agent.writeFails) throw Object.assign(new Error("agent unreachable"), { status: 502 });
        envFiles[bot._id] = content;
    },
    deleteBot: async () => {},
    removeBotFiles: async () => {},
    getBotStatus: async () => ({ status: "stopped" }),
    stopBot: async () => {},
});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });
stub("services/historyService", {});
stub("services/schedulerService", {});
stub("services/nodeService", { panelNodeId: () => "n1", resolveNodeId: (x) => x, getNodes: async () => [] });
stub("services/nodeReleases", {});
stub("services/staleCopies", {});
stub("routes/notifications", { createNotification: async () => {} });
stub("services/discordService", { sendExpiryWarning: async () => {}, sendExpiryRemoval: async () => {}, sendExpirySuspended: async () => {} });

const customers = require("../server/services/customerProjects");
const retireService = require("../server/services/customerRetire");
const apiKeys = require("../server/services/apiKeyService");
const expiry = require("../server/services/expiryService");
const customerRoutes = require("../server/routes/customerProjects");
const botRoutes = require("../server/routes/bots");
const bulkRoutes = require("../server/routes/bulk");

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
app.use("/api/customer-projects", customerRoutes);
app.use("/api/bots", botRoutes);
app.use("/api/bulk", bulkRoutes);
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
/** A customer project with both channels, an API key and a repo. → { bot, key } */
const fullCustomer = async ({ repoUrl = "git@github.com:me/lofi.git", expiresAt = null } = {}) => {
    const p = await db.create("bots", { buyerID: BUYER, botID: `c${++n}`, name: "Old", projectType: "discord", source: "git", repoUrl, expiresAt, pm2Name: `x${n}` });
    envFiles[p._id] = "TOKEN=x\n";
    await customers.enable(p._id, { botUserId: BOT });
    await customers.setUpChannels(p._id, {});
    const { key } = await apiKeys.create({ botId: p._id });
    return { bot: await record(p._id), key };
};
const retiredList = async () => (await call("GET", "/api/customer-projects/retired")).body;
const entryFor = async (botId) => (await retiredList()).find((e) => e.botId === botId);

// ── Tests ────────────────────────────────────────────────────────────────────

(async () => {
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    await db.set("customer_channels_settings", { log: [LOG.id], backup: [BACKUP.id] });

    console.log("retiring");
    let first;
    await check("Delete: webhooks deleted and keys revoked at once; channels + repo wait; listed newest first", async () => {
        const { bot, key } = await fullCustomer();
        first = bot;
        const { log, backup } = bot.customer.channels;
        assert.ok(await apiKeys.verify(key));
        logLines.length = 0;
        const res = await call("DELETE", `/api/bots/${bot._id}`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(await record(bot._id), undefined);
        assert.ok(!webhooks.has(log.webhookId) && !webhooks.has(backup.webhookId), "webhooks deleted");
        assert.ok(channels.has(log.channelId) && channels.has(backup.channelId), "channels kept");
        assert.strictEqual(await apiKeys.verify(key), null, "key revoked");
        const e = await entryFor(bot._id);
        assert.strictEqual(e.reason, "deleted");
        assert.strictEqual(e.name, "Lofi Music");
        assert.deepStrictEqual([e.webhooks.status, e.apiKeys.status, e.apiKeys.count], ["deleted", "revoked", 1]);
        assert.deepStrictEqual([e.channels.log.status, e.channels.backup.status], ["kept", "kept"]);
        assert.strictEqual(e.channels.log.webhookId, undefined, "webhook ids stay on the server");
        assert.deepStrictEqual(e.repo, { url: "git@github.com:me/lofi.git", status: "pending" });
        assert.strictEqual(e.backupKeptUntil, e.retiredAt + 30 * 24 * 60 * 60 * 1000);
        assert.ok(logLines.some((l) => l.includes('"Lofi Music" was removed') && l.includes("Bots → Retired")));
    });
    await check("a personal project, or one whose customer switch is off, is never listed", async () => {
        const personal = await db.create("bots", { buyerID: BUYER, botID: "mine", name: "Mine", repoUrl: "git@github.com:me/mine.git" });
        const off = (await fullCustomer()).bot;
        await customers.disable(off._id);
        const before = (await retiredList()).length;
        await call("DELETE", `/api/bots/${personal._id}`);
        await call("DELETE", `/api/bots/${off._id}`);
        assert.strictEqual((await retiredList()).length, before);
    });
    await check("a customer project with nothing left to clean is not listed at all", async () => {
        const p = await db.create("bots", { buyerID: BUYER, botID: "bare", name: "Bare", projectType: "discord", source: "local" });
        await customers.enable(p._id, { botUserId: BOT });
        const before = (await retiredList()).length;
        await call("DELETE", `/api/bots/${p._id}`);
        assert.strictEqual((await retiredList()).length, before);
    });
    await check("expiry removal (7 days after expiresAt) retires with reason expired", async () => {
        const { bot } = await fullCustomer({ expiresAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
        await expiry.checkExpiry();
        assert.strictEqual(await record(bot._id), undefined);
        assert.strictEqual((await entryFor(bot._id)).reason, "expired");
    });
    await check("bulk remove of several customer projects in parallel: every entry and every revocation kept", async () => {
        const made = [];
        for (let i = 0; i < 4; i++) made.push(await fullCustomer());
        const res = await call("POST", "/api/bulk/remove", { botIds: made.map((m) => m.bot._id) });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        for (const m of made) {
            assert.ok(await entryFor(m.bot._id), `entry for ${m.bot._id}`);
            assert.strictEqual(await apiKeys.verify(m.key), null, "revoked");
        }
    });
    await check("bus down while retiring → webhooks wait (Retry later deletes them)", async () => {
        const { bot } = await fullCustomer();
        fake.down = true;
        await call("DELETE", `/api/bots/${bot._id}`);
        fake.down = false;
        let e = await entryFor(bot._id);
        assert.strictEqual(e.webhooks.status, "pending");
        assert.match(e.webhooks.error, /not connected/);
        assert.ok(webhooks.has(bot.customer.channels.log.webhookId));
        const res = await call("POST", `/api/customer-projects/retired/${e._id}/webhooks`);
        assert.strictEqual(res.status, 200);
        e = await entryFor(bot._id);
        assert.strictEqual(e.webhooks.status, "deleted");
        assert.ok(!webhooks.has(bot.customer.channels.log.webhookId));
    });

    console.log("cleaning up");
    await check("delete a channel; one deleted on Discord by hand shows as done; all done → the entry leaves", async () => {
        const e = await entryFor(first._id);
        let res = await call("POST", `/api/customer-projects/retired/${e._id}/channels/log/delete`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.entry.channels.log.status, "deleted");
        assert.ok(!channels.has(first.customer.channels.log.channelId));
        channels.delete(first.customer.channels.backup.channelId); // deleted by hand
        assert.strictEqual((await entryFor(first._id)).channels.backup.status, "gone");
        logLines.length = 0;
        res = await call("POST", `/api/customer-projects/retired/${e._id}/repo`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.finished, true);
        assert.strictEqual(await entryFor(first._id), undefined);
        assert.ok(logLines.some((l) => l.includes("Cleanup of retired customer project") && l.includes("is finished")));
        assert.strictEqual((await call("POST", `/api/customer-projects/retired/${e._id}/repo`)).status, 404);
    });
    await check("stop listing forgets the entry; Discord is untouched", async () => {
        const { bot } = await fullCustomer();
        await call("DELETE", `/api/bots/${bot._id}`);
        const e = await entryFor(bot._id);
        const res = await call("DELETE", `/api/customer-projects/retired/${e._id}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await entryFor(bot._id), undefined);
        assert.ok(channels.has(bot.customer.channels.log.channelId));
    });
    await check("deleting a channel needs the bus; an unknown kind is refused", async () => {
        const { bot } = await fullCustomer();
        await call("DELETE", `/api/bots/${bot._id}`);
        const e = await entryFor(bot._id);
        fake.down = true;
        let res = await call("POST", `/api/customer-projects/retired/${e._id}/channels/log/delete`);
        fake.down = false;
        assert.strictEqual(res.status, 503);
        res = await call("POST", `/api/customer-projects/retired/${e._id}/channels/x/delete`);
        assert.strictEqual(res.status, 400);
    });

    console.log("the customer comes back");
    await check("the same bot is offered its old channels; reusing makes new webhooks there and renames them", async () => {
        // Clear the list so only one old set is on offer.
        for (const e of await retiredList()) await call("DELETE", `/api/customer-projects/retired/${e._id}`);
        const { bot: old } = await fullCustomer();
        await call("DELETE", `/api/bots/${old._id}`);
        const back = await db.create("bots", { buyerID: BUYER, botID: "back", name: "Back", projectType: "discord", source: "git", repoUrl: null });
        envFiles[back._id] = "TOKEN=x\n";
        await customers.enable(back._id, { botUserId: BOT });
        users[BOT].globalName = "Lofi Radio";
        await customers.refresh(back._id);
        let res = await call("GET", `/api/customer-projects/${back._id}/reusable`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.length, 1);
        assert.deepStrictEqual(Object.keys(res.body[0].channels), ["log", "backup"]);
        const before = channels.size;
        res = await call("POST", `/api/customer-projects/${back._id}/channels/reuse`, { retiredId: res.body[0].retiredId });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.reused, ["log", "backup"]);
        assert.strictEqual(channels.size, before, "no new channel");
        const r = await record(back._id);
        assert.strictEqual(r.customer.channels.log.channelId, old.customer.channels.log.channelId);
        assert.notStrictEqual(r.customer.channels.log.webhookId, old.customer.channels.log.webhookId);
        assert.ok(envFiles[back._id].includes(`/webhooks/${r.customer.channels.log.webhookId}/`));
        assert.strictEqual(channels.get(r.customer.channels.log.channelId).name, `khach-a-lofi-radio-${BOT}`);
        users[BOT].globalName = "Lofi Music";
        const e = await entryFor(old._id);
        assert.deepStrictEqual([e.channels.log.status, e.channels.backup.status], ["reused", "reused"]);
        assert.strictEqual(e.channels.log.reusedBy, "Lofi Radio");
        assert.strictEqual((await call("GET", `/api/customer-projects/${back._id}/reusable`)).body.length, 0, "nothing left to offer");
    });
    await check("reuse that fails on the .env removes only the new webhook, never the old channel", async () => {
        for (const e of await retiredList()) await call("DELETE", `/api/customer-projects/retired/${e._id}`);
        const { bot: old } = await fullCustomer();
        await call("DELETE", `/api/bots/${old._id}`);
        const back = await db.create("bots", { buyerID: BUYER, botID: "back2", name: "Back2", projectType: "discord" });
        envFiles[back._id] = "TOKEN=x\n";
        await customers.enable(back._id, { botUserId: BOT });
        const offer = (await call("GET", `/api/customer-projects/${back._id}/reusable`)).body[0];
        const hooksBefore = webhooks.size;
        agent.writeFails = true;
        const res = await call("POST", `/api/customer-projects/${back._id}/channels/reuse`, { retiredId: offer.retiredId });
        agent.writeFails = false;
        assert.strictEqual(res.status, 502);
        assert.ok(channels.has(old.customer.channels.log.channelId) && channels.has(old.customer.channels.backup.channelId));
        assert.strictEqual(webhooks.size, hooksBefore, "the new webhooks are gone again");
        assert.strictEqual((await entryFor(old._id)).channels.log.status, "kept");
    });
    await check("another bot is not offered someone else's channels", async () => {
        const other = await db.create("bots", { buyerID: BUYER, botID: "other", name: "Other", projectType: "website" });
        await customers.enable(other._id, {});
        assert.deepStrictEqual((await call("GET", `/api/customer-projects/${other._id}/reusable`)).body, []);
        const res = await call("POST", `/api/customer-projects/${other._id}/channels/reuse`, { retiredId: "nope" });
        assert.strictEqual(res.status, 409);
    });

    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
