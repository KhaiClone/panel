/**
 * badgeService.js
 * Vòng đời một đơn Auto Badge. Thanh toán nằm ở ArnTo-Auto; panel chỉ được gọi
 * SAU KHI khách đã trả tiền, rồi tự chạy hết phần còn lại.
 *
 *   paid ─→ verifying ─┬─→ sending ─→ sent ─(24h)─→ verified
 *                      │                                └─→ verify_failed
 *                      ├─→ forfeited       (đã sở hữu mốc rồi mà vẫn mua)
 *                      └─→ manual_review   (reader chết / rate-limit / 404)
 *
 * BA QUYẾT ĐỊNH THIẾT KẾ, theo yêu cầu:
 *  1. Không có bước xác nhận riêng trước khi hiện QR — khách chọn mốc là mua luôn.
 *  2. Reader lỗi thì KHÔNG tự tịch thu: đơn treo ở manual_review chờ duyệt tay.
 *     Tự động tịch thu khi hạ tầng của mình hỏng là kịch bản tệ nhất có thể có.
 *  3. Đã sở hữu mốc mà vẫn mua thì mất tiền (forfeited).
 *
 * `measuredValue` LUÔN lấy từ reader, không bao giờ từ lời khai của khách. Khách
 * khai thấp để ăn nâng cấp miễn phí là bất khả thi vì kế hoạch gửi tính từ số
 * đọc được, không phải số khai.
 *
 * DB model `badge_orders` — xem _shape() ở cuối file.
 */

const { EventEmitter } = require("events");
const crypto = require("crypto");
const axios = require("axios");
const db = require("../db");
const badgeReader = require("./badgeReader");
const { BadgeSender, planOrder, setHypeSquad } = require("./badgeEngine");
const pricingStore = require("./pricingStore");
const proxyPool = require("./proxyPool");

const MODEL = "badge_orders";
const ACCOUNTS = "badge_accounts";

// Badge lên sau ~1 ngày (đo được: gửi 04/09 20:xx → badge 05/09 17:42 và 20:00).
// 26h cho dư biên an toàn.
const VERIFY_DELAY_MS = 26 * 60 * 60_000;
const TICK_MS = 5 * 60_000;

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

function _dispatch(order, event) {
    bus.emit("event", { orderId: order.orderId, at: Date.now(), ...event });
    if (!order.webhookUrl) return;
    axios
        .post(
            order.webhookUrl,
            { ...event, orderId: order.orderId, ref: order.ref ?? null },
            { timeout: 8000, headers: { "x-api-key": process.env.PANEL_API_KEY || "" } },
        )
        .catch(() => {});
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

// ── Báo giá (ArnTo-Auto gọi trước khi hiện QR) ───────────────────────────────────

/**
 * Kiểm token + báo giá. KHÔNG dùng reader: khách có Nitro thì tự đọc bằng token
 * của chính họ, khách không Nitro thì chưa đọc gì cả — reader chỉ vào cuộc sau
 * khi tiền đã về. Nhờ vậy không ai spam được tài nguyên acc của bạn.
 */
async function quote({ token, badgeKey, tierKey }) {
    const me = await badgeReader.checkNitro(token);
    const q = await pricingStore.quote(badgeKey, tierKey, { hasNitro: me.hasNitro });

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
    } else if (me.hasNitro) {
        // Miễn phí với chúng ta: đọc bằng chính token khách.
        try {
            const read = await badgeReader.readSelf(token, me.userId);
            const b = read.badges[badgeKey];
            current = b?.value ?? null;
            alreadyOwned =
                current !== null && q.threshold !== null && current >= q.threshold;
        } catch {
            // Đọc hỏng không được chặn việc bán — reader thật sự chạy sau thanh toán.
            current = null;
        }
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
        basePrice: q.basePrice,
        multiplier: q.multiplier,
        // null = chưa biết (khách không Nitro, badge tiered). Bot phải hỏi khách khai.
        currentValue: current,
        alreadyOwned,
        // HypeSquad không cần khai gì: ta đọc được nhà hiện tại miễn phí.
        needsDeclaration: q.kind === "tiered" && !me.hasNitro,
        forfeitOnWrongTier: q.forfeitOnWrongTier,
    };
}

