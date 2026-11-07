import { useRef, useState } from "react";
import api from "../api/client";
import { Icon, Modal, StatusBadge, Toggle } from "./ui";

/**
 * "Check token(s)" on /quests: the panel tries each stored token on Discord
 * (POST /quests/:accountId/check-token), one account per request so none runs long and
 * the results fill in as it goes. A dead token is recorded the way a run records one
 * (the run stops, Token error); the switch decides whether the buyer is told —
 * ArnTo-Auto then DMs them to send a new token. Off by default: telling a buyer is
 * a message to a customer.
 */

const RESULT = {
    valid: { label: "Works", color: "var(--success)" },
    dead: { label: "Dead", color: "var(--warning)" },
    unknown: { label: "No answer", color: "var(--text-dim)" },
    failed: { label: "Failed", color: "var(--danger)" },
};

const planOf = (a) => (a.mode === "monthly" ? "monthly" : "single");
const keyOf = (a) => `${planOf(a)}:${a.accountId}`;

function ResultRow({ r }) {
    const st = RESULT[r.state] || RESULT.failed;
    return (
        <div style={{ padding: "10px 0", borderTop: "1px solid var(--border-light)", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                <StatusBadge color={st.color}>{st.label}</StatusBadge>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {r.username}
                </span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{r.accountId}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>· {r.plan === "monthly" ? "Monthly plan" : "Single order"}</span>
                {r.notified && (
                    <span style={{ fontSize: 11.5, color: "var(--success)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        · <Icon name="send" size={12} /> Buyer told
                    </span>
                )}
            </div>
            {r.reason && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", wordBreak: "break-word" }}>{r.reason}</p>}
            {r.note && <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)", wordBreak: "break-word" }}>{r.note}</p>}
        </div>
    );
}

export default function QuestTokenCheck({ accounts, onClose, onChanged }) {
    const [notify, setNotify] = useState(false);
    const [results, setResults] = useState([]);
    const [running, setRunning] = useState(false);
    const [checked, setChecked] = useState(0);
    const stopRef = useRef(false);

    const one = accounts.length === 1;

    const run = async () => {
        stopRef.current = false;
        setRunning(true);
        setResults([]);
        setChecked(0);
        for (const a of accounts) {
            if (stopRef.current) break;
            let r;
            try {
                const { data } = await api.post(`/quests/${a.accountId}/check-token`, { plan: planOf(a), notify });
                r = data;
            } catch (e) {
                r = { state: "failed", reason: e.response?.data?.error || "The check could not be run.", notified: false, note: null };
            }
            setResults((prev) => [...prev, { accountId: a.accountId, plan: planOf(a), username: a.username, ...r, key: keyOf(a) }]);
            setChecked((n) => n + 1);
        }
        setRunning(false);
        onChanged?.();
    };

    // Closing mid-way stops after the request in flight.
    const close = () => {
        stopRef.current = true;
        onClose();
    };

    const count = (s) => results.filter((r) => r.state === s).length;
    const told = results.filter((r) => r.notified).length;
    // With many accounts the working ones are just named; a row each is for what needs a look.
    const rows = one ? results : results.filter((r) => r.state !== "valid" || r.note);
    const fine = one ? [] : results.filter((r) => r.state === "valid" && !r.note);

    return (
        <Modal title={one ? `Check token — ${accounts[0].username}` : "Check tokens"} onClose={close} width={600}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                {one
                    ? "Asks Discord whether this account's stored token still works."
                    : `Asks Discord whether each stored token still works — ${accounts.length} account(s), one at a time.`}{" "}
                A dead token stops the run and shows as Token error, the same as when a run hits it.
            </p>

            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", marginTop: 14, borderTop: "1px solid var(--border-light)", borderBottom: "1px solid var(--border-light)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Tell the buyer when a token is dead</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        On: ArnTo-Auto DMs the buyer to send a new token. Off: only the panel records it. Finished
                        single orders and expired plans are never told.
                    </p>
                </div>
                <Toggle checked={notify} disabled={running} onChange={setNotify} title="Tell the buyer when a token is dead" />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                {running ? (
                    <button type="button" className="btn-ghost" onClick={() => (stopRef.current = true)}>
                        <Icon name="stop" /> Stop
                    </button>
                ) : (
                    <button type="button" className="btn-primary" disabled={!accounts.length} onClick={run}>
                        <Icon name="key" /> {one ? "Check token" : `Check ${accounts.length} token(s)`}
                    </button>
                )}
                {running && (
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        Checking {Math.min(checked + 1, accounts.length)}/{accounts.length}…
                    </span>
                )}
                {!running && results.length > 0 && (
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        {count("valid")} work · {count("dead")} dead
                        {count("unknown") + count("failed") > 0 && ` · ${count("unknown") + count("failed")} not checked`}
                        {told > 0 && ` · ${told} buyer(s) told`}
                        {results.length < accounts.length && ` · stopped at ${results.length}/${accounts.length}`}
                    </span>
                )}
            </div>

            {(rows.length > 0 || fine.length > 0) && (
                <div style={{ marginTop: 12 }}>
                    {rows.map((r) => (
                        <ResultRow key={r.key} r={r} />
                    ))}
                    {fine.length > 0 && (
                        <p style={{ margin: 0, padding: "10px 0 0", borderTop: "1px solid var(--border-light)", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                            <span style={{ color: "var(--success)", fontWeight: 600 }}>Works ({fine.length}):</span>{" "}
                            {fine.map((r) => r.username).join(", ")}
                        </p>
                    )}
                </div>
            )}
        </Modal>
    );
}
