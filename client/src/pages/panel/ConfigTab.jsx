// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Config: the panel's .env and its domains. Log rotation is
//  per node now, on each node's Manage tab (components/LogRotateSection.jsx).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Icon, Notice, StatusBadge } from "../../components/ui";
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
                    title={`Remove domain "${deleteConfirm}"`}
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
                <button type="submit" className="btn-primary" disabled={adding || !newDomain.trim() || !nodeId}>
                    {!adding && <Icon name="plus" />}
                    {adding ? "Adding…" : "Add domain"}
                </button>
            </form>

            {error && <Notice tone="danger">{error}</Notice>}

            {domains.length === 0 ? (
                <EmptyState compact icon="globe" title="No domains configured" description="Add one above to reach the panel by name." />
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
                            <Icon name="globe" style={{ color: "var(--text-dim)" }} />
                            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                                <div className="mono" style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {d.sslEnabled ? `https://${d.domain}` : `http://${d.domain}`}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                    {d.nodeName || "unknown node"} · {d.isPanelNode ? "serves the panel" : "redirects to the panel"}
                                </div>
                            </div>
                            {d.sslEnabled ? (
                                <StatusBadge tone="success">SSL</StatusBadge>
                            ) : (
                                <button
                                    onClick={() => handleSSL(d.domain)}
                                    disabled={sslLoading[d.domain]}
                                    className="btn-ghost btn-sm"
                                    style={{ flexShrink: 0 }}
                                    title="Let's Encrypt, issued on the domain's node"
                                >
                                    <Icon name="lock" size={14} />
                                    {sslLoading[d.domain] ? "Issuing…" : "Enable SSL"}
                                </button>
                            )}
                            <button
                                onClick={() => setDeleteConfirm(d.domain)}
                                className="btn-ghost btn-icon btn-sm is-danger"
                                title="Remove domain"
                            >
                                <Icon name="trash" size={14} />
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
                <Notice tone="warning">
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ flex: "1 1 240px" }}>.env saved — restart the panel for new values to take effect.</span>
                        <button onClick={onRestart} className="btn-warning btn-sm">Restart now</button>
                    </div>
                </Notice>
            )}

            {error && !entries && <Notice tone="danger">{error}</Notice>}

            <DataTable minWidth={480} columns={[{ label: "Key", width: "34%" }, "Value", { label: "", width: 48 }]}>
                {entries.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>No entries found. Click "Add variable" to start.</td></tr>
                )}

                {entries.map((entry) => {
                    const isSensitive = SENSITIVE_RE.test(entry.key);
                    const isRevealed = revealed.has(entry.id);
                    return (
                        <tr key={entry.id}>
                            <td style={{ padding: "6px 6px 6px 12px" }}>
                                <input
                                    className="input mono"
                                    style={{ fontSize: 12, padding: "5px 8px" }}
                                    placeholder="KEY_NAME"
                                    value={entry.key}
                                    onChange={e => updateEntry(entry.id, "key", e.target.value)}
                                    spellCheck={false}
                                />
                            </td>
                            <td style={{ padding: "6px" }}>
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
                                        <button type="button" onClick={() => toggleReveal(entry.id)} className="btn-ghost btn-icon btn-sm" title={isRevealed ? "Hide" : "Reveal"}>
                                            <Icon name={isRevealed ? "eyeOff" : "eye"} size={14} />
                                        </button>
                                    )}
                                </div>
                            </td>
                            <td className="actions" style={{ padding: "6px 12px 6px 6px" }}>
                                <button type="button" onClick={() => removeRow(entry.id)} className="btn-ghost btn-icon btn-sm is-danger" title="Delete">
                                    <Icon name="trash" size={14} />
                                </button>
                            </td>
                        </tr>
                    );
                })}
            </DataTable>

            {error && entries && <Notice tone="danger">{error}</Notice>}

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" onClick={addRow} className="btn-ghost">
                    <Icon name="plus" />
                    Add variable
                </button>
                {dirty && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Unsaved changes</span>}
                <button type="button" onClick={handleSave} disabled={saving || !dirty} className="btn-primary" style={{ marginLeft: "auto" }}>
                    {saving ? "Saving…" : "Save .env"}
                </button>
            </div>
        </div>
    );
}

export default function ConfigTab({ onRestart }) {
    return (
        <>
            <Section icon="fileText" title="Environment variables" hint=".env — requires a restart to apply">
                <EnvEditor onRestart={onRestart} />
            </Section>
            <Section icon="globe" title="Panel domains" hint="One per node, via nginx">
                <PanelDomainsSection />
            </Section>
        </>
    );
}
