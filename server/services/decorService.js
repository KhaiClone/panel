const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");

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
// ─────────────────────────────────────────────────────────────────────────────

const NAMES = ["decors", "importedDecors", "prices", "decorCategories"];
const FRAME_API = () => process.env.DECOR_FRAME_API || "https://khaidevapi.onrender.com";
const PRICE_TYPES = ["login", "gift", "gift-bundle"];

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

// Frame (type 3): Discord's /preview image while it lives, else layers composed by KhaiDevApi.
const frameImageURL = (decor) => {
    if (decor.type !== 3) return decor.staticURL || null;
    if (decor.previewValid !== false && decor.staticURL) return decor.staticURL;
    const f = decor.frame;
    if (!f?.layers?.length) return decor.staticURL || null;
    const enc = f.layers.map((l) => `${l.id},${l.anchor},${l.order}`).join(";");
    return (
        `${FRAME_API()}/discord/frame?sku=${decor.sku_id}` +
        `&iw=${f.inner_width}&ot=${f.overflow_top}&ob=${f.overflow_bottom}&oh=${f.overflow_horizontal}` +
        `&layers=${encodeURIComponent(enc)}`
    );
};

const priceLookup = (pricesRaw) => {
    const priceMap = {};
    for (const p of pricesRaw) priceMap[`${p.type}:${p.original}`] = p.price;
    return {
        getPrice: (type, original) => priceMap[`${type}:${original}`] ?? 0,
        hasPrice: (type, original) => Object.prototype.hasOwnProperty.call(priceMap, `${type}:${original}`),
    };
};

/**
 * GET /api/decors — decors + imported, with selling prices (the public site's
 * shape). `sellingPrices` honours the sale switches (0 = not sold); with
 * `tierPrices`, the Decors page also gets what each way costs from the price
 * table regardless of them, so flipping a switch needs no reload.
 */
