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
//
//  The ranking can go by spend, completed orders, all orders, average per
//  completed order or the latest order (SORTS), and count only one seller's
//  orders, one kind of order (FILTER_SOURCE), or only buyers who are active
//  resellers. A ranking by spend or average needs the money too.
// ─────────────────────────────────────────────────────────────────────────────

const SNOWFLAKE = /^\d{17,20}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// A period: "2026-10" | "2026" | "all" or a range of Vietnam days
// "2026-10-05_2026-10-20" — the Orders page's own (orderService.periodOf).
const { periodOf } = orderService;

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

/** Ways to rank, highest first. `money`: only with the revenue grant. */
const SORTS = {
    spent: { money: true, of: (b) => b.spent },
    completed: { of: (b) => b.completed },
    orders: { of: (b) => b.total },
    average: { money: true, of: (b) => b.average },
    recent: { of: (b) => b.lastOrder ?? 0 },
};
const defaultSort = (money) => (money ? "spent" : "completed");

/** Kinds of order: a ticket order has no source; the others were sold by a system. */
const FILTER_SOURCE = {
    ticket: (o) => !o.source,
    autoQuest: (o) => o.source === "autoQuest",
    autoQuestMonthly: (o) => o.source === "autoQuestMonthly",
    autoBadge: (o) => o.source === "autoBadge",
    decoGift: (o) => o.source === "decoGift",
};

/** Ranked by `sort`, then completed orders, then all orders, then who bought first. */
const ranked = (orders, sort) => {
    const by = new Map();
    for (const o of orders) {
        if (!o.buyerId) continue;
        const id = String(o.buyerId);
        if (!by.has(id)) by.set(id, blank(id));
        add(by.get(id), o);
    }
    const rows = [...by.values()];
    for (const b of rows) b.average = b.completed ? Math.round(b.spent / b.completed) : 0;
    const of = SORTS[sort].of;
    rows.sort(
        (a, b) =>
            of(b) - of(a) ||
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
        delete out.average;
        out.bySeller = Object.fromEntries(Object.entries(b.bySeller).map(([id, { spent, ...s }]) => [id, s]));
    }
    return out;
};

/** The ranking asked for: { sort, seller, source, resellers } checked; bad values are 400, a money sort without money 403. */
const optionsOf = ({ sort, seller, source, resellers: onlyResellers }, money) => {
    const s = sort || defaultSort(money);
    if (!SORTS[s]) throw httpError(400, `sort must be one of ${Object.keys(SORTS).join(", ")}`);
    if (SORTS[s].money && !money) throw httpError(403, "Ranking by spend needs the Orders page's \"See revenue\" access");
    const sel = seller && seller !== "all" ? String(seller) : null;
    if (sel && !orderService.SELLERS[sel]) throw httpError(400, "Unknown seller");
    const src = source && source !== "all" ? String(source) : null;
    if (src && !FILTER_SOURCE[src]) throw httpError(400, `source must be one of all, ${Object.keys(FILTER_SOURCE).join(", ")}`);
    return { sort: s, seller: sel, source: src, resellers: onlyResellers === true || onlyResellers === "1" || onlyResellers === "true" };
};

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Every buyer with an order placed in `period`, ranked by `sort`, counting only
 * `seller`'s / `source`'s orders when given, only active resellers with `resellers`.
 * The totals are those of the buyers listed.
 * → { period, sort, seller, source, resellers, months, money,
 *     totals: { buyers, orders, pending, completed, cancelled, revenue? }, buyers: [...] }
 */
const list = async ({ period, money = false, ...opts } = {}) => {
    orderService.requirePanel();
    const p = periodOf(period);
    const o = optionsOf(opts, money);
    const all = sharedStore.run("orders", "get");
    const orders = all.filter(
        (x) => p.has(x) && (!o.seller || x.sellerId === o.seller) && (!o.source || FILTER_SOURCE[o.source](x)),
    );
    let rows = ranked(orders, o.sort);
    if (o.resellers) {
        rows = rows.filter((b) => resellers.isReseller(b.buyerId));
        rows.forEach((r, i) => (r.rank = i + 1));
    }
    const sum = (k) => rows.reduce((s, b) => s + b[k], 0);
    const totals = { buyers: rows.length, orders: sum("total"), pending: sum("pending"), completed: sum("completed"), cancelled: sum("cancelled") };
    if (money) totals.revenue = sum("spent");
    return { period: p.key, ...o, months: orderService.monthsSince(all), money, totals, buyers: rows.map((b) => shape(b, money)) };
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
    const b = ranked(all, defaultSort(money)).find((r) => r.buyerId === id);
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

module.exports = { SORTS, periodOf, list, profile };
