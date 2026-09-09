/**
 * badgeReader.js
 * Đọc tiến độ badge của một tài khoản Discord.
 *
 * Discord chỉ trả badge directory cho NGƯỜI XEM có Nitro — gate nằm ở phía người
 * gửi request, không phải phía chủ badge. Nên có hai đường đọc:
 *
 *   readSelf(token)    — khách có Nitro: đọc bằng chính token của khách.
 *                        GET /users/@me/badges trả CẢ catalog kèm progress.current,
 *                        tức con số chính xác. Không tốn gì của reader.
 *   readOther(userId)  — khách không Nitro: đọc bằng token reader.
 *                        GET /users/{id}/badges chỉ trả badge ĐÃ SỞ HỮU, và
 *                        progress = null — con số phải parse từ info_label
 *                        ("9,844 games played"). Badge vắng mặt = chưa sở hữu.
 *
 * Reader là tài sản không thay thế được (acc cá nhân có Nitro), nên ở đây:
 *   - chỉ đọc, không bao giờ ghi
 *   - cache theo userId để retry/gọi trùng không phát thêm request
 *   - đi TRỰC TIẾP, không qua proxy, trừ khi bật BADGE_READER_USE_PROXY=1.
 *     Một acc cá nhân có IP ổn định thì bình thường; IP nhảy loạn giữa các proxy
 *     mới là thứ trông giống bot.
 */

const axios = require("axios");
const db = require("../db");
const { getBuildNumber } = require("./questEngine");
const proxyPool = require("./proxyPool");
const readerStore = require("./badgeReaderStore");
const { BADGE_CATALOG } = require("./pricingStore");

const CACHE_KEY = "badge_reads";
const CACHE_TTL = 10 * 60_000; // đủ để gộp retry, đủ ngắn để không bao giờ báo số cũ
const API = "https://discord.com/api/v9";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "discord/1.0.9253 Chrome/148.0.7778.280 Electron/42.7.1 Safari/537.36";

// badge_id (số) -> key trong catalog
const BY_ID = Object.fromEntries(
    Object.entries(BADGE_CATALOG).map(([key, cat]) => [cat.badgeId, key]),
);

