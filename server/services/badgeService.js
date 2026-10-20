/**
 * badgeService.js
 * Vòng đời một đơn Auto Badge. Thanh toán nằm ở ArnTo-Auto; panel chỉ được gọi
 * SAU KHI khách đã trả tiền, rồi tự chạy hết phần còn lại.
 *
 *   badge tiered   paid ─→ verifying ─┬─→ sending ─→ sent        (xong)
 *   (game_time,                       ├─→ forfeited
 *    game_variety)                    └─→ manual_review
 *
 *   badge choice   paid ─→ sending ─→ sent                       (xong)
 *   (hypesquad)
 *
 * "verifying" ở trên là lượt đọc TRƯỚC khi gửi — để biết tài khoản đang ở đâu mà
 * tính kế hoạch, và để chặn người mua lại mốc họ đã có. Nó không phải xác minh.
 *
 * Đơn tay (`source: "manual"`, owner thêm trên trang /badges, không thanh toán)
 * chạy cùng vòng đời này — khác biệt ghi ở createManualOrder().
 *
 * NĂM QUYẾT ĐỊNH THIẾT KẾ, theo yêu cầu:
 *  1. Không có bước xác nhận riêng trước khi hiện QR — khách chọn mốc là mua luôn.
 *  2. Đọc lỗi thì KHÔNG tự tịch thu: đơn treo ở manual_review chờ duyệt tay.
 *     Tự động tịch thu khi hạ tầng của mình hỏng là kịch bản tệ nhất có thể có.
 *  3. Đã sở hữu mốc mà vẫn mua thì mất tiền (forfeited).
 *  4. GỬI XONG LÀ XONG. Không có bước đọc lại badge sau khi đơn hoàn tất — không
 *     tự động, không cả nút bấm tay, cho mọi loại badge. Gửi xong là báo khách.
 *  5. Game badge (tiered) CHỈ BÁN CHO TÀI KHOẢN CÓ NITRO (2026-10-17). Tiến độ
 *     luôn đọc bằng chính token khách — không reader, không lời khai. Discord
 *     giấu badge bị ẩn với người ngoài, nên đọc hộ là đọc ra 0 rồi gửi thừa.
 *     Đọc được hay không phải biết TRƯỚC khi hiện QR (check/quote).
 *
 * DB model `badge_orders` — xem _shape() ở cuối file.
 */

const { EventEmitter } = require("events");
const crypto = require("crypto");
const db = require("../db");
const badgeReader = require("./badgeReader");
const { BadgeSender, planOrder, setHypeSquad } = require("./badgeEngine");
const pricingStore = require("./pricingStore");
const proxyPool = require("./proxyPool");
const callbacks = require("./callbackService");

const MODEL = "badge_orders";
const ACCOUNTS = "badge_accounts";

// KHÔNG ĐỌC LẠI BADGE SAU KHI GỬI. Đây là quyết định có chủ đích, đừng thêm lại.
//
// Badge tiered cần ~1 ngày để Discord dựng lại, nên mọi lượt đọc sớm hơn đều ra
// số cũ và chấm nhầm một đơn đang tốt thành hỏng — đã xảy ra thật một lần, khách
// nhận DM báo động vô cớ. Mỗi lượt đọc còn là thêm một request từ token khách,
// trong khi khách đã nhận đủ thứ họ mua ngay lúc gửi xong. Biết chắc phải đợi một
// ngày mới đọc được thì cái "xác minh" ấy không mua thêm thông tin gì.
//
// Cần đối chứng lúc tranh chấp thì đọc thủ công bằng badgeReader.readSelf, không
// đi qua đơn và không đổi trạng thái đơn.

const bus = new EventEmitter();
bus.setMaxListeners(0);

// orderId của những đơn đang gửi — chặn chạy trùng khi restore hoặc gọi lại.
const running = new Set();

