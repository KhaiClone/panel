import { useState } from "react";
import { useData } from "../context/DataContext";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";

/* ─── Enhanced Stat Card ──────────────────────────────────────────── */
function StatCard({ label, value, icon, color, gradient }) {
    return (
        <div className="card" style={{
            padding: "20px 24px",
            position: "relative",
            overflow: "hidden",
            borderBottom: `2px solid ${color}`,
        }}>
            {/* Ambient glow blob */}
            <div style={{
                position: "absolute", top: -30, right: -20,
                width: 120, height: 120,
                background: gradient,
                opacity: 0.08,
                filter: "blur(30px)",
                borderRadius: "50%",
                pointerEvents: "none",
            }} />

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <p style={{
                    fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.08em", margin: 0,
                }}>
                    {label}
                </p>
                <div style={{
                    width: 34, height: 34, borderRadius: 10,
                    background: `${color}18`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color,
                }}>
                    {icon}
                </div>
            </div>
            <p style={{ fontSize: 36, fontWeight: 800, color: "#fff", margin: 0, lineHeight: 1 }}>
                {value}
            </p>
        </div>
    );
}

/* ─── Group Section ───────────────────────────────────────────────── */
function GroupSection({ label, color, bots, onRefresh }) {
    const [open, setOpen] = useState(true);

    return (
        <div style={{ marginBottom: 28 }}>
            {/* Section header button */}
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: "flex", alignItems: "center", gap: 10,
                    background: "none", border: "none", cursor: "pointer",
                    padding: "4px 0 12px", width: "100%",
                }}
            >
                <div style={{
                    width: 4, height: 20, borderRadius: 2,
                    background: color || "#8892a4",
                    flexShrink: 0,
                }} />
                <span style={{
                    fontSize: 13, fontWeight: 700, color: "var(--text)",
                    textTransform: "uppercase", letterSpacing: "0.06em",
                }}>
                    {label}
                </span>
                <span className="badge" style={{
                    background: "var(--bg-input)", color: "var(--text-muted)", fontSize: 11,
                }}>
                    {bots.length}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
                <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={{
                        width: 14, height: 14, color: "var(--text-dim)",
                        transform: open ? "rotate(0deg)" : "rotate(-90deg)",
                        transition: "transform 0.2s",
                        flexShrink: 0,
                    }}
                >
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>

            {open && (
                <div className="slide-up" style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
                    gap: 16,
                }}>
                    {bots.map(bot => (
                        <BotCard key={bot._id} bot={bot} onRefresh={onRefresh} />
                    ))}
                </div>
            )}
        </div>
    );
}

/* ─── Skeleton Card ───────────────────────────────────────────────── */
function SkeletonCard() {
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="skeleton" style={{ height: 3 }} />
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="skeleton" style={{ height: 14, borderRadius: 4 }} />
                        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "60%" }} />
                    </div>
                    <div className="skeleton" style={{ width: 58, height: 20, borderRadius: 99, flexShrink: 0 }} />
                </div>
                <div className="skeleton" style={{ height: 3, borderRadius: 2 }} />
                <div className="skeleton" style={{ height: 3, borderRadius: 2 }} />
                <div style={{ display: "flex", gap: 4 }}>
                    {[1, 2, 3].map(j => (
                        <div key={j} className="skeleton" style={{ height: 18, width: 50, borderRadius: 99 }} />
                    ))}
                </div>
            </div>
            <div style={{
                padding: "10px 18px",
                borderTop: "1px solid var(--border-light)",
                display: "flex",
                gap: 6,
            }}>
                <div className="skeleton" style={{ height: 28, width: 32, borderRadius: 8 }} />
                <div className="skeleton" style={{ height: 28, width: 32, borderRadius: 8 }} />
                <div className="skeleton" style={{ height: 28, flex: 1, borderRadius: 8 }} />
                <div className="skeleton" style={{ height: 28, width: 28, borderRadius: 8 }} />
            </div>
        </div>
    );
}

