const crypto = require("crypto");
const cron = require("node-cron");
const { customAlphabet } = require("nanoid");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const agentCrypto = require("./agentCrypto");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  Stock — goods kept ready on the panel (accounts, keys…), one product type
//  per kind, and handed to a buyer one random item at a time.
//
//    deliver   staff run /giao on ArnTo-assistant (POST /api/external/stock/deliver)
//              or press "Giao" on the Stock page. Either way the panel picks a
//              random item, reserves it, and asks the assistant to DM it — bus
//              "stock.deliver", SEALED so the item never sits readable in the
//              channel or the outbox. Delivered → the item leaves the stock and
//              the delivery is kept as history; DM blocked → back to stock.
//    remind    a product type with reminders on gives each delivery an expiry;
//              the buyer is reminded at 72/47/24 h and once at expiry, like a
//              bot's renewal (expiryService): ping on DISCORD_ALERT_WEBHOOK + a
//              DM from whoever announced "dm.send" (ArnTo-Auto).
//
//  A delivery carries a deadline the assistant enforces: one it reads late (it
//  was down, the bus re-reads 3 days back) is refused, so an item is never
//  DM'd hours later after it went back to stock. settle() closes deliveries
//  whose answer was lost — a timeout, a panel restart — from the outbox row.
//
//  Items are AES-GCM-encrypted with JWT_SECRET (like API keys), so the shared
//  database and its Discord backups alone do not reveal them.
//  Storage: data/shared.sqlite (travels with a panel move).
// ─────────────────────────────────────────────────────────────────────────────

const CMD = "stock.deliver";
const BUS_TIMEOUT = 45_000;
const DEADLINE_MS = 3 * 60_000; // the assistant refuses a delivery it reads later than this
const SETTLE_GRACE = 10 * 60_000; // unanswered this long after the deadline → back to stock
const WARNING_HOURS = [72, 47, 24]; // same milestones as a bot's renewal (expiryService)
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_ITEM = 1000; // one Discord embed field
const MAX_PASTE = 5000;
const MAX_FIELDS = 10;
const SNOWFLAKE = /^\d{17,20}$/;
const CODE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_MESSAGE = "### Cảm ơn quý khách đã ủng hộ ArnTo Shop. Vui lòng cho chúng mình xin 1 legit tại <#1205054570074480710>";