function _err(message, status = 502, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

function _superProps(buildNumber) {
    return Buffer.from(
        JSON.stringify({
            os: "Windows",
            browser: "Discord Client",
            release_channel: "stable",
            client_version: "1.0.9253",
            os_version: "10.0.26200",
            os_arch: "x64",
            app_arch: "x64",
            system_locale: "en-US",
            has_client_mods: false,
            browser_user_agent: USER_AGENT,
            browser_version: "42.7.1",
            os_sdk_version: "26200",
            client_build_number: buildNumber,
            native_build_number: 88414,
            client_event_source: null,
            client_app_state: "focused",
        }),
        "utf8",
    ).toString("base64");
}

async function _headers(token) {
    return {
        authorization: token,
        "user-agent": USER_AGENT,
        "x-super-properties": _superProps(await getBuildNumber()),
        // Pin locale: info_label là chuỗi đã format ("9,844 games played"). Đổi
        // locale là đổi dấu phân cách, và parse sẽ sai.
        "x-discord-locale": "en-US",
        "accept-language": "en-US",
        accept: "*/*",
        origin: "https://discord.com",
        referer: "https://discord.com/channels/@me",
    };
}

/** "19,776 hours of games played" -> 19776. Không có số thì null. */
function _parseInfoLabel(label) {
    if (typeof label !== "string") return null;
    const m = label.replace(/[, \s](?=\d)/g, "").match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
}

/** Chuẩn hoá một badge từ API về đúng thứ engine cần. */
function _normalize(raw) {
    const key = BY_ID[raw.badge_id];
    if (!key) return null;
    const value =
        Number.isFinite(raw.progress?.[0]?.current)
            ? raw.progress[0].current
            : _parseInfoLabel(raw.info_label);
    return {
        key,
        badgeId: raw.badge_id,
        owned: Boolean(raw.owned),
        currentTier: raw.current_tier ?? null,
        nextTier: raw.next_tier ?? null,
        // null nghĩa là "đọc được badge nhưng không suy ra được con số" — khác hẳn
        // 0. Nơi gọi phải phân biệt, đừng coi null là chưa chơi gì.
        value: Number.isFinite(value) ? value : null,
        infoLabel: raw.info_label ?? null,
        tierObtainedAt: raw.tier_obtained_at ?? {},
    };
}

/** Badge nào không xuất hiện thì coi như chưa sở hữu (value 0). */
function _fillMissing(found) {
    const out = {};
    for (const key of Object.keys(BADGE_CATALOG)) {
        out[key] = found[key] ?? {
            key,
            badgeId: BADGE_CATALOG[key].badgeId,
            owned: false,
            currentTier: null,
            nextTier: null,
            value: 0,
            infoLabel: null,
            tierObtainedAt: {},
        };
    }
    return out;
}

async function _get(path, token, agent) {
    return axios.get(API + path, {
        headers: await _headers(token),
        timeout: 20_000,
        validateStatus: () => true,
        ...(agent ? { httpsAgent: agent, proxy: false } : {}),
    });
}

/**
 * GET /users/{id}/badges với 1 lần retry.
 *
 * Retry không phải cho lỗi mạng: lần gọi đầu tiên cho một user quan sát được là
 * TRẢ THIẾU badge (chỉ 3/7), lần gọi thứ hai mới đủ — có vẻ Discord dựng cache
 * catalog cho người xem ngay tại request đầu. Thiếu badge mà tưởng là "chưa sở
 * hữu" thì bot sẽ gửi thừa và khách được nâng cấp miễn phí, nên luôn gọi 2 lần
 * khi lần đầu không thấy badge nào ta quan tâm.
 */
async function _fetchBadges(path, token, agent) {
    let res = await _get(path, token, agent);
    if (res.status === 200 && Array.isArray(res.data?.badges)) {
        const hit = res.data.badges.some((b) => BY_ID[b.badge_id]);
        if (hit) return res;
        await new Promise((r) => setTimeout(r, 900));
        const again = await _get(path, token, agent);
        if (again.status === 200 && Array.isArray(again.data?.badges)) return again;
    }
    return res;
}

// ── Cache ────────────────────────────────────────────────────────────────────────

async function _cacheGet(userId) {
    const all = (await db.get(CACHE_KEY)) || {};
    const hit = all[userId];
    if (!hit || Date.now() - hit.at > CACHE_TTL) return null;
    return hit.result;
}

async function _cacheSet(userId, result) {
    const all = (await db.get(CACHE_KEY)) || {};
    // Dọn bản ghi hết hạn ngay lúc ghi, khỏi cần job riêng.
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) {
        if (now - v.at > CACHE_TTL) delete all[k];
    }
    all[userId] = { at: now, result };
    await db.set(CACHE_KEY, all);
}

// ── Public ───────────────────────────────────────────────────────────────────────

/** Token này có Nitro không (quyết định đọc bằng đường nào). */
async function checkNitro(token) {
    const res = await _get("/users/@me", token, null);
    if (res.status === 401 || res.status === 403) {
        throw _err("Token không hợp lệ hoặc đã chết", 400, { invalidToken: true });
    }
    if (res.status !== 200) throw _err(`Discord trả HTTP ${res.status}`);
    return {
        userId: String(res.data.id),
        username: res.data.username ?? "Unknown",
        premiumType: res.data.premium_type ?? 0,
        hasNitro: (res.data.premium_type ?? 0) !== 0,
    };
}

/** Đọc bằng chính token của khách. Chỉ dùng được khi khách có Nitro. */
async function readSelf(token, userId) {
    const res = await _fetchBadges("/users/@me/badges", token, null);
    if (res.status === 404) {
        throw _err("Tài khoản này không đọc được badge directory (cần Nitro)", 400, {
            needsNitro: true,
        });
    }
    if (res.status !== 200 || !Array.isArray(res.data?.badges)) {
        throw _err(`Đọc badge thất bại (HTTP ${res.status})`);
    }
    const found = {};
    for (const raw of res.data.badges) {
        const n = _normalize(raw);
        if (n) found[n.key] = n;
    }
    return { userId, source: "self", badges: _fillMissing(found) };
}

