#!/usr/bin/env node
/**
 * Checks for the supporters (server/services/supporterService.js): the shop's
 * one-time import and ownership, adding / removing (with the shop's part over
 * the stubbed Discord bus), salary and adjustments, what is owed by whom since
 * the last payout, payouts, and the DM texts.
 * Run:  node scripts/supporterService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "supporter-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const supporters = require("../server/services/supporterService");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const SHOP = "1378037598953672746";
const bus = { ready: true, requests: [], notices: [], answer: { role: "added", dm: "sent" }, unknown: new Set() };
discordBus.handlerOf = (cmd) => (cmd === supporters.CMD ? SHOP : null);
discordBus.canHandle = (botId, cmd) => botId === SHOP && cmd === supporters.CMD;
discordBus.status = () => ({ ready: bus.ready });
discordBus.userTag = async (id) => {
    if (bus.unknown.has(id)) throw Object.assign(new Error("Unknown User"), { code: 10013 });
    return `user${id.slice(-3)}`;
};
discordBus.request = async (target, cmd, payload, opts) => {
    bus.requests.push({ target, cmd, payload, opts });
    return typeof bus.answer === "function" ? bus.answer(payload) : bus.answer;
};
discordBus.notify = async (target, cmd, payload, opts) => {
    bus.notices.push({ target, cmd, payload, opts });
    return { id: `n-${bus.notices.length}` };
};

const ARNTO = "427399742906040333";
const KHAIDEV = "871329074046435338";
const NGHI = "953525563878948914";
const TAM = "612880338590498816";
const NEW = "852876827965521952";
const BANK = { bankCode: "MBBank", bankBin: "970422", accountNumber: "0123 456 789" };

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
const owed = (id) => Object.fromEntries(supporters.get(id).owed.map((o) => [o.sellerId || "none", o.amount]));
const discord = { via: "discord", byId: ARNTO, byTag: "arnto" };

(async () => {
    console.log("supporterService");

    await test("import: once, the importer owns it, balances split by who owes them", async () => {
        assert.strictEqual(supporters.canAccess("someone"), true, "nobody owns it before the import");
        const r = supporters.importFrom(SHOP, {
            supporters: [
                { userId: NGHI, bank: { shortName: "VCB", bin: "970436" }, account_number: "111", balance: 37000, joinedAt: 1_700_000_000_000, owed: { [ARNTO]: 20000, [KHAIDEV]: 10000 } },
                { userId: TAM, bank: { shortName: "TCB", bin: "970407" }, account_number: "222", balance: 0, joinedAt: 1_700_000_100_000, owed: {} },
                { userId: "nope", balance: 5 },
            ],
            welcome: "Chào {user} ({id})",
        });
        assert.deepStrictEqual(r, { imported: true, supporters: 2, balance: 37000 });
        assert.strictEqual(supporters.canAccess(SHOP), true);
        assert.strictEqual(supporters.canAccess("1400736865299992576"), false, "another project's key");
        const again = supporters.importFrom(SHOP, { supporters: [{ userId: NEW, bank: { bin: "970422" }, account_number: "1" }] });
        assert.strictEqual(again.imported, false);
        assert.strictEqual(supporters.list().length, 2);
        assert.deepStrictEqual(owed(NGHI), { [ARNTO]: 20000, [KHAIDEV]: 10000, none: 7000 });
        const s = supporters.get(NGHI);
        assert.strictEqual(s.balance, 37000);
        assert.strictEqual(s.earned, 37000);
        assert.strictEqual(s.joinedAt, 1_700_000_000_000);
        assert.strictEqual(supporters.getSettings().welcome, "Chào {user} ({id})", "the shop's text is kept");
    });

    await test("add from the page: the user is looked up, the shop gives the role (and its answer is shown)", async () => {
        bus.requests.length = 0;
        const r = await supporters.add({ userId: NEW, ...BANK, accountName: "nguyen van a" }, { via: "panel" });
        assert.strictEqual(r.supporter.userTag, "user952");
        assert.strictEqual(r.supporter.accountNumber, "0123456789", "spaces dropped");
        assert.strictEqual(r.supporter.accountName, "NGUYEN VAN A");
        assert.deepStrictEqual(r.discord, { sent: true, result: { role: "added", dm: "sent" } });
        assert.strictEqual(r.event, undefined, "the page gets no raw event");
        const req = bus.requests[0];
        assert.strictEqual(req.target, SHOP);
        assert.strictEqual(req.opts.sealed, true, "bank details travel sealed");
        assert.strictEqual(req.payload.event, "joined");
        assert.strictEqual(req.payload.dm, `Chào <@${NEW}> (${NEW})`, "the welcome text, rendered");
        await rejects(() => supporters.add({ userId: NEW, ...BANK }, { via: "panel" }), 409);
        bus.unknown.add("111111111111111111");
        await rejects(() => supporters.add({ userId: "111111111111111111", ...BANK }, { via: "panel" }), 400);
        await rejects(() => supporters.add({ userId: "222222222222222222", bankCode: "MB", bankBin: "12", accountNumber: "1" }, { via: "panel" }), 400);
    });

    await test("bus down: the change is kept, the page is told the shop did not get it", async () => {
        bus.ready = false;
        const r = await supporters.update(NEW, { note: "ca tối" });
        assert.strictEqual(r.note, "ca tối");
        const c = await supporters.credit(NEW, { kind: "add", amount: 1000 }, { via: "panel" });
        assert.strictEqual(c.discord.sent, false);
        assert.match(c.discord.error, /not ready/);
        bus.ready = true;
        await supporters.credit(NEW, { kind: "deduct", amount: 1000 }, { via: "panel" });
    });

    await test("salary from /done: owed to the order's seller; the event comes back, nothing on the bus", async () => {
        bus.requests.length = 0;
        bus.notices.length = 0;
        const r = await supporters.credit(TAM, { kind: "salary", amount: 15000, sellerId: ARNTO, orderId: "6855" }, discord);
        assert.strictEqual(r.supporter.balance, 15000);
        assert.strictEqual(r.entry.kind, "salary");
        assert.strictEqual(r.entry.orderId, "6855");
        assert.strictEqual(r.entry.byTag, "arnto");
        assert.strictEqual(r.entry.via, "discord");
        assert.strictEqual(r.event.event, "credit");
        assert.strictEqual(r.event.entry.amount, 15000);
        assert.strictEqual(bus.requests.length + bus.notices.length, 0, "the shop applies it itself");
        await supporters.credit(TAM, { kind: "salary", amount: 5000, sellerId: KHAIDEV, orderId: "6856" }, discord);
        assert.deepStrictEqual(owed(TAM), { [ARNTO]: 15000, [KHAIDEV]: 5000 });
        assert.strictEqual(supporters.get(TAM).orders, 2);
    });

    await test("adjustments from the page: told to the shop without waiting; never below 0", async () => {
        bus.notices.length = 0;
        const r = await supporters.credit(TAM, { kind: "deduct", amount: 4000, sellerId: ARNTO, note: "trễ đơn" }, { via: "panel" });
        assert.strictEqual(r.supporter.balance, 16000);
        assert.strictEqual(r.entry.amount, -4000);
        assert.strictEqual(r.entry.byTag, "Panel");
        assert.deepStrictEqual(r.discord, { sent: true, queued: true });
        assert.strictEqual(bus.notices[0].payload.event, "credit");
        assert.deepStrictEqual(owed(TAM), { [ARNTO]: 11000, [KHAIDEV]: 5000 });
        await rejects(() => supporters.credit(TAM, { kind: "deduct", amount: 999999 }, { via: "panel" }), 409);
        assert.strictEqual(supporters.get(TAM).balance, 16000, "a refused deduction changes nothing");
        await rejects(() => supporters.credit(TAM, { kind: "add", amount: -5 }, { via: "panel" }), 400);
        await rejects(() => supporters.credit(TAM, { kind: "bonus", amount: 5 }, { via: "panel" }), 400);
        await rejects(() => supporters.credit("999999999999999999", { kind: "add", amount: 5 }, { via: "panel" }), 404);
    });

    await test("payout: the whole balance, owed starts over, the bank details go to the shop", async () => {
        bus.notices.length = 0;
        const r = await supporters.payout(TAM, { note: "lương tháng 10" }, { via: "panel" });
        assert.strictEqual(r.supporter.balance, 0);
        assert.strictEqual(r.entry.amount, -16000);
        assert.deepStrictEqual(r.supporter.owed, []);
        assert.strictEqual(r.supporter.paid, 16000);
        assert.strictEqual(r.supporter.earned, 16000);
        const ev = bus.notices[0].payload;
        assert.strictEqual(ev.event, "payout");
        assert.strictEqual(ev.accountNumber, "222");
        assert.strictEqual(bus.notices[0].opts.sealed, true);
        await rejects(() => supporters.payout(TAM, {}, { via: "panel" }), 409);
        await supporters.credit(TAM, { kind: "salary", amount: 3000, sellerId: KHAIDEV }, discord);
        assert.deepStrictEqual(owed(TAM), { [KHAIDEV]: 3000 }, "only what came after the payout");
    });

    await test("remove: refused while owed; then they leave, history kept, and can come back", async () => {
        await rejects(() => supporters.remove(TAM, { via: "panel" }), 409);
        await supporters.payout(TAM, {}, discord);
        bus.requests.length = 0;
        const r = await supporters.remove(TAM, { via: "panel" });
        assert.strictEqual(r.supporter.active, false);
        assert.strictEqual(bus.requests[0].payload.event, "left");
        assert.match(bus.requests[0].payload.dm, new RegExp(`<@${TAM}>`));
        assert.ok(!supporters.list().some((s) => s.userId === TAM));
        assert.ok(supporters.list({ all: true }).some((s) => s.userId === TAM && !s.active));
        await rejects(() => supporters.credit(TAM, { kind: "salary", amount: 1000 }, discord), 404);
        const back = await supporters.add({ userId: TAM, userTag: "htamm25", ...BANK }, discord);
        assert.strictEqual(back.supporter.active, true);
        assert.strictEqual(back.event.event, "joined");
        assert.strictEqual(back.supporter.paid, 19000, "the old history is still theirs");
        assert.strictEqual(back.entry.note, "Back again");
    });

    await test("ledger: newest first, by supporter and by kind", async () => {
        const all = supporters.ledger({ userId: TAM });
        assert.deepStrictEqual(
            all.map((e) => e.kind),
            ["joined", "left", "payout", "salary", "payout", "deduct", "salary", "salary", "joined"],
        );
        assert.ok(supporters.ledger({ kind: "salary" }).every((e) => e.kind === "salary"));
        assert.strictEqual(supporters.ledger({ userId: NGHI, kind: "import" }).length, 3);
    });

    await test("settings: the DM texts, empty = the default", async () => {
        const s = supporters.setSettings({ farewell: "Tạm biệt {tag}" });
        assert.strictEqual(s.farewell, "Tạm biệt {tag}");
        assert.strictEqual(s.welcome, "Chào {user} ({id})");
        const d = supporters.setSettings({ welcome: "" });
        assert.match(d.welcome, /Hỗ Trợ Viên/);
    });

    await test("sync: the shop's answer, or why it could not answer", async () => {
        bus.answer = (p) => ({ given: p.userIds.length, extra: [KHAIDEV] });
        const r = await supporters.syncRoles();
        assert.deepStrictEqual(r, { given: 3, extra: [KHAIDEV] });
        bus.ready = false;
        await rejects(() => supporters.syncRoles(), 503);
        bus.ready = true;
    });

    await test("status: who answers, totals", async () => {
        const s = supporters.status();
        assert.strictEqual(s.owner, SHOP);
        assert.strictEqual(s.handler, SHOP);
        assert.strictEqual(s.active, 3);
        assert.strictEqual(s.owed, 37000);
    });

    sharedStore.close?.();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
