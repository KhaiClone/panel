import { useState, useEffect, useCallback, useMemo } from "react";
import api from "../api/client";

function Toggle({ enabled, onChange, disabled }) {
    return (
        <button
            onClick={() => !disabled && onChange(!enabled)}
            disabled={disabled}
            style={{
                position: "relative", width: 44, height: 24, borderRadius: 12, border: "none", cursor: disabled ? "not-allowed" : "pointer",
                background: enabled ? "var(--success)" : "var(--bg-input)", opacity: disabled ? 0.5 : 1, transition: "background 0.2s"
            }}
        >
            <span style={{
                position: "absolute", top: 2, left: 2, width: 20, height: 20, borderRadius: "50%", background: "#fff",
                transform: enabled ? "translateX(20px)" : "translateX(0)", transition: "transform 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
            }}/>
        </button>
    );
}

function InputField({ label, id, type = "text", value, onChange, placeholder, hint }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <label htmlFor={id} className="label">{label}</label>
            <input id={id} type={type} className="input" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
            {hint && <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{hint}</p>}
        </div>
    );
}

export default function ProxyPage() {
    const [config, setConfig] = useState({ enabled: false, type: "socks5", host: "", port: 1080, username: "", password: "" });
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [loadingBots, setLoadingBots] = useState(true);
    const [savingConfig, setSavingConfig] = useState(false);
    const [msg, setMsg] = useState(null);
    const [togglingId, setTogglingId] = useState(null);
    const [bulking, setBulking] = useState(false);
    
    // Filters
    const [search, setSearch] = useState("");
    const [filterGroup, setFilterGroup] = useState("all");
    const [filterStatus, setFilterStatus] = useState("all");
    
    const [configOpen, setConfigOpen] = useState(true);

    const fetchConfig = useCallback(async () => {
        try {
            const { data } = await api.get("/proxy/config");
            setConfig({ enabled: data.enabled ?? false, type: data.type ?? "socks5", host: data.host ?? "", port: data.port ?? 1080, username: data.username ?? "", password: data.password ?? "" });
        } catch { /* ignore */ } finally { setLoadingConfig(false); }
    }, []);

    const fetchBots = useCallback(async () => {
        try { 
            const [bRes, gRes] = await Promise.all([api.get("/proxy/bots"), api.get("/groups")]);
            setBots(bRes.data); 
            setGroups(gRes.data);
        } catch { /* ignore */ } finally { setLoadingBots(false); }
    }, []);

    useEffect(() => { fetchConfig(); fetchBots(); }, [fetchConfig, fetchBots]);

    const handleSaveConfig = async () => {
        setSavingConfig(true);
        setMsg(null);
        try {
            const payload = { ...config, port: Number(config.port), username: config.username || null, password: config.password || null };
            const { data } = await api.put("/proxy/config", payload);
            setConfig(c => ({ ...c, ...data }));
            setMsg({ type: "success", text: "Proxy configuration saved successfully." });
            setTimeout(() => setMsg(null), 3000);
        } catch { setMsg({ type: "error", text: "Failed to save configuration" }); setTimeout(() => setMsg(null), 3000); } finally { setSavingConfig(false); }
    };

    const handleToggleGlobal = async (val) => {
        const prev = config; setConfig(c => ({ ...c, enabled: val }));
        try { await api.put("/proxy/config", { enabled: val }); }
        catch { setConfig(prev); alert("Failed to toggle proxy"); }
    };

    const handleToggleBot = async (bot, val) => {
        setTogglingId(bot._id);
        setBots(prev => prev.map(b => (b._id === bot._id ? { ...b, proxyEnabled: val } : b)));
        try { await api.put(`/proxy/bots/${bot._id}`, { proxyEnabled: val }); }
        catch { setBots(prev => prev.map(b => (b._id === bot._id ? { ...b, proxyEnabled: !val } : b))); }
        finally { setTogglingId(null); }
    };

    const filteredBots = useMemo(() => {
        return bots.filter(b => {
            const matchesSearch = !search || b.name?.toLowerCase().includes(search.toLowerCase()) || b.pm2Name?.toLowerCase().includes(search.toLowerCase());
            const matchesGroup = filterGroup === "all" || (filterGroup === "ungrouped" ? !b.groupId : b.groupId === filterGroup);
            const matchesStatus = filterStatus === "all" || (filterStatus === "active" ? b.proxyEnabled : !b.proxyEnabled);
            return matchesSearch && matchesGroup && matchesStatus;
        });
    }, [bots, search, filterGroup, filterStatus]);

    const handleBulk = async (proxyEnabled) => {
        setBulking(true);
        const ids = filteredBots.map(b => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots(prev => prev.map(b => (ids.includes(b._id) ? { ...b, proxyEnabled } : b)));
        } catch { alert("Bulk operation failed"); } finally { setBulking(false); }
    };

    const enabledCount = bots.filter(b => b.proxyEnabled).length;

    return (
        <div className="fade-in" style={{ padding: "32px", maxWidth: 1000, margin: "0 auto", display: "flex", flexDirection: "column", gap: 32 }}>
            
            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-end", justifyItems: "space-between", flexWrap: "wrap", gap: 16 }}>
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Proxy Manager</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "6px 0 0 0" }}>Manage proxychains4 settings globally and per instance.</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 20px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 12 }}>
                    <div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Master Switch</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                            <span className="status-dot" style={{ background: config.enabled ? "var(--success)" : "var(--text-muted)", width: 8, height: 8 }}/>
                            <span style={{ fontSize: 14, fontWeight: 600, color: config.enabled ? "var(--success)" : "var(--text)" }}>{config.enabled ? "ACTIVE" : "INACTIVE"}</span>
                        </div>
                    </div>
                    <div style={{ width: 1, height: 30, background: "var(--border)" }}/>
                    <Toggle enabled={config.enabled} onChange={handleToggleGlobal} />
                </div>
            </div>

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
                <div className="card slide-up" style={{ padding: 20 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 8px 0" }}>Proxied Instances</p>
                    <p style={{ fontSize: 24, fontWeight: 700, color: "var(--text)", margin: 0 }}>{enabledCount} <span style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 500 }}>/ {bots.length}</span></p>
                </div>
                <div className="card slide-up" style={{ padding: 20, animationDelay: "0.1s" }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 8px 0" }}>Protocol</p>
                    <p style={{ fontSize: 24, fontWeight: 700, color: "var(--text)", margin: 0 }}>{config.type?.toUpperCase() || "—"}</p>
                </div>
                <div className="card slide-up" style={{ padding: 20, animationDelay: "0.2s" }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 8px 0" }}>Upstream Host</p>
                    <p className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--accent)", margin: 0, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{config.host ? `${config.host}:${config.port}` : "Not Configured"}</p>
                </div>
            </div>

            {/* Config Form */}
            <div className="card slide-up" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent-dim)" }}>
                <div style={{ padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: configOpen ? "var(--bg-input)" : "transparent", borderBottom: configOpen ? "1px solid var(--border-light)" : "none", transition: "all 0.2s" }} onClick={() => setConfigOpen(!configOpen)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg-surface)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18, color: "var(--text-muted)" }}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        </div>
                        <div>
                            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: "var(--text)" }}>Connection Settings</h2>
                            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "2px 0 0 0" }}>Update the upstream proxychain configuration.</p>
                        </div>
                    </div>
                    <span style={{ fontSize: 14, color: "var(--text-muted)", transform: configOpen ? "rotate(180deg)" : "none", transition: "transform 0.3s" }}>▼</span>
                </div>
                {configOpen && (
                    <div style={{ padding: 24 }}>
                        {loadingConfig ? <div style={{ textAlign: "center", padding: 20 }}><div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite", margin: "0 auto" }}/></div> : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                                <div>
                                    <label className="label">Protocol Type</label>
                                    <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                                        {["socks5", "socks4", "http"].map(t => (
                                            <button key={t} onClick={() => setConfig(c => ({ ...c, type: t }))} className={config.type === t ? "btn-primary" : "btn-ghost"} style={{ padding: "8px 20px", fontSize: 13 }}>{t.toUpperCase()}</button>
                                        ))}
                                    </div>
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
                                    <InputField id="host" label="Host / IP Address" value={config.host} onChange={v => setConfig(c => ({ ...c, host: v }))} placeholder="e.g. 127.0.0.1" />
                                    <InputField id="port" label="Port" type="number" value={config.port} onChange={v => setConfig(c => ({ ...c, port: v }))} placeholder="1080" />
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                    <InputField id="user" label="Authentication Username" value={config.username} onChange={v => setConfig(c => ({ ...c, username: v }))} placeholder="Optional" />
                                    <InputField id="pass" label="Authentication Password" type="password" value={config.password} onChange={v => setConfig(c => ({ ...c, password: v }))} placeholder="Optional" />
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginTop: 12, paddingTop: 20, borderTop: "1px solid var(--border-light)" }}>
                                    <p style={{ fontSize: 12, color: "var(--warning)", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                        proxychains4 must be installed on the host machine.
                                    </p>
                                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                                        {msg && (
                                            <span className="fade-in" style={{ fontSize: 13, fontWeight: 600, color: msg.type === "success" ? "var(--success)" : "var(--danger)" }}>
                                                {msg.type === "success" ? "✓ " : "⚠️ "}{msg.text}
                                            </span>
                                        )}
                                        <button onClick={handleSaveConfig} disabled={savingConfig} className="btn-primary" style={{ padding: "10px 24px" }}>
                                            {savingConfig ? "Saving..." : "Save Configuration"}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Assignments List */}
            <div className="card slide-up" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20, background: "var(--bg-input)" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: "var(--text)" }}>Instance Assignments</h2>
                        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "4px 0 0 0" }}>Control which instances are routed through the proxy.</p>
                    </div>
                    
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <input className="input" placeholder="Search by name or ID..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220, background: "var(--bg-card)" }} />
                        
                        <select className="input" value={filterGroup} onChange={e => setFilterGroup(e.target.value)} style={{ width: 160, background: "var(--bg-card)" }}>
                            <option value="all">All Groups</option>
                            <option value="ungrouped">Ungrouped Only</option>
                            {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
                        </select>
                        
                        <select className="input" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ width: 160, background: "var(--bg-card)" }}>
                            <option value="all">Any Status</option>
                            <option value="active">Proxy Active</option>
                            <option value="inactive">Proxy Inactive</option>
                        </select>
                    </div>
                </div>

                <div style={{ padding: "12px 24px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>
                        Showing {filteredBots.length} instance{filteredBots.length !== 1 ? 's' : ''}
                    </span>
                    <div style={{ display: "flex", gap: 10 }}>
                        <button onClick={() => handleBulk(true)} disabled={bulking || loadingBots || filteredBots.length === 0} className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12, color: "var(--success)" }}>Turn All On</button>
                        <button onClick={() => handleBulk(false)} disabled={bulking || loadingBots || filteredBots.length === 0} className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12, color: "var(--danger)" }}>Turn All Off</button>
                    </div>
                </div>

                <div style={{ padding: 12 }}>
                    {loadingBots ? (
                        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading instances...</div>
                    ) : filteredBots.length === 0 ? (
                        <div style={{ padding: 60, textAlign: "center" }}>
                            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.5 }}>🔍</div>
                            <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-muted)", margin: "0 0 8px 0" }}>No instances found</h3>
                            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>Try adjusting your filters or search query.</p>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {filteredBots.map(bot => {
                                const isToggling = togglingId === bot._id;
                                const group = groups.find(g => g._id === bot.groupId);
                                
                                return (
                                    <div key={bot._id} className="card-hover" style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-input)", transition: "all 0.2s" }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                                                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{bot.name}</span>
                                                <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", background: "var(--bg-surface)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-light)" }}>{bot.pm2Name}</span>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
                                                {group ? (
                                                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
                                                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: group.color || "var(--text-muted)" }}/>
                                                        {group.name}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Ungrouped</span>
                                                )}
                                                <span style={{ color: "var(--border)" }}>•</span>
                                                <span style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                                    {bot.buyerID || "Unknown Buyer"}
                                                </span>
                                            </div>
                                        </div>
                                        
                                        <div style={{ display: "flex", alignItems: "center", gap: 16, paddingLeft: 16, borderLeft: "1px solid var(--border-light)" }}>
                                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, minWidth: 70 }}>
                                                <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>Proxy Route</span>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: bot.proxyEnabled ? "var(--success)" : "var(--text-muted)" }}>
                                                    {bot.proxyEnabled ? "ROUTED" : "DIRECT"}
                                                </span>
                                            </div>
                                            
                                            <div style={{ width: 50, display: "flex", justifyContent: "center" }}>
                                                {isToggling ? (
                                                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
                                                ) : (
                                                    <Toggle enabled={bot.proxyEnabled} onChange={v => handleToggleBot(bot, v)} />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
