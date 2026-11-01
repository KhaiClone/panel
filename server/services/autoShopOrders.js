const db = require("../db");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const panelLog = require("./panelLog");
const lifecycle = require("./lifecycle");
const pricingStore = require("./pricingStore");

// ─────────────────────────────────────────────────────────────────────────────
//  Auto Quest and Auto Badge orders in the shop's books (user, 2026-11-01).
//
//  The Orders page, the shop's /thongke and its report on the 1st count the
//  shop's `orders` only. Deco Gift orders were already there; Auto Quest and
//  Auto Badge orders were not, so KhaiDev's income left them out. Every such
//  order — sold on ArnTo-Auto or added by hand on /quests, /badges — lives on
//  the panel, and the panel knows when it finishes, so the panel keeps the
//  books: it has ArnTo-Shop record each one as an `arnto_N` order, seller
//  AUTO_SELLER_ID, over the Discord bus.
//
//    open     the order exists on the panel → "order.record" (status pending).
//             Quietly: no waiting-list message, no DM — ArnTo-Auto already DMs
//             the buyer and shows the order in its own feed.
//    settle   it finished → "order.complete" (the money counts from then on)
//             or "order.cancel". A monthly plan is complete when paid.
//    history  past orders (backfill, below) are recorded with their date and
//             final status in one go — no role, no message, and outside this
//             month's /thongke unless they happened this month.
//
//  This is an outbox: one row per order in `auto_shop_orders`, `want` = the
//  state the panel's own record says, `have` = what the shop confirmed. A
//  worker sends what differs, every minute and right after a change, so a shop
//  that is down or restarting loses nothing. It sends nothing until the shop
//  announces "order.record": an older shop would post the order in its waiting
//  list and DM the buyer. The shop is idempotent on externalId, and answers
//  "already completed / cancelled" for a repeat.
//
//  Prices: what the buyer paid (ArnTo-Auto passes it, CTV price included); an
//  order added by hand counts at the regular price — the badge tier's, or
//  quests × the per-quest price, or months × the monthly price.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = "auto_shop_orders";
const BACKFILL_KEY = "auto_shop_orders_backfill";
const AUTO_SELLER_ID = process.env.AUTO_ORDERS_SELLER_ID || "871329074046435338"; // KhaiDev
const CMD = "order.record";
const BUS_TIMEOUT = 45_000;
const SYNC_EVERY_MS = 60_000;
const KEEP_MS = 90 * 86_400_000; // a settled row is only needed to answer a repeat
const MONTH_MS = 30 * 86_400_000; // questMonthly's month
const MAX_FAILS_IN_A_ROW = 3; // then the bus is likely down: try again next minute
const STATES = ["pending", "completed", "cancelled"];
const SNOWFLAKE = /^\d{17,20}$/;

const SOURCE = { quest: "autoQuest", monthly: "autoQuestMonthly", badge: "autoBadge" };

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const questName = (n) => (n > 0 ? `Auto Quest: ${plural(n, "quest")}` : "Auto Quest");
const monthlyName = (months) => `Auto Quest Monthly: ${plural(months, "month")}`;
const badgeName = (badgeKey, tierName) =>
    `Auto Badge: ${pricingStore.BADGE_CATALOG[badgeKey]?.label ?? badgeKey} — ${tierName ?? "?"}`;

/** The regular price of a badge tier (an order added by hand counts at it); null = not priced. */
const badgeBasePrice = (pricing, badgeKey, tierKey) =>
    pricing.autoBadge.badges[badgeKey]?.tiers.find((t) => t.key === tierKey)?.price ?? null;

/**
 * `order` in a body from ArnTo-Auto: { id, price, reseller? } — the payment it was
 * for. Missing → null (an older ArnTo-Auto, or not a purchase). Malformed → 400.
 */
const orderArg = (v) => {
    if (v === undefined || v === null) return null;
    const id = typeof v?.id === "string" ? v.id.trim() : "";
    const price = Number(v?.price);
    if (!id || id.length > 64 || !(price > 0) || (v.reseller !== undefined && typeof v.reseller !== "boolean")) {
        throw Object.assign(new Error("order must be { id, price > 0, reseller? }"), { status: 400 });
    }
    return { id, price, reseller: v.reseller === true };
};

// ── Storage ──────────────────────────────────────────────────────────────────
// quick.db rewrites the whole collection per write: every write goes through one chain.

let chain = Promise.resolve();
const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
};

const all = async () => (await db.get(MODEL)) || [];
const patch = (externalId, data) =>
    serial(() => db.findOneAndUpdate(MODEL, { externalId }, { ...data, updatedAt: Date.now() }));

