#!/usr/bin/env node
/**
 * Checks decorGiftService.createOrder's statusUrl: ArnTo-Auto shows a Deco Gift order
 * in its own order feed and sends that message's link, which goes to the shop in
 * order.create (the shop then leaves its waiting list out of it). A link that is not
 * a Discord message link is refused; without one the request is as before. The bus,
 * shared data and decor data are stubbed.
 * Run:  node scripts/decorGiftStatusUrl.test.js
 */

const path = require("path");
const assert = require("assert");

const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const sent = []; // { botId, cmd, body }
stub("services/sharedStore", { nameRow: (name) => ({ owner: name === "orders" ? "shop" : "assistant" }) });
stub("services/discordBus", {
    canHandle: () => true,
    request: async (botId, cmd, body) => {
        sent.push({ botId, cmd, body });
        return { orderId: "arnto_7", messageId: body.statusUrl ? null : "999", waitingUrl: body.statusUrl || "https://discord.com/channels/1/2/999" };
    },
});
stub("services/decorService", { listDecors: async () => [], listCategories: async () => [] });
stub("services/resellerService", {});

const decorGift = require("../server/services/decorGiftService");

const base = {
    paymentId: "DG-abc123",
    buyerId: "871329074046435338",
    sellerId: "871329074046435338",
    items: [{ sku_id: "1", name: "Neon Cat", type: 0, price: 66000 }],
    total: 66000,
};
const FEED = "https://discord.com/channels/1103736775815471257/1551668987786432563/1551668987786432999";

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
    console.log("decorGiftService.createOrder — statusUrl");

    await test("a feed message link goes to the shop in order.create", async () => {
        sent.length = 0;
        const res = await decorGift.createOrder({ ...base, statusUrl: FEED });
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].cmd, "order.create");
        assert.strictEqual(sent[0].botId, "shop");
        assert.strictEqual(sent[0].body.statusUrl, FEED);
        assert.strictEqual(sent[0].body.source, "decoGift");
        // Same shape as before: the link comes back as waitingUrl.
        assert.deepStrictEqual(res, { orderId: "arnto_7", messageId: null, waitingUrl: FEED });
    });

    await test("without one, order.create carries no statusUrl (the waiting list as before)", async () => {
        sent.length = 0;
        for (const statusUrl of [undefined, null, ""]) await decorGift.createOrder({ ...base, statusUrl });
        assert.strictEqual(sent.length, 3);
        for (const s of sent) assert.ok(!("statusUrl" in s.body));
    });

    await test("anything but a Discord message link is refused before the shop is asked", async () => {
        sent.length = 0;
        for (const statusUrl of ["https://example.com/x", "https://discord.com/channels/1/2", `${FEED}?x=1`, "javascript:alert(1)"]) {
            await assert.rejects(decorGift.createOrder({ ...base, statusUrl }), (e) => e.status === 400 && /statusUrl/.test(e.message));
        }
        assert.strictEqual(sent.length, 0);
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
