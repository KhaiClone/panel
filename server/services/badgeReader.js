/**
 * badgeReader.js
 * Đọc tiến độ badge của một tài khoản Discord — luôn bằng CHÍNH token của nó.
 *
 *   GET /users/@me/badges   — CẢ catalog kèm progress.current, tức con số chính
 *                             xác, kể cả badge chủ acc đã ẩn (`hidden`).
 *
 * Có Nitro hay không đều đọc được (2026-10-21). Ngày 2026-10-17 acc không Nitro
 * còn bị 404 ở mọi đường, nên game badge từng chỉ bán cho Nitro; nay Discord đã
 * mở cho mọi acc tự xem badge của mình, chỉ acc CHƯA TỪNG đạt thành tựu nào là
 * không có danh sách — xem readSelf().
 *
 * Không còn reader (acc Nitro đọc hộ người khác). Đo ngày 2026-10-17: người
 * khác xem thì Discord bỏ hẳn trường `hidden`, nên badge bị ẩn trông y hệt badge
 * chưa sở hữu — đọc hộ là đọc ra 0 rồi gửi thừa. Đọc bằng token chủ acc thì
 * không dính chuyện ẩn badge hay Profile riêng tư.
 */

const axios = require("axios");
const { getBuildNumber } = require("./questEngine");
const { BADGE_CATALOG } = require("./pricingStore");

const API = "https://discord.com/api/v9";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "discord/1.0.9253 Chrome/148.0.7778.280 Electron/42.7.1 Safari/537.36";

// badge_id (số) -> key trong catalog
const BY_ID = Object.fromEntries(
    Object.entries(BADGE_CATALOG).map(([key, cat]) => [cat.badgeId, key]),
);

