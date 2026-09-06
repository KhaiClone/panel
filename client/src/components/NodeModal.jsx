import { useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  NodeModal — register a new node, or edit an existing one.
//
//  Used from two places: the Systems list creates (node = null), a node's own
//  Manage tab edits. Registering verifies the agent answers with this key
//  before the record is saved, so a typo fails here rather than showing up
//  later as a mysteriously offline node.
// ─────────────────────────────────────────────────────────────────────────────

export default function NodeModal({ node, onClose, onSaved }) {
    const isEdit = !!node;
    const [form, setForm] = useState({
        name: node?.name || "",
        host: node?.host || "",
        port: node?.port || 4200,
        apiKey: "",
        controlHost: node?.controlHost || "",
        enabled: node ? node.enabled : true,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const set = (field) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [field]: val }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            if (isEdit) await api.put(`/nodes/${node._id}`, form);
            else await api.post("/nodes", form);
            onSaved?.();
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save node");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 480, padding: 0 }}>
                <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center" }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>{isEdit ? `Edit "${node.name}"` : "Add Worker Node"}</h2>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>✕</button>
                </div>
                <form onSubmit={handleSubmit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                        <label className="label">Name *</label>
                        <input className="input" placeholder="VPS 2" value={form.name} onChange={set("name")} required />
                    </div>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
                        <div>
                            <label className="label">Host / IP *</label>
                            <input className="input mono" placeholder="14.225.211.157" value={form.host} onChange={set("host")} required />
                        </div>
                        <div>
                            <label className="label">Agent Port *</label>
                            <input className="input mono" type="number" min="1" max="65535" value={form.port} onChange={set("port")} required />
                        </div>
                    </div>
                    <div>
                        <label className="label">Agent API Key {isEdit ? "(leave blank to keep current)" : "*"}</label>
                        <input className="input mono" placeholder="printed by setup-agent.sh" value={form.apiKey} onChange={set("apiKey")} required={!isEdit} />
                    </div>
                    <div>
                        <label className="label">Control Host (optional)</label>
                        <input className="input mono" placeholder="leave blank to use Host / IP" value={form.controlHost} onChange={set("controlHost")} />
                        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                            Address the panel uses to reach this agent. Set <span className="mono">127.0.0.1</span> only
                            on the node that runs the panel, so its control traffic never leaves the machine.
                            Host / IP above stays the public address — WireGuard and the egress proxy depend on it.
                        </p>
                    </div>
                    {isEdit && (
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                            <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
                            Enabled (scheduler may place new bots here)
                        </label>
                    )}
                    {error && <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 8 }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={loading}>
                            {loading ? "Testing connection…" : isEdit ? "Save" : "Add Node"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
