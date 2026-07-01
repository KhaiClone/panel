import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useData } from "../context/DataContext";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ── Status styles ─────────────────────────────────────────────────────────────
const STATUS_STYLES = {
    online:  { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    stopped: { color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)",  label: "Stopped" },
    errored: { color: "#F97316", bg: "rgba(249,115,22,0.15)", border: "rgba(249,115,22,0.3)",     label: "Errored" },
};
const getStyle = (s) => STATUS_STYLES[s] ?? {
    color: "var(--text-muted)", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", label: s ?? "Unknown",
};

// ── SiteCard ─────────────────────────────────────────────────────────────────
function SiteCard({ site, onRefresh }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const s = getStyle(site.live?.status);
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
                {/* Status strip */}
                <div style={{ height: 3, background: `linear-gradient(90deg, ${s.color}, transparent)`, flexShrink: 0 }} />

                <div style={{ padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* Header row */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ width: 38, height: 38, borderRadius: 10, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "#4ade80", flexShrink: 0 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="2" y1="12" x2="22" y2="12"/>
                                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                            </svg>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <h3 style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {site.name}
                                </h3>
                                <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4,
                                    background: wc.mode === "fullstack" ? "rgba(245,158,11,0.1)" : "rgba(34,197,94,0.12)",
                                    color: wc.mode === "fullstack" ? "#fbbf24" : "#4ade80",
                                    border: `1px solid ${wc.mode === "fullstack" ? "rgba(245,158,11,0.25)" : "rgba(34,197,94,0.25)"}`,
                                    flexShrink: 0 }}>
                                    {wc.mode === "fullstack" ? "Full-Stack" : "Static"}
                                </span>
                            </div>
                            <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {site.buyerID}
                            </p>
                        </div>
                        <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 11, padding: "3px 8px", flexShrink: 0 }}>
                            <span className="status-dot" style={{ background: s.color, width: 6, height: 6 }} />
                            {s.label}
                        </span>
                    </div>

                    {/* Domain / SSL row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {wc.domain ? (
                            <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--bg-input)", padding: "3px 8px", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                                {accessUrl}
                            </span>
                        ) : (
                            <span style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>No domain — port {wc.port}</span>
                        )}
                        {wc.sslEnabled
                            ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", flexShrink: 0 }}>🔒 SSL</span>
                            : wc.domain && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: "rgba(239,68,68,0.1)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.2)", flexShrink: 0 }}>⚠ No SSL</span>
                        }
                    </div>
                </div>

                {/* Footer actions */}
                <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border-light)", display: "flex", gap: 6, background: "rgba(0,0,0,0.15)" }}>
                    {isStopped ? (
                        <button className="btn-success" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }} onClick={() => action("start")} disabled={busy} title="Start">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                    ) : (
                        <button className="btn-danger" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }} onClick={() => action("stop")} disabled={busy} title="Stop">
                            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                        </button>
                    )}
                    <button className="btn-warning" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }} onClick={() => action("restart")} disabled={busy} title="Restart">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    </button>
                    <button className="btn-primary" style={{ flex: 1, padding: "5px 10px", fontSize: 12 }} onClick={() => navigate(`/sites/${site._id}`)} disabled={busy}>
                        Manage
                    </button>
                    <button className="btn-ghost" style={{ padding: "5px 8px", color: "var(--danger)", fontSize: 12, display: "flex", alignItems: "center" }} onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
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

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, color, gradient }) {
    return (
        <div className="card" style={{ padding: "20px 24px", position: "relative", overflow: "hidden", borderBottom: `2px solid ${color}` }}>
            <div style={{ position: "absolute", top: -30, right: -20, width: 120, height: 120, background: gradient, opacity: 0.08, filter: "blur(30px)", borderRadius: "50%", pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0 }}>{label}</p>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center", color }}>
                    {icon}
                </div>
            </div>
            <p style={{ fontSize: 36, fontWeight: 800, color: "#fff", margin: 0, lineHeight: 1 }}>{value}</p>
        </div>
    );
}

// ── SitesPage ─────────────────────────────────────────────────────────────────
export default function SitesPage() {
    const { bots: allBots, groups, loading, refresh: fetchAll } = useData();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");

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
        return ms && mf;
    });

    return (
        <div className="fade-in page" style={{ maxWidth: 1600 }}>

            {/* Header */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 32, flexWrap: "wrap" }}>
                <div className="min-w-0" style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>
                        Sites
                    </h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 4 }}>
                        Manage and monitor your hosted websites
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
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        New Site
                    </button>
                </div>
            </div>

            {/* Stats */}
            <div className="grid-2-mobile gap-sm-mobile" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 28 }}>
                <StatCard label="Total Sites" value={sites.length} color="var(--accent)" gradient="var(--accent)"
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>}
                />
                <StatCard label="Online" value={online} color="var(--success)" gradient="var(--success)"
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
                />
                <StatCard label="SSL Active" value={ssl} color="#4ade80" gradient="#4ade80"
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
                />
                <StatCard label="With Domain" value={domains} color="#60A5FA" gradient="#60A5FA"
                    icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
                />
            </div>

            {/* Filter bar */}
            <div className="card" style={{ marginBottom: 20, padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
                <div style={{ position: "relative", flex: "1 1 250px", maxWidth: 400 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}>
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input className="input" style={{ paddingLeft: 38 }} placeholder="Search by name, ID, or domain…" value={search} onChange={e => setSearch(e.target.value)} />
                </div>
                <div className="tab-bar">
                    {["all", "online", "stopped"].map(f => (
                        <button key={f} className={`tab-item ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)} style={{ textTransform: "capitalize" }}>{f}</button>
                    ))}
                </div>
                <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-dim)", fontWeight: 500 }}>
                    {visible.length} / {sites.length}
                </span>
            </div>

            {/* Grid */}
            {loading && sites.length === 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 16 }}>
                    {[1, 2, 3].map(i => (
                        <div key={i} className="card" style={{ padding: 0, overflow: "hidden" }}>
                            <div className="skeleton" style={{ height: 3 }} />
                            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                                <div style={{ display: "flex", gap: 12 }}>
                                    <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0 }} />
                                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                                        <div className="skeleton" style={{ height: 14, borderRadius: 4 }} />
                                        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "60%" }} />
                                    </div>
                                </div>
                                <div className="skeleton" style={{ height: 24, borderRadius: 6 }} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {!loading && visible.length === 0 && (
                <div className="card" style={{ textAlign: "center", padding: "72px 24px", borderStyle: "dashed" }}>
                    <div style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 36, height: 36, color: "var(--text-dim)" }}>
                            <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                        </svg>
                    </div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                        {sites.length === 0 ? "No sites yet" : "No matches found"}
                    </h3>
                    <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24, maxWidth: 360, margin: "0 auto 24px" }}>
                        {sites.length === 0
                            ? "Deploy your first static site or full-stack website."
                            : "Try adjusting your search or filter."}
                    </p>
                    {sites.length === 0 && (
                        <button className="btn-primary" onClick={() => setShowCreate(true)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16 }}>
                                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Deploy First Site
                        </button>
                    )}
                </div>
            )}

            {!loading && visible.length > 0 && (
                <div className="slide-up" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 16 }}>
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
