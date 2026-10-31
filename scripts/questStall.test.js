#!/usr/bin/env node
/**
 * Checks the skip line of a stalled quest (server/services/questEngine.js): every
 * progress loop (video, game heartbeat, activity) says what its last request got back
 * — an HTTP answer, a network failure, or a 200 that did not move the counter — so a
 * "made no progress" skip shows why. Discord is a fake api object; sleep() is the only
 * timer the loops use, so a fake clock jumps through the 5-minute stall timeout.
 * Run:  node scripts/questStall.test.js
 */

const path = require("path");
const assert = require("assert");
const { QuestAutocompleter } = require(path.join(__dirname, "..", "server", "services", "questEngine"));

// ── Fake clock ───────────────────────────────────────────────────────────────
let now = Date.UTC(2026, 9, 31, 12);
Date.now = () => now;
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms = 0) => {
    now += ms;
    return realSetTimeout(fn, 0);
};

const quest = (task, target) => ({
    id: "q1",
    config: {
        messages: { questName: "Test quest" },
        application: { id: "app1" },
        task_config: { tasks: { [task]: { target } } },
    },
    user_status: { enrolled_at: "2026-01-01T00:00:00.000Z", progress: { [task]: { value: 0 } } },
});

/** Runs one quest against `answer(path, n)` — a response object, or an Error to throw. */
async function run(task, target, answer) {
    let n = 0;
    const api = {
        httpsAgent: null,
        post: async (p) => {
            const r = answer(p, ++n);
            if (r instanceof Error) throw r;
            return r;
        },
    };
    const logs = [];
    const events = [];
    const c = new QuestAutocompleter(api, { label: "acc", onEvent: (e) => events.push(e) });
    c._log = (m) => logs.push(m);
    c._getValidChannelId = async () => "123";
    const result = await c.processQuest(quest(task, target));
    return { result, logs, events };
}

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
    console.log("questEngine — why a quest was skipped");

    await test("game heartbeat: 200 with a stuck counter names the value Discord sent", async () => {
        const { result, logs } = await run("PLAY_ON_DESKTOP", 900, () => ({
            status: 200,
            data: { progress: { PLAY_ON_DESKTOP: { value: 333 } } },
        }));
        assert.strictEqual(result.skipped, true);
        assert.match(result.reason, /made no progress for \d+ min at 333\/900s — last answer: HTTP 200, progress 333$/);
        assert.ok(logs.some((l) => l === `⏭ Skipped ${result.reason}`));
    });

    await test("game heartbeat: 200 without a progress field says so", async () => {
        const { result } = await run("PLAY_ON_DESKTOP", 900, () => ({ status: 200, data: {} }));
        assert.match(result.reason, /last answer: HTTP 200, progress missing$/);
    });

    await test("game heartbeat: a network failure is the reason (was swallowed silently)", async () => {
        const { result } = await run("PLAY_ON_DESKTOP", 900, () => new Error("read ECONNRESET"));
        assert.match(result.reason, /at 0\/900s — last answer: request failed: read ECONNRESET$/);
    });

    await test("game heartbeat: an odd HTTP answer is logged and is the reason", async () => {
        const { result, logs } = await run("PLAY_ON_DESKTOP", 900, () => ({
            status: 400,
            data: { message: "Invalid Form Body", code: 50035 },
        }));
        assert.match(result.reason, /last answer: HTTP 400: \{"message":"Invalid Form Body","code":50035\}$/);
        assert.ok(logs.some((l) => l.startsWith('⚠ "Test quest" heartbeat HTTP 400: {"message"')));
    });

    await test("game heartbeat: a permanent 429 is the reason", async () => {
        const { result } = await run("PLAY_ON_DESKTOP", 900, () => ({ status: 429, data: { retry_after: 30 } }));
        assert.match(result.reason, /last answer: HTTP 429: \{"retry_after":30\}$/);
    });

    await test("video: an odd HTTP answer is the reason, without a log line per request", async () => {
        const { result, logs } = await run("WATCH_VIDEO", 179, () => ({ status: 400, data: { message: "nope" } }));
        assert.match(result.reason, /at 0\/179s — last answer: HTTP 400: \{"message":"nope"\}$/);
        assert.ok(!logs.some((l) => l.startsWith("⚠")));
    });

    await test("video: a network failure is the reason", async () => {
        const { result } = await run("WATCH_VIDEO_ON_MOBILE", 102, () => new Error("timeout of 20000ms exceeded"));
        assert.match(result.reason, /last answer: request failed: timeout of 20000ms exceeded$/);
    });

    await test("video: a failure after progress reports the last answer, not an old one", async () => {
        const { result } = await run("WATCH_VIDEO", 179, (p, n) =>
            n <= 3 ? new Error("socket hang up") : n <= 6 ? { status: 200, data: {} } : { status: 500, data: "x" },
        );
        assert.match(result.reason, /at 21\/179s — last answer: HTTP 500: "x"$/);
    });

    await test("activity: a network failure is the reason", async () => {
        const { result } = await run("PLAY_ACTIVITY", 600, () => new Error("connect ECONNREFUSED"));
        assert.match(result.reason, /at 0\/600s — last answer: request failed: connect ECONNREFUSED$/);
    });

    await test("a quest that progresses still completes", async () => {
        let value = 0;
        const { result, events } = await run("PLAY_ON_DESKTOP", 900, (p) => {
            if (p.endsWith("/heartbeat")) value = Math.min(900, value + 300);
            return { status: 200, data: { progress: { PLAY_ON_DESKTOP: { value } } } };
        });
        assert.deepStrictEqual(result, { skipped: false });
        assert.ok(events.some((e) => e.type === "quest_done"));
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
