/**
 * questMonthly.js
 * Monthly quest subscriptions on the panel (ported from arnto-auto). arnto-auto keeps
 * payment; when a monthly plan is paid it calls activate() here. The panel then runs
 * ALL quests for active subscribers on the schedule (default Tue/Sat 09:00) + a daily
 * enroll scan (default 03:00), and webhooks quest events back to arnto-auto (DM the
 * buyer). The schedule, the pause switch and "run now" live in questSettings and are
 * driven from /quests.
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
const questSettings = require("./questSettings");
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
// An expired plan stays listed so the customer can still renew it; one week after it
// ended without a renewal the record (encrypted token included) is erased by the sweep.
const GRACE_DAYS = Math.max(1, parseInt(process.env.MONTHLY_GRACE_DAYS || "7", 10) || 7);
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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
    if (!rec.webhookUrl && !rec.webhookBotId) return;
    // Address and x-api-key follow the project that registered it (callbackService).
    // username + plan let arnto-auto say whose account this is in the
    // notification it posts, without asking the panel for the record.
    callbacks.send(rec.webhookUrl, rec.webhookBotId ?? null, {
        ...event,
        accountId: rec.accountId,
        ref: rec.ref ?? null,
        username: rec.username,
        plan: "monthly",
    }, "quest.event");
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
        webhookBotId: webhookUrl || webhookBotId ? webhookBotId : (existing?.webhookBotId ?? null),
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
// `abort.stopped` ends the pass early (paused, stopped from /quests, or the panel is
// moving to another node); a scheduled run is then not recorded as done, so the next
// check starts it over — quests already completed are skipped by isCompleted.

// accountId -> username for the accounts a pass is working on right now. The list on
// /quests shows them as running instead of the idle "monthly" badge.
const activeIds = new Map();
const isRunning = (accountId) => activeIds.has(accountId);

/** Wait `sec` seconds, but give up as soon as the pass is stopped. */
async function _gap(sec, abort) {
    const until = Date.now() + sec * 1000;
    while (!abort.stopped && Date.now() < until)
        await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
}

/** One subscriber: enroll everything, then complete every quest. */
async function _runAccount(rec, abort) {
    const token = _decrypt(rec);
    if (!token) return { ok: false, completed: 0 };
    // Hold the egress lease for the whole pass — the pool will not rotate this
    // proxy's IP while it is out (see proxyPool.acquire).
    const lease = await proxyPool.acquire(token);
    let egressFailed = false;
    let ok = false;
    let completed = 0;
    let started = false;
    activeIds.set(rec.accountId, rec.username);
    try {
        const resolved = await resolveDiscordAccount(token, lease.agent);
        if (!resolved.ok) {
            egressFailed = !resolved.invalidToken;
            if (resolved.invalidToken) {
                questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
                _webhook(rec, { type: "status", status: "token_dead" });
            }
            return { ok, completed };
        }
        // Reset this account's live state so /quests shows the current batch, then
        // feed quest_start/progress/done (with media) into the shared realtime bus
        // — this is what makes monthly accounts render quest cards like single ones.
        questService.clearLive(rec.accountId);
        questService.emitExternalEvent(rec.accountId, { type: "status", status: "running" });
        started = true;
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
        ok = true;
    } catch (e) {
        if (e?.aborted) {
            // Stopped (pause / Stop / panel move) — not the egress route's fault.
        } else if (isInvalidTokenError(e)) {
            started = false; // keep the token_dead badge, not the idle one
            questService.emitExternalEvent(rec.accountId, { type: "status", status: "token_dead" });
            _webhook(rec, { type: "status", status: "token_dead" });
        } else {
            egressFailed = true;
            console.error(`[Monthly] ${rec.username} error: ${e.message}`);
        }
    } finally {
        lease.release({ failed: egressFailed });
        activeIds.delete(rec.accountId);
        // Back to the idle "monthly" badge once this account's pass is over, finished or not.
        if (started) questService.emitExternalEvent(rec.accountId, { type: "status", status: "monthly" });
    }
    return { ok, completed };
}

