import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { motion, AnimatePresence } from "framer-motion";

// ── Nav items ──────────────────────────────────────────────────────────────
const NAV_ITEMS = [
    { to: "/dashboard",     icon: "📊", label: "Dashboard" },
    { to: "/groups",        icon: "🗂️", label: "Groups" },
    { to: "/multi-manage",  icon: "⚡", label: "Multi Manage" },
    { to: "/system",        icon: "🖥️", label: "System" },
];

// ── Nav link styles ────────────────────────────────────────────────────────
const navClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
        isActive
            ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
            : "text-slate-400 hover:bg-slate-700/50 hover:text-slate-100"
    }`;

const navClassCollapsed = ({ isActive }) =>
    `flex items-center justify-center w-10 h-10 rounded-lg text-base transition-all duration-200 ${
        isActive
            ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
            : "text-slate-400 hover:bg-slate-700/50 hover:text-slate-100"
    }`;

export default function Layout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [open, setOpen] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);

    useEffect(() => {
        const handleResize = () => setIsMobile(window.innerWidth < 1024);
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    return (
        <div className="flex h-[100dvh] bg-slate-950 text-slate-100 overflow-hidden flex-col lg:flex-row">
            {/* Background Decoration */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-indigo-600/5 blur-[120px] animate-glow" />
                <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] rounded-full bg-blue-600/5 blur-[120px] animate-glow" style={{ animationDelay: '-1.5s' }} />
            </div>

            {/* ── Mobile Header ────────────────────────────────────────────────── */}
            <div className="lg:hidden flex items-center justify-between px-4 py-3 bg-slate-900/50 border-b border-slate-800/50 backdrop-blur-xl z-30">
                <div className="flex items-center gap-2">
                    <span className="text-xl">🤖</span>
                    <p className="font-bold text-slate-100 text-sm tracking-tight">Bot Panel</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold shadow-lg shadow-indigo-600/30">
                        {user?.username?.[0]?.toUpperCase()}
                    </div>
                    <button onClick={handleLogout} className="text-slate-400 hover:text-slate-100 text-lg">
                        🚪
                    </button>
                </div>
            </div>

            {/* ── Sidebar (Desktop) ────────────────────────────────────────────── */}
            <motion.aside
                initial={false}
                animate={{ width: open ? 224 : 64 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="hidden lg:flex shrink-0 flex-col bg-slate-900/50 border-r border-slate-800/50 backdrop-blur-xl z-20"
            >
                {/* Logo + toggle */}
                <div className="px-3 py-4 border-b border-slate-800/50 flex items-center justify-between gap-2">
                    <AnimatePresence mode="wait">
                        {open && (
                            <NavLink 
                                to="/dashboard" 
                                className="flex items-center gap-2 min-w-0"
                            >
                                <motion.div 
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -10 }}
                                    className="flex items-center gap-2 min-w-0"
                                >
                                    <span className="text-2xl shrink-0">🤖</span>
                                    <div className="min-w-0">
                                        <p className="font-bold text-slate-100 leading-tight truncate">Bot Panel</p>
                                        <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider truncate">Admin Panel</p>
                                    </div>
                                </motion.div>
                            </NavLink>
                        )}
                    </AnimatePresence>
                    <button
                        onClick={() => setOpen((v) => !v)}
                        title={open ? "Collapse sidebar" : "Expand sidebar"}
                        className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-slate-100 transition-colors ${
                            !open ? "mx-auto" : ""
                        }`}
                    >
                        <motion.div
                            animate={{ rotate: open ? 0 : 180 }}
                            transition={{ type: "spring", stiffness: 200, damping: 20 }}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                        </motion.div>
                    </button>
                </div>

                {/* Nav */}
                <nav className={`flex-1 p-2 space-y-1 overflow-y-auto ${!open ? "flex flex-col items-center" : ""}`}>
                    {!open && (
                        <div className="w-full border-b border-slate-800/50 mb-1" />
                    )}
                    {open && (
                        <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest px-3 pt-1 pb-1">
                            Navigation
                        </p>
                    )}
                    {NAV_ITEMS.map(({ to, icon, label }) =>
                        open ? (
                            <NavLink key={to} to={to} className={navClass}>
                                <span className="text-lg">{icon}</span>
                                {label}
                            </NavLink>
                        ) : (
                            <NavLink key={to} to={to} className={navClassCollapsed} title={label}>
                                <span className="text-lg">{icon}</span>
                            </NavLink>
                        )
                    )}
                </nav>

                {/* Footer */}
                <div className={`p-2 border-t border-slate-800/50 ${!open ? "flex flex-col items-center gap-1" : ""}`}>
                    {open ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="space-y-2"
                        >
                            <div className="flex items-center gap-2 px-2">
                                <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold shrink-0 shadow-lg shadow-indigo-600/30">
                                    {user?.username?.[0]?.toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-slate-200 truncate">{user?.username}</p>
                                    <p className="text-[10px] text-slate-500">Online</p>
                                </div>
                            </div>
                            <button onClick={handleLogout} className="btn-ghost w-full text-left text-xs flex items-center gap-2">
                                <span>🚪</span> Logout
                            </button>
                        </motion.div>
                    ) : (
                        <>
                            <div
                                className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold cursor-default shadow-lg shadow-indigo-600/30 mb-1"
                                title={user?.username}
                            >
                                {user?.username?.[0]?.toUpperCase()}
                            </div>
                            <button
                                onClick={handleLogout}
                                title="Logout"
                                className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-slate-100 transition-colors text-base"
                            >
                                🚪
                            </button>
                        </>
                    )}
                </div>
            </motion.aside>

            {/* ── Main content ────────────────────────────────────────────────── */}
            <main className="flex-1 overflow-y-auto relative z-10">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={location.pathname}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.1 }}
                        className="min-h-full pb-32 lg:pb-8"
                    >
                        <Outlet />
                        <div className="h-20 lg:hidden" /> {/* Mobile bottom nav spacer */}
                    </motion.div>
                </AnimatePresence>
            </main>

            {/* ── Mobile Nav (Bottom Bar) ─────────────────────────────────────── */}
            <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-slate-900/80 border-t border-slate-800/50 backdrop-blur-xl z-30 px-6 py-2 flex items-center justify-around">
                {NAV_ITEMS.map(({ to, icon, label }) => (
                    <NavLink
                        key={to}
                        to={to}
                        className={({ isActive }) => 
                            `flex flex-col items-center gap-1 p-2 transition-all duration-200 ${
                                isActive ? "text-indigo-400 scale-110" : "text-slate-500"
                            }`
                        }
                    >
                        <span className="text-xl">{icon}</span>
                        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
                    </NavLink>
                ))}
            </div>
        </div>
    );
}
