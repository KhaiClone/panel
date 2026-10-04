const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const decorService = require("./decorService");

// ─────────────────────────────────────────────────────────────────────────────
//  Auto Deco Gift — a buyer picks decors on ArnTo-Auto's Discord panel, pays by
//  QR there, and an admin hands over the gift links. Each bot keeps to what it
//  owns, and the panel is the only one that talks to all of them:
//
//    catalog   decors sold as Gift, priced like the decor site — read from the
//              assistant's shared data (the panel may read every name)
//    create    after payment: ArnTo-Shop opens a real order (arnto_N) in its
//              waiting list, the way /new does — bus "order.create"
//    deliver   ArnTo-assistant DMs the gift links — bus "decor.gift.deliver",
//              SEALED so the links never sit readable in the channel or the
//              outbox — then the shop completes the order ("order.complete")
//    cancel    the shop cancels it ("order.cancel")
//
//  Shop orders made here carry source "decoGift": the Orders page will not
//  complete them, because Done there would close an order whose links were
//  never delivered (services/orderService.js).
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE = "decoGift";
const MAX_ITEMS = 5;
const BUS_TIMEOUT = 45_000;
const GIFT_LINK = /^https:\/\/discord\.gift\/[A-Za-z0-9]{8,32}$/;
const SNOWFLAKE = /^\d{17,20}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Who does what ────────────────────────────────────────────────────────────

const ownerOf = (name) => sharedStore.nameRow(name)?.owner || null;

/** The project that handles `cmd` for shared name `name` — it must own it AND have announced the command. */
const busTarget = (name, cmd, label) => {
    const botId = ownerOf(name);
    if (!botId) throw httpError(503, `${label}: "${name}" is not on the panel yet`);
    if (!discordBus.canHandle(botId, cmd)) throw httpError(503, `${label} has not announced "${cmd}" on the Discord bus — update and restart it`);
    return botId;
};
const shop = (cmd) => busTarget("orders", cmd, "ArnTo-Shop");
const assistant = () => busTarget("decors", "decor.gift.deliver", "ArnTo-assistant");

// ── Catalog ──────────────────────────────────────────────────────────────────

const TYPE_LABEL = { 0: "Avatar", 1: "Profile", 2: "Nameplate", 3: "Frame", 1000: "Bundle" };

// The picture /decor-find shows (KhaiDevApi renders it); `thumb` is the plain
// CDN image, light enough for a list of them.
const imageOf = (decor) => {
    const api = decorService.FRAME_API();
    if (decor.type === 3) return decorService.frameImageURL(decor);
    if (decor.type === 1000) {
        const [fg, bg] = Array.isArray(decor.assetURL) ? decor.assetURL : [];
        if (!fg) return null;
        return (
            `${api}/discord/deco?image1=${encodeURI(fg)}` +
            (bg ? `&image2=${encodeURI(bg)}` : "") +
            (decor.backgroundColors?.length ? `&colors=${decor.backgroundColors.join(",")}` : "") +
            "&type=bundle"
        );
    }
    const src = decor.staticURL || (typeof decor.assetURL === "string" ? decor.assetURL : null);
    return src ? `${api}/discord/deco?image=${encodeURI(src)}&type=${decor.type}` : null;
};
const thumbOf = (decor) =>
    (decor.type === 3 ? decorService.frameImageURL(decor) : null) ||
    decor.staticURL ||
    (Array.isArray(decor.assetURL) ? decor.assetURL[0] : null) ||
    imageOf(decor);

/**
 * Every decor sold as a Gift (switch on, priced), grouped like the decor site:
 * its theme in the categories' order, leftovers under "Khác".
 * → { categories: [{ sku_id, name, count }], decors: [{ sku_id, name, type, typeLabel, category, price, thumb, image, members? }] }
 */
const catalog = async () => {
    const [list, cats] = await Promise.all([decorService.listDecors(), decorService.listCategories()]);
    const decors = [];
    for (const d of list) {
        const price = d.type === 1000 ? d.sellingPrices?.giftBundle : d.sellingPrices?.gift;
        if (!(price > 0)) continue;
        decors.push({
            sku_id: d.sku_id,
            name: d.name,
            type: d.type,
            typeLabel: TYPE_LABEL[d.type] || "Decor",
            category: d.category_sku_id || null,
            price,
            thumb: thumbOf(d),
            image: imageOf(d),
            ...(d.type === 1000 ? { members: (d.items || []).map((i) => i.name).filter(Boolean) } : {}),
        });
    }
    const counts = new Map();
    for (const d of decors) counts.set(d.category, (counts.get(d.category) || 0) + 1);
    const categories = [];
    for (const c of cats) {
        if (!counts.has(c.sku_id)) continue;
        categories.push({ sku_id: c.sku_id, name: c.name, count: counts.get(c.sku_id) });
        counts.delete(c.sku_id);
    }
    const known = new Set(categories.map((c) => c.sku_id));
    let other = 0;
    for (const d of decors) {
        if (known.has(d.category)) continue;
        d.category = "other";
        other++;
    }
    if (other) categories.push({ sku_id: "other", name: "Khác", count: other });
    return { updatedAt: Date.now(), categories, decors };
};

