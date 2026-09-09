/**
 * badgeReaderStore.js
 * Kho token reader — những tài khoản Discord CÓ NITRO dùng để đọc badge của khách.
 *
 * Nhập từ trang /badges chứ không phải .env: reader là hàng tiêu hao (mất Nitro,
 * bị khoá, hết hạn) và bạn sẽ muốn thêm/bớt mà không phải sửa file rồi restart.
 *
 * Chọn NGẪU NHIÊN trong số reader còn khoẻ, không round-robin. Round-robin tạo ra
 * nhịp đều đặn giữa các acc — đúng thứ hệ thống chống bot để ý. Ngẫu nhiên cũng
 * rải tải đều tương đương khi số lượt đủ lớn.
 *
 * File này CỐ Ý không gọi Discord: nó chỉ lưu trữ và chọn. Việc xác thực token
 * nằm ở badgeReader.js, tránh phụ thuộc vòng giữa hai module.
 *
 * DB model `badge_readers` — xem _public() ở cuối file.
 */

const crypto = require("crypto");
const db = require("../db");

const MODEL = "badge_readers";

// 429 thì nghỉ 15 phút rồi thử lại — rate limit của Discord theo cửa sổ ngắn.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
// Lỗi lạ (mạng, 5xx) thì nghỉ ngắn thôi, đừng loại vội một acc còn tốt.
const SOFT_COOLDOWN_MS = 60_000;

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

