/**
 * questMonthly.js
 * Monthly quest subscriptions on the panel (ported from arnto-auto). arnto-auto keeps
 * payment; when a monthly plan is paid it calls activate() here. The panel then runs
 * ALL quests for active subscribers on the schedule (Tue/Sat) + a daily enroll scan,
 * and webhooks quest events back to arnto-auto (DM the buyer).
 *
 * DB model `quest_monthly`: { _id, accountId, username, tokenEncrypted, tokenIv,
 *   tokenTag, monthlyExpiresAt, webhookUrl, webhookBotId, ref, addedAt, updatedAt }
 *
 * RETENTION — an expired plan is kept ONE WEEK so the customer can still renew
 * (activate() extends monthlyExpiresAt). Past that grace window an un-renewed plan is
 * erased by the hourly sweep: record, encrypted token and live quest state all go.
 */

const crypto = require("crypto");
const db = require("../db");
const questService = require("./questService");
const proxyPool = require("./proxyPool");
const lifecycle = require("./lifecycle");
const callbacks = require("./callbackService");
const {
    QuestAutocompleter,
    resolveDiscordAccount,
    isInvalidTokenError,
    summarizeQuest,
    _fields,
} = require("./questEngine");

const MODEL = "quest_monthly";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_DAYS = [2, 6]; // Tue, Sat
// An expired plan stays listed so the customer can still renew it; one week after it
// ended without a renewal the record (encrypted token included) is erased by the sweep.
const GRACE_DAYS = Math.max(1, parseInt(process.env.MONTHLY_GRACE_DAYS || "7", 10) || 7);
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RUN_HOUR = () => parseInt(process.env.MONTHLY_RUN_HOUR || "9", 10) || 9;
const ENROLL_HOUR = () => parseInt(process.env.MONTHLY_ENROLL_HOUR || "3", 10) || 3;
const { isEnrolled, isCompleted, isCompletable, getQuestName, getTaskType } = _fields;

// ── token crypto (same scheme as questService) ──────────────────────────────────
const ALGO = "aes-256-gcm";
const _key = () =>
    crypto
        .createHash("sha256")
        .update(process.env.QUEST_ENC_SECRET || process.env.JWT_SECRET || "quest-fallback-secret")
        .digest();
function _encrypt(token) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, _key(), iv);
    const enc = Buffer.concat([c.update(String(token), "utf8"), c.final()]);
    return { tokenEncrypted: enc.toString("base64"), tokenIv: iv.toString("base64"), tokenTag: c.getAuthTag().toString("base64") };
}
function _decrypt(r) {
    try {
        const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(r.tokenIv, "base64"));
        d.setAuthTag(Buffer.from(r.tokenTag, "base64"));
        return Buffer.concat([d.update(Buffer.from(r.tokenEncrypted, "base64")), d.final()]).toString("utf8");
    } catch {
        return null;
    }
}
function _expiresMs(r) {
    return new Date(r?.monthlyExpiresAt ?? 0).getTime(); // NaN when the field is unusable
}
function _isActive(r) {
    return _expiresMs(r) > Date.now();
}
/** When an un-renewed plan gets erased: one week after it expired. */
function _purgeAt(r) {
    return _expiresMs(r) + GRACE_MS;
}
/** A record with an unreadable date is never swept; it just stays listed as expired. */
function _isPurgeable(r) {
    const at = _purgeAt(r);
    return Number.isFinite(at) && at <= Date.now();
}
function _webhook(rec, event) {
    if (!rec.webhookUrl) return;
    // Address and x-api-key follow the project that registered it (callbackService).
    // username + plan let arnto-auto say whose account this is in the
    // notification it posts, without asking the panel for the record.
    callbacks.send(rec.webhookUrl, rec.webhookBotId ?? null, {
        ...event,
        accountId: rec.accountId,
        ref: rec.ref ?? null,
        username: rec.username,
        plan: "monthly",
    });
}

