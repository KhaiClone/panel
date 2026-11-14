#!/usr/bin/env node
/**
 * Checks for the customer role (server/services/customerRole.js + its routes): everyone with
 * a running customer project (websites, services and never-expiring ones too) gets the role;
 * it goes when their last one expires / stops being a customer project; personal projects
 * never give it. A role the panel gave and the owner took off by hand (not left-and-rejoined)
 * is never given back — not even after a new purchase — until "Allow again"; "Take off and
 * keep off" does the same from the panel. Someone who already held the role is taken over;
 * someone given it by hand who is no customer is never touched. The bot that does the Discord
 * part (ArnTo-Shop: role.members / role.set) is a fake over a fake server.
 * Run:  node scripts/customerRole.test.js
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

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

// ── The shop server and the bot that does the Discord part ───────────────────
const ROLE = "1247011723563503616";
const server = new Map(); // userId → { hasRole, joinedAt, tag }
const shop = { announced: true, canManage: true, down: false, calls: [] };
const join = (id, { hasRole = false, joinedAt = Date.now() - 86_400_000 } = {}) => server.set(id, { hasRole, joinedAt, tag: `user${id.slice(-3)}` });
stub("services/discordBus", {
    status: () => ({ ready: !shop.down }),
    handlerOf: (cmd) => (shop.announced && ["role.members", "role.set"].includes(cmd) ? "shopbot" : null),
    canHandle: (bot, cmd) => shop.announced && bot === "shopbot" && ["role.members", "role.set"].includes(cmd),
    request: async (bot, cmd, body) => {
        shop.calls.push(cmd);
        assert.strictEqual(body.roleId, ROLE);
        if (cmd === "role.members") {
            const members = {};
            for (const id of body.userIds) {
                const m = server.get(id);
                members[id] = m ? { inGuild: true, hasRole: m.hasRole, joinedAt: m.joinedAt, tag: m.tag } : { inGuild: false };
            }
            return { guildId: "g", guildName: "ArnTo Shop", roleName: "Customer", canManage: shop.canManage, members };
        }
        const out = { added: [], removed: [], skipped: [], failed: [] };
        for (const [ids, give] of [[body.add || [], true], [body.remove || [], false]]) {
            for (const id of ids) {
                const m = server.get(id);
                if (!m) out.skipped.push({ id, why: "not in the server" });
                else if (m.hasRole === give) out.skipped.push({ id, why: "same" });
                else {
                    m.hasRole = give;
                    (give ? out.added : out.removed).push(id);
                }
            }
        }
        return out;
    },
});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });

const role = require("../server/services/customerRole");
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
        const where = err.stack.split("\n").find((l) => l.includes("customerRole.test.js")) || "";
        console.log(`  ✗ ${name}\n      ${err.message.split("\n").slice(0, 8).join("\n      ")}\n      ${where.trim()}`);
    }
};
const app = express();
app.use(express.json());
app.use("/api/customer-projects", routes);
let base;
const call = (method, url, body) =>
    new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request(`${base}${url}`, { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });

let u = 100;
const uid = () => `4273997429060${String(++u).padStart(5, "0")}`;
/** A project; customer = the Customer switch on. */
const project = (buyerID, { customer = true, expiresAt = null, projectType = "discord", name } = {}) =>
    db.create("bots", { buyerID, botID: `b${nextId}`, name: name || `P${nextId}`, projectType, expiresAt, ...(customer ? { customer: { enabled: true, buyerName: `buyer${buyerID.slice(-3)}` } } : {}) });
const has = (id) => !!server.get(id)?.hasRole;
const state = async () => db.get("customer_role");

