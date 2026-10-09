// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Config: the panel's .env and its domains. Log rotation is
//  per node now, on each node's Manage tab (components/LogRotateSection.jsx).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import Section from "./Section";

// ── PanelDomainsSection ───────────────────────────────────────────────────────
// Each domain belongs to the node its DNS points at, for good. On the node that
// runs the panel it serves the panel; on the others it redirects to it — so a
// move changes no DNS (server/services/panelDomains.js).

function PanelDomainsSection() {
    const [data, setData] = useState(null); // { domains, nodes, panelNodeId, publicUrl }
    const [newDomain, setNewDomain] = useState("");
    const [nodeId, setNodeId] = useState("");
    const [adding, setAdding] = useState(false);
    const [sslLoading, setSslLoading] = useState({});
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [error, setError] = useState("");

    const fetchDomains = useCallback(async () => {
        try {
            const { data: d } = await api.get("/panel/domains");
            setData(d);
            setNodeId((cur) => cur || d.panelNodeId || "");
        } catch (err) {
            setError(err.response?.data?.error || "Failed to load domains");
        }
    }, []);

    useEffect(() => { fetchDomains(); }, [fetchDomains]);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!newDomain.trim()) return;
        setAdding(true); setError("");
        try {
            await api.post("/panel/domains", { domain: newDomain.trim(), nodeId }, { timeout: 90_000 });
            setNewDomain("");
            await fetchDomains();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to add domain");
        } finally { setAdding(false); }
    };

    const handleDelete = async (domain) => {
        setError("");
        try {
            await api.delete(`/panel/domains/${encodeURIComponent(domain)}`, { timeout: 90_000 });
            await fetchDomains();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to remove domain");
        } finally { setDeleteConfirm(null); }
    };

    const handleSSL = async (domain) => {
        setSslLoading((s) => ({ ...s, [domain]: true })); setError("");
        try {
            await api.post(`/panel/domains/${encodeURIComponent(domain)}/ssl`, {}, { timeout: 200_000 });
            await fetchDomains();
        } catch (err) {
            setError(err.response?.data?.error || "SSL issuance failed — make sure the domain points at its node");
        } finally { setSslLoading((s) => ({ ...s, [domain]: false })); }
    };

    if (!data) {
        return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>;
    }
    const { domains, nodes } = data;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {deleteConfirm && (
                <ConfirmModal
                    title={`Remove Domain "${deleteConfirm}"`}
                    message={`This removes "${deleteConfirm}" from its node's nginx config. Its certificate stays on disk.`}
                    confirmText="Remove"
                    onConfirm={() => handleDelete(deleteConfirm)}
                    onCancel={() => setDeleteConfirm(null)}
                />
            )}

            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Give every node that may host the panel its own domain, pointing at that node for good. The domains of the node
                running the panel serve it; the others redirect to it. Moving the panel changes no DNS — and Prepare, on the
                Recovery tab, issues the new node's certificates in advance. The panel is at <a href={data.publicUrl} className="mono">{data.publicUrl}</a>.
            </p>

            <form onSubmit={handleAdd} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                    className="input mono"
                    style={{ flex: "2 1 200px", minWidth: 0, fontSize: 13 }}
                    placeholder="panel.example.com"
                    value={newDomain}
                    onChange={(e) => { setNewDomain(e.target.value); setError(""); }}
                    disabled={adding}
                    spellCheck={false}
                />
                <select className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)} disabled={adding} style={{ flex: "1 1 160px", minWidth: 0 }} title="The node this domain's DNS points at">
                    {nodes.map((n) => (
                        <option key={n._id} value={n._id}>{n.name} ({n.host}){n.isPanelNode ? " — panel" : ""}</option>
                    ))}
                </select>
                <button type="submit" className="btn-primary" disabled={adding || !newDomain.trim() || !nodeId} style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                    {adding ? "Adding…" : "+ Add Domain"}
                </button>
            </form>

            {error && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", fontSize: 13 }}>
                    {error}
                </div>
            )}

            {domains.length === 0 ? (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    No domains configured. Add one above to reach the panel by name.
                </div>
            ) : (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {domains.map((d, i) => (
                        <div
                            key={d.domain}
                            style={{
                                display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                                padding: "12px 14px",
                                borderBottom: i < domains.length - 1 ? "1px solid var(--border-light)" : "none",
                            }}
                        >
                            <span style={{ fontSize: 15, flexShrink: 0 }}>🌐</span>
                            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                                <div className="mono" style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {d.sslEnabled ? `https://${d.domain}` : `http://${d.domain}`}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                    {d.nodeName || "unknown node"} · {d.isPanelNode ? "serves the panel" : "redirects to the panel"}
                                </div>
                            </div>
                            {d.sslEnabled ? (
                                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success-border)", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>🔒 SSL</span>
                            ) : (
                                <button
                                    onClick={() => handleSSL(d.domain)}
                                    disabled={sslLoading[d.domain]}
                                    className="btn-ghost"
                                    style={{ fontSize: 11, padding: "3px 8px", color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}
                                    title="Let's Encrypt, issued on the domain's node"
                                >
                                    {sslLoading[d.domain] ? "Issuing…" : "Enable SSL"}
                                </button>
                            )}
                            <button
                                onClick={() => setDeleteConfirm(d.domain)}
                                className="btn-ghost"
                                style={{ padding: "4px 8px", color: "var(--danger)", fontSize: 13, flexShrink: 0 }}
                                title="Remove domain"
                            >
                                🗑️
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── EnvEditor ─────────────────────────────────────────────────────────────────

const SENSITIVE_RE = /password|secret|token|hash|webhook/i;

function EnvEditor({ onRestart }) {
    const [entries, setEntries] = useState(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");
    const [revealed, setRevealed] = useState(new Set());

    useEffect(() => {
        api.get("/panel/env")
            .then(r => setEntries(r.data.map((e, i) => ({ ...e, id: i }))))
            .catch(() => setError("Failed to load .env file"));
    }, []);

    const mark = () => { setDirty(true); setSaved(false); };

    const updateEntry = (id, field, val) => {
        setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: val } : e));
        mark();
    };

    const addRow = () => {
        setEntries(prev => [...prev, { key: "", value: "", id: Date.now() }]);
        mark();
    };

    const removeRow = (id) => {
        setEntries(prev => prev.filter(e => e.id !== id));
        mark();
    };

    const toggleReveal = (id) => setRevealed(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const handleSave = async () => {
        setError(""); setSaving(true);
        try {
            await api.put("/panel/env", { entries: entries.filter(e => e.key.trim()) });
            setSaved(true); setDirty(false);
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save .env");
        } finally {
            setSaving(false);
        }
    };

    if (entries === null) {
        return (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                {error || "Loading…"}
            </div>
        );
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Restart-required banner */}
            {saved && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning)", fontSize: 13 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    .env saved — restart the panel for new values to take effect.
                    <button onClick={onRestart} className="btn-warning" style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 12, flexShrink: 0 }}>Restart Now</button>
                </div>
            )}

            {error && !entries && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", fontSize: 13 }}>{error}</div>
            )}

            {/* Table */}
            <div className="scroll-x" style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,1fr) 2fr 60px", background: "var(--bg-input)", borderBottom: "1px solid var(--border)", padding: "8px 12px", gap: 8, minWidth: 480 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Key</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Value</span>
                    <span />
                </div>

                {entries.length === 0 && (
                    <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No entries found. Click "+ Add Variable" to start.</div>
                )}

                {entries.map((entry) => {
                    const isSensitive = SENSITIVE_RE.test(entry.key);
                    const isRevealed = revealed.has(entry.id);
                    return (
                        <div key={entry.id} style={{ display: "grid", gridTemplateColumns: "minmax(160px,1fr) 2fr 60px", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border-light)", alignItems: "center", minWidth: 480 }}>
                            <input
                                className="input mono"
                                style={{ fontSize: 12, padding: "5px 8px" }}
                                placeholder="KEY_NAME"
                                value={entry.key}
                                onChange={e => updateEntry(entry.id, "key", e.target.value)}
                                spellCheck={false}
                            />
                            <div style={{ display: "flex", gap: 4 }}>
                                <input
                                    className="input mono"
                                    style={{ fontSize: 12, padding: "5px 8px", flex: 1 }}
                                    type={isSensitive && !isRevealed ? "password" : "text"}
                                    placeholder="value"
                                    value={entry.value}
                                    onChange={e => updateEntry(entry.id, "value", e.target.value)}
                                    spellCheck={false}
                                />
                                {isSensitive && (
                                    <button type="button" onClick={() => toggleReveal(entry.id)} className="btn-ghost" style={{ padding: "4px 7px", fontSize: 13, flexShrink: 0 }} title={isRevealed ? "Hide" : "Reveal"}>
                                        {isRevealed
                                            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                        }
                                    </button>
                                )}
                            </div>
                            <button type="button" onClick={() => removeRow(entry.id)} className="btn-ghost" style={{ padding: "4px 8px", color: "var(--danger)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }} title="Delete">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                            </button>
                        </div>
                    );
                })}
            </div>

            {error && entries && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", fontSize: 13 }}>{error}</div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={addRow} className="btn-ghost" style={{ fontSize: 13 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add Variable
                </button>
                {dirty && <span style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>Unsaved changes</span>}
                <button type="button" onClick={handleSave} disabled={saving || !dirty} className="btn-primary" style={{ marginLeft: "auto", fontSize: 13 }}>
                    {saving ? "Saving…" : "Save .env"}
                </button>
            </div>
        </div>
    );
}

export default function ConfigTab({ onRestart }) {
    return (
        <>
            <Section icon="📄" title="Environment Variables" hint=".env — requires a restart to apply">
                <EnvEditor onRestart={onRestart} />
            </Section>
            <Section icon="🌐" title="Panel Domains" hint="One per node, via nginx">
                <PanelDomainsSection />
            </Section>
        </>
    );
}
