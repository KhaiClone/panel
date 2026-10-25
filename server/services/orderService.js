const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const panelLog = require("./panelLog");

// ─────────────────────────────────────────────────────────────────────────────
//  Shop orders for the panel's Orders page.
//
//  `orders` (and the nextOrderId counter) is shared data owned by ArnTo-Shop:
//  listing and stats read the panel's copy. Done / Cancel / Delete need the
//  shop's Discord client (edit the order message, DM the buyer, post in the
//  ticket) or its own data, so they go to the shop over the Discord bus. The
//  panel never calls the shop.
//  Shapes are the shop's former api/ordersApi.js, unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const SELLERS = {
    "427399742906040333": "ArnTo",
    "871329074046435338": "KhaiDev",
};

const onPanel = () => sharedStore.nameRow("orders")?.state === "active";
const requirePanel = () => {
    if (!onPanel()) throw Object.assign(new Error("The orders are not on the panel yet — the shop moves them here on its next start (PANEL_SHARED)"), { status: 503 });
};
const owner = () => sharedStore.nameRow("orders")?.owner || null;

const sum = (arr) => arr.reduce((s, o) => s + (o.price || 0), 0);

// ── Buyer tags ───────────────────────────────────────────────────────────────
// The shop showed each buyer's tag from its own Discord cache. The panel looks
// tags up with its own bot instead — in the background, a few per second, kept
// in shared.sqlite and refreshed after a week — so listing never waits on Discord.

const TAGS = "__orders.buyerTags";
const TAG_TTL = 7 * 86_400_000;
let tags = null;
const pendingTags = new Set();
let resolving = false;

const loadTags = () => {
    if (tags) return tags;
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(TAGS);
    tags = new Map(Object.entries(r ? JSON.parse(r.value) : {}));
    return tags;
};
const saveTags = () =>
    sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(TAGS, JSON.stringify(Object.fromEntries(tags)));

const resolveTags = async () => {
    if (resolving) return;
    resolving = true;
    try {
        let changed = 0;
        for (const id of [...pendingTags]) {
            pendingTags.delete(id);
            let tag;
            try {
                tag = await discordBus.userTag(id);
            } catch (err) {
                tag = err.code === 10013 ? null : undefined; // 10013 = unknown user → remember "none"
            }
            if (tag === undefined) break; // bus down: try again on a later listing
            tags.set(id, { tag, at: Date.now() });
            if (++changed % 50 === 0) saveTags();
            await new Promise((r) => setTimeout(r, 250));
        }
        if (changed) saveTags();
    } finally {
        resolving = false;
    }
};

const tagOf = (buyerId) => {
    if (!buyerId) return null;
    const t = loadTags().get(String(buyerId));
    if (!t || Date.now() - t.at > TAG_TTL) pendingTags.add(String(buyerId));
    return t?.tag ?? null;
};

const enrich = (order) => {
    if (!order) return order;
    const out = { ...order, sellerName: SELLERS[order.sellerId] || order.sellerId, buyerTag: tagOf(order.buyerId) };
    if (pendingTags.size) resolveTags().catch(() => {});
    return out;
};

const statsFor = (orders) => ({
    total: orders.length,
    pending: orders.filter((o) => o.status === "pending").length,
    completed: orders.filter((o) => o.status === "completed").length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
    buyers: new Set(orders.map((o) => o.buyerId)).size,
    revenue: sum(orders.filter((o) => o.status === "completed")),
});

const listOrders = async ({ status, sellerId } = {}) => {
    requirePanel();
    let orders = sharedStore.run("orders", "get");
    if (status) orders = orders.filter((o) => o.status === status);
    if (sellerId) orders = orders.filter((o) => o.sellerId === sellerId);
    orders.sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0));
    return { orders: orders.map(enrich) };
};

const getStats = async () => {
    requirePanel();
    const orders = sharedStore.run("orders", "get");
    const bySeller = {};
    for (const [id, name] of Object.entries(SELLERS)) bySeller[id] = { name, ...statsFor(orders.filter((o) => o.sellerId === id)) };
    return { ...statsFor(orders), bySeller };
};

/** getStats() for someone not allowed the shop's income: the counts, no revenue. */
const withoutRevenue = (stats) => {
    const strip = ({ revenue, ...rest }) => rest;
    return {
        ...strip(stats),
        bySeller: Object.fromEntries(Object.entries(stats.bySeller || {}).map(([id, s]) => [id, strip(s)])),
    };
};

const act = async (cmd, message, orderId) => {
    // A Deco Gift order is finished by ArnTo-Auto's staff channel, which hands the
    // gift links over first — Done here would close it with nothing delivered.
    const stored = sharedStore.run("orders", "findOne", { query: { orderId: String(orderId) } });
    if (stored?.source === "decoGift") {
        throw Object.assign(new Error("Deco Gift orders are approved or cancelled in ArnTo-Auto's staff channel on Discord"), { status: 409 });
    }
    const order = await discordBus.request(owner(), cmd, { orderId: String(orderId) }, { timeoutMs: 45_000 });
    return { message, order: enrich(order) };
};

const completeOrder = async (orderId) => {
    requirePanel();
    return act("order.complete", "Order completed", orderId);
};

const cancelOrder = async (orderId) => {
    requirePanel();
    return act("order.cancel", "Order cancelled", orderId);
};

// Same style as the pages (client/src/utils/format.js money): "1,000,000 VND".
const vnd = (n) => `${Number(n || 0).toLocaleString("en-US")} VND`;

/**
 * Delete an order, whatever its status (owner only — routes/shopOrders.js; on
 * Discord it is /order-remove). The shop does it (order.delete): besides the
 * record here it holds what else counts the order — the monthly statistics
 * (/thongke and the 1st-of-month report read its own monthlyOrders list), the
 * buyer's history and spend, the waiting-list message. Removing the record here
 * alone would leave all of that behind. The buyer is not told.
 */
const deleteOrder = async (orderId) => {
    requirePanel();
    const stored = sharedStore.run("orders", "findOne", { query: { orderId: String(orderId) } });
    if (!stored) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (stored.source === "decoGift") {
        throw Object.assign(new Error("Deco Gift orders cannot be deleted: ArnTo-Auto runs them"), { status: 409 });
    }
    if (!discordBus.canHandle(owner(), "order.delete")) {
        throw Object.assign(new Error('ArnTo-Shop has not announced "order.delete" on the Discord bus — update and restart it'), { status: 503 });
    }
    const order = await discordBus.request(owner(), "order.delete", { orderId: String(orderId) }, { timeoutMs: 45_000 });
    panelLog.add("owner", `Owner deleted order \`${stored.orderId}\` — ${stored.name} · ${vnd(stored.price)} · ${stored.status}`);
    return { message: "Order deleted", order: enrich(order) };
};

module.exports = { SELLERS, onPanel, statsFor, listOrders, getStats, withoutRevenue, completeOrder, cancelOrder, deleteOrder };
