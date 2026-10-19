#!/usr/bin/env node
/**
 * Checks for monthly quest failures (server/services/questMonthly.js): a token that
 * dies during a pass or the enroll scan stays on /quests as "token_dead" with its
 * reason — after the pass has moved on, on a fresh GET and after a restart — until a
 * pass gets through or the plan is activated again; other failures show as "error".
 * Discord, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/questMonthly.test.js
 */

const path = require("path");
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

// Discord: each token says how it behaves ("dead", "dead-mid", "down", anything else = fine).
const discord = { quests: [] };
class QuestAutocompleter {
    constructor(api) {
        this.api = api;
        this.completedIds = new Set();
    }
    async fetchQuests() {
        if (this.api.token === "dead-mid") throw Object.assign(new Error("HTTP 401"), { invalidToken: true });
        return discord.quests;
    }
    async autoAccept(q) {
        return q;
    }
}
stub("services/questEngine", {
    QuestAutocompleter,
    resolveDiscordAccount: async (token) => {
        if (token === "dead") return { ok: false, invalidToken: true, reason: "Token không hợp lệ (HTTP 401)" };
        if (token === "down") return { ok: false, invalidToken: false, reason: "Không kết nối được Discord: ECONNRESET" };
        return { ok: true, api: { token }, accountId: "111", username: "khai" };
    },
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => q,
    warmBuildNumber: () => {},
    _fields: { isEnrolled: () => true, isCompleted: () => true, isCompletable: () => true, getQuestName: () => "", getTaskType: () => "" },
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }), agentForKey: async () => null });
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event) => webhooks.push(event) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });
stub("services/discordBus", { handlerOf: () => null });

const questService = require("../server/services/questService");
const questSettings = require("../server/services/questSettings");
const questMonthly = require("../server/services/questMonthly");
const router = require("../server/routes/quests");

const events = [];
questService.bus.on("event", (e) => events.push(e));

// Swap the stored token, as a buyer sending a new one would (via activate()).
const plan = (token, ref = "buyer") => questMonthly.activate({ token, months: 1, ref, webhookBotId: "auto" });
const setToken = async (token) => {
    // activate() would resolve it (a dead one is refused), so write the record directly.
    const crypto = require("crypto");
    const key = crypto.createHash("sha256").update(process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret").digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
    await db.findOneAndUpdate("quest_monthly", { accountId: "111" }, {
        tokenEncrypted: enc.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: c.getAuthTag().toString("base64"),
    });
};

let server;
// GET / on the /quests router — what the page loads.
const listAccounts = () =>
    new Promise((resolve, reject) => {
        const req = require("http").get({ port: server.address().port, path: "/", agent: false }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve(JSON.parse(body)));
        });
        req.on("error", reject);
    });

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
    const app = express();
    app.use(router);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    await plan("good");

    console.log("questMonthly — failures stay on /quests");

    await test("a token rejected at the start of the pass stays token_dead on the list", async () => {
        await setToken("dead");
        webhooks.length = events.length = 0;
        const res = await questMonthly.runBatch();
        assert.strictEqual(res.failed.length, 1);
        assert.strictEqual(res.failed[0].status, "token_dead");
        assert.strictEqual(res.failed[0].username, "khai");
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "token_dead");
        assert.match(a.error, /rejected the token/);
        assert.ok(a.errorAt > 0);
        // The live event carries the reason; the buyer is told once.
        const ev = events.find((e) => e.type === "status");
        assert.strictEqual(ev.status, "token_dead");
        assert.match(ev.error, /rejected the token/);
        assert.deepStrictEqual(webhooks.map((w) => w.status), ["token_dead"]);
        // Not reverted to the idle badge afterwards.
        assert.ok(!events.some((e) => e.type === "status" && e.status === "monthly"));
    });

    await test("the scheduler card keeps the failed account after the pass, also after a restart", async () => {
        await setToken("dead");
        await questMonthly.runNow();
        await new Promise((r) => setTimeout(r, 50));
        const st = await questMonthly.status();
        assert.strictEqual(st.run.current, null);
        assert.strictEqual(st.run.last.failed.length, 1);
        assert.strictEqual(st.run.last.failed[0].status, "token_dead");
        const saved = await db.get("quest_monthly_last_result");
        assert.strictEqual(saved.run.failed[0].accountId, "111");
    });

    await test("a token that dies mid-pass is token_dead too", async () => {
        await setToken("good");
        await questMonthly.runBatch();
        assert.strictEqual((await listAccounts())[0].status, "monthly");
        await setToken("dead-mid");
        await questMonthly.runBatch();
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "token_dead");
        assert.match(a.error, /rejected the token/);
    });

    await test("Discord unreachable shows as error with its reason", async () => {
        await setToken("down");
        await questMonthly.runBatch();
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "error");
        assert.match(a.error, /ECONNRESET/);
    });

    await test("a pass that gets through clears it", async () => {
        await setToken("dead");
        await questMonthly.runBatch();
        await setToken("good");
        events.length = 0;
        await questMonthly.runBatch();
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "monthly");
        assert.strictEqual(a.error, null);
        const last = events.filter((e) => e.type === "status").pop();
        assert.strictEqual(last.status, "monthly");
        assert.strictEqual(last.error, null);
    });

    await test("a new working token via activate() clears it", async () => {
        await setToken("dead");
        await questMonthly.runBatch();
        await plan("good-new");
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "monthly");
        assert.strictEqual(a.error, null);
    });

    await test("the enroll scan records a dead token without messaging the buyer", async () => {
        await setToken("dead");
        webhooks.length = 0;
        const res = await questMonthly.runEnrollScan();
        assert.strictEqual(res.failed.length, 1);
        const [a] = await listAccounts();
        assert.strictEqual(a.status, "token_dead");
        assert.strictEqual(webhooks.length, 0);
    });

    await test("parallel failures are all kept", async () => {
        await db.create("quest_monthly", { ...(await db.findOne("quest_monthly", { accountId: "111" })), accountId: "222", username: "nghi" });
        await db.create("quest_monthly", { ...(await db.findOne("quest_monthly", { accountId: "111" })), accountId: "333", username: "tam" });
        await questSettings.update({ concurrency: 3 });
        await questMonthly.runBatch();
        const errors = await db.get("quest_monthly_outcome");
        assert.deepStrictEqual(Object.keys(errors).sort(), ["111", "222", "333"]);
        await questSettings.update({ concurrency: 1 });
    });

    await test("removing the plan drops its error", async () => {
        await questMonthly.remove("222");
        const errors = await db.get("quest_monthly_outcome");
        assert.ok(!errors["222"]);
        assert.ok(errors["333"]);
    });

    server.close();
    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
