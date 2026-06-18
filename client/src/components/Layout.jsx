import { useState, useEffect, useMemo, useRef } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useData } from "../context/DataContext";

// ── Icons ──────────────────────────────────────────────────────────────────
const I = {
    overview:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>,
    projects:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
    domains:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    groups:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    tags:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
    bulk:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    proxy:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
    system:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>,
    panel:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:18,height:18}}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    bell:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:18,height:18}}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
    logout:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{width:15,height:15}}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
    chevronL:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:18,height:18}}><polyline points="15 18 9 12 15 6"/></svg>,
    menu:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:22,height:22}}><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
    close:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{width:14,height:14}}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
};

const NAV_SECTIONS = [
    {
        id: "main",
        label: "Main",
        items: [
            { to: "/overview",  label: "Overview",  icon: I.overview },
            { to: "/dashboard", label: "Projects",  icon: I.projects },
            { to: "/domains",   label: "Domains",   icon: I.domains },
        ],
    },
    {
        id: "tools",
        label: "Tools",
        items: [
            { to: "/multi-manage", label: "Bulk Ops", icon: I.bulk },
            { to: "/proxy",        label: "Proxy",    icon: I.proxy },
        ],
    },
    {
        id: "organize",
        label: "Organize",
        items: [
            { to: "/groups", label: "Groups", icon: I.groups },
            { to: "/tags",   label: "Tags",   icon: I.tags },
        ],
    },
    {
        id: "system",
        label: "System",
        items: [
            { to: "/system",       label: "Monitor", icon: I.system },
            { to: "/panel-manage", label: "Panel",   icon: I.panel },
        ],
    },
];

const PAGE_TITLES = {
    "/overview":     "Overview",
    "/dashboard":    "Projects",
    "/domains":      "Domains",
    "/groups":       "Groups",
    "/tags":         "Tags",
    "/multi-manage": "Bulk Operations",
    "/panel-manage": "Panel Settings",
    "/proxy":        "Proxy",
    "/system":       "System Monitor",
};

const NOTIF_TYPE_COLOR = {
    start: "var(--success)", stop: "var(--warning)", restart: "var(--accent)",
    expired: "var(--danger)", reinstall: "#a78bfa", info: "var(--accent)",
};

function getPageTitle(pathname) {
    if (pathname.startsWith("/bots/")) return "Project Detail";
    return PAGE_TITLES[pathname] || "NexusPanel";
}

function NavItem({ to, icon, label, expanded }) {
    return (
        <NavLink
            to={to}
            title={!expanded ? label : undefined}
            style={({ isActive }) => ({
                display: "flex", alignItems: "center", gap: 12,
                padding: expanded ? "9px 12px" : "9px",
                borderRadius: 9, textDecoration: "none",
                fontSize: 13.5, fontWeight: 500,
                color: isActive ? "var(--text)" : "var(--text-muted)",
                background: isActive ? "rgba(99,102,241,0.12)" : "transparent",
                border: `1px solid ${isActive ? "rgba(99,102,241,0.25)" : "transparent"}`,
                justifyContent: expanded ? "flex-start" : "center",
                whiteSpace: "nowrap", transition: "all 0.15s ease",
            })}
        >
            {({ isActive }) => (
                <>
                    <span style={{
                        flexShrink: 0, width: 26, height: 26,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: 7,
                        color: isActive ? "var(--accent-hover)" : "var(--text-dim)",
                        transition: "all 0.15s",
                    }}>{icon}</span>
                    {expanded && <span style={{ opacity: isActive ? 1 : 0.85 }}>{label}</span>}
                </>
            )}
        </NavLink>
    );
}