/**
 * Kiểm token và lấy tình trạng tài khoản, KHÔNG cần biết định mua mốc nào.
 * Bot dùng cái này ngay sau khi khách dán token, để dựng bảng giá đã áp đúng hệ
 * số Nitro và đánh dấu sẵn những mốc khách đã sở hữu.
 *
 * Vẫn không đụng reader: khách có Nitro thì đọc bằng token của họ, khách không
 * Nitro thì trả values = null và bot sẽ hỏi khách tự khai.
 */
async function check({ token }) {
    const me = await badgeReader.checkNitro(token);
    let values = null;
    if (me.hasNitro) {
        try {
            const read = await badgeReader.readSelf(token, me.userId);
            values = Object.fromEntries(
                Object.entries(read.badges).map(([k, b]) => [
                    k,
                    { value: b.value, currentTier: b.currentTier, owned: b.owned },
                ]),
            );
        } catch {
            values = null;
        }
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
        hypesquadHouse,
        // Chỉ badge tiered mới cần khai, và chỉ khi khách không có Nitro.
        needsDeclaration: !me.hasNitro,
    };
}

// ── Tạo đơn (gọi sau khi thanh toán thành công) ──────────────────────────────────

async function createOrder({
    token,
    badgeKey,
    tierKey,
    declaredValue = null,
    ref = null,
    webhookUrl = null,
    paymentId = null,
}) {
    const me = await badgeReader.checkNitro(token);
    const q = await pricingStore.quote(badgeKey, tierKey, { hasNitro: me.hasNitro });

    const order = {
        orderId: crypto.randomUUID(),
        ref,
        paymentId,
        accountId: me.userId,
        username: me.username,
        hasNitro: me.hasNitro,
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
        declaredValue: Number.isFinite(declaredValue) ? declaredValue : null,
        measuredValue: null,
        measuredAt: null,
        measuredSource: null,
        status: "paid",
        error: null,
        plan: null,
        sent: 0,
        total: 0,
        webhookUrl,
        createdAt: Date.now(),
        paidAt: Date.now(),
        sentAt: null,
        verifyAfter: null,
        verifiedAt: null,
        finalTier: null,
        finalValue: null,
        updatedAt: Date.now(),
    };

    await db.create(MODEL, order);
    _dispatch(order, { type: "order_created", status: "paid" });
    // Chạy nền: người gọi không phải chờ hết cả lượt gửi.
    process(order.orderId).catch(() => {});
    return _shape(order);
}

// ── Chạy đơn ─────────────────────────────────────────────────────────────────────