const newId = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 8);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS stock_products (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,         -- what /giao offers
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config TEXT NOT NULL,              -- JSON: the DM's look + reminders (cleanConfig)
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            content TEXT NOT NULL,             -- AES-GCM with JWT_SECRET
            fp TEXT NOT NULL,                  -- HMAC of the text: a line pasted twice is skipped
            status TEXT NOT NULL,              -- available | reserved | delivered
            added_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stock_items_by_product ON stock_items(product_id, status);
        CREATE TABLE IF NOT EXISTS stock_deliveries (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            item_id INTEGER NOT NULL,
            buyer_id TEXT NOT NULL,
            buyer_tag TEXT,
            staff_id TEXT,                     -- who ran /giao (null: the panel)
            staff_tag TEXT,
            via TEXT NOT NULL,                 -- discord | panel
            status TEXT NOT NULL,              -- pending | delivered
            bus_id TEXT,
            deadline INTEGER,
            message_id TEXT,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            expires_at INTEGER,
            warned TEXT,                       -- JSON: reminder milestones (hours) already sent
            expired_sent INTEGER NOT NULL DEFAULT 0,
            reminders INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS stock_deliveries_by_product ON stock_deliveries(product_id, created_at);
        CREATE INDEX IF NOT EXISTS stock_deliveries_by_status ON stock_deliveries(status);
    `);
    made = c;
    return c;
};

const secret = () => {
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set — stock cannot be stored");
    return process.env.JWT_SECRET;
};
const encrypt = (text) => JSON.stringify(agentCrypto.encrypt(text, secret()));
const decrypt = (stored) => agentCrypto.decrypt(JSON.parse(stored), secret());
const fingerprint = (productId, text) => crypto.createHmac("sha256", secret()).update(`${productId}\n${text}`).digest("hex");

// ── Product types ────────────────────────────────────────────────────────────

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** The parts of a product type the admin edits, normalised. */
const cleanConfig = (input = {}) => {
    const fields = (Array.isArray(input.fields) ? input.fields : String(input.fields || "").split("|"))
        .map((f) => str(f, 64))
        .filter(Boolean)
        .slice(0, MAX_FIELDS);
    const days = Math.round(Number(input.reminders?.days));
    return {
        title: str(input.title, 256),
        message: str(input.message, 2000),
        fields,
        separator: String(input.separator ?? ":").slice(0, 5) || ":",
        multiline: !!input.multiline,
        reminders: {
            enabled: !!input.reminders?.enabled,
            days: Number.isFinite(days) && days >= 1 ? Math.min(days, 3650) : 30,
        },
    };
};

const countsOf = (productId) => {
    const out = { available: 0, reserved: 0, delivered: 0 };
    for (const r of conn().prepare("SELECT status, COUNT(*) n FROM stock_items WHERE product_id = ? GROUP BY status").all(productId)) out[r.status] = r.n;
    return out;
};

const toProduct = (r) =>
    r && {
        id: r.id,
        code: r.code,
        name: r.name,
        enabled: !!r.enabled,
        ...JSON.parse(r.config),
        counts: countsOf(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };

const productRow = (ref) => conn().prepare("SELECT * FROM stock_products WHERE id = ? OR code = ?").get(String(ref || ""), String(ref || "").toLowerCase());
const requireProduct = (ref) => {
    const r = productRow(ref);
    if (!r) throw httpError(404, "Product not found");
    return r;
};

const listProducts = () => conn().prepare("SELECT * FROM stock_products ORDER BY name COLLATE NOCASE").all().map(toProduct);
const getProduct = (ref) => toProduct(requireProduct(ref));

const checkIdentity = ({ name, code }, exceptId = null) => {
    if (!name) throw httpError(400, "The product name is required");
    if (!CODE.test(code)) throw httpError(400, "The code may only use a-z, 0-9, - and _ (up to 32 characters)");
    const clash = conn().prepare("SELECT id FROM stock_products WHERE code = ? AND id != ?").get(code, exceptId || "");
    if (clash) throw httpError(409, `Another product already uses the code "${code}"`);
};

const createProduct = (input = {}) => {
    const name = str(input.name, 100);
    const code = str(input.code, 32).toLowerCase();
    checkIdentity({ name, code });
    const id = crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    conn()
        .prepare("INSERT INTO stock_products (id, code, name, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, code, name, input.enabled === false ? 0 : 1, JSON.stringify(cleanConfig(input)), now, now);
    return getProduct(id);
};

const updateProduct = (ref, input = {}) => {
    const row = requireProduct(ref);
    const current = JSON.parse(row.config);
    const name = input.name === undefined ? row.name : str(input.name, 100);
    const code = input.code === undefined ? row.code : str(input.code, 32).toLowerCase();
    checkIdentity({ name, code }, row.id);
    const config = cleanConfig({ ...current, ...input, reminders: { ...current.reminders, ...(input.reminders || {}) } });
    const enabled = input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0;
    conn()
        .prepare("UPDATE stock_products SET name = ?, code = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?")
        .run(name, code, enabled, JSON.stringify(config), Date.now(), row.id);
    return getProduct(row.id);
};

/** A product type with everything in it: stock and history. */
const deleteProduct = (ref) => {
    const row = requireProduct(ref);
    const c = conn();
    if (c.prepare("SELECT 1 FROM stock_deliveries WHERE product_id = ? AND status = 'pending'").get(row.id)) {
        throw httpError(409, "A delivery of this product is in progress — try again in a few minutes");
    }
    c.transaction(() => {
        c.prepare("DELETE FROM stock_deliveries WHERE product_id = ?").run(row.id);
        c.prepare("DELETE FROM stock_items WHERE product_id = ?").run(row.id);
        c.prepare("DELETE FROM stock_products WHERE id = ?").run(row.id);
    })();
    return { deleted: true };
};

// ── Items ────────────────────────────────────────────────────────────────────

/** Pasted text → items: one per line, or (multi-line products) one per block between blank lines. */
const splitItems = (text, multiline) => {
    const norm = String(text || "").replace(/\r\n?/g, "\n");
    const parts = multiline ? norm.split(/\n[ \t]*\n/) : norm.split("\n");
    return parts
        .map((p) =>
            multiline
                ? p
                      .split("\n")
                      .map((l) => l.trimEnd())
                      .join("\n")
                      .trim()
                : p.trim(),
        )
        .filter(Boolean);
};

/** → { added, duplicates } — a text already in this product (in stock or delivered) is skipped unless allowDuplicates. */
const addItems = (ref, { text, allowDuplicates = false } = {}) => {
    const row = requireProduct(ref);
    const items = splitItems(text, JSON.parse(row.config).multiline);
    if (!items.length) throw httpError(400, "No items to add");
    if (items.length > MAX_PASTE) throw httpError(400, `At most ${MAX_PASTE} items per paste`);
    const long = items.findIndex((i) => i.length > MAX_ITEM);
    if (long !== -1) throw httpError(400, `Item ${long + 1} is longer than ${MAX_ITEM} characters`);

    const c = conn();
    const seen = new Set(allowDuplicates ? [] : c.prepare("SELECT fp FROM stock_items WHERE product_id = ?").pluck().all(row.id));
    const insert = c.prepare("INSERT INTO stock_items (product_id, content, fp, status, added_at) VALUES (?, ?, ?, 'available', ?)");
    let added = 0;
    let duplicates = 0;
    const now = Date.now();
    c.transaction(() => {
        for (const text of items) {
            const fp = fingerprint(row.id, text);
            if (!allowDuplicates && seen.has(fp)) {
                duplicates++;
                continue;
            }
            seen.add(fp);
            insert.run(row.id, encrypt(text), fp, now);
            added++;
        }
    })();
    return { added, duplicates, counts: countsOf(row.id) };
};

/** What is in stock (available, and reserved while a DM is on its way). */
const listItems = (ref) => {
    const row = requireProduct(ref);
    return conn()
        .prepare("SELECT id, content, status, added_at FROM stock_items WHERE product_id = ? AND status != 'delivered' ORDER BY id")
        .all(row.id)
        .map((r) => ({ id: r.id, content: decrypt(r.content), status: r.status, addedAt: r.added_at }));
};

const deleteItem = (ref, itemId) => {
    const row = requireProduct(ref);
    const res = conn().prepare("DELETE FROM stock_items WHERE id = ? AND product_id = ? AND status = 'available'").run(Number(itemId), row.id);
    if (!res.changes) throw httpError(404, "The item is no longer in stock (delivered or being delivered)");
    return { deleted: 1, counts: countsOf(row.id) };
};

/** Empty the stock — delivered items stay, they are history. */
const clearItems = (ref) => {
    const row = requireProduct(ref);
    const res = conn().prepare("DELETE FROM stock_items WHERE product_id = ? AND status = 'available'").run(row.id);
    return { deleted: res.changes, counts: countsOf(row.id) };
};

// ── Delivering ───────────────────────────────────────────────────────────────

/**
 * An item as the DM shows it: labelled fields when the product names them
 * ("Gmail | Password | Hash" with ":" → mail:pass:hash split up; a multi-line
 * item goes line by line), the last field taking whatever is left; otherwise
 * the text as it is.
 */
const formatItem = (content, { fields = [], separator = ":" } = {}) => {
    if (!fields.length) return { text: content };
    const byLine = content.includes("\n");
    const glue = byLine ? "\n" : separator;
    const parts = content.split(glue);
    const out = fields
        .map((name, i) => ({ name, value: (i === fields.length - 1 ? parts.slice(i).join(glue) : parts[i] || "").trim() }))
        .filter((f) => f.value);
    return out.length ? { fields: out } : { text: content };
};

/** Milestones already behind a delivery with `msLeft` to go — never sent. */
const passedMilestones = (msLeft) => WARNING_HOURS.filter((h) => h * HOUR >= msLeft);

const inFlight = new Set();

/** Item back to stock, delivery forgotten — nothing reached the buyer. */
const release = (deliveryId) => {
    const c = conn();
    c.transaction(() => {
        const d = c.prepare("SELECT item_id FROM stock_deliveries WHERE id = ? AND status = 'pending'").get(deliveryId);
        if (!d) return;
        c.prepare("UPDATE stock_items SET status = 'available' WHERE id = ? AND status = 'reserved'").run(d.item_id);
        c.prepare("DELETE FROM stock_deliveries WHERE id = ?").run(deliveryId);
    })();
};

/** The assistant's answer → delivered (history) or released. */
const finish = (deliveryId, result) => {
    if (!result?.delivered) {
        release(deliveryId);
        return false;
    }
    const c = conn();
    c.transaction(() => {
        const d = c.prepare("SELECT item_id FROM stock_deliveries WHERE id = ? AND status = 'pending'").get(deliveryId);
        if (!d) return;
        c.prepare("UPDATE stock_items SET status = 'delivered' WHERE id = ?").run(d.item_id);
        c.prepare("UPDATE stock_deliveries SET status = 'delivered', delivered_at = ?, message_id = ? WHERE id = ?").run(Date.now(), result.messageId || null, deliveryId);
    })();
    return true;
};

/**
 * Give `buyerId` one random item of `product` (id or code), DM'd by the assistant.
 * → { delivered: true, deliveryId, product, expiresAt, remaining }
 *   { delivered: false, reason: "dm_blocked" | "unknown_user" | "stale", product, remaining }
 */
const deliver = async ({ product, buyerId, buyerTag, staffId, staffTag, via = "panel" } = {}) => {
    buyerId = String(buyerId || "").trim();
    if (!SNOWFLAKE.test(buyerId)) throw httpError(400, "Invalid buyer Discord ID");
    const p = toProduct(requireProduct(product));
    if (!p.enabled) throw httpError(409, `"${p.name}" is turned off`);

    const target = discordBus.handlerOf(CMD);
    if (!target) throw httpError(503, `ArnTo-assistant has not announced "${CMD}" — update and restart the bot`);
    if (!discordBus.status().ready) throw httpError(503, "The panel's Discord bus is not ready");

    // From the panel the buyer is only an id: the panel's bot looks them up
    // (an unknown id fails here, before anything is reserved).
    if (!buyerTag) {
        try {
            buyerTag = (await discordBus.userTag(buyerId)) || null;
        } catch (err) {
            if (err.code === 10013) throw httpError(404, "No Discord user with this ID");
        }
    }

    const c = conn();
    const id = newId();
    const now = Date.now();
    const expiresAt = p.reminders.enabled ? now + p.reminders.days * DAY : null;
    const item = c.transaction(() => {
        const it = c.prepare("SELECT id, content FROM stock_items WHERE product_id = ? AND status = 'available' ORDER BY RANDOM() LIMIT 1").get(p.id);
        if (!it) return null;
        c.prepare("UPDATE stock_items SET status = 'reserved' WHERE id = ?").run(it.id);
        c.prepare(
            `INSERT INTO stock_deliveries (id, product_id, item_id, buyer_id, buyer_tag, staff_id, staff_tag, via, status, deadline, created_at, expires_at, warned)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        ).run(
            id,
            p.id,
            it.id,
            buyerId,
            str(buyerTag, 64) || null,
            SNOWFLAKE.test(String(staffId || "")) ? String(staffId) : null,
            str(staffTag, 64) || null,
            via === "discord" ? "discord" : "panel",
            now + DEADLINE_MS,
            now,
            expiresAt,
            JSON.stringify(expiresAt ? passedMilestones(expiresAt - now) : []),
        );
        return it;
    })();
    if (!item) throw httpError(409, `"${p.name}" is out of stock`);

    const remaining = () => countsOf(p.id).available;
    inFlight.add(id);
    let sent;
    try {
        sent = await discordBus.request(
            target,
            CMD,
            {
                deliveryId: id,
                buyerId,
                deadline: now + DEADLINE_MS,
                product: { name: p.name, title: p.title || p.name, message: p.message || DEFAULT_MESSAGE },
                item: formatItem(decrypt(item.content), p),
                expiresAt,
            },
            {
                timeoutMs: BUS_TIMEOUT,
                sealed: true,
                onQueued: (busId) => c.prepare("UPDATE stock_deliveries SET bus_id = ? WHERE id = ?").run(busId, id),
            },
        );
    } catch (err) {
        // Unanswered: it may still be DM'd before the deadline — settle() decides from the outbox.
        if (err.status === 504) throw httpError(504, "ArnTo-assistant has not answered — if it cannot deliver before the deadline, the item goes back to stock");
        release(id); // the assistant failed it: nothing was sent
        throw err;
    } finally {
        inFlight.delete(id);
    }

    if (!finish(id, sent)) return { delivered: false, reason: sent?.reason || "not_delivered", product: p.name, remaining: remaining() };
    return { delivered: true, deliveryId: id, product: p.name, expiresAt, remaining: remaining() };
};

