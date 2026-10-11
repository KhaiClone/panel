import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { END_REASONS } from "../context/access";
import api from "../api/client";

// The owner signs in with the .env account; staff only with Discord (the
// button shows once Discord login is set up under Panel Settings → Staff).
export default function Login() {
    const { login, startDiscordLogin } = useAuth();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    // Why the last staff session ended (api/client.js) — shown once.
    const [ended] = useState(() => {
        let key = params.get("ended");
        try { key = key || sessionStorage.getItem("bp_ended"); } catch { /* storage disabled */ }
        return END_REASONS[key] || null;
    });
    useEffect(() => {
        try { sessionStorage.removeItem("bp_ended"); } catch { /* storage disabled */ }
    }, []);
    const [discordEnabled, setDiscordEnabled] = useState(false);
    const [discordBusy, setDiscordBusy] = useState(false);

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPass, setShowPass] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        api.get("/auth/discord").then((r) => setDiscordEnabled(!!r.data?.enabled)).catch(() => {});
    }, []);

    const handleDiscord = async () => {
        setError("");
        setDiscordBusy(true);
        try {
            await startDiscordLogin(); // leaves the page
        } catch (err) {
            setError(err.response?.data?.error || "Could not start Discord sign-in.");
            setDiscordBusy(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await login(username, password);
            navigate("/systems");
        } catch (err) {
            setError(err.response?.data?.error || "Invalid credentials. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <title>Sign In — NexusPanel</title>

            {/* One quiet column: the panel has one admin, nothing to sell here */}
            <div className="fade-in" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px", background: "var(--bg-base)" }}>
                <div style={{ width: "100%", maxWidth: 360 }}>

                    {/* Form header */}
                    <div style={{ textAlign: "center", marginBottom: 24 }}>
                        <img src="/logo.png" alt="NexusPanel" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", margin: "0 auto 16px", display: "block" }} />
                        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", margin: "0 0 4px" }}>Sign in to NexusPanel</h1>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Enter your credentials to continue</p>
                    </div>

                    {/* Why a staff session ended (signed in elsewhere, role taken away, …) */}
                    {ended && (
                        <div style={{
                            background: "var(--warning-bg)", border: "1px solid var(--border)", borderRadius: 8,
                            padding: "10px 14px", fontSize: 13, color: "var(--warning)", marginBottom: 12,
                        }}>
                            {ended}
                        </div>
                    )}

                    {/* Form card */}
                    <div className="card" style={{ padding: 24 }}>
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
                                    fontSize: 13, color: "var(--danger)",
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
                                style={{ padding: "9px 0", fontSize: 14, marginTop: 2, width: "100%" }}
                            >
                                {loading ? (
                                    <>
                                        <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "var(--text-on-accent)", animation: "spin 0.8s linear infinite" }} />
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

                        {discordEnabled && (
                            <>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0", color: "var(--text-dim)", fontSize: 12 }}>
                                    <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
                                    staff
                                    <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
                                </div>
                                <button
                                    type="button"
                                    onClick={handleDiscord}
                                    disabled={discordBusy}
                                    className="btn"
                                    style={{ width: "100%", padding: "9px 0", fontSize: 14, justifyContent: "center", background: "#5865F2", color: "#fff", borderColor: "#5865F2" }}
                                >
                                    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }} aria-hidden="true">
                                        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                                    </svg>
                                    {discordBusy ? "Opening Discord…" : "Sign in with Discord"}
                                </button>
                            </>
                        )}
                    </div>

                    {/* Footer note */}
                    <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-dim)", margin: "16px 0 0" }}>
                        Authorized personnel only
                    </p>
                </div>
            </div>
        </>
    );
}
