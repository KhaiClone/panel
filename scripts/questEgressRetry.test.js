#!/usr/bin/env node
/**
 * Checks what a run does when its egress route dies (questEngine throws `egressDown`
 * after a minute with no answer from Discord): the lease goes back as failed (a fresh
 * IP) and the account runs once more — at the end of a monthly pass, or 60s later for
 * a single order — instead of being recorded as failed; a second death is an error.
 * Discord, the proxy pool and the callbacks are stubbed; timers run on a fake clock.
 * Run:  node scripts/questEgressRetry.test.js
 */

const path = require("path");
const assert = require("assert");

// ── Fake clock: timers fire in order, time jumps to each one ─────────────────
let now = Date.UTC(2026, 9, 31, 12);
Date.now = () => now;
const realSetImmediate = setImmediate;
const timers = [];
global.setTimeout = (fn, ms = 0) => {
    const t = { fn, at: now + ms, unref: () => t, ref: () => t };
    timers.push(t);
    return t;
};
global.clearTimeout = (t) => {
    const i = timers.indexOf(t);
    if (i !== -1) timers.splice(i, 1);
};
/** Settle promises, firing the next timer whenever nothing else is left, until cond(). */
async function runUntil(cond, { max = 10_000 } = {}) {
    for (let i = 0; i < max; i++) {
        await new Promise((r) => realSetImmediate(r));
        if (cond()) return;
        if (!timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.fn();
    }
    throw new Error("runUntil: condition never met");
}
/** Let pending promises finish without firing any timer. */
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => realSetImmediate(r));
};

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

// The token names the account and how its route behaves: "once-*" dies on the first
// run only, "always-*" on every run, anything else is fine.
const runs = []; // { token, at } per run started
class QuestAutocompleter {
    constructor(api) {
        this.api = api;
        this.completedIds = new Set();
        runs.push({ token: api.token, at: now });
        this.run = runs.filter((r) => r.token === api.token).length;
    }
    async fetchQuests() {
        const t = this.api.token;
        if (t.startsWith("always-") || (t.startsWith("once-") && this.run === 1)) {
            const e = new Error("Discord unreachable for 60s: Proxy connection ended before receiving CONNECT response");
            e.egressDown = true;
            throw e;
        }
        return [];
    }
    async autoAccept(q) {
        return q;
    }
    async enrollSelected() {}
}
// The first call of a run (GET /users/@me): a test can make the next N of them get no
// answer through the proxy, or the token dead — set after activate(), which calls it too.
const TLS_DROP = "Could not reach Discord: Client network socket disconnected before secure TLS connection was established";
const resolveFails = new Map(); // token → network failures still to give
const deadTokens = new Set();
const resolves = []; // { token, at } per call
stub("services/questEngine", {
    QuestAutocompleter,
    resolveDiscordAccount: async (token) => {
        resolves.push({ token, at: now });
        const left = resolveFails.get(token) || 0;
        if (left > 0) {
            resolveFails.set(token, left - 1);
            return { ok: false, invalidToken: false, reason: TLS_DROP };
        }
        if (deadTokens.has(token)) return { ok: false, invalidToken: true, reason: "Discord did not accept the token (HTTP 401)" };
        return { ok: true, api: { token }, accountId: token, username: token };
    },
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => q,
    warmBuildNumber: () => {},
    _fields: { isEnrolled: () => true, isCompleted: () => true, isCompletable: () => true, getQuestName: () => "", getTaskType: () => "" },
});
const releases = []; // { token, failed }
stub("services/proxyPool", {
    acquire: async (token) => ({ agent: null, release: (o = {}) => releases.push({ token, failed: !!o.failed }) }),
    agentForKey: async () => null,
});
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event) => webhooks.push(event) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });
stub("services/discordBus", { handlerOf: () => null });

const questService = require("../server/services/questService");
const questSettings = require("../server/services/questSettings");
const questMonthly = require("../server/services/questMonthly");