/**
 * Deliveries whose answer was lost (timeout, restart): close them from the outbox row.
 * A command already posted waits for its answer, however late — the assistant may
 * have DM'd it while this panel was down (the bus reads replies back on start, and
 * fails a row nobody answered in 3 days). One never posted, or never queued, is
 * released after the deadline: the assistant refuses it as stale by then.
 */
const settle = () => {
    const now = Date.now();
    for (const d of conn().prepare("SELECT id, bus_id, deadline, created_at FROM stock_deliveries WHERE status = 'pending'").all()) {
        if (inFlight.has(d.id)) continue;
        const bus = discordBus.get(d.bus_id);
        if (bus?.status === "done") finish(d.id, bus.result);
        else if (bus?.status === "failed") release(d.id);
        else if (bus?.status === "sent") continue;
        else if (now > (d.deadline || d.created_at) + SETTLE_GRACE) release(d.id);
    }
};

// ── History ──────────────────────────────────────────────────────────────────

const toDelivery = (r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name || null,
    buyerId: r.buyer_id,
    buyerTag: r.buyer_tag,
    staffId: r.staff_id,
    staffTag: r.staff_tag,
    via: r.via,
    status: r.status,
    content: r.content ? decrypt(r.content) : null,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    expiresAt: r.expires_at,
    reminders: !!r.reminders,
    expiredSent: !!r.expired_sent,
});

