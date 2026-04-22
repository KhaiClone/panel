import { useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// ── Nav link style helper ──────────────────────────────────────────────────
const navClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        isActive
            ? "bg-indigo-600 text-white"
            : "text-slate-400 hover:bg-slate-700 hover:text-slate-100"
    }`;

// Collapsed variant — icon only, centred
const navClassCollapsed = ({ isActive }) =>
    `flex items-center justify-center w-10 h-10 rounded-lg text-base transition-colors ${
        isActive
            ? "bg-indigo-600 text-white"
            : "text-slate-400 hover:bg-slate-700 hover:text-slate-100"
    }`;

export default function Layout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [open, setOpen] = useState(true);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    return (
        <div className="flex h-screen bg-slate-900 overflow-hidden">
            {/* ── Sidebar ─────────────────────────────────────────────────────── */}
            <aside
                className={`shrink-0 flex flex-col bg-slate-800 border-r border-slate-700 transition-all duration-200 ${
                    open ? "w-56" : "w-16"
                }`}
            >
                {/* Logo + toggle button */}
                <div className="px-3 py-4 border-b border-slate-700 flex items-center justify-between gap-2">
                    {open && (
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="text-2xl shrink-0">🤖</span>
                            <div className="min-w-0">
                                <p className="font-bold text-slate-100 leading-tight truncate">
                                    Bot Panel
                                </p>
                                <p className="text-xs text-slate-500 truncate">
                                    Admin Dashboard
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Toggle button */}
                    <button
                        onClick={() => setOpen((v) => !v)}
                        title={open ? "Collapse sidebar" : "Expand sidebar"}
                        className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-700 hover:text-slate-100 transition-colors ${
                            !open ? "mx-auto" : ""
                        }`}
                    >
                        {open ? (
                            /* ← chevron-left */
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                        ) : (
                            /* → chevron-right */
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                            </svg>
                        )}
                    </button>
                </div>

                {/* Nav */}
                <nav className={`flex-1 p-2 space-y-1 overflow-y-auto ${!open ? "flex flex-col items-center" : ""}`}>
                    {open ? (
                        <NavLink to="/dashboard" className={navClass}>
                            <span>📊</span> Dashboard
                        </NavLink>
                    ) : (
                        <NavLink to="/dashboard" className={navClassCollapsed} title="Dashboard">
                            <span>📊</span>
                        </NavLink>
                    )}
                </nav>

                {/* Footer */}
                <div className={`p-2 border-t border-slate-700 ${!open ? "flex flex-col items-center gap-1" : ""}`}>
                    {open ? (
                        <>
                            <div className="flex items-center gap-2 mb-2 px-2">
                                <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold shrink-0">
                                    {user?.username?.[0]?.toUpperCase()}
                                </div>
                                <span className="text-sm text-slate-300 truncate">
                                    {user?.username}
                                </span>
                            </div>
                            <button
                                onClick={handleLogout}
                                className="btn-ghost w-full text-left text-xs"
                            >
                                🚪 Logout
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Avatar only */}
                            <div
                                className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold cursor-default"
                                title={user?.username}
                            >
                                {user?.username?.[0]?.toUpperCase()}
                            </div>
                            {/* Logout icon button */}
                            <button
                                onClick={handleLogout}
                                title="Logout"
                                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-700 hover:text-slate-100 transition-colors text-base"
                            >
                                🚪
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* ── Main content ────────────────────────────────────────────────── */}
            <main className="flex-1 overflow-y-auto">
                <Outlet />
            </main>
        </div>
    );
}
