// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Integrations → Customer project channels: the Kho
//  categories the log and backup channels of customer projects are made in
//  (server/services/customerChannels.js), and what the panel's bot can do there.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { Icon, StatusBadge } from "../../components/ui";

const KINDS = [
    { kind: "log", label: "Log categories" },
    { kind: "backup", label: "Backup categories" },
];
const DIM = { fontSize: 12, color: "var(--text-dim)" };

function CategoryRow({ c, limit }) {
    const tone = !c.name ? "danger" : c.missing?.length ? "danger" : c.full ? "warning" : c.public ? "warning" : "success";
    const label = !c.name ? "Unusable" : c.missing?.length ? "Missing permissions" : c.full ? "Full" : c.public ? "Public" : "Ready";
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid var(--border-light)" }}>
            <StatusBadge tone={tone}>{label}</StatusBadge>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{c.name || <span className="mono">{c.id}</span>}</span>
            {c.guildName && <span style={DIM}>in {c.guildName}</span>}
            {c.name && <span style={DIM}>· {c.count}/{limit} channels</span>}
            <span className="mono" style={{ ...DIM, marginLeft: "auto" }}>{c.id}</span>
            {(c.error || c.public) && (
                <span style={{ flexBasis: "100%", fontSize: 12, color: c.error ? "var(--danger)" : "var(--warning)" }}>
                    {c.error || "@everyone can see this category (View Channel is not denied for @everyone on it), so the channels made in it would be public too — backups hold customer data. Make the category private and keep the panel's bot in it, then press Refresh."}
                </span>
            )}
        </div>
    );
}

export default function CustomerChannelsSection() {
    const [data, setData] = useState(null);
    const [form, setForm] = useState(null); // { log: "id, id", backup: "id" } while editing
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(() => {
        setError("");
        api.get("/customer-projects/channel-settings").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    const save = async () => {
        setBusy(true);
        setError("");
        try {
            const { data: r } = await api.put("/customer-projects/channel-settings", {
                log: form.log.split(/[\s,]+/).filter(Boolean),
                backup: form.backup.split(/[\s,]+/).filter(Boolean),
            });
            setData(r);
            setForm(null);
        } catch (err) {
            setError(err.response?.data?.error || "Save failed");
        } finally {
            setBusy(false);
        }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                The panel's bot makes each customer project's log and backup channel in the first category of the kind that has room
                (Discord allows {data.limit} channels per category — list another one to go past that). It needs View Channel, Manage Channels and
                Manage Webhooks there, and the categories should be private: a new channel copies its category's permissions.
            </p>
            {!data.busReady && <p style={{ fontSize: 12, color: "var(--warning)", margin: 0 }}>The panel's Discord bot is not connected — the categories cannot be checked now.</p>}
            {error && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}

            {form ? (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    {KINDS.map((k) => (
                        <label key={k.kind} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{k.label} — category IDs, in order of use</span>
                            <input className="input mono" value={form[k.kind]} onChange={(e) => setForm({ ...form, [k.kind]: e.target.value })} disabled={busy} />
                        </label>
                    ))}
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button className="btn-ghost btn-sm" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
                        <button className="btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? "Checking…" : "Save"}</button>
                    </div>
                </div>
            ) : (
                KINDS.map((k) => (
                    <div key={k.kind}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 2px" }}>{k.label}</p>
                        {data[k.kind].map((c) => <CategoryRow key={c.id} c={c} limit={data.limit} />)}
                    </div>
                ))
            )}

            {!form && (
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-ghost btn-sm" onClick={load}><Icon name="refresh" size={14} /> Refresh</button>
                    <button
                        className="btn-ghost btn-sm"
                        onClick={() => setForm({ log: data.log.map((c) => c.id).join(", "), backup: data.backup.map((c) => c.id).join(", ") })}
                        disabled={!data.busReady}
                    >
                        <Icon name="pencil" size={14} /> Edit categories
                    </button>
                </div>
            )}
        </div>
    );
}