// ── Public API ───────────────────────────────────────────────────────────────────
async function activate({ token, months = 1, ref, webhookUrl, webhookBotId = null }) {
    const resolved = await resolveDiscordAccount(token, await proxyPool.agentForKey(token));
    if (!resolved.ok) {
        const e = new Error(resolved.reason);
        e.status = resolved.invalidToken ? 401 : 502;
        throw e;
    }
    const m = Math.max(0, parseInt(months, 10) || 0);
    const accountId = resolved.accountId;
    const existing = await db.findOne(MODEL, { accountId });
    const base = _isActive(existing) ? new Date(existing.monthlyExpiresAt).getTime() : Date.now();
    const monthlyExpiresAt = new Date(base + m * MONTH_MS).toISOString();
    const rec = {
        accountId,
        username: resolved.username,
        ..._encrypt(token),
        monthlyExpiresAt,
        webhookUrl: webhookUrl ?? existing?.webhookUrl ?? null,
        // The owner goes with the URL: a new URL brings its caller's project.
        webhookBotId: webhookUrl ? webhookBotId : (existing?.webhookBotId ?? null),
        ref: ref ?? existing?.ref ?? null,
        addedAt: existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
    };
    if (existing) await db.findOneAndUpdate(MODEL, { accountId }, rec);
    else await db.create(MODEL, rec);
    return { accountId, username: resolved.username, monthlyExpiresAt, months: m };
}

async function listActive() {
    return ((await db.get(MODEL)) || []).filter(_isActive);
}

function _publicRec(r) {
    return {
        accountId: r.accountId,
        username: r.username,
        monthlyExpiresAt: r.monthlyExpiresAt,
        active: _isActive(r),
        purgeAt: _purgeAt(r),
        ref: r.ref ?? null,
    };
}
/** Plans past their grace window are hidden right away, before the sweep erases them. */
async function list() {
    return ((await db.get(MODEL)) || []).filter((r) => !_isPurgeable(r)).map(_publicRec);
}
async function remove(accountId) {
    await db.findOneAndDelete(MODEL, { accountId });
    return true;
}

// ── Retention sweep: erase plans a week past expiry (no renewal) ─────────────────
/**
 * Deletes the record (encrypted token included), drops its live quest state and tells
 * the panel + arnto-auto the account is gone. A renewal pushes monthlyExpiresAt
 * forward, so a renewed plan never reaches this.
 */
async function purgeExpired() {
    const recs = (await db.get(MODEL)) || [];
    let purged = 0;
    for (const rec of recs) {
        if (!_isPurgeable(rec)) continue;
        try {
            await db.findOneAndDelete(MODEL, { accountId: rec.accountId });
            questService.clearLive(rec.accountId);
            questService.emitExternalEvent(rec.accountId, { type: "removed" });
            _webhook(rec, { type: "removed", reason: "monthly_expired" });
            purged++;
        } catch (e) {
            console.warn(`[Monthly] retention purge ${rec.accountId} error: ${e.message}`);
        }
    }
    if (purged)
        console.log(`[Monthly] Retention: erased ${purged} plan(s) expired for more than ${GRACE_DAYS}d.`);
    return purged;
}

