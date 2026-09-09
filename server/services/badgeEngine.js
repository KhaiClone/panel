/**
 * badgeEngine.js
 * Bơm playtime giả vào /api/v9/science để đẩy badge Game Time / Game Variety.
 *
 * Endpoint analytics của Discord nhận đúng hai event mà client thật gửi khi bạn
 * chơi game: `launch_game` và `running_game_heartbeat`. `duration_tracked_ms`
 * không được validate, nên số nào cũng qua. Badge được tính từ kho analytics này
 * — KHÔNG phải từ /users/@me/activities/statistics/applications (kho đó do
 * game-detection qua gateway nuôi và sẽ không bao giờ thấy dữ liệu ở đây).
 *
 * Đã xác minh 2026-09-05 trên acc thật: gửi 10.448 game × 2h → hôm sau badge lên
 * `eternal` + `universalist`, credit ~94%.
 *
 * HAI BADGE ẢNH HƯỞNG LẪN NHAU. Mỗi game gửi đi vừa cộng vào Game Variety (số
 * game) vừa cộng vào Game Time (số giờ). Nên:
 *   - Bán Game Variety  → nhiều game, mỗi game 1 phút (giờ tăng không đáng kể).
 *   - Bán Game Time     → dồn giờ lên ÍT game nhất có thể, và ưu tiên game tài
 *                         khoản đã claim ở đơn trước (claimedGameIds) để số game
 *                         không nhích lên. Đơn đầu tiên không tránh được việc mở
 *                         vài game mới — xem GAME_TIME_SPREAD.
 */

const axios = require("axios");
const crypto = require("crypto");
const { getBuildNumber } = require("./questEngine");

const API = "https://discord.com/api/v9";
const SCIENCE_URL = `${API}/science`;
const ME_URL = `${API}/users/@me?with_analytics_token=true`;
const GAMES_URL = `${API}/applications/detectable`;

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "discord/1.0.9253 Chrome/148.0.7778.280 Electron/42.7.1 Safari/537.36";

// Giữ nguyên nhịp của bản đã chạy thành công: 50 game/request (150 event), nghỉ 300ms.
const BATCH_SIZE = 50;
const BATCH_DELAY = 300;

// Số game dùng để rải giờ cho một đơn Game Time thuần. Càng ít thì Game Variety
// càng ít bị đẩy theo (khách khỏi được nâng cấp miễn phí), nhưng dồn 5.000h lên
// 1 game thì trông bất thường hơn. 5 là điểm cân bằng; chỉnh được qua tham số.
const GAME_TIME_SPREAD = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Client thật gửi locale và timezone của chính máy người dùng, và hai thứ đó khớp
// với cài đặt tài khoản. Ta lấy locale thật từ /users/@me rồi suy ra timezone —
// hardcode một giá trị cố định cho mọi khách là thứ dễ nhận ra nhất khi đối soát.
// Mặc định Asia/Ho_Chi_Minh vì khách chủ yếu ở VN.
const DEFAULT_LOCALE = "en-US";
const DEFAULT_TZ = "Asia/Ho_Chi_Minh";
const LOCALE_TZ = {
    vi: "Asia/Ho_Chi_Minh",
    th: "Asia/Bangkok",
    id: "Asia/Jakarta",
    ja: "Asia/Tokyo",
    ko: "Asia/Seoul",
    "zh-CN": "Asia/Shanghai",
    "zh-TW": "Asia/Taipei",
    "en-US": "America/New_York",
    "en-GB": "Europe/London",
    de: "Europe/Berlin",
    fr: "Europe/Paris",
    "es-ES": "Europe/Madrid",
    it: "Europe/Rome",
    nl: "Europe/Amsterdam",
    pl: "Europe/Warsaw",
    "pt-BR": "America/Sao_Paulo",
    ru: "Europe/Moscow",
    tr: "Europe/Istanbul",
};

function _tzFor(locale) {
    return LOCALE_TZ[locale] ?? DEFAULT_TZ;
}

function _err(message, status = 502, extra = {}) {
    const e = new Error(message);
    e.status = status;
    Object.assign(e, extra);
    return e;
}

