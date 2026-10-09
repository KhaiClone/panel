// ─────────────────────────────────────────────────────────────────────────────
//  Git Keys — the SSH keys and git identity projects are cloned with, pushed to
//  every node. Lived on Panel Settings; it is about projects, not the panel.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

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

export default function GitKeysPage() {
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
        <div className="page fade-in" style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}>
            {deleteConfirm && (
                <ConfirmModal title={`Delete Key "${deleteConfirm}"`} message={`This will permanently delete the SSH key pair and its SSH config entry.\n\n⚠️ Any GitHub repos using this key will no longer be accessible.`} confirmText="Delete Key" onConfirm={() => handleDelete(deleteConfirm)} onCancel={() => setDeleteConfirm(null)} />
            )}
            {showAddModal && <AddKeyModal onClose={() => setShowAddModal(false)} onCreated={() => { fetchKeys(); fetchSyncStatus(); }} />}

            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>Git Keys</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>SSH keys and the git identity projects are cloned with — pushed to every node</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => handleTest(null)} disabled={defaultTest?.loading} className="btn-ghost" style={{ fontSize: 12, padding: "6px 10px" }}>
                        {defaultTest?.loading ? "Testing…" : "🔗 Test Default"}
                    </button>
                    <button onClick={() => setShowAddModal(true)} className="btn-primary" style={{ fontSize: 12, padding: "6px 10px" }}>+ Add Key</button>
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