// Lỗi mang hai câu: `message` tiếng Anh cho panel (lưu vào đơn, hiện trên trang
// /badges), `vi` là câu cũ gửi sang ArnTo-Auto — bot đưa nguyên văn lỗi tới khách
// và coi lỗi 400 có chữ "token" là token chết, nên câu `vi` không được đổi.
function _err(message, status = 502, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

const _tokenDead = () =>
    _err("The token is invalid or dead", 400, {
        invalidToken: true,
        vi: "Token không hợp lệ hoặc đã chết",
    });

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
        // Client thật luôn gửi timezone. Khách của shop ở VN dùng client tiếng
        // Anh — một tổ hợp hoàn toàn bình thường.
        "x-discord-timezone": "Asia/Ho_Chi_Minh",
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

/**
 * Badge nào không xuất hiện thì coi như chưa sở hữu (value 0). Chỉ đúng vì ta
 * luôn đọc bằng token của chủ acc: chủ acc thấy cả badge mình đã ẩn.
 */
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

async function _get(path, token) {
    return axios.get(API + path, {
        headers: await _headers(token),
        timeout: 20_000,
        validateStatus: () => true,
    });
}

/**
 * GET danh sách badge với 1 lần retry.
 *
 * Retry không phải cho lỗi mạng: lần gọi đầu tiên cho một user quan sát được là
 * TRẢ THIẾU badge (chỉ 3/7), lần gọi thứ hai mới đủ — có vẻ Discord dựng cache
 * catalog ngay tại request đầu. Thiếu badge mà tưởng là "chưa sở hữu" thì bot sẽ
 * gửi thừa và khách được nâng cấp miễn phí, nên luôn gọi 2 lần khi lần đầu không
 * thấy badge nào ta quan tâm.
 */
async function _fetchBadges(path, token) {
    let res = await _get(path, token);
    if (res.status === 200 && Array.isArray(res.data?.badges)) {
        const hit = res.data.badges.some((b) => BY_ID[b.badge_id]);
        if (hit) return res;
        await new Promise((r) => setTimeout(r, 900));
        const again = await _get(path, token);
        if (again.status === 200 && Array.isArray(again.data?.badges)) return again;
    }
    return res;
}

// ── Public ───────────────────────────────────────────────────────────────────────

/**
 * Kiểm token + thông tin tài khoản. Tên hàm có từ hồi game badge chỉ bán cho
 * Nitro; giờ `hasNitro` chỉ còn để hiển thị trên đơn.
 */
async function checkNitro(token) {
    const res = await _get("/users/@me", token);
    if (res.status === 401 || res.status === 403) throw _tokenDead();
    if (res.status !== 200) {
        throw _err(`Discord returned HTTP ${res.status}`, 502, { vi: `Discord trả HTTP ${res.status}` });
    }
    return {
        userId: String(res.data.id),
        username: res.data.username ?? "Unknown",
        premiumType: res.data.premium_type ?? 0,
        hasNitro: (res.data.premium_type ?? 0) !== 0,
        // Dùng để gửi /science và /hypesquad với đúng locale/timezone của tài
        // khoản, thay vì một giá trị cố định cho mọi khách.
        locale: res.data.locale ?? null,
    };
}

/**
 * Đọc tiến độ bằng chính token của khách.
 *
 * Đường dẫn có id (`/users/{id}/badges`) trả badge đã sở hữu, vẫn kèm progress
 * khi chính chủ gọi (đo 2026-10-17), nên thử nó khi `@me` trả 404.
 *
 * HAI ĐƯỜNG ĐỀU 404 = TÀI KHOẢN CHƯA CÓ THÀNH TỰU NÀO → mọi badge tính là 0
 * (`source: "empty"`). Người dùng quan sát 2026-10-21: acc không Nitro nay đều tự
 * xem được badge, trừ acc chưa từng đạt thành tựu gì thì Discord không hiện danh
 * sách. Trước đây 404 bị coi là "không đọc được" và chặn bán (đã gặp cả trên acc
 * Nitro `taynhocuto1811`). Nếu sau này thấy một acc 404 mà thật ra đã có tiến
 * độ, đơn của nó sẽ gửi thừa: sửa ở đây, đừng sửa ở nơi gọi.
 */
async function readSelf(token, userId) {
    let res = await _fetchBadges("/users/@me/badges", token);
    if (res.status === 404 && userId) res = await _fetchBadges(`/users/${userId}/badges`, token);
    if (res.status === 401) throw _tokenDead();
    if (res.status === 404) return { userId, source: "empty", badges: _fillMissing({}) };
    if (res.status !== 200 || !Array.isArray(res.data?.badges)) {
        throw _err(`Reading the badges failed (HTTP ${res.status})`, 502, {
            vi: `Đọc badge thất bại (HTTP ${res.status})`,
        });
    }
    const found = {};
    for (const raw of res.data.badges) {
        const n = _normalize(raw);
        if (n) found[n.key] = n;
    }
    return { userId, source: "self", badges: _fillMissing(found) };
}

/**
 * Badge trên PROFILE (khác badge directory).
 *
 * `/users/{id}/profile` trả về mảng badge dạng chuỗi id (`hypesquad_house_3`,
 * `quest_completed`…). `hypesquad_house_N` thì AI CŨNG THẤY — kể cả tài khoản
 * không Nitro tự xem chính mình. Nhờ vậy HypeSquad vẫn bán cho mọi khách.
 *
 * @returns {Promise<string[]>} danh sách badge id
 */
async function readProfileBadges(token, userId) {
    const res = await _get(
        `/users/${userId}/profile?with_mutual_guilds=false&with_mutual_friends=false`,
        token,
    );
    if (res.status === 401 || res.status === 403) throw _tokenDead();
    if (res.status !== 200 || !Array.isArray(res.data?.badges)) {
        throw _err(`Reading the profile failed (HTTP ${res.status})`, 502, {
            vi: `Đọc profile thất bại (HTTP ${res.status})`,
        });
    }
    return res.data.badges.map((b) => b.id);
}

/**
 * Application id của những game khách đã chơi THẬT.
 *
 * `/users/@me/activities/statistics/applications` là kho game-detection qua
 * gateway — khác kho analytics nuôi badge. Nhưng khi khách chơi thật thì client
 * bắn cả hai, nên một game xuất hiện ở đây gần như chắc chắn cũng đã được đếm
 * vào Game Variety. Dùng để dồn giờ Game Time lên game "đã có sẵn" thay vì mở
 * game mới.
 *
 * Chỉ đọc được cho CHÍNH chủ token (không đọc được của người khác), và không
 * cần Nitro.
 */
async function readPlayedApplicationIds(token) {
    const res = await _get("/users/@me/activities/statistics/applications", token);
    if (res.status === 401 || res.status === 403) throw _tokenDead();
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.map((a) => String(a.application_id)).filter(Boolean);
}

/** Tài khoản đang ở nhà HypeSquad nào (1/2/3), hoặc null. */
async function readHypeSquadHouse(token, userId) {
    const ids = await readProfileBadges(token, userId);
    for (const house of [1, 2, 3]) {
        if (ids.includes(`hypesquad_house_${house}`)) return house;
    }
    return null;
}

module.exports = {
    checkNitro,
    readSelf,
    readProfileBadges,
    readPlayedApplicationIds,
    readHypeSquadHouse,
    _parseInfoLabel,
};
