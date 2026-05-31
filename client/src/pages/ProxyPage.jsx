import { useState, useEffect, useCallback, useMemo } from "react";
import api from "../api/client";

function Toggle({ enabled, onChange, disabled }) {
    return (
        <button
            onClick={() => !disabled && onChange(!enabled)}
            disabled={disabled}
            style={{
                position: "relative", width: 44, height: 24, borderRadius: 12, border: "none", cursor: disabled ? "not-allowed" : "pointer",
                background: enabled ? "var(--success)" : "var(--bg-input)", opacity: disabled ? 0.5 : 1, transition: "background 0.2s",
            }}
        >
            <span style={{
                position: "absolute", top: 2, left: 2, width: 20, height: 20, borderRadius: "50%", background: "#fff",
                transform: enabled ? "translateX(20px)" : "translateX(0)", transition: "transform 0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
            }} />
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

const IconSave = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
    </svg>
);
const IconChevron = ({ open }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        style={{ width: 14, height: 14, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.25s" }}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
);
const IconSearch = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 40, height: 40, color: "var(--text-dim)" }}>
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);
const IconSettings = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18, color: "var(--text-muted)" }}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
);
const IconCheck = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 12, height: 12 }}>
        <polyline points="20 6 9 17 4 12" />
    </svg>
);
const IconWarn = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);

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

    // Config panel collapsed by default
    const [configOpen, setConfigOpen] = useState(false);

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
        setSavingConfig(true); setMsg(null);
        try {
            const payload = { ...config, port: Number(config.port), username: config.username || null, password: config.password || null };
            const { data } = await api.put("/proxy/config", payload);
            setConfig(c => ({ ...c, ...data }));
            setMsg({ type: "success", text: "Configuration saved." });
            setTimeout(() => setMsg(null), 3000);
        } catch {
            setMsg({ type: "error", text: "Failed to save configuration." });
            setTimeout(() => setMsg(null), 3000);
        } finally { setSavingConfig(false); }
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

    const groupMap = useMemo(() => Object.fromEntries(groups.map(g => [g._id, g])), [groups]);
    const botsByGroup = useMemo(() => groups.map(g => ({ group: g, bots: filteredBots.filter(b => b.groupId === g._id) })).filter(s => s.bots.length > 0), [groups, filteredBots]);
    const ungrouped = useMemo(() => filteredBots.filter(b => !b.groupId || !groupMap[b.groupId]), [filteredBots, groupMap]);

    const handleBulk = async (proxyEnabled) => {
        setBulking(true);
        const ids = filteredBots.map(b => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots(prev => prev.map(b => (ids.includes(b._id) ? { ...b, proxyEnabled } : b)));
        } catch { alert("Bulk operation failed"); } finally { setBulking(false); }
    };

    const enabledCount = bots.filter(b => b.proxyEnabled).length;
    const isConfigured = !!(config.host && config.port);

    const ProxyGroupCard = ({ group, groupBots }) => {
        const proxiedCount = groupBots.filter(b => b.proxyEnabled).length;
        const color = group?.color;
        return (
            <div className="card card-hover" style={{
                padding: 20, marginBottom: 12,
                border: `1px solid ${color ? color + '40' : 'var(--border)'}`,
                background: color
                    ? `linear-gradient(135deg, var(--bg-card) 0%, ${color}05 100%)`
                    : 'var(--bg-card)',
            }}>
                {/* Group header */}
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
                    <span style={{ width: 14, height: 14, borderRadius: "50%", background: color || '#64748b', flexShrink: 0, boxShadow: color ? `0 0 10px ${color}80` : 'none' }} />
                    <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {group?.name ?? 'Ungrouped'}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)", whiteSpace: "nowrap" }}>
                        {proxiedCount} proxied
                    </span>
                    <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap", width: 56, textAlign: "right" }}>
                        {groupBots.length} bot{groupBots.length !== 1 ? 's' : ''}
                    </span>
                    {/* Bulk enable/disable for this group */}
                    <button onClick={() => handleBulkGroup(groupBots, true)} disabled={bulking} className="btn-ghost"
                        style={{ padding: "4px 10px", fontSize: 11, color: "var(--success)", border: "1px solid var(--success-border)", whiteSpace: "nowrap" }}>
                        Enable all
                    </button>
                    <button onClick={() => handleBulkGroup(groupBots, false)} disabled={bulking} className="btn-ghost"
                        style={{ padding: "4px 10px", fontSize: 11, color: "var(--danger)", border: "1px solid var(--danger-border)", whiteSpace: "nowrap" }}>
                        Disable all
                    </button>
                </div>

                {/* Bot items grid */}
                {groupBots.length === 0 ? (
                    <p style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", margin: 0 }}>No instances match current filters.</p>
                ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 8 }}>
                        {groupBots.map(bot => {
                            const isToggling = togglingId === bot._id;
                            const isActive = bot.proxyEnabled;
                            return (
                                <div
                                    key={bot._id}
                                    onClick={() => !isToggling && handleToggleBot(bot, !bot.proxyEnabled)}
                                    style={{
                                        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                                        borderRadius: 8, cursor: isToggling ? "wait" : "pointer",
                                        background: isActive ? "rgba(16,185,129,0.08)" : "var(--bg-input)",
                                        border: `1px solid ${isActive ? "rgba(16,185,129,0.35)" : "var(--border)"}`,
                                        transition: "all 0.15s",
                                    }}
                                >
                                    <span style={{
                                        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                                        background: isActive ? "#10b981" : "var(--text-dim)",
                                        boxShadow: isActive ? "0 0 6px rgba(16,185,129,0.7)" : "none",
                                    }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bot.name}</div>
                                        <div className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{bot.buyerID}</div>
                                    </div>
                                    <span style={{
                                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
                                        background: isActive ? "var(--success-bg)" : "var(--bg-surface)",
                                        border: `1px solid ${isActive ? "var(--success-border)" : "var(--border)"}`,
                                        color: isActive ? "var(--success)" : "var(--text-dim)",
                                        whiteSpace: "nowrap", flexShrink: 0,
                                    }}>{ isActive ? "ON" : "OFF" }</span>
                                    <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
                                        {isToggling
                                            ? <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
                                            : <Toggle enabled={bot.proxyEnabled} onChange={v => handleToggleBot(bot, v)} />
                                        }
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const handleBulkGroup = async (groupBots, proxyEnabled) => {
        setBulking(true);
        const ids = groupBots.map(b => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots(prev => prev.map(b => ids.includes(b._id) ? { ...b, proxyEnabled } : b));
        } catch { alert("Bulk operation failed"); } finally { setBulking(false); }
    };

    return (
        <div className="fade-in page-compact" style={{ maxWidth: 1000, display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Page Header */}
            <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Proxy Manager</h1>
                <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "6px 0 0 0" }}>Manage proxychains4 settings globally and per instance.</p>
            </div>

            {/* Combined Status + Stats Bar */}
            <div className="card slide-up" style={{ display: "flex", alignItems: "center", gap: 24, padding: "16px 24px", flexWrap: "wrap" }}>
                {/* Global status */}
                <div style={{ flex: 1, minWidth: 120 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 5px" }}>Global Proxy</p>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="status-dot" style={{ background: config.enabled ? "var(--success)" : "var(--text-dim)", width: 8, height: 8 }} />
                        <span style={{ fontWeight: 700, color: config.enabled ? "var(--success)" : "var(--text-muted)", fontSize: 15 }}>
                            {config.enabled ? "Active" : "Inactive"}
                        </span>
                    </div>
                </div>

                {/* Divider */}
                <div style={{ width: 1, height: 36, background: "var(--border)" }} />

                {/* Proxied count */}
                <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Proxied</p>
                    <p style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", margin: 0 }}>
                        {enabledCount}<span style={{ fontSize: 13, color: "var(--text-dim)", fontWeight: 500 }}> / {bots.length}</span>
                    </p>
                </div>

                {/* Divider */}
                <div style={{ width: 1, height: 36, background: "var(--border)" }} />

                {/* Protocol */}
                <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Protocol</p>
                    <p style={{ fontSize: 15, fontWeight: 700, color: "var(--accent)", margin: 0 }}>{config.type?.toUpperCase() || "—"}</p>
                </div>

                {/* Divider */}
                <div style={{ width: 1, height: 36, background: "var(--border)" }} />

                {/* Host */}
                <div style={{ textAlign: "center", minWidth: 120 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Upstream</p>
                    <p className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
                        {config.host ? `${config.host}:${config.port}` : <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Not set</span>}
                    </p>
                </div>

                {/* Toggle */}
                <div style={{ marginLeft: "auto" }}>
                    <Toggle enabled={config.enabled} onChange={handleToggleGlobal} />
                </div>
            </div>

            {/* Config Form – Collapsible */}
            <div className="card slide-up" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent-dim)" }}>
                {/* Collapsible Header */}
                <div
                    style={{ padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: configOpen ? "var(--bg-input)" : "transparent", borderBottom: configOpen ? "1px solid var(--border-light)" : "none", transition: "all 0.2s" }}
                    onClick={() => setConfigOpen(!configOpen)}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg-surface)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <IconSettings />
                        </div>
                        <div>
                            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--text)" }}>Connection Settings</h2>
                            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "2px 0 0 0" }}>Update the upstream proxychain configuration.</p>
                        </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {/* Status badge */}
                        {isConfigured ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)" }}>
                                <IconCheck /> Configured
                            </span>
                        ) : (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning)" }}>
                                <IconWarn /> Setup Required
                            </span>
                        )}
                        <IconChevron open={configOpen} />
                    </div>
                </div>

                {configOpen && (
                    <div style={{ padding: 24 }}>
                        {loadingConfig ? (
                            <div style={{ textAlign: "center", padding: 20 }}>
                                <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite", margin: "0 auto" }} />
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                                <div>
                                    <label className="label">Protocol Type</label>
                                    <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                        {["socks5", "socks4", "http"].map(t => (
                                            <button key={t} onClick={() => setConfig(c => ({ ...c, type: t }))} className={config.type === t ? "btn-primary" : "btn-ghost"} style={{ padding: "8px 20px", fontSize: 13 }}>
                                                {t.toUpperCase()}
                                            </button>
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
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginTop: 4, paddingTop: 18, borderTop: "1px solid var(--border-light)" }}>
                                    <p style={{ fontSize: 12, color: "var(--warning)", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                                            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                                        </svg>
                                        proxychains4 must be installed on the host machine.
                                    </p>
                                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                                        {msg && (
                                            <span className="fade-in" style={{ fontSize: 12, fontWeight: 600, color: msg.type === "success" ? "var(--success)" : "var(--danger)", display: "flex", alignItems: "center", gap: 5 }}>
                                                {msg.type === "success"
                                                    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 13, height: 13 }}><polyline points="20 6 9 17 4 12" /></svg>
                                                    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 13, height: 13 }}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                                }
                                                {msg.text}
                                            </span>
                                        )}
                                        <button onClick={handleSaveConfig} disabled={savingConfig} className="btn-primary" style={{ padding: "10px 22px", display: "flex", alignItems: "center", gap: 8 }}>
                                            {savingConfig
                                                ? <><div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} /> Saving…</>
                                                : <><IconSave /> Save Configuration</>
                                            }
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Instance Assignments - GroupCard style */}
            <div>
                {/* Section header + filters */}
                <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>Instance Assignments</h2>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Click a hosting to toggle proxy routing.</p>
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <input className="input" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 180 }} />
                        <select className="input" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ width: 140 }}>
                            <option value="all">Any Status</option>
                            <option value="active">Proxy Active</option>
                            <option value="inactive">Proxy Inactive</option>
                        </select>
                    </div>
                </div>

                {loadingBots ? (
                    <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
                        <div style={{ width: 40, height: 40, borderRadius: "50%", border: "4px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
                    </div>
                ) : filteredBots.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "64px 20px", border: "1px dashed var(--border)", borderRadius: 16 }}>
                        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><IconSearch /></div>
                        <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-muted)", margin: "0 0 6px" }}>No instances found</h3>
                        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>Try adjusting your filters.</p>
                    </div>
                ) : (
                    <div>
                        {botsByGroup.map(({ group, bots: gb }) => (
                            <ProxyGroupCard key={group._id} group={group} groupBots={gb} />
                        ))}
                        {ungrouped.length > 0 && (
                            <ProxyGroupCard group={{ name: 'Ungrouped', color: '#64748b' }} groupBots={ungrouped} />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
