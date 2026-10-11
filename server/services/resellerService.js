const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const orderService = require("./orderService");

// ─────────────────────────────────────────────────────────────────────────────
//  Resellers (cộng tác viên, CTV) — ArnTo-Shop customers who buy at the CTV
//  price and sell on in their own shops.
//
//    add / remove   on the CTV page or with /ctv-new, /ctv-remove. The shop
//                   gives / takes the CTV role and DMs them the welcome /
//                   farewell text kept here.
//    orders         nothing is stored here: each CTV's orders are read from the
//                   shared `orders` (ArnTo-Shop's). The shop stamps every new
//                   order `reseller: true | false` — did the buyer hold the CTV
//                   role when it was opened. An older order without the stamp
//                   counts when it was opened while they were a CTV.
//
//  CTVs pay order by order, like any buyer; the CTV prices are the owner's own
//  price channel on Discord, not here.
//
//  The shop does everything on Discord (role, DM) from one bus command,
//  "reseller.event". A change made on the page is sent to it; one the shop made
//  through /api/external/resellers comes back in the answer and the shop applies
//  it itself. The shop seeds the list once from the members holding the CTV role
//  (importFrom); the project that did is the owner — the only one whose key may
//  read or change it.
//
//  Storage: data/shared.sqlite (travels with a panel move).
// ─────────────────────────────────────────────────────────────────────────────

const CMD = "reseller.event";
const META = "__reseller.meta"; // { owner, imported, importedAt }
const SETTINGS = "__reseller.settings"; // { welcome, farewell }
const SNOWFLAKE = /^\d{17,20}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TEMPLATE_VARS = ["{user}", "{id}", "{tag}"];
const VN_OFFSET = 7 * 3600_000; // months are Vietnam's (UTC+7)

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const str = (v, max) => String(v ?? "").trim().slice(0, max);

const DEFAULT_WELCOME = [
    "# Chào Mừng Cộng Tác Viên Mới Của ArnTo Shop",
    "Đội ngũ Admin thông báo đến Người dùng {user} ({id}) rằng bạn đã trở thành Cộng Tác Viên (CTV) của ArnTo Shop.",
    "Từ giờ bạn được mua hàng với giá dành riêng cho CTV để bán lại tại shop của mình.",
    "- Bảng giá CTV có trong kênh giá CTV của server.",
    "- Khi mua hàng, bạn mở ticket như bình thường — ticket của CTV sẽ được đánh dấu riêng.",
    "",
    "Mọi thắc mắc xin liên hệ <@427399742906040333> hoặc <@871329074046435338> để được giải đáp.",
    "",
    "#ArnTo Shop - Giàu Vì Bạn, Sang Vì Tôi",
].join("\n");

const DEFAULT_FAREWELL = [
    "# Thông Báo Kết Thúc Cộng Tác Tại ArnTo Shop",
    "Đội ngũ Admin thông báo đến Người dùng {user} ({id}) rằng bạn không còn là Cộng Tác Viên (CTV) của ArnTo Shop.",
    "",
    "Cảm ơn bạn đã đồng hành cùng ArnTo Shop trong thời gian qua. Chúc bạn mọi điều tốt đẹp và thành công trong tương lai!",
    "",
    "#ArnTo Shop - Giàu Vì Bạn, Sang Vì Tôi",
].join("\n");

// ── Storage ──────────────────────────────────────────────────────────────────

let made = null;
const conn = () => {
    const c = sharedStore.raw();
    if (made === c) return c;
    c.exec(`
        CREATE TABLE IF NOT EXISTS resellers (
            user_id TEXT PRIMARY KEY,
            user_tag TEXT,
            shop TEXT NOT NULL DEFAULT '',      -- their own shop: a name or a link
            note TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,  -- 0: removed (kept, with their orders)
            joined_at INTEGER NOT NULL,         -- CTV since (editable: imports guess it)
            left_at INTEGER,
            added_by TEXT,                      -- who added them: a tag, "Panel" or "Import"
            updated_at INTEGER NOT NULL
        );
    `);
    made = c;
    return c;
};

