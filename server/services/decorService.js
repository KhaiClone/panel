const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  Decors for the panel's Decors page.
//
//  The data (decors, importedDecors, prices, decorCategories) is shared data
//  owned by ArnTo-assistant (services/sharedStore.js): everything here reads
//  and writes the panel's own copy. The panel never calls the assistant.
//
//  Resolving a decor from a Discord link needs the assistant's Discord shop
//  session, so preview / import are asked of the assistant over the Discord bus.
//  The price arithmetic below is the assistant's decors.controller.js, verbatim
//  in behaviour: the Decors page must not see a difference.
//
//  Sale switches: every decor and bundle, loaded or imported, may stop selling
//  one way — a flag on its record, absent = for sale. A switched-off way sells
//  for 0 here (what the decor site and the snapshot show), and the assistant's
//  /decor-find says it is not sold; /decor-load carries the flags over when it
//  rewrites `decors`.
//
//  Bundle gift prices (`gift-bundle-set` rows) are looked up by what is IN the
//  bundle: each member's Discord (Nitro) price and how many of each, as the key
//  "66000x2" or "66000x1+99000x1" (see bundleSetKey). Until 2026-10-21 they
//  were looked up by the sum of the members' gift SELLING prices (`gift-bundle`
//  rows), so changing one decor's gift price moved every bundle holding it to
//  another sum — one with no price. The old rows are moved once
//  (migrateBundleSets); compositions that had different old prices are left
//  for the owner to set. The assistant's /decor-find builds the same key.
//
//  Reseller prices: a `gift` / `gift-bundle-set` row may carry `resellerPrice`,
//  what an active CTV pays for a Deco Gift (ArnTo-Auto, or an order made on the
//  panel) — empty = the regular price. Only the Deco Gift catalog reads it: the
//  public decor site never sees it. The assistant reads `price` only.
// ─────────────────────────────────────────────────────────────────────────────

const NAMES = ["decors", "importedDecors", "prices", "decorCategories"];
const BUNDLE_SET = "gift-bundle-set";
const LEGACY_BUNDLE = "gift-bundle"; // keyed by the old sum: read only to move it, then removable
const PRICE_TYPES = ["login", "gift", BUNDLE_SET];
const RESELLER_TYPES = ["gift", BUNDLE_SET]; // the auto (Deco Gift) ones
const MIGRATION = "__decor.bundleSets"; // { at, moved, conflicts } once the old bundle rows were moved

/** Way of selling → the record flag that switches it off. `gift` is the bundle's gift-bundle too. */
const SALE_FLAGS = { loginWithNitro: "noLoginWithNitro", loginWithoutNitro: "noLoginWithoutNitro", gift: "noGift" };
const sells = (decor, way) => !decor?.[SALE_FLAGS[way]];

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Shared once every decor name is active in the store. */
const onPanel = () => NAMES.every((n) => sharedStore.nameRow(n)?.state === "active");
const requirePanel = () => {
    if (!onPanel()) throw httpError(503, "The decor data is not on the panel yet — the assistant moves it here on its next start (PANEL_SHARED)");
};
const owner = () => sharedStore.nameRow("importedDecors")?.owner || null;
const read = (name, op = "get", query) => sharedStore.run(name, op, { query });
const write = (name, op, args) => sharedStore.run(name, op, args);
const kvGet = (name) => {
    const r = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name);
    return r ? JSON.parse(r.value) : null;
};
const kvSet = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));

// ── Bundle compositions ──────────────────────────────────────────────────────

const SET_KEY = /^\d+x[1-9]\d*(\+\d+x[1-9]\d*)*$/;

/** { original → count } → "66000x1+99000x2", the cheapest member first. */
const keyOf = (counts) =>
    [...counts]
        .sort((a, b) => a[0] - b[0])
        .map(([original, count]) => `${original}x${count}`)
        .join("+");

/**
 * A bundle's members → its composition key: each member's Discord Nitro price
 * and how many of each ("66000x2"). null when no member has a price.
 */
const bundleSetKey = (members) => {
    const counts = new Map();
    for (const m of members) {
        const original = m && m.type !== 1000 ? m.prices?.withNitro : undefined;
        if (!Number.isFinite(original)) continue;
        counts.set(original, (counts.get(original) || 0) + 1);
    }
    return counts.size ? keyOf(counts) : null;
};