export default function Layout() {
    const { user, logout } = useAuth();
    const { stats, bots } = useData();
    const navigate = useNavigate();
    const location = useLocation();
    const [expanded, setExpanded] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
    const [notifs, setNotifs] = useState([]);
    const [showNotifs, setShowNotifs] = useState(false);
    const notifRef = useRef(null);

    useEffect(() => {
        const fetchNotifs = () => {
            import("../api/client").then(({ default: api }) => {
                api.get("/notifications").then(r => setNotifs(r.data)).catch(() => {});
            });
        };
        fetchNotifs();
        const int = setInterval(fetchNotifs, 15000);
        return () => clearInterval(int);
    }, []);

    useEffect(() => {
        const handleResize = () => {
            const mobile = window.innerWidth < 1024;
            setIsMobile(mobile);
            if (!mobile) setExpanded(true);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => { if (isMobile) setExpanded(false); }, [location.pathname]);

    useEffect(() => {
        const handler = (e) => {
            if (showNotifs && notifRef.current && !notifRef.current.contains(e.target))
                setShowNotifs(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [showNotifs]);

    const handleLogout = () => { logout(); navigate("/login"); };
    const unreadCount = notifs.filter(n => !n.read).length;

    const cpuPct = stats?.cpu?.usagePercent != null ? Math.round(stats.cpu.usagePercent) : null;
    const ramPct = stats?.memory?.usedPercent != null ? Math.round(stats.memory.usedPercent) : null;
    const cpuColor = cpuPct == null ? "var(--text-dim)" : cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--success)";
    const ramColor = ramPct == null ? "var(--text-dim)" : ramPct > 85 ? "var(--danger)" : ramPct > 60 ? "var(--warning)" : "#60A5FA";

    const onlineBots = bots.filter(b => b.live?.status === "online").length;

    const pageTitle = useMemo(() => getPageTitle(location.pathname), [location.pathname]);

    const SIDEBAR_W = expanded ? 230 : 60;

    const handleMarkRead = async () => {
        try {
            const { default: api } = await import("../api/client");
            await api.post("/notifications/read");
            setNotifs(prev => prev.map(n => ({ ...n, read: true })));
        } catch {}
    };
    const handleRemoveNotif = async (id) => {
        try {
            const { default: api } = await import("../api/client");
            await api.delete(`/notifications/${id}`);
            setNotifs(prev => prev.filter(n => n._id !== id));
        } catch {}
    };

    return (
        <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>

            {/* Mobile overlay */}
            {isMobile && expanded && (
                <div className="fade-in" onClick={() => setExpanded(false)}
                    style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 40, backdropFilter: "blur(4px)" }} />
            )}

            {/* ── Sidebar ────────────────────────────────────────────── */}
            <aside style={{
                width: isMobile ? 230 : SIDEBAR_W,
                background: "var(--bg-surface)",
                borderRight: "1px solid var(--border)",
                display: "flex", flexDirection: "column", flexShrink: 0,
                transition: "width 0.25s cubic-bezier(0.4,0,0.2,1)",
                overflow: "hidden",
                position: isMobile ? "fixed" : "relative",
                zIndex: isMobile ? 50 : "auto",
                height: isMobile ? "100dvh" : "auto",
                transform: isMobile && !expanded ? "translateX(-100%)" : "translateX(0)",
            }}>
                {/* Top gradient strip */}
                <div style={{ height: 3, flexShrink: 0, background: "linear-gradient(90deg, var(--accent), #8B5CF6, #06B6D4)" }} />

                {/* Brand */}
                <div style={{
                    padding: expanded ? "14px 16px" : "14px 0",
                    display: "flex", alignItems: "center", justifyContent: expanded ? "flex-start" : "center",
                    gap: 10, minHeight: 60, borderBottom: "1px solid var(--border-light)",
                }}>
                    <div
                        onClick={() => !expanded && setExpanded(true)}
                        style={{ width: 34, height: 34, borderRadius: 9, overflow: "hidden", flexShrink: 0, cursor: expanded ? "default" : "pointer" }}
                    >
                        <img src="/logo.png" alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    </div>
                    {expanded && (
                        <div className="fade-in" style={{ flex: 1, overflow: "hidden" }}>
                            <p style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", margin: 0, whiteSpace: "nowrap" }}>NexusPanel</p>
                            <p style={{ fontSize: 10, color: "var(--accent-hover)", textTransform: "uppercase", letterSpacing: "0.06em", margin: 0, whiteSpace: "nowrap" }}>VPS Dashboard</p>
                        </div>
                    )}
                    {expanded && (
                        <button onClick={() => setExpanded(false)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 5, display: "flex", borderRadius: 7 }}>
                            {I.chevronL}
                        </button>
                    )}
                </div>

                {/* Nav sections */}
                <nav style={{ flex: 1, padding: "12px 8px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }} className="no-scrollbar">
                    {NAV_SECTIONS.map((section, si) => (
                        <div key={section.id} style={{ marginBottom: 6 }}>
                            {/* Section label */}
                            {expanded ? (
                                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "8px 12px 4px", margin: 0 }}>
                                    {section.label}
                                </p>
                            ) : si > 0 ? (
                                <div style={{ height: 1, background: "var(--border-light)", margin: "8px 10px" }} />
                            ) : null}

                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                {section.items.map(item => (
                                    <NavItem key={item.to} {...item} expanded={expanded} />
                                ))}
                            </div>
                        </div>
                    ))}
                </nav>

                {/* Sidebar stats strip (only when expanded) */}
                {expanded && cpuPct != null && (
                    <div className="fade-in" style={{ margin: "0 10px 10px", padding: "10px 12px", background: "var(--bg-input)", borderRadius: 10, border: "1px solid var(--border-light)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Server Health</span>
                            <span style={{ fontSize: 11, color: onlineBots > 0 ? "var(--success)" : "var(--text-dim)" }}>
                                {onlineBots} online
                            </span>
                        </div>
                        {[
                            { label: "CPU", pct: cpuPct, color: cpuColor },
                            { label: "RAM", pct: ramPct, color: ramColor },
                        ].map(({ label, pct, color }) => (
                            <div key={label} style={{ marginBottom: 6 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</span>
                                    <span style={{ fontSize: 10, fontWeight: 600, color }}>{pct}%</span>
                                </div>
                                <div style={{ height: 4, background: "var(--border)", borderRadius: 99, overflow: "hidden" }}>
                                    <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.5s ease" }} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* User footer */}
                <div style={{ padding: "12px 10px", borderTop: "1px solid var(--border-light)", background: "rgba(0,0,0,0.1)", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ position: "relative", flexShrink: 0 }}>
                        <div style={{ width: 34, height: 34, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent), #8B5CF6)", padding: 2 }}>
                            <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "var(--bg-surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "var(--accent-hover)" }}>
                                {user?.username?.[0]?.toUpperCase()}
                            </div>
                        </div>
                        <span className="status-dot" style={{ background: "var(--success)", width: 8, height: 8, position: "absolute", bottom: 0, right: 0, border: "1.5px solid var(--bg-surface)" }} />
                    </div>
                    {expanded && (
                        <>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", margin: 0 }}>{user?.username}</p>
                                <p style={{ fontSize: 10, color: "var(--success)", margin: 0 }}>Administrator</p>
                            </div>
                            <button onClick={handleLogout} title="Logout"
                                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)", cursor: "pointer", padding: 7, borderRadius: 8, display: "flex", flexShrink: 0 }}>
                                {I.logout}
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* ── Main ───────────────────────────────────────────────── */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                {/* Header */}
                <header style={{
                    height: 58, flexShrink: 0,
                    background: "var(--bg-surface)",
                    borderBottom: "1px solid var(--border-light)",
                    display: "flex", alignItems: "center", padding: "0 20px", gap: 14,
                    position: "relative", zIndex: 10,
                }}>
                    {isMobile && (
                        <button onClick={() => setExpanded(true)} style={{ background: "none", border: "none", color: "var(--text)", cursor: "pointer", padding: 4, display: "flex" }}>
                            {I.menu}
                        </button>
                    )}

                    <div style={{ flex: 1 }}>
                        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>{pageTitle}</h2>
                    </div>

                    {/* Header chips */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }} ref={notifRef}>
                        {/* Resource chips */}
                        <div className="hide-mobile" style={{ display: "flex", gap: 6 }}>
                            {cpuPct != null && (
                                <ResourceChip label="CPU" value={`${cpuPct}%`} color={cpuColor} />
                            )}
                            {ramPct != null && (
                                <ResourceChip label="RAM" value={`${ramPct}%`} color={ramColor} />
                            )}
                        </div>

                        {/* Notification bell */}
                        <button className="btn-ghost" style={{ padding: 8, borderRadius: "50%", position: "relative" }}
                            onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs && unreadCount > 0) handleMarkRead(); }}>
                            {I.bell}
                            {unreadCount > 0 && (
                                <span style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: "50%", background: "var(--danger)", border: "2px solid var(--bg-surface)" }} />
                            )}
                        </button>

                        {/* Notification dropdown */}
                        {showNotifs && (
                            <div className="card slide-up" style={{
                                position: "absolute", top: "calc(100% + 8px)", right: 16,
                                width: 340, maxHeight: 440, padding: 0, overflowY: "auto",
                                zIndex: 50, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", border: "1px solid var(--border)",
                            }}>
                                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", position: "sticky", top: 0, zIndex: 2 }}>
                                    <span style={{ fontSize: 13, fontWeight: 700 }}>Notifications</span>
                                    {unreadCount > 0 && <span className="badge" style={{ background: "var(--accent-dim)", color: "var(--accent-hover)", fontSize: 10 }}>{unreadCount} new</span>}
                                </div>
                                {notifs.length === 0 ? (
                                    <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No notifications</div>
                                ) : (
                                    notifs.map(n => (
                                        <div key={n._id} style={{
                                            padding: "12px 16px", borderBottom: "1px solid var(--border-light)",
                                            display: "flex", gap: 10, alignItems: "flex-start",
                                            background: n.read ? "transparent" : "var(--bg-input)",
                                            borderLeft: `3px solid ${NOTIF_TYPE_COLOR[n.type] || "var(--accent)"}`,
                                        }}>
                                            <div style={{ flex: 1 }}>
                                                <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.4, fontWeight: n.read ? 400 : 600 }}>{n.message}</p>
                                                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{new Date(n.createdAt).toLocaleString()}</p>
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); handleRemoveNotif(n._id); }}
                                                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 3, display: "flex", borderRadius: 4 }}>
                                                {I.close}
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </header>

                <main style={{ flex: 1, overflowY: "auto", position: "relative" }} className="fade-in">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

function ResourceChip({ label, value, color }) {
    return (
        <div style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "4px 10px", borderRadius: 99,
            background: "var(--bg-input)", border: "1px solid var(--border)",
            fontSize: 11, fontWeight: 600,
        }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
            <span style={{ color: "var(--text-muted)" }}>{label}</span>
            <span style={{ color }}>{value}</span>
        </div>
    );
}