(async () => {
    const httpServer = app.listen(0);
    await new Promise((r) => httpServer.once("listening", r));
    base = `http://127.0.0.1:${httpServer.address().port}`;

    console.log("who gets it");
    const A = uid(); // customer, Discord bot, never expires
    const B = uid(); // customer, website
    const C = uid(); // personal project only
    const D = uid(); // customer whose project expired
    const E = uid(); // customer who already had the role (given by hand)
    const F = uid(); // given the role by hand, no customer
    const G = uid(); // customer, not in the server
    let dProject;
    await check("running customer projects (bots, websites, never-expiring) → given; personal / expired / not in server → not", async () => {
        for (const id of [A, B, C, D, F]) join(id);
        join(E, { hasRole: true });
        server.get(F).hasRole = true;
        await project(A);
        await project(B, { projectType: "website" });
        await project(C, { customer: false });
        dProject = await project(D, { expiresAt: Date.now() - 1000 });
        await project(E);
        await project(G);
        const last = await role.syncNow();
        assert.strictEqual(last.error, null, JSON.stringify(last));
        assert.deepStrictEqual([has(A), has(B), has(C), has(D), has(E), has(F)], [true, true, false, false, true, true]);
        assert.strictEqual(last.added, 2);
        const s = await state();
        assert.ok(s.granted[A] && s.granted[B]);
        assert.strictEqual(s.granted[E].adopted, true, "already had it → taken over");
        assert.strictEqual(s.granted[F], undefined, "given by hand to a non-customer → never touched");
        assert.strictEqual(s.granted[G], undefined);
        assert.ok(logLines.some((l) => l.includes("Customer role: given to 2")));
    });
    await check("service ends (expired / customer switch off) → the role goes, also from one taken over", async () => {
        const db0 = await db.get("bots");
        db0.find((b) => b.buyerID === E).expiresAt = Date.now() - 1; // E's only project expires
        await db.set("bots", db0);
        await role.syncNow();
        assert.strictEqual(has(E), false);
        assert.strictEqual(has(F), true, "the hand-given one stays");
        assert.strictEqual((await state()).granted[E], undefined);
    });
    await check("renewing brings it back on the next pass", async () => {
        const b = await db.get("bots");
        b.find((x) => x._id === dProject._id).expiresAt = Date.now() + 86_400_000;
        await db.set("bots", b);
        await role.syncNow();
        assert.strictEqual(has(D), true);
    });

    console.log("taken off by hand");
    await check("taken off on Discord → recorded, never given back, even after a new purchase", async () => {
        server.get(A).hasRole = false; // the owner, on Discord
        logLines.length = 0;
        let last = await role.syncNow();
        assert.strictEqual(last.excludedByHand, 1);
        assert.strictEqual(has(A), false);
        const s = await state();
        assert.strictEqual(s.excluded[A].by, "discord");
        assert.strictEqual(s.granted[A], undefined);
        assert.ok(logLines.some((l) => l.includes("taken off by hand") && l.includes(A)));
        await project(A, { name: "Second bot" });
        last = await role.syncNow();
        assert.strictEqual(has(A), false, "still off after buying again");
        const res = await call("GET", "/api/customer-projects/role");
        assert.strictEqual(res.body.customers.find((c) => c.id === A).state, "excluded");
        assert.strictEqual(res.body.excluded.find((x) => x.id === A).customer, true);
    });
    await check("Allow again → given on the next pass", async () => {
        const res = await call("POST", "/api/customer-projects/role/allow", { userId: A });
        assert.strictEqual(res.status, 200);
        await role.syncNow();
        assert.strictEqual(has(A), true);
        assert.strictEqual((await state()).excluded[A], undefined);
    });
    await check("left the server and came back without it → given again, not counted as by hand", async () => {
        server.delete(B);
        await role.syncNow();
        assert.ok((await state()).granted[B], "still remembered while away");
        join(B, { joinedAt: Date.now() + 1000 }); // rejoined after the role was given
        const last = await role.syncNow();
        assert.strictEqual(last.excludedByHand, 0);
        assert.strictEqual(has(B), true);
    });
    await check("Take off and keep off (panel) → off now and stays off", async () => {
        const res = await call("POST", "/api/customer-projects/role/keep-off", { userId: B });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.discord.removed, [B]);
        assert.strictEqual(has(B), false);
        await role.syncNow();
        assert.strictEqual(has(B), false);
        assert.strictEqual((await state()).excluded[B].by, "panel");
        assert.strictEqual((await call("POST", "/api/customer-projects/role/keep-off", { userId: "nope" })).status, 400);
    });

    console.log("when it cannot work");
    await check("the bot cannot manage the role / has not announced the commands / bus down / off → nothing changes, the page says why", async () => {
        const C2 = uid();
        join(C2);
        await project(C2);
        shop.canManage = false;
        let last = await role.syncNow();
        assert.match(last.error, /cannot manage the role "Customer"/);
        assert.strictEqual(has(C2), false);
        shop.canManage = true;
        shop.announced = false;
        last = await role.syncNow();
        assert.match(last.error, /update and restart ArnTo-Shop/);
        assert.strictEqual((await call("GET", "/api/customer-projects/role")).body.botReady, false);
        shop.announced = true;
        shop.down = true;
        assert.deepStrictEqual(await role.syncNow(), { skipped: "bus" });
        shop.down = false;
        await call("PUT", "/api/customer-projects/role", { enabled: false });
        assert.deepStrictEqual(await role.syncNow(), { skipped: "off" });
        assert.strictEqual(has(C2), false);
        await call("PUT", "/api/customer-projects/role", { enabled: true });
        await role.syncNow();
        assert.strictEqual(has(C2), true);
    });
    await check("another role ID: the old one's record is dropped (nothing on Discord is touched); a bad ID is refused", async () => {
        let res = await call("PUT", "/api/customer-projects/role", { roleId: "abc" });
        assert.strictEqual(res.status, 400);
        res = await call("PUT", "/api/customer-projects/role", { roleId: "1247011723563503999" });
        assert.strictEqual(res.status, 200);
        const s = await state();
        assert.deepStrictEqual(s.granted, {});
        assert.ok(s.excluded[B], "who the owner keeps off stays kept off");
        await call("PUT", "/api/customer-projects/role", { roleId: ROLE });
    });
    await check("parallel passes and buttons lose nothing", async () => {
        const H = uid();
        join(H);
        await project(H);
        await Promise.all([role.syncNow(), role.keepOff(A), role.syncNow(), role.allow(B)]);
        const s = await state();
        assert.ok(s.excluded[A] && !s.excluded[B]);
        await role.syncNow();
        assert.deepStrictEqual([has(A), has(B), has(H)], [false, true, true]);
    });

    httpServer.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