function _err(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/** Không bao giờ để token ra khỏi module này. */
function _public(r) {
    if (!r) return null;
    const { tokenEncrypted: _a, tokenIv: _b, tokenTag: _c, ...rest } = r;
    return {
        ...rest,
        healthy: isHealthy(r),
        onCooldown: Boolean(r.cooldownUntil && r.cooldownUntil > Date.now()),
    };
}

function isHealthy(r) {
    if (!r?.enabled) return false;
    if (r.status !== "ok") return false;
    if (r.cooldownUntil && r.cooldownUntil > Date.now()) return false;
    return true;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────────

async function list() {
    const rows = (await db.find(MODEL, {})) ?? [];
    return rows.map(_public).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

async function get(id) {
    return db.findOne(MODEL, { id });
}

async function getToken(id) {
    const rec = await get(id);
    return rec ? _decrypt(rec) : null;
}

/**
 * Thêm reader. Người gọi (badgeReader.addReader) phải xác thực token trước và
 * truyền vào accountId/username/premiumType — store không tự gọi Discord.
 */
async function add({ token, label, accountId, username, premiumType }) {
    const existing = (await db.find(MODEL, {})) ?? [];
    if (existing.some((r) => r.accountId === accountId)) {
        throw _err(`Tài khoản ${username} (${accountId}) đã có trong danh sách`, 409);
    }
    const rec = {
        id: crypto.randomUUID().slice(0, 8),
        label: (label || username || "reader").slice(0, 60),
        ...(_encrypt(token)),
        accountId,
        username,
        premiumType,
        enabled: true,
        status: premiumType ? "ok" : "no_nitro",
        lastError: premiumType ? null : "Tài khoản không có Nitro",
        lastCheckedAt: Date.now(),
        lastUsedAt: null,
        cooldownUntil: null,
        uses: 0,
        failures: 0,
        addedAt: Date.now(),
        updatedAt: Date.now(),
    };
    await db.create(MODEL, rec);
    return _public(rec);
}

/** Cập nhật token của một reader đã có (khi token cũ hết hạn, khỏi phải xoá thêm lại). */
async function replaceToken(id, { token, accountId, username, premiumType }) {
    const rec = await get(id);
    if (!rec) throw _err("Không tìm thấy reader", 404);
    if (rec.accountId !== accountId) {
        throw _err(`Token này thuộc tài khoản khác (${username})`, 409);
    }
    await db.findOneAndUpdate(MODEL, { id }, {
        ...(_encrypt(token)),
        premiumType,
        username,
        status: premiumType ? "ok" : "no_nitro",
        lastError: premiumType ? null : "Tài khoản không có Nitro",
        lastCheckedAt: Date.now(),
        cooldownUntil: null,
        failures: 0,
        updatedAt: Date.now(),
    });
    return _public(await get(id));
}

async function update(id, patch = {}) {
    const rec = await get(id);
    if (!rec) throw _err("Không tìm thấy reader", 404);
    const data = { updatedAt: Date.now() };
    if ("label" in patch) data.label = String(patch.label).slice(0, 60);
    if ("enabled" in patch) {
        data.enabled = Boolean(patch.enabled);
        // Bật lại tay thì xoá cooldown — coi như bạn đã kiểm tra rồi.
        if (data.enabled) data.cooldownUntil = null;
    }
    await db.findOneAndUpdate(MODEL, { id }, data);
    return _public(await get(id));
}

async function remove(id) {
    const rec = await get(id);
    if (!rec) throw _err("Không tìm thấy reader", 404);
    await db.findOneAndDelete(MODEL, { id });
    return true;
}

/** badgeReader.verifyReader() gọi vào đây sau khi hỏi Discord xong. */
async function markChecked(id, { ok, premiumType, username, error }) {
    await db.findOneAndUpdate(MODEL, { id }, {
        status: ok ? "ok" : premiumType === 0 ? "no_nitro" : "dead",
        premiumType: premiumType ?? null,
        ...(username ? { username } : {}),
        lastError: ok ? null : (error ?? null),
        lastCheckedAt: Date.now(),
        ...(ok ? { cooldownUntil: null, failures: 0 } : {}),
        updatedAt: Date.now(),
    });
    return _public(await get(id));
}

// ── Chọn ─────────────────────────────────────────────────────────────────────────

/**
 * Một reader khoẻ, chọn ngẫu nhiên. `exclude` để thử reader khác sau khi cái
 * trước hỏng giữa chừng.
 * @returns {Promise<{id, token, username} | null>}
 */
async function pick({ exclude = [] } = {}) {
    const rows = (await db.find(MODEL, {})) ?? [];
    const pool = rows.filter((r) => isHealthy(r) && !exclude.includes(r.id));
    if (!pool.length) return null;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const token = _decrypt(chosen);
    if (!token) {
        // Giải mã hỏng (đổi QUEST_ENC_SECRET chẳng hạn) — loại ra rồi thử tiếp.
        await db.findOneAndUpdate(MODEL, { id: chosen.id }, {
            status: "dead",
            lastError: "Không giải mã được token",
            updatedAt: Date.now(),
        });
        return pick({ exclude: [...exclude, chosen.id] });
    }
    return { id: chosen.id, token, username: chosen.username };
}

async function markUsed(id) {
    const rec = await get(id);
    if (!rec) return;
    await db.findOneAndUpdate(MODEL, { id }, {
        uses: (rec.uses ?? 0) + 1,
        lastUsedAt: Date.now(),
        updatedAt: Date.now(),
    });
}

/**
 * @param {"dead"|"rate_limited"|"soft"} kind
 *   dead         → tắt hẳn, cần bạn thay token
 *   rate_limited → nghỉ 15 phút rồi tự dùng lại
 *   soft         → lỗi lạ, nghỉ 1 phút
 */
async function markFailure(id, kind, message) {
    const rec = await get(id);
    if (!rec) return;
    const data = {
        failures: (rec.failures ?? 0) + 1,
        lastError: message ?? kind,
        updatedAt: Date.now(),
    };
    if (kind === "dead") {
        data.status = "dead";
        data.enabled = false;
    } else if (kind === "rate_limited") {
        data.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    } else {
        data.cooldownUntil = Date.now() + SOFT_COOLDOWN_MS;
    }
    await db.findOneAndUpdate(MODEL, { id }, data);
}

/** Tóm tắt cho trang /badges và health check. */
async function summary() {
    const rows = (await db.find(MODEL, {})) ?? [];
    const healthy = rows.filter(isHealthy);
    return {
        total: rows.length,
        healthy: healthy.length,
        configured: rows.length > 0,
        ok: healthy.length > 0,
        reason: rows.length
            ? healthy.length
                ? null
                : "Không còn reader nào dùng được"
            : "Chưa thêm reader nào",
    };
}

module.exports = {
    list,
    get,
    getToken,
    add,
    replaceToken,
    update,
    remove,
    markChecked,
    pick,
    markUsed,
    markFailure,
    summary,
    isHealthy,
    RATE_LIMIT_COOLDOWN_MS,
};
