import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useData } from "../context/DataContext";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import NodeFilter, { matchNode } from "../components/NodeFilter";
import { EmptyState, Icon, PageHeader, SearchInput, StatCard } from "../components/ui";
import GroupsPanel from "./bots/GroupsPanel";
import TagsPanel from "./bots/TagsPanel";
import BulkBar from "./bots/BulkBar";

// The Bots page also holds what used to be three pages of their own:
// /groups and /tags are its Groups and Tags tabs (?view=groups, ?view=tags),
// and /multi-manage is its select mode (?select=1).
const VIEWS = ["bots", "groups", "tags"];
const DESCRIPTION = {
    bots: "Discord bots and services on every server, sorted by group.",
    groups: "Groups sort the Bots and Sites lists into sections.",
    tags: "Labels to put on bots and filter the list by.",
};
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 };

/* ─── Group Section ───────────────────────────────────────────────── */
function GroupSection({ label, color, bots, onRefresh, selecting, selected, onToggle, onToggleMany }) {
    const [open, setOpen] = useState(true);
    const ids = bots.map(b => b._id);
    const allSelected = ids.length > 0 && ids.every(id => selected.has(id));

    return (
        <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 0 10px" }}>
                <button
                    onClick={() => setOpen(v => !v)}
                    aria-expanded={open}
                    style={{
                        display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0,
                        background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--text)",
                    }}
                >
                    <Icon name={open ? "chevronDown" : "chevronRight"} size={14} style={{ color: "var(--text-dim)" }} />
                    <span className="chip-dot" style={{ width: 8, height: 8, background: color || "var(--text-dim)" }} />
                    <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{bots.length}</span>
                    <span style={{ flex: 1, height: 1, background: "var(--border)", marginLeft: 6 }} />
                </button>
                {selecting && (
                    <button className="btn-ghost btn-sm" onClick={() => onToggleMany(ids, !allSelected)}>
                        {allSelected ? "Deselect group" : "Select group"}
                    </button>
                )}
            </div>

            {open && (
                <div className="slide-up" style={GRID}>
                    {bots.map(bot => (
                        <BotCard
                            key={bot._id}
                            bot={bot}
                            onRefresh={onRefresh}
                            selectable={selecting}
                            selected={selected.has(bot._id)}
                            onToggleSelect={() => onToggle(bot._id)}
                        />
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
            <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="skeleton" style={{ height: 14, borderRadius: 4 }} />
                        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "60%" }} />
                    </div>
                    <div className="skeleton" style={{ width: 54, height: 14, borderRadius: 4, flexShrink: 0 }} />
                </div>
                <div className="skeleton" style={{ height: 3, borderRadius: 2 }} />
                <div className="skeleton" style={{ height: 3, borderRadius: 2 }} />
            </div>
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 6 }}>
                <div className="skeleton" style={{ height: 28, width: 28, borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 28, width: 28, borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 28, flex: 1, borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 28, width: 28, borderRadius: 6 }} />
            </div>
        </div>
    );
}

