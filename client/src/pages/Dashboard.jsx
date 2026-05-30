import { useState } from "react";
import { useData } from "../context/DataContext";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";

function StatCard({ label, value, icon, color, gradient }) {
    return (
        <div className="card" style={{ padding: 20, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -20, right: -20, width: 100, height: 100, background: gradient, opacity: 0.1, filter: "blur(20px)", borderRadius: "50%" }} />
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</p>
                <div style={{ padding: 8, borderRadius: 10, background: `${color}15`, color: color }}>
                    {icon}
                </div>
            </div>
            <p style={{ fontSize: 32, fontWeight: 700, color: "#fff", lineHeight: 1 }}>{value}</p>
        </div>
    );
}

function GroupSection({ label, color, bots, onRefresh }) {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ marginBottom: 24 }} className="slide-up">
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: "flex", alignItems: "center", gap: 12, width: "100%",
                    background: "none", border: "none", cursor: "pointer", padding: "8px 0",
                    marginBottom: open ? 12 : 4,
                }}
            >
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: color || "#8892a4", flexShrink: 0, boxShadow: `0 0 10px ${color}60` }}/>
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                <span className="badge" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>{bots.length}</span>
                
                <div style={{ flex: 1, height: 1, background: "var(--border-light)", marginLeft: 8 }} />

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                    width: 16, height: 16, color: "var(--text-dim)",
                    transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s",
                }}>
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            {open && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {bots.map(bot => (
                        <BotCard key={bot._id} bot={bot} onRefresh={onRefresh} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function Dashboard() {
    const { bots, groups, tags, loading, refresh: fetchAll } = useData();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");
    const [selectedTags, setSelectedTags] = useState([]);

    const online       = bots.filter(b => b.live?.status === "online").length;
    const errored      = bots.filter(b => b.live?.status === "errored").length;
    const expiringSoon = bots.filter(b => {
        if (!b.expiresAt) return false;
        return (new Date(b.expiresAt) - Date.now()) / 86_400_000 <= 3;
    }).length;

    const visible = bots.filter(b => {
        const ms = b.name.toLowerCase().includes(search.toLowerCase()) ||
                   b.botID.toLowerCase().includes(search.toLowerCase()) ||
                   b.buyerID.toLowerCase().includes(search.toLowerCase()) ||
                   (b.tags || []).some(tid => tags.find(t => t._id === tid)?.name.toLowerCase().includes(search.toLowerCase()));
        const mf = filter === "all" ||
                   (filter === "online" && b.live?.status === "online") ||
                   (filter === "stopped" && b.live?.status !== "online");
        const mt = selectedTags.length === 0 ||
                   selectedTags.some(tid => (b.tags || []).includes(tid));
        return ms && mf && mt;
    });

    const toggleTag = (tagId) => setSelectedTags(prev => prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]);

    const groupMap    = Object.fromEntries(groups.map(g => [g._id, g]));
    const botsByGroup = groups.map(g => ({ group: g, bots: visible.filter(b => b.groupId === g._id) })).filter(s => s.bots.length > 0);
    const ungrouped   = visible.filter(b => !b.groupId || !groupMap[b.groupId]);
    const isFiltering = search.trim() !== "" || filter !== "all" || selectedTags.length > 0;

    return (
        <div style={{ padding: "32px", maxWidth: 1600, margin: "0 auto" }}>

            {/* Page header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 32 }}>
                <div>
                    <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Overview</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 4 }}>Manage and monitor your hosting instances</p>
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                    <button className="btn-ghost" onClick={() => setShowGroups(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        Manage Groups
                    </button>
                    <button className="btn-primary" onClick={() => setShowCreate(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16 }}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        New Instance
                    </button>
                </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20, marginBottom: 32 }}>
                <StatCard label="Total Instances" value={bots.length} color="var(--accent)" gradient="var(--accent)" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>} />
                <StatCard label="Online" value={online} color="var(--success)" gradient="var(--success)" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>} />
                <StatCard label="Errored" value={errored} color="var(--danger)" gradient="var(--danger)" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>} />
                <StatCard label="Expiring Soon" value={expiringSoon} color="var(--warning)" gradient="var(--warning)" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
            </div>

            <div style={{ marginBottom: 32 }}>
                <StatsWidget />
            </div>

            {/* Filter & Search Bar */}
            <div className="card" style={{ marginBottom: 24, padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
                <div style={{ position: "relative", flex: "1 1 250px", maxWidth: 400 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                        width: 16, height: 16, position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)"
                    }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input className="input" style={{ paddingLeft: 38 }} placeholder="Search instances by name, ID, or tag..." value={search} onChange={e => setSearch(e.target.value)} />
                </div>

                <div className="tab-bar">
                    {["all", "online", "stopped"].map(f => (
                        <button key={f} className={`tab-item ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)} style={{ textTransform: "capitalize" }}>
                            {f}
                        </button>
                    ))}
                </div>

                <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-dim)", fontWeight: 500 }}>
                    Showing {visible.length} of {bots.length}
                </span>
            </div>

            {/* Tag filters */}
            {tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 24 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Tags:</span>
                    {selectedTags.length > 0 && (
                        <button className="badge" onClick={() => setSelectedTags([])} style={{ background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", cursor: "pointer" }}>
                            ✕ Clear
                        </button>
                    )}
                    {tags.map(tag => {
                        const isActive = selectedTags.includes(tag._id);
                        return (
                            <button
                                key={tag._id}
                                onClick={() => toggleTag(tag._id)}
                                className="badge"
                                style={{
                                    cursor: "pointer",
                                    background: isActive ? `${tag.color}25` : "var(--bg-input)",
                                    border: `1px solid ${isActive ? tag.color + "50" : "var(--border)"}`,
                                    color: isActive ? tag.color : "var(--text-muted)",
                                    transition: "all 0.2s"
                                }}
                            >
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: isActive ? tag.color : "var(--text-dim)", transition: "all 0.2s" }}/>
                                {tag.name}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Instance List */}
            {loading && bots.length === 0 ? (
                <div style={{ textAlign: "center", padding: "80px 0" }}>
                    <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid var(--border-light)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite", margin: "0 auto 16px" }}/>
                    <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading instances...</p>
                </div>
            ) : visible.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: "80px 0", borderStyle: "dashed" }}>
                    <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 32, height: 32, color: "var(--text-dim)" }}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    </div>
                    <h3 style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{bots.length === 0 ? "No instances found" : "No matches found"}</h3>
                    <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>{bots.length === 0 ? "Get started by creating your first hosting instance." : "Try adjusting your search or filters."}</p>
                    {bots.length === 0 && (
                        <button className="btn-primary" onClick={() => setShowCreate(true)}>Create First Instance</button>
                    )}
                </div>
            ) : isFiltering ? (
                <div className="slide-up" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {/* Header Row */}
                    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.2fr 1fr 1fr", padding: "0 20px 12px 20px", gap: 16 }}>
                        <span className="label">Instance</span>
                        <span className="label">Status</span>
                        <span className="label">Usage</span>
                        <span className="label">Tags</span>
                        <span className="label" style={{ textAlign: "right" }}>Actions</span>
                    </div>
                    {visible.map(bot => <BotCard key={bot._id} bot={bot} onRefresh={fetchAll} />)}
                </div>
            ) : (
                <div className="slide-up">
                    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.2fr 1fr 1fr", padding: "0 20px 12px 20px", gap: 16 }}>
                        <span className="label">Instance</span>
                        <span className="label">Status</span>
                        <span className="label">Usage</span>
                        <span className="label">Tags</span>
                        <span className="label" style={{ textAlign: "right" }}>Actions</span>
                    </div>
                    {botsByGroup.map(({ group, bots: gb }) => (
                        <GroupSection key={group._id} label={group.name} color={group.color} bots={gb} onRefresh={fetchAll} />
                    ))}
                    {ungrouped.length > 0 && (
                        <GroupSection label="Ungrouped" color="#8892a4" bots={ungrouped} onRefresh={fetchAll} />
                    )}
                </div>
            )}

            {showCreate && <CreateBotModal onClose={() => setShowCreate(false)} onCreated={() => fetchAll()} />}
            {showGroups && <GroupManager onClose={() => setShowGroups(false)} onChanged={() => fetchAll()} />}
        </div>
    );
}
