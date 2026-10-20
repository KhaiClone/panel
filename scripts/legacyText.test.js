#!/usr/bin/env node
/**
 * Checks for server/services/legacyText.js: errors saved in Vietnamese before the
 * panel went English (d310d7a) reach the /quests and /badges pages in English —
 * each old message as the exact English the code writes today — while English
 * text (even with a Vietnamese username in it) passes through untouched, and the
 * stored data and the routes ArnTo-Auto reads are left alone.
 * Run:  node scripts/legacyText.test.js
 */

const http = require("http");
const assert = require("assert");
const express = require("express");
const { toEnglish, englishErrors, englishJson, UNKNOWN } = require("../server/services/legacyText");

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

// [old Vietnamese as stored, English the code writes today]
const OLD = [
    // Auto Quest
    ["Token không hợp lệ / đã hết hạn.", "Discord rejected the token (invalid or expired)."],
    ["Không giải mã được token (đổi secret?).", "Could not decrypt the stored token (secret changed?)."],
    ["Token trống.", "The token is empty."],
    ["Token không hợp lệ (HTTP 401)", "Discord did not accept the token (HTTP 401)"],
    ["Không kết nối được Discord: read ECONNRESET", "Could not reach Discord: read ECONNRESET"],
    ['"Play Fortnite" đã hết hạn lúc 19/10/2026, 07:00:00', '"Play Fortnite" expired at 19/10/2026, 07:00:00'],
    ['"Watch Video" đứng yên 12 phút ở 300/900s', '"Watch Video" made no progress for 12 min at 300/900s'],
    ['"Stream X" quá 90 phút mà chưa xong (100/900s)', '"Stream X" still not done after 90 min (100/900s)'],
    ["Đã dừng theo yêu cầu.", "Stopped on request."],
    ["Token bị từ chối khi enroll (401)", "Discord rejected the token on enroll (401)"],
    ["Lấy danh sách quest thất bại (401)", "Fetching the quest list failed (401)"],
    ["Heartbeat terminal thất bại (403)", "Terminal heartbeat failed (403)"],
    ["Activity terminal thất bại (401)", "Terminal activity heartbeat failed (401)"],
    ["Lấy proxy ticket thất bại (401)", "Fetching the proxy ticket failed (401)"],
    // Auto Badge
    ["Token không hợp lệ hoặc đã chết", "The token is invalid or dead"],
    ["Discord trả HTTP 500", "Discord returned HTTP 500"],
    ["Discord không mở danh sách badge cho tài khoản này (HTTP 404)", "Discord does not open this account's badge list (HTTP 404)"],
    ["Đọc badge thất bại (HTTP 502)", "Reading the badges failed (HTTP 502)"],
    ["Không tải được danh sách game (HTTP 503)", "Could not load the game list (HTTP 503)"],
    ["Không đủ game mới: cần 40, còn 12", "Not enough new games: 40 needed, 12 left"],
    ["Đổi HypeSquad thất bại (HTTP 400)", "Changing the HypeSquad house failed (HTTP 400)"],
    ["Game Time và Game Variety chỉ bán cho tài khoản có Nitro", "Game Time and Game Variety are sold to Nitro accounts only"],
    ["Không đọc được con số tiến độ", "Could not read the progress value"],
    ["Tài khoản đã đạt mốc Serious (160 hours)", "Account already has Serious (160 hours)"],
    ["Kế hoạch rỗng", "The send plan is empty"],
    ["Discord từ chối ở HTTP 429 sau 150/400 game", "Discord refused with HTTP 429 after 150/400 games"],
    ["Bị tịch thu khi duyệt tay", "Forfeited on review"],
    ["Huỷ khi duyệt tay", "Cancelled on review — refund due"],
    [
        "Panel restart giữa lúc gửi (12/40). Gửi lại sẽ cộng thừa — kiểm tra rồi quyết.",
        "The panel restarted mid-send (12/40). Sending again would add too much — check first, then decide.",
    ],
];

(async () => {
    console.log("legacyText — old Vietnamese errors shown in English");

    await test("every old message becomes today's English", () => {
        for (const [vi, en] of OLD) assert.strictEqual(toEnglish(vi), en, vi);
    });

    await test("English passes through, also with a Vietnamese username in it", () => {
        for (const s of [
            "Discord rejected the token (invalid or expired).",
            "Sáng already has Casual (3 hours)",
            "Không Tên is already in Bravery",
            "Request failed with status code 500",
        ]) {
            assert.strictEqual(toEnglish(s), s);
        }
        assert.strictEqual(toEnglish(null), null);
        assert.strictEqual(toEnglish(""), "");
    });

    await test("an unknown old Vietnamese error becomes an English notice, never shown raw", () => {
        assert.strictEqual(toEnglish("Reader chết, không đọc được badge"), UNKNOWN);
        assert.strictEqual(toEnglish("Lỗi không xác định"), UNKNOWN);
    });

    await test("every `error` field is translated, however deep; other fields are not", () => {
        const body = {
            accounts: [{ username: "kai20913", error: "Token không hợp lệ / đã hết hạn.", note: "Đơn của khách" }],
            run: { last: { error: "Không kết nối được Discord: timeout", failed: [{ error: "Token không hợp lệ (HTTP 401)" }] } },
            tieredReason: "Game Time và Game Variety chỉ bán cho tài khoản có Nitro",
        };
        const out = englishErrors(body);
        assert.strictEqual(out.accounts[0].error, "Discord rejected the token (invalid or expired).");
        assert.strictEqual(out.accounts[0].note, "Đơn của khách", "only `error` fields");
        assert.strictEqual(out.run.last.error, "Could not reach Discord: timeout");
        assert.strictEqual(out.run.last.failed[0].error, "Discord did not accept the token (HTTP 401)");
        assert.strictEqual(out.tieredReason, body.tieredReason);
        assert.strictEqual(body.accounts[0].error, "Token không hợp lệ / đã hết hạn.", "input is not mutated");
    });

    await test("a router with englishJson answers English; data stays as stored", async () => {
        const stored = [{ accountId: "1", error: "Token không hợp lệ / đã hết hạn." }];
        const page = express.Router();
        page.use(englishJson);
        page.get("/", (req, res) => res.json(stored));
        const external = express.Router();
        external.get("/", (req, res) => res.json(stored));
        const app = express();
        app.use("/api/quests", page);
        app.use("/api/external/quests", external);
        const server = app.listen(0);
        await new Promise((r) => server.once("listening", r));
        const get = (p) =>
            new Promise((resolve, reject) => {
                http.get({ port: server.address().port, path: p, agent: false }, (res) => {
                    let b = "";
                    res.on("data", (c) => (b += c));
                    res.on("end", () => resolve(JSON.parse(b)));
                }).on("error", reject);
            });
        assert.strictEqual((await get("/api/quests"))[0].error, "Discord rejected the token (invalid or expired).");
        assert.strictEqual((await get("/api/external/quests"))[0].error, "Token không hợp lệ / đã hết hạn.");
        assert.strictEqual(stored[0].error, "Token không hợp lệ / đã hết hạn.");
        server.close();
    });

    await test("the panel's /quests and /badges routers use it, the external ones do not", () => {
        const fs = require("fs");
        const path = require("path");
        const src = (f) => fs.readFileSync(path.join(__dirname, "..", "server", "routes", f), "utf8");
        assert.match(src("quests.js"), /router\.use\(englishJson\)/);
        assert.match(src("badges.js"), /router\.use\(englishJson\)/);
        assert.doesNotMatch(src("questsExternal.js"), /englishJson/);
        assert.doesNotMatch(src("badgesExternal.js"), /englishJson/);
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