/* ─── Dashboard ───────────────────────────────────────────────────── */
export default function Dashboard() {
    const { bots: allBots, groups, tags, loading, refresh: fetchAll } = useData();
    const [searchParams, setSearchParams] = useSearchParams();
    const view = VIEWS.includes(searchParams.get("view")) ? searchParams.get("view") : "bots";
    const selecting = view === "bots" && searchParams.get("select") === "1";

    const [showCreate, setShowCreate] = useState(false);
    const [showNew, setShowNew]       = useState(false); // the Groups / Tags "New" form
    const [search, setSearch]         = useState("");
    const [filter, setFilter]         = useState("all");
    const [nodeFilter, setNodeFilter] = useState(searchParams.get("node") || "all");
    const [selectedTags, setSelectedTags] = useState([]);
    const [selected, setSelected]     = useState(() => new Set());

    // Only bots and services — websites live under /sites
    const bots = useMemo(() => allBots.filter(b => b.projectType !== "website"), [allBots]);

    const setParams = (patch) =>
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            for (const [k, v] of Object.entries(patch)) {
                if (v == null) next.delete(k);
                else next.set(k, v);
            }
            return next;
        }, { replace: true });

    const setView = (v) => {
        setShowNew(false);
        setParams({ view: v === "bots" ? null : v, select: null });
    };
    const setSelecting = (on) => {
        if (!on) setSelected(new Set());
        setParams({ select: on ? "1" : null });
    };

    /* ── Stat calculations ── */
    const online       = bots.filter(b => b.live?.status === "online").length;
    const errored      = bots.filter(b => b.live?.status === "errored").length;
    const expiringSoon = bots.filter(b => {
        if (!b.expiresAt) return false;
        return (new Date(b.expiresAt) - Date.now()) / 86_400_000 <= 3;
    }).length;

    /* ── Filter logic ── */
    const q = search.toLowerCase();
    const visible = useMemo(() => bots.filter(b => {
        const ms = b.name.toLowerCase().includes(q) ||
                   b.botID.toLowerCase().includes(q) ||
                   b.buyerID.toLowerCase().includes(q) ||
                   (b.tags || []).some(tid => tags.find(t => t._id === tid)?.name.toLowerCase().includes(q));
        const mf = filter === "all" ||
                   (filter === "online"  && b.live?.status === "online") ||
                   (filter === "stopped" && b.live?.status !== "online");
        const mt = selectedTags.length === 0 ||
                   selectedTags.some(tid => (b.tags || []).includes(tid));
        const mn = matchNode(b, nodeFilter);
        return ms && mf && mt && mn;
    }), [bots, tags, q, filter, selectedTags, nodeFilter]);

    // A bot that a filter hides, or that was deleted, leaves the selection too.
    useEffect(() => {
        const ids = new Set(visible.map(b => b._id));
        setSelected(prev => {
            const next = new Set([...prev].filter(id => ids.has(id)));
            return next.size !== prev.size ? next : prev;
        });
    }, [visible]);

    const toggleTag = (tagId) =>
        setSelectedTags(prev =>
            prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]
        );
    const toggleBot = (id) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
    const toggleMany = (ids, add) => setSelected(prev => {
        const next = new Set(prev);
        ids.forEach(id => (add ? next.add(id) : next.delete(id)));
        return next;
    });

    const groupMap    = Object.fromEntries(groups.map(g => [g._id, g]));
    const botsByGroup = groups
        .map(g => ({ group: g, bots: visible.filter(b => b.groupId === g._id) }))
        .filter(s => s.bots.length > 0);
    const ungrouped   = visible.filter(b => !b.groupId || !groupMap[b.groupId]);
    const isFiltering = search.trim() !== "" || filter !== "all" || selectedTags.length > 0 || nodeFilter !== "all";
    const sectionProps = { onRefresh: fetchAll, selecting, selected, onToggle: toggleBot, onToggleMany: toggleMany };

    const actions =
        view === "groups" ? (
            <button className="btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" /> New group</button>
        ) : view === "tags" ? (
            <button className="btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" /> New tag</button>
        ) : (
            <>
                {!selecting && (
                    <button className="btn-ghost" onClick={() => setSelecting(true)} disabled={!bots.length} title="Pick several bots and start, stop, update or remove them at once">
                        <Icon name="selectMode" /> Select
                    </button>
                )}
                <button className="btn-primary" onClick={() => setShowCreate(true)}>
                    <Icon name="plus" /> New bot
                </button>
            </>
        );

    return (
        <div className="fade-in page" style={{ maxWidth: 1600, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Bots"
                description={DESCRIPTION[view]}
                actions={actions}
            />

            <div className="tab-bar" style={{ alignSelf: "flex-start" }} role="tablist">
                {[
                    ["bots", "Bots", bots.length],
                    ["groups", "Groups", groups.length],
                    ["tags", "Tags", tags.length],
                ].map(([id, label, n]) => (
                    <button key={id} role="tab" aria-selected={view === id} className={`tab-item ${view === id ? "active" : ""}`} onClick={() => setView(id)}>
                        {label} <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>{n}</span>
                    </button>
                ))}
            </div>

            {view === "groups" && <GroupsPanel showNew={showNew} onNewClose={() => setShowNew(false)} />}
            {view === "tags" && <TagsPanel showNew={showNew} onNewClose={() => setShowNew(false)} />}

            {view === "bots" && (
                <>
                    {!selecting && (
                        <>
                            <div className="stat-grid">
                                <StatCard label="Total bots" value={bots.length} />
                                <StatCard label="Online" value={online} tone="success" />
                                <StatCard label="Errored" value={errored} tone="danger" />
                                <StatCard label="Expiring in 3 days" value={expiringSoon} tone="warning" />
                            </div>
                            <StatsWidget />
                        </>
                    )}

                    {/* ── Filter & search bar ── */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div className="toolbar">
                            <SearchInput value={search} onChange={setSearch} placeholder="Search by name, ID or tag…" style={{ flex: "1 1 250px", maxWidth: 400 }} />
                            <div className="tab-bar">
                                {[["all", "All"], ["online", "Online"], ["stopped", "Stopped"]].map(([f, label]) => (
                                    <button key={f} className={`tab-item ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <NodeFilter bots={bots} value={nodeFilter} onChange={setNodeFilter} />
                            <span className="toolbar-count">{visible.length} / {bots.length}</span>
                        </div>

                        {tags.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                                <span style={{ fontSize: 12, color: "var(--text-dim)", marginRight: 2 }}>Tags</span>
                                {tags.map(tag => (
                                    <button
                                        key={tag._id}
                                        onClick={() => toggleTag(tag._id)}
                                        className={`chip${selectedTags.includes(tag._id) ? " active" : ""}`}
                                        aria-pressed={selectedTags.includes(tag._id)}
                                    >
                                        <span className="chip-dot" style={{ background: tag.color }} />
                                        {tag.name}
                                    </button>
                                ))}
                                {selectedTags.length > 0 && (
                                    <button className="chip" onClick={() => setSelectedTags([])}>
                                        <Icon name="x" size={12} /> Clear
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {selecting && (
                        <BulkBar
                            selected={selected}
                            visibleIds={visible.map(b => b._id)}
                            onSelectAll={() => setSelected(new Set(visible.map(b => b._id)))}
                            onClear={() => setSelected(new Set())}
                            onExit={() => setSelecting(false)}
                            onRemoved={(ids) => setSelected(prev => new Set([...prev].filter(id => !ids.includes(id))))}
                            refresh={fetchAll}
                        />
                    )}

                    {/* ── Bot list ── */}
                    {loading && bots.length === 0 && (
                        <div style={GRID}>
                            {[1, 2, 3, 4].map(i => <SkeletonCard key={i} />)}
                        </div>
                    )}

                    {!loading && visible.length === 0 && (
                        <EmptyState
                            icon="bots"
                            title={bots.length === 0 ? "No bots yet" : "No bots match"}
                            description={bots.length === 0 ? "Deploy a Discord bot or service from Git, or import one already on disk." : "Try another search, status, node or tag."}
                            action={bots.length === 0 && (
                                <button className="btn-primary" onClick={() => setShowCreate(true)}>
                                    <Icon name="plus" /> New bot
                                </button>
                            )}
                        />
                    )}

                    {!loading && visible.length > 0 && isFiltering && (
                        <div className="slide-up" style={GRID}>
                            {visible.map(bot => (
                                <BotCard
                                    key={bot._id}
                                    bot={bot}
                                    onRefresh={fetchAll}
                                    selectable={selecting}
                                    selected={selected.has(bot._id)}
                                    onToggleSelect={() => toggleBot(bot._id)}
                                />
                            ))}
                        </div>
                    )}

                    {!loading && visible.length > 0 && !isFiltering && (
                        <div className="slide-up">
                            {botsByGroup.map(({ group, bots: gb }) => (
                                <GroupSection key={group._id} label={group.name} color={group.color} bots={gb} {...sectionProps} />
                            ))}
                            {ungrouped.length > 0 && (
                                <GroupSection label="Ungrouped" bots={ungrouped} {...sectionProps} />
                            )}
                        </div>
                    )}
                </>
            )}

            {/* ── Modals ── */}
            {showCreate && <CreateBotModal defaultProjectType="discord" onClose={() => setShowCreate(false)} onCreated={() => fetchAll()} />}
        </div>
    );
}