async function process(orderId) {
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
    if (!order) throw _err("Không tìm thấy đơn", 404);
    if (!["paid", "manual_review", "sending"].includes(order.status)) {
        return _shape(order);
    }

    const token = _decrypt(order);
    if (!token) {
        await _patch(orderId, { status: "error", error: "Không giải mã được token" });
        return _shape(await _get(orderId));
    }

    // ── Badge "choice" (HypeSquad): ăn ngay, đường đi ngắn hẳn ──────────────────
    // Không mốc → không cần đọc trước, không có chuyện mua nhầm mốc đã có (đổi
    // nhà là hành vi hợp lệ kể cả khi đang có nhà khác), không cần reader, và
    // xác minh được ngay bằng chính token khách.
    if (order.kind === "choice") return _processChoice(orderId, order, token);

    // ── Bước 1: đọc giá trị thật ────────────────────────────────────────────────
    await _patch(orderId, { status: "verifying", error: null });
    _dispatch(order, { type: "status", status: "verifying" });

    let read;
    try {
        read = await badgeReader.read({
            token,
            userId: order.accountId,
            hasNitro: order.hasNitro,
            force: true,
        });
    } catch (err) {
        if (err.invalidToken) {
            await _patch(orderId, { status: "token_dead", error: err.message });
            _dispatch(order, { type: "failed", status: "token_dead", error: err.message });
            return _shape(await _get(orderId));
        }
        // Reader chết / rate-limit / 404: KHÔNG tịch thu, KHÔNG gửi. Treo chờ duyệt.
        await _patch(orderId, { status: "manual_review", error: err.message });
        _dispatch(order, { type: "manual_review", status: "manual_review", error: err.message });
        return _shape(await _get(orderId));
    }

    const badge = read.badges[order.badgeKey];
    const measured = badge?.value;
    if (!Number.isFinite(measured)) {
        // Đọc được badge nhưng không suy ra được con số — cũng là chờ duyệt, vì
        // đoán bừa ở đây thì hoặc gửi thừa hoặc tịch thu oan.
        const reason = "Không đọc được con số tiến độ";
        await _patch(orderId, { status: "manual_review", error: reason });
        _dispatch(order, { type: "manual_review", status: "manual_review", error: reason });
        return _shape(await _get(orderId));
    }

    await _patch(orderId, {
        measuredValue: measured,
        measuredAt: Date.now(),
        measuredSource: read.source,
    });

    // ── Bước 2: đã sở hữu mốc rồi thì tịch thu ──────────────────────────────────
    if (measured >= order.threshold) {
        const patch = {
            status: order.forfeitOnWrongTier ? "forfeited" : "refund_due",
            error: `Tài khoản đã đạt mốc ${order.tierName} (${measured} ${order.unit})`,
            finalValue: measured,
            finalTier: badge.currentTier ?? null,
        };
        await _patch(orderId, patch);
        _dispatch(order, {
            type: order.forfeitOnWrongTier ? "forfeited" : "refund_due",
            status: patch.status,
            error: patch.error,
            measuredValue: measured,
            threshold: order.threshold,
            unit: order.unit,
        });
        return _shape(await _get(orderId));
    }

    // ── Bước 3: lập kế hoạch + gửi ──────────────────────────────────────────────
    let plan;
    try {
        plan = await planOrder({
            badgeKey: order.badgeKey,
            threshold: order.threshold,
            current: measured,
            overshoot: order.overshoot,
            claimedGameIds: await _claimedGameIds(order.accountId),
        });
    } catch (err) {
        await _patch(orderId, { status: "manual_review", error: err.message });
        _dispatch(order, { type: "manual_review", status: "manual_review", error: err.message });
        return _shape(await _get(orderId));
    }

    if (!plan.games.length) {
        // Đã đủ rồi mà chưa vượt threshold — hiếm, nhưng đừng gửi rỗng.
        await _patch(orderId, { status: "manual_review", error: "Kế hoạch rỗng" });
        return _shape(await _get(orderId));
    }

    await _patch(orderId, {
        status: "sending",
        plan: {
            gameCount: plan.games.length,
            hoursPerGame: plan.hoursPerGame,
            need: plan.need,
            varietySideEffect: plan.varietySideEffect ?? 0,
        },
        total: plan.games.length,
        sent: 0,
    });
    _dispatch(order, {
        type: "status",
        status: "sending",
        total: plan.games.length,
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
            error: err.message,
        });
        return _shape(await _get(orderId));
    }
    lease.release({ failed: result.aborted });

    if (result.aborted) {
        await _patch(orderId, {
            status: "manual_review",
            sent: result.sent,
            error: `Discord từ chối ở HTTP ${result.status} sau ${result.sent}/${result.total} game`,
        });
        _dispatch(order, { type: "manual_review", status: "manual_review", sent: result.sent });
        return _shape(await _get(orderId));
    }

    await _addClaimedGames(order.accountId, order.username, plan.games.map((g) => g.id));

    const verifyAfter = Date.now() + VERIFY_DELAY_MS;
    await _patch(orderId, {
        status: "sent",
        sent: result.sent,
        sentAt: Date.now(),
        verifyAfter,
        error: null,
    });
    _dispatch(order, {
        type: "sent",
        status: "sent",
        sent: result.sent,
        total: result.total,
        verifyAfter,
    });
    return _shape(await _get(orderId));
}

/**
 * HypeSquad: gọi API đổi nhà, rồi đọc lại profile để chắc chắn nó ăn.
 *
 * Xác minh bằng profile chứ không tin vào mã 204 trả về: đã thấy trường hợp API
 * nhận request nhưng badge không đổi. Đọc profile bằng chính token khách nên
 * không tốn reader, và badge `hypesquad_house_N` hiện với mọi người xem.
 */
