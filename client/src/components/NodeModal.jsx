import { useEffect, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  NodeModal — register a new node, or edit an existing one.
//
//  Used from two places: the Systems list creates (node = null), a node's detail
//  page edits (the Edit button in its header). Registering verifies the agent answers with this key
//  before the record is saved, so a typo fails here rather than showing up
//  later as a mysteriously offline node.
//
//  Creating offers two ways:
//    One command  the panel makes a single-use command for the new VPS; run as
//                 root there, it installs the agent and registers it, and this
//                 modal follows the setup steps (services/nodeJoin.js).
//    Manual       setup-agent.sh by hand, then paste host / port / key here.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_ICON = { running: "⏳", ok: "✅", warn: "⚠️", error: "❌" };
const INVITE_POLL_MS = 3000;

const errorBox = (msg) => (
    <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{msg}</div>
);

function ManualForm({ node, onClose, onSaved }) {
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
        <form onSubmit={handleSubmit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            {!isEdit && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                    Run <span className="mono">sudo bash agent/setup-agent.sh &lt;PANEL_IP&gt;</span> on the new VPS, then paste what it prints.
                </p>
            )}
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
            {error && errorBox(error)}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 8 }}>
                <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                    {loading ? "Testing connection…" : isEdit ? "Save" : "Add Node"}
                </button>
            </div>
        </form>
    );
}

function InviteStatus({ invite }) {
    const { status } = invite;
    const headline = {
        pending: "Waiting for the new VPS to run the command…",
        joining: "The agent is up — the panel is checking it…",
        provisioning: `${invite.name} is registered — setting it up…`,
        done: `${invite.name} joined the panel.`,
        expired: "This command has expired — create a new one.",
        revoked: "This command was revoked.",
    }[status] || status;
    const color = status === "done" ? "#4ade80" : status === "expired" || status === "revoked" ? "var(--danger)" : "var(--text)";
    return (
        <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <strong style={{ fontSize: 13, color }}>{headline}</strong>
            {invite.error && status === "pending" && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>
                    Last attempt: {invite.error} — fix it and run the same command again.
                </p>
            )}
            {(invite.steps || []).map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                    <span>{STEP_ICON[s.status] || "•"}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: "var(--text)" }}>{s.label}</div>
                        {s.detail && (
                            <pre className="mono" style={{ margin: "2px 0 0", fontSize: 11, color: s.status === "error" ? "#f87171" : "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{s.detail}</pre>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}

function JoinForm({ onClose, onSaved }) {
    const [form, setForm] = useState({ name: "", ip: "", port: 4200 });
    const [created, setCreated] = useState(null); // { invite, command, secure }
    const [invite, setInvite] = useState(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState("");

    const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

    const handleCreate = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const { data } = await api.post("/nodes/invites", { ...form, origin: window.location.origin });
            setCreated(data);
            setInvite(data.invite);
        } catch (err) {
            setError(err.response?.data?.error || "Could not create the command");
        } finally {
            setLoading(false);
        }
    };

    // Follow the invite until it is finished one way or the other.
    const inviteId = invite?.id;
    const finished = ["done", "expired", "revoked"].includes(invite?.status);
    useEffect(() => {
        if (!inviteId || finished) return undefined;
        const t = setInterval(async () => {
            try {
                const { data } = await api.get(`/nodes/invites/${inviteId}`);
                setInvite(data);
                // The node exists from "provisioning" on — let the list show it.
                if (data.status === "provisioning" || data.status === "done") onSaved?.();
            } catch { /* keep polling — the panel may be briefly busy */ }
        }, INVITE_POLL_MS);
        return () => clearInterval(t);
    }, [inviteId, finished, onSaved]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(created.command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — the command is selectable */ }
    };

    const revoke = async () => {
        try {
            const { data } = await api.delete(`/nodes/invites/${invite.id}`);
            setInvite(data);
        } catch (err) {
            setError(err.response?.data?.error || "Could not revoke");
        }
    };

    if (!created) {
        return (
            <form onSubmit={handleCreate} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                    The panel makes one command for the new VPS (Ubuntu 22.04 / 24.04). It installs the agent, WireGuard and
                    Java, registers the node, and the panel then copies SSH keys, joins it to the mesh and installs Lavalink.
                </p>
                <div>
                    <label className="label">Name *</label>
                    <input className="input" placeholder="VPS 4" value={form.name} onChange={set("name")} required maxLength={64} />
                </div>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
                    <div>
                        <label className="label">Public IP of the new VPS *</label>
                        <input className="input mono" placeholder="203.0.113.10" value={form.ip} onChange={set("ip")} required />
                    </div>
                    <div>
                        <label className="label">Agent Port</label>
                        <input className="input mono" type="number" min="1" max="65535" value={form.port} onChange={set("port")} required />
                    </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                    The command only works for this IP, once, within 30 minutes.
                </p>
                {error && errorBox(error)}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 8 }}>
                    <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Creating…" : "Create command"}</button>
                </div>
            </form>
        );
    }

    const expires = new Date(created.invite.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
                <label className="label">Run as root on {created.invite.ip}</label>
                <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                    <pre className="mono" style={{ flex: 1, margin: 0, padding: "10px 12px", fontSize: 12, borderRadius: 8, background: "var(--bg-input)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "all" }}>
                        {created.command}
                    </pre>
                    <button type="button" className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={copy}>
                        {copied ? "Copied ✓" : "Copy"}
                    </button>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                    Single use, valid until {expires}. Keep it private: whoever runs it on {created.invite.ip} joins that machine to the panel.
                </p>
                {!created.secure && (
                    <p style={{ fontSize: 12, color: "var(--warning)", margin: "6px 0 0" }}>
                        ⚠️ The panel is reached over plain HTTP ({created.invite.baseUrl}). The agent key travels encrypted with the
                        token, but anyone who can read that traffic can read both. Give the panel an HTTPS domain to avoid it.
                    </p>
                )}
            </div>
            {invite && <InviteStatus invite={invite} />}
            {error && errorBox(error)}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
                {invite?.status === "pending" && (
                    <button type="button" className="btn-ghost" onClick={revoke}>Revoke</button>
                )}
                <button type="button" className={invite?.status === "done" ? "btn-primary" : "btn-ghost"} onClick={onClose}>
                    {invite?.status === "done" ? "Done" : "Close"}
                </button>
            </div>
        </div>
    );
}

export default function NodeModal({ node, onClose, onSaved }) {
    const isEdit = !!node;
    const [mode, setMode] = useState("join");

    return (
        <div className="modal-overlay">
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 560, padding: 0 }}>
                <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", gap: 12 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>{isEdit ? `Edit "${node.name}"` : "Add Worker Node"}</h2>
                    {!isEdit && (
                        <div className="tab-bar" style={{ display: "flex", gap: 4 }}>
                            {[["join", "One command"], ["manual", "Manual"]].map(([key, label]) => (
                                <button key={key} type="button" className={`tab-item${mode === key ? " active" : ""}`} style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setMode(key)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    )}
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>✕</button>
                </div>
                {isEdit || mode === "manual" ? (
                    <ManualForm node={node} onClose={onClose} onSaved={onSaved} />
                ) : (
                    <JoinForm onClose={onClose} onSaved={onSaved} />
                )}
            </div>
        </div>
    );
}
