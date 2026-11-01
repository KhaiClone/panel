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

/** A buyer's tag from the cache (null until looked up), starting the lookups still owed. */
const buyerTag = (buyerId) => {
    const tag = tagOf(buyerId);
    if (pendingTags.size) resolveTags().catch(() => {});
    return tag;
};

const enrich = (order) => {
    if (!order) return order;
    return { ...order, sellerName: SELLERS[order.sellerId] || order.sellerId, buyerTag: buyerTag(order.buyerId) };
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

// ── Statistics by period ─────────────────────────────────────────────────────
// A period is a month ("2026-10"), a year ("2026"), all time (null) or a range
// of days ("2026-10-05_2026-10-20", both ends included). Months, years and days
// are Vietnam's (UTC+7) whatever the node's clock says, like the shop's /thongke
// and its report on the 1st: an order placed at 00:30 on the 1st belongs to the
// new month. An order counts in the period it was PLACED in, with its status of
// today — revenue is its completed orders, as on Discord.

const VN_OFFSET = 7 * 3600_000;
const DAY = 86_400_000;
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const RANGE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

/** "YYYY-MM" of a timestamp, in Vietnam; null for an order without a date. */
const monthOf = (ts) => {
    const n = Number(ts);
    return n > 0 ? new Date(n + VN_OFFSET).toISOString().slice(0, 7) : null;
};

const periodArg = (v) => {
    if (v === undefined || v === null || v === "" || v === "all") return null;
    if (!PERIOD.test(String(v))) throw Object.assign(new Error('period must be "all", a year like 2026 or a month like 2026-10'), { status: 400 });
    return String(v);
};

const inPeriod = (order, period) => !period || (monthOf(order.orderDate) || "").startsWith(period);

/** Midnight starting a Vietnam calendar day ("2026-10-05"), in ms; NaN if no such day. */
const vnDayStart = (day) => {
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms - VN_OFFSET : NaN;
};

/**
 * Any period above → { key, range, has(order) }: `key` is the period as given
 * ("all" for all time), `range` whether it is a range of days.
 */
const periodOf = (v) => {
    const m = String(v ?? "").match(RANGE);
    if (m) {
        const from = vnDayStart(m[1]);
        const to = vnDayStart(m[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw Object.assign(new Error("The range has a day that does not exist"), { status: 400 });
        if (from > to) throw Object.assign(new Error("The range ends before it starts"), { status: 400 });
        const end = to + DAY;
        return { key: `${m[1]}_${m[2]}`, range: true, has: (o) => Number(o.orderDate) >= from && Number(o.orderDate) < end };
    }
    let p;
    try {
        p = periodArg(v);
    } catch {
        throw Object.assign(new Error('period must be "all", a year like 2026, a month like 2026-10 or a range like 2026-10-05_2026-10-20'), { status: 400 });
    }
    return { key: p || "all", range: false, has: (o) => inPeriod(o, p) };
};

/** Every month from the first order's to this one, newest first — what the page can pick. */
const monthsSince = (orders) => {
    const now = monthOf(Date.now());
    const first = orders.reduce((m, o) => {
        const k = monthOf(o.orderDate);
        return k && k < m ? k : m;
    }, now);
    const out = [];
    const d = new Date(`${now}-01T00:00:00Z`);
    while (d.toISOString().slice(0, 7) >= first) {
        out.push(d.toISOString().slice(0, 7));
        d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return out;
};

/**
 * The period cut one level finer, oldest first: a year by month, all time by
 * year. Rows run from the first order to today — no empty future months. A month
 * and a range of days have none: the page lists their orders.
 */
const breakdownOf = (orders, period, months) => {
    if (period?.length === 7) return [];
    const keys = period
        ? months.filter((k) => k.startsWith(period)).reverse()
        : [...new Set(months.map((k) => k.slice(0, 4)))].reverse();
    const groups = new Map(keys.map((k) => [k, []]));
    for (const o of orders) {
        const m = monthOf(o.orderDate);
        groups.get(m && (period ? m : m.slice(0, 4)))?.push(o);
    }
    return keys.map((key) => ({ key, ...statsFor(groups.get(key)) }));
};

/**
 * { …counts, revenue, bySeller, period, months, breakdown } for `period` (see
 * above; missing = all time). `months` is every month the page may pick.
 */
const getStats = async ({ period } = {}) => {
    requirePanel();
    const p = periodOf(period);
    const key = p.key === "all" ? null : p.key;
    const all = sharedStore.run("orders", "get");
    const orders = all.filter(p.has);
    const months = monthsSince(all);
    const bySeller = {};
    for (const [id, name] of Object.entries(SELLERS)) bySeller[id] = { name, ...statsFor(orders.filter((o) => o.sellerId === id)) };
    return { ...statsFor(orders), bySeller, period: key, months, breakdown: p.range ? [] : breakdownOf(orders, key, months) };
};

/** getStats() for someone not allowed the shop's income: the counts, no revenue. */
const withoutRevenue = (stats) => {
    const strip = ({ revenue, ...rest }) => rest;
    return {
        ...strip(stats),
        bySeller: Object.fromEntries(Object.entries(stats.bySeller || {}).map(([id, s]) => [id, strip(s)])),
        ...(stats.breakdown ? { breakdown: stats.breakdown.map(strip) } : {}),
    };
};

// Orders with a `source` were sold by a system that also finishes them. A Deco
// Gift order is finished by ArnTo-Auto's staff channel, which hands the gift
// links over first — Done here would close it with nothing delivered. Auto Quest
// and Auto Badge orders follow the panel's own records (autoShopOrders.js).
const RUN_BY = {
    decoGift: "Deco Gift orders are approved or cancelled in ArnTo-Auto's staff channel on Discord",
};
const RUN_BY_PANEL = "Auto Quest and Auto Badge orders complete or cancel themselves when the panel finishes them";

const act = async (cmd, message, orderId) => {
    const stored = sharedStore.run("orders", "findOne", { query: { orderId: String(orderId) } });
    if (stored?.source) throw Object.assign(new Error(RUN_BY[stored.source] || RUN_BY_PANEL), { status: 409 });
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
    if (stored.source) {
        const msg =
            stored.source === "decoGift"
                ? "Deco Gift orders cannot be deleted: ArnTo-Auto runs them"
                : "Auto Quest and Auto Badge orders cannot be deleted: the panel keeps them in step with its own records";
        throw Object.assign(new Error(msg), { status: 409 });
    }
    if (!discordBus.canHandle(owner(), "order.delete")) {
        throw Object.assign(new Error('ArnTo-Shop has not announced "order.delete" on the Discord bus — update and restart it'), { status: 503 });
    }
    const order = await discordBus.request(owner(), "order.delete", { orderId: String(orderId) }, { timeoutMs: 45_000 });
    panelLog.add("owner", `Owner deleted order \`${stored.orderId}\` — ${stored.name} · ${vnd(stored.price)} · ${stored.status}`);
    return { message: "Order deleted", order: enrich(order) };
};

module.exports = {
    SELLERS,
    onPanel,
    requirePanel,
    buyerTag,
    monthOf,
    monthsSince,
    periodArg,
    inPeriod,
    periodOf,
    statsFor,
    listOrders,
    getStats,
    withoutRevenue,
    completeOrder,
    cancelOrder,
    deleteOrder,
};
