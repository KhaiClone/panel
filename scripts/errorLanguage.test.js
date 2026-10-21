#!/usr/bin/env node
/**
 * Checks the two-language errors of Auto Badge / Auto Quest (CLAUDE.md rule 29): every
 * error badgeReader, badgeEngine and questEngine raise is English in `message` /
 * `reason` — what the panel stores and shows — and keeps the exact Vietnamese text
 * ArnTo-Auto already shows its buyers in `vi` / `reasonVi`. Auto also reads a 400
 * that says "token" as a dead token, so those `vi` texts must not change.
 * Discord (axios) and the db are stubbed.
 * Run:  node scripts/errorLanguage.test.js
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

// Discord answers whatever `reply(url)` says; `null` = the request itself fails.
let reply = () => ({ status: 200, data: {} });
const respond = async (url) => {
    if (String(url).includes("discord.com/app")) return { status: 200, data: "" }; // build number → fallback
    const r = reply(String(url));
    if (!r) throw new Error("ECONNRESET");
    return r;
};
const fakeAxios = {
    get: (url) => respond(url),
    post: (url) => respond(url),
    create: () => ({ get: (p) => respond(p), post: (p) => respond(p), delete: (p) => respond(p) }),
};
stubAbs(require.resolve("axios", { paths: [path.join(SERVER, "services")] }), fakeAxios);

const badgeReader = require("../server/services/badgeReader");
const { BadgeSender, planOrder, setHypeSquad, loadGames } = require("../server/services/badgeEngine");
const { resolveDiscordAccount } = require("../server/services/questEngine");
const { toEnglish } = require("../server/services/legacyText");

// ── Helpers ──────────────────────────────────────────────────────────────────
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const caught = async (fn) => {
    try {
        await fn();
    } catch (err) {
        return err;
    }
    throw new Error("expected an error");
};
/** English for the panel, the old Vietnamese for ArnTo-Auto. */
const twoTexts = (err, en, vi) => {
    assert.doesNotMatch(err.message, VI, `Vietnamese in message: ${err.message}`);
    assert.strictEqual(err.message, en);
    assert.strictEqual(err.vi, vi);
    // Records saved before the switch hold `vi`; the pages translate it back (legacyText).
    assert.strictEqual(toEnglish(vi), en, `legacyText does not translate: ${vi}`);
};
const TOKEN_DEAD = ["The token is invalid or dead", "Token không hợp lệ hoặc đã chết"];

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
    console.log("errors — English on the panel, Vietnamese for ArnTo-Auto");

    await test("badgeReader: dead token, Discord down, failed reads", async () => {
        reply = () => ({ status: 401, data: {} });
        const dead = await caught(() => badgeReader.checkNitro("t"));
        twoTexts(dead, ...TOKEN_DEAD);
        assert.strictEqual(dead.invalidToken, true);
        assert.strictEqual(dead.status, 400);
        // Auto's dead-token rule: a 400 whose text says "token".
        assert.match(dead.vi, /token/i);

        reply = () => ({ status: 500, data: {} });
        twoTexts(await caught(() => badgeReader.checkNitro("t")), "Discord returned HTTP 500", "Discord trả HTTP 500");
        twoTexts(await caught(() => badgeReader.readSelf("t", "1")), "Reading the badges failed (HTTP 500)", "Đọc badge thất bại (HTTP 500)");
        twoTexts(await caught(() => badgeReader.readProfileBadges("t", "1")), "Reading the profile failed (HTTP 500)", "Đọc profile thất bại (HTTP 500)");

        // A 404 on the badge list is no longer an error: the account has no badges
        // yet and counts as 0 (scripts/badgeReader.test.js).

        reply = () => ({ status: 403, data: {} });
        twoTexts(await caught(() => badgeReader.readPlayedApplicationIds("t")), ...TOKEN_DEAD);
    });

    await test("badgeEngine: game list, plan, sender, HypeSquad", async () => {
        reply = () => ({ status: 503, data: null });
        twoTexts(await caught(() => loadGames()), "Could not load the game list (HTTP 503)", "Không tải được danh sách game (HTTP 503)");
        reply = () => ({ status: 200, data: [] });
        twoTexts(await caught(() => loadGames()), "The game list is empty", "Danh sách game rỗng");

        reply = () => ({ status: 200, data: [{ id: "1", name: "A", executables: [{ os: "win32", name: "a.exe" }] }] });
        twoTexts(
            await caught(() => planOrder({ badgeKey: "game_variety", threshold: 5, current: 0, overshoot: 1 })),
            "Not enough new games: 5 needed, 1 left",
            "Không đủ game mới: cần 5, còn 1",
        );
        twoTexts(
            // spread 0 → no game to reuse, and the only game is already claimed
            await caught(() => planOrder({ badgeKey: "game_time", threshold: 5, current: 0, claimedGameIds: ["1"], varietyHeadroom: 0, spread: 0 })),
            "No games left to use",
            "Không còn game nào để dùng",
        );
        twoTexts(
            await caught(() => planOrder({ badgeKey: "streaming", threshold: 5 })),
            "Sending is not supported for this badge: streaming",
            "Badge chưa hỗ trợ gửi: streaming",
        );

        reply = () => ({ status: 401, data: {} });
        twoTexts(await caught(() => new BadgeSender("t").init()), ...TOKEN_DEAD);
        reply = () => ({ status: 502, data: {} });
        twoTexts(await caught(() => new BadgeSender("t").init()), "Discord returned HTTP 502", "Discord trả HTTP 502");
        reply = () => ({ status: 200, data: { id: "1" } });
        twoTexts(await caught(() => new BadgeSender("t").init()), "Could not get the analytics_token", "Không lấy được analytics_token");
        // No HTTP answer at all (timeout through a dead egress): flagged so badgeService tries another one.
        reply = () => null;
        const unreachable = await caught(() => new BadgeSender("t").init());
        twoTexts(unreachable, "Could not reach Discord: ECONNRESET", "Không kết nối được Discord: ECONNRESET");
        assert.strictEqual(unreachable.egressFailed, true);
        assert.strictEqual(unreachable.cause.message, "ECONNRESET");

        reply = () => ({ status: 403, data: {} });
        twoTexts(await caught(() => setHypeSquad("t", 1)), ...TOKEN_DEAD);
        reply = () => ({ status: 500, data: {} });
        twoTexts(await caught(() => setHypeSquad("t", 1)), "Changing the HypeSquad house failed (HTTP 500)", "Đổi HypeSquad thất bại (HTTP 500)");
        // Discord's own message (English) goes both ways unchanged, as before.
        reply = () => ({ status: 400, data: { message: "Invalid Form Body" } });
        twoTexts(await caught(() => setHypeSquad("t", 1)), "Invalid Form Body", "Invalid Form Body");
    });

    await test("questEngine.resolveDiscordAccount: empty, refused, unreachable", async () => {
        const empty = await resolveDiscordAccount("  ");
        assert.deepStrictEqual(
            { ok: empty.ok, reason: empty.reason, reasonVi: empty.reasonVi },
            { ok: false, reason: "The token is empty.", reasonVi: "Token trống." },
        );
        reply = () => ({ status: 401, data: {} });
        const refused = await resolveDiscordAccount("t");
        assert.strictEqual(refused.invalidToken, true);
        assert.strictEqual(refused.reason, "Discord did not accept the token (HTTP 401)");
        assert.strictEqual(refused.reasonVi, "Token không hợp lệ (HTTP 401)");
        reply = () => null;
        const down = await resolveDiscordAccount("t");
        assert.strictEqual(down.invalidToken, false);
        assert.strictEqual(down.reason, "Could not reach Discord: ECONNRESET");
        assert.strictEqual(down.reasonVi, "Không kết nối được Discord: ECONNRESET");
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