const kvGet = (name) => {
    const r = conn().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => conn().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

const meta = () => ({ owner: null, imported: false, importedAt: null, ...(kvGet(META) || {}) });

/** May this project's key read / change the resellers? The first one to import owns them. */
const canAccess = (botId) => {
    const { owner } = meta();
    return !owner || owner === botId;
};

// ── Settings (the DM texts) ──────────────────────────────────────────────────

const getSettings = () => {
    const s = kvGet(SETTINGS) || {};
    return { welcome: s.welcome || DEFAULT_WELCOME, farewell: s.farewell || DEFAULT_FAREWELL, vars: TEMPLATE_VARS };
};

const setSettings = (input = {}) => {
    const s = kvGet(SETTINGS) || {};
    // Empty = back to the default text.
    if (input.welcome !== undefined) s.welcome = str(input.welcome, 1900) || null;
    if (input.farewell !== undefined) s.farewell = str(input.farewell, 1900) || null;
    kvSet(SETTINGS, s);
    return getSettings();
};

const render = (template, { userId, userTag }) =>
    String(template)
        .replace(/\{user\}/g, `<@${userId}>`)
        .replace(/\{id\}/g, userId)
        .replace(/\{tag\}/g, userTag || userId);

// ── Orders ───────────────────────────────────────────────────────────────────

/** "YYYY-MM" of a timestamp, in Vietnam. */
const monthOf = (ts) => new Date(Number(ts) + VN_OFFSET).toISOString().slice(0, 7);

/** The last `n` months, newest first ("2026-10", "2026-09", …). */
const recentMonths = (n = 12) => {
    const d = new Date(Date.now() + VN_OFFSET);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    }
    return out;
};

const monthArg = (v) => {
    if (v === undefined || v === null || v === "") return monthOf(Date.now());
    if (!MONTH.test(String(v))) throw httpError(400, "month must look like 2026-10");
    return String(v);
};

/** ArnTo-Shop's orders, or null while they are not on the panel. */
const allOrders = () => (orderService.onPanel() ? sharedStore.run("orders", "get") : null);

/**
 * Was `order` bought as a CTV by reseller row `r`? The shop's stamp decides; an
 * order from before the stamp counts when it was opened while they were one.
 */
const boughtAsReseller = (order, r) => {
    if (order.buyerId !== r.user_id) return false;
    if (typeof order.reseller === "boolean") return order.reseller;
    const at = Number(order.orderDate) || 0;
    return at >= r.joined_at && (!r.left_at || at <= r.left_at);
};

const emptyStats = () => ({ orders: 0, revenue: 0, pending: 0 });

const tally = (s, o) => {
    if (o.status === "completed") {
        s.orders++;
        s.revenue += Number(o.price) || 0;
    } else if (o.status === "pending") s.pending++;
};

/** Every reseller's orders, grouped: { [userId]: order[] } (all their CTV orders). */
const ordersByReseller = (rows, orders) => {
    const byId = new Map(rows.map((r) => [r.user_id, r]));
    const out = {};
    for (const o of orders || []) {
        const r = byId.get(o.buyerId);
        if (!r || !boughtAsReseller(o, r)) continue;
        (out[r.user_id] ||= []).push(o);
    }
    return out;
};

/** { month: {orders, revenue, pending}, total: {orders, revenue, pending}, lastOrderAt } */
const statsOf = (orders = [], month) => {
    const s = { month: emptyStats(), total: emptyStats(), lastOrderAt: null };
    for (const o of orders) {
        tally(s.total, o);
        if (monthOf(o.orderDate) === month) tally(s.month, o);
        if (!s.lastOrderAt || o.orderDate > s.lastOrderAt) s.lastOrderAt = o.orderDate || null;
    }
    return s;
};