/**
 * One pass over the active subscribers (or just `accountIds`), `concurrency` accounts
 * at a time. `progress` is filled in as it goes, for the status on /quests.
 */
async function runBatch(abort = { stopped: false }, { accountIds = null, progress = {} } = {}) {
    const settings = await questSettings.get();
    let accts = await listActive();
    if (accountIds) accts = accts.filter((r) => accountIds.includes(r.accountId));
    Object.assign(progress, { total: accts.length, done: 0, processed: 0, completed: 0 });

    let next = 0;
    const worker = async () => {
        while (!abort.stopped && next < accts.length) {
            const rec = accts[next++];
            const r = await _runAccount(rec, abort);
            progress.done++;
            if (r.ok) progress.processed++;
            progress.completed += r.completed;
            if (next < accts.length) await _gap(settings.accountDelaySec, abort);
        }
    };
    const workers = Math.max(1, Math.min(settings.concurrency, accts.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return { processed: progress.processed, completed: progress.completed, total: accts.length, aborted: abort.stopped };
}

// ── Daily enroll-only scan (no completion) ───────────────────────────────────────
async function runEnrollScan(abort = { stopped: false }, { progress = {} } = {}) {
    const settings = await questSettings.get();
    const accts = await listActive();
    Object.assign(progress, { total: accts.length, done: 0, processed: 0 });
    for (const rec of accts) {
        if (abort.stopped) break;
        const token = _decrypt(rec);
        progress.done++;
        if (!token) continue;
        const lease = await proxyPool.acquire(token);
        try {
            const resolved = await resolveDiscordAccount(token, lease.agent);
            if (!resolved.ok) continue;
            const completer = new QuestAutocompleter(resolved.api, { label: rec.username });
            const quests = await completer.fetchQuests();
            if (quests.length) await completer.autoAccept(quests);
            progress.processed++;
        } catch (e) {
            if (!isInvalidTokenError(e)) console.error(`[MonthlyEnroll] ${rec.username}: ${e.message}`);
        } finally {
            lease.release();
        }
        await _gap(settings.accountDelaySec, abort);
    }
    return { processed: progress.processed, total: accts.length, aborted: abort.stopped };
}

// ── Schedulers (Asia/Ho_Chi_Minh; catch-up + crash-safe like arnto-auto) ─────────
// The days and times come from questSettings (edited on /quests). Vietnam has no
// DST, so a fixed +7h offset is exact and lets nextAt() do plain date arithmetic.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const LAST_RUN_KEY = "quest_monthly_last_run";
const LAST_ENROLL_KEY = "quest_monthly_last_enroll";

function _vnParts(at = Date.now()) {
    const d = new Date(at + VN_OFFSET_MS);
    return {
        weekday: d.getUTCDay(),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        dateStr: d.toISOString().slice(0, 10),
    };
}
const _minutesOf = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + m;
};

/**
 * When the scheduler fires next: the first allowed day (today included) that has not
 * run yet, at `time`. A slot that is already past but has not run is due now — the
 * scheduler catches it up on its next check.
 */
function nextAt(days, time, lastDate) {
    const now = Date.now();
    const today = new Date(now + VN_OFFSET_MS);
    for (let off = 0; off <= 7; off++) {
        const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + off));
        if (!days.includes(day.getUTCDay())) continue;
        if (day.toISOString().slice(0, 10) === lastDate) continue;
        return Math.max(now, day.getTime() + _minutesOf(time) * 60_000 - VN_OFFSET_MS);
    }
    return null;
}

// The pass / enroll scan in flight: { trigger, accountId, startedAt, abort, progress, promise } | null.
// Only one of each at a time, scheduled or manual.
let currentRun = null;
let currentEnroll = null;
// What the last pass / scan ended with (in memory — for the status line only).
const lastResult = { run: null, enroll: null };

