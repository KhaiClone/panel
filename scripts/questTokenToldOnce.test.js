#!/usr/bin/env node
/**
 * Checks that a dead Auto Quest token is told to the buyer ONCE (arnto-auto DMs them
 * on quest.event status token_dead). Before, a monthly plan whose token died DMed the
 * buyer on every pass (twice a week) until they sent a new one.
 *   monthly — the first pass (or a "Check token" with Tell on) tells; later passes,
 *     the daily enroll scan and later checks keep it on /quests only. The mark goes
 *     when the token is shown to work: a pass that gets through, a new token
 *     (activate), a check that passes, or the plan being removed. A token whose quest
 *     calls die mid-pass while /users/@me still works is told once too.
 *   single — a run that dies tells once; a later check with Tell on does not; "Run
 *     again" (the token resolved) makes a death after it news again.
 * Discord, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/questTokenToldOnce.test.js
 */

const path = require("path");
const assert = require("assert");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
// In-memory stand-in for server/db (same merge semantics as QuickDB.js).
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

// /users/@me per token: "ok" (default) or "dead" (401). `midDead`: /users/@me works
// but the quest calls answer 403 — a token that dies mid-pass, every pass.
const discord = new Map();
const midDead = new Set();
stub("services/questEngine", {
    QuestAutocompleter: class {
        constructor(api) {
            this.api = api;
            this.completedIds = new Set();
        }
        async fetchQuests() {
            if (midDead.has(this.api.token)) throw Object.assign(new Error("HTTP 403"), { invalidToken: true });
            return [];
        }
        async autoAccept(q) {
            return q;
        }
        async enrollSelected() {}
        async processQuest() {
            return { skipped: true };
        }
    },
    resolveDiscordAccount: async (token) => {
        if (discord.get(token) === "dead") return { ok: false, invalidToken: true, reason: "Discord did not accept the token (HTTP 401)", reasonVi: "x" };
        return { ok: true, api: { token }, accountId: `id-${token}`, username: `user-${token}` };
    },
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => q,
    warmBuildNumber: () => {},
    _fields: { isEnrolled: () => true, isCompleted: () => false, isCompletable: () => true, getQuestName: () => "", getTaskType: () => "" },
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }), agentForKey: async () => null });
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event) => webhooks.push(event) });
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
const questSettings = require("../server/services/questSettings");
const questMonthly = require("../server/services/questMonthly");