const buildDecorList = (decorsRaw, importedDecorsRaw, pricesRaw, { tierPrices = false } = {}) => {
    const allDecors = [...decorsRaw, ...importedDecorsRaw];
    const importedSkuIds = new Set(importedDecorsRaw.map((d) => d.sku_id));
    const decorMap = Object.fromEntries(allDecors.map((d) => [d.sku_id, d]));
    const { getPrice } = priceLookup(pricesRaw);

    return allDecors.map((decor) => {
        const fromImported = importedSkuIds.has(decor.sku_id);
        if (decor.type === 1000) {
            const items = (decor.items || []).map((skuId) => decorMap[skuId]).filter(Boolean);
            let loginWithNitro = 0;
            let loginWithoutNitro = 0;
            let totalGiftPrice = 0;
            for (const item of items) {
                loginWithNitro += getPrice("login", item.prices.withNitro);
                loginWithoutNitro += getPrice("login", item.prices.withoutNitro);
                totalGiftPrice += getPrice("gift", item.prices.withNitro);
            }
            const giftBundle = getPrice("gift-bundle", totalGiftPrice);
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
            ...(decor.type === 3 ? { frameURL: frameImageURL(decor) } : {}),
            sellingPrices: {
                loginWithNitro: sells(decor, "loginWithNitro") ? tier.loginWithNitro : 0,
                loginWithoutNitro: sells(decor, "loginWithoutNitro") ? tier.loginWithoutNitro : 0,
                gift: sells(decor, "gift") ? tier.gift : 0,
            },
            ...(tierPrices ? { tierPrices: tier } : {}),
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
 * switches, or through a bundle that sells that way at the sum of its members.
 */
const buildPriceReport = (decorsRaw, importedRaw, prices) => {
    const decors = [...decorsRaw, ...importedRaw];
    const { getPrice, hasPrice } = priceLookup(prices);
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
        // A bundle sells at the sum of its members' prices: it needs theirs.
        const members = d.type === 1000 ? (d.items || []).map((s) => decorMap[s]) : [d];
        for (const m of members) {
            if (!m?.prices || m.type === 1000) continue;
            if (sells(d, "loginWithNitro")) need(m.prices.withNitro, "login", m);
            if (sells(d, "loginWithoutNitro")) need(m.prices.withoutNitro, "login", m);
            // `gift` is only looked up with the Nitro original.
            if (sells(d, "gift")) need(m.prices.withNitro, "gift", m);
        }
    }

    const bundleTiers = new Map();
    for (const b of decors) {
        if (b.type !== 1000 || !sells(b, "gift")) continue;
        const members = (b.items || []).map((s) => decorMap[s]).filter(Boolean);
        const total = members.reduce((sum, m) => sum + getPrice("gift", m.prices?.withNitro), 0);
        if (!bundleTiers.has(total)) bundleTiers.set(total, { total, giftBundle: priceOf("gift-bundle", total), bundleCount: 0, bundles: [] });
        const t = bundleTiers.get(total);
        t.bundleCount++;
        t.bundles.push(ref(b));
    }

    for (const p of prices) {
        if (p.type === "gift-bundle") {
            if (!bundleTiers.has(p.original)) bundleTiers.set(p.original, { total: p.original, giftBundle: p.price, bundleCount: 0, bundles: [] });
        } else if (!decorTiers.has(p.original)) {
            tier(p.original);
        }
    }

    const byNumber = (key) => (a, b) => a[key] - b[key];
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), "vi");
    for (const t of decorTiers.values()) t.decors.sort(byName);
    for (const t of bundleTiers.values()) t.bundles.sort(byName);
    return {
        types: PRICE_TYPES,
        rows: prices.map(({ type, original, price }) => ({ type, original, price })),
        decorTiers: [...decorTiers.values()].sort(byNumber("original")),
        bundleTiers: [...bundleTiers.values()].sort(byNumber("total")),
    };
};

const listPrices = async () => {
    requirePanel();
    return buildPriceReport(read("decors"), read("importedDecors"), read("prices"));
};

const upsertPrice = async (body = {}) => {
    requirePanel();
    const { type } = body;
    const original = Number(body.original);
    const price = Number(body.price);
    if (!PRICE_TYPES.includes(type)) throw httpError(400, `type phải là một trong: ${PRICE_TYPES.join(", ")}.`);
    if (!Number.isFinite(original) || original < 0) throw httpError(400, "original phải là số không âm.");
    if (!Number.isFinite(price) || price < 0) throw httpError(400, "price phải là số không âm.");
    const existing = read("prices", "findOne", { type, original });
    const row = existing
        ? write("prices", "findOneAndUpdate", { query: { type, original }, data: { price } })
        : write("prices", "create", { data: { type, original, price } });
    return { message: existing ? "Đã cập nhật mốc giá" : "Đã thêm mốc giá", row };
};

const deletePrice = async (type, rawOriginal) => {
    requirePanel();
    const original = Number(rawOriginal);
    if (!PRICE_TYPES.includes(type)) throw httpError(400, "type không hợp lệ.");
    if (!Number.isFinite(original)) throw httpError(400, "original không hợp lệ.");
    const deleted = write("prices", "findOneAndDelete", { query: { type, original } });
    if (!deleted) throw httpError(404, "Không tìm thấy mốc giá này.");
    return { message: "Đã xóa mốc giá", row: deleted };
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
    if (!imported && !read("decors", "findOne", { sku_id: skuId })) throw httpError(404, "Không tìm thấy decor với sku_id này.");
    const patch = salePatch(body);
    if ("category_sku_id" in body) {
        if (!imported) throw httpError(400, "Theme của decor shop lấy từ /decor-load — chỉ đổi được theme của decor đã import.");
        const cat = body.category_sku_id;
        if (cat === null || cat === "") {
            patch.category_sku_id = null;
        } else {
            if (!read("decorCategories", "findOne", { sku_id: String(cat) })) throw httpError(400, `Category "${cat}" không tồn tại.`);
            patch.category_sku_id = String(cat);
        }
    }
    if (Object.keys(patch).length === 0) throw httpError(400, "Không có trường nào để cập nhật.");
    const updated = write(name, "findOneAndUpdate", { query: { sku_id: skuId }, data: patch });
    return { message: "Đã cập nhật decor", decor: updated };
};

/** PATCH the sale switches of many decors at once (a theme, a filter). → { count } */
const updateDecors = async (skuIds, body = {}) => {
    requirePanel();
    const ids = [...new Set((Array.isArray(skuIds) ? skuIds : []).map(String))];
    if (!ids.length) throw httpError(400, "sku_ids phải là mảng sku_id.");
    const patch = salePatch(body);
    if (Object.keys(patch).length === 0) throw httpError(400, "Không có trạng thái bán nào để cập nhật.");
    const importedIds = new Set(read("importedDecors").map((d) => d.sku_id));
    const inImported = ids.filter((id) => importedIds.has(id));
    const inLoaded = ids.filter((id) => !importedIds.has(id));
    let count = 0;
    if (inImported.length) count += write("importedDecors", "updateMany", { query: { sku_id: inImported }, data: patch }).count;
    if (inLoaded.length) count += write("decors", "updateMany", { query: { sku_id: inLoaded }, data: patch }).count;
    return { message: `Đã cập nhật ${count} decor`, count, patch };
};

const deleteDecor = async (skuId) => {
    requirePanel();
    if (!read("importedDecors", "findOne", { sku_id: skuId })) throw httpError(404, "Không tìm thấy decor đã import với sku_id này.");
    write("importedDecors", "findOneAndDelete", { query: { sku_id: skuId } });
    return { message: `Đã xóa decor "${skuId}" khỏi importedDecors.` };
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
    onPanel,
    buildDecorList,
    buildPriceReport,
    sortCategories,
    listDecors,
    listCategories,
    listPrices,
    upsertPrice,
    deletePrice,
    updateDecor,
    updateDecors,
    deleteDecor,
    previewDecor,
    importDecor,
};