function _conflict(message, status = 409) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/** Start a pass unless one is already going. Resolves with its result; null when busy. */
function _startRun(trigger, accountId = null) {
    if (currentRun) return null;
    const run = { trigger, accountId, startedAt: Date.now(), abort: { stopped: false }, progress: {} };
    currentRun = run;
    run.promise = runBatch(run.abort, { accountIds: accountId ? [accountId] : null, progress: run.progress })
        .then((res) => {
            lastResult.run = { ...res, trigger, accountId, startedAt: run.startedAt, finishedAt: Date.now() };
            return res;
        })
        .catch((e) => {
            lastResult.run = { error: e.message, trigger, accountId, startedAt: run.startedAt, finishedAt: Date.now() };
            throw e;
        })
        .finally(() => {
            if (currentRun === run) currentRun = null;
        });
    return run.promise;
}

function _startEnroll(trigger) {
    if (currentEnroll) return null;
    const scan = { trigger, startedAt: Date.now(), abort: { stopped: false }, progress: {} };
    currentEnroll = scan;
    scan.promise = runEnrollScan(scan.abort, { progress: scan.progress })
        .then((res) => {
            lastResult.enroll = { ...res, trigger, startedAt: scan.startedAt, finishedAt: Date.now() };
            return res;
        })
        .catch((e) => {
            lastResult.enroll = { error: e.message, trigger, startedAt: scan.startedAt, finishedAt: Date.now() };
            throw e;
        })
        .finally(() => {
            if (currentEnroll === scan) currentEnroll = null;
        });
    return scan.promise;
}

/**
 * Stop the monthly pass and the enroll scan if one is running (paused, or the panel
 * is handing over to another node). An aborted pass is not recorded as done, so the
 * next check starts it again. Resolves once they have stopped or after timeoutMs;
 * true when something was running.
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
        const s = await questSettings.get();
        if (s.paused || !s.run.enabled) return;
        const { weekday, minutes, dateStr } = _vnParts();
        if (!s.run.days.includes(weekday) || minutes < _minutesOf(s.run.time)) return;
        if (currentRun) return;
        if ((await db.get(LAST_RUN_KEY)) === dateStr) return;
        const pending = _startRun("schedule");
        if (!pending) return; // a manual pass got in first; caught up after it ends
        console.log(`[Monthly] Scheduled run start (${dateStr})`);
        const res = await pending;
        if (res.aborted) {
            console.log("[Monthly] Run suspended before finishing — it restarts on the next check.");
            return;
        }
        await db.set(LAST_RUN_KEY, dateStr);
        console.log(`[Monthly] Done: ${res.processed}/${res.total} account(s), ${res.completed} quest(s).`);
    } catch (e) {
        console.warn("[Monthly] scheduler:", e.message);
    }
}

async function _checkEnroll() {
    try {
        const s = await questSettings.get();
        if (s.paused || !s.enroll.enabled) return;
        const { minutes, dateStr } = _vnParts();
        if (minutes < _minutesOf(s.enroll.time)) return;
        if (currentEnroll) return;
        if ((await db.get(LAST_ENROLL_KEY)) === dateStr) return;
        const pending = _startEnroll("schedule");
        if (!pending) return;
        console.log(`[MonthlyEnroll] Daily enroll scan start (${dateStr})`);
        const res = await pending;
        if (res.aborted) return;
        await db.set(LAST_ENROLL_KEY, dateStr);
        console.log(`[MonthlyEnroll] Done: ${res.processed}/${res.total} account(s).`);
    } catch (e) {
        console.warn("[MonthlyEnroll] scheduler:", e.message);
    }
}

/** Check both schedules now instead of on the next minute tick (after a resume or an edit). */
function kick() {
    if (!lifecycle.isActive()) return;
    _checkRun().catch(() => {});
    _checkEnroll().catch(() => {});
}

