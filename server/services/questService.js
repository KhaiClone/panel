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
const db = require("../db");
const {
    QuestAutocompleter,
    resolveDiscordAccount,
    warmBuildNumber,
    summarizeQuest,
    isInvalidTokenError,
    _fields,
} = require("./questEngine");

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

function _publish(accountId, event) {
    bus.emit("event", { accountId, at: Date.now(), ...event });
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
        addedAt: r.addedAt,
        updatedAt: r.updatedAt,
    };
}

async function listAccounts() {
    const recs = (await db.get(MODEL)) || [];
    return recs.map(_publicRec);
}

/** Resolve a token and fetch its quests (for the UI to pick from). No storage. */
async function previewToken(token) {
    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const completer = new QuestAutocompleter(resolved.api, { label: resolved.username });
    const quests = await completer.fetchQuests();
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
async function startAccount({ token, mode = "all", selectedQuestIds = [] }) {
    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const accountId = resolved.accountId;
    const cleanIds = [...new Set((selectedQuestIds ?? []).map(String).filter(Boolean))];
    const enc = _encrypt(token);
    const existing = await _getRec(accountId);
    const record = {
        accountId,
        username: resolved.username,
        ...enc,
        mode: mode === "select" ? "select" : "all",
        selectedQuestIds: mode === "select" ? cleanIds : [],
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
    await db.findOneAndDelete(MODEL, { accountId });
    _publish(accountId, { type: "removed" });
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
        if (rec.status !== "running") continue;
        const token = _decrypt(rec);
        if (!token) {
            await _setStatus(rec.accountId, "token_dead", {
                error: "Không giải mã được token (đổi secret?).",
            });
            continue;
        }
        try {
            const resolved = await resolveDiscordAccount(token);
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
    previewToken,
    startAccount,
    stopAccount,
    removeAccount,
    restore,
};