// ── Backfill: the orders from before the shop kept them (once) ────────────────
//
// Badge: every order on the panel — paid price, or the tier's regular price for
// one added by hand (buyer = the account). Finished ones go in as history.
// Monthly quests: one order per plan still on the panel, months estimated from
// addedAt to its end × the regular monthly price (no record of each payment
// exists; plans a week past their end are already erased). Single quests: none
// — what is left of them carries no price (the user, 2026-11-01).

const BADGE_WANT = { sent: "completed", forfeited: "completed", refund_due: "cancelled", cancelled: "cancelled" };

let backfilled = null;
/** Resolves once the backfill ran. A new purchase waits for it, so it is never counted twice. */
const ready = () => (backfilled ??= backfill().catch((e) => console.error("[AutoShopOrders] Backfill failed:", e.message)));

async function backfill() {
    if (await db.get(BACKFILL_KEY)) return;
    const pricing = await pricingStore.getPricing();
    const have = new Set((await all()).map((r) => r.externalId));
    const rows = [];
    const add = (r) => {
        if (!have.has(r.externalId) && r.price > 0 && SNOWFLAKE.test(String(r.buyerId || ""))) rows.push(r);
    };
    for (const o of (await db.get("badge_orders")) || []) {
        const manual = o.source === "manual";
        const want = BADGE_WANT[o.status] ?? "pending";
        add({
            externalId: `badge:${o.orderId}`,
            source: SOURCE.badge,
            buyerId: String((manual ? null : o.ref) || o.accountId || ""),
            name: badgeName(o.badgeKey, o.tierName),
            price: manual ? badgeBasePrice(pricing, o.badgeKey, o.tierKey) : o.price,
            reseller: !manual && o.reseller === true,
            orderDate: o.paidAt || o.createdAt || Date.now(),
            want,
            history: want !== "pending",
        });
    }
    const monthly = pricing.autoQuest.monthlyPrice;
    for (const p of (await db.get("quest_monthly")) || []) {
        const months = Math.max(1, Math.round((new Date(p.monthlyExpiresAt).getTime() - (p.addedAt || 0)) / MONTH_MS));
        add({
            externalId: `questMonthly:history:${p.accountId}`,
            source: SOURCE.monthly,
            buyerId: String(p.ref || p.accountId || ""),
            name: monthlyName(months),
            price: months * monthly,
            reseller: false,
            orderDate: p.addedAt || Date.now(),
            want: "completed",
            history: true,
        });
    }
    const now = Date.now();
    await serial(async () => {
        const list = await all();
        for (const r of rows) list.push({ ...r, have: null, shopOrderId: null, tries: 0, error: null, createdAt: now, updatedAt: now });
        await db.set(MODEL, list);
        await db.set(BACKFILL_KEY, { at: now, orders: rows.length });
    });
    if (rows.length) {
        const vnd = rows.reduce((s, r) => s + r.price, 0).toLocaleString("en-US");
        const badges = rows.filter((r) => r.source === SOURCE.badge).length;
        panelLog.add(
            "system",
            `Auto orders: queued ${rows.length} past orders for the shop's books (${badges} Auto Badge, ${rows.length - badges} monthly quest plans) — ${vnd} VND`,
        );
    }
}

// ── Open / settle (called from the order services; never throw at them) ───────

/**
 * An auto order exists: { externalId, source, buyerId, name, price, reseller?,
 * orderDate?, want? }. Opening the same externalId again changes nothing.
 */
async function open(entry) {
    try {
        await ready();
        const price = Number(entry.price);
        const buyerId = String(entry.buyerId || "");
        if (!(price > 0) || !SNOWFLAKE.test(buyerId)) {
            console.warn(`[AutoShopOrders] ${entry.externalId}: not recorded (price ${entry.price}, buyer ${buyerId || "none"})`);
            return null;
        }
        const now = Date.now();
        const row = await serial(async () => {
            const existing = await db.findOne(MODEL, { externalId: entry.externalId });
            if (existing) return existing;
            return db.create(MODEL, {
                externalId: entry.externalId,
                source: entry.source,
                buyerId,
                name: String(entry.name).slice(0, 100),
                price,
                reseller: entry.reseller === true,
                orderDate: entry.orderDate || now,
                want: STATES.includes(entry.want) ? entry.want : "pending",
                history: false,
                have: null,
                shopOrderId: null,
                tries: 0,
                error: null,
                createdAt: now,
                updatedAt: now,
            });
        });
        kick();
        return row;
    } catch (e) {
        console.error(`[AutoShopOrders] open ${entry?.externalId}: ${e.message}`);
        return null;
    }
}

