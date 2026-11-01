#!/usr/bin/env node
/**
 * Checks the quest events arnto-auto builds its order feed from: one message per
 * single order and per monthly pass, listing every quest as waiting and ticking each
 * off. A run sends run_start (every quest about to run) once after the pre-scan, then
 * quest_done per quest (with questId); a monthly pass carries its runId on all of
 * them and ends with run_end — not when the account runs again after an egress retry
 * (same runId), is stopped, or its token died. Discord, the proxy pool and the
 * callbacks are stubbed.
 * Run:  node scripts/questFeedEvents.test.js
 */

const path = require("path");
const assert = require("assert");

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
    findOneAndDelete: async (m, q) => void store.set(m, (store.get(m) || []).filter((e) => !match(e, q))),
};
stub("db", db);

// Each token has its own quests. Behaviour by token: "flaky-*" — the egress route
// dies after the first quest of the first run; "dying-*" — Discord rejects the
// token after the first quest; "stop-*" — the test stops the pass after one quest.
const accounts = new Map(); // token → { quests: [{ id, name, taskType, done }], runs }
const abortOf = new Map(); // token → abort object of the current monthly pass
const questsFor = (token) => {
    if (!accounts.has(token)) {
        accounts.set(token, {
            runs: 0,
            quests: [
                { id: `${token}-1`, name: "Quest One", taskType: "WATCH_VIDEO", done: false },
                { id: `${token}-2`, name: "Quest Two", taskType: "PLAY_ON_DESKTOP", done: false },
                { id: `${token}-3`, name: "Quest Three", taskType: "WATCH_VIDEO", done: false },
            ],
        });
    }
    return accounts.get(token);
};
class QuestAutocompleter {
    constructor(api, opts = {}) {
        this.api = api;
        this.opts = opts;
        this.completedIds = new Set();
        this.acc = questsFor(api.token);
        this.run = ++this.acc.runs;
        this.processed = 0;
    }
    async fetchQuests() {
        return this.acc.quests.filter((q) => !q.done);
    }
    async autoAccept(q) {
        return q;
    }
    async enrollSelected() {}
    async processQuest(q) {
        const t = this.api.token;
        if (this.processed === 1) {
            if (t.startsWith("flaky-") && this.run === 1) throw Object.assign(new Error("Discord unreachable for 60s"), { egressDown: true });
            if (t.startsWith("dying-")) throw Object.assign(new Error("HTTP 401"), { invalidToken: true });
            if (t.startsWith("stop-")) abortOf.get(t).stopped = true;
        }
        this.processed++;
        q.done = true;
        this.completedIds.add(q.id);
        this.opts.onEvent?.({ type: "quest_done", questId: String(q.id), name: q.name, took: 1 });
        return {};
    }
}
stub("services/questEngine", {
    QuestAutocompleter,
    resolveDiscordAccount: async (token) => ({ ok: true, api: { token }, accountId: token, username: token }),
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => ({ id: q.id, name: q.name, taskType: q.taskType, needed: 1, media: null }),
    warmBuildNumber: () => {},
    _fields: {
        isEnrolled: () => true,
        isCompleted: (q) => q.done,
        isCompletable: () => true,
        getQuestName: (q) => q.name,
        getTaskType: (q) => q.taskType,
    },
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }), agentForKey: async () => null });
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event, busCmd) => webhooks.push({ ...event, busCmd }) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });
stub("services/discordBus", { handlerOf: () => null });

const questService = require("../server/services/questService");
const questSettings = require("../server/services/questSettings");
const questMonthly = require("../server/services/questMonthly");

const of = (accountId) => webhooks.filter((w) => w.accountId === accountId);
const types = (list) => list.map((w) => w.type);

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
const until = async (cond) => {
    for (let i = 0; i < 500; i++) {
        if (cond()) return;
        await new Promise((r) => setImmediate(r));
    }
    throw new Error("condition never met");
};

