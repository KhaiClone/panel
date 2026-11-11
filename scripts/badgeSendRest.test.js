#!/usr/bin/env node
/**
 * Checks Auto Badge orders that Discord took only part of — no test framework needed.
 * Run:  node scripts/badgeSendRest.test.js
 *
 * The incident (2026-11-11): a Game Time Eternal order sent 2200 of 2750 sessions.
 * BadgeSender.run() skipped every batch /science answered with something other than
 * 204/401/403, without a retry, and the order was still marked "sent" — 1,100 hours
 * short while the panel and the buyer were told it was done.
 *
 * The real engine runs against a fake Discord (axios stubbed); the panel DB, the
 * egress pool, the callbacks and the shop books are in-memory stand-ins. Covered:
 *   - run(): a refused batch is sent again (same events), Retry-After is honoured,
 *     a batch refused on every try is skipped, 3 in a row stop the run, 401 aborts
 *   - an order Discord took only part of → manual_review, never "sent"; only the
 *     accepted games are claimed
 *   - "Send the rest": exactly the missing sessions, on claimed games, behind the
 *     sessions already sent, no new read, no new shop order; quiet for an order the
 *     buyer was already told is done, reported for one waiting for review
 *   - refused when nothing is missing, nothing was sent, the order is closed or running
 *   - partial again → manual_review with the running total
 *   - the order's token is dead (.wlxa, same day): the newest working token the panel
 *     holds for the SAME account (Auto Quest) is used; another account's never is;
 *     all dead → token_dead, and only a buyer never told "done" hears about it
 */

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const express = require("express");

const SERVER = path.join(__dirname, "..", "server");
const stubAbs = (p, exports) => {
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const stub = (rel, exports) => stubAbs(require.resolve(path.join(SERVER, rel)), exports);

// ── In-memory stand-in for server/db (same merge semantics as QuickDB.js) ──────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => e[k] === q[k]);
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0] ?? null; },
    async create(model, data) {
        const arr = (await this.get(model)) || [];
        arr.push(data);
        await this.set(model, arr);
        return data;
    },
    async findOneAndUpdate(model, q, data) {
        const arr = (await this.get(model)) || [];
        const i = arr.findIndex((e) => matches(e, q));
        if (i < 0) return null;
        arr[i] = { ...arr[i], ...data };
        await this.set(model, arr);
        return arr[i];
    },
};
stub("db", fakeDb);
process.env.QUEST_ENC_SECRET = "badge-send-rest-test";

// ── Fake Discord ───────────────────────────────────────────────────────────────
// `answers` = statuses for the next /science posts, in order; empty → 204.
const GAMES = Array.from({ length: 400 }, (_, i) => ({
    id: String(5000 + i),
    name: `Game ${i}`,
    executables: [{ os: "win32", name: `game${i}.exe` }],
}));
let answers = [];
let retryAfter = null;
const posts = [];
const postedWith = [];
let reads = 0;
// Which Discord account each token opens; anything else is dead (401).
const ACCOUNT_OF = { tok: "42", "quest-new": "42", "someone-else": "99" };
const fakeAxios = {
    async get(url, cfg = {}) {
        if (url.includes("discord.com/app")) return { status: 200, data: "" }; // build number → fallback
        if (url.includes("/applications/detectable")) return { status: 200, data: GAMES };
        const id = ACCOUNT_OF[cfg.headers?.authorization];
        if (!id) return { status: 401, data: {} };
        return { status: 200, data: { id, username: "buyer", analytics_token: "at", locale: "vi" } };
    },
    async post(url, body, cfg = {}) {
        posts.push(body.events);
        postedWith.push(cfg.headers?.authorization);
        const status = answers.length ? answers.shift() : 204;
        if (status === "net") throw new Error("socket hang up");
        const headers = status === 429 && retryAfter ? { "retry-after": String(retryAfter) } : {};
        return { status, headers, data: {} };
    },
};
stubAbs(require.resolve("axios", { paths: [path.join(SERVER, "services")] }), fakeAxios);

// The account reads at 0 games / 0 hours — but "Send the rest" must never read.
const badgeReader = require("../server/services/badgeReader");
badgeReader.checkNitro = async () => {
    reads++;
    return { userId: "42", username: "buyer", premiumType: 2, hasNitro: true, locale: "vi" };
};
badgeReader.readSelf = async (token, userId) => {
    reads++;
    return {
        userId,
        source: "self",
        badges: {
            game_time: { key: "game_time", value: 0, currentTier: null, owned: false },
            game_variety: { key: "game_variety", value: 0, currentTier: null, owned: false },
        },
    };
};
badgeReader.readPlayedApplicationIds = async () => [];