// ── Helpers ──────────────────────────────────────────────────────────────────
const told = (id) => webhooks.filter((w) => w.accountId === id && w.type === "status" && w.status === "token_dead").length;
const panelEvents = [];
questService.bus.on("event", (e) => panelEvents.push(e));
const panelDead = (id) => panelEvents.filter((e) => e.accountId === id && e.type === "status" && e.status === "token_dead").length;
const plan = (token) => questMonthly.activate({ token, months: 1, ref: `buyer-${token}`, webhookBotId: "auto" });
const pass = (id) => questMonthly.runBatch(undefined, { accountIds: [id] });
const marks = async () => (await db.get("quest_monthly_told")) || {};
const monthly = async (id) => (await questMonthly.list()).find((m) => m.accountId === id);
const single = async (id) => (await questService.listAccounts()).find((a) => a.accountId === id);
const tick = () => new Promise((r) => setTimeout(r, 30));

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
    await questSettings.update({ accountDelaySec: 0 });

    console.log("monthly plans");

    await test("the first pass tells the buyer; the next passes only show it on /quests", async () => {
        await plan("m1");
        discord.set("m1", "dead");
        for (let i = 0; i < 3; i++) {
            const res = await pass("id-m1");
            assert.strictEqual(res.failed[0]?.status, "token_dead", `pass ${i + 1} still records it`);
        }
        assert.strictEqual(told("id-m1"), 1);
        assert.strictEqual(panelDead("id-m1"), 3, "/quests sees every pass live");
        assert.strictEqual((await monthly("id-m1")).lastError.status, "token_dead");
        assert.ok((await marks())["id-m1"] > 0);
    });

    await test("the enroll scan and Check token with Tell on do not tell again", async () => {
        await questMonthly.runEnrollScan();
        const r = await questMonthly.checkToken("id-m1", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "dead", status: "token_dead", notified: false });
        assert.match(r.note, /already told/);
        assert.strictEqual(told("id-m1"), 1);
    });

    await test("a pass that gets through forgets it: the next death is told once again", async () => {
        discord.set("m1", "ok");
        await pass("id-m1");
        assert.strictEqual((await monthly("id-m1")).lastError, null);
        assert.ok(!(await marks())["id-m1"]);
        discord.set("m1", "dead");
        await pass("id-m1");
        await pass("id-m1");
        assert.strictEqual(told("id-m1"), 2);
    });

    await test("a new token from the buyer (activate) forgets it too", async () => {
        discord.set("m1", "ok");
        await plan("m1");
        assert.ok(!(await marks())["id-m1"]);
        discord.set("m1", "dead");
        await pass("id-m1");
        assert.strictEqual(told("id-m1"), 3);
    });

    await test("found dead by the enroll scan first: the scan tells nobody, the pass tells once", async () => {
        await plan("m2");
        discord.set("m2", "dead");
        await questMonthly.runEnrollScan();
        await questMonthly.runEnrollScan();
        assert.strictEqual(told("id-m2"), 0);
        assert.strictEqual((await monthly("id-m2")).lastError.status, "token_dead");
        await pass("id-m2");
        await pass("id-m2");
        assert.strictEqual(told("id-m2"), 1);
    });

    await test("Check token with Tell on before any pass tells once; the pass after says nothing", async () => {
        await plan("m3");
        discord.set("m3", "dead");
        const r = await questMonthly.checkToken("id-m3", { notify: false });
        assert.strictEqual(r.notified, false);
        assert.strictEqual(told("id-m3"), 0, "notify off does not use up the telling");
        const r2 = await questMonthly.checkToken("id-m3", { notify: true });
        assert.strictEqual(r2.notified, true);
        assert.strictEqual(r2.note, null);
        await pass("id-m3");
        assert.strictEqual(told("id-m3"), 1);
    });

    await test("a check that finds the token working forgets it", async () => {
        discord.set("m3", "ok");
        const r = await questMonthly.checkToken("id-m3", { notify: false });
        assert.strictEqual(r.state, "valid");
        assert.ok(!(await marks())["id-m3"]);
        discord.set("m3", "dead");
        await pass("id-m3");
        assert.strictEqual(told("id-m3"), 2);
    });

    await test("quest calls that die mid-pass every pass (/users/@me still works) are told once", async () => {
        await plan("m4");
        midDead.add("m4");
        await pass("id-m4");
        await pass("id-m4");
        await pass("id-m4");
        assert.strictEqual(told("id-m4"), 1);
        assert.strictEqual((await monthly("id-m4")).lastError.status, "token_dead");
        // Once a pass gets through, a later death is news again.
        midDead.delete("m4");
        await pass("id-m4");
        midDead.add("m4");
        await pass("id-m4");
        assert.strictEqual(told("id-m4"), 2);
    });

    await test("removing the plan drops its mark", async () => {
        assert.ok((await marks())["id-m2"]);
        await questMonthly.remove("id-m2");
        assert.ok(!(await marks())["id-m2"]);
    });

    console.log("single orders");

    await test("a run that dies tells once; Check token with Tell on does not tell again", async () => {
        midDead.add("s1");
        await questService.startAccount({ token: "s1", mode: "all", webhookBotId: "auto", ref: "buyerS" });
        await tick();
        assert.strictEqual((await single("id-s1")).status, "token_dead");
        assert.strictEqual(told("id-s1"), 1);
        discord.set("s1", "dead");
        const r = await questService.checkToken("id-s1", { notify: true });
        assert.deepStrictEqual({ state: r.state, status: r.status, notified: r.notified }, { state: "dead", status: "token_dead", notified: false });
        assert.match(r.note, /already told/);
        assert.strictEqual(told("id-s1"), 1);
        assert.ok(!("tokenDeadToldAt" in (await single("id-s1"))), "the mark is not in the public view");
    });

    await test("Run again: the token resolved, so a death after it is told again", async () => {
        discord.set("s1", "ok");
        await questService.resumeAccount("id-s1");
        await tick();
        assert.strictEqual((await single("id-s1")).status, "token_dead");
        assert.strictEqual(told("id-s1"), 2);
    });

    await test("checks: notify off does not use up the telling, then once with Tell on", async () => {
        await questService.startAccount({ token: "s2", mode: "all", webhookBotId: "auto", ref: "buyerS2" });
        await questService.stopAccount("id-s2");
        discord.set("s2", "dead");
        assert.strictEqual((await questService.checkToken("id-s2", { notify: false })).notified, false);
        assert.strictEqual(told("id-s2"), 0);
        assert.strictEqual((await questService.checkToken("id-s2", { notify: true })).notified, true);
        const again = await questService.checkToken("id-s2", { notify: true });
        assert.strictEqual(again.notified, false);
        assert.match(again.note, /already told/);
        assert.strictEqual(told("id-s2"), 1);
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