function _superProps(buildNumber, session, locale = DEFAULT_LOCALE) {
    return Buffer.from(
        JSON.stringify({
            os: "Windows",
            browser: "Discord Client",
            release_channel: "stable",
            client_version: "1.0.9253",
            os_version: "10.0.26200",
            os_arch: "x64",
            app_arch: "x64",
            system_locale: locale,
            has_client_mods: false,
            browser_user_agent: USER_AGENT,
            browser_version: "42.7.1",
            os_sdk_version: "26200",
            client_build_number: buildNumber,
            native_build_number: 88414,
            client_event_source: null,
            client_app_state: "focused",
            client_launch_id: crypto.randomUUID(),
            launch_signature: session.launchSignature,
            client_heartbeat_session_id: session.heartbeatSession,
        }),
        "utf8",
    ).toString("base64");
}

// ── Danh sách game detectable ────────────────────────────────────────────────────

let gamesCache = { list: null, at: 0 };
const GAMES_TTL = 12 * 60 * 60_000;

/** Game detectable có exe win32 — chỉ những game này mới dựng được event hợp lệ. */
async function loadGames() {
    if (gamesCache.list && Date.now() - gamesCache.at < GAMES_TTL) return gamesCache.list;
    const res = await axios.get(GAMES_URL, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 30_000,
        validateStatus: () => true,
    });
    if (res.status !== 200 || !Array.isArray(res.data)) {
        throw _err(`Không tải được danh sách game (HTTP ${res.status})`);
    }
    const seen = new Set();
    const list = [];
    for (const entry of res.data) {
        const id = String(entry?.id ?? "");
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        const exe = (entry.executables ?? []).find((e) => e.os === "win32" && e.name);
        if (!exe) continue;
        seen.add(id);
        list.push({ id, name: entry.name ?? "Unknown", exe: exe.name });
    }
    if (!list.length) throw _err("Danh sách game rỗng");
    gamesCache = { list, at: Date.now() };
    return list;
}

// ── Lập kế hoạch cho một đơn ─────────────────────────────────────────────────────

/**
 * Từ mốc đích + giá trị hiện tại → chính xác cần gửi những game nào, mỗi game
 * bao nhiêu giờ.
 *
 * `current` PHẢI là số reader đọc được, không phải lời khai của khách — đó là
 * chỗ bịt lỗ hổng khai thấp để ăn nâng cấp miễn phí.
 */
async function planOrder({
    badgeKey,
    threshold,
    current = 0,
    overshoot = 1.1,
    claimedGameIds = [],
    spread = GAME_TIME_SPREAD,
}) {
    const games = await loadGames();
    const claimed = new Set(claimedGameIds.map(String));
    const byId = new Map(games.map((g) => [g.id, g]));

    if (badgeKey === "game_variety") {
        const need = Math.ceil(Math.max(0, threshold - current) * overshoot);
        if (need <= 0) return { games: [], hoursPerGame: 0, need: 0, badgeKey };
        // Game MỚI — game đã claim rồi thì không cộng thêm vào số lượng nữa.
        const fresh = games.filter((g) => !claimed.has(g.id)).slice(0, need);
        if (fresh.length < need) {
            throw _err(
                `Không đủ game mới: cần ${need}, còn ${fresh.length}`,
                409,
                { exhausted: true },
            );
        }
        // 1 phút mỗi game: đủ để tính là "đã chơi", cộng vào Game Time không đáng kể.
        return { games: fresh, hoursPerGame: 1 / 60, need, badgeKey };
    }

    if (badgeKey === "game_time") {
        const needHours = Math.ceil(Math.max(0, threshold - current) * overshoot);
        if (needHours <= 0) return { games: [], hoursPerGame: 0, need: 0, badgeKey };
        // Ưu tiên game đã claim: dồn giờ lên đó thì Game Variety đứng yên.
        const reused = claimedGameIds.map((id) => byId.get(String(id))).filter(Boolean);
        let pool = reused.slice(0, spread);
        if (pool.length < spread) {
            const fresh = games.filter((g) => !claimed.has(g.id));
            pool = pool.concat(fresh.slice(0, spread - pool.length));
        }
        if (!pool.length) throw _err("Không chọn được game nào", 409);
        return {
            games: pool,
            hoursPerGame: needHours / pool.length,
            need: needHours,
            badgeKey,
            // Bao nhiêu game MỚI bị mở ra — tức Game Variety sẽ nhích thêm bấy nhiêu.
            varietySideEffect: pool.filter((g) => !claimed.has(g.id)).length,
        };
    }

    throw _err(`Badge chưa hỗ trợ gửi: ${badgeKey}`, 400);
}

// ── Sender ───────────────────────────────────────────────────────────────────────

