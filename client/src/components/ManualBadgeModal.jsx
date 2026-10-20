import { useMemo, useState } from "react";
import api from "../api/client";
import { Field, Modal, Notice } from "./ui";

// Add an account to Auto Badge by hand — no payment, owner only
// (server: badgeService.createManualOrder). The order then runs exactly like a
// paid one: read the progress, plan, send. An account whose progress Discord
// will not show (no Nitro…) can still be sent to: the owner types its current
// value, and a wrong number means sending too much or too little.

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtNum = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("vi-VN") : "—");
const HOUSES = { 1: "Bravery", 2: "Brilliance", 3: "Balance" };

const UNREADABLE = {
    needsNitro: "No Nitro, so Discord does not show this account its own Game Time / Game Variety progress.",
    unreadable: "Discord does not show this account its Game Time / Game Variety progress, even with Nitro.",
    error: "Could not read this account's Game Time / Game Variety progress.",
};

/** The highest tier `value` has reached, or null. */
const tierAt = (badge, value) =>
    Number.isFinite(value)
        ? [...badge.tiers].reverse().find((t) => Number.isFinite(t.threshold) && value >= t.threshold) || null
        : null;

function AccountSummary({ account }) {
    const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, padding: "3px 0" };
    return (
        <div className="card" style={{ padding: "10px 12px" }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                {account.username}
                <span className="mono" style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                    {account.accountId}
                </span>
                <span style={{ marginLeft: 8, fontSize: 11, color: account.hasNitro ? "var(--success)" : "var(--warning)" }}>
                    {account.hasNitro ? "Nitro" : "no Nitro"}
                </span>
            </div>
            {account.catalog.map((b) => {
                let text;
                if (b.kind === "choice") {
                    text = account.hypesquadHouse ? HOUSES[account.hypesquadHouse] : "none";
                } else {
                    const v = account.values?.[b.key]?.value;
                    const t = tierAt(b, v);
                    text = Number.isFinite(v) ? `${fmtNum(v)} ${b.unit}${t ? ` · ${t.name}` : ""}` : "not readable";
                }
                return (
                    <div key={b.key} style={row}>
                        <span style={{ color: "var(--text-muted)" }}>{b.label}</span>
                        <span className="mono">{text}</span>
                    </div>
                );
            })}
        </div>
    );
}

