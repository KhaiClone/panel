// ─────────────────────────────────────────────────────────────────────────────
//  Legacy text — errors saved in Vietnamese before the panel went English.
//
//  Since d310d7a (2026-10-20) Auto Quest and Auto Badge store their errors in
//  English, but records written earlier still hold the old Vietnamese text, and
//  the pages showed it as-is ("Token không hợp lệ / đã hết hạn." on /quests).
//  CLAUDE.md rule 29: every value the panel shows is English.
//
//  The data is NOT rewritten. ArnTo-Auto reads the same records through
//  /api/external/* and shows some of these texts to buyers in Vietnamese, so only
//  the panel's own routers translate on the way out (englishJson middleware).
//
//  Each old message is mapped to the exact English the code writes today. A
//  Vietnamese text that matches none of them (from an even older version) gets a
//  plain English notice instead of being shown untranslated.
// ─────────────────────────────────────────────────────────────────────────────

// Quest engine contexts passed to _throwIfUnauthorized → "<ctx> thất bại (<status>)".
const QUEST_CTX = {
    "Lấy danh sách quest": "Fetching the quest list failed",
    "Video progress": "Video progress failed",
    "Video finish": "Video finish failed",
    Heartbeat: "Heartbeat failed",
    "Heartbeat terminal": "Terminal heartbeat failed",
    "Activity heartbeat": "Activity heartbeat failed",
    "Activity terminal": "Terminal activity heartbeat failed",
    "Lấy proxy ticket": "Fetching the proxy ticket failed",
    "Achievement authorize": "Achievement authorize failed",
};

const EXACT = new Map([
    // Auto Quest
    ["Token không hợp lệ / đã hết hạn.", "Discord rejected the token (invalid or expired)."],
    ["Không giải mã được token (đổi secret?).", "Could not decrypt the stored token (secret changed?)."],
    ["Token trống.", "The token is empty."],
    ["Đã dừng theo yêu cầu.", "Stopped on request."],
    ["Token bị từ chối khi enroll (401)", "Discord rejected the token on enroll (401)"],
    // Auto Badge
    ["Token không hợp lệ hoặc đã chết", "The token is invalid or dead"],
    ["Discord không mở danh sách badge cho tài khoản này (HTTP 404)", "Discord does not open this account's badge list (HTTP 404)"],
    ["Danh sách game rỗng", "The game list is empty"],
    ["Không còn game nào để dùng", "No games left to use"],
    ["Không lấy được analytics_token", "Could not get the analytics_token"],
    ["Game Time và Game Variety chỉ bán cho tài khoản có Nitro", "Game Time and Game Variety are sold to Nitro accounts only"],
    [
        "Discord không cho đọc tiến độ badge của tài khoản này nên hiện chưa mua được Game Time / Game Variety",
        "Discord does not show this account's badge progress, so Game Time / Game Variety cannot be bought yet",
    ],
    ["Không giải mã được token", "Could not decrypt the stored token"],
    ["Không đọc được con số tiến độ", "Could not read the progress value"],
    ["Kế hoạch rỗng", "The send plan is empty"],
    ["Bị tịch thu khi duyệt tay", "Forfeited on review"],
    ["Huỷ khi duyệt tay", "Cancelled on review — refund due"],
]);

// [pattern, English]: `$1`… are the captured parts, carried over unchanged.
const PATTERNS = [
    // Auto Quest
    [/^Token không hợp lệ \(HTTP (\d+)\)$/u, "Discord did not accept the token (HTTP $1)"],
    [/^Không kết nối được Discord: (.*)$/su, "Could not reach Discord: $1"],
    [/^"(.*)" đã hết hạn lúc (.*)$/su, '"$1" expired at $2'],
    [/^"(.*)" đứng yên (\d+) phút ở (\S+)$/su, '"$1" made no progress for $2 min at $3'],
    [/^"(.*)" quá (\d+) phút mà chưa xong \((.*)\)$/su, '"$1" still not done after $2 min ($3)'],
    // Auto Badge
    [/^Discord trả HTTP (\d+)$/u, "Discord returned HTTP $1"],
    [/^Đọc badge thất bại \(HTTP (\d+)\)$/u, "Reading the badges failed (HTTP $1)"],
    [/^Đọc profile thất bại \(HTTP (\d+)\)$/u, "Reading the profile failed (HTTP $1)"],
    [/^Không tải được danh sách game \(HTTP (\d+)\)$/u, "Could not load the game list (HTTP $1)"],
    [/^Không đủ game mới: cần (\d+), còn (\d+)$/u, "Not enough new games: $1 needed, $2 left"],
    [/^Badge chưa hỗ trợ gửi: (.*)$/su, "Sending is not supported for this badge: $1"],
    [/^Đổi HypeSquad thất bại \(HTTP (\d+)\)$/u, "Changing the HypeSquad house failed (HTTP $1)"],
    [/^Tài khoản đã đạt mốc (.+) \((.+)\)$/su, "Account already has $1 ($2)"],
    [/^Discord từ chối ở HTTP (\d+) sau (\d+)\/(\d+) game$/u, "Discord refused with HTTP $1 after $2/$3 games"],
    [
        /^Panel restart giữa lúc gửi \((\d+)\/(\d+)\)\. Gửi lại sẽ cộng thừa — kiểm tra rồi quyết\.$/u,
        "The panel restarted mid-send ($1/$2). Sending again would add too much — check first, then decide.",
    ],
];

// Words only Vietnamese sentences use. Diacritics alone are not enough, and neither
// is one such word: an English error may carry a Vietnamese name ("Không Tên is
// already in Bravery"). Every old message has at least two of them.
const VI_WORDS =
    /(?<!\p{L})(không|được|đã|thất bại|lỗi|của|cho|khi|đơn|tài khoản|mốc|hết hạn|trống|chưa|bị|giữa|đọc|gửi|lấy|danh sách|giải mã|kết nối|dừng|yêu cầu|từ chối|duyệt|tịch thu|huỷ|hủy|hợp lệ|này|và|với|rồi|nên|lúc|phút|cần|còn|xác định)(?!\p{L})/giu;
const looksVietnamese = (text) => new Set((text.match(VI_WORDS) ?? []).map((w) => w.toLowerCase())).size >= 2;

const UNKNOWN = "Saved in Vietnamese by an older panel version — no English text is available.";

/** `text` in English: a known old message translated, anything else unchanged. */
function toEnglish(text) {
    if (typeof text !== "string" || !text) return text;
    const exact = EXACT.get(text.trim());
    if (exact) return exact;
    const ctx = text.match(/^(.+) thất bại \((\d+)\)$/u);
    if (ctx && QUEST_CTX[ctx[1]]) return `${QUEST_CTX[ctx[1]]} (${ctx[2]})`;
    for (const [re, en] of PATTERNS) {
        const m = text.match(re);
        if (m) return en.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
    }
    return looksVietnamese(text) ? UNKNOWN : text;
}

/** A deep copy of `value` with every `error` string passed through toEnglish(). */
function englishErrors(value) {
    if (Array.isArray(value)) return value.map(englishErrors);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = k === "error" && typeof v === "string" ? toEnglish(v) : englishErrors(v);
    }
    return out;
}

/** Express middleware for a panel-facing router: every res.json body goes through englishErrors(). */
function englishJson(req, res, next) {
    const json = res.json.bind(res);
    res.json = (body) => json(englishErrors(body));
    next();
}

module.exports = { toEnglish, englishErrors, englishJson, UNKNOWN };