/** "66000x1+99000x2" → [{ original: 66000, count: 1 }, …]; null if it is not a key. */
const parseSetKey = (key) =>
    SET_KEY.test(String(key ?? ""))
        ? String(key)
              .split("+")
              .map((part) => {
                  const [original, count] = part.split("x").map(Number);
                  return { original, count };
              })
        : null;

/** A key in any order or with repeats ("99000x1+66000x1") → its one spelling, or null. */
const canonicalSetKey = (key) => {
    const parts = parseSetKey(key);
    if (!parts) return null;
    const counts = new Map();
    for (const { original, count } of parts) counts.set(original, (counts.get(original) || 0) + count);
    return keyOf(counts);
};

/** A request's `original` for `type`: a composition key for bundles, a number otherwise. */
const originalArg = (type, raw) => {
    if (type === BUNDLE_SET) {
        const key = canonicalSetKey(raw);
        if (!key) throw httpError(400, "original must be a bundle composition like 66000x2 or 66000x1+99000x1.");
        return key;
    }
    const original = Number(raw);
    if (!Number.isFinite(original) || original < 0) throw httpError(400, "original must be a non-negative number.");
    return original;
};

/** A row's reseller price: a number above 0, else null (not set). */
const resellerOf = (row) => (Number.isFinite(row?.resellerPrice) && row.resellerPrice > 0 ? row.resellerPrice : null);

const priceLookup = (pricesRaw) => {
    const priceMap = {};
    const resellerMap = {};
    for (const p of pricesRaw) {
        priceMap[`${p.type}:${p.original}`] = p.price;
        resellerMap[`${p.type}:${p.original}`] = resellerOf(p);
    }
    return {
        getPrice: (type, original) => priceMap[`${type}:${original}`] ?? 0,
        hasPrice: (type, original) => Object.prototype.hasOwnProperty.call(priceMap, `${type}:${original}`),
        getResellerPrice: (type, original) => resellerMap[`${type}:${original}`] ?? null,
    };
};

/**
 * GET /api/decors — decors + imported, with selling prices (the public site's
 * shape). `sellingPrices` honours the sale switches (0 = not sold); with
 * `tierPrices`, the Decors page also gets what each way costs from the price
 * table regardless of them, so flipping a switch needs no reload. With
 * `reseller` (the Deco Gift catalog only), `resellerGift` is the gift's — or
 * the bundle composition's — reseller price, null when not set or not sold.
 * A bundle's login prices add up its members'; its gift price is its
 * composition's (bundleSetKey), never its members' gift prices.
 */
const buildDecorList = (decorsRaw, importedDecorsRaw, pricesRaw, { tierPrices = false, reseller = false } = {}) => {
    const allDecors = [...decorsRaw, ...importedDecorsRaw];
    const importedSkuIds = new Set(importedDecorsRaw.map((d) => d.sku_id));
    const decorMap = Object.fromEntries(allDecors.map((d) => [d.sku_id, d]));
    const { getPrice, getResellerPrice } = priceLookup(pricesRaw);

    return allDecors.map((decor) => {
        const fromImported = importedSkuIds.has(decor.sku_id);
        if (decor.type === 1000) {
            const items = (decor.items || []).map((skuId) => decorMap[skuId]).filter(Boolean);
            let loginWithNitro = 0;
            let loginWithoutNitro = 0;
            for (const item of items) {
                loginWithNitro += getPrice("login", item.prices.withNitro);
                loginWithoutNitro += getPrice("login", item.prices.withoutNitro);
            }
            const setKey = bundleSetKey(items);
            const giftBundle = setKey ? getPrice(BUNDLE_SET, setKey) : 0;
            const tier = { loginWithNitro, loginWithoutNitro, giftBundle };
            return {
                ...decor,
                decorFrom: fromImported ? "importedDecors" : "decors",
                sellingPrices: {
                    loginWithNitro: sells(decor, "loginWithNitro") ? loginWithNitro : 0,
                    loginWithoutNitro: sells(decor, "loginWithoutNitro") ? loginWithoutNitro : 0,
                    giftBundle: sells(decor, "gift") ? giftBundle : 0,
                },
                ...(tierPrices ? { tierPrices: tier } : {}),
                ...(reseller ? { resellerGift: sells(decor, "gift") && giftBundle > 0 ? getResellerPrice(BUNDLE_SET, setKey) : null } : {}),
                items,
            };
        }
        const tier = {
            loginWithNitro: getPrice("login", decor.prices.withNitro),
            loginWithoutNitro: getPrice("login", decor.prices.withoutNitro),
            gift: getPrice("gift", decor.prices.withNitro),
        };
        return {
            ...decor,
            decorFrom: fromImported ? "importedDecors" : "decors",
            sellingPrices: {
                loginWithNitro: sells(decor, "loginWithNitro") ? tier.loginWithNitro : 0,
                loginWithoutNitro: sells(decor, "loginWithoutNitro") ? tier.loginWithoutNitro : 0,
                gift: sells(decor, "gift") ? tier.gift : 0,
            },
            ...(tierPrices ? { tierPrices: tier } : {}),
            ...(reseller ? { resellerGift: sells(decor, "gift") && tier.gift > 0 ? getResellerPrice("gift", decor.prices.withNitro) : null } : {}),
        };
    });
};