/**
 * Đọc badge của người khác bằng một reader trong pool.
 *
 * Đây là con đường DUY NHẤT tiêu tài nguyên acc của bạn — mỗi lần gọi là một
 * request phát ra từ acc thật. Chỉ gọi sau khi khách đã thanh toán.
 *
 * Một token hỏng KHÔNG được làm hỏng đơn hàng: reader chết hoặc bị rate-limit
 * thì đánh dấu rồi bốc reader khác trong pool thử lại. Chỉ khi hết sạch reader
 * khoẻ mới ném readerDown (→ đơn treo ở manual_review, không tịch thu).
 */
async function readOther(userId, { force = false } = {}) {
    if (!force) {
        const cached = await _cacheGet(userId);
        if (cached) return { ...cached, cached: true };
    }

    const tried = [];
    let lastError = null;

    // Nhiều nhất 3 reader cho một lượt đọc. Thử mãi chỉ tổ đốt cả pool khi sự cố
    // nằm ở phía Discord chứ không phải ở token.
    for (let attempt = 0; attempt < 3; attempt++) {
        const reader = await readerStore.pick({ exclude: tried });
        if (!reader) break;
        tried.push(reader.id);

        let lease = null;
        let agent = null;
        if (process.env.BADGE_READER_USE_PROXY === "1") {
            lease = await proxyPool.acquire(`badge-reader-${reader.id}`, { feature: "badge" });
            agent = lease.agent;
        }

        try {
            const res = await _fetchBadges(`/users/${userId}/badges`, reader.token, agent);

            if (res.status === 401 || res.status === 403) {
                await readerStore.markFailure(reader.id, "dead", `HTTP ${res.status}`);
                lastError = `Reader ${reader.username} đã chết`;
                continue;
            }
            if (res.status === 429) {
                await readerStore.markFailure(reader.id, "rate_limited", "HTTP 429");
                lastError = `Reader ${reader.username} bị rate-limit`;
                continue;
            }
            if (res.status === 404) {
                // Nhập nhằng cố ý không đoán: có thể reader mất Nitro, có thể user
                // id sai. Cả hai đều KHÔNG được hiểu thành "khách chưa có badge
                // nào" — hiểu sai kiểu đó là tịch thu tiền oan hoặc gửi thừa.
                // Thử reader khác: nếu cái nào cũng 404 thì mới là id sai thật.
                await readerStore.markFailure(reader.id, "soft", "HTTP 404");
                lastError =
                    "Không đọc được badge — reader mất quyền hoặc user id không tồn tại";
                continue;
            }
            if (res.status !== 200 || !Array.isArray(res.data?.badges)) {
                await readerStore.markFailure(reader.id, "soft", `HTTP ${res.status}`);
                lastError = `Đọc badge thất bại (HTTP ${res.status})`;
                continue;
            }

            const found = {};
            for (const raw of res.data.badges) {
                const n = _normalize(raw);
                if (n) found[n.key] = n;
            }
            const result = {
                userId,
                source: "reader",
                readerId: reader.id,
                badges: _fillMissing(found),
            };
            await readerStore.markUsed(reader.id);
            await _cacheSet(userId, result);
            return result;
        } catch (err) {
            await readerStore.markFailure(reader.id, "soft", err.message);
            lastError = err.message;
        } finally {
            lease?.release();
        }
    }

    if (tried.length) {
        throw _err(`${lastError} (đã thử ${tried.length} reader)`, 503, { readerDown: true });
    }
    // pick() không trả gì ngay từ đầu: phân biệt "chưa thêm reader nào" với "có
    // reader nhưng đang nghỉ / bị tắt" — hai cái cần hành động khác hẳn nhau.
    const sum = await readerStore.summary();
    throw _err(
        sum.total
            ? `Không còn reader nào khả dụng lúc này (${sum.total} reader, ${sum.healthy} khoẻ) — có thể đang nghỉ sau rate-limit`
            : "Chưa thêm reader nào — vào trang Badges thêm một tài khoản có Nitro",
        503,
        { readerDown: true },
    );
}

/**
 * Đọc theo đường rẻ nhất có thể: có token + có Nitro thì tự đọc, còn lại mới
 * nhờ reader.
 */
async function read({ token = null, userId = null, hasNitro = null, force = false } = {}) {
    if (token) {
        const me = hasNitro === null ? await checkNitro(token) : { userId, hasNitro };
        const id = me.userId ?? userId;
        if (me.hasNitro) return readSelf(token, id);
        return readOther(id, { force });
    }
    if (!userId) throw _err("Cần token hoặc userId", 400);
    return readOther(userId, { force });
}

