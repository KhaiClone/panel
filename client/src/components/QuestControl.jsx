import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";

/**
 * Scheduler card on /quests: pause everything, run the monthly pass or the enroll
 * scan now, and edit when they fire. The schedule is GMT+7 on the server, so every
 * time here is rendered in that zone too, whatever the browser's zone is.
 */

const TZ = "Asia/Ho_Chi_Minh";
const DAYS = [
    [1, "Mon"],
    [2, "Tue"],
    [3, "Wed"],
    [4, "Thu"],
    [5, "Fri"],
    [6, "Sat"],
    [0, "Sun"],
];

const fmtAt = (ms) => {
    if (!ms) return "—";
    if (ms - Date.now() < 60_000) return "now";
    return new Date(ms).toLocaleString("en-GB", {
        timeZone: TZ,
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
};
const fmtClock = (ms) =>
    new Date(ms).toLocaleString("en-GB", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const draftOf = (s) => ({
    run: { enabled: s.run.enabled, days: [...s.run.days], time: s.run.time },
    enroll: { enabled: s.enroll.enabled, time: s.enroll.time },
    concurrency: s.concurrency,
    accountDelaySec: s.accountDelaySec,
});

const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function lastText(last, lastDate) {
    if (last?.error) return `last attempt failed: ${last.error}`;
    if (last) {
        const what = last.aborted ? "stopped" : "finished";
        const n = last.completed != null ? `, ${last.completed} quest(s)` : "";
        return `last ${last.trigger === "manual" ? "manual " : ""}${what} ${fmtClock(last.finishedAt)} — ${last.processed}/${last.total} account(s)${n}`;
    }
    return lastDate ? `last scheduled run ${lastDate}` : "never ran";
}

function Progress({ label, cur, accounts, onStop, busy }) {
    const pct = cur.total ? Math.round((cur.done / cur.total) * 100) : 0;
    return (
        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 10, background: "var(--bg-input)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                    {cur.stopping ? "⏹ Stopping" : "▶"} {label}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 160 }}>
                    {cur.done}/{cur.total} account(s)
                    {cur.completed != null && ` · ${cur.completed} quest(s) done`}
                    {` · ${cur.trigger === "manual" ? "started manually" : "scheduled"} ${fmtClock(cur.startedAt)}`}
                </span>
                {!cur.stopping && (
                    <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy} onClick={onStop}>
                        ■ Stop
                    </button>
                )}
            </div>
            <div style={{ height: 5, borderRadius: 4, background: "var(--border)", overflow: "hidden", marginTop: 8 }}>
                <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", transition: "width .3s" }} />
            </div>
            {accounts?.length > 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--text-dim)" }}>Now: {accounts.join(", ")}</p>
            )}
        </div>
    );
}

function Section({ title, children }) {
    return (
        <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                {title}
            </p>
            {children}
        </div>
    );
}

function Check({ checked, onChange, children }) {
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            {children}
        </label>
    );
}