const DELIVERY_SELECT = `
    SELECT d.*, p.name AS product_name, i.content
    FROM stock_deliveries d
    LEFT JOIN stock_products p ON p.id = d.product_id
    LEFT JOIN stock_items i ON i.id = d.item_id`;

/** Newest first; `productId` narrows to one product type. */
const listDeliveries = ({ productId, limit = 1000 } = {}) => {
    const n = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
    const rows = productId
        ? conn().prepare(`${DELIVERY_SELECT} WHERE d.product_id = ? ORDER BY d.created_at DESC LIMIT ?`).all(requireProduct(productId).id, n)
        : conn().prepare(`${DELIVERY_SELECT} ORDER BY d.created_at DESC LIMIT ?`).all(n);
    return rows.map(toDelivery);
};

const deliveryRow = (id) => {
    const r = conn().prepare("SELECT * FROM stock_deliveries WHERE id = ?").get(String(id));
    if (!r) throw httpError(404, "Delivery not found");
    if (r.status !== "delivered") throw httpError(409, "This delivery is still in progress");
    return r;
};
const getDelivery = (id) => toDelivery(conn().prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(String(id)));

/** Renewed: +days from the expiry (or from now, once it has passed); reminders start over. */
const extendDelivery = (id, days) => {
    const r = deliveryRow(id);
    const n = Math.round(Number(days));
    if (!(n >= 1 && n <= 3650)) throw httpError(400, "Invalid number of days");
    const now = Date.now();
    const expiresAt = Math.max(r.expires_at || now, now) + n * DAY;
    conn()
        .prepare("UPDATE stock_deliveries SET expires_at = ?, warned = ?, expired_sent = 0 WHERE id = ?")
        .run(expiresAt, JSON.stringify(passedMilestones(expiresAt - now)), r.id);
    return getDelivery(r.id);
};