// ── Manual controls (/quests) ────────────────────────────────────────────────────

/**
 * Run a pass right now — every active subscriber, or one `accountId`. Outside the
 * schedule: it does not count as the day's scheduled run, which still fires (and
 * then only picks up whatever the manual pass left).
 */
async function runNow({ accountId = null } = {}) {
    if ((await questSettings.get()).paused) throw _conflict("Auto Quest đang tạm dừng — bấm Tiếp tục trước.");
    if (accountId) {
        const rec = await db.findOne(MODEL, { accountId });
        if (!rec) throw _conflict("Không tìm thấy gói tháng của account này.", 404);
        if (!_isActive(rec)) throw _conflict("Gói tháng của account này đã hết hạn.");
    }
    const pending = _startRun("manual", accountId);
    if (!pending) throw _conflict("Đang có một lượt chạy monthly — đợi xong hoặc bấm Dừng.");
    console.log(`[Monthly] Manual run start${accountId ? ` (${accountId})` : ""}`);
    pending
        .then((res) => console.log(`[Monthly] Manual run ${res.aborted ? "stopped" : "done"}: ${res.processed}/${res.total} account(s), ${res.completed} quest(s).`))
        .catch((e) => console.warn("[Monthly] manual run:", e.message));
    return status();
}

/** Enroll scan right now. Like runNow, it does not replace the day's scheduled scan. */
async function enrollNow() {
    if ((await questSettings.get()).paused) throw _conflict("Auto Quest đang tạm dừng — bấm Tiếp tục trước.");
    const pending = _startEnroll("manual");
    if (!pending) throw _conflict("Đang có một lượt nhận quest — đợi xong hoặc bấm Dừng.");
    console.log("[MonthlyEnroll] Manual enroll scan start");
    pending
        .then((res) => console.log(`[MonthlyEnroll] Manual scan ${res.aborted ? "stopped" : "done"}: ${res.processed}/${res.total} account(s).`))
        .catch((e) => console.warn("[MonthlyEnroll] manual scan:", e.message));
    return status();
}

/** Ask the pass and/or the scan to stop; does not wait for them. */
function stop({ run = true, enroll = true } = {}) {
    if (run && currentRun) currentRun.abort.stopped = true;
    if (enroll && currentEnroll) currentEnroll.abort.stopped = true;
}

/** Whether a monthly pass / enroll scan is in flight (the panel-move preflight shows it). */
const busy = () => ({ run: !!currentRun, enroll: !!currentEnroll });

/** Everything the scheduler card on /quests shows. */
async function status() {
    const s = await questSettings.get();
    const [lastRunDate, lastEnrollDate, subscribers] = await Promise.all([
        db.get(LAST_RUN_KEY),
        db.get(LAST_ENROLL_KEY),
        listActive().then((l) => l.length),
    ]);
    const view = (r) =>
        r && {
            trigger: r.trigger,
            accountId: r.accountId ?? null,
            startedAt: r.startedAt,
            stopping: r.abort.stopped,
            ...r.progress,
        };
    return {
        subscribers,
        run: {
            current: view(currentRun),
            accounts: [...activeIds.values()],
            lastDate: lastRunDate ?? null,
            last: lastResult.run,
            nextAt: s.paused || !s.run.enabled ? null : nextAt(s.run.days, s.run.time, lastRunDate),
        },
        enroll: {
            current: view(currentEnroll),
            lastDate: lastEnrollDate ?? null,
            last: lastResult.enroll,
            nextAt: s.paused || !s.enroll.enabled ? null : nextAt(ALL_DAYS, s.enroll.time, lastEnrollDate),
        },
    };
}

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
    isRunning,
    runBatch,
    runEnrollScan,
    runNow,
    enrollNow,
    stop,
    kick,
    status,
    nextAt,
    purgeExpired,
    startRetentionSweep,
    GRACE_DAYS,
    start,
};