class BadgeSender {
    /**
     * @param {string} token   token Discord của khách
     * @param {object} opts
     * @param {object} [opts.agent]   httpsAgent từ proxyPool
     * @param {string} [opts.cookie]  header cookie đầy đủ (cf_clearance) nếu cần
     */
    constructor(token, { agent = null, cookie = "" } = {}) {
        this.token = String(token).trim();
        this.agent = agent;
        this.cookie = cookie;
        this.analyticsToken = null;
        this.buildNumber = null;
        // Locale thật của tài khoản, lấy ở init(). Trước đó dùng mặc định vì
        // chính lời gọi /users/@me cũng cần super_props.
        this.locale = DEFAULT_LOCALE;
        this.session = {
            heartbeatSession: crypto.randomUUID(),
            launchSignature: crypto.randomUUID(),
        };
        // Client thật đánh số tăng dần suốt phiên; giữ nguyên hành vi đó.
        this.seq = 0;
    }

    get _proxyCfg() {
        return this.agent ? { httpsAgent: this.agent, proxy: false } : {};
    }

    /** Lấy analytics_token — đây mới là token /science thực sự kiểm tra. */
    async init() {
        this.buildNumber = await getBuildNumber();
        const res = await axios.get(ME_URL, {
            headers: {
                authorization: this.token,
                "user-agent": USER_AGENT,
                "x-super-properties": _superProps(this.buildNumber, this.session),
            },
            timeout: 15_000,
            validateStatus: () => true,
            ...this._proxyCfg,
        });
        if (res.status === 401 || res.status === 403) {
            throw _err("Token không hợp lệ hoặc đã chết", 400, { invalidToken: true });
        }
        if (res.status !== 200) throw _err(`Discord trả HTTP ${res.status}`);
        if (!res.data?.analytics_token) throw _err("Không lấy được analytics_token");
        this.analyticsToken = res.data.analytics_token;
        if (res.data.locale) this.locale = res.data.locale;
        return {
            userId: String(res.data.id),
            username: res.data.username ?? "Unknown",
            hasNitro: (res.data.premium_type ?? 0) !== 0,
            locale: this.locale,
        };
    }

    _next() {
        return ++this.seq;
    }

    _launch(game) {
        const now = Date.now();
        return {
            type: "launch_game",
            properties: {
                client_track_timestamp: now,
                client_heartbeat_session_id: this.session.heartbeatSession,
                event_sequence_number: this._next(),
                game: game.name,
                game_id: game.id,
                verified: true,
                elevated: false,
                is_launcher: false,
                game_platform: "desktop",
                detection_method: "verified_game",
                is_overlay_enabled: false,
                is_overlay_game_enabled: true,
                is_overlay_game_source: "OOP_DEFAULT_DATABASE",
                fullscreen_type: "UNKNOWN",
                hardware_display_count: 1,
                overlay_method: "Disabled",
                activity_status_enabled: true,
                activity_status_shared_guilds: [],
                current_user_status: "online",
                game_detection_enabled: true,
                executable_path: game.exe,
                voice_channel_id: null,
                voice_channel_type: null,
                voice_channel_bitrate: null,
                voice_channel_guild_id: null,
                hidden_by_distributor: false,
                game_metadata: null,
                client_performance_cpu: null,
                client_performance_memory: null,
                cpu_core_count: null,
                accessibility_features: 0,
                rendered_locale: this.locale,
                launch_signature: this.session.launchSignature,
                client_rtc_state: null,
                client_app_state: "focused",
                client_send_timestamp: now,
            },
        };
    }

    _heartbeat(game, durationMs, sessionId, { initial, final, ts }) {
        return {
            type: "running_game_heartbeat",
            properties: {
                client_track_timestamp: ts,
                client_heartbeat_session_id: this.session.heartbeatSession,
                event_sequence_number: this._next(),
                game_id: game.id,
                game_name: game.name,
                game_metadata: null,
                game_executable: game.exe,
                game_detection_enabled: true,
                initial_heartbeat: initial,
                final_heartbeat: final,
                game_session_id: sessionId,
                duration_tracked_ms: durationMs,
                rtc_connection_id: null,
                media_session_id: null,
                launch_signature: this.session.launchSignature,
                client_app_state: "focused",
                client_send_timestamp: ts,
            },
        };
    }

    /** Đúng thứ tự client thật: heartbeat mở (0ms) → launch_game → heartbeat đóng. */
    buildSession(game, durationMs) {
        const sessionId = crypto.randomUUID();
        const now = Date.now();
        const start = now - durationMs < 0 ? now : now - durationMs;
        return [
            this._heartbeat(game, 0, sessionId, { initial: true, final: false, ts: start }),
            this._launch(game),
            this._heartbeat(game, durationMs, sessionId, { initial: false, final: true, ts: now }),
        ];
    }

