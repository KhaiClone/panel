import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { motion, AnimatePresence } from "framer-motion";

// ── Animated grid lines background ─────────────────────────────────────────
function GridBackground() {
    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <svg className="absolute inset-0 w-full h-full opacity-[0.025]" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
                        <path d="M 48 0 L 0 0 0 48" fill="none" stroke="white" strokeWidth="0.5"/>
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid)" />
            </svg>
            {/* Glow blobs */}
            <div className="absolute top-[15%] left-[15%] w-[55%] h-[55%] rounded-full animate-glow"
                style={{ background: "radial-gradient(circle, rgba(124,58,237,0.15) 0%, transparent 70%)", filter: "blur(80px)" }} />
            <div className="absolute bottom-[10%] right-[10%] w-[45%] h-[45%] rounded-full animate-glow"
                style={{ background: "radial-gradient(circle, rgba(79,70,229,0.12) 0%, transparent 70%)", filter: "blur(70px)", animationDelay: "-2s" }} />
            <div className="absolute top-[60%] left-[5%] w-[30%] h-[30%] rounded-full animate-glow"
                style={{ background: "radial-gradient(circle, rgba(56,189,248,0.07) 0%, transparent 70%)", filter: "blur(60px)", animationDelay: "-4s" }} />
        </div>
    );
}

export default function Login() {
    const { login } = useAuth();
    const navigate = useNavigate();

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPass, setShowPass] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await login(username, password);
            navigate("/dashboard");
        } catch (err) {
            setError(err.response?.data?.error || "Invalid credentials. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden" style={{ background: "var(--bg-base)" }}>
            <GridBackground />

            <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-sm relative z-10"
            >
                {/* ── Logo & Title ── */}
                <div className="text-center mb-10">
                    <motion.div
                        initial={{ scale: 0.5, opacity: 0, rotate: -10 }}
                        animate={{ scale: 1, opacity: 1, rotate: 0 }}
                        transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.15 }}
                        className="relative inline-block mb-5"
                    >
                        <div className="absolute inset-0 rounded-2xl animate-glow"
                            style={{ background: "radial-gradient(circle, rgba(124,58,237,0.5) 0%, transparent 70%)", filter: "blur(20px)" }} />
                        <div className="relative w-20 h-20 rounded-2xl overflow-hidden mx-auto"
                            style={{
                                background: "linear-gradient(135deg, #7C3AED, #4F46E5)",
                                boxShadow: "0 8px 32px rgba(124,58,237,0.5), inset 0 1px 0 rgba(255,255,255,0.15)",
                            }}>
                            <img src="/logo.png" alt="NexusPanel" className="w-full h-full object-cover" />
                        </div>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.25 }}
                    >
                        <h1 className="text-3xl font-black text-slate-100 tracking-tight">
                            Nexus<span className="gradient-text-violet">Panel</span>
                        </h1>
                        <p className="text-xs font-bold text-slate-500 uppercase tracking-[0.18em] mt-2">
                            Secure Authentication
                        </p>
                    </motion.div>
                </div>

                {/* ── Card ── */}
                <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3, duration: 0.4 }}
                >
                    <div className="gradient-border">
                        <div
                            className="rounded-2xl p-7 space-y-5"
                            style={{
                                background: "linear-gradient(160deg, rgba(17,24,39,0.97) 0%, rgba(10,15,28,0.97) 100%)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                boxShadow: "0 24px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(124,58,237,0.06)",
                            }}
                        >
                            <form onSubmit={handleSubmit} className="space-y-5">
                                {/* Username */}
                                <div className="space-y-1.5">
                                    <label className="label">Username</label>
                                    <div className="relative">
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                                            </svg>
                                        </div>
                                        <input
                                            id="login-username"
                                            type="text"
                                            className="input pl-10"
                                            placeholder="Enter username"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            autoComplete="username"
                                            required
                                        />
                                    </div>
                                </div>

                                {/* Password */}
                                <div className="space-y-1.5">
                                    <label className="label">Password</label>
                                    <div className="relative">
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                            </svg>
                                        </div>
                                        <input
                                            id="login-password"
                                            type={showPass ? "text" : "password"}
                                            className="input pl-10 pr-10"
                                            placeholder="••••••••"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            autoComplete="current-password"
                                            required
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPass((v) => !v)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400 transition-colors"
                                        >
                                            {showPass ? (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                                                    <line x1="1" y1="1" x2="23" y2="23"/>
                                                </svg>
                                            ) : (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                                                </svg>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* Error */}
                                <AnimatePresence>
                                    {error && (
                                        <motion.div
                                            initial={{ opacity: 0, height: 0, marginTop: 0 }}
                                            animate={{ opacity: 1, height: "auto", marginTop: 0 }}
                                            exit={{ opacity: 0, height: 0 }}
                                            className="rounded-xl px-4 py-3 text-xs font-semibold text-rose-400 flex items-center gap-2"
                                            style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
                                        >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0">
                                                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                                            </svg>
                                            {error}
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                {/* Submit */}
                                <button
                                    id="login-submit"
                                    type="submit"
                                    disabled={loading}
                                    className="btn-gradient w-full py-3 font-black text-xs uppercase tracking-widest"
                                >
                                    {loading ? (
                                        <span className="flex items-center gap-2">
                                            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                            </svg>
                                            Authenticating…
                                        </span>
                                    ) : "Sign In →"}
                                </button>
                            </form>
                        </div>
                    </div>
                </motion.div>

                <p className="text-center mt-6 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-700">
                    Protected by end-to-end encryption
                </p>
            </motion.div>
        </div>
    );
}
