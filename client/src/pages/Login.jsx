import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const FEATURES = [
    {
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
        ),
        title: "Real-time Monitoring",
        desc: "Track CPU, RAM and uptime live",
    },
    {
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
        ),
        title: "Secure & Isolated",
        desc: "Each instance runs in its own PM2 process",
    },
    {
        icon: (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
        ),
        title: "Instant Deployment",
        desc: "Deploy from GitHub or local directory",
    },
];

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
            navigate("/overview");
        } catch (err) {
            setError(err.response?.data?.error || "Invalid credentials. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <title>Sign In — NexusPanel</title>

            {/* Responsive: hide left panel on small screens */}
            <style>{`
                @keyframes float1 {
                    0%, 100% { transform: translateY(0) scale(1); }
                    50% { transform: translateY(-30px) scale(1.05); }
                }
                @keyframes float2 {
                    0%, 100% { transform: translateY(0) rotate(0deg); }
                    50% { transform: translateY(20px) rotate(180deg); }
                }
                @media (max-width: 768px) {
                    .login-brand-panel { display: none !important; }
                    .login-form-panel { flex: 1 !important; }
                }
            `}</style>

            <div className="fade-in" style={{ minHeight: "100vh", display: "flex", background: "var(--bg-base)" }}>

                {/* ── Left Brand Panel ── */}
                <div
                    className="login-brand-panel"
                    style={{
                        flex: "0 0 55%",
                        position: "relative",
                        overflow: "hidden",
                        background: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #1e1b4b 100%)",
                        display: "flex",
                        flexDirection: "column",
                        padding: "40px 48px",
                    }}
                >
                    {/* Floating orbs */}
                    <div style={{ position: "absolute", top: "10%", left: "15%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(99,102,241,0.3), transparent)", filter: "blur(60px)", animation: "float1 8s ease-in-out infinite" }} />
                    <div style={{ position: "absolute", bottom: "15%", right: "10%", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.25), transparent)", filter: "blur(50px)", animation: "float2 10s ease-in-out infinite" }} />
                    <div style={{ position: "absolute", top: "50%", right: "20%", width: 180, height: 180, borderRadius: "50%", background: "radial-gradient(circle, rgba(6,182,212,0.15), transparent)", filter: "blur(40px)", animation: "float1 12s ease-in-out infinite reverse" }} />

                    {/* Logo top-left */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative", zIndex: 1 }}>
                        <div style={{ width: 48, height: 48, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", flexShrink: 0 }}>
                            <img src="/logo.png" alt="NexusPanel" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 18, color: "#fff", letterSpacing: "0.02em" }}>NexusPanel</span>
                    </div>

                    {/* Center content */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", position: "relative", zIndex: 1 }}>
                        <div style={{ marginBottom: 48 }}>
                            <h1 style={{
                                fontSize: 40,
                                fontWeight: 800,
                                color: "#fff",
                                margin: "0 0 12px",
                                lineHeight: 1.1,
                                letterSpacing: "-0.02em",
                            }}>
                                Premium Bot{" "}
                                <span style={{ background: "linear-gradient(90deg, #818CF8, #06B6D4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
                                    Hosting
                                </span>
                                {" "}Control Panel
                            </h1>
                            <p style={{ fontSize: 16, color: "rgba(255,255,255,0.55)", margin: 0, lineHeight: 1.6 }}>
                                Manage, monitor and deploy your Discord bots with confidence.
                            </p>
                        </div>

                        {/* Feature list */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                            {FEATURES.map((f, i) => (
                                <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                                    <div style={{
                                        width: 40, height: 40, borderRadius: 10,
                                        background: "rgba(255,255,255,0.08)",
                                        border: "1px solid rgba(255,255,255,0.12)",
                                        display: "flex", alignItems: "center", justifyContent: "center",
                                        color: "#a5b4fc", flexShrink: 0,
                                        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                                    }}>
                                        {f.icon}
                                    </div>
                                    <div>
                                        <p style={{ fontWeight: 600, color: "#fff", margin: "0 0 3px", fontSize: 14 }}>{f.title}</p>
                                        <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, margin: 0, lineHeight: 1.5 }}>{f.desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Bottom version badge */}
                    <div style={{ position: "relative", zIndex: 1 }}>
                        <span style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            padding: "5px 12px", borderRadius: 99,
                            background: "rgba(255,255,255,0.07)",
                            border: "1px solid rgba(255,255,255,0.12)",
                            fontSize: 11, color: "rgba(255,255,255,0.4)", fontWeight: 500,
                        }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
                            v2.0 · Powered by PM2
                        </span>
                    </div>
                </div>

                {/* ── Right Form Panel ── */}
                <div
                    className="login-form-panel"
                    style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "40px 24px",
                        background: "radial-gradient(ellipse at 60% 40%, rgba(99,102,241,0.06) 0%, transparent 60%)",
                        position: "relative",
                    }}
                >
                    <div style={{ width: "100%", maxWidth: 380 }} className="slide-up">

                        {/* Form header */}
                        <div style={{ textAlign: "center", marginBottom: 32 }}>
                            <div style={{
                                width: 52, height: 52, borderRadius: 14,
                                background: "linear-gradient(135deg, var(--accent), #8B5CF6)",
                                padding: 2,
                                display: "inline-flex",
                                margin: "0 auto 18px",
                            }}>
                                <div style={{
                                    width: "100%", height: "100%", borderRadius: 12,
                                    background: "var(--bg-base)",
                                    overflow: "hidden",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                }}>
                                    <img src="/logo.png" alt="NexusPanel" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                                </div>
                            </div>
                            <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>Sign In</h2>
                            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Enter your credentials to continue</p>
                        </div>

                        {/* Form card */}
                        <div className="card" style={{ padding: "28px 24px" }}>
                            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>

                                {/* Username */}
                                <div className="form-group">
                                    <label className="label" htmlFor="login-username">Username</label>
                                    <div style={{ position: "relative" }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--text-dim)", pointerEvents: "none" }}>
                                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                                        </svg>
                                        <input
                                            id="login-username"
                                            type="text"
                                            className="input"
                                            style={{ paddingLeft: 36 }}
                                            placeholder="Enter username"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            autoComplete="username"
                                            required
                                        />
                                    </div>
                                </div>

                                {/* Password */}
                                <div className="form-group">
                                    <label className="label" htmlFor="login-password">Password</label>
                                    <div style={{ position: "relative" }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--text-dim)", pointerEvents: "none" }}>
                                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                        </svg>
                                        <input
                                            id="login-password"
                                            type={showPass ? "text" : "password"}
                                            className="input"
                                            style={{ paddingLeft: 36, paddingRight: 40 }}
                                            placeholder="Enter password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            autoComplete="current-password"
                                            required
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPass(v => !v)}
                                            style={{
                                                position: "absolute", right: 10, top: "50%",
                                                transform: "translateY(-50%)",
                                                background: "none", border: "none",
                                                color: "var(--text-muted)", cursor: "pointer",
                                                padding: 0, display: "flex",
                                            }}
                                            title={showPass ? "Hide password" : "Show password"}
                                        >
                                            {showPass ? (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}>
                                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                                                    <line x1="1" y1="1" x2="23" y2="23"/>
                                                </svg>
                                            ) : (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}>
                                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                                    <circle cx="12" cy="12" r="3"/>
                                                </svg>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* Error */}
                                {error && (
                                    <div style={{
                                        background: "var(--danger-bg)",
                                        border: "1px solid var(--danger-border)",
                                        borderRadius: 8,
                                        padding: "10px 14px",
                                        fontSize: 13, color: "#f87171",
                                        display: "flex", alignItems: "center", gap: 8,
                                    }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 15, height: 15, flexShrink: 0 }}>
                                            <circle cx="12" cy="12" r="10"/>
                                            <line x1="12" y1="8" x2="12" y2="12"/>
                                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                                        </svg>
                                        {error}
                                    </div>
                                )}

                                {/* Submit */}
                                <button
                                    id="login-submit"
                                    type="submit"
                                    disabled={loading}
                                    className="btn-primary"
                                    style={{ padding: "11px 0", fontSize: 14, marginTop: 2, width: "100%" }}
                                >
                                    {loading ? (
                                        <>
                                            <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", animation: "spin 0.8s linear infinite" }} />
                                            Signing in…
                                        </>
                                    ) : (
                                        <>
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}>
                                                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
                                            </svg>
                                            Sign In
                                        </>
                                    )}
                                </button>
                            </form>
                        </div>

                        {/* Footer note */}
                        <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-dim)", marginTop: 20, margin: "20px 0 0" }}>
                            🔒 Authorized personnel only
                        </p>
                    </div>
                </div>
            </div>
        </>
    );
}