    /** @returns {Promise<number>} HTTP status (204 = nhận, 0 = lỗi mạng) */
    async post(events) {
        const headers = {
            accept: "*/*",
            "accept-language": this.locale,
            authorization: this.token,
            "content-type": "application/json",
            origin: "https://discord.com",
            referer: "https://discord.com/channels/@me",
            "user-agent": USER_AGENT,
            "x-debug-options": "bugReporterEnabled",
            "x-discord-locale": this.locale,
            "x-discord-timezone": _tzFor(this.locale),
            "x-super-properties": _superProps(this.buildNumber, this.session, this.locale),
        };
        if (this.cookie) headers.cookie = this.cookie;
        try {
            const res = await axios.post(
                SCIENCE_URL,
                { token: this.analyticsToken, events },
                { headers, timeout: 15_000, validateStatus: () => true, ...this._proxyCfg },
            );
            return res.status;
        } catch {
            return 0;
        }
    }

    /**
     * Gửi cả kế hoạch theo batch.
     * Dừng ngay khi gặp 401/403 — cookie/token hỏng thì mọi batch sau cũng hỏng,
     * gửi tiếp chỉ tổ đốt request.
     */
    async run(plan, { onBatch = () => {} } = {}) {
        if (!this.analyticsToken) await this.init();
        const durationMs = Math.round(plan.hoursPerGame * 3600 * 1000);
        const total = plan.games.length;
        let sent = 0;
        let batchNo = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const chunk = plan.games.slice(i, i + BATCH_SIZE);
            batchNo += 1;
            const events = chunk.flatMap((g) => this.buildSession(g, durationMs));
            const status = await this.post(events);

            if (status === 204) {
                sent += chunk.length;
                onBatch({ batchNo, status, sent, total, ok: true });
            } else if (status === 401 || status === 403) {
                onBatch({ batchNo, status, sent, total, ok: false, fatal: true });
                return { sent, total, aborted: true, status };
            } else {
                onBatch({ batchNo, status, sent, total, ok: false });
            }
            if (i + BATCH_SIZE < total) await sleep(BATCH_DELAY);
        }
        return { sent, total, aborted: false, status: 204 };
    }
}

// ── HypeSquad ────────────────────────────────────────────────────────────────────

const HYPESQUAD_URL = `${API}/hypesquad/online`;

/**
 * Đổi nhà HypeSquad. Ăn ngay, không có mốc, không cần analytics token.
 *
 * Khác hẳn /science ở chỗ đây là API công khai của client — đổi nhà là hành vi
 * hợp lệ, ai cũng làm được từ Settings. Rủi ro gần như bằng không, nên không cần
 * dàn trải hay nghỉ giữa chừng gì cả.
 *
 * @param {1|2|3} houseId  1 Bravery · 2 Brilliance · 3 Balance
 */
async function setHypeSquad(token, houseId, { agent = null, locale = DEFAULT_LOCALE } = {}) {
    const buildNumber = await getBuildNumber();
    const session = {
        heartbeatSession: crypto.randomUUID(),
        launchSignature: crypto.randomUUID(),
    };
    const res = await axios.post(
        HYPESQUAD_URL,
        { house_id: houseId },
        {
            headers: {
                authorization: token,
                "content-type": "application/json",
                "user-agent": USER_AGENT,
                "x-super-properties": _superProps(buildNumber, session, locale),
                "accept-language": locale,
                "x-discord-locale": locale,
                "x-discord-timezone": _tzFor(locale),
                origin: "https://discord.com",
                referer: "https://discord.com/channels/@me",
            },
            timeout: 15_000,
            validateStatus: () => true,
            ...(agent ? { httpsAgent: agent, proxy: false } : {}),
        },
    );
    if (res.status === 401 || res.status === 403) {
        throw _err("Token không hợp lệ hoặc đã chết", 400, { invalidToken: true });
    }
    // Discord trả 204 khi thành công.
    if (res.status !== 204 && res.status !== 200) {
        throw _err(res.data?.message || `Đổi HypeSquad thất bại (HTTP ${res.status})`);
    }
    return { ok: true, houseId };
}

module.exports = {
    BadgeSender,
    DEFAULT_LOCALE,
    loadGames,
    planOrder,
    setHypeSquad,
    BATCH_SIZE,
    BATCH_DELAY,
    GAME_TIME_SPREAD,
};