stub("services/proxyPool", { acquire: async () => ({ agent: null, source: null, release: () => {} }) });
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event) => webhooks.push(event) });
const books = [];
stub("services/autoShopOrders", {
    open: async (e) => void books.push({ op: "open", ...e }),
    settle: async (externalId, want) => void books.push({ op: "settle", externalId, want }),
    badgeBasePrice: () => 0,
    badgeName: (k, t) => `${k} ${t}`,
    SOURCE: { badge: "autoBadge" },
});

const engine = require("../server/services/badgeEngine");
// Retries wait milliseconds here, not seconds.
engine.RETRY_DELAYS.splice(0, engine.RETRY_DELAYS.length, 1, 1, 1, 1);
const badgeService = require("../server/services/badgeService");
const router = require("../server/routes/badges");

// ── Helpers ────────────────────────────────────────────────────────────────────
function encrypt(token) {
    const key = crypto.createHash("sha256").update(process.env.QUEST_ENC_SECRET).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
    return { tokenEncrypted: enc.toString("base64"), tokenIv: iv.toString("base64"), tokenTag: c.getAuthTag().toString("base64") };
}
function decrypt(rec) {
    const key = crypto.createHash("sha256").update(process.env.QUEST_ENC_SECRET).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(rec.tokenIv, "base64"));
    d.setAuthTag(Buffer.from(rec.tokenTag, "base64"));
    return Buffer.concat([d.update(Buffer.from(rec.tokenEncrypted, "base64")), d.final()]).toString("utf8");
}

// A Game Time order: threshold in hours, overshoot 1 so need = threshold.
async function addOrder(orderId, extra = {}) {
    await fakeDb.create("badge_orders", {
        orderId,
        source: "auto",
        ref: "42",
        accountId: "42",
        username: "buyer",
        hasNitro: true,
        ...encrypt("tok"),
        webhookBotId: "auto-bot",
        badgeKey: "game_time",
        tierKey: "eternal",
        tierName: "Eternal",
        kind: "tiered",
        threshold: 200,
        unit: "hours",
        price: 100000,
        overshoot: 1,
        forfeitOnWrongTier: true,
        status: "paid",
        error: null,
        plan: null,
        sent: 0,
        total: 0,
        createdAt: Date.now() - 2 * 24 * 3_600_000,
        ...extra,
    });
}

const SETTLED = new Set(["sent", "manual_review", "cancelled", "forfeited", "refund_due", "token_dead", "error"]);
async function settle(orderId) {
    for (let i = 0; i < 300; i++) {
        const o = await badgeService.getOrder(orderId);
        if (SETTLED.has(o.status)) return o;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`order ${orderId} never settled`);
}

