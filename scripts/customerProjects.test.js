#!/usr/bin/env node
/**
 * Checks for customer projects, phase 1 (server/services/customerProjects.js +
 * routes/customerProjects.js + the New project / rename hooks in routes/bots.js):
 * the switch is per project and off by default, so personal projects are never
 * touched; the bot id is typed in (checked: digits, a bot not a person) or read
 * from the token in the project's .env without calling Discord with it; the daily
 * sync renames the panel project after its bot only while syncName is on, keeps
 * the last good name when the bot is gone / the customer deleted their account /
 * the bus is down; naming a project by hand turns syncName off. Discord, the agent
 * and the db are stubbed.
 * Run:  node scripts/customerProjects.test.js
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// In-memory stand-in for server/db (same merge semantics as QuickDB.js).
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
    findOneAndDelete: async () => null,
};
stub("db", db);

// Discord users by id, through the panel's bot.
const BOT = "1480411893448573009";
const BOT2 = "1400736865299992576";
const PERSON = "871329074046435338";
const BUYER = "427399742906040333";
const users = {
    [BOT]: { id: BOT, username: "lofimusic", globalName: "Lofi Music 🎵", bot: true },
    [BOT2]: { id: BOT2, username: "đứcbot", globalName: null, bot: true },
    [PERSON]: { id: PERSON, username: "someone", globalName: "Someone", bot: false },
    [BUYER]: { id: BUYER, username: "khach.a", globalName: "Khách A", bot: false },
};
const discord = { down: false, calls: 0 };
stub("services/discordBus", {
    fetchUser: async (id) => {
        discord.calls++;
        if (discord.down) return undefined;
        const u = users[id];
        if (!u) throw Object.assign(new Error("Unknown User"), { code: 10013 });
        return { ...u };
    },
    status: () => ({ ready: !discord.down }),
});

// Project files by project _id.
const envFiles = {};
const clones = [];
stub("services/executor", {
    fsRead: async (bot, sub) => {
        assert.strictEqual(sub, ".env");
        if (envFiles[bot._id] === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
        return { content: envFiles[bot._id] };
    },
    cloneRepo: async (ref, url) => void clones.push(url),
    installDeps: async () => {},
    fsDelete: async () => {},
    fsExists: async () => true,
    gitInfo: async () => ({ repoUrl: null, branch: null }),
    getBotStatus: async () => ({ status: "stopped" }),
    getLiveStatus: async () => ({ status: "stopped" }),
});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn });
// routes/bots.js needs these to load; the routes under test never reach them.
stub("services/historyService", {});
stub("services/schedulerService", { pickNode: async () => ({ nodeId: "n1", nodeName: "node1", reason: "test" }) });
stub("services/nodeService", { panelNodeId: () => "n1", resolveNodeId: (x) => x, getNodes: async () => [] });
stub("services/nodeReleases", {});
stub("services/staleCopies", {});
stub("routes/notifications", { createNotification: async () => {} });

const customers = require("../server/services/customerProjects");
const customerRoutes = require("../server/routes/customerProjects");
const botRoutes = require("../server/routes/bots");

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

// A token-shaped string made at run time (never a literal that looks real):
// base64(id) . base64(time) . hmac
const fakeToken = (id, url = false) => {
    let first = Buffer.from(id).toString("base64").replace(/=+$/, "");
    if (url) first = first.replace(/\+/g, "-").replace(/\//g, "_");
    return [first, "Zm9v", "x".repeat(27)].join(".");
};

const app = express();
app.use(express.json());
app.use("/api/customer-projects", customerRoutes);
app.use("/api/bots", botRoutes);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

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

const project = async (fields) =>
    db.create("bots", { buyerID: BUYER, botID: "proj", name: "Old name", projectType: "discord", ...fields });
const record = async (id) => db.findOne("bots", { _id: id });

// ── Tests ────────────────────────────────────────────────────────────────────

(async () => {
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    console.log("names");
    await check("slug: plain lowercase a-z 0-9 and -, accents and fancy letters made plain", () => {
        assert.strictEqual(customers.slug("Lofi Music 🎵"), "lofi-music");
        assert.strictEqual(customers.slug("Đức Anh's  Bot!!"), "duc-anh-s-bot");
        assert.strictEqual(customers.slug("𝓐𝓻𝓷𝓣𝓸 Shop"), "arnto-shop");
        assert.strictEqual(customers.slug("khach.a"), "khach-a");
        assert.strictEqual(customers.slug("🎵🎵"), "");
        assert.strictEqual(customers.slug("a".repeat(29) + " b"), "a".repeat(29)); // no dangling "-"
    });
    await check("base name: customer-bot-id, or customer-project id without a bot, ≤ 100", () => {
        assert.strictEqual(customers.baseName({ buyerName: "khach.a", botName: "Lofi Music", botUserId: BOT, botID: "x" }), `khach-a-lofi-music-${BOT}`);
        assert.strictEqual(customers.baseName({ buyerName: "khach.a", botName: null, botUserId: null, botID: "My_Site" }), "khach-a-my-site");
        assert.strictEqual(customers.baseName({ buyerName: null, botName: null, botUserId: BOT, botID: "x" }), BOT);
        assert.ok(customers.baseName({ buyerName: "b".repeat(80), botName: "c".repeat(80), botUserId: BOT }).length <= 100);
    });
    await check("bot id from a token: base64 and base64url first part; anything else → null", () => {
        assert.strictEqual(customers.botIdFromToken(fakeToken(BOT)), BOT);
        assert.strictEqual(customers.botIdFromToken(fakeToken(BOT2, true)), BOT2);
        assert.strictEqual(customers.botIdFromToken(`Bot ${fakeToken(BOT)}`), BOT);
        assert.strictEqual(customers.botIdFromToken("not-a-token"), null);
        assert.strictEqual(customers.botIdFromToken(""), null);
    });

    console.log("turning it on");
    await check("a project starts off — no customer block, the sync never touches it", async () => {
        const p = await project({ botID: "personal", name: "My own bot" });
        await customers.syncAll({ gapMs: 0 });
        const r = await record(p._id);
        assert.strictEqual(r.customer, undefined);
        assert.strictEqual(r.name, "My own bot");
    });
    await check("enable with a bot id: names looked up, panel name follows the bot, base name built", async () => {
        const p = await project({ botID: "lofi" });
        const res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: BOT });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const r = await record(p._id);
        assert.strictEqual(r.customer.enabled, true);
        assert.strictEqual(r.customer.botName, "Lofi Music 🎵");
        assert.strictEqual(r.customer.buyerName, "khach.a");
        assert.strictEqual(r.customer.buyerDisplayName, "Khách A");
        assert.strictEqual(r.customer.syncName, true);
        assert.strictEqual(r.customer.envKeys.token, "TOKEN");
        assert.strictEqual(r.name, "Lofi Music 🎵");
        assert.strictEqual(r.customer.baseName, `khach-a-lofi-music-${BOT}`);
        assert.strictEqual(r.customer.lastError, null);
        assert.ok(logLines.some((l) => l.startsWith("owner:") && l.includes("customer project")));
    });
    await check("enable with syncName off keeps the panel name", async () => {
        const p = await project({ botID: "keep", name: "Hand name" });
        const res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: BOT, syncName: false });
        assert.strictEqual(res.status, 200);
        const r = await record(p._id);
        assert.strictEqual(r.name, "Hand name");
        assert.strictEqual(r.customer.botName, "Lofi Music 🎵");
    });
    await check("a person's id, an unknown id or not digits is refused (nothing saved)", async () => {
        const p = await project({ botID: "bad" });
        let res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: PERSON });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /person, not a bot/);
        res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: "999999999999999999" });
        assert.strictEqual(res.status, 404);
        res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: "abc" });
        assert.strictEqual(res.status, 400);
        res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: BOT, tokenKey: "BAD KEY" });
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await record(p._id)).customer, undefined);
    });
    await check("a project with no bot (a website): only the customer is looked up", async () => {
        const p = await project({ botID: "shop_site", name: "Site", projectType: "website" });
        const res = await call("POST", `/api/customer-projects/${p._id}/enable`, {});
        assert.strictEqual(res.status, 200);
        const r = await record(p._id);
        assert.strictEqual(r.customer.botUserId, null);
        assert.strictEqual(r.name, "Site");
        assert.strictEqual(r.customer.baseName, "khach-a-shop-site");
    });
    await check("bus down: the id is taken unchecked, nothing looked up, the answer says synced:false", async () => {
        const p = await project({ botID: "offline" });
        discord.down = true;
        const res = await call("POST", `/api/customer-projects/${p._id}/enable`, { botUserId: BOT });
        discord.down = false;
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.synced, false);
        const r = await record(p._id);
        assert.strictEqual(r.customer.botUserId, BOT);
        assert.strictEqual(r.customer.botName, null);
        assert.strictEqual(r.customer.checkedAt, undefined);
        assert.strictEqual(r.name, "Old name");
    });

    console.log("bot id from the token");
    await check("detect reads TOKEN (or the given key) and says who it is — nothing saved", async () => {
        const p = await project({ botID: "detect" });
        envFiles[p._id] = `PORT=1\nTOKEN=${fakeToken(BOT)}\nBOT_TOKEN="${fakeToken(BOT2, true)}"\n`;
        let res = await call("POST", `/api/customer-projects/${p._id}/detect`, {});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body, { botUserId: BOT, bot: { username: "lofimusic", name: "Lofi Music 🎵" } });
        res = await call("POST", `/api/customer-projects/${p._id}/detect`, { tokenKey: "BOT_TOKEN" });
        assert.strictEqual(res.body.botUserId, BOT2);
        assert.strictEqual((await record(p._id)).customer, undefined);
        assert.ok(!JSON.stringify(res.body).includes("x".repeat(27)), "the token never comes back");
    });
    await check("detect: no .env, no key, not a token, a bot that is gone", async () => {
        const p = await project({ botID: "detect2" });
        let res = await call("POST", `/api/customer-projects/${p._id}/detect`, {});
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /no \.env/);
        envFiles[p._id] = "PORT=1\n";
        res = await call("POST", `/api/customer-projects/${p._id}/detect`, {});
        assert.match(res.body.error, /There is no TOKEN/);
        envFiles[p._id] = "TOKEN=hello\n";
        res = await call("POST", `/api/customer-projects/${p._id}/detect`, {});
        assert.match(res.body.error, /does not look like a Discord bot token/);
        envFiles[p._id] = `TOKEN=${fakeToken("1111111111111111111")}\n`;
        res = await call("POST", `/api/customer-projects/${p._id}/detect`, {});
        assert.strictEqual(res.status, 404);
    });

    console.log("daily sync");
    await check("the bot renamed on Discord → the panel name follows (logged); syncName off → only the stored name", async () => {
        const follow = await project({ botID: "follow" });
        const own = await project({ botID: "own", name: "Mine" });
        await customers.enable(follow._id, { botUserId: BOT });
        await customers.enable(own._id, { botUserId: BOT, syncName: false });
        users[BOT].globalName = "Lofi Radio";
        logLines.length = 0;
        const out = await customers.syncAll({ gapMs: 0 });
        assert.ok(out.checked >= 2 && out.renamed >= 1, JSON.stringify(out));
        assert.strictEqual((await record(follow._id)).name, "Lofi Radio");
        assert.strictEqual((await record(follow._id)).customer.baseName, `khach-a-lofi-radio-${BOT}`);
        const o = await record(own._id);
        assert.strictEqual(o.name, "Mine");
        assert.strictEqual(o.customer.botName, "Lofi Radio");
        assert.ok(logLines.some((l) => l.startsWith("system:") && l.includes('is now "Lofi Radio"')));
    });
    await check("the bot is gone / the customer deleted the account → last good names kept, lastError says why", async () => {
        const p = await project({ botID: "gone" });
        await customers.enable(p._id, { botUserId: BOT2 });
        const before = await record(p._id);
        assert.strictEqual(before.name, "đứcbot");
        assert.strictEqual(before.customer.baseName, `khach-a-ducbot-${BOT2}`);
        const savedBot = users[BOT2];
        const savedBuyer = users[BUYER];
        delete users[BOT2];
        users[BUYER] = { id: BUYER, username: "deleted_user_5f3a", globalName: "Deleted User", bot: false };
        await customers.syncOne(await record(p._id));
        const r = await record(p._id);
        assert.strictEqual(r.name, "đứcbot");
        assert.strictEqual(r.customer.botName, "đứcbot");
        assert.strictEqual(r.customer.buyerName, "khach.a");
        assert.match(r.customer.lastError, /bot no longer exists/);
        assert.match(r.customer.lastError, /deleted their Discord account/);
        users[BOT2] = savedBot;
        users[BUYER] = savedBuyer;
        await customers.syncOne(await record(p._id));
        assert.strictEqual((await record(p._id)).customer.lastError, null);
    });
    await check("bus down during the run → nothing written, the run says skipped", async () => {
        const p = await project({ botID: "busdown" });
        await customers.enable(p._id, { botUserId: BOT });
        const before = await record(p._id);
        discord.down = true;
        const out = await customers.syncAll({ gapMs: 0 });
        discord.down = false;
        assert.ok(out.skipped > 0 && out.checked === 0, JSON.stringify(out));
        assert.deepStrictEqual(await record(p._id), before);
    });
    await check("a buyer id that is not a Discord id is not looked up", async () => {
        const p = await project({ botID: "nobuyer", buyerID: "acme" });
        discord.calls = 0;
        await customers.enable(p._id, { botUserId: BOT });
        assert.strictEqual(discord.calls, 2); // the check + the bot lookup, no buyer
        assert.strictEqual((await record(p._id)).customer.baseName, `lofi-radio-${BOT}`);
    });
    await check("POST /refresh runs every project; refused while the bus is down", async () => {
        let res = await call("POST", "/api/customer-projects/refresh");
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.total >= 1);
        discord.down = true;
        res = await call("POST", "/api/customer-projects/refresh");
        discord.down = false;
        assert.strictEqual(res.status, 503);
        res = await call("GET", "/api/customer-projects/status");
        assert.strictEqual(res.body.busReady, true);
        assert.strictEqual(res.body.schedule.at, "04:00");
    });

    console.log("changes");
    await check("off keeps the bot id; on again without an id reuses it", async () => {
        const p = await project({ botID: "toggle" });
        await customers.enable(p._id, { botUserId: BOT });
        let res = await call("POST", `/api/customer-projects/${p._id}/disable`);
        assert.strictEqual(res.status, 200);
        let r = await record(p._id);
        assert.strictEqual(r.customer.enabled, false);
        assert.strictEqual(r.customer.botUserId, BOT);
        res = await call("POST", `/api/customer-projects/${p._id}/enable`, {});
        r = await record(p._id);
        assert.strictEqual(r.customer.enabled, true);
        assert.strictEqual(r.customer.botUserId, BOT);
    });
    await check("PUT: a new bot id drops the old bot's names and looks the new one up; not a customer project → 409", async () => {
        const p = await project({ botID: "swap" });
        await customers.enable(p._id, { botUserId: BOT });
        const res = await call("PUT", `/api/customer-projects/${p._id}`, { botUserId: BOT2 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const r = await record(p._id);
        assert.strictEqual(r.customer.botUserId, BOT2);
        assert.strictEqual(r.customer.botName, "đứcbot");
        assert.strictEqual(r.name, "đứcbot");
        const other = await project({ botID: "notcustomer" });
        assert.strictEqual((await call("PUT", `/api/customer-projects/${other._id}`, { syncName: true })).status, 409);
    });
    await check("naming a customer project by hand (PUT /api/bots/:id) turns syncName off; a same-name save does not", async () => {
        const p = await project({ botID: "rename" });
        await customers.enable(p._id, { botUserId: BOT });
        let res = await call("PUT", `/api/bots/${p._id}`, { name: "Lofi Radio" });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual((await record(p._id)).customer.syncName, true);
        res = await call("PUT", `/api/bots/${p._id}`, { name: "Customer A bot" });
        assert.strictEqual(res.status, 200);
        const r = await record(p._id);
        assert.strictEqual(r.name, "Customer A bot");
        assert.strictEqual(r.customer.syncName, false);
        await customers.syncOne(r);
        assert.strictEqual((await record(p._id)).name, "Customer A bot");
    });

    console.log("New project form");
    await check("a wrong bot id is refused BEFORE cloning", async () => {
        clones.length = 0;
        const res = await call("POST", "/api/bots", {
            buyerID: BUYER, botID: "newbad", name: "New", repoUrl: "git@github.com:x/y.git", installCommand: "",
            customer: { enabled: true, botUserId: PERSON },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(clones.length, 0);
    });
    await check("created with Customer project ticked → marked and named after its bot", async () => {
        const res = await call("POST", "/api/bots", {
            buyerID: BUYER, botID: "newgood", name: "New", repoUrl: "git@github.com:x/y.git", installCommand: "",
            customer: { enabled: true, botUserId: BOT },
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.customer.enabled, true);
        assert.strictEqual(res.body.name, "Lofi Radio");
        assert.strictEqual(res.body.customerError, undefined);
    });
    await check("created without the tick → no customer block", async () => {
        const res = await call("POST", "/api/bots", {
            buyerID: BUYER, botID: "newplain", name: "Plain", repoUrl: "git@github.com:x/y.git", installCommand: "",
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.customer, undefined);
        assert.strictEqual(res.body.name, "Plain");
    });

    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