// ── Mã hoá token khi lưu (dùng chung cách của questService) ──────────────────────
const ALGO = "aes-256-gcm";
function _key() {
    const secret =
        process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret";
    return crypto.createHash("sha256").update(secret).digest();
}
function _encrypt(token) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, _key(), iv);
    const enc = Buffer.concat([c.update(String(token), "utf8"), c.final()]);
    return {
        tokenEncrypted: enc.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: c.getAuthTag().toString("base64"),
    };
}
function _decrypt(rec) {
    try {
        const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(rec.tokenIv, "base64"));
        d.setAuthTag(Buffer.from(rec.tokenTag, "base64"));
        return Buffer.concat([
            d.update(Buffer.from(rec.tokenEncrypted, "base64")),
            d.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

function _err(message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ── Webhook về ArnTo-Auto ────────────────────────────────────────────────────────

// Lỗi đi hai đường: `order.error` lưu câu tiếng Anh (trang /badges hiển thị), còn
// `error` trong sự kiện gửi ArnTo-Auto giữ câu tiếng Việt (`err.vi`) — Auto đưa
// nguyên văn lỗi của sự kiện "failed" vào DM khách. Lỗi không có `vi` (lỗi mạng
// của axios…) đi nguyên văn như trước.
const _vi = (err) => err?.vi ?? err?.message;

function _dispatch(order, event) {
    bus.emit("event", { orderId: order.orderId, at: Date.now(), ...event });
    if (!order.webhookUrl && !order.webhookBotId) return;
    // Địa chỉ và x-api-key đi theo project đã đăng ký webhook (callbackService).
    callbacks.send(order.webhookUrl, order.webhookBotId ?? null, { ...event, orderId: order.orderId, ref: order.ref ?? null }, "badge.event");
}

// ── Truy cập DB ──────────────────────────────────────────────────────────────────

async function _get(orderId) {
    return db.findOne(MODEL, { orderId });
}

async function _patch(orderId, data) {
    return db.findOneAndUpdate(MODEL, { orderId }, { ...data, updatedAt: Date.now() });
}

/** Game đã claim của một account, gộp qua mọi đơn — để hai badge không đụng nhau. */
async function _claimedGameIds(accountId) {
    const rec = await db.findOne(ACCOUNTS, { accountId });
    return Array.isArray(rec?.claimedGameIds) ? rec.claimedGameIds : [];
}

async function _addClaimedGames(accountId, username, ids) {
    const rec = await db.findOne(ACCOUNTS, { accountId });
    const merged = [...new Set([...(rec?.claimedGameIds ?? []), ...ids.map(String)])];
    if (rec) {
        await db.findOneAndUpdate(
            ACCOUNTS,
            { accountId },
            { claimedGameIds: merged, username, updatedAt: Date.now() },
        );
    } else {
        await db.create(ACCOUNTS, {
            accountId,
            username,
            claimedGameIds: merged,
            addedAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    return merged;
}

/**
 * Còn bao nhiêu đơn vị nữa mới chạm mốc kế tiếp của một badge.
 *
 * Dùng cho đơn Game Time: mỗi game mới mở ra cộng 1 vào Game Variety, và nếu
 * cộng đủ để qua mốc thì khách được mốc đó miễn phí. Trả Infinity khi đã ở mốc
 * cao nhất (không còn gì để mất).
 */
function _headroomToNextTier(badgeKey, currentValue) {
    const tiers = pricingStore.BADGE_CATALOG[badgeKey]?.tiers ?? [];
    const next = tiers
        .filter((t) => Number.isFinite(t.threshold) && t.threshold > currentValue)
        .sort((a, b) => a.threshold - b.threshold)[0];
    if (!next) return Infinity;
    // -1 vì chạm đúng ngưỡng là đã đạt mốc.
    return Math.max(0, next.threshold - currentValue - 1);
}

// ── Báo giá (ArnTo-Auto gọi trước khi hiện QR) ───────────────────────────────────

/**
 * Tiến độ game badge của chính khách, đọc bằng token của họ. Ném lỗi 400 với lý
 * do khách đọc được khi không bán được: không Nitro, hoặc có Nitro mà Discord vẫn
 * đóng danh sách badge (đã gặp thật). `vi` là câu khách thấy trên Auto. Đừng để
 * chữ "token" lọt vào câu này — bot sẽ hiểu nhầm thành token chết.
 */
async function _readOwn(token, me) {
    if (!me.hasNitro) {
        throw _err("Game Time and Game Variety are sold to Nitro accounts only", 400, {
            needsNitro: true,
            vi: "Game Time và Game Variety chỉ bán cho tài khoản có Nitro",
        });
    }
    try {
        return await badgeReader.readSelf(token, me.userId);
    } catch (err) {
        if (err.invalidToken) throw err;
        throw _err(
            "Discord does not show this account's badge progress, so Game Time / Game Variety cannot be bought yet",
            400,
            {
                unreadable: true,
                vi: "Discord không cho đọc tiến độ badge của tài khoản này nên hiện chưa mua được Game Time / Game Variety",
            },
        );
    }
}

/**
 * Kiểm token + báo giá. Game badge: đọc tiến độ bằng token khách ngay tại đây, và
 * từ chối luôn nếu không đọc được — để không ai trả tiền cho một đơn mà panel
 * không chạy được.
 */
async function quote({ token, badgeKey, tierKey }) {
    const me = await badgeReader.checkNitro(token);
    const q = await pricingStore.quote(badgeKey, tierKey);

    let current = null;
    let alreadyOwned = null;

    if (q.kind === "choice") {
        // HypeSquad: đọc nhà hiện tại bằng token khách — profile không bị lọc theo
        // Nitro nên ai cũng đọc được. Đang ở nhà khác vẫn mua được (đổi nhà là
        // hành vi hợp lệ); chỉ chặn khi mua đúng nhà đang có, vì tiền sẽ vô ích.
        try {
            current = await badgeReader.readHypeSquadHouse(token, me.userId);
            alreadyOwned = current === q.houseId;
        } catch {
            current = null;
        }
    } else {
        const read = await _readOwn(token, me);
        current = read.badges[badgeKey]?.value ?? null;
        alreadyOwned = current !== null && q.threshold !== null && current >= q.threshold;
    }

    return {
        accountId: me.userId,
        username: me.username,
        hasNitro: me.hasNitro,
        badgeKey,
        tierKey,
        tierName: q.tier.name,
        kind: q.kind,
        houseId: q.houseId,
        threshold: q.threshold,
        unit: q.unit,
        price: q.price,
        currentValue: current,
        alreadyOwned,
        forfeitOnWrongTier: q.forfeitOnWrongTier,
    };
}

/**
 * Kiểm token và lấy tình trạng tài khoản, KHÔNG cần biết định mua mốc nào.
 * Bot dùng cái này ngay sau khi khách dán token, để ẩn những mốc khách đã sở hữu
 * và ẩn hẳn game badge khi tài khoản không mua được (`tieredReason` nói vì sao).
 */
async function check({ token }) {
    const me = await badgeReader.checkNitro(token);
    let values = null;
    let tieredReason = null;
    let tieredCode = null;
    try {
        const read = await _readOwn(token, me);
        values = Object.fromEntries(
            Object.entries(read.badges).map(([k, b]) => [
                k,
                { value: b.value, currentTier: b.currentTier, owned: b.owned },
            ]),
        );
    } catch (err) {
        if (err.invalidToken) throw err;
        tieredReason = _vi(err);
        tieredCode = err.needsNitro ? "needsNitro" : err.unreadable ? "unreadable" : "error";
    }

    // HypeSquad đọc được cho MỌI khách, có Nitro hay không, vì profile không bị
    // lọc. Nhờ vậy bot ẩn luôn được nhà khách đang ở khỏi menu.
    let hypesquadHouse = null;
    try {
        hypesquadHouse = await badgeReader.readHypeSquadHouse(token, me.userId);
    } catch {
        hypesquadHouse = null;
    }

    return {
        accountId: me.userId,
        username: me.username,
        hasNitro: me.hasNitro,
        premiumType: me.premiumType,
        values,
        // false → bot không bán Game Time / Game Variety cho tài khoản này.
        tieredAvailable: values !== null,
        // Câu tiếng Việt bot đưa nguyên văn cho khách — trang panel không hiện nó.
        tieredReason,
        // Cùng lý do ở dạng mã, cho trang panel (tiếng Anh): needsNitro | unreadable | error.
        tieredCode,
        hypesquadHouse,
    };
}

// ── Tạo đơn (gọi sau khi thanh toán thành công) ──────────────────────────────────

/**
 * Tiền đã về rồi, nên ở đây KHÔNG chặn theo Nitro: khách mất Nitro giữa lúc báo
 * giá và lúc trả tiền thì đơn vẫn được tạo, rồi _process đẩy sang manual_review
 * để hoàn tiền — còn hơn một khoản tiền không có đơn nào trên panel.
 */
async function createOrder({
    token,
    badgeKey,
    tierKey,
    ref = null,
    webhookUrl = null,
    webhookBotId = null,
    paymentId = null,
}) {
    const me = await badgeReader.checkNitro(token);
    const q = await pricingStore.quote(badgeKey, tierKey);

    const order = {
        orderId: crypto.randomUUID(),
        ref,
        paymentId,
        accountId: me.userId,
        username: me.username,
        hasNitro: me.hasNitro,
        locale: me.locale ?? null,
        ...(_encrypt(token)),
        badgeKey,
        tierKey,
        tierName: q.tier.name,
        kind: q.kind,
        houseId: q.houseId,
        threshold: q.threshold,
        unit: q.unit,
        price: q.price,
        overshoot: q.overshoot,
        forfeitOnWrongTier: q.forfeitOnWrongTier,
        measuredValue: null,
        measuredAt: null,
        measuredSource: null,
        status: "paid",
        error: null,
        plan: null,
        sent: 0,
        total: 0,
        webhookUrl,
        webhookBotId: webhookUrl || webhookBotId ? webhookBotId : null,
        createdAt: Date.now(),
        paidAt: Date.now(),
        sentAt: null,
        finalTier: null,
        finalValue: null,
        updatedAt: Date.now(),
    };

    await db.create(MODEL, order);
    _dispatch(order, { type: "order_created", status: "paid" });
    // Chạy nền: người gọi không phải chờ hết cả lượt gửi.
    processOrder(order.orderId).catch(() => {});
    return _shape(order);
}

// ── Đơn tay (chủ panel tự thêm acc, không qua thanh toán) ────────────────────────
//
// Trang /badges, chỉ owner. Không đi qua ArnTo-Auto: không giá, không webhook,
// không bảng giá — mốc lấy thẳng từ CATALOG nên chạy được cả khi Auto Badge đang
// tắt hay mốc chưa đặt giá. Sau khi tạo, đơn chạy đúng đường của đơn có trả tiền.
//
// Khác đơn bán ở ba chỗ, vì tiền không ở đây:
//   - Tài khoản không đọc được tiến độ (không Nitro…) vẫn gửi được: chủ panel tự
//     nhập con số hiện tại (`enteredValue`). Nhập sai thì gửi thừa/thiếu — đó là
//     lựa chọn của chính họ, không phải của khách.
//   - Đã có mốc thì từ chối ngay lúc tạo; lỡ lọt tới lúc chạy thì "cancelled",
//     không bao giờ "forfeited".
//   - Duyệt tay chỉ có Retry / Cancel — không có tiền để tịch thu hay hoàn.

function _catalogTier(badgeKey, tierKey) {
    const cat = pricingStore.BADGE_CATALOG[badgeKey];
    if (!cat || cat.supported === false) throw _err(`Invalid badge: ${badgeKey}`);
    const tier = cat.tiers.find((t) => t.key === tierKey);
    if (!tier) throw _err(`Invalid tier: ${tierKey}`);
    return { cat, tier, kind: cat.kind ?? "tiered" };
}

function _manualCatalog() {
    return Object.entries(pricingStore.BADGE_CATALOG)
        .filter(([, c]) => c.supported !== false)
        .map(([key, c]) => ({
            key,
            label: c.label,
            unit: c.unit,
            kind: c.kind ?? "tiered",
            tiers: c.tiers.map((t) => ({
                key: t.key,
                name: t.name,
                threshold: t.threshold ?? null,
                houseId: t.houseId ?? null,
            })),
        }));
}

/** Tình trạng tài khoản cho form thêm tay — như check(), kèm catalog và overshoot. */
async function checkManual({ token }) {
    const [account, pricing] = await Promise.all([
        check({ token: String(token).trim() }),
        pricingStore.getPricing(),
    ]);
    return { ...account, overshoot: pricing.autoBadge.overshoot, catalog: _manualCatalog() };
}

async function createManualOrder(
    { token, badgeKey, tierKey, currentValue = null, note = "" },
    createdBy = null,
) {
    token = String(token ?? "").trim();
    if (!token) throw _err("Paste the account's token");
    const { cat, tier, kind } = _catalogTier(badgeKey, tierKey);
    const me = await badgeReader.checkNitro(token);
    const pricing = await pricingStore.getPricing();

    let enteredValue = null;
    if (kind === "choice") {
        const house = await badgeReader.readHypeSquadHouse(token, me.userId).catch(() => null);
        if (house === tier.houseId) throw _err(`${me.username} is already in ${tier.name}`, 409);
    } else {
        let current = null;
        try {
            current = (await _readOwn(token, me)).badges[badgeKey]?.value ?? null;
        } catch (err) {
            if (err.invalidToken) throw err;
        }
        if (!Number.isFinite(current)) {
            const n = currentValue === null || currentValue === "" ? NaN : Number(currentValue);
            if (!Number.isFinite(n) || n < 0) {
                throw _err(
                    `Discord does not show this account's ${cat.label} progress — enter its current value`,
                    400,
                    { needsValue: true },
                );
            }
            enteredValue = current = n;
        }
        if (current >= tier.threshold) {
            throw _err(`${me.username} already has ${tier.name} (${current} ${cat.unit})`, 409);
        }
    }

    const order = {
        orderId: crypto.randomUUID(),
        source: "manual",
        createdBy,
        note: String(note ?? "").trim().slice(0, 200) || null,
        ref: null,
        paymentId: null,
        accountId: me.userId,
        username: me.username,
        hasNitro: me.hasNitro,
        locale: me.locale ?? null,
        ...(_encrypt(token)),
        badgeKey,
        tierKey,
        tierName: tier.name,
        kind,
        houseId: tier.houseId ?? null,
        threshold: tier.threshold ?? null,
        unit: cat.unit,
        price: 0,
        overshoot: pricing.autoBadge.overshoot,
        forfeitOnWrongTier: false,
        enteredValue,
        measuredValue: null,
        measuredAt: null,
        measuredSource: null,
        status: "paid",
        error: null,
        plan: null,
        sent: 0,
        total: 0,
        webhookUrl: null,
        webhookBotId: null,
        createdAt: Date.now(),
        paidAt: null,
        sentAt: null,
        finalTier: null,
        finalValue: null,
        updatedAt: Date.now(),
    };

    await db.create(MODEL, order);
    _dispatch(order, { type: "order_created", status: "paid" });
    processOrder(order.orderId).catch(() => {});
    return _shape(order);
}

// ── Chạy đơn ─────────────────────────────────────────────────────────────────────

/**
 * TUYỆT ĐỐI KHÔNG đặt tên hàm này là `process`: ở phạm vi module nó che khuất
 * global `process` của Node, khiến mọi `process.env` trong file thành undefined.
 * Đã dính một lần — _encrypt() chết ngay ở createOrder nên KHÔNG đơn nào chạy được.
 */
async function processOrder(orderId) {
    if (running.has(orderId)) return null;
    running.add(orderId);
    try {
        return await _process(orderId);
    } finally {
        running.delete(orderId);
    }
}

async function _process(orderId) {
    let order = await _get(orderId);
    if (!order) throw _err("Order not found", 404);
    if (!["paid", "manual_review", "sending"].includes(order.status)) {
        return _shape(order);
    }

    const token = _decrypt(order);
    if (!token) {
        await _patch(orderId, { status: "error", error: "Could not decrypt the stored token" });
        return _shape(await _get(orderId));
    }

    // ── Badge "choice" (HypeSquad): ăn ngay, đường đi ngắn hẳn ──────────────────
    // Không mốc → không cần đọc trước, không có chuyện mua nhầm mốc đã có (đổi
    // nhà là hành vi hợp lệ kể cả khi đang có nhà khác), không cần Nitro, và
    // xác minh được ngay bằng chính token khách.
    if (order.kind === "choice") return _processChoice(orderId, order, token);

    // ── Bước 1: đọc giá trị thật ────────────────────────────────────────────────
    await _patch(orderId, { status: "verifying", error: null });
    _dispatch(order, { type: "status", status: "verifying" });

    // Đơn tay của tài khoản Discord không cho đọc: chủ panel đã tự nhập con số lúc
    // tạo đơn. Vẫn thử đọc trước — đọc được thì số thật thắng số nhập.
    const entered = Number.isFinite(order.enteredValue) ? order.enteredValue : null;

    let read = null;
    try {
        // Hỏi lại Nitro ngay lúc chạy: khách có thể mất Nitro sau khi báo giá.
        const me = await badgeReader.checkNitro(token);
        read = await _readOwn(token, me);
    } catch (err) {
        if (err.invalidToken) {
            await _patch(orderId, { status: "token_dead", error: err.message });
            _dispatch(order, { type: "failed", status: "token_dead", error: _vi(err) });
            return _shape(await _get(orderId));
        }
        // Mất Nitro / Discord đóng danh sách badge / lỗi mạng: KHÔNG tịch thu,
        // KHÔNG gửi. Treo chờ duyệt.
        if (entered === null) {
            await _patch(orderId, { status: "manual_review", error: err.message });
            _dispatch(order, { type: "manual_review", status: "manual_review", error: _vi(err) });
            return _shape(await _get(orderId));
        }
    }

    const badge = read?.badges[order.badgeKey];
    const readValue = Number.isFinite(badge?.value) ? badge.value : null;
    const measured = readValue ?? entered;
    if (!Number.isFinite(measured)) {
        // Đọc được badge nhưng không suy ra được con số — cũng là chờ duyệt, vì
        // đoán bừa ở đây thì hoặc gửi thừa hoặc tịch thu oan.
        await _patch(orderId, { status: "manual_review", error: "Could not read the progress value" });
        _dispatch(order, { type: "manual_review", status: "manual_review", error: "Không đọc được con số tiến độ" });
        return _shape(await _get(orderId));
    }

    await _patch(orderId, {
        measuredValue: measured,
        measuredAt: Date.now(),
        measuredSource: readValue === null ? "entered" : read.source,
    });

    // ── Bước 2: đã sở hữu mốc rồi thì tịch thu ──────────────────────────────────
    // Đơn tay không có tiền để tịch thu: huỷ.
    if (measured >= order.threshold && order.source === "manual") {
        const error = `Account already has ${order.tierName} (${measured} ${order.unit})`;
        await _patch(orderId, { status: "cancelled", error, finalValue: measured, finalTier: badge?.currentTier ?? null });
        _dispatch(order, { type: "cancelled", status: "cancelled", error });
        return _shape(await _get(orderId));
    }
    if (measured >= order.threshold) {
        const patch = {
            status: order.forfeitOnWrongTier ? "forfeited" : "refund_due",
            error: `Account already has ${order.tierName} (${measured} ${order.unit})`,
            finalValue: measured,
            finalTier: badge?.currentTier ?? null,
        };
        await _patch(orderId, patch);
        _dispatch(order, {
            type: order.forfeitOnWrongTier ? "forfeited" : "refund_due",
            status: patch.status,
            error: `Tài khoản đã đạt mốc ${order.tierName} (${measured} ${order.unit})`,
            measuredValue: measured,
            threshold: order.threshold,
            unit: order.unit,
        });
        return _shape(await _get(orderId));
    }

    // ── Bước 3: lập kế hoạch + gửi ──────────────────────────────────────────────
    // Đơn Game Time: gom thêm dữ liệu để khỏi vô tình tặng mốc Game Variety.
    let playedGameIds = [];
    let varietyHeadroom = Infinity;
    if (order.badgeKey === "game_time") {
        varietyHeadroom = _headroomToNextTier(
            "game_variety",
            read?.badges.game_variety?.value ?? 0,
        );
        // Hỏng thì bỏ qua — lớp chặn cứng varietyHeadroom vẫn còn.
        playedGameIds = await badgeReader
            .readPlayedApplicationIds(token)
            .catch(() => []);
    }

    let plan;
    try {
        plan = await planOrder({
            badgeKey: order.badgeKey,
            threshold: order.threshold,
            current: measured,
            overshoot: order.overshoot,
            claimedGameIds: await _claimedGameIds(order.accountId),
            playedGameIds,
            varietyHeadroom,
        });
    } catch (err) {
        await _patch(orderId, { status: "manual_review", error: err.message });
        _dispatch(order, { type: "manual_review", status: "manual_review", error: _vi(err) });
        return _shape(await _get(orderId));
    }

    if (!plan.sessions?.length) {
        // Đã đủ rồi mà chưa vượt threshold — hiếm, nhưng đừng gửi rỗng.
        await _patch(orderId, { status: "manual_review", error: "The send plan is empty" });
        return _shape(await _get(orderId));
    }

    await _patch(orderId, {
        status: "sending",
        plan: {
            gameCount: plan.games.length,
            sessionCount: plan.sessions.length,
            hoursPerSession: plan.hoursPerSession,
            need: plan.need,
            varietySideEffect: plan.varietySideEffect ?? 0,
            reusedCount: plan.reusedCount ?? 0,
            playedCount: plan.playedCount ?? 0,
            varietyHeadroom: Number.isFinite(plan.varietyHeadroom)
                ? plan.varietyHeadroom
                : null,
            crossedVarietyTier: Boolean(plan.crossedVarietyTier),
        },
        total: plan.sessions.length,
        sent: 0,
    });
    _dispatch(order, {
        type: "status",
        status: "sending",
        total: plan.sessions.length,
        need: plan.need,
        unit: order.unit,
    });

    // Lease dính theo accountId: mỗi tài khoản luôn ra cùng một IP.
    const lease = await proxyPool.acquire(order.accountId, { feature: "badge" });
    let result;
    try {
        const sender = new BadgeSender(token, { agent: lease.agent });
        await sender.init();
        result = await sender.run(plan, {
            onBatch: ({ sent, total, ok, status }) => {
                _patch(orderId, { sent }).catch(() => {});
                _dispatch(order, { type: "progress", sent, total, ok, httpStatus: status });
            },
        });
    } catch (err) {
        lease.release({ failed: true });
        const dead = Boolean(err.invalidToken);
        await _patch(orderId, { status: dead ? "token_dead" : "error", error: err.message });
        _dispatch(order, {
            type: "failed",
            status: dead ? "token_dead" : "error",
            error: _vi(err),
        });
        return _shape(await _get(orderId));
    }
    lease.release({ failed: result.aborted });

    if (result.aborted) {
        await _patch(orderId, {
            status: "manual_review",
            sent: result.sent,
            error: `Discord refused with HTTP ${result.status} after ${result.sent}/${result.total} games`,
        });
        _dispatch(order, { type: "manual_review", status: "manual_review", sent: result.sent });
        return _shape(await _get(orderId));
    }

    await _addClaimedGames(order.accountId, order.username, plan.games.map((g) => g.id));

    await _patch(orderId, {
        status: "sent",
        sent: result.sent,
        sentAt: Date.now(),
        error: null,
    });
    _dispatch(order, {
        type: "sent",
        status: "sent",
        sent: result.sent,
        total: result.total,
        badgeKey: order.badgeKey,
        tierName: order.tierName,
        threshold: order.threshold,
        unit: order.unit,
    });
    return _shape(await _get(orderId));
}

/**
 * HypeSquad: gọi API đổi nhà, rồi đọc lại profile để chắc chắn nó ăn.
 *
 * Xác minh bằng profile chứ không tin vào mã 204 trả về: đã thấy trường hợp API
 * nhận request nhưng badge không đổi. Đọc profile bằng chính token khách, và
 * badge `hypesquad_house_N` hiện với mọi người xem — kể cả khách không Nitro.
 */
async function _processChoice(orderId, order, token) {
    await _patch(orderId, { status: "sending", total: 1, sent: 0, error: null });
    _dispatch(order, { type: "status", status: "sending" });

    const lease = await proxyPool.acquire(order.accountId, { feature: "badge" });
    try {
        await setHypeSquad(token, order.houseId, {
            agent: lease.agent,
            ...(order.locale ? { locale: order.locale } : {}),
        });
    } catch (err) {
        lease.release({ failed: true });
        const dead = Boolean(err.invalidToken);
        await _patch(orderId, { status: dead ? "token_dead" : "error", error: err.message });
        _dispatch(order, {
            type: "failed",
            status: dead ? "token_dead" : "error",
            error: _vi(err),
        });
        return _shape(await _get(orderId));
    }
    lease.release();

    await _patch(orderId, {
        status: "sent",
        sent: 1,
        total: 1,
        sentAt: Date.now(),
        finalValue: order.houseId,
        finalTier: order.tierKey,
    });

    // Đổi nhà xong là xong. POST /hypesquad/online trả 2xx nghĩa là Discord đã
    // nhận, và nhà đổi tức thì — đọc lại profile chỉ để tự trấn an, mà lượt đọc
    // hỏng thì lại chấm oan một đơn đã thành công.
    _dispatch(order, {
        type: "sent",
        status: "sent",
        sent: 1,
        total: 1,
        badgeKey: order.badgeKey,
        tierName: order.tierName,
        unit: order.unit,
    });
    return _shape(await _get(orderId));
}

// ── Duyệt tay ────────────────────────────────────────────────────────────────────

/**
 * Duyệt một đơn manual_review: "retry" chạy lại, "forfeit" tịch thu, "cancel" huỷ.
 * Đơn tay không có tiền: "cancel" là huỷ hẳn, không có "forfeit".
 */
async function resolveManual(orderId, action) {
    const order = await _get(orderId);
    if (!order) throw _err("Order not found", 404);
    if (order.status !== "manual_review") throw _err("The order is not waiting for review");

    if (action === "retry") {
        await _patch(orderId, { status: "paid", error: null });
        return processOrder(orderId);
    }
    if (order.source === "manual") {
        if (action !== "cancel") throw _err("An order added by hand can only be retried or cancelled");
        await _patch(orderId, { status: "cancelled", error: "Cancelled on review" });
        _dispatch(order, { type: "cancelled", status: "cancelled" });
        return _shape(await _get(orderId));
    }
    if (action === "forfeit") {
        await _patch(orderId, { status: "forfeited", error: "Forfeited on review" });
        _dispatch(order, { type: "forfeited", status: "forfeited" });
        return _shape(await _get(orderId));
    }
    if (action === "cancel") {
        await _patch(orderId, { status: "refund_due", error: "Cancelled on review — refund due" });
        _dispatch(order, { type: "refund_due", status: "refund_due" });
        return _shape(await _get(orderId));
    }
    throw _err(`Invalid action: ${action}`);
}

// ── Liệt kê ──────────────────────────────────────────────────────────────────────

function _shape(o) {
    if (!o) return null;
    // Không bao giờ để token rò ra ngoài service.
    const {
        tokenEncrypted: _a, tokenIv: _b, tokenTag: _c, webhookUrl: _d, ...rest
    } = o;
    return rest;
}

/** source: "manual" = thêm tay trên panel, "auto" = bán qua ArnTo-Auto (đơn cũ không có trường này). */
async function listOrders({ ref = null, status = null, source = null } = {}) {
    const query = {};
    if (ref) query.ref = ref;
    if (status) query.status = status;
    let rows = (await db.find(MODEL, query)) ?? [];
    if (source === "manual") rows = rows.filter((o) => o.source === "manual");
    else if (source === "auto") rows = rows.filter((o) => o.source !== "manual");
    return rows.map(_shape).sort((a, b) => b.createdAt - a.createdAt);
}

async function getOrder(orderId) {
    return _shape(await _get(orderId));
}

// ── Scheduler + khôi phục sau reboot ─────────────────────────────────────────────

/**
 * Đơn đang dở lúc panel restart. "paid"/"verifying" chạy lại từ đầu an toàn vì
 * chưa gửi gì. "sending" thì KHÔNG tự chạy lại — /science cộng dồn, chạy lại là
 * gửi thừa — nên đẩy sang chờ duyệt để bạn nhìn rồi quyết.
 */
async function restoreOrders() {
    const stuck = (await db.find(MODEL, {})) ?? [];
    for (const o of stuck) {
        if (o.status === "paid" || o.status === "verifying") {
            processOrder(o.orderId).catch(() => {});
        } else if (o.status === "sending") {
            await _patch(o.orderId, {
                status: "manual_review",
                error: `The panel restarted mid-send (${o.sent}/${o.total}). Sending again would add too much — check first, then decide.`,
            }).catch(() => {});
        }
    }
}

/**
 * Chờ các đơn đang gửi chạy xong (panel sắp chuyển sang node khác). Không ngắt
 * giữa chừng: /science cộng dồn nên một đơn "sending" không chạy lại được.
 * Trả về số đơn còn chạy khi hết timeoutMs (0 = đã rảnh).
 */
async function waitIdle({ timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    return running.size;
}

/** Số đơn đang xử lý (preflight chuyển panel hiển thị). */
const runningCount = () => running.size;

function start() {
    restoreOrders().catch(() => {});
}

module.exports = {
    bus,
    check,
    quote,
    createOrder,
    checkManual,
    createManualOrder,
    processOrder,
    resolveManual,
    listOrders,
    getOrder,
    restoreOrders,
    waitIdle,
    runningCount,
    start,
};