const sortCategories = (cats) => [...cats].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

const listDecors = async (opts) => {
    requirePanel();
    return buildDecorList(read("decors"), read("importedDecors"), read("prices"), opts);
};

const listCategories = async () => {
    requirePanel();
    return sortCategories(read("decorCategories"));
};

/**
 * Price tiers and every decor / bundle using each (the assistant's listPrices).
 * A tier is needed only by the ways actually sold: `loginCount` / `giftCount`
 * count the decors that need its login / gift price — through their own
 * switches, or (login only) through a bundle that sells login at the sum of its
 * members. A bundle's gift needs its composition's row (`bundleTiers`), not its
 * members' gift prices. `legacyBundleTiers`: the old sum-keyed rows, unused.
 */
const buildPriceReport = (decorsRaw, importedRaw, prices) => {
    const decors = [...decorsRaw, ...importedRaw];
    const { getPrice, hasPrice, getResellerPrice } = priceLookup(prices);
    const priceOf = (type, original) => (hasPrice(type, original) ? getPrice(type, original) : null);
    const ref = (d) => ({ sku_id: d.sku_id, name: d.name, type: d.type });

    const decorTiers = new Map();
    const users = new Map(); // original → { login, gift, any } sets of sku_id
    const tier = (original) => {
        if (!decorTiers.has(original)) {
            decorTiers.set(original, {
                original,
                login: priceOf("login", original),
                gift: priceOf("gift", original),
                giftReseller: getResellerPrice("gift", original),
                decorCount: 0,
                loginCount: 0,
                giftCount: 0,
                decors: [],
            });
            users.set(original, { login: new Set(), gift: new Set(), any: new Set() });
        }
        return decorTiers.get(original);
    };
    /** Decor `d` needs the `kind` price ("login" | "gift") of tier `original`. */
    const need = (original, kind, d) => {
        if (typeof original !== "number") return;
        const t = tier(original);
        const u = users.get(original);
        if (!u[kind].has(d.sku_id)) {
            u[kind].add(d.sku_id);
            t[kind === "login" ? "loginCount" : "giftCount"]++;
        }
        if (!u.any.has(d.sku_id)) {
            u.any.add(d.sku_id);
            t.decorCount++;
            t.decors.push(ref(d));
        }
    };
    const decorMap = Object.fromEntries(decors.map((d) => [d.sku_id, d]));
    for (const d of decors) {
        // A bundle sells login at the sum of its members' login prices: it needs theirs.
        const members = d.type === 1000 ? (d.items || []).map((s) => decorMap[s]) : [d];
        for (const m of members) {
            if (!m?.prices || m.type === 1000) continue;
            if (sells(d, "loginWithNitro")) need(m.prices.withNitro, "login", m);
            if (sells(d, "loginWithoutNitro")) need(m.prices.withoutNitro, "login", m);
            // `gift` is only looked up with the Nitro original — and only for
            // the decor itself: a bundle's gift is its composition's price.
            if (d.type !== 1000 && sells(d, "gift")) need(m.prices.withNitro, "gift", m);
        }
    }

    const bundleTiers = new Map();
    const bundleTier = (key) => {
        if (!bundleTiers.has(key)) {
            const members = parseSetKey(key) || [];
            bundleTiers.set(key, {
                key,
                members,
                memberCount: members.reduce((n, m) => n + m.count, 0),
                giftBundle: priceOf(BUNDLE_SET, key),
                giftBundleReseller: getResellerPrice(BUNDLE_SET, key),
                bundleCount: 0,
                bundles: [],
            });
        }
        return bundleTiers.get(key);
    };
    for (const b of decors) {
        if (b.type !== 1000 || !sells(b, "gift")) continue;
        const key = bundleSetKey((b.items || []).map((s) => decorMap[s]).filter(Boolean));
        if (!key) continue;
        const t = bundleTier(key);
        t.bundleCount++;
        t.bundles.push(ref(b));
    }

    const legacyBundleTiers = [];
    for (const p of prices) {
        if (p.type === BUNDLE_SET) {
            if (parseSetKey(p.original)) bundleTier(p.original);
        } else if (p.type === LEGACY_BUNDLE) {
            legacyBundleTiers.push({ total: p.original, price: p.price, resellerPrice: resellerOf(p) });
        } else if (!decorTiers.has(p.original)) {
            tier(p.original);
        }
    }

    const byNumber = (key) => (a, b) => a[key] - b[key];
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), "vi");
    const discordTotal = (t) => t.members.reduce((s, m) => s + m.original * m.count, 0);
    for (const t of decorTiers.values()) t.decors.sort(byName);
    for (const t of bundleTiers.values()) t.bundles.sort(byName);
    return {
        types: PRICE_TYPES,
        rows: prices.map((p) => ({ type: p.type, original: p.original, price: p.price, resellerPrice: resellerOf(p) })),
        decorTiers: [...decorTiers.values()].sort(byNumber("original")),
        // Fewest decors first, then the cheapest.
        bundleTiers: [...bundleTiers.values()].sort((a, b) => a.memberCount - b.memberCount || discordTotal(a) - discordTotal(b) || a.key.localeCompare(b.key)),
        legacyBundleTiers: legacyBundleTiers.sort(byNumber("total")),
    };
};