const claimed = async () => (await fakeDb.findOne("badge_accounts", { accountId: "42" }))?.claimedGameIds ?? [];
const sessionsOf = (events) => events.filter((e) => e.type === "running_game_heartbeat" && e.properties.final_heartbeat);

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
    app.use((req, res, next) => {
        req.auth = { kind: "owner", username: "admin" };
        next();
    });
    app.use(router);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));

    const game = (i) => ({ id: String(5000 + i), name: `Game ${i}`, exe: `game${i}.exe` });
    const plan = (n, games = 3) => ({ sessions: Array.from({ length: n }, (_, i) => ({ game: game(i % games), hours: 2 })) });
    const newSender = () => {
        const s = new engine.BadgeSender("tok", { retryDelays: [1, 1, 1, 1], batchDelay: 0 });
        s.analyticsToken = "at";
        s.buildNumber = 1;
        return s;
    };

    console.log("BadgeSender.run — batches Discord refuses");

    await test("a refused batch is sent again with the same events, then counts", async () => {
        posts.length = 0;
        answers = [429, 502, 204];
        const r = await newSender().run(plan(10));
        assert.deepStrictEqual([r.sent, r.total, r.aborted, r.status], [10, 10, false, 204]);
        assert.strictEqual(posts.length, 3);
        assert.deepStrictEqual(posts[2], posts[0], "the retry resends the very same events (same session ids)");
    });

    await test("429 waits at least Retry-After", async () => {
        answers = [429];
        retryAfter = 0.2;
        const t = Date.now();
        await newSender().run(plan(1));
        retryAfter = null;
        assert.ok(Date.now() - t >= 190, `waited ${Date.now() - t}ms`);
    });

    await test("a batch refused on every try is skipped, the rest still goes, the result is short", async () => {
        posts.length = 0;
        // batch 1 ok; batch 2 refused 5 times (1 + 4 retries); batch 3 ok
        answers = [204, 500, 500, 500, 500, 500, 204];
        const r = await newSender().run(plan(120, 120));
        assert.deepStrictEqual([r.sent, r.total, r.aborted, r.status], [70, 120, false, 500]);
        assert.strictEqual(r.acceptedGameIds.length, 70, "games of the refused batch are not accepted");
        assert.ok(!r.acceptedGameIds.includes(game(60).id));
    });

    await test("3 batches in a row refused on every try → stop", async () => {
        posts.length = 0;
        answers = Array(15).fill("net");
        const r = await newSender().run(plan(250));
        assert.deepStrictEqual([r.sent, r.total, r.aborted, r.status], [0, 250, false, 0]);
        assert.strictEqual(posts.length, 15, "5 batches planned, gave up after 3 × 5 tries");
    });

    await test("401 still aborts at once, no retry", async () => {
        posts.length = 0;
        answers = [204, 401];
        const r = await newSender().run(plan(100));
        assert.deepStrictEqual([r.sent, r.aborted, r.status], [50, true, 401]);
        assert.strictEqual(posts.length, 2);
    });

    await test("indexOffset pushes the sessions further back in time", async () => {
        posts.length = 0;
        const t = Date.now();
        await newSender().run(plan(1), { indexOffset: 10 });
        const end = sessionsOf(posts[0])[0].properties.client_track_timestamp;
        const back = t - end;
        assert.ok(back > 10 * 2 * 3_600_000 - 5_000 && back < 11 * 2 * 3_600_000, `ended ${back}ms ago`);
    });

    console.log("\nbadgeService — orders Discord took only part of");

    await test("part of the sessions refused → manual_review with sent/total, never \"sent\"", async () => {
        webhooks.length = 0;
        // threshold 200h → 100 sessions → 2 batches; the 2nd refused on every try.
        answers = [204, 500, 500, 500, 500, 500];
        await addOrder("p1");
        const o = await badgeService.processOrder("p1");
        assert.strictEqual(o.status, "manual_review");
        assert.deepStrictEqual([o.sent, o.total], [50, 100]);
        assert.match(o.error, /^Discord did not take 50 of 100 sessions \(last answer: HTTP 500\)\. "Send the rest"/);
        assert.ok(!books.some((b) => b.externalId === "badge:p1" && b.op === "settle"), "the shop order stays open");
        assert.deepStrictEqual(webhooks.filter((e) => e.type !== "progress").map((e) => e.type), ["status", "status", "manual_review"]);
        assert.ok(!webhooks.some((e) => e.type === "sent"));
    });

    await test("Send the rest: exactly the missing sessions, on claimed games, behind the old ones, no read", async () => {
        webhooks.length = 0;
        posts.length = 0;
        const claimedBefore = await claimed();
        const readsBefore = reads;
        const booksBefore = books.length;
        const { status, body } = await call("POST", "/p1/send-rest");
        assert.strictEqual(status, 200);
        assert.strictEqual(body.status, "sending");
        const o = await settle("p1");
        assert.strictEqual(o.status, "sent");
        assert.deepStrictEqual([o.sent, o.total, o.error], [100, 100, null]);
        assert.strictEqual(reads, readsBefore, "no new read of the account");
        const sent = posts.flatMap(sessionsOf);
        assert.strictEqual(sent.length, 50);
        assert.ok(sent.every((e) => e.properties.duration_tracked_ms === 2 * 3_600_000));
        assert.ok(sent.every((e) => claimedBefore.includes(e.properties.game_id)), "only games already counted");
        assert.deepStrictEqual(await claimed(), claimedBefore, "no new game claimed");
        // The first send covered sessions 0..99 back from the order's start; these come after.
        const order = await fakeDb.findOne("badge_orders", { orderId: "p1" });
        const newest = Math.max(...sent.map((e) => e.properties.client_track_timestamp));
        assert.ok(newest <= order.createdAt - 100 * 2 * 3_600_000, "behind every session already sent");
        assert.strictEqual(o.restSends.length, 1);
        assert.deepStrictEqual([o.restSends[0].sessions, o.restSends[0].accepted], [50, 50]);
        assert.ok(!books.slice(booksBefore).some((b) => b.op === "open"), "no new shop order");
        assert.ok(books.some((b) => b.externalId === "badge:p1" && b.want === "completed"));
        // The buyer was waiting on review: they hear it is done, once.
        assert.deepStrictEqual(webhooks.map((e) => e.type), ["sent"]);
        assert.deepStrictEqual([webhooks[0].sent, webhooks[0].total], [100, 100]);
    });

    await test("an order marked Done while short (before the fix) gets the rest quietly", async () => {
        webhooks.length = 0;
        posts.length = 0;
        await addOrder("p2", {
            status: "sent",
            sent: 80,
            total: 100,
            sentAt: Date.now() - 24 * 3_600_000,
            plan: { gameCount: 3, sessionCount: 100, hoursPerSession: 2, need: 200 },
        });
        const o = await badgeService.sendRest("p2").then(() => settle("p2"));
        assert.strictEqual(o.status, "sent");
        assert.deepStrictEqual([o.sent, o.total], [100, 100]);
        assert.strictEqual(posts.flatMap(sessionsOf).length, 20);
        assert.strictEqual(webhooks.length, 0, "the buyer was already told it is done");
    });

    await test("Game Variety: the rest goes to new games, one session each", async () => {
        posts.length = 0;
        const before = await claimed();
        await addOrder("p3", {
            badgeKey: "game_variety",
            tierKey: "universalist",
            tierName: "Universalist",
            unit: "games",
            threshold: 100,
            status: "manual_review",
            sent: 90,
            total: 100,
            plan: { gameCount: 100, sessionCount: 100, hoursPerSession: 1 / 60, need: 100 },
        });
        const o = await badgeService.sendRest("p3").then(() => settle("p3"));
        assert.strictEqual(o.status, "sent");
        const ids = posts.flatMap(sessionsOf).map((e) => e.properties.game_id);
        assert.strictEqual(ids.length, 10);
        assert.strictEqual(new Set(ids).size, 10);
        assert.ok(ids.every((id) => !before.includes(id)), "games not claimed before");
        assert.strictEqual((await claimed()).length, before.length + 10);
    });

    await test("partial again → manual_review with the running total", async () => {
        await addOrder("p4", {
            status: "manual_review",
            sent: 50,
            total: 200,
            plan: { gameCount: 3, sessionCount: 200, hoursPerSession: 2, need: 400 },
        });
        // 150 missing = 3 batches: ok, refused on every try, ok
        answers = [204, 500, 500, 500, 500, 500, 204];
        const o = await badgeService.sendRest("p4").then(() => settle("p4"));
        assert.strictEqual(o.status, "manual_review");
        assert.deepStrictEqual([o.sent, o.total], [150, 200]);
        assert.match(o.error, /^Discord did not take 50 of 200 sessions/);
        // and the next try sends just those 50, further back again
        posts.length = 0;
        const done = await badgeService.sendRest("p4").then(() => settle("p4"));
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(posts.flatMap(sessionsOf).length, 50);
        assert.strictEqual(done.restSends.length, 2);
    });

    await test("refused: nothing missing, nothing sent yet, a closed order, HypeSquad, unknown", async () => {
        const plan2 = { gameCount: 3, sessionCount: 100, hoursPerSession: 2, need: 200 };
        await addOrder("r1", { status: "sent", sent: 100, total: 100, plan: plan2 });
        await addOrder("r2", { status: "manual_review", sent: 0, total: 100, plan: plan2 });
        await addOrder("r3", { status: "refund_due", sent: 50, total: 100, plan: plan2 });
        await addOrder("r4", { badgeKey: "hypesquad", kind: "choice", status: "sent", sent: 0, total: 1 });
        for (const id of ["r1", "r2", "r3", "r4"]) {
            const { status, body } = await call("POST", `/${id}/send-rest`);
            assert.strictEqual(status, 400, id);
            assert.strictEqual(body.error, "This order has nothing left to send");
        }
        assert.strictEqual((await call("POST", "/nope/send-rest")).status, 404);
    });

    console.log("\nbadgeService — the order's token is dead");

    const DONE_SHORT = {
        status: "token_dead",
        error: "The token is invalid or dead",
        sent: 80,
        total: 100,
        sentAt: Date.now() - 24 * 3_600_000,
        plan: { gameCount: 3, sessionCount: 100, hoursPerSession: 2, need: 200 },
    };

    await test("uses the account's Auto Quest token instead, quietly for an order once done", async () => {
        webhooks.length = 0;
        posts.length = 0;
        postedWith.length = 0;
        await addOrder("t1", { ...encrypt("dead-badge"), ...DONE_SHORT, accountId: "42" });
        // A dead single-quest token, an older dead monthly one, a newer working monthly one,
        // and someone else's quest token — only the newest working one of acc 42 may be used.
        await fakeDb.create("quest_accounts", { accountId: "42", ...encrypt("dead-quest"), updatedAt: Date.now() });
        await fakeDb.create("quest_monthly", { accountId: "42", ...encrypt("dead-old"), updatedAt: Date.now() - 9e6 });
        await fakeDb.create("quest_monthly", { accountId: "42", ...encrypt("quest-new"), updatedAt: Date.now() - 1e6 });
        await fakeDb.create("quest_monthly", { accountId: "7", ...encrypt("someone-else"), updatedAt: Date.now() });
        const { status, body } = await call("POST", "/t1/send-rest");
        assert.strictEqual(status, 200, JSON.stringify(body));
        const o = await settle("t1");
        assert.strictEqual(o.status, "sent", o.error);
        assert.deepStrictEqual([o.sent, o.total, o.error], [100, 100, null]);
        assert.strictEqual(posts.flatMap(sessionsOf).length, 20);
        assert.ok(postedWith.length && postedWith.every((t) => t === "quest-new"));
        assert.strictEqual(o.restSends.at(-1).tokenFrom, "quest_monthly");
        assert.strictEqual(webhooks.length, 0, "the buyer was told it was done before the token died");
        // the order keeps its own (dead) token — nothing is copied between records
        assert.strictEqual(decrypt(await fakeDb.findOne("badge_orders", { orderId: "t1" })), "dead-badge");
    });

    await test("a working token of ANOTHER account is never used", async () => {
        webhooks.length = 0;
        postedWith.length = 0;
        // acc 99's own token sits in quest_accounts under acc 55's id (a mix-up)
        await addOrder("t2", { ...encrypt("dead-badge"), ...DONE_SHORT, accountId: "55" });
        await fakeDb.create("quest_accounts", { accountId: "55", ...encrypt("someone-else"), updatedAt: Date.now() });
        await badgeService.sendRest("t2");
        const o = await settle("t2");
        assert.strictEqual(o.status, "manual_review");
        assert.strictEqual(o.error, "No token the panel holds works for this account");
        assert.strictEqual(postedWith.length, 0, "nothing sent");
        assert.strictEqual(o.sent, 80);
    });

    await test("every token dead → token_dead again, nothing sent, the buyer not told", async () => {
        webhooks.length = 0;
        postedWith.length = 0;
        await addOrder("t3", { ...encrypt("dead-badge"), ...DONE_SHORT, accountId: "66" });
        await fakeDb.create("quest_monthly", { accountId: "66", ...encrypt("dead-quest-66"), updatedAt: Date.now() });
        await badgeService.sendRest("t3");
        const o = await settle("t3");
        assert.strictEqual(o.status, "token_dead");
        assert.strictEqual(o.error, "Every token the panel holds for this account is dead (2 tried)");
        assert.strictEqual(postedWith.length, 0);
        assert.strictEqual(webhooks.length, 0);
    });

    await test("an order never finished hears about a dead token (Vietnamese for ArnTo-Auto)", async () => {
        webhooks.length = 0;
        await addOrder("t4", { ...encrypt("dead-badge"), ...DONE_SHORT, sentAt: null, status: "manual_review", accountId: "77" });
        await badgeService.sendRest("t4");
        const o = await settle("t4");
        assert.strictEqual(o.status, "token_dead");
        assert.deepStrictEqual(webhooks.map((e) => [e.type, e.status, e.error]), [["failed", "token_dead", "Token không hợp lệ hoặc đã chết"]]);
    });

    await test("refused while the same order is running", async () => {
        await addOrder("r5", {
            status: "manual_review",
            sent: 50,
            total: 100,
            plan: { gameCount: 3, sessionCount: 100, hoursPerSession: 2, need: 200 },
        });
        answers = [429, 429];
        const first = badgeService.sendRest("r5");
        await first;
        await assert.rejects(badgeService.sendRest("r5"), /already running/);
        assert.strictEqual((await settle("r5")).status, "sent");
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
