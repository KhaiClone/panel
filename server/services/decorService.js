const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const assistantService = require("./assistantService");

// ─────────────────────────────────────────────────────────────────────────────
//  Decors for the panel's Decors page.
//
//  The data (decors, importedDecors, prices, decorCategories) is shared data
//  owned by ArnTo-assistant (services/sharedStore.js). Once the assistant has
//  adopted it, everything here reads and writes the panel's own copy; before
//  that, it still asks the assistant's HTTP API (assistantService) — so the
//  panel can be deployed first and switches by itself.
//
//  Resolving a decor from a Discord link needs the assistant's Discord shop
//  session, so preview / import are asked of the assistant over the Discord bus.
//  The price arithmetic below is the assistant's decors.controller.js, verbatim
//  in behaviour: the Decors page must not see a difference.
// ─────────────────────────────────────────────────────────────────────────────

const NAMES = ["decors", "importedDecors", "prices", "decorCategories"];
const FRAME_API = () => process.env.DECOR_FRAME_API || "https://khaidevapi.onrender.com";
const PRICE_TYPES = ["login", "gift", "gift-bundle"];

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Shared once every decor name is active in the store. */
const onPanel = () => NAMES.every((n) => sharedStore.nameRow(n)?.state === "active");
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

/** GET /api/decors — decors + imported, with selling prices (the public site's shape). */
const buildDecorList = (decorsRaw, importedDecorsRaw, pricesRaw) => {
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
            const giftBundle = decor.noGift ? 0 : getPrice("gift-bundle", totalGiftPrice);
            return {
                ...decor,
                decorFrom: fromImported ? "importedDecors" : "decors",
                sellingPrices: { loginWithNitro, loginWithoutNitro, giftBundle },
                items,
            };
        }
        return {
            ...decor,
            decorFrom: fromImported ? "importedDecors" : "decors",
            ...(decor.type === 3 ? { frameURL: frameImageURL(decor) } : {}),
            sellingPrices: {
                loginWithNitro: getPrice("login", decor.prices.withNitro),
                loginWithoutNitro: getPrice("login", decor.prices.withoutNitro),
                gift: decor.noGift ? 0 : getPrice("gift", decor.prices.withNitro),
            },
        };
    });
};

const sortCategories = (cats) => [...cats].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

const listDecors = async () => {
    if (!onPanel()) return assistantService.listDecors();
    return buildDecorList(read("decors"), read("importedDecors"), read("prices"));
};

const listCategories = async () => {
    if (!onPanel()) return assistantService.listCategories();
    return sortCategories(read("decorCategories"));
};

/** Price tiers and how many decors use each (the assistant's listPrices). */
const buildPriceReport = (decorsRaw, importedRaw, prices) => {
    const decors = [...decorsRaw, ...importedRaw];
    const { getPrice, hasPrice } = priceLookup(prices);
    const priceOf = (type, original) => (hasPrice(type, original) ? getPrice(type, original) : null);

    const decorTiers = new Map();
    const tier = (original) => {
        if (!decorTiers.has(original)) {
            decorTiers.set(original, { original, login: priceOf("login", original), gift: priceOf("gift", original), decorCount: 0, samples: [] });
        }
        return decorTiers.get(original);
    };
    for (const d of decors) {
        if (d.type === 1000 || !d.prices) continue;
        for (const original of new Set([d.prices.withNitro, d.prices.withoutNitro])) {
            if (typeof original !== "number") continue;
            const t = tier(original);
            t.decorCount++;
            if (t.samples.length < 3) t.samples.push(d.name);
        }
    }

    const decorMap = Object.fromEntries(decors.map((d) => [d.sku_id, d]));
    const bundleTiers = new Map();
    for (const b of decors) {
        if (b.type !== 1000) continue;
        const members = (b.items || []).map((s) => decorMap[s]).filter(Boolean);
        const total = members.reduce((sum, m) => sum + getPrice("gift", m.prices?.withNitro), 0);
        if (!bundleTiers.has(total)) bundleTiers.set(total, { total, giftBundle: priceOf("gift-bundle", total), bundleCount: 0, samples: [] });
        const t = bundleTiers.get(total);
        t.bundleCount++;
        if (t.samples.length < 3) t.samples.push(b.name);
    }

    for (const p of prices) {
        if (p.type === "gift-bundle") {
            if (!bundleTiers.has(p.original)) bundleTiers.set(p.original, { total: p.original, giftBundle: p.price, bundleCount: 0, samples: [] });
        } else if (!decorTiers.has(p.original)) {
            tier(p.original);
        }
    }

    const byNumber = (key) => (a, b) => a[key] - b[key];
    return {
        types: PRICE_TYPES,
        rows: prices.map(({ type, original, price }) => ({ type, original, price })),
        decorTiers: [...decorTiers.values()].sort(byNumber("original")),
        bundleTiers: [...bundleTiers.values()].sort(byNumber("total")),
    };
};

