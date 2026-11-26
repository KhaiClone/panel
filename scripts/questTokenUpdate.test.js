#!/usr/bin/env node
/**
 * Checks "Update token" on /quests (POST /api/quests/:accountId/token,
 * questService.resolveReplacement / replaceToken, questMonthly.replaceToken): the pasted
 * token must log into the same account — another account's token, a dead one or no
 * answer from Discord changes nothing. It goes on the single order AND the monthly plan
 * of the account. A single order the dead token stopped runs again (a resume: no new
 * shop order), a running one restarts on it, a stopped / finished one only stores it;
 * paused, it waits for the resume. A plan keeps its end date, its token error is
 * cleared, another error stays. Nobody is told. A monthly pass reads each account
 * again at its turn, so a token replaced after the pass listed it is the one it uses.
 * Discord, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/questTokenUpdate.test.js
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
// `stale[k]`: the next read of collection k answers that older copy, once — a pass
// that listed its plans before a change.
const stale = new Map();
const db = {
    get: async (k) => {
        if (stale.has(k)) {
            const v = stale.get(k);
            stale.delete(k);
            return clone(v);
        }
        return clone(store.get(k)) ?? null;
    },
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

// What Discord answers per token: "ok" (default), "dead" (401) or "down" (unreachable),
// and which account a token logs into (default id-<token>).
const discord = new Map();
const accountOf = new Map();
const resolveCalls = [];
let QUESTS = [{ id: "q1" }];
stub("services/questEngine", {
    // A run that only ends when it is stopped: one quest that never finishes.
    QuestAutocompleter: class {
        constructor(api, opts = {}) {
            this.opts = opts;
            this.completedIds = new Set();
        }
        async fetchQuests() {
            return QUESTS;
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
        const id = accountOf.get(token) ?? `id-${token}`;
        return { ok: true, api: { token }, accountId: id, username: `user-${token}` };
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
const shopOpens = [];
stub("services/autoShopOrders", {
    ready: async () => {},
    open: async (o) => void shopOpens.push(o),
    settle: async () => {},
    questName: () => "Quest",
    monthlyName: () => "Monthly",
    SOURCE: { quest: "autoQuest", monthly: "autoQuestMonthly" },
});

const questService = require("../server/services/questService");
const questMonthly = require("../server/services/questMonthly");
const questSettings = require("../server/services/questSettings");
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
const update = (id, token) => call("POST", `/quests/${id}/token`, { token });
const single = async (id) => (await questService.listAccounts()).find((a) => a.accountId === id);
const monthly = async (id) => (await questMonthly.list()).find((m) => m.accountId === id);
const raw = (model, id) => db.findOne(model, { accountId: id });
const deadEvents = (accountId) => webhooks.filter((w) => w.accountId === accountId && w.type === "status" && w.status === "token_dead");
const tick = () => new Promise((r) => setTimeout(r, 20));
// Which token the panel holds now: a check passes only on the token Discord takes.
const holds = async (svc, id, token) => {
    const was = new Map(discord);
    for (const k of [...discord.keys()]) if (k !== token) discord.set(k, "dead");
    discord.set(token, "ok");
    const r = await svc.checkToken(id, { notify: false });
    discord.clear();
    for (const [k, v] of was) discord.set(k, v);
    return r.state === "valid";
};

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

    console.log("checks before anything is stored");

    await questService.startAccount({ token: "a1", mode: "all", webhookBotId: "auto", ref: "buyerA" });
    await tick();
    await questService.stopAccount("id-a1");

    await test("a token of another account: 400 naming it, nothing stored", async () => {
        const before = resolveCalls.length;
        const res = await update("id-a1", "other");
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, "This token logs into another account — user-other (id-other), not id-a1.");
        assert.strictEqual(resolveCalls.length, before + 1, "one look at Discord");
        assert.strictEqual(resolveCalls.at(-1).agent, AGENT, "through the token's usual egress, no lease");
        assert.ok(await holds(questService, "id-a1", "a1"), "the old token is still the stored one");
        assert.strictEqual(await raw("quest_accounts", "id-other"), undefined, "no record for the other account");
    });

    await test("a dead token: 401 with Discord's reason, nothing stored", async () => {
        discord.set("a1dead", "dead");
        accountOf.set("a1dead", "id-a1");
        const res = await update("id-a1", "a1dead");
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error, "Discord did not accept the token (HTTP 401)");
        assert.ok(await holds(questService, "id-a1", "a1"));
    });

    await test("Discord unreachable: 502, nothing stored", async () => {
        discord.set("a1down", "down");
        accountOf.set("a1down", "id-a1");
        const res = await update("id-a1", "a1down");
        assert.strictEqual(res.status, 502);
        assert.ok(await holds(questService, "id-a1", "a1"));
    });

    await test("missing token 400, unknown account 404 — Discord is not asked", async () => {
        const before = resolveCalls.length;
        assert.strictEqual((await update("id-a1", "   ")).status, 400);
        assert.strictEqual((await call("POST", "/quests/id-a1/token", {})).body.error, "Missing token.");
        const none = await update("id-nobody", "x");
        assert.deepStrictEqual({ status: none.status, error: none.body.error }, { status: 404, error: "Account not found." });
        assert.strictEqual(resolveCalls.length, before);
    });

    console.log("single orders");

    await test("stopped by hand: the token is stored, the order stays stopped", async () => {
        accountOf.set("a1new", "id-a1");
        const res = await update("id-a1", "  a1new  ");
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(Object.keys(res.body).sort(), ["accountId", "updated", "username"]);
        assert.strictEqual(res.body.username, "user-a1new");
        assert.strictEqual(res.body.updated.length, 1);
        const u = res.body.updated[0];
        assert.deepStrictEqual({ plan: u.plan, status: u.status, restarted: u.restarted }, { plan: "single", status: "stopped", restarted: false });
        assert.match(u.note, /Run again/);
        assert.strictEqual(questService.runningCount(), 0);
        assert.strictEqual((await single("id-a1")).username, "user-a1new");
        assert.ok(await holds(questService, "id-a1", "a1new"), "the trimmed new token is stored");
        // (The stub names the account after its token, so the name is left out.)
        const { username, ...rest } = await raw("quest_accounts", "id-a1");
        assert.ok(username && !JSON.stringify(rest).includes("a1new"), "stored encrypted");
    });

    await test("stopped by a dead token: runs again on the new token — no new shop order, nobody told", async () => {
        await questService.startAccount({ token: "b1", mode: "select", selectedQuestIds: ["q1"], webhookBotId: "auto", ref: "buyerB" });
        await tick();
        discord.set("b1", "dead");
        await questService.checkToken("id-b1", { notify: true });
        assert.strictEqual((await single("id-b1")).status, "token_dead");
        assert.ok((await raw("quest_accounts", "id-b1")).tokenDeadToldAt, "the buyer was told about b1");
        const opens = shopOpens.length;
        const told = deadEvents("id-b1").length;
        const leases = acquired;

        accountOf.set("b1new", "id-b1");
        const res = await update("id-b1", "b1new");
        assert.strictEqual(res.status, 200);
        const u = res.body.updated[0];
        assert.deepStrictEqual({ plan: u.plan, status: u.status, restarted: u.restarted }, { plan: "single", status: "running", restarted: true });
        assert.match(u.note, /goes on/);
        await tick();
        const a = await single("id-b1");
        assert.deepStrictEqual({ status: a.status, running: a.running, error: a.error, mode: a.mode, ids: a.selectedQuestIds, ref: a.ref }, { status: "running", running: true, error: null, mode: "select", ids: ["q1"], ref: "buyerB" });
        assert.strictEqual(acquired, leases + 1, "the run holds a lease, as any run does");
        assert.strictEqual((await raw("quest_accounts", "id-b1")).tokenDeadToldAt, null, "a death of the new token is news again");
        const rec = await raw("quest_accounts", "id-b1");
        assert.strictEqual(rec.priceLater, null, "a resume — no price-later order either");
        assert.strictEqual(shopOpens.length, opens, "no shop order opened");
        assert.strictEqual(deadEvents("id-b1").length, told);
        assert.ok(webhooks.some((w) => w.accountId === "id-b1" && w.type === "status" && w.status === "running" && w.username === "user-b1new"), "arnto-auto sees the run going on, under the new name");
        await questService.stopAccount("id-b1");
    });

    await test("running: the run restarts on the new token (one loop, not two)", async () => {
        await questService.startAccount({ token: "c1", mode: "all", webhookBotId: "auto", ref: "buyerC" });
        await tick();
        const loops = questService.runningCount();
        accountOf.set("c1new", "id-c1");
        const res = await update("id-c1", "c1new");
        const u = res.body.updated[0];
        assert.deepStrictEqual({ status: u.status, restarted: u.restarted }, { status: "running", restarted: true });
        assert.match(u.note, /restarted/);
        await tick();
        assert.strictEqual(questService.runningCount(), loops);
        assert.ok(resolveCalls.some((c) => c.token === "c1new" && c.agent === null), "the restart resolves through its lease");
        await questService.stopAccount("id-c1");
    });

    await test("finished: stored, the order stays done", async () => {
        await questService.startAccount({ token: "d1", mode: "all", webhookBotId: "auto", ref: "buyerD" });
        await questService.stopAccount("id-d1");
        await db.findOneAndUpdate("quest_accounts", { accountId: "id-d1" }, { status: "done" });
        accountOf.set("d1new", "id-d1");
        const u = (await update("id-d1", "d1new")).body.updated[0];
        assert.deepStrictEqual({ status: u.status, restarted: u.restarted }, { status: "done", restarted: false });
        assert.match(u.note, /already finished/);
        assert.strictEqual((await single("id-d1")).status, "done");
    });

    await test("Auto Quest paused: stored, the run waits for the resume", async () => {
        await questService.startAccount({ token: "e1", mode: "all", webhookBotId: "auto", ref: "buyerE" });
        await tick();
        await questSettings.setPaused(true);
        questService.pauseAll();
        accountOf.set("e1new", "id-e1");
        const u = (await update("id-e1", "e1new")).body.updated[0];
        assert.deepStrictEqual({ status: u.status, restarted: u.restarted }, { status: "paused", restarted: true });
        assert.match(u.note, /paused/);
        assert.strictEqual((await single("id-e1")).running, false);
        await questSettings.setPaused(false);
        await questService.restore();
        await tick();
        assert.strictEqual((await single("id-e1")).running, true, "the resume runs it");
        assert.ok(resolveCalls.filter((c) => c.token === "e1new").length >= 2, "on the new token");
        await questService.stopAccount("id-e1");
    });

    console.log("monthly plans");

    await test("token error: cleared, the end date and the books untouched, nobody told", async () => {
        await questMonthly.activate({ token: "m1", months: 1, ref: "buyerM", webhookBotId: "auto" });
        const end = (await monthly("id-m1")).monthlyExpiresAt;
        discord.set("m1", "dead");
        await questMonthly.checkToken("id-m1", { notify: true });
        assert.strictEqual((await monthly("id-m1")).lastError.status, "token_dead");
        assert.ok((await db.get("quest_monthly_told"))["id-m1"], "the buyer was told about m1");
        const opens = shopOpens.length;
        const told = deadEvents("id-m1").length;

        accountOf.set("m1new", "id-m1");
        const res = await update("id-m1", "m1new");
        assert.strictEqual(res.status, 200);
        const u = res.body.updated[0];
        assert.deepStrictEqual({ plan: u.plan, status: u.status, restarted: u.restarted }, { plan: "monthly", status: "monthly", restarted: false });
        assert.match(u.note, /next pass/);
        const m = await monthly("id-m1");
        assert.deepStrictEqual({ end: m.monthlyExpiresAt, lastError: m.lastError, username: m.username }, { end, lastError: null, username: "user-m1new" });
        assert.strictEqual((await db.get("quest_monthly_told"))["id-m1"], undefined, "a death of the new token is told again");
        assert.strictEqual(shopOpens.length, opens, "no shop order");
        assert.strictEqual(deadEvents("id-m1").length, told);
        assert.ok(await holds(questMonthly, "id-m1", "m1new"));
    });

    await test("another stored error stays (the new token did not fix it)", async () => {
        await questMonthly.activate({ token: "m2", months: 1, ref: "buyerM2", webhookBotId: "auto" });
        await db.set("quest_monthly_outcome", { ...((await db.get("quest_monthly_outcome")) || {}), "id-m2": { status: "error", error: "Discord returned HTTP 500", at: 1 } });
        accountOf.set("m2new", "id-m2");
        const u = (await update("id-m2", "m2new")).body.updated[0];
        assert.strictEqual(u.status, "error");
        assert.strictEqual((await monthly("id-m2")).lastError.error, "Discord returned HTTP 500");
    });

    await test("expired plan (in its grace week): stored, said so", async () => {
        await questMonthly.activate({ token: "m3", months: 1, ref: "buyerM3", webhookBotId: "auto" });
        await db.findOneAndUpdate("quest_monthly", { accountId: "id-m3" }, { monthlyExpiresAt: new Date(Date.now() - 60_000).toISOString() });
        accountOf.set("m3new", "id-m3");
        const u = (await update("id-m3", "m3new")).body.updated[0];
        assert.strictEqual(u.status, "expired");
        assert.match(u.note, /expired/);
        assert.ok(await holds(questMonthly, "id-m3", "m3new"));
    });

    await test("single order and monthly plan of one account: both get the token, one Discord look", async () => {
        await questMonthly.activate({ token: "f1", months: 1, ref: "buyerF", webhookBotId: "auto" });
        await questService.startAccount({ token: "f1", mode: "all", webhookBotId: "auto", ref: "buyerF" });
        await questService.stopAccount("id-f1");
        accountOf.set("f1new", "id-f1");
        const before = resolveCalls.length;
        const res = await update("id-f1", "f1new");
        assert.deepStrictEqual(res.body.updated.map((u) => u.plan), ["single", "monthly"]);
        assert.strictEqual(resolveCalls.length, before + 1, "stopped single: no restart, so one call");
        assert.ok(await holds(questService, "id-f1", "f1new"));
        assert.ok(await holds(questMonthly, "id-f1", "f1new"));
    });

    await test("a pass runs an account on the token stored at its turn, not the one it listed", async () => {
        await questMonthly.activate({ token: "p1", months: 1, ref: "buyerP", webhookBotId: "auto" });
        accountOf.set("p1new", "id-p1");
        // The pass lists its plans, then the token is replaced before its turn.
        const listed = clone(store.get("quest_monthly"));
        await questMonthly.replaceToken("id-p1", "p1new", await questService.resolveReplacement("id-p1", "p1new"));
        stale.set("quest_monthly", listed);
        QUESTS = [];
        const from = resolveCalls.length;
        const out = await questMonthly.runBatch({ stopped: false }, { accountIds: ["id-p1"] });
        QUESTS = [{ id: "q1" }];
        assert.strictEqual(out.processed, 1);
        const used = resolveCalls.slice(from).map((c) => c.token);
        assert.ok(used.includes("p1new") && !used.includes("p1"), `ran on ${used.join(", ")}`);
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
