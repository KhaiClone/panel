#!/usr/bin/env node
/**
 * Checks for the panel log channel (server/services/panelLog.js): nothing is
 * sent without DISCORD_PANEL_LOG_WEBHOOK, lines are batched into one message,
 * tokens and webhook URLs are masked, a repeated warning is counted instead of
 * re-sent, a rate limit puts the lines back, and console.error / console.warn
 * are captured — plus the notifications that reach it.
 * Run:  node scripts/panelLog.test.js
 */

const path = require("path");
const assert = require("assert");

// Stand-in for server/db (routes/notifications.js stores the bell's entries there).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
const stored = [];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { create: async (m, doc) => stored.push(doc) } };

const axios = require("axios");
const posts = [];
let answer = null; // null = 204, or an error to throw once
axios.post = async (url, body) => {
    if (answer) {
        const err = answer;
        answer = null;
        throw err;
    }
    posts.push({ url, body });
    return { status: 204 };
};

const log = require("../server/services/panelLog");
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl";

let failures = 0;
const test = async (name, fn) => {
    log._reset();
    posts.length = 0;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};
const lines = (i = 0) => posts[i].body.embeds[0].description.split("\n");

(async () => {
    await test("nothing is queued or sent without the webhook", async () => {
        delete process.env.DISCORD_PANEL_LOG_WEBHOOK;
        log.add("system", "hello");
        assert.deepStrictEqual(log._queued(), []);
        process.env.DISCORD_PANEL_LOG_WEBHOOK = "https://example.com/not-discord";
        log.add("system", "hello");
        assert.deepStrictEqual(log._queued(), []);
        process.env.DISCORD_PANEL_LOG_WEBHOOK = HOOK;
        assert.ok(log.enabled());
    });

    await test("lines are batched into one message, mentions never ping", async () => {
        log.add("system", "Panel started");
        log.add("staff", "**lan** · Stock · `POST /api/stock/products` → ✅ 200");
        log.add("notice", 'Bot "shop" was started.');
        await log.flush();
        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].url, HOOK);
        assert.deepStrictEqual(posts[0].body.allowed_mentions, { parse: [] });
        const l = lines();
        assert.strictEqual(l.length, 3);
        assert.match(l[0], /^🖥️ <t:\d+:T> Panel started$/);
        assert.match(l[1], /^👤 <t:\d+:T> \*\*lan\*\* · Stock/);
        assert.match(l[2], /^🔔 /);
        assert.strictEqual(posts[0].body.embeds[0].color, 0x5865f2);
    });

    await test("an error turns the message red", async () => {
        log.add("system", "x");
        log.add("error", "[Bus] boom", { code: true });
        await log.flush();
        assert.strictEqual(posts[0].body.embeds[0].color, 0xed4245);
        assert.match(lines()[1], /^❌ <t:\d+:T> `\[Bus\] boom`$/);
    });

    await test("tokens and webhook URLs are masked", () => {
        // A made-up bot token, put together here so the source holds nothing
        // token-shaped (GitHub's push protection refuses those).
        const fakeToken = ["MTAxMjM0NTY3ODkwMTIzNDU2Nzg5", "GaBcDe", "abcdefghijklmnopqrstuvwxyz0123"].join(".");
        const s = log._redact(
            `post to ${HOOK}?wait=true with Bot ${fakeToken} ` +
                "and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl, Bearer abcdefghijklmnopqrstuvwxyz",
        );
        assert.ok(!s.includes("abcDEF"), s);
        assert.ok(!s.includes("GaBcDe"), s);
        assert.ok(!s.includes("eyJzdWIi"), s);
        assert.ok(!s.includes("abcdefghijklmnopqrstuvwxyz"), s);
        assert.match(s, /\[webhook\].*\[token\].*\[jwt\].*Bearer \[token\]/);
    });

    await test("a repeated warning is counted, not re-sent, for 10 minutes", async () => {
        for (let i = 0; i < 5; i++) log.add("warn", "[Staff] Role check failed: 502", { code: true });
        log.add("warn", "[Bus] something else", { code: true });
        await log.flush();
        assert.strictEqual(lines().length, 2);
        posts.length = 0;
        // 11 minutes later the same warning goes out again, with the count.
        const realNow = Date.now;
        Date.now = () => realNow() + 11 * 60 * 1000;
        try {
            log.add("warn", "[Staff] Role check failed: 502", { code: true });
        } finally {
            Date.now = realNow;
        }
        await log.flush();
        assert.match(lines()[0], /`\[Staff\] Role check failed: 502` \(\+4 more like it/);
    });

    await test("multi-line errors become one line, long ones are cut", async () => {
        log.add("error", `Error: x\n    at a (f.js:1)\n    at b (g.js:2)\n${"y".repeat(2000)}`, { code: true });
        await log.flush();
        const l = lines()[0];
        assert.ok(!l.includes("\n"));
        assert.match(l, /Error: x ⏎ at a \(f\.js:1\) ⏎ at b/);
        assert.ok(l.length < 600);
    });

    await test("a big backlog goes out in several messages under Discord's limit", async () => {
        for (let i = 0; i < 40; i++) log.add("system", `line ${i} ${"z".repeat(150)}`);
        await log.flush();
        await log.flush();
        assert.ok(posts.length >= 2);
        assert.ok(posts.every((p) => p.body.embeds[0].description.length <= 4096));
        const all = posts.flatMap((p, i) => lines(i));
        assert.strictEqual(all.length, 40);
        assert.match(all[39], /line 39 /);
    });

    await test("a rate limit puts the lines back", async () => {
        log.add("system", "kept");
        answer = Object.assign(new Error("429"), { response: { status: 429, data: { retry_after: 0.01 } } });
        await log.flush();
        assert.strictEqual(posts.length, 0);
        assert.strictEqual(log._queued().length, 1);
        await log.flush();
        assert.match(lines()[0], /kept$/);
    });

    await test("console.error and console.warn are captured, console.log is not", async () => {
        const quiet = { error: console.error, warn: console.warn };
        log.captureConsole();
        // The originals still print; silence them for the test output.
        const realWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
            console.error("[Backup] Backup failed:", new Error("disk full"));
            console.warn("[Bus] Could not post x — will retry");
            console.log("[Panel] just chatter");
        } finally {
            process.stderr.write = realWrite;
        }
        const q = log._queued();
        assert.strictEqual(q.length, 2);
        assert.match(q[0], /^❌ .*`\[Backup\] Backup failed: Error: disk full ⏎ at /);
        assert.match(q[1], /^⚠️ .*`\[Bus\] Could not post x — will retry`$/);
        assert.ok(quiet.error !== console.error);
    });

    await test("bell notifications reach the log, trouble flagged", async () => {
        const { createNotification } = require("../server/routes/notifications");
        await createNotification('Bot "shop" was started.', "start");
        await createNotification('Node "dio" (1.2.3.4) is not responding.', "error");
        await createNotification('Bot "x" exceeded its memory limit and was automatically restarted.', "warning");
        assert.strictEqual(stored.length, 3);
        const q = log._queued();
        assert.match(q[0], /^🔔 .*Bot "shop" was started\.$/);
        assert.match(q[1], /^❌ .*is not responding/);
        assert.match(q[2], /^⚠️ .*memory limit/);
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
