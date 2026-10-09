// ─────────────────────────────────────────────────────────────────────────────
//  pm2-logrotate on one node: install it, or set when PM2 logs rotate and how
//  many old files are kept. Every agent serves the same /logrotate, so each
//  node's Manage tab shows its own (server/services/nodeLogrotate.js).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../api/client";

const FIELDS = [
    { key: "max_size", label: "Max size", hint: "Rotate when a log reaches this size (e.g. 50M, 1G)", placeholder: "50M", width: 90 },
    { key: "retain", label: "Retain", hint: "How many rotated files to keep per process", placeholder: "7", width: 60 },
    { key: "rotateInterval", label: "Rotate at (cron)", hint: "Forced rotation schedule — default is midnight daily", placeholder: "0 0 * * *", width: 110 },
];

const ERROR_STYLE = { padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", fontSize: 13, overflowWrap: "anywhere" };

/** Remount it (key={nodeId}) to switch nodes: the form holds the previous node's values. */
export default function LogRotateSection({ nodeId }) {
    const [info, setInfo] = useState(null);
    const [form, setForm] = useState({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    const url = `/nodes/${nodeId}/logrotate`;

    const load = useCallback(() => {
        api.get(url)
            .then(r => {
                setInfo(r.data); setError("");
                const c = r.data.config || {};
                setForm({
                    max_size: c.max_size ?? "50M",
                    retain: String(c.retain ?? "7"),
                    rotateInterval: c.rotateInterval ?? "0 0 * * *",
                    compress: String(c.compress ?? "true") === "true",
                });
            })
            .catch((err) => setError(err.response?.data?.error || "Failed to load log rotation status"));
    }, [url]);
    useEffect(() => { load(); }, [load]);

    const handleInstall = async () => {
        setBusy(true); setError("");
        try {
            const { data } = await api.post(`${url}/install`, {}, { timeout: 300_000 });
            setInfo(data); load();
        } catch (err) {
            setError(err.response?.data?.error || "Install failed — check the agent logs below");
        } finally { setBusy(false); }
    };

    const handleSave = async () => {
        setBusy(true); setError(""); setSaved(false);
        try {
            const { data } = await api.put(url, {
                max_size: form.max_size.trim(),
                retain: form.retain.trim(),
                rotateInterval: form.rotateInterval.trim(),
                compress: String(form.compress),
            }, { timeout: 90_000 });
            setInfo(data); setSaved(true);
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save settings");
        } finally { setBusy(false); }
    };

    if (info === null) {
        if (!error) return <div style={{ padding: "8px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>;
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <div style={{ ...ERROR_STYLE, alignSelf: "stretch" }}>{error}</div>
                <button onClick={load} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Try again</button>
            </div>
        );
    }

    if (!info.installed) {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    pm2-logrotate is not installed on this node. Without it PM2 logs grow forever and can
                    fill the disk — which corrupts PM2's saved process list and loses every
                    bot on the next reboot.
                </p>
                {error && <div style={ERROR_STYLE}>{error}</div>}
                <button onClick={handleInstall} disabled={busy} className="btn-primary" style={{ alignSelf: "flex-start", fontSize: 13 }}>
                    {busy ? "Installing… (may take a minute)" : "Install pm2-logrotate"}
                </button>
            </div>
        );
    }

    const online = info.status === "online";
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: online ? "var(--success)" : "var(--danger)", flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    Module {online ? "running" : `status: ${info.status}`} — logs rotate automatically when they hit the size limit.
                </span>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
                {FIELDS.map(f => (
                    <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }} title={f.hint}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{f.label}</span>
                        <input
                            className="input mono"
                            style={{ fontSize: 13, width: f.width }}
                            placeholder={f.placeholder}
                            value={form[f.key] ?? ""}
                            onChange={e => { setForm(prev => ({ ...prev, [f.key]: e.target.value })); setSaved(false); }}
                            spellCheck={false}
                        />
                    </label>
                ))}
                <label style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8, cursor: "pointer" }} title="Gzip rotated log files">
                    <input
                        type="checkbox"
                        checked={!!form.compress}
                        onChange={e => { setForm(prev => ({ ...prev, compress: e.target.checked })); setSaved(false); }}
                    />
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Compress</span>
                </label>
                <button onClick={handleSave} disabled={busy} className="btn-primary" style={{ fontSize: 13, marginBottom: 2 }}>
                    {busy ? "Saving…" : "Save"}
                </button>
            </div>

            {saved && <div style={{ fontSize: 12, color: "var(--success)" }}>Settings applied.</div>}
            {error && <div style={ERROR_STYLE}>{error}</div>}
        </div>
    );
}
