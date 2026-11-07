#!/usr/bin/env node
/**
 * Checks the "Check token" action on /quests (questService.checkToken,
 * questMonthly.checkToken, POST /api/quests/:accountId/check-token): one GET
 * /users/@me through agentForKey — never a lease, so no proxy rotates. A dead token is
 * recorded like a run records one (a running single loop stops, token_dead; a monthly
 * plan keeps it as its last error), and arnto-auto hears it only with `notify` and a
 * linked buyer — never for the panel's own unreadable copy, a finished single order or
 * an expired plan. No verdict (Discord unreachable) changes nothing; a token that works
 * clears a monthly token error. Discord, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/questTokenCheck.test.js
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
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
const db = {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    create: async (m, d) => {
        store.set(m, [...(store.get(m) || []), clone(d)]);
        return d;
    },
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
        const hit = arr.find((e) => match(e, q));
        store.set(m, arr.filter((e) => !match(e, q)));
        return clone(hit) ?? null;
    },
};
stub("db", db);

// What Discord answers per token: "ok" (default), "dead" (401) or "down" (unreachable).
const discord = new Map();
const resolveCalls = [];
stub("services/questEngine", {
    // A run that only ends when it is stopped: one quest that never finishes.
    QuestAutocompleter: class {
        constructor(api, opts = {}) {
            this.opts = opts;
            this.completedIds = new Set();
        }
        async fetchQuests() {
            return [{ id: "q1" }];
        }
        async autoAccept(q) {
            return q;
        }
        async enrollSelected() {}
        async processQuest() {
            while (!this.opts.abort?.stopped) await new Promise((r) => setTimeout(r, 5));
            throw Object.assign(new Error("stopped"), { aborted: true });
        }
    },
    resolveDiscordAccount: async (token, agent) => {
        resolveCalls.push({ token, agent });
        const how = discord.get(token) ?? "ok";
        if (how === "dead") return { ok: false, invalidToken: true, reason: "Discord did not accept the token (HTTP 401)", reasonVi: "x" };
        if (how === "down") return { ok: false, invalidToken: false, reason: "Could not reach Discord: timeout", reasonVi: "x" };
        return { ok: true, api: { token }, accountId: `id-${token}`, username: `user-${token}` };
    },
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => ({ id: q.id, name: "Quest", taskType: "WATCH_VIDEO", needed: 1, media: null }),
    warmBuildNumber: () => {},
    _fields: {
        isEnrolled: () => true,
        isCompleted: () => false,
        isCompletable: () => true,
        getQuestName: () => "Quest",
        getTaskType: () => "WATCH_VIDEO",
    },
});
let acquired = 0;
const AGENT = { egress: "sticky" };
stub("services/proxyPool", {
    acquire: async () => {
        acquired++;
        return { agent: null, release: () => {} };
    },
    agentForKey: async () => AGENT,
});
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event, busCmd) => webhooks.push({ ...event, busCmd }) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });
stub("services/discordBus", { handlerOf: () => "auto" });
stub("services/autoShopOrders", {
    ready: async () => {},
    open: async () => {},
    settle: async () => {},
    questName: () => "Quest",
    monthlyName: () => "Monthly",
    SOURCE: { quest: "autoQuest", monthly: "autoQuestMonthly" },
});

const questService = require("../server/services/questService");
const questMonthly = require("../server/services/questMonthly");
const router = require("../server/routes/quests");

// ── Helpers ──────────────────────────────────────────────────────────────────
let server;
const call = (method, p, body) =>
    new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
            { port: server.address().port, path: p, method, agent: false, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
            (res) => {
                let out = "";
                res.on("data", (c) => (out += c));
                res.on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
            },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
const deadEvents = (accountId) => webhooks.filter((w) => w.accountId === accountId && w.type === "status" && w.status === "token_dead");
const panelEvents = [];
questService.bus.on("event", (e) => panelEvents.push(e));
const single = async (id) => (await questService.listAccounts()).find((a) => a.accountId === id);
const monthly = async (id) => (await questMonthly.list()).find((m) => m.accountId === id);
const tick = () => new Promise((r) => setTimeout(r, 20));

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};

(async () => {
    const app = express();
    app.use(express.json());
    app.use("/quests", router);
    server = app.listen(0);

    console.log("single orders");

    await test("a working token: nothing changes, the run keeps going, no lease taken", async () => {
        await questService.startAccount({ token: "s1", mode: "all", webhookBotId: "auto", ref: "buyer1" });
        await tick();
        const before = acquired;
        const r = await questService.checkToken("id-s1", { notify: true });
        assert.deepStrictEqual(
            { state: r.state, status: r.status, notified: r.notified, reason: r.reason, plan: r.plan, username: r.username },
            { state: "valid", status: "running", notified: false, reason: null, plan: "single", username: "user-s1" },
        );
        assert.strictEqual(acquired, before, "a check never acquires a lease");
        assert.strictEqual(resolveCalls.at(-1).agent, AGENT, "it goes through the account's usual egress (agentForKey)");
        assert.strictEqual(questService.runningCount(), 1);
        assert.strictEqual(deadEvents("id-s1").length, 0);
    });

    await test("dead, notify off: the run stops, token_dead on the panel, arnto-auto hears nothing", async () => {
        discord.set("s1", "dead");
        panelEvents.length = 0;
        const r = await questService.checkToken("id-s1", { notify: false });
        assert.strictEqual(r.state, "dead");
        assert.strictEqual(r.status, "token_dead");
        assert.strictEqual(r.notified, false);
        assert.strictEqual(r.reason, "Discord did not accept the token (HTTP 401)");
        assert.strictEqual(questService.runningCount(), 0, "the loop is stopped");
        const a = await single("id-s1");
        assert.strictEqual(a.status, "token_dead");
        assert.strictEqual(a.error, "Token check: Discord did not accept the token (HTTP 401)");
        await tick();
        assert.strictEqual(deadEvents("id-s1").length, 0, "no webhook");
        assert.ok(panelEvents.some((e) => e.accountId === "id-s1" && e.type === "status" && e.status === "token_dead"), "/quests still sees it live");
        // The stopped loop does not overwrite the status afterwards.
        assert.strictEqual((await single("id-s1")).status, "token_dead");
    });

    await test("dead, notify on: arnto-auto is told, with the buyer and the account's name", async () => {
        const r = await questService.checkToken("id-s1", { notify: true });
        assert.strictEqual(r.notified, true);
        assert.strictEqual(r.note, null);
        const ev = deadEvents("id-s1");
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual(
            { ref: ev[0].ref, username: ev[0].username, plan: ev[0].plan, busCmd: ev[0].busCmd },
            { ref: "buyer1", username: "user-s1", plan: "single", busCmd: "quest.event" },
        );
    });

    await test("the token works again: reported, the status is left for Run again", async () => {
        discord.set("s1", "ok");
        const r = await questService.checkToken("id-s1", { notify: true });
        assert.strictEqual(r.state, "valid");
        assert.strictEqual(r.status, "token_dead");
        assert.match(r.note, /Run again/);
    });

    await test("no buyer linked: notify on tells nobody, and says so", async () => {
        await questService.startAccount({ token: "s2", mode: "all", webhookBotId: "auto" });
        discord.set("s2", "dead");
        const r = await questService.checkToken("id-s2", { notify: true });
        assert.strictEqual(r.status, "token_dead");
        assert.strictEqual(r.notified, false);
        assert.match(r.note, /No buyer is linked/);
        await tick();
        assert.strictEqual(deadEvents("id-s2").length, 0);
    });

    await test("a finished run is only reported — never told, status stays done", async () => {
        await questService.startAccount({ token: "s3", mode: "all", webhookBotId: "auto", ref: "buyer3" });
        await questService.stopAccount("id-s3");
        await db.findOneAndUpdate("quest_accounts", { accountId: "id-s3" }, { status: "done" });
        discord.set("s3", "dead");
        const r = await questService.checkToken("id-s3", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "dead", status: "done", notified: false });
        assert.match(r.note, /already finished/);
        assert.strictEqual((await single("id-s3")).status, "done");
        assert.strictEqual(deadEvents("id-s3").length, 0);
    });

    await test("Discord unreachable: no verdict, nothing changes", async () => {
        await questService.startAccount({ token: "s4", mode: "all", webhookBotId: "auto", ref: "buyer4" });
        await tick();
        discord.set("s4", "down");
        const r = await questService.checkToken("id-s4", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "unknown", status: "running", notified: false });
        assert.strictEqual(r.reason, "Could not reach Discord: timeout");
        assert.strictEqual(questService.runningCount(), 1);
        await questService.stopAccount("id-s4");
    });

    await test("the panel's copy cannot be decrypted: token_dead, but the buyer is never told", async () => {
        await questService.startAccount({ token: "s5", mode: "all", webhookBotId: "auto", ref: "buyer5" });
        await questService.stopAccount("id-s5");
        await db.findOneAndUpdate("quest_accounts", { accountId: "id-s5" }, { tokenTag: Buffer.alloc(16).toString("base64") });
        const r = await questService.checkToken("id-s5", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "dead", status: "token_dead", notified: false });
        assert.match(r.note, /cannot read its own copy/);
        await tick();
        assert.strictEqual(deadEvents("id-s5").length, 0);
    });

    console.log("monthly plans");

    await test("dead, notify off: kept as the plan's last error, arnto-auto hears nothing", async () => {
        await questMonthly.activate({ token: "m1", months: 1, ref: "buyerM", webhookBotId: "auto" });
        discord.set("m1", "dead");
        const r = await questMonthly.checkToken("id-m1", { notify: false });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified, plan: r.plan }, { state: "dead", status: "token_dead", notified: false, plan: "monthly" });
        const m = await monthly("id-m1");
        assert.strictEqual(m.lastError.status, "token_dead");
        assert.strictEqual(m.lastError.error, "Token check: Discord did not accept the token (HTTP 401)");
        assert.strictEqual(deadEvents("id-m1").length, 0);
    });

    await test("dead, notify on: arnto-auto is told (plan monthly)", async () => {
        const r = await questMonthly.checkToken("id-m1", { notify: true });
        assert.strictEqual(r.notified, true);
        const ev = deadEvents("id-m1");
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual({ ref: ev[0].ref, plan: ev[0].plan, username: ev[0].username }, { ref: "buyerM", plan: "monthly", username: "user-m1" });
    });

    await test("the token works again: the token error is cleared", async () => {
        discord.set("m1", "ok");
        const r = await questMonthly.checkToken("id-m1", { notify: true });
        assert.strictEqual(r.state, "valid");
        assert.strictEqual(r.status, "monthly");
        assert.match(r.note, /cleared/);
        assert.strictEqual((await monthly("id-m1")).lastError, null);
    });

    await test("a working token leaves a stored non-token error alone", async () => {
        await questMonthly.activate({ token: "m2", months: 1, ref: "buyerM2", webhookBotId: "auto" });
        await db.set("quest_monthly_outcome", { ...((await db.get("quest_monthly_outcome")) || {}), "id-m2": { status: "error", error: "Discord returned HTTP 500", at: 1 } });
        const r = await questMonthly.checkToken("id-m2", { notify: false });
        assert.strictEqual(r.state, "valid");
        assert.strictEqual(r.status, "error");
        assert.strictEqual((await monthly("id-m2")).lastError.error, "Discord returned HTTP 500");
    });

    await test("an expired plan is only reported — never told, nothing stored", async () => {
        await questMonthly.activate({ token: "m3", months: 1, ref: "buyerM3", webhookBotId: "auto" });
        await db.findOneAndUpdate("quest_monthly", { accountId: "id-m3" }, { monthlyExpiresAt: new Date(Date.now() - 60_000).toISOString() });
        discord.set("m3", "dead");
        const r = await questMonthly.checkToken("id-m3", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "dead", status: "expired", notified: false });
        assert.match(r.note, /expired/);
        assert.strictEqual((await monthly("id-m3")).lastError, null);
        assert.strictEqual(deadEvents("id-m3").length, 0);
    });

    console.log("route");

    await test("POST /:accountId/check-token picks the plan and answers in English", async () => {
        discord.set("m1", "dead");
        const res = await call("POST", "/quests/id-m1/check-token", { plan: "monthly", notify: false });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            Object.keys(res.body).sort(),
            ["accountId", "note", "notified", "plan", "reason", "state", "status", "username"],
        );
        assert.strictEqual(res.body.state, "dead");
        // The single-order record of the same id would be a different account: 404 here.
        const none = await call("POST", "/quests/id-m1/check-token", { plan: "single" });
        assert.strictEqual(none.status, 404);
        assert.strictEqual(none.body.error, "Account not found.");
    });

    await test("notify must be exactly true — anything else tells nobody", async () => {
        const before = deadEvents("id-m1").length;
        const res = await call("POST", "/quests/id-m1/check-token", { plan: "monthly", notify: "true" });
        assert.strictEqual(res.body.notified, false);
        assert.strictEqual(deadEvents("id-m1").length, before);
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
