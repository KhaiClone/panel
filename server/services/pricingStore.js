/**
 * pricingStore.js
 * Bảng giá của các hệ thống auto, chỉnh được từ trang /pricing thay vì phải sửa
 * .env rồi restart bot.
 *
 * Hai thứ tách rời nhau ở đây, cố ý:
 *
 *   CATALOG  — thông số do Discord quy định (badge id, tên tier, ngưỡng, độ hiếm).
 *              Nằm cứng trong code, UI không sửa được. Discord đổi ngưỡng thì sửa
 *              file này; giá của bạn không bị ảnh hưởng.
 *   PRICING  — giá + bật/tắt từng mốc. Nằm trong DB, UI sửa.
 *
 * Ngưỡng badge được xác minh 2026-09-07 bằng cách đọc /users/@me/badges với một
 * token có Nitro (badge directory chỉ trả dữ liệu cho người xem có Nitro).
 *
 * ArnTo-Auto đọc bảng này qua /api/external/pricing rồi cache lại, nên panel sập
 * thì bot vẫn bán được bằng giá cache.
 */

const db = require("../db");

const KEY = "pricing_settings";

// rarity: 1 common · 2 rare · 3 epic · 5 mythic (theo enum của Discord)
const RARITY = { 1: "common", 2: "rare", 3: "epic", 5: "mythic" };

// ── CATALOG (không sửa từ UI) ────────────────────────────────────────────────────

// `kind` quyết định cả cách định giá lẫn cách chạy:
//
//   "tiered" — khách mua một MỐC. Cần biết giá trị hiện tại (→ dùng reader cho
//              khách không Nitro), chạy qua /science, badge lên sau ~1 ngày.
//   "choice" — khách chọn một PHƯƠNG ÁN. Không có ngưỡng, không cần reader,
//              gọi API một phát là xong và xác minh được ngay.
const BADGE_CATALOG = {
    game_time: {
        badgeId: 20,
        label: "Game Time",
        unit: "hours",
        kind: "tiered",
        tiers: [
            { key: "casual",       name: "Casual",       threshold: 1,    rarity: 1 },
            { key: "recreational", name: "Recreational", threshold: 5,    rarity: 1 },
            { key: "dedicated",    name: "Dedicated",    threshold: 20,   rarity: 1 },
            { key: "committed",    name: "Committed",    threshold: 75,   rarity: 1 },
            { key: "serious",      name: "Serious",      threshold: 150,  rarity: 2 },
            { key: "devoted",      name: "Devoted",      threshold: 300,  rarity: 2 },
            { key: "seasoned",     name: "Seasoned",     threshold: 500,  rarity: 2 },
            { key: "ironclad",     name: "Ironclad",     threshold: 1000, rarity: 3 },
            { key: "unshakeable",  name: "Unshakeable",  threshold: 2000, rarity: 3 },
            { key: "eternal",      name: "Eternal",      threshold: 5000, rarity: 5 },
        ],
    },
    game_variety: {
        badgeId: 21,
        label: "Game Variety",
        unit: "games",
        kind: "tiered",
        tiers: [
            { key: "sampler",      name: "Sampler",      threshold: 2,   rarity: 1 },
            { key: "dabbler",      name: "Dabbler",      threshold: 5,   rarity: 1 },
            { key: "enthusiast",   name: "Enthusiast",   threshold: 10,  rarity: 1 },
            { key: "ranger",       name: "Ranger",       threshold: 15,  rarity: 1 },
            { key: "explorer",     name: "Explorer",     threshold: 20,  rarity: 2 },
            { key: "adventurer",   name: "Adventurer",   threshold: 30,  rarity: 2 },
            { key: "voyager",      name: "Voyager",      threshold: 40,  rarity: 2 },
            { key: "maverick",     name: "Maverick",     threshold: 60,  rarity: 3 },
            { key: "polymath",     name: "Polymath",     threshold: 80,  rarity: 3 },
            { key: "universalist", name: "Universalist", threshold: 100, rarity: 5 },
        ],
    },
    // Chưa bán: event stream trên /science chưa reverse xong, và Discord đã siết
    // phát hiện screen-share thật ở phía quest (xem questEngine STREAM_ON_DESKTOP).
    streaming: {
        badgeId: 19,
        label: "Streaming",
        unit: "hours",
        kind: "tiered",
        supported: false,
        tiers: [
            { key: "newcomer",    name: "Newcomer",    threshold: 1,    rarity: 1 },
            { key: "fledgling",   name: "Fledgling",   threshold: 5,    rarity: 1 },
            { key: "breakout",    name: "Breakout",    threshold: 20,   rarity: 1 },
            { key: "standout",    name: "Standout",    threshold: 75,   rarity: 1 },
            { key: "trendsetter", name: "Trendsetter", threshold: 150,  rarity: 2 },
            { key: "headliner",   name: "Headliner",   threshold: 300,  rarity: 2 },
            { key: "star",        name: "Star",        threshold: 500,  rarity: 2 },
            { key: "sensation",   name: "Sensation",   threshold: 1000, rarity: 3 },
            { key: "visionary",   name: "Visionary",   threshold: 2000, rarity: 3 },
            { key: "phenomenon",  name: "Phenomenon",  threshold: 5000, rarity: 5 },
        ],
    },
    // HypeSquad: POST /hypesquad/online, ăn ngay, không có mốc.
    // Badge `hypesquad_house_N` hiện trên profile với MỌI người xem (không cần
    // Nitro), nên xác minh được ngay bằng chính token khách — không tốn reader,
    // và vì thế cũng không chịu phụ phí non-Nitro.
    hypesquad: {
        badgeId: 4,
        label: "HypeSquad",
        unit: "house",
        kind: "choice",
        tiers: [
            { key: "bravery",    name: "Bravery",    houseId: 1, rarity: 2 },
            { key: "brilliance", name: "Brilliance", houseId: 2, rarity: 2 },
            { key: "balance",    name: "Balance",    houseId: 3, rarity: 2 },
        ],
    },
};