/**
 * Badge trên PROFILE (khác badge directory).
 *
 * `/users/{id}/profile` trả về mảng badge dạng chuỗi id (`hypesquad_house_3`,
 * `quest_completed`…). Với badge tiered thì endpoint này bị lọc theo Nitro của
 * người xem, nhưng `hypesquad_house_N` thì AI CŨNG THẤY — kể cả tài khoản không
 * Nitro tự xem chính mình. Nhờ vậy xác minh HypeSquad không tốn reader lần nào.
 *
 * @returns {Promise<string[]>} danh sách badge id
 */
async function readProfileBadges(token, userId) {
    const res = await _get(
        `/users/${userId}/profile?with_mutual_guilds=false&with_mutual_friends=false`,
        token,
        null,
    );
    if (res.status === 401 || res.status === 403) {
        throw _err("Token không hợp lệ hoặc đã chết", 400, { invalidToken: true });
    }
    if (res.status !== 200 || !Array.isArray(res.data?.badges)) {
        throw _err(`Đọc profile thất bại (HTTP ${res.status})`);
    }
    return res.data.badges.map((b) => b.id);
}

/** Tài khoản đang ở nhà HypeSquad nào (1/2/3), hoặc null. */
async function readHypeSquadHouse(token, userId) {
    const ids = await readProfileBadges(token, userId);
    for (const house of [1, 2, 3]) {
        if (ids.includes(`hypesquad_house_${house}`)) return house;
    }
    return null;
}

// ── Quản lý pool reader ──────────────────────────────────────────────────────────

/** Thêm một reader: xác thực token trước, rồi mới lưu. */
async function addReader(token, label) {
    const me = await checkNitro(token);
    if (!me.hasNitro) {
        throw _err(
            `${me.username} không có Nitro — tài khoản này không đọc được badge của người khác`,
            400,
        );
    }
    return readerStore.add({
        token,
        label,
        accountId: me.userId,
        username: me.username,
        premiumType: me.premiumType,
    });
}

/** Thay token cho một reader đã có (token cũ hết hạn nhưng vẫn là acc đó). */
async function replaceReaderToken(id, token) {
    const me = await checkNitro(token);
    return readerStore.replaceToken(id, {
        token,
        accountId: me.userId,
        username: me.username,
        premiumType: me.premiumType,
    });
}

/** Hỏi lại Discord xem một reader còn dùng được không, rồi cập nhật trạng thái. */
async function verifyReader(id) {
    const token = await readerStore.getToken(id);
    if (!token) throw _err("Không tìm thấy reader", 404);
    try {
        const me = await checkNitro(token);
        return readerStore.markChecked(id, {
            ok: me.hasNitro,
            premiumType: me.premiumType,
            username: me.username,
            error: me.hasNitro ? null : "Tài khoản không còn Nitro",
        });
    } catch (err) {
        return readerStore.markChecked(id, {
            ok: false,
            premiumType: null,
            error: err.message,
        });
    }
}

/** Kiểm tra lại toàn bộ pool. */
async function verifyAllReaders() {
    const rows = await readerStore.list();
    const out = [];
    for (const r of rows) out.push(await verifyReader(r.id));
    return out;
}

/** Tóm tắt pool cho trang admin và health check. */
async function readerStatus() {
    return { ...(await readerStore.summary()), readers: await readerStore.list() };
}

/**
 * Nếu .env còn BADGE_READER_TOKEN từ trước thì nhập nó vào pool một lần, để
 * không ai phải cấu hình lại tay khi nâng cấp. Sau đó pool là nguồn duy nhất.
 */
async function importEnvReader() {
    const token = process.env.BADGE_READER_TOKEN;
    if (!token) return null;
    const existing = await readerStore.list();
    if (existing.length) return null;
    try {
        return await addReader(token, "Nhập từ .env");
    } catch {
        return null;
    }
}

module.exports = {
    checkNitro,
    readProfileBadges,
    readHypeSquadHouse,
    read,
    readSelf,
    readOther,
    readerStatus,
    addReader,
    replaceReaderToken,
    verifyReader,
    verifyAllReaders,
    importEnvReader,
    _parseInfoLabel,
};
