import { useState, useCallback } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";

function StatCard({ label, value, color }) {
    return (
        <div className="card" style={{ padding: 16 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</p>
            <p style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>{value}</p>
        </div>
    );
}

function GroupSection({ label, color, bots, onRefresh }) {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ marginBottom: 24 }}>
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    background: "none", border: "none", cursor: "pointer", padding: "4px 0",
                    marginBottom: open ? 12 : 4,
                }}
            >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: color || "#8892a4", flexShrink: 0 }}/>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                <span style={{
                    fontSize: 11, color: "var(--text-dim)", background: "var(--bg-input)",
                    border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px", fontWeight: 600,
                }}>{bots.length}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                    width: 12, height: 12, color: "var(--text-dim)", marginLeft: "auto",
                    transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s",
                }}>
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            {open && (
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: 12,
                    paddingLeft: 16,
                    borderLeft: `2px solid ${color ? `${color}44` : "var(--border)"}`,
                }}>
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

    const toggleTag = (tagId) => {
        setSelectedTags(prev => prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]);
    };

    const groupMap    = Object.fromEntries(groups.map(g => [g._id, g]));
    const botsByGroup = groups.map(g => ({ group: g, bots: visible.filter(b => b.groupId === g._id) })).filter(s => s.bots.length > 0);
    const ungrouped   = visible.filter(b => !b.groupId || !groupMap[b.groupId]);
    const isFiltering = search.trim() !== "" || filter !== "all" || selectedTags.length > 0;

    return (
        <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>

            {/* Page header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Dashboard</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                        {bots.length} bot instances
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button id="btn-create-bot" className="btn-primary" onClick={() => setShowCreate(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 13, height: 13 }}>
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        New Bot
                    </button>
                </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
                <StatCard label="Total Bots"  value={bots.length} color="var(--accent)" />
                <StatCard label="Online"      value={online}       color="var(--success)" />
                <StatCard label="Errored"     value={errored}      color="var(--danger)" />
                <StatCard label="Expiring"    value={expiringSoon} color="var(--warning)" />
            </div>

            {/* System stats */}
            <div style={{ marginBottom: 20 }}>
                <StatsWidget />
            </div>

            {/* Filter bar */}
            <div style={{
                display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
                marginBottom: 16, padding: "10px 14px",
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10,
            }}>
                {/* Search */}
                <div style={{ position: "relative", flex: "1 1 200px", maxWidth: 280 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                        width: 15, height: 15, position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                        color: "var(--text-dim)"
                    }}>
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        id="bot-search"
                        className="input"
                        style={{ paddingLeft: 32, fontSize: 13 }}
                        placeholder="Search bots…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>

                {/* Filter pills */}
                <div style={{ display: "flex", gap: 4 }}>
                    {["all", "online", "stopped"].map(f => (
                        <button
                            key={f}
                            id={`filter-${f}`}
                            onClick={() => setFilter(f)}
                            className={filter === f ? "btn-primary" : "btn-ghost"}
                            style={{ fontSize: 12, textTransform: "capitalize", padding: "5px 12px" }}
                        >
                            {f}
                        </button>
                    ))}
                </div>

                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
                    {visible.length} / {bots.length}
                </span>
            </div>

            {/* Tag filters */}
            {tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 16 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Tags:</span>
                    {selectedTags.length > 0 && (
                        <button
                            onClick={() => setSelectedTags([])}
                            style={{
                                fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99, cursor: "pointer",
                                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171"
                            }}
                        >
                            ✕ Clear
                        </button>
                    )}
                    {tags.map(tag => {
                        const isActive = selectedTags.includes(tag._id);
                        return (
                            <button
                                key={tag._id}
                                id={`tag-filter-${tag._id}`}
                                onClick={() => toggleTag(tag._id)}
                                style={{
                                    display: "inline-flex", alignItems: "center", gap: 4,
                                    padding: "3px 9px", borderRadius: 99, fontSize: 11, fontWeight: 500, cursor: "pointer",
                                    background: isActive ? `${tag.color}18` : "var(--bg-input)",
                                    border: `1px solid ${isActive ? tag.color + "40" : "var(--border)"}`,
                                    color: isActive ? tag.color : "var(--text-muted)",
                                }}
                            >
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: isActive ? tag.color : "var(--text-dim)" }}/>
                                {tag.name}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Bot list */}
            {loading && bots.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text-muted)", fontSize: 13 }}>
                    <div style={{
                        width: 28, height: 28, borderRadius: "50%",
                        border: "3px solid var(--border)", borderTopColor: "var(--accent)",
                        animation: "spin 0.8s linear infinite", margin: "0 auto 12px",
                    }}/>
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                    Loading bots…
                </div>
            ) : visible.length === 0 ? (
                <div style={{
                    textAlign: "center", padding: "60px 0", borderRadius: 10,
                    border: "1px dashed var(--border)", color: "var(--text-muted)", fontSize: 13,
                }}>
                    <p style={{ fontSize: 32, marginBottom: 12 }}>🤖</p>
                    <p>{bots.length === 0 ? "No bots yet. Create your first instance." : "No results match your filters."}</p>
                    {bots.length === 0 && (
                        <button className="btn-primary" style={{ marginTop: 16 }} onClick={() => setShowCreate(true)}>
                            Create Bot
                        </button>
                    )}
                </div>
            ) : isFiltering ? (
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                    gap: 12,
                }}>
                    {visible.map(bot => (
                        <BotCard key={bot._id} bot={bot} onRefresh={fetchAll} />
                    ))}
                </div>
            ) : (
                <div>
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