/* ─── Dashboard ───────────────────────────────────────────────────── */
export default function Dashboard() {
    const { bots: allBots, groups, tags, loading, refresh: fetchAll } = useData();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch]         = useState("");
    const [filter, setFilter]         = useState("all");
    const [selectedTags, setSelectedTags] = useState([]);

    // Only bots and services — websites live under /sites
    const bots = allBots.filter(b => b.projectType !== "website");

    /* ── Stat calculations ── */
    const online       = bots.filter(b => b.live?.status === "online").length;
    const errored      = bots.filter(b => b.live?.status === "errored").length;
    const expiringSoon = bots.filter(b => {
        if (!b.expiresAt) return false;
        return (new Date(b.expiresAt) - Date.now()) / 86_400_000 <= 3;
    }).length;

    /* ── Filter logic ── */
    const visible = bots.filter(b => {
        const ms = b.name.toLowerCase().includes(search.toLowerCase()) ||
                   b.botID.toLowerCase().includes(search.toLowerCase()) ||
                   b.buyerID.toLowerCase().includes(search.toLowerCase()) ||
                   (b.tags || []).some(tid => tags.find(t => t._id === tid)?.name.toLowerCase().includes(search.toLowerCase()));
        const mf = filter === "all" ||
                   (filter === "online"  && b.live?.status === "online") ||
                   (filter === "stopped" && b.live?.status !== "online");
        const mt = selectedTags.length === 0 ||
                   selectedTags.some(tid => (b.tags || []).includes(tid));
        return ms && mf && mt;
    });

    const toggleTag = (tagId) =>
        setSelectedTags(prev =>
            prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]
        );

    const groupMap    = Object.fromEntries(groups.map(g => [g._id, g]));
    const botsByGroup = groups
        .map(g => ({ group: g, bots: visible.filter(b => b.groupId === g._id) }))
        .filter(s => s.bots.length > 0);
    const ungrouped   = visible.filter(b => !b.groupId || !groupMap[b.groupId]);
    const isFiltering = search.trim() !== "" || filter !== "all" || selectedTags.length > 0;

    return (
        <div className="fade-in page" style={{ maxWidth: 1600 }}>

            {/* ── Page header ── */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 32 }}>
                <div className="min-w-0" style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>
                        Bots
                    </h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 4 }}>
                        Manage and monitor your Discord bots & services
                    </p>
                </div>
                <div className="mobile-wrap" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <button className="btn-ghost btn-full-mobile" onClick={() => setShowGroups(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}>
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                        Manage Groups
                    </button>
                    <button className="btn-primary btn-full-mobile" onClick={() => setShowCreate(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16 }}>
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5"  y1="12" x2="19" y2="12"/>
                        </svg>
                        New Bot
                    </button>
                </div>
            </div>

            {/* ── Stat cards ── */}
            <div className="grid-2-mobile gap-sm-mobile" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 28 }}>
                <StatCard
                    label="Total Bots"
                    value={bots.length}
                    color="var(--accent)"
                    gradient="var(--accent)"
                    icon={
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                            <rect x="2" y="3" width="20" height="14" rx="2"/>
                            <line x1="8" y1="21" x2="16" y2="21"/>
                            <line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                    }
                />
                <StatCard
                    label="Online"
                    value={online}
                    color="var(--success)"
                    gradient="var(--success)"
                    icon={
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                    }
                />
                <StatCard
                    label="Errored"
                    value={errored}
                    color="var(--danger)"
                    gradient="var(--danger)"
                    icon={
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                    }
                />
                <StatCard
                    label="Expiring Soon"
                    value={expiringSoon}
                    color="var(--warning)"
                    gradient="var(--warning)"
                    icon={
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                    }
                />
            </div>

            {/* ── Stats widget ── */}
            <div style={{ marginBottom: 28 }}>
                <StatsWidget />
            </div>

            {/* ── Filter & search bar ── */}
            <div className="card" style={{
                marginBottom: 20,
                padding: "12px 16px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 16,
            }}>
                {/* Search */}
                <div style={{ position: "relative", flex: "1 1 250px", maxWidth: 400 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                        width: 16, height: 16, position: "absolute", left: 12, top: "50%",
                        transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none",
                    }}>
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        className="input"
                        style={{ paddingLeft: 38 }}
                        placeholder="Search by name, ID, or tag…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>

                {/* Status tabs */}
                <div className="tab-bar">
                    {["all", "online", "stopped"].map(f => (
                        <button
                            key={f}
                            className={`tab-item ${filter === f ? "active" : ""}`}
                            onClick={() => setFilter(f)}
                            style={{ textTransform: "capitalize" }}
                        >
                            {f}
                        </button>
                    ))}
                </div>

                {/* Count */}
                <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-dim)", fontWeight: 500 }}>
                    {visible.length} / {bots.length}
                </span>
            </div>

            {/* ── Tag filter pills ── */}
            {tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 24 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Tags:
                    </span>
                    {selectedTags.length > 0 && (
                        <button
                            className="badge"
                            onClick={() => setSelectedTags([])}
                            style={{
                                background: "var(--danger-bg)",
                                border: "1px solid var(--danger-border)",
                                color: "var(--danger)",
                                cursor: "pointer",
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
                                onClick={() => toggleTag(tag._id)}
                                className="badge"
                                style={{
                                    cursor: "pointer",
                                    background: isActive ? `${tag.color}25` : "var(--bg-input)",
                                    border: `1px solid ${isActive ? tag.color + "50" : "var(--border)"}`,
                                    color: isActive ? tag.color : "var(--text-muted)",
                                    transition: "all 0.2s",
                                }}
                            >
                                <span style={{
                                    width: 6, height: 6, borderRadius: "50%",
                                    background: isActive ? tag.color : "var(--text-dim)",
                                    transition: "all 0.2s",
                                }} />
                                {tag.name}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* ── Bot list ── */}

            {/* Loading skeleton grid */}
            {loading && bots.length === 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 16 }}>
                    {[1, 2, 3, 4].map(i => <SkeletonCard key={i} />)}
                </div>
            )}

            {/* Empty state */}
            {!loading && visible.length === 0 && (
                <div className="card" style={{
                    textAlign: "center",
                    padding: "72px 24px",
                    borderStyle: "dashed",
                }}>
                    <div style={{
                        width: 72, height: 72, borderRadius: "50%",
                        background: "var(--bg-input)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        margin: "0 auto 20px",
                    }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 36, height: 36, color: "var(--text-dim)" }}>
                            <rect x="2" y="3" width="20" height="14" rx="2"/>
                            <line x1="8" y1="21" x2="16" y2="21"/>
                            <line x1="12" y1="17" x2="12" y2="21"/>
                        </svg>
                    </div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                        {bots.length === 0 ? "No bots yet" : "No matches found"}
                    </h3>
                    <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24, maxWidth: 360, margin: "0 auto 24px" }}>
                        {bots.length === 0
                            ? "Get started by creating your first Discord bot or service."
                            : "Try adjusting your search or filter settings."}
                    </p>
                    {bots.length === 0 && (
                        <button className="btn-primary" onClick={() => setShowCreate(true)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16 }}>
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Create First Bot
                        </button>
                    )}
                </div>
            )}

            {/* Filtered flat grid */}
            {!loading && visible.length > 0 && isFiltering && (
                <div className="slide-up" style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
                    gap: 16,
                }}>
                    {visible.map(bot => (
                        <BotCard key={bot._id} bot={bot} onRefresh={fetchAll} />
                    ))}
                </div>
            )}

            {/* Grouped grid */}
            {!loading && visible.length > 0 && !isFiltering && (
                <div className="slide-up">
                    {botsByGroup.map(({ group, bots: gb }) => (
                        <GroupSection
                            key={group._id}
                            label={group.name}
                            color={group.color}
                            bots={gb}
                            onRefresh={fetchAll}
                        />
                    ))}
                    {ungrouped.length > 0 && (
                        <GroupSection
                            label="Ungrouped"
                            color="#8892a4"
                            bots={ungrouped}
                            onRefresh={fetchAll}
                        />
                    )}
                </div>
            )}

            {/* ── Modals ── */}
            {showCreate && <CreateBotModal defaultProjectType="discord" onClose={() => setShowCreate(false)} onCreated={() => fetchAll()} />}
            {showGroups && <GroupManager onClose={() => setShowGroups(false)} onChanged={() => fetchAll()} />}
        </div>
    );
}
