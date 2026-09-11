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
 * ĐƠN VỊ GỬI LÀ PHIÊN, KHÔNG PHẢI GAME. Một game có thể mang rất nhiều phiên —
 * đúng như người chơi thật tích giờ qua nhiều buổi. Đây không phải chi tiết làm
 * đẹp: gộp tất cả giờ vào MỘT phiên thì `duration_tracked_ms` tràn int32 và
 * Discord nhận (204) rồi bỏ im lặng. Xem MAX_SESSION_HOURS.
 *
 * HAI BADGE ẢNH HƯỞNG LẪN NHAU. Mỗi game MỚI gửi đi vừa cộng vào Game Variety
 * (số game) vừa cộng vào Game Time (số giờ). Nên:
 *   - Bán Game Variety  → nhiều game, mỗi game 1 phiên 1 phút.
 *   - Bán Game Time     → nhiều phiên trên game ĐÃ ĐƯỢC ĐẾM RỒI, số game đứng yên.
 *
 * Chỗ thứ hai là nơi dễ mất tiền nhất: mở 5 game mới cho một account trắng là
 * tặng luôn Sampler (2 game) và Dabbler (5 game). planOrder() chống bằng ba lớp:
 *
 *   1. claimedGameIds  — game ta đã gửi cho account này ở đơn trước. Chắc chắn
 *                        đã đếm, dùng lại là miễn phí tuyệt đối.
 *   2. playedGameIds   — game khách đã chơi thật. Chơi thật thì client cũng bắn
 *                        /science nên gần như chắc chắn đã đếm. Suy đoán mạnh,
 *                        không phải đảm bảo.
 *   3. varietyHeadroom — CHẶN CỨNG: không bao giờ mở nhiều game mới hơn số còn
 *                        thiếu để chạm mốc Variety kế tiếp. Đây mới là thứ bảo
 *                        đảm; hai lớp trên chỉ để ít phải dùng tới nó.
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

// Giờ tối đa của MỘT phiên chơi.
//
// `duration_tracked_ms` đi qua một tầng lưu int32 ở phía Discord: 2.147.483.647ms
// = 596,5 giờ. Vượt là event được nhận (204) rồi bị bỏ âm thầm — đã dính: gửi
// 1.100 giờ/phiên (3,96 tỷ ms) thì Game Time không nhích một giờ nào.
//
// 2 giờ là con số bản gốc đã chứng minh chạy được ở quy mô 10.448 game, và cũng
// là độ dài một phiên chơi hợp lý. Cần nhiều giờ thì chia thành nhiều PHIÊN trên
// cùng một game — vừa an toàn, vừa không mở thêm game nào nên Game Variety đứng yên.
const MAX_SESSION_HOURS = 2;

