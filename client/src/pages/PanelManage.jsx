import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { useData } from "../context/DataContext";

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
};

const fmtUptime = (ts) => {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const day = Math.floor(hr / 24);
    return `${day}d ${hr % 24}h`;
};

function ReconnectOverlay({ onReconnected }) {
    const [dots, setDots] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const dotTimer = setInterval(() => setDots(d => (d.length >= 3 ? "" : d + ".")), 500);
        return () => clearInterval(dotTimer);
    }, []);

    useEffect(() => {
        const timer = setInterval(async () => {
            setAttempt(a => a + 1);
            try { await api.get("/panel/status"); onReconnected(); } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(timer);
    }, [onReconnected]);

    return createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", border: "4px solid rgba(91,115,232,0.3)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
            <div style={{ textAlign: "center" }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: "0 0 8px 0" }}>Panel Restarting{dots}</h2>
                <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 4px 0" }}>Waiting for the panel to come back online</p>
                <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>Attempt #{attempt}</p>
            </div>
        </div>,
        document.body
    );
}

function StatCard({ icon, label, value, sub, accent = "var(--text)" }) {
    return (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                {icon}
            </div>
            <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 2px 0" }}>{label}</p>
                <p style={{ fontSize: 18, fontWeight: 700, color: accent, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</p>
                {sub && <p style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</p>}
            </div>
        </div>
    );
}

function AddKeyModal({ onClose, onCreated }) {
    const [mode, setMode] = useState("generate");
    const [name, setName] = useState("");
    const [comment, setComment] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e) => {
        e.preventDefault(); setError(""); setLoading(true);
        try {
            const payload = mode === "generate" ? { name, mode: "generate", comment } : { name, mode: "import", privateKey };
            const { data } = await api.post("/github/keys", payload);
            onCreated(data); onClose();
        } catch (err) { setError(err.response?.data?.error || "Failed to add key"); }
        finally { setLoading(false); }
    };

    return createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div className="card" style={{ maxWidth: 500, width: "100%", padding: 0, display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>🔑 Add SSH Key</h2>
                    <button onClick={onClose} className="btn-ghost" style={{ padding: "4px 8px" }}>✕</button>
                </div>
                <form onSubmit={handleSubmit} style={{ padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                        <label className="label">Mode</label>
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                            <button type="button" onClick={() => setMode("generate")} className={mode === "generate" ? "btn-primary" : "btn-ghost"} style={{ flex: 1 }}>🔧 Generate</button>
                            <button type="button" onClick={() => setMode("import")} className={mode === "import" ? "btn-primary" : "btn-ghost"} style={{ flex: 1 }}>📋 Import</button>
                        </div>
                    </div>
                    <div>
                        <label className="label">Key Name *</label>
                        <input className="input mono" placeholder="github_myaccount" value={name} onChange={e => setName(e.target.value)} required pattern="[a-zA-Z0-9_-]+" />
                        <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>Saved as ~/.ssh/{name || "..."}</p>
                    </div>
                    {mode === "generate" ? (
                        <div>
                            <label className="label">Email / Comment</label>
                            <input className="input" placeholder="you@example.com" value={comment} onChange={e => setComment(e.target.value)} />
                        </div>
                    ) : (
                        <div>
                            <label className="label">Private Key *</label>
                            <textarea className="input mono" style={{ height: 160, resize: "vertical", fontSize: 12 }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..." value={privateKey} onChange={e => setPrivateKey(e.target.value)} required spellCheck={false} />
                        </div>
                    )}
                    {error && <div style={{ padding: 12, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", borderRadius: 8, fontSize: 13 }}>{error}</div>}
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Save Key"}</button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    );
}

function GitHubSection() {
    const [keys, setKeys] = useState([]);
    const [keysLoading, setKeysLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [testResults, setTestResults] = useState({});
    const [copiedKey, setCopiedKey] = useState(null);
    const [gitConfig, setGitConfig] = useState({ name: "", email: "" });
    const [editingConfig, setEditingConfig] = useState(false);
    const [configForm, setConfigForm] = useState({ name: "", email: "" });
    const [configSaving, setConfigSaving] = useState(false);
    const [expandedKey, setExpandedKey] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);

    const fetchKeys = useCallback(async () => {
        setKeysLoading(true);
        try { const { data } = await api.get("/github/keys"); setKeys(data); } catch { /* ignore */ }
        finally { setKeysLoading(false); }
    }, []);

    const fetchGitConfig = useCallback(async () => {
        try { const { data } = await api.get("/github/git-config"); setGitConfig(data); setConfigForm(data); } catch { /* ignore */ }
    }, []);

    const [syncStatus, setSyncStatus] = useState([]);
    const [syncing, setSyncing] = useState({}); // nodeId → bool

    const fetchSyncStatus = useCallback(async () => {
        try {
            const { data } = await api.get("/github/sync-status");
            // Only remote nodes are relevant (local is always the source of truth)
            setSyncStatus(data);
        } catch { /* nodes optional */ }
    }, []);

    useEffect(() => { fetchKeys(); fetchGitConfig(); fetchSyncStatus(); }, [fetchKeys, fetchGitConfig, fetchSyncStatus]);

    const handleSyncNode = async (nodeId) => {
        setSyncing(s => ({ ...s, [nodeId]: true }));
        try {
            await api.post(`/github/sync/${nodeId}`);
            await fetchSyncStatus();
        } catch { /* surfaced by status refresh */ }
        finally { setSyncing(s => ({ ...s, [nodeId]: false })); }
    };

    const handleTest = async (keyName = null) => {
        const id = keyName || "__default__";
        setTestResults(r => ({ ...r, [id]: { loading: true } }));
        try {
            const url = keyName ? `/github/keys/${keyName}/test` : "/github/test";
            const { data } = await api.post(url);
            setTestResults(r => ({ ...r, [id]: { loading: false, ...data } }));
        } catch {
            setTestResults(r => ({ ...r, [id]: { loading: false, success: false, output: "Request failed" } }));
        }
    };

    const handleCopy = async (publicKey, keyName) => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(publicKey);
            } else {
                // Fallback for non-HTTPS or older browsers
                const el = document.createElement('textarea');
                el.value = publicKey;
                el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                document.body.appendChild(el);
                el.focus(); el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
            }
            setCopiedKey(keyName);
            setTimeout(() => setCopiedKey(null), 2000);
        } catch { /* ignore */ }
    };

    const handleDelete = async (keyName) => {
        try { await api.delete(`/github/keys/${keyName}`); setKeys(k => k.filter(key => key.name !== keyName)); setDeleteConfirm(null); fetchSyncStatus(); } catch { /* ignore */ }
    };

    const handleSaveConfig = async () => {
        setConfigSaving(true);
        try {
            const { data } = await api.put("/github/git-config", configForm);
            setGitConfig(data); setEditingConfig(false); fetchSyncStatus();
        } catch { /* ignore */ }
        finally { setConfigSaving(false); }
    };

    const defaultTest = testResults["__default__"];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {deleteConfirm && (
                <ConfirmModal title={`Delete Key "${deleteConfirm}"`} message={`This will permanently delete the SSH key pair and its SSH config entry.\n\n⚠️ Any GitHub repos using this key will no longer be accessible.`} confirmText="Delete Key" onConfirm={() => handleDelete(deleteConfirm)} onCancel={() => setDeleteConfirm(null)} />
            )}
            {showAddModal && <AddKeyModal onClose={() => setShowAddModal(false)} onCreated={() => { fetchKeys(); fetchSyncStatus(); }} />}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>GitHub & SSH Keys</h2>
                <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => handleTest(null)} disabled={defaultTest?.loading} className="btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}>
                        {defaultTest?.loading ? "Testing…" : "🔗 Test Default"}
                    </button>
                    <button onClick={() => setShowAddModal(true)} className="btn-primary" style={{ fontSize: 11, padding: "4px 8px" }}>+ Add Key</button>
                </div>
            </div>

            {defaultTest && !defaultTest.loading && (
                <div className="card" style={{ padding: 12, border: `1px solid ${defaultTest.success ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, background: defaultTest.success ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)' }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: defaultTest.output ? 8 : 0 }}>
                        <span>{defaultTest.success ? "✅" : "❌"}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: defaultTest.success ? "#4ade80" : "#f87171" }}>{defaultTest.success ? "Connected" : "Connection Failed"}</span>
                        <button onClick={() => setTestResults(r => { const n = { ...r }; delete n["__default__"]; return n; })} className="btn-ghost" style={{ marginLeft: "auto", fontSize: 11, padding: "2px 6px" }}>Dismiss</button>
                    </div>
                    {defaultTest.output && <pre className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: 0, whiteSpace: "pre-wrap" }}>{defaultTest.output}</pre>}
                </div>
            )}

            <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>⚙️</span><h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Git Global Config</h3>
                    </div>
                    {!editingConfig ? (
                        <button onClick={() => { setConfigForm(gitConfig); setEditingConfig(true); }} className="btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}>✏️ Edit</button>
                    ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => setEditingConfig(false)} className="btn-ghost" style={{ fontSize: 11, padding: "4px 8px" }}>Cancel</button>
                            <button onClick={handleSaveConfig} disabled={configSaving} className="btn-success" style={{ fontSize: 11, padding: "4px 8px" }}>{configSaving ? "Saving…" : "💾 Save"}</button>
                        </div>
                    )}
                </div>
                {editingConfig ? (
                    <div style={{ display: "flex", gap: 12 }}>
                        <div style={{ flex: 1 }}><label className="label">user.name</label><input className="input" value={configForm.name} onChange={e => setConfigForm(f => ({ ...f, name: e.target.value }))} placeholder="Your Name" /></div>
                        <div style={{ flex: 1 }}><label className="label">user.email</label><input className="input" value={configForm.email} onChange={e => setConfigForm(f => ({ ...f, email: e.target.value }))} placeholder="you@example.com" /></div>
                    </div>
                ) : (
                    <div style={{ display: "flex", gap: 12 }}>
                        <div style={{ flex: 1 }}><p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>user.name</p><p className="mono" style={{ fontSize: 13, margin: 0 }}>{gitConfig.name || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Not set</span>}</p></div>
                        <div style={{ flex: 1 }}><p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>user.email</p><p className="mono" style={{ fontSize: 13, margin: 0 }}>{gitConfig.email || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Not set</span>}</p></div>
                    </div>
                )}
            </div>

            {/* Node key sync — only shown once a worker node exists */}
            {syncStatus.length > 0 && (
                <div className="card" style={{ padding: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <span>🔄</span>
                        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Key Sync to Nodes</h3>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>Keys &amp; git config auto-push to nodes on every change</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {syncStatus.map(n => {
                            const offline = !n.reachable && n.enabled;
                            const outOfSync = n.reachable && !n.inSync;
                            const issues = [
                                n.missing.length ? `${n.missing.length} missing` : null,
                                n.mismatched.length ? `${n.mismatched.length} outdated` : null,
                                !n.gitConfigInSync ? "git config differs" : null,
                            ].filter(Boolean).join(", ");
                            return (
                                <div key={n.nodeId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg-input)", borderRadius: 8 }}>
                                    <span style={{ fontSize: 14 }}>
                                        {!n.enabled ? "⏸️" : offline ? "❌" : n.inSync ? "✅" : "⚠️"}
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>⬡ {n.name}</p>
                                        <p style={{ fontSize: 11, color: outOfSync ? "var(--warning)" : "var(--text-dim)", margin: "2px 0 0" }}>
                                            {!n.enabled ? "Disabled" : offline ? "Offline — cannot sync" : n.inSync ? `In sync (${n.matched.length} key${n.matched.length === 1 ? "" : "s"})` : issues || "Out of sync"}
                                        </p>
                                    </div>
                                    <button
                                        className="btn-ghost"
                                        style={{ fontSize: 11, padding: "4px 10px" }}
                                        disabled={!n.reachable || syncing[n.nodeId]}
                                        onClick={() => handleSyncNode(n.nodeId)}
                                    >
                                        {syncing[n.nodeId] ? "Syncing…" : "Sync now"}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {keysLoading ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading keys…</div>
            ) : keys.length === 0 ? (
                <div className="card" style={{ padding: 24, textAlign: "center" }}>
                    <p style={{ fontSize: 14, color: "var(--text)", margin: "0 0 4px 0" }}>No SSH keys found</p>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Add a key to connect to GitHub repositories</p>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {keys.map(key => {
                        const test = testResults[key.name];
                        const isExpanded = expandedKey === key.name;
                        return (
                            <div key={key.name} className="card" style={{ padding: 12 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🔑</div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <p className="mono" style={{ fontSize: 13, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{key.name}</p>
                                            {key.hostAlias && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(91,115,232,0.1)", color: "var(--accent)" }}>{key.hostAlias}</span>}
                                        </div>
                                        {key.fingerprint && <p className="mono" style={{ fontSize: 10, color: "var(--text-dim)", margin: "4px 0 0 0", overflow: "hidden", textOverflow: "ellipsis" }}>{key.fingerprint}</p>}
                                    </div>
                                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                        <button onClick={() => handleTest(key.name)} disabled={test?.loading} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12, color: test?.success === true ? "#4ade80" : test?.success === false ? "#f87171" : "inherit" }}>
                                            {test?.loading ? "⏳" : test?.success === true ? "✅" : test?.success === false ? "❌" : "🔗"}
                                        </button>
                                        {key.publicKey && <button onClick={() => handleCopy(key.publicKey, key.name)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12 }}>{copiedKey === key.name ? "✓" : "📋"}</button>}
                                        <button onClick={() => setExpandedKey(isExpanded ? null : key.name)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12 }}>{isExpanded ? "▲" : "▼"}</button>
                                        <button onClick={() => setDeleteConfirm(key.name)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 12, color: "var(--danger)" }}>🗑️</button>
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                                        {key.publicKey && (
                                            <div>
                                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", margin: 0 }}>Public Key</p></div>
                                                <pre className="mono" style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--bg-input)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{key.publicKey}</pre>
                                            </div>
                                        )}
                                        {key.hostAlias && (
                                            <div>
                                                <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>Clone URL Pattern</p>
                                                <p className="mono" style={{ fontSize: 11, color: "var(--text)", background: "var(--bg-input)", padding: 10, borderRadius: 6, margin: 0 }}>git@{key.hostAlias}:username/repo.git</p>
                                            </div>
                                        )}
                                        {test && !test.loading && test.output && (
                                            <div>
                                                <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>Test Result</p>
                                                <pre className="mono" style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--bg-input)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap" }}>{test.output}</pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

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
                running the panel serve it; the others redirect to it. Moving the panel changes no DNS — and Prepare issues the
                new node's certificates in advance. The panel is at <a href={data.publicUrl} className="mono">{data.publicUrl}</a>.
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
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", fontSize: 13 }}>
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
                                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>🔒 SSL</span>
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

// ── Panel gateway: every node's 127.0.0.1:4201 door to the panel ─────────────

function PanelGatewaySection() {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");
    const load = useCallback(() => {
        setError("");
        api.get("/panel/gateway", { timeout: 60_000 }).then((r) => setRows(r.data.nodes)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Projects call the panel's API at <span className="mono">http://127.0.0.1:4201</span> on whatever node they run on. The agent there
                forwards to the panel holding its node — so neither moving the panel nor migrating a project needs a .env change.
                Set it with <strong>API Keys</strong> below (PANEL_API_URL).
            </p>
            {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}
            {!rows ? (
                !error && <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>Loading…</p>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {rows.map((g) => {
                        const ok = g.listening && g.panelUrl && g.reach?.ok;
                        const why = g.error
                            ? g.error
                            : !g.listening
                              ? "not listening"
                              : !g.panelUrl
                                ? "does not know the panel yet"
                                : g.reach?.ok
                                  ? `→ ${g.panelUrl}`
                                  : `→ ${g.panelUrl} unreachable (${g.reach?.error || "?"})`;
                        return (
                            <div key={g.nodeId} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                                <span>{ok ? "✅" : "⚠️"}</span>
                                <strong style={{ color: "var(--text)" }}>{g.name}</strong>
                                {g.localUrl && <span className="mono" style={{ color: "var(--text-dim)" }}>{g.localUrl}</span>}
                                <span className="mono" style={{ color: ok ? "var(--text-muted)" : "#f59e0b", overflowWrap: "anywhere" }}>{why}</span>
                            </div>
                        );
                    })}
                </div>
            )}
            <div><button className="btn-ghost" onClick={load} style={{ padding: "4px 10px", fontSize: 12 }}>Refresh</button></div>
        </div>
    );
}

// ── LogRotateSection ──────────────────────────────────────────────────────────

const LOGROTATE_FIELDS = [
    { key: "max_size", label: "Max size", hint: "Rotate when a log reaches this size (e.g. 50M, 1G)", placeholder: "50M", width: 90 },
    { key: "retain", label: "Retain", hint: "How many rotated files to keep per process", placeholder: "7", width: 60 },
    { key: "rotateInterval", label: "Rotate at (cron)", hint: "Forced rotation schedule — default is midnight daily", placeholder: "0 0 * * *", width: 110 },
];

// ── API keys: one per project calling /api/external ─────────────────────────

const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : "never");

function ApiKeysSection() {
    const { bots } = useData();
    const [data, setData] = useState(null);
    const [form, setForm] = useState({ botId: "", label: "", envKey: "PANEL_API_KEY", writeEnv: true, setUrl: true, urlKey: "PANEL_API_URL" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [created, setCreated] = useState(null); // { record, key?, wroteEnv? }
    const [restart, setRestart] = useState(null); // null | "running" | "done" | error text
    const [revokeConfirm, setRevokeConfirm] = useState(null);

    const load = useCallback(() => {
        api.get("/panel/api-keys").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load API keys"));
    }, []);
    useEffect(load, [load]);

    const create = async () => {
        setBusy(true); setError(""); setCreated(null); setRestart(null);
        try {
            const { setUrl, ...rest } = form;
            const { data: r } = await api.post("/panel/api-keys", { ...rest, urlKey: setUrl ? form.urlKey : null }, { timeout: 60_000 });
            setCreated(r);
            setForm((f) => ({ ...f, botId: "", label: "" }));
            load();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create the key");
        } finally { setBusy(false); }
    };

    const revoke = async (id) => {
        setRevokeConfirm(null); setError("");
        try { const { data: r } = await api.delete(`/panel/api-keys/${id}`); setData(r); }
        catch (err) { setError(err.response?.data?.error || "Failed to revoke"); }
    };

    const restartProject = async (botId) => {
        setRestart("running");
        try { await api.post(`/bots/${botId}/restart`); setRestart("done"); }
        catch (err) { setRestart(err.response?.data?.error || "Restart failed"); }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;
    const active = data.keys.filter((k) => !k.revokedAt);
    const revoked = data.keys.filter((k) => k.revokedAt);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {revokeConfirm && (
                <ConfirmModal
                    title={`Revoke key ${revokeConfirm.prefix}…`}
                    message={`${revokeConfirm.botName || "The project"} can no longer call the panel with this key, and its callbacks fall back to the shared PANEL_API_KEY.`}
                    confirmText="Revoke"
                    onConfirm={() => revoke(revokeConfirm._id)}
                    onCancel={() => setRevokeConfirm(null)}
                />
            )}
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Give every project that calls the panel's external API its own key instead of the shared PANEL_API_KEY. The panel then knows
                who registered each callback: a <span className="mono">localhost</span> callback follows that project to whatever node it runs on,
                and is signed with the project's key. Moving the panel or the project needs no .env change.
            </p>
            {error && <p style={{ fontSize: 12, color: "#f87171", margin: 0 }}>{error}</p>}

            <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <select className="input" value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <option value="">— choose the project —</option>
                        {bots.map((b) => <option key={b._id} value={b._id}>{b.name} ({b.pm2Name})</option>)}
                    </select>
                    <input className="input" placeholder="label (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ flex: "1 1 140px", minWidth: 0 }} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={form.writeEnv} onChange={(e) => setForm({ ...form, writeEnv: e.target.checked })} />
                        Write it into the project's .env as
                    </label>
                    <input className="input mono" value={form.envKey} disabled={!form.writeEnv} onChange={(e) => setForm({ ...form, envKey: e.target.value })} style={{ width: 170 }} />
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }} title="Points the project at the panel gateway on its own node — no panel address in its .env">
                        <input type="checkbox" checked={form.writeEnv && form.setUrl} disabled={!form.writeEnv} onChange={(e) => setForm({ ...form, setUrl: e.target.checked })} />
                        and
                    </label>
                    <input className="input mono" value={form.urlKey} disabled={!form.writeEnv || !form.setUrl} onChange={(e) => setForm({ ...form, urlKey: e.target.value })} style={{ width: 150 }} />
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>= panel gateway</span>
                    <button className="btn-primary" disabled={!form.botId || busy} onClick={create} style={{ padding: "6px 12px", fontSize: 12, marginLeft: "auto" }}>
                        {busy ? "Creating…" : "Create key"}
                    </button>
                </div>
            </div>

            {created?.wroteEnv && (
                <div className="card" style={{ padding: 12, borderColor: "#4ade80", fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <span>
                        ✅ Written to <strong>{created.record.botName}</strong>'s .env as <span className="mono">{created.wroteEnv}</span>
                        {created.gateway && <>, with <span className="mono">{created.gateway.key}={created.gateway.url}</span></>}. It takes effect when the project restarts.
                    </span>
                    <button className="btn-ghost" disabled={restart === "running" || restart === "done"} onClick={() => restartProject(created.record.botId)} style={{ padding: "4px 10px", fontSize: 12, marginLeft: "auto" }}>
                        {restart === "running" ? "Restarting…" : restart === "done" ? "Restarted ✓" : `Restart ${created.record.botName} now`}
                    </button>
                    {restart && restart !== "running" && restart !== "done" && <span style={{ color: "#f87171", width: "100%" }}>{restart}</span>}
                </div>
            )}
            {created?.key && (
                <div className="card" style={{ padding: 12, borderColor: "#facc15", fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    <span>Key for <strong>{created.record.botName}</strong> — shown once, copy it now:</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <input className="input mono" readOnly value={created.key} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
                        <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(created.key)} style={{ padding: "4px 10px", fontSize: 12 }}>Copy</button>
                    </div>
                </div>
            )}

            {active.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {active.map((k) => (
                        <div key={k._id} className="card" style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
                            <strong style={{ color: "var(--text)" }}>{k.botName || "deleted project"}</strong>
                            {k.label !== k.botName && <span style={{ color: "var(--text-muted)" }}>{k.label}</span>}
                            <span className="mono" style={{ color: "var(--text-dim)" }}>{k.prefix}…</span>
                            <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>created {fmtWhen(k.createdAt)} · last used {fmtWhen(k.lastUsedAt)}</span>
                            <button className="btn-ghost" onClick={() => setRevokeConfirm(k)} style={{ padding: "2px 8px", fontSize: 11, color: "#f87171" }}>Revoke</button>
                        </div>
                    ))}
                </div>
            )}
            {revoked.length > 0 && (
                <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>
                    Revoked: {revoked.map((k) => `${k.botName || "?"} ${k.prefix}…`).join(", ")}
                </p>
            )}
            {!data.sharedKey && active.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>PANEL_API_KEY is not set and no project has a key — the external API refuses everyone.</p>
            )}

            {data.callbacks.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>Localhost callbacks the panel holds</span>
                    {data.callbacks.map((c) => (
                        <div key={`${c.url}|${c.ownerBotId}`} style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span className="mono" style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{c.url}</span>
                            <span style={{ color: "var(--text-muted)" }}>{c.sources.join(", ")}</span>
                            {c.ownerBotId
                                ? <span style={{ color: "#4ade80" }}>→ follows {c.ownerName}</span>
                                : <span style={{ color: "#facc15" }}>→ no known project: pinned to this node when the panel moves</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Shared data + the Discord bus ───────────────────────────────────────────
// Data the bots and the panel both use lives on the panel (bots call it through
// their gateway); commands to the bots go through a private Discord channel.

const BUS_STATUS_COLOR = { done: "#4ade80", failed: "#f87171", sent: "var(--accent)", queued: "var(--text-muted)" };

function SharedDataSection() {
    const { bots } = useData();
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [form, setForm] = useState({ botId: "", name: "", kind: "collection" });
    const [busy, setBusy] = useState(null);
    const [note, setNote] = useState("");

    const load = useCallback(() => {
        api.get("/panel/shared").then((r) => { setData(r.data); setError(""); }).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    const act = (key, fn) => async () => {
        setBusy(key); setNote(""); setError("");
        try { setNote(await fn()); load(); }
        catch (err) { setError(err.response?.data?.error || err.message); }
        finally { setBusy(null); }
    };

    const declare = act("declare", async () => {
        await api.post("/panel/shared/declare", form);
        setForm((f) => ({ ...f, name: "" }));
        return `"${form.name}" reserved — the project moves its copy here on its next start (PANEL_SHARED)`;
    });
    const ping = (botId, name) => act(`ping:${botId}`, async () => {
        const { data: r } = await api.post("/panel/shared/ping", { botId }, { timeout: 40_000 });
        return `${name} answered over Discord in ${r.ms} ms`;
    });
    const publish = act("publish", async () => (await api.post("/panel/shared/decor-site/publish", {}, { timeout: 120_000 })).data.message);

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;
    const { bus, names, capabilities, recent, decorSite } = data;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Data a bot and the panel both use is kept here: the bot lists the names in <span className="mono">PANEL_SHARED</span> and reads/writes
                them through its gateway — the panel never calls a bot. When the panel needs a bot to act (complete an order, send a DM…), it posts
                a signed command in a private Discord channel and the bot replies there.
            </p>
            {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}
            {note && <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{note}</p>}

            <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ color: "var(--text)" }}>Discord bus</strong>
                {!bus.configured ? (
                    <span style={{ color: "var(--text-muted)" }}>off — set PANEL_DISCORD_TOKEN and PANEL_BUS_CHANNEL_ID in .env</span>
                ) : bus.ready ? (
                    <span style={{ color: "#4ade80" }}>✅ {bus.botTag} on channel <span className="mono">{bus.channelId}</span></span>
                ) : (
                    <span style={{ color: "#f59e0b" }}>⚠️ not connected{bus.error ? ` — ${bus.error}` : ""}</span>
                )}
                {Object.entries(bus.counts || {}).map(([k, n]) => <span key={k} style={{ color: "var(--text-dim)" }}>{k}: {n}</span>)}
            </div>

            {capabilities.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {capabilities.map((c) => (
                        <div key={c.botId} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                            <strong style={{ color: "var(--text)" }}>{c.name || c.botId}</strong>
                            <span className="mono" style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{c.commands.join(", ")}</span>
                            <span style={{ color: "var(--text-dim)" }}>· seen {new Date(c.at).toLocaleString()}</span>
                            <button className="btn-ghost" disabled={!bus.ready || busy === `ping:${c.botId}`} onClick={ping(c.botId, c.name)} style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto" }}>
                                {busy === `ping:${c.botId}` ? "Pinging…" : "Ping"}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {names.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 12, color: "var(--text-dim)" }}>No shared data yet.</div>
                ) : names.map((n, i) => (
                    <div key={n.name} style={{ display: "flex", gap: 10, padding: "8px 12px", fontSize: 12, alignItems: "baseline", flexWrap: "wrap", borderBottom: i < names.length - 1 ? "1px solid var(--border-light)" : "none" }}>
                        <strong className="mono" style={{ color: "var(--text)" }}>{n.name}</strong>
                        <span style={{ color: "var(--text-dim)" }}>{n.kind}</span>
                        <span style={{ color: "var(--text-muted)" }}>{n.ownerName || n.owner}</span>
                        <span style={{ marginLeft: "auto", color: n.state === "active" ? "#4ade80" : "#f59e0b" }}>
                            {n.state === "active" ? `${n.kind === "collection" ? `${n.count} records` : n.count ? "set" : "empty"}` : "waiting for the project to move it here"}
                        </span>
                    </div>
                ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="input" value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <option value="">— owning project —</option>
                    {bots.map((b) => <option key={b._id} value={b._id}>{b.name} ({b.pm2Name})</option>)}
                </select>
                <input className="input mono" placeholder="name (e.g. orders)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.trim() })} style={{ flex: "1 1 140px", minWidth: 0 }} />
                <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ width: 130 }}>
                    <option value="collection">collection</option>
                    <option value="value">value</option>
                </select>
                <button className="btn-primary" disabled={!form.botId || !form.name || busy === "declare"} onClick={declare} style={{ padding: "6px 12px", fontSize: 12 }}>Declare</button>
            </div>

            <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ color: "var(--text)" }}>Decor site</strong>
                {decorSite.configured ? (
                    <span style={{ color: "var(--text-muted)" }}>
                        publishes to <span className="mono">{decorSite.repo}</span>
                        {decorSite.last?.at ? ` · last: ${decorSite.last.ok ? "✅" : "❌"} ${decorSite.last.message} (${new Date(decorSite.last.at).toLocaleString()})` : " · nothing published yet"}
                    </span>
                ) : (
                    <span style={{ color: "var(--text-muted)" }}>off — set DECOR_SITE_GITHUB_TOKEN (Contents: read & write on the site repo) in .env</span>
                )}
                {decorSite.configured && (
                    <button className="btn-ghost" disabled={busy === "publish"} onClick={publish} style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto" }}>
                        {busy === "publish" ? "Publishing…" : "Publish now"}
                    </button>
                )}
            </div>

            {recent.length > 0 && (
                <details>
                    <summary style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>Recent commands ({recent.length})</summary>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                        {recent.map((r) => (
                            <div key={r.id} style={{ display: "flex", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
                                <span style={{ color: "var(--text-dim)" }}>{new Date(r.createdAt).toLocaleString()}</span>
                                <span style={{ color: "var(--text-muted)" }}>{r.targetName || r.target}</span>
                                <span className="mono">{r.cmd}</span>
                                <span style={{ color: BUS_STATUS_COLOR[r.status] || "var(--text-muted)" }}>{r.status}</span>
                                {r.error && <span style={{ color: "#f87171", overflowWrap: "anywhere" }}>{r.error}</span>}
                            </div>
                        ))}
                    </div>
                </details>
            )}
            <div><button className="btn-ghost" onClick={load} style={{ padding: "4px 10px", fontSize: 12 }}>Refresh</button></div>
        </div>
    );
}

// ── Moving the panel to another node ────────────────────────────────────────

const CHECK_ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", error: "❌" };
const STEP_ICON = { running: "⏳", ok: "✅", warn: "⚠️", error: "❌" };

function MoveResult({ result }) {
    if (!result?.target) return null;
    const { target, url, port } = result;
    const href = url || `http://${target.host}:${port}`;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            <p style={{ margin: 0, color: "#4ade80", fontWeight: 700 }}>The panel now runs on {target.name}. This copy is being stopped.</p>
            <p style={{ margin: 0 }}>
                It answers at <span className="mono">{href}</span>. This node's domains will redirect there once the new panel has flipped them.
            </p>
            <div><a className="btn-primary" href={href} style={{ padding: "6px 12px", fontSize: 12, display: "inline-block" }}>Open the new panel</a></div>
        </div>
    );
}

function MoveJob({ job, lost }) {
    const title = job.kind === "move" ? `Moving the panel to ${job.targetName}` : `Preparing ${job.targetName}`;
    const statusColor = job.status === "done" ? "#4ade80" : job.status === "failed" ? "#f87171" : "var(--accent)";
    return (
        <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13, color: "var(--text)" }}>{title}</strong>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: statusColor }}>{job.status}</span>
            </div>
            {job.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                    <span>{STEP_ICON[s.status] || "•"}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: "var(--text)" }}>{s.label}</div>
                        {s.detail && (
                            <pre className="mono" style={{ margin: "2px 0 0", fontSize: 11, color: s.status === "error" ? "#f87171" : "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto" }}>{s.detail}</pre>
                        )}
                    </div>
                </div>
            ))}
            {job.error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{job.error}</p>}
            {job.kind === "move" && job.status === "done" && <MoveResult result={job.result} />}
            {lost && job.kind === "move" && job.status !== "failed" && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>This copy of the panel has stopped answering — the new one retired it, as expected.</p>
            )}
        </div>
    );
}

