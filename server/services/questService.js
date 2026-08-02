/**
 * questService.js
 * Admin-only Discord Quest runner. Owns account storage (panel DB), the background
 * run loop, restart recovery, and a realtime event bus (consumed by the SSE route).
 * The Discord logic lives in questEngine.js.
 *
 * DB model `quest_accounts` (one record per Discord account):
 *   { _id, accountId, username, tokenEncrypted, tokenIv, tokenTag,
 *     mode: "all" | "select", selectedQuestIds: [], status, completedCount,
 *     error, addedAt, updatedAt }
 * status: "running" | "done" | "stopped" | "token_dead" | "error"
 */

const { EventEmitter } = require("events");
const crypto = require("crypto");
const axios = require("axios");
const db = require("../db");
const {
    QuestAutocompleter,
    resolveDiscordAccount,
    warmBuildNumber,
    summarizeQuest,
    isInvalidTokenError,
    _fields,
} = require("./questEngine");
const proxyPool = require("./proxyPool");

const MODEL = "quest_accounts";
const { isEnrolled, isCompleted, isCompletable } = _fields;

// ── Token encryption at rest (aes-256-gcm, key from env secret) ──────────────────
const ALGO = "aes-256-gcm";
function _key() {
    const secret =
        process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret";
    return crypto.createHash("sha256").update(secret).digest();
}
function _encrypt(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, _key(), iv);
    const enc = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
    return {
        tokenEncrypted: enc.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: cipher.getAuthTag().toString("base64"),
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

// ── Realtime bus + in-memory run state ───────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(0);
// accountId -> { abort, completer }
const running = new Map();
// accountId -> { [questId]: { name, taskType, needed, done, percent, state, media } }
// Kept so the snapshot / list can render rich quest cards even after a page reload.
const liveState = new Map();
// accountId -> { url, ref }: caller (arnto-auto) webhook to notify on quest events.
const webhooks = new Map();

// Forward meaningful events to the account's webhook (arnto-auto → DM the buyer).
function _dispatchWebhook(accountId, event) {
    const hook = webhooks.get(accountId);
    if (!hook?.url) return;
    if (!["quest_start", "quest_done", "status", "removed"].includes(event.type)) return;
    axios
        .post(hook.url, { ...event, accountId, ref: hook.ref ?? null }, {
            timeout: 8000,
            // arnto-auto's /api/quest-event authenticates with the shared key.
            headers: { "x-api-key": process.env.PANEL_API_KEY || "" },
        })
        .catch(() => {});
}

function _updateLive(accountId, evt) {
    if (!["quest_start", "quest_progress", "quest_done", "quest_pending"].includes(evt.type))
        return;
    let acc = liveState.get(accountId);
    if (!acc) {
        acc = {};
        liveState.set(accountId, acc);
    }
    const q = acc[evt.questId] || {};
    if (evt.name) q.name = evt.name;
    if (evt.taskType) q.taskType = evt.taskType;
    if (evt.needed != null) q.needed = evt.needed;
    if (evt.done != null) q.done = evt.done;
    if (evt.percent != null) q.percent = evt.percent;
    if (evt.media) q.media = evt.media;
    if (evt.type === "quest_done") {
        q.state = "done";
        q.percent = 100;
    } else if (evt.type === "quest_pending") {
        // A pre-run placeholder card; never downgrade one already running/finished.
        if (q.state !== "running" && q.state !== "done") q.state = "pending";
        if (q.percent == null) q.percent = 0;
    } else {
        q.state = "running";
    }
    acc[evt.questId] = q;
}

function _publish(accountId, event) {
    _updateLive(accountId, event);
    _dispatchWebhook(accountId, event);
    bus.emit("event", { accountId, at: Date.now(), ...event });
}

// ── External producers (e.g. the monthly batch) ──────────────────────────────────
// The monthly runner lives in questMonthly.js but its accounts should show the same
// live quest cards + realtime stream on /quests as single-quest accounts. These let
// it feed the shared liveState + bus. Unlike _publish this does NOT dispatch the
// per-account webhook — monthly owns its own webhook delivery to arnto-auto.
function emitExternalEvent(accountId, event) {
    _updateLive(accountId, event);
    bus.emit("event", { accountId, at: Date.now(), ...event });
}
function getLive(accountId) {
    return liveState.get(accountId) ?? {};
}
function clearLive(accountId) {
    liveState.delete(accountId);
}

// ── DB helpers ───────────────────────────────────────────────────────────────────
async function _getRec(accountId) {
    return db.findOne(MODEL, { accountId });
}
async function _updateRec(accountId, patch) {
    const rec = await db.findOneAndUpdate(
        MODEL,
        { accountId },
        { ...patch, updatedAt: Date.now() },
    );
    return rec;
}
async function _setStatus(accountId, status, extra = {}) {
    await _updateRec(accountId, { status, ...extra });
    _publish(accountId, { type: "status", status, ...extra });
}

/** Public account view (no token material). */
function _publicRec(r) {
    return {
        accountId: r.accountId,
        username: r.username,
        mode: r.mode,
        selectedQuestIds: r.selectedQuestIds ?? [],
        status: r.status,
        completedCount: r.completedCount ?? 0,
        error: r.error ?? null,
        running: running.has(r.accountId),
        ref: r.webhookRef ?? null,
        addedAt: r.addedAt,
        updatedAt: r.updatedAt,
        quests: liveState.get(r.accountId) ?? {},
    };
}

async function listAccounts() {
    const recs = (await db.get(MODEL)) || [];
    return recs.map(_publicRec);
}

async function getAccount(accountId) {
    const rec = await _getRec(accountId);
    return rec ? _publicRec(rec) : null;
}

/** Resolve a token and fetch its quests (for the UI to pick from). No storage. */
async function previewToken(token) {
    const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const completer = new QuestAutocompleter(resolved.api, { label: resolved.username });
    const quests = await completer.fetchQuests();
    // One-time dev aid: log the raw asset/colors of the first quest so the CDN URL
    // pattern & field names can be verified against a real quest if an image 404s.
    if (quests[0]?.config) {
        console.log(
            "[Quest] sample config.assets:",
            JSON.stringify(quests[0].config.assets ?? null),
            "colors:",
            JSON.stringify(quests[0].config.colors ?? null),
        );
    }
    return {
        accountId: resolved.accountId,
        username: resolved.username,
        quests: quests
            .filter((q) => !isCompleted(q) && isCompletable(q))
            .map(summarizeQuest),
    };
}

/**
 * Add (or update) an account and start running.
 * mode "all"  → run every available quest.
 * mode "select" → run only selectedQuestIds.
 */
async function startAccount({ token, mode = "all", selectedQuestIds = [], webhookUrl, ref }) {
    const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const accountId = resolved.accountId;
    const cleanIds = [...new Set((selectedQuestIds ?? []).map(String).filter(Boolean))];
    const enc = _encrypt(token);
    const existing = await _getRec(accountId);
    // Preserve an existing webhook if the caller didn't supply a new one.
    const hookUrl = webhookUrl ?? existing?.webhookUrl ?? null;
    const hookRef = ref ?? existing?.webhookRef ?? null;
    if (hookUrl) webhooks.set(accountId, { url: hookUrl, ref: hookRef });
    const record = {
        accountId,
        username: resolved.username,
        ...enc,
        mode: mode === "select" ? "select" : "all",
        selectedQuestIds: mode === "select" ? cleanIds : [],
        webhookUrl: hookUrl,
        webhookRef: hookRef,
        status: "running",
        completedCount: existing?.completedCount ?? 0,
        error: null,
        addedAt: existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
    };
    if (existing) await db.findOneAndUpdate(MODEL, { accountId }, record);
    else await db.create(MODEL, record);

    // (Re)start the loop with the freshly resolved api.
    _stopLoop(accountId);
    _launch(accountId, resolved, record);
    return _publicRec(record);
}

function _stopLoop(accountId) {
    const r = running.get(accountId);
    if (r) {
        r.abort.stopped = true;
        running.delete(accountId);
    }
}

async function stopAccount(accountId) {
    _stopLoop(accountId);
    if (await _getRec(accountId)) await _setStatus(accountId, "stopped");
    return true;
}

async function removeAccount(accountId) {
    _stopLoop(accountId);
    liveState.delete(accountId);
    await db.findOneAndDelete(MODEL, { accountId });
    _publish(accountId, { type: "removed" });
    webhooks.delete(accountId);
    return true;
}

// ── Run loop ─────────────────────────────────────────────────────────────────────
function _launch(accountId, resolved, record) {
    const abort = { stopped: false };
    const completer = new QuestAutocompleter(resolved.api, {
        label: resolved.username,
        onEvent: (e) => _publish(accountId, e),
    });
    running.set(accountId, { abort, completer });
    _runLoop(accountId, completer, abort, record).catch((err) => {
        console.error(`[Quest] ${resolved.username} loop crash:`, err.message);
    });
}

async function _runLoop(accountId, completer, abort, record) {
    const mode = record.mode;
    const selected = new Set((record.selectedQuestIds ?? []).map(String));
    _publish(accountId, { type: "status", status: "running" });

    // Pre-scan: enroll everything we intend to run, then show every quest that will
    // run as a "pending" card up front — so the panel loads the FULL set immediately
    // instead of one-by-one. Enroll is idempotent, so the loop below re-enrolling is
    // harmless. quest_pending is not forwarded to the arnto webhook (see _dispatchWebhook).
    try {
        let scan = await completer.fetchQuests();
        if (scan.length && !abort.stopped) {
            if (mode === "select") await completer.enrollSelected([...selected]);
            else await completer.autoAccept(scan);
            scan = await completer.fetchQuests();
            for (const q of scan) {
                if (
                    isEnrolled(q) &&
                    !isCompleted(q) &&
                    isCompletable(q) &&
                    (mode === "all" || selected.has(String(q.id)))
                ) {
                    const s = summarizeQuest(q);
                    _publish(accountId, {
                        type: "quest_pending",
                        questId: s.id,
                        name: s.name,
                        taskType: s.taskType,
                        needed: s.needed,
                        media: s.media,
                    });
                }
            }
        }
    } catch {
        // A failed pre-scan is non-fatal — the main loop below re-fetches anyway.
    }

    let guard = 0;
    try {
        while (!abort.stopped && guard++ < 50) {
            let quests = await completer.fetchQuests();
            if (!quests.length) break;

            // Enroll what we intend to run, then re-fetch to see enrolled state.
            if (mode === "select") await completer.enrollSelected([...selected]);
            else quests = await completer.autoAccept(quests);
            quests = await completer.fetchQuests();

            const actionable = quests.filter(
                (q) =>
                    isEnrolled(q) &&
                    !isCompleted(q) &&
                    isCompletable(q) &&
                    (mode === "all" || selected.has(String(q.id))),
            );
            if (!actionable.length) break; // nothing left → done

            for (const q of actionable) {
                if (abort.stopped) break;
                await completer.processQuest(q);
                const cur = (await _getRec(accountId))?.completedCount ?? 0;
                await _updateRec(accountId, { completedCount: cur + 1 });
            }
        }
        if (!abort.stopped) {
            running.delete(accountId);
            await _setStatus(accountId, "done");
        }
    } catch (err) {
        running.delete(accountId);
        if (isInvalidTokenError(err)) {
            await _setStatus(accountId, "token_dead", {
                error: "Token không hợp lệ / đã hết hạn.",
            });
        } else {
            console.error(`[Quest] ${record.username} loop error:`, err.message);
            await _setStatus(accountId, "error", { error: err.message });
        }
    }
}

/** Restart accounts that were running before a server restart. */
async function restore() {
    warmBuildNumber();
    const recs = (await db.get(MODEL)) || [];
    let restored = 0;
    for (const rec of recs) {
        if (rec.webhookUrl) webhooks.set(rec.accountId, { url: rec.webhookUrl, ref: rec.webhookRef ?? null });
        if (rec.status !== "running") continue;
        const token = _decrypt(rec);
        if (!token) {
            await _setStatus(rec.accountId, "token_dead", {
                error: "Không giải mã được token (đổi secret?).",
            });
            continue;
        }
        try {
            const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
            if (!resolved.ok) {
                await _setStatus(
                    rec.accountId,
                    resolved.invalidToken ? "token_dead" : "error",
                    { error: resolved.reason },
                );
                continue;
            }
            _launch(rec.accountId, resolved, rec);
            restored++;
        } catch (e) {
            console.warn(`[Quest] restore ${rec.username} error: ${e.message}`);
        }
    }
    if (restored) console.log(`[Quest] Restored ${restored} account(s).`);
    return restored;
}

module.exports = {
    bus,
    listAccounts,
    getAccount,
    previewToken,
    startAccount,
    stopAccount,
    removeAccount,
    restore,
    emitExternalEvent,
    getLive,
    clearLive,
};
