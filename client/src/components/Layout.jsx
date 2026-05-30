import { useState, useEffect, useMemo } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useData } from "../context/DataContext";

const NAV_ITEMS = [
    { to: "/dashboard", label: "Dashboard", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg> },
    { to: "/groups", label: "Groups", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
    { to: "/tags", label: "Tags", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
    { to: "/multi-manage", label: "Multi Manage", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> },
    { to: "/panel-manage", label: "Panel", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> },
    { to: "/proxy", label: "Proxy", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> },
    { to: "/system", label: "System", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
];

const PAGE_TITLES = {
    "/dashboard": "Overview",
    "/groups": "Groups",
    "/tags": "Tags",
    "/multi-manage": "Bulk Operations",
    "/panel-manage": "Panel",
    "/proxy": "Proxy",
    "/system": "System Monitor",
};

function getPageTitle(pathname) {
    if (pathname.startsWith("/bots/")) return "Instance Detail";
    return PAGE_TITLES[pathname] || "NexusPanel";
}

export default function Layout() {
    const { user, logout } = useAuth();
    const { stats } = useData();
    const navigate = useNavigate();
    const location = useLocation();
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
    const [notifs, setNotifs] = useState([]);
    const [showNotifs, setShowNotifs] = useState(false);

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
            if (!mobile) setSidebarOpen(true);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => {
        if (isMobile) setSidebarOpen(false);
    }, [location.pathname]);

    const handleLogout = () => { logout(); navigate("/login"); };

    const handleMarkRead = async () => {
        try {
            const { default: api } = await import("../api/client");
            await api.post("/notifications/read");
            setNotifs(prev => prev.map(n => ({ ...n, read: true })));
        } catch {}
    };

    const unreadCount = notifs.filter(n => !n.read).length;

    const cpuPct = stats?.cpu?.usagePercent != null ? Math.round(stats.cpu.usagePercent) : null;
    const cpuColor = cpuPct == null ? "var(--text-dim)" : cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--success)";

    const pageTitle = useMemo(() => getPageTitle(location.pathname), [location.pathname]);

    const SIDEBAR_EXPANDED = 256;
    const SIDEBAR_COLLAPSED = 68;

    return (
        <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "transparent" }}>

            {/* Mobile overlay */}
            {isMobile && sidebarOpen && (
                <div className="fade-in" onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 40, backdropFilter: "blur(4px)" }} />
            )}

            {/* ── Sidebar ── */}
            <aside style={{
                width: isMobile ? SIDEBAR_EXPANDED : (sidebarOpen ? SIDEBAR_EXPANDED : SIDEBAR_COLLAPSED),
                background: "var(--bg-surface)",
                borderRight: "1px solid var(--border)",
                backdropFilter: "var(--glass-blur)",
                WebkitBackdropFilter: "var(--glass-blur)",
                display: "flex",
                flexDirection: "column",
                flexShrink: 0,
                transition: "width 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                overflow: "hidden",
                position: isMobile ? "fixed" : "relative",
                zIndex: isMobile ? 50 : "auto",
                height: isMobile ? "100dvh" : "auto",
                transform: isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
            }}>

                {/* Gradient accent strip */}
                <div style={{
                    height: 3,
                    flexShrink: 0,
                    background: "linear-gradient(90deg, var(--accent), #8B5CF6, #06B6D4)",
                }} />

                {/* Brand header */}
                <div style={{
                    padding: "16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 66,
                    borderBottom: "1px solid var(--border-light)",
                }}>
                    {/* Logo */}
                    <div style={{
                        width: 40, height: 40,
                        borderRadius: 10,
                        overflow: "hidden",
                        flexShrink: 0,
                        background: "var(--accent-dim)",
                        border: "1px solid var(--border)",
                    }}>
                        <img src="/logo.png" alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    </div>

                    <div style={{ overflow: "hidden", opacity: sidebarOpen ? 1 : 0, transition: "opacity 0.2s", flex: 1 }}>
                        <p style={{ fontWeight: 700, fontSize: 16, color: "var(--text)", letterSpacing: "0.02em", whiteSpace: "nowrap", margin: 0 }}>NexusPanel</p>
                        <p style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap", margin: 0 }}>Bot Manager</p>
                    </div>

                    <button
                        onClick={() => setSidebarOpen(v => !v)}
                        style={{
                            marginLeft: "auto",
                            background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer",
                            padding: 6, display: "flex", borderRadius: 8, flexShrink: 0, transition: "all 0.2s",
                        }}
                        title={sidebarOpen ? "Collapse" : "Expand"}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18, transform: sidebarOpen ? "none" : "rotate(180deg)", transition: "transform 0.3s" }}>
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                    </button>
                </div>

                {/* Nav */}
                <nav style={{ flex: 1, padding: "16px 10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }} className="no-scrollbar">
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            title={!sidebarOpen ? label : undefined}
                            style={({ isActive }) => ({
                                display: "flex", alignItems: "center", gap: 12,
                                padding: sidebarOpen ? "10px 14px" : "10px",
                                borderRadius: 10, textDecoration: "none",
                                fontSize: 14, fontWeight: 500,
                                color: isActive ? "#fff" : "var(--text-muted)",
                                background: isActive
                                    ? "linear-gradient(135deg, var(--accent-dim), rgba(99,102,241,0.08))"
                                    : "transparent",
                                borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                                justifyContent: sidebarOpen ? "flex-start" : "center",
                                whiteSpace: "nowrap", transition: "all 0.2s ease",
                            })}
                        >
                            {({ isActive }) => (
                                <>
                                    <span style={{
                                        flexShrink: 0,
                                        width: 28, height: 28,
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        borderRadius: 8,
                                        background: isActive ? "rgba(99,102,241,0.2)" : "transparent",
                                        color: isActive ? "var(--accent-hover)" : "var(--text-muted)",
                                        filter: isActive ? "drop-shadow(0 0 8px rgba(99,102,241,0.5))" : "none",
                                        transition: "all 0.2s",
                                    }}>{icon}</span>
                                    {sidebarOpen && <span>{label}</span>}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* User footer */}
                <div style={{
                    padding: "14px 12px",
                    borderTop: "1px solid var(--border-light)",
                    background: "rgba(0,0,0,0.15)",
                    display: "flex", alignItems: "center", gap: 10,
                }}>
                    {/* Avatar with gradient ring */}
                    <div style={{ position: "relative", flexShrink: 0 }}>
                        <div style={{
                            width: 36, height: 36,
                            borderRadius: "50%",
                            background: "linear-gradient(135deg, var(--accent), #8B5CF6)",
                            padding: 2,
                            flexShrink: 0,
                        }}>
                            <div style={{
                                width: "100%", height: "100%", borderRadius: "50%",
                                background: "var(--bg-surface)",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 13, fontWeight: 700, color: "var(--accent-hover)",
                            }}>
                                {user?.username?.[0]?.toUpperCase()}
                            </div>
                        </div>
                        {/* Online dot */}
                        <span className="status-dot" style={{
                            background: "var(--success)",
                            width: 8, height: 8,
                            position: "absolute", bottom: 0, right: 0,
                            border: "1.5px solid var(--bg-surface)",
                        }} />
                    </div>

                    {sidebarOpen && (
                        <>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", margin: 0 }}>
                                    {user?.username}
                                </p>
                                <p style={{ fontSize: 11, color: "var(--success)", margin: 0, fontWeight: 500 }}>Online</p>
                            </div>
                            <button
                                onClick={handleLogout}
                                title="Logout"
                                style={{
                                    background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--danger)",
                                    cursor: "pointer", padding: 7, borderRadius: 8, display: "flex", flexShrink: 0, transition: "all 0.2s",
                                }}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                                </svg>
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* ── Main content area ── */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                {/* ── Header ── */}
                <header style={{
                    height: 64,
                    flexShrink: 0,
                    background: "var(--bg-surface)",
                    borderBottom: "1px solid var(--border-light)",
                    backdropFilter: "var(--glass-blur)",
                    WebkitBackdropFilter: "var(--glass-blur)",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 24px",
                    gap: 16,
                    position: "relative",
                    zIndex: 10,
                }}>
                    {/* Mobile hamburger */}
                    {isMobile && (
                        <button
                            onClick={() => setSidebarOpen(true)}
                            style={{ background: "none", border: "none", color: "var(--text)", cursor: "pointer", padding: 4, display: "flex" }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 22, height: 22 }}>
                                <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
                            </svg>
                        </button>
                    )}

                    {/* Page Title */}
                    <div style={{ flex: 1 }}>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>{pageTitle}</h2>
                    </div>

                    {/* Right section */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, position: "relative" }}>

                        {/* CPU Health chip */}
                        {cpuPct != null && (
                            <div style={{
                                display: "flex", alignItems: "center", gap: 6,
                                padding: "5px 10px", borderRadius: 99,
                                background: "var(--bg-input)", border: "1px solid var(--border)",
                                fontSize: 12, fontWeight: 600, color: "var(--text-muted)",
                            }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: cpuColor, display: "inline-block", flexShrink: 0 }} />
                                <span style={{ color: cpuColor }}>CPU {cpuPct}%</span>
                            </div>
                        )}

                        {/* Notification bell */}
                        <button
                            className="btn-ghost"
                            style={{ padding: 8, borderRadius: "50%", position: "relative" }}
                            onClick={() => {
                                setShowNotifs(!showNotifs);
                                if (!showNotifs && unreadCount > 0) handleMarkRead();
                            }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                            </svg>
                            {unreadCount > 0 && (
                                <span style={{
                                    position: "absolute", top: 4, right: 6,
                                    width: 8, height: 8, borderRadius: "50%",
                                    background: "var(--danger)", border: "2px solid var(--bg-surface)",
                                }} />
                            )}
                        </button>

                        {/* Notification dropdown */}
                        {showNotifs && (
                            <>
                                <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setShowNotifs(false)} />
                                <div className="card slide-up" style={{
                                    position: "absolute", top: "calc(100% + 10px)", right: 0,
                                    width: 340, maxHeight: 420,
                                    padding: 0, overflowY: "auto", zIndex: 50,
                                    boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
                                    border: "1px solid var(--border)",
                                }}>
                                    {/* Header */}
                                    <div style={{
                                        padding: "14px 18px",
                                        borderBottom: "1px solid var(--border-light)",
                                        display: "flex", alignItems: "center", justifyContent: "space-between",
                                        background: "var(--bg-input)",
                                        position: "sticky", top: 0, zIndex: 2,
                                    }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 15, height: 15, color: "var(--accent)" }}>
                                                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                                            </svg>
                                            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Notifications</h3>
                                        </div>
                                        {unreadCount > 0 && (
                                            <span className="badge" style={{ background: "var(--accent-dim)", color: "var(--accent-hover)", fontSize: 10 }}>
                                                {unreadCount} new
                                            </span>
                                        )}
                                    </div>

                                    {/* Items */}
                                    <div style={{ display: "flex", flexDirection: "column" }}>
                                        {notifs.length === 0 ? (
                                            <div style={{ padding: "36px 24px", textAlign: "center" }}>
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 32, height: 32, color: "var(--text-dim)", margin: "0 auto 10px" }}>
                                                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                                                </svg>
                                                <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)" }}>No notifications yet</p>
                                                <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-dim)", opacity: 0.7 }}>Events will appear here</p>
                                            </div>
                                        ) : (
                                            notifs.map(n => {
                                                let borderColor = "var(--accent)";
                                                if (n.type === "start") borderColor = "var(--success)";
                                                if (n.type === "stop") borderColor = "var(--warning)";
                                                if (n.type === "expired") borderColor = "var(--danger)";

                                                return (
                                                    <div key={n._id} style={{
                                                        padding: "14px 18px",
                                                        borderBottom: "1px solid var(--border-light)",
                                                        display: "flex", gap: 12,
                                                        background: n.read ? "transparent" : "var(--bg-input)",
                                                        borderLeft: `3px solid ${borderColor}`,
                                                        transition: "background 0.3s",
                                                    }}>
                                                        <div>
                                                            <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.4, fontWeight: n.read ? 400 : 600 }}>{n.message}</p>
                                                            <p style={{ margin: "5px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{new Date(n.createdAt).toLocaleString()}</p>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            </>
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
