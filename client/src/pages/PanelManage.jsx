import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

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

    useEffect(() => { fetchKeys(); fetchGitConfig(); }, [fetchKeys, fetchGitConfig]);

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
        try { await api.delete(`/github/keys/${keyName}`); setKeys(k => k.filter(key => key.name !== keyName)); setDeleteConfirm(null); } catch { /* ignore */ }
    };

    const handleSaveConfig = async () => {
        setConfigSaving(true);
        try {
            const { data } = await api.put("/github/git-config", configForm);
            setGitConfig(data); setEditingConfig(false);
        } catch { /* ignore */ }
        finally { setConfigSaving(false); }
    };

    const defaultTest = testResults["__default__"];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {deleteConfirm && (
                <ConfirmModal title={`Delete Key "${deleteConfirm}"`} message={`This will permanently delete the SSH key pair and its SSH config entry.\n\n⚠️ Any GitHub repos using this key will no longer be accessible.`} confirmText="Delete Key" onConfirm={() => handleDelete(deleteConfirm)} onCancel={() => setDeleteConfirm(null)} />
            )}
            {showAddModal && <AddKeyModal onClose={() => setShowAddModal(false)} onCreated={() => fetchKeys()} />}

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

function PanelDomainsSection() {
    const [domains, setDomains] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newDomain, setNewDomain] = useState("");
    const [adding, setAdding] = useState(false);
    const [sslLoading, setSslLoading] = useState({});
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [error, setError] = useState("");

    const fetchDomains = useCallback(async () => {
        try { const { data } = await api.get("/panel/domains"); setDomains(data); }
        catch { /* ignore */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchDomains(); }, [fetchDomains]);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!newDomain.trim()) return;
        setAdding(true); setError("");
        try {
            const { data } = await api.post("/panel/domains", { domain: newDomain.trim() });
            setDomains(d => [...d, data]);
            setNewDomain("");
        } catch (err) {
            setError(err.response?.data?.error || "Failed to add domain");
        } finally { setAdding(false); }
    };

    const handleDelete = async (domain) => {
        try {
            await api.delete(`/panel/domains/${encodeURIComponent(domain)}`);
            setDomains(d => d.filter(x => x.domain !== domain));
        } catch (err) {
            setError(err.response?.data?.error || "Failed to remove domain");
        } finally { setDeleteConfirm(null); }
    };

    const handleSSL = async (domain) => {
        setSslLoading(s => ({ ...s, [domain]: true })); setError("");
        try {
            await api.post(`/panel/domains/${encodeURIComponent(domain)}/ssl`);
            setDomains(d => d.map(x => x.domain === domain ? { ...x, sslEnabled: true } : x));
        } catch (err) {
            setError(err.response?.data?.error || "SSL issuance failed — ensure domain points to this server");
        } finally { setSslLoading(s => ({ ...s, [domain]: false })); }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {deleteConfirm && (
                <ConfirmModal
                    title={`Remove Domain "${deleteConfirm}"`}
                    message={`This will remove the nginx config for "${deleteConfirm}" and reload nginx. The domain will no longer point to this panel.`}
                    confirmText="Remove"
                    onConfirm={() => handleDelete(deleteConfirm)}
                    onCancel={() => setDeleteConfirm(null)}
                />
            )}

            {/* Add domain form */}
            <form onSubmit={handleAdd} style={{ display: "flex", gap: 8 }}>
                <input
                    className="input mono"
                    style={{ flex: 1, fontSize: 13 }}
                    placeholder="panel.example.com"
                    value={newDomain}
                    onChange={e => { setNewDomain(e.target.value); setError(""); }}
                    disabled={adding}
                    spellCheck={false}
                />
                <button type="submit" className="btn-primary" disabled={adding || !newDomain.trim()} style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                    {adding ? "Adding…" : "+ Add Domain"}
                </button>
            </form>

            {error && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", fontSize: 13 }}>
                    {error}
                </div>
            )}

            {loading ? (
                <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
            ) : domains.length === 0 ? (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    No domains configured. Add one above to access the panel via a custom domain.
                </div>
            ) : (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {domains.map((d, i) => (
                        <div
                            key={d.domain}
                            style={{
                                display: "flex", alignItems: "center", gap: 12,
                                padding: "12px 14px",
                                borderBottom: i < domains.length - 1 ? "1px solid var(--border-light)" : "none",
                            }}
                        >
                            <span style={{ fontSize: 15, flexShrink: 0 }}>🌐</span>
                            <span className="mono" style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {d.sslEnabled ? `https://${d.domain}` : `http://${d.domain}`}
                            </span>
                            {d.sslEnabled ? (
                                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>🔒 SSL</span>
                            ) : (
                                <button
                                    onClick={() => handleSSL(d.domain)}
                                    disabled={sslLoading[d.domain]}
                                    className="btn-ghost"
                                    style={{ fontSize: 11, padding: "3px 8px", color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}
                                    title="Enable HTTPS via Let's Encrypt"
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
    const [building, setBuilding] = useState(false);
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

    const handleRebuild = () => {
        setConfirm({
            title: "Rebuild & Restart Panel",
            message: "This will rebuild the client UI (may take 30-60 seconds) and then restart the panel. The panel stays online during the build. Continue?",
            onConfirm: async () => {
                setConfirm(null); setBuilding(true); setBuildOutput(null);
                try {
                    const r = await api.post("/panel/rebuild", {}, { timeout: 300_000 });
                    const outputData = { success: true, output: r.data.buildOutput, message: r.data.message };
                    setBuildOutput(outputData); sessionStorage.setItem("panel_build_output", JSON.stringify(outputData));
                    setTimeout(() => setReconnecting(true), 1000);
                } catch (err) {
                    setBuildOutput({ success: false, output: err.response?.data?.buildOutput || err.message, message: err.response?.data?.message || "Build failed" });
                } finally { setBuilding(false); }
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
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: buildOutput.output ? 12 : 0 }}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, color: buildOutput.success ? "#4ade80" : "#f87171", margin: 0 }}>{buildOutput.success ? "✅ Build Successful" : "❌ Build Failed"}</h3>
                        <button onClick={() => setBuildOutput(null)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}>Dismiss</button>
                    </div>
                    {buildOutput.message && <p style={{ fontSize: 13, margin: "0 0 8px 0" }}>{buildOutput.message}</p>}
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
                            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 2px 0" }}>{building ? "Rebuilding..." : "Rebuild & Restart"}</p>
                            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>Rebuilds frontend assets and restarts</p>
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
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>Reverse-proxied via nginx</span>
                </div>
                <div style={{ padding: 16 }}>
                    <PanelDomainsSection />
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