(async () => {
    await questSettings.update({ accountDelaySec: 0 });

    console.log("single order — what arnto-auto's feed hears");

    await test("run_start lists the selected quests once, then quest_done for each with its id", async () => {
        await questService.startAccount({ token: "s1", mode: "select", selectedQuestIds: ["s1-1", "s1-3"], webhookBotId: "auto", ref: "buyer" });
        await until(() => of("s1").some((w) => w.type === "status" && w.status === "done"));
        const evs = of("s1");
        const start = evs.filter((w) => w.type === "run_start");
        assert.strictEqual(start.length, 1);
        assert.deepStrictEqual(start[0].quests, [
            { questId: "s1-1", name: "Quest One", taskType: "WATCH_VIDEO" },
            { questId: "s1-3", name: "Quest Three", taskType: "WATCH_VIDEO" },
        ]);
        assert.strictEqual(start[0].ref, "buyer");
        assert.strictEqual(start[0].plan, "single");
        assert.strictEqual(start[0].busCmd, "quest.event");
        assert.deepStrictEqual(evs.filter((w) => w.type === "quest_done").map((w) => w.questId), ["s1-1", "s1-3"]);
        // run_start comes before the first quest_done.
        assert.ok(types(evs).indexOf("run_start") < types(evs).indexOf("quest_done"));
        // The UI's quest_pending cards are not forwarded.
        assert.ok(!evs.some((w) => w.type === "quest_pending"));
    });

    await test("nothing left to run: no run_start", async () => {
        for (const q of questsFor("s2").quests) q.done = true;
        await questService.startAccount({ token: "s2", mode: "all", webhookBotId: "auto", ref: "buyer" });
        await until(() => of("s2").some((w) => w.type === "status" && w.status === "done"));
        assert.ok(!of("s2").some((w) => w.type === "run_start"));
    });

    console.log("monthly pass — run_start / quest_done / run_end with the pass's runId");

    await test("one pass: every quest waiting, each done, then run_end — all on one runId", async () => {
        await questMonthly.activate({ token: "m1", months: 1, ref: "buyer", webhookBotId: "auto" });
        await questMonthly.runBatch(undefined, { accountIds: ["m1"] });
        const evs = of("m1").filter((w) => ["run_start", "quest_done", "run_end"].includes(w.type));
        assert.deepStrictEqual(types(evs), ["run_start", "quest_done", "quest_done", "quest_done", "run_end"]);
        const runId = evs[0].runId;
        assert.ok(runId && evs.every((w) => w.runId === runId));
        assert.deepStrictEqual(evs[0].quests.map((q) => q.questId), ["m1-1", "m1-2", "m1-3"]);
        assert.deepStrictEqual(evs.filter((w) => w.type === "quest_done").map((w) => w.questId), ["m1-1", "m1-2", "m1-3"]);
        assert.strictEqual(evs[1].questName, "Quest One");
        assert.deepStrictEqual({ completed: evs[4].completed, ok: evs[4].ok, plan: evs[4].plan }, { completed: 3, ok: true, plan: "monthly" });
    });

    await test("the next pass has a new runId", async () => {
        for (const q of questsFor("m1").quests) q.done = false;
        const before = of("m1").find((w) => w.type === "run_start").runId;
        await questMonthly.runBatch(undefined, { accountIds: ["m1"] });
        const starts = of("m1").filter((w) => w.type === "run_start");
        assert.strictEqual(starts.length, 2);
        assert.notStrictEqual(starts[1].runId, before);
    });

    await test("an egress retry runs again under the same runId; run_end only after it", async () => {
        await questMonthly.activate({ token: "flaky-m", months: 1, ref: "buyer", webhookBotId: "auto" });
        await questSettings.update({ accountDelaySec: 0 });
        const done = questMonthly.runBatch(undefined, { accountIds: ["flaky-m"] });
        // The retry waits EGRESS_RETRY_DELAY_SEC — skip the wait.
        const realSetTimeout = global.setTimeout;
        global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 1), ...a);
        try {
            await done;
        } finally {
            global.setTimeout = realSetTimeout;
        }
        const evs = of("flaky-m").filter((w) => ["run_start", "quest_done", "run_end"].includes(w.type));
        assert.deepStrictEqual(types(evs), ["run_start", "quest_done", "run_start", "quest_done", "quest_done", "run_end"]);
        assert.strictEqual(new Set(evs.map((w) => w.runId)).size, 1);
        // The second run_start lists only what is still left.
        assert.deepStrictEqual(evs[2].quests.map((q) => q.questId), ["flaky-m-2", "flaky-m-3"]);
    });

    await test("a token that dies mid-pass: token_dead, no run_end", async () => {
        await questMonthly.activate({ token: "dying-m", months: 1, ref: "buyer", webhookBotId: "auto" });
        await questMonthly.runBatch(undefined, { accountIds: ["dying-m"] });
        const evs = of("dying-m");
        assert.ok(evs.some((w) => w.type === "run_start"));
        assert.ok(evs.some((w) => w.type === "status" && w.status === "token_dead"));
        assert.ok(!evs.some((w) => w.type === "run_end"));
    });

    await test("a pass stopped half-way: no run_end", async () => {
        await questMonthly.activate({ token: "stop-m", months: 1, ref: "buyer", webhookBotId: "auto" });
        const abort = { stopped: false };
        abortOf.set("stop-m", abort);
        await questMonthly.runBatch(abort, { accountIds: ["stop-m"] });
        const evs = of("stop-m");
        assert.ok(evs.some((w) => w.type === "run_start"));
        assert.ok(!evs.some((w) => w.type === "run_end"));
    });

    await test("nothing to do in a pass: arnto-auto hears nothing", async () => {
        await questMonthly.activate({ token: "m-idle", months: 1, ref: "buyer", webhookBotId: "auto" });
        for (const q of questsFor("m-idle").quests) q.done = true;
        webhooks.length = 0;
        await questMonthly.runBatch(undefined, { accountIds: ["m-idle"] });
        assert.deepStrictEqual(of("m-idle"), []);
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
