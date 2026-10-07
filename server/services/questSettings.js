const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  Auto Quest run settings, edited on /quests.
//
//  Same shape as lavalinkStore: DEFAULTS live in code and get() merges them
//  over whatever is stored, so a new field needs no migration. Kept in
//  panel.sqlite, so it moves with the panel and survives restarts.
//
//    paused   one switch over EVERYTHING: single-quest loops are suspended
//             (their DB status stays "running", so resuming picks them up),
//             the monthly pass and the enroll scan stop and do not fire, and
//             new orders are stored but wait for the resume.
//    run      when the monthly pass fires (days of week + HH:MM, GMT+7).
//    enroll   when the daily enroll-only scan fires.
//
//  Times are Asia/Ho_Chi_Minh, which has no DST — questMonthly relies on that.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "quest_settings";
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const _hourEnv = (name, fallback) => {
    const h = parseInt(process.env[name] ?? "", 10);
    return `${String(Number.isInteger(h) && h >= 0 && h <= 23 ? h : fallback).padStart(2, "0")}:00`;
};

// The env hours were the only knob before this file existed; they seed the
// defaults so a deployment that set them keeps its schedule.
const DEFAULTS = {
    paused: false,
    pausedAt: null,
    run: { enabled: true, days: [2, 6], time: _hourEnv("MONTHLY_RUN_HOUR", 9) }, // Tue, Sat
    enroll: { enabled: true, time: _hourEnv("MONTHLY_ENROLL_HOUR", 3) },
    // Monthly accounts worked on at the same time. A pass is sequential by default,
    // and one account can take an hour or more, so a long list can run all day.
    concurrency: 1,
    // Pause between two accounts in a monthly pass / enroll scan.
    accountDelaySec: 3,
};

const _bad = (message) => {
    const e = new Error(message);
    e.status = 400;
    return e;
};

function _merge(stored) {
    const s = stored || {};
    return {
        ...DEFAULTS,
        ...s,
        run: { ...DEFAULTS.run, ...(s.run || {}) },
        enroll: { ...DEFAULTS.enroll, ...(s.enroll || {}) },
    };
}

let cache = null;

async function get() {
    if (!cache) cache = _merge(await db.get(KEY));
    return cache;
}

/** Synchronous read for hot paths; defaults until get() has run once (at boot). */
const peek = () => cache ?? _merge(null);

function _time(v, label) {
    const t = String(v ?? "").trim();
    if (!TIME_RE.test(t)) throw _bad(`${label}: the time must look like HH:MM (00:00–23:59).`);
    return t;
}

function _int(v, min, max, label) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw _bad(`${label} must be a whole number ${min}–${max}.`);
    return n;
}

/** Patch the schedule fields. `paused` is not accepted here — use setPaused(). */
async function update(patch = {}) {
    const cur = await get();
    const next = _merge(cur);

    if (patch.run) {
        const r = patch.run;
        if (r.enabled !== undefined) next.run.enabled = !!r.enabled;
        if (r.time !== undefined) next.run.time = _time(r.time, "Run time");
        if (r.days !== undefined) {
            if (!Array.isArray(r.days)) throw _bad("Run days must be a list.");
            const days = [...new Set(r.days.map(Number))].sort((a, b) => a - b);
            if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw _bad("Invalid run days.");
            next.run.days = days;
        }
        if (next.run.enabled && !next.run.days.length) throw _bad("Pick at least one run day (or turn the schedule off).");
    }
    if (patch.enroll) {
        const e = patch.enroll;
        if (e.enabled !== undefined) next.enroll.enabled = !!e.enabled;
        if (e.time !== undefined) next.enroll.time = _time(e.time, "Enroll time");
    }
    if (patch.concurrency !== undefined) next.concurrency = _int(patch.concurrency, 1, 10, "Accounts running in parallel");
    if (patch.accountDelaySec !== undefined)
        next.accountDelaySec = _int(patch.accountDelaySec, 0, 300, "Pause between two accounts (seconds)");

    await db.set(KEY, next);
    cache = next;
    return next;
}

async function setPaused(paused) {
    const next = { ...(await get()), paused: !!paused, pausedAt: paused ? Date.now() : null };
    await db.set(KEY, next);
    cache = next;
    return next;
}

module.exports = { get, peek, update, setPaused, DEFAULTS };