const listPrices = async () => {
    if (!onPanel()) return assistantService.listPrices();
    return buildPriceReport(read("decors"), read("importedDecors"), read("prices"));
};

const upsertPrice = async (body = {}) => {
    if (!onPanel()) return assistantService.upsertPrice(body);
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
    if (!onPanel()) return assistantService.deletePrice(type, rawOriginal);
    const original = Number(rawOriginal);
    if (!PRICE_TYPES.includes(type)) throw httpError(400, "type không hợp lệ.");
    if (!Number.isFinite(original)) throw httpError(400, "original không hợp lệ.");
    const deleted = write("prices", "findOneAndDelete", { query: { type, original } });
    if (!deleted) throw httpError(404, "Không tìm thấy mốc giá này.");
    return { message: "Đã xóa mốc giá", row: deleted };
};

const updateDecor = async (skuId, body = {}) => {
    if (!onPanel()) return assistantService.updateDecor(skuId, body);
    const existing = read("importedDecors", "findOne", { sku_id: skuId });
    if (!existing) throw httpError(404, "Không tìm thấy decor đã import với sku_id này.");
    const patch = {};
    if ("category_sku_id" in body) {
        const cat = body.category_sku_id;
        if (cat === null || cat === "") {
            patch.category_sku_id = null;
        } else {
            if (!read("decorCategories", "findOne", { sku_id: String(cat) })) throw httpError(400, `Category "${cat}" không tồn tại.`);
            patch.category_sku_id = String(cat);
        }
    }
    if ("noGift" in body) patch.noGift = !!body.noGift;
    if (Object.keys(patch).length === 0) throw httpError(400, "Không có trường nào để cập nhật.");
    const updated = write("importedDecors", "findOneAndUpdate", { query: { sku_id: skuId }, data: patch });
    return { message: "Đã cập nhật decor", decor: updated };
};

const deleteDecor = async (skuId) => {
    if (!onPanel()) return assistantService.deleteDecor(skuId);
    if (!read("importedDecors", "findOne", { sku_id: skuId })) throw httpError(404, "Không tìm thấy decor đã import với sku_id này.");
    write("importedDecors", "findOneAndDelete", { query: { sku_id: skuId } });
    return { message: `Đã xóa decor "${skuId}" khỏi importedDecors.` };
};

// Resolving needs the assistant (its Discord shop session): ask it on the bus.
const previewDecor = async (fields) => {
    if (!onPanel()) return assistantService.previewDecor(fields);
    return discordBus.request(owner(), "decor.preview", fields, { timeoutMs: 45_000 });
};

const importDecor = async (fields) => {
    if (!onPanel()) return assistantService.importDecor(fields);
    return discordBus.request(owner(), "decor.import", fields, { timeoutMs: 60_000 });
};

module.exports = {
    NAMES,
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
    deleteDecor,
    previewDecor,
    importDecor,
};
