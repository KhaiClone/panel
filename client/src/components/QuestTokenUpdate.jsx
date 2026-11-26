import { useState } from "react";
import api from "../api/client";
import { Icon, Modal, Notice } from "./ui";

/**
 * "Update token" on an Auto Quest account: paste the account's new token and the panel
 * stores it instead of the old one (POST /quests/:accountId/token). It must log into
 * the same Discord account. It goes on the account's single order and its monthly plan
 * alike; a single order the dead token stopped runs again, a plan uses it from its
 * next pass. No message goes to the buyer.
 */

const PLAN = { single: "Single order", monthly: "Monthly plan" };

export default function QuestTokenUpdate({ account, onClose, onChanged }) {
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);

    const save = async (e) => {
        e.preventDefault();
        if (!token.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { data } = await api.post(`/quests/${account.accountId}/token`, { token: token.trim() });
            setResult(data);
            setToken("");
            onChanged?.();
        } catch (err) {
            setError(err.response?.data?.error || "The token could not be updated.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={`Update token — ${account.username}`} onClose={onClose} width={520}>
            {result ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Notice tone="success">
                        Token updated for <b>{result.username}</b>.
                    </Notice>
                    {result.updated.map((u) => (
                        <div key={u.plan} style={{ paddingTop: 10, borderTop: "1px solid var(--border-light)" }}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{PLAN[u.plan] || u.plan}</p>
                            {u.note && <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{u.note}</p>}
                        </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button type="button" className="btn-primary" onClick={onClose}>
                            Done
                        </button>
                    </div>
                </div>
            ) : (
                <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        Replaces the stored token. The new one must log into this same account
                        (<span className="mono">{account.accountId}</span>) — the panel checks it with Discord first.
                        A single order stopped by a dead token runs again; a monthly plan uses it from its next
                        pass. The buyer gets no message.
                    </p>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>New token</span>
                        <input
                            className="input mono"
                            type="password"
                            autoComplete="off"
                            autoFocus
                            value={token}
                            disabled={busy}
                            onChange={(e) => {
                                setToken(e.target.value);
                                setError(null);
                            }}
                        />
                    </label>
                    {error && <Notice tone="danger">{error}</Notice>}
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary" disabled={busy || !token.trim()}>
                            <Icon name="refresh" /> {busy ? "Checking…" : "Update token"}
                        </button>
                    </div>
                </form>
            )}
        </Modal>
    );
}