// ── Orders ───────────────────────────────────────────────────────────────────

const cleanItems = (items, { needLink = false } = {}) => {
    if (!Array.isArray(items) || !items.length) throw httpError(400, "items is required");
    if (items.length > MAX_ITEMS) throw httpError(400, `At most ${MAX_ITEMS} decors per order`);
    return items.map((i, n) => {
        const name = String(i?.name || "").trim().slice(0, 100);
        if (!name) throw httpError(400, `items[${n}].name is required`);
        const out = { sku_id: String(i.sku_id || ""), name, type: Number.isFinite(i.type) ? i.type : null };
        if (Number.isFinite(i.price)) out.price = i.price;
        if (needLink) {
            const link = String(i.link || "").trim();
            if (!GIFT_LINK.test(link)) throw httpError(400, `items[${n}].link is not a discord.gift link`);
            out.link = link;
        }
        return out;
    });
};

/** Busy-or-done errors from the shop that mean "already in the state you asked for". */
const already = (err, state) => new RegExp(`already ${state}`, "i").test(String(err?.message || ""));

/**
 * After payment: the shop opens the order. Idempotent on paymentId — a retry
 * after a timeout gets the order the first attempt made.
 * → { orderId, messageId, waitingUrl }
 */
const createOrder = async ({ paymentId, buyerId, sellerId, items, total } = {}) => {
    if (!paymentId || typeof paymentId !== "string") throw httpError(400, "paymentId is required");
    if (!SNOWFLAKE.test(String(buyerId || ""))) throw httpError(400, "buyerId is required");
    if (!SNOWFLAKE.test(String(sellerId || ""))) throw httpError(400, "sellerId is required");
    const clean = cleanItems(items);
    const price = Number(total);
    if (!(price > 0)) throw httpError(400, "total must be a positive number");
    let name = `Deco Gift: ${clean.map((i) => i.name).join(", ")}`;
    if (name.length > 100) name = `${name.slice(0, 97)}...`;
    const order = await discordBus.request(
        shop("order.create"),
        "order.create",
        { externalId: paymentId, source: SOURCE, sellerId: String(sellerId), buyerId: String(buyerId), name, price, items: clean },
        { timeoutMs: BUS_TIMEOUT },
    );
    return { orderId: order?.orderId, messageId: order?.messageId || null, waitingUrl: order?.waitingUrl || null };
};

/** The shop completes the order — tolerant of a repeat. → { completed } */
const completeOrder = async (orderId) => {
    try {
        await discordBus.request(shop("order.complete"), "order.complete", { orderId: String(orderId) }, { timeoutMs: BUS_TIMEOUT });
    } catch (err) {
        if (!already(err, "completed")) throw err;
    }
    return { completed: true };
};

/**
 * The assistant DMs the links (sealed), then the shop completes the order.
 * A closed DM is an answer, not an error: → { delivered: false, reason }.
 * → { delivered, completed, error? }
 */
const deliver = async (orderId, { buyerId, items } = {}) => {
    if (!orderId) throw httpError(400, "orderId is required");
    if (!SNOWFLAKE.test(String(buyerId || ""))) throw httpError(400, "buyerId is required");
    const clean = cleanItems(items, { needLink: true });
    const sent = await discordBus.request(
        assistant(),
        "decor.gift.deliver",
        { orderId: String(orderId), buyerId: String(buyerId), items: clean },
        { timeoutMs: BUS_TIMEOUT, sealed: true },
    );
    if (!sent?.delivered) return { delivered: false, completed: false, reason: sent?.reason || "not_delivered" };
    try {
        await completeOrder(orderId);
        return { delivered: true, completed: true };
    } catch (err) {
        // Delivered is what matters to the buyer; ArnTo-Auto retries the completion.
        return { delivered: true, completed: false, error: err.message };
    }
};

/** The shop cancels the order — tolerant of a repeat. → { cancelled } */
const cancelOrder = async (orderId) => {
    try {
        await discordBus.request(shop("order.cancel"), "order.cancel", { orderId: String(orderId) }, { timeoutMs: BUS_TIMEOUT });
    } catch (err) {
        if (!already(err, "cancelled")) throw err;
    }
    return { cancelled: true };
};

module.exports = { SOURCE, MAX_ITEMS, GIFT_LINK, catalog, createOrder, completeOrder, deliver, cancelOrder, imageOf, thumbOf };