/**
 * The price report, plus how the old bundle rows were moved: `migration`
 * { at, moved, conflicts } — only the conflicts whose composition still has no
 * price (setting one in the table settles it).
 */
const listPrices = async () => {
    requirePanel();
    const prices = read("prices");
    const report = buildPriceReport(read("decors"), read("importedDecors"), prices);
    const m = kvGet(MIGRATION);
    const priced = new Set(prices.filter((p) => p.type === BUNDLE_SET).map((p) => p.original));
    return { ...report, migration: m && { ...m, conflicts: (m.conflicts || []).filter((c) => !priced.has(c.key)) } };
};

const upsertPrice = async (body = {}) => {
    requirePanel();
    const { type } = body;
    if (!PRICE_TYPES.includes(type)) throw httpError(400, `type must be one of: ${PRICE_TYPES.join(", ")}.`);
    const original = originalArg(type, body.original);
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) throw httpError(400, "price must be a non-negative number.");
    const existing = read("prices", "findOne", { type, original });
    const row = existing
        ? write("prices", "findOneAndUpdate", { query: { type, original }, data: { price } })
        : write("prices", "create", { data: { type, original, price } });
    return { message: existing ? "Price tier updated" : "Price tier added", row };
};

/**
 * The reseller price of an existing gift / gift-bundle-set tier { type,
 * original, resellerPrice } — empty / null clears it (CTVs pay the regular price).
 */