// ── Mặc định (giá null = chưa đặt giá → không bán được) ──────────────────────────
//
// Cố ý để null thay vì 0: một mốc chỉ lên kệ khi bạn chủ động nhập giá cho nó, nên
// không có đường nào vô tình bán 0đ.

const DEFAULTS = {
    autoBadge: {
        enabled: false,           // bật khi đã đặt giá xong
        nonNitroSurcharge: 1.5,   // hệ số nhân cho khách không Nitro
        overshoot: 1.1,           // bù tỷ lệ credit ~94% của /science
        forfeitOnWrongTier: true, // đã sở hữu mốc mà vẫn mua thì mất tiền
        badges: {},               // { [badgeKey]: { [tierKey]: { price, enabled } } }
    },
    autoQuest: {
        pricePerItem: 2000,
        monthlyPrice: 50000,
    },
};

// ── Merge ────────────────────────────────────────────────────────────────────────

function _mergeBadges(stored) {
    const out = {};
    for (const [badgeKey, cat] of Object.entries(BADGE_CATALOG)) {
        const storedTiers = stored?.badges?.[badgeKey] ?? {};
        const supported = cat.supported !== false;
        const kind = cat.kind ?? "tiered";
        out[badgeKey] = {
            badgeId: cat.badgeId,
            label: cat.label,
            unit: cat.unit,
            kind,
            // Chỉ badge tiered mới phải đọc tiến độ, tức chỉ nó mới tiêu reader.
            usesReader: kind === "tiered",
            supported,
            tiers: cat.tiers.map((t) => {
                const s = storedTiers[t.key] ?? {};
                const price = Number.isFinite(s.price) ? s.price : null;
                return {
                    ...t,
                    rarityName: RARITY[t.rarity] ?? "common",
                    price,
                    // một mốc chỉ bán được khi có giá VÀ được bật VÀ badge có hỗ trợ
                    enabled: Boolean(s.enabled) && price > 0 && supported,
                };
            }),
        };
    }
    return out;
}

/** Toàn bộ bảng giá, đã điền mặc định. */
async function getPricing() {
    const stored = (await db.get(KEY)) || {};
    return {
        autoBadge: {
            ...DEFAULTS.autoBadge,
            ...(stored.autoBadge ?? {}),
            badges: _mergeBadges(stored.autoBadge),
        },
        autoQuest: { ...DEFAULTS.autoQuest, ...(stored.autoQuest ?? {}) },
    };
}

