/**
 * questEngine.js
 * Standalone Discord Quest engine (ported from the ArnTo-Auto bot). Pure Discord
 * API logic: build-number, DiscordAPI client, and QuestAutocompleter (enroll +
 * complete WATCH_VIDEO / PLAY_ON_* / PLAY_ACTIVITY / ACHIEVEMENT_IN_ACTIVITY).
 *
 * No panel DB / storage here — questService.js owns accounts, the run loop and
 * realtime events. The completer takes an optional `onEvent` callback so progress
 * can be streamed to the UI.
 */

const axios = require("axios");
const { randomUUID } = require("crypto");

const API_BASE = "https://discord.com/api/v9";
const HEARTBEAT_INTERVAL = 20;
const SUPPORTED_TASKS = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "PLAY_ON_XBOX",
    "PLAY_ON_PLAYSTATION",
    "PLAY_ACTIVITY",
    "ACHIEVEMENT_IN_ACTIVITY",
];
const GAME_HEARTBEAT_TASKS = ["PLAY_ON_DESKTOP", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"];
const DESKTOP_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9236 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";
const ANDROID_USER_AGENT = "Discord-Android/316011;RNA";

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function _throwIfUnauthorized(res, ctx) {
    if (
        res?.status === 401 ||
        res?.status === 403 ||
        /unauthorized/i.test(res?.data?.message ?? "")
    ) {
        const e = new Error(`${ctx} (${res?.status ?? 401})`);
        e.invalidToken = true;
        throw e;
    }
}

const BUILD_FALLBACK = 539951;
async function fetchLatestBuildNumber() {
    try {
        const res = await axios.get("https://discord.com/app", {
            headers: { "User-Agent": DESKTOP_USER_AGENT },
            timeout: 15000,
        });
        if (res.status !== 200) return BUILD_FALLBACK;
        const scripts = [
            ...new Set(
                [...res.data.matchAll(/\/assets\/web\.([a-f0-9]+)\.js/g)].map(
                    (m) => m[0],
                ),
            ),
        ];
        for (const scriptPath of scripts.slice(0, 5)) {
            try {
                const ar = await axios.get(`https://discord.com${scriptPath}`, {
                    headers: { "User-Agent": DESKTOP_USER_AGENT },
                    timeout: 15000,
                });
                const match = ar.data.match(/buildNumber["'\s:]+["'\s]*(\d{5,7})/);
                if (match) return parseInt(match[1], 10);
            } catch {}
        }
        return BUILD_FALLBACK;
    } catch {
        return BUILD_FALLBACK;
    }
}

// Cache the build number for 6 hours; it changes rarely and a stale value works.
const BUILD_CACHE_TTL = 6 * 60 * 60_000;
let buildCache = { value: null, fetchedAt: 0 };
async function getBuildNumber() {
    if (buildCache.value && Date.now() - buildCache.fetchedAt < BUILD_CACHE_TTL)
        return buildCache.value;
    const v = await fetchLatestBuildNumber();
    buildCache = { value: v, fetchedAt: Date.now() };
    return v;
}
async function warmBuildNumber() {
    try {
        await getBuildNumber();
    } catch {}
}

function _makeSuperProperties(buildNumber, isAndroid) {
    if (isAndroid) {
        return Buffer.from(
            JSON.stringify({
                os: "Android",
                browser: "Discord Android",
                device: "b0q",
                system_locale: "en-US",
                has_client_mods: false,
                client_version: "316.11 - rn",
                release_channel: "googleRelease",
                device_vendor_id: randomUUID(),
                design_id: 2,
                browser_user_agent: "",
                browser_version: "",
                os_version: "28",
                client_build_number: 5169,
                client_event_source: null,
                client_launch_id: randomUUID(),
                launch_signature: randomUUID(),
                client_app_state: "active",
                client_heartbeat_session_id: randomUUID(),
            }),
        ).toString("base64");
    }
    return Buffer.from(
        JSON.stringify({
            os: "Windows",
            browser: "Discord Client",
            release_channel: "stable",
            client_version: "1.0.9236",
            os_version: "10.0.19045",
            os_arch: "x64",
            app_arch: "x64",
            system_locale: "en-US",
            has_client_mods: false,
            client_launch_id: randomUUID(),
            browser_user_agent: DESKTOP_USER_AGENT,
            browser_version: "37.6.0",
            os_sdk_version: "19045",
            client_build_number: buildNumber,
            native_build_number: 81687,
            client_event_source: null,
            launch_signature: randomUUID(),
            client_heartbeat_session_id: randomUUID(),
            client_app_state: "focused",
        }),
    ).toString("base64");
}

class DiscordAPI {
    constructor(token, buildNumber) {
        this.token = token;
        this.buildNumber = buildNumber;
        this.client = axios.create({
            baseURL: API_BASE,
            timeout: 20000,
            headers: {
                Authorization: token,
                "Content-Type": "application/json",
                Accept: "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": DESKTOP_USER_AGENT,
                "X-Super-Properties": _makeSuperProperties(buildNumber, false),
                "X-Discord-Locale": "en-US",
                "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
                "X-Debug-Options": "bugReporterEnabled",
                Origin: "https://discord.com",
                Referer: "https://discord.com/channels/@me",
            },
        });
    }
    async get(path, config = {}) {
        return this.client.get(path, { validateStatus: () => true, ...config });
    }
    async post(path, payload = null, config = {}) {
        return this.client.post(path, payload, {
            validateStatus: () => true,
            ...config,
        });
    }
    async delete(path, config = {}) {
        return this.client.delete(path, { validateStatus: () => true, ...config });
    }
    androidEnrollHeaders() {
        return {
            "User-Agent": ANDROID_USER_AGENT,
            "X-Super-Properties": _makeSuperProperties(this.buildNumber, true),
        };
    }
}

// ── Quest field helpers ─────────────────────────────────────────────────────────
function _getValue(d, ...keys) {
    if (!d) return undefined;
    for (const k of keys) if (k in d) return d[k];
    return undefined;
}
function _getTaskConfig(q) {
    return _getValue(
        q.config ?? {},
        "taskConfig",
        "task_config",
        "taskConfigV2",
        "task_config_v2",
    );
}
function _getUserStatus(q) {
    const us = _getValue(q, "userStatus", "user_status");
    return us && typeof us === "object" ? us : {};
}
function _getExpiresAt(q) {
    return _getValue(q.config ?? {}, "expiresAt", "expires_at");
}
function _isEnrolled(q) {
    return Boolean(_getValue(_getUserStatus(q), "enrolledAt", "enrolled_at"));
}
function _isCompleted(q) {
    return Boolean(_getValue(_getUserStatus(q), "completedAt", "completed_at"));
}
function _isCompletable(q) {
    const exp = _getExpiresAt(q);
    if (exp && new Date(exp) <= new Date()) return false;
    const tc = _getTaskConfig(q);
    return !!(tc?.tasks && SUPPORTED_TASKS.some((t) => tc.tasks[t] != null));
}
function _getQuestName(q) {
    const m = (q.config ?? {}).messages ?? {};
    return (
        _getValue(m, "questName", "quest_name", "gameTitle", "game_title")?.trim?.() ||
        (q.config ?? {}).application?.name ||
        `Quest#${q.id ?? "?"}`
    );
}
function _getTaskType(q) {
    const tc = _getTaskConfig(q);
    return (tc?.tasks && SUPPORTED_TASKS.find((t) => tc.tasks[t] != null)) ?? null;
}
function _getSecondsNeeded(q) {
    const tc = _getTaskConfig(q),
        t = _getTaskType(q);
    return !tc || !t ? 0 : tc.tasks[t]?.target ?? 0;
}
function _getSecondsDone(q) {
    const t = _getTaskType(q);
    return t ? _getUserStatus(q).progress?.[t]?.value ?? 0 : 0;
}
function _getEnrolledAt(q) {
    return _getValue(_getUserStatus(q), "enrolledAt", "enrolled_at");
}
function _getApplicationId(q) {
    return (q.config ?? {}).application?.id ?? null;
}
function _isMobileOnlyTask(q) {
    const tc = _getTaskConfig(q);
    return Boolean(tc?.tasks?.WATCH_VIDEO_ON_MOBILE) && !tc?.tasks?.WATCH_VIDEO;
}

// Asset values in config.assets ALREADY contain the full path (e.g.
// "quests/{id}/{file}.jpg"), so just prefix the CDN host. Some assets are the
// literal string "PLACEHOLDER" — treat those as absent.
function _questAssetUrl(asset) {
    if (!asset || asset === "PLACEHOLDER") return null;
    if (/^https?:\/\//.test(asset)) return asset;
    return `https://cdn.discordapp.com/${String(asset).replace(/^\/+/, "")}`;
}

/** Extract the rich media + branding of a quest so the UI can render a card that
 *  looks like Discord's original. Field access is defensive (snake/camel + theme
 *  variants; base logotype/game_tile are often "PLACEHOLDER").*/
function _questMedia(q) {
    const cfg = q.config ?? {};
    const a = cfg.assets ?? {};
    const messages = cfg.messages ?? {};
    const app = cfg.application ?? {};
    const rewardsCfg = cfg.rewards_config ?? cfg.rewardsConfig ?? {};
    const rewards = Array.isArray(rewardsCfg.rewards)
        ? rewardsCfg.rewards
        : Array.isArray(cfg.rewards)
          ? cfg.rewards
          : [];
    const r0 = rewards[0] ?? null;
    const u = _questAssetUrl;
    const heroIsVideo = a.hero && /\.(mp4|webm)/i.test(a.hero);

    // The compact quest CARD uses the "quest bar hero" banner; fall back to hero.
    const bannerVideo =
        u(a.quest_bar_hero_video ?? a.questBarHeroVideo) ||
        (heroIsVideo ? u(a.hero) : u(a.hero_video ?? a.heroVideo));
    const bannerImage =
        u(a.quest_bar_hero ?? a.questBarHero) || (heroIsVideo ? null : u(a.hero));

    return {
        heroImage: bannerImage,
        heroVideo: bannerVideo,
        fullHero: heroIsVideo ? null : u(a.hero),
        fullHeroVideo: heroIsVideo ? u(a.hero) : u(a.hero_video ?? a.heroVideo),
        gameTile: u(a.game_tile_dark) || u(a.game_tile_light) || u(a.game_tile),
        logotype: u(a.logotype_dark) || u(a.logotype_light) || u(a.logotype),
        colors: cfg.colors ?? cfg.gradient ?? null,
        gameTitle: messages.game_title ?? messages.gameTitle ?? app.name ?? null,
        gamePublisher: messages.game_publisher ?? messages.gamePublisher ?? null,
        questName: messages.quest_name ?? messages.questName ?? null,
        expiresAt: cfg.expires_at ?? cfg.expiresAt ?? null,
        startsAt: cfg.starts_at ?? cfg.startsAt ?? null,
        applicationId: app.id ?? null,
        reward: r0
            ? {
                  name:
                      r0.messages?.name ??
                      r0.messages?.name_with_article ??
                      r0.name ??
                      null,
                  orbs: r0.orb_quantity ?? r0.orbQuantity ?? null,
              }
            : null,
    };
}

function summarizeQuest(q) {
    return {
        id: String(q.id),
        name: _getQuestName(q),
        taskType: _getTaskType(q),
        needed: _getSecondsNeeded(q),
        done: _getSecondsDone(q),
        enrolled: _isEnrolled(q),
        completed: _isCompleted(q),
        media: _questMedia(q),
    };
}

class QuestAutocompleter {
    /** @param {DiscordAPI} api  @param {{label?:string,onEvent?:Function}} opts */
    constructor(api, opts = {}) {
        this.api = api;
        this.label = opts.label ?? "";
        this.onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
        this.completedIds = new Set();
        this._cachedChannelId = null;
        this._lastFetched = null;
    }

    _log(msg) {
        console.log(`[Quest]${this.label ? ` ${this.label}` : ""} ${msg}`);
    }
    _emit(event) {
        if (this.onEvent) {
            try {
                this.onEvent(event);
            } catch {}
        }
    }

    async _getValidChannelId() {
        if (this._cachedChannelId) return this._cachedChannelId;
        try {
            const dmRes = await this.api.get("/users/@me/channels");
            if (dmRes.status === 200 && Array.isArray(dmRes.data) && dmRes.data.length) {
                this._cachedChannelId = dmRes.data[0].id;
                return this._cachedChannelId;
            }
        } catch {}
        try {
            const guildRes = await this.api.get("/users/@me/guilds");
            if (guildRes.status === 200 && Array.isArray(guildRes.data)) {
                for (const guild of guildRes.data) {
                    try {
                        const chRes = await this.api.get(`/guilds/${guild.id}/channels`);
                        if (chRes.status === 200 && Array.isArray(chRes.data)) {
                            const vc = chRes.data.find((c) => c.type === 2);
                            if (vc) {
                                this._cachedChannelId = vc.id;
                                return this._cachedChannelId;
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
        return "1";
    }

    async fetchQuests() {
        try {
            const res = await this.api.get("/quests/@me");
            if (res.status === 200) {
                const d = res.data;
                const list = Array.isArray(d) ? d : d?.quests ?? [];
                this._lastFetched = list;
                return list;
            }
            _throwIfUnauthorized(res, "Lấy danh sách quest thất bại");
            if (res.status === 429) {
                await sleep(res.data?.retry_after ?? 10);
                return this.fetchQuests();
            }
            return [];
        } catch (err) {
            if (err?.invalidToken) throw err;
            return [];
        }
    }

    async _enrollAll(questObjs) {
        if (!questObjs.length) return;
        const enrollOne = async (q) => {
            try {
                const isAndroid = _isMobileOnlyTask(q);
                for (let i = 1; i <= 3; i++) {
                    const res = await this.api.post(
                        `/quests/${q.id}/enroll`,
                        {
                            location: isAndroid ? 12 : 11,
                            is_targeted: false,
                            metadata_sealed: null,
                            traffic_metadata_raw: q.traffic_metadata_raw ?? null,
                            traffic_metadata_sealed: q.traffic_metadata_sealed ?? null,
                        },
                        isAndroid ? { headers: this.api.androidEnrollHeaders() } : {},
                    );
                    if (res.status === 401) {
                        const e = new Error("Token bị từ chối khi enroll (401)");
                        e.invalidToken = true;
                        throw e;
                    }
                    if (res.status === 429) {
                        await sleep((res.data?.retry_after ?? 5) + 1);
                        continue;
                    }
                    if (![200, 201, 204].includes(res.status))
                        this._log(
                            `⚠ Không enroll được "${_getQuestName(q)}" (HTTP ${res.status}) — bỏ qua.`,
                        );
                    break;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
        };
        const CONCURRENCY = 5;
        for (let i = 0; i < questObjs.length; i += CONCURRENCY) {
            const batch = questObjs.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(enrollOne));
            const invalid = results.find(
                (r) => r.status === "rejected" && r.reason?.invalidToken,
            );
            if (invalid) throw invalid.reason;
        }
    }

    async autoAccept(quests) {
        const unaccepted = quests.filter(
            (q) => !_isEnrolled(q) && !_isCompleted(q) && _isCompletable(q),
        );
        if (!unaccepted.length) return quests;
        await this._enrollAll(unaccepted);
        await sleep(1);
        return this.fetchQuests();
    }

    async enrollSelected(ids) {
        const idSet = new Set((ids ?? []).map(String));
        if (!idSet.size) return;
        const quests = this._lastFetched ?? (await this.fetchQuests());
        const toEnroll = quests.filter(
            (q) =>
                idSet.has(String(q.id)) &&
                !_isEnrolled(q) &&
                !_isCompleted(q) &&
                _isCompletable(q),
        );
        await this._enrollAll(toEnroll);
    }

    async processQuest(quest) {
        const taskType = _getTaskType(quest);
        if (!taskType || this.completedIds.has(quest.id)) return;
        const name = _getQuestName(quest);
        const needed = _getSecondsNeeded(quest);
        const startedAt = Date.now();
        this._log(`▶ Bắt đầu "${name}" (${taskType})${needed ? ` — cần ${needed}s` : ""}`);
        this._emit({
            type: "quest_start",
            questId: String(quest.id),
            name,
            taskType,
            needed,
            media: _questMedia(quest),
        });
        if (["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"].includes(taskType))
            await this._completeVideo(quest);
        else if (GAME_HEARTBEAT_TASKS.includes(taskType))
            await this._completeGameHeartbeat(quest, taskType);
        else if (taskType === "PLAY_ACTIVITY") await this._completeActivity(quest);
        else if (taskType === "ACHIEVEMENT_IN_ACTIVITY")
            await this._completeAchievement(quest);
        this.completedIds.add(quest.id);
        const secs = Math.round((Date.now() - startedAt) / 1000);
        this._log(`✓ Hoàn thành "${name}" (mất ${secs}s)`);
        this._emit({ type: "quest_done", questId: String(quest.id), name, took: secs });
    }

    _emitProgress(questId, name, done, needed) {
        this._emit({
            type: "quest_progress",
            questId: String(questId),
            name,
            done: Math.round(done),
            needed,
            percent: needed ? Math.round((done / needed) * 100) : 0,
        });
    }

    async _completeVideo(quest) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        const name = _getQuestName(quest);
        let done = _getSecondsDone(quest);
        let lastLog = 0;
        const enrolledTs =
            (_getEnrolledAt(quest) ? new Date(_getEnrolledAt(quest)).getTime() : Date.now()) /
            1000;
        while (done < needed) {
            const maxAllowed = Date.now() / 1000 - enrolledTs + 10;
            if (maxAllowed - done >= 7) {
                try {
                    const res = await this.api.post(`/quests/${qid}/video-progress`, {
                        timestamp: Math.min(needed, done + 7 + Math.random()),
                    });
                    _throwIfUnauthorized(res, "Video progress thất bại");
                    if (res.status === 200) {
                        if (res.data.completed_at) return;
                        done = Math.min(needed, done + 7);
                    } else if (res.status === 429) {
                        await sleep((res.data?.retry_after ?? 5) + 1);
                        continue;
                    }
                } catch (err) {
                    if (err?.invalidToken) throw err;
                }
            }
            if (Date.now() - lastLog > 30000) {
                this._log(`   "${name}": ${Math.round(done)}/${needed}s`);
                this._emitProgress(qid, name, done, needed);
                lastLog = Date.now();
            }
            if (done + 7 >= needed) break;
            await sleep(1);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/video-progress`, {
                timestamp: needed,
            });
            _throwIfUnauthorized(res, "Video finish thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }

    async _completeGameHeartbeat(quest, taskType) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        const name = _getQuestName(quest);
        let done = _getSecondsDone(quest);
        let lastLog = 0;
        const applicationId = _getApplicationId(quest);
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                    application_id: applicationId,
                    terminal: false,
                });
                _throwIfUnauthorized(res, "Heartbeat thất bại");
                if (res.status === 200) {
                    done = res.data.progress?.[taskType]?.value ?? done;
                    if (res.data.completed_at || done >= needed) break;
                } else if (res.status === 429) {
                    await sleep((res.data?.retry_after ?? 10) + 1);
                    continue;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
            if (Date.now() - lastLog > 30000) {
                this._log(`   "${name}": ${Math.round(done)}/${needed}s`);
                this._emitProgress(qid, name, done, needed);
                lastLog = Date.now();
            }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                application_id: applicationId,
                terminal: true,
            });
            _throwIfUnauthorized(res, "Heartbeat terminal thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }

    async _completeActivity(quest) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        let done = _getSecondsDone(quest);
        const channelId = await this._getValidChannelId();
        const streamKey = `call:${channelId}:1`;
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                    stream_key: streamKey,
                    terminal: false,
                });
                _throwIfUnauthorized(res, "Activity heartbeat thất bại");
                if (res.status === 200) {
                    done = res.data.progress?.PLAY_ACTIVITY?.value ?? done;
                    if (res.data.completed_at || done >= needed) break;
                } else if (res.status === 429) {
                    await sleep((res.data?.retry_after ?? 10) + 1);
                    continue;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                stream_key: streamKey,
                terminal: true,
            });
            _throwIfUnauthorized(res, "Activity terminal thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }

    async _getActivityReferrer(applicationId) {
        const res = await this.api.post(`/applications/${applicationId}/proxy-tickets`, {});
        _throwIfUnauthorized(res, "Lấy proxy ticket thất bại");
        const referrer = new URL(`https://${applicationId}.discordsays.com/`);
        referrer.searchParams.set("instance_id", "example-cl-instance");
        referrer.searchParams.set("platform", "desktop");
        referrer.searchParams.set("discord_proxy_ticket", res.data?.ticket ?? "");
        return referrer.toString();
    }

    async _completeAchievement(quest) {
        const qid = quest.id;
        const applicationId = _getApplicationId(quest);
        if (!applicationId) return;
        const tc = _getTaskConfig(quest);
        const questTarget = tc?.tasks?.ACHIEVEMENT_IN_ACTIVITY?.target ?? 0;
        try {
            const authRes = await this.api.post(
                `/oauth2/authorize`,
                {
                    permissions: "0",
                    authorize: true,
                    integration_type: 1,
                    location_context: {
                        guild_id: "10000",
                        channel_id: "10000",
                        channel_type: 10000,
                    },
                },
                {
                    params: {
                        response_type: "code",
                        client_id: applicationId,
                        scope: "identify applications.commands applications.entitlements",
                        state: "",
                    },
                },
            );
            _throwIfUnauthorized(authRes, "Achievement authorize thất bại");
            const location = authRes.data?.location;
            const authCode = location ? new URL(location).searchParams.get("code") : null;
            if (!authCode) return;

            const activityReferrer = await this._getActivityReferrer(applicationId);
            const activityHeaders = {
                "Content-Type": "application/json",
                "X-Discord-Quest-ID": qid,
                Referer: activityReferrer,
                "User-Agent": DESKTOP_USER_AGENT,
            };
            const authorizeRes = await axios.post(
                `https://${applicationId}.discordsays.com/.proxy/acf/authorize`,
                { code: authCode },
                { headers: activityHeaders, validateStatus: () => true },
            );
            const activityToken = authorizeRes.data?.token;
            if (!activityToken) return;

            await axios.post(
                `https://${applicationId}.discordsays.com/.proxy/acf/quest/progress`,
                { progress: questTarget },
                {
                    headers: { ...activityHeaders, "X-Auth-Token": activityToken },
                    validateStatus: () => true,
                },
            );

            const tokensRes = await this.api.get("/oauth2/tokens");
            if (tokensRes.status === 200 && Array.isArray(tokensRes.data)) {
                const tokenInfo = tokensRes.data.find(
                    (t) => t.application?.id === applicationId,
                );
                if (tokenInfo)
                    await this.api.delete(`/oauth2/tokens/${tokenInfo.id}`).catch(() => null);
            }
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }
}

/** Validate a token and resolve its Discord account (id + username). */
async function resolveDiscordAccount(rawToken) {
    const token = String(rawToken ?? "").trim();
    if (!token) return { ok: false, invalidToken: false, reason: "Token trống." };
    const buildNumber = await getBuildNumber();
    const api = new DiscordAPI(token, buildNumber);
    try {
        const res = await api.get("/users/@me");
        if (res.status !== 200)
            return {
                ok: false,
                invalidToken: res.status === 401 || res.status === 403,
                reason: `Token không hợp lệ (HTTP ${res.status})`,
            };
        return {
            ok: true,
            api,
            buildNumber,
            accountId: String(res.data.id),
            username: res.data.username ?? "Unknown",
        };
    } catch (err) {
        return { ok: false, invalidToken: false, reason: `Không kết nối được Discord: ${err.message}` };
    }
}

module.exports = {
    DiscordAPI,
    QuestAutocompleter,
    resolveDiscordAccount,
    getBuildNumber,
    warmBuildNumber,
    summarizeQuest,
    isInvalidTokenError: (err) =>
        err?.invalidToken || /401|403|unauthorized/i.test(err?.message ?? ""),
    // quest field helpers used by questService
    _fields: {
        isEnrolled: _isEnrolled,
        isCompleted: _isCompleted,
        isCompletable: _isCompletable,
        getQuestName: _getQuestName,
        getTaskType: _getTaskType,
    },
};
