import { useState, useEffect, useCallback } from "react";
import api from "../api/client";

function Toggle({ enabled, onChange, disabled }) {
    return (
        <button
            onClick={() => !disabled && onChange(!enabled)}
            disabled={disabled}
            style={{
                position: "relative", width: 44, height: 24, borderRadius: 12, border: "none", cursor: disabled ? "not-allowed" : "pointer",
                background: enabled ? "var(--accent)" : "var(--bg-input)", opacity: disabled ? 0.5 : 1, transition: "background 0.2s"
            }}
        >
            <span style={{
                position: "absolute", top: 2, left: 2, width: 20, height: 20, borderRadius: "50%", background: "#fff",
                transform: enabled ? "translateX(20px)" : "translateX(0)", transition: "transform 0.2s"
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

function BotRow({ bot, togglingId, onToggle }) {
    const isToggling = togglingId === bot._id;
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bot.name}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{bot.pm2Name}</span>
            </div>
            <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: bot.proxyEnabled ? "rgba(91,115,232,0.1)" : "var(--bg-input)", color: bot.proxyEnabled ? "var(--accent)" : "var(--text-muted)" }}>
                {bot.proxyEnabled ? "PROXY ON" : "PROXY OFF"}
            </span>
            {isToggling ? <span style={{ width: 44, textAlign: "center", fontSize: 12 }}>⏳</span> : <Toggle enabled={bot.proxyEnabled} onChange={v => onToggle(bot, v)} />}
        </div>
    );
}