async function _processChoice(orderId, order, token) {
    await _patch(orderId, { status: "sending", total: 1, sent: 0, error: null });
    _dispatch(order, { type: "status", status: "sending" });

    const lease = await proxyPool.acquire(order.accountId, { feature: "badge" });
    try {
        await setHypeSquad(token, order.houseId, { agent: lease.agent });
    } catch (err) {
        lease.release({ failed: true });
        const dead = Boolean(err.invalidToken);
        await _patch(orderId, { status: dead ? "token_dead" : "error", error: err.message });
        _dispatch(order, {
            type: "failed",
            status: dead ? "token_dead" : "error",
            error: err.message,
        });
        return _shape(await _get(orderId));
    }
    lease.release();

    await _patch(orderId, { status: "sent", sent: 1, sentAt: Date.now() });

    // Discord cập nhật profile gần như tức thì, nhưng chờ một nhịp cho chắc.
    await new Promise((r) => setTimeout(r, 1500));
    let house = null;
    try {
        house = await badgeReader.readHypeSquadHouse(token, order.accountId);
    } catch {
        // Đọc hỏng thì không kết luận là thất bại — API đã nhận rồi. Để scheduler
        // xác minh lại ở lượt sau.
        await _patch(orderId, {
            verifyAfter: Date.now() + 60_000,
            error: "Chưa xác minh được, sẽ thử lại",
        });
        _dispatch(order, { type: "sent", status: "sent", sent: 1, total: 1 });
        return _shape(await _get(orderId));
    }

    const ok = house === order.houseId;
    await _patch(orderId, {
        status: ok ? "verified" : "verify_failed",
        verifiedAt: Date.now(),
        finalValue: house,
        finalTier: order.tierKey,
        error: ok ? null : `Nhà hiện tại là ${house ?? "không có"}, không phải ${order.tierName}`,
    });
    _dispatch(order, {
        type: ok ? "verified" : "verify_failed",
        status: ok ? "verified" : "verify_failed",
        proof: {
            badge: "hypesquad",
            tierName: order.tierName,
            currentTier: order.tierKey,
            value: house,
            unit: "house",
            infoLabel: ok ? `HypeSquad ${order.tierName}` : null,
            obtainedAt: ok ? new Date().toISOString() : null,
        },
    });
    return _shape(await _get(orderId));
}

// ── Xác minh sau ~1 ngày ─────────────────────────────────────────────────────────

async function verifyOrder(orderId) {
    const order = await _get(orderId);
    if (!order) throw _err("Không tìm thấy đơn", 404);
    if (!["sent", "verify_failed"].includes(order.status)) return _shape(order);

    const token = _decrypt(order);

    // HypeSquad xác minh bằng profile, không phải badge directory.
    if (order.kind === "choice") {
        let house = null;
        try {
            house = await badgeReader.readHypeSquadHouse(token, order.accountId);
        } catch (err) {
            await _patch(orderId, { error: `Xác minh hoãn: ${err.message}` });
            return _shape(await _get(orderId));
        }
        const okHouse = house === order.houseId;
        await _patch(orderId, {
            status: okHouse ? "verified" : "verify_failed",
            verifiedAt: Date.now(),
            finalValue: house,
            finalTier: order.tierKey,
            error: okHouse ? null : `Nhà hiện tại là ${house ?? "không có"}`,
        });
        _dispatch(order, {
            type: okHouse ? "verified" : "verify_failed",
            status: okHouse ? "verified" : "verify_failed",
            proof: {
                badge: "hypesquad",
                tierName: order.tierName,
                currentTier: order.tierKey,
                value: house,
                unit: "house",
                infoLabel: okHouse ? `HypeSquad ${order.tierName}` : null,
            },
        });
        return _shape(await _get(orderId));
    }

    let read;
    try {
        read = await badgeReader.read({
            token,
            userId: order.accountId,
            hasNitro: order.hasNitro,
            force: true,
        });
    } catch (err) {
        // Không đọc được thì cứ để nguyên "sent" và thử lại lượt sau — badge đã
        // gửi rồi, khách không mất gì.
        await _patch(orderId, { error: `Xác minh hoãn: ${err.message}` });
        return _shape(await _get(orderId));
    }

    const badge = read.badges[order.badgeKey];
    const value = badge?.value ?? 0;
    const ok = value >= order.threshold;

    await _patch(orderId, {
        status: ok ? "verified" : "verify_failed",
        verifiedAt: Date.now(),
        finalValue: value,
        finalTier: badge?.currentTier ?? null,
        error: ok ? null : `Mới đạt ${value}/${order.threshold} ${order.unit}`,
    });
    _dispatch(order, {
        type: ok ? "verified" : "verify_failed",
        status: ok ? "verified" : "verify_failed",
        // Badge Proof: đây là thứ khách không Nitro không tự nhìn thấy được.
        proof: {
            badge: order.badgeKey,
            tierName: order.tierName,
            currentTier: badge?.currentTier ?? null,
            value,
            unit: order.unit,
            infoLabel: badge?.infoLabel ?? null,
            obtainedAt: badge?.tierObtainedAt?.[order.tierKey] ?? null,
        },
    });
    return _shape(await _get(orderId));
}