const setDeliveryReminders = (id, enabled) => {
    const r = deliveryRow(id);
    conn().prepare("UPDATE stock_deliveries SET reminders = ? WHERE id = ?").run(enabled ? 1 : 0, r.id);
    return getDelivery(r.id);
};

// ── Expiry reminders ─────────────────────────────────────────────────────────

/**
 * Hourly: each milestone once, the most urgent reached one announced (as
 * expiryService does for bots), then one "expired" notice. Only for products
 * whose reminders are on now, and deliveries not switched off one by one.
 */
const checkExpiry = async () => {
    const { sendStockExpiryWarning, sendStockExpired } = require("./discordService");
    const c = conn();
    const now = Date.now();
    const products = new Map(c.prepare("SELECT * FROM stock_products").all().map((r) => [r.id, toProduct(r)]));
    const due = c
        .prepare("SELECT * FROM stock_deliveries WHERE status = 'delivered' AND reminders = 1 AND expired_sent = 0 AND expires_at IS NOT NULL")
        .all();
    for (const d of due) {
        const p = products.get(d.product_id);
        if (!p?.reminders.enabled) continue;
        const delivery = toDelivery({ ...d, content: null });
        try {
            const msLeft = d.expires_at - now;
            if (msLeft <= 0) {
                await sendStockExpired({ product: p, delivery });
                c.prepare("UPDATE stock_deliveries SET expired_sent = 1 WHERE id = ?").run(d.id);
                continue;
            }
            const hoursLeft = Math.ceil(msLeft / HOUR);
            const warned = JSON.parse(d.warned || "[]");
            const reached = WARNING_HOURS.filter((h) => hoursLeft <= h);
            if (!reached.some((h) => !warned.includes(h))) continue;
            await sendStockExpiryWarning({ product: p, delivery, hoursLeft });
            c.prepare("UPDATE stock_deliveries SET warned = ? WHERE id = ?").run(JSON.stringify([...new Set([...warned, ...reached])]), d.id);
        } catch (err) {
            console.error(`[Stock] Reminder for ${d.id} failed: ${err.message}`);
        }
    }
};