function GroupSection({ group, bots, togglingId, bulkingGroup, onToggle, onGroupBulk, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    const enabledCount = bots.filter(b => b.proxyEnabled).length;
    const allEnabled = enabledCount === bots.length;
    const noneEnabled = enabledCount === 0;
    const isBulking = bulkingGroup === group._id;

    return (
        <div className="card" style={{ marginBottom: 12, padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", background: "var(--bg-input)", cursor: "pointer" }} onClick={() => setOpen(!open)}>
                <span style={{ fontSize: 12, color: "var(--text-dim)", marginRight: 8, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
                {group.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: group.color, marginRight: 8 }}/>}
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", flex: 1 }}>{group.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 12 }}>{enabledCount}/{bots.length} proxied</span>
                <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
                    {isBulking ? <span style={{ fontSize: 12 }}>⏳</span> : (
                        <>
                            <button onClick={() => onGroupBulk(group._id, bots, true)} disabled={allEnabled} className="btn-success" style={{ padding: "4px 8px", fontSize: 10 }}>All ON</button>
                            <button onClick={() => onGroupBulk(group._id, bots, false)} disabled={noneEnabled} className="btn-danger" style={{ padding: "4px 8px", fontSize: 10 }}>All OFF</button>
                        </>
                    )}
                </div>
            </div>
            {open && (
                <div style={{ padding: "0 16px" }}>
                    {bots.map(bot => <BotRow key={bot._id} bot={bot} togglingId={togglingId} onToggle={onToggle} />)}
                </div>
            )}
        </div>
    );
}

export default function ProxyPage() {
    const [config, setConfig] = useState({ enabled: false, type: "socks5", host: "", port: 1080, username: "", password: "" });
    const [bots, setBots] = useState([]);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [loadingBots, setLoadingBots] = useState(true);
    const [savingConfig, setSavingConfig] = useState(false);
    const [msg, setMsg] = useState(null);
    const [togglingId, setTogglingId] = useState(null);
    const [bulkingGroup, setBulkingGroup] = useState(null);
    const [search, setSearch] = useState("");
    const [viewMode, setViewMode] = useState("group"); // "group" | "buyer" | "flat"
    const [configOpen, setConfigOpen] = useState(true);

    const fetchConfig = useCallback(async () => {
        try {
            const { data } = await api.get("/proxy/config");
            setConfig({ enabled: data.enabled ?? false, type: data.type ?? "socks5", host: data.host ?? "", port: data.port ?? 1080, username: data.username ?? "", password: data.password ?? "" });
        } catch { /* ignore */ } finally { setLoadingConfig(false); }
    }, []);

    const fetchBots = useCallback(async () => {
        try { const { data } = await api.get("/proxy/bots"); setBots(data); } catch { /* ignore */ } finally { setLoadingBots(false); }
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

    const handleGroupBulk = async (groupKey, groupBots, proxyEnabled) => {
        setBulkingGroup(groupKey); const ids = groupBots.map(b => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots(prev => prev.map(b => (ids.includes(b._id) ? { ...b, proxyEnabled } : b)));
        } catch { alert("Bulk operation failed"); } finally { setBulkingGroup(null); }
    };

    const handleAllBulk = async (proxyEnabled) => {
        setBulkingGroup("__all__"); const ids = filteredBots.map(b => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots(prev => prev.map(b => (ids.includes(b._id) ? { ...b, proxyEnabled } : b)));
        } catch { alert("Bulk operation failed"); } finally { setBulkingGroup(null); }
    };

    const filteredBots = bots.filter(b => !search || b.name?.toLowerCase().includes(search.toLowerCase()) || b.buyerID?.toLowerCase().includes(search.toLowerCase()) || b.pm2Name?.toLowerCase().includes(search.toLowerCase()));
    const enabledCount = bots.filter(b => b.proxyEnabled).length;

    const buildGroups = () => {
        if (viewMode === "flat") return [{ key: "__flat__", label: null, bots: filteredBots }];
        if (viewMode === "buyer") {
            const map = {};
            filteredBots.forEach(b => { const k = b.buyerID || "Unknown"; if (!map[k]) map[k] = { key: k, label: k, color: null, bots: [] }; map[k].bots.push(b); });
            return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
        }
        const map = {};
        filteredBots.forEach(b => {
            const g = b.group;
            if (g) { if (!map[g._id]) map[g._id] = { key: g._id, label: g.name, color: g.color, bots: [] }; map[g._id].bots.push(b); }
            else { if (!map["__ungrouped__"]) map["__ungrouped__"] = { key: "__ungrouped__", label: "Ungrouped", color: "#475569", bots: [] }; map["__ungrouped__"].bots.push(b); }
        });
        const named = Object.values(map).filter(g => g.key !== "__ungrouped__").sort((a, b) => a.label.localeCompare(b.label));
        const ungrouped = map["__ungrouped__"] ? [map["__ungrouped__"]] : [];
        return [...named, ...ungrouped];
    };
    const groups = buildGroups();

    return (
        <div style={{ padding: "20px 24px", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyItems: "space-between", flexWrap: "wrap", gap: 16 }}>
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Proxy Manager</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0 0" }}>Manage proxychains4 per bot</p>
                </div>
                <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: config.enabled ? "var(--success)" : "var(--text-muted)" }}>{config.enabled ? "🟢 PROXY ACTIVE" : "⚫ PROXY INACTIVE"}</span>
                    <Toggle enabled={config.enabled} onChange={handleToggleGlobal} />
                </div>
            </div>

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
                <div className="card" style={{ padding: 16 }}><p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>Status</p><p style={{ fontSize: 16, fontWeight: 700, color: config.enabled ? "var(--success)" : "var(--text)", margin: 0 }}>{config.enabled ? "Active" : "Inactive"}</p></div>
                <div className="card" style={{ padding: 16 }}><p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>Proxied Bots</p><p style={{ fontSize: 16, fontWeight: 700, color: "var(--accent)", margin: 0 }}>{enabledCount} <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 400 }}>of {bots.length}</span></p></div>
                <div className="card" style={{ padding: 16 }}><p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", margin: "0 0 4px 0" }}>Proxy Type</p><p style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>{config.type?.toUpperCase() || "—"}</p></div>
            </div>

            {/* Config */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-input)", cursor: "pointer", borderBottom: configOpen ? "1px solid var(--border)" : "none" }} onClick={() => setConfigOpen(!configOpen)}>
                    <div>
                        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Proxy Configuration</h2>
                        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0 0" }}>{config.host ? `${config.type.toUpperCase()} · ${config.host}:${config.port}` : "Click to configure"}</p>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", transform: configOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
                </div>
                {configOpen && (
                    <div style={{ padding: 20 }}>
                        {loadingConfig ? <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading config...</p> : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                                <div style={{ display: "flex", gap: 8 }}>
                                    {["socks5", "socks4", "http"].map(t => (
                                        <button key={t} onClick={() => setConfig(c => ({ ...c, type: t }))} className={config.type === t ? "btn-primary" : "btn-ghost"} style={{ padding: "6px 12px", fontSize: 12 }}>{t}</button>
                                    ))}
                                </div>
                                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                                    <div style={{ flex: "2 1 200px" }}><InputField id="host" label="Host / IP" value={config.host} onChange={v => setConfig(c => ({ ...c, host: v }))} placeholder="127.0.0.1" /></div>
                                    <div style={{ flex: "1 1 100px" }}><InputField id="port" label="Port" type="number" value={config.port} onChange={v => setConfig(c => ({ ...c, port: v }))} placeholder="1080" /></div>
                                </div>
                                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                                    <div style={{ flex: 1 }}><InputField id="user" label="Username (Optional)" value={config.username} onChange={v => setConfig(c => ({ ...c, username: v }))} placeholder="Leave blank if none" /></div>
                                    <div style={{ flex: 1 }}><InputField id="pass" label="Password (Optional)" type="password" value={config.password} onChange={v => setConfig(c => ({ ...c, password: v }))} placeholder="Leave blank if none" /></div>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                                    <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0, flex: 1 }}>Requires proxychains4 installed on server.</p>
                                    {msg && (
                                        <span style={{ fontSize: 13, fontWeight: 500, color: msg.type === "success" ? "var(--success)" : "var(--danger)" }}>
                                            {msg.text}
                                        </span>
                                    )}
                                    <button onClick={handleSaveConfig} disabled={savingConfig} className="btn-success" style={{ padding: "8px 24px" }}>{savingConfig ? "Saving..." : "💾 Save"}</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Assignments */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, justifyContent: "space-between" }}>
                    <div>
                        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Bot Assignments</h2>
                        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0 0" }}>{enabledCount} of {bots.length} bots using proxy</p>
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <input className="input" placeholder="Search bots..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 160 }} />
                        <div style={{ display: "flex", background: "var(--bg-input)", borderRadius: 6, padding: 2 }}>
                            {[{ key: "group", l: "🗂 Group" }, { key: "buyer", l: "👤 Buyer" }, { key: "flat", l: "☰ All" }].map(m => (
                                <button key={m.key} onClick={() => setViewMode(m.key)} className={viewMode === m.key ? "btn-primary" : "btn-ghost"} style={{ padding: "4px 8px", fontSize: 11, border: "none" }}>{m.l}</button>
                            ))}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => handleAllBulk(true)} disabled={bulkingGroup === "__all__" || loadingBots} className="btn-success" style={{ padding: "4px 8px", fontSize: 11 }}>All ON</button>
                            <button onClick={() => handleAllBulk(false)} disabled={bulkingGroup === "__all__" || loadingBots} className="btn-danger" style={{ padding: "4px 8px", fontSize: 11 }}>All OFF</button>
                        </div>
                    </div>
                </div>

                <div style={{ padding: 20 }}>
                    {loadingBots ? <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading bots...</p> : filteredBots.length === 0 ? <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No bots match your search.</p> : (
                        viewMode === "flat" ? (
                            <div style={{ border: "1px solid var(--border)", borderRadius: 8 }}>
                                {filteredBots.map(bot => <BotRow key={bot._id} bot={bot} togglingId={togglingId} onToggle={handleToggleBot} />)}
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                {groups.map(g => (
                                    <GroupSection key={g.key} group={{ _id: g.key, name: g.label || "All Bots", color: g.color }} bots={g.bots} togglingId={togglingId} bulkingGroup={bulkingGroup} onToggle={handleToggleBot} onGroupBulk={handleGroupBulk} defaultOpen={groups.length <= 4} />
                                ))}
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}
