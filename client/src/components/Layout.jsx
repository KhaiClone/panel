import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { motion, AnimatePresence } from "framer-motion";

// ── Nav items ──────────────────────────────────────────────────────────────
const NAV_ITEMS = [
    {
        to: "/dashboard",
        label: "Dashboard",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
            </svg>
        ),
    },
    {
        to: "/groups",
        label: "Groups",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
        ),
    },
    {
        to: "/tags",
        label: "Tags",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
        ),
    },
    {
        to: "/multi-manage",
        label: "Multi Manage",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
        ),
    },
    {
        to: "/panel-manage",
        label: "Panel",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
        ),
    },
    {
        to: "/proxy",
        label: "Proxy",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
        ),
    },
    {
        to: "/system",
        label: "System",
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
        ),
    },
];

export default function Layout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [open, setOpen] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth < 1024);
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    // Close mobile nav on route change
    useEffect(() => {
        setMobileNavOpen(false);
    }, [location.pathname]);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const initials = user?.username?.[0]?.toUpperCase();

    return (
        <div className="flex h-[100dvh] overflow-hidden" style={{ background: "var(--bg-base)" }}>

            {/* ── Ambient background glows ───────────────────────────── */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
                <div className="absolute -top-[20%] -left-[10%] w-[45%] h-[45%] rounded-full animate-glow"
                    style={{ background: "radial-gradient(circle, rgba(124,58,237,0.12) 0%, transparent 70%)", filter: "blur(60px)" }} />
                <div className="absolute -bottom-[15%] -right-[5%] w-[40%] h-[40%] rounded-full animate-glow"
                    style={{ background: "radial-gradient(circle, rgba(79,70,229,0.1) 0%, transparent 70%)", filter: "blur(60px)", animationDelay: "-2s" }} />
                <div className="absolute top-[40%] left-[30%] w-[30%] h-[30%] rounded-full animate-glow"
                    style={{ background: "radial-gradient(circle, rgba(56,189,248,0.04) 0%, transparent 70%)", filter: "blur(80px)", animationDelay: "-4s" }} />
            </div>

            {/* ── DESKTOP SIDEBAR ─────────────────────────────────────── */}
            <motion.aside
                initial={false}
                animate={{ width: open ? 240 : 68 }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
                className="hidden lg:flex shrink-0 flex-col relative z-20"
                style={{
                    background: "rgba(10,15,28,0.85)",
                    backdropFilter: "blur(24px)",
                    borderRight: "1px solid rgba(255,255,255,0.05)",
                }}
            >
                {/* ── Brand ── */}
                <div className="px-3 pt-5 pb-4 flex items-center gap-3 overflow-hidden"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    {/* Logo icon */}
                    <div className="w-9 h-9 shrink-0 rounded-xl overflow-hidden flex items-center justify-center"
                        style={{
                            background: "linear-gradient(135deg, #7C3AED, #4F46E5)",
                            boxShadow: "0 4px 16px rgba(124,58,237,0.4)",
                        }}>
                        <img src="/logo.png" alt="NexusPanel" className="w-full h-full object-cover" />
                    </div>
                    <AnimatePresence>
                        {open && (
                            <motion.div
                                key="brand-text"
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -8 }}
                                transition={{ duration: 0.18 }}
                                className="min-w-0 overflow-hidden"
                            >
                                <p className="font-black text-sm text-slate-100 leading-tight tracking-tight truncate">
                                    NexusPanel
                                </p>
                                <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-violet-400/70 truncate mt-0.5">
                                    Bot Manager
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Toggle */}
                    <motion.button
                        onClick={() => setOpen((v) => !v)}
                        className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${open ? "ml-auto" : "mx-auto"}`}
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                        whileHover={{ background: "rgba(124,58,237,0.15)" }}
                        title={open ? "Collapse" : "Expand"}
                    >
                        <motion.svg
                            animate={{ rotate: open ? 0 : 180 }}
                            transition={{ type: "spring", stiffness: 200, damping: 20 }}
                            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            className="w-3.5 h-3.5 text-slate-500"
                        >
                            <polyline points="15 18 9 12 15 6" />
                        </motion.svg>
                    </motion.button>
                </div>

                {/* ── Navigation ── */}
                <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto overflow-x-hidden">
                    {open && (
                        <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-600 px-3 mb-2">
                            Navigation
                        </p>
                    )}
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink key={to} to={to} title={!open ? label : undefined}
                            className={({ isActive }) =>
                                `flex items-center gap-3 rounded-xl transition-all duration-200 relative group
                                ${open ? "px-3 py-2.5" : "w-11 h-11 mx-auto justify-center"}
                                ${isActive
                                    ? "text-white"
                                    : "text-slate-500 hover:text-slate-200"
                                }`
                            }
                        >
                            {({ isActive }) => (
                                <>
                                    {isActive && (
                                        <motion.div
                                            layoutId="sidebar-active-bg"
                                            className="absolute inset-0 rounded-xl"
                                            style={{
                                                background: "linear-gradient(135deg, rgba(124,58,237,0.2), rgba(79,70,229,0.15))",
                                                border: "1px solid rgba(124,58,237,0.2)",
                                                boxShadow: "0 0 20px rgba(124,58,237,0.1)",
                                            }}
                                            transition={{ type: "spring", stiffness: 350, damping: 30 }}
                                        />
                                    )}
                                    <span className={`relative z-10 shrink-0 transition-colors ${isActive ? "text-violet-400" : ""}`}>
                                        {icon}
                                    </span>
                                    {open && (
                                        <span className="relative z-10 text-sm font-semibold truncate">
                                            {label}
                                        </span>
                                    )}
                                    {/* Tooltip for collapsed */}
                                    {!open && (
                                        <div className="absolute left-full ml-3 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-100 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50"
                                            style={{ background: "rgba(17,24,39,0.96)", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                                            {label}
                                        </div>
                                    )}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* ── User footer ── */}
                <div className="p-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <AnimatePresence mode="wait">
                        {open ? (
                            <motion.div
                                key="user-expanded"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="rounded-xl p-2.5 flex items-center gap-3"
                                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}
                            >
                                <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-black text-white"
                                    style={{ background: "linear-gradient(135deg,#7C3AED,#4F46E5)", boxShadow: "0 4px 12px rgba(124,58,237,0.4)" }}>
                                    {initials}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-slate-200 truncate leading-tight">{user?.username}</p>
                                    <p className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">● Online</p>
                                </div>
                                <button onClick={handleLogout} title="Logout"
                                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                                    </svg>
                                </button>
                            </motion.div>
                        ) : (
                            <motion.div key="user-collapsed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="flex flex-col items-center gap-1">
                                <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-black text-white"
                                    style={{ background: "linear-gradient(135deg,#7C3AED,#4F46E5)", boxShadow: "0 4px 12px rgba(124,58,237,0.35)" }}>
                                    {initials}
                                </div>
                                <button onClick={handleLogout} title="Logout"
                                    className="w-9 h-7 rounded-lg flex items-center justify-center text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                                    </svg>
                                </button>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </motion.aside>

            {/* ── MOBILE HEADER ──────────────────────────────────────── */}
            <div className="lg:hidden fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3"
                style={{ background: "rgba(6,11,20,0.88)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl overflow-hidden" style={{ background: "linear-gradient(135deg,#7C3AED,#4F46E5)", boxShadow: "0 4px 12px rgba(124,58,237,0.4)" }}>
                        <img src="/logo.png" alt="NexusPanel" className="w-full h-full object-cover" />
                    </div>
                    <span className="font-black text-sm text-slate-100 tracking-tight">NexusPanel</span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black text-white"
                        style={{ background: "linear-gradient(135deg,#7C3AED,#4F46E5)" }}>
                        {initials}
                    </div>
                    <button onClick={handleLogout}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-rose-400 transition-colors"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                    </button>
                </div>
            </div>

            {/* ── MAIN CONTENT ───────────────────────────────────────── */}
            <main className="flex-1 overflow-y-auto relative z-10 pt-14 lg:pt-0 pb-20 lg:pb-0">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={location.pathname}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.14, ease: "easeOut" }}
                        className="min-h-full"
                        style={{ willChange: "transform, opacity" }}
                    >
                        <Outlet />
                    </motion.div>
                </AnimatePresence>
            </main>

            {/* ── MOBILE BOTTOM NAV ──────────────────────────────────── */}
            <div className="lg:hidden fixed bottom-4 left-4 right-4 z-30 rounded-2xl overflow-hidden"
                style={{
                    background: "rgba(10,15,28,0.92)",
                    backdropFilter: "blur(24px)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 -4px 24px rgba(0,0,0,0.4), 0 8px 32px rgba(0,0,0,0.3)",
                }}>
                <div className="flex items-center overflow-x-auto no-scrollbar px-1 py-1.5"
                    style={{ scrollbarWidth: "none" }}>
                    {NAV_ITEMS.map(({ to, icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            className={({ isActive }) =>
                                `flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl transition-all duration-200 shrink-0 min-w-[52px] ${
                                    isActive
                                        ? "text-violet-400"
                                        : "text-slate-600 hover:text-slate-400"
                                }`
                            }
                        >
                            {({ isActive }) => (
                                <>
                                    <div className={`transition-all duration-200 ${isActive ? "scale-110" : ""}`}>
                                        {icon}
                                    </div>
                                    <span className={`text-[8px] font-black uppercase tracking-wide leading-none ${isActive ? "text-violet-400" : ""}`}>
                                        {label.split(" ")[0]}
                                    </span>
                                    {isActive && (
                                        <motion.div layoutId="mobile-nav-indicator"
                                            className="absolute bottom-1 w-1 h-1 rounded-full bg-violet-400"
                                            transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                                    )}
                                </>
                            )}
                        </NavLink>
                    ))}
                </div>
            </div>
        </div>
    );
}
