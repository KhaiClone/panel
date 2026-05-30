import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
    { to: "/dashboard", label: "Dashboard", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg> },
    { to: "/groups", label: "Groups", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
    { to: "/tags", label: "Tags", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
    { to: "/multi-manage", label: "Multi Manage", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> },
    { to: "/panel-manage", label: "Panel", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg> },
    { to: "/proxy", label: "Proxy", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> },
    { to: "/system", label: "System", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
];

export default function Layout() {
    const { user, logout } = useAuth();
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

    return (
        <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "transparent" }}>

            {/* Mobile overlay */}
            {isMobile && sidebarOpen && (
                <div className="fade-in" onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 40, backdropFilter: "blur(4px)" }} />
            )}

            {/* Sidebar */}
            <aside style={{
                width: isMobile ? "100%" : (sidebarOpen ? 260 : 70),
                background: "var(--bg-surface)",
                borderRight: "1px solid var(--border)",
                backdropFilter: "var(--glass-blur)",
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
                {/* Brand header */}
                <div style={{
                    padding: "20px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 70,
                    borderBottom: "1px solid var(--border-light)",
                }}>
                    <div style={{
                        width: 40, height: 40, 
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                    }}>
                        <img src="/logo.png" alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    </div>
                    
                    <div style={{ overflow: "hidden", opacity: sidebarOpen ? 1 : 0, transition: "opacity 0.2s" }}>
                        <p style={{ fontWeight: 700, fontSize: 16, color: "var(--text)", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>NexusPanel</p>
                        <p style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>Bot Manager</p>
                    </div>

                    <button
                        onClick={() => setSidebarOpen(v => !v)}
                        style={{
                            marginLeft: sidebarOpen ? "auto" : 0,
                            background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer",
                            padding: 6, display: "flex", borderRadius: 8, flexShrink: 0, transition: "all 0.2s"
                        }}
                        title={sidebarOpen ? "Collapse" : "Expand"}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18, transform: sidebarOpen ? "none" : "rotate(180deg)", transition: "transform 0.3s" }}>
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                    </button>
                </div>

                {/* Nav */}
                <nav style={{ flex: 1, padding: "20px 12px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }} className="no-scrollbar">
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            title={!sidebarOpen ? label : undefined}
                            style={({ isActive }) => ({
                                display: "flex", alignItems: "center", gap: 12,
                                padding: sidebarOpen ? "12px 16px" : "12px",
                                borderRadius: 10, textDecoration: "none",
                                fontSize: 14, fontWeight: 500,
                                color: isActive ? "#fff" : "var(--text-muted)",
                                background: isActive ? "linear-gradient(90deg, var(--accent-dim), transparent)" : "transparent",
                                borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                                justifyContent: sidebarOpen ? "flex-start" : "center",
                                whiteSpace: "nowrap", transition: "all 0.2s ease",
                            })}
                        >
                            {({ isActive }) => (
                                <>
                                    <span style={{ 
                                        flexShrink: 0, 
                                        color: isActive ? "var(--accent-hover)" : "var(--text-muted)",
                                        filter: isActive ? "drop-shadow(0 0 8px rgba(99,102,241,0.5))" : "none",
                                        transition: "all 0.2s"
                                    }}>{icon}</span>
                                    {sidebarOpen && <span>{label}</span>}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* User footer */}
                <div style={{
                    padding: "16px",
                    borderTop: "1px solid var(--border-light)",
                    background: "rgba(0,0,0,0.1)",
                    display: "flex", alignItems: "center", gap: 12,
                }}>
                    <div style={{
                        width: 36, height: 36, borderRadius: "50%",
                        background: "var(--bg-input)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, fontWeight: 700, color: "var(--accent-hover)", flexShrink: 0,
                    }}>
                        {user?.username?.[0]?.toUpperCase()}
                    </div>
                    {sidebarOpen && (
                        <>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                                <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {user?.username}
                                </p>
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                                    <span className="status-dot" style={{ background: "var(--success)", width: 6, height: 6 }}/>
                                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Online</span>
                                </div>
                            </div>
                            <button
                                onClick={handleLogout}
                                title="Logout"
                                style={{
                                    background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "var(--danger)",
                                    cursor: "pointer", padding: 8, borderRadius: 8, display: "flex", flexShrink: 0, transition: "all 0.2s"
                                }}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                                </svg>
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* Main content area */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                
                {/* Top bar (Desktop & Mobile) */}
                <header style={{
                    height: 70, flexShrink: 0,
                    background: "var(--bg-surface)", borderBottom: "1px solid var(--border-light)", backdropFilter: "var(--glass-blur)",
                    display: "flex", alignItems: "center", padding: "0 24px", gap: 16,
                    position: "relative", zIndex: 10
                }}>
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
                    
                    {/* Top bar content (e.g. Breadcrumbs, Page Title can be injected here via context later, for now just a nice date/greeting) */}
                    <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>
                            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                        </p>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
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
                                    position: "absolute", top: 4, right: 6, width: 8, height: 8, borderRadius: "50%", 
                                    background: "var(--danger)", border: "2px solid var(--bg-surface)"
                                }}/>
                            )}
                        </button>

                        {showNotifs && (
                            <>
                                <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setShowNotifs(false)} />
                                <div className="card slide-up" style={{
                                    position: "absolute", top: "calc(100% + 10px)", right: 0, width: 340, maxHeight: 400, 
                                    padding: 0, overflowY: "auto", zIndex: 50, boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
                                    border: "1px solid var(--border)"
                                }}>
                                    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-input)", position: "sticky", top: 0, zIndex: 2 }}>
                                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Notifications</h3>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column" }}>
                                        {notifs.length === 0 ? (
                                            <p style={{ padding: 32, textAlign: "center", margin: 0, fontSize: 13, color: "var(--text-dim)", fontStyle: "italic" }}>No notifications yet.</p>
                                        ) : (
                                            notifs.map(n => {
                                                let badgeColor = "var(--accent)";
                                                if (n.type === "stop" || n.type === "expired") badgeColor = "var(--warning)";
                                                if (n.type === "start") badgeColor = "var(--success)";
                                                
                                                return (
                                                    <div key={n._id} style={{ 
                                                        padding: "16px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", gap: 12,
                                                        background: n.read ? "transparent" : "var(--bg-input)", transition: "background 0.3s"
                                                    }}>
                                                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: badgeColor, marginTop: 5, flexShrink: 0, boxShadow: `0 0 8px ${badgeColor}80` }}/>
                                                        <div>
                                                            <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.4, fontWeight: n.read ? 500 : 600 }}>{n.message}</p>
                                                            <p style={{ margin: "4px 0 0 0", fontSize: 11, color: "var(--text-muted)" }}>{new Date(n.createdAt).toLocaleString()}</p>
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