// Không lùi timestamp quá xa: phiên chơi từ 3 năm trước trông vô lý hơn là nhiều
// phiên gần nhau. Quá mốc này thì quay vòng lại hiện tại.
const MAX_BACKDATE_MS = 365 * 24 * 60 * 60_000;

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
    // Game khách đã chơi thật (từ activities/statistics). Dùng lại chúng thì
    // Game Variety nhiều khả năng không nhích.
    playedGameIds = [],
    // Còn bao nhiêu game nữa mới chạm mốc Game Variety kế tiếp. badgeService
    // tính từ chính giá trị reader đọc được. Infinity = không cần chặn.
    varietyHeadroom = Infinity,
    spread = GAME_TIME_SPREAD,
}) {
    const games = await loadGames();
    const claimed = new Set(claimedGameIds.map(String));
    const byId = new Map(games.map((g) => [g.id, g]));

    if (badgeKey === "game_variety") {
        const need = Math.ceil(Math.max(0, threshold - current) * overshoot);
        if (need <= 0) return { games: [], sessions: [], need: 0, badgeKey };
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
        return {
            games: fresh,
            sessions: fresh.map((game) => ({ game, hours: 1 / 60 })),
            hoursPerSession: 1 / 60,
            need,
            badgeKey,
        };
    }

    if (badgeKey === "game_time") {
        const needHours = Math.ceil(Math.max(0, threshold - current) * overshoot);
        if (needHours <= 0) return { games: [], sessions: [], need: 0, badgeKey };

        // Ba lớp ưu tiên, mục tiêu: dồn giờ mà KHÔNG đẩy Game Variety qua mốc kế
        // tiếp (khách sẽ được mốc đó miễn phí, tức mất doanh thu).
        //
        //  1. Game ta đã gửi cho chính account này ở đơn trước — chắc chắn đã
        //     được đếm rồi, thêm giờ lên đó không làm số game nhích lên.
        //  2. Game khách đã chơi THẬT (đọc từ activities/statistics bằng token
        //     của họ). Chơi thật thì client cũng đã bắn /science, nên gần như
        //     chắc chắn đã được đếm. "Gần như" — đây là suy đoán, không phải
        //     đảm bảo, nên nó chỉ là lớp giảm rủi ro.
        //  3. Game mới — nhưng bị CHẶN CỨNG bởi varietyHeadroom. Đây mới là thứ
        //     bảo đảm không vượt mốc, hai lớp trên chỉ để ít phải dùng tới nó.
        const seen = new Set();
        const take = (list) => {
            const out = [];
            for (const g of list) {
                if (!g || seen.has(g.id)) continue;
                seen.add(g.id);
                out.push(g);
            }
            return out;
        };

        const reused = take(claimedGameIds.map((id) => byId.get(String(id))));
        const played = take(
            playedGameIds.map((id) => byId.get(String(id))).filter((g) => g && !claimed.has(g.id)),
        );

        let pool = [...reused, ...played].slice(0, spread);
        for (const g of pool) seen.add(g.id);

        let openedNew = 0;
        if (pool.length < spread) {
            // Còn chỗ trước mốc Variety kế tiếp là bao nhiêu thì mở bấy nhiêu.
            const room = Math.max(0, Math.min(spread - pool.length, varietyHeadroom));
            if (room > 0) {
                const fresh = games.filter((g) => !claimed.has(g.id) && !seen.has(g.id));
                const picked = fresh.slice(0, room);
                pool = pool.concat(picked);
                openedNew = picked.length;
            }
        }

        // Hết đường: không có game cũ nào dùng lại được VÀ không còn chỗ trống
        // trước mốc kế tiếp. Vẫn phải gửi (khách đã trả tiền), nhưng đánh dấu để
        // đơn ghi lại là có vượt mốc Variety.
        let crossedVarietyTier = false;
        if (!pool.length) {
            const fresh = games.filter((g) => !claimed.has(g.id));
            if (!fresh.length) throw _err("Không còn game nào để dùng", 409, { exhausted: true });
            pool = fresh.slice(0, 1);
            openedNew = 1;
            crossedVarietyTier = varietyHeadroom <= 0;
        }

        // Chia đều thành nhiều phiên ngắn, xoay vòng qua pool. Cùng một game có
        // thể nhận rất nhiều phiên — đó chính là cách người chơi thật tích giờ,
        // và nó không làm Game Variety nhích lên.
        const sessions = [];
        let left = needHours;
        while (left > 0) {
            const hours = Math.min(MAX_SESSION_HOURS, left);
            sessions.push({ game: pool[sessions.length % pool.length], hours });
            left -= hours;
        }

        // `games` phải là những game THẬT SỰ được gửi, không phải cả pool: đơn nhỏ
        // (vài giờ) chỉ chạm tới 1-2 game trong pool 5 cái. Ghi nhận dư thì đơn sau
        // sẽ "dùng lại" game chưa bao giờ gửi đi, và Game Variety nhích ngoài dự tính.
        const usedIds = new Set(sessions.map((x) => x.game.id));
        const used = pool.filter((g) => usedIds.has(g.id));

        return {
            games: used,
            sessions,
            hoursPerSession: MAX_SESSION_HOURS,
            need: needHours,
            badgeKey,
            // Bao nhiêu game MỚI bị mở ra — tức Game Variety sẽ nhích thêm bấy nhiêu.
            // Chỉ đếm game mới THẬT SỰ được gửi.
            varietySideEffect: used.filter((g) => !claimed.has(g.id)).length,
            reusedCount: reused.length,
            playedCount: Math.min(played.length, Math.max(0, spread - reused.length)),
            varietyHeadroom,
            crossedVarietyTier,
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
    buildSession(game, durationMs, { index = 0 } = {}) {
        const sessionId = crypto.randomUUID();
        // Các phiên lát kề nhau lùi dần về quá khứ: phiên 0 kết thúc bây giờ,
        // phiên 1 kết thúc ngay trước đó… Một người chơi 2.750 phiên 2h thì các
        // phiên đó phải rải ra chứ không thể chồng lên cùng một khoảnh khắc.
        const back = (index * durationMs) % MAX_BACKDATE_MS;
        const now = Date.now() - back;
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
    /**
     * Gửi từng PHIÊN, không phải từng game. Một game có thể xuất hiện ở rất nhiều
     * phiên — đó là cách tích giờ mà không đụng vào Game Variety.
     */
    async run(plan, { onBatch = () => {} } = {}) {
        if (!this.analyticsToken) await this.init();
        const sessions = plan.sessions ?? [];
        const total = sessions.length;
        let sent = 0;
        let batchNo = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const chunk = sessions.slice(i, i + BATCH_SIZE);
            batchNo += 1;
            const events = chunk.flatMap((ses, k) =>
                this.buildSession(ses.game, Math.round(ses.hours * 3600 * 1000), {
                    index: i + k,
                }),
            );
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
