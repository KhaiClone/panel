import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

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
                    <p style={{ textAlign: "center", fontSize: 12, color: "var(--text-dim)", margin: "16px 0 0" }}>
                        Authorized personnel only
                    </p>
                </div>
            </div>
        </>
    );
}
