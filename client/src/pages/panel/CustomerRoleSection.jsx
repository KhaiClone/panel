// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Integrations → Customer role: the Discord role everyone
//  using the bot service has (server/services/customerRole.js). Taking it off
//  someone by hand — here or right on Discord — keeps it off until Allow again.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { Icon, StatusBadge, Toggle } from "../../components/ui";

const DIM = { fontSize: 12, color: "var(--text-dim)" };
const ROW = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--border-light)" };
const fmt = (ts) => (ts ? new Date(ts).toLocaleString("en-GB") : "—");
const STATE = {
    "has-role": { tone: "success", label: "Has the role" },
    excluded: { tone: "warning", label: "Removed by hand" },
    waiting: { tone: "neutral", label: "Not given yet" },
};

export default function CustomerRoleSection() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(null);
    const [form, setForm] = useState(null); // { roleId } while editing
    const [confirm, setConfirm] = useState(null); // the customer to keep off
    const [note, setNote] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data: r } = await api.get("/customer-projects/role");
            setData(r);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || "Failed to load");
        }
    }, []);
    useEffect(() => {
        load();
    }, [load]);

    const run = async (name, call, after) => {
        setBusy(name);
        setError("");
        setNote(null);
        try {
            const { data: r } = await call();
            after?.(r);
            await load();
        } catch (err) {
            setError(err.response?.data?.error || "Something went wrong");
        } finally {
            setBusy(null);
            setConfirm(null);
        }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;
    const last = data.last;
    const others = data.excluded.filter((x) => !x.customer);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {confirm && (
                <ConfirmModal
                    title={`Take the customer role from ${confirm.name || confirm.id}?`}
                    message="It comes off now, and the panel will not give it back — not even when they buy again — until you press Allow again. Taking it off on Discord does the same."
                    confirmText="Take it off"
                    onConfirm={() => run(`off-${confirm.id}`, () => api.post("/customer-projects/role/keep-off", { userId: confirm.id }),
                        (r) => r.discord?.error && setNote(r.discord.error))}
                    onCancel={() => setConfirm(null)}
                />
            )}
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Everyone whose customer project is running (websites and services too, and projects that never expire) gets this role on the shop
                server; it goes when their last one expires or is deleted. Take it off someone by hand — on Discord or here — and the panel keeps it off
                until you allow them again. Personal and team projects never give it. ArnTo-Shop does the Discord part.
            </p>
            {error && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}
            {note && <p style={{ fontSize: 12, color: "var(--warning)", margin: 0 }}>{note}</p>}
            {!data.botReady && <p style={{ fontSize: 12, color: "var(--warning)", margin: 0 }}>ArnTo-Shop has not announced role.members and role.set on the bus yet — update and restart it.</p>}

            {form ? (
                <div className="card" style={{ padding: 12, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 240px" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Role ID</span>
                        <input className="input mono" value={form.roleId} onChange={(e) => setForm({ roleId: e.target.value.trim() })} disabled={!!busy} />
                    </label>
                    <button className="btn-ghost btn-sm" onClick={() => setForm(null)} disabled={!!busy}>Cancel</button>
                    <button className="btn-primary btn-sm" onClick={() => run("save", () => api.put("/customer-projects/role", { roleId: form.roleId }), () => setForm(null))} disabled={!!busy}>
                        Save
                    </button>
                </div>
            ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Toggle checked={data.enabled} disabled={!!busy} title={data.enabled ? "Turn the customer role off" : "Turn the customer role on"}
                        onChange={(v) => run("toggle", () => api.put("/customer-projects/role", { enabled: v }))} />
                    <StatusBadge tone={data.enabled ? "success" : "neutral"}>{data.enabled ? "On" : "Off"}</StatusBadge>
                    <span className="mono" style={{ fontSize: 13 }}>{data.roleId}</span>
                    {last?.roleName && <span style={DIM}>@{last.roleName}{last.guildName ? ` in ${last.guildName}` : ""}</span>}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        <button className="btn-ghost btn-sm" onClick={() => run("sync", () => api.post("/customer-projects/role/sync", {}, { timeout: 180_000 }))} disabled={!!busy || !data.enabled}>
                            <Icon name="refresh" size={14} /> {busy === "sync" ? "Syncing…" : "Sync now"}
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => setForm({ roleId: data.roleId })} disabled={!!busy}>
                            <Icon name="pencil" size={14} /> Role
                        </button>
                    </span>
                </div>
            )}

            <p style={{ ...DIM, margin: 0 }}>
                {last
                    ? last.error
                        ? <span style={{ color: "var(--danger)" }}>Last pass {fmt(last.at)}: {last.error}</span>
                        : <>Last pass {fmt(last.at)}: given to {last.added}, taken from {last.removed}{last.excludedByHand ? `, ${last.excludedByHand} taken off by hand` : ""}
                            {last.failed?.length ? `, ${last.failed.length} failed (${last.failed[0].error})` : ""}. Runs every hour and right after a customer project changes.</>
                    : "No pass yet — it runs every hour and right after a customer project changes."}
            </p>

            <div>
                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 2px" }}>Customers ({data.customers.length})</p>
                {!data.customers.length && <p style={{ ...DIM, margin: "6px 0 0" }}>No running customer project.</p>}
                {data.customers.map((c) => {
                    const s = STATE[c.state];
                    return (
                        <div key={c.id} style={ROW}>
                            <span style={{ fontSize: 13, fontWeight: 500 }}>{c.name || c.id}</span>
                            <span className="mono" style={DIM}>{c.id}</span>
                            <span style={DIM}>· {c.projects.join(", ")}</span>
                            <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                            <span style={{ marginLeft: "auto" }}>
                                {c.state === "excluded" ? (
                                    <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => run(`allow-${c.id}`, () => api.post("/customer-projects/role/allow", { userId: c.id }))}>
                                        Allow again
                                    </button>
                                ) : (
                                    <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => setConfirm(c)}>Take off and keep off</button>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>

            {others.length > 0 && (
                <div>
                    <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", margin: "0 0 2px" }}>Removed by hand, no running project now ({others.length})</p>
                    {others.map((x) => (
                        <div key={x.id} style={ROW}>
                            <span style={{ fontSize: 13, fontWeight: 500 }}>{x.name || x.id}</span>
                            <span className="mono" style={DIM}>{x.id}</span>
                            <span style={DIM}>· {x.by === "discord" ? "taken off on Discord" : "taken off here"} {fmt(x.at)}</span>
                            <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={!!busy}
                                onClick={() => run(`allow-${x.id}`, () => api.post("/customer-projects/role/allow", { userId: x.id }))}>
                                Allow again
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