export default function ManualBadgeModal({ onClose, onCreated }) {
    const [token, setToken] = useState("");
    const [account, setAccount] = useState(null);
    const [checking, setChecking] = useState(false);
    const [badgeKey, setBadgeKey] = useState("");
    const [tierKey, setTierKey] = useState("");
    const [currentValue, setCurrentValue] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [created, setCreated] = useState(null);

    const badge = account?.catalog.find((b) => b.key === badgeKey) || null;
    const readValue = badge && badge.kind !== "choice" ? account.values?.[badge.key]?.value : null;
    const readable = Number.isFinite(readValue);
    const needsValue = Boolean(badge && badge.kind !== "choice" && !readable);

    // Tiers the account already has are not offered — the server refuses them too.
    const tiers = useMemo(() => {
        if (!badge) return [];
        return badge.tiers.map((t) => {
            const has = badge.kind === "choice" ? account.hypesquadHouse === t.houseId : readable && readValue >= t.threshold;
            return { ...t, has };
        });
    }, [badge, account, readable, readValue]);

    const tier = tiers.find((t) => t.key === tierKey) || null;
    const entered = currentValue === "" ? NaN : Number(currentValue);
    const current = readable ? readValue : entered;
    const enteredOk = !needsValue || (Number.isFinite(entered) && entered >= 0);
    const tooHigh = tier && badge?.kind !== "choice" && Number.isFinite(current) && current >= tier.threshold;
    const need = tier && badge?.kind !== "choice" && Number.isFinite(current) && !tooHigh
        ? Math.ceil((tier.threshold - current) * (account.overshoot || 1))
        : null;
    const canCreate = !busy && account && tier && !tier.has && enteredOk && !tooHigh;

    const pickBadge = (key) => {
        setBadgeKey(key);
        setCurrentValue("");
        const b = account.catalog.find((x) => x.key === key);
        const v = account.values?.[key]?.value;
        const first = b.tiers.find((t) =>
            b.kind === "choice" ? account.hypesquadHouse !== t.houseId : !Number.isFinite(v) || v < t.threshold,
        );
        setTierKey(first?.key || "");
    };

    const check = async (e) => {
        e?.preventDefault();
        if (!token.trim()) return;
        setChecking(true);
        setError("");
        setAccount(null);
        setBadgeKey("");
        setTierKey("");
        try {
            const { data } = await api.post("/badges/manual/check", { token: token.trim() }, { timeout: 60_000 });
            setAccount(data);
        } catch (err) {
            setError(errMsg(err, "Could not check the token"));
        } finally {
            setChecking(false);
        }
    };

    const create = async (e) => {
        e.preventDefault();
        if (!canCreate) return;
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post(
                "/badges/manual",
                { token: token.trim(), badgeKey, tierKey, currentValue: needsValue ? entered : null, note },
                { timeout: 60_000 },
            );
            setCreated(data);
            onCreated?.();
        } catch (err) {
            setError(errMsg(err, "Could not create the order"));
        } finally {
            setBusy(false);
        }
    };

    const again = () => {
        setToken("");
        setAccount(null);
        setBadgeKey("");
        setTierKey("");
        setCurrentValue("");
        setNote("");
        setError("");
        setCreated(null);
    };

    if (created) {
        return (
            <Modal title="Add account by hand" onClose={onClose} width={560}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <Notice tone="success">
                        <b>{created.username}</b> · {created.tierName} is queued and runs now — follow it in the list.
                        {created.kind === "choice" ? "" : " The badge shows up in about a day."}
                    </Notice>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={again}>
                            Another account
                        </button>
                        <button type="button" className="btn-primary" onClick={onClose}>
                            Done
                        </button>
                    </div>
                </div>
            </Modal>
        );
    }

    return (
        <Modal title="Add account by hand" onClose={busy || checking ? () => {} : onClose} width={560}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    A free order, outside ArnTo-Auto: no payment and no message to anyone. It runs like a paid order — any tier, even ones not on sale.
                </p>

                {/* Not a <Field>: the Check button must not sit inside a <label>. */}
                <form onSubmit={check} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Account token</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            className="input mono"
                            type="password"
                            autoComplete="off"
                            autoFocus
                            aria-label="Account token"
                            style={{ flex: 1, minWidth: 0 }}
                            value={token}
                            onChange={(e) => {
                                setToken(e.target.value);
                                setAccount(null);
                            }}
                        />
                        <button type="submit" className="btn-ghost" disabled={checking || !token.trim()}>
                            {checking ? "Checking…" : "Check"}
                        </button>
                    </div>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Stored encrypted with the order, like a customer's.</span>
                </form>

                {account && (
                    <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <AccountSummary account={account} />

                        {!account.tieredAvailable && (
                            <Notice tone="warning">
                                {UNREADABLE[account.tieredCode] || UNREADABLE.error} You can still send them by entering the current value yourself.
                            </Notice>
                        )}

                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Badge</span>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {account.catalog.map((b) => (
                                    <button
                                        key={b.key}
                                        type="button"
                                        className={`chip${badgeKey === b.key ? " active" : ""}`}
                                        onClick={() => pickBadge(b.key)}
                                    >
                                        {b.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {badge && (
                            <Field label="Tier">
                                <select className="input" value={tierKey} onChange={(e) => setTierKey(e.target.value)}>
                                    {!tierKey && <option value="">Pick a tier</option>}
                                    {tiers.map((t) => (
                                        <option key={t.key} value={t.key} disabled={t.has}>
                                            {t.name}
                                            {t.threshold != null ? ` — ${fmtNum(t.threshold)} ${badge.unit}` : ""}
                                            {t.has ? (badge.kind === "choice" ? " (current)" : " (has it)") : ""}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        )}

                        {needsValue && (
                            <Field
                                label={`Current ${badge.label} (${badge.unit})`}
                                hint="What the account has now, from its profile. Too low sends more than needed; too high falls short of the tier."
                            >
                                <input
                                    className="input mono"
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={currentValue}
                                    onChange={(e) => setCurrentValue(e.target.value)}
                                    placeholder="0"
                                />
                            </Field>
                        )}

                        {tier && (
                            <p style={{ margin: 0, fontSize: 12, color: tooHigh ? "var(--danger)" : "var(--text-muted)" }}>
                                {badge.kind === "choice"
                                    ? "Switches the account's HypeSquad house — instant."
                                    : tooHigh
                                      ? readable
                                          ? `The account already has ${tier.name}.`
                                          : `That value already reaches ${tier.name} — nothing to send.`
                                      : need != null
                                        ? `Sends about ${fmtNum(need)} ${badge.unit} (${fmtNum(current)} → ${fmtNum(tier.threshold)}, plus the ${Math.round(((account.overshoot || 1) - 1) * 100)}% buffer).`
                                        : "Enter the current value to see how much it sends."}
                            </p>
                        )}

                        <Field label="Note (optional)" hint="Shown on the order — whose account it is, why it is free.">
                            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                        </Field>

                        {error && <Notice tone="danger">{error}</Notice>}
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                                Cancel
                            </button>
                            <button type="submit" className="btn-primary" disabled={!canCreate}>
                                {busy ? "Creating…" : "Create free order"}
                            </button>
                        </div>
                    </form>
                )}

                {!account && error && <Notice tone="danger">{error}</Notice>}
            </div>
        </Modal>
    );
}
