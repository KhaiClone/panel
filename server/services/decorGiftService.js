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

// Pictures come straight from Discord's CDN, which Discord always loads. The
// composed picture /decor-find shows (decor on a sample avatar / profile,
// bundle layers, a frame around a profile) is drawn by ArnTo-Auto itself from
// the record's fields below (its functions/decorImage.js) — no longer linked
// to KhaiDevApi, whose Render free tier made Discord drop the image.
const thumbOf = (decor) => {
    if (decor.type === 1000) return (Array.isArray(decor.assetURL) && decor.assetURL[0]) || null;
    if (decor.type === 3 && (decor.previewValid === false || !decor.staticURL)) {
        // /preview is gone: the frame's ring layer (or its first) on its own.
        const layers = decor.frame?.layers || [];
        const layer = layers.find((l) => l.anchor === "center") || layers[0];
        if (layer) return `https://cdn.discordapp.com/media/v1/collectibles-shop/${decor.sku_id}/${layer.id}/static`;
    }
    if (decor.staticURL) return decor.staticURL;
    // A nameplate's assetURL is a .webm — not a picture.
    return decor.type === 0 && typeof decor.assetURL === "string" ? decor.assetURL : null;
};

/** The record's fields a composed picture is drawn from — only those its type uses. */
const artOf = (decor) => {
    if (decor.type === 1000) return { assetURL: decor.assetURL || [], backgroundColors: decor.backgroundColors || [] };
    const art = { staticURL: decor.staticURL || null };
    if (decor.type === 0 && !decor.staticURL && typeof decor.assetURL === "string") art.assetURL = decor.assetURL;
    if (decor.type === 3) Object.assign(art, { frame: decor.frame || null, previewValid: decor.previewValid ?? null });
    return art;
};

/**
 * Every decor sold as a Gift (switch on, priced), grouped like the decor site:
 * its theme in the categories' order, leftovers under "Khác".
 * → { categories: [{ sku_id, name, count }], decors: [{ sku_id, name, type, typeLabel, category, price, thumb, image, members?, ...art }] }
 *   `image` is `thumb` again, for readers from before the art fields.
 */
const catalog = async () => {
    const [list, cats] = await Promise.all([decorService.listDecors(), decorService.listCategories()]);
    const decors = [];
    for (const d of list) {
        const price = d.type === 1000 ? d.sellingPrices?.giftBundle : d.sellingPrices?.gift;
        if (!(price > 0)) continue;
        const thumb = thumbOf(d);
        decors.push({
            sku_id: d.sku_id,
            name: d.name,
            type: d.type,
            typeLabel: TYPE_LABEL[d.type] || "Decor",
            category: d.category_sku_id || null,
            price,
            thumb,
            image: thumb,
            ...(d.type === 1000 ? { members: (d.items || []).map((i) => i.name).filter(Boolean) } : {}),
            ...artOf(d),
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

// ── Orders made on the panel ─────────────────────────────────────────────────
// A buyer who paid in a ticket instead of by QR: staff pick the decors on the
// Orders page and ArnTo-Auto records the order as paid — bus "decor.gift.create".
// From there it is an ordinary Deco Gift order: the shop's arnto_N, the staff
// card, an admin approves with the links. Priced from the catalog, never by hand.

const MANUAL_REF = /^[a-z0-9]{8,20}$/;
// Auto asks the panel for the shop's order (≤ BUS_TIMEOUT) before it answers.
const CREATE_TIMEOUT = 75_000;

const auto = () => {
    const botId = discordBus.handlerOf("decor.gift.create");
    if (!botId) throw httpError(503, 'ArnTo-Auto has not announced "decor.gift.create" on the Discord bus — update and restart it');
    return botId;
};

/** A Discord user id → { known: true, tag } | { known: false } | { known: null } (the bus is down). */
const buyerInfo = async (id) => {
    if (!SNOWFLAKE.test(String(id || ""))) throw httpError(400, "Not a Discord user ID");
    try {
        const tag = await discordBus.userTag(id);
        return tag === undefined ? { known: null, tag: null } : { known: true, tag };
    } catch (err) {
        if (err.code === 10013) return { known: false, tag: null }; // unknown user
        throw err;
    }
};

/**
 * `ref` is the form's own id: sending the same form again (after a timeout)
 * returns the order the first send made instead of a second one.
 * → { id, existed, status, shopOrderId, waitingUrl, shopError, staffUrl }
 */
const createByHand = async ({ ref, buyerId, skus, note } = {}, auth = {}) => {
    if (!MANUAL_REF.test(String(ref || ""))) throw httpError(400, "ref is required");
    const buyer = String(buyerId || "").trim();
    if (!SNOWFLAKE.test(buyer)) throw httpError(400, "The buyer's Discord user ID is required");
    if (!Array.isArray(skus) || !skus.length) throw httpError(400, "Pick at least one decor");
    if (skus.length > MAX_ITEMS) throw httpError(400, `At most ${MAX_ITEMS} decors per order`);
    const wanted = skus.map(String);
    if (new Set(wanted).size !== wanted.length) throw httpError(400, "The same decor is picked twice");

    const target = auto();
    const index = new Map((await catalog()).decors.map((d) => [String(d.sku_id), d]));
    const items = wanted.map((sku) => {
        const d = index.get(sku);
        if (!d) throw httpError(409, "A picked decor is no longer sold as a Gift — reopen the form");
        return { sku_id: d.sku_id, name: d.name, type: d.type, typeLabel: d.typeLabel, price: d.price, thumb: d.thumb || null, image: d.image || null };
    });
    const by =
        auth.kind === "staff"
            ? { name: auth.staff.userTag || auth.staff.userId, discordId: auth.staff.userId }
            : { name: auth.username || "owner", discordId: null };
    return discordBus.request(
        target,
        "decor.gift.create",
        {
            id: `DGP-${ref}`,
            buyerId: buyer,
            items,
            total: items.reduce((s, i) => s + i.price, 0),
            note: String(note || "").trim().slice(0, 300),
            by,
        },
        { timeoutMs: CREATE_TIMEOUT },
    );
};

module.exports = {
    SOURCE,
    MAX_ITEMS,
    GIFT_LINK,
    catalog,
    createOrder,
    completeOrder,
    deliver,
    cancelOrder,
    buyerInfo,
    createByHand,
    thumbOf,
};