// ── Duyệt tay ────────────────────────────────────────────────────────────────────

/** Duyệt một đơn manual_review: "retry" chạy lại, "forfeit" tịch thu, "cancel" huỷ. */
async function resolveManual(orderId, action) {
    const order = await _get(orderId);
    if (!order) throw _err("Không tìm thấy đơn", 404);
    if (order.status !== "manual_review") throw _err("Đơn không ở trạng thái chờ duyệt");

    if (action === "retry") {
        await _patch(orderId, { status: "paid", error: null });
        return process(orderId);
    }
    if (action === "forfeit") {
        await _patch(orderId, { status: "forfeited", error: "Bị tịch thu khi duyệt tay" });
        _dispatch(order, { type: "forfeited", status: "forfeited" });
        return _shape(await _get(orderId));
    }
    if (action === "cancel") {
        await _patch(orderId, { status: "refund_due", error: "Huỷ khi duyệt tay" });
        _dispatch(order, { type: "refund_due", status: "refund_due" });
        return _shape(await _get(orderId));
    }
    throw _err(`Hành động không hợp lệ: ${action}`);
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

async function listOrders({ ref = null, status = null } = {}) {
    const query = {};
    if (ref) query.ref = ref;
    if (status) query.status = status;
    const rows = await db.find(MODEL, query);
    return (rows ?? []).map(_shape).sort((a, b) => b.createdAt - a.createdAt);
}

async function getOrder(orderId) {
    return _shape(await _get(orderId));
}

// ── Scheduler + khôi phục sau reboot ─────────────────────────────────────────────

async function _tick() {
    const now = Date.now();
    for (const o of (await db.find(MODEL, { status: "sent" })) ?? []) {
        if (o.verifyAfter && o.verifyAfter <= now) {
            await verifyOrder(o.orderId).catch(() => {});
        }
    }
}

/**
 * Đơn đang dở lúc panel restart. "paid"/"verifying" chạy lại từ đầu an toàn vì
 * chưa gửi gì. "sending" thì KHÔNG tự chạy lại — /science cộng dồn, chạy lại là
 * gửi thừa — nên đẩy sang chờ duyệt để bạn nhìn rồi quyết.
 */
async function restoreOrders() {
    const stuck = (await db.find(MODEL, {})) ?? [];
    for (const o of stuck) {
        if (o.status === "paid" || o.status === "verifying") {
            process(o.orderId).catch(() => {});
        } else if (o.status === "sending") {
            await _patch(o.orderId, {
                status: "manual_review",
                error: `Panel restart giữa lúc gửi (${o.sent}/${o.total}). Gửi lại sẽ cộng thừa — kiểm tra rồi quyết.`,
            }).catch(() => {});
        }
    }
}

function start() {
    // Nâng cấp êm: .env cũ còn BADGE_READER_TOKEN thì đưa vào pool một lần.
    badgeReader.importEnvReader().catch(() => {});
    restoreOrders().catch(() => {});
    _tick().catch(() => {});
    setInterval(() => _tick().catch(() => {}), TICK_MS);
}

module.exports = {
    bus,
    check,
    quote,
    createOrder,
    process,
    verifyOrder,
    resolveManual,
    listOrders,
    getOrder,
    restoreOrders,
    start,
};