// ── Reading ──────────────────────────────────────────────────────────────────

const row = (userId) => conn().prepare("SELECT * FROM resellers WHERE user_id = ?").get(String(userId || ""));

const requireRow = (userId, { active = true } = {}) => {
    const r = row(userId);
    if (!r || (active && !r.active)) throw httpError(404, "This user is not a CTV");
    return r;
};

const toReseller = (r, stats) =>
    r && {
        userId: r.user_id,
        userTag: r.user_tag,
        shop: r.shop,
        note: r.note,
        active: !!r.active,
        joinedAt: r.joined_at,
        leftAt: r.left_at,
        addedBy: r.added_by,
        updatedAt: r.updated_at,
        ...(stats ? { stats } : {}),
    };

const rows = ({ all = false } = {}) => conn().prepare(`SELECT * FROM resellers ${all ? "" : "WHERE active = 1"} ORDER BY active DESC, joined_at`).all();

/**
 * The page's list: each CTV with their orders for `month` and in total, the
 * best month first. `stats` is null while the orders are not on the panel.
 */
const list = ({ all = false, month } = {}) => {
    const m = monthArg(month);
    const rs = rows({ all });
    const orders = allOrders();
    const grouped = orders ? ordersByReseller(rs, orders) : {};
    const resellers = rs.map((r) => toReseller(r, orders ? statsOf(grouped[r.user_id], m) : null));
    if (orders) {
        resellers.sort((a, b) => b.active - a.active || b.stats.month.revenue - a.stats.month.revenue || b.stats.total.revenue - a.stats.total.revenue);
    }

    // How much of the month's shop revenue came from CTVs.
    let totals = null;
    if (orders) {
        const month = emptyStats();
        for (const r of resellers) {
            month.orders += r.stats.month.orders;
            month.revenue += r.stats.month.revenue;
            month.pending += r.stats.month.pending;
        }
        const shopRevenue = orders.filter((o) => o.status === "completed" && monthOf(o.orderDate) === m).reduce((s, o) => s + (Number(o.price) || 0), 0);
        totals = { ...month, shopRevenue, buyers: resellers.filter((r) => r.stats.month.orders > 0).length };
    }
    return { month: m, months: recentMonths(), ordersOnPanel: !!orders, totals, resellers };
};

/** The shop's view: no stats. */
const listPlain = ({ all = false } = {}) => rows({ all }).map((r) => toReseller(r));

const get = (userId, { active = false } = {}) => toReseller(requireRow(userId, { active }));

/** CTV orders, newest first — one CTV's or everyone's, for one month or all of them. */
const orders = ({ userId, month, limit = 300 } = {}) => {
    const all = allOrders();
    if (!all) throw httpError(503, "The orders are not on the panel yet — the shop moves them here on its next start (PANEL_SHARED)");
    const m = month === "all" ? null : monthArg(month);
    const rs = userId ? [requireRow(userId, { active: false })] : rows({ all: true });
    const tags = new Map(rs.map((r) => [r.user_id, r.user_tag]));
    const grouped = ordersByReseller(rs, all);
    const n = Math.min(Math.max(Number(limit) || 300, 1), 2000);
    return {
        month: m,
        orders: Object.values(grouped)
            .flat()
            .filter((o) => !m || monthOf(o.orderDate) === m)
            .sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0))
            .slice(0, n)
            .map((o) => ({
                orderId: o.orderId,
                name: o.name,
                price: o.price,
                status: o.status,
                orderDate: o.orderDate,
                sellerId: o.sellerId,
                sellerName: orderService.SELLERS[o.sellerId] || o.sellerId,
                buyerId: o.buyerId,
                buyerTag: tags.get(o.buyerId) || null,
                stamped: typeof o.reseller === "boolean",
            })),
    };
};

// ── Validation ───────────────────────────────────────────────────────────────

const userIdOf = (v) => {
    const id = str(v, 20);
    if (!SNOWFLAKE.test(id)) throw httpError(400, "Invalid Discord user ID");
    return id;
};

