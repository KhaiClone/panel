#!/usr/bin/env node
/**
 * Checks for the vouchers (server/services/voucherService.js): vouchers, giving
 * them to members (with the DM batch over the stubbed Discord bus), using them
 * within the per-member and overall limits, claiming / rejecting, and settling
 * DM batches whose answer was lost.
 * Run:  node scripts/voucherService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voucher-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const vouchers = require("../server/services/voucherService");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const bus = { handler: "assistant", ready: true, requests: [], notices: [], answer: null, rows: new Map(), unknown: new Set() };
discordBus.handlerOf = (cmd) => (cmd.startsWith("voucher.") ? bus.handler : null);
discordBus.status = () => ({ ready: bus.ready });
discordBus.userTag = async (id) => {
    if (bus.unknown.has(id)) throw Object.assign(new Error("Unknown User"), { code: 10013 });
    return `user${id.slice(-3)}`;
};
discordBus.get = (id) => bus.rows.get(id) || null;
discordBus.request = async (target, cmd, payload, opts) => {
    const busId = `bus-${bus.requests.length + 1}`;
    bus.requests.push({ target, cmd, payload, opts, busId });
    opts.onQueued?.(busId);
    return typeof bus.answer === "function" ? bus.answer(payload) : bus.answer;
};
discordBus.notify = async (target, cmd, payload, opts) => {
    bus.notices.push({ target, cmd, payload, opts });
    return { id: `n-${bus.notices.length}` };
};

const raw = () => sharedStore.raw();
const tick = () => new Promise((r) => setImmediate(r));
const A = "871329074046435338";
const B = "427399742906040333";
const C = "1133037157527859230";
const ADMIN = "1378037598953672746";

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
const rejects = async (fn, status) => {
    try {
        await fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};
const dmOf = (voucherId, userId) => raw().prepare("SELECT dm FROM voucher_grants WHERE voucher_id = ? AND user_id = ?").pluck().get(voucherId, userId);

(async () => {
    console.log("voucherService");
    let tet;
    let open;

    await test("vouchers: create, generated or own code, validation", async () => {
        tet = vouchers.createVoucher({ name: "Giảm 20k", description: "Trừ 20k vào đơn kế tiếp", perUser: 2 });
        assert.match(tet.code, /^[A-Z2-9]{8}$/, "a code is generated");
        assert.strictEqual(tet.audience, "granted", "for granted members by default");
        assert.strictEqual(tet.perUser, 2);
        assert.strictEqual(tet.total, 0);
        assert.deepStrictEqual(tet.counts, { pending: 0, claimed: 0, rejected: 0, used: 0, granted: 0 });
        open = vouchers.createVoucher({ name: "Tặng decor", code: "tet-2026", audience: "public", perUser: 1, total: 2 });
        assert.strictEqual(open.code, "TET-2026", "codes are upper case");
        await rejects(() => vouchers.createVoucher({ name: "Khác", code: "Tet-2026" }), 409);
        await rejects(() => vouchers.createVoucher({ name: "Khác", code: "có dấu" }), 400);
        await rejects(() => vouchers.createVoucher({ name: "", code: "ABC" }), 400);
        await rejects(() => vouchers.createVoucher({ name: "X", expiresAt: "soon" }), 400);
        const edited = vouchers.updateVoucher(tet.id, { description: "Trừ 20k" });
        assert.strictEqual(edited.description, "Trừ 20k");
        assert.strictEqual(edited.perUser, 2, "untouched settings stay");
        assert.strictEqual(edited.code, tet.code);
        assert.strictEqual(vouchers.getVoucher("tet-2026").id, open.id, "found by code, any case");
    });

    await test("grant: ids from any text, unknown users left out, one sealed DM batch", async () => {
        bus.unknown.add(C);
        bus.answer = (p) => ({ results: Object.fromEntries(p.users.map((u) => [u.id, u.id === B ? "dm_blocked" : "sent"])) });
        const res = await vouchers.grant(tet.id, { userIds: `<@${A}>, ${B}\n${C} rác` });
        assert.deepStrictEqual(res, { added: 2, updated: 0, unknown: [C], dm: "queued" });
        await tick();
        const req = bus.requests.at(-1);
        assert.strictEqual(req.cmd, "voucher.granted");
        assert.strictEqual(req.opts.sealed, true, "the code travels sealed");
        assert.strictEqual(req.payload.voucher.code, tet.code);
        assert.deepStrictEqual(req.payload.users, [{ id: A, uses: 2 }, { id: B, uses: 2 }]);
        const grants = vouchers.listGrants(tet.id);
        assert.strictEqual(grants.find((g) => g.userId === A).dm, "sent");
        assert.strictEqual(grants.find((g) => g.userId === B).dm, "dm_blocked");
        assert.strictEqual(grants.find((g) => g.userId === A).userTag, "user338");
        await rejects(() => vouchers.grant(tet.id, { userIds: "nobody" }), 400);
    });

    await test("grant again: own limit replaced, uses kept; no DM when off", async () => {
        const before = bus.requests.length;
        const res = await vouchers.grant(tet.id, { userIds: A, uses: 3, notify: false });
        assert.deepStrictEqual(res, { added: 0, updated: 1, unknown: [], dm: "off" });
        assert.strictEqual(bus.requests.length, before, "nothing sent");
        assert.strictEqual(dmOf(tet.id, A), "sent", "the earlier DM state stays");
        assert.strictEqual(vouchers.listGrants(tet.id).find((g) => g.userId === A).uses, 3);
        vouchers.updateGrant(tet.id, A, { uses: "" });
        assert.strictEqual(vouchers.listGrants(tet.id).find((g) => g.userId === A).uses, null, "back to the voucher's limit");
    });

    await test("redeem: unknown code, not granted, disabled, expired", async () => {
        assert.deepStrictEqual(vouchers.redeem({ code: "NOPE", userId: A }), { ok: false, reason: "not_found" });
        assert.deepStrictEqual(vouchers.redeem({ code: tet.code, userId: C }), { ok: false, reason: "not_granted" });
        vouchers.updateVoucher(tet.id, { enabled: false });
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: A }).reason, "disabled");
        vouchers.updateVoucher(tet.id, { enabled: true, expiresAt: Date.now() - 1000 });
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: A }).reason, "expired");
        vouchers.updateVoucher(tet.id, { expiresAt: Date.now() + 86_400_000 });
        await rejects(() => vouchers.redeem({ code: tet.code, userId: "abc" }), 400);
    });

    let first;
    await test("redeem: a pending use with the card's channel; the member's limit holds", async () => {
        vouchers.setSettings({ channelId: "1205054570074480710", pingRoleId: "", staffRoleIds: "<@&1246001516893175818> x" });
        const r = vouchers.redeem({ code: tet.code.toLowerCase(), userId: A, userTag: "khai", note: "đơn arnto_2600" });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.card, { channelId: "1205054570074480710", pingRoleId: null });
        assert.strictEqual(r.view.redemption.status, "pending");
        assert.strictEqual(r.view.redemption.note, "đơn arnto_2600");
        assert.deepStrictEqual(r.view.usage, { used: 1, limit: 2 });
        assert.strictEqual(r.view.voucher.code, tet.code);
        first = r.view.redemption.id;
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: A }).ok, true);
        assert.deepStrictEqual(vouchers.redeem({ code: tet.code, userId: A }), { ok: false, reason: "limit_user", used: 2, limit: 2 });
        assert.strictEqual(vouchers.getVoucher(tet.id).counts.pending, 2);
    });

    await test("mine: the member's vouchers with uses left; public ones not listed", async () => {
        const list = vouchers.mine(A);
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(
            { code: list[0].code, used: list[0].used, limit: list[0].limit, remaining: list[0].remaining, pending: list[0].pending },
            { code: tet.code, used: 2, limit: 2, remaining: 0, pending: 2 },
        );
        assert.deepStrictEqual(vouchers.mine(C), []);
    });

    await test("claim on Discord: staff role allowed, a second claim is a 409 with the view", async () => {
        assert.strictEqual(vouchers.canClaim({ isAdmin: false, roleIds: ["1"] }), false);
        assert.strictEqual(vouchers.canClaim({ isAdmin: false, roleIds: ["1246001516893175818"] }), true);
        assert.strictEqual(vouchers.canClaim({ isAdmin: true }), true);
        vouchers.attachCard(first, { channelId: "1205054570074480710", messageId: "1400000000000000000" });
        const notices = bus.notices.length;
        const view = vouchers.claim(first, { staffId: ADMIN, staffTag: "admin", via: "discord" });
        assert.strictEqual(view.redemption.status, "claimed");
        assert.strictEqual(view.redemption.staffTag, "admin");
        assert.strictEqual(view.redemption.via, "discord");
        assert.strictEqual(view.redemption.messageId, "1400000000000000000");
        assert.strictEqual(bus.notices.length, notices, "Discord updates its own card");
        const err = await rejects(() => vouchers.reject(first, { via: "discord" }), 409);
        assert.strictEqual(err.view.redemption.status, "claimed");
        await rejects(() => vouchers.claim("NOPE", {}), 404);
    });

    await test("reject on the panel: the use comes back, the assistant is told (sealed)", async () => {
        const second = vouchers.listRedemptions({ voucherId: tet.id, status: "pending" })[0];
        const view = vouchers.reject(second.id, { staffTag: "Panel", via: "panel", reason: "trùng đơn" });
        assert.strictEqual(view.redemption.status, "rejected");
        assert.strictEqual(view.redemption.reason, "trùng đơn");
        assert.deepStrictEqual(view.usage, { used: 1, limit: 2 }, "a rejected use does not count");
        const n = bus.notices.at(-1);
        assert.strictEqual(n.cmd, "voucher.resolved");
        assert.strictEqual(n.opts.sealed, true);
        assert.strictEqual(n.payload.redemption.id, second.id);
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: A }).ok, true, "a use is free again");
    });

    await test("public voucher: anyone, one each, two overall", async () => {
        assert.strictEqual(vouchers.redeem({ code: open.code, userId: A }).ok, true);
        assert.strictEqual(vouchers.redeem({ code: open.code, userId: A }).reason, "limit_user");
        assert.strictEqual(vouchers.redeem({ code: open.code, userId: B }).ok, true);
        assert.strictEqual(vouchers.redeem({ code: open.code, userId: C }).reason, "limit_total");
        const pending = vouchers.listRedemptions({ voucherId: open.id, status: "pending" });
        vouchers.reject(pending[0].id, {});
        assert.strictEqual(vouchers.redeem({ code: open.code, userId: C }).ok, true, "a rejected use frees a slot overall");
    });

    await test("no limit: per member 0", async () => {
        const free = vouchers.createVoucher({ name: "Free", audience: "public", perUser: 0 });
        for (let i = 0; i < 5; i++) assert.strictEqual(vouchers.redeem({ code: free.code, userId: B }).ok, true);
        assert.strictEqual(vouchers.getVoucher(free.id).counts.used, 5);
        assert.strictEqual(vouchers.mine(B).some((v) => v.code === free.code), false, "not given to B, so not listed");
    });

    await test("DM batch answered late: settle() reads the outbox; never queued → failed", async () => {
        bus.answer = () => {
            throw Object.assign(new Error("timeout"), { status: 504 });
        };
        await vouchers.grant(open.id, { userIds: [A, B] });
        await tick();
        const busId = bus.requests.at(-1).busId;
        assert.strictEqual(dmOf(open.id, A), "pending");
        vouchers.settle();
        assert.strictEqual(dmOf(open.id, A), "pending", "still on its way");
        bus.rows.set(busId, { status: "sent" });
        vouchers.settle();
        assert.strictEqual(dmOf(open.id, A), "pending");
        bus.rows.set(busId, { status: "done", result: { results: { [A]: "sent", [B]: "unknown_user" } } });
        vouchers.settle();
        assert.strictEqual(dmOf(open.id, A), "sent");
        assert.strictEqual(dmOf(open.id, B), "unknown_user");

        raw().prepare("UPDATE voucher_grants SET dm = 'pending', bus_id = NULL, dm_at = ? WHERE voucher_id = ? AND user_id = ?").run(Date.now() - 11 * 60_000, open.id, A);
        vouchers.settle();
        assert.strictEqual(dmOf(open.id, A), "failed");
    });

    await test("a failed bus command marks the batch failed; resend DMs one member", async () => {
        bus.answer = () => {
            throw Object.assign(new Error("boom"), { status: 502 });
        };
        await vouchers.resendDm(open.id, A);
        await tick();
        assert.strictEqual(dmOf(open.id, A), "failed");
        bus.answer = (p) => ({ results: { [p.users[0].id]: "sent" } });
        assert.deepStrictEqual(vouchers.resendDm(open.id, A), { dm: "queued" });
        await tick();
        assert.strictEqual(dmOf(open.id, A), "sent");
        await rejects(() => vouchers.resendDm(open.id, C), 404);
    });

    await test("no DM sender: granted anyway, reported unavailable", async () => {
        bus.handler = null;
        bus.unknown.clear();
        const before = bus.requests.length;
        const res = await vouchers.grant(tet.id, { userIds: C });
        assert.strictEqual(res.dm, "unavailable");
        assert.strictEqual(bus.requests.length, before);
        assert.strictEqual(dmOf(tet.id, C), "off");
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: C }).ok, true);
        bus.handler = "assistant";
    });

    await test("revoke and delete: refused while a use waits, then everything goes", async () => {
        vouchers.revoke(tet.id, C);
        assert.strictEqual(vouchers.redeem({ code: tet.code, userId: C }).reason, "not_granted");
        assert.strictEqual(vouchers.listRedemptions({ voucherId: tet.id }).some((r) => r.userId === C), true, "past uses stay");
        await rejects(() => vouchers.deleteVoucher(tet.id), 409);
        for (const r of vouchers.listRedemptions({ voucherId: tet.id, status: "pending" })) vouchers.claim(r.id, {});
        vouchers.deleteVoucher(tet.id);
        await rejects(() => vouchers.getVoucher(tet.id), 404);
        assert.strictEqual(raw().prepare("SELECT COUNT(*) FROM voucher_redemptions WHERE voucher_id = ?").pluck().get(tet.id), 0);
        assert.strictEqual(raw().prepare("SELECT COUNT(*) FROM voucher_grants WHERE voucher_id = ?").pluck().get(tet.id), 0);
    });

    await test("settings: ids validated", async () => {
        await rejects(() => vouchers.setSettings({ channelId: "general" }), 400);
        const s = vouchers.setSettings({ pingRoleId: "1246001516893175818" });
        assert.strictEqual(s.channelId, "1205054570074480710", "untouched settings stay");
        assert.deepStrictEqual(s.staffRoleIds, ["1246001516893175818"]);
    });

    sharedStore.close?.();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