export default function QuestControl({ runningCount = 0, waitingCount = 0, onChanged }) {
    const [data, setData] = useState(null); // { settings, status }
    const [draft, setDraft] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const [confirm, setConfirm] = useState(null); // "pause" | "run" | "enroll"

    // The settings as last seen from the server, to tell unsaved edits apart.
    const savedRef = useRef(null);

    const apply = useCallback((d) => {
        const prev = savedRef.current;
        savedRef.current = draftOf(d.settings);
        setData(d);
        // Only reset the form while it holds no unsaved edits.
        setDraft((cur) => (cur && prev && !sameDraft(cur, prev) ? cur : draftOf(d.settings)));
    }, []);

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get("/quests/control");
            apply(d);
        } catch (e) {
            setMsg({ ok: false, text: e.response?.data?.error || "Could not load the scheduler." });
        }
    }, [apply]);

    useEffect(() => {
        load();
        const t = setInterval(() => {
            if (document.visibilityState === "visible") load();
        }, 5000);
        return () => clearInterval(t);
    }, [load]);

    const act = async (fn, okText) => {
        setBusy(true);
        setMsg(null);
        try {
            const { data: d } = await fn();
            apply(d);
            if (okText) setMsg({ ok: true, text: okText });
            onChanged?.();
        } catch (e) {
            setMsg({ ok: false, text: e.response?.data?.error || "Failed." });
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const { data: d } = await api.patch("/quests/control/settings", draft);
            savedRef.current = draftOf(d.settings);
            setData(d);
            setDraft(draftOf(d.settings));
            setMsg({ ok: true, text: "Schedule saved." });
        } catch (e) {
            setMsg({ ok: false, text: e.response?.data?.error || "Could not save." });
        } finally {
            setBusy(false);
        }
    };

    if (!data || !draft)
        return (
            <div className="card" style={{ padding: 18, marginBottom: 20, fontSize: 13, color: "var(--text-dim)" }}>
                {msg?.text || "Loading scheduler…"}
            </div>
        );

    const { settings: s, status: st } = data;
    const paused = s.paused;
    const dirty = !sameDraft(draft, draftOf(s));
    const setRun = (patch) => setDraft((d) => ({ ...d, run: { ...d.run, ...patch } }));
    const setEnroll = (patch) => setDraft((d) => ({ ...d, enroll: { ...d.enroll, ...patch } }));
    const toggleDay = (day) =>
        setRun({
            days: draft.run.days.includes(day)
                ? draft.run.days.filter((x) => x !== day)
                : [...draft.run.days, day].sort((a, b) => a - b),
        });

    const pill = paused
        ? { text: `Paused since ${fmtClock(s.pausedAt)}`, color: "#38bdf8" }
        : { text: "Active", color: "var(--success)" };

    const confirms = {
        pause: {
            title: "Pause Auto Quest?",
            message:
                `Stops everything right now: ${runningCount} running single-quest account(s)` +
                `${st.run.current ? ", the monthly pass" : ""}${st.enroll.current ? ", the enroll scan" : ""}.\n\n` +
                "Nothing is lost — stopped accounts resume where they were when you press Resume. " +
                "New orders are accepted but wait for the resume. Buyers are not notified.",
            confirmText: "Pause all",
            danger: true,
            run: () => act(() => api.post("/quests/control/pause"), "Paused."),
        },
        run: {
            title: "Run all monthly accounts now?",
            message:
                `Runs every available quest for all ${st.subscribers} active monthly subscriber(s), ` +
                `${s.concurrency} at a time.\n\nThis is extra — the scheduled run still happens at its time ` +
                "(and then only picks up whatever is left).",
            confirmText: "Run now",
            danger: false,
            run: () => act(() => api.post("/quests/control/run"), "Monthly pass started."),
        },
        enroll: {
            title: "Enroll quests now?",
            message: `Accepts every new quest on all ${st.subscribers} active monthly subscriber(s) without completing them.`,
            confirmText: "Enroll now",
            danger: false,
            run: () => act(() => api.post("/quests/control/enroll"), "Enroll scan started."),
        },
    };

    return (
        <div className="card" style={{ padding: 18, marginBottom: 20 }}>
            {/* ── Header: state + actions ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>⏱ Scheduler</span>
                        <span
                            className="status-pill"
                            style={{ background: pill.color + "22", color: pill.color, border: `1px solid ${pill.color}33` }}
                        >
                            <span className="status-dot" style={{ background: pill.color }} />
                            {pill.text}
                        </span>
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        Monthly pass:{" "}
                        <b style={{ color: "var(--text)" }}>
                            {paused ? "paused" : s.run.enabled ? fmtAt(st.run.nextAt) : "off"}
                        </b>
                        {" · "}Enroll:{" "}
                        <b style={{ color: "var(--text)" }}>
                            {paused ? "paused" : s.enroll.enabled ? fmtAt(st.enroll.nextAt) : "off"}
                        </b>
                        {" · "}
                        {st.subscribers} monthly subscriber(s)
                        {paused && waitingCount > 0 && ` · ${waitingCount} single account(s) waiting`}
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                        className="btn-primary"
                        disabled={busy || paused || !!st.run.current || !st.subscribers}
                        title={paused ? "Resume first" : st.run.current ? "A pass is already running" : ""}
                        onClick={() => setConfirm("run")}
                    >
                        ▶ Run all now
                    </button>
                    <button
                        className="btn-ghost"
                        disabled={busy || paused || !!st.enroll.current || !st.subscribers}
                        onClick={() => setConfirm("enroll")}
                    >
                        ⤓ Enroll now
                    </button>
                    {paused ? (
                        <button className="btn-success" disabled={busy} onClick={() => act(() => api.post("/quests/control/resume"), "Resumed.")}>
                            ▶ Resume
                        </button>
                    ) : (
                        <button className="btn-warning" disabled={busy} onClick={() => setConfirm("pause")}>
                            ⏸ Pause all
                        </button>
                    )}
                </div>
            </div>

            {/* ── What is running now ── */}
            {st.run.current && (
                <Progress
                    label={st.run.current.accountId ? "Monthly run (one account)" : "Monthly pass"}
                    cur={st.run.current}
                    accounts={st.run.accounts}
                    busy={busy}
                    onStop={() => act(() => api.post("/quests/control/stop", { what: "run" }), "Stopping the pass…")}
                />
            )}
            {st.enroll.current && (
                <Progress
                    label="Enroll scan"
                    cur={{ ...st.enroll.current, completed: null }}
                    busy={busy}
                    onStop={() => act(() => api.post("/quests/control/stop", { what: "enroll" }), "Stopping the scan…")}
                />
            )}

            {msg && (
                <p style={{ margin: "12px 0 0", fontSize: 12.5, color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</p>
            )}

            {/* ── Schedule settings ── */}
            <button
                onClick={() => setOpen((o) => !o)}
                style={{ marginTop: 14, background: "none", border: "none", color: "var(--text-dim)", fontSize: 12, cursor: "pointer", padding: 0 }}
            >
                {open ? "▾" : "▸"} Schedule settings{dirty && !open ? " (unsaved)" : ""}
            </button>

            {open && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-light)" }}>
                    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                        <Section title="Monthly pass (complete quests)">
                            <Check checked={draft.run.enabled} onChange={(v) => setRun({ enabled: v })}>
                                Run automatically
                            </Check>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {DAYS.map(([d, label]) => (
                                    <button
                                        key={d}
                                        type="button"
                                        className={draft.run.days.includes(d) ? "btn-primary" : "btn-ghost"}
                                        style={{ padding: "5px 10px", fontSize: 12, minWidth: 46 }}
                                        disabled={!draft.run.enabled}
                                        onClick={() => toggleDay(d)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <div className="form-group" style={{ maxWidth: 160 }}>
                                <label className="label">Time (GMT+7)</label>
                                <input
                                    className="input"
                                    type="time"
                                    style={{ colorScheme: "dark" }}
                                    value={draft.run.time}
                                    disabled={!draft.run.enabled}
                                    onChange={(e) => setRun({ time: e.target.value })}
                                />
                            </div>
                            <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-dim)" }}>{lastText(st.run.last, st.run.lastDate)}</p>
                        </Section>

                        <Section title="Daily enroll (accept new quests)">
                            <Check checked={draft.enroll.enabled} onChange={(v) => setEnroll({ enabled: v })}>
                                Enroll every day
                            </Check>
                            <div className="form-group" style={{ maxWidth: 160 }}>
                                <label className="label">Time (GMT+7)</label>
                                <input
                                    className="input"
                                    type="time"
                                    style={{ colorScheme: "dark" }}
                                    value={draft.enroll.time}
                                    disabled={!draft.enroll.enabled}
                                    onChange={(e) => setEnroll({ time: e.target.value })}
                                />
                            </div>
                            <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-dim)" }}>
                                {lastText(st.enroll.last, st.enroll.lastDate)}
                            </p>
                        </Section>

                        <Section title="Pace">
                            <div className="form-group" style={{ maxWidth: 200 }}>
                                <label className="label">Accounts in parallel (1–10)</label>
                                <input
                                    className="input"
                                    type="number"
                                    min={1}
                                    max={10}
                                    value={draft.concurrency}
                                    onChange={(e) => setDraft((d) => ({ ...d, concurrency: e.target.value === "" ? "" : Number(e.target.value) }))}
                                />
                            </div>
                            <div className="form-group" style={{ maxWidth: 200 }}>
                                <label className="label">Pause between accounts (s)</label>
                                <input
                                    className="input"
                                    type="number"
                                    min={0}
                                    max={300}
                                    value={draft.accountDelaySec}
                                    onChange={(e) => setDraft((d) => ({ ...d, accountDelaySec: e.target.value === "" ? "" : Number(e.target.value) }))}
                                />
                            </div>
                        </Section>
                    </div>

                    <p style={{ margin: "16px 0 0", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
                        If a time has already passed today and today's run hasn't happened yet, it starts right after saving.
                        Single-quest orders always start immediately — the schedule only drives monthly plans.
                    </p>

                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                        <button className="btn-primary" disabled={busy || !dirty} onClick={save}>
                            {busy ? "Saving…" : "Save schedule"}
                        </button>
                        <button className="btn-ghost" disabled={busy || !dirty} onClick={() => setDraft(draftOf(s))}>
                            Reset
                        </button>
                    </div>
                </div>
            )}

            {confirm && (
                <ConfirmModal
                    title={confirms[confirm].title}
                    message={confirms[confirm].message}
                    confirmText={confirms[confirm].confirmText}
                    danger={confirms[confirm].danger}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const c = confirms[confirm];
                        setConfirm(null);
                        c.run();
                    }}
                />
            )}
        </div>
    );
}
