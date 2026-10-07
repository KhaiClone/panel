const crypto = require("crypto");
const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");

// ─────────────────────────────────────────────────────────────────────────────
//  Ticket menus — what a customer picks in a new ArnTo-Shop ticket:
//
//    1. a service ("Mua Sắm", "Bảo Hành"…): which category the ticket moves to
//       (its own, or the seller's) and how the seller is pinged;
//    2. a product of that service, or "Khác": the channel's name suffix and
//       the seller to ping.
//
//  Managed on the Ticket Menus page and with /menu on ArnTo-Shop. The shop reads
//  it from /api/external/ticket-menus (cached, with its last copy as a fallback)
//  and is told to re-read it after a change made here (bus "ticketmenu.refresh").
//  The shop seeds it once from its old local menus (importFrom); the project that
//  did is the owner — the only one whose key may read or change it.
//
//  Storage: one JSON document in data/shared.sqlite (kv "__ticketMenu") — a few
//  dozen entries, kept in display order.
// ─────────────────────────────────────────────────────────────────────────────

const KV = "__ticketMenu";
const REFRESH = "ticketmenu.refresh";
const LIMIT = 24; // a select menu takes 25 options; one stays for "Khác"
const SNOWFLAKE = /^\d{17,20}$/;
const SERVICE_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_~]{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI = /^(?=.*[^\x00-\x7f])[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}$/u;

const PING_VARS = ["{seller}", "{staff}", "{owner}", "{product}", "{service}", "{ticket}"];
const defaultPing = () => "{seller} {staff} ơi! có {owner} cần **{service}** - sản phẩm **{product}** nè! Bạn vào đây nhanh nhé!";
const DEFAULT_OTHER = { enabled: true, label: "Khác", description: "Chọn nếu không thấy sản phẩm mình cần", emoji: "", sellerId: "", suffix: "other" };

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Storage ──────────────────────────────────────────────────────────────────

const empty = () => ({ owner: null, imported: false, services: [], products: [], other: { ...DEFAULT_OTHER }, sellers: [], updatedAt: null });

const load = () => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(KV);
    const doc = r?.value ? JSON.parse(r.value) : {};
    return { ...empty(), ...doc, other: { ...DEFAULT_OTHER, ...(doc.other || {}) } };
};

const store = (doc) => {
    doc.updatedAt = Date.now();
    sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(KV, JSON.stringify(doc));
    return doc;
};

/** The shop re-reads its menus — only for a change it did not make itself. */
const tellShop = (doc) => {
    try {
        if (doc.owner && discordBus.canHandle(doc.owner, REFRESH)) {
            Promise.resolve(discordBus.notify(doc.owner, REFRESH, { updatedAt: doc.updatedAt })).catch(() => {});
        }
    } catch {
        /* the shop's cache expires on its own */
    }
};

/** load → fn(doc) → save; `notify: false` when the shop made the change. */
const mutate = (fn, { notify = true } = {}) => {
    const doc = load();
    const out = fn(doc);
    store(doc);
    if (notify) tellShop(doc);
    return out === undefined ? view(doc) : out;
};

// ── Validation ───────────────────────────────────────────────────────────────

const str = (v, max) => String(v ?? "").trim().slice(0, max);

const emojiOf = (v, what) => {
    const e = str(v, 64);
    if (!e || CUSTOM_EMOJI.test(e) || UNICODE_EMOJI.test(e)) return e;
    throw httpError(400, `${what}: "${e}" is not an emoji — use a Unicode emoji or a server emoji like <:name:123…>`);
};
const idOf = (v, what) => {
    const id = str(v, 20);
    if (id && !SNOWFLAKE.test(id)) throw httpError(400, `${what} must be a Discord ID`);
    return id;
};
/** A channel-name part: lower case, spaces → "-" (the move command splits on spaces). */
const suffixOf = (v) =>
    str(v, 60)
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}_-]/gu, "")
        .slice(0, 40);

/** Lenient twins for imported data: a bad value is dropped, not refused. */
const soft = (fn, fallback = "") => {
    try {
        return fn();
    } catch {
        return fallback;
    }
};

const findService = (doc, key) => {
    const s = doc.services.find((x) => x.key === String(key || "").toLowerCase());
    if (!s) throw httpError(404, `No service "${key}"`);
    return s;
};
const findProduct = (doc, id) => {
    const p = doc.products.find((x) => x.id === String(id || ""));
    if (!p) throw httpError(404, "Product not found");
    return p;
};

/** Enabled products a service shows — Discord's select limit applies to these. */
const shownIn = (doc, key) => doc.products.filter((p) => p.enabled && p.services.includes(key));

const checkLimit = (doc, keys) => {
    for (const key of keys) {
        if (shownIn(doc, key).length > LIMIT) {
            const s = doc.services.find((x) => x.key === key);
            throw httpError(409, `"${s?.label || key}" would show more than ${LIMIT} products — Discord menus take 25 options, one is "${doc.other.label}"`);
        }
    }
};