/** Purge now, then keep checking hourly. */
function startRetentionSweep() {
    purgeExpired().catch((e) => console.warn("[Monthly] retention sweep:", e.message));
    const timer = setInterval(
        lifecycle.guard(() => purgeExpired().catch((e) => console.warn("[Monthly] retention sweep:", e.message))),
        SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    return timer;
}

// ── Run: complete ALL quests for every active subscriber (one pass) ──────────────
// `abort.stopped` ends the pass early (the panel is moving to another node); the
// run is then not recorded as done, so the next panel's scheduler starts it over
// — quests already completed are skipped by isCompleted.
async function runBatch(abort = { stopped: false }) {
    const accts = await listActive();
    let processed = 0,
        completed = 0;
    for (const rec of accts) {
        if (abort.stopped) break;
        const token = _decrypt(rec);
        if (!token) continue;
        // Hold the egress lease for the whole pass — the pool will not rotate this
        // proxy's IP while it is out (see proxyPool.acquire).
        const lease = await proxyPool.acquire(token);
        let egressFailed = false;
        try {
            const resolved = await resolveDiscordAccount(token, lease.agent);
            if (!resolved.ok) {
                egressFailed = !resolved.invalidToken;
                if (resolved.invalidToken) {
                    questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
                    _webhook(rec, { type: "status", status: "token_dead" });
                }
                continue;
            }
            // Reset this account's live state so /quests shows the current batch, then
            // feed quest_start/progress/done (with media) into the shared realtime bus
            // — this is what makes monthly accounts render quest cards like single ones.
            questService.clearLive(rec.accountId);
            questService.emitExternalEvent(rec.accountId, { type: "status", status: "running" });
            const completer = new QuestAutocompleter(resolved.api, {
                label: rec.username,
                abort,
                onEvent: (e) => questService.emitExternalEvent(rec.accountId, e),
            });

            // Pre-scan: enroll everything up front, then emit a "pending" card for
            // every quest that will run — so the panel shows the FULL set immediately
            // (before completing them one by one). Enroll is idempotent, so the loop
            // below re-enrolling is harmless.
            let scan = await completer.fetchQuests();
            if (scan.length) {
                await completer.autoAccept(scan);
                scan = await completer.fetchQuests();
                for (const q of scan) {
                    if (isEnrolled(q) && !isCompleted(q) && isCompletable(q)) {
                        const s = summarizeQuest(q);
                        questService.emitExternalEvent(rec.accountId, {
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

            let guard = 0;
            while (!abort.stopped && guard++ < 10) {
                let quests = await completer.fetchQuests();
                if (!quests.length) break;
                quests = await completer.autoAccept(quests);
                const actionable = quests.filter(
                    (q) => isEnrolled(q) && !isCompleted(q) && isCompletable(q) && !completer.completedIds.has(q.id),
                );
                if (!actionable.length) break;
                // The batch runs for hours, so take the soonest-expiring quest first —
                // otherwise a quest can expire while it is still waiting its turn.
                actionable.sort((a, b) => {
                    const ea = new Date(a.config?.expires_at ?? a.config?.expiresAt ?? 8.64e15).getTime();
                    const eb = new Date(b.config?.expires_at ?? b.config?.expiresAt ?? 8.64e15).getTime();
                    return ea - eb;
                });
                for (const q of actionable) {
                    if (abort.stopped) break;
                    const r = await completer.processQuest(q);
                    if (r?.skipped) continue;
                    completed++;
                    _webhook(rec, { type: "quest_done", questName: getQuestName(q), taskType: getTaskType(q) });
                }
            }
            // Back to the idle "monthly" badge once this account's pass is done.
            questService.emitExternalEvent(rec.accountId, { type: "status", status: "monthly" });
            processed++;
        } catch (e) {
            if (e?.aborted) {
                // Suspended for a panel move — not the egress route's fault.
            } else if (isInvalidTokenError(e)) {
                questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
                _webhook(rec, { type: "status", status: "token_dead" });
            } else {
                egressFailed = true;
                console.error(`[Monthly] ${rec.username} error: ${e.message}`);
            }
        } finally {
            lease.release({ failed: egressFailed });
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return { processed, completed, total: accts.length, aborted: abort.stopped };
}

// ── Daily enroll-only scan (no completion) ───────────────────────────────────────
async function runEnrollScan(abort = { stopped: false }) {
    const accts = await listActive();
    let processed = 0;
    for (const rec of accts) {
        if (abort.stopped) break;
        const token = _decrypt(rec);
        if (!token) continue;
        const lease = await proxyPool.acquire(token);
        try {
            const resolved = await resolveDiscordAccount(token, lease.agent);
            if (!resolved.ok) continue;
            const completer = new QuestAutocompleter(resolved.api, { label: rec.username });
            const quests = await completer.fetchQuests();
            if (quests.length) await completer.autoAccept(quests);
            processed++;
        } catch (e) {
            if (!isInvalidTokenError(e)) console.error(`[MonthlyEnroll] ${rec.username}: ${e.message}`);
        } finally {
            lease.release();
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return { processed, total: accts.length, aborted: abort.stopped };
}

// ── Schedulers (Asia/Ho_Chi_Minh; catch-up + crash-safe like arnto-auto) ─────────
function _vnParts() {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        weekday: "short",
        hour: "numeric",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { weekday: dayMap[p.weekday], hour: parseInt(p.hour, 10) % 24, dateStr: `${p.year}-${p.month}-${p.day}` };
}

let runInProgress = false;
let enrollInProgress = false;
// The pass in flight, so abortRuns() can stop it: { abort, promise } | null.
let currentRun = null;
let currentEnroll = null;

/**
 * Stop the monthly pass and the enroll scan if one is running (the panel is
 * handing over to another node). An aborted pass is not recorded as done, so
 * the next panel starts it again. Resolves once they have stopped or after
 * timeoutMs; true when something was running.
 */
async function abortRuns({ timeoutMs = 30_000 } = {}) {
    const active = [currentRun, currentEnroll].filter(Boolean);
    for (const r of active) r.abort.stopped = true;
    await Promise.race([
        Promise.allSettled(active.map((r) => r.promise)),
        new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    return active.length > 0;
}

async function _checkRun() {
    try {
        const { weekday, hour, dateStr } = _vnParts();
        if (!RUN_DAYS.includes(weekday) || hour < RUN_HOUR()) return;
        if (runInProgress) return;
        if ((await db.get("quest_monthly_last_run")) === dateStr) return;
        runInProgress = true;
        try {
            console.log(`[Monthly] Scheduled run start (${dateStr})`);
            currentRun = { abort: { stopped: false }, promise: null };
            currentRun.promise = runBatch(currentRun.abort);
            const res = await currentRun.promise;
            if (res.aborted) {
                console.log("[Monthly] Run suspended before finishing — it restarts on the next check.");
                return;
            }
            await db.set("quest_monthly_last_run", dateStr);
            console.log(`[Monthly] Done: ${res.processed}/${res.total} account(s), ${res.completed} quest(s).`);
        } finally {
            runInProgress = false;
            currentRun = null;
        }
    } catch (e) {
        console.warn("[Monthly] scheduler:", e.message);
    }
}

async function _checkEnroll() {
    try {
        const { hour, dateStr } = _vnParts();
        if (hour < ENROLL_HOUR()) return;
        if (enrollInProgress) return;
        if ((await db.get("quest_monthly_last_enroll")) === dateStr) return;
        enrollInProgress = true;
        try {
            console.log(`[MonthlyEnroll] Daily enroll scan start (${dateStr})`);
            currentEnroll = { abort: { stopped: false }, promise: null };
            currentEnroll.promise = runEnrollScan(currentEnroll.abort);
            const res = await currentEnroll.promise;
            if (res.aborted) return;
            await db.set("quest_monthly_last_enroll", dateStr);
            console.log(`[MonthlyEnroll] Done: ${res.processed}/${res.total} account(s).`);
        } finally {
            enrollInProgress = false;
            currentEnroll = null;
        }
    } catch (e) {
        console.warn("[MonthlyEnroll] scheduler:", e.message);
    }
}

/** Whether a monthly pass / enroll scan is in flight (the panel-move preflight shows it). */
const busy = () => ({ run: runInProgress, enroll: enrollInProgress });

function start() {
    startRetentionSweep();
    _checkRun().catch(() => {});
    _checkEnroll().catch(() => {});
    setInterval(lifecycle.guard(() => _checkRun().catch(() => {})), 60 * 1000);
    setInterval(lifecycle.guard(() => _checkEnroll().catch(() => {})), 60 * 1000);
}

module.exports = {
    abortRuns,
    busy,
    activate,
    list,
    remove,
    listActive,
    runBatch,
    runEnrollScan,
    purgeExpired,
    startRetentionSweep,
    GRACE_DAYS,
    start,
};