const runsOf = (token) => runs.filter((r) => r.token === token);
const releasesOf = (token) => releases.filter((r) => r.token === token).map((r) => r.failed);
const single = (id) => db.findOne("quest_accounts", { accountId: id });

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
    await questSettings.update({ accountDelaySec: 3 });

    console.log("monthly pass — the egress route dies");

    await test("dies once: runs again after the others, a minute later, nothing recorded", async () => {
        for (const t of ["once-m", "fine-m"]) await questMonthly.activate({ token: t, months: 1, ref: t });
        let res;
        questMonthly.runBatch().then((r) => (res = r));
        await runUntil(() => res);
        assert.deepStrictEqual(runs.map((r) => r.token), ["once-m", "fine-m", "once-m"]);
        assert.ok(runsOf("once-m")[1].at - runsOf("once-m")[0].at >= 60_000);
        assert.deepStrictEqual(releasesOf("once-m"), [true, false]);
        assert.deepStrictEqual(res.failed, []);
        assert.strictEqual(res.processed, 2);
        assert.strictEqual(res.total, 2);
        assert.deepStrictEqual((await db.get("quest_monthly_outcome")) || {}, {});
    });

    await test("dies twice: recorded as an error with the reason, not run a third time", async () => {
        await questMonthly.activate({ token: "always-m", months: 1, ref: "always-m" });
        runs.length = releases.length = 0;
        let res;
        questMonthly.runBatch(undefined, { accountIds: ["always-m"] }).then((r) => (res = r));
        await runUntil(() => res);
        assert.strictEqual(runsOf("always-m").length, 2);
        assert.deepStrictEqual(releasesOf("always-m"), [true, true]);
        assert.strictEqual(res.failed.length, 1);
        assert.strictEqual(res.failed[0].status, "error");
        assert.match(res.failed[0].error, /unreachable for 60s: Proxy connection ended/);
        assert.strictEqual(res.processed, 0);
    });

    await test("a pass stopped while the retry waits does not run it", async () => {
        await questMonthly.remove("always-m");
        runs.length = releases.length = 0;
        const abort = { stopped: false };
        let res;
        questMonthly.runBatch(abort, { accountIds: ["once-m"] }).then((r) => (res = r));
        await runUntil(() => releases.length === 1);
        abort.stopped = true;
        await runUntil(() => res);
        assert.strictEqual(runsOf("once-m").length, 1);
        assert.strictEqual(res.aborted, true);
    });

    console.log("monthly pass — the first call gets no answer");

    // What the pass prints, for these tests only.
    const said = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...a) => said.push(["warn", a.join(" ")]);
    console.error = (...a) => said.push(["error", a.join(" ")]);
    const resolvesOf = (token) => resolves.filter((r) => r.token === token);

    await test("no answer once: runs again after the others, a minute later, on a fresh lease; nothing recorded", async () => {
        for (const t of ["tls-once-m", "fine-2-m"]) await questMonthly.activate({ token: t, months: 1, ref: t });
        resolveFails.set("tls-once-m", 1);
        runs.length = releases.length = resolves.length = said.length = 0;
        let res;
        questMonthly.runBatch(undefined, { accountIds: ["tls-once-m", "fine-2-m"] }).then((r) => (res = r));
        await runUntil(() => res);
        assert.deepStrictEqual(resolves.map((r) => r.token), ["tls-once-m", "fine-2-m", "tls-once-m"]);
        assert.ok(resolvesOf("tls-once-m")[1].at - resolvesOf("tls-once-m")[0].at >= 60_000);
        assert.deepStrictEqual(releasesOf("tls-once-m"), [true, false]);
        assert.strictEqual(runsOf("tls-once-m").length, 1, "the quests ran on the second go");
        assert.deepStrictEqual(res.failed, []);
        assert.strictEqual(res.processed, 2);
        assert.ok(said.some(([k, t]) => k === "warn" && t.includes("[Monthly] tls-once-m: Could not reach Discord") && t.includes("again at the end of the pass")));
        await settle();
        assert.strictEqual(((await db.get("quest_monthly_outcome")) || {})["tls-once-m"] ?? null, null);
    });

    await test("no answer twice: an error with the reason, printed; not run a third time", async () => {
        resolveFails.set("tls-once-m", 2);
        runs.length = releases.length = resolves.length = said.length = 0;
        let res;
        questMonthly.runBatch(undefined, { accountIds: ["tls-once-m"] }).then((r) => (res = r));
        await runUntil(() => res);
        assert.strictEqual(resolvesOf("tls-once-m").length, 2);
        assert.deepStrictEqual(releasesOf("tls-once-m"), [true, true]);
        assert.strictEqual(runs.length, 0);
        assert.strictEqual(res.failed.length, 1);
        assert.strictEqual(res.failed[0].status, "error");
        assert.strictEqual(res.failed[0].error, TLS_DROP);
        assert.ok(said.some(([k, t]) => k === "error" && t === `[Monthly] tls-once-m error: ${TLS_DROP}`));
        await settle();
        assert.strictEqual((await db.get("quest_monthly_outcome"))["tls-once-m"].status, "error");
    });

    await test("a dead token is not run again: token_dead at once, the lease not marked failed", async () => {
        deadTokens.add("fine-2-m");
        runs.length = releases.length = resolves.length = 0;
        let res;
        questMonthly.runBatch(undefined, { accountIds: ["fine-2-m"] }).then((r) => (res = r));
        await runUntil(() => res);
        assert.strictEqual(resolvesOf("fine-2-m").length, 1);
        assert.deepStrictEqual(releasesOf("fine-2-m"), [false]);
        assert.strictEqual(res.failed.length, 1);
        assert.strictEqual(res.failed[0].status, "token_dead");
        deadTokens.delete("fine-2-m");
    });

    console.warn = realWarn;
    console.error = realError;

    console.log("single order — the egress route dies");

    await test("dies once: a fresh lease a minute later, then done; the buyer hears no error", async () => {
        runs.length = releases.length = webhooks.length = 0;
        await questService.startAccount({ token: "once-s", mode: "all", webhookUrl: "http://hook" });
        await runUntil(() => runsOf("once-s").length === 2 && releases.length === 2);
        await settle();
        assert.strictEqual((await single("once-s")).status, "done");
        assert.ok(runsOf("once-s")[1].at - runsOf("once-s")[0].at >= 60_000);
        assert.deepStrictEqual(releasesOf("once-s"), [true, false]);
        assert.ok(!webhooks.some((w) => w.type === "status" && w.status === "error"));
    });

    await test("dies twice: error with the reason, no third run", async () => {
        runs.length = releases.length = 0;
        await questService.startAccount({ token: "always-s", mode: "all" });
        await runUntil(() => releases.length === 2);
        await settle();
        const rec = await single("always-s");
        assert.strictEqual(rec.status, "error");
        assert.match(rec.error, /unreachable for 60s/);
        assert.strictEqual(runsOf("always-s").length, 2);
        assert.strictEqual(timers.length, 0);
    });

    await test("stopped while the retry waits: not run again", async () => {
        runs.length = releases.length = 0;
        await questService.startAccount({ token: "once-t", mode: "all" });
        await runUntil(() => releases.length === 1);
        await questService.stopAccount("once-t");
        await runUntil(() => !timers.length);
        await settle();
        assert.strictEqual(runsOf("once-t").length, 1);
        assert.strictEqual((await single("once-t")).status, "stopped");
    });

    await test("paused while the retry waits: left for the resume, which runs it", async () => {
        runs.length = releases.length = 0;
        await questService.startAccount({ token: "once-p", mode: "all" });
        await runUntil(() => releases.length === 1);
        await questSettings.setPaused(true);
        await runUntil(() => !timers.length);
        await settle();
        assert.strictEqual(runsOf("once-p").length, 1);
        assert.strictEqual((await single("once-p")).status, "running");
        await questSettings.setPaused(false);
        await questService.restore();
        await runUntil(() => runsOf("once-p").length === 2);
        await settle();
        assert.strictEqual((await single("once-p")).status, "done");
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