const serviceKeys = (doc, list) => {
    const keys = [...new Set((Array.isArray(list) ? list : String(list || "").split(",")).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
    for (const k of keys) findService(doc, k);
    return keys;
};

const move = (arr, from, to) => {
    const i = Math.max(0, Math.min(arr.length - 1, Math.round(Number(to)) || 0));
    const [x] = arr.splice(from, 1);
    arr.splice(i, 0, x);
};

// ── Reading ──────────────────────────────────────────────────────────────────

const view = (doc = load()) => ({
    owner: doc.owner,
    imported: doc.imported,
    services: doc.services.map((s) => ({ ...s, products: shownIn(doc, s.key).length })),
    products: doc.products,
    other: doc.other,
    sellers: doc.sellers,
    updatedAt: doc.updatedAt,
    limit: LIMIT,
    pingVars: PING_VARS,
});

const get = () => view();

/** May this project's key read / change the menus? The first one to import owns them. */
const canAccess = (botId) => {
    const { owner } = load();
    return !owner || owner === botId;
};

// ── Services ─────────────────────────────────────────────────────────────────

const serviceFields = (input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const label = has("label") ? str(input.label, 100) : current.label;
    if (!label) throw httpError(400, "The service needs a name");
    return {
        label,
        emoji: has("emoji") ? emojiOf(input.emoji, "Emoji") : current.emoji || "",
        description: has("description") ? str(input.description, 100) : current.description || "",
        ping: has("ping") ? str(input.ping, 1500) || defaultPing() : current.ping || defaultPing(),
        category: has("category") ? idOf(input.category, "The category") : current.category || "",
        enabled: has("enabled") ? !!input.enabled : current.enabled ?? true,
    };
};

const createService = (input = {}, opts) =>
    mutate((doc) => {
        const key = str(input.key, 32).toLowerCase();
        if (!SERVICE_KEY.test(key)) throw httpError(400, "The key may only use a-z, 0-9, - and _ (up to 32 characters)");
        if (doc.services.some((s) => s.key === key)) throw httpError(409, `A service already uses the key "${key}"`);
        if (doc.services.filter((s) => s.enabled).length >= 25 && input.enabled !== false) throw httpError(409, "Discord menus take at most 25 services");
        doc.services.push({ key, ...serviceFields(input) });
    }, opts);

const updateService = (key, input = {}, opts) =>
    mutate((doc) => {
        const s = findService(doc, key);
        const next = serviceFields(input, s);
        if (next.enabled && !s.enabled && doc.services.filter((x) => x.enabled).length >= 25) throw httpError(409, "Discord menus take at most 25 services");
        Object.assign(s, next);
    }, opts);

/** The service goes; its products stay, out of that menu. */
const deleteService = (key, opts) =>
    mutate((doc) => {
        const s = findService(doc, key);
        doc.services = doc.services.filter((x) => x !== s);
        for (const p of doc.products) p.services = p.services.filter((k) => k !== s.key);
    }, opts);

const moveService = (key, position, opts) =>
    mutate((doc) => {
        move(doc.services, doc.services.indexOf(findService(doc, key)), position);
    }, opts);

// ── Products ─────────────────────────────────────────────────────────────────

const productFields = (doc, input, current = {}) => {
    const has = (k) => input[k] !== undefined;
    const name = has("name") ? str(input.name, 100) : current.name;
    if (!name) throw httpError(400, "The product needs a name");
    return {
        name,
        description: has("description") ? str(input.description, 100) : current.description || "",
        emoji: has("emoji") ? emojiOf(input.emoji, "Emoji") : current.emoji || "",
        sellerId: has("sellerId") ? idOf(input.sellerId, "The seller") : current.sellerId || "",
        suffix: (has("suffix") ? suffixOf(input.suffix) : current.suffix) || suffixOf(name),
        services: has("services") ? serviceKeys(doc, input.services) : current.services || [],
        enabled: has("enabled") ? !!input.enabled : current.enabled ?? true,
    };
};

const createProduct = (input = {}, opts) =>
    mutate((doc) => {
        const p = { id: crypto.randomBytes(6).toString("hex"), ...productFields(doc, input) };
        doc.products.push(p);
        checkLimit(doc, p.services);
        return p;
    }, opts);

const updateProduct = (id, input = {}, opts) =>
    mutate((doc) => {
        const p = findProduct(doc, id);
        Object.assign(p, productFields(doc, input, p));
        checkLimit(doc, p.services);
        return p;
    }, opts);

const deleteProduct = (id, opts) =>
    mutate((doc) => {
        const p = findProduct(doc, id);
        doc.products = doc.products.filter((x) => x !== p);
    }, opts);

const moveProduct = (id, position, opts) =>
    mutate((doc) => {
        move(doc.products, doc.products.indexOf(findProduct(doc, id)), position);
    }, opts);

// ── "Khác" and sellers ───────────────────────────────────────────────────────

const updateSettings = ({ other, sellers } = {}, opts) =>
    mutate((doc) => {
        if (other) {
            const o = { ...doc.other, ...other };
            doc.other = {
                enabled: !!o.enabled,
                label: str(o.label, 100) || DEFAULT_OTHER.label,
                description: str(o.description, 100),
                emoji: emojiOf(o.emoji, "Emoji"),
                sellerId: idOf(o.sellerId, "The seller"),
                suffix: suffixOf(o.suffix) || DEFAULT_OTHER.suffix,
            };
        }
        if (sellers) {
            if (!Array.isArray(sellers)) throw httpError(400, "sellers must be a list");
            const seen = new Set();
            doc.sellers = sellers.map((s) => {
                const id = idOf(s.id, "A seller");
                if (!id) throw httpError(400, "Every seller needs a Discord ID");
                if (seen.has(id)) throw httpError(400, `Seller ${id} is listed twice`);
                seen.add(id);
                return { id, name: str(s.name, 64) || id, category: idOf(s.category, "A seller's category") };
            });
        }
    }, opts);

// ── Seeding from the shop's old menus ────────────────────────────────────────

/**
 * Once: the shop's built-in services, its old local products (one row per
 * product AND service — merged back into one product here), "Khác" and the
 * sellers with their categories. Services and products already made on the
 * page are kept; the caller becomes the owner.
 * → { imported: bool, services, products } (counts added)
 */
const importFrom = (owner, { services = [], legacyProducts = [], other, sellers = [] } = {}) =>
    mutate(
        (doc) => {
            if (doc.imported) return { imported: false, services: 0, products: 0 };
            if (!doc.owner) doc.owner = owner || null;
            let addedServices = 0;
            for (const s of Array.isArray(services) ? services : []) {
                const key = str(s.key, 32).toLowerCase();
                if (!SERVICE_KEY.test(key) || doc.services.some((x) => x.key === key)) continue;
                doc.services.push({
                    key,
                    label: str(s.label, 100) || key,
                    emoji: soft(() => emojiOf(s.emoji, "")),
                    description: str(s.description, 100),
                    ping: str(s.ping, 1500) || defaultPing(),
                    category: soft(() => idOf(s.category, "")),
                    enabled: s.enabled !== false,
                });
                addedServices++;
            }

            const merged = new Map();
            for (const r of Array.isArray(legacyProducts) ? legacyProducts : []) {
                const name = str(r.name, 100);
                if (!name) continue;
                const fields = {
                    name,
                    description: str(r.description, 100),
                    emoji: soft(() => emojiOf(r.emoji, "")),
                    sellerId: soft(() => idOf(r.sellerId, "")),
                    suffix: suffixOf(r.ticketPrefixName ?? r.suffix) || suffixOf(name),
                };
                const id = JSON.stringify(fields);
                if (!merged.has(id)) merged.set(id, { ...fields, services: [] });
                const key = str(r.type, 32).toLowerCase();
                const p = merged.get(id);
                if (doc.services.some((s) => s.key === key) && !p.services.includes(key)) p.services.push(key);
            }
            for (const p of merged.values()) {
                // Over Discord's limit: kept, but off, rather than breaking the menu.
                const enabled = p.services.every((k) => shownIn(doc, k).length < LIMIT);
                doc.products.push({ id: crypto.randomBytes(6).toString("hex"), ...p, enabled });
            }

            if (other && JSON.stringify(doc.other) === JSON.stringify(DEFAULT_OTHER)) {
                doc.other = {
                    enabled: other.enabled !== false,
                    label: str(other.label, 100) || DEFAULT_OTHER.label,
                    description: str(other.description, 100),
                    emoji: soft(() => emojiOf(other.emoji, "")),
                    sellerId: soft(() => idOf(other.sellerId, "")),
                    suffix: suffixOf(other.suffix) || DEFAULT_OTHER.suffix,
                };
            }
            if (!doc.sellers.length) {
                doc.sellers = (Array.isArray(sellers) ? sellers : [])
                    .filter((s) => SNOWFLAKE.test(String(s.id || "")))
                    .map((s) => ({ id: String(s.id), name: str(s.name, 64) || String(s.id), category: soft(() => idOf(s.category, "")) }));
            }
            doc.imported = true;
            return { imported: true, services: addedServices, products: merged.size };
        },
        { notify: false },
    );

module.exports = {
    KV,
    REFRESH,
    LIMIT,
    get,
    canAccess,
    createService,
    updateService,
    deleteService,
    moveService,
    createProduct,
    updateProduct,
    deleteProduct,
    moveProduct,
    updateSettings,
    importFrom,
};
