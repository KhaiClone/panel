// ─────────────────────────────────────────────────────────────────────────────
//  Git Keys — the SSH keys and git identity projects are cloned with, pushed to
//  every node. Lived on Panel Settings; it is about projects, not the panel.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { EmptyState, Icon, Modal, Notice, PageHeader, StatusIcon } from "../components/ui";

// A small caption above a value (user.name, Public key…)
const CAPTION = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)", margin: "0 0 4px 0" };

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

    return (
        <Modal title="Add SSH key" onClose={onClose} width={500}>
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                    <label className="label">Mode</label>
                    <div className="tab-bar">
                        <button type="button" onClick={() => setMode("generate")} className={`tab-item${mode === "generate" ? " active" : ""}`} style={{ flex: 1 }}>Generate</button>
                        <button type="button" onClick={() => setMode("import")} className={`tab-item${mode === "import" ? " active" : ""}`} style={{ flex: 1 }}>Import</button>
                    </div>
                </div>
                <div>
                    <label className="label">Key name *</label>
                    <input className="input mono" placeholder="github_myaccount" value={name} onChange={e => setName(e.target.value)} required pattern="[a-zA-Z0-9_-]+" />
                    <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>Saved as ~/.ssh/{name || "..."}</p>
                </div>
                {mode === "generate" ? (
                    <div>
                        <label className="label">Email / comment</label>
                        <input className="input" placeholder="you@example.com" value={comment} onChange={e => setComment(e.target.value)} />
                    </div>
                ) : (
                    <div>
                        <label className="label">Private key *</label>
                        <textarea className="input mono" style={{ height: 160, resize: "vertical", fontSize: 12 }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..." value={privateKey} onChange={e => setPrivateKey(e.target.value)} required spellCheck={false} />
                    </div>
                )}
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
                    <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Save key"}</button>
                </div>
            </form>
        </Modal>
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
                <ConfirmModal title={`Delete key "${deleteConfirm}"`} message={`This will permanently delete the SSH key pair and its SSH config entry.\n\nAny GitHub repos using this key will no longer be accessible.`} confirmText="Delete key" onConfirm={() => handleDelete(deleteConfirm)} onCancel={() => setDeleteConfirm(null)} />
            )}
            {showAddModal && <AddKeyModal onClose={() => setShowAddModal(false)} onCreated={() => { fetchKeys(); fetchSyncStatus(); }} />}

            <PageHeader
                title="Git Keys"
                description="SSH keys and the git identity projects are cloned with — pushed to every node"
                actions={
                    <>
                        <button onClick={() => handleTest(null)} disabled={defaultTest?.loading} className="btn-ghost">
                            <Icon name="link" /> {defaultTest?.loading ? "Testing…" : "Test default"}
                        </button>
                        <button onClick={() => setShowAddModal(true)} className="btn-primary"><Icon name="plus" /> Add key</button>
                    </>
                }
            />

            {defaultTest && !defaultTest.loading && (
                <div className="card" style={{ padding: 12, border: `1px solid ${defaultTest.success ? 'var(--success-border)' : 'var(--danger-border)'}`, background: defaultTest.success ? 'var(--success-bg)' : 'var(--danger-bg)' }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: defaultTest.output ? 8 : 0 }}>
                        <StatusIcon tone={defaultTest.success ? "success" : "danger"} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: defaultTest.success ? "var(--success)" : "var(--danger)" }}>{defaultTest.success ? "Connected" : "Connection failed"}</span>
                        <button onClick={() => setTestResults(r => { const n = { ...r }; delete n["__default__"]; return n; })} className="btn-ghost btn-sm" style={{ marginLeft: "auto" }}>Dismiss</button>
                    </div>
                    {defaultTest.output && <pre className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: 0, whiteSpace: "pre-wrap" }}>{defaultTest.output}</pre>}
                </div>
            )}

            <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Icon name="settings" style={{ color: "var(--text-dim)" }} />
                        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Git global config</h3>
                    </div>
                    {!editingConfig ? (
                        <button onClick={() => { setConfigForm(gitConfig); setEditingConfig(true); }} className="btn-ghost btn-sm"><Icon name="pencil" size={14} /> Edit</button>
                    ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => setEditingConfig(false)} className="btn-ghost btn-sm">Cancel</button>
                            <button onClick={handleSaveConfig} disabled={configSaving} className="btn-primary btn-sm">{configSaving ? "Saving…" : "Save"}</button>
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
                        <div style={{ flex: 1 }}><p style={CAPTION}>user.name</p><p className="mono" style={{ fontSize: 13, margin: 0 }}>{gitConfig.name || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Not set</span>}</p></div>
                        <div style={{ flex: 1 }}><p style={CAPTION}>user.email</p><p className="mono" style={{ fontSize: 13, margin: 0 }}>{gitConfig.email || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Not set</span>}</p></div>
                    </div>
                )}
            </div>

            {/* Node key sync — only shown once a worker node exists */}
            {syncStatus.length > 0 && (
                <div className="card" style={{ padding: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                        <Icon name="refresh" style={{ color: "var(--text-dim)" }} />
                        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Key sync to nodes</h3>
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Keys &amp; git config auto-push to nodes on every change</span>
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
                                    <StatusIcon
                                        tone={!n.enabled ? "neutral" : offline ? "danger" : n.inSync ? "success" : "warning"}
                                        icon={!n.enabled ? "pause" : undefined}
                                    />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{n.name}</p>
                                        <p style={{ fontSize: 11, color: outOfSync ? "var(--warning)" : "var(--text-dim)", margin: "2px 0 0" }}>
                                            {!n.enabled ? "Disabled" : offline ? "Offline — cannot sync" : n.inSync ? `In sync (${n.matched.length} key${n.matched.length === 1 ? "" : "s"})` : issues || "Out of sync"}
                                        </p>
                                    </div>
                                    <button
                                        className="btn-ghost btn-sm"
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
                <EmptyState icon="key" title="No SSH keys found" description="Add a key to connect to GitHub repositories" />
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {keys.map(key => {
                        const test = testResults[key.name];
                        const isExpanded = expandedKey === key.name;
                        return (
                            <div key={key.name} className="card" style={{ padding: 12 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="key" /></div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <p className="mono" style={{ fontSize: 13, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{key.name}</p>
                                            {key.hostAlias && <span className="badge mono" style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>{key.hostAlias}</span>}
                                        </div>
                                        {key.fingerprint && <p className="mono" style={{ fontSize: 10, color: "var(--text-dim)", margin: "4px 0 0 0", overflow: "hidden", textOverflow: "ellipsis" }}>{key.fingerprint}</p>}
                                    </div>
                                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                        <button onClick={() => handleTest(key.name)} disabled={test?.loading} className="btn-ghost btn-icon btn-sm" title="Test the connection to GitHub" style={{ color: test?.success === true ? "var(--success)" : test?.success === false ? "var(--danger)" : undefined }}>
                                            <Icon name={test?.loading ? "hourglass" : test?.success === true ? "checkCircle" : test?.success === false ? "xCircle" : "link"} size={14} />
                                        </button>
                                        {key.publicKey && (
                                            <button onClick={() => handleCopy(key.publicKey, key.name)} className="btn-ghost btn-icon btn-sm" title="Copy the public key">
                                                <Icon name={copiedKey === key.name ? "check" : "copy"} size={14} />
                                            </button>
                                        )}
                                        <button onClick={() => setExpandedKey(isExpanded ? null : key.name)} className="btn-ghost btn-icon btn-sm" title={isExpanded ? "Hide details" : "Show details"}>
                                            <Icon name={isExpanded ? "chevronUp" : "chevronDown"} size={14} />
                                        </button>
                                        <button onClick={() => setDeleteConfirm(key.name)} className="btn-ghost btn-icon btn-sm is-danger" title="Delete key">
                                            <Icon name="trash" size={14} />
                                        </button>
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                                        {key.publicKey && (
                                            <div>
                                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><p style={{ ...CAPTION, margin: 0 }}>Public key</p></div>
                                                <pre className="mono" style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--bg-input)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{key.publicKey}</pre>
                                            </div>
                                        )}
                                        {key.hostAlias && (
                                            <div>
                                                <p style={CAPTION}>Clone URL pattern</p>
                                                <p className="mono" style={{ fontSize: 11, color: "var(--text)", background: "var(--bg-input)", padding: 10, borderRadius: 6, margin: 0 }}>git@{key.hostAlias}:username/repo.git</p>
                                            </div>
                                        )}
                                        {test && !test.loading && test.output && (
                                            <div>
                                                <p style={CAPTION}>Test result</p>
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