const setResellerPrice = async (body = {}) => {
    requirePanel();
    const { type } = body;
    if (!RESELLER_TYPES.includes(type)) throw httpError(400, `Reseller prices are for ${RESELLER_TYPES.join(" and ")} tiers only.`);
    const original = originalArg(type, body.original);
    let resellerPrice = null;
    if (body.resellerPrice !== null && body.resellerPrice !== undefined && body.resellerPrice !== "") {
        resellerPrice = Math.round(Number(body.resellerPrice));
        if (!Number.isFinite(resellerPrice) || resellerPrice <= 0) throw httpError(400, "The reseller price must be above 0 — leave it empty for the regular price.");
    }
    if (!read("prices", "findOne", { type, original })) throw httpError(404, "Set the regular price of this tier first.");
    const row = write("prices", "findOneAndUpdate", { query: { type, original }, data: { resellerPrice } });
    return { message: resellerPrice ? "Reseller price saved" : "Reseller price removed", row };
};

const deletePrice = async (type, rawOriginal) => {
    requirePanel();
    if (!PRICE_TYPES.includes(type) && type !== LEGACY_BUNDLE) throw httpError(400, "Invalid type.");
    const original = originalArg(type, rawOriginal);
    const deleted = write("prices", "findOneAndDelete", { query: { type, original } });
    if (!deleted) throw httpError(404, "Price tier not found.");
    return { message: "Price tier deleted", row: deleted };
};

/**
 * Remove every old sum-keyed bundle row at once — the owner's button, after
 * ArnTo-assistant reads the compositions too (its old /decor-find reads these).
 */
const deleteLegacyBundlePrices = async () => {
    requirePanel();
    const rows = read("prices", "find", { type: LEGACY_BUNDLE });
    for (const r of rows) write("prices", "findOneAndDelete", { query: { type: LEGACY_BUNDLE, original: r.original } });
    return { message: `${rows.length} old bundle tier(s) removed`, removed: rows.length };
};

// ── Moving the old bundle rows ───────────────────────────────────────────────

let migrating = false;

/**
 * Once: each bundle's price under the old key (the sum of its members' gift
 * prices, as it is charged today) goes to its composition's row. Bundles of one
 * composition with different old prices are a conflict: nothing is written for
 * it and the Price tiers tab lists the old prices for the owner to pick. A
 * composition that already has a row is left alone. The old rows stay until
 * the owner removes them. → { at, moved, conflicts } | null (not yet: no data)
 */
const migrateBundleSets = () => {
    if (migrating || !onPanel() || kvGet(MIGRATION)) return null;
    migrating = true;
    try {
        const decors = [...read("decors"), ...read("importedDecors")];
        const prices = read("prices");
        const decorMap = Object.fromEntries(decors.map((d) => [d.sku_id, d]));
        const { getPrice } = priceLookup(prices);
        const oldRows = new Map(prices.filter((p) => p.type === LEGACY_BUNDLE).map((p) => [p.original, p]));
        const priced = new Set(prices.filter((p) => p.type === BUNDLE_SET).map((p) => p.original));

        const found = new Map(); // key → Map("price/reseller" → { price, resellerPrice, bundles })
        for (const b of decors) {
            if (b.type !== 1000) continue;
            const members = (b.items || []).map((s) => decorMap[s]).filter(Boolean);
            const key = bundleSetKey(members);
            if (!key || priced.has(key)) continue;
            const total = members.reduce((sum, m) => sum + getPrice("gift", m.prices?.withNitro), 0);
            const row = oldRows.get(total);
            if (!row) continue;
            const value = { price: row.price, resellerPrice: resellerOf(row) };
            const values = found.get(key) || new Map();
            const id = `${value.price}/${value.resellerPrice}`;
            if (!values.has(id)) values.set(id, { ...value, bundles: [] });
            values.get(id).bundles.push(b.name);
            found.set(key, values);
        }

        let moved = 0;
        const conflicts = [];
        for (const [key, values] of found) {
            const options = [...values.values()];
            if (options.length > 1) {
                conflicts.push({ key, options });
                continue;
            }
            const { price, resellerPrice } = options[0];
            write("prices", "create", { data: { type: BUNDLE_SET, original: key, price, ...(resellerPrice ? { resellerPrice } : {}) } });
            moved++;
        }
        const result = { at: Date.now(), moved, conflicts };
        kvSet(MIGRATION, result);
        console.log(`[Decors] Bundle gift prices now go by composition: ${moved} moved, ${conflicts.length} to set by hand`);
        return result;
    } finally {
        migrating = false;
    }
};

