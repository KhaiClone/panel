import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useData } from "../context/DataContext";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import NodeFilter, { matchNode } from "../components/NodeFilter";
import { EmptyState, Icon, PageHeader, SearchInput, StatCard, StatusBadge } from "../components/ui";

// ── Status, as on the Bots page ──────────────────────────────────────────────
const STATUS = {
    online:    { tone: "success", label: "Online" },
    stopped:   { tone: "neutral", label: "Stopped" },
    errored:   { tone: "danger",  label: "Errored" },
    launching: { tone: "warning", label: "Starting" },
};
const getStatus = (s) => STATUS[s] ?? { tone: "neutral", label: s ?? "Unknown" };

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 16 };
const CHIP = { background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)", flexShrink: 0 };

// ── SiteCard ─────────────────────────────────────────────────────────────────
function SiteCard({ site, onRefresh }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const s = getStatus(site.live?.status);
    const wc = site.websiteConfig || {};
    const isOnline = site.live?.status === "online";
    const isStopped = !isOnline;
    const accessUrl = wc.sslEnabled && wc.domain
        ? `https://${wc.domain}`
        : wc.domain
            ? `http://${wc.domain}`
            : `http://...:${wc.port}`;

    const action = async (endpoint) => {
        setBusy(true);
        try {
            await api.post(`/bots/${site._id}/${endpoint}`);
            onRefresh();
        } catch (err) {
            alert(err.response?.data?.error || `Failed: ${endpoint}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async () => {
        setConfirm(null);
        setBusy(true);
        try {
            await api.delete(`/bots/${site._id}`);
            onRefresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to delete");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div className="card card-hover" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", opacity: busy ? 0.7 : 1, transition: "opacity 0.2s" }}>
                <div style={{ padding: "14px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Header row */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", flexShrink: 0 }}>
                            <Icon name="globe" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <h3 style={{ fontWeight: 500, fontSize: 14, color: "var(--text)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {site.name}
                                </h3>
                                <span className="badge" style={CHIP}>
                                    {wc.mode === "fullstack" ? "Full-stack" : "Static"}
                                </span>
                            </div>
                            <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {site.buyerID}
                            </p>
                        </div>
                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                    </div>

                    {/* Domain / SSL row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {wc.domain ? (
                            <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--bg-input)", padding: "3px 8px", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                                {accessUrl}
                            </span>
                        ) : (
                            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No domain — port {wc.port}</span>
                        )}
                        {wc.sslEnabled
                            ? <StatusBadge tone="success">SSL</StatusBadge>
                            : wc.domain && <StatusBadge tone="danger">No SSL</StatusBadge>
                        }
                    </div>
                </div>

                {/* Footer actions */}
                <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 4, alignItems: "center" }}>
                    {isStopped ? (
                        <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("start")} disabled={busy} title="Start">
                            <Icon name="play" size={14} />
                        </button>
                    ) : (
                        <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("stop")} disabled={busy} title="Stop">
                            <Icon name="stop" size={14} />
                        </button>
                    )}
                    <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("restart")} disabled={busy} title="Restart">
                        <Icon name="restart" size={14} />
                    </button>
                    <button className="btn-ghost btn-sm" style={{ flex: 1, marginLeft: 4 }} onClick={() => navigate(`/sites/${site._id}`)} disabled={busy}>
                        Manage
                    </button>
                    <button className="btn-ghost btn-icon btn-sm is-danger" style={{ border: "none" }} onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete">
                        <Icon name="trash" size={14} />
                    </button>
                </div>
            </div>

            {confirm?.action === "delete" && (
                <ConfirmModal
                    title={`Delete "${site.name}"?`}
                    message={
                        site.source === "local"
                            ? "This will remove the nginx config and remove the site from the panel.\n\nYour project folder stays safe on disk."
                            : "This will remove the nginx config, delete the project folder, and remove the site from the panel.\n\nThis action is irreversible."
                    }
                    confirmText={site.source === "local" ? "Remove from Panel" : "Delete permanently"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}

function SkeletonCard() {
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 12 }}>
                    <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="skeleton" style={{ height: 14, borderRadius: 4 }} />
                        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "60%" }} />
                    </div>
                </div>
                <div className="skeleton" style={{ height: 24, borderRadius: 6 }} />
            </div>
        </div>
    );
}

// ── SitesPage ─────────────────────────────────────────────────────────────────
export default function SitesPage() {
    const { bots: allBots, loading, refresh: fetchAll } = useData();
    const [searchParams] = useSearchParams();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");
    const [nodeFilter, setNodeFilter] = useState(searchParams.get("node") || "all");

    // Only website projects
    const sites = allBots.filter(b => b.projectType === "website");

    const online  = sites.filter(s => s.live?.status === "online").length;
    const ssl     = sites.filter(s => s.websiteConfig?.sslEnabled).length;
    const domains = sites.filter(s => s.websiteConfig?.domain).length;

    const visible = sites.filter(s => {
        const ms = s.name.toLowerCase().includes(search.toLowerCase()) ||
                   s.botID.toLowerCase().includes(search.toLowerCase()) ||
                   s.buyerID.toLowerCase().includes(search.toLowerCase()) ||
                   (s.websiteConfig?.domain || "").toLowerCase().includes(search.toLowerCase());
        const mf = filter === "all" ||
                   (filter === "online"  && s.live?.status === "online") ||
                   (filter === "stopped" && s.live?.status !== "online");
        return ms && mf && matchNode(s, nodeFilter);
    });

    return (
        <div className="fade-in page" style={{ maxWidth: 1600, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Sites"
                description="Manage and monitor your hosted websites"
                actions={
                    <>
                        <button className="btn-ghost btn-full-mobile" onClick={() => setShowGroups(true)}>
                            <Icon name="users" /> Manage groups
                        </button>
                        <button className="btn-primary btn-full-mobile" onClick={() => setShowCreate(true)}>
                            <Icon name="plus" /> New site
                        </button>
                    </>
                }
            />

            {/* Stats */}
            <div className="stat-grid">
                <StatCard label="Total sites" value={sites.length} />
                <StatCard label="Online" value={online} tone="success" />
                <StatCard label="SSL active" value={ssl} tone="success" />
                <StatCard label="With domain" value={domains} tone="info" />
            </div>

            {/* Filter bar */}
            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Search by name, ID or domain…" style={{ flex: "1 1 250px", maxWidth: 400 }} />
                <div className="tab-bar">
                    {[["all", "All"], ["online", "Online"], ["stopped", "Stopped"]].map(([f, label]) => (
                        <button key={f} className={`tab-item ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                            {label}
                        </button>
                    ))}
                </div>
                <NodeFilter bots={sites} value={nodeFilter} onChange={setNodeFilter} />
                <span className="toolbar-count">{visible.length} / {sites.length}</span>
            </div>

            {/* Grid */}
            {loading && sites.length === 0 && (
                <div style={GRID}>
                    {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
                </div>
            )}

            {!loading && visible.length === 0 && (
                <EmptyState
                    icon="sites"
                    title={sites.length === 0 ? "No sites yet" : "No matches found"}
                    description={sites.length === 0
                        ? "Deploy your first static site or full-stack website."
                        : "Try adjusting your search or filter."}
                    action={sites.length === 0 && (
                        <button className="btn-primary" onClick={() => setShowCreate(true)}>
                            <Icon name="plus" /> Deploy first site
                        </button>
                    )}
                />
            )}

            {!loading && visible.length > 0 && (
                <div className="slide-up" style={GRID}>
                    {visible.map(site => (
                        <SiteCard key={site._id} site={site} onRefresh={fetchAll} />
                    ))}
                </div>
            )}

            {showCreate && <CreateBotModal defaultProjectType="website" onClose={() => setShowCreate(false)} onCreated={() => fetchAll()} />}
            {showGroups && <GroupManager onClose={() => setShowGroups(false)} onChanged={() => fetchAll()} />}
        </div>
    );
}
