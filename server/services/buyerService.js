const sharedStore = require("./sharedStore");
const orderService = require("./orderService");
const resellers = require("./resellerService");

// ─────────────────────────────────────────────────────────────────────────────
//  Buyers page — every customer who ever ordered, what /me shows on Discord,
//  and a ranking for any period (user, 2026-11-01).
//
//  Read-only, from the shop's `orders` on the panel — the same data as the
//  Orders page, so a period cuts the same way: an order counts in the period it
//  was PLACED in (Vietnam time), with its status of today. Spent = its
//  completed orders, like the Orders page's revenue and /me's "Đã chi" (the
//  shop's own `buyers.spent` agreed for 1,406 of 1,412 buyers on 2026-11-01;
//  the rest had it edited by hand). A buyer with no order in a period is not
//  in that period's list.
//
//  Money goes only to whoever may see the shop's income (orders.revenue —
//  routes/buyers.js). Without it nothing priced is sent, and the ranking goes
//  by completed orders instead, so its order gives away nobody's spend.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const VN_OFFSET = 7 * 3600_000;
const RANGE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;
const SNOWFLAKE = /^\d{17,20}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Midnight starting a Vietnam calendar day ("2026-10-05"), in ms; NaN if no such day. */
const vnDayStart = (day) => {
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms - VN_OFFSET : NaN;
};

/**
 * A period: "2026-10" | "2026" | "all" (as the Orders page), or a range of
 * Vietnam days "2026-10-05_2026-10-20", both ends included.
 * → { key, has(order) }
 */
const periodOf = (v) => {
    const range = String(v ?? "").match(RANGE);
    if (range) {
        const from = vnDayStart(range[1]);
        const to = vnDayStart(range[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw httpError(400, "The range has a day that does not exist");
        if (from > to) throw httpError(400, "The range ends before it starts");
        const end = to + DAY;
        return { key: `${range[1]}_${range[2]}`, has: (o) => Number(o.orderDate) >= from && Number(o.orderDate) < end };
    }
    let p;
    try {
        p = orderService.periodArg(v);
    } catch {
        throw httpError(400, 'period must be "all", a year like 2026, a month like 2026-10 or a range like 2026-10-05_2026-10-20');
    }
    return { key: p || "all", has: (o) => orderService.inPeriod(o, p) };
};

// ── Totals per buyer ─────────────────────────────────────────────────────────

const blank = (buyerId) => ({
    buyerId,
    total: 0,
    pending: 0,
    completed: 0,
    cancelled: 0,
    spent: 0,
    bySeller: {},
    firstOrder: null,
    lastOrder: null,
});

const add = (b, o) => {
    b.total++;
    if (o.status === "pending") b.pending++;
    if (o.status === "cancelled") b.cancelled++;
    const s = (b.bySeller[o.sellerId] ??= { name: orderService.SELLERS[o.sellerId] || o.sellerId, orders: 0, completed: 0, spent: 0 });
    s.orders++;
    if (o.status === "completed") {
        b.completed++;
        b.spent += o.price || 0;
        s.completed++;
        s.spent += o.price || 0;
    }
    const at = Number(o.orderDate) || null;
    if (at && (!b.firstOrder || at < b.firstOrder)) b.firstOrder = at;
    if (at && (!b.lastOrder || at > b.lastOrder)) b.lastOrder = at;
};

/** Ranked: by spend (or, without money, by completed orders), then orders, then who bought first. */
const ranked = (orders, money) => {
    const by = new Map();
    for (const o of orders) {
        if (!o.buyerId) continue;
        const id = String(o.buyerId);
        if (!by.has(id)) by.set(id, blank(id));
        add(by.get(id), o);
    }
    const rows = [...by.values()].sort(
        (a, b) =>
            (money ? b.spent - a.spent : 0) ||
            b.completed - a.completed ||
            b.total - a.total ||
            (a.firstOrder ?? Infinity) - (b.firstOrder ?? Infinity),
    );
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
};

/** What is sent of a buyer's totals — nothing priced without money. */
const shape = (b, money) => {
    const out = { ...b, tag: orderService.buyerTag(b.buyerId), reseller: resellers.isReseller(b.buyerId) };
    if (!money) {
        delete out.spent;
        out.bySeller = Object.fromEntries(Object.entries(b.bySeller).map(([id, { spent, ...s }]) => [id, s]));
    }
    return out;
};

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Every buyer with an order placed in `period`, ranked.
 * → { period, months, money, totals: { buyers, orders, pending, completed, cancelled, revenue? }, buyers: [...] }
 */
const list = async ({ period, money = false } = {}) => {
    orderService.requirePanel();
    const p = periodOf(period);
    const all = sharedStore.run("orders", "get");
    const orders = all.filter(p.has);
    const rows = ranked(orders, money);
    const totals = {
        buyers: rows.length,
        orders: orders.length,
        pending: orders.filter((o) => o.status === "pending").length,
        completed: orders.filter((o) => o.status === "completed").length,
        cancelled: orders.filter((o) => o.status === "cancelled").length,
    };
    if (money) totals.revenue = orders.filter((o) => o.status === "completed").reduce((s, o) => s + (o.price || 0), 0);
    return { period: p.key, months: orderService.monthsSince(all), money, totals, buyers: rows.map((b) => shape(b, money)) };
};

/**
 * One buyer, all time — what /me shows, their all-time rank and every order
 * they placed, newest first.
 */
const profile = async (buyerId, { money = false } = {}) => {
    orderService.requirePanel();
    const id = String(buyerId || "");
    if (!SNOWFLAKE.test(id)) throw httpError(400, "Not a Discord user id");
    const all = sharedStore.run("orders", "get");
    const b = ranked(all, money).find((r) => r.buyerId === id);
    if (!b) throw httpError(404, "No orders from this buyer");
    const history = all
        .filter((o) => String(o.buyerId) === id)
        .sort((x, y) => (Number(y.orderDate) || 0) - (Number(x.orderDate) || 0))
        .map((o) => ({
            orderId: o.orderId,
            name: o.name,
            ...(money ? { price: o.price } : {}),
            status: o.status,
            orderDate: o.orderDate ?? null,
            sellerId: o.sellerId,
            sellerName: orderService.SELLERS[o.sellerId] || o.sellerId,
            source: o.source || null,
        }));
    return { ...shape(b, money), money, history };
};

module.exports = { periodOf, list, profile };