const joinedAtOf = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, "Invalid “CTV since” date");
    if (n > Date.now() + 86_400_000) throw httpError(400, "“CTV since” cannot be in the future");
    return n;
};

/** Who did it, for `added_by`: their tag, "Panel" or "Import". */
const byOf = (who = {}) => (who.via === "discord" ? str(who.byTag, 64) || str(who.byId, 20) || "Discord" : who.via === "import" ? "Import" : "Panel");

// ── Events for the shop ──────────────────────────────────────────────────────

/** What the shop does on Discord for a change: the role and the DM. */
const eventOf = (event, r) => ({
    event,
    userId: r.user_id,
    userTag: r.user_tag,
    dm: render(getSettings()[event === "joined" ? "welcome" : "farewell"], { userId: r.user_id, userTag: r.user_tag }),
});

const shop = () => {
    const { owner } = meta();
    if (owner && discordBus.canHandle(owner, CMD)) return owner;
    return discordBus.handlerOf(CMD);
};

/**
 * Send a change made on the page to the shop and wait for its answer (role
 * given? DM sent?) — the page shows it.
 * → { sent: true, result } | { sent: true, queued: true } | { sent: false, error }
 */
const tellShop = async (event) => {
    const target = shop();
    if (!target) return { sent: false, error: `ArnTo-Shop has not announced "${CMD}" — update and restart the bot` };
    if (!discordBus.status().ready) return { sent: false, error: "The panel's Discord bus is not ready" };
    try {
        return { sent: true, result: await discordBus.request(target, CMD, event, { sealed: true, timeoutMs: 20_000 }) };
    } catch (err) {
        if (err.status === 504) return { sent: true, queued: true };
        return { sent: false, error: err.message };
    }
};

/** From the page: apply the change, then the shop's part. From Discord: hand the event back. */
const finish = async (out, who) => {
    if (who?.via === "discord") return out;
    const { event, ...rest } = out;
    return { ...rest, discord: await tellShop(event) };
};

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * A new CTV (or one who was removed, back again). From the page the panel's bot
 * looks the user up; from Discord the shop sends their tag.
 * → { reseller, event } (Discord) | { reseller, discord } (page)
 */