// ── What the assistant offers in /giao ───────────────────────────────────────

const catalog = () =>
    conn()
        .prepare("SELECT * FROM stock_products WHERE enabled = 1 ORDER BY name COLLATE NOCASE")
        .all()
        .map((r) => ({ code: r.code, name: r.name, available: countsOf(r.id).available }));

/** Who would deliver and remind — for the Stock page's warnings. */
const status = () => {
    const bus = discordBus.status();
    return {
        busReady: !!bus.ready,
        deliverer: discordBus.handlerOf(CMD),
        dmSender: discordBus.handlerOf("dm.send"),
        alertWebhook: !!process.env.DISCORD_ALERT_WEBHOOK,
    };
};

// ── Scheduler ────────────────────────────────────────────────────────────────

const start = () => {
    conn();
    settle();
    checkExpiry().catch((e) => console.error("[Stock] Expiry check failed:", e.message));
    setInterval(lifecycle.guard(() => {
        try {
            settle();
        } catch (e) {
            console.error("[Stock] Settle failed:", e.message);
        }
    }), 60_000);
    cron.schedule("5 * * * *", lifecycle.guard(() => checkExpiry().catch((e) => console.error("[Stock] Expiry check failed:", e.message))));
    console.log("[Stock] Stock service started");
};

module.exports = {
    CMD,
    DEFAULT_MESSAGE,
    WARNING_HOURS,
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    deleteProduct,
    splitItems,
    addItems,
    listItems,
    deleteItem,
    clearItems,
    formatItem,
    deliver,
    settle,
    listDeliveries,
    extendDelivery,
    setDeliveryReminders,
    checkExpiry,
    catalog,
    status,
    start,
};