/** Move the old bundle rows now, or as soon as the decor data is on the panel. */
const start = () => {
    const attempt = lifecycle.guard(() => {
        try {
            migrateBundleSets();
        } catch (err) {
            console.error(`[Decors] Moving the bundle gift prices failed: ${err.message}`);
        }
    });
    attempt();
    sharedStore.events.on("change", (name) => {
        if (NAMES.includes(name) && !migrating && !kvGet(MIGRATION)) attempt();
    });
};

/** The sale switches in a request body → { noLoginWithNitro, … } booleans; {} if none. */
const salePatch = (body = {}) => {
    const patch = {};
    for (const flag of Object.values(SALE_FLAGS)) if (flag in body) patch[flag] = !!body[flag];
    return patch;
};

/**
 * PATCH one decor or bundle, loaded or imported: the sale switches, and for an
 * imported one its theme (a loaded decor's theme comes from /decor-load).
 */
const updateDecor = async (skuId, body = {}) => {
    requirePanel();
    const imported = read("importedDecors", "findOne", { sku_id: skuId });
    const name = imported ? "importedDecors" : "decors";
    if (!imported && !read("decors", "findOne", { sku_id: skuId })) throw httpError(404, "No decor with this sku_id.");
    const patch = salePatch(body);
    if ("category_sku_id" in body) {
        if (!imported) throw httpError(400, "Shop decor take their theme from /decor-load — only imported decor can change theme.");
        const cat = body.category_sku_id;
        if (cat === null || cat === "") {
            patch.category_sku_id = null;
        } else {
            if (!read("decorCategories", "findOne", { sku_id: String(cat) })) throw httpError(400, `Category "${cat}" does not exist.`);
            patch.category_sku_id = String(cat);
        }
    }
    if (Object.keys(patch).length === 0) throw httpError(400, "Nothing to update.");
    const updated = write(name, "findOneAndUpdate", { query: { sku_id: skuId }, data: patch });
    return { message: "Decor updated", decor: updated };
};

/** PATCH the sale switches of many decors at once (a theme, a filter). → { count } */
const updateDecors = async (skuIds, body = {}) => {
    requirePanel();
    const ids = [...new Set((Array.isArray(skuIds) ? skuIds : []).map(String))];
    if (!ids.length) throw httpError(400, "sku_ids must be an array of sku_id.");
    const patch = salePatch(body);
    if (Object.keys(patch).length === 0) throw httpError(400, "No sale status to update.");
    const importedIds = new Set(read("importedDecors").map((d) => d.sku_id));
    const inImported = ids.filter((id) => importedIds.has(id));
    const inLoaded = ids.filter((id) => !importedIds.has(id));
    let count = 0;
    if (inImported.length) count += write("importedDecors", "updateMany", { query: { sku_id: inImported }, data: patch }).count;
    if (inLoaded.length) count += write("decors", "updateMany", { query: { sku_id: inLoaded }, data: patch }).count;
    return { message: `Updated ${count} decor`, count, patch };
};

const deleteDecor = async (skuId) => {
    requirePanel();
    if (!read("importedDecors", "findOne", { sku_id: skuId })) throw httpError(404, "No imported decor with this sku_id.");
    write("importedDecors", "findOneAndDelete", { query: { sku_id: skuId } });
    return { message: `Removed decor "${skuId}" from importedDecors.` };
};

// Resolving needs the assistant (its Discord shop session): ask it on the bus.
const previewDecor = async (fields) => {
    requirePanel();
    return discordBus.request(owner(), "decor.preview", fields, { timeoutMs: 45_000 });
};

const importDecor = async (fields) => {
    requirePanel();
    return discordBus.request(owner(), "decor.import", fields, { timeoutMs: 60_000 });
};

module.exports = {
    NAMES,
    SALE_FLAGS,
    BUNDLE_SET,
    onPanel,
    bundleSetKey,
    canonicalSetKey,
    buildDecorList,
    buildPriceReport,
    sortCategories,
    listDecors,
    listCategories,
    listPrices,
    upsertPrice,
    setResellerPrice,
    deletePrice,
    deleteLegacyBundlePrices,
    migrateBundleSets,
    start,
    updateDecor,
    updateDecors,
    deleteDecor,
    previewDecor,
    importDecor,
};
