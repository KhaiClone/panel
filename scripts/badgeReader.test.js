#!/usr/bin/env node
/**
 * Checks badgeReader.readSelf (server/services/badgeReader.js) since game badges are
 * sold to every account, Nitro or not (2026-10-21): the progress is read with the
 * buyer's own token; `/users/@me/badges` → `/users/{id}/badges` on a 404; both 404 =
 * an account with no badges yet → every badge counts as 0 (`source: "empty"`). Any
 * other failure (5xx, 429) must stay an error — reading it as 0 would oversend.
 * Discord (axios) and the db are stubbed.
 * Run:  node scripts/badgeReader.test.js
 */

const path = require("path");
const assert = require("assert");

// ── Stubs ────────────────────────────────────────────────────────────────────
const SERVER = path.join(__dirname, "..", "server");
const stubAbs = (p, exports) => {
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stubAbs(require.resolve(path.join(SERVER, "db")), {
    get: async () => null,
    set: async () => {},
});

// Discord answers by path; anything not listed is a 404. `calls` keeps the paths asked.
let routes = {};
const calls = [];
const respond = async (url) => {
    url = String(url);
    if (url.includes("discord.com/app")) return { status: 200, data: "" }; // build number → fallback
    const p = url.replace("https://discord.com/api/v9", "");
    calls.push(p);
    const r = routes[p];
    return typeof r === "function" ? r() : (r ?? { status: 404, data: {} });
};
stubAbs(require.resolve("axios", { paths: [path.join(SERVER, "services")] }), {
    get: (url) => respond(url),
    post: (url) => respond(url),
    create: () => ({ get: (p) => respond(p), post: (p) => respond(p) }),
});

const badgeReader = require("../server/services/badgeReader");

// ── Helpers ──────────────────────────────────────────────────────────────────
const badge = (id, current, extra = {}) => ({ badge_id: id, owned: current > 0, progress: [{ current }], ...extra });
const list = (...badges) => ({ status: 200, data: { badges } });
const caught = async (fn) => {
    try {
        await fn();
    } catch (err) {
        return err;
    }
    throw new Error("expected an error");
};

let failures = 0;
const test = async (name, fn) => {
    routes = {};
    calls.length = 0;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};

(async () => {
    console.log("badgeReader.readSelf — every account, Nitro or not");

    await test("a non-Nitro account is read like any other", async () => {
        routes["/users/@me"] = { status: 200, data: { id: "7", username: "free", premium_type: 0 } };
        routes["/users/@me/badges"] = list(badge(20, 37), badge(21, 4, { hidden: true }));
        const me = await badgeReader.checkNitro("t");
        assert.strictEqual(me.hasNitro, false);
        const read = await badgeReader.readSelf("t", me.userId);
        assert.strictEqual(read.source, "self");
        assert.strictEqual(read.badges.game_time.value, 37);
        // The owner sees badges they hid — still counted.
        assert.strictEqual(read.badges.game_variety.value, 4);
    });

    await test("@me answers 404: the id path is tried and wins", async () => {
        routes["/users/7/badges"] = list(badge(20, 12));
        const read = await badgeReader.readSelf("t", "7");
        assert.deepStrictEqual(calls, ["/users/@me/badges", "/users/7/badges"]);
        assert.strictEqual(read.source, "self");
        assert.strictEqual(read.badges.game_time.value, 12);
        assert.strictEqual(read.badges.game_variety.value, 0, "a badge missing from the list is 0");
    });

    await test("both paths 404: no badges yet, every badge counts as 0", async () => {
        const read = await badgeReader.readSelf("t", "7");
        assert.strictEqual(read.source, "empty");
        for (const key of ["game_time", "game_variety", "streaming"]) {
            assert.strictEqual(read.badges[key].value, 0, key);
            assert.strictEqual(read.badges[key].owned, false, key);
        }
    });

    await test("an empty list (asked twice) is 0 too, read from the list", async () => {
        routes["/users/@me/badges"] = list();
        const read = await badgeReader.readSelf("t", "7");
        assert.strictEqual(calls.filter((p) => p === "/users/@me/badges").length, 2, "retried once");
        assert.strictEqual(read.source, "self");
        assert.strictEqual(read.badges.game_time.value, 0);
    });

    await test("a dead token stays a dead token", async () => {
        routes["/users/@me/badges"] = { status: 401, data: {} };
        const err = await caught(() => badgeReader.readSelf("t", "7"));
        assert.strictEqual(err.invalidToken, true);
    });

    await test("Discord errors are never read as 0", async () => {
        for (const status of [500, 429]) {
            routes["/users/@me/badges"] = { status, data: {} };
            const err = await caught(() => badgeReader.readSelf("t", "7"));
            assert.strictEqual(err.status, 502, `HTTP ${status}`);
            assert.strictEqual(err.message, `Reading the badges failed (HTTP ${status})`);
        }
        // @me 404 then the id path failing: still an error, not "no badges yet".
        routes["/users/@me/badges"] = { status: 404, data: {} };
        routes["/users/7/badges"] = { status: 500, data: {} };
        assert.strictEqual((await caught(() => badgeReader.readSelf("t", "7"))).status, 502);
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