function PanelMoveSection() {
    const [ov, setOv] = useState(null);
    const [lost, setLost] = useState(false);
    const [targetId, setTargetId] = useState("");
    const [pf, setPf] = useState(null);
    const [checking, setChecking] = useState(false);
    const [confirmName, setConfirmName] = useState("");
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/panel/migration");
            setOv(data); setLost(false);
        } catch {
            setLost(true);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const job = ov?.job;
    const running = job?.status === "running";
    // Poll while a job runs; keep polling after a finished move so "stopped
    // answering" shows once the new panel retires this one.
    const followMove = job?.kind === "move" && job?.status === "done";
    useEffect(() => {
        if (!running && !followMove) return;
        const t = setInterval(load, running ? 2000 : 5000);
        return () => clearInterval(t);
    }, [running, followMove, load]);

    // A finished Prepare carries a fresh preflight — show it.
    useEffect(() => {
        if (job?.kind === "prepare" && job.status === "done" && job.result?.preflight) setPf(job.result.preflight);
    }, [job?.kind, job?.status, job?.result]);

    const runCheck = async () => {
        setChecking(true); setError(""); setPf(null);
        try {
            const { data } = await api.post("/panel/migration/preflight", { targetNodeId: targetId }, { timeout: 180_000 });
            setPf(data);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally { setChecking(false); }
    };

    const start = (kind) => async () => {
        setError("");
        try {
            const body = kind === "start" ? { targetNodeId: targetId, confirmName } : { targetNodeId: targetId };
            await api.post(`/panel/migration/${kind}`, body, { timeout: 180_000 });
            setConfirmName("");
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    };

    if (!ov) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Loading…</p>;

    const state = ov.lifecycle?.state;
    const current = ov.nodes.find((n) => n.isPanelNode);
    const candidates = ov.nodes.filter((n) => !n.isPanelNode && n.enabled);
    const nodeName = (id) => ov.nodes.find((n) => n._id === id)?.name || id;
    const idle = !running && state === "active";

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                The panel runs on <strong style={{ color: "var(--text)" }}>{current?.name || ov.panelNodeId || "?"}</strong> (epoch {ov.epoch}).
                Moving it copies its database, .env and history to another node, starts it there and retires this copy.
                Bots keep running throughout; quests and badge orders pause for a few minutes and resume on the new panel.
            </p>

            {state === "fenced" && (
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#f87171" }}>
                    This panel has been replaced{ov.lifecycle.info?.to ? ` — it now runs on ${ov.lifecycle.info.to}` : ""}. Nothing here runs any more.
                    {ov.lifecycle.info?.url && <> Open <a href={ov.lifecycle.info.url} className="mono">{ov.lifecycle.info.url}</a>.</>}
                </p>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="input" value={targetId} disabled={!idle} onChange={(e) => { setTargetId(e.target.value); setPf(null); setConfirmName(""); }} style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <option value="">— choose the new host —</option>
                    {candidates.map((n) => (
                        <option key={n._id} value={n._id}>{n.name} ({n.host}){n.online ? "" : " — offline"}</option>
                    ))}
                </select>
                <button className="btn-ghost" disabled={!targetId || checking || !idle} onClick={runCheck} style={{ padding: "6px 12px", fontSize: 12 }}>
                    {checking ? "Checking…" : "Check"}
                </button>
                <button className="btn-primary" disabled={!pf?.canPrepare || !idle} onClick={start("prepare")} style={{ padding: "6px 12px", fontSize: 12 }} title="Firewall access, dependencies, client build and HTTPS for its domains on the new host — nothing is paused">
                    Prepare
                </button>
            </div>

            {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

            {pf && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {pf.checks.map((c, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                            <span>{CHECK_ICON[c.level] || "•"}</span>
                            <span style={{ color: c.level === "error" ? "#f87171" : c.level === "warn" ? "#f59e0b" : "var(--text-muted)", overflowWrap: "anywhere" }}>{c.message}</span>
                        </div>
                    ))}
                </div>
            )}

            {pf?.canMove && idle && pf.target?._id === targetId && (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.04)" }}>
                    <p style={{ margin: 0, fontSize: 13 }}>Every check passed. Type <strong className="mono">{pf.target.name}</strong> to move the panel there.</p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={pf.target.name} style={{ flex: "1 1 200px", minWidth: 0 }} />
                        <button className="btn-primary" disabled={confirmName !== pf.target.name} onClick={start("start")} style={{ padding: "6px 14px", fontSize: 12, background: "var(--danger)" }}>
                            Move panel
                        </button>
                    </div>
                </div>
            )}

            {job && <MoveJob job={job} lost={lost} />}

            {ov.history?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
                    <strong style={{ color: "var(--text-muted)" }}>Recent moves</strong>
                    {ov.history.map((h) => (
                        <span key={h.id}>
                            {new Date(h.startedAt).toLocaleString()} · {nodeName(h.fromNodeId)} → {nodeName(h.toNodeId)} · {h.status}{h.error ? ` — ${h.error}` : ""}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function LogRotateSection() {
    const [info, setInfo] = useState(null);
    const [form, setForm] = useState({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    const load = useCallback(() => {
        api.get("/panel/logrotate")
            .then(r => {
                setInfo(r.data);
                const c = r.data.config || {};
                setForm({
                    max_size: c.max_size ?? "50M",
                    retain: String(c.retain ?? "7"),
                    rotateInterval: c.rotateInterval ?? "0 0 * * *",
                    compress: String(c.compress ?? "true") === "true",
                });
            })
            .catch(() => setError("Failed to load log rotation status"));
    }, []);
    useEffect(() => { load(); }, [load]);

    const handleInstall = async () => {
        setBusy(true); setError("");
        try {
            const { data } = await api.post("/panel/logrotate/install", {}, { timeout: 300_000 });
            setInfo(data); load();
        } catch (err) {
            setError(err.response?.data?.error || "Install failed — check panel logs");
        } finally { setBusy(false); }
    };

    const handleSave = async () => {
        setBusy(true); setError(""); setSaved(false);
        try {
            const { data } = await api.put("/panel/logrotate", {
                max_size: form.max_size.trim(),
                retain: form.retain.trim(),
                rotateInterval: form.rotateInterval.trim(),
                compress: String(form.compress),
            });
            setInfo(data); setSaved(true);
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save settings");
        } finally { setBusy(false); }
    };

    if (info === null) {
        return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>;
    }

    if (!info.installed) {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    pm2-logrotate is not installed. Without it PM2 logs grow forever and can
                    fill the disk — which corrupts PM2's saved process list and loses every
                    bot on the next reboot.
                </p>
                {error && <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", fontSize: 13 }}>{error}</div>}
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
                {LOGROTATE_FIELDS.map(f => (
                    <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }} title={f.hint}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{f.label}</span>
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

            {saved && <div style={{ fontSize: 12, color: "#4ade80" }}>✓ Settings applied</div>}
            {error && <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", fontSize: 13 }}>{error}</div>}
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
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 13 }}>
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

export default function PanelManage() {
    const [status, setStatus] = useState(null);
    const [logs, setLogs] = useState("");
    const [logsLoading, setLogsLoading] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [confirm, setConfirm] = useState(null);
    const [building, setBuilding] = useState(null); // null | "agents" | "panel"
    const [buildOutput, setBuildOutput] = useState(() => {
        const saved = sessionStorage.getItem("panel_build_output");
        if (saved) { sessionStorage.removeItem("panel_build_output"); try { return JSON.parse(saved); } catch { return null; } }
        return null;
    });
    const logsEndRef = useRef(null);

    const fetchStatus = useCallback(() => { api.get("/panel/status").then(r => setStatus(r.data)).catch(() => {}); }, []);
    useEffect(() => { fetchStatus(); const int = setInterval(fetchStatus, 5000); return () => clearInterval(int); }, [fetchStatus]);

    const fetchLogs = async () => {
        setLogsLoading(true);
        try { const r = await api.get("/panel/logs?lines=200"); setLogs(r.data.logs || "No logs available"); }
        catch { setLogs("Failed to fetch logs"); }
        finally { setLogsLoading(false); }
    };
    useEffect(() => { if (showLogs) fetchLogs(); }, [showLogs]);
    useEffect(() => { if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: "smooth" }); }, [logs]);

    const handleRestart = () => {
        setConfirm({
            title: "Restart Panel",
            message: "The panel will restart. You'll lose connection for a few seconds while it comes back up. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                try { await api.post("/panel/restart"); setTimeout(() => setReconnecting(true), 1000); }
                catch (err) { alert("Failed to restart: " + (err.response?.data?.message || err.message)); }
            },
        });
    };

    // Two requests, agents first: a newer panel may call endpoints an older
    // agent does not have. Kept separate so neither runs into the reverse
    // proxy's read timeout on its own.
    const handleRebuild = () => {
        setConfirm({
            title: "Update Agents, Rebuild & Restart Panel",
            message: "First updates the agent on every node (git pull, install, restart — bots keep running), then rebuilds the client UI and restarts the panel. The panel stays online during the build. Continue?",
            onConfirm: async () => {
                setConfirm(null); setBuildOutput(null);
                let agents = [];
                try {
                    setBuilding("agents");
                    try {
                        const r = await api.post("/panel/update-agents", {}, { timeout: 600_000 });
                        agents = r.data.agents || [];
                    } catch (err) {
                        setBuildOutput({ success: false, output: "", message: `Agent update failed — the panel was NOT rebuilt: ${err.response?.data?.error || err.message}` });
                        return;
                    }
                    // The rebuild itself runs on the panel node's agent — without it there is nothing to rebuild with.
                    const panelAgent = agents.find((a) => a.isPanelNode);
                    if (panelAgent && !panelAgent.ok) {
                        setBuildOutput({ success: false, output: "", agents, message: "The agent on the panel's own node did not update — the panel was NOT rebuilt." });
                        return;
                    }

                    setBuilding("panel");
                    try {
                        const r = await api.post("/panel/rebuild", {}, { timeout: 300_000 });
                        const outputData = { success: true, output: r.data.buildOutput, message: r.data.message, agents };
                        setBuildOutput(outputData); sessionStorage.setItem("panel_build_output", JSON.stringify(outputData));
                        setTimeout(() => setReconnecting(true), 1000);
                    } catch (err) {
                        setBuildOutput({ success: false, output: err.response?.data?.buildOutput || err.message, message: err.response?.data?.message || "Build failed", agents });
                    }
                } finally { setBuilding(null); }
            },
        });
    };

    const handleReconnected = useCallback(() => { setReconnecting(false); fetchStatus(); window.location.reload(); }, [fetchStatus]);

    if (!status) {
        return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Loading panel info…</div>;
    }

    const { env, git, pm2 } = status;
    const isOnline = pm2?.status === "online";
    const statusColor = isOnline ? "var(--success)" : "var(--danger)";

    return (
        <div className="page-compact fade-in" style={{ maxWidth: 960, display: "flex", flexDirection: "column", gap: 24 }}>
            {reconnecting && <ReconnectOverlay onReconnected={handleReconnected} />}
            {confirm && <ConfirmModal title={confirm.title} message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}

            {/* Header */}
            <div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Panel Settings</h1>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "2px 8px", borderRadius: 99, background: isOnline ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", color: statusColor, border: `1px solid ${isOnline ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}` }}>
                        {pm2?.status || "Unknown"}
                    </span>
                    {env?.isDev && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "2px 8px", borderRadius: 99, background: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.2)" }}>Dev Mode</span>}
                </div>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Manage the control panel process and configuration</p>
            </div>

            {/* Build output banner */}
            {buildOutput && (
                <div className="card" style={{ padding: 16, border: `1px solid ${buildOutput.success ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, background: buildOutput.success ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)' }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: buildOutput.output || buildOutput.agents?.length ? 12 : 0 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, color: buildOutput.success ? "#4ade80" : "#f87171", margin: 0 }}>{buildOutput.success ? "✅ Build Successful" : "❌ Build Failed"}</h3>
                        <button onClick={() => setBuildOutput(null)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}>Dismiss</button>
                    </div>
                    {buildOutput.message && <p style={{ fontSize: 13, margin: "0 0 8px 0" }}>{buildOutput.message}</p>}
                    {buildOutput.agents?.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "0 0 10px 0" }}>
                            {buildOutput.agents.map((a) => (
                                <div key={a.nodeId} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
                                    <span>{a.ok ? "✅" : "❌"}</span>
                                    <strong style={{ color: "var(--text)", whiteSpace: "nowrap" }}>Agent · {a.name}{a.isPanelNode ? " (panel)" : ""}</strong>
                                    <span style={{ color: a.ok ? "var(--text-muted)" : "#f87171", minWidth: 0, overflowWrap: "anywhere" }}>{a.message}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {buildOutput.output && <pre className="mono" style={{ fontSize: 11, color: "var(--text-dim)", background: "rgba(0,0,0,0.2)", padding: 12, borderRadius: 8, margin: 0, maxHeight: 300, overflowY: "auto", whiteSpace: "pre-wrap" }}>{buildOutput.output}</pre>}
                </div>
            )}

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
                <StatCard icon="⚡" label="Version" value={`v${env?.version || "?"}`} sub={git?.commitHash ? `Commit: ${git.commitHash.substring(0,7)}` : ""} />
                <StatCard icon="⏱️" label="Uptime" value={fmtUptime(pm2?.pm_uptime)} sub="Time since last restart" />
                <StatCard icon="💾" label="Memory" value={fmt(pm2?.monit?.memory)} sub="Panel RAM usage" />
                <StatCard icon="🖥️" label="CPU" value={`${pm2?.monit?.cpu || 0}%`} sub="Panel CPU usage" />
            </div>

            {/* Grid for Actions and Info */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
                {/* Process Actions */}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>Actions</h2>
                    <button onClick={handleRestart} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.05)", cursor: "pointer", transition: "all 0.2s" }} onMouseEnter={e => e.currentTarget.style.background = "rgba(245,158,11,0.1)"} onMouseLeave={e => e.currentTarget.style.background = "rgba(245,158,11,0.05)"}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(245,158,11,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#f59e0b" }}>🔄</div>
                        <div style={{ textAlign: "left" }}>
                            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 2px 0" }}>Restart Panel</p>
                            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>Restarts the PM2 process</p>
                        </div>
                    </button>
                    <button onClick={handleRebuild} disabled={building} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, border: "1px solid rgba(91,115,232,0.3)", background: "rgba(91,115,232,0.05)", cursor: building ? "wait" : "pointer", opacity: building ? 0.7 : 1, transition: "all 0.2s" }} onMouseEnter={e => !building && (e.currentTarget.style.background = "rgba(91,115,232,0.1)")} onMouseLeave={e => !building && (e.currentTarget.style.background = "rgba(91,115,232,0.05)")}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(91,115,232,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "var(--accent)" }}>{building ? "⏳" : "🛠️"}</div>
                        <div style={{ textAlign: "left" }}>
                            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 2px 0" }}>{building === "agents" ? "Updating agents..." : building ? "Rebuilding..." : "Rebuild & Restart"}</p>
                            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>Updates every node's agent, then rebuilds and restarts</p>
                        </div>
                    </button>
                </div>

                {/* GitHub Keys */}
                <GitHubSection />
            </div>

            {/* Panel Domains */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🌐</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Custom Domains</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>One per node, via nginx</span>
                </div>
                <div style={{ padding: 16 }}>
                    <PanelDomainsSection />
                </div>
            </div>

            {/* API keys */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🔑</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>API Keys</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>One per project calling the external API</span>
                </div>
                <div style={{ padding: 16 }}>
                    <ApiKeysSection />
                </div>
            </div>

            {/* Panel gateway */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🚪</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Panel Gateway</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>127.0.0.1:4201 on every node</span>
                </div>
                <div style={{ padding: 16 }}>
                    <PanelGatewaySection />
                </div>
            </div>

            {/* Shared data + Discord bus */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🗄️</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Shared Data &amp; Discord Bus</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>Bots call the panel; the panel talks to them on Discord</span>
                </div>
                <div style={{ padding: 16 }}>
                    <SharedDataSection />
                </div>
            </div>

            {/* Move the panel */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🚚</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Move Panel</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>Run the panel on another node</span>
                </div>
                <div style={{ padding: 16 }}>
                    <PanelMoveSection />
                </div>
            </div>

            {/* Log Rotation */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>♻️</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Log Rotation</h2>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>pm2-logrotate — keeps PM2 logs from filling the disk</span>
                </div>
                <div style={{ padding: 16 }}>
                    <LogRotateSection />
                </div>
            </div>

            {/* Logs Viewer */}
            <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 400, maxHeight: 600, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>📋</span>
                        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Panel Logs</h2>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        {showLogs && <button onClick={fetchLogs} disabled={logsLoading} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}>{logsLoading ? "⏳" : "🔄 Refresh"}</button>}
                        <button onClick={() => setShowLogs(!showLogs)} className="btn-primary" style={{ padding: "4px 8px", fontSize: 11 }}>{showLogs ? "Hide Logs" : "Load Logs"}</button>
                    </div>
                </div>
                {showLogs && (
                    <div className="mono" style={{ flex: 1, padding: 16, background: "var(--bg-base)", overflowY: "auto", fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all", borderTop: "1px solid var(--border)" }}>
                        {logs}
                        <div ref={logsEndRef} />
                    </div>
                )}
                {!showLogs && (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                        Logs are hidden. Click "Load Logs" to view.
                    </div>
                )}
            </div>

            {/* Environment Variables Editor */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, color: "var(--text-muted)" }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Environment Variables</h2>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>.env</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>Requires restart to apply</span>
                </div>
                <div style={{ padding: 16 }}>
                    <EnvEditor onRestart={handleRestart} />
                </div>
            </div>
        </div>
    );
}