function _bad(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

/** Đặt giá / bật tắt một mốc. price = null để xoá giá. */
async function setTier(badgeKey, tierKey, patch = {}) {
    const cat = BADGE_CATALOG[badgeKey];
    if (!cat) throw _bad(`Badge không hợp lệ: ${badgeKey}`);
    if (!cat.tiers.some((t) => t.key === tierKey)) {
        throw _bad(`Mốc không hợp lệ: ${tierKey}`);
    }

    const stored = (await db.get(KEY)) || {};
    stored.autoBadge ??= {};
    stored.autoBadge.badges ??= {};
    stored.autoBadge.badges[badgeKey] ??= {};
    const entry = stored.autoBadge.badges[badgeKey][tierKey] ?? {};

    if ("price" in patch) {
        if (patch.price === null || patch.price === "") {
            entry.price = null;
            entry.enabled = false; // xoá giá thì gỡ khỏi kệ luôn
        } else {
            const price = Number(patch.price);
            if (!Number.isFinite(price) || price < 0) {
                throw _bad(`Giá không hợp lệ: ${patch.price}`);
            }
            entry.price = Math.round(price);
        }
    }
    if ("enabled" in patch) entry.enabled = Boolean(patch.enabled);

    stored.autoBadge.badges[badgeKey][tierKey] = entry;
    await db.set(KEY, stored);
    return getPricing();
}

/** Patch phần cài đặt chung của một hệ thống auto. Key lạ bị bỏ qua. */
async function updateFeature(feature, patch = {}) {
    if (!DEFAULTS[feature]) throw _bad(`Hệ thống không hợp lệ: ${feature}`);

    const stored = (await db.get(KEY)) || {};
    const current = { ...DEFAULTS[feature], ...(stored[feature] ?? {}) };

    for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS[feature]) || k === "badges") continue;
        if (typeof DEFAULTS[feature][k] === "boolean") {
            current[k] = Boolean(v);
        } else {
            const num = Number(v);
            if (!Number.isFinite(num) || num < 0) {
                throw _bad(`Giá trị không hợp lệ cho ${k}: ${v}`);
            }
            current[k] = num;
        }
    }
    // Hệ số < 1 nghĩa là giảm giá cho khách không Nitro — hợp lệ. Nhưng 0 thì gần
    // như chắc chắn là gõ nhầm, và nó biến mọi đơn thành miễn phí.
    if (current.nonNitroSurcharge !== undefined && current.nonNitroSurcharge <= 0) {
        throw _bad("nonNitroSurcharge phải lớn hơn 0");
    }

    // Giá từng mốc chỉ đi qua setTier. Vòng lặp trên đã bỏ qua `badges` trong
    // patch, nên giữ nguyên giá đã lưu ở đây — xoá nó đi là mất sạch bảng giá.
    if ("badges" in DEFAULTS[feature]) current.badges = stored[feature]?.badges ?? {};
    stored[feature] = current;
    await db.set(KEY, stored);
    return getPricing();
}

/**
 * Giá cuối cùng của một mốc, đã áp hệ số non-Nitro.
 * Giá phẳng: không phụ thuộc mốc khách đang có.
 */
async function quote(badgeKey, tierKey, { hasNitro = true } = {}) {
    const pricing = await getPricing();
    if (!pricing.autoBadge.enabled) throw _bad("Auto Badge đang tắt");

    const badge = pricing.autoBadge.badges[badgeKey];
    if (!badge) throw _bad(`Badge không hợp lệ: ${badgeKey}`);

    const tier = badge.tiers.find((t) => t.key === tierKey);
    if (!tier) throw _bad(`Mốc không hợp lệ: ${tierKey}`);
    if (!tier.enabled) throw _bad(`Mốc "${tier.name}" hiện không bán`);

    // Phụ phí non-Nitro chỉ áp cho badge PHẢI đọc bằng reader. HypeSquad không
    // đụng reader lần nào nên tính thêm tiền là không có cơ sở.
    const multiplier =
        hasNitro || !badge.usesReader ? 1 : pricing.autoBadge.nonNitroSurcharge;
    return {
        badgeKey,
        badgeId: badge.badgeId,
        kind: badge.kind,
        usesReader: badge.usesReader,
        unit: badge.unit,
        tier,
        threshold: tier.threshold ?? null,
        houseId: tier.houseId ?? null,
        basePrice: tier.price,
        multiplier,
        price: Math.round(tier.price * multiplier),
        overshoot: pricing.autoBadge.overshoot,
        // Chỉ badge tiered mới có khái niệm "mua nhầm mốc đã có".
        forfeitOnWrongTier: badge.kind === "tiered" && pricing.autoBadge.forfeitOnWrongTier,
    };
}

module.exports = {
    BADGE_CATALOG,
    RARITY,
    getPricing,
    setTier,
    updateFeature,
    quote,
};
