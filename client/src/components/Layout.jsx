import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const NAV_ITEMS = [
    {
        to: "/dashboard", label: "Dashboard",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
        </svg>
    },
    {
        to: "/groups", label: "Groups",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    },
    {
        to: "/tags", label: "Tags",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
            <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
    },
    {
        to: "/multi-manage", label: "Multi Manage",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
    },
    {
        to: "/panel-manage", label: "Panel",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>
    },
    {
        to: "/proxy", label: "Proxy",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
    },
    {
        to: "/system", label: "System",
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
    },
];

export default function Layout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);

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

    const sidebarStyle = {
        width: isMobile ? "100%" : (sidebarOpen ? 220 : 56),
        background: "var(--bg-card)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        transition: "width 0.2s ease",
        overflow: "hidden",
        position: isMobile ? "fixed" : "relative",
        zIndex: isMobile ? 50 : "auto",
        height: isMobile ? "100dvh" : "auto",
        transform: isMobile && !sidebarOpen ? "translateX(-100%)" : "translateX(0)",
    };

    return (
        <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>

            {/* Mobile overlay */}
            {isMobile && sidebarOpen && (
                <div
                    onClick={() => setSidebarOpen(false)}
                    style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 40 }}
                />
            )}

            {/* Sidebar */}
            <aside style={sidebarStyle}>
                {/* Brand header */}
                <div style={{
                    padding: "14px 12px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 56,
                }}>
                    <div style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        background: "var(--accent)",
                        overflow: "hidden",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                    }}>
                        <img src="/logo.png" alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </div>
                    {sidebarOpen && (
                        <div style={{ overflow: "hidden" }}>
                            <p style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", lineHeight: 1.2, whiteSpace: "nowrap" }}>NexusPanel</p>
                            <p style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Bot Manager</p>
                        </div>
                    )}
                    <button
                        onClick={() => setSidebarOpen(v => !v)}
                        style={{
                            marginLeft: sidebarOpen ? "auto" : 0,
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            padding: 4,
                            display: "flex",
                            borderRadius: 4,
                            flexShrink: 0,
                        }}
                        title={sidebarOpen ? "Collapse" : "Expand"}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14, transform: sidebarOpen ? "none" : "rotate(180deg)", transition: "transform 0.2s" }}>
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                    </button>
                </div>

                {/* Nav */}
                <nav style={{ flex: 1, padding: "8px 6px", overflowY: "auto", overflowX: "hidden" }}>
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            title={!sidebarOpen ? label : undefined}
                            style={({ isActive }) => ({
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: sidebarOpen ? "8px 10px" : "10px",
                                borderRadius: 7,
                                textDecoration: "none",
                                fontSize: 13,
                                fontWeight: 500,
                                color: isActive ? "#fff" : "var(--text-muted)",
                                background: isActive ? "var(--accent)" : "transparent",
                                marginBottom: 2,
                                justifyContent: sidebarOpen ? "flex-start" : "center",
                                whiteSpace: "nowrap",
                                transition: "background 0.15s, color 0.15s",
                            })}
                        >
                            {({ isActive }) => (
                                <>
                                    <span style={{ flexShrink: 0, color: isActive ? "#fff" : "var(--text-muted)" }}>{icon}</span>
                                    {sidebarOpen && <span>{label}</span>}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* User footer */}
                <div style={{
                    padding: "10px 8px",
                    borderTop: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                }}>
                    <div style={{
                        width: 30,
                        height: 30,
                        borderRadius: "50%",
                        background: "var(--accent)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#fff",
                        flexShrink: 0,
                    }}>
                        {user?.username?.[0]?.toUpperCase()}
                    </div>
                    {sidebarOpen && (
                        <>
                            <div style={{ flex: 1, overflow: "hidden" }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", truncate: true, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {user?.username}
                                </p>
                                <p style={{ fontSize: 11, color: "var(--success)" }}>● Online</p>
                            </div>
                            <button
                                onClick={handleLogout}
                                title="Logout"
                                style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--text-muted)",
                                    cursor: "pointer",
                                    padding: 4,
                                    borderRadius: 4,
                                    display: "flex",
                                    flexShrink: 0,
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

            {/* Top bar (mobile) */}
            {isMobile && (
                <div style={{
                    position: "fixed",
                    top: 0, left: 0, right: 0,
                    height: 52,
                    background: "var(--bg-card)",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 16px",
                    gap: 12,
                    zIndex: 30,
                }}>
                    <button
                        onClick={() => setSidebarOpen(true)}
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 20, height: 20 }}>
                            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
                        </svg>
                    </button>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>NexusPanel</span>
                    <button
                        onClick={handleLogout}
                        style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                    </button>
                </div>
            )}

            {/* Main content */}
            <main style={{
                flex: 1,
                overflowY: "auto",
                paddingTop: isMobile ? 52 : 0,
            }}>
                <Outlet />
            </main>
        </div>
    );
}