const addReseller = async (input = {}, who = {}) => {
    const userId = userIdOf(input.userId);
    let userTag = str(input.userTag, 64) || null;
    if (!userTag && who.via !== "discord") {
        try {
            userTag = (await discordBus.userTag(userId)) || null;
        } catch (err) {
            if (err.code === 10013) throw httpError(400, "No Discord user has this ID");
        }
    }
    const old = row(userId);
    if (old?.active) throw httpError(409, "This user is already a CTV");
    const shopName = input.shop !== undefined ? str(input.shop, 200) : old?.shop || "";
    const note = input.note !== undefined ? str(input.note, 300) : old?.note || "";
    const now = Date.now();
    const c = conn();
    if (old) {
        c.prepare(
            `UPDATE resellers SET user_tag = COALESCE(?, user_tag), shop = ?, note = ?, active = 1, joined_at = ?, left_at = NULL, added_by = ?, updated_at = ?
             WHERE user_id = ?`,
        ).run(userTag, shopName, note, now, byOf(who), now, userId);
    } else {
        c.prepare(
            `INSERT INTO resellers (user_id, user_tag, shop, note, active, joined_at, added_by, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(userId, userTag, shopName, note, now, byOf(who), now);
    }
    const r = row(userId);
    return finish({ reseller: toReseller(r), event: eventOf("joined", r) }, who);
};

/** Their shop, note, tag or “CTV since”. */
const update = (userId, input = {}) => {
    const r = requireRow(userId, { active: false });
    const shopName = input.shop !== undefined ? str(input.shop, 200) : r.shop;
    const note = input.note !== undefined ? str(input.note, 300) : r.note;
    const userTag = input.userTag !== undefined ? str(input.userTag, 64) || r.user_tag : r.user_tag;
    const joinedAt = input.joinedAt !== undefined ? joinedAtOf(input.joinedAt) : r.joined_at;
    if (r.left_at && joinedAt > r.left_at) throw httpError(400, "“CTV since” must be before they were removed");
    conn()
        .prepare("UPDATE resellers SET user_tag = ?, shop = ?, note = ?, joined_at = ?, updated_at = ? WHERE user_id = ?")
        .run(userTag, shopName, note, joinedAt, Date.now(), r.user_id);
    return get(r.user_id);
};

/** No longer a CTV — kept, with their orders, and can be added again. */
const remove = async (userId, who = {}) => {
    const r = requireRow(userId);
    const now = Date.now();
    conn().prepare("UPDATE resellers SET active = 0, left_at = ?, updated_at = ? WHERE user_id = ?").run(now, now, r.user_id);
    const after = row(r.user_id);
    return finish({ reseller: toReseller(after), event: eventOf("left", after) }, who);
};

/**
 * The shop checks the CTV role against the list: gives it to every active CTV
 * who lacks it, and reports who holds it without being one.
 */
const syncRoles = async () => {
    const userIds = conn().prepare("SELECT user_id FROM resellers WHERE active = 1").pluck().all();
    const out = await tellShop({ event: "sync", userIds });
    if (!out.sent) throw httpError(503, out.error);
    if (out.queued) throw httpError(504, "ArnTo-Shop did not answer in time — try again in a minute");
    return out.result;
};

// ── Import (the members holding the CTV role, once) ─────────────────────────

/**
 * body: { resellers: [{ userId, userTag?, joinedAt? }] } — the members who hold
 * the CTV role when the shop first starts. Nobody is DMed and no role changes.
 * `joinedAt` is the shop's guess (when they joined the server): the page can
 * correct it, and older orders count from it.
 */
const importFrom = (botId, body = {}) => {
    if (!botId) throw httpError(403, "A project API key is required");
    const m = meta();
    if (m.imported) return { imported: false, already: true, owner: m.owner };
    const c = conn();
    let count = 0;
    c.transaction(() => {
        const now = Date.now();
        for (const x of Array.isArray(body.resellers) ? body.resellers : []) {
            const userId = str(x.userId, 20);
            if (!SNOWFLAKE.test(userId) || row(userId)) continue;
            const joinedAt = Number(x.joinedAt) > 0 && Number(x.joinedAt) <= now ? Math.round(Number(x.joinedAt)) : now;
            c.prepare(
                `INSERT INTO resellers (user_id, user_tag, shop, note, active, joined_at, added_by, updated_at)
                 VALUES (?, ?, '', '', 1, ?, 'Import', ?)`,
            ).run(userId, str(x.userTag, 64) || null, joinedAt, now);
            count++;
        }
        kvSet(META, { owner: botId, imported: true, importedAt: now });
    })();
    console.log(`[Reseller] Imported ${count} CTVs from project ${botId}`);
    return { imported: true, resellers: count };
};

// ── Status ───────────────────────────────────────────────────────────────────

/** For the page: who answers on Discord, how many. */
const status = () => {
    const m = meta();
    return {
        owner: m.owner,
        imported: m.imported,
        importedAt: m.importedAt,
        busReady: !!discordBus.status().ready,
        handler: shop(),
        active: conn().prepare("SELECT COUNT(*) FROM resellers WHERE active = 1").pluck().get(),
        ordersOnPanel: orderService.onPanel(),
    };
};

const start = () => {
    conn();
    console.log("[Reseller] Reseller service started");
};

module.exports = {
    CMD,
    TEMPLATE_VARS,
    monthOf,
    canAccess,
    getSettings,
    setSettings,
    list,
    listPlain,
    get,
    orders,
    add: addReseller,
    update,
    remove,
    syncRoles,
    importFrom,
    status,
    start,
};