/** The order finished: "completed" | "cancelled". A finished order never changes its mind. */
async function settle(externalId, want) {
    if (!["completed", "cancelled"].includes(want)) return;
    try {
        await serial(async () => {
            const row = await db.findOne(MODEL, { externalId });
            if (!row || row.want !== "pending") return;
            await db.findOneAndUpdate(MODEL, { externalId }, { want, updatedAt: Date.now() });
        });
        kick();
    } catch (e) {
        console.error(`[AutoShopOrders] settle ${externalId}: ${e.message}`);
    }
}

// ── Worker ───────────────────────────────────────────────────────────────────

/** Busy-or-done errors from the shop that mean "already in that state". */
const alreadyIn = (err) => String(err?.message || "").match(/already (completed|cancelled)/i)?.[1]?.toLowerCase() ?? null;
const notFound = (err) => /order not found/i.test(String(err?.message || ""));

/** The shop, when it can take the books: it owns `orders` here and announced "order.record". */
const shopId = () => {
    const row = sharedStore.nameRow("orders");
    if (row?.state !== "active" || !row.owner) return null;
    return discordBus.canHandle(row.owner, CMD) ? row.owner : null;
};

async function step(shop, r) {
    let { have, shopOrderId } = r;
    if (!shopOrderId) {
        const order = await discordBus.request(
            shop,
            CMD,
            {
                externalId: r.externalId,
                source: r.source,
                sellerId: AUTO_SELLER_ID,
                buyerId: r.buyerId,
                name: r.name,
                price: r.price,
                orderDate: r.orderDate,
                status: r.history ? r.want : "pending",
                reseller: r.reseller === true,
            },
            { timeoutMs: BUS_TIMEOUT },
        );
        shopOrderId = order?.orderId || null;
        have = STATES.includes(order?.status) ? order.status : r.history ? r.want : "pending";
        await patch(r.externalId, { shopOrderId, have, tries: 0, error: null });
    }
    if (have !== "pending" || r.want === "pending") return;
    const cmd = r.want === "completed" ? "order.complete" : "order.cancel";
    try {
        const order = await discordBus.request(shop, cmd, { orderId: shopOrderId }, { timeoutMs: BUS_TIMEOUT });
        have = STATES.includes(order?.status) ? order.status : r.want;
    } catch (err) {
        if (notFound(err)) {
            // Deleted on the shop's side: nothing left to keep in step.
            panelLog.add("warn", `Auto orders: \`${shopOrderId}\` (${r.name}) is gone from the shop — left as is`);
            have = r.want;
        } else if (!(have = alreadyIn(err))) {
            throw err;
        }
    }
    if (have !== r.want) console.warn(`[AutoShopOrders] ${shopOrderId}: wanted ${r.want}, the shop has it ${have}`);
    await patch(r.externalId, { have, tries: 0, error: null });
}

let syncing = null;
let again = false;
/** One pass at a time; a change during a pass gets another pass right after. */
const sync = () => {
    if (syncing) {
        again = true;
        return syncing;
    }
    syncing = runSync().finally(() => {
        syncing = null;
        if (again) {
            again = false;
            sync();
        }
    });
    return syncing;
};
const kick = () => {
    if (lifecycle.isActive()) sync().catch(() => {});
};

async function runSync() {
    await ready();
    const shop = shopId();
    if (!shop) return;
    let fails = 0;
    for (const r of await all()) {
        if (r.shopOrderId && r.have === r.want) continue;
        if (!lifecycle.isActive()) return;
        try {
            await step(shop, r);
            fails = 0;
        } catch (err) {
            const tries = (r.tries || 0) + 1;
            await patch(r.externalId, { tries, error: String(err.message || err).slice(0, 300) });
            console.warn(`[AutoShopOrders] ${r.externalId}: ${err.message}`);
            if (tries === 5) panelLog.add("warn", `Auto orders: the shop keeps refusing ${r.name} (${r.externalId}): ${err.message}`);
            if (++fails >= MAX_FAILS_IN_A_ROW) return;
        }
    }
    const cutoff = Date.now() - KEEP_MS;
    await serial(async () => {
        const list = await all();
        const kept = list.filter((r) => !(r.have === r.want && r.want !== "pending" && (r.updatedAt || 0) < cutoff));
        if (kept.length !== list.length) await db.set(MODEL, kept);
    });
}

const start = () => {
    ready().then(kick);
    setInterval(lifecycle.guard(() => sync().catch((e) => console.error("[AutoShopOrders] Sync failed:", e.message))), SYNC_EVERY_MS);
    console.log("[AutoShopOrders] Auto order books started");
};

module.exports = {
    AUTO_SELLER_ID,
    SOURCE,
    questName,
    monthlyName,
    badgeName,
    badgeBasePrice,
    orderArg,
    ready,
    open,
    settle,
    sync,
    start,
};
